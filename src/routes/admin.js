import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { ObjectId } from "mongodb";
import { constantTimeEquals } from "../lib/crypto.js";
import { ADMIN_COOKIE, cookieOptions } from "../security/auth.js";
import { badRequest, unauthorized } from "../lib/errors.js";

function createAdminRouter({ config, accessKeys, sessions, catalog, media, broadcasts, auth, audit, collections }) {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many login attempts. Wait 15 minutes." },
  });

  router.post("/login", loginLimiter, async (req, res, next) => {
    try {
      const token = req.body?.token;
      if (typeof token !== "string" || !constantTimeEquals(token, config.adminToken)) {
        await audit("admin.login.failed", { ip: auth.resolveIp(req).ip });
        throw unauthorized("Invalid admin token");
      }

      res.cookie(ADMIN_COOKIE, auth.issueAdminCookie(), cookieOptions(config, config.sessionTtlHours * 3600 * 1000));
      await audit("admin.login.ok", { ip: auth.resolveIp(req).ip });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(ADMIN_COOKIE, cookieOptions(config, 0));
    res.json({ ok: true });
  });

  router.use(auth.requireAdmin);

  router.get("/overview", async (req, res, next) => {
    try {
      const [liveViewers, activeSubscriptions, totals, hasFfmpeg, broadcastList] = await Promise.all([
        sessions.countLive(),
        accessKeys.countActive(),
        catalog.totals(),
        media.ffmpegAvailable(),
        broadcasts.list(5),
      ]);

      res.set("Cache-Control", "no-store").json({
        liveViewers,
        activeSubscriptions,
        ...totals,
        mediaRoot: config.mediaRoot,
        ipMatchMode: config.ipMatchMode,
        ffmpegAvailable: hasFfmpeg,
        activeBroadcast: broadcastList.find((item) => item.active) ?? null,
        presenceWindowSeconds: config.presenceWindowSeconds,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/live", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json({ viewers: await sessions.listLive(100) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/files", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json(await media.listDirectory(req.query.path ?? ""));
    } catch (error) {
      next(error);
    }
  });

  router.get("/categories", async (req, res, next) => {
    try {
      res.json({ categories: await catalog.listCategories() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/categories", async (req, res, next) => {
    try {
      const category = await catalog.createCategory({ code: req.body?.code, name: req.body?.name });
      await audit("category.create", { code: category.code, name: category.name });
      res.status(201).json(category);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/categories/:code", async (req, res, next) => {
    try {
      res.json(await catalog.renameCategory(req.params.code, req.body?.name));
    } catch (error) {
      next(error);
    }
  });

  router.get("/archives", async (req, res, next) => {
    try {
      res.json({ archives: await catalog.listArchives(req.query.categoryCode) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/archives", async (req, res, next) => {
    try {
      const archive = await catalog.createArchive({
        categoryCode: req.body?.categoryCode,
        name: req.body?.name,
        description: req.body?.description,
      });
      await audit("archive.create", { archiveId: archive.id, name: archive.name });
      res.status(201).json(archive);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/archives/:archiveId", async (req, res, next) => {
    try {
      const removed = await catalog.deleteArchive(req.params.archiveId);
      await audit("archive.delete", removed);
      res.json({ ok: true, ...removed });
    } catch (error) {
      next(error);
    }
  });

  router.post("/archives/:archiveId/import", async (req, res, next) => {
    try {
      const relPath = req.body?.relPath;
      if (typeof relPath !== "string") throw badRequest("relPath is required");

      const mode = ["auto", "zip", "path"].includes(req.body?.mode) ? req.body.mode : "auto";
      const result = await catalog.importIntoArchive(req.params.archiveId, { relPath, mode });
      await audit("archive.import", { archiveId: req.params.archiveId, relPath, added: result.added });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/archives/:archiveId/videos", async (req, res, next) => {
    try {
      const skip = Math.max(0, Number(req.query.skip) || 0);
      const { docs, archive, total } = await catalog.listVideos(req.params.archiveId, {
        sort: req.query.sort ?? "number",
        skip,
        limit: Math.min(200, Number(req.query.limit) || 50),
      });
      res.json({ archive, total, skip, videos: docs.map((doc) => catalog.shapeVideo(doc)) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/keys", async (req, res, next) => {
    try {
      const result = await accessKeys.list({
        status: req.query.status,
        categoryCode: req.query.categoryCode,
        search: req.query.search,
        limit: Number(req.query.limit) || 50,
        skip: Math.max(0, Number(req.query.skip) || 0),
      });
      res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/keys", async (req, res, next) => {
    try {
      const created = await accessKeys.create(req.body);
      await audit("key.create", { keyId: created.id, categoryCode: created.categoryCode });
      res.status(201).set("Cache-Control", "no-store").json(created);
    } catch (error) {
      next(error);
    }
  });

  router.post("/keys/:keyId/expire", async (req, res, next) => {
    try {
      const key = await accessKeys.expireNow(req.params.keyId);
      const kicked = await sessions.destroyForKey(toId(key.id));
      await audit("key.expire", { keyId: key.id, kickedSessions: kicked });
      res.json({ ...key, kickedSessions: kicked });
    } catch (error) {
      next(error);
    }
  });

  router.post("/keys/:keyId/extend", async (req, res, next) => {
    try {
      const key = await accessKeys.extend(req.params.keyId, Number(req.body?.additionalDays));
      await audit("key.extend", { keyId: key.id, additionalDays: req.body?.additionalDays });
      res.json(key);
    } catch (error) {
      next(error);
    }
  });

  router.post("/keys/:keyId/release-ip", async (req, res, next) => {
    try {
      const key = await accessKeys.releaseIpBinding(req.params.keyId);
      const kicked = await sessions.destroyForKey(toId(key.id));
      await audit("key.releaseIp", { keyId: key.id });
      res.json({ ...key, kickedSessions: kicked });
    } catch (error) {
      next(error);
    }
  });

  router.get("/broadcasts", async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store").json({ broadcasts: await broadcasts.list(25) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/broadcasts", async (req, res, next) => {
    try {
      const broadcast = await broadcasts.create({
        title: req.body?.title,
        message: req.body?.message,
        categoryCode: req.body?.categoryCode ?? null,
      });
      await audit("broadcast.create", { broadcastId: broadcast.id });
      res.status(201).json(broadcast);
    } catch (error) {
      next(error);
    }
  });

  router.post("/broadcasts/:broadcastId/deactivate", async (req, res, next) => {
    try {
      res.json(await broadcasts.deactivate(req.params.broadcastId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/audit", async (req, res, next) => {
    try {
      const entries = await collections.auditLog.find().sort({ createdAt: -1 }).limit(100).toArray();
      res.set("Cache-Control", "no-store").json({
        entries: entries.map((entry) => ({
          action: entry.action,
          detail: entry.detail,
          createdAt: entry.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function toId(hex) {
  return new ObjectId(hex);
}

export { createAdminRouter };
