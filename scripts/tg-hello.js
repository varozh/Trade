// Отправка сообщения в Telegram через бота.
//
//   node --env-file=.env scripts/tg-hello.js              -> отправит "привет"
//   node --env-file=.env scripts/tg-hello.js "текст"      -> отправит свой текст
//   node --env-file=.env scripts/tg-hello.js --chat-id    -> покажет chat_id (сначала напишите боту)
//
// Нужны переменные в .env: TG_BOT_TOKEN (и TG_CHAT_ID для отправки).
// Скрипт самостоятельный: без зависимостей, не трогает другие скрипты и их переменные.

const token = process.env.TG_BOT_TOKEN;
const chatId = process.env.TG_CHAT_ID;
const args = process.argv.slice(2);

if (!token) {
  console.error("Нет TG_BOT_TOKEN в .env");
  process.exit(1);
}

async function tg(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

try {
  if (args[0] === "--chat-id") {
    const updates = await tg("getUpdates");
    const chats = new Map();
    for (const u of updates) {
      const chat = (u.message || u.channel_post || u.my_chat_member)?.chat;
      if (chat) chats.set(chat.id, chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username);
    }
    if (!chats.size) {
      console.log("Сообщений нет. Напишите боту /start в Telegram и запустите команду снова.");
    } else {
      for (const [id, name] of chats) console.log(`TG_CHAT_ID=${id}   (${name})`);
    }
  } else {
    if (!chatId) {
      console.error("Нет TG_CHAT_ID в .env (узнать: npm run tg:chat-id)");
      process.exit(1);
    }
    const text = args.join(" ") || "привет";
    await tg("sendMessage", { chat_id: chatId, text });
    console.log(`${new Date().toISOString()} отправлено: ${text}`);
  }
} catch (e) {
  console.error(`${new Date().toISOString()} ошибка: ${e.message}`);
  process.exit(1);
}
