import { randomBytes } from "node:crypto";
import { DURABLE_WRITE } from "../db.js";
import { sha256Hex, signPayload, verifySignature } from "../lib/crypto.js";

const SESSION_COOKIE = "gp_session";
const HOUR_MS = 60 * 60 * 1000;

function createSessionService(sessions, config) {
  async function start({ keyDoc, ipFingerprint, userAgent }) {
    const sessionId = randomBytes(24).toString("hex");
    const now = new Date();
    const hardExpiry = new Date(now.getTime() + config.sessionTtlHours * HOUR_MS);
    const expiresAt = keyDoc.planExpiresAt < hardExpiry ? keyDoc.planExpiresAt : hardExpiry;

    await sessions.insertOne(
      {
        _id: sessionId,
        keyId: keyDoc._id,
        keyHint: keyDoc.keyHint,
        categoryCode: keyDoc.categoryCode,
        ipFingerprint,
        userAgentHash: sha256Hex(String(userAgent ?? "")),
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      },
      { writeConcern: DURABLE_WRITE },
    );

    return { sessionId, cookieValue: `${sessionId}.${signPayload(config.sessionSecret, sessionId)}`, expiresAt };
  }

  function parseCookie(rawCookie) {
    if (typeof rawCookie !== "string") return null;
    const separator = rawCookie.lastIndexOf(".");
    if (separator <= 0) return null;

    const sessionId = rawCookie.slice(0, separator);
    const signature = rawCookie.slice(separator + 1);
    if (!/^[a-f0-9]{48}$/.test(sessionId)) return null;
    if (!verifySignature(config.sessionSecret, sessionId, signature)) return null;
    return sessionId;
  }

  async function find(sessionId) {
    const session = await sessions.findOne({ _id: sessionId });
    if (!session) return null;
    if (session.expiresAt <= new Date()) return null;
    return session;
  }

  async function heartbeat(sessionId) {
    await sessions.updateOne({ _id: sessionId }, { $set: { lastSeenAt: new Date() } });
  }

  async function destroy(sessionId) {
    await sessions.deleteOne({ _id: sessionId });
  }

  async function destroyForKey(keyId) {
    const result = await sessions.deleteMany({ keyId }, { writeConcern: DURABLE_WRITE });
    return result.deletedCount;
  }

  async function countLive() {
    const since = new Date(Date.now() - config.presenceWindowSeconds * 1000);
    return sessions.countDocuments({ lastSeenAt: { $gte: since } });
  }

  async function listLive(limit = 100) {
    const since = new Date(Date.now() - config.presenceWindowSeconds * 1000);
    const docs = await sessions
      .find({ lastSeenAt: { $gte: since } })
      .sort({ lastSeenAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map((doc) => ({
      keyHint: doc.keyHint,
      categoryCode: doc.categoryCode,
      ipFingerprint: doc.ipFingerprint,
      startedAt: doc.createdAt.toISOString(),
      lastSeenAt: doc.lastSeenAt.toISOString(),
    }));
  }

  return { start, parseCookie, find, heartbeat, destroy, destroyForKey, countLive, listLive, SESSION_COOKIE };
}

export { createSessionService, SESSION_COOKIE };
