// Weekly trading journal: closed BingX futures positions of the last 7 days, sent to VK / Telegram.
// Needs BINGX_API_KEY / BINGX_SECRET_KEY in .env (a read-only key is enough).
//
//   node --env-file=.env scripts/journal.js             – last 7 days, send
//   node --env-file=.env scripts/journal.js --dry       – print only
//   node --env-file=.env scripts/journal.js --days 30   – another period
import { BingXClient } from "../src/bingx.js";
import { sendAll } from "../src/notify.js";
import { env } from "../src/env.js";
import { TZ, TZ_LABEL } from "../src/market.js";
import { sleep } from "../src/quotes.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const days = Number(args[args.indexOf("--days") + 1]) || 7;

const client = new BingXClient({
  apiKey: env("BINGX_API_KEY"),
  secretKey: env("BINGX_SECRET_KEY"),
  demo: /^true$/i.test(env("BINGX_DEMO") ?? "false"),
});
if (!client.hasKeys) {
  console.error("BINGX_API_KEY / BINGX_SECRET_KEY are not set in .env");
  process.exit(1);
}

const D = 864e5;
const now = Date.now();

// Closed positions with close time inside [from, to).
async function closedPositions(from, to) {
  // Symbols traded in the period come from realized PnL records (positionHistory needs a symbol).
  const income = [await client.get("/openApi/swap/v2/user/income", { incomeType: "REALIZED_PNL", limit: 1000, startTime: from, endTime: to })]
    .flat()
    .filter(Boolean);
  const symbols = [...new Set(income.map((x) => x.symbol))];
  const out = [];
  // BingX returns nothing when paging params are passed, so ask in 7-day windows instead.
  const seen = new Set();
  for (const symbol of symbols) {
    for (let t = from; t < to; t += 7 * D) {
      const r = await client.get("/openApi/swap/v1/trade/positionHistory", { symbol, startTs: t, endTs: Math.min(to, t + 7 * D) });
      for (const p of r?.positionHistory ?? []) {
        if (!seen.has(p.positionId)) (seen.add(p.positionId), out.push(p));
      }
      await sleep(120);
    }
  }
  return out
    .filter((p) => +p.updateTime >= from && +p.updateTime < to)
    .map((p) => ({
      symbol: p.symbol.replace("-USDT", ""),
      side: p.positionSide === "SHORT" ? "short" : "long",
      open: +p.openTime,
      close: +p.updateTime,
      entry: +p.avgPrice,
      exit: +p.avgClosePrice,
      qty: +p.closePositionAmt || +p.positionAmt,
      leverage: +p.leverage,
      net: +p.netProfit, // after commission and funding
      fee: -Number(p.positionCommission || 0),
      funding: Number(p.totalFunding || 0),
    }))
    .map((p) => ({ ...p, notional: p.qty * p.entry }))
    .sort((a, b) => a.close - b.close);
}

async function equity() {
  try {
    const d = await client.get("/openApi/swap/v3/user/balance", {});
    const u = [d].flat().find((x) => x?.asset === "USDT" || x?.asset === "VST");
    return Number(u?.equity) || null;
  } catch {
    return null;
  }
}

const [cur, prev, eq] = await Promise.all([
  closedPositions(now - days * D, now),
  closedPositions(now - 2 * days * D, now - days * D),
  equity(),
]);

// ---------- numbers ----------
const sum = (a, f = (x) => x.net) => a.reduce((s, x) => s + f(x), 0);
const money = (x) => `${x < 0 ? "−" : x > 0 ? "+" : ""}${Math.abs(x).toLocaleString("ru-RU", { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 })} $`;
const plain = (x) => `${x.toLocaleString("ru-RU", { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 })} $`;
const hours = (ms) => (ms < 3600e3 ? `${Math.round(ms / 60e3)} мин` : ms < 48 * 3600e3 ? `${(ms / 3600e3).toFixed(1)} ч` : `${(ms / D).toFixed(1)} дн`);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

const fmtDate = (t) => new Date(t).toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "short" });
const lines = [`📒 Дневник сделок: ${fmtDate(now - days * D)} — ${fmtDate(now)}`];

if (!cur.length) {
  lines.push("", "Закрытых сделок за период нет.");
  if (eq) lines.push(`💼 Депозит: ${plain(eq)}`);
} else {
  const wins = cur.filter((p) => p.net > 0), losses = cur.filter((p) => p.net <= 0);
  const net = sum(cur), grossWin = sum(wins), grossLoss = -sum(losses);
  const pf = grossLoss > 0 ? grossWin / grossLoss : null;
  const fees = sum(cur, (p) => p.fee), funding = sum(cur, (p) => p.funding);
  const prevNet = prev.length ? sum(prev) : null;

  lines.push(
    "",
    // No "% of deposit": transfers in/out during the period make the starting deposit unknown.
    `${net >= 0 ? "🟢" : "🔴"} Итог: ${money(net)}`,
    prevNet == null ? null : `     прошлый период: ${money(prevNet)}`,
    `🎯 Сделок: ${cur.length} · прибыльных ${wins.length} (${Math.round((wins.length / cur.length) * 100)}%)`,
    `⚖️ Profit factor: ${pf == null ? "∞" : pf.toFixed(2)}`,
    wins.length ? `     средняя прибыль: ${money(grossWin / wins.length)}` : null,
    losses.length ? `     средний убыток: ${money(-grossLoss / losses.length)}` : null,
    `💸 Комиссии: ${money(-fees)} · фандинг: ${money(funding)}`,
    eq ? `💼 Депозит сейчас: ${plain(eq)}` : null,
  );

  // Long vs short
  lines.push("", "━━━━━━━━━━━━");
  for (const [side, title] of [["long", "🟢 Лонги"], ["short", "🔴 Шорты"]]) {
    const s = cur.filter((p) => p.side === side);
    if (s.length) lines.push(`${title}: ${s.length} сд. · ${money(sum(s))} · прибыльных ${Math.round((s.filter((p) => p.net > 0).length / s.length) * 100)}%`);
  }

  // By coin
  const byCoin = new Map();
  for (const p of cur) byCoin.set(p.symbol, (byCoin.get(p.symbol) ?? 0) + p.net);
  const coins = [...byCoin.entries()].sort((a, b) => b[1] - a[1]);
  const top = coins.filter(([, v]) => v > 0).slice(0, 3);
  const bottom = coins.filter(([, v]) => v < 0).slice(-3).reverse();
  if (top.length) lines.push(`🏆 Лучшие монеты: ${top.map(([s, v]) => `${s} ${money(v)}`).join(", ")}`);
  if (bottom.length) lines.push(`🩸 Худшие монеты: ${bottom.map(([s, v]) => `${s} ${money(v)}`).join(", ")}`);
  const best = cur.reduce((a, b) => (b.net > a.net ? b : a)), worst = cur.reduce((a, b) => (b.net < a.net ? b : a));
  lines.push(`⬆️ Лучшая сделка: ${best.symbol} ${best.side === "long" ? "лонг" : "шорт"} ${money(best.net)}`);
  if (worst.net < 0) lines.push(`⬇️ Худшая сделка: ${worst.symbol} ${worst.side === "long" ? "лонг" : "шорт"} ${money(worst.net)}`);

  // ---------- observations ----------
  const notes = [];
  const holdW = median(wins.map((p) => p.close - p.open)), holdL = median(losses.map((p) => p.close - p.open));
  if (wins.length && losses.length) {
    lines.push(`⏱ Удержание (медиана): прибыльные ${hours(holdW)} · убыточные ${hours(holdL)}`);
    if (holdL > holdW * 1.5) notes.push("Убыточные сделки держатся заметно дольше прибыльных: похоже, прибыль фиксируется рано, а убыток пересиживается.");
  }
  if (wins.length && losses.length) {
    const avgW = grossWin / wins.length, avgL = grossLoss / losses.length;
    if (avgL > avgW) notes.push(`Средний убыток больше средней прибыли в ${(avgL / avgW).toFixed(1)} раза: при таком соотношении нужен высокий процент прибыльных сделок.`);
  }
  const grossAbs = grossWin + grossLoss;
  if (grossAbs > 0 && fees + Math.max(0, -funding) > 0.2 * Math.max(grossWin, 1e-9)) {
    notes.push(`Комиссии и фандинг съели ${Math.round(((fees + Math.max(0, -funding)) / grossWin) * 100)}% прибыли.`);
  }
  // Longest losing streak
  let streak = 0, maxStreak = 0;
  for (const p of cur) {
    streak = p.net <= 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  if (maxStreak >= 3) notes.push(`Серия из ${maxStreak} убыточных сделок подряд.`);
  // Bigger size right after a loss
  const typical = median(cur.map((p) => p.notional));
  const afterLoss = cur.filter((p, i) => i > 0 && cur[i - 1].net < 0 && p.open >= cur[i - 1].close && p.notional > 1.5 * typical);
  if (afterLoss.length) notes.push(`${afterLoss.length} раз объём сразу после убытка был в 1,5+ раза больше обычного — признак отыгрыша.`);
  const levs = [...new Set(cur.map((p) => p.leverage))];
  if (levs.length > 1) notes.push(`Плечо менялось: ${levs.sort((a, b) => a - b).map((l) => `×${l}`).join(", ")}.`);

  if (notes.length) lines.push("", "━━━━━━━━━━━━", "🧠 Наблюдения:", ...notes.map((n) => `• ${n}`));
}

const text = lines.filter((l) => l != null).join("\n");
if (dry) console.log(text);
else if (!(await sendAll(text))) process.exitCode = 1;
