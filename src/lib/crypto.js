import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest();
}

function constantTimeEquals(a, b) {
  return timingSafeEqual(sha256Buffer(String(a)), sha256Buffer(String(b)));
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function signPayload(secret, payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function verifySignature(secret, payload, signature) {
  const expected = signPayload(secret, payload);
  if (expected.length !== String(signature).length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
}

function issueStreamToken({ secret, sessionId, videoId, ipFingerprint, ttlSeconds }) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = [sessionId, videoId, ipFingerprint ?? "", expiresAt].join("|");
  return `${expiresAt}.${signPayload(secret, payload)}`;
}

function verifyStreamToken({ secret, token, sessionId, videoId, ipFingerprint }) {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const separator = token.indexOf(".");
  const expiresAt = Number(token.slice(0, separator));
  const signature = token.slice(separator + 1);

  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;

  const payload = [sessionId, videoId, ipFingerprint ?? "", expiresAt].join("|");
  return verifySignature(secret, payload, signature);
}

export {
  constantTimeEquals,
  issueStreamToken,
  randomToken,
  sha256Hex,
  signPayload,
  verifySignature,
  verifyStreamToken,
};
