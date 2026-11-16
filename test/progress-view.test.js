"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const view = require("../progress-view.js");

const root = path.join(__dirname, "..");

function row(partial) {
  return Object.assign({
    cardId: "c_0000000000000000",
    zh: "",
    unit: "",
    status: "new",
    dueAt: null,
    dueLabel: "—",
    lastLabel: "未有"
  }, partial);
}

test("trial metric lines name the counts and do not claim mastery or 90%", function () {
  const lines = view.trialMetricLines({
    delayedCount: 3,
    denominator: 55,
    todayIndependent: { correct: 2, total: 4 },
    remediationCount: 1
  });
  assert.deepEqual(lines, [
    "延遲獨立拼寫率 3/55（含未學）",
    "今日獨立首次 2/4",
    "今日補救 1（唔算獨立）"
  ]);
  const text = lines.join("\n");
  assert.equal(text.includes("掌握率"), false);
  assert.equal(text.includes("已掌握"), false);
  assert.equal(text.includes("90%"), false);
  assert.deepEqual(view.trialMetricLines(null), ["延遲獨立拼寫率 —（排程未載入）"]);
});

test("status labels stay 新卡 / 到期 / 未到期", function () {
  assert.equal(view.statusLabel("new"), "新卡");
  assert.equal(view.statusLabel("due"), "到期");
  assert.equal(view.statusLabel("waiting"), "未到期");
  assert.equal(view.statusLabel("overdue"), "新卡");
  assert.equal(["新卡", "到期", "未到期"].includes(view.statusLabel("due")), true);
  assert.equal(view.statusLabel("due").includes("需重學"), false);
});

test("source unit is collapsed unless the preference is exactly on", function () {
  assert.equal(view.SHOW_UNITS_DEFAULT, false);
  assert.equal(view.unitsVisible(null), false);
  assert.equal(view.unitsVisible(undefined), false);
  assert.equal(view.unitsVisible(""), false);
  assert.equal(view.unitsVisible("0"), false);
  assert.equal(view.unitsVisible("1"), true);
});

test("progress rows sort by status, due date, last result, prompt, and unit", function () {
  assert.equal(view.DEFAULT_SORT, "status");
  const rows = [
    row({ cardId: "c_0000000000000003", zh: "c-prompt", status: "waiting", dueAt: 300, lastLabel: "獨立正確", unit: "Unit C" }),
    row({ cardId: "c_0000000000000001", zh: "a-prompt", status: "due", dueAt: 100, lastLabel: "錯", unit: "Unit B" }),
    row({ cardId: "c_0000000000000002", zh: "b-prompt", status: "new", dueAt: null, lastLabel: "未有", unit: "Unit A" })
  ];
  assert.deepEqual(view.sortRows(rows, "status", "asc").map((item) => item.zh), ["a-prompt", "b-prompt", "c-prompt"]);
  assert.deepEqual(view.sortRows(rows, "status", "desc").map((item) => item.status), ["waiting", "new", "due"]);
  assert.deepEqual(view.sortRows(rows, "due", "asc").map((item) => item.zh), ["a-prompt", "c-prompt", "b-prompt"]);
  assert.deepEqual(view.sortRows(rows, "due", "desc").map((item) => item.zh), ["c-prompt", "a-prompt", "b-prompt"]);
  assert.deepEqual(view.sortRows(rows, "result", "asc").map((item) => item.lastLabel), ["錯", "未有", "獨立正確"]);
  assert.deepEqual(view.sortRows(rows, "zh", "asc").map((item) => item.zh), ["a-prompt", "b-prompt", "c-prompt"]);
  assert.deepEqual(view.sortRows(rows, "zh", "desc").map((item) => item.zh), ["c-prompt", "b-prompt", "a-prompt"]);
  assert.deepEqual(view.sortRows(rows, "unit", "asc").map((item) => item.unit), ["Unit A", "Unit B", "Unit C"]);
  const tied = [
    row({ cardId: "c_0000000000000009", zh: "m-prompt", status: "due", dueAt: 50, unit: "Same" }),
    row({ cardId: "c_0000000000000008", zh: "m-prompt", status: "due", dueAt: 50, unit: "Same" })
  ];
  assert.deepEqual(view.sortRows(tied, "status", "asc").map((item) => item.cardId), [
    "c_0000000000000008",
    "c_0000000000000009"
  ]);
});

test("the page shell is v2.2 and the progress table stays separate from records", function () {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const version = fs.readFileSync(path.join(root, "VERSION"), "utf8");
  assert.match(html, /data-app-ver="2\.2"/);
  assert.match(html, /<title>SSCO Vocab v2\.2<\/title>/);
  assert.match(html, /class="app-ver">v2\.2</);
  assert.match(version, /^v2\.2 — /);
  assert.match(html, /id="progressTableTitle">進度表</);
  assert.match(html, /id="btnProgress"[^>]*>進度表</);
  assert.match(html, /id="btnRecords"[^>]*>紀錄</);
  assert.match(html, /<h2>練習紀錄<\/h2>/);
  assert.match(html, /id="btnToggleUnits"[^>]*aria-pressed="false"/);
  assert.match(html, /顯示來源單元/);
  assert.equal(view.SCOPE_NOTE, "");
  assert.equal(html.includes("排程暫時跟呢部機"), false);
  assert.equal(html.includes("雲端複習規則未公布"), false);
  assert.match(html, /id="homeScope"[^>]*hidden/);
  assert.match(html, /id="progressScope"[^>]*hidden/);
  assert.match(html, /id="btnSkip"[^>]*hidden/);
  assert.match(html, /id="btnCheck"[^>]*hidden/);
  assert.match(html, /trialMetricLines\(view\)/);
  assert.match(html, /延遲獨立拼寫率/);
  assert.match(html, /今日獨立首次/);
  assert.match(html, /唔算獨立/);
  assert.match(html, /data-sort="status"/);
  assert.match(html, /data-sort="due"/);
  assert.match(html, /data-sort="result"/);
  assert.match(html, /data-sort="zh"/);
  assert.match(html, /data-sort="unit"/);
  assert.equal(html.includes("掌握率"), false);
  assert.equal(html.includes("已掌握"), false);
  assert.equal(html.includes("需重學"), false);
  const boardStart = html.indexOf('id="progressBoard"');
  const boardEnd = html.indexOf('id="cardList"');
  const board = html.slice(boardStart, boardEnd);
  assert.equal(board.includes("90%"), false);
  assert.match(board, /進度表/);
  const reportStart = html.indexOf("function buildProgressReport");
  const reportEnd = html.indexOf("function legacyCopyText");
  const report = html.slice(reportStart, reportEnd);
  assert.match(report, /正確率/);
  assert.match(report, /各單元正確率（累計）/);
  assert.match(report, /trialMetricLines\(view\)/);
  assert.equal(report.includes("掌握率"), false);
  assert.equal(report.includes("90%"), false);
  assert.match(html, /<body data-screen="cards">/);
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  assert.match(html, /body\[data-screen="answer"\] #home/);
  assert.match(html, /body\[data-screen="cards"\] #practice/);
  assert.match(html, /function setScreen\(screen\)/);
  const screenFn = html.slice(html.indexOf("function setScreen"), html.indexOf("function showHome"));
  assert.match(screenFn, /screen !== "cards"/);
  assert.match(screenFn, /screen !== "answer"/);
  assert.match(screenFn, /answering = screen === "answer"/);
  assert.match(screenFn, /node\.hidden = !answering/);
});
