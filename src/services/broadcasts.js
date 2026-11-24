import { DURABLE_WRITE } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { toObjectId } from "./accessKeys.js";

function createBroadcastService({ broadcasts, broadcastAcks }) {
  async function create({ title, message, categoryCode = null, createdBy = "admin" }) {
    if (typeof message !== "string" || message.trim().length < 2 || message.length > 1000) {
      throw badRequest("message must be between 2 and 1000 characters");
    }
    if (title !== undefined && title !== null && (typeof title !== "string" || title.length > 120)) {
      throw badRequest("title must be a string of at most 120 characters");
    }

    await broadcasts.updateMany({ active: true }, { $set: { active: false, deactivatedAt: new Date() } });

    const document = {
      title: title?.trim() || "Announcement",
      message: message.trim(),
      categoryCode: categoryCode ? String(categoryCode) : null,
      active: true,
      createdBy,
      createdAt: new Date(),
      deactivatedAt: null,
    };

    const result = await broadcasts.insertOne(document, { writeConcern: DURABLE_WRITE });
    return shape({ ...document, _id: result.insertedId }, 0);
  }

  function shape(doc, ackCount) {
    return {
      id: doc._id.toHexString(),
      title: doc.title,
      message: doc.message,
      categoryCode: doc.categoryCode ?? null,
      active: Boolean(doc.active),
      ackCount,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  async function activeFor({ keyId, categoryCode }) {
    const active = await broadcasts.findOne(
      { active: true, $or: [{ categoryCode: null }, { categoryCode: String(categoryCode) }] },
      { sort: { createdAt: -1 } },
    );
    if (!active) return null;

    const acked = await broadcastAcks.findOne({ broadcastId: active._id, keyId });
    if (acked) return null;

    return { id: active._id.toHexString(), title: active.title, message: active.message, createdAt: active.createdAt.toISOString() };
  }

  async function acknowledge({ broadcastId, keyId }) {
    const id = toObjectId(broadcastId);
    try {
      await broadcastAcks.insertOne({ broadcastId: id, keyId, ackedAt: new Date() }, { writeConcern: DURABLE_WRITE });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    return { acknowledged: true };
  }

  async function list(limit = 25) {
    const docs = await broadcasts.find().sort({ createdAt: -1 }).limit(limit).toArray();
    if (docs.length === 0) return [];

    const counts = await broadcastAcks
      .aggregate([{ $match: { broadcastId: { $in: docs.map((doc) => doc._id) } } }, { $group: { _id: "$broadcastId", total: { $sum: 1 } } }])
      .toArray();
    const byId = new Map(counts.map((entry) => [entry._id.toHexString(), entry.total]));

    return docs.map((doc) => shape(doc, byId.get(doc._id.toHexString()) ?? 0));
  }

  async function deactivate(broadcastId) {
    const updated = await broadcasts.findOneAndUpdate(
      { _id: toObjectId(broadcastId) },
      { $set: { active: false, deactivatedAt: new Date() } },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    if (!updated) throw notFound("Broadcast not found");
    return shape(updated, 0);
  }

  return { create, activeFor, acknowledge, list, deactivate };
}

export { createBroadcastService };
