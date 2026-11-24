import { Router } from "express";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { issueStreamToken, verifyStreamToken } from "../lib/crypto.js";
import { forbidden, notFound } from "../lib/errors.js";

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

function parseRange(header, sizeBytes) {
  if (!header) return null;
  const match = RANGE_PATTERN.exec(String(header).trim());
  if (!match) return { invalid: true };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return { invalid: true };

  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    const start = Math.max(0, sizeBytes - suffixLength);
    return { start, end: sizeBytes - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? sizeBytes - 1 : Number(rawEnd);

  if (!Number.isInteger(start) || start < 0 || start >= sizeBytes) return { invalid: true };
  if (!Number.isInteger(end) || end < start) return { invalid: true };

  return { start, end: Math.min(end, sizeBytes - 1) };
}

function placeholderThumbnail(video) {
  const hash = createHash("sha256").update(video._id.toHexString()).digest();
  const hue = (hash[0] * 2) % 360;
  const hue2 = (hue + 48 + (hash[1] % 60)) % 360;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270" role="img" aria-label="Video ${video.seq}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 72% 24%)"/><stop offset="1" stop-color="hsl(${hue2} 68% 12%)"/>
</linearGradient></defs>
<rect width="480" height="270" fill="url(#g)"/>
<circle cx="240" cy="135" r="44" fill="rgba(255,255,255,0.1)"/>
<path d="M226 111 L270 135 L226 159 Z" fill="rgba(255,255,255,0.85)"/>
</svg>`;
}

function createStreamRouter({ config, catalog, engagement }) {
  const router = Router();

  router.post("/videos/:videoId/stream-token", async (req, res, next) => {
    try {
      const video = await catalog.getVideo(req.params.videoId);
      if (video.categoryCode !== req.viewer.categoryCode) throw notFound("Video not found");
      if (video.playable === false) {
        throw forbidden("not_playable", "This file needs transcoding to MP4 or WebM before it can play in a browser.");
      }

      const view = await engagement.registerView({ keyId: req.viewer.keyId, videoId: video._id });

      const token = issueStreamToken({
        secret: config.streamSecret,
        sessionId: req.viewer.sessionId,
        videoId: video._id.toHexString(),
        ipFingerprint: req.viewer.ipFingerprint,
        ttlSeconds: config.streamTokenTtlSeconds,
      });

      res.set("Cache-Control", "no-store").json({
        url: `/api/stream/${video._id.toHexString()}?t=${encodeURIComponent(token)}`,
        expiresInSeconds: config.streamTokenTtlSeconds,
        mimeType: video.mimeType,
        watermark: req.viewer.keyHint,
        viewCount: (video.viewCount ?? 0) + (view.counted ? 1 : 0),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/stream/:videoId", async (req, res, next) => {
    try {
      const video = await catalog.getVideo(req.params.videoId);
      if (video.categoryCode !== req.viewer.categoryCode) throw notFound("Video not found");

      const valid = verifyStreamToken({
        secret: config.streamSecret,
        token: req.query.t,
        sessionId: req.viewer.sessionId,
        videoId: video._id.toHexString(),
        ipFingerprint: req.viewer.ipFingerprint,
      });

      if (!valid) throw forbidden("stream_token_invalid", "This playback link has expired. Reload the player.");

      const file = await catalog.resolveVideoFile(video);
      const range = parseRange(req.headers.range, file.sizeBytes);

      res.set({
        "Content-Type": video.mimeType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      });

      if (range?.invalid) {
        res.set("Content-Range", `bytes */${file.sizeBytes}`);
        return res.status(416).end();
      }

      if (!range) {
        res.set("Content-Length", String(file.sizeBytes));
        if (req.method === "HEAD") return res.status(200).end();
        return pipeToResponse(createReadStream(file.absolute), res, next);
      }

      const chunkSize = range.end - range.start + 1;
      res.status(206).set({
        "Content-Range": `bytes ${range.start}-${range.end}/${file.sizeBytes}`,
        "Content-Length": String(chunkSize),
      });

      if (req.method === "HEAD") return res.end();
      return pipeToResponse(createReadStream(file.absolute, { start: range.start, end: range.end }), res, next);
    } catch (error) {
      next(error);
    }
  });

  router.get("/thumb/:videoId", async (req, res, next) => {
    try {
      const video = await catalog.getVideo(req.params.videoId);
      if (video.categoryCode !== req.viewer.categoryCode) throw notFound("Thumbnail not found");

      if (!video.thumbRelPath) {
        return res
          .status(200)
          .set({ "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" })
          .send(placeholderThumbnail(video));
      }

      const file = await catalog.resolveThumbFile(video);
      res.set({
        "Content-Type": video.thumbMimeType ?? "image/jpeg",
        "Content-Length": String(file.sizeBytes),
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      });
      return pipeToResponse(createReadStream(file.absolute), res, next);
    } catch (error) {
      if (error?.status === 404) {
        const video = await catalog.getVideo(req.params.videoId).catch(() => null);
        if (video) {
          return res
            .status(200)
            .set({ "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=600" })
            .send(placeholderThumbnail(video));
        }
      }
      next(error);
    }
  });

  return router;
}

function pipeToResponse(stream, res, next) {
  stream.on("error", (error) => {
    if (!res.headersSent) next(error);
    else res.destroy(error);
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export { createStreamRouter, parseRange };
