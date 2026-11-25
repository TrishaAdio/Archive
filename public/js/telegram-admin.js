import { api, ApiError, escapeHtml, formatBytes, icon, plural } from "./api.js";
import { confirmSheet, enhanceButtons, toast } from "./ui.js";

const ACTIVE = new Set(["queued", "connecting", "joining", "scanning", "downloading", "zipping"]);
const RESUMABLE = new Set(["failed", "cancelled", "interrupted"]);
const FAST_POLL_MS = 1000;
const SLOW_POLL_MS = 8000;

const STATUS = {
  queued: ["Waiting", ""],
  connecting: ["Connecting", "pill--live"],
  joining: ["Joining chat", "pill--live"],
  scanning: ["Finding videos", "pill--live"],
  downloading: ["Downloading", "pill--live"],
  zipping: ["Making zip", "pill--live"],
  done: ["Done", "pill--ok"],
  failed: ["Failed", "pill--bad"],
  cancelled: ["Stopped", "pill--warn"],
  interrupted: ["Interrupted", "pill--warn"],
};

const byId = (id) => document.getElementById(id);

function describe(error) {
  if (!(error instanceof ApiError)) return "Unexpected error. Try again.";
  return error.message;
}

function setError(id, message) {
  const node = byId(id);
  node.textContent = message ?? "";
  node.hidden = !message;
}

function timeLeft(seconds) {
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours} h ${String(minutes).padStart(2, "0")} min left`;
}

function took(job) {
  if (!job.startedAt || !job.finishedAt) return null;
  const seconds = (Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000;
  if (seconds < 90) return `took ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `took ${Math.round(seconds / 60)} min`;
  return `took ${(seconds / 3600).toFixed(1)} h`;
}

function percent(done, total) {
  if (!total) return 0;
  return Math.min(100, Math.floor((done / total) * 100));
}

function jobStats(job) {
  if (job.status === "scanning") return [`${plural(job.scannedCount, "video")} found so far`];
  if (job.status === "queued") return ["Starts when the current download finishes"];
  if (job.status === "connecting" || job.status === "joining") return [job.chatTitle ?? job.link];

  if (job.status === "zipping") {
    return [
      `Zip ${percent(job.zipBytes, job.doneBytes)}%`,
      `${formatBytes(job.zipBytes)} of ${formatBytes(job.doneBytes)}`,
      job.speedBytesPerSecond ? `${formatBytes(job.speedBytesPerSecond)}/s` : null,
      timeLeft(job.etaSeconds),
    ].filter(Boolean);
  }

  if (job.status === "downloading") {
    const waiting = job.waitingUntil ? Math.max(0, Math.ceil((Date.parse(job.waitingUntil) - Date.now()) / 1000)) : 0;
    return [
      `${percent(job.doneBytes, job.totalBytes)}%`,
      `${formatBytes(job.doneBytes)} of ${formatBytes(job.totalBytes)}`,
      waiting ? `Telegram asked to pause, resuming in ${waiting} s` : job.speedBytesPerSecond ? `${formatBytes(job.speedBytesPerSecond)}/s` : "starting",
      waiting ? null : timeLeft(job.etaSeconds),
      `${job.doneFiles} of ${plural(job.totalFiles, "video")}`,
    ].filter(Boolean);
  }

  const parts = [
    job.totalFiles ? `${job.doneFiles} of ${plural(job.totalFiles, "video")}` : null,
    job.totalBytes ? formatBytes(job.doneBytes) : null,
    job.status === "done" ? took(job) : null,
  ];
  return parts.filter(Boolean);
}

function barFraction(job) {
  if (job.status === "zipping") return job.doneBytes ? job.zipBytes / job.doneBytes : 0;
  if (job.status === "done") return 1;
  return job.totalBytes ? job.doneBytes / job.totalBytes : 0;
}

function jobMarkup(job) {
  return `
    <article class="tgjob" data-job="${job.id}">
      <div class="tgjob__head">
        <span class="row__lead">${icon("send")}</span>
        <div class="row__main">
          <strong class="row__title" data-field="title"></strong>
          <span class="row__sub" data-field="sub"></span>
        </div>
        <span class="pill" data-field="status"></span>
      </div>
      <div class="tgjob__bar" aria-hidden="true"><span class="tgjob__fill" data-field="fill"></span></div>
      <p class="tgjob__stats mono" data-field="stats"></p>
      <ul class="tgjob__current" data-field="current"></ul>
      <p class="tgjob__note" data-field="note" hidden></p>
      <div class="tgjob__actions">
        <button class="btn btn--ghost btn--sm" data-action="cancel" type="button" hidden>${icon("close")}Stop</button>
        <button class="btn btn--primary btn--sm" data-action="resume" type="button" hidden>${icon("replay")}Resume</button>
      </div>
    </article>`;
}

function createTelegramAdmin({ getCategories, onLibraryChanged }) {
  const panel = document.querySelector('[data-panel="telegram"]');
  const jobsList = byId("tg-jobs");
  const status = { connected: false };
  const lastStatus = new Map();
  let pollTimer = null;
  let polling = false;

  function fillJob(node, job) {
    const field = (name) => node.querySelector(`[data-field="${name}"]`);
    const [label, tone] = STATUS[job.status] ?? [job.status, ""];
    field("title").textContent = job.archiveName;
    field("sub").textContent = `${job.chatTitle ?? job.link} · code ${job.categoryCode}`;
    const pill = field("status");
    pill.className = `pill ${tone}`.trim();
    pill.textContent = label;

    node.classList.toggle("is-active", ACTIVE.has(job.status));
    node.classList.toggle("is-done", job.status === "done");
    field("fill").style.transform = `scaleX(${Math.max(0, Math.min(1, barFraction(job))).toFixed(4)})`;
    field("stats").innerHTML = jobStats(job)
      .map((part) => `<span>${escapeHtml(part)}</span>`)
      .join("");

    const current = job.status === "downloading" ? job.current : [];
    field("current").innerHTML = current
      .map(
        (file) => `
        <li>
          <span class="tgjob__file">${escapeHtml(file.name)}</span>
          <span class="mono">${percent(file.receivedBytes, file.sizeBytes)}%</span>
        </li>`,
      )
      .join("");
    field("current").hidden = current.length === 0;

    const notes = [];
    if (job.error) notes.push(job.error);
    if (job.failedFiles) {
      const names = job.failures.slice(0, 3).map((failure) => failure.fileName).join(", ");
      notes.push(`${plural(job.failedFiles, "video")} could not be downloaded${names ? `: ${names}` : ""}. Resume to try again.`);
    }
    if (job.status === "done") notes.push(`Saved in ${job.folder}${job.zipPath ? ` and ${job.zipPath}` : ""}`);
    const note = field("note");
    note.textContent = notes.join(" ");
    note.hidden = notes.length === 0;
    note.classList.toggle("is-error", Boolean(job.error));

    node.querySelector('[data-action="cancel"]').hidden = !ACTIVE.has(job.status);
    node.querySelector('[data-action="resume"]').hidden = !(RESUMABLE.has(job.status) || (job.status === "done" && job.failedFiles > 0));
  }

  function bindJob(node, jobId) {
    node.querySelector('[data-action="cancel"]').addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api.post(`/api/admin/telegram/jobs/${jobId}/cancel`);
        toast("Download stopped. Resume picks up where it left off.", { tone: "ok" });
      } catch (error) {
        toast(describe(error), { tone: "error" });
      } finally {
        button.disabled = false;
        refreshJobs();
      }
    });
    node.querySelector('[data-action="resume"]').addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await api.post(`/api/admin/telegram/jobs/${jobId}/resume`);
        toast("Download resumed", { tone: "ok" });
      } catch (error) {
        toast(describe(error), { tone: "error" });
      } finally {
        button.disabled = false;
        refreshJobs();
      }
    });
  }

  function renderJobs(jobs) {
    if (!jobs.length) {
      jobsList.innerHTML = `<div class="empty">${icon("send")}No downloads yet.</div>`;
      return;
    }
    jobsList.querySelector(".empty")?.remove();

    const wanted = new Set(jobs.map((job) => job.id));
    jobsList.querySelectorAll("[data-job]").forEach((node) => {
      if (!wanted.has(node.dataset.job)) node.remove();
    });

    let previous = null;
    for (const job of jobs) {
      let node = jobsList.querySelector(`[data-job="${CSS.escape(job.id)}"]`);
      if (!node) {
        const template = document.createElement("template");
        template.innerHTML = jobMarkup(job).trim();
        node = template.content.firstElementChild;
        bindJob(node, job.id);
        enhanceButtons(node);
      }
      const expectedPosition = previous ? previous.nextElementSibling : jobsList.firstElementChild;
      if (node !== expectedPosition) jobsList.insertBefore(node, expectedPosition);
      fillJob(node, job);
      previous = node;
    }
  }

  async function refreshJobs() {
    try {
      const { jobs } = await api.get("/api/admin/telegram/jobs");
      let libraryChanged = false;
      for (const job of jobs) {
        const before = lastStatus.get(job.id);
        if (before && before !== job.status && !ACTIVE.has(job.status)) libraryChanged = true;
        lastStatus.set(job.id, job.status);
      }
      renderJobs(jobs);
      if (libraryChanged) onLibraryChanged();
      return jobs.some((job) => ACTIVE.has(job.status));
    } catch {
      return false;
    }
  }

  function showStep(step) {
    byId("tg-login-form").hidden = step !== "login";
    byId("tg-code-form").hidden = step !== "code";
    byId("tg-password-form").hidden = step !== "password";
    byId("tg-account").hidden = step !== "connected";
  }

  function renderStatus(next) {
    Object.assign(status, next);
    if (next.connected) {
      showStep("connected");
      byId("tg-account-icon").innerHTML = icon("send");
      byId("tg-account-name").textContent = next.account.name;
      byId("tg-account-sub").textContent = [next.account.username ? `@${next.account.username}` : null, next.account.phone, "connected"]
        .filter(Boolean)
        .join(" · ");
    } else if (next.login?.step === "code") {
      showStep("code");
      byId("tg-code-lead").textContent = next.login.viaApp
        ? `Telegram sent a code to the Telegram app logged in on ${next.login.phone}.`
        : `Telegram sent a code by SMS to ${next.login.phone}.`;
    } else if (next.login?.step === "password") {
      showStep("password");
      byId("tg-password-lead").textContent = next.login.hint
        ? `This account has two-step verification. Password hint: ${next.login.hint}`
        : "This account has two-step verification. Enter its password.";
    } else {
      showStep("login");
    }

    byId("tg-job-button").disabled = !next.connected;
    byId("tg-job-locked").hidden = Boolean(next.connected);
  }

  async function loadStatus() {
    try {
      renderStatus(await api.get("/api/admin/telegram"));
    } catch {
      return;
    }
  }

  async function busy(button, label, work) {
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner spinner--sm"></span>${label}`;
    try {
      return await work();
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  byId("tg-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("tg-login-error", "");
    const button = event.submitter ?? event.target.querySelector('[type="submit"]');
    try {
      await busy(button, "Sending code", () =>
        api.post("/api/admin/telegram/login", {
          apiId: byId("tg-api-id").value.trim(),
          apiHash: byId("tg-api-hash").value.trim(),
          phone: byId("tg-phone").value.trim(),
        }),
      );
      await loadStatus();
      byId("tg-code").focus();
    } catch (error) {
      setError("tg-login-error", describe(error));
    }
  });

  byId("tg-code-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("tg-login-error", "");
    const button = event.submitter ?? event.target.querySelector('[type="submit"]');
    try {
      const result = await busy(button, "Checking", () => api.post("/api/admin/telegram/login/code", { code: byId("tg-code").value }));
      byId("tg-code").value = "";
      await loadStatus();
      if (result.connected) toast("Telegram connected", { tone: "ok" });
      else byId("tg-password").focus();
    } catch (error) {
      setError("tg-login-error", describe(error));
      if (error instanceof ApiError && error.status === 409) await loadStatus();
    }
  });

  byId("tg-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("tg-login-error", "");
    const button = event.submitter ?? event.target.querySelector('[type="submit"]');
    try {
      await busy(button, "Checking", () => api.post("/api/admin/telegram/login/password", { password: byId("tg-password").value }));
      byId("tg-password").value = "";
      byId("tg-api-hash").value = "";
      await loadStatus();
      toast("Telegram connected", { tone: "ok" });
    } catch (error) {
      setError("tg-login-error", describe(error));
      if (error instanceof ApiError && error.status === 409) await loadStatus();
    }
  });

  panel.querySelectorAll("[data-tg-restart]").forEach((button) => {
    button.addEventListener("click", async () => {
      setError("tg-login-error", "");
      await api.post("/api/admin/telegram/login/cancel").catch(() => null);
      await loadStatus();
    });
  });

  byId("tg-logout").addEventListener("click", async () => {
    const confirmed = await confirmSheet({
      title: "Disconnect Telegram?",
      message: "The server logs out of this Telegram session. Archives that were already downloaded stay on the site.",
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!confirmed) return;
    try {
      renderStatus(await api.post("/api/admin/telegram/logout"));
      toast("Telegram disconnected", { tone: "ok" });
    } catch (error) {
      toast(describe(error), { tone: "error" });
    }
  });

  function syncCategoryField() {
    const code = byId("tg-category-code").value.trim();
    const known = getCategories().find((category) => category.code === code);
    const isNew = /^\d{1,10}$/.test(code) && !known;
    byId("tg-category-name-field").hidden = !isNew;
    byId("tg-category-name").required = isNew;
    const note = byId("tg-category-note");
    note.hidden = !code || !/^\d{1,10}$/.test(code);
    note.textContent = known ? `Files into “${known.name}”.` : `Code ${code} is new and will be created.`;
  }

  function refreshCategoryOptions() {
    byId("tg-category-codes").innerHTML = getCategories()
      .map((category) => `<option value="${escapeHtml(category.code)}">${escapeHtml(category.name)}</option>`)
      .join("");
    syncCategoryField();
  }

  byId("tg-category-code").addEventListener("input", syncCategoryField);

  byId("tg-job-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("tg-job-error", "");
    const button = byId("tg-job-button");
    try {
      const job = await busy(button, "Joining chat", () =>
        api.post("/api/admin/telegram/jobs", {
          link: byId("tg-link").value.trim(),
          archiveName: byId("tg-archive-name").value.trim(),
          categoryCode: byId("tg-category-code").value.trim(),
          categoryName: byId("tg-category-name").value.trim(),
          keepZip: byId("tg-keep-zip").checked,
        }),
      );
      event.target.reset();
      syncCategoryField();
      toast(`Downloading “${job.chatTitle}”`, { tone: "ok" });
      onLibraryChanged();
      schedule(0);
    } catch (error) {
      setError("tg-job-error", describe(error));
    } finally {
      byId("tg-job-button").disabled = !status.connected;
    }
  });

  function schedule(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(tick, delay);
  }

  async function tick() {
    if (polling) return;
    polling = true;
    let active = false;
    try {
      if (!panel.hidden && document.visibilityState === "visible") active = await refreshJobs();
    } finally {
      polling = false;
      schedule(active ? FAST_POLL_MS : SLOW_POLL_MS);
    }
  }

  async function start() {
    refreshCategoryOptions();
    await Promise.all([loadStatus(), refreshJobs()]);
    schedule(SLOW_POLL_MS);
  }

  function stop() {
    clearTimeout(pollTimer);
  }

  function onShown() {
    loadStatus();
    schedule(0);
  }

  return { start, stop, onShown, refreshCategoryOptions };
}

export { createTelegramAdmin };
