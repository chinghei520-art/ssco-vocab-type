"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("vm");
const path = require("node:path");

const root = path.join(__dirname, "..");
const umd = fs.readFileSync(path.join(root, "vendor/ts-fsrs-6.0.0.umd.js"), "utf8");
const context = {
  console: console,
  Date: Date,
  Math: Math,
  Object: Object,
  Array: Array,
  Number: Number,
  String: String,
  JSON: JSON,
  Promise: Promise,
  Map: Map,
  Set: Set,
  Symbol: Symbol,
  Reflect: Reflect,
  WeakMap: WeakMap,
  Intl: Intl,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  queueMicrotask: queueMicrotask
};
context.window = context;
context.self = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(umd, context);
global.FSRS = context.FSRS;

const sched = require("../scheduler.js");
const vocab = require("../vocab.json");

const HK_MORNING = Date.parse("2026-11-15T02:00:00.000Z"); // 10:00 HK
const HK_LATE = Date.parse("2026-11-15T15:30:00.000Z"); // 23:30 HK
const HK_NEXT = Date.parse("2026-11-15T16:30:00.000Z"); // 00:30 HK on the 16th

function event(partial) {
  return Object.assign({
    id: "ev_" + Math.random().toString(16).slice(2, 12) + "aa",
    cardId: "c_0123456789abcdef",
    t: HK_MORNING,
    sessionId: "s1",
    kind: "new",
    outcome: "correct",
    hint: false,
    revealed: false,
    initial: true,
    v: 2
  }, partial);
}

let fsrs = null;

test.before(async function () {
  fsrs = await sched.engine();
  assert.ok(fsrs);
  assert.equal(fsrs.definition.model.name, "fsrs-6");
});

test("63 vocab cards have distinct stable ids and keep their units", function () {
  assert.equal(vocab.length, 63);
  const ids = vocab.map((item) => sched.cardId(item));
  assert.equal(new Set(ids).size, 63);
  assert.equal(sched.cardId(vocab[0]), sched.cardId(Object.assign({}, vocab[0])));
  assert.notEqual(sched.cardId(vocab[0]), sched.cardId(vocab[1]));
});

test("Hong Kong day boundary is deterministic", function () {
  assert.equal(sched.hkDay(HK_LATE), "2026-11-15");
  assert.equal(sched.hkDay(HK_NEXT), "2026-11-16");
});

test("first unhinted correct is Good; hint, reveal, skip and wrong are not", async function () {
  const id = sched.cardId(vocab[0]);
  const base = { cardId: id, t: HK_MORNING, sessionId: "learn", kind: "new", initial: true, v: 2 };
  const good = sched.plan([], event(Object.assign({}, base, { id: "ev_goodcorrect1", outcome: "correct" })), fsrs);
  assert.equal(good.grade, "good");
  assert.match(good.effect, /Good/);
  assert.ok(good.dueAt > HK_MORNING);

  const hinted = sched.plan([], event(Object.assign({}, base, { id: "ev_hintcorrect1", outcome: "correct", hint: true })), fsrs);
  assert.equal(hinted.grade, "again");
  assert.notEqual(hinted.grade, "good");

  const revealed = sched.plan([], event(Object.assign({}, base, { id: "ev_revealcorr1", outcome: "correct", revealed: true })), fsrs);
  assert.equal(revealed.grade, "again");

  const wrong = sched.plan([], event(Object.assign({}, base, { id: "ev_wrongfirst1", outcome: "incorrect" })), fsrs);
  assert.equal(wrong.grade, "again");
  assert.ok(wrong.dueAt > HK_MORNING);
  assert.ok(wrong.dueAt < good.dueAt);

  const skipped = sched.plan([], event(Object.assign({}, base, { id: "ev_skipfirst01", outcome: "skip" })), fsrs);
  assert.equal(skipped.grade, "again");

  const exposed = sched.plan([], event(Object.assign({}, base, { id: "ev_exposefirst1", outcome: "expose" })), fsrs);
  assert.equal(exposed.grade, "again");
});

test("same-session correction after a miss does not create Good or move due later", function () {
  const id = sched.cardId(vocab[1]);
  const miss = event({
    id: "ev_miss00000001",
    cardId: id,
    sessionId: "round",
    outcome: "incorrect",
    t: HK_MORNING
  });
  const fix = event({
    id: "ev_fix000000001",
    cardId: id,
    sessionId: "round",
    outcome: "correct",
    revealed: true,
    t: HK_MORNING + 1000
  });
  const planned = sched.plan([miss], fix, fsrs);
  assert.equal(planned.grade, null);
  assert.equal(planned.role, "remediation");
  const folded = sched.foldCard([miss, fix], fsrs);
  assert.equal(folded.applied.length, 1);
  assert.equal(folded.applied[0].grade, "again");
});

test("extra practice cannot push a due date later; a later independent miss can shorten it", function () {
  const id = sched.cardId(vocab[2]);
  const first = event({ id: "ev_firstgood001", cardId: id, sessionId: "a", outcome: "correct", t: HK_MORNING });
  const learned = sched.foldCard([first], fsrs);
  const extra = sched.plan([first], event({
    id: "ev_extragood001",
    cardId: id,
    sessionId: "b",
    kind: "manual",
    outcome: "correct",
    t: HK_MORNING + 60 * 1000
  }), fsrs);
  assert.equal(extra.grade, null);
  assert.equal(sched.foldCard([first, extra.event], fsrs).dueAt, learned.dueAt);

  const miss = sched.plan([first], event({
    id: "ev_extramiss001",
    cardId: id,
    sessionId: "c",
    kind: "manual",
    outcome: "incorrect",
    t: HK_MORNING + 30 * 1000
  }), fsrs);
  assert.equal(miss.grade, "again");
  assert.ok(miss.dueAt < learned.dueAt);
});

test("due cards come before new cards and overdue does not change the last result", function () {
  const items = vocab.slice(0, 3);
  const dueId = sched.cardId(items[0]);
  const past = event({
    id: "ev_pastdue0001",
    cardId: dueId,
    outcome: "correct",
    t: HK_MORNING - 10 * 24 * 60 * 60 * 1000
  });
  const view = sched.summarize(items, [past], HK_MORNING, fsrs);
  assert.equal(view.due[0].cardId, dueId);
  assert.equal(view.fresh.length, 2);
  assert.equal(view.order[0].cardId, dueId);
  assert.equal(view.rows.find((row) => row.cardId === dueId).lastLabel, "獨立正確");
  assert.equal(view.rows.find((row) => row.cardId === dueId).status, "due");
});

test("legacy attempt rows are not treated as recall, and the denominator includes new cards", function () {
  const items = vocab.slice(0, 4);
  const view = sched.summarize(items, [], HK_MORNING, fsrs);
  assert.equal(view.denominator, 4);
  assert.equal(view.delayedCount, 0);
  assert.equal(view.fresh.length, 4);
  const introduced = event({
    id: "ev_introgood001",
    cardId: sched.cardId(items[0]),
    outcome: "correct",
    t: HK_MORNING
  });
  const sameDay = sched.summarize(items, [introduced], HK_MORNING, fsrs);
  assert.equal(sameDay.delayedCount, 0);
  const later = event({
    id: "ev_latergood001",
    cardId: sched.cardId(items[0]),
    sessionId: "next-day",
    kind: "review",
    outcome: "correct",
    t: HK_NEXT
  });
  const delayed = sched.summarize(items, [introduced, later], HK_NEXT, fsrs);
  assert.equal(delayed.delayedCount, 1);
  assert.equal(delayed.denominator, 4);
  assert.match(delayed.criterion, /試行指標/);
  assert.equal(delayed.retention, 0.9);
  assert.match(delayed.criterion, /唔係 FSRS 目標記得率/);
});

test("two devices replaying conflicting reviews converge, including a duplicate id", function () {
  const id = sched.cardId(vocab[3]);
  const a = event({ id: "ev_devicea0001", cardId: id, sessionId: "dev-a", outcome: "incorrect", t: HK_MORNING });
  const b = event({ id: "ev_deviceb0001", cardId: id, sessionId: "dev-b", outcome: "correct", t: HK_MORNING + 5000 });
  const left = sched.foldCard([a, b, b], fsrs);
  const right = sched.foldCard([b, a], fsrs);
  assert.equal(left.dueAt, right.dueAt);
  assert.equal(left.applied.length, right.applied.length);
});

test("refreshing the same session does not schedule twice", function () {
  const id = sched.cardId(vocab[4]);
  const once = event({ id: "ev_once0000001", cardId: id, sessionId: "same", outcome: "correct", t: HK_MORNING });
  const again = event({ id: "ev_once0000002", cardId: id, sessionId: "same", outcome: "correct", t: HK_MORNING + 10 });
  const folded = sched.foldCard([once, again], fsrs);
  assert.equal(folded.applied.length, 1);
});

test("last independent label distinguishes help, skip, wrong, and a later remediation", function () {
  const item = vocab[6];
  const id = sched.cardId(item);
  function label(events) {
    return sched.summarize([item], events, HK_MORNING, fsrs).rows[0].lastLabel;
  }
  assert.equal(sched.summarize([item], [], HK_MORNING, fsrs).rows[0].lastLabel, "未有");
  assert.equal(sched.summarize([item], [], HK_MORNING, fsrs).rows[0].dueLabel, "—");
  assert.equal(label([event({ id: "ev_labcorrect01", cardId: id, outcome: "correct" })]), "獨立正確");
  assert.equal(label([event({ id: "ev_labhint0001", cardId: id, outcome: "correct", hint: true })]), "用過提示");
  assert.equal(label([event({ id: "ev_labreveal01", cardId: id, outcome: "correct", revealed: true })]), "睇過答案");
  assert.equal(label([event({ id: "ev_labboth0001", cardId: id, outcome: "correct", hint: true, revealed: true })]), "睇過答案");
  assert.equal(label([event({ id: "ev_labexpose01", cardId: id, outcome: "expose" })]), "睇過答案");
  assert.equal(label([event({ id: "ev_labskip0001", cardId: id, outcome: "skip" })]), "跳過");
  assert.equal(label([event({ id: "ev_labwrong001", cardId: id, outcome: "incorrect" })]), "錯");
  assert.equal(label([event({ id: "ev_labhinwrong1", cardId: id, outcome: "incorrect", hint: true })]), "錯");
  const hinted = event({
    id: "ev_labhint0002",
    cardId: id,
    sessionId: "helped",
    outcome: "correct",
    hint: true,
    t: HK_MORNING
  });
  const later = event({
    id: "ev_labfix00001",
    cardId: id,
    sessionId: "helped",
    kind: "remediation",
    outcome: "correct",
    initial: false,
    revealed: true,
    t: HK_MORNING + 1000
  });
  assert.equal(label([hinted, later]), "用過提示");
  const missed = event({
    id: "ev_labmiss0001",
    cardId: id,
    sessionId: "seen",
    outcome: "incorrect",
    t: HK_MORNING
  });
  const afterAnswer = event({
    id: "ev_labafter001",
    cardId: id,
    sessionId: "seen",
    kind: "remediation",
    outcome: "correct",
    initial: false,
    revealed: true,
    t: HK_MORNING + 2000
  });
  assert.equal(label([missed, afterAnswer]), "錯");
  assert.notEqual(label([missed, afterAnswer]), "獨立正確");
});

test("without the library there is no invented due date", function () {
  const id = sched.cardId(vocab[5]);
  const row = sched.summarize([vocab[5]], [event({
    id: "ev_nolibrary001",
    cardId: id,
    outcome: "correct"
  })], HK_MORNING, null);
  assert.equal(row.available, false);
  assert.equal(row.due.length, 0);
  assert.equal(row.rows[0].dueAt, null);
  assert.equal(row.rows[0].status, "new");
});
