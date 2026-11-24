import { MongoMemoryReplSet } from "mongodb-memory-server";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = 4612;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = randomBytes(24).toString("hex");
const FIXTURES = path.resolve(import.meta.dirname, "fixtures");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const TITLES = [
  "Opening Night",
  "Coastline Drive",
  "Harbour Lights",
  "The Long Walk",
  "Midnight Kitchen",
  "Desert Signal",
  "Paper Moon",
  "Second Chances",
];

const SAMPLE_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm";

async function ensureFixtures() {
  const target = path.join(FIXTURES, "sample.webm");
  try {
    await fs.access(target);
    return;
  } catch {
    console.log("downloading video fixture…");
  }
  await fs.mkdir(FIXTURES, { recursive: true });
  const response = await fetch(SAMPLE_URL);
  if (!response.ok) throw new Error(`Could not download the video fixture: ${response.status}`);
  await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function buildMedia() {
  await ensureFixtures();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gp-browser-"));
  const season = path.join(root, "library", "season-one");
  await fs.mkdir(season, { recursive: true });

  const webm = await fs.readFile(path.join(FIXTURES, "sample.webm"));

  for (const [index, title] of TITLES.entries()) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await fs.writeFile(path.join(season, `${String(index + 1).padStart(2, "0")}-${slug}.webm`), webm);
  }

  await fs.writeFile(path.join(season, "raw-master.mkv"), randomBytes(2048));
  return root;
}

async function adminCall(method, url, body) {
  const response = await fetch(BASE + url, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function waitForHealth(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server never became healthy");
}

async function main() {
  const mediaRoot = await buildMedia();
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });

  const server = spawn("node", ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: replSet.getUri(),
      MONGODB_DB: "getpleasure_browser",
      ADMIN_TOKEN,
      SESSION_SECRET: randomBytes(24).toString("hex"),
      STREAM_SECRET: randomBytes(24).toString("hex"),
      MEDIA_ROOT: mediaRoot,
      IP_MATCH_MODE: "strict",
      TRUST_PROXY_HOPS: "0",
      COOKIE_SECURE: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => process.stdout.write(`  [srv] ${c}`));
  server.stderr.on("data", (c) => process.stderr.write(`  [srv!] ${c}`));

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  let context;

  try {
    await waitForHealth();

    await adminCall("POST", "/api/admin/categories", { code: 12, name: "Premium Collection" });
    const season = await adminCall("POST", "/api/admin/archives", {
      categoryCode: "12",
      name: "Season One",
      description: "The complete first run, remastered.",
    });
    await adminCall("POST", `/api/admin/archives/${season.id}/import`, { relPath: "library/season-one" });
    const keyDoc = await adminCall("POST", "/api/admin/keys", {
      validityDays: 30,
      categoryCode: 12,
      label: "Browser test",
    });

    context = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    section("Gate page in a real browser (mobile viewport)");
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

    check("wordmark rendered", (await page.locator(".gate__title").textContent()).includes("Get"));
    check("key input visible", await page.locator("#key-input").isVisible());
    check("trust list has four points", (await page.locator(".gate__trust-item").count()) === 4);

    const fontFamily = await page.locator(".gate__title").evaluate((node) => getComputedStyle(node).fontFamily);
    check("custom display font applied", fontFamily.includes("Bricolage"), `got ${fontFamily}`);

    const fontLoaded = await page.evaluate(() => document.fonts.check('700 40px "Bricolage Grotesque"'));
    check("display font actually loaded by the browser", fontLoaded);

    await page.fill("#key-input", "GP-definitely-wrong-key");
    await page.click("#gate-submit");
    await page.waitForSelector("#gate-error:not([hidden])", { timeout: 8000 });
    check("wrong key shows an inline error", (await page.locator("#gate-error").textContent()).length > 5);
    check("still on the gate after a wrong key", page.url().endsWith("/"));

    await page.fill("#key-input", keyDoc.key);
    await page.click("#gate-submit");
    await page.waitForURL("**/watch", { timeout: 10000 });
    check("correct key opens the library", page.url().includes("/watch"));

    section("Home view");
    await page.waitForSelector(".acard", { timeout: 10000 });
    check("category name shown as the heading", (await page.locator("#hero-title").textContent()).trim() === "Premium Collection");
    check("tier code shown", (await page.locator("#hero-eyebrow").textContent()).includes("12"));
    check("archive card rendered", (await page.locator(".acard").count()) === 1);
    check('"Start Watching" button present', await page.locator(".acard__cta").first().isVisible());
    check("plan days pill visible", await page.locator("#plan-pill").isVisible());
    check("plan pill mentions days left", (await page.locator("#plan-pill").textContent()).includes("day"));

    await page.click("#menu-toggle");
    await page.waitForSelector("#account-sheet:not([hidden])");
    check("account sheet shows the locked IP", (await page.locator("#account-ip").textContent()).length > 3);
    check("account sheet shows a masked key hint", (await page.locator("#account-key").textContent()).includes("GP-"));
    await page.click("#sheet-close");

    section("Archive listing");
    await page.click(".acard__cta");
    await page.waitForSelector("#video-grid .vcard", { timeout: 10000 });

    const cardCount = await page.locator("#video-grid .vcard").count();
    check("all 9 videos listed", cardCount === 9, `got ${cardCount}`);
    check("archive title shown", (await page.locator("#archive-title").textContent()).trim() === "Season One");

    const numbers = await page.locator(".thumb__number").allTextContents();
    check("video numbers use the #N format", numbers.every((value) => /^#\d+$/.test(value)), `got ${numbers.slice(0, 4)}`);
    check("numbers cover #1 through #9", new Set(numbers).size === 9 && numbers.includes("#1"), `got ${numbers.join(",")}`);

    const thumbLoaded = await page.locator(".thumb__img").first().evaluate((img) => img.complete && img.naturalWidth > 0);
    check("thumbnail image actually loaded", thumbLoaded);

    const transcodeBadges = await page.locator(".thumb__duration--warn").count();
    check("mkv file flagged as needing transcode", transcodeBadges === 1, `got ${transcodeBadges}`);

    await page.click('.sort[data-sort="number"]');
    await page.waitForTimeout(900);
    const sortedNumbers = await page.locator(".thumb__number").allTextContents();
    check("sorting by number starts at #1", sortedNumbers[0] === "#1", `got ${sortedNumbers[0]}`);
    check("sort tab marked active", await page.locator('.sort[data-sort="number"]').evaluate((n) => n.classList.contains("is-active")));

    section("Protected player with real video playback");
    await page.click("#video-grid .vcard >> nth=0");
    await page.waitForSelector("#view-player:not([hidden])", { timeout: 10000 });

    check("player shows the video number", (await page.locator("#player-number").textContent()).startsWith("#"));
    check("player shows the title", (await page.locator("#player-title").textContent()).length > 3);

    await page.waitForFunction(() => Boolean(document.getElementById("player-video").src), { timeout: 15000 });
    const videoSrc = await page.locator("#player-video").evaluate((video) => video.src);
    check(
      "player src points at the signed stream endpoint",
      /\/api\/stream\/[a-f0-9]{24}\?t=\d+\./.test(videoSrc),
      `got ${videoSrc}`,
    );
    check("player src is not a raw file path", !/\.webm|\.mp4|library/i.test(videoSrc));

    const controlsList = await page.locator("#player-video").getAttribute("controlslist");
    check("download control removed from the player", String(controlsList).includes("nodownload"));

    const watermarkText = await page.locator("#player-watermark").textContent();
    check("session watermark drawn over the video", watermarkText.includes("GP-"), `got ${watermarkText}`);

    await page.waitForFunction(() => {
      const video = document.getElementById("player-video");
      return video && video.readyState >= 2;
    }, { timeout: 20000 });

    const metadata = await page.locator("#player-video").evaluate((video) => ({
      duration: video.duration,
      width: video.videoWidth,
      error: video.error?.code ?? null,
    }));
    check("video metadata decoded", metadata.duration > 0 && metadata.width > 0, JSON.stringify(metadata));
    check("no media error reported", metadata.error === null, `error code ${metadata.error}`);

    await page.locator("#player-video").evaluate((video) => video.play());
    await page.waitForFunction(() => document.getElementById("player-video").currentTime > 0.6, { timeout: 20000 });
    const playedTo = await page.locator("#player-video").evaluate((video) => video.currentTime);
    check("video genuinely plays through the protected stream", playedTo > 0.6, `reached ${playedTo.toFixed(2)}s`);

    await page.locator("#player-video").evaluate((video) => {
      video.currentTime = 3.2;
    });
    await page.waitForTimeout(1800);
    const afterSeek = await page.locator("#player-video").evaluate((video) => ({
      time: video.currentTime,
      error: video.error?.code ?? null,
    }));
    check("seeking works over range requests", afterSeek.time > 2.5 && afterSeek.error === null, JSON.stringify(afterSeek));

    section("Likes and resume");
    const likeBefore = await page.locator("#like-count").textContent();
    await page.click("#like-button");
    await page.waitForTimeout(700);
    check("like count increments", (await page.locator("#like-count").textContent()) !== likeBefore);
    check("like button shows the liked state", await page.locator("#like-button").evaluate((n) => n.classList.contains("is-liked")));
    check("like button exposes aria-pressed", (await page.locator("#like-button").getAttribute("aria-pressed")) === "true");

    await page.locator("#player-video").evaluate(async (video) => {
      video.currentTime = video.duration * 0.55;
      await video.play().catch(() => {});
    });
    await page.waitForTimeout(500);
    await page.locator("#player-video").evaluate((video) => video.pause());
    await page.waitForTimeout(1600);

    const savedProgress = await page.evaluate(async () => {
      const home = await fetch("/api/home", { credentials: "same-origin" }).then((response) => response.json());
      return home.continueWatching;
    });
    check("progress persisted to the database", savedProgress.length === 1, JSON.stringify(savedProgress));

    await page.goto(`${BASE}/watch`, { waitUntil: "networkidle" });
    await page.waitForSelector("#resume-section:not([hidden])", { timeout: 10000 });
    check("continue watching row appears after watching", await page.locator("#resume-section").isVisible());
    const resumeCards = await page.locator("#resume-rail .vcard").count();
    check("resume row holds the watched video", resumeCards === 1, `got ${resumeCards}`);

    const progressWidth = await page
      .locator("#resume-rail .thumb__progress-fill")
      .first()
      .evaluate((node) => node.style.width);
    check("resume progress bar has a width", /%$/.test(progressWidth) && parseFloat(progressWidth) > 0, `got ${progressWidth}`);

    section("Broadcast popup with I Read");
    const broadcast = await adminCall("POST", "/api/admin/broadcasts", {
      title: "Server maintenance",
      message: "The library pauses for 10 minutes at 02:00 UTC tonight.",
    });

    await page.waitForSelector("#broadcast-modal:not([hidden])", { timeout: 30000 });
    check("broadcast pops up on the viewer screen", await page.locator("#broadcast-modal").isVisible());
    check("broadcast title shown", (await page.locator("#broadcast-title").textContent()).includes("maintenance"));
    check("broadcast message shown", (await page.locator("#broadcast-message").textContent()).includes("02:00 UTC"));
    check('"I Read" button present', (await page.locator("#broadcast-ack").textContent()).trim() === "I Read");

    await page.click("#broadcast-ack");
    await page.waitForSelector("#broadcast-modal", { state: "hidden", timeout: 5000 });
    check('"I Read" closes the popup', await page.locator("#broadcast-modal").isHidden());

    await page.waitForTimeout(23000);
    check("broadcast does not come back after acknowledgement", await page.locator("#broadcast-modal").isHidden());

    const acked = await adminCall("GET", "/api/admin/broadcasts");
    check("owner sees the acknowledgement count", acked.broadcasts[0].ackCount === 1, `got ${acked.broadcasts[0].ackCount}`);
    void broadcast;

    section("Owner console in the browser");
    const adminPage = await context.newPage();
    const adminErrors = [];
    adminPage.on("pageerror", (error) => adminErrors.push(error.message));

    await adminPage.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
    check("admin login screen shown", await adminPage.locator("#login-view").isVisible());

    await adminPage.fill("#admin-token", "wrong-token-value");
    await adminPage.click('#login-form button[type="submit"]');
    await adminPage.waitForSelector("#login-error:not([hidden])", { timeout: 8000 });
    check("wrong admin token rejected in the UI", await adminPage.locator("#login-error").isVisible());

    await adminPage.fill("#admin-token", ADMIN_TOKEN);
    await adminPage.click('#login-form button[type="submit"]');
    await adminPage.waitForSelector("#console-view:not([hidden])", { timeout: 12000 });
    check("console opens with the right token", await adminPage.locator("#console-view").isVisible());

    await adminPage.waitForSelector(".stat", { timeout: 10000 });
    const stats = await adminPage.locator(".stat__value").allTextContents();
    check("dashboard renders stat tiles", stats.length === 6, `got ${stats.length}`);
    check("live viewer count is visible", (await adminPage.locator("#live-pill").textContent()).includes("live"));

    const liveNow = Number((await adminPage.locator(".stat__value").first().textContent()).trim());
    check("live viewers counts the open viewer tab", liveNow >= 1, `got ${liveNow}`);

    await adminPage.click('.tab[data-tab="library"]');
    await adminPage.waitForSelector(".fsrow", { timeout: 10000 });
    check("VPS file browser lists entries", (await adminPage.locator(".fsrow").count()) >= 1);
    check("browser path starts at the media root", (await adminPage.locator("#fs-path").textContent()) === "/");

    await adminPage.click(".fsrow >> nth=0");
    await adminPage.waitForTimeout(900);
    check("clicking a folder navigates into it", (await adminPage.locator("#fs-path").textContent()).includes("library"));

    await adminPage.click('.tab[data-tab="keys"]');
    await adminPage.waitForSelector("#key-form", { timeout: 8000 });
    await adminPage.fill("#key-days", "7");
    await adminPage.fill("#key-label", "Browser created");
    await adminPage.click('#key-form button[type="submit"]');
    await adminPage.waitForSelector("#key-output:not([hidden])", { timeout: 10000 });
    const newKey = await adminPage.locator("#key-value").textContent();
    check("admin UI generates a key", newKey.startsWith("GP-"), `got ${newKey.slice(0, 12)}`);
    check("key list shows subscriptions", (await adminPage.locator("#key-list .row").count()) >= 2);

    await adminPage.click('.tab[data-tab="activity"]');
    await adminPage.waitForSelector("#live-list .row", { timeout: 10000 });
    check("activity tab lists the live viewer", (await adminPage.locator("#live-list .row").count()) >= 1);
    check("audit log has entries", (await adminPage.locator("#audit-list .row").count()) >= 1);

    section("Owner expires the viewer mid-session");
    await adminPage.click('.tab[data-tab="keys"]');
    await adminPage.waitForTimeout(600);
    await adminCall("POST", `/api/admin/keys/${keyDoc.id}/expire`);

    await page.bringToFront();
    await page.waitForURL((url) => !url.pathname.startsWith("/watch"), { timeout: 40000 });
    check("expired viewer is thrown back to the gate", !page.url().includes("/watch"), `at ${page.url()}`);

    section("Console hygiene");
    const cspViolations = [...consoleErrors, ...adminErrors].filter((text) => /content security policy|refused to/i.test(text));
    check("no content security policy violations", cspViolations.length === 0, cspViolations.join(" | "));
    check("no uncaught javascript errors on the viewer pages", pageErrors.length === 0, pageErrors.join(" | "));
    check("no uncaught javascript errors in the admin console", adminErrors.length === 0, adminErrors.join(" | "));

    const ignorable = /favicon|ERR_ABORTED|net::ERR_FAILED|401|403/i;
    const realErrors = consoleErrors.filter((text) => !ignorable.test(text));
    check("no unexpected console errors", realErrors.length === 0, realErrors.join(" | "));
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    server.kill("SIGKILL");
    await replSet.stop();
    await fs.rm(mediaRoot, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(46)}`);
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const name of failures) console.log(`  - ${name}`);
  }
  console.log("=".repeat(46));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nBrowser harness crashed:", error);
  process.exit(1);
});
