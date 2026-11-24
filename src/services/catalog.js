import path from "node:path";
import { ObjectId } from "mongodb";
import { DURABLE_WRITE } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { toObjectId } from "./accessKeys.js";

const CATEGORY_CODE_PATTERN = /^\d{1,10}$/;
const DUPLICATE_KEY_ERROR = 11000;
const IMPORT_BATCH_SIZE = 500;

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function createCatalogService({ categories, archives, videos }, { counters, media }) {
  async function createCategory({ code, name }) {
    const normalizedCode =
      typeof code === "number" && Number.isInteger(code) && code >= 0 ? String(code) : code;

    if (typeof normalizedCode !== "string" || !CATEGORY_CODE_PATTERN.test(normalizedCode)) {
      throw badRequest('code must be a numeric category code of 1 to 10 digits, for example "12"');
    }
    if (typeof name !== "string" || name.trim().length < 2 || name.length > 80) {
      throw badRequest("name must be between 2 and 80 characters");
    }

    const document = { code: normalizedCode, name: name.trim(), createdAt: new Date() };

    try {
      const result = await categories.insertOne(document, { writeConcern: DURABLE_WRITE });
      return { id: result.insertedId.toHexString(), ...document, createdAt: document.createdAt.toISOString() };
    } catch (error) {
      if (error?.code === DUPLICATE_KEY_ERROR) throw conflict(`Category code ${normalizedCode} already exists`);
      throw error;
    }
  }

  async function renameCategory(code, name) {
    if (typeof name !== "string" || name.trim().length < 2 || name.length > 80) {
      throw badRequest("name must be between 2 and 80 characters");
    }
    const updated = await categories.findOneAndUpdate(
      { code: String(code) },
      { $set: { name: name.trim() } },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    if (!updated) throw notFound("Category not found");
    return { id: updated._id.toHexString(), code: updated.code, name: updated.name };
  }

  async function listCategories() {
    const docs = await categories.find().sort({ code: 1 }).toArray();
    const counts = await archives
      .aggregate([{ $group: { _id: "$categoryCode", archiveCount: { $sum: 1 }, videoCount: { $sum: "$videoCount" } } }])
      .toArray();
    const byCode = new Map(counts.map((entry) => [entry._id, entry]));

    return docs.map((doc) => ({
      id: doc._id.toHexString(),
      code: doc.code,
      name: doc.name,
      archiveCount: byCode.get(doc.code)?.archiveCount ?? 0,
      videoCount: byCode.get(doc.code)?.videoCount ?? 0,
      createdAt: doc.createdAt.toISOString(),
    }));
  }

  async function getCategoryByCode(code) {
    return categories.findOne({ code: String(code) });
  }

  async function createArchive({ categoryCode, name, description }) {
    const category = await getCategoryByCode(categoryCode);
    if (!category) throw badRequest(`No category exists with code ${categoryCode}. Create the category first.`);
    if (typeof name !== "string" || name.trim().length < 2 || name.length > 120) {
      throw badRequest("name must be between 2 and 120 characters");
    }

    const slug = slugify(name);
    if (!slug) throw badRequest("name must contain at least one letter or digit");

    const document = {
      categoryCode: category.code,
      name: name.trim(),
      slug,
      description: typeof description === "string" ? description.trim().slice(0, 500) : null,
      videoCount: 0,
      createdAt: new Date(),
    };

    try {
      const result = await archives.insertOne(document, { writeConcern: DURABLE_WRITE });
      return shapeArchive({ ...document, _id: result.insertedId });
    } catch (error) {
      if (error?.code === DUPLICATE_KEY_ERROR) {
        throw conflict(`An archive named "${document.name}" already exists in category ${category.code}`);
      }
      throw error;
    }
  }

  function shapeArchive(doc) {
    return {
      id: doc._id.toHexString(),
      categoryCode: doc.categoryCode,
      name: doc.name,
      slug: doc.slug,
      description: doc.description ?? null,
      videoCount: doc.videoCount ?? 0,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  async function listArchives(categoryCode) {
    const filter = categoryCode ? { categoryCode: String(categoryCode) } : {};
    const docs = await archives.find(filter).sort({ createdAt: -1 }).toArray();
    return docs.map(shapeArchive);
  }

  async function getArchive(archiveId) {
    const doc = await archives.findOne({ _id: toObjectId(archiveId) });
    if (!doc) throw notFound("Archive not found");
    return doc;
  }

  async function deleteArchive(archiveId) {
    const archive = await getArchive(archiveId);
    await videos.deleteMany({ archiveId: archive._id }, { writeConcern: DURABLE_WRITE });
    await archives.deleteOne({ _id: archive._id }, { writeConcern: DURABLE_WRITE });
    return { id: archive._id.toHexString(), name: archive.name };
  }

  async function importIntoArchive(archiveId, { relPath, mode = "auto" }) {
    const archive = await getArchive(archiveId);
    let sourceRelPath = relPath;
    let extraction = null;

    const resolvedMode = mode === "auto" ? (path.extname(String(relPath)).toLowerCase() === ".zip" ? "zip" : "path") : mode;

    if (resolvedMode === "zip") {
      extraction = await media.extractZip(relPath, path.join("_extracted", archive._id.toHexString()));
      sourceRelPath = extraction.destRelPath;
    }

    const discovered = await media.scanVideos(sourceRelPath);
    if (discovered.length === 0) {
      return { archiveId: archive._id.toHexString(), discovered: 0, added: 0, skipped: 0, extraction, videos: [] };
    }

    const existing = await videos
      .find({ archiveId: archive._id, relPath: { $in: discovered.map((item) => item.relPath) } })
      .project({ relPath: 1 })
      .toArray();
    const existingPaths = new Set(existing.map((doc) => doc.relPath));

    const fresh = discovered.filter((item) => !existingPaths.has(item.relPath));
    if (fresh.length === 0) {
      return {
        archiveId: archive._id.toHexString(),
        discovered: discovered.length,
        added: 0,
        skipped: discovered.length,
        extraction,
        videos: [],
      };
    }

    const hasFfmpeg = await media.ffmpegAvailable();
    const { start } = await counters.reserveBlock(`archive:${archive._id.toHexString()}:seq`, fresh.length);
    const now = new Date();
    const documents = [];

    for (const [index, item] of fresh.entries()) {
      const seq = start + index;
      let thumbnail = await media.findSiblingThumbnail(item.relPath);

      if (!thumbnail && hasFfmpeg) {
        try {
          thumbnail = await media.generateThumbnail(
            item.relPath,
            path.join("_thumbs", archive._id.toHexString(), `${seq}.jpg`),
          );
        } catch {
          thumbnail = null;
        }
      }

      documents.push({
        archiveId: archive._id,
        categoryCode: archive.categoryCode,
        seq,
        title: item.title,
        fileName: item.fileName,
        relPath: item.relPath,
        sizeBytes: item.sizeBytes,
        mimeType: item.mimeType,
        playable: item.playable,
        durationSeconds: hasFfmpeg ? await media.probeDuration(item.relPath) : null,
        thumbRelPath: thumbnail?.relPath ?? null,
        thumbMimeType: thumbnail?.mimeType ?? null,
        viewCount: 0,
        likeCount: 0,
        createdAt: now,
      });
    }

    let added = 0;
    for (let offset = 0; offset < documents.length; offset += IMPORT_BATCH_SIZE) {
      const batch = documents.slice(offset, offset + IMPORT_BATCH_SIZE);
      try {
        const result = await videos.insertMany(batch, { ordered: false, writeConcern: DURABLE_WRITE });
        added += result.insertedCount;
      } catch (error) {
        if (error?.code === DUPLICATE_KEY_ERROR || error?.writeErrors) {
          added += error.result?.insertedCount ?? error.insertedCount ?? 0;
        } else {
          throw error;
        }
      }
    }

    await archives.updateOne(
      { _id: archive._id },
      { $inc: { videoCount: added }, $set: { lastImportAt: now } },
      { writeConcern: DURABLE_WRITE },
    );

    return {
      archiveId: archive._id.toHexString(),
      discovered: discovered.length,
      added,
      skipped: discovered.length - added,
      notPlayable: documents.filter((doc) => !doc.playable).length,
      extraction,
    };
  }

  function shapeVideo(doc, { progress, liked } = {}) {
    return {
      id: doc._id.toHexString(),
      archiveId: doc.archiveId.toHexString(),
      number: doc.seq,
      displayId: `#${doc.seq}`,
      title: doc.title,
      durationSeconds: doc.durationSeconds ?? null,
      sizeBytes: doc.sizeBytes,
      playable: doc.playable !== false,
      hasThumbnail: Boolean(doc.thumbRelPath),
      viewCount: doc.viewCount ?? 0,
      likeCount: doc.likeCount ?? 0,
      liked: Boolean(liked),
      progressSeconds: progress?.positionSeconds ?? 0,
      progressPercent: progress?.percent ?? 0,
      completed: Boolean(progress?.completed),
    };
  }

  async function listVideos(archiveId, { sort = "popular", limit = 60, skip = 0 } = {}) {
    const archive = await getArchive(archiveId);
    const sortSpec =
      sort === "number"
        ? { seq: 1 }
        : sort === "newest"
          ? { createdAt: -1, seq: 1 }
          : sort === "liked"
            ? { likeCount: -1, seq: 1 }
            : { viewCount: -1, seq: 1 };

    const [docs, total] = await Promise.all([
      videos.find({ archiveId: archive._id }).sort(sortSpec).skip(skip).limit(Math.min(limit, 200)).toArray(),
      videos.countDocuments({ archiveId: archive._id }),
    ]);

    return { archive: shapeArchive(archive), total, docs };
  }

  async function getVideo(videoId) {
    const doc = await videos.findOne({ _id: toObjectId(videoId) });
    if (!doc) throw notFound("Video not found");
    return doc;
  }

  async function findVideosByIds(ids) {
    if (ids.length === 0) return [];
    return videos.find({ _id: { $in: ids.map((id) => toObjectId(id)) } }).toArray();
  }

  async function resolveVideoFile(video) {
    return media.statFile(video.relPath);
  }

  async function resolveThumbFile(video) {
    return media.statFile(video.thumbRelPath);
  }

  async function totals() {
    const [categoryCount, archiveCount, videoCount, sizeAgg] = await Promise.all([
      categories.countDocuments(),
      archives.countDocuments(),
      videos.countDocuments(),
      videos.aggregate([{ $group: { _id: null, bytes: { $sum: "$sizeBytes" } } }]).toArray(),
    ]);
    return { categoryCount, archiveCount, videoCount, totalBytes: sizeAgg[0]?.bytes ?? 0 };
  }

  return {
    createCategory,
    renameCategory,
    listCategories,
    getCategoryByCode,
    createArchive,
    listArchives,
    getArchive,
    deleteArchive,
    importIntoArchive,
    listVideos,
    getVideo,
    findVideosByIds,
    shapeVideo,
    shapeArchive,
    resolveVideoFile,
    resolveThumbFile,
    totals,
  };
}

export { createCatalogService, slugify };
