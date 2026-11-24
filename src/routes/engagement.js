import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { notFound } from "../lib/errors.js";

function createEngagementRouter({ catalog, engagement, sessions, broadcasts }) {
  const router = Router();

  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 240,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  async function ownedVideo(req) {
    const video = await catalog.getVideo(req.params.videoId);
    if (video.categoryCode !== req.viewer.categoryCode) throw notFound("Video not found");
    return video;
  }

  router.post("/videos/:videoId/progress", writeLimiter, async (req, res, next) => {
    try {
      const video = await ownedVideo(req);
      const result = await engagement.saveProgress({
        keyId: req.viewer.keyId,
        videoId: video._id,
        positionSeconds: req.body?.positionSeconds,
        durationSeconds: req.body?.durationSeconds,
      });
      res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/videos/:videoId/like", writeLimiter, async (req, res, next) => {
    try {
      const video = await ownedVideo(req);
      const result = await engagement.toggleLike({ keyId: req.viewer.keyId, videoId: video._id });
      res.set("Cache-Control", "no-store").json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/presence", writeLimiter, async (req, res, next) => {
    try {
      await sessions.heartbeat(req.viewer.sessionId);
      const broadcast = await broadcasts.activeFor({
        keyId: req.viewer.keyId,
        categoryCode: req.viewer.categoryCode,
      });

      res.set("Cache-Control", "no-store").json({
        serverTime: new Date().toISOString(),
        planExpiresAt: req.viewer.planExpiresAt.toISOString(),
        broadcast,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/broadcasts/:broadcastId/ack", writeLimiter, async (req, res, next) => {
    try {
      const result = await broadcasts.acknowledge({
        broadcastId: req.params.broadcastId,
        keyId: req.viewer.keyId,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export { createEngagementRouter };
