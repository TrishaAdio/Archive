import { api, ApiError } from "./api.js";

const form = document.getElementById("gate-form");
const input = document.getElementById("key-input");
const submit = document.getElementById("gate-submit");
const submitLabel = document.getElementById("gate-submit-label");
const errorBox = document.getElementById("gate-error");
const gate = document.querySelector(".gate");

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  form.classList.remove("shake");
  void form.offsetWidth;
  form.classList.add("shake");
  if (navigator.vibrate) navigator.vibrate(60);
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function setBusy(busy) {
  submit.disabled = busy;
  input.readOnly = busy;
  submitLabel.textContent = busy ? "Checking key…" : "Unlock access";
}

input.addEventListener("input", () => {
  if (!errorBox.hidden) clearError();
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
  setBusy(true);

  try {
    await api.post("/api/gate/redeem", { key });
    gate.classList.add("gate--success");
    submitLabel.textContent = "Welcome back";
    setTimeout(() => {
      window.location.replace("/watch");
    }, 420);
  } catch (error) {
    setBusy(false);
    if (error instanceof ApiError) {
      showError(error.message);
      if (error.status === 429) submitLabel.textContent = "Try again later";
    } else {
      showError("Something went wrong. Try again.");
    }
  }
});

api
  .get("/api/gate/me")
  .then(() => window.location.replace("/watch"))
  .catch(() => input.focus());
