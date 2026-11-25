import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yauzl from "yauzl";

const PORT = 4412;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = randomBytes(24).toString("hex");
const SESSION_SECRET = randomBytes(24).toString("hex");
const FAKE_DRIVER = path.resolve(import.meta.dirname, "fake-telegram.mjs");
const API = { apiId: "123456", apiHash: "0123456789abcdef0123456789abcdef" };

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function call(method, url, body, { auth = true } = {}) {
  const response = await fetch(BASE + url, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

const get = (url, options) => call("GET", url, undefined, options);
const post = (url, body, options) => call("POST", url, body ?? {}, options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fetchJob, predicate, timeoutMs = 40000) {
  const until = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < until) {
    last = await fetchJob();
    if (predicate(last)) return last;
    await sleep(150);
  }
  return last;
}

function startServer(env) {
  const server = spawn("node", ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => process.stdout.write(`  [server] ${chunk}`));
  server.stderr.on("data", (chunk) => process.stderr.write(`  [server:err] ${chunk}`));
  return server;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) return true;
    await sleep(250);
  }
  return false;
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await Promise.race([exited, sleep(8000)]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

function zipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = [];
      zip.on("entry", (entry) => {
        entries.push({ name: entry.fileName, size: entry.uncompressedSize, method: entry.compressionMethod });
        zip.readEntry();
      });
      zip.on("end", () => resolve(entries));
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

async function archiveVideos(archiveId) {
  const response = await get(`/api/admin/archives/${archiveId}/videos?sort=number&limit=50`);
  return response.json?.videos ?? [];
}

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gp-telegram-"));
  const env = {
    PORT: String(PORT),
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB: "getpleasure_telegram",
    ADMIN_TOKEN,
    SESSION_SECRET,
    STREAM_SECRET: randomBytes(24).toString("hex"),
    MEDIA_ROOT: mediaRoot,
    IP_MATCH_MODE: "relaxed",
    COOKIE_SECURE: "false",
    TELEGRAM_DRIVER_MODULE: FAKE_DRIVER,
  };
  const mongo = new MongoClient(replSet.getUri());
  await mongo.connect();
  const db = mongo.db("getpleasure_telegram");
  let server = startServer(env);

  try {
    if (!(await waitForHealth())) throw new Error("Server did not become healthy");

    section("Admin only");
    const anonymous = await get("/api/admin/telegram", { auth: false });
    check("telegram status is closed to anonymous callers", anonymous.status === 401, `got ${anonymous.status}`);
    const anonymousJob = await post("/api/admin/telegram/jobs", { link: "@archivechan" }, { auth: false });
    check("starting a download is closed to anonymous callers", anonymousJob.status === 401, `got ${anonymousJob.status}`);

    const initial = await get("/api/admin/telegram");
    check("no account is connected at first", initial.status === 200 && initial.json?.connected === false, initial.text);

    const tooEarly = await post("/api/admin/telegram/jobs", { link: "@archivechan", archiveName: "Early", categoryCode: "40", categoryName: "Telegram" });
    check("a download needs a connected account", tooEarly.status === 409 && tooEarly.json?.code === "telegram_not_logged_in", tooEarly.text);

    section("Logging in a Telegram account");
    const badId = await post("/api/admin/telegram/login", { ...API, apiId: "abc", phone: "+15550001" });
    check("API ID must be numeric", badId.status === 400 && badId.json?.field === "apiId", badId.text);
    const badHash = await post("/api/admin/telegram/login", { ...API, apiHash: "short", phone: "+15550001" });
    check("API hash must be 32 hex characters", badHash.status === 400 && badHash.json?.field === "apiHash", badHash.text);
    const badPhone = await post("/api/admin/telegram/login", { ...API, phone: "call me" });
    check("phone must be international format", badPhone.status === 400 && badPhone.json?.field === "phone", badPhone.text);
    const wrongApp = await post("/api/admin/telegram/login", { ...API, apiHash: "ffffffffffffffffffffffffffffffff", phone: "+15550001" });
    check("wrong API credentials are explained", wrongApp.status === 400 && wrongApp.json?.code === "telegram_api_id_invalid", wrongApp.text);

    const codeWithoutLogin = await post("/api/admin/telegram/login/code", { code: "12345" });
    check("a code without a started login is refused", codeWithoutLogin.status === 409, codeWithoutLogin.text);

    const started = await post("/api/admin/telegram/login", { ...API, phone: "+1 555 0002" });
    check("login sends a code", started.status === 200 && started.json?.step === "code", started.text);
    check("the phone is masked in the reply", started.json?.phone && !started.json.phone.includes("5550002"), started.json?.phone);
    const pendingStatus = await get("/api/admin/telegram");
    check("status shows the login waiting for a code", pendingStatus.json?.login?.step === "code", pendingStatus.text);

    const wrongCode = await post("/api/admin/telegram/login/code", { code: "99999" });
    check("a wrong code is rejected", wrongCode.status === 400 && wrongCode.json?.code === "telegram_phone_code_invalid", wrongCode.text);
    const rightCode = await post("/api/admin/telegram/login/code", { code: "1 2 3 4 5" });
    check("two-step accounts ask for the password", rightCode.status === 200 && rightCode.json?.step === "password", rightCode.text);
    check("the password hint is shown", rightCode.json?.hint === "the usual", rightCode.text);
    const wrongPassword = await post("/api/admin/telegram/login/password", { password: "nope" });
    check("a wrong password is rejected", wrongPassword.status === 400 && wrongPassword.json?.code === "telegram_password_hash_invalid", wrongPassword.text);
    const connected = await post("/api/admin/telegram/login/password", { password: "hunter2" });
    check("the right password connects the account", connected.status === 200 && connected.json?.connected === true, connected.text);
    check("the account name is shown", connected.json?.account?.name === "Second Account", connected.text);

    const statusAfter = await get("/api/admin/telegram");
    check("status shows the connected account", statusAfter.json?.connected === true && statusAfter.json?.login === null, statusAfter.text);
    check("status never returns the session", !/fake-session|hunter2|0123456789abcdef/.test(statusAfter.text), statusAfter.text);

    const stored = await db.collection("telegram_accounts").findOne({});
    check("the account is stored", Boolean(stored));
    check("the session is encrypted at rest", stored && !JSON.stringify(stored).includes("fake-session") && stored.sessionSealed.startsWith("v1."));
    check("the API hash is encrypted at rest", stored && !JSON.stringify(stored).includes(API.apiHash));
    check("the full phone number is not stored", stored && !JSON.stringify(stored).includes("5550002"));

    const secondLogin = await post("/api/admin/telegram/login", { ...API, phone: "+15550001" });
    check("a second login is refused while connected", secondLogin.status === 409, secondLogin.text);

    section("Download form validation");
    const cases = [
      [{ link: "https://example.com/chan", archiveName: "X Archive", categoryCode: "40", categoryName: "Telegram" }, 400, "only t.me links"],
      [{ link: "", archiveName: "X Archive", categoryCode: "40", categoryName: "Telegram" }, 400, "link required"],
      [{ link: "@archivechan", archiveName: "X", categoryCode: "40", categoryName: "Telegram" }, 400, "archive name too short"],
      [{ link: "@archivechan", archiveName: "X Archive", categoryCode: "forty", categoryName: "Telegram" }, 400, "category code must be numeric"],
      [{ link: "@archivechan", archiveName: "X Archive", categoryCode: "40" }, 400, "a new code needs a name"],
      [{ link: "@nobody_here", archiveName: "X Archive", categoryCode: "40", categoryName: "Telegram" }, 404, "unknown username"],
      [{ link: "https://t.me/+Expired0000", archiveName: "X Archive", categoryCode: "40", categoryName: "Telegram" }, 400, "expired invite"],
      [{ link: "@lockedchan", archiveName: "X Archive", categoryCode: "40", categoryName: "Telegram" }, 403, "chats that restrict saving are refused"],
    ];
    for (const [body, status, label] of cases) {
      const response = await post("/api/admin/telegram/jobs", body);
      check(`rejects: ${label}`, response.status === status, `got ${response.status} ${response.text}`);
    }
    const categoryCount = await db.collection("categories").countDocuments({ code: "40" });
    check("rejected downloads create no category", categoryCount === 0, `got ${categoryCount}`);
    const archiveCount = await db.collection("archives").countDocuments({});
    check("rejected downloads create no archive", archiveCount === 0, `got ${archiveCount}`);

    section("Downloading a public channel with a zip copy");
    const created = await post("/api/admin/telegram/jobs", {
      link: "https://t.me/archivechan",
      archiveName: "Archive Channel Picks",
      categoryCode: "40",
      categoryName: "Telegram Picks",
      keepZip: true,
    });
    check("download accepted", created.status === 202, created.text);
    check("the chat title is resolved before starting", created.json?.chatTitle === "Archive Channel", created.text);
    const jobId = created.json?.id;

    const duplicate = await post("/api/admin/telegram/jobs", { link: "@archivechan", archiveName: "Another Name", categoryCode: "40" });
    check("the same chat cannot download twice at once", duplicate.status === 409, duplicate.text);

    const finished = await waitFor(() => get(`/api/admin/telegram/jobs/${jobId}`).then((r) => r.json), (job) => ["done", "failed"].includes(job?.status));
    check("download finishes", finished?.status === "done", JSON.stringify(finished));
    check("all four videos downloaded", finished?.doneFiles === 4 && finished?.totalFiles === 4 && finished?.failedFiles === 0, JSON.stringify(finished));
    check("bytes add up", finished?.doneBytes === finished?.totalBytes && finished?.totalBytes > 0, JSON.stringify(finished));

    const category = await db.collection("categories").findOne({ code: "40" });
    check("the new category code was created with its name", category?.name === "Telegram Picks", JSON.stringify(category));
    const videos = await archiveVideos(finished?.archiveId);
    check("the archive holds four videos", videos.length === 4, `got ${videos.length}`);
    check("videos are numbered #1 to #4 in chat order", videos.map((video) => video.number).join(",") === "1,2,3,4", videos.map((video) => video.number).join(","));
    check(
      "titles come from file names, then captions",
      videos.map((video) => video.title).join(" | ") === "Opening Night | Harbour Lights | Video 19 | Long Walk",
      videos.map((video) => video.title).join(" | "),
    );

    const folder = path.join(mediaRoot, "telegram", "40-archive-channel-picks");
    const files = (await fs.readdir(folder)).sort();
    check("files are saved under MEDIA_ROOT/telegram", files.length === 4, files.join(", "));
    check("file names carry the number", files[0] === "0001 Opening Night.mp4" && files[3] === "0004 Long Walk.webm", files.join(", "));
    check("no partial files are left behind", !files.some((name) => name.endsWith(".part")));

    check("zip path reported", finished?.zipPath === "telegram/40-archive-channel-picks.zip", finished?.zipPath);
    const entries = await zipEntries(path.join(mediaRoot, "telegram", "40-archive-channel-picks.zip")).catch(() => []);
    check("zip holds every video", entries.length === 4, JSON.stringify(entries));
    check("zip stores videos without recompressing", entries.every((entry) => entry.method === 0));
    const sizes = await Promise.all(files.map((name) => fs.stat(path.join(folder, name)).then((stat) => stat.size)));
    check("zip entries match the files", entries.map((entry) => entry.size).join(",") === sizes.join(","));

    const taken = await post("/api/admin/telegram/jobs", { link: "@archivechan", archiveName: "Archive Channel Picks", categoryCode: "40" });
    check("an archive name already used in that category is refused", taken.status === 409, taken.text);

    section("Joining a private chat by invite link");
    const invite = await post("/api/admin/telegram/jobs", { link: "https://t.me/+FakeInvite123", archiveName: "Vault", categoryCode: "40" });
    check("invite download accepted into an existing code", invite.status === 202, invite.text);
    const inviteDone = await waitFor(() => get(`/api/admin/telegram/jobs/${invite.json?.id}`).then((r) => r.json), (job) => ["done", "failed"].includes(job?.status));
    check("invite download finishes", inviteDone?.status === "done" && inviteDone?.doneFiles === 3, JSON.stringify(inviteDone));
    check("no zip unless asked", inviteDone?.zipPath === null, String(inviteDone?.zipPath));

    section("Live progress, cancel and resume");
    const slow = await post("/api/admin/telegram/jobs", { link: "@slowchan", archiveName: "Slow Archive", categoryCode: "41", categoryName: "Slow" });
    check("slow download accepted", slow.status === 202, slow.text);
    const fetchSlow = () => get(`/api/admin/telegram/jobs/${slow.json?.id}`).then((r) => r.json);
    const moving = await waitFor(fetchSlow, (job) => job?.status === "downloading" && job?.speedBytesPerSecond > 0 && job?.doneBytes > 300000, 20000);
    check("status shows downloading", moving?.status === "downloading", JSON.stringify(moving));
    check("speed is reported", moving?.speedBytesPerSecond > 0, String(moving?.speedBytesPerSecond));
    check("time left is reported", Number.isFinite(moving?.etaSeconds) && moving.etaSeconds >= 0, String(moving?.etaSeconds));
    check("the files in flight are listed", moving?.current?.length > 0 && moving.current[0].receivedBytes > 0 && moving.current[0].sizeBytes > 0, JSON.stringify(moving?.current));
    check("several files download in parallel", moving?.current?.length >= 2, String(moving?.current?.length));
    await sleep(500);
    const later = await fetchSlow();
    check("progress keeps moving", later?.doneBytes > moving?.doneBytes, `${moving?.doneBytes} -> ${later?.doneBytes}`);
    const listed = await get("/api/admin/telegram/jobs");
    check("the downloads list includes live progress", listed.json?.jobs?.some((job) => job.id === slow.json?.id && job.doneBytes > 0), listed.text.slice(0, 200));

    const busyLogout = await post("/api/admin/telegram/logout");
    check("disconnecting is refused while a download runs", busyLogout.status === 409, busyLogout.text);

    const cancelled = await post(`/api/admin/telegram/jobs/${slow.json?.id}/cancel`);
    check("cancel stops the download", cancelled.status === 200 && cancelled.json?.status === "cancelled", cancelled.text);
    const partials = (await fs.readdir(path.join(mediaRoot, "telegram", "41-slow-archive"))).filter((name) => name.endsWith(".part"));
    check("partial files are kept so resume can continue", partials.length > 0, String(partials.length));
    const afterCancel = await fetchSlow();
    await sleep(800);
    const stillCancelled = await fetchSlow();
    check("nothing downloads after cancel", stillCancelled?.doneBytes === afterCancel?.doneBytes && stillCancelled?.status === "cancelled", `${afterCancel?.doneBytes} -> ${stillCancelled?.doneBytes}`);

    const resumed = await post(`/api/admin/telegram/jobs/${slow.json?.id}/resume`);
    check("resume queues the download again", resumed.status === 200 && ["queued", "connecting"].includes(resumed.json?.status), resumed.text);
    const resumedDone = await waitFor(fetchSlow, (job) => ["done", "failed"].includes(job?.status));
    check("resumed download finishes", resumedDone?.status === "done" && resumedDone?.doneFiles === 4, JSON.stringify(resumedDone));
    const slowVideos = await archiveVideos(resumedDone?.archiveId);
    check("resume keeps chat order numbering", slowVideos.map((video) => `${video.number}:${video.title}`).join(",") === "1:Slow One,2:Slow Two,3:Slow Three,4:Slow Four", slowVideos.map((video) => `${video.number}:${video.title}`).join(","));
    const slowSizes = await Promise.all(
      (await fs.readdir(path.join(mediaRoot, "telegram", "41-slow-archive"))).map((name) => fs.stat(path.join(mediaRoot, "telegram", "41-slow-archive", name)).then((stat) => stat.size)),
    );
    check("resumed files are complete", slowSizes.length === 4 && slowSizes.every((size) => size === 1536 * 1024), slowSizes.join(","));
    const doneAgain = await post(`/api/admin/telegram/jobs/${slow.json?.id}/resume`);
    check("a finished download cannot be resumed", doneAgain.status === 409, doneAgain.text);

    section("Server restart in the middle of a download");
    const restartJob = await post("/api/admin/telegram/jobs", { link: "@slowchan", archiveName: "Slow Again", categoryCode: "41" });
    check("second slow download accepted", restartJob.status === 202, restartJob.text);
    const fetchRestart = () => get(`/api/admin/telegram/jobs/${restartJob.json?.id}`).then((r) => r.json);
    await waitFor(fetchRestart, (job) => job?.status === "downloading" && job?.doneBytes > 600000, 20000);
    await stopServer(server);
    const parked = await db.collection("telegram_jobs").findOne({ archiveName: "Slow Again" });
    check("a graceful stop parks the download as queued", parked?.status === "queued", parked?.status);
    server = startServer(env);
    check("server restarts", await waitForHealth());
    const afterRestart = await waitFor(fetchRestart, (job) => ["done", "failed"].includes(job?.status));
    check("the download resumes by itself after a restart", afterRestart?.status === "done" && afterRestart?.doneFiles === 4, JSON.stringify(afterRestart));
    check("the saved Telegram login works after a restart", (await get("/api/admin/telegram")).json?.connected === true);

    section("Retries and files that keep failing");
    const flaky = await post("/api/admin/telegram/jobs", { link: "@flakychan", archiveName: "Flaky", categoryCode: "41" });
    check("flaky download accepted", flaky.status === 202, flaky.text);
    const flakyDone = await waitFor(() => get(`/api/admin/telegram/jobs/${flaky.json?.id}`).then((r) => r.json), (job) => ["done", "failed"].includes(job?.status), 60000);
    check("download finishes despite one broken file", flakyDone?.status === "done", JSON.stringify(flakyDone));
    check("a timeout and a flood wait are retried", flakyDone?.doneFiles === 2, JSON.stringify(flakyDone));
    check("the broken file is reported", flakyDone?.failedFiles === 1 && flakyDone?.failures?.[0]?.fileName === "0003 Flaky Broken.mp4", JSON.stringify(flakyDone?.failures));
    const flakyVideos = await archiveVideos(flakyDone?.archiveId);
    check("only finished files enter the archive", flakyVideos.length === 2, `got ${flakyVideos.length}`);

    section("Audit trail and disconnect");
    const audit = await get("/api/admin/audit");
    const auditText = audit.text;
    check("logins are audited", auditText.includes("telegram.login.ok"));
    check("downloads are audited", auditText.includes("telegram.download.start") && auditText.includes("telegram.download.cancel"));
    check("the audit log holds no password or full phone", !auditText.includes("hunter2") && !auditText.includes("5550002"));

    const logout = await post("/api/admin/telegram/logout");
    check("disconnect works when idle", logout.status === 200 && logout.json?.connected === false, logout.text);
    check("the stored session is deleted", (await db.collection("telegram_accounts").countDocuments({})) === 0);
    const afterLogout = await post("/api/admin/telegram/jobs", { link: "@archivechan", archiveName: "After", categoryCode: "40" });
    check("downloads need a login again", afterLogout.status === 409, afterLogout.text);
    const archivesKept = await archiveVideos(finished?.archiveId);
    check("downloaded archives stay after disconnecting", archivesKept.length === 4, `got ${archivesKept.length}`);
  } finally {
    await stopServer(server);
    await mongo.close();
    await replSet.stop();
    await fs.rm(mediaRoot, { recursive: true, force: true });
  }

  console.log("\n==============================================");
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);
  console.log("==============================================");
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
