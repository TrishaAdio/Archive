import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import yauzl from "yauzl";
import { badRequest, forbidden, notFound } from "../lib/errors.js";

const execFileAsync = promisify(execFile);

const PLAYABLE_EXTENSIONS = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".webm", "video/webm"],
  [".ogv", "video/ogg"],
]);

const TRANSCODE_EXTENSIONS = new Map([
  [".mkv", "video/x-matroska"],
  [".mov", "video/quicktime"],
  [".avi", "video/x-msvideo"],
  [".ts", "video/mp2t"],
  [".wmv", "video/x-ms-wmv"],
  [".flv", "video/x-flv"],
]);

const IMAGE_EXTENSIONS = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
]);

const ARCHIVE_EXTENSIONS = new Set([".zip"]);
const MAX_SCAN_DEPTH = 12;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024 * 1024;

function prettifyTitle(fileName) {
  const base = fileName.replace(/\.[^.]+$/, "");
  const withoutIndex = base.replace(/^[\s\-_.]*\d{1,4}[\s\-_.]+(?=\D)/, "");
  const spaced = (withoutIndex || base)
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const titled = spaced.replace(/\b[a-z]/g, (character) => character.toUpperCase());
  return (titled || base).slice(0, 200);
}

function classify(name) {
  const ext = path.extname(name).toLowerCase();
  if (PLAYABLE_EXTENSIONS.has(ext)) {
    return { kind: "video", playable: true, mimeType: PLAYABLE_EXTENSIONS.get(ext) };
  }
  if (TRANSCODE_EXTENSIONS.has(ext)) {
    return { kind: "video", playable: false, mimeType: TRANSCODE_EXTENSIONS.get(ext) };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { kind: "image", playable: false, mimeType: IMAGE_EXTENSIONS.get(ext) };
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) return { kind: "archive", playable: false, mimeType: "application/zip" };
  return { kind: "other", playable: false, mimeType: "application/octet-stream" };
}

function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function createMediaService({ mediaRoot }) {
  let canonicalRootPromise = null;

  async function canonicalRoot() {
    canonicalRootPromise ??= fs.realpath(mediaRoot).catch(() => {
      throw new Error(`MEDIA_ROOT does not exist or is not readable: ${mediaRoot}`);
    });
    return canonicalRootPromise;
  }

  function assertContained(root, candidate) {
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      throw forbidden("path_outside_media_root", "Path resolves outside the configured media root");
    }
  }

  async function resolveExisting(relPath = "") {
    const raw = String(relPath ?? "");
    if (raw.includes("\0")) throw badRequest("Path contains a null byte");

    const root = await canonicalRoot();
    const joined = path.resolve(root, raw.replace(/^[/\\]+/, ""));
    assertContained(root, joined);

    let real;
    try {
      real = await fs.realpath(joined);
    } catch {
      throw notFound("Path does not exist");
    }
    assertContained(root, real);
    return { absolute: real, relative: path.relative(root, real), root };
  }

  async function resolveForWrite(relPath) {
    const raw = String(relPath ?? "");
    if (raw.includes("\0")) throw badRequest("Path contains a null byte");

    const root = await canonicalRoot();
    const joined = path.resolve(root, raw.replace(/^[/\\]+/, ""));
    assertContained(root, joined);
    return { absolute: joined, relative: path.relative(root, joined), root };
  }

  async function listDirectory(relPath = "") {
    const { absolute, relative, root } = await resolveExisting(relPath);
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) throw badRequest("Path is not a directory");

    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    const entries = [];

    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;

      const entryAbsolute = path.join(absolute, dirent.name);
      let entryStat;
      try {
        entryStat = await fs.stat(entryAbsolute);
      } catch {
        continue;
      }

      if (dirent.isSymbolicLink()) {
        try {
          assertContained(root, await fs.realpath(entryAbsolute));
        } catch {
          continue;
        }
      }

      const info = classify(dirent.name);
      entries.push({
        name: dirent.name,
        relPath: path.relative(root, entryAbsolute),
        type: entryStat.isDirectory() ? "directory" : "file",
        kind: entryStat.isDirectory() ? "directory" : info.kind,
        playable: entryStat.isDirectory() ? false : info.playable,
        sizeBytes: entryStat.isDirectory() ? null : entryStat.size,
        modifiedAt: entryStat.mtime.toISOString(),
      });
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return naturalCompare(a.name, b.name);
    });

    return {
      relPath: relative,
      parentRelPath: relative === "" ? null : path.dirname(relative) === "." ? "" : path.dirname(relative),
      isRoot: relative === "",
      entries,
    };
  }

  async function scanVideos(relPath) {
    const { absolute, root } = await resolveExisting(relPath);
    const stat = await fs.stat(absolute);
    const found = [];

    async function walk(dir, depth) {
      if (depth > MAX_SCAN_DEPTH) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      const sorted = [...dirents].sort((a, b) => naturalCompare(a.name, b.name));

      for (const dirent of sorted) {
        if (dirent.name.startsWith(".")) continue;
        const entryAbsolute = path.join(dir, dirent.name);

        let real;
        try {
          real = await fs.realpath(entryAbsolute);
          assertContained(root, real);
        } catch {
          continue;
        }

        const entryStat = await fs.stat(real);
        if (entryStat.isDirectory()) {
          await walk(real, depth + 1);
          continue;
        }

        const info = classify(dirent.name);
        if (info.kind !== "video") continue;

        found.push({
          relPath: path.relative(root, real),
          fileName: dirent.name,
          title: prettifyTitle(dirent.name),
          sizeBytes: entryStat.size,
          mimeType: info.mimeType,
          playable: info.playable,
        });
      }
    }

    if (stat.isDirectory()) {
      await walk(absolute, 0);
    } else {
      const info = classify(path.basename(absolute));
      if (info.kind !== "video") throw badRequest("Selected file is not a recognised video file");
      found.push({
        relPath: path.relative(root, absolute),
        fileName: path.basename(absolute),
        title: prettifyTitle(path.basename(absolute)),
        sizeBytes: stat.size,
        mimeType: info.mimeType,
        playable: info.playable,
      });
    }

    return found;
  }

  async function extractZip(relPath, destRelPath) {
    const { absolute } = await resolveExisting(relPath);
    if (path.extname(absolute).toLowerCase() !== ".zip") throw badRequest("Selected file is not a .zip archive");

    const destination = await resolveForWrite(destRelPath);
    await fs.mkdir(destination.absolute, { recursive: true });
    const destinationReal = await fs.realpath(destination.absolute);
    assertContained(destination.root, destinationReal);

    const summary = { extracted: 0, skipped: 0, destRelPath: path.relative(destination.root, destinationReal) };

    const zipfile = await new Promise((resolve, reject) => {
      yauzl.open(absolute, { lazyEntries: true, autoClose: true, decodeStrings: false }, (error, handle) =>
        error ? reject(error) : resolve(handle),
      );
    });

    await new Promise((resolve, reject) => {
      zipfile.on("error", reject);
      zipfile.on("end", resolve);

      zipfile.on("entry", (entry) => {
        const rawName = Buffer.isBuffer(entry.fileName)
          ? entry.fileName.toString("utf8")
          : String(entry.fileName);
        const entryName = rawName.replace(/\\/g, "/");

        const unsafe =
          entryName.includes("\0") ||
          entryName.startsWith("/") ||
          /^[a-z]:/i.test(entryName) ||
          entryName.split("/").includes("..");

        if (unsafe) {
          summary.skipped += 1;
          zipfile.readEntry();
          return;
        }

        const isSymlink = ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
        if (isSymlink || entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
          summary.skipped += 1;
          zipfile.readEntry();
          return;
        }

        const target = path.resolve(destinationReal, entryName);
        if (target !== destinationReal && !target.startsWith(destinationReal + path.sep)) {
          summary.skipped += 1;
          zipfile.readEntry();
          return;
        }

        if (entryName.endsWith("/")) {
          fs.mkdir(target, { recursive: true })
            .then(() => zipfile.readEntry())
            .catch(reject);
          return;
        }

        const info = classify(entryName);
        if (info.kind !== "video" && info.kind !== "image") {
          summary.skipped += 1;
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, async (streamError, readStream) => {
          if (streamError) return reject(streamError);
          try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await pipeline(readStream, createWriteStream(target));
            summary.extracted += 1;
            zipfile.readEntry();
          } catch (writeError) {
            reject(writeError);
          }
        });
      });

      zipfile.readEntry();
    });

    return summary;
  }

  async function findSiblingThumbnail(videoRelPath) {
    const { absolute, root } = await resolveExisting(videoRelPath);
    const withoutExtension = absolute.slice(0, absolute.length - path.extname(absolute).length);

    for (const extension of IMAGE_EXTENSIONS.keys()) {
      const candidate = withoutExtension + extension;
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          return { relPath: path.relative(root, candidate), mimeType: IMAGE_EXTENSIONS.get(extension) };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async function ffmpegAvailable() {
    try {
      await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async function generateThumbnail(videoRelPath, thumbRelPath, atSeconds = 5) {
    const { absolute } = await resolveExisting(videoRelPath);
    const target = await resolveForWrite(thumbRelPath);
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });

    await execFileAsync(
      "ffmpeg",
      ["-y", "-ss", String(atSeconds), "-i", absolute, "-frames:v", "1", "-vf", "scale=480:-2", target.absolute],
      { timeout: 60000 },
    );

    return { relPath: target.relative, mimeType: "image/jpeg" };
  }

  async function probeDuration(videoRelPath) {
    const { absolute } = await resolveExisting(videoRelPath);
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", absolute],
        { timeout: 20000 },
      );
      const seconds = Number.parseFloat(stdout.trim());
      return Number.isFinite(seconds) ? Math.round(seconds) : null;
    } catch {
      return null;
    }
  }

  async function statFile(relPath) {
    const { absolute } = await resolveExisting(relPath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw notFound("Not a file");
    return { absolute, sizeBytes: stat.size, modifiedAt: stat.mtime };
  }

  return {
    listDirectory,
    scanVideos,
    extractZip,
    findSiblingThumbnail,
    ffmpegAvailable,
    generateThumbnail,
    probeDuration,
    statFile,
    classify,
  };
}

export { createMediaService, IMAGE_EXTENSIONS, PLAYABLE_EXTENSIONS, prettifyTitle };
