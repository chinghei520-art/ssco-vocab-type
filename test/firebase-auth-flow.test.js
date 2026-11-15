"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const auth = require("../firebase-sync.js");

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

test("sign-in never starts a cross-site redirect", function () {
  const src = fs.readFileSync(path.join(__dirname, "..", "firebase-sync.js"), "utf8");
  assert.doesNotMatch(src, /signInWithRedirect\s*\(/);
  assert.match(src, /signInWithPopup\s*\(/);
  assert.deepEqual(auth.signInPlan({}), { method: "popup" });
  assert.equal(auth.signInPlan({ popupBlocked: true }).method, "error");
  assert.equal(auth.signInPlan({ popupBlocked: true }).code, "auth/popup-blocked");
});

test("iPhone Safari and iPhone Chrome are both WebKit; a lost redirect is an error", function () {
  assert.equal(auth.isIosWebKit(IPHONE_SAFARI, "iPhone", 5), true);
  assert.equal(auth.isIosWebKit(IPHONE_CHROME, "iPhone", 5), true);
  assert.equal(auth.isIosWebKit(DESKTOP_CHROME, "Win32", 0), false);
  assert.equal(auth.isIosWebKit(DESKTOP_CHROME, "MacIntel", 0), false);
  assert.equal(auth.isIosWebKit("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "MacIntel", 5), true);

  const lost = auth.interpretRedirectResult({ pending: true, result: null, user: null });
  assert.equal(lost.ok, false);
  assert.equal(lost.error.code, "auth/redirect-result-missing");

  const idle = auth.interpretRedirectResult({ pending: false, result: null, user: null });
  assert.equal(idle.ok, true);
  assert.equal(idle.ignored, true);

  const signed = auth.interpretRedirectResult({ pending: true, result: { user: { uid: "abc" } }, user: null });
  assert.equal(signed.ok, true);
  assert.equal(signed.error, undefined);
});
