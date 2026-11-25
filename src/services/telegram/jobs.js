import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ObjectId } from "mongodb";
import yazl from "yazl";
import { DURABLE_WRITE } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { describeFailure, TelegramFailure } from "./failures.js";
import { ENDED_SESSION_CODES } from "./account.js";
import { parseChatLink } from "./links.js";

const RUNNING = ["connecting", "joining", "scanning", "downloading", "zipping"];
const ACTIVE = ["queued", ...RUNNING];
const RESUMABLE = ["failed", "cancelled", "interrupted"];
const PARALLEL_FILES = 3;
const RESUME_ALIGN_BYTES = 512 * 1024;
const PERSIST_EVERY_MS = 2000;
const SPEED_WINDOW_MS = 8000;
const MAX_ATTEMPTS = 4;
const RETRY_STEP_MS = 2000;
const MAX_FLOOD_WAITS = 20;
const MAX_FAILURES_KEPT = 50;
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;
const CATEGORY_CODE_PATTERN = /^\d{1,10}$/;

const EXTENSION_BY_MIME = {
  "video/mp4": ".mp4",
  "video/x-m4v": ".m4v",
  "video/webm": ".webm",
  "video/ogg": ".ogv",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "video/mp2t": ".ts",
  "video/x-ms-wmv": ".wmv",
  "video/x-flv": ".flv",
};

const GENERIC_FILE_NAME = /^(video|vid|img|mov|movie|file|document|telegram|tg)?[\s_\-.]*[\d\s_\-.]*$/i;

class Cancelled extends Error {}

function cleanName(value) {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Cancelled());
      },
      { once: true },
    );
  });
}

function createTelegramJobs({ collection, account, catalog, media }) {
  const live = new Map();
  let running = null;
  let closing = false;

  function extensionFor(item) {
    const original = path.extname(item.fileName || "").toLowerCase();
    if (original && media.classify(`x${original}`).kind === "video") return original;
    return EXTENSION_BY_MIME[item.mimeType] ?? ".mp4";
  }

  function baseNameFor(item) {
    const fromFile = cleanName(path.basename(item.fileName || "", path.extname(item.fileName || "")));
    if (fromFile.length >= 3 && !GENERIC_FILE_NAME.test(fromFile)) return fromFile;
    const fromCaption = cleanName(String(item.caption ?? "").split("\n").find((line) => cleanName(line).length >= 3) ?? "");
    if (fromCaption) return fromCaption;
    return `Video ${item.messageId}`;
  }

  function fileNameFor(item, number, total) {
    const width = Math.max(4, String(total).length);
    return `${String(number).padStart(width, "0")} ${baseNameFor(item)}${extensionFor(item)}`;
  }

  function shape(doc) {
    const progress = live.get(doc._id.toHexString());
    const merged = progress ? { ...doc, ...progress.snapshot() } : doc;
    return {
      id: doc._id.toHexString(),
      link: merged.linkDisplay,
      chatTitle: merged.chatTitle ?? null,
      archiveId: merged.archiveId.toHexString(),
      archiveName: merged.archiveName,
      categoryCode: merged.categoryCode,
      folder: merged.folderRelPath,
      keepZip: merged.keepZip,
      zipPath: merged.zipRelPath ?? null,
      status: merged.status,
      error: merged.error ?? null,
      scannedCount: merged.scannedCount ?? 0,
      totalFiles: merged.totalFiles ?? 0,
      doneFiles: merged.doneFiles ?? 0,
      failedFiles: merged.failedFiles ?? 0,
      totalBytes: merged.totalBytes ?? 0,
      doneBytes: merged.doneBytes ?? 0,
      zipBytes: merged.zipBytes ?? 0,
      speedBytesPerSecond: progress ? (merged.speedBytesPerSecond ?? 0) : 0,
      etaSeconds: progress ? (merged.etaSeconds ?? null) : null,
      waitingUntil: progress && merged.waitingUntil ? new Date(merged.waitingUntil).toISOString() : null,
      current: progress ? (merged.current ?? []) : [],
      failures: (merged.failures ?? []).slice(-20),
      createdAt: doc.createdAt.toISOString(),
      startedAt: merged.startedAt ? new Date(merged.startedAt).toISOString() : null,
      finishedAt: merged.finishedAt ? new Date(merged.finishedAt).toISOString() : null,
    };
  }

  function toJobId(id) {
    if (typeof id !== "string" || !ObjectId.isValid(id)) throw notFound("Download not found");
    return new ObjectId(id);
  }

  async function list() {
    const docs = await collection.find({}).sort({ createdAt: -1 }).limit(20).toArray();
    return docs.map(shape);
  }

  async function get(id) {
    const doc = await collection.findOne({ _id: toJobId(id) });
    if (!doc) throw notFound("Download not found");
    return shape(doc);
  }

  async function create(input = {}) {
    const target = parseChatLink(input.link);
    const archiveName = typeof input.archiveName === "string" ? input.archiveName.trim() : "";
    if (archiveName.length < 2 || archiveName.length > 120) {
      throw badRequest("Archive name must be between 2 and 120 characters", { field: "archiveName" });
    }
    const categoryCode = String(input.categoryCode ?? "").trim();
    if (!CATEGORY_CODE_PATTERN.test(categoryCode)) {
      throw badRequest('Category code must be a number of 1 to 10 digits, for example "12"', { field: "categoryCode" });
    }
    const categoryName = typeof input.categoryName === "string" ? input.categoryName.trim() : "";
    const existingCategory = await catalog.getCategoryByCode(categoryCode);
    if (!existingCategory && categoryName.length < 2) {
      throw badRequest(`Category code ${categoryCode} does not exist yet. Give it a name so it can be created.`, {
        field: "categoryName",
      });
    }

    const client = await account.getClient();
    const chat = await client.resolveChat(target);
    if (await collection.findOne({ chatId: chat.id, status: { $in: ACTIVE } }, { projection: { _id: 1 } })) {
      throw conflict(`"${chat.title}" is already downloading.`);
    }

    if (!existingCategory) await catalog.createCategory({ code: categoryCode, name: categoryName });
    const archive = await catalog.createArchive({ categoryCode, name: archiveName });

    const now = new Date();
    const doc = {
      link: String(input.link).trim(),
      linkDisplay: target.display,
      chatId: chat.id,
      chatTitle: chat.title,
      archiveId: new ObjectId(archive.id),
      archiveName: archive.name,
      categoryCode,
      folderRelPath: path.posix.join("telegram", `${categoryCode}-${archive.slug}`),
      keepZip: input.keepZip === true,
      zipRelPath: null,
      status: "queued",
      error: null,
      totalFiles: 0,
      doneFiles: 0,
      failedFiles: 0,
      totalBytes: 0,
      doneBytes: 0,
      failures: [],
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    const { insertedId } = await collection.insertOne(doc, { writeConcern: DURABLE_WRITE });
    kick();
    return shape({ ...doc, _id: insertedId });
  }

  async function cancel(id) {
    const jobId = toJobId(id);
    if (running?.id.equals(jobId)) {
      running.controller.abort();
      await running.done;
      return get(id);
    }
    const result = await collection.findOneAndUpdate(
      { _id: jobId, status: "queued" },
      { $set: { status: "cancelled", finishedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!result) {
      const doc = await collection.findOne({ _id: jobId });
      if (!doc) throw notFound("Download not found");
      throw conflict("That download is not running.");
    }
    return shape(result);
  }

  async function resume(id) {
    const jobId = toJobId(id);
    const result = await collection.findOneAndUpdate(
      { _id: jobId, status: { $in: RESUMABLE } },
      { $set: { status: "queued", error: null, finishedAt: null } },
      { returnDocument: "after" },
    );
    if (!result) {
      const doc = await collection.findOne({ _id: jobId });
      if (!doc) throw notFound("Download not found");
      throw conflict(doc.status === "done" ? "That download already finished." : "That download is already running.");
    }
    kick();
    return shape(result);
  }

  function kick() {
    if (running || closing) return;
    setImmediate(() => {
      runNext().catch((error) => console.error("telegram job runner failed", error));
    });
  }

  async function runNext() {
    if (running || closing) return;
    const doc = await collection.findOneAndUpdate(
      { status: "queued" },
      { $set: { status: "connecting", startedAt: new Date(), error: null } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    );
    if (!doc) return;

    const controller = new AbortController();
    const slot = { id: doc._id, controller, done: null };
    running = slot;
    slot.done = execute(doc, controller.signal).finally(() => {
      live.delete(doc._id.toHexString());
      running = null;
      kick();
    });
    await slot.done;
  }

  function createProgress(doc) {
    const state = {
      status: doc.status,
      chatTitle: doc.chatTitle,
      scannedCount: 0,
      totalFiles: 0,
      doneFiles: 0,
      failedFiles: 0,
      totalBytes: 0,
      completedBytes: 0,
      zipBytes: 0,
      zipRelPath: doc.zipRelPath ?? null,
      failures: [],
      waitingUntil: null,
      startedAt: doc.startedAt,
      finishedAt: null,
      error: null,
    };
    const active = new Map();
    const samples = [];
    let transferred = 0;
    let lastPersist = 0;
    let writes = Promise.resolve();

    function receivedNow() {
      let sum = 0;
      for (const entry of active.values()) sum += entry.received;
      return sum;
    }

    function speed() {
      const now = Date.now();
      while (samples.length > 2 && now - samples[0][0] > SPEED_WINDOW_MS) samples.shift();
      if (samples.length < 2) return 0;
      const [firstAt, firstBytes] = samples[0];
      const elapsed = (now - firstAt) / 1000;
      return elapsed > 0.5 ? (transferred - firstBytes) / elapsed : 0;
    }

    function snapshot() {
      const doneBytes = state.completedBytes + receivedNow();
      const bytesPerSecond = Math.round(speed());
      const remaining = Math.max(0, state.totalBytes - doneBytes);
      const zipping = state.status === "zipping";
      const zipRemaining = zipping ? Math.max(0, state.completedBytes - state.zipBytes) : 0;
      return {
        status: state.status,
        chatTitle: state.chatTitle,
        scannedCount: state.scannedCount,
        totalFiles: state.totalFiles,
        doneFiles: state.doneFiles,
        failedFiles: state.failedFiles,
        totalBytes: state.totalBytes,
        doneBytes,
        zipBytes: state.zipBytes,
        zipRelPath: state.zipRelPath,
        speedBytesPerSecond: bytesPerSecond,
        etaSeconds: bytesPerSecond > 0 ? Math.round((zipping ? zipRemaining : remaining) / bytesPerSecond) : null,
        waitingUntil: state.waitingUntil,
        current: [...active.values()].map((entry) => ({ name: entry.fileName, receivedBytes: entry.received, sizeBytes: entry.item.sizeBytes })),
        failures: state.failures,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        error: state.error,
      };
    }

    function persist(force = false) {
      const now = Date.now();
      if (!force && now - lastPersist < PERSIST_EVERY_MS) return writes;
      lastPersist = now;
      writes = writes.then(() => write(snapshot()));
      return writes;
    }

    function write(view) {
      return collection
        .updateOne(
          { _id: doc._id },
          {
            $set: {
              status: view.status,
              chatTitle: view.chatTitle,
              totalFiles: view.totalFiles,
              doneFiles: view.doneFiles,
              failedFiles: view.failedFiles,
              totalBytes: view.totalBytes,
              doneBytes: view.doneBytes,
              zipBytes: view.zipBytes,
              zipRelPath: view.zipRelPath,
              failures: view.failures.slice(-MAX_FAILURES_KEPT),
              error: view.error,
              finishedAt: view.finishedAt,
            },
          },
        )
        .catch((error) => console.error("telegram job progress write failed", error.message));
    }

    function update(fields) {
      Object.assign(state, fields);
      persist(Boolean(fields.status));
    }

    function addBytes(count) {
      transferred += count;
      const now = Date.now();
      const last = samples.at(-1);
      if (!last || now - last[0] >= 250) samples.push([now, transferred]);
      else last[1] = transferred;
      persist();
    }

    return { state, active, snapshot, persist, update, addBytes };
  }

  async function prepareEntries(folder, items) {
    const entries = [];
    for (const [index, item] of items.entries()) {
      const fileName = fileNameFor(item, index + 1, items.length);
      const finalPath = path.join(folder.absolute, fileName);
      const partPath = path.join(folder.absolute, `.${fileName}.part`);
      const finalSize = await fs.stat(finalPath).then((stat) => stat.size, () => -1);
      const partSize = await fs.stat(partPath).then((stat) => stat.size, () => 0);
      const done = finalSize === item.sizeBytes;
      entries.push({
        item,
        fileName,
        finalPath,
        partPath,
        relPath: path.posix.join(folder.relative.split(path.sep).join("/"), fileName),
        state: done ? "done" : "pending",
        resumeFrom: done ? 0 : Math.min(partSize, item.sizeBytes) - (Math.min(partSize, item.sizeBytes) % RESUME_ALIGN_BYTES),
        received: 0,
        imported: false,
      });
    }
    return entries;
  }

  async function downloadEntry(entry, { client, chatId, progress, signal }) {
    const { item } = entry;
    let attempts = 0;
    let floodWaits = 0;

    while (true) {
      if (signal.aborted) throw new Cancelled();
      let handle = null;
      const offset = await fs.stat(entry.partPath).then(
        (stat) => {
          const usable = Math.min(stat.size, item.sizeBytes);
          return usable - (usable % RESUME_ALIGN_BYTES);
        },
        () => 0,
      );

      try {
        handle = await fs.open(entry.partPath, offset > 0 ? "r+" : "w");
        await handle.truncate(offset);
        entry.received = offset;
        progress.active.set(entry.fileName, entry);

        let position = offset;
        for await (const chunk of client.download(chatId, item, { offset })) {
          if (signal.aborted) throw new Cancelled();
          await handle.write(chunk, 0, chunk.length, position);
          position += chunk.length;
          entry.received = position;
          progress.addBytes(chunk.length);
        }
        await handle.close();
        handle = null;

        if (position !== item.sizeBytes) throw new Error(`Download stopped at ${position} of ${item.sizeBytes} bytes`);
        await fs.rename(entry.partPath, entry.finalPath);
        progress.active.delete(entry.fileName);
        entry.state = "done";
        progress.state.completedBytes += item.sizeBytes;
        progress.update({ doneFiles: progress.state.doneFiles + 1 });
        return;
      } catch (error) {
        await handle?.close().catch(() => null);
        progress.active.delete(entry.fileName);
        if (error instanceof Cancelled || signal.aborted) throw new Cancelled();
        if (ENDED_SESSION_CODES.has(error?.code)) throw error;

        if (error?.code === "FLOOD_WAIT" && floodWaits < MAX_FLOOD_WAITS) {
          floodWaits += 1;
          const waitMs = ((error.seconds ?? 30) + 1) * 1000;
          progress.update({ waitingUntil: Date.now() + waitMs });
          await sleep(waitMs, signal);
          progress.update({ waitingUntil: null });
          continue;
        }

        attempts += 1;
        if (attempts >= MAX_ATTEMPTS) {
          entry.state = "failed";
          const reason = error instanceof TelegramFailure ? describeFailure(error) : error.message;
          progress.state.failures.push({ messageId: item.messageId, fileName: entry.fileName, error: reason });
          progress.update({ failedFiles: progress.state.failedFiles + 1 });
          return;
        }
        await sleep(RETRY_STEP_MS * attempts, signal);
      }
    }
  }

  function createImporter(archiveId, entries) {
    let cursor = 0;
    let chain = Promise.resolve();

    async function drain() {
      while (cursor < entries.length && entries[cursor].state !== "pending") {
        const entry = entries[cursor];
        if (entry.state === "done" && !entry.imported) {
          await catalog.importIntoArchive(archiveId, { relPath: entry.relPath, mode: "path" });
          entry.imported = true;
        }
        cursor += 1;
      }
    }

    return () => {
      chain = chain.then(drain);
      return chain;
    };
  }

  async function writeZip(doc, entries, progress, signal) {
    const zipRelPath = `${doc.folderRelPath}.zip`;
    const target = await media.ensureDirectory(path.posix.dirname(zipRelPath));
    const finalPath = path.join(target.absolute, path.posix.basename(zipRelPath));
    const partPath = path.join(target.absolute, `.${path.posix.basename(zipRelPath)}.part`);

    progress.update({ status: "zipping", zipBytes: 0 });
    const zip = new yazl.ZipFile();
    for (const entry of entries) {
      if (entry.state === "done") zip.addFile(entry.finalPath, entry.fileName, { compress: false });
    }
    zip.end();

    let written = 0;
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        written += chunk.length;
        progress.state.zipBytes = Math.min(written, progress.state.completedBytes);
        progress.addBytes(chunk.length);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(zip.outputStream, counter, createWriteStream(partPath), { signal });
    } catch (error) {
      await fs.rm(partPath, { force: true });
      if (signal.aborted) throw new Cancelled();
      throw error;
    }
    await fs.rename(partPath, finalPath);
    progress.update({ zipRelPath, zipBytes: progress.state.completedBytes });
  }

  async function execute(doc, signal) {
    const progress = createProgress(doc);
    live.set(doc._id.toHexString(), progress);
    const archiveId = doc.archiveId.toHexString();

    try {
      progress.update({ status: "connecting" });
      const client = await account.getClient();
      if (signal.aborted) throw new Cancelled();

      progress.update({ status: "joining" });
      const chat = await client.resolveChat(parseChatLink(doc.link));
      if (signal.aborted) throw new Cancelled();

      progress.update({ status: "scanning", chatTitle: chat.title });
      const items = await client.listVideos(chat.id, {
        signal,
        onProgress: (count) => {
          progress.state.scannedCount = count;
          progress.persist();
        },
      });
      if (signal.aborted) throw new Cancelled();

      const folder = await media.ensureDirectory(doc.folderRelPath);
      const entries = await prepareEntries(folder, items);
      const totalBytes = entries.reduce((sum, entry) => sum + entry.item.sizeBytes, 0);
      const completedBytes = entries.filter((entry) => entry.state === "done").reduce((sum, entry) => sum + entry.item.sizeBytes, 0);
      const alreadyPartial = entries.filter((entry) => entry.state === "pending").reduce((sum, entry) => sum + entry.resumeFrom, 0);

      const needed = totalBytes - completedBytes - alreadyPartial + (doc.keepZip ? totalBytes : 0) + DISK_MARGIN_BYTES;
      const free = await media.freeBytes().catch(() => Infinity);
      if (free < needed) {
        throw new Error(
          `Not enough disk space. This chat needs about ${Math.ceil(needed / 1e9)} GB more but the server has ${Math.floor(free / 1e9)} GB free.`,
        );
      }

      progress.state.completedBytes = completedBytes;
      progress.update({
        status: "downloading",
        scannedCount: items.length,
        totalFiles: entries.length,
        totalBytes,
        doneFiles: entries.filter((entry) => entry.state === "done").length,
        failedFiles: 0,
      });

      const importReady = createImporter(archiveId, entries);
      await importReady();

      const queue = entries.filter((entry) => entry.state === "pending");
      const workers = new AbortController();
      const stopWorkers = () => workers.abort();
      signal.addEventListener("abort", stopWorkers, { once: true });
      let workerError = null;
      const worker = async () => {
        try {
          while (queue.length && !workers.signal.aborted) {
            const entry = queue.shift();
            await downloadEntry(entry, { client, chatId: chat.id, progress, signal: workers.signal });
            await importReady();
          }
        } catch (error) {
          if (!(error instanceof Cancelled)) workerError ??= error;
          workers.abort();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_FILES, Math.max(1, queue.length)) }, worker));
      signal.removeEventListener("abort", stopWorkers);
      if (signal.aborted) throw new Cancelled();
      if (workerError) throw workerError;
      await importReady();

      if (doc.keepZip && entries.some((entry) => entry.state === "done")) await writeZip(doc, entries, progress, signal);

      progress.update({ status: "done", finishedAt: new Date(), waitingUntil: null });
    } catch (error) {
      if (error instanceof Cancelled || signal.aborted) {
        progress.update({
          status: closing ? "queued" : "cancelled",
          finishedAt: closing ? null : new Date(),
          waitingUntil: null,
        });
      } else {
        await account.handleFailure(error);
        const message = error instanceof TelegramFailure ? describeFailure(error) : error.message || "The download failed.";
        if (!(error instanceof TelegramFailure)) console.error("telegram job failed", error);
        progress.update({ status: "failed", error: message, finishedAt: new Date(), waitingUntil: null });
      }
    } finally {
      progress.active.clear();
      await progress.persist(true);
    }
  }

  async function start() {
    await collection.updateMany({ status: { $in: RUNNING } }, { $set: { status: "queued" } });
    kick();
  }

  async function hasActive() {
    return Boolean(await collection.findOne({ status: { $in: ACTIVE } }, { projection: { _id: 1 } }));
  }

  async function close() {
    closing = true;
    if (running) {
      running.controller.abort();
      await running.done.catch(() => null);
    }
  }

  return { create, list, get, cancel, resume, start, close, hasActive };
}

export { createTelegramJobs };
