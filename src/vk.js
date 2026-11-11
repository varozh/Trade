// Minimal VK API client: send a message from a community (group) to a user.
// Needs env: VK_TOKEN (community access key with "messages" right), VK_USER_ID (recipient).
// The recipient must have written to the community at least once, otherwise VK refuses.
const API = "https://api.vk.com/method/";
const VERSION = "5.199";
const MAX_LEN = 4000; // VK limit is 4096 chars per message

import { readFileSync } from "node:fs";

// VK_* from this project's .env win over the process environment: other scripts on the same
// server (e.g. a crontab with its own VK_TOKEN for another community) must not hijack the sender.
const ownEnv = (() => {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    return Object.fromEntries(
      text.split(/\r?\n/)
        .map((l) => l.match(/^\s*(VK_[A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
  } catch {
    return {};
  }
})();
const env = (name) => ownEnv[name] || process.env[name];

export async function vkCall(method, params, token = env("VK_TOKEN")) {
  if (!token) throw new Error("VK_TOKEN is not set");
  const body = new URLSearchParams({ ...params, access_token: token, v: VERSION });
  const res = await fetch(API + method, { method: "POST", body });
  const json = await res.json();
  if (json.error) throw new Error(`VK ${method}: ${json.error.error_code} ${json.error.error_msg}`);
  return json.response;
}

// Split long text by lines so every part fits into one message.
export function splitText(text, max = MAX_LEN) {
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) parts.push(cur);
  return parts;
}

export async function sendVk(text, userId = env("VK_USER_ID")) {
  if (!userId) throw new Error("VK_USER_ID is not set");
  for (const part of splitText(text)) {
    await vkCall("messages.send", {
      peer_id: userId,
      message: part,
      random_id: Math.floor(Math.random() * 2 ** 31),
    });
  }
}
