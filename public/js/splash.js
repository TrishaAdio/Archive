const SEEN_KEY = "gp_splash_v1";
const MIN_VISIBLE_MS = 2200;
const MAX_WAIT_MS = 10000;

const STEPS = [
  [0, "Waking the butterfly"],
  [0.5, "Loading the butterfly"],
  [0.9, "Almost there"],
  [1, "Ready"],
];

function sealVideoSource() {
  const probe = document.createElement("video");
  return probe.canPlayType('video/webm; codecs="vp9"')
    ? { url: "/media/seal.webm", type: "video/webm" }
    : { url: "/media/seal.mp4", type: "video/mp4" };
}

async function downloadVideo(url, type, onProgress) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error(`Video download failed: ${response.status}`);

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total) onProgress(Math.min(1, received / total));
  }

  onProgress(1);
  return URL.createObjectURL(new Blob(chunks, { type }));
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
    return Promise.resolve({ shown: false, videoUrl: null });
  }

  const splash = document.getElementById("splash");
  const fill = document.getElementById("splash-fill");
  const pct = document.getElementById("splash-pct");
  const step = document.getElementById("splash-step");
  const startedAt = performance.now();
  const source = sealVideoSource();

  let real = 0;
  let shown = 0;
  let videoUrl = null;

  function render() {
    const paced = Math.min(real, (performance.now() - startedAt) / MIN_VISIBLE_MS);
    shown = Math.max(shown, paced);
    fill.style.setProperty("--progress", shown.toFixed(3));
    pct.textContent = `${Math.round(shown * 100)}%`;
    step.textContent = STEPS.filter(([at]) => shown >= at).pop()[1];
  }

  const ticker = setInterval(render, 90);

  const download = downloadVideo(source.url, source.type, (value) => {
    real = value;
  }).then(
    (url) => {
      videoUrl = url;
    },
    () => {
      real = 1;
    },
  );

  const minimum = new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS));
  const ceiling = new Promise((resolve) => setTimeout(resolve, MAX_WAIT_MS));

  return Promise.race([Promise.all([download, minimum]), ceiling]).then(
    () =>
      new Promise((resolve) => {
        real = 1;
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
            resolve({ shown: true, videoUrl });
          }, 760);
        }, 260);
      }),
  );
}

export { runSplash };
