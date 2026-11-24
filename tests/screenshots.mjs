import { MongoMemoryReplSet } from "mongodb-memory-server";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = 4710;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = randomBytes(24).toString("hex");
const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const OUT = path.resolve(import.meta.dirname, "..", "screenshots");

const TITLES = [
  "Opening Night",
  "Coastline Drive",
  "Harbour Lights",
  "The Long Walk",
  "Midnight Kitchen",
  "Desert Signal",
  "Paper Moon",
  "Second Chances",
  "Glass Houses",
  "Winter Garden",
  "Last Train Out",
  "Quiet Hours",
];

async function buildMedia() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gp-shot-"));
  const season = path.join(root, "library", "season-one");
  const bonus = path.join(root, "library", "bonus-features");
  await fs.mkdir(season, { recursive: true });
  await fs.mkdir(bonus, { recursive: true });

  const webm = await fs.readFile(path.join(FIXTURES, "sample.webm"));
  for (const [index, title] of TITLES.entries()) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const target = index < 9 ? season : bonus;
    await fs.writeFile(path.join(target, `${String(index + 1).padStart(2, "0")}-${slug}.webm`), webm);
  }
  await fs.writeFile(path.join(season, "raw-master.mkv"), randomBytes(2048));
  return root;
}

async function adminCall(method, url, body) {
  const response = await fetch(BASE + url, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const mediaRoot = await buildMedia();
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });

  const server = spawn("node", ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: replSet.getUri(),
      MONGODB_DB: "getpleasure_shots",
      ADMIN_TOKEN,
      SESSION_SECRET: randomBytes(24).toString("hex"),
      STREAM_SECRET: randomBytes(24).toString("hex"),
      MEDIA_ROOT: mediaRoot,
      IP_MATCH_MODE: "relaxed",
      COOKIE_SECURE: "false",
    },
    stdio: "ignore",
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await adminCall("POST", "/api/admin/categories", { code: 12, name: "Premium Collection" });
  await adminCall("POST", "/api/admin/categories", { code: 30, name: "Standard Pass" });
  const season = await adminCall("POST", "/api/admin/archives", {
    categoryCode: "12",
    name: "Season One",
    description: "The complete first run, remastered from the source tapes.",
  });
  const bonus = await adminCall("POST", "/api/admin/archives", { categoryCode: "12", name: "Bonus Features" });
  await adminCall("POST", `/api/admin/archives/${season.id}/import`, { relPath: "library/season-one" });
  await adminCall("POST", `/api/admin/archives/${bonus.id}/import`, { relPath: "library/bonus-features" });
  const key = await adminCall("POST", "/api/admin/keys", { validityDays: 30, categoryCode: 12, label: "Demo viewer" });
  await adminCall("POST", "/api/admin/keys", { validityDays: 7, categoryCode: 30, label: "Trial buyer" });

  const videos = await adminCall("GET", `/api/admin/archives/${season.id}/videos?limit=20`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 414, height: 896 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  async function shot(name) {
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`saved ${name}.png`);
  }

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(OUT, "00-splash.png") });
  console.log("saved 00-splash.png");
  await page.waitForSelector("#splash", { state: "hidden", timeout: 15000 });
  await page.waitForFunction(() => document.getElementById("seal-video")?.currentTime > 0.5, { timeout: 10000 });
  await shot("01-gate");

  await page.fill("#key-input", "GP-wrong-key-for-the-screenshot");
  await page.click("#gate-submit");
  await page.waitForSelector("#gate-error:not([hidden])");
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(OUT, "01b-gate-wrong-key.png") });
  console.log("saved 01b-gate-wrong-key.png");
  await page.waitForFunction(() => document.getElementById("mascot").dataset.mood === "idle", { timeout: 6000 });

  await page.fill("#key-input", key.key);
  await page.click("#gate-submit");
  await page.waitForSelector("#gate-seal.is-unlocked", { timeout: 6000 });
  await page.waitForTimeout(420);
  await page.screenshot({ path: path.join(OUT, "01c-gate-unlocking.png") });
  console.log("saved 01c-gate-unlocking.png");
  await page.waitForSelector("#iris.is-open", { timeout: 4000 });
  await page.waitForTimeout(520);
  await page.screenshot({ path: path.join(OUT, "01d-gate-iris.png") });
  console.log("saved 01d-gate-iris.png");
  await page.waitForURL("**/watch");
  await page.waitForSelector(".acard");
  await shot("02-home");

  await page.click(".acard__cta");
  await page.waitForSelector("#video-grid .vcard");
  await shot("03-archive");

  await page.click("#video-grid .vcard >> nth=0");
  await page.waitForSelector("#view-player:not([hidden])");
  await page.waitForFunction(() => document.getElementById("player-video")?.readyState >= 2, { timeout: 20000 });
  await page.locator("#player-video").evaluate(async (video) => {
    video.currentTime = video.duration * 0.55;
    await video.play().catch(() => {});
  });
  await page.waitForTimeout(600);
  await page.locator("#player-video").evaluate((video) => video.pause());
  await page.click("#like-button");
  await shot("04-player");

  await adminCall("POST", "/api/admin/broadcasts", {
    title: "New archive added",
    message: "Bonus Features is live for every Premium member. 3 new videos, no extra charge.",
  });
  await page.goto(`${BASE}/watch`, { waitUntil: "networkidle" });
  await page.waitForSelector("#broadcast-modal:not([hidden])", { timeout: 30000 });
  await shot("05-broadcast");
  await page.click("#broadcast-ack");

  await page.waitForSelector("#resume-section:not([hidden])", { timeout: 15000 });
  await shot("06-home-resume");

  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await shot("06b-admin-login");
  await page.fill("#admin-token", ADMIN_TOKEN);
  await page.click('#login-form button[type="submit"]');
  await page.waitForSelector("#console-view:not([hidden])");
  await page.waitForSelector(".stat");
  await shot("07-admin-dashboard");

  await page.click('.tab[data-tab="library"]');
  await page.waitForSelector(".fsrow");
  await page.click(".fsrow >> nth=0");
  await page.waitForTimeout(800);
  await shot("08-admin-library");

  await page.click('.tab[data-tab="keys"]');
  await page.waitForSelector("#key-list .row");
  await shot("09-admin-keys");

  await page.click('.tab[data-tab="broadcast"]');
  await page.waitForTimeout(500);
  await shot("10-admin-broadcast");

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await desktopPage.waitForSelector("#splash", { state: "hidden", timeout: 15000 });
  await desktopPage.screenshot({ path: path.join(OUT, "11a-desktop-gate.png") });
  await desktopPage.fill("#key-input", key.key);
  await desktopPage.click("#gate-submit");
  await desktopPage.waitForURL("**/watch");
  await desktopPage.waitForSelector(".acard");
  await desktopPage.waitForTimeout(1200);
  await desktopPage.screenshot({ path: path.join(OUT, "11-desktop-home.png") });
  await desktopPage.click(".acard__cta");
  await desktopPage.waitForSelector("#video-grid .vcard");
  await desktopPage.waitForTimeout(1200);
  await desktopPage.screenshot({ path: path.join(OUT, "12-desktop-archive.png") });
  console.log("saved desktop shots");

  void videos;
  await desktop.close();
  await context.close();
  await browser.close();
  server.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  server.kill("SIGKILL");
  await replSet.stop();
  await fs.rm(mediaRoot, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
