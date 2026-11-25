import express from "express";
import rateLimit from "express-rate-limit";
import { conflict } from "../lib/errors.js";
import { toAppError } from "../services/telegram/failures.js";

function createTelegramRouter({ telegram, audit }) {
  const router = express.Router();
  const { account, jobs } = telegram;

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many Telegram login attempts. Wait 15 minutes.", code: "rate_limited" },
  });

  const handle = (work) => async (req, res, next) => {
    try {
      res.set("Cache-Control", "no-store");
      await work(req, res);
    } catch (error) {
      next(toAppError(error));
    }
  };

  router.get(
    "/",
    handle(async (req, res) => {
      res.json(await account.status());
    }),
  );

  router.post(
    "/login",
    loginLimiter,
    handle(async (req, res) => {
      const result = await account.startLogin(req.body ?? {});
      await audit("telegram.login.code_sent", { phone: result.phone });
      res.json(result);
    }),
  );

  router.post(
    "/login/code",
    loginLimiter,
    handle(async (req, res) => {
      const result = await account.submitCode(req.body?.code);
      if (result.connected) await audit("telegram.login.ok", { account: result.account.name });
      res.json(result);
    }),
  );

  router.post(
    "/login/password",
    loginLimiter,
    handle(async (req, res) => {
      const result = await account.submitPassword(req.body?.password);
      await audit("telegram.login.ok", { account: result.account.name });
      res.json(result);
    }),
  );

  router.post(
    "/login/cancel",
    handle(async (req, res) => {
      await account.cancelLogin();
      res.json(await account.status());
    }),
  );

  router.post(
    "/logout",
    handle(async (req, res) => {
      if (await jobs.hasActive()) throw conflict("Stop the running download before disconnecting Telegram.");
      await account.logout();
      await audit("telegram.logout");
      res.json(await account.status());
    }),
  );

  router.get(
    "/jobs",
    handle(async (req, res) => {
      res.json({ jobs: await jobs.list() });
    }),
  );

  router.post(
    "/jobs",
    handle(async (req, res) => {
      const job = await jobs.create(req.body ?? {});
      await audit("telegram.download.start", { chat: job.chatTitle, link: job.link, archive: job.archiveName, categoryCode: job.categoryCode });
      res.status(202).json(job);
    }),
  );

  router.get(
    "/jobs/:id",
    handle(async (req, res) => {
      res.json(await jobs.get(req.params.id));
    }),
  );

  router.post(
    "/jobs/:id/cancel",
    handle(async (req, res) => {
      const job = await jobs.cancel(req.params.id);
      await audit("telegram.download.cancel", { chat: job.chatTitle, archive: job.archiveName });
      res.json(job);
    }),
  );

  router.post(
    "/jobs/:id/resume",
    handle(async (req, res) => {
      const job = await jobs.resume(req.params.id);
      await audit("telegram.download.resume", { chat: job.chatTitle, archive: job.archiveName });
      res.json(job);
    }),
  );

  return router;
}

export { createTelegramRouter };
