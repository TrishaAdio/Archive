import bigInt from "big-integer";
import { Api, Logger, TelegramClient, utils } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import { computeCheck } from "telegram/Password.js";
import { StringSession } from "telegram/sessions/index.js";
import { TelegramFailure } from "./failures.js";

const REQUEST_BYTES = 512 * 1024;
const CONNECT_TIMEOUT_MS = 20000;

function asFailure(error) {
  if (error instanceof TelegramFailure) return error;
  if (typeof error?.seconds === "number" && /FLOOD/i.test(String(error?.errorMessage ?? error?.message))) {
    return new TelegramFailure("FLOOD_WAIT", { seconds: error.seconds, cause: error });
  }
  const code = typeof error?.errorMessage === "string" ? error.errorMessage : "UNKNOWN";
  return new TelegramFailure(code, { cause: error });
}

async function guard(work) {
  try {
    return await work();
  } catch (error) {
    throw asFailure(error);
  }
}

function describeUser(user) {
  if (!user) return null;
  return {
    id: String(user.id),
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    username: user.username ?? "",
    phone: user.phone ?? "",
  };
}

function chatTitle(entity) {
  if (entity.title) return entity.title;
  const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
  return name || (entity.username ? `@${entity.username}` : "Telegram chat");
}

function videoFromMessage(message) {
  const document = message?.media instanceof Api.MessageMediaDocument ? message.media.document : null;
  if (!(document instanceof Api.Document)) return null;
  const mimeType = String(document.mimeType ?? "").toLowerCase();
  if (!mimeType.startsWith("video/")) return null;
  if (document.attributes.some((attribute) => attribute instanceof Api.DocumentAttributeAnimated)) return null;

  const fileAttribute = document.attributes.find((attribute) => attribute instanceof Api.DocumentAttributeFilename);
  const videoAttribute = document.attributes.find((attribute) => attribute instanceof Api.DocumentAttributeVideo);

  return {
    messageId: message.id,
    fileName: fileAttribute?.fileName ?? "",
    mimeType,
    sizeBytes: Number(document.size.toString()),
    durationSeconds: videoAttribute?.duration ? Math.round(videoAttribute.duration) : null,
    caption: message.message ?? "",
    postedAt: new Date(message.date * 1000),
    media: message.media,
  };
}

function wrapClient(client, { apiId, apiHash }) {
  const credentials = { apiId, apiHash };
  const entities = new Map();

  async function me() {
    const authorized = await guard(() => client.checkAuthorization());
    if (!authorized) return null;
    return describeUser(await guard(() => client.getMe()));
  }

  async function sendCode(phone) {
    const result = await guard(() => client.sendCode(credentials, phone));
    return { phoneCodeHash: result.phoneCodeHash, viaApp: Boolean(result.isCodeViaApp) };
  }

  async function signIn({ phone, phoneCodeHash, code }) {
    try {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw new TelegramFailure("PHONE_NUMBER_UNOCCUPIED");
      return describeUser(result.user);
    } catch (error) {
      if (error?.errorMessage === "SESSION_PASSWORD_NEEDED") throw new TelegramFailure("PASSWORD_NEEDED");
      throw asFailure(error);
    }
  }

  async function passwordHint() {
    const settings = await guard(() => client.invoke(new Api.account.GetPassword()));
    return settings.hint ?? "";
  }

  async function signInWithPassword(password) {
    return guard(async () => {
      const settings = await client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(settings, password);
      const result = await client.invoke(new Api.auth.CheckPassword({ password: check }));
      return describeUser(result.user);
    });
  }

  async function joinInvite(hash) {
    const preview = await guard(() => client.invoke(new Api.messages.CheckChatInvite({ hash })));
    if (preview instanceof Api.ChatInviteAlready) return { entity: preview.chat, joined: false };
    if (preview instanceof Api.ChatInvitePeek) return { entity: preview.chat, joined: false };
    if (preview.requestNeeded) throw new TelegramFailure("INVITE_REQUEST_NEEDED");

    try {
      const updates = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      return { entity: updates.chats[0], joined: true };
    } catch (error) {
      if (error?.errorMessage === "USER_ALREADY_PARTICIPANT") {
        const again = await guard(() => client.invoke(new Api.messages.CheckChatInvite({ hash })));
        if (again.chat) return { entity: again.chat, joined: false };
      }
      throw asFailure(error);
    }
  }

  async function joinPublic(username) {
    const entity = await guard(() => client.getEntity(username));
    let joined = false;
    if (entity instanceof Api.Channel && entity.left) {
      try {
        await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
        joined = true;
      } catch (error) {
        if (!entity.username) throw asFailure(error);
      }
    }
    return { entity, joined };
  }

  async function findPrivate(channelId) {
    await guard(() => client.getDialogs({ limit: 500 }));
    try {
      return { entity: await client.getEntity(bigInt(`-100${channelId}`)), joined: false };
    } catch {
      throw new TelegramFailure("NOT_A_MEMBER");
    }
  }

  async function resolveChat(target) {
    const { entity, joined } =
      target.kind === "invite"
        ? await joinInvite(target.hash)
        : target.kind === "private"
          ? await findPrivate(target.channelId)
          : await joinPublic(target.username);

    if (entity?.noforwards) throw new TelegramFailure("CHAT_FORWARDS_RESTRICTED");
    const id = String(utils.getPeerId(entity));
    entities.set(id, entity);
    return { id, title: chatTitle(entity), joined };
  }

  function entityFor(chatId) {
    const entity = entities.get(chatId);
    if (!entity) throw new TelegramFailure("CHANNEL_INVALID");
    return entity;
  }

  async function listVideos(chatId, { onProgress = () => {}, signal } = {}) {
    const entity = entityFor(chatId);
    const found = new Map();
    const filters = [Api.InputMessagesFilterVideo, Api.InputMessagesFilterDocument];

    await guard(async () => {
      for (const Filter of filters) {
        for await (const message of client.iterMessages(entity, { filter: new Filter(), reverse: true, waitTime: 1 })) {
          if (signal?.aborted) return;
          const item = videoFromMessage(message);
          if (!item || found.has(item.messageId)) continue;
          found.set(item.messageId, item);
          onProgress(found.size);
        }
      }
    });

    return [...found.values()].sort((a, b) => a.messageId - b.messageId);
  }

  async function refreshMedia(chatId, item) {
    const [message] = await guard(() => client.getMessages(entityFor(chatId), { ids: [item.messageId] }));
    const fresh = videoFromMessage(message);
    if (!fresh) throw new TelegramFailure("MESSAGE_ID_INVALID");
    item.media = fresh.media;
  }

  async function* download(chatId, item, { offset = 0 } = {}) {
    let position = offset;
    let refreshed = false;

    while (true) {
      try {
        const chunks = client.iterDownload({
          file: item.media,
          offset: bigInt(position),
          requestSize: REQUEST_BYTES,
          fileSize: bigInt(item.sizeBytes),
        });
        for await (const chunk of chunks) {
          if (!chunk.length) continue;
          const remaining = item.sizeBytes - position;
          const piece = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          if (!piece.length) return;
          position += piece.length;
          yield piece;
          if (position >= item.sizeBytes) return;
        }
        return;
      } catch (error) {
        const failure = asFailure(error);
        if (!refreshed && /FILE_REFERENCE_(EXPIRED|INVALID)/.test(failure.code)) {
          refreshed = true;
          await refreshMedia(chatId, item);
          continue;
        }
        throw failure;
      }
    }
  }

  async function logOut() {
    await guard(() => client.invoke(new Api.auth.LogOut()));
  }

  async function disconnect() {
    try {
      await client.destroy();
    } catch {
      return;
    }
  }

  return {
    me,
    sendCode,
    signIn,
    passwordHint,
    signInWithPassword,
    resolveChat,
    listVideos,
    download,
    logOut,
    disconnect,
    session: () => client.session.save(),
  };
}

function createDriver() {
  async function connect({ apiId, apiHash, session = "" }) {
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
      deviceModel: "Get Pleasure server",
      systemVersion: "Linux",
      appVersion: "1.0",
      baseLogger: new Logger(LogLevel.ERROR),
    });

    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new TelegramFailure("CONNECTION_FAILED")), CONNECT_TIMEOUT_MS);
    });
    try {
      await Promise.race([guard(() => client.connect()), timeout]);
    } catch (error) {
      await client.destroy().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return wrapClient(client, { apiId, apiHash });
  }

  return { connect };
}

export { createDriver };
