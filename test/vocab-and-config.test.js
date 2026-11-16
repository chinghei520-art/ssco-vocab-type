"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sync = require("../history-sync.js");

const root = path.join(__dirname, "..");

test("bundled vocab.js matches vocab.json and deleted units stay deleted", function () {
  const json = JSON.parse(fs.readFileSync(path.join(root, "vocab.json"), "utf8"));
  const js = fs.readFileSync(path.join(root, "vocab.js"), "utf8");
  const context = { window: {} };
  vm.runInNewContext(js, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.SSCO_ITEMS)), json);
  assert.equal(json.length, 55);
  const units = [];
  for (const item of json) {
    if (!units.includes(item.unit)) units.push(item.unit);
  }
  assert.deepEqual(units, [
    "Station Ops / Service English",
    "OP295A-UE-2026-11-01",
    "EAL021-UE-2026-11-03",
    "DailyLOG-UE-2026-11-04",
    "Serious-Injury-UE-2026-11-04",
    "DailyLOG-UE-2026-11-05",
    "Stage3-CCTV-UE-2026-11-06",
    "Stage3-CCTV-UE-2026-11-06b",
    "Stage3-CCTV-UE-2026-11-11",
    "Stage3-CCTV-UE-2026-11-11b"
  ]);
  const blob = js + "\n" + JSON.stringify(json);
  for (const gone of [
    "Point Secure (EAL/118)",
    "EAL022-spell-2026-10-22",
    "Injury-Severity-2026-11-02",
    "Track Access (EAL/014)"
  ]) {
    assert.equal(blob.includes(gone), false, gone);
  }
});

test("committed firebase config is the public web config and not a service account", function () {
  const src = fs.readFileSync(path.join(root, "firebase-config.js"), "utf8");
  assert.doesNotMatch(src, /private_key|BEGIN PRIVATE KEY|client_secret|service_account/i);
  const context = { window: {} };
  vm.runInNewContext(src, context);
  const cfg = context.window.SSCO_FIREBASE_CONFIG;
  assert.equal(sync.inspectConfig(cfg).ok, true);
  assert.equal(cfg.projectId, "ssco-vocab");
  assert.equal(cfg.authDomain, "ssco-vocab.firebaseapp.com");
  assert.equal(cfg.messagingSenderId, "824416630235");
  assert.equal(cfg.appId, "1:824416630235:web:dcb6ea98d5262a10daa3fe");
  assert.equal(cfg.storageBucket, "ssco-vocab.firebasestorage.app");
  assert.match(cfg.apiKey, /^AIza[0-9A-Za-z_-]{30,}$/);
});

test("shell version is v2.2 in the page shell", function () {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const version = fs.readFileSync(path.join(root, "VERSION"), "utf8");
  assert.match(html, /data-app-ver="2\.2"/);
  assert.match(html, /<title>SSCO Vocab v2\.2<\/title>/);
  assert.match(html, /class="app-ver">v2\.2</);
  assert.match(version, /^v2\.2 — /);
  assert.equal(html.includes("ssco-vocab-attempt-log-v1"), true);
  assert.equal(html.includes("ssco-vocab-items-v1"), true);
  assert.equal(html.includes("ssco-vocab-session-v1"), true);
});
