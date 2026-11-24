import { MongoMemoryReplSet } from "mongodb-memory-server";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = 4931;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = randomBytes(24).toString("hex");
const CPU_SLOWDOWN = Number(process.env.CPU_SLOWDOWN ?? 4);
const RUNS = Number(process.env.RUNS ?? 3);
const BUDGET_MS = 1000 / 60;

async function adminCall(method, url, body) {
  const response = await fetch(BASE + url, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}`);
  return response.json();
}

function summarise(intervals) {
  const sorted = [...intervals].sort((a, b) => a - b);
  const total = intervals.reduce((sum, value) => sum + value, 0);
  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  const expected = Math.round(total / BUDGET_MS);
  return {
    frames: intervals.length,
    fps: Math.round((intervals.length / total) * 1000),
    p50: Number(pick(0.5).toFixed(1)),
    p95: Number(pick(0.95).toFixed(1)),
    worst: Number(sorted.at(-1).toFixed(1)),
    janky: intervals.filter((value) => value > 34).length,
    dropped: Math.max(0, expected - intervals.length),
  };
}

async function main() {
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gp-perf-"));
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const server = spawn("node", ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: replSet.getUri(),
      MONGODB_DB: "getpleasure_perf",
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
    if (await fetch(`${BASE}/health`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await adminCall("POST", "/api/admin/categories", { code: 12, name: "Premium" });
  const browser = await chromium.launch();
  const results = [];

  try {
    for (let run = 0; run < RUNS; run++) {
      const key = await adminCall("POST", "/api/admin/keys", { validityDays: 30, categoryCode: 12 });
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      });
      await context.addInitScript(() => localStorage.setItem("gp_splash_v1", "1"));
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.getElementById("seal-video")?.currentTime > 0.3, { timeout: 15000 });
      await page.fill("#key-input", key.key);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

      await browser.startTracing(page, {
        categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "cc",
          "benchmark",
        ],
      });

      const intervals = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const samples = [];
            let last = 0;
            let recording = false;
            const seal = document.getElementById("gate-seal");
            const observer = new MutationObserver(() => {
              if (seal.classList.contains("is-unlocking") && !recording) {
                recording = true;
                last = performance.now();
                requestAnimationFrame(tick);
                setTimeout(() => resolve(samples), 3100);
              }
            });
            observer.observe(seal, { attributes: true, attributeFilter: ["class"] });
            function tick(now) {
              samples.push(now - last);
              last = now;
              if (samples.length < 400) requestAnimationFrame(tick);
            }
            document.getElementById("gate-form").requestSubmit();
          }),
      );

      const trace = JSON.parse((await browser.stopTracing()).toString("utf8"));
      const events = trace.traceEvents ?? trace;
      const sumMs = (names) =>
        Math.round(events.filter((event) => names.includes(event.name) && event.dur).reduce((sum, event) => sum + event.dur, 0) / 1000);
      const frames = events.filter((event) => event.name === "PipelineReporter" && event.ph === "b");
      const states = frames.map((event) => event.args?.chrome_frame_reporter?.state).filter(Boolean);
      const presented = states.filter((state) => state === "STATE_PRESENTED_ALL").length;
      const dropped = states.filter((state) => state === "STATE_DROPPED" || state === "STATE_PRESENTED_PARTIAL").length;

      results.push({
        ...summarise(intervals.slice(1)),
        compositorFrames: states.length,
        compositorDropped: dropped,
        dropRate: states.length ? Math.round((dropped / states.length) * 100) : 0,
        paintMs: sumMs(["Paint", "PaintImage", "Rasterize", "RasterTask", "ImageDecodeTask"]),
        styleLayoutMs: sumMs(["UpdateLayoutTree", "Layout", "RecalculateStyles", "PrePaint"]),
        presented,
      });
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 800));
    server.kill("SIGKILL");
    await replSet.stop();
    await fs.rm(mediaRoot, { recursive: true, force: true });
  }

  const average = (field) => Math.round((results.reduce((sum, item) => sum + item[field], 0) / results.length) * 10) / 10;
  console.log(`Unlock animation, 390x844 @3x, CPU slowed ${CPU_SLOWDOWN}x, ${RUNS} runs`);
  for (const [index, item] of results.entries()) console.log(`  run ${index + 1}`, JSON.stringify(item));
  console.log(
    `  average  fps ${average("fps")}  p95 ${average("p95")} ms  worst ${average("worst")} ms  janky ${average("janky")}`,
  );
  console.log(
    `  compositor  dropped ${average("compositorDropped")} of ${average("compositorFrames")} frames (${average("dropRate")}%)  paint+raster ${average("paintMs")} ms  style+layout ${average("styleLayoutMs")} ms`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
