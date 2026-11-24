import { api, ApiError, escapeHtml } from "./api.js";

const HEARTBEAT_MS = 20000;

function startPresence({ onExpired }) {
  const modal = document.getElementById("broadcast-modal");
  const titleNode = document.getElementById("broadcast-title");
  const messageNode = document.getElementById("broadcast-message");
  const ackButton = document.getElementById("broadcast-ack");
  let showing = null;
  let timer = null;

  function hide() {
    modal.hidden = true;
    showing = null;
  }

  function show(broadcast) {
    if (showing === broadcast.id) return;
    showing = broadcast.id;
    titleNode.textContent = broadcast.title;
    messageNode.innerHTML = escapeHtml(broadcast.message).replace(/\n/g, "<br />");
    modal.hidden = false;
    ackButton.focus();
  }

  ackButton.addEventListener("click", async () => {
    const id = showing;
    hide();
    if (id) {
      try {
        await api.post(`/api/broadcasts/${id}/ack`);
      } catch {
        /* acknowledgement is retried on the next heartbeat */
      }
    }
  });

  async function beat() {
    try {
      const result = await api.post("/api/presence");
      if (result?.broadcast) show(result.broadcast);
      else if (showing) hide();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        clearInterval(timer);
        onExpired(error);
      }
    }
  }

  beat();
  timer = setInterval(() => {
    if (document.visibilityState === "visible") beat();
  }, HEARTBEAT_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") beat();
  });

  return { stop: () => clearInterval(timer) };
}

export { startPresence };
