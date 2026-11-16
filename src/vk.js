// Minimal VK API client: send a message from a community (group) to a user.
// Needs .env: VK_TOKEN (community access key with "messages" right), VK_USER_ID (recipient).
// The recipient must have written to the community at least once, otherwise VK refuses.
import { env, splitText } from "./env.js";
import { fetchRetry } from "./net.js";

const API = "https://api.vk.com/method/";
const VERSION = "5.199";
const MAX_LEN = 4000; // VK limit is 4096 chars per message

export const vkConfigured = () => Boolean(env("VK_TOKEN") && env("VK_USER_ID"));

export async function vkCall(method, params, token = env("VK_TOKEN")) {
  if (!token) throw new Error("VK_TOKEN is not set");
  const body = new URLSearchParams({ ...params, access_token: token, v: VERSION });
  const res = await fetchRetry(API + method, { method: "POST", body });
  const json = await res.json();
  if (json.error) throw new Error(`VK ${method}: ${json.error.error_code} ${json.error.error_msg}`);
  return json.response;
}

export async function sendVk(text, userId = env("VK_USER_ID")) {
  if (!userId) throw new Error("VK_USER_ID is not set");
  for (const part of splitText(text, MAX_LEN)) {
    await vkCall("messages.send", {
      peer_id: userId,
      message: part,
      random_id: Math.floor(Math.random() * 2 ** 31),
    });
  }
}
