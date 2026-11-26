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
      TELEGRAM_DRIVER_MODULE: path.resolve(import.meta.dirname, "fake-telegram.mjs"),
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

    section("First-visit splash screen");
    const splashStarted = Date.now();
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    check("splash is shown on the very first visit", await page.locator("#splash").isVisible());
    check("splash says it is loading the experience", /loading your experience/i.test(await page.locator(".splash__title").textContent()));

    await page.waitForFunction(() => {
      const img = document.querySelector(".splash__banner");
      return img && img.complete && img.naturalWidth > 0;
    }, { timeout: 8000 });
    check("splash banner image loaded", true);

    const midProgress = await page.locator("#splash-pct").textContent();
    check("splash shows a percentage", /^\d+%$/.test(midProgress.trim()), `got ${midProgress}`);

    await page.waitForSelector("#splash", { state: "hidden", timeout: 15000 });
    const splashMs = Date.now() - splashStarted;
    check("splash stays long enough to be seen", splashMs >= 2000, `${splashMs} ms`);
    check("splash gives way within the time limit", splashMs < 13000, `${splashMs} ms`);
    check("splash reached 100% before leaving", (await page.locator("#splash-pct").textContent()).trim() === "100%");
    check("splash marks itself as seen", (await page.evaluate(() => localStorage.getItem("gp_splash_v1"))) === "1");

    const fetched = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname),
    );
    const videoDownloads = fetched.filter((item) => /^\/media\/seal\.(webm|mp4)$/.test(item));
    check("splash downloads the butterfly video", videoDownloads.length >= 1, fetched.join(","));
    check("butterfly video is downloaded only once", videoDownloads.length === 1, videoDownloads.join(","));
    check("splash does not prefetch the home page script", !fetched.includes("/js/app.js"), fetched.join(","));
    check("splash does not prefetch home page styles", !fetched.includes("/css/app.css"));
    check("splash does not prefetch the hero character", !fetched.includes("/img/characters/rize-lean.webp"));
    check("splash shows the butterfly step text", /butterfly|ready|almost/i.test(await page.locator("#splash-step").textContent()));

    section("Gate page in a real browser (mobile viewport)");
    check("wordmark rendered", (await page.locator(".gate__title").textContent()).includes("Get"));
    check("key input visible", await page.locator("#key-input").isVisible());
    check("trust list has four points", (await page.locator(".gate__trust-item").count()) === 4);

    const titleFont = await page.locator(".gate__title").evaluate((node) => getComputedStyle(node).fontFamily);
    check("headings use Plus Jakarta Sans", titleFont.includes("Plus Jakarta Sans"), `got ${titleFont}`);
    const accentFont = await page.locator(".gate__title em").evaluate((node) => {
      const style = getComputedStyle(node);
      return { family: style.fontFamily, style: style.fontStyle };
    });
    check("accent words keep the Bodoni Moda italic", accentFont.family.includes("Bodoni Moda") && accentFont.style === "italic", JSON.stringify(accentFont));

    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => ({
      sans: document.fonts.check('500 16px "Plus Jakarta Sans"'),
      sansBold: document.fonts.check('800 40px "Plus Jakarta Sans"'),
      italic: document.fonts.check('italic 500 40px "Bodoni Moda"'),
      mono: document.fonts.check('500 12px "Martian Mono"'),
    }));
    check("Plus Jakarta Sans loaded", fonts.sans);
    check("Plus Jakarta Sans bold weight available", fonts.sansBold);
    check("Bodoni Moda italic loaded", fonts.italic);
    check("mono font loaded", fonts.mono);

    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    check("body text uses Plus Jakarta Sans", bodyFont.includes("Plus Jakarta Sans"), `got ${bodyFont}`);
    check("paste button offered on the key field", await page.locator("#gate-paste").isVisible());

    section("Video seal and mascot");
    await page.waitForFunction(() => {
      const video = document.getElementById("seal-video");
      return video && video.readyState >= 2 && !video.paused && video.currentTime > 0.2;
    }, { timeout: 10000 });
    const sealVideo = await page.locator("#seal-video").evaluate((video) => ({
      muted: video.muted,
      loop: video.loop,
      src: video.currentSrc,
      width: video.videoWidth,
      radius: getComputedStyle(video.parentElement).borderRadius,
    }));
    check("seal video plays in the circle", sealVideo.width > 0, JSON.stringify(sealVideo));
    check("seal video is muted and loops", sealVideo.muted && sealVideo.loop);
    check("seal plays from the copy the splash downloaded", sealVideo.src.startsWith("blob:"), sealVideo.src);

    const smooth = await page.locator("#seal-video").evaluate(async (video) => {
      const start = video.currentTime;
      let stalls = 0;
      video.addEventListener("waiting", () => stalls++);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { advanced: video.currentTime - start, stalls, buffered: video.buffered.length ? video.buffered.end(0) : 0, duration: video.duration };
    });
    check("butterfly plays without stalling", smooth.stalls === 0 && smooth.advanced > 0.8, JSON.stringify(smooth));
    check("whole butterfly loop is buffered", smooth.buffered >= smooth.duration - 0.1, JSON.stringify(smooth));
    check("seal is clipped to a circle", sealVideo.radius === "50%", sealVideo.radius);

    const halo = await page.locator(".seal__halo").evaluate((node) => getComputedStyle(node).backgroundImage);
    check("seal has a side gradient halo", (halo.match(/radial-gradient/g) ?? []).length >= 2, halo.slice(0, 80));

    check("mascot starts idle", (await page.locator("#mascot").getAttribute("data-mood")) === "idle");
    const mascotLoaded = await page.locator(".mascot__img--idle").evaluate((img) => img.complete && img.naturalWidth > 0);
    check("mascot image loaded", mascotLoaded);

    section("Wrong key reaction");
    await page.fill("#key-input", "GP-definitely-wrong-key");
    await page.click("#gate-submit");
    await page.waitForSelector("#gate-error:not([hidden])", { timeout: 8000 });
    check("wrong key shows an inline error", (await page.locator("#gate-error").textContent()).length > 5);
    check("still on the gate after a wrong key", page.url().endsWith("/"));
    check("mascot reacts sadly to a wrong key", (await page.locator("#mascot").getAttribute("data-mood")) === "sad");
    check("seal shakes on a wrong key", await page.locator("#gate-seal").evaluate((node) => node.classList.contains("is-denied")));
    await page.waitForFunction(() => document.getElementById("mascot").dataset.mood === "idle", { timeout: 5000 });
    check("mascot recovers to idle", true);

    section("Unlock animation");
    await page.fill("#key-input", keyDoc.key);
    const unlockStarted = Date.now();
    await page.click("#gate-submit");
    await page.waitForSelector("#gate-seal.is-unlocking", { timeout: 6000 });
    check("ring sweep starts on a correct key", true);
    check("key field turns valid", await page.locator("#gate-field").evaluate((node) => node.classList.contains("is-valid")));
    check("button reads Unlocked", (await page.locator("#gate-submit-label").textContent()) === "Unlocked");
    check("mascot celebrates", (await page.locator("#mascot").getAttribute("data-mood")) === "happy");

    await page.waitForSelector("#gate-seal.is-unlocked", { timeout: 4000 });
    const sparks = await page.locator("#seal-burst .spark").count();
    check("spark burst fires", sparks >= 24, `got ${sparks}`);

    await page.waitForSelector("#iris.is-open", { timeout: 4000 });
    check("iris wipe opens from the seal", true);

    await page.waitForURL("**/watch", { timeout: 10000 });
    const unlockMs = Date.now() - unlockStarted;
    check("correct key opens the library", page.url().includes("/watch"));
    check("unlock sequence plays out over about three and a half seconds", unlockMs >= 3000 && unlockMs < 6500, `${unlockMs} ms`);
    check("watch page plays the arrival transition", (await page.evaluate(() => document.documentElement.getAttribute("data-arrival"))) === "on");

    section("Home view");
    await page.waitForSelector(".acard", { timeout: 10000 });
    check("category name shown as the heading", (await page.locator("#hero-title").textContent()).trim() === "Premium Collection");
    check("tier code shown", (await page.locator("#hero-eyebrow").textContent()).includes("12"));
    check("archive card rendered", (await page.locator(".acard").count()) === 1);
    check('"Start Watching" button present', await page.locator(".acard__cta").first().isVisible());
    check("plan days pill visible", await page.locator("#plan-pill").isVisible());
    check("plan pill mentions days left", (await page.locator("#plan-pill").textContent()).includes("day"));
    check("greeting line rendered", /welcome back/i.test(await page.locator("#hero-greeting").textContent()));
    check("hero stat chips rendered", (await page.locator("#hero-chips .chip").count()) === 3);

    await page.waitForFunction(
      () => [...document.querySelectorAll(".acard__cover img")].some((img) => img.complete && img.naturalWidth > 0),
      { timeout: 10000 },
    );
    const coverCount = await page.locator(".acard__cover img").count();
    check("archive card shows a thumbnail mosaic", coverCount === 3, `got ${coverCount}`);

    await page.click("#menu-toggle");
    await page.waitForSelector("#account-sheet:not([hidden])");
    check("account sheet shows the locked IP", (await page.locator("#account-ip").textContent()).length > 3);
    check("account sheet shows a masked key hint", (await page.locator("#account-key").textContent()).includes("GP-"));

    await page.waitForTimeout(1500);
    const ring = await page.evaluate(() => ({
      offset: Number(getComputedStyle(document.getElementById("plan-progress")).strokeDashoffset.replace("px", "")),
      days: document.getElementById("plan-days").textContent.trim(),
    }));
    check("plan ring is drawn nearly full for a fresh 30-day key", ring.offset >= 0 && ring.offset < 20, `offset ${ring.offset}`);
    check("plan ring counts 30 days", ring.days === "30", `got ${ring.days}`);

    await page.click("#sheet-close");
    await page.waitForSelector("#account-sheet", { state: "hidden", timeout: 3000 });
    check("account sheet closes with its exit animation", await page.locator("#account-sheet").isHidden());

    section("Archive listing");
    await page.click(".acard__cta");
    await page.waitForSelector("#video-grid .vcard", { timeout: 10000 });

    const cardCount = await page.locator("#video-grid .vcard").count();
    check("all 9 videos listed", cardCount === 9, `got ${cardCount}`);
    check("archive title shown", (await page.locator("#archive-title").textContent()).trim() === "Season One");

    const numbers = await page.locator("#video-grid .thumb__number").allTextContents();
    check("video numbers use the #N format", numbers.every((value) => /^#\d+$/.test(value)), `got ${numbers.slice(0, 4)}`);
    check("numbers cover #1 through #9", new Set(numbers).size === 9 && numbers.includes("#1"), `got ${numbers.join(",")}`);

    await page.waitForFunction(
      () => {
        const img = document.querySelector("#video-grid .thumb__img");
        return img && img.complete && img.naturalWidth > 0 && img.classList.contains("is-loaded");
      },
      { timeout: 10000 },
    );
    check("thumbnail image loaded and faded in", true);

    const transcodeBadges = await page.locator("#video-grid .thumb__duration--warn").count();
    check("mkv file flagged as needing transcode", transcodeBadges === 1, `got ${transcodeBadges}`);

    const indicatorBefore = await page.evaluate(() => {
      const node = document.querySelector("#sort-control .segmented__indicator");
      return { width: node.getBoundingClientRect().width, left: node.getBoundingClientRect().left };
    });
    check("sort indicator sits under the active tab", indicatorBefore.width > 40, `width ${indicatorBefore.width}`);

    await page.click('.sort[data-sort="number"]');
    await page.waitForTimeout(900);
    const sortedNumbers = await page.locator("#video-grid .thumb__number").allTextContents();
    check("sorting by number starts at #1", sortedNumbers[0] === "#1", `got ${sortedNumbers[0]}`);
    check("sort tab marked active", await page.locator('.sort[data-sort="number"]').evaluate((n) => n.classList.contains("is-active")));

    const indicatorAfter = await page.evaluate(() => {
      const node = document.querySelector("#sort-control .segmented__indicator");
      const active = document.querySelector('.sort[data-sort="number"]');
      return {
        left: node.getBoundingClientRect().left,
        activeLeft: active.getBoundingClientRect().left,
        width: node.getBoundingClientRect().width,
        activeWidth: active.getBoundingClientRect().width,
      };
    });
    check("sort indicator slid to the new tab", Math.abs(indicatorAfter.left - indicatorAfter.activeLeft) < 2, JSON.stringify(indicatorAfter));
    check("sort indicator matches the tab width", Math.abs(indicatorAfter.width - indicatorAfter.activeWidth) < 2, JSON.stringify(indicatorAfter));

    section("Search and jump to number");
    await page.fill("#video-search", "#3");
    await page.waitForFunction(() => document.querySelectorAll("#video-grid .vcard").length === 1, { timeout: 6000 });
    check("typing #3 jumps straight to video #3", (await page.locator("#video-grid .thumb__number").first().textContent()) === "#3");
    check("result count shown in the subtitle", (await page.locator("#archive-sub").textContent()).includes("1 result"));

    await page.fill("#video-search", "paper");
    await page.waitForFunction(
      () => {
        const titles = [...document.querySelectorAll("#video-grid .vcard__title")].map((node) => node.textContent);
        return titles.length === 1 && titles[0] === "Paper Moon";
      },
      { timeout: 6000 },
    );
    check("title search finds Paper Moon", true);

    await page.fill("#video-search", "#999");
    await page.waitForSelector("#video-grid .empty", { timeout: 6000 });
    check("a missing number shows a friendly empty state", (await page.locator("#video-grid .empty").textContent()).includes("#999"));

    await page.click("#video-search-clear");
    await page.waitForFunction(() => document.querySelectorAll("#video-grid .vcard").length === 9, { timeout: 6000 });
    check("clearing the search restores every video", true);
    check("clear button hides itself again", await page.locator("#video-search-clear").isHidden());

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

    check("native browser controls are off", !(await page.locator("#player-video").evaluate((video) => video.controls)));
    check("custom control bar is drawn", await page.locator("#pc-seek").isVisible());
    check("duration shown in the custom bar", (await page.locator("#pc-duration").textContent()) !== "0:00");

    await page.click("#pc-play");
    await page.waitForFunction(() => document.getElementById("player-video").currentTime > 0.6, { timeout: 20000 });
    check("our play button starts playback", true);
    check("play button switches to pause", (await page.locator("#player-controls").getAttribute("data-state")) === "playing");
    const seekFill = await page.locator("#pc-played").evaluate((node) => node.style.transform);
    check("seek bar fills as the video plays", /scaleX\(0\.[1-9]|scaleX\(1/.test(seekFill), seekFill);
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

    section("Up next countdown");
    await page.waitForSelector("#upnext-overlay:not([hidden])", { timeout: 10000 });
    check("up-next card appears when the video ends", await page.locator("#upnext-overlay").isVisible());
    check("up-next offers the next number in order", (await page.locator("#upnext-title").textContent()).startsWith("#2"), await page.locator("#upnext-title").textContent());
    const countdown = Number(await page.locator("#upnext-seconds").textContent());
    check("countdown is ticking", countdown >= 1 && countdown <= 6, `got ${countdown}`);
    await page.click("#upnext-cancel");
    check('"Stay here" cancels autoplay', await page.locator("#upnext-overlay").isHidden());
    await page.waitForTimeout(6500);
    check("player stays on the same video after cancelling", (await page.locator("#player-number").textContent()) === "#1");

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

    section("Back to the archive without reloading");
    await page.click("#nav-back");
    await page.waitForSelector("#view-archive:not([hidden])", { timeout: 6000 });
    const afterBack = await page.evaluate(() => ({
      skeletons: document.querySelectorAll("#video-grid .skeleton").length,
      cards: document.querySelectorAll("#video-grid .vcard").length,
      videoSrc: document.getElementById("player-video").getAttribute("src"),
    }));
    check("archive grid comes back instantly with no loading skeletons", afterBack.skeletons === 0 && afterBack.cards === 9, JSON.stringify(afterBack));
    check("leaving the player pauses the video at once", await page.evaluate(() => document.getElementById("player-video").paused));
    const streamStopped = await page
      .waitForFunction(() => !document.getElementById("player-video").getAttribute("src"), null, { timeout: 4000 })
      .then(() => true, () => false);
    check("leaving the player stops the stream once the animation ends", streamStopped, JSON.stringify(afterBack));
    await page.waitForFunction(
      () => document.querySelector('#video-grid [data-video] .vcard__meta')?.textContent.includes("1 view"),
      { timeout: 6000 },
    ).then(
      () => check("view counts refresh quietly after coming back", true),
      () => check("view counts refresh quietly after coming back", false),
    );

    await page.goto(`${BASE}/watch`, { waitUntil: "networkidle" });
    await page.waitForSelector("#resume-section:not([hidden])", { timeout: 10000 });
    check("continue watching row appears after watching", await page.locator("#resume-section").isVisible());
    const resumeCards = await page.locator("#resume-rail .vcard").count();
    check("resume row holds the watched video", resumeCards === 1, `got ${resumeCards}`);

    const progressWidth = await page
      .locator("#resume-rail .thumb__progress-fill")
      .first()
      .evaluate((node) => node.style.transform);
    check("resume progress bar fills with a transform", /^scaleX\(0\.\d+\)$/.test(progressWidth) && parseFloat(progressWidth.slice(7)) > 0, `got ${progressWidth}`);

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

    await adminPage.click('#key-list .row:has-text("Browser created") [data-expire]');
    await adminPage.waitForSelector(".scrim .sheet-panel", { timeout: 5000 });
    check("expiring a key asks for confirmation in a styled sheet", (await adminPage.locator(".scrim .sheet-title").textContent()).includes("Expire"));

    await adminPage.click('.scrim [data-answer="no"]');
    await adminPage.waitForSelector(".scrim", { state: "detached", timeout: 3000 });
    check("cancelling the sheet leaves the key active", (await adminPage.locator('#key-list .row:has-text("Browser created") .pill').textContent()) === "active");

    await adminPage.click('#key-list .row:has-text("Browser created") [data-expire]');
    await adminPage.click('.scrim [data-answer="yes"]');
    await adminPage.waitForSelector('.toast:has-text("Subscription expired")', { timeout: 6000 });
    check("no error toast was raised", (await adminPage.locator(".toast--error").count()) === 0);
    check("confirming shows a success toast", true);
    await adminPage.waitForFunction(
      () => [...document.querySelectorAll("#key-list .row")].some((row) => row.textContent.includes("Browser created") && row.textContent.includes("revoked")),
      { timeout: 6000 },
    );
    check("the key list updates to revoked", true);

    await adminPage.click('.tab[data-tab="activity"]');
    await adminPage.waitForSelector("#live-list .row", { timeout: 10000 });
    check("activity tab lists the live viewer", (await adminPage.locator("#live-list .row").count()) >= 1);
    check("audit log has entries", (await adminPage.locator("#audit-list .row").count()) >= 1);

    section("Telegram downloads in the owner console");
    await adminPage.click('.tab[data-tab="telegram"]');
    await adminPage.waitForSelector("#tg-login-form:not([hidden])", { timeout: 6000 });
    check("telegram tab asks for API details first", await adminPage.locator("#tg-login-form").isVisible());
    check("start download is locked until an account is connected", await adminPage.locator("#tg-job-button").isDisabled());
    await adminPage.fill("#tg-api-id", "123456");
    await adminPage.fill("#tg-api-hash", "0123456789abcdef0123456789abcdef");
    await adminPage.fill("#tg-phone", "+15550002");
    await adminPage.click('#tg-login-form button[type="submit"]');
    await adminPage.waitForSelector("#tg-code-form:not([hidden])", { timeout: 6000 });
    check("the code step names where the code went", (await adminPage.locator("#tg-code-lead").textContent()).includes("Telegram app"));
    await adminPage.fill("#tg-code", "00000");
    await adminPage.click('#tg-code-form button[type="submit"]');
    await adminPage.waitForSelector("#tg-login-error:not([hidden])", { timeout: 6000 });
    check("a wrong code shows a clear error", (await adminPage.locator("#tg-login-error").textContent()).includes("wrong"));
    await adminPage.fill("#tg-code", "12345");
    await adminPage.click('#tg-code-form button[type="submit"]');
    await adminPage.waitForSelector("#tg-password-form:not([hidden])", { timeout: 6000 });
    check("two-step password step shows the hint", (await adminPage.locator("#tg-password-lead").textContent()).includes("the usual"));
    await adminPage.fill("#tg-password", "hunter2");
    await adminPage.click('#tg-password-form button[type="submit"]');
    await adminPage.waitForSelector("#tg-account:not([hidden])", { timeout: 6000 });
    check("the connected account is shown", (await adminPage.locator("#tg-account-name").textContent()) === "Second Account");
    check("start download unlocks after connecting", await adminPage.locator("#tg-job-button").isEnabled());

    await adminPage.fill("#tg-category-code", "88");
    check("a new code asks for its name", await adminPage.locator("#tg-category-name-field").isVisible());
    await adminPage.fill("#tg-category-code", "12");
    check("an existing code needs no name", await adminPage.locator("#tg-category-name-field").isHidden());
    await adminPage.fill("#tg-link", "https://t.me/slowchan");
    await adminPage.fill("#tg-archive-name", "Browser Drops");
    await adminPage.fill("#tg-category-code", "88");
    await adminPage.fill("#tg-category-name", "Drops");
    await adminPage.click("#tg-job-button");
    await adminPage.waitForFunction(() => document.querySelector(".tgjob.is-active .tgjob__stats")?.textContent.includes("/s"), null, { timeout: 20000 });
    const liveStats = await adminPage.locator(".tgjob .tgjob__stats").textContent();
    check("the download card shows speed", /\/s/.test(liveStats), liveStats);
    check("the download card shows time left", /left/.test(liveStats), liveStats);
    check("the download card shows the video count", /of 4 videos/.test(liveStats), liveStats);
    check("the progress bar moves with a transform", /scaleX\(0\.\d+\)/.test(await adminPage.locator(".tgjob__fill").getAttribute("style")));
    await adminPage.waitForSelector(".tgjob.is-done", { timeout: 30000 });
    check("the card turns done when every video is saved", (await adminPage.locator(".tgjob .pill").textContent()) === "Done");
    await adminPage.click('.tab[data-tab="library"]');
    await adminPage.waitForFunction(() => document.getElementById("archive-list").textContent.includes("Browser Drops"), null, { timeout: 6000 });
    check("the new archive appears in the library", true);

    section("Owner expires the viewer mid-session");
    await adminPage.click('.tab[data-tab="keys"]');
    await adminPage.waitForTimeout(600);
    await adminCall("POST", `/api/admin/keys/${keyDoc.id}/expire`);

    await page.bringToFront();
    await page.waitForURL((url) => !url.pathname.startsWith("/watch"), { timeout: 40000 });
    check("expired viewer is thrown back to the gate", !page.url().includes("/watch"), `at ${page.url()}`);
    check("splash does not repeat on a later visit", await page.locator("#splash").isHidden());
    await page.waitForFunction(() => document.getElementById("seal-video")?.currentSrc, { timeout: 8000 });
    const laterSrc = await page.locator("#seal-video").evaluate((video) => new URL(video.currentSrc).pathname);
    check("later visits play the butterfly straight from the server", /^\/media\/seal\.(webm|mp4)$/.test(laterSrc), laterSrc);
    await page.waitForSelector("#gate-reason:not([hidden])", { timeout: 6000 });
    check("the gate explains why the viewer was signed out", (await page.locator("#gate-reason").textContent()).includes("session has ended"));
    check("the reason is removed from the address bar", !page.url().includes("reason="), page.url());

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
