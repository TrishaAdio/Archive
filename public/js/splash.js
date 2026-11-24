const SEEN_KEY = "gp_splash_v1";
const MIN_VISIBLE_MS = 2200;
const MAX_WAIT_MS = 10000;

const CHARACTER_IMAGES = [
  "/img/characters/reze-smile.webp",
  "/img/characters/rize-glasses.webp",
  "/img/characters/reze-cafe.webp",
  "/img/characters/rize-lean.webp",
  "/img/characters/banner-girl.webp",
];

const NEXT_PAGE_ASSETS = ["/css/app.css", "/js/app.js", "/js/player.js", "/js/presence.js", "/media/seal-poster.webp"];

const STEPS = [
  [0, "Warming up the archive"],
  [0.3, "Loading the seal"],
  [0.6, "Bringing in the cast"],
  [0.88, "Almost there"],
  [1, "Ready"],
];

function sealVideoUrl() {
  const probe = document.createElement("video");
  return probe.canPlayType('video/webm; codecs="vp9"') ? "/media/seal.webm" : "/media/seal.mp4";
}

async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url, { cache: "force-cache", credentials: "same-origin" });
  if (!response.ok || !response.body) {
    onProgress(1);
    return;
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (total) onProgress(Math.min(1, received / total));
  }
  onProgress(1);
}

function loadFonts() {
  if (!document.fonts?.load) return Promise.resolve();
  return Promise.all([
    document.fonts.load('400 16px "Plus Jakarta Sans"'),
    document.fonts.load('800 40px "Plus Jakarta Sans"'),
    document.fonts.load('italic 500 40px "Bodoni Moda"'),
    document.fonts.load('500 12px "Martian Mono"'),
  ]).catch(() => null);
}

function shouldShow() {
  return document.documentElement.getAttribute("data-splash") === "on";
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    return;
  }
}

function runSplash() {
  const root = document.documentElement;
  if (!shouldShow()) {
    root.classList.add("is-ready");
    return Promise.resolve({ shown: false });
  }

  const splash = document.getElementById("splash");
  const fill = document.getElementById("splash-fill");
  const pct = document.getElementById("splash-pct");
  const step = document.getElementById("splash-step");
  const startedAt = performance.now();

  const tasks = [
    { weight: 4, run: (report) => fetchWithProgress(sealVideoUrl(), report) },
    { weight: 2, run: (report) => loadFonts().then(() => report(1)) },
    ...CHARACTER_IMAGES.map((url) => ({ weight: 1, run: (report) => fetchWithProgress(url, report) })),
    ...NEXT_PAGE_ASSETS.map((url) => ({ weight: 0.5, run: (report) => fetchWithProgress(url, report) })),
  ];

  const totalWeight = tasks.reduce((sum, task) => sum + task.weight, 0);
  const progress = tasks.map(() => 0);
  let shown = 0;

  function render() {
    const real = tasks.reduce((sum, task, index) => sum + task.weight * progress[index], 0) / totalWeight;
    const elapsed = performance.now() - startedAt;
    const paced = Math.min(real, elapsed / MIN_VISIBLE_MS);
    shown = Math.max(shown, paced);
    fill.style.setProperty("--progress", shown.toFixed(3));
    pct.textContent = `${Math.round(shown * 100)}%`;
    step.textContent = STEPS.filter(([at]) => shown >= at).pop()[1];
  }

  const ticker = setInterval(render, 90);

  const work = Promise.all(
    tasks.map((task, index) =>
      task
        .run((value) => {
          progress[index] = value;
        })
        .catch(() => {
          progress[index] = 1;
        }),
    ),
  );

  const minimum = new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS));
  const ceiling = new Promise((resolve) => setTimeout(resolve, MAX_WAIT_MS));

  return Promise.race([Promise.all([work, minimum]), ceiling]).then(
    () =>
      new Promise((resolve) => {
        progress.fill(1);
        shown = 1;
        render();
        clearInterval(ticker);
        markSeen();

        setTimeout(() => {
          root.classList.add("is-ready");
          splash.classList.add("is-leaving");
          setTimeout(() => {
            root.removeAttribute("data-splash");
            splash.classList.remove("is-leaving");
            resolve({ shown: true });
          }, 760);
        }, 260);
      }),
  );
}

export { runSplash };
