import path from "node:path";
import { pathToFileURL } from "node:url";
import { createTelegramAccount } from "./account.js";
import { createTelegramJobs } from "./jobs.js";

function createTelegramService({ collections, config, catalog, media }) {
  let driverPromise = null;

  function loadDriver() {
    driverPromise ??= (
      config.telegramDriverModule
        ? import(pathToFileURL(path.resolve(config.telegramDriverModule)).href)
        : import("./gramDriver.js")
    ).then((module) => module.createDriver());
    return driverPromise;
  }

  const account = createTelegramAccount({ collection: collections.telegramAccounts, config, loadDriver });
  const jobs = createTelegramJobs({ collection: collections.telegramJobs, account, catalog, media });

  async function close() {
    await jobs.close();
    await account.close();
  }

  return { account, jobs, start: () => jobs.start(), close };
}

export { createTelegramService };
