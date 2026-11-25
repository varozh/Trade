// Where messages go: trade signals (scanner) — Telegram only, they carry the "open" buttons;
// everything informational (alerts, events, journal, statistics, top coins) — VK only.
// Each channel on its own: a failure in one must not block the other. Returns true if all succeeded.
// tgButtons: optional Telegram inline keyboard (rows of {text, callback_data}); VK gets plain text.
import { sendVk, vkConfigured } from "./vk.js";
import { sendTg, tgConfigured } from "./tg.js";

const CHANNELS = {
  vk: ["VK", vkConfigured, (t) => sendVk(t)],
  tg: ["Telegram", tgConfigured, (t, buttons) => sendTg(t, undefined, buttons)],
};

async function sendTo(keys, text, tgButtons) {
  const channels = keys.map((k) => CHANNELS[k]).filter(([, configured]) => configured());
  if (!channels.length) {
    console.error(`No messenger configured for ${keys.join("/")}: set VK_TOKEN/VK_USER_ID and/or TG_BOT_TOKEN/TG_CHAT_ID in .env`);
    return false;
  }
  let ok = true;
  for (const [name, , send] of channels) {
    try {
      await send(text, tgButtons);
      console.log(`Sent to ${name}.`);
    } catch (e) {
      console.error(`${name} send failed: ${e.message}`);
      ok = false;
    }
  }
  return ok;
}

// Trade signals: Telegram only.
export const sendSignal = (text, { tgButtons } = {}) => sendTo(["tg"], text, tgButtons);
// Informational messages: VK only. --tg (passed by the Telegram bot for /journal, /stats, /top):
// the report was asked for in Telegram, so it is answered there.
export const sendInfo = (text) => sendTo([process.argv.includes("--tg") ? "tg" : "vk"], text);
