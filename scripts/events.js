// Morning message: today's high-impact US macro events (FOMC, CPI, NFP, …), time in Moscow.
// Nothing is sent when the day has no such events.
//
//   node --env-file=.env scripts/events.js          – send to VK / Telegram
//   node --env-file=.env scripts/events.js --dry    – print only
import { todayEvents } from "../src/market.js";
import { sendAll } from "../src/notify.js";

const dry = process.argv.includes("--dry");
const date = new Date().toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "long", weekday: "long" });

let events;
try {
  events = await todayEvents();
} catch (e) {
  console.error(`Calendar failed: ${e.message}`);
  process.exit(1);
}

if (!events.length) {
  console.log(`${date}: no high-impact US events, nothing sent.`);
} else {
  const lines = [`📅 События США на сегодня, ${date}`, ""];
  for (const e of events) {
    const extra = [e.forecast && `прогноз ${e.forecast}`, e.previous && `пред. ${e.previous}`].filter(Boolean).join(", ");
    lines.push(`🕐 ${e.time} МСК — ${e.title}${extra ? ` (${extra})` : ""}`);
  }
  lines.push("", "⚠️ Около выхода данных возможны резкие движения и проскальзывание.");
  const text = lines.join("\n");
  if (dry) console.log(text);
  else if (!(await sendAll(text))) process.exitCode = 1;
}
