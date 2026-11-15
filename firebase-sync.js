/* Firebase Auth (Google) + Firestore transport for history-sync.js.

   Loaded only after a real public web config is present. The web apiKey is
   not a secret; per-user access is enforced by firestore.rules. This file
   must not contain a service account or admin credentials.

   Offline queueing is the app outbox in localStorage, keyed by uid. Firestore
   persistent cache is left off so a signed-out browser does not keep the
   previous account's rows in IndexedDB.
*/
(function (root) {
  "use strict";

  var SDK_VERSION = "11.10.0";
  var BASE = "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";

  function loadSdk() {
    return Promise.all([
      import(BASE + "firebase-app.js"),
      import(BASE + "firebase-auth.js"),
      import(BASE + "firebase-firestore.js")
    ]).then(function (mods) {
      return { app: mods[0], auth: mods[1], fs: mods[2] };
    });
  }

  function isCoarsePointer() {
    try {
      return window.matchMedia && window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    } catch (_) {
      return false;
    }
  }

  function toUser(user) {
    if (!user) return null;
    return { uid: user.uid, email: user.email || "" };
  }

  function isDenied(err) {
    var code = String((err && err.code) || "");
    return code.indexOf("permission-denied") !== -1;
  }

  function openSession(config, handlers) {
    var onUser = handlers && handlers.onUser;
    var onError = handlers && handlers.onError;
    return loadSdk().then(function (sdk) {
      var apps = sdk.app.getApps();
      var firebaseApp = apps.length ? apps[0] : sdk.app.initializeApp({
        apiKey: config.apiKey,
        authDomain: config.authDomain,
        projectId: config.projectId,
        appId: config.appId,
        storageBucket: config.storageBucket || undefined,
        messagingSenderId: config.messagingSenderId || undefined
      });
      var auth = sdk.auth.getAuth(firebaseApp);
      var db = sdk.fs.getFirestore(firebaseApp);
      var provider = new sdk.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });

      sdk.auth.onAuthStateChanged(auth, function (user) {
        if (typeof onUser === "function") onUser(toUser(user));
      }, function (err) {
        if (typeof onError === "function") onError(err);
      });

      sdk.auth.getRedirectResult(auth).catch(function (err) {
        if (typeof onError === "function") onError(err);
      });

      function connect(uid) {
        if (!auth.currentUser || auth.currentUser.uid !== uid) {
          var mismatch = new Error("permission-denied");
          mismatch.code = "permission-denied";
          return Promise.reject(mismatch);
        }
        var attemptsCol = sdk.fs.collection(db, "users", uid, "attempts");
        var stateRef = sdk.fs.doc(db, "users", uid, "sync", "state");
        var unsubs = [];
        return Promise.resolve({
          pull: function () {
            return Promise.all([
              sdk.fs.getDoc(stateRef),
              sdk.fs.getDocs(attemptsCol)
            ]).then(function (snaps) {
              var stateSnap = snaps[0];
              var attemptSnap = snaps[1];
              var state = null;
              if (stateSnap.exists()) {
                var data = stateSnap.data() || {};
                state = { clearRev: data.clearRev | 0, clearedThrough: data.clearedThrough | 0 };
              }
              return {
                state: state,
                attempts: attemptSnap.docs.map(function (item) { return item.data(); })
              };
            });
          },
          subscribe: function (cb) {
            var ping = function () { cb(); };
            var fail = function (err) { if (typeof onError === "function") onError(err); };
            unsubs.push(sdk.fs.onSnapshot(attemptsCol, ping, fail));
            unsubs.push(sdk.fs.onSnapshot(stateRef, ping, fail));
          },
          pushAttempts: function (list) {
            var rejected = [];
            var acked = [];
            var index = 0;
            function step() {
              if (index >= list.length) return Promise.resolve({ rejected: rejected, acked: acked });
              var entry = list[index];
              index += 1;
              var ref = sdk.fs.doc(attemptsCol, entry.id);
              return sdk.fs.setDoc(ref, entry).then(function () {
                acked.push(entry.id);
                return step();
              }).catch(function (err) {
                if (isDenied(err)) {
                  rejected.push(entry.id);
                  return step();
                }
                err.ackedIds = acked.slice();
                throw err;
              });
            }
            return step();
          },
          pushClear: function (state) {
            return sdk.fs.setDoc(stateRef, {
              clearRev: state.clearRev,
              clearedThrough: state.clearedThrough,
              updatedAt: sdk.fs.serverTimestamp()
            });
          },
          deleteCleared: function (through) {
            var q = sdk.fs.query(attemptsCol, sdk.fs.where("t", "<=", through));
            return sdk.fs.getDocs(q).then(function (snap) {
              var docs = snap.docs;
              var start = 0;
              function next() {
                if (start >= docs.length) return Promise.resolve();
                var batch = sdk.fs.writeBatch(db);
                var slice = docs.slice(start, start + 400);
                start += 400;
                slice.forEach(function (item) { batch.delete(item.ref); });
                return batch.commit().then(next);
              }
              return next();
            });
          },
          close: function () {
            while (unsubs.length) {
              var unsub = unsubs.pop();
              try { unsub(); } catch (_) { /* ignore */ }
            }
          }
        });
      }

      return {
        signIn: function () {
          if (isCoarsePointer()) return sdk.auth.signInWithRedirect(auth, provider);
          return sdk.auth.signInWithPopup(auth, provider).catch(function (err) {
            var code = String((err && err.code) || "");
            if (code.indexOf("popup-blocked") !== -1 || code.indexOf("operation-not-supported") !== -1) {
              return sdk.auth.signInWithRedirect(auth, provider);
            }
            throw err;
          });
        },
        signOut: function () {
          return sdk.auth.signOut(auth);
        },
        connect: connect
      };
    }).catch(function (err) {
      if (err && !err.code) err.code = "load-failed";
      throw err;
    });
  }

  root.SSCOFirebaseSync = { openSession: openSession, SDK_VERSION: SDK_VERSION };
})(typeof globalThis !== "undefined" ? globalThis : this);
