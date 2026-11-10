// Shows who has written to the community, to find your VK_USER_ID.
// Usage: node --env-file=.env scripts/vk-users.js
import { vkCall } from "../src/vk.js";

const r = await vkCall("messages.getConversations", { count: 20, extended: 1 });
const names = new Map((r.profiles ?? []).map((p) => [p.id, `${p.first_name} ${p.last_name}`]));
const users = r.items.map((i) => i.conversation.peer).filter((p) => p.type === "user");
if (!users.length) console.log("Диалогов нет. Напишите сообществу любое сообщение и запустите снова.");
for (const p of users) console.log(`VK_USER_ID=${p.id}  ${names.get(p.id) ?? ""}`);
