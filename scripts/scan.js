// Market scanner for BingX USDT-M perpetuals: trend, RSI, ATR, funding and 30-day range per symbol.
// Public data only, no API keys needed.
//
// Usage:
//   npm run scan                      – scan the default watchlist (WATCHLIST below)
//   npm run scan -- BTC ETH SOL       – scan given symbols
//   npm run scan -- --json            – raw JSON instead of a table
//   npm run scan -- --send            – also send trade plans to VK and Telegram (whichever is set in .env:
//                                       VK_TOKEN + VK_USER_ID, TG_BOT_TOKEN + TG_CHAT_ID); --vk is the same
//   npm run scan -- --dry             – print that message without sending (--vk-dry is the same)
import { BingXClient } from "../src/bingx.js";
import { sendAll } from "../src/notify.js";
import { toSymbols, pub, klines, sleep } from "../src/quotes.js";
import { btcDominance, todayEvents, okxLiquidations, TZ, TZ_LABEL } from "../src/market.js";
import { env } from "../src/env.js";

// The watchlist lives in src/quotes.js (shared with the alerts).
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const symbols = toSymbols(args.filter((a) => !a.startsWith("--")));

const ema = (a, n) => {
  const k = 2 / (n + 1);
  let e = a[0];
  return a.map((x) => (e = x * k + e * (1 - k)));
};

function rsi(c, n = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = c[i] - c[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function atr(k, n = 14) {
  const tr = k.slice(1).map((x, i) => Math.max(x.h - x.l, Math.abs(x.h - k[i].c), Math.abs(x.l - k[i].c)));
  return tr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

const trend = (p, fast, slow) => (p > fast && fast > slow ? "UP" : p < fast && fast < slow ? "DN" : "MIX");

async function analyze(symbol) {
  const d = await klines(symbol, "1d", 120);
  const h4 = await klines(symbol, "4h", 200);
  const fr = await pub("/openApi/swap/v2/quote/premiumIndex", { symbol });
  const cd = d.map((x) => x.c), c4 = h4.map((x) => x.c), p = c4.at(-1);
  const e20d = ema(cd, 20).at(-1), e50d = ema(cd, 50).at(-1);
  const e20 = ema(c4, 20).at(-1), e50 = ema(c4, 50).at(-1), e200 = ema(c4, 200).at(-1);
  const last30 = d.slice(-30);
  const hi30 = Math.max(...last30.map((x) => x.h)), lo30 = Math.min(...last30.map((x) => x.l));
  const avgVol = (from, to) => { const s = d.slice(from, to); return s.reduce((a, x) => a + x.v * x.c, 0) / s.length; };
  const chg = (n) => (d.length > n ? (p / d.at(-1 - n).c - 1) * 100 : null);
  return {
    symbol: symbol.replace("-USDT", ""),
    price: p,
    ch1d: chg(1), ch7d: chg(7), ch30d: chg(30),
    rsi4h: rsi(c4), rsi1d: rsi(cd),
    trend4h: trend(p, e20, e50), trend1d: trend(p, e20d, e50d),
    ema20_4h: e20, ema50_4h: e50,
    vsEma200_4h: (p / e200 - 1) * 100,
    hi30, lo30, pos30: ((p - lo30) / (hi30 - lo30)) * 100,
    atr1dPct: (atr(d) / p) * 100, atr4h: atr(h4),
    volRatio7to30: avgVol(-8, -1) / avgVol(-31, -1),
    fundingPct: Number(fr.lastFundingRate) * 100,
    // Market structure on 4h: nearest swing (2 days) for stops, 7-day extremes for targets.
    swingHi4h: Math.max(...h4.slice(-12).map((x) => x.h)),
    swingLo4h: Math.min(...h4.slice(-12).map((x) => x.l)),
    hi7d4h: Math.max(...h4.slice(-42).map((x) => x.h)),
    lo7d4h: Math.min(...h4.slice(-42).map((x) => x.l)),
  };
}

// Simple tagging: what kind of setup the numbers suggest.
function signal(r) {
  if (r.atr1dPct > 15 || r.volRatio7to30 < 0.3) return "AVOID (volatile/illiquid)";
  if (r.trend4h === "UP" && r.trend1d !== "DN" && r.rsi4h < 70) return "LONG on pullback to EMA20 4h";
  if (r.trend4h === "DN" && r.trend1d === "DN") {
    return r.rsi4h < 33 ? "SHORT — wait for bounce (oversold)" : "SHORT on bounce to EMA20 4h";
  }
  if (r.fundingPct < 0 && r.ch1d < -3) return "squeeze risk (crowded shorts)";
  if (r.fundingPct > 0.015) return "crowded longs";
  return "-";
}

const results = [];
for (const s of symbols) {
  try {
    results.push(await analyze(s));
  } catch (e) {
    results.push({ symbol: s, error: e.message });
  }
  await sleep(150);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const f = (x, n = 1) => (x == null ? "" : x.toFixed(n));
  const g = (x) => String(+x.toPrecision(5));
  const cols = ["SYM", "price", "1d%", "7d%", "30d%", "RSI4h", "RSI1d", "T4h", "T1d", "EMA20_4h", "EMA50_4h", "lo30", "hi30", "ATR%d", "volR", "fund%", "signal"];
  const rows = results.map((r) =>
    r.error
      ? [r.symbol, `error: ${r.error}`]
      : [r.symbol, g(r.price), f(r.ch1d), f(r.ch7d), f(r.ch30d), f(r.rsi4h, 0), f(r.rsi1d, 0), r.trend4h, r.trend1d,
         g(r.ema20_4h), g(r.ema50_4h), g(r.lo30), g(r.hi30), f(r.atr1dPct), f(r.volRatio7to30, 2), f(r.fundingPct, 4), signal(r)],
  );
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => (r.length > 2 ? String(r[i] ?? "").length : 0))));
  const line = (r) => r.map((v, i) => (i === 0 || i === r.length - 1 ? String(v).padEnd(w[i]) : String(v).padStart(w[i]))).join("  ");
  console.log(`BingX scan ${new Date().toISOString()} — ${results.length} symbols`);
  console.log(line(cols));
  for (const r of rows) console.log(r.length > 2 ? line(r) : r.join("  "));
  const dn = results.filter((r) => r.trend1d === "DN").length;
  console.log(`\nDaily downtrend: ${dn}/${results.filter((r) => !r.error).length}`);
}

// VK report: only setups that can be worked in the next 1–2 hours.
// A setup qualifies when the price is already close to its entry level (EMA20 4h):
// within READY_ATR of one 4h ATR — a distance the price can cover in an hour or two.
// Oversold shorts, warnings (squeeze, crowded longs) and "avoid" are dropped: they are not entries.
const READY_ATR = 0.75;      // max distance to EMA20 4h, in 4h ATRs
const MAX_ATR_D = 10;        // skip coins with daily ATR above this %, too wild
const MIN_VOL_RATIO = 0.5;   // skip coins whose volume dried up (7d vs 30d)
const MAX_FUNDING = 0.03;    // skip if funding (%) is crowded against the trade
const MAX_SETUPS = 5;        // keep the message short

// Trade plan settings (override in .env).
const envNum = (name, def) => {
  const v = env(name);
  return v != null && v !== "" && Number.isFinite(+v) ? +v : def;
};
const MIN_RR = envNum("SCAN_MIN_RR", 2);          // main list: reward/risk at least 1:MIN_RR
const MIN_RR_WEAK = envNum("SCAN_MIN_RR_WEAK", 1); // separate list: from 1:MIN_RR_WEAK up to 1:MIN_RR
const MAX_WEAK = 3;                                // keep the weaker list short
const RISK_MIN = envNum("SCAN_RISK_MIN_PCT", 5);  // risk per trade, % of deposit (lower bound)
const RISK_MAX = envNum("SCAN_RISK_MAX_PCT", 15); // risk per trade, % of deposit (upper bound)
const LEVERAGE = envNum("SCAN_LEVERAGE", 30);     // leverage used to open trades: margin = position / leverage
// Deposit: futures account equity read from BingX on every run (needs BINGX_API_KEY / BINGX_SECRET_KEY,
// a read-only key is enough). Falls back to SCAN_DEPOSIT_USDT, then to sizes in % of deposit.
async function fetchDeposit() {
  const apiKey = env("BINGX_API_KEY"), secretKey = env("BINGX_SECRET_KEY");
  if (apiKey && secretKey) {
    try {
      const acc = new BingXClient({ apiKey, secretKey, demo: /^true$/i.test(env("BINGX_DEMO") ?? "false") });
      const data = await acc.get("/openApi/swap/v3/user/balance", {});
      const usdt = [data].flat().find((x) => x?.asset === "USDT" || x?.asset === "VST");
      const equity = Number(usdt?.equity);
      if (equity > 0) return { amount: equity, source: "BingX" };
      console.error("BingX balance: no USDT equity in the response");
    } catch (e) {
      console.error(`BingX balance failed: ${e.message}`);
    }
  }
  const manual = envNum("SCAN_DEPOSIT_USDT", 0);
  return manual > 0 ? { amount: manual, source: ".env" } : null;
}
const STOP_BUFFER_ATR = 0.25; // stop goes this far beyond the swing
const MIN_STOP_ATR = 1;       // stop never closer than 1 ATR (4h) to entry: inside that is noise
const ATR_TARGET = 3;         // target in ATRs when there is no structure ahead (price at the extreme)

const SIDES = { "LONG on pullback to EMA20 4h": "long", "SHORT on bounce to EMA20 4h": "short" };

// Entry at EMA20 4h, stop behind the 2-day swing, target at the 7-day extreme.
function tradePlan(r) {
  const side = SIDES[signal(r)];
  if (!side || r.atr1dPct > MAX_ATR_D || r.volRatio7to30 < MIN_VOL_RATIO) return null;
  const long = side === "long";
  // Strong only: daily trend must agree with the 4h trend.
  if (r.trend1d !== (long ? "UP" : "DN")) return null;
  const a = r.atr4h, entry = r.ema20_4h;
  // Distance the price must travel to reach the entry, in 4h ATRs.
  const dist = (long ? r.price - entry : entry - r.price) / a;
  if (dist < 0 || dist > READY_ATR) return null;
  if (long ? r.rsi4h > 65 || r.fundingPct > MAX_FUNDING : r.rsi4h < 35 || r.fundingPct < -MAX_FUNDING) return null;

  const dir = long ? 1 : -1;
  const swing = long ? Math.min(r.swingLo4h, entry) : Math.max(r.swingHi4h, entry);
  let stop = swing - dir * STOP_BUFFER_ATR * a;
  if (Math.abs(entry - stop) < MIN_STOP_ATR * a) stop = entry - dir * MIN_STOP_ATR * a;
  let target = long ? r.hi7d4h : r.lo7d4h, tpBy = "структура";
  if ((target - entry) * dir < 1.5 * a) { target = entry + dir * ATR_TARGET * a; tpBy = "ATR"; }
  const risk = Math.abs(entry - stop), rr = Math.abs(target - entry) / risk;
  if (rr < MIN_RR_WEAK) return null;
  const stopPct = (risk / entry) * 100;
  return { side, entry, stop, target, tpBy, rr, dist, stopPct };
}

// BTC dominance filter. Rising dominance while BTC falls: money leaves alts, they fall harder.
// Falling dominance while BTC rises: alts outrun BTC. Needs ~a day of dominance history on the server.
const BTCD_PP = envNum("SCAN_BTCD_PP", 0.5);    // dominance change over 24h, percentage points
const BTC_MOVE = envNum("SCAN_BTC_MOVE_PCT", 0.5); // BTC daily move, %

function altRegime(btcdChange, btcCh1d) {
  if (btcdChange == null || btcCh1d == null) return null;
  if (btcdChange >= BTCD_PP && btcCh1d <= -BTC_MOVE) return "alts-weak";
  if (btcdChange <= -BTCD_PP && btcCh1d >= BTC_MOVE) return "alts-strong";
  return null;
}

// "with" – the trade goes the way the regime pushes alts, "against" – the opposite; BTC itself is not affected.
function regimeTag(regime, symbol, side) {
  if (!regime || symbol === "BTC") return null;
  const favoured = regime === "alts-weak" ? "short" : "long";
  return side === favoured ? "with" : "against";
}

// Extra context must never break the report: on any error the line is just left out.
const safe = (p) => p.catch((e) => (console.error(`context: ${e.message}`), null));
const compactUsd = (x) =>
  x >= 1e6 ? `${(x / 1e6).toFixed(1)} млн $` : x >= 1e3 ? `${(x / 1e3).toFixed(0)} тыс $` : `${x.toFixed(0)} $`;

async function vkSummary(results, deposit) {
  const DEPOSIT = deposit?.amount ?? 0;
  const ok = results.filter((r) => !r.error);
  const num = (x) => String(+x.toPrecision(5));
  // Whole dollars for big sums, cents for small ones (a small deposit would otherwise show "−0 $").
  const usd = (x) => x.toLocaleString("ru-RU", { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 });
  const ts = new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
  // Fetched on every run, even with no setups: dominance history for the 24h change builds up from these.
  const [btcd, events] = await Promise.all([safe(btcDominance()), safe(todayEvents({ upcomingOnly: true }))]);
  const btc = ok.find((r) => r.symbol === "BTC");
  const regime = altRegime(btcd?.change24h, btc?.ch1d);

  const all = ok
    .map((r) => ({ r, t: tradePlan(r) }))
    .filter((x) => x.t)
    .map((x) => ({ ...x, mkt: regimeTag(regime, x.r.symbol, x.t.side) }))
    .sort((a, b) => b.t.rr - a.t.rr);
  // Against the market (see altRegime): never in the strong list, whatever the R:R.
  const strong = all.filter((x) => x.t.rr >= MIN_RR && x.mkt !== "against").slice(0, MAX_SETUPS);
  const weak = all.filter((x) => x.t.rr < MIN_RR || x.mkt === "against").slice(0, MAX_WEAK);
  if (!strong.length && !weak.length) return null; // nothing worth a message

  const lines = [`📊 Скан BingX — ${ts} (${TZ_LABEL})`];
  if (DEPOSIT) lines.push(`💼 Депозит: ${usd(DEPOSIT)} $${deposit.source === ".env" ? " (из настроек)" : ""}`);
  if (btcd) {
    const ch = btcd.change24h == null ? "" : ` (${btcd.change24h >= 0 ? "+" : ""}${btcd.change24h.toFixed(2)} за сутки)`;
    lines.push(`₿ Доминация BTC: ${btcd.value.toFixed(1)}%${ch}`);
  }
  if (regime === "alts-weak") lines.push("📉 Доминация растёт, BTC падает → альты слабее: лонги по альтам понижены");
  if (regime === "alts-strong") lines.push("📈 Доминация падает, BTC растёт → альты сильнее: шорты по альтам понижены");
  if (events?.length) lines.push(`📅 Сегодня: ${events.map((e) => `${e.time} ${e.title}`).join("; ")}`);

  const liqList = await Promise.all([...strong, ...weak].map(({ r }) => safe(okxLiquidations(r.symbol))));
  const liqs = new Map([...strong, ...weak].map(({ r }, i) => [r.symbol, liqList[i]]));
  const section = (title, items) => {
    if (!items.length) return;
    lines.push("", `${title} — ${items.length}`);
    for (const x of items) addPlan(x);
  };
  const addPlan = ({ r, t, mkt }) => {
    // Position size so that hitting the stop loses exactly riskPct of the deposit;
    // hitting the take then earns riskPct × R:R. Fees and slippage are not included.
    // Margin = position / leverage: the amount taken from the deposit to open the trade.
    const size = (riskPct) => {
      const mult = riskPct / t.stopPct; // position value / deposit
      const gainPct = riskPct * t.rr;
      const short = mult / LEVERAGE > 1 ? " ⚠️ не хватает депозита" : "";
      return DEPOSIT
        ? [`💰 Риск ${riskPct}%: маржа ${usd((DEPOSIT * mult) / LEVERAGE)} $ ×${LEVERAGE} = позиция ${usd(DEPOSIT * mult)} $${short}`,
           `     ⛔ стоп: −${usd((DEPOSIT * riskPct) / 100)} $ · 🎯 тейк: +${usd((DEPOSIT * gainPct) / 100)} $`]
        : [`💰 Риск ${riskPct}%: маржа ${((mult / LEVERAGE) * 100).toFixed(1)}% депо ×${LEVERAGE}${short}`,
           `     ⛔ стоп: −${riskPct}% депо · 🎯 тейк: +${gainPct.toFixed(0)}% депо`];
    };
    lines.push(
      "",
      "━━━━━━━━━━━━",
      `${t.side === "long" ? "🟢 ЛОНГ" : "🔴 ШОРТ"} ${r.symbol} · R:R 1:${t.rr.toFixed(1)}` +
        (mkt === "with" ? " · по рынку" : mkt === "against" ? " · против рынка" : ""),
      `▶️ Вход: ${num(t.entry)}`,
      `⛔ Стоп: ${num(t.stop)}`,
      `🎯 Тейк: ${num(t.target)}`,
      ...size(RISK_MIN),
      ...size(RISK_MAX),
    );
    const lq = liqs.get(r.symbol);
    if (lq && (lq.longs || lq.shorts)) {
      lines.push(`💥 Ликвидации OKX 24ч: лонги ${compactUsd(lq.longs)} · шорты ${compactUsd(lq.shorts)}`);
      const z = lq.zone;
      lines.push(`     макс. зона ${num(z.lo)}–${num(z.hi)} (${z.side === "long" ? "лонги" : "шорты"}, ${compactUsd(z.usd)})`);
    }
  };
  section(`✅ СИЛЬНЫЕ: R:R от 1:${MIN_RR}`, strong);
  section(`🟡 СЛАБЕЕ: R:R 1:${MIN_RR_WEAK}–1:${MIN_RR}${weak.some((x) => x.mkt === "against") ? " или против рынка" : ""}`, weak);
  return lines.join("\n");
}

// --send (or the old --vk) sends to every configured messenger; --dry (--vk-dry) only prints.
const dry = args.includes("--dry") || args.includes("--vk-dry");
const send = args.includes("--send") || args.includes("--vk");
const msgText = dry || send ? await vkSummary(results, await fetchDeposit()) : null;
if ((dry || send) && !msgText) {
  console.log(`\nNo setups with R:R >= 1:${MIN_RR_WEAK}, nothing sent.`);
} else if (dry) {
  console.log("\n--- message ---\n" + msgText);
} else if (send) {
  if (!(await sendAll(msgText))) process.exitCode = 1;
}
