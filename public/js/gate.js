import { api, ApiError, revealOnScroll } from "./api.js";
import { enhanceButtons, haptic, toast } from "./ui.js";

const form = document.getElementById("gate-form");
const input = document.getElementById("key-input");
const submit = document.getElementById("gate-submit");
const submitLabel = document.getElementById("gate-submit-label");
const errorBox = document.getElementById("gate-error");
const reasonBox = document.getElementById("gate-reason");
const pasteButton = document.getElementById("gate-paste");
const gate = document.querySelector(".gate");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  form.classList.remove("shake");
  void form.offsetWidth;
  form.classList.add("shake");
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
    gate.classList.add("gate--success");
    submitLabel.textContent = "Welcome in";
    haptic([12, 60, 18]);
    setTimeout(() => window.location.replace("/watch"), 820);
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

enhanceButtons();
revealOnScroll();
showReasonFromUrl();

api
  .get("/api/gate/me")
  .then(() => window.location.replace("/watch"))
  .catch(() => {
    if (window.matchMedia("(hover: hover)").matches) input.focus();
  });
