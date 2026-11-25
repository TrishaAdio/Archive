import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SEALED_PREFIX = "v1";

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

function deriveKey(secret, purpose) {
  return Buffer.from(hkdfSync("sha256", secret, "getpleasure", purpose, 32));
}

function sealText(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return [SEALED_PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function openText(key, sealed) {
  const [prefix, iv, tag, encrypted] = String(sealed).split(".");
  if (prefix !== SEALED_PREFIX || !iv || !tag || encrypted === undefined) throw new Error("Sealed value has an unknown format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

export {
  constantTimeEquals,
  deriveKey,
  issueStreamToken,
  openText,
  randomToken,
  sealText,
  sha256Hex,
  signPayload,
  verifySignature,
  verifyStreamToken,
};
