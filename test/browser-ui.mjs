import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vocab = JSON.parse(fs.readFileSync(path.join(root, "vocab.json"), "utf8"));
const shots = "/opt/cursor/artifacts";
fs.mkdirSync(shots, { recursive: true });

const cloud = new Map();
function bucket(uid) {
  if (!cloud.has(uid)) cloud.set(uid, { state: null, attempts: new Map() });
  return cloud.get(uid);
}
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
  });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "__test_cloud" && parts[1]) {
    const uid = decodeURIComponent(parts[1]);
    const box = bucket(uid);
    try {
      if (req.method === "GET" && parts.length === 2) {
        send(res, 200, {
          state: box.state,
          attempts: [...box.attempts.values()]
        });
        return;
      }
      const body = await readBody(req);
      if (req.method === "POST" && parts[2] === "attempts") {
        const rejected = [];
        for (const entry of body || []) {
          if (box.state && entry.t <= box.state.clearedThrough) {
            rejected.push(entry.id);
            continue;
          }
          const prev = box.attempts.get(entry.id);
          if (prev && JSON.stringify(prev) !== JSON.stringify(entry)) {
            rejected.push(entry.id);
            continue;
          }
          if (!prev) box.attempts.set(entry.id, entry);
        }
        send(res, 200, { rejected });
        return;
      }
      if (req.method === "POST" && parts[2] === "clear") {
        if (box.state && (body.clearRev < box.state.clearRev || body.clearedThrough < box.state.clearedThrough)) {
          send(res, 403, { error: "permission-denied" });
          return;
        }
        box.state = { clearRev: body.clearRev, clearedThrough: body.clearedThrough };
        send(res, 200, box.state);
        return;
      }
      if (req.method === "POST" && parts[2] === "delete") {
        for (const [id, entry] of box.attempts) {
          if (entry.t <= body.through) box.attempts.delete(id);
        }
        send(res, 200, { ok: true });
        return;
      }
    } catch (err) {
      send(res, 400, { error: String(err && err.message) });
      return;
    }
    send(res, 404, { error: "no" });
    return;
  }
  const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || "/usr/local/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const failures = [];
function check(name, cond, extra) {
  if (!cond) failures.push(name + (extra ? " — " + extra : ""));
  else console.log("ok", name);
}

const TEST_BACKEND = `
window.__SSCO_TEST_BACKEND = {
  openSession(handlers) {
    let user = null;
    handlers.onUser(null);
    return {
      async signIn() {
        user = window.__SSCO_TEST_USER || { uid: "alice", email: "alice@example.com" };
        await handlers.onUser(user);
      },
      async signOut() {
        user = null;
        await handlers.onUser(null);
      },
      connect(uid) {
        if (!user || user.uid !== uid) {
          const err = new Error("permission-denied");
          err.code = "permission-denied";
          return Promise.reject(err);
        }
        let timer = null;
        const root = location.origin + "/__test_cloud/" + encodeURIComponent(uid);
        return Promise.resolve({
          async pull() {
            const res = await fetch(root);
            if (!res.ok) {
              const err = new Error("unavailable");
              err.code = "unavailable";
              throw err;
            }
            return res.json();
          },
          subscribe(cb) { timer = setInterval(cb, 300); },
          async pushAttempts(list) {
            const res = await fetch(root + "/attempts", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(list)
            });
            if (!res.ok) {
              const err = new Error("unavailable");
              err.code = "unavailable";
              throw err;
            }
            return res.json();
          },
          async pushClear(state) {
            const res = await fetch(root + "/clear", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(state)
            });
            if (res.status === 403) {
              const err = new Error("permission-denied");
              err.code = "permission-denied";
              throw err;
            }
            if (!res.ok) {
              const err = new Error("unavailable");
              err.code = "unavailable";
              throw err;
            }
          },
          async deleteCleared(through) {
            const res = await fetch(root + "/delete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ through: through })
            });
            if (!res.ok) {
              const err = new Error("unavailable");
              err.code = "unavailable";
              throw err;
            }
          },
          close() { if (timer) clearInterval(timer); }
        });
      }
    };
  }
};
`;

function acceptDialogs(page, sink) {
  page.on("dialog", async (dialog) => {
    sink.push(dialog.message());
    await dialog.accept();
  });
}

async function waitBanner(page, text, timeout = 8000) {
  await page.waitForFunction((needle) => {
    const el = document.getElementById("syncBanner");
    return !!(el && el.textContent && el.textContent.includes(needle));
  }, text, { timeout });
}

async function textOf(locator) {
  return ((await locator.textContent()) || "").trim();
}

async function releaseKeyboard(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active && typeof active.blur === "function") active.blur();
    document.body.classList.remove("keyboard-open");
  });
}

async function typeCurrentAnswer(page) {
  const zh = await textOf(page.locator("#phraseZh"));
  const item = vocab.find((row) => row.zh === zh);
  if (!item) throw new Error("prompt not in vocab: " + zh);
  const answer = item.answers[0];
  const cells = page.locator(".letter-cell");
  let n = 0;
  for (const ch of answer) {
    if (!/[A-Za-z0-9]/.test(ch)) continue;
    await cells.nth(n).click();
    await cells.nth(n).fill(ch);
    n += 1;
  }
  await cells.nth(Math.max(0, n - 1)).press("Enter");
  await page.locator("#feedback").getByText("正確").waitFor({ timeout: 4000 });
  return { zh, answer };
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route("**/firebase-config.js", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript; charset=utf-8",
    body: "window.SSCO_FIREBASE_CONFIG = null;\n"
  }));
  await page.addInitScript(() => {
    window.__copied = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.__copied = text; } }
    });
  });
  const localDialogs = [];
  acceptDialogs(page, localDialogs);
  await page.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await page.locator(".app-ver").waitFor();
  check("version", (await textOf(page.locator(".app-ver"))) === "v1.9");
  check("title", await page.title() === "SSCO Vocab v1.9");
  check("vocab count", (await textOf(page.locator("#vocabMeta"))).includes("55"));
  check("local banner", (await textOf(page.locator("#syncBanner"))).includes("未設定雲端"));
  check("account button", (await textOf(page.locator("#btnAccount"))) === "本機", await textOf(page.locator("#btnAccount")));
  const units = await page.evaluate(() => window.SSCO_ITEMS.map((item) => item.unit).filter((unit, i, all) => all.indexOf(unit) === i));
  check("live units", units.length === 10 && !units.includes("Point Secure (EAL/118)") && !units.includes("EAL022-spell-2026-10-22"));
  check("cloze cells", await page.locator(".letter-cell").count() > 0);
  check("hint button", await page.locator(".gloss-toggle").count() > 0);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
  check("dark background", typeof bg === "string" && bg.includes("gradient"));

  const before = await textOf(page.locator("#phraseZh"));
  const answered = await typeCurrentAnswer(page);
  await page.waitForFunction((prev) => document.getElementById("phraseZh").textContent !== prev, before);
  const resumedPrompt = await textOf(page.locator("#phraseZh"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#feedback").getByText("接返上次").waitFor({ timeout: 4000 });
  check("session resume", (await textOf(page.locator("#phraseZh"))) === resumedPrompt, resumedPrompt);

  await releaseKeyboard(page);
  await page.locator("#btnRecords").click();
  await page.locator("#recordsSheet.show").waitFor();
  check("records today", (await textOf(page.locator("#recStats"))).includes("今日"));
  await page.locator("#btnRecCopy").click();
  await page.waitForFunction(() => window.__copied && window.__copied.includes("進度報告"));
  const report = await page.evaluate(() => window.__copied);
  check("report version", report.includes("v1.9"));
  check("report scope", report.includes("紀錄範圍：本機（未設定雲端）"));
  check("report answer", report.includes(answered.answer) || report.includes("正確"));
  await page.screenshot({ path: path.join(shots, "ssco-local-records.png") });
  await page.locator("#btnCloseRecords").click();

  await releaseKeyboard(page);
  await page.locator("#btnAccount").click();
  check("unconfigured alert", localDialogs.some((text) => text.includes("未設定雲端")));

  const imported = JSON.stringify([{
    unit: "Import Probe",
    zh: "匯入探測",
    words: [{ en: "Say", gloss: "" }, { en: null, gloss: "字" }],
    blankIndex: 1,
    answers: ["probe"]
  }]);
  await page.locator("#fileImport").setInputFiles({ name: "vocab.json", mimeType: "application/json", buffer: Buffer.from(imported) });
  await page.locator("#feedback").getByText("已匯入 1 題").waitFor();
  check("import count", (await page.locator("#vocabMeta").innerText()).includes("1"));
  await releaseKeyboard(page);
  await page.locator("#btnResetVocab").click();
  await page.locator("#vocabMeta").getByText("題庫 55 題").waitFor();
  check("reset vocab", true);

  await page.evaluate(() => {
    const raw = localStorage.getItem("ssco-vocab-attempt-log-v1");
    const rows = raw ? JSON.parse(raw) : [];
    localStorage.setItem("ssco-vocab-attempt-log-v1", JSON.stringify(rows.concat([{
      t: 1700000000000, day: "2026-11-01", unit: "U", zh: "種子", answer: "seed", typed: "seed", ok: false
    }])));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await releaseKeyboard(page);
  await page.locator("#btnRecords").click();
  const sessionBeforeClear = await page.evaluate(() => localStorage.getItem("ssco-vocab-session-v1"));
  localDialogs.length = 0;
  await page.locator("#btnRecClear").click();
  await page.locator("#recBody").waitFor();
  check("local clear copy", localDialogs.some((text) => text.includes("唔會刪除任何雲端")));
  check("clear leaves the round", (await page.evaluate(() => localStorage.getItem("ssco-vocab-session-v1"))) === sessionBeforeClear);
  const sessionAfter = await page.evaluate(() => ({
    items: localStorage.getItem("ssco-vocab-items-v1"),
    anon: localStorage.getItem("ssco-vocab-attempt-log-v1")
  }));
  check("clear leaves vocab key", sessionAfter.items === null);
  check("clear removes anon log", sessionAfter.anon === null);
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.route("**/firebase-config.js", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript; charset=utf-8",
    body: "window.SSCO_FIREBASE_CONFIG = null;\n"
  }));
  await mobile.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await releaseKeyboard(mobile);
  await mobile.locator("#btnAccount").waitFor();
  const box = await mobile.locator("#btnAccount").boundingBox();
  check("mobile account button", !!box && box.width > 0 && box.y >= 0);
  await mobile.screenshot({ path: path.join(shots, "ssco-mobile.png") });
  await mobile.close();

  async function openSynced(user) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await context.addInitScript(TEST_BACKEND);
    await context.addInitScript((next) => { window.__SSCO_TEST_USER = next; }, user);
    const synced = await context.newPage();
    const dialogs = [];
    acceptDialogs(synced, dialogs);
    await synced.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
    return { context, synced, dialogs };
  }

  const aliceSeed = {
    t: 1700000001000,
    day: "2026-11-01",
    unit: "Station Ops / Service English",
    zh: "舊紀錄",
    answer: "reset",
    typed: "reseted",
    ok: false
  };
  const a = await openSynced({ uid: "alice", email: "alice@example.com" });
  await a.synced.evaluate((row) => {
    localStorage.setItem("ssco-vocab-attempt-log-v1", JSON.stringify([row]));
  }, aliceSeed);
  await a.synced.reload({ waitUntil: "domcontentloaded" });
  await releaseKeyboard(a.synced);
  await a.synced.locator("#btnAccount", { hasText: "登入" }).waitFor();
  await a.synced.locator("#btnAccount").click();
  await a.synced.locator("#syncBanner").getByText("alice@example.com").waitFor({ timeout: 8000 });
  const bannerA = await textOf(a.synced.locator("#syncBanner"));
  check("signed-in banner", bannerA.includes("已同步") && bannerA.includes("合併 1 筆"), bannerA);
  check("claim confirm", a.dialogs.some((text) => text.includes("第一個登入")));
  await a.synced.screenshot({ path: path.join(shots, "ssco-synced.png") });

  const b = await openSynced({ uid: "alice", email: "alice@example.com" });
  await releaseKeyboard(b.synced);
  await b.synced.locator("#btnAccount", { hasText: "登入" }).waitFor();
  await b.synced.locator("#btnAccount").click();
  await b.synced.locator("#syncBanner").getByText("合併 1 筆").waitFor({ timeout: 8000 });
  check("second browser sees migrated row", true);

  const promptBefore = await textOf(a.synced.locator("#phraseZh"));
  await typeCurrentAnswer(a.synced);
  await a.synced.waitForFunction((prev) => document.getElementById("phraseZh").textContent !== prev, promptBefore);
  await b.synced.locator("#syncBanner").getByText("合併 2 筆").waitFor({ timeout: 8000 });
  check("second browser sees the new attempt once", cloud.get("alice").attempts.size === 2, "size " + cloud.get("alice").attempts.size);

  await a.context.setOffline(true);
  await typeCurrentAnswer(a.synced);
  await waitBanner(a.synced, "離線", 4000);
  check("offline keeps a single local extra", (await textOf(a.synced.locator("#syncBanner"))).includes("離線"));
  await a.context.setOffline(false);
  await waitBanner(a.synced, "合併 3 筆");
  await waitBanner(b.synced, "合併 3 筆");
  check("reconnect did not duplicate", cloud.get("alice").attempts.size === 3);

  await releaseKeyboard(a.synced);
  await a.synced.locator("#btnRecords").click();
  await a.synced.locator("#btnRecClear").click();
  check("account clear confirm", a.dialogs.some((text) => text.includes("所有裝置") && text.includes("唔會再出現")));
  await waitBanner(a.synced, "合併 0 筆");
  await waitBanner(b.synced, "合併 0 筆");
  check("clear removed cloud rows", cloud.get("alice").attempts.size === 0);
  check("tombstone kept", cloud.get("alice").state && cloud.get("alice").state.clearedThrough > 0);

  await releaseKeyboard(a.synced);
  await a.synced.locator("#btnAccount", { hasText: "登出" }).click();
  await waitBanner(a.synced, "已登出");
  check("sign-out confirm", a.dialogs.some((text) => text.includes("雲端紀錄會保留")));
  check("sign-out hides account rows", !(await textOf(a.synced.locator("#syncBanner"))).includes("alice@example.com"));

  await a.synced.evaluate(() => { window.__SSCO_TEST_USER = { uid: "bob", email: "bob@example.com" }; });
  await releaseKeyboard(a.synced);
  await a.synced.locator("#btnAccount", { hasText: "登入" }).click();
  await waitBanner(a.synced, "bob@example.com");
  const bobBanner = await textOf(a.synced.locator("#syncBanner"));
  check("bob does not see alice history", bobBanner.includes("合併 0 筆"), bobBanner);
  check("alice cloud was not deleted by bob", cloud.get("alice").state && cloud.get("alice").state.clearedThrough > 0);
  check("bob cloud empty", !cloud.get("bob") || cloud.get("bob").attempts.size === 0);

  await a.context.close();
  await b.context.close();

  const configured = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const configuredDialogs = [];
  acceptDialogs(configured, configuredDialogs);
  await configured.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await releaseKeyboard(configured);
  await configured.waitForFunction(() => {
    const el = document.getElementById("syncBanner");
    const text = el && el.textContent ? el.textContent : "";
    return text.includes("未登入") || text.includes("同步未成功");
  }, null, { timeout: 20000 });
  const configuredBanner = await textOf(configured.locator("#syncBanner"));
  check("live config reaches signed-out", configuredBanner.includes("未登入"), configuredBanner);
  check("live config offers Google sign-in", (await textOf(configured.locator("#btnAccount"))) === "登入", await textOf(configured.locator("#btnAccount")));
  check("live config did not start a sign-in", configuredDialogs.length === 0);
  await configured.close();
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("FAILED");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}
console.log("browser checks passed");
