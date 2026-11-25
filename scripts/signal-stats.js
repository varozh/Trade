// Weekly statistics of scanner signals: what happened to each signal after it was sent.
// For every signal of the period (repeats are counted once) it walks 15m candles from the signal time:
//   the entry is a limit order at `entry`, valid for `validH` hours (saved with the signal; older ones: 12, 24 for the watch list);
//   after the fill, whichever comes first: stop (−1R) or take (+R:R). Both in one candle → stop (conservative).
//
//   node --env-file=.env scripts/signal-stats.js            – last 7 days, send
//   node --env-file=.env scripts/signal-stats.js --dry      – print only
//   node --env-file=.env scripts/signal-stats.js --days 30
import { readSignals } from "../src/store.js";
import { pub, sleep } from "../src/quotes.js";
import { sendInfo } from "../src/notify.js";
import { riskLevels } from "../src/env.js";
import { TZ } from "../src/market.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const days = Number(args[args.indexOf("--days") + 1]) || 7;
const [RISK] = riskLevels();

const D = 864e5, now = Date.now(), from = now - days * D;

// First signal of each coin+direction; later repeats within 24h are the same idea.
const all = readSignals().filter((s) => !s.manual && s.ts >= from).sort((a, b) => a.ts - b.ts); // /coin analyses excluded
const firsts = all.filter((s) => !s.repeat);
const repeats = all.length - firsts.length;

async function candles15m(symbol, start) {
  const r = await pub("/openApi/swap/v3/quote/klines", { symbol: `${symbol}-USDT`, interval: "15m", startTime: start, limit: 1000 });
  return r.map((k) => ({ t: +k.time, h: +k.high, l: +k.low, c: +k.close })).sort((a, b) => a.t - b.t);
}

async function outcome(s) {
  const k = (await candles15m(s.symbol, s.ts - 15 * 60e3)).filter((x) => x.t + 15 * 60e3 > s.ts);
  const long = s.side === "long";
  const hitEntry = (x) => (long ? x.l <= s.entry : x.h >= s.entry);
  const hitStop = (x) => (long ? x.l <= s.stop : x.h >= s.stop);
  const hitTake = (x) => (long ? x.h >= s.target : x.l <= s.target);
  const window = (s.validH ?? (s.watch || s.retest ? 24 : 12)) * 3600e3;
  const fill = k.findIndex((x) => x.t <= s.ts + window && hitEntry(x));
  if (fill < 0) return { ...s, result: k.at(-1)?.t > s.ts + window ? "missed" : "waiting", r: 0 };
  for (const x of k.slice(fill)) {
    if (hitStop(x)) return { ...s, result: "stop", r: -1 };
    if (hitTake(x)) return { ...s, result: "take", r: s.rr };
  }
  const last = k.at(-1).c; // still open: mark to market, in R
  const r = ((long ? last - s.entry : s.entry - last) / Math.abs(s.entry - s.stop));
  return { ...s, result: "open", r };
}

const res = [];
for (const s of firsts) {
  try {
    res.push(await outcome(s));
  } catch (e) {
    console.error(`${s.symbol}: ${e.message}`);
  }
  await sleep(150);
}

const fmtDate = (t) => new Date(t).toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "short" });
const R = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}R`;
const cnt = (f) => res.filter(f).length;
const lines = [`📊 Статистика сигналов сканера: ${fmtDate(from)} — ${fmtDate(now)}`, ""];

if (!res.length) {
  lines.push("Сигналов за период не было.");
} else {
  const filled = res.filter((x) => ["stop", "take", "open"].includes(x.result));
  const closed = res.filter((x) => x.result === "stop" || x.result === "take");
  const total = closed.reduce((a, x) => a + x.r, 0);
  lines.push(
    `📨 Сигналов: ${res.length}${repeats ? ` (+${repeats} повторов, не считаются)` : ""}`,
    `▶️ Дошли до входа: ${filled.length} из ${res.length}` + (cnt((x) => x.result === "waiting") ? ` · ещё ждут входа: ${cnt((x) => x.result === "waiting")}` : ""),
    `🎯 Тейк: ${cnt((x) => x.result === "take")} · ⛔ Стоп: ${cnt((x) => x.result === "stop")} · ⏳ ещё открыты: ${cnt((x) => x.result === "open")}`,
  );
  if (closed.length) {
    lines.push(
      `✅ Прибыльных из закрытых: ${Math.round((cnt((x) => x.result === "take") / closed.length) * 100)}%`,
      `💰 Итог закрытых: ${R(total)} (≈ ${total >= 0 ? "+" : "−"}${Math.abs(total * RISK).toFixed(0)}% депозита при риске ${RISK}% на сделку)`,
    );
  }
  const group = (title, f) => {
    const g = closed.filter(f);
    if (g.length) lines.push(`${title}: ${g.length} закрыто · ${R(g.reduce((a, x) => a + x.r, 0))} · тейков ${Math.round((g.filter((x) => x.result === "take").length / g.length) * 100)}%`);
  };
  lines.push("", "━━━━━━━━━━━━");
  group("✅ Сильные (старый список)", (x) => x.strong);
  group("📉 Откат к EMA20", (x) => !x.strong && !x.watch && !x.bounce);
  group("↩️ Отскок от уровня", (x) => x.bounce);
  group("⏳ Ожидание", (x) => x.watch);
  group("🟢 Лонги", (x) => x.side === "long");
  group("🔴 Шорты", (x) => x.side === "short");

  lines.push("", "━━━━━━━━━━━━");
  const icon = { take: "🎯", stop: "⛔", open: "⏳", missed: "➖", waiting: "🕐" };
  const word = { take: "тейк", stop: "стоп", open: "открыта", missed: "вход не дошёл", waiting: "ждёт входа" };
  for (const x of res) {
    const r = x.result === "missed" || x.result === "waiting" ? "" : ` ${R(x.r)}`;
    lines.push(`${icon[x.result]} ${fmtDate(x.ts)} ${x.symbol} ${x.side === "long" ? "лонг" : "шорт"} — ${word[x.result]}${r}`);
  }
}
lines.push("", "ℹ️ R — риск сделки: стоп = −1R, тейк = +R:R. Комиссии не учтены.");

const text = lines.join("\n");
if (dry) console.log(text);
else if (!(await sendInfo(text))) process.exitCode = 1;
