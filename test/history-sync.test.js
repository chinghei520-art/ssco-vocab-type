"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sync = require("../history-sync.js");

const SAMPLE = {
  t: 1700000000000,
  day: "2026-11-15",
  unit: "U",
  zh: "中",
  answer: "Hello",
  typed: "helo",
  ok: false
};

function memoryStorage(initial) {
  const data = new Map(initial || []);
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    }
  };
}

function createMemoryCloud() {
  const users = new Map();
  const api = {
    failPushes: 0,
    pushCalls: 0,
    ops: [],
    bucket(uid) {
      if (!users.has(uid)) users.set(uid, { state: null, attempts: new Map(), listeners: new Set() });
      return users.get(uid);
    },
    dump(uid) {
      const bucket = api.bucket(uid);
      return {
        state: bucket.state ? { ...bucket.state } : null,
        attempts: [...bucket.attempts.values()].map((entry) => ({ ...entry }))
      };
    },
    connect(uid) {
      const bucket = api.bucket(uid);
      const emit = function () {
        [...bucket.listeners].forEach((fn) => fn());
      };
      return {
        async pull() {
          return {
            state: bucket.state ? { ...bucket.state } : null,
            attempts: [...bucket.attempts.values()].map((entry) => ({ ...entry }))
          };
        },
        subscribe(cb) {
          bucket.listeners.add(cb);
          return function () { bucket.listeners.delete(cb); };
        },
        async pushAttempts(list) {
          api.pushCalls += 1;
          api.ops.push("attempts:" + list.length);
          if (api.failPushes > 0) {
            api.failPushes -= 1;
            const err = new Error("unavailable");
            err.code = "unavailable";
            throw err;
          }
          const rejected = [];
          for (const entry of list) {
            if (bucket.state && entry.t <= bucket.state.clearedThrough) {
              rejected.push(entry.id);
              continue;
            }
            const prev = bucket.attempts.get(entry.id);
            if (prev) {
              if (JSON.stringify(prev) !== JSON.stringify(entry)) rejected.push(entry.id);
              continue;
            }
            bucket.attempts.set(entry.id, { ...entry });
          }
          emit();
          return { rejected };
        },
        async pushClear(state) {
          api.ops.push("clear");
          if (bucket.state) {
            if (state.clearRev < bucket.state.clearRev || state.clearedThrough < bucket.state.clearedThrough) {
              const err = new Error("permission-denied");
              err.code = "permission-denied";
              throw err;
            }
          }
          bucket.state = { clearRev: state.clearRev, clearedThrough: state.clearedThrough };
          emit();
        },
        async deleteCleared(through) {
          api.ops.push("delete");
          let changed = false;
          for (const [id, entry] of bucket.attempts) {
            if (entry.t <= through) {
              bucket.attempts.delete(id);
              changed = true;
            }
          }
          if (changed) emit();
        },
        close() {}
      };
    }
  };
  return api;
}

async function boot(options) {
  const cloud = options.cloud;
  const identity = { uid: options.uid || "alice", email: options.email || "alice@example.com" };
  let current = null;
  let handlers = null;
  const ctl = sync.createHistoryController({
    storage: options.storage,
    now: options.now || function () { return 1700000000000; },
    forceCloud: true,
    autoRetry: false,
    listenWindow: false,
    online: options.online || function () { return true; },
    openSession(next) {
      handlers = next;
      next.onUser(null);
      return {
        async signIn() {
          current = { uid: identity.uid, email: identity.email };
          await next.onUser(current);
        },
        async signOut() {
          current = null;
          await next.onUser(null);
        },
        connect(uid) {
          if (!current || current.uid !== uid) {
            const err = new Error("permission-denied");
            err.code = "permission-denied";
            return Promise.reject(err);
          }
          return Promise.resolve(cloud.connect(uid));
        }
      };
    }
  });
  await ctl.ready;
  ctl.become = function (uid, email) {
    identity.uid = uid;
    identity.email = email || uid + "@example.com";
  };
  ctl._handlers = handlers;
  return ctl;
}

function anonEntry(overrides) {
  return Object.assign({
    t: 1700000000000,
    day: "2026-11-15",
    unit: "Station Ops / Service English",
    zh: "重設",
    answer: "reset",
    typed: "reseted",
    ok: false
  }, overrides);
}

test("legacy ids are stable and order-independent", function () {
  const id = sync.legacyAttemptId(SAMPLE);
  assert.equal(id, "leg_623af76d448ffdab");
  assert.equal(sync.legacyAttemptId(SAMPLE), id);
  const withId = sync.normalizeExisting(Object.assign({ id: id }, SAMPLE));
  assert.equal(withId.id, id);
  const flipped = sync.normalizeExisting(Object.assign({}, SAMPLE));
  assert.equal(flipped.id, id);
});

test("merge counts one row per id", function () {
  const entry = sync.normalizeExisting(SAMPLE);
  const merged = sync.mergeAttempts([[entry], [Object.assign({}, entry), Object.assign({}, entry, { t: entry.t + 5, id: "a_bbbbbbbbbbbbbbbb" })]]);
  assert.equal(merged.length, 2);
  assert.equal(merged.filter((row) => row.id === entry.id).length, 1);
});

test("placeholder, empty, and secret configs are not live", function () {
  assert.equal(sync.inspectConfig(null).reason, "missing");
  assert.equal(sync.isFirebaseConfig({
    apiKey: "YOUR_WEB_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    appId: "YOUR_APP_ID"
  }), false);
  const secret = sync.inspectConfig({
    apiKey: "public",
    authDomain: "example.firebaseapp.com",
    projectId: "example",
    appId: "1:2:web:abc",
    private_key: "-----BEGIN PRIVATE KEY-----\nabc"
  });
  assert.equal(secret.ok, false);
  assert.equal(secret.reason, "secret");
  assert.equal(sync.isFirebaseConfig({
    apiKey: "AIzaSyDemoKeyValue123456",
    authDomain: "ssco-demo.firebaseapp.com",
    projectId: "ssco-demo",
    appId: "1:123:web:abc"
  }), true);
});

test("signed-out history stays capped at 200 and account history does not", async function () {
  const storage = memoryStorage();
  const cloud = createMemoryCloud();
  const anon = await boot({ storage, cloud, uid: "alice" });
  for (let i = 0; i < 205; i++) {
    anon.record({ day: "2026-11-15", unit: "U", zh: "題" + i, answer: "A" + i, typed: "x", ok: false });
  }
  assert.equal(anon.getEntries().length, 200);
  assert.equal(anon.getEntries()[0].answer, "A5");
  assert.equal(anon.reportScopeLine(), "紀錄範圍：本機未登入（最多 200 筆）");
  const stored = JSON.parse(storage.getItem(sync.ANON_LOG_KEY));
  assert.equal(stored.length, 200);

  await anon.clearActive();
  await anon.signIn();
  for (let i = 0; i < 250; i++) {
    anon.record({ day: "2026-11-16", unit: "U", zh: "雲" + i, answer: "C" + i, typed: "y", ok: i % 2 === 0 });
  }
  await anon.flush();
  assert.equal(anon.getEntries().length, 250);
  assert.equal(cloud.dump("alice").attempts.length, 250);
  assert.match(anon.reportScopeLine(), /Google 帳戶合併（250 筆）/);
  const today = anon.getEntries().filter((entry) => entry.day === "2026-11-16");
  assert.equal(today.length, 250);
});

test("migration is idempotent and preserves attempt fields", async function () {
  const storage = memoryStorage();
  const cloud = createMemoryCloud();
  const rows = [
    anonEntry({ t: 100, typed: "reseted", ok: false }),
    anonEntry({ t: 101, typed: "reset", ok: true }),
    anonEntry({ t: 102, answer: "berthed", zh: "停", typed: "berth", ok: false })
  ];
  storage.setItem(sync.ANON_LOG_KEY, JSON.stringify(rows));
  storage.setItem("ssco-vocab-items-v1", "[{\"unit\":\"keep\"}]");
  storage.setItem("ssco-vocab-session-v1", "{\"v\":1}");

  const first = await boot({ storage, cloud, uid: "alice", email: "alice@example.com" });
  assert.match(first.signInPrompt(), /第一個登入/);
  await first.signIn();
  assert.equal(first.getEntries().length, 3);
  assert.equal(cloud.dump("alice").attempts.length, 3);
  assert.equal(storage.getItem(sync.ANON_LOG_KEY), null);
  const uploaded = cloud.dump("alice").attempts.find((entry) => entry.t === 100);
  assert.equal(uploaded.zh, "重設");
  assert.equal(uploaded.answer, "reset");
  assert.equal(uploaded.typed, "reseted");
  assert.equal(uploaded.ok, false);
  assert.equal(uploaded.unit, "Station Ops / Service English");
  assert.equal(uploaded.id, sync.legacyAttemptId(sync.normalizeExisting(rows[0])));

  const second = await boot({ storage, cloud, uid: "alice", email: "alice@example.com" });
  await second.signIn();
  assert.equal(second.getEntries().length, 3);
  assert.equal(cloud.dump("alice").attempts.length, 3);
  assert.equal(storage.getItem("ssco-vocab-items-v1"), "[{\"unit\":\"keep\"}]");
  assert.equal(storage.getItem("ssco-vocab-session-v1"), "{\"v\":1}");
});

test("a pre-existing log larger than 200 is migrated whole", async function () {
  const storage = memoryStorage();
  const cloud = createMemoryCloud();
  const rows = [];
  for (let i = 0; i < 230; i++) rows.push(anonEntry({ t: 1000 + i, answer: "W" + i, zh: "字" + i }));
  storage.setItem(sync.ANON_LOG_KEY, JSON.stringify(rows));
  const ctl = await boot({ storage, cloud });
  await ctl.signIn();
  assert.equal(ctl.getEntries().length, 230);
  assert.equal(cloud.dump("alice").attempts.length, 230);
});

test("failed migration retries without duplicates and does not transfer to another account", async function () {
  const storage = memoryStorage();
  const cloud = createMemoryCloud();
  storage.setItem(sync.ANON_LOG_KEY, JSON.stringify([
    anonEntry({ t: 10 }),
    anonEntry({ t: 11, ok: true, typed: "reset" })
  ]));
  cloud.failPushes = 1;
  const ctl = await boot({ storage, cloud, uid: "alice" });
  await ctl.signIn();
  assert.equal(ctl.getStatus().code, "offline");
  assert.equal(cloud.dump("alice").attempts.length, 0);
  assert.equal(storage.getItem(sync.ANON_LOG_KEY), null);
  assert.equal(ctl.getEntries().length, 2);
  assert.ok(storage.getItem(sync.KEYS.cache("alice")));

  await ctl.signOut();
  assert.equal(ctl.getEntries().length, 0);
  assert.match(ctl.getStatus().detail, /唔會顯示上一個帳戶/);
  ctl.become("bob", "bob@example.com");
  await ctl.signIn();
  assert.equal(ctl.getEntries().length, 0);
  assert.equal(cloud.dump("bob").attempts.length, 0);
  assert.equal(cloud.dump("alice").attempts.length, 0);
  await ctl.signOut();

  ctl.become("alice", "alice@example.com");
  await ctl.signIn();
  assert.equal(ctl.getStatus().code, "synced");
  assert.equal(ctl.getEntries().length, 2);
  assert.equal(cloud.dump("alice").attempts.length, 2);
  await ctl.flush();
  assert.equal(cloud.dump("alice").attempts.length, 2);
});

test("later signed-out rows are not claimed by the next account", async function () {
  const storage = memoryStorage();
  const cloud = createMemoryCloud();
  storage.setItem(sync.ANON_LOG_KEY, JSON.stringify([anonEntry({ t: 10 })]));
  const ctl = await boot({ storage, cloud, uid: "alice" });
  await ctl.signIn();
  await ctl.signOut();
  ctl.record({ day: "2026-11-20", unit: "U", zh: "之後", answer: "later", typed: "later", ok: true });
  assert.match(ctl.signInPrompt(), /唔會搬去新帳戶/);
  ctl.become("bob", "bob@example.com");
  await ctl.signIn();
  assert.equal(ctl.getEntries().length, 0);
  assert.equal(cloud.dump("bob").attempts.length, 0);
  assert.equal(cloud.dump("alice").attempts.length, 1);
  const anon = JSON.parse(storage.getItem(sync.ANON_LOG_KEY));
  assert.equal(anon.length, 1);
  assert.equal(anon[0].answer, "later");
});

test("offline writes retry once and concurrent devices union by id", async function () {
  const cloud = createMemoryCloud();
  const storageA = memoryStorage();
  const storageB = memoryStorage();
  let onlineA = true;
  const a = await boot({
    storage: storageA,
    cloud,
    uid: "alice",
    email: "alice@example.com",
    online: function () { return onlineA; }
  });
  const b = await boot({
    storage: storageB,
    cloud,
    uid: "alice",
    email: "alice@example.com"
  });
  await a.signIn();
  await b.signIn();
  onlineA = false;
  a.record({ day: "2026-11-15", unit: "U", zh: "離線", answer: "offline", typed: "off", ok: false });
  await a.flush();
  assert.equal(a.getStatus().code, "offline");
  assert.equal(cloud.dump("alice").attempts.length, 0);
  onlineA = true;
  await a.flush();
  assert.equal(a.getStatus().code, "synced");
  assert.equal(cloud.dump("alice").attempts.length, 1);
  await a.flush();
  assert.equal(cloud.dump("alice").attempts.length, 1);

  b.record({ day: "2026-11-15", unit: "U", zh: "另一部", answer: "other", typed: "oth", ok: true });
  await b.flush();
  await a.flush();
  assert.equal(cloud.dump("alice").attempts.length, 2);
  assert.equal(a.getEntries().length, 2);
  assert.equal(b.getEntries().length, 2);
  const ids = new Set(a.getEntries().map((entry) => entry.id));
  assert.equal(ids.size, 2);
});

test("the same legacy row uploaded from two browsers counts once", async function () {
  const cloud = createMemoryCloud();
  const row = JSON.stringify([anonEntry({ t: 50 })]);
  const a = await boot({ storage: memoryStorage([[sync.ANON_LOG_KEY, row]]), cloud, uid: "alice" });
  const b = await boot({ storage: memoryStorage([[sync.ANON_LOG_KEY, row]]), cloud, uid: "alice" });
  await a.signIn();
  await b.signIn();
  await a.flush();
  assert.equal(cloud.dump("alice").attempts.length, 1);
  assert.equal(a.getEntries().length, 1);
  assert.equal(b.getEntries().length, 1);
});

test("clear writes a forward-only tombstone and does not resurrect", async function () {
  const cloud = createMemoryCloud();
  let clock = 1700000000000;
  const storageA = memoryStorage();
  const storageB = memoryStorage();
  const a = await boot({ storage: storageA, cloud, uid: "alice", now: function () { return clock; } });
  const b = await boot({ storage: storageB, cloud, uid: "alice", now: function () { return clock; } });
  storageA.setItem("ssco-vocab-items-v1", "[1]");
  storageA.setItem("ssco-vocab-session-v1", "{\"v\":1}");
  await a.signIn();
  await b.signIn();
  a.record({ day: "2026-11-15", unit: "U", zh: "舊", answer: "old", typed: "old", ok: false });
  await a.flush();
  await b.flush();
  assert.equal(b.getEntries().length, 1);
  const oldEntry = b.getEntries()[0];

  clock = 1700000005000;
  assert.match(a.clearPrompt(), /所有裝置/);
  assert.match(a.clearPrompt(), /唔會再出現/);
  const beforeOps = cloud.ops.length;
  await a.clearActive();
  assert.equal(a.getEntries().length, 0);
  assert.ok(cloud.dump("alice").state.clearedThrough >= 1700000005000);
  assert.equal(cloud.dump("alice").attempts.length, 0);
  assert.ok(cloud.ops.slice(beforeOps).indexOf("clear") < cloud.ops.slice(beforeOps).indexOf("delete"));
  assert.equal(storageA.getItem("ssco-vocab-items-v1"), "[1]");
  assert.equal(storageA.getItem("ssco-vocab-session-v1"), "{\"v\":1}");

  storageB.setItem(sync.KEYS.outbox("alice"), JSON.stringify([oldEntry]));
  await b.flush();
  assert.equal(b.getEntries().length, 0);
  assert.equal(cloud.dump("alice").attempts.some((entry) => entry.id === oldEntry.id), false);
  assert.equal(b.getEntries().some((entry) => entry.id === oldEntry.id), false);

  clock = 1700000009000;
  const fresh = b.record({ day: "2026-11-16", unit: "U", zh: "新", answer: "new", typed: "new", ok: true });
  await b.flush();
  await a.flush();
  assert.equal(a.getEntries().length, 1);
  assert.equal(a.getEntries()[0].id, fresh.id);
  assert.equal(cloud.dump("alice").attempts.length, 1);

  cloud.bucket("alice").attempts.set("leg_aaaaaaaaaaaaaaaa", {
    id: "leg_aaaaaaaaaaaaaaaa",
    t: 10,
    day: "2026-11-01",
    unit: "U",
    zh: "舊",
    answer: "stale",
    typed: "stale",
    ok: false,
    v: 1
  });
  await a.flush();
  assert.equal(a.getEntries().some((entry) => entry.answer === "stale"), false);
  assert.equal(cloud.dump("alice").attempts.some((entry) => entry.answer === "stale"), false);
});

test("signed-out clear does not delete account or cloud history", async function () {
  const storage = memoryStorage();
  const cloud = createMemoryCloud();
  const ctl = await boot({ storage, cloud, uid: "alice" });
  await ctl.signIn();
  ctl.record({ day: "2026-11-15", unit: "U", zh: "留", answer: "keep", typed: "keep", ok: true });
  await ctl.flush();
  await ctl.signOut();
  ctl.record({ day: "2026-11-15", unit: "U", zh: "本機", answer: "local", typed: "local", ok: false });
  assert.match(ctl.clearPrompt(), /唔會刪除任何雲端/);
  const ops = cloud.ops.length;
  await ctl.clearActive();
  assert.equal(ctl.getEntries().length, 0);
  assert.equal(cloud.ops.length, ops);
  assert.equal(cloud.dump("alice").state, null);
  assert.equal(cloud.dump("alice").attempts.length, 1);
  await ctl.signIn();
  assert.equal(ctl.getEntries().length, 1);
  assert.equal(ctl.getEntries()[0].answer, "keep");
});

test("sign-out does not write a clear and does not copy account rows into the anon log", async function () {
  const storage = memoryStorage();
  const cloud = createMemoryCloud();
  const ctl = await boot({ storage, cloud });
  await ctl.signIn();
  ctl.record({ day: "2026-11-15", unit: "U", zh: "雲", answer: "cloud", typed: "cloud", ok: true });
  await ctl.flush();
  const ops = cloud.ops.length;
  await ctl.signOut();
  assert.equal(cloud.ops.length, ops);
  assert.equal(storage.getItem(sync.ANON_LOG_KEY), null);
  assert.equal(ctl.getStatus().uid, null);
  assert.match(ctl.signOutPrompt(), /唔會刪除/);
});

test("offline clear stays cleared after reconnect", async function () {
  const cloud = createMemoryCloud();
  let online = true;
  let clock = 1700000000000;
  const ctl = await boot({
    storage: memoryStorage(),
    cloud,
    online: function () { return online; },
    now: function () { return clock; }
  });
  await ctl.signIn();
  ctl.record({ day: "2026-11-15", unit: "U", zh: "清", answer: "gone", typed: "gone", ok: false });
  await ctl.flush();
  online = false;
  clock = 1700000008000;
  const result = await ctl.clearActive();
  assert.equal(result.pendingUpload, true);
  assert.equal(ctl.getEntries().length, 0);
  assert.equal(cloud.dump("alice").attempts.length, 1);
  online = true;
  await ctl.flush();
  assert.equal(cloud.dump("alice").attempts.length, 0);
  assert.ok(cloud.dump("alice").state.clearedThrough >= 1700000008000);
  await ctl.flush();
  assert.equal(cloud.dump("alice").attempts.length, 0);
  assert.equal(ctl.getEntries().length, 0);
});

test("push retry after a transport failure does not duplicate", async function () {
  const cloud = createMemoryCloud();
  const ctl = await boot({ storage: memoryStorage(), cloud });
  await ctl.signIn();
  cloud.failPushes = 1;
  ctl.record({ day: "2026-11-15", unit: "U", zh: "重試", answer: "retry", typed: "r", ok: false });
  await ctl.settled();
  assert.equal(ctl.getStatus().code, "offline");
  assert.equal(cloud.dump("alice").attempts.length, 0);
  await ctl.flush();
  assert.equal(ctl.getStatus().code, "synced");
  assert.equal(cloud.dump("alice").attempts.length, 1);
  await ctl.flush();
  assert.equal(cloud.dump("alice").attempts.length, 1);
});

test("more than one upload batch still merges as a single history", async function () {
  const cloud = createMemoryCloud();
  const ctl = await boot({ storage: memoryStorage(), cloud });
  await ctl.signIn();
  cloud.pushCalls = 0;
  for (let i = 0; i < 450; i++) {
    ctl.record({ day: "2026-11-15", unit: "U", zh: "批", answer: "B" + i, typed: "b", ok: true });
  }
  await ctl.flush();
  assert.equal(ctl.getEntries().length, 450);
  assert.equal(cloud.dump("alice").attempts.length, 450);
  assert.ok(cloud.pushCalls >= 2);
});

test("unconfigured controller never opens a session and keeps the anon log", async function () {
  let opened = false;
  const storage = memoryStorage();
  const ctl = sync.createHistoryController({
    storage,
    config: null,
    listenWindow: false,
    autoRetry: false,
    openSession() {
      opened = true;
      throw new Error("should not open");
    }
  });
  await ctl.ready;
  assert.equal(opened, false);
  assert.equal(ctl.getStatus().code, "local-only");
  assert.equal(ctl.getStatus().cloudConfigured, false);
  ctl.record({ day: "2026-11-15", unit: "U", zh: "本", answer: "local", typed: "local", ok: true });
  assert.equal(ctl.getEntries().length, 1);
  assert.equal(ctl.reportScopeLine(), "紀錄範圍：本機（未設定雲端）");
  await assert.rejects(ctl.signIn(), /unconfigured/);
  const secret = sync.createHistoryController({
    storage: memoryStorage(),
    config: { private_key: "-----BEGIN PRIVATE KEY-----\nMII" },
    listenWindow: false
  });
  await secret.ready;
  assert.equal(secret.getStatus().code, "config-rejected");
  assert.match(secret.getStatus().detail, /服務帳戶或密鑰/);
});

test("a lost redirect is visible while signed out and does not touch local records", async function () {
  const storage = memoryStorage();
  storage.setItem(sync.ANON_LOG_KEY, JSON.stringify([
    anonEntry({ t: 10, answer: "keep", typed: "keep", ok: true })
  ]));
  storage.setItem("ssco-vocab-session-v1", "{\"v\":1}");
  storage.setItem("ssco-vocab-items-v1", "[1]");
  const ctl = sync.createHistoryController({
    storage: storage,
    forceCloud: true,
    listenWindow: false,
    autoRetry: false,
    openSession(handlers) {
      handlers.onUser(null);
      const err = new Error("redirect-result-missing");
      err.code = "auth/redirect-result-missing";
      handlers.onError(err);
      return {
        async signIn() {},
        async signOut() { await handlers.onUser(null); },
        connect() { throw new Error("not used"); }
      };
    }
  });
  await ctl.ready;
  assert.equal(ctl.getStatus().code, "error");
  assert.match(ctl.getStatus().detail, /仍然未登入/);
  assert.equal(ctl.getStatus().detail.includes("會再試"), false);
  assert.equal(ctl.getEntries().length, 1);
  assert.equal(ctl.getEntries()[0].answer, "keep");
  assert.equal(storage.getItem("ssco-vocab-session-v1"), "{\"v\":1}");
  assert.equal(storage.getItem("ssco-vocab-items-v1"), "[1]");
});
