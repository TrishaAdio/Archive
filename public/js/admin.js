import { api, ApiError, escapeHtml, formatBytes, formatDate, formatCount, icon } from "./api.js";

const loginView = document.getElementById("login-view");
const consoleView = document.getElementById("console-view");

const state = {
  categories: [],
  archives: [],
  cwd: "",
  selection: null,
  refreshTimer: null,
};

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

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("login-error", "");
  const token = document.getElementById("admin-token").value.trim();

  try {
    await api.post("/api/admin/login", { token });
    document.getElementById("admin-token").value = "";
    await enterConsole();
  } catch (error) {
    setError("login-error", describe(error));
  }
});

document.getElementById("admin-logout").addEventListener("click", async () => {
  clearInterval(state.refreshTimer);
  try {
    await api.post("/api/admin/logout");
  } catch {
    /* leaving regardless */
  }
  consoleView.hidden = true;
  loginView.hidden = false;
});

async function enterConsole() {
  loginView.hidden = true;
  consoleView.hidden = false;

  await Promise.all([loadDashboard(), loadCategories(), loadArchives()]);
  await Promise.all([browse(""), loadKeys(), loadBroadcasts(), loadActivity()]);

  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible") {
      loadDashboard();
      loadActivity();
    }
  }, 15000);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((node) => node.classList.toggle("is-active", node === tab));
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
  });
});

async function loadDashboard() {
  try {
    const overview = await api.get("/api/admin/overview");

    document.getElementById("live-pill").textContent = `${overview.liveViewers} live`;

    document.getElementById("stats").innerHTML = [
      { label: "Live viewers now", value: overview.liveViewers, accent: true },
      { label: "Active subscriptions", value: overview.activeSubscriptions },
      { label: "Videos in library", value: formatCount(overview.videoCount) },
      { label: "Archives", value: overview.archiveCount },
      { label: "Category codes", value: overview.categoryCount },
      { label: "Library size", value: formatBytes(overview.totalBytes) },
    ]
      .map(
        (stat) => `
        <div class="stat${stat.accent ? " stat--accent" : ""}">
          <span class="stat__value">${stat.value}</span>
          <span class="stat__label">${stat.label}</span>
        </div>`,
      )
      .join("");

    document.getElementById("server-info").innerHTML = [
      ["Media root", `<code class="mono">${escapeHtml(overview.mediaRoot)}</code>`],
      ["IP lock mode", overview.ipMatchMode === "strict" ? "Strict (exact IP)" : "Relaxed (same subnet)"],
      [
        "ffmpeg",
        overview.ffmpegAvailable
          ? '<span class="pill pill--ok">Installed</span>'
          : '<span class="pill pill--warn">Missing — no auto thumbnails or durations</span>',
      ],
      ["Live window", `${overview.presenceWindowSeconds}s since last heartbeat`],
      [
        "Active broadcast",
        overview.activeBroadcast
          ? `${escapeHtml(overview.activeBroadcast.title)} (${overview.activeBroadcast.ackCount} read)`
          : "None",
      ],
    ]
      .map(([key, value]) => `<div class="kv__row"><dt>${key}</dt><dd>${value}</dd></div>`)
      .join("");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      clearInterval(state.refreshTimer);
      consoleView.hidden = true;
      loginView.hidden = false;
    }
  }
}

async function loadCategories() {
  const { categories } = await api.get("/api/admin/categories");
  state.categories = categories;

  document.getElementById("category-list").innerHTML = categories.length
    ? categories
        .map(
          (category) => `
          <div class="row">
            <div class="row__main">
              <strong class="row__title">${escapeHtml(category.name)}</strong>
              <span class="row__sub">Code ${category.code} · ${category.archiveCount} archives · ${category.videoCount} videos</span>
            </div>
          </div>`,
        )
        .join("")
    : '<p class="empty">No category codes yet. Create one above.</p>';

  const options = categories
    .map((category) => `<option value="${category.code}">${category.code} — ${escapeHtml(category.name)}</option>`)
    .join("");

  document.getElementById("archive-category").innerHTML = options || '<option value="">Create a category first</option>';
  document.getElementById("key-category").innerHTML = options || '<option value="">Create a category first</option>';
  document.getElementById("bc-category").innerHTML = `<option value="">Everyone</option>${options}`;
}

document.getElementById("category-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("category-error", "");
  try {
    await api.post("/api/admin/categories", {
      code: document.getElementById("category-code").value.trim(),
      name: document.getElementById("category-name").value.trim(),
    });
    document.getElementById("category-form").reset();
    await Promise.all([loadCategories(), loadDashboard()]);
  } catch (error) {
    setError("category-error", describe(error));
  }
});

async function loadArchives() {
  const { archives } = await api.get("/api/admin/archives");
  state.archives = archives;

  document.getElementById("archive-list").innerHTML = archives.length
    ? archives
        .map(
          (archive) => `
          <div class="row">
            <div class="row__main">
              <strong class="row__title">${escapeHtml(archive.name)}</strong>
              <span class="row__sub">Category ${archive.categoryCode} · ${archive.videoCount} videos</span>
            </div>
            <button class="btn btn--danger btn--sm" data-del-archive="${archive.id}" type="button">Delete</button>
          </div>`,
        )
        .join("")
    : '<p class="empty">No archives yet.</p>';

  document.querySelectorAll("[data-del-archive]").forEach((button) => {
    button.addEventListener("click", async () => {
      const archive = archives.find((item) => item.id === button.dataset.delArchive);
      if (!window.confirm(`Delete "${archive.name}" and its ${archive.videoCount} video entries?\n\nThe video files on your server are NOT deleted.`)) {
        return;
      }
      await api.del(`/api/admin/archives/${button.dataset.delArchive}`);
      await Promise.all([loadArchives(), loadDashboard()]);
    });
  });

  const importOptions = archives
    .map((archive) => `<option value="${archive.id}">${escapeHtml(archive.name)} (cat ${archive.categoryCode})</option>`)
    .join("");
  document.getElementById("import-archive").innerHTML = importOptions || '<option value="">Create an archive first</option>';
  refreshImportButton();
}

document.getElementById("archive-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setError("archive-error", "");
  try {
    await api.post("/api/admin/archives", {
      categoryCode: document.getElementById("archive-category").value,
      name: document.getElementById("archive-name").value.trim(),
    });
    document.getElementById("archive-name").value = "";
    await Promise.all([loadArchives(), loadCategories(), loadDashboard()]);
  } catch (error) {
    setError("archive-error", describe(error));
  }
});

async function browse(relPath) {
  setError("fs-error", "");
  try {
    const listing = await api.get(`/api/admin/files?path=${encodeURIComponent(relPath)}`);
    state.cwd = listing.relPath;

    document.getElementById("fs-path").textContent = `/${listing.relPath}`;
    document.getElementById("fs-up").disabled = listing.isRoot;

    document.getElementById("fs-list").innerHTML = listing.entries.length
      ? listing.entries
          .map((entry) => {
            const glyph =
              entry.type === "directory"
                ? icon("folder")
                : entry.kind === "archive"
                  ? icon("box")
                  : entry.kind === "video"
                    ? icon("film")
                    : entry.kind === "image"
                      ? icon("image")
                      : icon("doc");
            const meta =
              entry.type === "directory"
                ? "folder"
                : [formatBytes(entry.sizeBytes), entry.kind === "video" && !entry.playable ? "needs transcode" : null]
                    .filter(Boolean)
                    .join(" · ");
            const selectable = entry.type === "directory" || entry.kind === "video" || entry.kind === "archive";

            return `
              <div class="fsrow${selectable ? " is-selectable" : ""}" data-path="${escapeHtml(entry.relPath)}" data-type="${entry.type}" data-kind="${entry.kind}">
                <span class="fsrow__icon">${glyph}</span>
                <span class="fsrow__name">${escapeHtml(entry.name)}</span>
                <span class="fsrow__meta">${meta}</span>
              </div>`;
          })
          .join("")
      : '<p class="empty">This folder is empty.</p>';

    document.querySelectorAll(".fsrow").forEach((row) => {
      row.addEventListener("click", () => {
        if (row.dataset.type === "directory") {
          select(row.dataset.path, "directory");
          browse(row.dataset.path);
          return;
        }
        if (row.dataset.kind === "video" || row.dataset.kind === "archive") {
          document.querySelectorAll(".fsrow").forEach((node) => node.classList.remove("is-selected"));
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
  document.getElementById("import-selection").textContent = `/${relPath} (${kind})`;
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
  button.textContent = "Importing…";
  result.hidden = true;
  setError("fs-error", "");

  try {
    const response = await api.post(`/api/admin/archives/${document.getElementById("import-archive").value}/import`, {
      relPath: state.selection.relPath,
    });

    const parts = [
      `${response.added} video${response.added === 1 ? "" : "s"} added`,
      response.skipped ? `${response.skipped} already present` : null,
      response.notPlayable ? `${response.notPlayable} need transcoding to play in a browser` : null,
      response.extraction ? `${response.extraction.extracted} extracted from the zip` : null,
      response.extraction?.skipped ? `${response.extraction.skipped} unsafe zip entries skipped` : null,
    ].filter(Boolean);

    result.textContent = parts.join(" · ");
    result.hidden = false;
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

    document.getElementById("key-value").textContent = created.key;
    document.getElementById("key-output").hidden = false;
    document.getElementById("key-label").value = "";
    await Promise.all([loadKeys(), loadDashboard()]);
  } catch (error) {
    setError("key-error", describe(error));
  }
});

document.getElementById("key-copy").addEventListener("click", async () => {
  const button = document.getElementById("key-copy");
  try {
    await navigator.clipboard.writeText(document.getElementById("key-value").textContent);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Select it manually";
  }
  setTimeout(() => {
    button.textContent = "Copy key";
  }, 1800);
});

async function loadKeys() {
  const status = document.getElementById("key-filter").value;
  const search = document.getElementById("key-search").value.trim();
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (search) query.set("search", search);

  const { items, total } = await api.get(`/api/admin/keys?${query}`);

  document.getElementById("key-list").innerHTML = items.length
    ? `<p class="list__count">${items.length} of ${total}</p>` +
      items
        .map((key) => {
          const tone = key.status === "active" ? "ok" : key.status === "expired" ? "warn" : "bad";
          return `
            <div class="row">
              <div class="row__main">
                <strong class="row__title mono">${escapeHtml(key.keyHint)}</strong>
                <span class="row__sub">
                  ${key.label ? `${escapeHtml(key.label)} · ` : ""}Category ${key.categoryCode}
                  · ends ${formatDate(key.planExpiresAt)}
                  · ${key.boundIp ? `locked to ${escapeHtml(key.boundIp)}` : "not yet claimed"}
                </span>
              </div>
              <div class="row__actions">
                <span class="pill pill--${tone}">${key.status}</span>
                ${key.status === "active" ? `<button class="btn btn--danger btn--sm" data-expire="${key.id}" type="button">Expire now</button>` : `<button class="btn btn--ghost btn--sm" data-extend="${key.id}" type="button">+30 days</button>`}
                ${key.boundIp ? `<button class="btn btn--ghost btn--sm" data-release="${key.id}" type="button">Unlock IP</button>` : ""}
              </div>
            </div>`;
        })
        .join("")
    : '<p class="empty">No keys match.</p>';

  bindKeyAction("data-expire", "expire", "Expire this subscription now? The viewer is signed out immediately.");
  bindKeyAction("data-extend", "extend", null, { additionalDays: 30 });
  bindKeyAction("data-release", "release-ip", "Unlock the IP binding so this key can be claimed from a new network?");
}

function bindKeyAction(attribute, path, confirmMessage, body) {
  document.querySelectorAll(`[${attribute}]`).forEach((button) => {
    button.addEventListener("click", async () => {
      if (confirmMessage && !window.confirm(confirmMessage)) return;
      const id = button.getAttribute(attribute);
      button.disabled = true;
      try {
        await api.post(`/api/admin/keys/${id}/${path}`, body);
        await Promise.all([loadKeys(), loadDashboard()]);
      } catch (error) {
        window.alert(describe(error));
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
    await Promise.all([loadBroadcasts(), loadDashboard()]);
  } catch (error) {
    setError("bc-error", describe(error));
  }
});

async function loadBroadcasts() {
  const { broadcasts } = await api.get("/api/admin/broadcasts");

  document.getElementById("broadcast-list").innerHTML = broadcasts.length
    ? broadcasts
        .map(
          (broadcast) => `
          <div class="row">
            <div class="row__main">
              <strong class="row__title">${escapeHtml(broadcast.title)}</strong>
              <span class="row__sub">
                ${escapeHtml(broadcast.message.slice(0, 90))}${broadcast.message.length > 90 ? "…" : ""}
                · ${broadcast.ackCount} read · ${formatDate(broadcast.createdAt)}
              </span>
            </div>
            <div class="row__actions">
              ${broadcast.active ? '<span class="pill pill--ok">Showing</span>' : '<span class="pill">Closed</span>'}
              ${broadcast.active ? `<button class="btn btn--ghost btn--sm" data-stop="${broadcast.id}" type="button">Stop</button>` : ""}
            </div>
          </div>`,
        )
        .join("")
    : '<p class="empty">Nothing sent yet.</p>';

  document.querySelectorAll("[data-stop]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api.post(`/api/admin/broadcasts/${button.dataset.stop}/deactivate`);
      await Promise.all([loadBroadcasts(), loadDashboard()]);
    });
  });
}

async function loadActivity() {
  try {
    const [live, audit] = await Promise.all([api.get("/api/admin/live"), api.get("/api/admin/audit")]);

    document.getElementById("live-list").innerHTML = live.viewers.length
      ? live.viewers
          .map(
            (viewer) => `
            <div class="row">
              <div class="row__main">
                <strong class="row__title mono">${escapeHtml(viewer.keyHint)}</strong>
                <span class="row__sub">
                  Category ${viewer.categoryCode} · ${escapeHtml(viewer.ipFingerprint)}
                  · last seen ${new Date(viewer.lastSeenAt).toLocaleTimeString()}
                </span>
              </div>
              <span class="pill pill--live">live</span>
            </div>`,
          )
          .join("")
      : '<p class="empty">Nobody is watching right now.</p>';

    document.getElementById("audit-list").innerHTML = audit.entries.length
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
      : '<p class="empty">No activity recorded yet.</p>';
  } catch {
    /* dashboard handles auth failures */
  }
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

api
  .get("/api/admin/overview")
  .then(() => enterConsole())
  .catch(() => {
    loginView.hidden = false;
    document.getElementById("admin-token").focus();
  });
