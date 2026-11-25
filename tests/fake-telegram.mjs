import { TelegramFailure } from "../src/services/telegram/failures.js";

const SAMPLE = Buffer.from(Array.from({ length: 96 * 1024 }, (_, index) => (index * 31 + (index >> 8)) & 0xff));
const API_ID = 123456;
const API_HASH = "0123456789abcdef0123456789abcdef";
const LOGIN_CODE = "12345";

const ACCOUNTS = {
  "+15550001": { password: null, user: { id: "1001", firstName: "Owner", lastName: "", username: "gp_owner", phone: "15550001" } },
  "+15550002": { password: "hunter2", user: { id: "1002", firstName: "Second", lastName: "Account", username: "", phone: "15550002" } },
};

class Failure extends TelegramFailure {
  constructor(code, seconds) {
    super(code, { seconds });
  }
}

function repeated(bytes) {
  const buffer = Buffer.alloc(bytes);
  for (let offset = 0; offset < bytes; offset += SAMPLE.length) SAMPLE.copy(buffer, offset);
  return buffer;
}

function video(messageId, { fileName = "", caption = "", mimeType = "video/mp4", bytes = SAMPLE, chunkDelayMs = 0, failTimes = 0, floodOnce = 0 } = {}) {
  return { messageId, fileName, caption, mimeType, bytes, chunkDelayMs, failTimes, floodOnce };
}

const CHATS = {
  "public:archivechan": {
    id: "-1001",
    title: "Archive Channel",
    videos: () => [
      video(11, { fileName: "Opening Night.mp4", caption: "promo text ignored" }),
      video(14, { fileName: "VID_20240102_1130.mp4", caption: "Harbour Lights\nwatch till the end https://example.com" }),
      video(19, { fileName: "", caption: "" }),
      video(23, { fileName: "Long Walk.webm", mimeType: "video/webm" }),
    ],
  },
  "invite:FakeInvite123": {
    id: "-1002",
    title: "Private Vault",
    videos: () => [video(5, { fileName: "Vault One.mp4" }), video(6, { fileName: "Vault Two.mp4" }), video(9, { fileName: "Vault Three.mp4" })],
  },
  "public:slowchan": {
    id: "-1003",
    title: "Slow Channel",
    videos: () => [
      video(1, { fileName: "Slow One.mp4", bytes: repeated(1536 * 1024), chunkDelayMs: 110 }),
      video(2, { fileName: "Slow Two.mp4", bytes: repeated(1536 * 1024), chunkDelayMs: 110 }),
      video(3, { fileName: "Slow Three.mp4", bytes: repeated(1536 * 1024), chunkDelayMs: 110 }),
      video(4, { fileName: "Slow Four.mp4", bytes: repeated(1536 * 1024), chunkDelayMs: 110 }),
    ],
  },
  "public:flakychan": {
    id: "-1004",
    title: "Flaky Channel",
    videos: () => [
      video(1, { fileName: "Flaky Retry.mp4", failTimes: 1 }),
      video(2, { fileName: "Flaky Flood.mp4", floodOnce: 1 }),
      video(3, { fileName: "Flaky Broken.mp4", failTimes: 99 }),
    ],
  },
  "public:lockedchan": { id: "-1005", title: "Locked Channel", noforwards: true, videos: () => [video(1, { fileName: "Locked.mp4" })] },
};

const endedSessions = new Set();
const chatState = new Map();

function chatFor(target) {
  const key = target.kind === "invite" ? `invite:${target.hash}` : target.kind === "public" ? `public:${target.username.toLowerCase()}` : `private:${target.channelId}`;
  const chat = CHATS[key];
  if (!chat) throw new Failure(target.kind === "invite" ? "INVITE_HASH_EXPIRED" : target.kind === "private" ? "NOT_A_MEMBER" : "USERNAME_NOT_OCCUPIED");
  if (!chatState.has(chat.id)) chatState.set(chat.id, chat.videos());
  return chat;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createDriver() {
  async function connect({ apiId, apiHash, session = "" }) {
    let signedIn = session && !endedSessions.has(session) ? session.replace(/^fake-session:/, "") : null;
    let pendingPhone = null;
    let pendingPassword = false;
    const credentialsValid = apiId === API_ID && apiHash === API_HASH;

    const client = {
      async me() {
        return signedIn ? ACCOUNTS[signedIn].user : null;
      },
      async sendCode(phone) {
        if (!credentialsValid) throw new Failure("API_ID_INVALID");
        if (!ACCOUNTS[phone]) throw new Failure("PHONE_NUMBER_INVALID");
        pendingPhone = phone;
        return { phoneCodeHash: `hash-${phone}`, viaApp: true };
      },
      async signIn({ phone, phoneCodeHash, code }) {
        if (phone !== pendingPhone || phoneCodeHash !== `hash-${phone}`) throw new Failure("PHONE_CODE_EXPIRED");
        if (code !== LOGIN_CODE) throw new Failure("PHONE_CODE_INVALID");
        if (ACCOUNTS[phone].password) {
          pendingPassword = true;
          throw new Failure("PASSWORD_NEEDED");
        }
        signedIn = phone;
        return ACCOUNTS[phone].user;
      },
      async passwordHint() {
        return "the usual";
      },
      async signInWithPassword(password) {
        if (!pendingPassword) throw new Failure("PASSWORD_HASH_INVALID");
        if (password !== ACCOUNTS[pendingPhone].password) throw new Failure("PASSWORD_HASH_INVALID");
        signedIn = pendingPhone;
        return ACCOUNTS[pendingPhone].user;
      },
      session() {
        return signedIn ? `fake-session:${signedIn}` : "";
      },
      async resolveChat(target) {
        if (!signedIn) throw new Failure("AUTH_KEY_UNREGISTERED");
        const chat = chatFor(target);
        if (chat.noforwards) throw new Failure("CHAT_FORWARDS_RESTRICTED");
        return { id: chat.id, title: chat.title, joined: target.kind === "invite" };
      },
      async listVideos(chatId, { onProgress = () => {} } = {}) {
        const videos = chatState.get(chatId) ?? [];
        videos.forEach((_, index) => onProgress(index + 1));
        return videos.map((entry) => ({
          messageId: entry.messageId,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          sizeBytes: entry.bytes.length,
          durationSeconds: 5,
          caption: entry.caption,
          postedAt: new Date(),
          source: entry,
        }));
      },
      async *download(chatId, item, { offset = 0 } = {}) {
        const entry = item.source;
        if (entry.floodOnce > 0) {
          entry.floodOnce -= 1;
          throw new Failure("FLOOD_WAIT", 1);
        }
        const chunkSize = 64 * 1024;
        let position = offset;
        let sent = 0;
        while (position < entry.bytes.length) {
          if (entry.chunkDelayMs) await sleep(entry.chunkDelayMs);
          if (entry.failTimes > 0 && sent >= 1) {
            entry.failTimes -= 1;
            throw new Failure("TIMEOUT");
          }
          const piece = entry.bytes.subarray(position, Math.min(position + chunkSize, entry.bytes.length));
          position += piece.length;
          sent += 1;
          yield piece;
        }
      },
      async logOut() {
        if (signedIn) endedSessions.add(`fake-session:${signedIn}`);
        signedIn = null;
      },
      async disconnect() {},
    };
    return client;
  }

  return { connect };
}

export { createDriver };
