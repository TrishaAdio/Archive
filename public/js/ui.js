import { escapeHtml, icon } from "./api.js";

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;

function ensureToastHost() {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts";
    host.className = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

function toast(message, { tone = "info", duration = 2800 } = {}) {
  const host = ensureToastHost();
  const node = document.createElement("div");
  const glyph = tone === "ok" ? "check" : tone === "error" ? "alert" : "info";
  node.className = `toast toast--${tone}`;
  node.innerHTML = `${icon(glyph)}<span>${escapeHtml(message)}</span>`;
  host.appendChild(node);

  while (host.children.length > 3) host.firstElementChild.remove();

  setTimeout(() => {
    node.classList.add("is-leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }, duration);
}

function closeScrim(scrim) {
  return new Promise((resolve) => {
    if (prefersReducedMotion()) {
      scrim.hidden = true;
      resolve();
      return;
    }
    scrim.classList.add("is-leaving");
    const finish = () => {
      scrim.classList.remove("is-leaving");
      scrim.hidden = true;
      resolve();
    };
    const panel = scrim.querySelector(".sheet-panel");
    (panel ?? scrim).addEventListener("animationend", finish, { once: true });
    setTimeout(finish, 450);
  });
}

function confirmSheet({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.setAttribute("role", "alertdialog");
    scrim.setAttribute("aria-modal", "true");
    scrim.innerHTML = `
      <div class="sheet-panel">
        <p class="eyebrow">${danger ? "Please confirm" : "Confirm"}</p>
        <h2 class="sheet-title">${escapeHtml(title)}</h2>
        <p class="sheet-body">${escapeHtml(message)}</p>
        <div class="sheet-actions">
          <button class="btn ${danger ? "btn--danger" : "btn--primary"} btn--block" data-answer="yes" type="button">${escapeHtml(confirmLabel)}</button>
          <button class="btn btn--ghost btn--block" data-answer="no" type="button">${escapeHtml(cancelLabel)}</button>
        </div>
      </div>`;

    const settle = async (answer) => {
      document.removeEventListener("keydown", onKey);
      await closeScrim(scrim);
      scrim.remove();
      resolve(answer);
    };

    const onKey = (event) => {
      if (event.key === "Escape") settle(false);
    };

    scrim.addEventListener("click", (event) => {
      if (event.target === scrim) settle(false);
      const answer = event.target.closest("[data-answer]")?.dataset.answer;
      if (answer) settle(answer === "yes");
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(scrim);
    enhanceButtons(scrim);
    scrim.querySelector('[data-answer="no"]').focus();
  });
}

function isOnScreen(node) {
  if (!node?.isConnected) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
}

const GLIDE_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const GLIDE_MS = 820;
const VIEW_SETTLE_MS = 560;
const HANDOFF_AT = 0.7;

let transitionSettled = Promise.resolve();
let transitionToken = 0;
let liveAnimations = [];

function afterTransition() {
  return transitionSettled;
}

function cloneForGlide(node) {
  const copy = node.cloneNode(true);
  copy.removeAttribute("id");
  copy.removeAttribute("style");
  copy.removeAttribute("data-light-host");
  copy.querySelectorAll("[id]").forEach((child) => child.removeAttribute("id"));
  copy.querySelectorAll(".glare, video, .thumb__duration").forEach((child) => child.remove());
  copy.querySelectorAll("img").forEach((image) => {
    image.loading = "eager";
    image.decoding = "sync";
  });
  return copy;
}

function placeGhost(copy, rect, radius) {
  const ghost = document.createElement("div");
  ghost.className = "glide-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.borderRadius = radius;
  ghost.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
  copy.style.borderRadius = radius;
  ghost.appendChild(copy);
  document.body.appendChild(ghost);
  return ghost;
}

function cardRadius(node) {
  if (parseFloat(radiusOf(node)) > 0) return radiusOf(node);
  const card = node.closest(".acard, .vcard");
  return card ? radiusOf(card) : "0px";
}

function placeAt(rect, base) {
  return `translate3d(${rect.left}px, ${rect.top}px, 0) scale(${rect.width / base.width})`;
}

function radiusOf(node) {
  return getComputedStyle(node).borderTopLeftRadius;
}

function stopGlides() {
  liveAnimations.forEach((animation) => animation.cancel());
  liveAnimations = [];
  document.querySelectorAll(".glide-ghost").forEach((node) => node.remove());
}

function fly({ ghost, target, fromRect, toRect, base }) {
  const timing = { duration: GLIDE_MS, easing: GLIDE_EASE, fill: "both" };
  const handoff = { duration: GLIDE_MS, easing: "linear", fill: "both" };
  const flight = ghost.animate([{ transform: placeAt(fromRect, base) }, { transform: placeAt(toRect, base) }], timing);
  const ghostFade = ghost.animate([{ opacity: 1 }, { opacity: 1, offset: HANDOFF_AT }, { opacity: 0 }], handoff);
  const reveal = target.animate([{ opacity: 0 }, { opacity: 0, offset: HANDOFF_AT }, { opacity: 1 }], handoff);
  liveAnimations.push(flight, ghostFade, reveal);
  return flight.finished.catch(() => null);
}

function fadeAway(ghost) {
  const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-out", fill: "both" });
  liveAnimations.push(fade);
  return fade.finished.catch(() => null);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function glide(update, morphs = []) {
  stopGlides();
  if (prefersReducedMotion()) {
    update();
    transitionSettled = Promise.resolve();
    return transitionSettled;
  }

  const root = document.documentElement;
  const token = ++transitionToken;
  const pair = morphs.find((candidate) => isOnScreen(candidate.from));
  const fromRect = pair?.from.getBoundingClientRect();
  const cloneFrom = pair && pair.clone !== "to";
  const fromRadius = pair ? cardRadius(pair.from) : "0px";
  const copy = cloneFrom ? pair.from : null;
  const sourceCopy = copy ? cloneForGlide(copy) : null;

  root.classList.toggle("is-morphing", Boolean(pair));
  root.classList.add("is-transitioning");
  update();
  document.querySelectorAll("[data-view]:not([hidden])").forEach((view) => {
    view.dataset.enter = pair ? "fade" : "rise";
  });

  let motion;
  const target = pair?.to();
  if (pair && target && isOnScreen(target)) {
    const toRect = target.getBoundingClientRect();
    const base = toRect.width > fromRect.width ? toRect : fromRect;
    const cardRect = cloneFrom ? fromRect : toRect;
    const cardCorner = parseFloat(cloneFrom ? fromRadius : cardRadius(target)) || 0;
    const radius = `${((cardCorner * base.width) / cardRect.width).toFixed(1)}px`;
    const ghost = placeGhost(sourceCopy ?? cloneForGlide(target), base, radius);
    motion = fly({ ghost, target, fromRect, toRect, base });
  } else {
    motion = sourceCopy ? fadeAway(placeGhost(sourceCopy, fromRect, fromRadius)) : Promise.resolve();
    root.classList.remove("is-morphing");
  }

  const settled = Promise.all([motion, wait(VIEW_SETTLE_MS)]).then(() => {
    if (token !== transitionToken) return;
    stopGlides();
    root.classList.remove("is-morphing", "is-transitioning");
  });
  transitionSettled = settled;
  return settled;
}

function splitReveal(node, { delay = 0, play = true } = {}) {
  if (!node) return;
  const pieces = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      child.textContent.split(/(\s+)/).forEach((part) => {
        if (!part) return;
        if (/^\s+$/.test(part)) pieces.push(document.createTextNode(" "));
        else pieces.push(wrapWord(document.createTextNode(part)));
      });
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      pieces.push(wrapWord(child.cloneNode(true)));
    }
  });

  node.replaceChildren(...pieces);
  node.querySelectorAll(".wi").forEach((word, index) => word.style.setProperty("--i", String(index)));
  node.style.setProperty("--split-delay", `${delay}ms`);
  node.classList.add("split");
  node.classList.remove("is-in");
  if (!play) return;
  void node.offsetWidth;
  node.classList.add("is-in");
}

function wrapWord(content) {
  const outer = document.createElement("span");
  outer.className = "w";
  if (content.nodeType === Node.ELEMENT_NODE) {
    content.classList.add("wi");
    outer.appendChild(content);
    return outer;
  }
  const inner = document.createElement("span");
  inner.className = "wi";
  inner.appendChild(content);
  outer.appendChild(inner);
  return outer;
}

function countUp(node, target, { duration = 1100, format = (value) => String(value) } = {}) {
  const end = Number(target);
  if (!Number.isFinite(end) || prefersReducedMotion()) {
    node.textContent = format(target);
    return;
  }

  const start = Number(node.dataset.value ?? 0) || 0;
  node.dataset.value = String(end);
  if (Math.abs(end - start) < 12) {
    node.textContent = format(end);
    return;
  }

  const startedAt = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - progress, 4);
    node.textContent = format(Math.round(start + (end - start) * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function addRipple(event) {
  const button = event.currentTarget;
  if (button.disabled || prefersReducedMotion()) return;

  const rect = button.getBoundingClientRect();
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.setProperty("--rx", `${event.clientX - rect.left}px`);
  ripple.style.setProperty("--ry", `${event.clientY - rect.top}px`);
  ripple.style.setProperty("--rs", String(Math.ceil(Math.max(rect.width, rect.height) / 5)));
  button.appendChild(ripple);
  ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
}

function makeMagnetic(button, strength = 0.22) {
  if (!finePointer() || prefersReducedMotion()) return;

  button.addEventListener("pointermove", (event) => {
    const rect = button.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    button.style.setProperty("--mag-x", `${(dx * strength).toFixed(1)}px`);
    button.style.setProperty("--mag-y", `${(dy * strength).toFixed(1)}px`);
  });
  button.addEventListener("pointerleave", () => {
    button.style.setProperty("--mag-x", "0px");
    button.style.setProperty("--mag-y", "0px");
  });
}

function enhanceButtons(root = document) {
  root.querySelectorAll(".btn:not([data-enhanced])").forEach((button) => {
    button.dataset.enhanced = "1";
    button.addEventListener("pointerdown", addRipple);
    if (button.classList.contains("btn--primary")) makeMagnetic(button);
  });
}

function enableTouchLight(root = document, selector = "[data-light]", { tilt: tiltAmount = 0 } = {}) {
  if (prefersReducedMotion()) return;
  const hover = finePointer();
  const tilt = hover ? tiltAmount : 0;

  root.querySelectorAll(`${selector}:not([data-lit])`).forEach((node) => {
    node.dataset.lit = "1";
    const host = node.querySelector("[data-light-host]") ?? node;
    if (!host.querySelector(":scope > .glare")) {
      const glare = document.createElement("span");
      glare.className = "glare";
      glare.setAttribute("aria-hidden", "true");
      host.appendChild(glare);
    }

    let frame = 0;
    let pending = null;
    let pressed = false;

    const paint = () => {
      frame = 0;
      if (!pending) return;
      const rect = host.getBoundingClientRect();
      const x = pending.x - rect.left;
      const y = pending.y - rect.top;
      host.style.setProperty("--mx", `${x.toFixed(1)}px`);
      host.style.setProperty("--my", `${y.toFixed(1)}px`);
      if (tilt) {
        const px = x / rect.width - 0.5;
        const py = y / rect.height - 0.5;
        node.style.setProperty("--tilt-x", `${(-py * tilt * 0.75).toFixed(2)}deg`);
        node.style.setProperty("--tilt-y", `${(px * tilt).toFixed(2)}deg`);
      }
    };

    const queue = (event) => {
      pending = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const settle = () => {
      pressed = false;
      node.classList.remove("is-lit");
      node.style.setProperty("--tilt-x", "0deg");
      node.style.setProperty("--tilt-y", "0deg");
    };

    node.addEventListener("pointerdown", (event) => {
      pressed = true;
      queue(event);
      node.classList.add("is-lit");
    });
    node.addEventListener("pointermove", (event) => {
      if (!hover && !pressed) return;
      queue(event);
      if (hover) node.classList.add("is-lit");
    });
    node.addEventListener("pointerleave", settle);
    node.addEventListener("pointercancel", settle);
    node.addEventListener("pointerup", () => {
      if (!hover) setTimeout(settle, 180);
    });
  });
}

function syncSegmented(container, { instant = false } = {}) {
  const indicator = container.querySelector(".segmented__indicator");
  const active = container.querySelector(".segmented__item.is-active");
  if (!indicator || !active || active.offsetWidth === 0) return;

  const firstPlacement = !indicator.dataset.placed;
  if (instant || firstPlacement) indicator.classList.add("is-instant");

  indicator.style.setProperty("--ind-x", `${active.offsetLeft}px`);
  indicator.style.setProperty("--ind-w", `${active.offsetWidth}px`);
  indicator.dataset.placed = "1";

  if (instant || firstPlacement) {
    void indicator.offsetWidth;
    requestAnimationFrame(() => indicator.classList.remove("is-instant"));
  }

  const overflowLeft = active.offsetLeft - container.scrollLeft;
  const overflowRight = active.offsetLeft + active.offsetWidth - (container.scrollLeft + container.clientWidth);
  if (overflowLeft < 0 || overflowRight > 0) {
    container.scrollTo({ left: active.offsetLeft - 16, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }
}

function watchSegmented(container) {
  syncSegmented(container);
  if ("ResizeObserver" in window) new ResizeObserver(() => syncSegmented(container)).observe(container);
  document.fonts?.ready.then(() => syncSegmented(container));
}

function trackScroll(threshold = 12) {
  const update = () => document.body.classList.toggle("is-scrolled", window.scrollY > threshold);
  update();
  window.addEventListener("scroll", update, { passive: true });
}

function haptic(pattern = 12) {
  if (navigator.vibrate && !prefersReducedMotion()) navigator.vibrate(pattern);
}

function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 5) return "Late night";
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Late night";
}

export {
  afterTransition,
  closeScrim,
  confirmSheet,
  countUp,
  enableTouchLight,
  enhanceButtons,
  greeting,
  haptic,
  isOnScreen,
  prefersReducedMotion,
  splitReveal,
  syncSegmented,
  toast,
  trackScroll,
  watchSegmented,
  glide,
};
