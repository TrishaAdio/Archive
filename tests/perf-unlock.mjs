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
const SCENARIO = process.env.SCENARIO ?? "unlock";

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

async function recordFrames(page, durationMs) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        const tick = (now) => {
          samples.push(now - last);
          last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve(samples), duration);
      }),
    durationMs,
  );
}

async function dragFinger(cdp) {
  const points = 60;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: 700 }] });
  for (let step = 1; step <= points; step++) {
    const y = 700 - step * 8;
    const x = 200 + Math.sin(step / 6) * 90;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await new Promise((resolve) => setTimeout(resolve, 45));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const SCENARIO_LABELS = {
  unlock: "Unlock animation",
  touch: "Finger drag and scroll on the gate",
  open: "Opening a video from the archive",
  back: "Going back from a video to the archive",
};

async function seedArchive(mediaRoot) {
  const folder = path.join(mediaRoot, "perf");
  await fs.mkdir(folder, { recursive: true });
  const sample = await fs.readFile(path.resolve(import.meta.dirname, "fixtures", "sample.webm"));
  for (let index = 1; index <= 9; index++) await fs.writeFile(path.join(folder, `clip-${index}.webm`), sample);
  const archive = await adminCall("POST", "/api/admin/archives", { categoryCode: 12, name: "Perf Archive" });
  await adminCall("POST", `/api/admin/archives/${archive.id}/import`, { relPath: "perf" });
}

async function unlockInto(page, key) {
  await page.fill("#key-input", key);
  await page.locator("#gate-form").evaluate((form) => form.requestSubmit());
  await page.waitForURL(/\/watch/, { timeout: 20000 });
  await page.locator("#archive-grid [data-archive]").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator("#archive-grid [data-archive]").first().click();
  await page.locator("#video-grid [data-video]").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  if (SCENARIO === "back") {
    await page.locator("#video-grid [data-video]").first().click();
    await page.waitForTimeout(1500);
    await page.locator("#pc-play").click();
    await page.waitForFunction(() => document.getElementById("player-video")?.currentTime > 0.4, { timeout: 20000 });
    await page.waitForTimeout(600);
  }
}

function recordTransition(page, durationMs) {
  return page.evaluate(
    ({ duration, scenario }) =>
      new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        let firstMoveAt = null;
        const startedAt = last;
        let seenTransition = false;
        const tick = (now) => {
          const moving = document.documentElement.classList.contains("is-transitioning");
          if (moving || !seenTransition) samples.push(now - last);
          if (moving) seenTransition = true;
          last = now;
          if (firstMoveAt === null && document.documentElement.classList.contains("is-morphing")) firstMoveAt = now - startedAt;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve({ samples, firstMoveAt }), duration);
        if (scenario === "open") document.querySelector("#video-grid [data-video]").click();
        else document.getElementById("nav-back").click();
      }),
    { duration: durationMs, scenario: SCENARIO },
  );
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
  const transition = SCENARIO === "open" || SCENARIO === "back";
  if (transition) await seedArchive(mediaRoot);
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
      if (process.env.NO_SILK) await context.addInitScript(() => (HTMLCanvasElement.prototype.getContext = () => null));
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.getElementById("seal-video")?.currentTime > 0.3, { timeout: 15000 });
      if (transition) await unlockInto(page, key.key);
      else await page.fill("#key-input", key.key);
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

      const dragging = SCENARIO === "touch" ? dragFinger(cdp) : null;
      let firstMoveAt = null;
      const recordTransitionFrames = async () => {
        const recorded = await recordTransition(page, 1800);
        firstMoveAt = recorded.firstMoveAt;
        return recorded.samples;
      };
      const intervals = transition ? await recordTransitionFrames() : SCENARIO === "touch" ? await recordFrames(page, 3100) : await page.evaluate(
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

      if (process.env.SHOW_FRAMES) console.log("frames", intervals.map((v) => Math.round(v)).join(" "));
      await dragging;
      const trace = JSON.parse((await browser.stopTracing()).toString("utf8"));
      const events = trace.traceEvents ?? trace;
      const sumMs = (names) =>
        Math.round(events.filter((event) => names.includes(event.name) && event.dur).reduce((sum, event) => sum + event.dur, 0) / 1000);
      if (process.env.PAINT_DETAIL) {
        const totals = {};
        for (const event of events) {
          if (!event.dur || !["Paint", "PaintImage", "Rasterize", "RasterTask", "ImageDecodeTask", "GPUTask", "UpdateLayer"].includes(event.name)) continue;
          const key = `${event.name}:${event.args?.data?.nodeName ?? event.args?.data?.layerId ?? ""}`;
          totals[key] = (totals[key] ?? 0) + event.dur / 1000;
        }
        console.log(Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${Math.round(v)}ms`).join("\n"));
      }
      if (process.env.TOP_EVENTS) {
        const totals = {};
        for (const event of events) {
          if (!event.dur || event.ph !== "X") continue;
          const detail = event.args?.data?.url?.split("/").pop() || event.args?.data?.functionName || event.args?.data?.type || "";
          const key = `${event.name}:${detail}`.slice(0, 90);
          totals[key] = (totals[key] ?? 0) + event.dur / 1000;
        }
        console.log(Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${k} ${Math.round(v)}ms`).join("\n"));
        const mainTasks = events.filter((event) => event.name === "RunTask" && event.dur > Number(process.env.TASK_US ?? 30000));
        for (const task of mainTasks.slice(0, 14)) {
          const inside = events.filter(
            (event) => event.tid === task.tid && event.ts >= task.ts && event.ts + (event.dur ?? 0) <= task.ts + task.dur && event.dur > 4000 && event !== task,
          );
          const label = inside
            .slice(0, Number(process.env.TASK_PARTS ?? 8))
            .map((event) => `${event.name}${event.args?.data?.functionName ? `(${event.args.data.functionName})` : ""}${event.args?.elementCount ? `[${event.args.elementCount}]` : ""}${event.args?.data?.url ? `<${event.args.data.url.split("/").pop()}>` : ""} ${Math.round(event.dur / 1000)}`)
            .join(" | ");
          console.log(`task ${Math.round(task.dur / 1000)}ms: ${label}`);
        }
      }
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
        ...(transition ? { firstMoveMs: Math.round(firstMoveAt ?? -1) } : {}),
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
  console.log(`${SCENARIO_LABELS[SCENARIO] ?? SCENARIO}, 390x844 @3x, CPU slowed ${CPU_SLOWDOWN}x, ${RUNS} runs`);
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
