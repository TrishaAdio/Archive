import { DURABLE_WRITE } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { toObjectId } from "./accessKeys.js";

function createEngagementService({ progress, likes, viewMarks, videos }, config) {
  async function saveProgress({ keyId, videoId, positionSeconds, durationSeconds }) {
    const position = Number(positionSeconds);
    if (!Number.isFinite(position) || position < 0) throw badRequest("positionSeconds must be a non-negative number");

    const duration = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0 ? Number(durationSeconds) : null;
    const clamped = duration ? Math.min(position, duration) : position;
    const percent = duration ? Math.min(100, Math.round((clamped / duration) * 100)) : 0;
    const videoObjectId = toObjectId(videoId);
    const now = new Date();

    await progress.updateOne(
      { keyId, videoId: videoObjectId },
      {
        $set: {
          positionSeconds: Math.round(clamped),
          durationSeconds: duration ? Math.round(duration) : null,
          percent,
          completed: percent >= 95,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, writeConcern: DURABLE_WRITE },
    );

    if (duration) {
      await videos.updateOne({ _id: videoObjectId, durationSeconds: null }, { $set: { durationSeconds: Math.round(duration) } });
    }

    return { positionSeconds: Math.round(clamped), percent, completed: percent >= 95 };
  }

  async function progressForVideos(keyId, videoObjectIds) {
    if (videoObjectIds.length === 0) return new Map();
    const docs = await progress.find({ keyId, videoId: { $in: videoObjectIds } }).toArray();
    return new Map(docs.map((doc) => [doc.videoId.toHexString(), doc]));
  }

  async function likedVideoIds(keyId, videoObjectIds) {
    if (videoObjectIds.length === 0) return new Set();
    const docs = await likes.find({ keyId, videoId: { $in: videoObjectIds } }).project({ videoId: 1 }).toArray();
    return new Set(docs.map((doc) => doc.videoId.toHexString()));
  }

  async function toggleLike({ keyId, videoId }) {
    const videoObjectId = toObjectId(videoId);
    const removed = await likes.findOneAndDelete({ keyId, videoId: videoObjectId }, { writeConcern: DURABLE_WRITE });

    if (removed) {
      const updated = await videos.findOneAndUpdate(
        { _id: videoObjectId },
        { $inc: { likeCount: -1 } },
        { returnDocument: "after", writeConcern: DURABLE_WRITE },
      );
      return { liked: false, likeCount: Math.max(0, updated?.likeCount ?? 0) };
    }

    await likes.insertOne({ keyId, videoId: videoObjectId, createdAt: new Date() }, { writeConcern: DURABLE_WRITE });
    const updated = await videos.findOneAndUpdate(
      { _id: videoObjectId },
      { $inc: { likeCount: 1 } },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    return { liked: true, likeCount: updated?.likeCount ?? 1 };
  }

  async function registerView({ keyId, videoId }) {
    const videoObjectId = toObjectId(videoId);
    const expiresAt = new Date(Date.now() + config.viewDedupeHours * 60 * 60 * 1000);

    try {
      await viewMarks.insertOne({ keyId, videoId: videoObjectId, createdAt: new Date(), expiresAt });
    } catch (error) {
      if (error?.code === 11000) return { counted: false };
      throw error;
    }

    await videos.updateOne({ _id: videoObjectId }, { $inc: { viewCount: 1 } }, { writeConcern: DURABLE_WRITE });
    return { counted: true };
  }

  async function continueWatching(keyId, limit = 12) {
    return progress
      .find({
        keyId,
        completed: false,
        positionSeconds: { $gte: 3 },
        $or: [{ percent: { $gte: 2 } }, { positionSeconds: { $gte: 60 } }],
      })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
  }

  return { saveProgress, progressForVideos, likedVideoIds, toggleLike, registerView, continueWatching };
}

export { createEngagementService };
