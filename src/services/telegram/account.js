import { deriveKey, openText, sealText } from "../../lib/crypto.js";
import { badRequest, conflict } from "../../lib/errors.js";
import { DURABLE_WRITE } from "../../db.js";
import { TelegramFailure } from "./failures.js";

const ACCOUNT_ID = "primary";
const PENDING_LOGIN_MS = 10 * 60 * 1000;
const ENDED_SESSION_CODES = new Set(["AUTH_KEY_UNREGISTERED", "SESSION_REVOKED", "USER_DEACTIVATED", "USER_DEACTIVATED_BAN", "AUTH_KEY_INVALID"]);

function maskPhone(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 5) return "";
  return `+${digits.slice(0, 2)} ••• ••• ${digits.slice(-2)}`;
}

function displayName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || (user.username ? `@${user.username}` : "Telegram account");
}

function normaliseCredentials({ apiId, apiHash, phone }) {
  const idText = String(apiId ?? "").trim();
  if (!/^\d{3,12}$/.test(idText)) throw badRequest("API ID must be the number shown on my.telegram.org", { field: "apiId" });
  const hash = String(apiHash ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hash)) throw badRequest("API hash must be the 32-character code shown on my.telegram.org", { field: "apiHash" });
  const digits = String(phone ?? "").replace(/[\s().-]/g, "");
  if (!/^\+?\d{7,15}$/.test(digits)) throw badRequest("Phone number must be in international format, like +15551234567", { field: "phone" });
  return { apiId: Number(idText), apiHash: hash, phone: digits.startsWith("+") ? digits : `+${digits}` };
}

function createTelegramAccount({ collection, config, loadDriver }) {
  const key = deriveKey(config.sessionSecret, "telegram-session");
  let pending = null;
  let shared = null;

  function shapeAccount(doc) {
    if (!doc) return null;
    return {
      name: doc.account.name,
      username: doc.account.username,
      phone: doc.account.phoneMasked,
      connectedAt: doc.connectedAt.toISOString(),
    };
  }

  function livePending() {
    if (pending && pending.expiresAt < Date.now()) {
      pending.client.disconnect();
      pending = null;
    }
    return pending;
  }

  async function status() {
    const doc = await collection.findOne({ _id: ACCOUNT_ID });
    const current = livePending();
    return {
      connected: Boolean(doc),
      account: shapeAccount(doc),
      login: current ? { step: current.step, phone: maskPhone(current.phone), viaApp: current.viaApp, hint: current.hint } : null,
    };
  }

  async function cancelLogin() {
    if (pending) await pending.client.disconnect();
    pending = null;
  }

  async function startLogin(input) {
    const credentials = normaliseCredentials(input ?? {});
    if (await collection.findOne({ _id: ACCOUNT_ID }, { projection: { _id: 1 } })) {
      throw conflict("A Telegram account is already connected. Disconnect it first.");
    }
    await cancelLogin();

    const driver = await loadDriver();
    const client = await driver.connect({ apiId: credentials.apiId, apiHash: credentials.apiHash });
    try {
      const { phoneCodeHash, viaApp } = await client.sendCode(credentials.phone);
      pending = { ...credentials, client, phoneCodeHash, viaApp, step: "code", hint: "", expiresAt: Date.now() + PENDING_LOGIN_MS };
      return { step: "code", viaApp, phone: maskPhone(credentials.phone) };
    } catch (error) {
      await client.disconnect();
      throw error;
    }
  }

  async function finish(user) {
    const login = pending;
    const now = new Date();
    await collection.replaceOne(
      { _id: ACCOUNT_ID },
      {
        _id: ACCOUNT_ID,
        apiId: login.apiId,
        apiHashSealed: sealText(key, login.apiHash),
        sessionSealed: sealText(key, login.client.session()),
        account: { name: displayName(user), username: user.username ?? "", phoneMasked: maskPhone(user.phone || login.phone) },
        connectedAt: now,
      },
      { upsert: true, writeConcern: DURABLE_WRITE },
    );
    if (shared) await shared.disconnect();
    shared = login.client;
    pending = null;
    return { connected: true, account: { name: displayName(user), username: user.username ?? "", phone: maskPhone(user.phone || login.phone) } };
  }

  function requirePending(step) {
    const current = livePending();
    if (!current) throw new TelegramFailure("LOGIN_NOT_STARTED");
    if (current.step !== step) throw badRequest(step === "code" ? "The login code was already accepted. Enter your password." : "Enter the login code first.");
    return current;
  }

  async function submitCode(code) {
    const current = requirePending("code");
    const cleaned = String(code ?? "").replace(/\D/g, "");
    if (!/^\d{4,8}$/.test(cleaned)) throw badRequest("Enter the 5-digit code Telegram sent you", { field: "code" });
    try {
      return await finish(await current.client.signIn({ phone: current.phone, phoneCodeHash: current.phoneCodeHash, code: cleaned }));
    } catch (error) {
      if (error?.code !== "PASSWORD_NEEDED") throw error;
      current.step = "password";
      current.hint = await current.client.passwordHint().catch(() => "");
      return { step: "password", hint: current.hint };
    }
  }

  async function submitPassword(password) {
    const current = requirePending("password");
    if (typeof password !== "string" || !password.length || password.length > 256) {
      throw badRequest("Enter the account's two-step verification password", { field: "password" });
    }
    return finish(await current.client.signInWithPassword(password));
  }

  async function forget() {
    await collection.deleteOne({ _id: ACCOUNT_ID });
    if (shared) await shared.disconnect();
    shared = null;
  }

  async function getClient() {
    if (shared) return shared;
    const doc = await collection.findOne({ _id: ACCOUNT_ID });
    if (!doc) throw new TelegramFailure("NOT_LOGGED_IN");

    const driver = await loadDriver();
    const client = await driver.connect({
      apiId: doc.apiId,
      apiHash: openText(key, doc.apiHashSealed),
      session: openText(key, doc.sessionSealed),
    });
    let user;
    try {
      user = await client.me();
    } catch (error) {
      await client.disconnect();
      if (ENDED_SESSION_CODES.has(error?.code)) {
        await forget();
        throw new TelegramFailure("AUTH_KEY_UNREGISTERED");
      }
      throw error;
    }
    if (!user) {
      await client.disconnect();
      await forget();
      throw new TelegramFailure("AUTH_KEY_UNREGISTERED");
    }
    shared = client;
    return shared;
  }

  async function handleFailure(error) {
    if (ENDED_SESSION_CODES.has(error?.code)) await forget();
  }

  async function logout() {
    const doc = await collection.findOne({ _id: ACCOUNT_ID }, { projection: { _id: 1 } });
    if (!doc) return { connected: false };
    const client = await getClient().catch(() => null);
    await client?.logOut().catch(() => null);
    await forget();
    return { connected: false };
  }

  async function isConnected() {
    return Boolean(await collection.findOne({ _id: ACCOUNT_ID }, { projection: { _id: 1 } }));
  }

  async function close() {
    await cancelLogin();
    if (shared) await shared.disconnect();
    shared = null;
  }

  return { status, startLogin, submitCode, submitPassword, cancelLogin, logout, getClient, handleFailure, isConnected, close };
}

export { createTelegramAccount, ENDED_SESSION_CODES };
