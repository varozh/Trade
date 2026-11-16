// Minimal Telegram Bot API client: send a message from the bot to a chat.
// Needs .env: TG_BOT_TOKEN (from @BotFather), TG_CHAT_ID (the chat the bot writes to).
import { env, splitText } from "./env.js";
import { fetchRetry } from "./net.js";

const MAX_LEN = 4000; // Telegram limit is 4096 chars per message

export const tgConfigured = () => Boolean(env("TG_BOT_TOKEN") && env("TG_CHAT_ID"));

export async function tgCall(method, params = {}, token = env("TG_BOT_TOKEN")) {
  if (!token) throw new Error("TG_BOT_TOKEN is not set");
  // getUpdates long-polls (timeout up to 50s) and is retried by the bot loop itself.
  const poll = method === "getUpdates";
  const res = await fetchRetry(
    `https://api.telegram.org/bot${token}/${method}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) },
    poll ? { tries: 1, timeoutMs: 70000 } : {},
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

// buttons: inline keyboard rows, attached to the last part of a long message.
export async function sendTg(text, chatId = env("TG_CHAT_ID"), buttons) {
  if (!chatId) throw new Error("TG_CHAT_ID is not set");
  const parts = splitText(text, MAX_LEN);
  for (const [i, part] of parts.entries()) {
    const markup = buttons?.length && i === parts.length - 1 ? { reply_markup: { inline_keyboard: buttons } } : {};
    await tgCall("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true, ...markup });
  }
}
