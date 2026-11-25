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
import {
  afterTransition,
  closeScrim,
  countUp,
  enableTouchLight,
  enhanceButtons,
  greeting,
  isOnScreen,
  haptic,
  prefersReducedMotion,
  splitReveal,
  syncSegmented,
  toast,
  trackScroll,
  watchSegmented,
  withViewTransition,
} from "./ui.js";
import { startPresence } from "./presence.js";
import { createPlayer } from "./player.js";
import { startSilk } from "./silk.js";

const PAGE_SIZE = 24;
const RING_LENGTH = 326.73;
const SESSION_ENDING_CODES = ["ip_mismatch", "subscription_expired", "subscription_revoked", "plan_not_started"];
const SESSION_ENDED_MESSAGE = "Your session has ended. If your plan is still active, enter your key again.";

const views = {
  home: document.getElementById("view-home"),
  archive: document.getElementById("view-archive"),
  player: document.getElementById("view-player"),
};

const navBack = document.getElementById("nav-back");
const planPill = document.getElementById("plan-pill");
const sheet = document.getElementById("account-sheet");
const sortControl = document.getElementById("sort-control");
const searchInput = document.getElementById("video-search");
const searchClear = document.getElementById("video-search-clear");

const state = {
  viewer: null,
  category: null,
  archives: [],
  archive: null,
  sort: "popular",
  query: "",
  videos: [],
  total: 0,
  loading: false,
  requestId: 0,
  currentView: "home",
  gridArchive: null,
  gridKey: null,
  archiveScroll: 0,
  playingId: null,
};

function leaveToGate(message) {
  const target = message ? `/?reason=${encodeURIComponent(message)}` : "/";
  window.location.replace(target);
}

function showView(name, morphs = [], { scrollTop = 0 } = {}) {
  const changed = state.currentView !== name;
  const leavingPlayer = state.currentView === "player" && name !== "player";
  if (state.currentView === "archive" && changed) state.archiveScroll = window.scrollY;
  state.currentView = name;
  if (leavingPlayer) player.pause();

  const apply = () => {
    Object.entries(views).forEach(([key, node]) => {
      node.hidden = key !== name;
    });
    navBack.hidden = name === "home";
    if (changed) window.scrollTo({ top: scrollTop, behavior: "instant" });
    if (name === "archive") syncSegmented(sortControl, { instant: changed });
  };

  const settled = changed ? withViewTransition(apply, morphs) : (apply(), Promise.resolve());
  if (leavingPlayer) {
    settled.then(() => {
      if (state.currentView !== "player") player.teardown();
    });
  }
  return settled;
}

function route() {
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

function markImagesOnLoad(root) {
  root.querySelectorAll("img[data-fade]:not(.is-loaded)").forEach((img) => {
    const done = () => img.classList.add("is-loaded");
    if (img.complete && img.naturalWidth > 0) done();
    else img.addEventListener("load", done, { once: true });
  });
}

function progressBarMarkup(percent) {
  if (!percent) return "";
  return `<span class="thumb__progress"><span class="thumb__progress-fill" data-percent="${percent}"></span></span>`;
}

function applyProgressWidths(root) {
  requestAnimationFrame(() => {
    root.querySelectorAll(".thumb__progress-fill[data-percent]").forEach((node) => {
      node.style.width = `${Math.min(100, Number(node.dataset.percent) || 0)}%`;
    });
  });
}

function videoCardMarkup(video, { showArchive } = {}) {
  const duration = formatDuration(video.durationSeconds);
  const badge = video.playable
    ? duration
      ? `<span class="thumb__duration">${duration}</span>`
      : ""
    : `<span class="thumb__duration thumb__duration--warn">Needs transcode</span>`;

  const likes = video.liked
    ? `<span class="vcard__liked">${icon("heart", { solid: true })} ${formatCount(video.likeCount)}</span>`
    : plural(video.likeCount, "like");

  return `
    <article class="vcard reveal" data-video="${video.id}" data-light tabindex="0" role="button" aria-label="Play #${video.number} ${escapeHtml(video.title)}">
      <div class="thumb" data-light-host>
        <img class="thumb__img" data-fade src="${thumbUrl(video.id)}" alt="" loading="lazy" decoding="async" />
        <span class="thumb__number">#${video.number}</span>
        ${progressBarMarkup(video.progressPercent)}
        ${badge}
        <span class="thumb__play" aria-hidden="true">${icon("play", { solid: true })}</span>
      </div>
      <h3 class="vcard__title">${escapeHtml(video.title)}</h3>
      <p class="vcard__meta">
        ${plural(video.viewCount, "view")} · ${likes}
        ${showArchive && video.archiveName ? ` · ${escapeHtml(video.archiveName)}` : ""}
      </p>
    </article>`;
}

function hydrateCards(root, handler) {
  root.querySelectorAll("[data-video]:not([data-bound])").forEach((node) => {
    node.dataset.bound = "1";
    const open = () => handler(node.dataset.video, node);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
  markImagesOnLoad(root);
  applyProgressWidths(root);
  enableTouchLight(root);
  revealOnScroll(root);
}

function cardMorphs(card, pairs) {
  if (!card) return [];
  return pairs
    .map(([selector, name, target]) => ({ from: card.querySelector(selector), name, to: () => document.getElementById(target) }))
    .filter((pair) => pair.from);
}

function openVideoCard(id, card) {
  return openPlayer(id, { from: card });
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
    renderHero(home.category, home.archives, home.viewer, home.continueWatching);
    renderResume(home.continueWatching);
    renderArchives(home.archives);
  } catch (error) {
    handleAuthError(error);
  }
}

function renderPlan(viewer, category) {
  const remaining = Math.max(0, daysLeft(viewer.planExpiresAt) ?? 0);
  planPill.hidden = false;
  planPill.textContent = remaining > 0 ? `${remaining} day${remaining === 1 ? "" : "s"} left` : "Ends today";
  planPill.className = `pill ${remaining <= 3 ? "pill--warn" : "pill--ok"}`;

  document.getElementById("account-key").textContent = viewer.keyHint;
  document.getElementById("account-tier").textContent = category?.name ?? `Code ${category?.code ?? "—"}`;
  document.getElementById("account-ip").textContent = viewer.lockedIp ?? "—";
  document.getElementById("account-expiry").textContent = formatDate(viewer.planExpiresAt);
}

function renderPlanRing() {
  const viewer = state.viewer;
  if (!viewer) return;

  const start = new Date(viewer.planStartsAt ?? Date.now()).getTime();
  const end = new Date(viewer.planExpiresAt).getTime();
  const span = Math.max(1, end - start);
  const fraction = Math.min(1, Math.max(0, (end - Date.now()) / span));
  const remaining = Math.max(0, daysLeft(viewer.planExpiresAt) ?? 0);

  const progress = document.getElementById("plan-progress");
  progress.style.setProperty("--plan-offset", String(RING_LENGTH));
  requestAnimationFrame(() =>
    requestAnimationFrame(() => progress.style.setProperty("--plan-offset", String(RING_LENGTH * (1 - fraction)))),
  );

  document.getElementById("plan-days").dataset.value = "0";
  countUp(document.getElementById("plan-days"), remaining, { duration: 1200 });
  document.getElementById("plan-unit").textContent = remaining === 1 ? "day left" : "days left";
}

function castMarkup(name) {
  return `<img class="empty__cast" src="/img/characters/${name}.webp" alt="" aria-hidden="true" decoding="async" />`;
}

function revealHeroCast() {
  const cast = document.getElementById("hero-cast");
  if (!cast || cast.classList.contains("is-in")) return;
  const show = () => requestAnimationFrame(() => cast.classList.add("is-in"));
  if (cast.complete && cast.naturalWidth > 0) show();
  else cast.addEventListener("load", show, { once: true });
}

function trackHeroParallax() {
  const cast = document.getElementById("hero-cast");
  if (!cast || prefersReducedMotion()) return;
  let queued = false;
  window.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const shift = Math.min(160, window.scrollY * 0.28);
        cast.style.setProperty("--cast-shift", `${shift.toFixed(1)}px`);
      });
    },
    { passive: true },
  );
}

function renderHero(category, archives, viewer, resume = []) {
  revealHeroCast();
  const videoTotal = archives.reduce((sum, archive) => sum + archive.videoCount, 0);
  const remaining = Math.max(0, daysLeft(viewer.planExpiresAt) ?? 0);

  document.getElementById("hero-eyebrow").textContent = `Tier ${category.code} · Members`;
  document.getElementById("hero-greeting").textContent = `${greeting()}, welcome back`;
  renderHeroTitle(category.name ?? `Category ${category.code}`);
  document.getElementById("hero-sub").textContent = archives.length
    ? `${plural(archives.length, "archive")} and ${plural(videoTotal, "video")} curated for your tier.`
    : "Your collection is being prepared.";

  document.getElementById("hero-chips").innerHTML = `
    <span class="chip">${icon("layers")}<strong>${formatCount(videoTotal)}</strong> videos</span>
    <span class="chip">${icon("calendar")}<strong>${remaining}</strong> ${remaining === 1 ? "day" : "days"} left</span>
    <span class="chip">${icon("lock")} Network-locked</span>`;

  renderHeroAction(archives, resume);
}

function renderHeroAction(archives, resume) {
  const host = document.getElementById("hero-actions");
  const next = resume.find((video) => video.playable) ?? null;
  const first = archives.find((archive) => archive.videoCount > 0) ?? null;
  if (!next && !first) {
    host.hidden = true;
    return;
  }

  host.hidden = false;
  host.innerHTML = next
    ? `<button class="btn btn--primary hero__cta" type="button">${icon("play", { solid: true })} Continue #${next.number}</button>
       <span class="hero__cta-note">${escapeHtml(next.title)}</span>`
    : `<button class="btn btn--primary hero__cta" type="button">${icon("play", { solid: true })} Start watching</button>
       <span class="hero__cta-note">${escapeHtml(first.name)}</span>`;

  host.querySelector("button").addEventListener("click", () => {
    haptic(10);
    if (next) openPlayer(next.id);
    else openArchive(first.id, { query: "" });
  });
  enhanceButtons(host);
}

function renderHeroTitle(name) {
  const title = document.getElementById("hero-title");
  const words = name.trim().split(/\s+/);
  const lead = words.length > 1 ? words.slice(0, -1).join(" ") : "";
  const accent = document.createElement("em");
  accent.textContent = words.at(-1);
  title.replaceChildren(...(lead ? [document.createTextNode(`${lead} `), accent] : [document.createTextNode(name)]));
  if (prefersReducedMotion()) return;
  splitReveal(title, { delay: 120 });
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
  hydrateCards(rail, openVideoCard);
}

function coverMarkup(archive) {
  const covers = archive.coverVideoIds ?? [];
  const cells = covers.length
    ? covers
        .map((id) => `<span class="acard__cover"><img data-fade src="${thumbUrl(id)}" alt="" loading="lazy" decoding="async" /></span>`)
        .join("")
    : '<span class="acard__cover"></span>';

  return `<div class="acard__covers acard__covers--${Math.max(1, covers.length)}">${cells}</div>`;
}

function renderArchives(archives) {
  const grid = document.getElementById("archive-grid");
  const empty = document.getElementById("archive-empty");
  const count = document.getElementById("archive-count");

  count.textContent = archives.length ? String(archives.length).padStart(2, "0") : "";
  empty.hidden = archives.length > 0;

  grid.innerHTML = archives
    .map(
      (archive) => `
      <article class="acard reveal" data-archive="${archive.id}" data-light>
        ${coverMarkup(archive)}
        <span class="pill acard__count">${plural(archive.videoCount, "video")}</span>
        <div class="acard__body">
          <h3 class="acard__title">${escapeHtml(archive.name)}</h3>
          ${archive.description ? `<p class="acard__desc">${escapeHtml(archive.description)}</p>` : ""}
          <button class="btn btn--primary acard__cta" type="button" data-start="${archive.id}">
            Start Watching ${icon("arrowRight")}
          </button>
        </div>
      </article>`,
    )
    .join("");

  grid.querySelectorAll("[data-archive]").forEach((card) => {
    card.addEventListener("click", () => {
      haptic(10);
      openArchive(card.dataset.archive, { query: "", from: card });
    });
  });

  markImagesOnLoad(grid);
  enhanceButtons(grid);
  enableTouchLight(grid, "[data-light]", { tilt: 7 });
  revealOnScroll(grid);
}

function renderArchiveCover(ids) {
  const cover = document.getElementById("archive-cover");
  const list = (ids ?? []).slice(0, 3);
  cover.dataset.for = state.archive ?? "";
  cover.className = `archive-head__cover archive-head__cover--${Math.max(1, list.length)}`;
  cover.innerHTML = list.length
    ? list.map((id) => `<span class="archive-head__tile"><img data-fade src="${thumbUrl(id)}" alt="" decoding="async" /></span>`).join("")
    : '<span class="archive-head__tile"></span>';
  markImagesOnLoad(cover);
}

function archiveCoverIsCurrent() {
  return document.getElementById("archive-cover").dataset.for === state.archive;
}

function gridKey(archiveId, sort, query) {
  return `${archiveId}|${sort}|${query}`;
}

function playerMorphs() {
  const card = () => {
    const node = state.playingId ? document.querySelector(`#video-grid [data-video="${CSS.escape(state.playingId)}"]`) : null;
    return node && isOnScreen(node) ? node : null;
  };
  return [
    { from: document.getElementById("player-stage"), name: "morph-media", to: () => card()?.querySelector(".thumb") },
  ];
}

async function openArchive(archiveId, { push = true, sort, query, from } = {}) {
  const fromPlayer = state.currentView === "player";
  const sameArchive = state.gridArchive === archiveId;
  const nextSort = sort ?? state.sort;
  const nextQuery = query !== undefined ? query : sameArchive ? state.query : "";
  const reuse =
    sameArchive && state.gridKey === gridKey(archiveId, nextSort, nextQuery) && state.videos.length > 0 && !state.loading;
  const known = state.archives.find((archive) => archive.id === archiveId);

  state.archive = archiveId;
  state.sort = nextSort;
  state.query = nextQuery;
  searchInput.value = nextQuery;
  searchClear.hidden = !nextQuery;

  if (!reuse && known) {
    document.getElementById("archive-title").textContent = known.name;
    document.getElementById("archive-sub").textContent = plural(known.videoCount, "video");
    renderArchiveCover(known.coverVideoIds);
  }

  const morphs = from
    ? cardMorphs(from, [[".acard__covers", "morph-media", "archive-cover"]])
    : fromPlayer && reuse
      ? playerMorphs()
      : [];

  sortControl.querySelectorAll(".sort").forEach((node) => {
    const active = node.dataset.sort === state.sort;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });

  showView("archive", morphs, { scrollTop: fromPlayer && reuse ? state.archiveScroll : 0 });
  if (push) pushUrl(`a=${encodeURIComponent(archiveId)}`);

  if (reuse) {
    refreshCardStats();
    return;
  }

  state.videos = [];
  const grid = document.getElementById("video-grid");
  grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton video-skeleton"></div>').join("");

  await loadVideoPage({ replace: true });
}

async function refreshCardStats() {
  const params = new URLSearchParams({ sort: state.sort, skip: "0", limit: String(Math.min(96, state.videos.length)) });
  if (state.query) params.set("q", state.query);
  try {
    const page = await api.get(`/api/archives/${state.archive}/videos?${params}`);
    await afterTransition();
    page.videos.forEach((video) => {
      const card = document.querySelector(`#video-grid [data-video="${CSS.escape(video.id)}"]`);
      if (!card) return;
      const fresh = document.createElement("template");
      fresh.innerHTML = videoCardMarkup(video).trim();
      const next = fresh.content.firstElementChild;
      card.querySelector(".vcard__meta").replaceWith(next.querySelector(".vcard__meta"));
      card.querySelector(".thumb__progress")?.remove();
      const progress = next.querySelector(".thumb__progress");
      if (progress) card.querySelector(".thumb__number").after(progress);
    });
    applyProgressWidths(document.getElementById("video-grid"));
  } catch (error) {
    handleAuthError(error);
  }
}

async function loadVideoPage({ replace = false } = {}) {
  if (state.loading && !replace) return;
  state.loading = true;
  const requestId = ++state.requestId;

  const grid = document.getElementById("video-grid");
  const status = document.getElementById("video-status");
  const loadMore = document.getElementById("load-more");

  try {
    const skip = replace ? 0 : state.videos.length;
    const params = new URLSearchParams({ sort: state.sort, skip: String(skip), limit: String(PAGE_SIZE) });
    if (state.query) params.set("q", state.query);

    const page = await api.get(`/api/archives/${state.archive}/videos?${params}`);
    if (requestId !== state.requestId) return;

    state.total = page.total;
    state.videos = replace ? page.videos : [...state.videos, ...page.videos];
    state.gridArchive = state.archive;
    state.gridKey = gridKey(state.archive, state.sort, state.query);

    document.getElementById("archive-title").textContent = page.archive.name;
    if (!archiveCoverIsCurrent() && page.videos.length) renderArchiveCover(page.videos.map((video) => video.id));
    document.getElementById("archive-sub").textContent = state.query
      ? `${plural(page.total, "result")} for “${state.query}”`
      : `${plural(page.total, "video")}, numbered #1 to #${page.total || 0}`;

    if (replace) grid.innerHTML = "";

    if (state.videos.length === 0) {
      grid.innerHTML = state.query
        ? `<div class="empty empty--cast">${castMarkup("rize-glasses")}No video matches “${escapeHtml(state.query)}”.</div>`
        : `<div class="empty empty--cast">${castMarkup("reze-smile")}This archive has no videos yet.</div>`;
    } else {
      grid.insertAdjacentHTML("beforeend", page.videos.map((video) => videoCardMarkup(video)).join(""));
      hydrateCards(grid, openVideoCard);
    }

    const remaining = state.total - state.videos.length;
    loadMore.hidden = remaining <= 0;
    status.textContent = state.total ? `${state.videos.length} of ${state.total}` : "";
  } catch (error) {
    handleAuthError(error);
  } finally {
    if (requestId === state.requestId) state.loading = false;
  }
}

const player = createPlayer({
  onError: (message) => {
    const box = document.getElementById("player-error");
    box.textContent = message;
    box.hidden = !message;
  },
  onAuthError: handleAuthError,
  onEnded: () => startUpNext(),
  onUserResume: () => cancelUpNext(),
});

const upNext = { timer: null, video: null };

function startUpNext() {
  const next = upNext.video;
  if (!next) return;

  const overlay = document.getElementById("upnext-overlay");
  const seconds = document.getElementById("upnext-seconds");
  const bar = document.getElementById("upnext-bar");
  const durationMs = 6000;

  document.getElementById("upnext-title").textContent = `#${next.number} ${next.title}`;
  bar.style.setProperty("--upnext-ms", `${durationMs}ms`);
  bar.style.animation = "none";
  void bar.offsetWidth;
  bar.style.animation = "";
  overlay.hidden = false;

  let left = Math.round(durationMs / 1000);
  seconds.textContent = String(left);
  clearInterval(upNext.timer);
  upNext.timer = setInterval(() => {
    left -= 1;
    seconds.textContent = String(Math.max(0, left));
    if (left <= 0) {
      cancelUpNext();
      openPlayer(next.id);
    }
  }, 1000);
}

function cancelUpNext() {
  clearInterval(upNext.timer);
  upNext.timer = null;
  document.getElementById("upnext-overlay").hidden = true;
}

async function openPlayer(videoId, { push = true, from } = {}) {
  cancelUpNext();
  if (state.currentView === "player") player.teardown();
  state.playingId = videoId;

  const playerVideo = document.getElementById("player-video");
  playerVideo.poster = thumbUrl(videoId);
  const cardTitle = from?.querySelector(".vcard__title")?.textContent;
  const cardNumber = from?.querySelector(".thumb__number")?.textContent;
  if (cardTitle) document.getElementById("player-title").textContent = cardTitle;
  if (cardNumber) document.getElementById("player-number").textContent = cardNumber;

  showView(
    "player",
    cardMorphs(from, [[".thumb", "morph-media", "player-stage"]]),
  );
  if (push) pushUrl(`v=${encodeURIComponent(videoId)}`);

  document.getElementById("player-error").hidden = true;
  const ambient = document.getElementById("player-ambient");
  ambient.classList.remove("is-loaded");
  ambient.onload = () => ambient.classList.add("is-loaded");
  afterTransition().then(() => {
    if (state.playingId === videoId) ambient.src = thumbUrl(videoId);
  });

  try {
    const video = await api.get(`/api/videos/${videoId}`);
    state.archive = video.archiveId;

    document.getElementById("player-number").textContent = `#${video.number}`;
    document.getElementById("player-title").textContent = video.title;
    document.title = `#${video.number} ${video.title} — Get Pleasure`;

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
    const optimistic = !video.liked;
    button.classList.toggle("is-liked", optimistic);
    button.classList.remove("is-popping");
    void button.offsetWidth;
    button.classList.add("is-popping");
    if (optimistic) haptic([8, 30, 14]);

    try {
      const result = await api.post(`/api/videos/${video.id}/like`);
      video.liked = result.liked;
      video.likeCount = result.likeCount;
      count.textContent = formatCount(result.likeCount);
      button.classList.toggle("is-liked", result.liked);
      button.setAttribute("aria-pressed", String(result.liked));
    } catch (error) {
      button.classList.toggle("is-liked", Boolean(video.liked));
      handleAuthError(error);
    } finally {
      button.disabled = false;
      setTimeout(() => button.classList.remove("is-popping"), 650);
    }
  };
}

async function loadUpNext(video) {
  const section = document.getElementById("upnext-section");
  const rail = document.getElementById("upnext-rail");
  upNext.video = null;

  try {
    const [popular, ordered] = await Promise.all([
      api.get(`/api/archives/${video.archiveId}/videos?sort=popular&limit=12`),
      api.get(`/api/archives/${video.archiveId}/videos?sort=number&skip=${Math.max(0, video.number)}&limit=1`),
    ]);
    await afterTransition();
    if (state.playingId !== video.id) return;

    const others = popular.videos.filter((item) => item.id !== video.id).slice(0, 10);
    upNext.video = ordered.videos.find((item) => item.playable && item.id !== video.id) ?? others.find((item) => item.playable) ?? null;

    if (!others.length) {
      section.hidden = true;
      return;
    }

    section.hidden = false;
    rail.innerHTML = others.map((item) => videoCardMarkup(item)).join("");
    hydrateCards(rail, openVideoCard);
  } catch {
    section.hidden = true;
  }
}

function handleAuthError(error) {
  if (!(error instanceof ApiError)) {
    console.error(error);
    return;
  }

  if (error.status === 401) return leaveToGate(state.viewer ? SESSION_ENDED_MESSAGE : undefined);
  if (error.status === 403 && SESSION_ENDING_CODES.includes(error.code)) return leaveToGate(error.message);

  const box = document.getElementById("player-error");
  if (box && !views.player.hidden) {
    box.textContent = error.message;
    box.hidden = false;
  } else {
    toast(error.message, { tone: "error" });
  }
}

async function openSheet() {
  sheet.hidden = false;
  renderPlanRing();
  enhanceButtons(sheet);
  document.getElementById("sheet-close").focus();
}

async function closeSheet() {
  if (sheet.hidden) return;
  await closeScrim(sheet);
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const runSearch = debounce(() => {
  const value = searchInput.value.trim();
  if (value === state.query) return;
  state.query = value;
  searchClear.hidden = !value;
  state.videos = [];
  loadVideoPage({ replace: true });
}, 280);

searchInput.addEventListener("input", () => {
  searchClear.hidden = !searchInput.value;
  runSearch();
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    searchInput.value = "";
    runSearch();
  }
});

searchClear.addEventListener("click", () => {
  searchInput.value = "";
  searchClear.hidden = true;
  runSearch();
  searchInput.focus();
});

navBack.addEventListener("click", () => {
  if (!views.player.hidden && state.archive) return openArchive(state.archive);
  return openHome();
});

sortControl.querySelectorAll(".sort").forEach((node) => {
  node.addEventListener("click", () => {
    if (node.dataset.sort === state.sort) return;
    haptic(8);
    openArchive(state.archive, { push: false, sort: node.dataset.sort });
  });
});

document.getElementById("load-more").addEventListener("click", () => loadVideoPage());

if ("IntersectionObserver" in window) {
  const sentinel = document.getElementById("load-sentinel");
  new IntersectionObserver(
    (entries) => {
      if (!entries[0].isIntersecting || views.archive.hidden) return;
      if (state.videos.length > 0 && state.videos.length < state.total) loadVideoPage();
    },
    { rootMargin: "600px 0px" },
  ).observe(sentinel);
}

document.getElementById("upnext-play").addEventListener("click", () => {
  const next = upNext.video;
  cancelUpNext();
  if (next) openPlayer(next.id);
});

document.getElementById("upnext-cancel").addEventListener("click", cancelUpNext);

document.getElementById("menu-toggle").addEventListener("click", () => (sheet.hidden ? openSheet() : closeSheet()));
document.getElementById("sheet-close").addEventListener("click", closeSheet);

sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !sheet.hidden) closeSheet();
  if (event.key === "/" && !views.archive.hidden && document.activeElement !== searchInput) {
    event.preventDefault();
    searchInput.focus();
  }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  player.teardown();
  await api.post("/api/gate/logout").catch(() => null);
  leaveToGate();
});

window.addEventListener("popstate", () => route());

const silk = startSilk({ intensity: 0.78 });
if (document.documentElement.dataset.arrival === "on") {
  silk.settle(window.innerWidth / 2, window.innerHeight * 0.22, { duration: 2600 });
}

function trackStickyToolbar() {
  const toolbar = document.querySelector(".toolbar");
  let queued = false;
  const update = () => {
    queued = false;
    if (views.archive.hidden) return;
    const stickyTop = parseFloat(getComputedStyle(toolbar).top) || 0;
    toolbar.classList.toggle("is-stuck", toolbar.getBoundingClientRect().top <= stickyTop + 1 && window.scrollY > 0);
  };
  window.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
}

trackScroll();
trackHeroParallax();
trackStickyToolbar();
enhanceButtons();
watchSegmented(sortControl);
startPresence({
  onExpired: (error) => leaveToGate(error.status === 401 ? SESSION_ENDED_MESSAGE : error.message),
});
route();
