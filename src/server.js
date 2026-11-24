import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import { createApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const { client, db, collections } = await connectDatabase(config);
  const { app } = createApp({ config, db, collections });

  const server = app.listen(config.port, () => {
    console.log(`${config.siteName} listening on port ${config.port}`);
    console.log(`Media root: ${config.mediaRoot}`);
    console.log(`IP match mode: ${config.ipMatchMode}`);
  });

  server.headersTimeout = 0;
  server.requestTimeout = 0;

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);

    server.close(async () => {
      await client.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start:", error.message);
  process.exit(1);
});
