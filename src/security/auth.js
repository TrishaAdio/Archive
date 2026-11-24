import { constantTimeEquals, signPayload, verifySignature } from "../lib/crypto.js";
import { clientIp, ipFingerprint } from "../lib/ip.js";
import { forbidden, unauthorized } from "../lib/errors.js";

const ADMIN_COOKIE = "gp_admin";

const SESSION_ENDING_REASONS = new Set([
  "key_missing",
  "subscription_revoked",
  "subscription_expired",
  "plan_not_started",
]);

function createAuthMiddleware({ config, accessKeys, sessions }) {
  function resolveIp(req) {
    const ip = clientIp(req, config.trustProxyHops);
    return { ip, fingerprint: ipFingerprint(ip, config.ipMatchMode) };
  }

  async function loadSession(req) {
    const sessionId = sessions.parseCookie(req.cookies?.[sessions.SESSION_COOKIE]);
    if (!sessionId) return null;

    const session = await sessions.find(sessionId);
    if (!session) return null;

    const keyDoc = await accessKeys.findById(session.keyId);
    if (!keyDoc) return { session, reason: "key_missing" };
    if (keyDoc.revoked) return { session, reason: "subscription_revoked" };

    const now = new Date();
    if (keyDoc.planStartsAt > now) return { session, reason: "plan_not_started" };
    if (keyDoc.planExpiresAt <= now) return { session, reason: "subscription_expired" };

    const { ip, fingerprint } = resolveIp(req);
    if (session.ipFingerprint !== fingerprint) return { session, reason: "ip_mismatch" };
    if (keyDoc.boundIp && keyDoc.boundIp !== fingerprint) return { session, reason: "ip_mismatch" };

    return { session, keyDoc, ip, fingerprint };
  }

  async function requireSession(req, res, next) {
    try {
      const result = await loadSession(req);

      if (!result) throw unauthorized("Enter your access key to continue");

      if (result.reason) {
        if (SESSION_ENDING_REASONS.has(result.reason)) {
          await sessions.destroy(result.session._id);
        }
        res.clearCookie(sessions.SESSION_COOKIE, cookieOptions(config, 0));
        throw forbidden(result.reason, reasonMessage(result.reason));
      }

      req.viewer = {
        sessionId: result.session._id,
        keyId: result.keyDoc._id,
        keyHint: result.keyDoc.keyHint,
        categoryCode: result.keyDoc.categoryCode,
        planStartsAt: result.keyDoc.planStartsAt,
        planExpiresAt: result.keyDoc.planExpiresAt,
        ip: result.ip,
        ipFingerprint: result.fingerprint,
      };
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireAdmin(req, res, next) {
    const header = req.get("authorization") ?? "";
    const [scheme, bearer] = header.split(" ");

    if (scheme === "Bearer" && bearer && constantTimeEquals(bearer, config.adminToken)) return next();

    const cookie = req.cookies?.[ADMIN_COOKIE];
    if (typeof cookie === "string") {
      const separator = cookie.lastIndexOf(".");
      const issuedAt = Number(cookie.slice(0, separator));
      const signature = cookie.slice(separator + 1);
      const fresh = Number.isInteger(issuedAt) && Date.now() - issuedAt < config.sessionTtlHours * 3600 * 1000;

      if (fresh && verifySignature(config.sessionSecret, `admin:${issuedAt}`, signature)) return next();
    }

    next(unauthorized("Admin authentication required"));
  }

  function issueAdminCookie() {
    const issuedAt = Date.now();
    return `${issuedAt}.${signPayload(config.sessionSecret, `admin:${issuedAt}`)}`;
  }

  return { requireSession, requireAdmin, resolveIp, loadSession, issueAdminCookie };
}

function reasonMessage(reason) {
  switch (reason) {
    case "ip_mismatch":
      return "This access key is locked to the network it was first used on. Entry from a different IP address is blocked.";
    case "subscription_expired":
      return "This subscription has expired.";
    case "subscription_revoked":
      return "This subscription has been cancelled by the owner.";
    case "plan_not_started":
      return "This subscription has not started yet.";
    default:
      return "Access denied.";
  }
}

function cookieOptions(config, maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    path: "/",
    ...(maxAgeMs === 0 ? {} : { maxAge: maxAgeMs }),
  };
}

export { ADMIN_COOKIE, cookieOptions, createAuthMiddleware, reasonMessage };
