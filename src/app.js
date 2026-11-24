import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { AppError } from "./lib/errors.js";
import { createAuthMiddleware } from "./security/auth.js";
import { createAccessKeyService } from "./services/accessKeys.js";
import { createSessionService } from "./services/sessions.js";
import { createCounterService } from "./services/counters.js";
import { createMediaService } from "./services/media.js";
import { createCatalogService } from "./services/catalog.js";
import { createEngagementService } from "./services/engagement.js";
import { createBroadcastService } from "./services/broadcasts.js";
import { createGateRouter } from "./routes/gate.js";
import { createCatalogRouter } from "./routes/catalog.js";
import { createStreamRouter } from "./routes/stream.js";
import { createEngagementRouter } from "./routes/engagement.js";
import { createAdminRouter } from "./routes/admin.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

function createApp({ config, db, collections }) {
  const accessKeys = createAccessKeyService(collections.accessKeys, config);
  const sessions = createSessionService(collections.sessions, config);
  const counters = createCounterService(collections.counters);
  const media = createMediaService(config);
  const catalog = createCatalogService(collections, { counters, media });
  const engagement = createEngagementService(collections, config);
  const broadcasts = createBroadcastService(collections);
  const auth = createAuthMiddleware({ config, accessKeys, sessions });

  async function audit(action, detail = {}) {
    try {
      await collections.auditLog.insertOne({ action, detail, createdAt: new Date() });
    } catch (error) {
      console.error("audit write failed", error);
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops > 0 ? config.trustProxyHops : false);
  app.set("etag", false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'none'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "font-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "media-src": ["'self'", "blob:"],
          "connect-src": ["'self'"],
          "base-uri": ["'none'"],
          "form-action": ["'none'"],
          "frame-ancestors": ["'none'"],
          "object-src": ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
    }),
  );

  app.use((req, res, next) => {
    res.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });

  app.use(cookieParser());
  app.use(express.json({ limit: "32kb", strict: true }));

  app.get("/health", async (req, res) => {
    try {
      await db.command({ ping: 1 });
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "degraded" });
    }
  });

  app.use(
    "/api/admin",
    createAdminRouter({ config, accessKeys, sessions, catalog, media, broadcasts, auth, audit, collections }),
  );
  app.use("/api/gate", createGateRouter({ config, accessKeys, sessions, catalog, auth, audit }));

  const viewerRouter = express.Router();
  viewerRouter.use(auth.requireSession);
  viewerRouter.use(createCatalogRouter({ catalog, engagement }));
  viewerRouter.use(createStreamRouter({ config, catalog, engagement }));
  viewerRouter.use(createEngagementRouter({ catalog, engagement, sessions, broadcasts }));
  app.use("/api", viewerRouter);

  app.use(
    express.static(publicDir, {
      index: false,
      etag: true,
      maxAge: "1h",
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".woff2")) res.set("Cache-Control", "public, max-age=31536000, immutable");
        if (filePath.endsWith(".html")) res.set("Cache-Control", "no-store");
      },
    }),
  );

  app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
  app.get("/watch", (req, res) => res.sendFile(path.join(publicDir, "watch.html")));
  app.get("/admin", (req, res) => res.sendFile(path.join(publicDir, "admin.html")));

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found", code: "not_found" });
    res.status(404).sendFile(path.join(publicDir, "index.html"));
  });

  app.use((error, req, res, next) => {
    if (error instanceof AppError) {
      return res
        .status(error.status)
        .set("Cache-Control", "no-store")
        .json({ error: error.message, code: error.code, ...error.extra });
    }
    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid JSON body", code: "bad_json" });
    }
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body too large", code: "too_large" });
    }

    console.error(error);
    res.status(500).json({ error: "Internal server error", code: "internal_error" });
  });

  return { app, services: { accessKeys, sessions, catalog, media, broadcasts, engagement, counters } };
}

export { createApp };
