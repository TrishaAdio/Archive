import { api, ApiError, escapeHtml, formatBytes, formatDate, formatCount, icon, plural } from "./api.js";
import { confirmSheet, countUp, enhanceButtons, syncSegmented, toast, trackScroll, watchSegmented } from "./ui.js";
import { createTelegramAdmin } from "./telegram-admin.js";

const loginView = document.getElementById("login-view");
const consoleView = document.getElementById("console-view");
const tabs = document.getElementById("tabs");

const state = {
  categories: [],
  archives: [],
  cwd: "",
  selection: null,
  refreshTimer: null,
  statsBuilt: false,
};

const STAT_DEFS = [
  { key: "liveViewers", label: "Live viewers now", icon: "eye", accent: true },
  { key: "activeSubscriptions", label: "Active subscriptions", icon: "users" },
  { key: "videoCount", label: "Videos in library", icon: "film" },
  { key: "archiveCount", label: "Archives", icon: "layers" },
  { key: "categoryCount", label: "Category codes", icon: "grid" },
  { key: "totalBytes", label: "Library size", icon: "box", bytes: true },
];

function setError(id, message) {
  const node = document.getElementById(id);
  node.textContent = message ?? "";
  node.hidden = !message;
}

function describe(error) {
  if (!(error instanceof ApiError)) return "Unexpected error. Try again.";
  if (error.details?.length) return error.details.map((detail) => `${detail.field}: ${detail.message}`).join(" · ");
  return error.message;
}

function stagger(root, selector) {
  root.querySelectorAll(selector).forEach((node, index) => node.style.setProperty("--i", String(Math.min(index, 14))));
}

const telegram = createTelegramAdmin({
  getCategories: () => state.categories,
  onLibraryChanged: () => Promise.all([loadCategories(), loadArchives(), loadDashboard()]).catch(() => null),
});

function showLogin() {
  clearInterval(state.refreshTimer);
  telegram.stop();
  consoleView.hidden = true;
  loginView.hidden = false;
  document.getElementById("admin-token").focus();
}

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("login-error", "");
  const tokenInput = document.getElementById("admin-token");

  try {
    await api.post("/api/admin/login", { token: tokenInput.value.trim() });
    tokenInput.value = "";
    await enterConsole();
  } catch (error) {
    setError("login-error", describe(error));
    const card = document.getElementById("login-form");
    card.classList.remove("shake");
    void card.offsetWidth;
    card.classList.add("shake");
  }
});

document.getElementById("admin-logout").addEventListener("click", async () => {
  await api.post("/api/admin/logout").catch(() => null);
  state.statsBuilt = false;
  showLogin();
});

async function enterConsole() {
  loginView.hidden = true;
  consoleView.hidden = false;
  document.getElementById("dash-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const hour = new Date().getHours();
  document.getElementById("dash-when").textContent = hour >= 18 || hour < 5 ? "Tonight" : "Today";

  watchSegmented(tabs);
  enhanceButtons();

  await Promise.all([loadDashboard(), loadCategories(), loadArchives()]);
  await Promise.all([browse(""), loadKeys(), loadBroadcasts(), loadActivity(), telegram.start()]);

  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      loadDashboard();
      loadActivity();
    }
  }, 15000);
}

tabs.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.querySelectorAll(".tab").forEach((node) => {
      const active = node === tab;
      node.classList.toggle("is-active", active);
      node.setAttribute("aria-selected", String(active));
    });
    syncSegmented(tabs);
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
    if (tab.dataset.tab === "telegram") telegram.onShown();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

function buildStats() {
  document.getElementById("stats").innerHTML = STAT_DEFS.map(
    (stat) => `
      <div class="stat${stat.accent ? " stat--accent" : ""}">
        <span class="stat__icon">${icon(stat.icon)}</span>
        <span class="stat__value" data-stat="${stat.key}">0</span>
        <span class="stat__label">${stat.label}</span>
      </div>`,
  ).join("");
  state.statsBuilt = true;
}

async function loadDashboard() {
  try {
    const overview = await api.get("/api/admin/overview");
    if (!state.statsBuilt) buildStats();

    document.getElementById("live-pill").textContent = `${overview.liveViewers} live`;

    for (const stat of STAT_DEFS) {
      const node = document.querySelector(`[data-stat="${stat.key}"]`);
      if (stat.bytes) node.textContent = formatBytes(overview[stat.key]);
      else countUp(node, overview[stat.key], { format: (value) => formatCount(value) });
    }

    document.getElementById("server-info").innerHTML = [
      ["Media root", `<code class="mono">${escapeHtml(overview.mediaRoot)}</code>`],
      ["IP lock mode", overview.ipMatchMode === "strict" ? "Strict, exact IP" : "Relaxed, same subnet"],
      [
        "ffmpeg",
        overview.ffmpegAvailable
          ? '<span class="pill pill--ok">Installed</span>'
          : '<span class="pill pill--warn">Missing, no auto thumbnails</span>',
      ],
      ["Live window", `${overview.presenceWindowSeconds}s since last heartbeat`],
      [
        "Active broadcast",
        overview.activeBroadcast
          ? `${escapeHtml(overview.activeBroadcast.title)} · ${overview.activeBroadcast.ackCount} read`
          : "None",
      ],
    ]
      .map(([key, value]) => `<div class="kv__row"><dt>${key}</dt><dd>${value}</dd></div>`)
      .join("");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) showLogin();
  }
}

async function loadCategories() {
  const { categories } = await api.get("/api/admin/categories");
  state.categories = categories;
  const list = document.getElementById("category-list");

  list.innerHTML = categories.length
    ? categories
        .map(
          (category) => `
          <div class="row">
            <span class="row__lead mono">${escapeHtml(category.code)}</span>
            <div class="row__main">
              <strong class="row__title">${escapeHtml(category.name)}</strong>
              <span class="row__sub">${plural(category.archiveCount, "archive")} · ${plural(category.videoCount, "video")}</span>
            </div>
          </div>`,
        )
        .join("")
    : `<div class="empty">${icon("grid")}No category codes yet. Create your first one above.</div>`;
  stagger(list, ".row");

  const options = categories
    .map((category) => `<option value="${escapeHtml(category.code)}">${escapeHtml(category.code)} · ${escapeHtml(category.name)}</option>`)
    .join("");

  document.getElementById("archive-category").innerHTML = options || '<option value="">Create a category first</option>';
  document.getElementById("key-category").innerHTML = options || '<option value="">Create a category first</option>';
  document.getElementById("bc-category").innerHTML = `<option value="">Everyone</option>${options}`;
  telegram.refreshCategoryOptions();
}

document.getElementById("category-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("category-error", "");
  try {
    const created = await api.post("/api/admin/categories", {
      code: document.getElementById("category-code").value.trim(),
      name: document.getElementById("category-name").value.trim(),
    });
    document.getElementById("category-form").reset();
    toast(`Category ${created.code} created`, { tone: "ok" });
    await Promise.all([loadCategories(), loadDashboard()]);
  } catch (error) {
    setError("category-error", describe(error));
  }
});

async function loadArchives() {
  const { archives } = await api.get("/api/admin/archives");
  state.archives = archives;
  const list = document.getElementById("archive-list");

  list.innerHTML = archives.length
    ? archives
        .map(
          (archive) => `
          <div class="row">
            <span class="row__lead">${icon("layers")}</span>
            <div class="row__main">
              <strong class="row__title">${escapeHtml(archive.name)}</strong>
              <span class="row__sub">Category ${escapeHtml(archive.categoryCode)} · ${plural(archive.videoCount, "video")}</span>
            </div>
            <button class="btn btn--danger btn--sm" data-del-archive="${archive.id}" type="button">${icon("trash")}Delete</button>
          </div>`,
        )
        .join("")
    : `<div class="empty">${icon("layers")}No archives yet.</div>`;
  stagger(list, ".row");
  enhanceButtons(list);

  list.querySelectorAll("[data-del-archive]").forEach((button) => {
    button.addEventListener("click", async () => {
      const archive = archives.find((item) => item.id === button.dataset.delArchive);
      const confirmed = await confirmSheet({
        title: `Delete “${archive.name}”?`,
        message: `This removes the archive and its ${plural(archive.videoCount, "video")} from the site. The files on your server are not touched.`,
        confirmLabel: "Delete archive",
        danger: true,
      });
      if (!confirmed) return;

      try {
        await api.del(`/api/admin/archives/${archive.id}`);
        toast(`“${archive.name}” deleted`, { tone: "ok" });
        await Promise.all([loadArchives(), loadCategories(), loadDashboard()]);
      } catch (error) {
        toast(describe(error), { tone: "error" });
      }
    });
  });

  const importOptions = archives
    .map((archive) => `<option value="${archive.id}">${escapeHtml(archive.name)} · cat ${escapeHtml(archive.categoryCode)}</option>`)
    .join("");
  document.getElementById("import-archive").innerHTML = importOptions || '<option value="">Create an archive first</option>';
  refreshImportButton();
}

document.getElementById("archive-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("archive-error", "");
  try {
    const created = await api.post("/api/admin/archives", {
      categoryCode: document.getElementById("archive-category").value,
      name: document.getElementById("archive-name").value.trim(),
    });
    document.getElementById("archive-name").value = "";
    toast(`Archive “${created.name}” created`, { tone: "ok" });
    await Promise.all([loadArchives(), loadCategories(), loadDashboard()]);
  } catch (error) {
    setError("archive-error", describe(error));
  }
});

function renderCrumbs(relPath) {
  const nav = document.getElementById("fs-path");
  const parts = relPath ? relPath.split("/") : [];

  const crumbs = [`<button class="crumb${parts.length ? "" : " is-current"}" data-crumb="" type="button">/</button>`];
  parts.forEach((part, index) => {
    const target = parts.slice(0, index + 1).join("/");
    if (index > 0) crumbs.push('<span class="crumb-sep" aria-hidden="true">/</span>');
    const current = index === parts.length - 1;
    crumbs.push(
      `<button class="crumb${current ? " is-current" : ""}" data-crumb="${escapeHtml(target)}" type="button"${current ? ' aria-current="page"' : ""}>${escapeHtml(part)}</button>`,
    );
  });

  nav.innerHTML = crumbs.join("");
  nav.querySelectorAll("[data-crumb]").forEach((crumb) => {
    crumb.addEventListener("click", () => {
      select(crumb.dataset.crumb, "directory");
      browse(crumb.dataset.crumb);
    });
  });
  nav.scrollLeft = nav.scrollWidth;
}

function fileGlyph(entry) {
  if (entry.type === "directory") return icon("folder");
  if (entry.kind === "archive") return icon("box");
  if (entry.kind === "video") return icon("film");
  if (entry.kind === "image") return icon("image");
  return icon("doc");
}

async function browse(relPath) {
  setError("fs-error", "");
  try {
    const listing = await api.get(`/api/admin/files?path=${encodeURIComponent(relPath)}`);
    state.cwd = listing.relPath;

    renderCrumbs(listing.relPath);
    document.getElementById("fs-up").disabled = listing.isRoot;

    const list = document.getElementById("fs-list");
    list.innerHTML = listing.entries.length
      ? listing.entries
          .map((entry) => {
            const meta =
              entry.type === "directory"
                ? "folder"
                : [formatBytes(entry.sizeBytes), entry.kind === "video" && !entry.playable ? "needs transcode" : null]
                    .filter(Boolean)
                    .join(" · ");
            const selectable = entry.type === "directory" || entry.kind === "video" || entry.kind === "archive";

            return `
              <div class="fsrow${selectable ? " is-selectable" : ""}" data-path="${escapeHtml(entry.relPath)}" data-type="${entry.type}" data-kind="${entry.kind}">
                <span class="fsrow__icon">${fileGlyph(entry)}</span>
                <span class="fsrow__name">${escapeHtml(entry.name)}</span>
                <span class="fsrow__meta">${meta}</span>
              </div>`;
          })
          .join("")
      : `<div class="empty">${icon("folder")}This folder is empty.</div>`;
    stagger(list, ".fsrow");

    list.querySelectorAll(".fsrow").forEach((row) => {
      row.addEventListener("click", () => {
        if (row.dataset.type === "directory") {
          select(row.dataset.path, "directory");
          browse(row.dataset.path);
          return;
        }
        if (row.dataset.kind === "video" || row.dataset.kind === "archive") {
          list.querySelectorAll(".fsrow").forEach((node) => node.classList.remove("is-selected"));
          row.classList.add("is-selected");
          select(row.dataset.path, row.dataset.kind);
        }
      });
    });
  } catch (error) {
    setError("fs-error", describe(error));
  }
}

function select(relPath, kind) {
  state.selection = { relPath, kind };
  const label = kind === "directory" ? "folder" : kind === "archive" ? "zip file" : "video";
  document.getElementById("import-selection").textContent = `/${relPath} · ${label}`;
  refreshImportButton();
}

function refreshImportButton() {
  const hasArchive = Boolean(document.getElementById("import-archive").value);
  document.getElementById("import-button").disabled = !state.selection || !hasArchive;
}

document.getElementById("fs-up").addEventListener("click", () => {
  const parent = state.cwd.includes("/") ? state.cwd.slice(0, state.cwd.lastIndexOf("/")) : "";
  select(parent, "directory");
  browse(parent);
});

document.getElementById("import-archive").addEventListener("change", refreshImportButton);

document.getElementById("import-button").addEventListener("click", async () => {
  const button = document.getElementById("import-button");
  const result = document.getElementById("import-result");
  button.disabled = true;
  button.innerHTML = '<span class="spinner spinner--sm"></span>Importing';
  result.hidden = true;
  setError("fs-error", "");

  try {
    const response = await api.post(`/api/admin/archives/${document.getElementById("import-archive").value}/import`, {
      relPath: state.selection.relPath,
    });

    const parts = [
      `${plural(response.added, "video")} added`,
      response.skipped ? `${response.skipped} already present` : null,
      response.notPlayable ? `${response.notPlayable} need transcoding` : null,
      response.extraction ? `${response.extraction.extracted} extracted from the zip` : null,
      response.extraction?.skipped ? `${response.extraction.skipped} unsafe zip entries skipped` : null,
    ].filter(Boolean);

    result.textContent = parts.join(" · ");
    result.hidden = false;
    toast(`${plural(response.added, "video")} imported`, { tone: "ok" });
    await Promise.all([loadArchives(), loadCategories(), loadDashboard()]);
  } catch (error) {
    setError("fs-error", describe(error));
  } finally {
    button.textContent = "Import into archive";
    refreshImportButton();
  }
});

document.getElementById("key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("key-error", "");

  try {
    const created = await api.post("/api/admin/keys", {
      validityDays: Number(document.getElementById("key-days").value),
      categoryCode: document.getElementById("key-category").value,
      label: document.getElementById("key-label").value.trim() || undefined,
    });

    const output = document.getElementById("key-output");
    document.getElementById("key-value").textContent = created.key;
    output.hidden = true;
    void output.offsetWidth;
    output.hidden = false;
    document.getElementById("key-label").value = "";
    await Promise.all([loadKeys(), loadDashboard()]);
  } catch (error) {
    setError("key-error", describe(error));
  }
});

const daysInput = document.getElementById("key-days");
const presets = document.getElementById("day-presets");

function markPreset() {
  presets.querySelectorAll(".preset").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.days === daysInput.value);
  });
}

presets.querySelectorAll(".preset").forEach((button) => {
  button.addEventListener("click", () => {
    daysInput.value = button.dataset.days;
    markPreset();
  });
});

daysInput.addEventListener("input", markPreset);

document.getElementById("key-copy").addEventListener("click", async () => {
  const label = document.getElementById("key-copy-label");
  try {
    await navigator.clipboard.writeText(document.getElementById("key-value").textContent);
    label.textContent = "Copied";
    toast("Key copied to clipboard", { tone: "ok" });
  } catch {
    label.textContent = "Select it manually";
  }
  setTimeout(() => {
    label.textContent = "Copy key";
  }, 1800);
});

async function loadKeys() {
  const status = document.getElementById("key-filter").value;
  const search = document.getElementById("key-search").value.trim();
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (search) query.set("search", search);

  const { items, total } = await api.get(`/api/admin/keys?${query}`);
  const list = document.getElementById("key-list");

  list.innerHTML = items.length
    ? `<p class="list__count">${items.length} of ${total}</p>` +
      items
        .map((key) => {
          const tone = key.status === "active" ? "ok" : key.status === "expired" ? "warn" : "bad";
          return `
            <div class="row">
              <span class="row__lead">${icon("key")}</span>
              <div class="row__main">
                <strong class="row__title mono">${escapeHtml(key.keyHint)}</strong>
                <span class="row__sub">
                  ${key.label ? `${escapeHtml(key.label)} · ` : ""}Category ${escapeHtml(key.categoryCode)}
                  · ends ${formatDate(key.planExpiresAt)}
                  · ${key.boundIp ? `locked to ${escapeHtml(key.boundIp)}` : "not yet claimed"}
                </span>
              </div>
              <div class="row__actions">
                <span class="pill pill--${tone}">${key.status}</span>
                ${key.status === "active" ? `<button class="btn btn--danger btn--sm" data-expire="${key.id}" type="button">Expire now</button>` : `<button class="btn btn--ghost btn--sm" data-extend="${key.id}" type="button">${icon("plus")}30 days</button>`}
                ${key.boundIp ? `<button class="btn btn--ghost btn--sm" data-release="${key.id}" type="button">${icon("unlock")}Unlock IP</button>` : ""}
              </div>
            </div>`;
        })
        .join("")
    : `<div class="empty">${icon("key")}No keys match.</div>`;
  stagger(list, ".row");
  enhanceButtons(list);

  bindKeyAction(list, "data-expire", "expire", {
    title: "Expire this subscription now?",
    message: "The viewer is signed out immediately and the key stops working. You can extend it again later.",
    confirmLabel: "Expire now",
    danger: true,
  }, null, "Subscription expired");
  bindKeyAction(list, "data-extend", "extend", null, { additionalDays: 30 }, "Extended by 30 days");
  bindKeyAction(list, "data-release", "release-ip", {
    title: "Unlock the network binding?",
    message: "The key can then be claimed from a new network. Any open session on the old one is signed out.",
    confirmLabel: "Unlock IP",
  }, null, "IP binding released");
}

function bindKeyAction(root, attribute, path, confirmOptions, body, successMessage) {
  root.querySelectorAll(`[${attribute}]`).forEach((button) => {
    button.addEventListener("click", async () => {
      if (confirmOptions && !(await confirmSheet(confirmOptions))) return;
      const id = button.getAttribute(attribute);
      button.disabled = true;
      try {
        await api.post(`/api/admin/keys/${id}/${path}`, body);
        toast(successMessage, { tone: "ok" });
        await Promise.all([loadKeys(), loadDashboard()]);
      } catch (error) {
        toast(describe(error), { tone: "error" });
        button.disabled = false;
      }
    });
  });
}

document.getElementById("key-filter").addEventListener("change", loadKeys);
document.getElementById("key-search").addEventListener("input", debounce(loadKeys, 320));

document.getElementById("broadcast-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("bc-error", "");

  try {
    await api.post("/api/admin/broadcasts", {
      title: document.getElementById("bc-title").value.trim() || undefined,
      message: document.getElementById("bc-message").value.trim(),
      categoryCode: document.getElementById("bc-category").value || null,
    });
    document.getElementById("bc-message").value = "";
    toast("Broadcast sent to every open screen", { tone: "ok" });
    await Promise.all([loadBroadcasts(), loadDashboard()]);
  } catch (error) {
    setError("bc-error", describe(error));
  }
});

async function loadBroadcasts() {
  const { broadcasts } = await api.get("/api/admin/broadcasts");
  const list = document.getElementById("broadcast-list");

  list.innerHTML = broadcasts.length
    ? broadcasts
        .map(
          (broadcast) => `
          <div class="row">
            <span class="row__lead">${icon("megaphone")}</span>
            <div class="row__main">
              <strong class="row__title">${escapeHtml(broadcast.title)}</strong>
              <span class="row__sub">
                ${escapeHtml(broadcast.message.slice(0, 90))}${broadcast.message.length > 90 ? "…" : ""}
                · ${broadcast.ackCount} read · ${formatDate(broadcast.createdAt)}
              </span>
            </div>
            <div class="row__actions">
              ${broadcast.active ? '<span class="pill pill--live">Showing</span>' : '<span class="pill">Closed</span>'}
              ${broadcast.active ? `<button class="btn btn--ghost btn--sm" data-stop="${broadcast.id}" type="button">Stop</button>` : ""}
            </div>
          </div>`,
        )
        .join("")
    : `<div class="empty">${icon("megaphone")}Nothing sent yet.</div>`;
  stagger(list, ".row");
  enhanceButtons(list);

  list.querySelectorAll("[data-stop]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.post(`/api/admin/broadcasts/${button.dataset.stop}/deactivate`);
      toast("Broadcast stopped", { tone: "ok" });
      await Promise.all([loadBroadcasts(), loadDashboard()]);
    });
  });
}

async function loadActivity() {
  try {
    const [live, audit] = await Promise.all([api.get("/api/admin/live"), api.get("/api/admin/audit")]);
    const liveList = document.getElementById("live-list");
    const auditList = document.getElementById("audit-list");

    liveList.innerHTML = live.viewers.length
      ? live.viewers
          .map(
            (viewer) => `
            <div class="row">
              <span class="row__lead">${icon("eye")}</span>
              <div class="row__main">
                <strong class="row__title mono">${escapeHtml(viewer.keyHint)}</strong>
                <span class="row__sub">
                  Category ${escapeHtml(viewer.categoryCode)} · ${escapeHtml(viewer.ipFingerprint)}
                  · seen ${new Date(viewer.lastSeenAt).toLocaleTimeString()}
                </span>
              </div>
              <span class="pill pill--live">live</span>
            </div>`,
          )
          .join("")
      : `<div class="empty">${icon("eye")}Nobody is watching right now.</div>`;

    auditList.innerHTML = audit.entries.length
      ? audit.entries
          .map(
            (entry) => `
            <div class="row row--tight">
              <div class="row__main">
                <strong class="row__title">${escapeHtml(entry.action)}</strong>
                <span class="row__sub mono">${escapeHtml(JSON.stringify(entry.detail))}</span>
              </div>
              <span class="row__time">${new Date(entry.createdAt).toLocaleTimeString()}</span>
            </div>`,
          )
          .join("")
      : `<div class="empty">${icon("activity")}No activity recorded yet.</div>`;
  } catch {
    return;
  }
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

trackScroll();
enhanceButtons();

api
  .get("/api/admin/overview")
  .then(() => enterConsole())
  .catch(() => showLogin());
