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

function withViewTransition(update) {
  if (!document.startViewTransition || prefersReducedMotion()) {
    update();
    return Promise.resolve();
  }
  return document.startViewTransition(update).finished.catch(() => {});
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

function enableSpotlight(root = document) {
  if (!finePointer()) return;
  root.querySelectorAll(".spotlight:not([data-spot])").forEach((node) => {
    node.dataset.spot = "1";
    node.addEventListener("pointermove", (event) => {
      const rect = node.getBoundingClientRect();
      node.style.setProperty("--mx", `${event.clientX - rect.left}px`);
      node.style.setProperty("--my", `${event.clientY - rect.top}px`);
    });
  });
}

function enableTilt(root = document, selector = "[data-tilt]") {
  if (!finePointer() || prefersReducedMotion()) return;
  root.querySelectorAll(`${selector}:not([data-tilted])`).forEach((node) => {
    node.dataset.tilted = "1";
    node.addEventListener("pointermove", (event) => {
      const rect = node.getBoundingClientRect();
      const px = (event.clientX - rect.left) / rect.width - 0.5;
      const py = (event.clientY - rect.top) / rect.height - 0.5;
      node.style.setProperty("--tilt-x", `${(-py * 6).toFixed(2)}deg`);
      node.style.setProperty("--tilt-y", `${(px * 8).toFixed(2)}deg`);
    });
    node.addEventListener("pointerleave", () => {
      node.style.setProperty("--tilt-x", "0deg");
      node.style.setProperty("--tilt-y", "0deg");
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
  closeScrim,
  confirmSheet,
  countUp,
  enableSpotlight,
  enableTilt,
  enhanceButtons,
  greeting,
  haptic,
  prefersReducedMotion,
  syncSegmented,
  toast,
  trackScroll,
  watchSegmented,
  withViewTransition,
};
