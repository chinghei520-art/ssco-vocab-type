/* SSCO attempt-history sync.

   Syncs practice attempts only. Vocab (`ssco-vocab-items-v1`) and the
   in-progress round (`ssco-vocab-session-v1`) stay on this browser.

   Signed-out attempts stay in `ssco-vocab-attempt-log-v1` (newest 200 on write).
   The first Google account that signs in on this browser claims whatever is
   already in that log and uploads it once. Later signed-out attempts are not
   moved to any account, so a second person cannot receive the first person's
   rows and the first person cannot receive the second person's rows.

   Account history lives under per-uid keys and is the report source (not the
   200-row device cap). A clear writes a tombstone first (`clearedThrough`),
   then drops older rows. The tombstone only moves forward, so a later sync
   cannot bring cleared rows back. Sign-out hides the account cache; it does
   not delete cloud data.
*/
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SSCOHistorySync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ANON_LOG_KEY = "ssco-vocab-attempt-log-v1";
  const MIGRATION_KEY = "ssco-vocab-migration-v1";
  const LOG_MAX = 200;
  const PUSH_BATCH = 400;

  const KEYS = {
    anon: ANON_LOG_KEY,
    migration: MIGRATION_KEY,
    cache: function (uid) { return "ssco-vocab-account-cache-v1:" + uid; },
    outbox: function (uid) { return "ssco-vocab-account-outbox-v1:" + uid; },
    clear: function (uid) { return "ssco-vocab-account-clear-v1:" + uid; }
  };

  const COPY = {
    localOnly: "未設定雲端，紀錄只留喺呢部機",
    checking: "正在檢查登入狀態…",
    signedOut: "未登入。登入 Google 之後，同一帳戶嘅練習紀錄會跨裝置合併。",
    signingIn: "登入中…",
    syncing: "同步中…",
    offline: "離線。新紀錄已留喺呢部機，有網時會再同步。",
    signedOutAfter: "已登出。畫面只顯示未上傳嘅本機紀錄，唔會顯示上一個帳戶。",
    signInClaim: "登入 Google？呢部機現有嘅練習紀錄會搬去呢個帳戶，而且只會綁定第一個登入嘅帳戶。請確認係你自己嘅帳戶。",
    signInOther: "登入另一個 Google 帳戶？呢部機未上傳嘅本機紀錄唔會搬去新帳戶，避免同之前嘅帳戶撈亂。",
    signOut: "登出 Google？登出後畫面唔會再顯示呢個帳戶嘅紀錄，避免下一個使用者睇到。雲端紀錄會保留，唔會刪除。",
    clearAnon: "清空呢部機未登入嘅練習紀錄？呢個動作只影響呢部瀏覽器，唔會刪除任何雲端或其他帳戶嘅紀錄。",
    clearAccount: "清空呢個 Google 帳戶喺所有裝置嘅練習紀錄？會寫入雲端「已清空」標記並刪除已同步紀錄。已清空嘅紀錄唔會再出現。詞庫同未完成嘅練習輪次唔會刪。",
    unconfiguredClick: "未設定雲端同步。練習紀錄只留喺呢部瀏覽器，唔會上傳。",
    secretRejected: "設定被拒絕：偵測到服務帳戶或密鑰欄位。請只填 Firebase Web 公開設定。",
    storageFull: "本機儲存空間不足，呢次紀錄可能重新載入後先會唔見。請清理瀏覽器儲存空間。"
  };

  function asInt(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) ? number : 0;
  }

  function fnv1a32(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function clip(value, max) {
    const s = value == null ? "" : String(value);
    return s.length > max ? s.slice(0, max) : s;
  }

  function isSafeId(id) {
    return typeof id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(id);
  }

  function isSafeUid(uid) {
    return typeof uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(uid);
  }

  function legacyAttemptId(entry) {
    const canon = [
      entry.t,
      entry.day,
      entry.unit,
      entry.zh,
      entry.answer,
      entry.typed,
      entry.ok ? 1 : 0
    ].join("\u001f");
    const a = fnv1a32(canon, 0x811c9dc5).toString(16).padStart(8, "0");
    const b = fnv1a32("ssco-v1|" + canon, 0x811c9dc5).toString(16).padStart(8, "0");
    return "leg_" + a + b;
  }

  function defaultNewId() {
    const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return "a_" + cryptoObj.randomUUID().replace(/-/g, "");
    }
    const rand = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    return ("a_" + Date.now().toString(16) + rand).slice(0, 40);
  }

  function normalizeExisting(raw) {
    if (!raw || typeof raw !== "object") return null;
    const t = Number(raw.t);
    if (!Number.isFinite(t) || t <= 0) return null;
    const entry = {
      t: Math.floor(t),
      day: clip(typeof raw.day === "string" && raw.day ? raw.day : "", 16),
      unit: clip(raw.unit, 200),
      zh: clip(raw.zh, 500),
      answer: clip(raw.answer, 300),
      typed: clip(raw.typed, 300),
      ok: !!raw.ok
    };
    if (!entry.day) entry.day = "1970-01-01";
    entry.id = isSafeId(raw.id) ? raw.id : legacyAttemptId(entry);
    return entry;
  }

  function mergeAttempts(lists) {
    const map = new Map();
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i] || [];
      for (let j = 0; j < list.length; j++) {
        const entry = normalizeExisting(list[j]);
        if (!entry) continue;
        if (!map.has(entry.id)) map.set(entry.id, entry);
      }
    }
    return Array.from(map.values()).sort(function (a, b) {
      if (a.t !== b.t) return a.t - b.t;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

  function toFirestoreAttempt(entry) {
    const normalized = normalizeExisting(entry);
    if (!normalized) throw new Error("invalid-attempt");
    return {
      id: normalized.id,
      t: normalized.t,
      day: normalized.day,
      unit: normalized.unit,
      zh: normalized.zh,
      answer: normalized.answer,
      typed: normalized.typed,
      ok: normalized.ok,
      v: 1
    };
  }

  function inspectConfig(cfg) {
    if (cfg == null) return { ok: false, reason: "missing" };
    let blob = "";
    try { blob = JSON.stringify(cfg); } catch (_) { blob = ""; }
    if (/private_key|client_secret|BEGIN PRIVATE KEY|service_account/i.test(blob)) {
      return { ok: false, reason: "secret" };
    }
    if (typeof cfg !== "object") return { ok: false, reason: "incomplete" };
    const required = ["apiKey", "authDomain", "projectId", "appId"];
    for (let i = 0; i < required.length; i++) {
      const value = cfg[required[i]];
      if (typeof value !== "string") return { ok: false, reason: "incomplete" };
      const trimmed = value.trim();
      if (!trimmed || trimmed.length < 6) return { ok: false, reason: "incomplete" };
      if (/YOUR_|REPLACE_ME|<[^>]+>|TODO|xxxxx|example/i.test(trimmed)) {
        return { ok: false, reason: "incomplete" };
      }
    }
    return { ok: true, reason: "" };
  }

  function isFirebaseConfig(cfg) {
    return inspectConfig(cfg).ok;
  }

  function errorText(err) {
    const code = String((err && (err.code || err.message)) || err || "");
    if (code.includes("unconfigured")) return COPY.unconfiguredClick;
    if (code.includes("not-ready")) return "登入功能未準備好，請等一陣再試。";
    if (code.includes("unauthorized-domain")) return "呢個網址未加入 Firebase 授權網域";
    if (code.includes("redirect-result-missing")) {
      return "登入未完成。手機瀏覽器攔截咗跨網站登入狀態，所以返回之後仍然未登入。請再撳「登入」，用彈出視窗完成。紀錄同詞庫都未刪。";
    }
    if (code.includes("popup-blocked") || code.includes("operation-not-supported") || code.includes("popup-closed-by-browser")) {
      return "彈出視窗被攔截。請允許呢個網站開視窗，再撳登入。唔使關閉追蹤保護，紀錄同詞庫都未刪。";
    }
    if (code.includes("popup-closed") || code.includes("cancelled") || code.includes("canceled")) {
      return "已取消登入";
    }
    if (code.includes("permission-denied")) return "雲端拒絕存取，請檢查 Firestore 規則係咪已發佈";
    if (code.includes("load-failed")) return "載入同步元件失敗，請檢查網絡";
    if (
      code.includes("network") ||
      code.includes("unavailable") ||
      code.includes("offline") ||
      code.includes("Failed to fetch")
    ) {
      return "網絡有問題，紀錄已留喺呢部機";
    }
    if (code.includes("secret")) return COPY.secretRejected;
    if (code.includes("quota") || code.includes("storage")) return COPY.storageFull;
    return "請稍後再試";
  }

  function isCancelError(err) {
    const code = String((err && (err.code || err.message)) || "");
    return code.includes("popup-closed") || code.includes("cancelled") || code.includes("canceled");
  }

  function isOfflineError(err) {
    const code = String((err && (err.code || err.message)) || "");
    return code.includes("unavailable") || code.includes("network") || code.includes("offline") || code.includes("Failed to fetch");
  }

  function createHistoryController(options) {
    const opts = options || {};
    const storage = opts.storage;
    if (!storage || typeof storage.getItem !== "function") {
      throw new Error("storage required");
    }
    const now = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };
    const newId = typeof opts.newId === "function" ? opts.newId : defaultNewId;
    const configInfo = opts.forceCloud
      ? { ok: true, reason: "" }
      : inspectConfig(opts.config);
    const configuredFlag = !!(opts.forceCloud || configInfo.ok);
    const configProblem = configuredFlag ? "" : (configInfo.reason || "missing");

    const mem = new Map();
    const memDirty = new Set();
    let quotaProblem = false;

    function writeRaw(key, text) {
      mem.set(key, text);
      try {
        storage.setItem(key, text);
        memDirty.delete(key);
      } catch (err) {
        memDirty.add(key);
        quotaProblem = err || true;
      }
    }

    function readRaw(key) {
      if (memDirty.has(key) && mem.has(key)) return mem.get(key);
      try {
        const raw = storage.getItem(key);
        if (raw != null) return raw;
      } catch (_) { /* ignore */ }
      return mem.has(key) ? mem.get(key) : null;
    }

    function removeRaw(key) {
      mem.delete(key);
      memDirty.delete(key);
      try { storage.removeItem(key); } catch (_) { /* ignore */ }
    }

    function readJson(key, fallback) {
      const raw = readRaw(key);
      if (raw == null || raw === "") return fallback;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    }

    function writeJson(key, value) {
      writeRaw(key, JSON.stringify(value));
    }

    function readAnonRaw() {
      const data = readJson(KEYS.anon, []);
      return Array.isArray(data) ? data : [];
    }

    function writeAnonList(list) {
      if (!list.length) {
        removeRaw(KEYS.anon);
        return;
      }
      writeJson(KEYS.anon, list);
    }

    function readMigration() {
      const data = readJson(KEYS.migration, null);
      const pending = data && Array.isArray(data.pending) ? data.pending.map(normalizeExisting).filter(Boolean) : [];
      const doneIds = data && Array.isArray(data.doneIds) ? data.doneIds.filter(isSafeId) : [];
      const ownerUid = data && isSafeUid(data.ownerUid) ? data.ownerUid : null;
      return { ownerUid: ownerUid, pending: pending, doneIds: doneIds };
    }

    function writeMigration(mig) {
      writeJson(KEYS.migration, {
        ownerUid: mig.ownerUid || null,
        pending: mig.pending || [],
        doneIds: mig.doneIds || []
      });
    }

    function readCache(uid) {
      const data = readJson(KEYS.cache(uid), []);
      return Array.isArray(data) ? mergeAttempts([data]) : [];
    }

    function writeCache(uid, list) {
      writeJson(KEYS.cache(uid), mergeAttempts([list]));
    }

    function readOutbox(uid) {
      const data = readJson(KEYS.outbox(uid), []);
      return Array.isArray(data) ? mergeAttempts([data]) : [];
    }

    function writeOutbox(uid, list) {
      const merged = mergeAttempts([list]);
      if (!merged.length) removeRaw(KEYS.outbox(uid));
      else writeJson(KEYS.outbox(uid), merged);
    }

    function readClear(uid) {
      const data = readJson(KEYS.clear(uid), null);
      if (!data || !Number.isFinite(Number(data.clearedThrough)) || !Number.isFinite(Number(data.clearRev))) {
        return null;
      }
      const clearRev = asInt(data.clearRev);
      const clearedThrough = asInt(data.clearedThrough);
      if (clearRev < 0 || clearedThrough < 0) return null;
      return { clearRev: clearRev, clearedThrough: clearedThrough };
    }

    function writeClear(uid, next) {
      const prev = readClear(uid) || { clearRev: 0, clearedThrough: 0 };
      const merged = {
        clearRev: Math.max(prev.clearRev, asInt(next.clearRev)),
        clearedThrough: Math.max(prev.clearedThrough, asInt(next.clearedThrough))
      };
      writeJson(KEYS.clear(uid), merged);
      return merged;
    }

    function visible(list, clear) {
      if (!clear) return list.slice();
      return list.filter(function (entry) { return entry.t > clear.clearedThrough; });
    }

    const REVIEW_DEVICE = "ssco-vocab-review-events-v1";
    const REVIEW_MIGRATION = "ssco-vocab-review-migration-v1";
    function reviewStoreKey(uid) {
      return uid ? REVIEW_DEVICE + ":" + uid : REVIEW_DEVICE;
    }
    function reviewBoxKey(uid) {
      return "ssco-vocab-review-outbox-v1:" + uid;
    }
    function normalizeReview(raw) {
      if (!raw || typeof raw !== "object") return null;
      const t = Math.floor(Number(raw.t));
      if (!Number.isFinite(t) || t <= 0) return null;
      if (typeof raw.cardId !== "string" || !/^c_[0-9a-f]{16}$/.test(raw.cardId)) return null;
      if (typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(raw.id)) return null;
      const kinds = { new: 1, review: 1, manual: 1, remediation: 1 };
      const outcomes = { correct: 1, incorrect: 1, skip: 1, expose: 1 };
      return {
        id: raw.id,
        cardId: raw.cardId,
        t: t,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId.slice(0, 80) : "",
        kind: kinds[raw.kind] ? raw.kind : "manual",
        outcome: outcomes[raw.outcome] ? raw.outcome : "expose",
        hint: !!raw.hint,
        revealed: !!raw.revealed,
        initial: raw.initial !== false,
        v: 2
      };
    }
    function toFirestoreReview(event) {
      const clean = normalizeReview(event);
      if (!clean) throw new Error("invalid-review");
      return clean;
    }
    function readReviewList(uid) {
      const data = readJson(reviewStoreKey(uid), []);
      if (!Array.isArray(data)) return [];
      const map = new Map();
      data.forEach(function (raw) {
        const event = normalizeReview(raw);
        if (!event || map.has(event.id)) return;
        map.set(event.id, event);
      });
      return Array.from(map.values()).sort(function (a, b) {
        return a.t - b.t || (a.id < b.id ? -1 : 1);
      });
    }
    function writeReviewList(uid, list) {
      const clean = [];
      const seen = new Set();
      (list || []).forEach(function (raw) {
        const event = normalizeReview(raw);
        if (!event || seen.has(event.id)) return;
        seen.add(event.id);
        clean.push(event);
      });
      clean.sort(function (a, b) { return a.t - b.t || (a.id < b.id ? -1 : 1); });
      if (!clean.length) removeRaw(reviewStoreKey(uid));
      else writeJson(reviewStoreKey(uid), clean);
    }
    function readReviewBox(uid) {
      const data = readJson(reviewBoxKey(uid), []);
      return Array.isArray(data) ? data.map(normalizeReview).filter(Boolean) : [];
    }
    function writeReviewBox(uid, list) {
      const clean = [];
      const seen = new Set();
      (list || []).forEach(function (raw) {
        const event = normalizeReview(raw);
        if (!event || seen.has(event.id)) return;
        seen.add(event.id);
        clean.push(event);
      });
      if (!clean.length) removeRaw(reviewBoxKey(uid));
      else writeJson(reviewBoxKey(uid), clean);
    }
    let reviewCloud = "";
    function appendReview(event) {
      const clean = normalizeReview(event);
      if (!clean) return null;
      const uid = activeUid;
      const clear = uid ? readClear(uid) : null;
      if (clear && clean.t <= clear.clearedThrough) return null;
      const list = readReviewList(uid);
      if (!list.some(function (item) { return item.id === clean.id; })) {
        writeReviewList(uid, list.concat([clean]));
      }
      if (uid) {
        const box = readReviewBox(uid);
        if (!box.some(function (item) { return item.id === clean.id; })) writeReviewBox(uid, box.concat([clean]));
        scheduleFlush();
      }
      emitChange();
      return clean;
    }
    function getReviews() {
      const uid = activeUid;
      const clear = uid ? readClear(uid) : null;
      return readReviewList(uid).filter(function (event) {
        return !clear || event.t > clear.clearedThrough;
      });
    }
    function claimReviews(uid) {
      const mig = readJson(REVIEW_MIGRATION, null) || { ownerUid: null };
      if (mig.ownerUid && mig.ownerUid !== uid) return { blocked: true };
      const device = readReviewList(null);
      if (!mig.ownerUid) {
        writeJson(REVIEW_MIGRATION, { ownerUid: uid });
        if (device.length) {
          writeReviewList(uid, readReviewList(uid).concat(device));
          writeReviewBox(uid, readReviewBox(uid).concat(device));
          writeReviewList(null, []);
        }
      }
      return { blocked: false, claimed: !mig.ownerUid ? device.length : 0 };
    }

    function purgeUid(uid, through) {
      writeCache(uid, readCache(uid).filter(function (entry) { return entry.t > through; }));
      writeOutbox(uid, readOutbox(uid).filter(function (entry) { return entry.t > through; }));
      writeReviewList(uid, readReviewList(uid).filter(function (event) { return event.t > through; }));
      writeReviewBox(uid, readReviewBox(uid).filter(function (event) { return event.t > through; }));
      const mig = readMigration();
      if (mig.ownerUid === uid && mig.pending.length) {
        const dropped = mig.pending.filter(function (entry) { return entry.t <= through; });
        mig.pending = mig.pending.filter(function (entry) { return entry.t > through; });
        if (dropped.length) {
          mig.doneIds = Array.from(new Set(mig.doneIds.concat(dropped.map(function (entry) { return entry.id; }))));
        }
        writeMigration(mig);
      }
    }

    let activeUid = null;
    let activeEmail = "";
    let hadUser = false;
    let code = configuredFlag ? "checking" : (configProblem === "secret" ? "config-rejected" : "local-only");
    let errorDetail = "";
    let errorKind = "";
    let gen = 0;
    let transport = null;
    let sessionApi = null;
    let userChain = Promise.resolve();
    let chain = Promise.resolve();
    let lastIssuedT = 0;
    let lastRemoteClear = null;
    let sweptThrough = 0;
    let sawStale = false;
    let lastError = null;
    let retryMs = 3000;
    let staleGaveUp = 0;
    let readyResolve = function () {};
    const ready = new Promise(function (resolve) { readyResolve = resolve; });

    function entryCount() {
      try { return getEntries().length; } catch (_) { return 0; }
    }

    function buttonFor(statusCode, uid) {
      if (statusCode === "local-only") return "本機";
      if (statusCode === "config-rejected") return "設定錯誤";
      if (statusCode === "checking") return "檢查中";
      if (statusCode === "signing-in") return "登入中";
      if (!uid) return "登入";
      return "登出";
    }

    function detailFor(statusCode, uid, email, count) {
      if (statusCode === "local-only") return COPY.localOnly;
      if (statusCode === "config-rejected") return COPY.secretRejected;
      if (statusCode === "checking") return COPY.checking;
      if (statusCode === "signed-out") return COPY.signedOut;
      if (statusCode === "signed-out-after") return COPY.signedOutAfter;
      if (statusCode === "signing-in") return COPY.signingIn;
      if (statusCode === "syncing" || statusCode === "migrating") return COPY.syncing;
      if (statusCode === "offline") return COPY.offline;
      if (statusCode === "error") {
        if (errorKind === "auth") return errorDetail || "登入未完成。請再撳登入。紀錄同詞庫都未刪。";
        return "同步未成功：" + (errorDetail || "請稍後再試") + "。紀錄仍留喺呢部機，會再試。";
      }
      if (statusCode === "synced") {
        const who = email ? "已同步 · " + email + " · " : "已同步 · ";
        const tail = reviewCloud === "rules" ? " · 排程仍在本機，雲端規則未更新" : "";
        return who + "合併 " + count + " 筆" + tail;
      }
      return "";
    }

    function getStatus() {
      const count = entryCount();
      return {
        code: code,
        button: buttonFor(code, activeUid),
        busy: code === "checking" || code === "signing-in",
        detail: detailFor(code, activeUid, activeEmail, count),
        cloudConfigured: configuredFlag,
        uid: activeUid,
        email: activeEmail,
        count: count,
        configProblem: configProblem,
        pending: activeUid ? readOutbox(activeUid).length : 0,
        quotaProblem: !!quotaProblem,
        reviewCloud: reviewCloud
      };
    }

    function setCode(next) {
      if (next !== "error") errorKind = "";
      code = next;
      if (typeof opts.onStatus === "function") {
        try { opts.onStatus(getStatus()); } catch (_) { /* UI must not break sync */ }
      }
    }

    function emitChange() {
      if (typeof opts.onChange === "function") {
        try { opts.onChange(getEntries()); } catch (_) { /* ignore */ }
      }
      if (typeof opts.onStatus === "function") {
        try { opts.onStatus(getStatus()); } catch (_) { /* ignore */ }
      }
    }

    function isOnline() {
      if (typeof opts.online === "function") return opts.online() !== false;
      if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) return false;
      return true;
    }

    function getEntries() {
      if (activeUid) return visible(readCache(activeUid), readClear(activeUid));
      return mergeAttempts([readAnonRaw()]);
    }

    function nextT() {
      const clear = activeUid ? readClear(activeUid) : null;
      const floor = clear ? clear.clearedThrough + 1 : 0;
      const t = Math.max(Math.floor(Number(now()) || 0), floor, lastIssuedT + 1);
      lastIssuedT = t;
      return t;
    }

    function closeTransport() {
      if (transport && typeof transport.close === "function") {
        try { transport.close(); } catch (_) { /* ignore */ }
      }
      transport = null;
      lastRemoteClear = null;
      sweptThrough = 0;
      sawStale = false;
      staleGaveUp = 0;
    }

    function addOutbox(uid, entries) {
      writeOutbox(uid, readOutbox(uid).concat(entries));
    }

    function dropOutbox(uid, ids) {
      const drop = new Set(ids);
      writeOutbox(uid, readOutbox(uid).filter(function (entry) { return !drop.has(entry.id); }));
    }

    function ackMigration(ids) {
      const done = new Set(ids);
      const mig = readMigration();
      const acked = mig.pending.filter(function (entry) { return done.has(entry.id); });
      if (!acked.length) return;
      mig.pending = mig.pending.filter(function (entry) { return !done.has(entry.id); });
      mig.doneIds = Array.from(new Set(mig.doneIds.concat(acked.map(function (entry) { return entry.id; }))));
      writeMigration(mig);
    }

    function claimMigration(uid) {
      const mig = readMigration();
      if (mig.ownerUid && mig.ownerUid !== uid) return { blocked: true, claimed: 0 };
      const anon = readAnonRaw();
      const done = new Set(mig.doneIds);
      const pendingIds = new Set(mig.pending.map(function (entry) { return entry.id; }));
      const keep = [];
      const claimed = [];
      for (let i = 0; i < anon.length; i++) {
        const entry = normalizeExisting(anon[i]);
        if (!entry) {
          keep.push(anon[i]);
          continue;
        }
        if (done.has(entry.id) || pendingIds.has(entry.id)) continue;
        if (!mig.ownerUid) claimed.push(entry);
        else keep.push(entry);
      }
      if (!mig.ownerUid) {
        mig.ownerUid = uid;
        mig.pending = mig.pending.concat(claimed);
      }
      writeMigration(mig);
      writeAnonList(keep);
      const fresh = readMigration();
      const clear = readClear(uid);
      const pendingVisible = fresh.pending.filter(function (entry) {
        return !clear || entry.t > clear.clearedThrough;
      });
      const pendingDropped = fresh.pending.filter(function (entry) {
        return clear && entry.t <= clear.clearedThrough;
      });
      if (pendingDropped.length || pendingVisible.length !== fresh.pending.length) {
        fresh.pending = pendingVisible;
        fresh.doneIds = Array.from(new Set(fresh.doneIds.concat(pendingDropped.map(function (entry) { return entry.id; }))));
        writeMigration(fresh);
      }
      if (pendingVisible.length) {
        writeCache(uid, mergeAttempts([readCache(uid), pendingVisible]));
        addOutbox(uid, pendingVisible);
      }
      return { blocked: false, claimed: claimed.length };
    }

    function applyRemote(uid, remote) {
      if (!remote || typeof remote !== "object") return;
      if (remote.state && Number.isFinite(Number(remote.state.clearedThrough))) {
        lastRemoteClear = {
          clearRev: asInt(remote.state.clearRev),
          clearedThrough: asInt(remote.state.clearedThrough)
        };
        writeClear(uid, lastRemoteClear);
      } else if (remote.state == null && Object.prototype.hasOwnProperty.call(remote, "state")) {
        lastRemoteClear = { clearRev: 0, clearedThrough: 0 };
      }
      const clear = readClear(uid);
      if (clear) purgeUid(uid, clear.clearedThrough);
      const incoming = mergeAttempts([remote.attempts || []]);
      const stale = clear ? incoming.filter(function (entry) { return entry.t <= clear.clearedThrough; }) : [];
      if (stale.length) sawStale = true;
      const fresh = clear ? incoming.filter(function (entry) { return entry.t > clear.clearedThrough; }) : incoming;
      writeCache(uid, mergeAttempts([readCache(uid), fresh]));
    }

    function needsClearPush(local, remote) {
      if (!local || (local.clearRev === 0 && local.clearedThrough === 0)) return false;
      if (!remote) return true;
      return local.clearRev > remote.clearRev || local.clearedThrough > remote.clearedThrough;
    }

    function noteAuthError(err) {
      errorKind = "auth";
      errorDetail = errorText(err);
      lastError = err;
      setCode("error");
    }

    function isAuthFlowError(err) {
      const code = String((err && (err.code || err.message)) || "");
      return code.includes("auth/") || code.includes("popup") || code.includes("redirect-result") || code.includes("unauthorized-domain");
    }

    function handleFlushError(err, myGen) {
      if (myGen !== gen || !activeUid) return;
      lastError = err;
      if (!isOnline() || isOfflineError(err)) {
        setCode("offline");
        if (opts.autoRetry === false) return;
        const wait = retryMs;
        retryMs = Math.min(retryMs * 2, 30000);
        setTimeout(function () { scheduleFlush(); }, wait);
        return;
      }
      errorKind = "";
      errorDetail = errorText(err);
      setCode("error");
      if (opts.autoRetry === false) return;
      const waitErr = retryMs;
      retryMs = Math.min(retryMs * 2, 30000);
      setTimeout(function () { scheduleFlush(); }, waitErr);
    }

    async function flushOnce(myGen) {
      if (myGen !== gen) return;
      const uid = activeUid;
      if (!uid || !transport) return;
      if (!isOnline()) {
        setCode("offline");
        return;
      }
      const pendingBefore = readOutbox(uid).length;
      const localBefore = readClear(uid);
      if (pendingBefore || needsClearPush(localBefore, lastRemoteClear) || sawStale) setCode("syncing");
      sawStale = false;
      const remote = await transport.pull();
      if (myGen !== gen || activeUid !== uid) return;
      applyRemote(uid, remote);
      const localClear = readClear(uid);
      if (needsClearPush(localClear, lastRemoteClear)) {
        await transport.pushClear({
          clearRev: localClear.clearRev,
          clearedThrough: localClear.clearedThrough
        });
        if (myGen !== gen || activeUid !== uid) return;
        lastRemoteClear = { clearRev: localClear.clearRev, clearedThrough: localClear.clearedThrough };
      }
      const through = localClear ? localClear.clearedThrough : 0;
      if (through > 0 && staleGaveUp !== through && (through > sweptThrough || sawStale)) {
        await transport.deleteCleared(through);
        if (myGen !== gen || activeUid !== uid) return;
        if (sweptThrough === through && sawStale) staleGaveUp = through;
        sweptThrough = through;
        sawStale = false;
      }
      let guard = 0;
      while (guard < 1000) {
        guard += 1;
        if (myGen !== gen || activeUid !== uid) return;
        const clearNow = readClear(uid);
        const queued = readOutbox(uid);
        const tooOld = clearNow ? queued.filter(function (entry) { return entry.t <= clearNow.clearedThrough; }) : [];
        if (tooOld.length) {
          dropOutbox(uid, tooOld.map(function (entry) { return entry.id; }));
          ackMigration(tooOld.map(function (entry) { return entry.id; }));
        }
        const batch = readOutbox(uid).filter(function (entry) {
          return !clearNow || entry.t > clearNow.clearedThrough;
        }).slice(0, PUSH_BATCH);
        if (!batch.length) break;
        let result;
        try {
          result = await transport.pushAttempts(batch.map(toFirestoreAttempt));
        } catch (err) {
          if (err && Array.isArray(err.ackedIds) && err.ackedIds.length) {
            dropOutbox(uid, err.ackedIds);
            ackMigration(err.ackedIds);
          }
          throw err;
        }
        if (myGen !== gen || activeUid !== uid) return;
        const rejected = new Set((result && result.rejected) || []);
        const dropped = [];
        const blocked = [];
        batch.forEach(function (entry) {
          if (!rejected.has(entry.id)) dropped.push(entry.id);
          else if (clearNow && entry.t <= clearNow.clearedThrough) dropped.push(entry.id);
          else blocked.push(entry);
        });
        dropOutbox(uid, dropped);
        ackMigration(dropped);
        if (blocked.length) {
          const denied = new Error("permission-denied");
          denied.code = "permission-denied";
          throw denied;
        }
      }
      if (myGen !== gen || activeUid !== uid) return;
      if (transport.pullReviews || transport.pushReviews || transport.deleteClearedReviews) {
        const clearNow = readClear(uid);
        try {
          if (transport.pullReviews) {
            const remote = await transport.pullReviews();
            const incoming = (remote || []).map(normalizeReview).filter(Boolean).filter(function (event) {
              return !clearNow || event.t > clearNow.clearedThrough;
            });
            writeReviewList(uid, readReviewList(uid).concat(incoming));
          }
          if (transport.pushReviews) {
            const box = readReviewBox(uid).filter(function (event) {
              return !clearNow || event.t > clearNow.clearedThrough;
            });
            if (box.length) {
              const result = await transport.pushReviews(box.map(toFirestoreReview));
              const rejected = new Set((result && result.rejected) || []);
              writeReviewBox(uid, box.filter(function (event) { return rejected.has(event.id); }));
            }
          }
          if (transport.deleteClearedReviews && clearNow && clearNow.clearedThrough > 0) {
            await transport.deleteClearedReviews(clearNow.clearedThrough);
          }
          reviewCloud = "";
        } catch (err) {
          const denied = String((err && err.code) || "").includes("permission-denied");
          if (!denied) throw err;
          reviewCloud = "rules";
        }
      }
      if (myGen !== gen || activeUid !== uid) return;
      retryMs = 3000;
      lastError = null;
      if (quotaProblem) {
        errorDetail = errorText("quota");
        setCode("error");
        return;
      }
      setCode("synced");
      emitChange();
    }

    function scheduleFlush() {
      const scheduledGen = gen;
      chain = chain.then(function () {
        return flushOnce(scheduledGen);
      }).catch(function (err) {
        handleFlushError(err, scheduledGen);
      });
      return chain;
    }

    async function handleUser(user) {
      const my = ++gen;
      closeTransport();
      if (!user || !isSafeUid(user.uid)) {
        const showAfter = hadUser;
        activeUid = null;
        activeEmail = "";
        if (user && !isSafeUid(user.uid)) {
          errorDetail = "帳戶編號格式異常";
          setCode("error");
        } else {
          setCode(showAfter ? "signed-out-after" : "signed-out");
        }
        emitChange();
        return;
      }
      hadUser = true;
      activeUid = user.uid;
      activeEmail = typeof user.email === "string" ? user.email : "";
      const existingClear = readClear(user.uid);
      if (existingClear) purgeUid(user.uid, existingClear.clearedThrough);
      const claim = claimMigration(user.uid);
      claimReviews(user.uid);
      if (my !== gen) return;
      if (claim.claimed > 0) setCode("migrating");
      emitChange();
      if (!sessionApi || typeof sessionApi.connect !== "function") {
        errorDetail = errorText("not-ready");
        setCode("error");
        return;
      }
      try {
        transport = await sessionApi.connect(user.uid);
      } catch (err) {
        if (my !== gen) return;
        handleFlushError(err, my);
        return;
      }
      if (my !== gen) {
        closeTransport();
        return;
      }
      if (transport && typeof transport.subscribe === "function") {
        try {
          transport.subscribe(function () {
            if (my === gen) scheduleFlush();
          });
        } catch (_) { /* pull-on-flush still works */ }
      }
      await scheduleFlush();
    }

    function signInPrompt() {
      const mig = readMigration();
      const hasAnon = readAnonRaw().some(function (raw) { return !!normalizeExisting(raw); });
      if (!mig.ownerUid && hasAnon) return COPY.signInClaim;
      if (mig.ownerUid && hasAnon) return COPY.signInOther;
      return "";
    }

    function clearPrompt() {
      return activeUid ? COPY.clearAccount : COPY.clearAnon;
    }

    async function signIn() {
      if (!configuredFlag) {
        const err = new Error("unconfigured");
        err.code = "unconfigured";
        throw err;
      }
      if (!sessionApi || typeof sessionApi.signIn !== "function") {
        const err = new Error("not-ready");
        err.code = "not-ready";
        throw err;
      }
      setCode("signing-in");
      try {
        await sessionApi.signIn();
        await userChain;
        await chain;
      } catch (err) {
        if (!activeUid) {
          if (isCancelError(err)) setCode(hadUser ? "signed-out-after" : "signed-out");
          else {
            noteAuthError(err);
          }
        }
        throw err;
      }
    }

    async function signOut() {
      if (sessionApi && typeof sessionApi.signOut === "function") await sessionApi.signOut();
      await userChain;
      if (activeUid) {
        userChain = handleUser(null);
        await userChain;
      }
    }

    function record(input) {
      const source = input || {};
      let id = newId();
      if (!isSafeId(id)) id = defaultNewId();
      const entry = normalizeExisting({
        id: id,
        t: nextT(),
        day: source.day,
        unit: source.unit,
        zh: source.zh,
        answer: source.answer,
        typed: source.typed,
        ok: source.ok
      });
      if (!activeUid) {
        const existing = mergeAttempts([readAnonRaw()]);
        existing.push(entry);
        existing.sort(function (a, b) { return a.t - b.t || (a.id < b.id ? -1 : 1); });
        writeAnonList(existing.slice(-LOG_MAX));
        emitChange();
        return entry;
      }
      writeCache(activeUid, mergeAttempts([readCache(activeUid), [entry]]));
      addOutbox(activeUid, [entry]);
      emitChange();
      scheduleFlush();
      return entry;
    }

    async function clearActive() {
      if (!activeUid) {
        writeAnonList([]);
        writeReviewList(null, []);
        emitChange();
        return { scope: "device", pendingUpload: false };
      }
      const uid = activeUid;
      const prev = readClear(uid) || { clearRev: 0, clearedThrough: 0 };
      const mig = readMigration();
      const pool = readCache(uid).concat(readOutbox(uid), readReviewList(uid), mig.ownerUid === uid ? mig.pending : []);
      const maxT = pool.reduce(function (max, entry) {
        return Math.max(max, entry && entry.t ? entry.t : 0);
      }, 0);
      const clearedThrough = Math.max(prev.clearedThrough, maxT, Math.floor(Number(now()) || 0));
      writeClear(uid, { clearRev: prev.clearRev + 1, clearedThrough: clearedThrough });
      purgeUid(uid, clearedThrough);
      emitChange();
      if (!transport || !isOnline()) {
        setCode("offline");
        return { scope: "account", pendingUpload: true, clearedThrough: clearedThrough };
      }
      await scheduleFlush();
      if (code === "error" && isOnline()) throw lastError || new Error("sync");
      return {
        scope: "account",
        pendingUpload: readOutbox(uid).length > 0 || needsClearPush(readClear(uid), lastRemoteClear),
        clearedThrough: clearedThrough
      };
    }

    function reportScopeLine() {
      if (configProblem === "secret") return "紀錄範圍：本機（雲端設定被拒絕）";
      if (!configuredFlag) return "紀錄範圍：本機（未設定雲端）";
      if (!activeUid) return "紀錄範圍：本機未登入（最多 200 筆）";
      return "紀錄範圍：Google 帳戶合併（" + getEntries().length + " 筆）";
    }

    if (opts.listenWindow !== false && typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("online", function () { scheduleFlush(); });
      window.addEventListener("offline", function () {
        if (activeUid) setCode("offline");
      });
      window.addEventListener("storage", function (event) {
        if (!event || !event.key || !activeUid) return;
        if (
          event.key === KEYS.cache(activeUid) ||
          event.key === KEYS.outbox(activeUid) ||
          event.key === KEYS.clear(activeUid)
        ) {
          const clear = readClear(activeUid);
          if (clear) purgeUid(activeUid, clear.clearedThrough);
          emitChange();
          scheduleFlush();
        }
      });
    }

    if (!configuredFlag) {
      setCode(configProblem === "secret" ? "config-rejected" : "local-only");
      readyResolve();
    } else if (typeof opts.openSession !== "function") {
      errorDetail = errorText("not-ready");
      setCode("error");
      readyResolve();
    } else {
      setCode("checking");
      Promise.resolve()
        .then(function () {
          return opts.openSession({
            onUser: function (user) {
              userChain = handleUser(user);
              return userChain;
            },
            onError: function (err) {
              if (!activeUid && isAuthFlowError(err)) {
                noteAuthError(err);
                return;
              }
              handleFlushError(err, gen);
            }
          });
        })
        .then(function (api) {
          sessionApi = api || null;
          if (!sessionApi) {
            errorDetail = errorText("not-ready");
            setCode("error");
          }
        })
        .catch(function (err) {
          errorDetail = errorText(err && err.code ? err : "load-failed");
          lastError = err;
          setCode("error");
        })
        .then(function () {
          readyResolve();
        });
    }

    return {
      ready: ready,
      getEntries: getEntries,
      getStatus: getStatus,
      record: record,
      clearActive: clearActive,
      clearPrompt: clearPrompt,
      signIn: signIn,
      signOut: signOut,
      signInPrompt: signInPrompt,
      signOutPrompt: function () { return COPY.signOut; },
      unconfiguredPrompt: function () {
        return configProblem === "secret" ? COPY.secretRejected : COPY.unconfiguredClick;
      },
      reportScopeLine: reportScopeLine,
      errorText: errorText,
      appendReview: appendReview,
      getReviews: getReviews,
      flush: function () { return scheduleFlush(); },
      settled: function () { return chain; },
      prompts: COPY
    };
  }

  return {
    createHistoryController: createHistoryController,
    legacyAttemptId: legacyAttemptId,
    mergeAttempts: mergeAttempts,
    normalizeExisting: normalizeExisting,
    isFirebaseConfig: isFirebaseConfig,
    inspectConfig: inspectConfig,
    toFirestoreAttempt: toFirestoreAttempt,
    errorText: errorText,
    ANON_LOG_KEY: ANON_LOG_KEY,
    LOG_MAX: LOG_MAX,
    KEYS: KEYS,
    COPY: COPY
  };
});
