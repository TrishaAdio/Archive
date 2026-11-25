import { AppError } from "../../lib/errors.js";

class TelegramFailure extends Error {
  constructor(code, { seconds, cause } = {}) {
    super(code);
    this.code = code;
    this.seconds = seconds;
    this.cause = cause;
  }
}

const MESSAGES = {
  PHONE_NUMBER_INVALID: [400, "Telegram says that phone number is not valid. Use the full international format, like +15551234567."],
  PHONE_NUMBER_BANNED: [403, "Telegram has banned that phone number."],
  PHONE_NUMBER_UNOCCUPIED: [400, "That phone number has no Telegram account."],
  PHONE_CODE_INVALID: [400, "That login code is wrong. Check the code Telegram sent and try again."],
  PHONE_CODE_EMPTY: [400, "Enter the login code Telegram sent you."],
  PHONE_CODE_EXPIRED: [400, "That login code has expired. Start the login again to get a new one."],
  PASSWORD_HASH_INVALID: [400, "That two-step verification password is wrong."],
  API_ID_INVALID: [400, "Telegram rejected the API ID and API hash. Copy them again from my.telegram.org."],
  API_ID_PUBLISHED_FLOOD: [400, "Telegram blocked that API ID because it is public. Create your own at my.telegram.org."],
  AUTH_KEY_UNREGISTERED: [409, "The Telegram login has ended. Log in again."],
  SESSION_REVOKED: [409, "The Telegram login was ended from another device. Log in again."],
  USER_DEACTIVATED: [409, "That Telegram account has been deleted."],
  USER_DEACTIVATED_BAN: [409, "That Telegram account has been banned."],
  INVITE_HASH_EXPIRED: [400, "That invite link has expired or was revoked."],
  INVITE_HASH_INVALID: [400, "That invite link is not valid."],
  INVITE_HASH_EMPTY: [400, "That invite link is not valid."],
  INVITE_REQUEST_SENT: [409, "That chat needs an admin to approve new members. A join request was sent. Start the download again once you are approved."],
  INVITE_REQUEST_NEEDED: [409, "That chat needs an admin to approve new members. Ask to join from the Telegram app first."],
  USERNAME_NOT_OCCUPIED: [404, "No Telegram chat uses that username."],
  USERNAME_INVALID: [400, "That Telegram username is not valid."],
  CHANNEL_PRIVATE: [403, "That chat is private or you were removed from it. Use an invite link."],
  CHANNEL_INVALID: [400, "That chat could not be opened."],
  CHANNELS_TOO_MUCH: [409, "The Telegram account is in too many chats to join another one. Leave some chats first."],
  CHAT_FORWARDS_RESTRICTED: [403, "That chat blocks saving its content, so its videos cannot be downloaded."],
  NOT_A_MEMBER: [403, "The account is not a member of that private channel. Use an invite link instead."],
  NOT_LOGGED_IN: [409, "Connect a Telegram account first."],
  LOGIN_NOT_STARTED: [409, "Start the Telegram login again."],
  CONNECTION_FAILED: [502, "Could not reach Telegram from the server. Check the server's internet connection."],
};

function describeFailure(error) {
  const code = error?.code ?? "UNKNOWN";
  if (code === "FLOOD_WAIT") {
    const minutes = Math.ceil((error.seconds ?? 60) / 60);
    return `Telegram asked us to slow down. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return MESSAGES[code]?.[1] ?? `Telegram returned an error: ${code}`;
}

function toAppError(error) {
  if (error instanceof AppError) return error;
  if (!(error instanceof TelegramFailure)) return error;
  const status = error.code === "FLOOD_WAIT" ? 429 : (MESSAGES[error.code]?.[0] ?? 502);
  return new AppError(status, `telegram_${error.code.toLowerCase()}`, describeFailure(error), error.seconds ? { retryAfterSeconds: error.seconds } : {});
}

export { describeFailure, TelegramFailure, toAppError };
