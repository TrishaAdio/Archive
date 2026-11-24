import { api, ApiError } from "./api.js";

const PROGRESS_INTERVAL_MS = 10000;
const TOKEN_REFRESH_RATIO = 0.55;
const WATERMARK_MOVE_MS = 23000;

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function createPlayer({ onError, onAuthError, onEnded = () => {}, onUserResume = () => {} }) {
  const video = document.getElementById("player-video");
  const stage = document.getElementById("player-stage");
  const spinner = document.getElementById("player-spinner");
  const watermark = document.getElementById("player-watermark");
  const resumeChip = document.getElementById("player-resume");
  let chipTimer = null;

  function showChip(text) {
    clearTimeout(chipTimer);
    resumeChip.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/></svg><span></span>`;
    resumeChip.querySelector("span").textContent = text;
    resumeChip.hidden = false;
    chipTimer = setTimeout(() => {
      resumeChip.hidden = true;
    }, 2600);
  }

  let current = null;
  let token = null;
  let tokenIssuedAt = 0;
  let tokenTtlMs = 120000;
  let progressTimer = null;
  let watermarkTimer = null;
  let lastSaved = -1;
  let recovering = false;

  function setSpinner(visible) {
    spinner.hidden = !visible;
  }

  function tokenIsStale() {
    return !token || Date.now() - tokenIssuedAt > tokenTtlMs * TOKEN_REFRESH_RATIO;
  }

  let lastTokenResult = null;

  async function fetchToken(videoId) {
    const result = await api.post(`/api/videos/${videoId}/stream-token`);
    token = result.url;
    tokenIssuedAt = Date.now();
    tokenTtlMs = (result.expiresInSeconds ?? 120) * 1000;
    lastTokenResult = result;

    if (result.watermark) {
      watermark.textContent = result.watermark;
      watermark.hidden = false;
    }
    return token;
  }

  function moveWatermark() {
    watermark.style.setProperty("--wm-x", `${6 + Math.random() * 60}%`);
    watermark.style.setProperty("--wm-y", `${6 + Math.random() * 46}%`);
  }

  async function saveProgress({ keepalive = false } = {}) {
    if (!current || !Number.isFinite(video.currentTime)) return;

    const position = Math.floor(video.currentTime);
    if (position === lastSaved || position < 1) return;
    lastSaved = position;

    const payload = {
      positionSeconds: position,
      durationSeconds: Number.isFinite(video.duration) && video.duration > 0 ? Math.floor(video.duration) : undefined,
    };

    if (keepalive) {
      await fetch(`/api/videos/${current.id}/progress`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => null);
      return;
    }

    try {
      await api.post(`/api/videos/${current.id}/progress`, payload);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) onAuthError(error);
    }
  }

  async function recoverPlayback() {
    if (!current || recovering) return;
    recovering = true;
    const resumeAt = video.currentTime;
    const wasPlaying = !video.paused;

    try {
      const url = await fetchToken(current.id);
      video.src = url;
      video.load();
      await new Promise((resolve) => {
        video.addEventListener("loadedmetadata", resolve, { once: true });
        setTimeout(resolve, 6000);
      });
      if (resumeAt > 0) video.currentTime = resumeAt;
      if (wasPlaying) await video.play().catch(() => {});
      onError("");
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) onAuthError(error);
      else onError("Playback could not be restored. Reload the page to continue.");
    } finally {
      recovering = false;
    }
  }

  async function load(videoDoc) {
    teardown();
    current = videoDoc;
    lastSaved = -1;
    onError("");

    if (!videoDoc.playable) {
      setSpinner(false);
      video.removeAttribute("src");
      onError("This file is not a browser-playable format yet. It needs converting to MP4 or WebM.");
      return null;
    }

    setSpinner(true);

    try {
      const url = await fetchToken(videoDoc.id);
      video.src = url;
      video.load();

      if (videoDoc.progressSeconds > 5) {
        video.addEventListener(
          "loadedmetadata",
          () => {
            if (videoDoc.progressSeconds < video.duration - 10) {
              video.currentTime = videoDoc.progressSeconds;
              showChip(`Resuming from ${formatClock(videoDoc.progressSeconds)}`);
            }
          },
          { once: true },
        );
      }

      progressTimer = setInterval(() => {
        if (!video.paused) saveProgress();
      }, PROGRESS_INTERVAL_MS);

      moveWatermark();
      watermarkTimer = setInterval(moveWatermark, WATERMARK_MOVE_MS);
      return lastTokenResult;
    } catch (error) {
      setSpinner(false);
      if (error instanceof ApiError) {
        if (error.status === 401 || ["ip_mismatch", "subscription_expired", "subscription_revoked"].includes(error.code)) {
          return onAuthError(error);
        }
        return onError(error.message);
      }
      onError("Could not start playback.");
    }
  }

  function teardown() {
    clearInterval(progressTimer);
    clearInterval(watermarkTimer);
    progressTimer = null;
    watermarkTimer = null;

    if (current && video.currentTime > 1) saveProgress({ keepalive: true });

    clearTimeout(chipTimer);
    resumeChip.hidden = true;

    if (video.getAttribute("src")) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    current = null;
    token = null;
    setSpinner(false);
  }

  video.addEventListener("waiting", () => setSpinner(true));
  video.addEventListener("playing", () => setSpinner(false));
  video.addEventListener("canplay", () => setSpinner(false));
  video.addEventListener("pause", () => saveProgress());
  video.addEventListener("ended", () => {
    saveProgress();
    if (current) onEnded(current);
  });
  video.addEventListener("play", () => onUserResume());

  video.addEventListener("seeking", async () => {
    onUserResume();
    if (tokenIsStale() && !recovering) await recoverPlayback();
  });

  video.addEventListener("error", () => {
    if (!current) return;
    setSpinner(false);
    recoverPlayback();
  });

  video.addEventListener("contextmenu", (event) => event.preventDefault());
  stage.addEventListener("contextmenu", (event) => event.preventDefault());
  video.addEventListener("dragstart", (event) => event.preventDefault());

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveProgress({ keepalive: true });
  });

  window.addEventListener("pagehide", () => saveProgress({ keepalive: true }));

  return { load, teardown };
}

export { createPlayer };
