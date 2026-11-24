import {
  api,
  ApiError,
  daysLeft,
  escapeHtml,
  formatCount,
  formatDate,
  formatDuration,
  icon,
  plural,
  revealOnScroll,
} from "./api.js";
import { startPresence } from "./presence.js";
import { createPlayer } from "./player.js";

const PAGE_SIZE = 24;

const views = {
  home: document.getElementById("view-home"),
  archive: document.getElementById("view-archive"),
  player: document.getElementById("view-player"),
};

const navBack = document.getElementById("nav-back");
const planPill = document.getElementById("plan-pill");
const sheet = document.getElementById("account-sheet");

const state = {
  viewer: null,
  category: null,
  archives: [],
  archive: null,
  sort: "popular",
  videos: [],
  total: 0,
  loading: false,
};

function leaveToGate(message) {
  const target = message ? `/?reason=${encodeURIComponent(message)}` : "/";
  window.location.replace(target);
}

function showView(name) {
  Object.entries(views).forEach(([key, node]) => {
    node.hidden = key !== name;
  });
  navBack.hidden = name === "home";
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

function route(push = true) {
  const params = new URLSearchParams(window.location.search);
  const videoId = params.get("v");
  const archiveId = params.get("a");

  if (videoId) return openPlayer(videoId, { push: false });
  if (archiveId) return openArchive(archiveId, { push: false });
  return openHome({ push: false });
}

function pushUrl(query) {
  const url = query ? `/watch?${query}` : "/watch";
  if (window.location.pathname + window.location.search !== url) {
    window.history.pushState({}, "", url);
  }
}

function thumbUrl(videoId) {
  return `/api/thumb/${videoId}`;
}

function progressBarMarkup(percent) {
  if (!percent) return "";
  return `<span class="thumb__progress"><span class="thumb__progress-fill" data-percent="${percent}"></span></span>`;
}

function applyProgressWidths(root) {
  root.querySelectorAll(".thumb__progress-fill[data-percent]").forEach((node) => {
    node.style.width = `${Math.min(100, Number(node.dataset.percent) || 0)}%`;
  });
}

function videoCardMarkup(video, { showArchive } = {}) {
  const duration = formatDuration(video.durationSeconds);
  const badge = video.playable
    ? duration
      ? `<span class="thumb__duration">${duration}</span>`
      : ""
    : `<span class="thumb__duration thumb__duration--warn">Needs transcode</span>`;

  return `
    <article class="vcard reveal" data-video="${video.id}" tabindex="0" role="button">
      <div class="thumb">
        <img class="thumb__img" src="${thumbUrl(video.id)}" alt="" loading="lazy" decoding="async" />
        <span class="thumb__number">#${video.number}</span>
        ${badge}
        ${progressBarMarkup(video.progressPercent)}
        <span class="thumb__play" aria-hidden="true">${icon("play", { solid: true })}</span>
      </div>
      <h3 class="vcard__title">${escapeHtml(video.title)}</h3>
      <p class="vcard__meta">
        ${plural(video.viewCount, "view")} · ${plural(video.likeCount, "like")}
        ${showArchive && video.archiveName ? ` · ${escapeHtml(video.archiveName)}` : ""}
      </p>
    </article>`;
}

function bindVideoCards(root, handler) {
  root.querySelectorAll("[data-video]").forEach((node) => {
    const open = () => handler(node.dataset.video);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

async function openHome({ push = true } = {}) {
  showView("home");
  if (push) pushUrl("");

  const grid = document.getElementById("archive-grid");
  if (!state.archives.length) {
    grid.innerHTML = Array.from({ length: 2 }, () => '<div class="skeleton archive-skeleton"></div>').join("");
  }

  try {
    const home = await api.get("/api/home");
    state.viewer = home.viewer;
    state.category = home.category;
    state.archives = home.archives;

    renderPlan(home.viewer, home.category);
    renderHero(home.category, home.archives);
    renderResume(home.continueWatching);
    renderArchives(home.archives);
  } catch (error) {
    handleAuthError(error);
  }
}

function renderPlan(viewer, category) {
  const remaining = daysLeft(viewer.planExpiresAt);
  planPill.hidden = false;
  planPill.textContent = remaining > 0 ? `${remaining} day${remaining === 1 ? "" : "s"} left` : "Expiring";
  planPill.className = `pill ${remaining <= 3 ? "pill--warn" : "pill--ok"}`;

  document.getElementById("account-key").textContent = viewer.keyHint;
  document.getElementById("account-tier").textContent = category?.name ?? `Code ${category?.code ?? "—"}`;
  document.getElementById("account-ip").textContent = viewer.lockedIp ?? "—";
  document.getElementById("account-expiry").textContent = formatDate(viewer.planExpiresAt);
}

function renderHero(category, archives) {
  const videoTotal = archives.reduce((sum, archive) => sum + archive.videoCount, 0);
  document.getElementById("hero-eyebrow").textContent = `Tier ${category.code}`;
  document.getElementById("hero-title").textContent = category.name ?? `Category ${category.code}`;
  document.getElementById("hero-sub").textContent = archives.length
    ? `${archives.length} archive${archives.length === 1 ? "" : "s"} · ${videoTotal} video${videoTotal === 1 ? "" : "s"} available to you`
    : "";
}

function renderResume(items) {
  const section = document.getElementById("resume-section");
  const rail = document.getElementById("resume-rail");

  if (!items.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  rail.innerHTML = items.map((video) => videoCardMarkup(video, { showArchive: true })).join("");
  applyProgressWidths(rail);
  bindVideoCards(rail, (id) => openPlayer(id));
  revealOnScroll(rail);
}

function renderArchives(archives) {
  const grid = document.getElementById("archive-grid");
  const empty = document.getElementById("archive-empty");
  const count = document.getElementById("archive-count");

  count.textContent = archives.length ? `${archives.length}` : "";
  empty.hidden = archives.length > 0;

  grid.innerHTML = archives
    .map(
      (archive) => `
      <article class="acard reveal" data-archive="${archive.id}">
        <div class="acard__body">
          <h3 class="acard__title">${escapeHtml(archive.name)}</h3>
          <p class="acard__meta">${archive.videoCount} video${archive.videoCount === 1 ? "" : "s"}</p>
          ${archive.description ? `<p class="acard__desc">${escapeHtml(archive.description)}</p>` : ""}
        </div>
        <button class="btn btn--primary acard__cta" type="button" data-start="${archive.id}">
          Start Watching
        </button>
      </article>`,
    )
    .join("");

  grid.querySelectorAll("[data-start]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      openArchive(node.dataset.start);
    });
  });

  revealOnScroll(grid);
}

async function openArchive(archiveId, { push = true, sort } = {}) {
  showView("archive");
  if (push) pushUrl(`a=${encodeURIComponent(archiveId)}`);

  state.archive = archiveId;
  state.sort = sort ?? state.sort;
  state.videos = [];

  document.querySelectorAll(".sort").forEach((node) => {
    node.classList.toggle("is-active", node.dataset.sort === state.sort);
  });

  const grid = document.getElementById("video-grid");
  grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton video-skeleton"></div>').join("");

  await loadVideoPage({ replace: true });
}

async function loadVideoPage({ replace = false } = {}) {
  if (state.loading) return;
  state.loading = true;

  const grid = document.getElementById("video-grid");
  const status = document.getElementById("video-status");
  const loadMore = document.getElementById("load-more");

  try {
    const skip = replace ? 0 : state.videos.length;
    const page = await api.get(
      `/api/archives/${state.archive}/videos?sort=${state.sort}&skip=${skip}&limit=${PAGE_SIZE}`,
    );

    state.total = page.total;
    state.videos = replace ? page.videos : [...state.videos, ...page.videos];

    document.getElementById("archive-title").textContent = page.archive.name;
    document.getElementById("archive-sub").textContent = `${page.total} video${page.total === 1 ? "" : "s"} in this archive`;

    if (replace) grid.innerHTML = "";
    if (state.videos.length === 0) {
      grid.innerHTML = '<p class="empty">This archive has no videos yet.</p>';
    } else {
      grid.insertAdjacentHTML("beforeend", page.videos.map((video) => videoCardMarkup(video)).join(""));
      applyProgressWidths(grid);
      bindVideoCards(grid, (id) => openPlayer(id));
      revealOnScroll(grid);
    }

    const remaining = state.total - state.videos.length;
    loadMore.hidden = remaining <= 0;
    status.textContent = state.total ? `Showing ${state.videos.length} of ${state.total}` : "";
  } catch (error) {
    handleAuthError(error);
  } finally {
    state.loading = false;
  }
}

const player = createPlayer({
  onError: (message) => {
    const box = document.getElementById("player-error");
    box.textContent = message;
    box.hidden = !message;
  },
  onAuthError: handleAuthError,
});

async function openPlayer(videoId, { push = true } = {}) {
  showView("player");
  if (push) pushUrl(`v=${encodeURIComponent(videoId)}`);

  document.getElementById("player-error").hidden = true;

  try {
    const video = await api.get(`/api/videos/${videoId}`);

    document.getElementById("player-number").textContent = `#${video.number}`;
    document.getElementById("player-title").textContent = video.title;
    const renderMeta = (viewCount) => {
      document.getElementById("player-meta").textContent = [
        plural(viewCount, "view"),
        video.archive?.name,
        formatDuration(video.durationSeconds),
      ]
        .filter(Boolean)
        .join(" · ");
    };

    renderMeta(video.viewCount);
    renderLike(video);
    document.getElementById("back-to-archive").onclick = () => openArchive(video.archiveId);

    const started = await player.load(video);
    if (Number.isFinite(started?.viewCount)) renderMeta(started.viewCount);
    loadUpNext(video);
  } catch (error) {
    handleAuthError(error);
  }
}

function renderLike(video) {
  const button = document.getElementById("like-button");
  const count = document.getElementById("like-count");

  count.textContent = formatCount(video.likeCount);
  button.classList.toggle("is-liked", video.liked);
  button.setAttribute("aria-pressed", String(Boolean(video.liked)));

  button.onclick = async () => {
    button.disabled = true;
    button.classList.add("is-popping");
    try {
      const result = await api.post(`/api/videos/${video.id}/like`);
      video.liked = result.liked;
      video.likeCount = result.likeCount;
      count.textContent = formatCount(result.likeCount);
      button.classList.toggle("is-liked", result.liked);
      button.setAttribute("aria-pressed", String(result.liked));
    } catch (error) {
      handleAuthError(error);
    } finally {
      button.disabled = false;
      setTimeout(() => button.classList.remove("is-popping"), 420);
    }
  };
}

async function loadUpNext(video) {
  const section = document.getElementById("upnext-section");
  const rail = document.getElementById("upnext-rail");

  try {
    const page = await api.get(`/api/archives/${video.archiveId}/videos?sort=popular&limit=12`);
    const others = page.videos.filter((item) => item.id !== video.id).slice(0, 10);

    if (!others.length) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    rail.innerHTML = others.map((item) => videoCardMarkup(item)).join("");
    applyProgressWidths(rail);
    bindVideoCards(rail, (id) => openPlayer(id));
    revealOnScroll(rail);
  } catch {
    section.hidden = true;
  }
}

function handleAuthError(error) {
  if (!(error instanceof ApiError)) {
    console.error(error);
    return;
  }

  if (error.status === 401) return leaveToGate();
  if (error.status === 403) {
    if (["ip_mismatch", "subscription_expired", "subscription_revoked", "plan_not_started"].includes(error.code)) {
      return leaveToGate(error.message);
    }
  }

  const box = document.getElementById("player-error");
  if (box && !views.player.hidden) {
    box.textContent = error.message;
    box.hidden = false;
  } else {
    console.warn(error.message);
  }
}

navBack.addEventListener("click", () => {
  if (!views.player.hidden && state.archive) return openArchive(state.archive);
  return openHome();
});

document.querySelectorAll(".sort").forEach((node) => {
  node.addEventListener("click", () => openArchive(state.archive, { push: false, sort: node.dataset.sort }));
});

document.getElementById("load-more").addEventListener("click", () => loadVideoPage());

document.getElementById("menu-toggle").addEventListener("click", () => {
  sheet.hidden = !sheet.hidden;
});

document.getElementById("sheet-close").addEventListener("click", () => {
  sheet.hidden = true;
});

sheet.addEventListener("click", (event) => {
  if (event.target === sheet) sheet.hidden = true;
});

document.getElementById("logout-button").addEventListener("click", async () => {
  player.teardown();
  try {
    await api.post("/api/gate/logout");
  } catch {
    /* leaving regardless */
  }
  leaveToGate();
});

window.addEventListener("popstate", () => route(false));

startPresence({ onExpired: (error) => leaveToGate(error.message) });
route();
