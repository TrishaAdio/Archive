import path from "node:path";

function required(name, { minLength = 0 } = {}) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters long`);
  }
  return value;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function loadConfig() {
  const secrets = {
    adminToken: required("ADMIN_TOKEN", { minLength: 32 }),
    sessionSecret: required("SESSION_SECRET", { minLength: 32 }),
    streamSecret: required("STREAM_SECRET", { minLength: 32 }),
  };

  if (new Set(Object.values(secrets)).size !== 3) {
    throw new Error("ADMIN_TOKEN, SESSION_SECRET and STREAM_SECRET must all differ");
  }

  const ipMatchMode = process.env.IP_MATCH_MODE ?? "strict";
  if (!["strict", "relaxed"].includes(ipMatchMode)) {
    throw new Error('IP_MATCH_MODE must be "strict" or "relaxed"');
  }

  return {
    port: intEnv("PORT", 3000),
    mongoUri: required("MONGODB_URI"),
    mongoDbName: process.env.MONGODB_DB ?? "getpleasure",
    ...secrets,
    mediaRoot: path.resolve(required("MEDIA_ROOT")),
    ipMatchMode,
    trustProxyHops: intEnv("TRUST_PROXY_HOPS", 0),
    sessionTtlHours: intEnv("SESSION_TTL_HOURS", 12),
    streamTokenTtlSeconds: intEnv("STREAM_TOKEN_TTL_SECONDS", 120),
    presenceWindowSeconds: intEnv("PRESENCE_WINDOW_SECONDS", 60),
    viewDedupeHours: intEnv("VIEW_DEDUPE_HOURS", 6),
    maxValidityDays: intEnv("MAX_VALIDITY_DAYS", 3650),
    cookieSecure: (process.env.COOKIE_SECURE ?? "true") !== "false",
    siteName: process.env.SITE_NAME ?? "Get Pleasure",
  };
}

export { loadConfig };
