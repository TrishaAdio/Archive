import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { cookieOptions } from "../security/auth.js";
import { badRequest, forbidden } from "../lib/errors.js";

function createGateRouter({ config, accessKeys, sessions, catalog, auth, audit }) {
  const router = Router();

  const redeemLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts. Wait a few minutes and try again." },
  });

  router.post("/redeem", redeemLimiter, async (req, res, next) => {
    try {
      const plainKey = req.body?.key;
      if (typeof plainKey !== "string" || plainKey.trim().length === 0) {
        throw badRequest("Enter your access key");
      }

      const { ip, fingerprint } = auth.resolveIp(req);
      const keyDoc = await accessKeys.findByPlainKey(plainKey);

      if (!keyDoc) {
        await audit("gate.reject", { reason: "unknown_key", ip });
        throw forbidden("invalid_key", "That access key is not valid.");
      }

      const now = new Date();
      if (keyDoc.revoked) {
        await audit("gate.reject", { reason: "revoked", keyId: keyDoc._id, ip });
        throw forbidden("subscription_revoked", "This subscription has been cancelled by the owner.");
      }
      if (keyDoc.planStartsAt > now) {
        throw forbidden("plan_not_started", `This subscription starts on ${keyDoc.planStartsAt.toISOString().slice(0, 10)}.`);
      }
      if (keyDoc.planExpiresAt <= now) {
        await audit("gate.reject", { reason: "expired", keyId: keyDoc._id, ip });
        throw forbidden("subscription_expired", "This subscription has expired.");
      }

      const claim = await accessKeys.claimIp(keyDoc._id, fingerprint);
      if (!claim.ok) {
        await audit("gate.reject", {
          reason: "ip_mismatch",
          keyId: keyDoc._id,
          ip,
          boundIp: claim.key?.boundIp ?? null,
        });
        throw forbidden(
          "ip_mismatch",
          "This access key is already locked to a different network. Entry is blocked even though the key is correct.",
        );
      }

      const session = await sessions.start({
        keyDoc: claim.key,
        ipFingerprint: fingerprint,
        userAgent: req.get("user-agent"),
      });

      res.cookie(
        sessions.SESSION_COOKIE,
        session.cookieValue,
        cookieOptions(config, session.expiresAt.getTime() - Date.now()),
      );

      await audit("gate.accept", { keyId: keyDoc._id, ip, boundNow: claim.boundNow });

      const category = await catalog.getCategoryByCode(claim.key.categoryCode);
      res.set("Cache-Control", "no-store").json({
        ok: true,
        boundNow: claim.boundNow,
        viewer: {
          keyHint: claim.key.keyHint,
          categoryCode: claim.key.categoryCode,
          categoryName: category?.name ?? null,
          planStartsAt: claim.key.planStartsAt.toISOString(),
          planExpiresAt: claim.key.planExpiresAt.toISOString(),
          lockedIp: fingerprint,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const sessionId = sessions.parseCookie(req.cookies?.[sessions.SESSION_COOKIE]);
      if (sessionId) await sessions.destroy(sessionId);
      res.clearCookie(sessions.SESSION_COOKIE, cookieOptions(config, 0));
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/me", auth.requireSession, async (req, res, next) => {
    try {
      const category = await catalog.getCategoryByCode(req.viewer.categoryCode);
      res.set("Cache-Control", "no-store").json({
        keyHint: req.viewer.keyHint,
        categoryCode: req.viewer.categoryCode,
        categoryName: category?.name ?? null,
        planExpiresAt: req.viewer.planExpiresAt.toISOString(),
        lockedIp: req.viewer.ipFingerprint,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export { createGateRouter };
