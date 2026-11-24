import { ObjectId } from "mongodb";
import { randomBytes } from "node:crypto";
import { DURABLE_WRITE } from "../db.js";
import { sha256Hex } from "../lib/crypto.js";
import { badRequest, notFound } from "../lib/errors.js";

const KEY_PREFIX = "GP-";
const KEY_BYTES = 24;
const CATEGORY_CODE_PATTERN = /^\d{1,10}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_INSERT_ATTEMPTS = 3;
const DUPLICATE_KEY_ERROR = 11000;

function generatePlainKey() {
  return KEY_PREFIX + randomBytes(KEY_BYTES).toString("base64url");
}

function publicKeyShape(doc, now = new Date()) {
  const expired = doc.planExpiresAt <= now;
  return {
    id: doc._id.toHexString(),
    keyHint: doc.keyHint,
    label: doc.label ?? null,
    categoryCode: doc.categoryCode,
    validityDays: doc.validityDays,
    planStartsAt: doc.planStartsAt.toISOString(),
    planExpiresAt: doc.planExpiresAt.toISOString(),
    boundIp: doc.boundIp ?? null,
    boundIpAt: doc.boundIpAt?.toISOString() ?? null,
    revoked: Boolean(doc.revoked),
    revokedAt: doc.revokedAt?.toISOString() ?? null,
    lastSeenAt: doc.lastSeenAt?.toISOString() ?? null,
    redeemCount: doc.redeemCount ?? 0,
    createdAt: doc.createdAt.toISOString(),
    status: doc.revoked ? "revoked" : expired ? "expired" : "active",
  };
}

function validateCreateInput(body, { maxValidityDays }) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Body must be a JSON object");
  }

  const errors = [];
  const { validityDays, categoryCode, label, planStartsAt } = body;

  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > maxValidityDays) {
    errors.push({
      field: "validityDays",
      message: `Must be an integer between 1 and ${maxValidityDays}`,
    });
  }

  const normalizedCategory =
    typeof categoryCode === "number" && Number.isInteger(categoryCode) && categoryCode >= 0
      ? String(categoryCode)
      : categoryCode;

  if (typeof normalizedCategory !== "string" || !CATEGORY_CODE_PATTERN.test(normalizedCategory)) {
    errors.push({
      field: "categoryCode",
      message: 'Must be a numeric code of 1 to 10 digits, for example 12 or "12"',
    });
  }

  if (label !== undefined && (typeof label !== "string" || label.length > 120)) {
    errors.push({ field: "label", message: "Must be a string of at most 120 characters" });
  }

  let startsAt = new Date();
  if (planStartsAt !== undefined) {
    const parsed = new Date(planStartsAt);
    if (Number.isNaN(parsed.getTime())) {
      errors.push({ field: "planStartsAt", message: "Must be an ISO 8601 date-time" });
    } else {
      startsAt = parsed;
    }
  }

  if (errors.length > 0) throw badRequest("Validation failed", { details: errors });

  return {
    validityDays,
    categoryCode: normalizedCategory,
    label: label?.trim() || null,
    planStartsAt: startsAt,
  };
}

function createAccessKeyService(accessKeys, config) {
  async function create(body) {
    const input = validateCreateInput(body, config);
    const createdAt = new Date();
    const planExpiresAt = new Date(input.planStartsAt.getTime() + input.validityDays * DAY_MS);

    for (let attempt = 1; attempt <= MAX_INSERT_ATTEMPTS; attempt++) {
      const plainKey = generatePlainKey();
      const document = {
        keyHash: sha256Hex(plainKey),
        keyHint: `${plainKey.slice(0, KEY_PREFIX.length + 4)}…${plainKey.slice(-4)}`,
        label: input.label,
        categoryCode: input.categoryCode,
        validityDays: input.validityDays,
        planStartsAt: input.planStartsAt,
        planExpiresAt,
        boundIp: null,
        boundIpAt: null,
        revoked: false,
        revokedAt: null,
        lastSeenAt: null,
        redeemCount: 0,
        createdAt,
      };

      try {
        const result = await accessKeys.insertOne(document, { writeConcern: DURABLE_WRITE });
        return {
          ...publicKeyShape({ ...document, _id: result.insertedId }, createdAt),
          key: plainKey,
        };
      } catch (error) {
        if (error?.code !== DUPLICATE_KEY_ERROR || attempt === MAX_INSERT_ATTEMPTS) throw error;
      }
    }
  }

  async function findByPlainKey(plainKey) {
    if (typeof plainKey !== "string" || plainKey.length < 8 || plainKey.length > 200) return null;
    return accessKeys.findOne({ keyHash: sha256Hex(plainKey.trim()) });
  }

  async function findById(keyId) {
    return accessKeys.findOne({ _id: toObjectId(keyId) });
  }

  async function claimIp(keyId, fingerprint) {
    const now = new Date();

    const firstClaim = await accessKeys.findOneAndUpdate(
      { _id: keyId, boundIp: null },
      { $set: { boundIp: fingerprint, boundIpAt: now, lastSeenAt: now }, $inc: { redeemCount: 1 } },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    if (firstClaim) return { ok: true, key: firstClaim, boundNow: true };

    const sameIp = await accessKeys.findOneAndUpdate(
      { _id: keyId, boundIp: fingerprint },
      { $set: { lastSeenAt: now }, $inc: { redeemCount: 1 } },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    if (sameIp) return { ok: true, key: sameIp, boundNow: false };

    const current = await accessKeys.findOne({ _id: keyId });
    return { ok: false, key: current, boundNow: false };
  }

  async function touch(keyId) {
    await accessKeys.updateOne({ _id: keyId }, { $set: { lastSeenAt: new Date() } });
  }

  async function list({ status, categoryCode, search, limit = 50, skip = 0 }) {
    const now = new Date();
    const filter = {};

    if (status === "active") Object.assign(filter, { revoked: false, planExpiresAt: { $gt: now } });
    if (status === "expired") Object.assign(filter, { revoked: false, planExpiresAt: { $lte: now } });
    if (status === "revoked") Object.assign(filter, { revoked: true });
    if (categoryCode) filter.categoryCode = String(categoryCode);
    if (search) filter.$or = [{ label: new RegExp(escapeRegex(search), "i") }, { keyHint: new RegExp(escapeRegex(search), "i") }];

    const [items, total] = await Promise.all([
      accessKeys.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 200)).toArray(),
      accessKeys.countDocuments(filter),
    ]);

    return { items: items.map((doc) => publicKeyShape(doc, now)), total };
  }

  async function countActive() {
    return accessKeys.countDocuments({ revoked: false, planExpiresAt: { $gt: new Date() } });
  }

  async function expireNow(keyId) {
    const now = new Date();
    const result = await accessKeys.findOneAndUpdate(
      { _id: toObjectId(keyId) },
      { $set: { planExpiresAt: now, revoked: true, revokedAt: now } },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    if (!result) throw notFound("Access key not found");
    return publicKeyShape(result, now);
  }

  async function extend(keyId, additionalDays) {
    if (!Number.isInteger(additionalDays) || additionalDays < 1 || additionalDays > config.maxValidityDays) {
      throw badRequest(`additionalDays must be an integer between 1 and ${config.maxValidityDays}`);
    }

    const existing = await accessKeys.findOne({ _id: toObjectId(keyId) });
    if (!existing) throw notFound("Access key not found");

    const base = existing.planExpiresAt > new Date() ? existing.planExpiresAt : new Date();
    const result = await accessKeys.findOneAndUpdate(
      { _id: existing._id },
      {
        $set: {
          planExpiresAt: new Date(base.getTime() + additionalDays * DAY_MS),
          revoked: false,
          revokedAt: null,
        },
        $inc: { validityDays: additionalDays },
      },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    return publicKeyShape(result);
  }

  async function releaseIpBinding(keyId) {
    const result = await accessKeys.findOneAndUpdate(
      { _id: toObjectId(keyId) },
      { $set: { boundIp: null, boundIpAt: null } },
      { returnDocument: "after", writeConcern: DURABLE_WRITE },
    );
    if (!result) throw notFound("Access key not found");
    return publicKeyShape(result);
  }

  return {
    create,
    findByPlainKey,
    findById,
    claimIp,
    touch,
    list,
    countActive,
    expireNow,
    extend,
    releaseIpBinding,
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toObjectId(value) {
  if (value instanceof ObjectId) return value;
  if (typeof value === "string" && ObjectId.isValid(value)) return new ObjectId(value);
  throw badRequest("Invalid id");
}

export { createAccessKeyService, publicKeyShape, toObjectId };
