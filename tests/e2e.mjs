import { MongoMemoryReplSet } from "mongodb-memory-server";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PORT = 4311;
const BASE = `http://127.0.0.1:${PORT}`;
const VIEWER_IP = "203.0.113.45";
const OTHER_IP = "198.51.100.9";

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

class Client {
  constructor(ip) {
    this.ip = ip;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(method, url, { body, headers = {}, raw } = {}) {
    const response = await fetch(BASE + url, {
      method,
      redirect: "manual",
      headers: {
        "x-forwarded-for": this.ip,
        ...(body !== undefined || raw ? { "content-type": "application/json" } : {}),
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...headers,
      },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });

    for (const value of response.headers.getSetCookie?.() ?? []) {
      const [pair] = value.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const content = pair.slice(index + 1).trim();
      if (content === "" || /expires=thu, 01 jan 1970/i.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, content);
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { status: response.status, headers: response.headers, json, text };
  }

  get = (url, options) => this.request("GET", url, options);
  post = (url, body, options) => this.request("POST", url, { body, ...options });
  del = (url) => this.request("DELETE", url);
}

async function buildMediaRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gp-media-"));
  const library = path.join(root, "library", "season-one");
  await fs.mkdir(library, { recursive: true });

  for (let index = 1; index <= 5; index++) {
    await fs.writeFile(path.join(library, `episode-${index}.mp4`), randomBytes(4096 + index));
  }
  await fs.writeFile(path.join(library, "episode-1.jpg"), randomBytes(256));
  await fs.writeFile(path.join(library, "notes.txt"), "ignored");
  await fs.writeFile(path.join(library, "raw-footage.mkv"), randomBytes(1024));

  const secretOutside = path.join(root, "..", `gp-secret-${Date.now()}.txt`);
  await fs.writeFile(secretOutside, "top secret");

  const zipSource = path.join(root, "zipsrc");
  await fs.mkdir(zipSource, { recursive: true });
  for (let index = 1; index <= 3; index++) {
    await fs.writeFile(path.join(zipSource, `bonus-${index}.mp4`), randomBytes(2048));
  }

  const zipPath = path.join(root, "bonus-pack.zip");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  let zipCreated = false;
  try {
    await execFileAsync("python3", [
      "-c",
      `import zipfile,os,sys
src=sys.argv[1]; out=sys.argv[2]
z=zipfile.ZipFile(out,'w')
for n in sorted(os.listdir(src)): z.write(os.path.join(src,n), n)
z.writestr('../escape.mp4', b'zip slip attempt')
z.close()`,
      zipSource,
      zipPath,
    ]);
    zipCreated = true;
  } catch (error) {
    console.log(`  (zip fixture skipped: ${error.message.split("\n")[0]})`);
  }

  return { root, zipCreated, secretOutside };
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const media = await buildMediaRoot();
  const adminToken = randomBytes(24).toString("hex");

  const server = spawn("node", ["src/server.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      MONGODB_URI: replSet.getUri(),
      MONGODB_DB: "getpleasure_test",
      ADMIN_TOKEN: adminToken,
      SESSION_SECRET: randomBytes(24).toString("hex"),
      STREAM_SECRET: randomBytes(24).toString("hex"),
      MEDIA_ROOT: media.root,
      IP_MATCH_MODE: "strict",
      TRUST_PROXY_HOPS: "1",
      COOKIE_SECURE: "false",
      PRESENCE_WINDOW_SECONDS: "60",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => process.stdout.write(`  [server] ${chunk}`));
  server.stderr.on("data", (chunk) => process.stderr.write(`  [server:err] ${chunk}`));

  try {
    if (!(await waitForServer())) throw new Error("Server did not become healthy");

    const admin = new Client("198.51.100.200");
    const viewer = new Client(VIEWER_IP);
    const thief = new Client(OTHER_IP);

    section("Admin authentication");
    const badLogin = await admin.post("/api/admin/login", { token: "wrong-token" });
    check("wrong admin token rejected", badLogin.status === 401, `got ${badLogin.status}`);

    const noAuthOverview = await admin.get("/api/admin/overview");
    check("admin API requires auth", noAuthOverview.status === 401, `got ${noAuthOverview.status}`);

    const login = await admin.post("/api/admin/login", { token: adminToken });
    check("correct admin token accepted", login.status === 200, `got ${login.status}`);
    check("admin cookie issued", admin.cookies.has("gp_admin"));

    section("VPS directory browsing");
    const rootListing = await admin.get("/api/admin/files?path=");
    check("media root listing works", rootListing.status === 200, `got ${rootListing.status}`);
    check(
      "listing shows library directory",
      rootListing.json?.entries?.some((entry) => entry.name === "library" && entry.type === "directory"),
    );
    check(
      "hidden dotfiles excluded",
      !(rootListing.json?.entries ?? []).some((entry) => entry.name.startsWith(".")),
    );

    const deepListing = await admin.get("/api/admin/files?path=library/season-one");
    check("subdirectory listing works", deepListing.status === 200);
    check(
      "mp4 marked playable",
      deepListing.json?.entries?.find((e) => e.name === "episode-1.mp4")?.playable === true,
    );
    check(
      "mkv marked not playable",
      deepListing.json?.entries?.find((e) => e.name === "raw-footage.mkv")?.playable === false,
    );

    const traversal = await admin.get(`/api/admin/files?path=${encodeURIComponent("../")}`);
    check("path traversal with ../ blocked", traversal.status === 403 || traversal.status === 404, `got ${traversal.status}`);

    const absoluteEscape = await admin.get(`/api/admin/files?path=${encodeURIComponent("/etc")}`);
    check("absolute path escape blocked", absoluteEscape.status === 403 || absoluteEscape.status === 404, `got ${absoluteEscape.status}`);

    const nullByte = await admin.get(`/api/admin/files?path=${encodeURIComponent("library\0/etc")}`);
    check("null byte in path rejected", nullByte.status === 400, `got ${nullByte.status}`);

    section("Categories and archives");
    const category = await admin.post("/api/admin/categories", { code: 12, name: "Premium Collection" });
    check("category created", category.status === 201, `got ${category.status} ${category.text}`);
    check("category code stored as string", category.json?.code === "12");

    const duplicateCategory = await admin.post("/api/admin/categories", { code: "12", name: "Dupe" });
    check("duplicate category code rejected", duplicateCategory.status === 409, `got ${duplicateCategory.status}`);

    const archive = await admin.post("/api/admin/archives", { categoryCode: "12", name: "Season One" });
    check("archive created", archive.status === 201, `got ${archive.status} ${archive.text}`);
    const archiveId = archive.json?.id;

    const orphanArchive = await admin.post("/api/admin/archives", { categoryCode: "999", name: "Orphan" });
    check("archive under unknown category rejected", orphanArchive.status === 400, `got ${orphanArchive.status}`);

    section("Importing videos from the VPS");
    const importResult = await admin.post(`/api/admin/archives/${archiveId}/import`, {
      relPath: "library/season-one",
    });
    check("import succeeded", importResult.status === 200, `got ${importResult.status} ${importResult.text}`);
    check("6 video files discovered", importResult.json?.discovered === 6, `got ${importResult.json?.discovered}`);
    check("6 videos added", importResult.json?.added === 6, `got ${importResult.json?.added}`);
    check("non-playable file counted", importResult.json?.notPlayable === 1, `got ${importResult.json?.notPlayable}`);

    const reImport = await admin.post(`/api/admin/archives/${archiveId}/import`, { relPath: "library/season-one" });
    check("re-import adds nothing (no duplicates)", reImport.json?.added === 0, `got ${reImport.json?.added}`);
    check("re-import reports skipped", reImport.json?.skipped === 6, `got ${reImport.json?.skipped}`);

    const adminVideos = await admin.get(`/api/admin/archives/${archiveId}/videos?sort=number&limit=200`);
    const numbers = (adminVideos.json?.videos ?? []).map((video) => video.number);
    check("video numbers are 1..6 with no gaps", JSON.stringify(numbers) === JSON.stringify([1, 2, 3, 4, 5, 6]), `got ${numbers}`);
    check("display id formatted as #1", adminVideos.json?.videos?.[0]?.displayId === "#1");
    check(
      "sibling jpg detected as thumbnail",
      adminVideos.json?.videos?.some((video) => video.hasThumbnail === true),
    );

    if (media.zipCreated) {
      const zipArchive = await admin.post("/api/admin/archives", { categoryCode: "12", name: "Bonus Pack" });
      const zipImport = await admin.post(`/api/admin/archives/${zipArchive.json.id}/import`, {
        relPath: "bonus-pack.zip",
      });
      check("zip import succeeded", zipImport.status === 200, `got ${zipImport.status} ${zipImport.text}`);
      check("3 videos imported from zip", zipImport.json?.added === 3, `got ${zipImport.json?.added}`);
      check("zip-slip entry skipped", (zipImport.json?.extraction?.skipped ?? 0) >= 1, `got ${zipImport.json?.extraction?.skipped}`);

      const escaped = await fs
        .stat(path.join(path.dirname(media.root), "escape.mp4"))
        .then(() => true)
        .catch(() => false);
      check("zip-slip did not write outside media root", escaped === false);
    }

    section("Access key creation");
    const keyResponse = await admin.post("/api/admin/keys", { validityDays: 30, categoryCode: 12, label: "Test buyer" });
    check("key created", keyResponse.status === 201, `got ${keyResponse.status} ${keyResponse.text}`);
    check("plaintext key returned once", typeof keyResponse.json?.key === "string" && keyResponse.json.key.startsWith("GP-"));
    check("plan start recorded", Boolean(keyResponse.json?.planStartsAt));
    check("plan expiry recorded", Boolean(keyResponse.json?.planExpiresAt));

    const expiryGapDays = Math.round(
      (new Date(keyResponse.json.planExpiresAt) - new Date(keyResponse.json.planStartsAt)) / 86400000,
    );
    check("expiry is exactly 30 days after start", expiryGapDays === 30, `got ${expiryGapDays}`);
    check("key not yet bound to an IP", keyResponse.json?.boundIp === null);

    const plainKey = keyResponse.json.key;
    const keyId = keyResponse.json.id;

    const badKey = await admin.post("/api/admin/keys", { validityDays: 0, categoryCode: "abc" });
    check("invalid key input rejected", badKey.status === 400, `got ${badKey.status}`);
    check("validation lists both bad fields", (badKey.json?.details ?? []).length === 2, `got ${JSON.stringify(badKey.json?.details)}`);

    section("Gate entry and IP locking");
    const unauthenticatedHome = await viewer.get("/api/home");
    check("home blocked without a key", unauthenticatedHome.status === 401, `got ${unauthenticatedHome.status}`);

    const wrongKey = await viewer.post("/api/gate/redeem", { key: "GP-not-a-real-key" });
    check("unknown key rejected at gate", wrongKey.status === 403, `got ${wrongKey.status}`);
    check("unknown key error code", wrongKey.json?.code === "invalid_key", `got ${wrongKey.json?.code}`);

    const redeem = await viewer.post("/api/gate/redeem", { key: plainKey });
    check("valid key accepted", redeem.status === 200, `got ${redeem.status} ${redeem.text}`);
    check("session cookie issued", viewer.cookies.has("gp_session"));
    check("key bound on first use", redeem.json?.boundNow === true);
    check("category name returned to viewer", redeem.json?.viewer?.categoryName === "Premium Collection");
    check("locked ip reported", redeem.json?.viewer?.lockedIp === VIEWER_IP, `got ${redeem.json?.viewer?.lockedIp}`);

    const thiefRedeem = await thief.post("/api/gate/redeem", { key: plainKey });
    check("same key from another IP is blocked", thiefRedeem.status === 403, `got ${thiefRedeem.status}`);
    check("block reason is ip_mismatch", thiefRedeem.json?.code === "ip_mismatch", `got ${thiefRedeem.json?.code}`);
    check("no session cookie for blocked IP", !thief.cookies.has("gp_session"));

    const sameIpAgain = await new Client(VIEWER_IP).post("/api/gate/redeem", { key: plainKey });
    check("re-entry from the bound IP still works", sameIpAgain.status === 200, `got ${sameIpAgain.status}`);
    check("second redeem does not rebind", sameIpAgain.json?.boundNow === false);

    section("Stolen cookie replayed from another IP");
    const cookieThief = new Client(OTHER_IP);
    cookieThief.cookies.set("gp_session", viewer.cookies.get("gp_session"));
    const replay = await cookieThief.get("/api/home");
    check("stolen session cookie rejected from new IP", replay.status === 403, `got ${replay.status}`);
    check("replay reason is ip_mismatch", replay.json?.code === "ip_mismatch", `got ${replay.json?.code}`);

    const viewerStillOk = await viewer.get("/api/gate/me");
    check("original viewer session survived the replay attempt", viewerStillOk.status === 200, `got ${viewerStillOk.status}`);

    section("Home page and catalog");
    const home = await viewer.get("/api/home");
    check("home loads", home.status === 200, `got ${home.status}`);
    check("home shows category name for the key's code", home.json?.category?.name === "Premium Collection");
    check("home lists archives in that category", (home.json?.archives ?? []).length >= 1);
    check("continue watching starts empty", (home.json?.continueWatching ?? []).length === 0);

    const videoList = await viewer.get(`/api/archives/${archiveId}/videos?sort=popular&limit=60`);
    check("video listing loads", videoList.status === 200, `got ${videoList.status}`);
    check("all 6 videos returned", videoList.json?.videos?.length === 6, `got ${videoList.json?.videos?.length}`);
    check("total reported", videoList.json?.total === 6);

    if (!videoList.json?.videos?.length) throw new Error(`Video listing failed: ${videoList.status} ${videoList.text}`);
    const playable = videoList.json.videos.find((video) => video.playable);
    const notPlayable = videoList.json.videos.find((video) => !video.playable);
    check("a playable video exists", Boolean(playable));
    check("non-playable video flagged for the UI", Boolean(notPlayable));

    section("Protected streaming");
    const noToken = await viewer.get(`/api/stream/${playable.id}`);
    check("stream without token rejected", noToken.status === 403, `got ${noToken.status}`);

    const forgedToken = await viewer.get(`/api/stream/${playable.id}?t=9999999999.forgedsignature`);
    check("stream with forged token rejected", forgedToken.status === 403, `got ${forgedToken.status}`);

    const tokenResponse = await viewer.post(`/api/videos/${playable.id}/stream-token`);
    check("stream token issued", tokenResponse.status === 200, `got ${tokenResponse.status} ${tokenResponse.text}`);
    check("token url points at the stream endpoint", String(tokenResponse.json?.url).startsWith(`/api/stream/${playable.id}?t=`));
    check("watermark value returned", typeof tokenResponse.json?.watermark === "string");

    const streamUrl = tokenResponse.json.url;
    const fullStream = await viewer.get(streamUrl);
    check("full stream returns 200", fullStream.status === 200, `got ${fullStream.status}`);
    check("accept-ranges advertised", fullStream.headers.get("accept-ranges") === "bytes");
    check("stream marked no-store", String(fullStream.headers.get("cache-control")).includes("no-store"));
    check("content-disposition is inline", fullStream.headers.get("content-disposition") === "inline");
    check("content type is video/mp4", fullStream.headers.get("content-type") === "video/mp4");

    const partial = await viewer.get(streamUrl, { headers: { range: "bytes=100-199" } });
    check("range request returns 206", partial.status === 206, `got ${partial.status}`);
    check("content-length is 100 bytes", partial.headers.get("content-length") === "100", `got ${partial.headers.get("content-length")}`);
    check("content-range header correct", /^bytes 100-199\/\d+$/.test(partial.headers.get("content-range") ?? ""), `got ${partial.headers.get("content-range")}`);

    const suffixRange = await viewer.get(streamUrl, { headers: { range: "bytes=-50" } });
    check("suffix range returns 206", suffixRange.status === 206, `got ${suffixRange.status}`);
    check("suffix range length is 50", suffixRange.headers.get("content-length") === "50");

    const badRange = await viewer.get(streamUrl, { headers: { range: "bytes=99999999-" } });
    check("unsatisfiable range returns 416", badRange.status === 416, `got ${badRange.status}`);

    const thiefStream = new Client(OTHER_IP);
    thiefStream.cookies.set("gp_session", viewer.cookies.get("gp_session"));
    const thiefStreamResult = await thiefStream.get(streamUrl);
    check("leaked stream url fails from a different IP", thiefStreamResult.status === 403, `got ${thiefStreamResult.status}`);

    const noCookieStream = await fetch(BASE + streamUrl, { headers: { "x-forwarded-for": VIEWER_IP } });
    check("leaked stream url fails without the session cookie", noCookieStream.status === 401, `got ${noCookieStream.status}`);

    const notPlayableToken = await viewer.post(`/api/videos/${notPlayable.id}/stream-token`);
    check("non-playable file gives a clear error", notPlayableToken.status === 403, `got ${notPlayableToken.status}`);
    check("non-playable error code", notPlayableToken.json?.code === "not_playable", `got ${notPlayableToken.json?.code}`);

    section("Thumbnails");
    const withThumb = videoList.json.videos.find((video) => video.hasThumbnail);
    const thumbResponse = await viewer.get(`/api/thumb/${withThumb.id}`);
    check("real thumbnail served", thumbResponse.status === 200, `got ${thumbResponse.status}`);
    check("thumbnail content type is an image", String(thumbResponse.headers.get("content-type")).startsWith("image/"));

    const withoutThumb = videoList.json.videos.find((video) => !video.hasThumbnail);
    const placeholder = await viewer.get(`/api/thumb/${withoutThumb.id}`);
    check("placeholder thumbnail generated", placeholder.status === 200, `got ${placeholder.status}`);
    check(
      "placeholder is an svg",
      String(placeholder.headers.get("content-type")).includes("image/svg+xml"),
      `got ${placeholder.headers.get("content-type")}`,
    );
    check("placeholder is labelled with the video number", placeholder.text.includes(`Video ${withoutThumb.number}`));
    check(
      "placeholder is deterministic per video",
      placeholder.text === (await viewer.get(`/api/thumb/${withoutThumb.id}`)).text,
    );

    section("Archive search and covers");
    const byNumber = await viewer.get(`/api/archives/${archiveId}/videos?q=${encodeURIComponent("#4")}`);
    check("search by #number returns exactly that video", byNumber.json?.videos?.length === 1 && byNumber.json.videos[0].number === 4, `got ${byNumber.text}`);

    const bareNumber = await viewer.get(`/api/archives/${archiveId}/videos?q=5`);
    check("a bare number also jumps to that video", bareNumber.json?.videos?.[0]?.number === 5, `got ${bareNumber.json?.videos?.[0]?.number}`);

    const byTitle = await viewer.get(`/api/archives/${archiveId}/videos?q=EPISODE`);
    check("title search is case-insensitive", byTitle.json?.total === 5, `got ${byTitle.json?.total}`);

    const regexAttack = await viewer.get(`/api/archives/${archiveId}/videos?q=${encodeURIComponent("(.*)+$")}`);
    check("regex characters in search are treated literally", regexAttack.status === 200 && regexAttack.json?.total === 0, `got ${regexAttack.status} ${regexAttack.json?.total}`);

    const missing = await viewer.get(`/api/archives/${archiveId}/videos?q=${encodeURIComponent("#9999")}`);
    check("a number that does not exist returns nothing", missing.json?.total === 0);

    const homeCovers = await viewer.get("/api/home");
    const coverIds = homeCovers.json?.archives?.find((item) => item.id === archiveId)?.coverVideoIds ?? [];
    check("home archives carry up to three cover thumbnails", coverIds.length === 3, `got ${coverIds.length}`);
    check("home viewer includes the plan start date", Boolean(homeCovers.json?.viewer?.planStartsAt));

    section("Resume, likes and view counts");
    const saveProgress = await viewer.post(`/api/videos/${playable.id}/progress`, {
      positionSeconds: 312,
      durationSeconds: 1200,
    });
    check("progress saved", saveProgress.status === 200, `got ${saveProgress.status}`);
    check("progress percent computed", saveProgress.json?.percent === 26, `got ${saveProgress.json?.percent}`);

    const homeWithResume = await viewer.get("/api/home");
    check("continue watching now has the video", (homeWithResume.json?.continueWatching ?? []).length === 1);
    check("resume position returned", homeWithResume.json?.continueWatching?.[0]?.progressSeconds === 312);
    check("resume row knows its archive name", homeWithResume.json?.continueWatching?.[0]?.archiveName === "Season One");

    const overLength = await viewer.post(`/api/videos/${playable.id}/progress`, {
      positionSeconds: 5000,
      durationSeconds: 1200,
    });
    check("progress clamped to duration", overLength.json?.positionSeconds === 1200, `got ${overLength.json?.positionSeconds}`);
    check("fully watched marks completed", overLength.json?.completed === true);

    const negative = await viewer.post(`/api/videos/${playable.id}/progress`, { positionSeconds: -5 });
    check("negative progress rejected", negative.status === 400, `got ${negative.status}`);

    const like = await viewer.post(`/api/videos/${playable.id}/like`);
    check("like registered", like.json?.liked === true && like.json?.likeCount === 1, `got ${like.text}`);

    const unlike = await viewer.post(`/api/videos/${playable.id}/like`);
    check("like toggles off", unlike.json?.liked === false && unlike.json?.likeCount === 0, `got ${unlike.text}`);

    const relike = await viewer.post(`/api/videos/${playable.id}/like`);
    check("like toggles back on", relike.json?.liked === true && relike.json?.likeCount === 1);

    const sorted = await viewer.get(`/api/archives/${archiveId}/videos?sort=popular`);
    check("most watched video sorts to the top", sorted.json?.videos?.[0]?.id === playable.id, `got ${sorted.json?.videos?.[0]?.displayId}`);
    check("top video has a view recorded", sorted.json?.videos?.[0]?.viewCount === 1, `got ${sorted.json?.videos?.[0]?.viewCount}`);

    await viewer.post(`/api/videos/${playable.id}/stream-token`);
    const afterSecondToken = await viewer.get(`/api/archives/${archiveId}/videos?sort=popular`);
    check("repeat view by same key is not double counted", afterSecondToken.json?.videos?.[0]?.viewCount === 1, `got ${afterSecondToken.json?.videos?.[0]?.viewCount}`);

    section("Cross-category isolation");
    await admin.post("/api/admin/categories", { code: 77, name: "Other Tier" });
    const otherArchive = await admin.post("/api/admin/archives", { categoryCode: "77", name: "Hidden Vault" });
    const crossAccess = await viewer.get(`/api/archives/${otherArchive.json.id}/videos`);
    check("archive from another category is forbidden", crossAccess.status === 403, `got ${crossAccess.status}`);
    check("isolation reason reported", crossAccess.json?.code === "category_mismatch", `got ${crossAccess.json?.code}`);

    const homeAfter = await viewer.get("/api/home");
    check("other category archive not listed on home", !(homeAfter.json?.archives ?? []).some((a) => a.name === "Hidden Vault"));

    section("Live viewers and active subscriptions");
    await viewer.post("/api/presence");
    const overview = await admin.get("/api/admin/overview");
    check("overview loads", overview.status === 200, `got ${overview.status}`);
    check("live viewers counted", overview.json?.liveViewers >= 1, `got ${overview.json?.liveViewers}`);
    check("active subscriptions counted", overview.json?.activeSubscriptions === 1, `got ${overview.json?.activeSubscriptions}`);
    check("video count reported", overview.json?.videoCount >= 6, `got ${overview.json?.videoCount}`);
    check("media root reported to admin", overview.json?.mediaRoot === media.root);
    check("ffmpeg availability reported", typeof overview.json?.ffmpegAvailable === "boolean");

    const liveList = await admin.get("/api/admin/live");
    check("live viewer list returned", (liveList.json?.viewers ?? []).length >= 1);
    check("live viewer shows masked key hint", typeof liveList.json?.viewers?.[0]?.keyHint === "string");
    check("live viewer list contains no plaintext key", !liveList.text.includes(plainKey));

    section("Broadcast with I Read acknowledgement");
    const broadcast = await admin.post("/api/admin/broadcasts", {
      title: "Scheduled maintenance",
      message: "The library will be offline for 10 minutes at 02:00 UTC.",
    });
    check("broadcast created", broadcast.status === 201, `got ${broadcast.status} ${broadcast.text}`);

    const presenceWithBroadcast = await viewer.post("/api/presence");
    check("viewer receives the broadcast", presenceWithBroadcast.json?.broadcast?.id === broadcast.json.id);
    check("broadcast message delivered", presenceWithBroadcast.json?.broadcast?.message.includes("02:00 UTC"));

    const ack = await viewer.post(`/api/broadcasts/${broadcast.json.id}/ack`);
    check("I Read acknowledgement accepted", ack.status === 200, `got ${ack.status}`);

    const presenceAfterAck = await viewer.post("/api/presence");
    check("broadcast not shown again after acknowledgement", presenceAfterAck.json?.broadcast === null);

    const ackAgain = await viewer.post(`/api/broadcasts/${broadcast.json.id}/ack`);
    check("duplicate acknowledgement is harmless", ackAgain.status === 200);

    const broadcastList = await admin.get("/api/admin/broadcasts");
    check("admin sees acknowledgement count", broadcastList.json?.broadcasts?.[0]?.ackCount === 1, `got ${broadcastList.json?.broadcasts?.[0]?.ackCount}`);

    section("Owner expires a subscription");
    const stillWorks = await viewer.get("/api/home");
    check("viewer active before expiry", stillWorks.status === 200);

    const expire = await admin.post(`/api/admin/keys/${keyId}/expire`);
    check("expire succeeded", expire.status === 200, `got ${expire.status} ${expire.text}`);
    check("key status is revoked", expire.json?.status === "revoked", `got ${expire.json?.status}`);
    check("active session was kicked", expire.json?.kickedSessions >= 1, `got ${expire.json?.kickedSessions}`);

    const afterExpiry = await viewer.get("/api/home");
    check("expired viewer locked out immediately", afterExpiry.status === 401 || afterExpiry.status === 403, `got ${afterExpiry.status}`);

    const reRedeem = await new Client(VIEWER_IP).post("/api/gate/redeem", { key: plainKey });
    check("expired key cannot re-enter", reRedeem.status === 403, `got ${reRedeem.status}`);
    check("expiry reason reported", reRedeem.json?.code === "subscription_revoked", `got ${reRedeem.json?.code}`);

    const overviewAfter = await admin.get("/api/admin/overview");
    check("active subscriptions dropped to zero", overviewAfter.json?.activeSubscriptions === 0, `got ${overviewAfter.json?.activeSubscriptions}`);

    section("Extending and re-issuing access");
    const extend = await admin.post(`/api/admin/keys/${keyId}/extend`, { additionalDays: 15 });
    check("extend reactivates the key", extend.json?.status === "active", `got ${extend.json?.status}`);

    const releaseIp = await admin.post(`/api/admin/keys/${keyId}/release-ip`);
    check("ip binding released", releaseIp.json?.boundIp === null);

    const movedViewer = new Client("192.0.2.77");
    const rebind = await movedViewer.post("/api/gate/redeem", { key: plainKey });
    check("key rebinds to a new IP after release", rebind.status === 200, `got ${rebind.status} ${rebind.text}`);
    check("new IP recorded", rebind.json?.viewer?.lockedIp === "192.0.2.77");

    section("Static pages and headers");
    const homePage = await fetch(`${BASE}/`);
    check("landing page served", homePage.status === 200, `got ${homePage.status}`);
    check("content security policy set", String(homePage.headers.get("content-security-policy")).includes("default-src 'none'"));
    check("no inline script allowed by csp", !String(homePage.headers.get("content-security-policy")).includes("unsafe-inline"));
    check("frame-ancestors none", String(homePage.headers.get("content-security-policy")).includes("frame-ancestors 'none'"));

    const keysLeak = await fetch(`${BASE}/api/admin/keys`);
    check("admin keys endpoint closed to anonymous callers", keysLeak.status === 401, `got ${keysLeak.status}`);

    section("Front-end assets");
    const pages = { "/": "index.html", "/watch": "watch.html", "/admin": "admin.html" };
    const referenced = new Set();

    for (const [route, label] of Object.entries(pages)) {
      const page = await fetch(BASE + route);
      const html = await page.text();
      check(`${label} served`, page.status === 200, `got ${page.status}`);
      check(`${label} has no inline <script> code`, !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html));
      check(`${label} has no inline <style> block`, !/<style[^>]*>/i.test(html));
      check(`${label} has no style= attribute`, !/\sstyle=/i.test(html));

      for (const match of html.matchAll(/(?:href|src|poster|data-webm|data-mp4)="(\/[^"]+)"/g)) referenced.add(match[1]);
    }

    const { execFileSync } = await import("node:child_process");
    const repoRoot = path.resolve(import.meta.dirname, "..");

    for (const asset of [...referenced].sort()) {
      const response = await fetch(BASE + asset);
      check(`asset ${asset} loads`, response.status === 200, `got ${response.status}`);

      const route = asset.split("?")[0];
      if (route === "/watch" || route === "/admin" || route === "/") continue;
      const filePath = `public${route}`;
      const ignored = (() => {
        try {
          execFileSync("git", ["check-ignore", "-q", filePath], { cwd: repoRoot });
          return true;
        } catch {
          return false;
        }
      })();
      check(`asset ${asset} is not excluded by .gitignore, so it deploys`, !ignored, filePath);
    }

    const cssResponse = await fetch(`${BASE}/css/theme.css`);
    check("stylesheets revalidate on every load so updates show at once", cssResponse.headers.get("cache-control") === "no-cache", String(cssResponse.headers.get("cache-control")));
    const scriptResponse = await fetch(`${BASE}/js/gate.js`);
    check("scripts revalidate on every load", scriptResponse.headers.get("cache-control") === "no-cache", String(scriptResponse.headers.get("cache-control")));
    const etag = cssResponse.headers.get("etag");
    const { request: httpRequest } = await import("node:http");
    const revalidatedStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(`${BASE}/css/theme.css`, { headers: { "if-none-match": etag } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    check("unchanged stylesheet answers 304 so revalidation stays cheap", Boolean(etag) && revalidatedStatus === 304, `etag ${etag}, got ${revalidatedStatus}`);
    const videoResponse = await fetch(`${BASE}/media/seal.webm`, { method: "HEAD" });
    check("video revalidates so a replaced clip shows at once", videoResponse.headers.get("cache-control") === "no-cache", String(videoResponse.headers.get("cache-control")));

    for (const fontFile of [
      "plus-jakarta-sans-latin.woff2",
      "bodoni-moda-italic-latin.woff2",
      "martian-mono-latin.woff2",
    ]) {
      const fontResponse = await fetch(`${BASE}/fonts/${fontFile}`);
      const fontBytes = Buffer.from(await fontResponse.arrayBuffer());
      check(`${fontFile} is a real woff2 file`, fontBytes.subarray(0, 4).toString("ascii") === "wOF2");
      check(`${fontFile} cached immutably`, String(fontResponse.headers.get("cache-control")).includes("immutable"));
    }

    const themeCss = await (await fetch(`${BASE}/css/theme.css`)).text();
    const fontUrls = [...themeCss.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((match) => match[1]);
    check("theme declares three self-hosted font files", fontUrls.length === 3, `got ${fontUrls.length}`);
    for (const url of fontUrls) {
      check(`font referenced in css exists: ${url}`, (await fetch(BASE + url)).status === 200);
    }
    check("no external font host referenced", !/fonts\.googleapis|fonts\.gstatic|use\.typekit/i.test(themeCss));
    check("reduced-motion preference respected", themeCss.includes("prefers-reduced-motion: reduce"));

    for (const [asset, type, maxKb] of [
      ["/media/seal.webm", "video/webm", 450],
      ["/media/seal.mp4", "video/mp4", 450],
      ["/media/seal-poster.webp", "image/webp", 40],
      ["/img/splash-banner.webp", "image/webp", 60],
      ["/img/characters/reze-smile.webp", "image/webp", 80],
      ["/img/characters/reze-cafe.webp", "image/webp", 80],
      ["/img/characters/rize-glasses.webp", "image/webp", 80],
      ["/img/characters/rize-lean.webp", "image/webp", 80],
      ["/img/characters/banner-girl.webp", "image/webp", 80],
    ]) {
      const response = await fetch(BASE + asset);
      const bytes = Buffer.from(await response.arrayBuffer());
      check(`${asset} is served as ${type}`, response.status === 200 && String(response.headers.get("content-type")).startsWith(type), `got ${response.status} ${response.headers.get("content-type")}`);
      check(`${asset} stays under ${maxKb} KB for mobile`, bytes.length < maxKb * 1024, `got ${Math.round(bytes.length / 1024)} KB`);
    }

    const ranged = await fetch(`${BASE}/media/seal.mp4`, { headers: { range: "bytes=0-1023" } });
    check("seal video supports range requests for iOS Safari", ranged.status === 206, `got ${ranged.status}`);

    const characterWebp = Buffer.from(await (await fetch(`${BASE}/img/characters/reze-smile.webp`)).arrayBuffer());
    check("character cutouts keep an alpha channel", characterWebp.subarray(0, 4).toString() === "RIFF" && characterWebp.includes(Buffer.from("ALPH")));

    const watchPage = await fetch(`${BASE}/watch`);
    const watchHtml = await watchPage.text();
    check("player blocks the download control", watchHtml.includes("nodownload"));
    check('broadcast modal has an "I Read" button', watchHtml.includes("I Read"));
    check("no unhackable marketing claim in the markup", !/cannot be hacked|unhackable|100% secure/i.test(watchHtml));
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    server.kill("SIGKILL");
    await replSet.stop();
    await fs.rm(media.root, { recursive: true, force: true });
    await fs.rm(media.secretOutside, { force: true });
    await fs.rm(path.join(path.dirname(media.root), "escape.mp4"), { force: true });
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
  console.error("\nTest harness crashed:", error);
  process.exit(1);
});
