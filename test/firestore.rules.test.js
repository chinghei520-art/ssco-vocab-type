"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds
} = require("@firebase/rules-unit-testing");
const {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  serverTimestamp
} = require("firebase/firestore");

const PROJECT_ID = "demo-ssco-vocab";
const ATTEMPT_ID = "a_0123456789abcdef";

function attempt(id, overrides) {
  return Object.assign({
    id: id,
    t: 1700000000000,
    day: "2026-11-15",
    unit: "Station Ops / Service English",
    zh: "重設",
    answer: "reset",
    typed: "reseted",
    ok: false,
    v: 1
  }, overrides);
}

function clearState(overrides) {
  return Object.assign({
    clearRev: 1,
    clearedThrough: 5000,
    updatedAt: serverTimestamp()
  }, overrides, { updatedAt: serverTimestamp() });
}

let testEnv;

test.before(async function () {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080
    }
  });
});

test.after(async function () {
  if (testEnv) await testEnv.cleanup();
});

test.beforeEach(async function () {
  await testEnv.clearFirestore();
});

function authed(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

test("unsigned and other users cannot read or write attempt history", async function () {
  const anon = testEnv.unauthenticatedContext().firestore();
  const alice = authed("alice");
  const bob = authed("bob");
  const aliceAttempt = doc(alice, "users/alice/attempts/" + ATTEMPT_ID);
  await assertSucceeds(setDoc(aliceAttempt, attempt(ATTEMPT_ID)));
  await assertSucceeds(getDoc(aliceAttempt));
  await assertFails(getDoc(doc(anon, "users/alice/attempts/" + ATTEMPT_ID)));
  await assertFails(setDoc(doc(anon, "users/alice/attempts/" + ATTEMPT_ID), attempt(ATTEMPT_ID)));
  await assertFails(getDoc(doc(bob, "users/alice/attempts/" + ATTEMPT_ID)));
  await assertFails(setDoc(doc(bob, "users/alice/attempts/" + ATTEMPT_ID), attempt(ATTEMPT_ID)));
  await assertFails(deleteDoc(doc(bob, "users/alice/attempts/" + ATTEMPT_ID)));
  await assertFails(getDocs(collection(bob, "users/alice/attempts")));
  await assertSucceeds(getDocs(collection(alice, "users/alice/attempts")));
  await assertFails(getDocs(collectionGroup(alice, "attempts")));
  await assertFails(setDoc(doc(bob, "users/bob/attempts/" + ATTEMPT_ID), attempt(ATTEMPT_ID, { id: "different" })));
  await assertFails(setDoc(doc(alice, "users/alice/notes/secret"), { hello: "no" }));
});

test("attempt rows are immutable and shaped", async function () {
  const alice = authed("alice");
  const ref = doc(alice, "users/alice/attempts/" + ATTEMPT_ID);
  await assertSucceeds(setDoc(ref, attempt(ATTEMPT_ID)));
  await assertSucceeds(setDoc(ref, attempt(ATTEMPT_ID)));
  await assertFails(setDoc(ref, attempt(ATTEMPT_ID, { ok: true })));
  await assertFails(setDoc(ref, attempt(ATTEMPT_ID, { typed: "changed" })));
  await assertFails(setDoc(doc(alice, "users/alice/attempts/a_ffffffffffffffff"), attempt("a_ffffffffffffffff", { t: 1.5 })));
  await assertFails(setDoc(doc(alice, "users/alice/attempts/a_ffffffffffffffff"), attempt("a_ffffffffffffffff", { v: 2 })));
  const extra = attempt("a_aaaaaaaaaaaaaaaa");
  extra.email = "alice@example.com";
  await assertFails(setDoc(doc(alice, "users/alice/attempts/a_aaaaaaaaaaaaaaaa"), extra));
  await assertFails(setDoc(doc(alice, "users/alice/attempts/not this id"), attempt("not this id")));
});

test("clear tombstone cannot move backward, be deleted, or accept older rows", async function () {
  const alice = authed("alice");
  const bob = authed("bob");
  const anon = testEnv.unauthenticatedContext().firestore();
  const state = doc(alice, "users/alice/sync/state");
  await assertSucceeds(setDoc(state, clearState()));
  await assertSucceeds(getDoc(state));
  await assertFails(getDoc(doc(bob, "users/alice/sync/state")));
  await assertFails(getDoc(doc(anon, "users/alice/sync/state")));
  await assertFails(setDoc(doc(bob, "users/alice/sync/state"), clearState()));
  await assertFails(deleteDoc(state));
  await assertFails(setDoc(state, clearState({ clearRev: 0, clearedThrough: 5000 })));
  await assertFails(setDoc(state, clearState({ clearRev: 1, clearedThrough: 4999 })));
  await assertFails(setDoc(doc(alice, "users/alice/sync/other"), clearState()));
  await assertSucceeds(setDoc(state, clearState({ clearRev: 2, clearedThrough: 8000 })));

  await assertFails(setDoc(doc(alice, "users/alice/attempts/a_1111111111111111"), attempt("a_1111111111111111", { t: 8000 })));
  await assertSucceeds(setDoc(doc(alice, "users/alice/attempts/a_2222222222222222"), attempt("a_2222222222222222", { t: 8001 })));
  const old = doc(alice, "users/alice/attempts/" + ATTEMPT_ID);
  await assertSucceeds(setDoc(old, attempt(ATTEMPT_ID, { t: 9000 })));
  await assertSucceeds(setDoc(state, clearState({ clearRev: 3, clearedThrough: 9000 })));
  await assertFails(setDoc(old, attempt(ATTEMPT_ID, { t: 9000 })));
  await assertSucceeds(deleteDoc(old));
  await assertFails(setDoc(old, attempt(ATTEMPT_ID, { t: 9000 })));
});

test("review events are append-only and old attempt documents still validate", async function () {
  const alice = authed("alice");
  const bob = authed("bob");
  const review = {
    id: "r_0123456789abcdef",
    cardId: "c_0123456789abcdef",
    t: 1700000000000,
    sessionId: "s1",
    kind: "new",
    outcome: "correct",
    hint: false,
    revealed: false,
    initial: true,
    v: 2
  };
  const ref = doc(alice, "users/alice/reviews/r_0123456789abcdef");
  await assertSucceeds(setDoc(ref, review));
  await assertSucceeds(setDoc(ref, review));
  await assertFails(setDoc(ref, Object.assign({}, review, { outcome: "incorrect" })));
  await assertFails(getDoc(doc(bob, "users/alice/reviews/r_0123456789abcdef")));
  await assertFails(setDoc(doc(bob, "users/alice/reviews/r_0123456789abcdef"), review));
  await assertSucceeds(setDoc(doc(alice, "users/alice/attempts/" + ATTEMPT_ID), attempt(ATTEMPT_ID)));
});

test("rules file is the one shipped for deploy", function () {
  const rules = fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8");
  assert.match(rules, /request\.auth\.uid == uid/);
  assert.match(rules, /allow delete: if false/);
  assert.doesNotMatch(rules, /private_key|service_account/i);
});
