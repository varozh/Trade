// Send one text to every configured messenger (VK and/or Telegram, see .env).
// Each channel on its own: a failure in one must not block the other. Returns true if all succeeded.
// tgButtons: optional Telegram inline keyboard (rows of {text, callback_data}); VK gets plain text.
import { sendVk, vkConfigured } from "./vk.js";
import { sendTg, tgConfigured } from "./tg.js";

export async function sendAll(text, { tgButtons } = {}) {
  const channels = [
    ["VK", vkConfigured, (t) => sendVk(t)],
    ["Telegram", tgConfigured, (t) => sendTg(t, undefined, tgButtons)],
  ].filter(([, configured]) => configured());
  if (!channels.length) {
    console.error("No messenger configured: set VK_TOKEN/VK_USER_ID and/or TG_BOT_TOKEN/TG_CHAT_ID in .env");
    return false;
  }
  let ok = true;
  for (const [name, , send] of channels) {
    try {
      await send(text);
      console.log(`Sent to ${name}.`);
    } catch (e) {
      console.error(`${name} send failed: ${e.message}`);
      ok = false;
    }
  }
  return ok;
}
