import { Router } from "express";
import { forbidden, notFound } from "../lib/errors.js";

function createCatalogRouter({ catalog, engagement }) {
  const router = Router();

  async function assertVisible(archive, viewer) {
    if (archive.categoryCode !== viewer.categoryCode) {
      throw forbidden("category_mismatch", "Your access key does not include this archive.");
    }
  }

  router.get("/home", async (req, res, next) => {
    try {
      const { categoryCode } = req.viewer;
      const [category, archives, resumeDocs] = await Promise.all([
        catalog.getCategoryByCode(categoryCode),
        catalog.listArchives(categoryCode),
        engagement.continueWatching(req.viewer.keyId, 12),
      ]);

      const resumeVideos = await catalog.findVideosByIds(resumeDocs.map((doc) => doc.videoId));
      const resumeById = new Map(resumeVideos.map((doc) => [doc._id.toHexString(), doc]));
      const progressById = new Map(resumeDocs.map((doc) => [doc.videoId.toHexString(), doc]));

      const continueWatching = resumeDocs
        .map((doc) => {
          const video = resumeById.get(doc.videoId.toHexString());
          if (!video || video.categoryCode !== categoryCode) return null;
          return {
            ...catalog.shapeVideo(video, { progress: progressById.get(doc.videoId.toHexString()) }),
            archiveName: archives.find((archive) => archive.id === video.archiveId.toHexString())?.name ?? null,
          };
        })
        .filter(Boolean);

      const covers = await catalog.coversForArchives(archives.map((archive) => catalog.toArchiveObjectId(archive.id)));

      res.set("Cache-Control", "no-store").json({
        category: category ? { code: category.code, name: category.name } : { code: categoryCode, name: null },
        archives: archives.map((archive) => ({ ...archive, coverVideoIds: covers.get(archive.id) ?? [] })),
        continueWatching,
        viewer: {
          keyHint: req.viewer.keyHint,
          planStartsAt: req.viewer.planStartsAt.toISOString(),
          planExpiresAt: req.viewer.planExpiresAt.toISOString(),
          lockedIp: req.viewer.ipFingerprint,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/archives/:archiveId/videos", async (req, res, next) => {
    try {
      const sort = ["popular", "number", "newest", "liked"].includes(req.query.sort) ? req.query.sort : "popular";
      const skip = Math.max(0, Number(req.query.skip) || 0);
      const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 30));

      const archive = await catalog.getArchive(req.params.archiveId);
      await assertVisible(archive, req.viewer);

      const query = typeof req.query.q === "string" ? req.query.q : "";
      const { docs, total } = await catalog.listVideos(archive._id, { sort, skip, limit, query });
      const videoIds = docs.map((doc) => doc._id);

      const [progressMap, likedSet] = await Promise.all([
        engagement.progressForVideos(req.viewer.keyId, videoIds),
        engagement.likedVideoIds(req.viewer.keyId, videoIds),
      ]);

      res.set("Cache-Control", "no-store").json({
        archive: catalog.shapeArchive(archive),
        sort,
        skip,
        limit,
        total,
        videos: docs.map((doc) =>
          catalog.shapeVideo(doc, {
            progress: progressMap.get(doc._id.toHexString()),
            liked: likedSet.has(doc._id.toHexString()),
          }),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/videos/:videoId", async (req, res, next) => {
    try {
      const video = await catalog.getVideo(req.params.videoId);
      if (video.categoryCode !== req.viewer.categoryCode) throw notFound("Video not found");

      const [progressMap, likedSet] = await Promise.all([
        engagement.progressForVideos(req.viewer.keyId, [video._id]),
        engagement.likedVideoIds(req.viewer.keyId, [video._id]),
      ]);

      const archive = await catalog.getArchive(video.archiveId);

      res.set("Cache-Control", "no-store").json({
        ...catalog.shapeVideo(video, {
          progress: progressMap.get(video._id.toHexString()),
          liked: likedSet.has(video._id.toHexString()),
        }),
        archive: catalog.shapeArchive(archive),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export { createCatalogRouter };
