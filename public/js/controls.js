const SKIP_SECONDS = 10;
const IDLE_MS = 2800;
const DOUBLE_TAP_MS = 300;
const SPEEDS = [1, 1.25, 1.5, 2];

function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

function createControls({ video, stage, onUserSeek = () => {} }) {
  const root = document.getElementById("player-controls");
  const surface = document.getElementById("pc-surface");
  const playButton = document.getElementById("pc-play");
  const backButton = document.getElementById("pc-back");
  const forwardButton = document.getElementById("pc-forward");
  const muteButton = document.getElementById("pc-mute");
  const speedButton = document.getElementById("pc-speed");
  const fullButton = document.getElementById("pc-full");
  const seek = document.getElementById("pc-seek");
  const played = document.getElementById("pc-played");
  const buffered = document.getElementById("pc-buffered");
  const knob = document.getElementById("pc-knob");
  const bubble = document.getElementById("pc-bubble");
  const current = document.getElementById("pc-current");
  const length = document.getElementById("pc-duration");
  const flashBack = document.getElementById("pc-flash-back");
  const flashForward = document.getElementById("pc-flash-forward");

  const hover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let idleTimer = 0;
  let frame = 0;
  let scrubbing = null;
  let lastTap = { at: 0, side: null };

  function duration() {
    return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  }

  function setFraction(fraction) {
    const value = Math.min(1, Math.max(0, fraction || 0));
    played.style.transform = `scaleX(${value})`;
    knob.style.transform = `translateX(${(value * seek.clientWidth).toFixed(1)}px)`;
  }

  function renderTime(seconds = video.currentTime) {
    const total = duration();
    current.textContent = clock(seconds);
    length.textContent = clock(total);
    seek.setAttribute("aria-valuemax", String(Math.round(total)));
    seek.setAttribute("aria-valuenow", String(Math.round(seconds || 0)));
    seek.setAttribute("aria-valuetext", `${clock(seconds)} of ${clock(total)}`);
  }

  function renderBuffered() {
    const total = duration();
    if (!total || !video.buffered.length) {
      buffered.style.transform = "scaleX(0)";
      return;
    }
    let end = 0;
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.buffered.start(index) <= video.currentTime + 0.5) end = Math.max(end, video.buffered.end(index));
    }
    buffered.style.transform = `scaleX(${Math.min(1, end / total)})`;
  }

  function tick() {
    frame = 0;
    if (!scrubbing) setFraction(duration() ? video.currentTime / duration() : 0);
    if (!video.paused && !video.ended) frame = requestAnimationFrame(tick);
  }

  function startTicking() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function syncState() {
    const state = video.ended ? "ended" : video.paused ? "paused" : "playing";
    root.dataset.state = state;
    playButton.setAttribute("aria-label", state === "playing" ? "Pause" : "Play");
    if (state !== "playing") wake({ stay: true });
    else wake();
  }

  function wake({ stay = false } = {}) {
    root.classList.remove("is-idle");
    clearTimeout(idleTimer);
    if (stay || video.paused || scrubbing) return;
    idleTimer = setTimeout(() => root.classList.add("is-idle"), IDLE_MS);
  }

  function sleep() {
    if (video.paused || scrubbing) return;
    clearTimeout(idleTimer);
    root.classList.add("is-idle");
  }

  function togglePlay() {
    if (!video.currentSrc && !video.src) return;
    if (video.paused || video.ended) video.play().catch(() => {});
    else video.pause();
  }

  function skip(seconds) {
    const total = duration();
    if (!total) return;
    video.currentTime = Math.min(total - 0.25, Math.max(0, video.currentTime + seconds));
    onUserSeek();
    renderTime();
    setFraction(video.currentTime / total);
    const flash = seconds < 0 ? flashBack : flashForward;
    flash.classList.remove("is-on");
    void flash.offsetWidth;
    flash.classList.add("is-on");
  }

  function setMuted(muted) {
    video.muted = muted;
    root.classList.toggle("is-muted", muted);
    muteButton.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  }

  function fullscreenElement() {
    return document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
  }

  async function toggleFullscreen() {
    if (fullscreenElement()) {
      await (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document);
      return;
    }
    const request = stage.requestFullscreen ?? stage.webkitRequestFullscreen;
    if (request) {
      try {
        await request.call(stage, { navigationUI: "hide" });
        await screen.orientation?.lock?.("landscape").catch(() => {});
      } catch {
        video.webkitEnterFullscreen?.();
      }
      return;
    }
    video.webkitEnterFullscreen?.();
  }

  function fractionAt(clientX) {
    const rect = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function previewScrub(clientX) {
    const fraction = fractionAt(clientX);
    scrubbing.fraction = fraction;
    setFraction(fraction);
    const seconds = fraction * duration();
    renderTime(seconds);
    bubble.textContent = clock(seconds);
    bubble.style.transform = `translateX(${(fraction * seek.clientWidth).toFixed(1)}px)`;
  }

  seek.addEventListener("pointerdown", (event) => {
    if (!duration()) return;
    event.preventDefault();
    seek.setPointerCapture(event.pointerId);
    scrubbing = { fraction: 0 };
    root.classList.add("is-scrubbing");
    wake({ stay: true });
    previewScrub(event.clientX);
  });

  seek.addEventListener("pointermove", (event) => {
    if (scrubbing) previewScrub(event.clientX);
  });

  const finishScrub = () => {
    if (!scrubbing) return;
    const target = scrubbing.fraction * duration();
    scrubbing = null;
    root.classList.remove("is-scrubbing");
    video.currentTime = Math.min(Math.max(0, target), Math.max(0, duration() - 0.25));
    onUserSeek();
    wake();
  };
  seek.addEventListener("pointerup", finishScrub);
  seek.addEventListener("pointercancel", finishScrub);

  seek.addEventListener("keydown", (event) => {
    const steps = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 };
    if (event.key in steps) {
      event.preventDefault();
      skip(steps[event.key]);
    } else if (event.key === "Home") {
      event.preventDefault();
      skip(-video.currentTime);
    }
  });

  surface.addEventListener("click", (event) => {
    const rect = surface.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const side = x < 0.36 ? "back" : x > 0.64 ? "forward" : null;
    const now = performance.now();
    const isDouble = side && lastTap.side === side && now - lastTap.at < DOUBLE_TAP_MS;
    lastTap = { at: isDouble ? 0 : now, side };

    if (isDouble) {
      skip(side === "back" ? -SKIP_SECONDS : SKIP_SECONDS);
      wake();
      return;
    }
    if (hover) {
      togglePlay();
      return;
    }
    if (root.classList.contains("is-idle")) wake();
    else sleep();
  });

  surface.addEventListener("dblclick", (event) => {
    if (hover) {
      event.preventDefault();
      toggleFullscreen();
    }
  });

  stage.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") wake();
  });
  stage.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") sleep();
  });

  playButton.addEventListener("click", togglePlay);
  backButton.addEventListener("click", () => skip(-SKIP_SECONDS));
  forwardButton.addEventListener("click", () => skip(SKIP_SECONDS));
  muteButton.addEventListener("click", () => setMuted(!video.muted));
  fullButton.addEventListener("click", toggleFullscreen);
  speedButton.addEventListener("click", () => {
    const next = SPEEDS[(SPEEDS.indexOf(video.playbackRate) + 1) % SPEEDS.length] ?? 1;
    video.playbackRate = next;
    speedButton.textContent = `${next}×`;
    speedButton.setAttribute("aria-label", `Playback speed ${next} times`);
  });

  root.addEventListener("focusin", () => wake());

  const onFullscreen = () => root.classList.toggle("is-fullscreen", Boolean(fullscreenElement()));
  document.addEventListener("fullscreenchange", onFullscreen);
  document.addEventListener("webkitfullscreenchange", onFullscreen);

  document.addEventListener("keydown", (event) => {
    if (stage.closest("[hidden]") || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest?.("input, textarea, select, [role='slider']")) return;
    const key = event.key.toLowerCase();
    const actions = {
      " ": togglePlay,
      k: togglePlay,
      j: () => skip(-SKIP_SECONDS),
      l: () => skip(SKIP_SECONDS),
      arrowleft: () => skip(-5),
      arrowright: () => skip(5),
      m: () => setMuted(!video.muted),
      f: toggleFullscreen,
    };
    if (!actions[key]) return;
    if (key === " " && event.target.closest?.("button")) return;
    event.preventDefault();
    actions[key]();
    wake();
  });

  video.addEventListener("play", () => {
    syncState();
    startTicking();
  });
  video.addEventListener("pause", syncState);
  video.addEventListener("ended", syncState);
  video.addEventListener("timeupdate", () => {
    if (!scrubbing) renderTime();
  });
  video.addEventListener("seeked", () => {
    setFraction(duration() ? video.currentTime / duration() : 0);
    renderBuffered();
  });
  video.addEventListener("progress", renderBuffered);
  video.addEventListener("loadedmetadata", () => {
    renderTime();
    renderBuffered();
    setFraction(duration() ? video.currentTime / duration() : 0);
    root.classList.add("is-ready");
  });
  video.addEventListener("volumechange", () => root.classList.toggle("is-muted", video.muted));

  if ("ResizeObserver" in window) {
    new ResizeObserver(() => setFraction(duration() ? video.currentTime / duration() : 0)).observe(seek);
  }

  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    scrubbing = null;
    clearTimeout(idleTimer);
    root.classList.remove("is-idle", "is-scrubbing", "is-ready", "is-leaving");
    root.dataset.state = "paused";
    setFraction(0);
    buffered.style.transform = "scaleX(0)";
    current.textContent = "0:00";
    length.textContent = "0:00";
    video.playbackRate = 1;
    speedButton.textContent = "1×";
  }

  function hideForLeave() {
    root.classList.add("is-leaving");
  }

  reset();
  return { reset, hideForLeave };
}

export { createControls };
