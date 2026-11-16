// Telegram control bot. Runs all the time (systemd service on the server), long-polls Telegram.
// Answers only the chat in TG_CHAT_ID; everyone else is ignored.
//
// Commands: /scan /signals /status /positions /journal [days] /stats [days] /top /list /add SYM /remove SYM
//           /pause [hours] /resume /help
// Signal buttons "SYM 5%" / "SYM 15%" (under scanner messages and /signals) open a position after a confirmation.
//
//   node --env-file=.env scripts/bot.js
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tgCall } from "../src/tg.js";
import { env } from "../src/env.js";
import { readSignals, pausedUntil, setPause } from "../src/store.js";
import { TZ } from "../src/market.js";
import { planOrder, placeOrder, account, openPositions, LEVERAGE } from "../src/trade.js";
import { watchlist, editWatchlist, pub } from "../src/quotes.js";

const CHAT = String(env("TG_CHAT_ID") ?? "");
if (!env("TG_BOT_TOKEN") || !CHAT) {
  console.error("TG_BOT_TOKEN / TG_CHAT_ID are not set in .env");
  process.exit(1);
}
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIGNAL_MAX_AGE_H = 6; // older signals cannot be opened from a button
const RISKS = [Number(env("SCAN_RISK_MIN_PCT")) || 5, Number(env("SCAN_RISK_MAX_PCT")) || 15];

const say = (text, buttons) =>
  tgCall("sendMessage", { chat_id: CHAT, text, disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
const time = (t) => new Date(t).toLocaleString("ru-RU", { timeZone: TZ, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const num = (x) => String(+Number(x).toPrecision(6));
const usd = (x) => `${x.toLocaleString("ru-RU", { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 })} $`;

// Run one of the project scripts; it sends its own report. Returns its console output.
function run(script, args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [`scripts/${script}`, ...args], { cwd: ROOT });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}
async function runAndReport(script, args, busyText, emptyRe, emptyText) {
  await say(busyText);
  const { code, out } = await run(script, args);
  if (emptyRe && emptyRe.test(out)) await say(emptyText);
  else if (code !== 0) await say(`⚠️ Ошибка:\n${out.trim().split("\n").slice(-5).join("\n")}`);
}

const signalButtons = (list) =>
  list.map((s) => RISKS.map((r, i) => ({ text: `${i ? "" : s.side === "long" ? "🟢 " : "🔴 "}${s.symbol} ${r}%`, callback_data: `open:${s.id}:${r}` })));

const commands = {
  async help() {
    await say(
      [
        "🤖 Команды:",
        "/scan — скан прямо сейчас",
        "/signals — сигналы последнего скана с кнопками открытия",
        "/status — депозит, позиции, пауза",
        "/positions — открытые позиции",
        "/journal 7 — дневник сделок за N дней",
        "/stats 7 — статистика сигналов за N дней",
        "/top — самые активные монеты",
        "/list — список монет для анализа",
        "/add NEAR — добавить монету (можно несколько)",
        "/remove NEAR — убрать монету",
        "/pause 12 — пауза сигналов и алертов на N часов",
        "/resume — снять паузу",
      ].join("\n"),
    );
  },
  start() {
    return commands.help();
  },
  async scan() {
    await runAndReport("scan.js", ["--send"], "⏳ Сканирую, около минуты…", /nothing sent/, "Подходящих сетапов сейчас нет.");
  },
  async signals() {
    const all = readSignals();
    const lastTs = all.at(-1)?.ts;
    const list = all.filter((s) => s.ts === lastTs && Date.now() - s.ts < SIGNAL_MAX_AGE_H * 3600e3);
    if (!list.length) return say(`Свежих сигналов нет (не старше ${SIGNAL_MAX_AGE_H} ч). Запустите /scan.`);
    const lines = [`📋 Сигналы от ${time(lastTs)}:`, ""];
    for (const s of list) {
      lines.push(`${s.side === "long" ? "🟢 ЛОНГ" : "🔴 ШОРТ"} ${s.symbol} · R:R 1:${s.rr} · вход ${num(s.entry)} · стоп ${num(s.stop)} · тейк ${num(s.target)}`);
    }
    lines.push("", "Нажмите монету и риск, чтобы открыть позицию (будет подтверждение).");
    await say(lines.join("\n"), signalButtons(list));
  },
  async status() {
    const [acc, pos] = await Promise.all([account(), openPositions()]);
    const until = pausedUntil();
    const last = readSignals().at(-1);
    await say(
      [
        `💼 Депозит: ${usd(acc.equity)} · свободно ${usd(acc.available)}`,
        `📂 Открытых позиций: ${pos.length}${pos.length ? ` · PnL ${usd(pos.reduce((a, p) => a + p.pnl, 0))}` : ""}`,
        `⏸ ${until > Date.now() ? `Пауза до ${time(until)}` : "Пауза выключена"}`,
        `📨 Последний сигнал: ${last ? `${time(last.ts)} (${last.symbol})` : "нет"}`,
      ].join("\n"),
    );
  },
  async positions() {
    const pos = await openPositions();
    if (!pos.length) return say("Открытых позиций нет.");
    await say(pos.map((p) => `${p.side === "long" ? "🟢" : "🔴"} ${p.symbol} ×${p.leverage} · ${num(p.qty)} по ${num(p.entry)} · PnL ${usd(p.pnl)}`).join("\n"));
  },
  async journal(arg) {
    await runAndReport("journal.js", ["--days", String(Number(arg) || 7)], "⏳ Собираю дневник…");
  },
  async stats(arg) {
    await runAndReport("signal-stats.js", ["--days", String(Number(arg) || 7)], "⏳ Считаю статистику…");
  },
  async top() {
    await runAndReport("top.js", [], "⏳ Собираю список…");
  },
  async list() {
    const w = watchlist();
    await say(`📋 Список анализа (${w.length}):\n${w.join(" ")}\n\n/add SYM — добавить · /remove SYM — убрать`);
  },
  async add(arg) {
    await editCoins(arg, true);
  },
  async remove(arg) {
    await editCoins(arg, false);
  },
  async pause(arg) {
    const h = Number(arg) || 12;
    setPause(Date.now() + h * 3600e3);
    await say(`⏸ Сигналы и алерты на паузе до ${time(Date.now() + h * 3600e3)}. Отчёты и дневник приходят как обычно. /resume — снять.`);
  },
  async resume() {
    setPause(0);
    await say("▶️ Пауза снята.");
  },
};

// ---------- watchlist ----------
const base = (s) => s.toUpperCase().replace(/[/_]/g, "-").replace(/-?USDT$/, "").replace(/-$/, "");
let contractNames = null;
async function exists(sym) {
  if (!contractNames) {
    const list = await pub("/openApi/swap/v2/quote/contracts", {});
    contractNames = new Set(list.map((c) => c.symbol.replace("-USDT", "")));
  }
  return contractNames.has(sym);
}
async function editCoins(arg, add) {
  const syms = arg.split(/[\s,]+/).filter(Boolean).map(base);
  if (!syms.length) return say(add ? "Укажите монету: /add NEAR (можно несколько: /add NEAR WLD)" : "Укажите монету: /remove NEAR");
  const current = new Set(watchlist());
  const done = [], skipped = [];
  for (const s of syms) {
    if (add && current.has(s)) skipped.push(`${s} уже в списке`);
    else if (!add && !current.has(s)) skipped.push(`${s} нет в списке`);
    else if (add && !(await exists(s))) skipped.push(`${s} нет на BingX${(await exists(`1000${s}`)) ? ` (есть 1000${s})` : ""}`);
    else (editWatchlist(s, add), done.push(s));
  }
  const lines = [];
  if (done.length) lines.push(`${add ? "➕ Добавлено" : "➖ Убрано"}: ${done.join(", ")} · в списке ${watchlist().length} монет`);
  if (skipped.length) lines.push(`Пропущено: ${skipped.join("; ")}`);
  if (done.length) lines.push("Изменения действуют со следующего скана и алертов.");
  await say(lines.join("\n"));
}

// ---------- buttons ----------
async function onButton(data) {
  const [action, id, riskStr] = data.split(":");
  if (action === "cancel") return say("❌ Отменено.");
  if (action === "add") return editCoins(id, true);
  const s = readSignals().find((x) => x.id === id);
  if (!s) return say("Сигнал не найден (возможно, удалён при очистке).");
  if (Date.now() - s.ts > SIGNAL_MAX_AGE_H * 3600e3) return say(`Сигнал старше ${SIGNAL_MAX_AGE_H} ч, открывать по нему уже нельзя. Запустите /scan.`);
  const risk = Number(riskStr);

  let p;
  try {
    p = await planOrder(s, risk);
  } catch (e) {
    return say(`⚠️ ${s.symbol}: ${e.message}`);
  }

  if (action === "open") {
    return say(
      [
        `${p.side === "long" ? "🟢 ЛОНГ" : "🔴 ШОРТ"} ${s.symbol} · риск ${risk}% · плечо ×${LEVERAGE}`,
        `▶️ Лимит: ${num(p.entry)} (цена сейчас ${num(p.price)})`,
        `⛔ Стоп: ${num(p.stop)} · −${usd(p.loss)}`,
        `🎯 Тейк: ${num(p.target)} · +${usd(p.gain)}`,
        `📦 Объём: ${num(p.qty)} ${p.asset} = ${usd(p.notional)} · маржа ${usd(p.margin)}`,
        p.immediate ? "⚠️ Цена уже прошла вход: ордер исполнится сразу по рынку." : null,
        "",
        "Открыть на реальном счёте?",
      ]
        .filter((l) => l != null)
        .join("\n"),
      [[{ text: "✅ Открыть", callback_data: `confirm:${id}:${risk}` }, { text: "❌ Отмена", callback_data: "cancel" }]],
    );
  }

  if (action === "confirm") {
    try {
      const r = await placeOrder(p);
      const orderId = r?.order?.orderId ?? r?.orderId ?? "";
      return say(`✅ Ордер выставлен: ${s.symbol} ${p.side === "long" ? "лонг" : "шорт"} ${num(p.qty)} по ${num(p.entry)}, стоп ${num(p.stop)}, тейк ${num(p.target)}${orderId ? `\nID: ${orderId}` : ""}`);
    } catch (e) {
      return say(`⚠️ BingX отклонил ордер: ${e.message}`);
    }
  }
}

// ---------- main loop ----------
const own = (chat) => String(chat?.id) === CHAT;

await tgCall("setMyCommands", {
  commands: [
    ["scan", "скан прямо сейчас"],
    ["signals", "сигналы с кнопками открытия"],
    ["status", "депозит, позиции, пауза"],
    ["positions", "открытые позиции"],
    ["journal", "дневник сделок, /journal 7"],
    ["stats", "статистика сигналов, /stats 7"],
    ["top", "самые активные монеты"],
    ["list", "список монет для анализа"],
    ["add", "добавить монету, /add NEAR"],
    ["remove", "убрать монету, /remove NEAR"],
    ["pause", "пауза сигналов, /pause 12"],
    ["resume", "снять паузу"],
    ["help", "список команд"],
  ].map(([command, description]) => ({ command, description })),
}).catch((e) => console.error(`setMyCommands: ${e.message}`));
console.log(`${new Date().toISOString()} bot started`);

let offset = 0;
for (;;) {
  let updates = [];
  try {
    updates = await tgCall("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
  } catch (e) {
    console.error(`${new Date().toISOString()} getUpdates: ${e.message}`);
    await new Promise((r) => setTimeout(r, 5000));
    continue;
  }
  for (const u of updates) {
    offset = u.update_id + 1;
    try {
      if (u.message && own(u.message.chat)) {
        const m = (u.message.text ?? "").match(/^\/(\w+)(?:@\w+)?\s*(.*)$/);
        const cmd = m && commands[m[1].toLowerCase()];
        if (cmd) await cmd(m[2].trim());
        else if (m) await say("Не знаю такой команды. /help — список.");
      } else if (u.callback_query && own(u.callback_query.message?.chat)) {
        await tgCall("answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => {});
        await onButton(u.callback_query.data ?? "");
      }
    } catch (e) {
      console.error(`${new Date().toISOString()} ${e.message}`);
      await say(`⚠️ Ошибка: ${e.message}`).catch(() => {});
    }
  }
}
