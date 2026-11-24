import { api, ApiError, revealOnScroll } from "./api.js";
import { enhanceButtons, haptic, prefersReducedMotion, toast } from "./ui.js";
import { runSplash } from "./splash.js";

const form = document.getElementById("gate-form");
const field = document.getElementById("gate-field");
const input = document.getElementById("key-input");
const submit = document.getElementById("gate-submit");
const submitLabel = document.getElementById("gate-submit-label");
const errorBox = document.getElementById("gate-error");
const reasonBox = document.getElementById("gate-reason");
const pasteButton = document.getElementById("gate-paste");
const gate = document.querySelector(".gate");
const seal = document.getElementById("gate-seal");
const sealVideo = document.getElementById("seal-video");
const burst = document.getElementById("seal-burst");
const mascot = document.getElementById("mascot");
const iris = document.getElementById("iris");

const SPARK_COLORS = ["#ff5fbf", "#ff5f8f", "#ffae8a", "#f0cf9e", "#9adaea", "#ffffff", "#8d7bff"];
let moodTimer = null;

function setMood(mood, holdMs = 0) {
  clearTimeout(moodTimer);
  mascot.dataset.mood = mood;
  if (holdMs) moodTimer = setTimeout(() => (mascot.dataset.mood = "idle"), holdMs);
}

function restartClass(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  restartClass(form, "shake");
  restartClass(seal, "is-denied");
  setMood("sad", 2600);
  haptic([30, 40, 30]);
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function setBusy(busy) {
  submit.disabled = busy;
  submit.classList.toggle("is-busy", busy);
  input.readOnly = busy;
  submitLabel.textContent = busy ? "Checking your key" : "Unlock access";
}

function showReasonFromUrl() {
  const reason = new URLSearchParams(window.location.search).get("reason");
  if (!reason) return;
  reasonBox.textContent = reason.slice(0, 240);
  reasonBox.hidden = false;
  window.history.replaceState({}, "", "/");
}

function sparkBurst(count = 34) {
  burst.innerHTML = "";
  for (let index = 0; index < count; index++) {
    const spark = document.createElement("span");
    const angle = (Math.PI * 2 * index) / count + Math.random() * 0.4;
    const distance = 90 + Math.random() * 120;
    const size = 4 + Math.random() * 7;
    spark.className = "spark";
    spark.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    spark.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
    spark.style.setProperty("--size", `${size.toFixed(1)}px`);
    spark.style.setProperty("--color", SPARK_COLORS[index % SPARK_COLORS.length]);
    spark.style.setProperty("--radius", index % 3 === 0 ? "2px" : "50%");
    spark.style.setProperty("--spin", `${Math.round(Math.random() * 540 - 270)}deg`);
    spark.style.setProperty("--duration", `${750 + Math.round(Math.random() * 500)}ms`);
    spark.style.setProperty("--delay", `${Math.round(Math.random() * 90)}ms`);
    burst.appendChild(spark);
  }
}

function openIris() {
  const rect = seal.getBoundingClientRect();
  iris.style.setProperty("--iris-x", `${rect.left + rect.width / 2}px`);
  iris.style.setProperty("--iris-y", `${rect.top + rect.height / 2}px`);
  iris.classList.add("is-open");
}

function rememberArrival() {
  try {
    sessionStorage.setItem("gp_arrival", "1");
  } catch {
    return;
  }
}

function celebrateAndEnter() {
  const reduced = prefersReducedMotion();
  gate.classList.add("gate--success");
  field.classList.add("is-valid");
  submit.classList.add("is-done");
  submitLabel.textContent = "Unlocked";
  setMood("happy");
  rememberArrival();

  if (reduced) {
    seal.classList.add("is-unlocked");
    setTimeout(() => window.location.replace("/watch"), 450);
    return;
  }

  haptic([12, 50, 12, 50, 40]);
  seal.classList.add("is-unlocking");
  setTimeout(() => {
    seal.classList.add("is-unlocked");
    sparkBurst();
    haptic(30);
  }, 620);
  setTimeout(openIris, 1250);
  setTimeout(() => window.location.replace("/watch"), 2050);
}

input.addEventListener("input", () => {
  if (!errorBox.hidden) clearError();
});

pasteButton.addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) {
      toast("Your clipboard is empty", { tone: "info" });
      return;
    }
    input.value = text;
    clearError();
    input.focus();
    haptic(10);
  } catch {
    input.focus();
    toast("Long-press the field to paste", { tone: "info" });
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = input.value.trim();

  if (!key) {
    showError("Enter the access key you were given.");
    input.focus();
    return;
  }

  clearError();
  reasonBox.hidden = true;
  setBusy(true);

  try {
    await api.post("/api/gate/redeem", { key });
    input.blur();
    celebrateAndEnter();
  } catch (error) {
    setBusy(false);
    if (error instanceof ApiError) {
      showError(error.message);
      if (error.status === 429) submitLabel.textContent = "Try again in a few minutes";
    } else {
      showError("Something went wrong. Try again.");
    }
  }
});

function settleSealVideo() {
  const saveData = navigator.connection?.saveData;
  if (prefersReducedMotion() || saveData) {
    sealVideo.removeAttribute("autoplay");
    sealVideo.pause();
    return;
  }
  sealVideo.play().catch(() => null);
}

enhanceButtons();
showReasonFromUrl();
settleSealVideo();

const sessionCheck = api.get("/api/gate/me").then(
  () => true,
  () => false,
);

runSplash().then(async () => {
  revealOnScroll();
  if (await sessionCheck) {
    window.location.replace("/watch");
    return;
  }
  if (window.matchMedia("(hover: hover)").matches) input.focus();
});
