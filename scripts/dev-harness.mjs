import { MongoMemoryReplSet } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.HARNESS_PORT ?? 4500);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = randomBytes(24).toString("hex");
const SAMPLES = ["/tmp/s1.mp4", "/tmp/s2.mp4"];

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gp-dev-"));
  const season = path.join(root, "library", "season-one");
  const bonus = path.join(root, "library", "bonus");
  await fs.mkdir(season, { recursive: true });
  await fs.mkdir(bonus, { recursive: true });

  const available = [];
  for (const sample of SAMPLES) {
    try {
      available.push(await fs.readFile(sample));
    } catch {
      /* sample missing */
    }
  }
  if (available.length === 0) throw new Error("No sample mp4 files found in /tmp");

  for (const [index, title] of TITLES.entries()) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const target = index < 9 ? season : bonus;
    await fs.writeFile(path.join(target, `${String(index + 1).padStart(2, "0")}-${slug}.mp4`), available[index % available.length]);
  }

  await fs.writeFile(path.join(season, "raw-master.mkv"), randomBytes(2048));
  return root;
}

async function waitFor(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class Admin {
  constructor() {
    this.cookie = null;
  }

  async call(method, url, body) {
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
      MONGODB_DB: "getpleasure_dev",
      ADMIN_TOKEN,
      SESSION_SECRET: randomBytes(24).toString("hex"),
      STREAM_SECRET: randomBytes(24).toString("hex"),
      MEDIA_ROOT: mediaRoot,
      IP_MATCH_MODE: "relaxed",
      TRUST_PROXY_HOPS: "0",
      COOKIE_SECURE: "false",
    },
    stdio: "inherit",
  });

  await waitFor(`${BASE}/health`);

  const admin = new Admin();
  await admin.call("POST", "/api/admin/categories", { code: 12, name: "Premium Collection" });
  await admin.call("POST", "/api/admin/categories", { code: 30, name: "Standard Pass" });

  const season = await admin.call("POST", "/api/admin/archives", {
    categoryCode: "12",
    name: "Season One",
    description: "The complete first run, remastered.",
  });
  const bonus = await admin.call("POST", "/api/admin/archives", {
    categoryCode: "12",
    name: "Bonus Features",
  });

  await admin.call("POST", `/api/admin/archives/${season.id}/import`, { relPath: "library/season-one" });
  await admin.call("POST", `/api/admin/archives/${bonus.id}/import`, { relPath: "library/bonus" });

  const key = await admin.call("POST", "/api/admin/keys", {
    validityDays: 30,
    categoryCode: 12,
    label: "Demo viewer",
  });

  const info = {
    baseUrl: BASE,
    adminToken: ADMIN_TOKEN,
    viewerKey: key.key,
    mediaRoot,
    seasonId: season.id,
  };

  await fs.writeFile(path.resolve(import.meta.dirname, "..", "harness.json"), JSON.stringify(info, null, 2));
  console.log(`\nHarness ready at ${BASE}`);
  console.log(`Viewer key: ${key.key}`);
  console.log(`Admin token: ${ADMIN_TOKEN}\n`);

  async function shutdown() {
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 800));
    server.kill("SIGKILL");
    await replSet.stop();
    await fs.rm(mediaRoot, { recursive: true, force: true });
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
