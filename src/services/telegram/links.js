import { badRequest } from "../../lib/errors.js";

const USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const INVITE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog", "www.t.me", "www.telegram.me"]);
const RESERVED_PATHS = new Set(["addstickers", "share", "proxy", "socks", "login", "setlanguage", "addtheme", "iv"]);

const LINK_HELP =
  "Paste a Telegram link like https://t.me/channelname, an invite link like https://t.me/+AbCdEf123, or @channelname";

function invite(hash) {
  if (!INVITE_PATTERN.test(hash)) throw badRequest(`That invite link looks incomplete. ${LINK_HELP}`);
  return { kind: "invite", hash, display: `t.me/+${hash}` };
}

function publicChat(username) {
  if (!USERNAME_PATTERN.test(username) || RESERVED_PATHS.has(username.toLowerCase())) {
    throw badRequest(`"${username}" is not a valid Telegram username. ${LINK_HELP}`);
  }
  return { kind: "public", username, display: `@${username}` };
}

function privateChannel(id) {
  if (!/^\d{5,16}$/.test(id)) throw badRequest(`That private channel link looks incomplete. ${LINK_HELP}`);
  return { kind: "private", channelId: id, display: `t.me/c/${id}` };
}

function parseDeepLink(url) {
  const params = url.searchParams;
  if (url.hostname === "join" && params.get("invite")) return invite(params.get("invite"));
  if (url.hostname === "resolve" && params.get("domain")) return publicChat(params.get("domain"));
  throw badRequest(LINK_HELP);
}

function parseChatLink(input) {
  if (typeof input !== "string" || !input.trim()) throw badRequest(`link is required. ${LINK_HELP}`);
  const raw = input.trim();
  if (raw.length > 300) throw badRequest("link is too long");

  if (raw.startsWith("@")) return publicChat(raw.slice(1));
  if (/^tg:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw badRequest(LINK_HELP);
    }
    return parseDeepLink(url);
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw badRequest(LINK_HELP);
  }

  if (!TELEGRAM_HOSTS.has(url.hostname.toLowerCase())) {
    throw badRequest(`Only t.me links are supported. ${LINK_HELP}`);
  }

  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length === 0) throw badRequest(LINK_HELP);

  const [first, second] = parts;
  if (first.startsWith("+")) return invite(first.slice(1));
  if (first === "joinchat" && second) return invite(second);
  if (first === "c" && second) return privateChannel(second);
  if (first === "s" && second) return publicChat(second);
  return publicChat(first);
}

export { parseChatLink };
