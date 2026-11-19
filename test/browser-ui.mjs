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

async function clickAccountSignIn(page) {
  await releaseKeyboard(page);
  await page.locator("#btnAccount", { hasText: "登入" }).evaluate((el) => el.click());
  const opened = await page.locator("#authConfirm").evaluate((el) => !el.hidden).catch(() => false);
  if (!opened) return "";
  const prompt = await textOf(page.locator("#authConfirmText"));
  await page.locator("#btnAuthConfirmOk").click();
  return prompt;
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
  check("version", (await textOf(page.locator(".app-ver"))) === "v2.2");
  check("title", await page.title() === "SSCO Vocab v2.2");
  check("vocab count", (await textOf(page.locator("#vocabMeta"))).includes("67"));
  check("local banner", (await textOf(page.locator("#syncBanner"))).includes("未設定雲端"));
  check("account button", (await textOf(page.locator("#btnAccount"))) === "本機", await textOf(page.locator("#btnAccount")));
  const units = await page.evaluate(() => window.SSCO_ITEMS.map((item) => item.unit).filter((unit, i, all) => all.indexOf(unit) === i));
  check("live units", units.length === 15 && !units.includes("Point Secure (EAL/118)") && !units.includes("EAL022-spell-2026-10-22"));
  await page.locator("#homeCounts").getByText("新卡", { exact: false }).waitFor();
  check("dashboard due label", (await textOf(page.locator("#homeCounts"))).includes("未到期"));
  check("no unit bar", await page.locator(".unit-bar-wrap").evaluate((el) => getComputedStyle(el).display === "none"));
  const figurePx = await page.locator("#homeMetricFigure").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  check("metric is prominent", figurePx >= 28, String(figurePx));
  check("metric title", (await textOf(page.locator("#trialMetricTitle"))) === "延遲獨立拼寫率");
  check("today independent nearby", (await textOf(page.locator("#homeMetricToday"))).includes("今日獨立首次") && (await textOf(page.locator("#homeMetricToday"))).includes("唔算獨立"));
  check("progress heading", (await textOf(page.locator("#progressTableTitle"))) === "進度表");
  check("scope note stays empty", (await textOf(page.locator("#homeScope"))) === "" && await page.locator("#homeScope").isHidden());
  check("no unpublished rules claim", !(await page.locator("body").innerText()).includes("雲端複習規則未公布") && !(await page.locator("body").innerText()).includes("排程暫時跟呢部機"));
  check("cards page hides skip and check", await page.locator("#btnSkip").isHidden() && await page.locator("#btnCheck").isHidden());
  check("units collapsed", (await page.locator("#btnToggleUnits").getAttribute("aria-pressed")) === "false");
  check("unit text hidden", await page.locator("#cardList .source-unit").first().isHidden());
  check("answer hidden", await page.locator("#cardList .answer").first().isHidden());
  const homeText = await textOf(page.locator("#home"));
  check("no mastery label", !homeText.includes("掌握率") && !homeText.includes("已掌握") && !homeText.includes("需重學"));
  const boardText = await textOf(page.locator("#progressBoard"));
  check("table heading is not a 90 score", boardText.includes("進度表") && !boardText.includes("90%"));
  await page.locator("#trialMetricTitle").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-home.png" });
  await page.locator("#progressTableTitle").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-home-table.png" });
  const firstRow = page.locator("#cardList .card-row").first();
  await firstRow.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-row-unit-collapsed.png" });
  await page.locator("#btnToggleUnits").click();
  check("unit expanded", await page.locator("#cardList .source-unit").first().isVisible());
  await firstRow.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-row-unit-expanded.png" });
  await page.locator("#btnToggleUnits").click();
  check("unit collapsed again", await page.locator("#cardList .source-unit").first().isHidden());
  await page.locator("#btnProgress").click();
  await page.locator("#progressSheet.show").waitFor();
  check("progress sheet sort", (await textOf(page.locator("#progressSort"))).includes("狀態") && (await textOf(page.locator("#progressSort"))).includes("到期日"));
  check("records not mixed into progress", (await textOf(page.locator("#progressSheet"))).includes("進度表") && !(await textOf(page.locator("#progressSheet"))).includes("各單元累計"));
  await page.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-progress-sheet.png" });
  await page.locator("#progressSort button[data-sort='zh']").click();
  const sortedZh = await page.locator("#progressList .zh").allTextContents();
  const expectedZh = [...sortedZh].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  check("progress sheet sorts by prompt", sortedZh.join("\n") === expectedZh.join("\n"));
  await page.locator("#btnCloseProgress").click();
  await page.locator("#btnRecords").click();
  await page.locator("#recordsSheet.show").waitFor();
  check("records still separate", (await textOf(page.locator("#recordsSheet h2"))) === "練習紀錄");
  check("records keeps today rate", (await textOf(page.locator("#recordsSheet"))).includes("今日") && !(await textOf(page.locator("#recordsSheet h2"))).includes("進度表"));
  await page.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-records.png" });
  await page.locator("#btnCloseRecords").click();
  await page.screenshot({ path: "/opt/cursor/artifacts/ssco-dashboard.png" });
  await page.screenshot({ path: "/opt/cursor/artifacts/ssco-detail.png", clip: { x: 0, y: 180, width: 900, height: 500 } }).catch(() => {});
  await page.evaluate(() => {
    const shell = document.getElementById("main");
    if (shell) shell.scrollTop = shell.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.locator("#btnStartToday").click();
  await page.locator(".letter-cell").first().waitFor();
  check("cloze cells", await page.locator(".letter-cell").count() > 0);
  check("answer page hides the card list", await page.locator("#home").isHidden() && await page.locator("#cardList").isHidden());
  check("answer page shows the prompt", await page.locator("#phraseZh").isVisible());
  await releaseKeyboard(page);
  check("answer page shows skip and check", await page.locator("#btnSkip").isVisible() && await page.locator("#btnCheck").isVisible());
  const leakedCards = await page.locator("#cardList .zh").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
  check("no card row is on the answer page", leakedCards === 0, String(leakedCards));
  const answerTop = await page.evaluate(() => ({
    shell: document.getElementById("main").scrollTop,
    win: window.scrollY,
    screen: document.body.dataset.screen
  }));
  check("answer page is its own screen", answerTop.screen === "answer" && answerTop.shell < 8 && answerTop.win < 8, JSON.stringify(answerTop));
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
  check("resumed answer still hides cards", await page.locator("#home").isHidden() && (await page.evaluate(() => document.body.dataset.screen)) === "answer");

  await releaseKeyboard(page);
  await page.locator("#btnRecords").click();
  await page.locator("#recordsSheet.show").waitFor();
  check("records today", (await textOf(page.locator("#recStats"))).includes("今日"));
  await page.locator("#btnRecCopy").click();
  await page.waitForFunction(() => window.__copied && window.__copied.includes("進度報告"));
  const report = await page.evaluate(() => window.__copied);
  check("report version", report.includes("v2.2"));
  check("report scope", report.includes("紀錄範圍：本機（未設定雲端）"));
  check("report answer", report.includes(answered.answer) || report.includes("正確"));
  check("report delayed metric", /延遲獨立拼寫率 \d+\/\d+（含未學）/.test(report), report);
  check("report today independent", /今日獨立首次 \d+\/\d+/.test(report), report);
  check("report remediation", report.includes("今日補救") && report.includes("唔算獨立"), report);
  check("report keeps unit rates", report.includes("各單元正確率（累計）") && report.includes("正確率"));
  check("report is not mastery", !report.includes("掌握率") && !report.includes("90%"));
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => { throw new Error("denied"); };
    const deny = () => false;
    try { Document.prototype.execCommand = deny; } catch (_) {}
    try { document.execCommand = deny; } catch (_) {}
  });
  await page.locator("#btnRecCopy").click();
  await page.locator("#copyFallback:not([hidden])").waitFor();
  const fallback = await page.locator("#copyFallbackText").inputValue();
  check("fallback shows trial metrics", fallback.includes("延遲獨立拼寫率") && fallback.includes("今日獨立首次") && fallback.includes("唔算獨立"));
  await page.screenshot({ path: path.join(shots, "ssco-v22-copy-report.png") });
  await page.locator("#btnCopyFallbackClose").click();
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
  await page.locator("#vocabMeta").getByText("題庫 1 題").waitFor();
  await page.locator("#homeWarn").getByText("已匯入 1 題").waitFor();
  check("import count", (await page.locator("#vocabMeta").innerText()).includes("1"));
  await releaseKeyboard(page);
  await page.locator("#btnResetVocab").click();
  await page.locator("#vocabMeta").getByText("題庫 67 題").waitFor();
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
  await mobile.locator("#home").waitFor();
  await mobile.locator("#homeCounts").getByText("新卡", { exact: false }).waitFor();
  await mobile.locator("#homeMetricFigure").waitFor();
  const mobileFigure = await mobile.locator("#homeMetricFigure").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  check("mobile metric is prominent", mobileFigure >= 28, String(mobileFigure));
  check("mobile progress title", (await textOf(mobile.locator("#progressTableTitle"))) === "進度表");
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("mobile does not overflow sideways", overflow);
  check("mobile cards hide skip and check", await mobile.locator("#btnSkip").isHidden() && await mobile.locator("#btnCheck").isHidden());
  await mobile.locator("#trialMetricTitle").scrollIntoViewIfNeeded();
  await mobile.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-mobile.png" });
  await mobile.screenshot({ path: "/opt/cursor/artifacts/ssco-mobile-dashboard.png" });
  await mobile.locator("#progressTableTitle").scrollIntoViewIfNeeded();
  await mobile.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-mobile-table.png" });
  await mobile.evaluate(() => {
    const shell = document.getElementById("main");
    if (shell) shell.scrollTop = shell.scrollHeight;
  });
  await mobile.locator("#btnStartToday").click();
  await mobile.locator(".letter-cell").first().waitFor();
  await releaseKeyboard(mobile);
  check("mobile answer hides the card list", await mobile.locator("#home").isHidden());
  check("mobile answer shows the blank", await mobile.locator("#phraseZh").isVisible() && await mobile.locator(".letter-cell").first().isVisible());
  check("mobile answer shows skip and check", await mobile.locator("#btnSkip").isVisible() && await mobile.locator("#btnCheck").isVisible());
  const mobileLeaked = await mobile.locator("#cardList .zh").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).length);
  check("mobile answer has no card rows", mobileLeaked === 0, String(mobileLeaked));
  const mobileScreen = await mobile.evaluate(() => document.body.dataset.screen);
  check("mobile answer screen", mobileScreen === "answer", mobileScreen);
  await mobile.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-mobile-answer.png" });
  await mobile.locator("#btnRestart").click();
  await mobile.locator("#progressTableTitle").waitFor();
  check("mobile home is separate again", await mobile.locator("#practice").isHidden() && await mobile.locator("#cardList .card-row").first().isVisible());
  check("mobile home hides skip and check again", await mobile.locator("#btnSkip").isHidden() && await mobile.locator("#btnCheck").isHidden());
  await mobile.screenshot({ path: "/opt/cursor/artifacts/ssco-v22-mobile-home-return.png" });
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
  const claimPrompt = await clickAccountSignIn(a.synced);
  await a.synced.locator("#syncBanner").getByText("alice@example.com").waitFor({ timeout: 8000 });
  const bannerA = await textOf(a.synced.locator("#syncBanner"));
  check("signed-in banner", bannerA.includes("已同步") && bannerA.includes("合併 1 筆"), bannerA);
  check("claim confirm", claimPrompt.includes("第一個登入"), claimPrompt);
  await a.synced.screenshot({ path: path.join(shots, "ssco-synced.png") });

  const b = await openSynced({ uid: "alice", email: "alice@example.com" });
  await clickAccountSignIn(b.synced);
  await b.synced.locator("#syncBanner").getByText("合併 1 筆").waitFor({ timeout: 8000 });
  check("second browser sees migrated row", true);

  await a.synced.locator("#btnStartToday").click();
  await a.synced.locator(".letter-cell").first().waitFor();
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
  await a.synced.locator("#btnAccount", { hasText: "登出" }).evaluate((el) => {
    el.scrollIntoView({ block: "nearest", inline: "center" });
    el.click();
  });
  await waitBanner(a.synced, "已登出");
  check("sign-out confirm", a.dialogs.some((text) => text.includes("雲端紀錄會保留")));
  check("sign-out hides account rows", !(await textOf(a.synced.locator("#syncBanner"))).includes("alice@example.com"));

  await a.synced.evaluate(() => { window.__SSCO_TEST_USER = { uid: "bob", email: "bob@example.com" }; });
  await clickAccountSignIn(a.synced);
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
  const authPlan = await configured.evaluate(() => {
    const api = window.SSCOFirebaseSync;
    const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
    const crios = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
    return {
      loaded: !!api,
      safari: api.isIosWebKit(safari, "iPhone", 5),
      crios: api.isIosWebKit(crios, "iPhone", 5),
      popup: api.signInPlan({}).method,
      blocked: api.signInPlan({ popupBlocked: true }).method
    };
  });
  check("ios safari is webkit", authPlan.safari === true);
  check("ios chrome is webkit", authPlan.crios === true);
  check("sign-in plan is popup", authPlan.popup === "popup", authPlan.popup);
  check("popup blocked does not redirect", authPlan.blocked === "error", authPlan.blocked);
  await configured.close();

  const offlineSched = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await offlineSched.route("**/firebase-config.js", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript; charset=utf-8",
    body: "window.SSCO_FIREBASE_CONFIG = null;\n"
  }));
  await offlineSched.route("**/ts-fsrs-6.0.0.umd.js", (route) => route.fulfill({
    status: 200,
    contentType: "text/javascript; charset=utf-8",
    body: "/* library unavailable */\n"
  }));
  await offlineSched.goto(base + "/index.html", { waitUntil: "domcontentloaded" });
  await offlineSched.locator("#homeWarn").getByText("排程庫未載入").waitFor({ timeout: 8000 });
  check("missing library stays honest", (await textOf(offlineSched.locator("#homeWarn"))).includes("不會假裝"));
  await offlineSched.screenshot({ path: "/opt/cursor/artifacts/ssco-schedule-error.png" });
  await offlineSched.close();
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
