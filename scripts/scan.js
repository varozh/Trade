// Market scanner for BingX USDT-M perpetuals: trend, RSI, ATR, funding and 30-day range per symbol.
// Public data only, no API keys needed.
//
// Usage:
//   npm run scan                      – scan the default watchlist (WATCHLIST below)
//   npm run scan -- BTC ETH SOL       – scan given symbols
//   npm run scan -- --json            – raw JSON instead of a table
//   npm run scan -- --send            – open the new signals on BingX (auto-trading, needs BINGX_API_KEY with
//                                       trading rights; SCAN_AUTO_TRADE=false or /auto off: send them to Telegram
//                                       instead) and report changes of open positions; --vk is the same
//   npm run scan -- --send --show     – send the signals to Telegram with buttons, open nothing (/scan in the bot)
//   npm run scan -- --dry             – print that message without sending (--vk-dry is the same)
import { BingXClient } from "../src/bingx.js";
import { sendSignal } from "../src/notify.js";
import { sendTg } from "../src/tg.js";
import { toSymbols, pub, klines, sleep } from "../src/quotes.js";
import { readJson, writeJson, readSignals, appendSignals, isPaused, autoTrading, addPendingOrder } from "../src/store.js";
import { btcDominance, todayEvents, okxLiquidations, TZ, TZ_LABEL } from "../src/market.js";
import { env, riskLevels } from "../src/env.js";
import { openPositions, openOrders, isEntryOrder, planOrder, placeOrder } from "../src/trade.js";

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

// Horizontal levels: swing highs and lows (fractals, `side` candles each way) on 1d (LEVEL_DAYS of history)
// and 4h (about 80 days), merged into zones when closer than `tol`. A level is stronger the more swings it
// gathers (highs and lows both count: old support becomes resistance); the extremes of the whole history,
// of 120 days and of 30 days get a bonus. The date of the last touch shows whether the level is still alive.
const LEVEL_DAYS = Math.min(1400, Math.max(120, Number(process.env.SCAN_LEVEL_DAYS) || 730));
const H4_CANDLES = 500;
function pivots(k, side) {
  const out = [];
  for (let i = side; i < k.length - side; i++) {
    const w = k.slice(i - side, i + side + 1);
    if (k[i].h === Math.max(...w.map((x) => x.h))) out.push({ v: k[i].h, t: k[i].t });
    if (k[i].l === Math.min(...w.map((x) => x.l))) out.push({ v: k[i].l, t: k[i].t });
  }
  return out;
}
const period = (days) => (days >= 365 ? `${+(days / 365).toFixed(1)} г.` : `${Math.round(days / 30)} мес.`);
const shortDate = (t) => new Date(t).toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "2-digit" });

function findLevels(d, h4, tol) {
  // The last 4h candles are the bounce itself: they must not make the level they bounce from.
  // A 4h swing within the daily history is the same touch seen closer: daily swings use 4 candles each way.
  const pts = [...pivots(d.slice(0, -1), 4).map((p) => ({ ...p, w: 1.5 })), ...pivots(h4.slice(0, -6), 3).map((p) => ({ ...p, w: 1 }))]
    .sort((a, b) => a.v - b.v);
  const zones = [];
  for (const p of pts) {
    const z = zones.at(-1);
    if (z && p.v - z.pts[0].v <= tol) z.pts.push(p), (z.score += p.w);
    else zones.push({ pts: [p], score: p.w });
  }
  const old = d.slice(0, -1);
  const lo = (k) => Math.min(...k.map((x) => x.l)), hi = (k) => Math.max(...k.map((x) => x.h));
  const ext = [
    [lo(old), 2, `мин. ${period(old.length)}`], [hi(old), 2, `макс. ${period(old.length)}`],
    ...(old.length > 150 ? [[lo(old.slice(-120)), 1.5, "мин. 4 мес."], [hi(old.slice(-120)), 1.5, "макс. 4 мес."]] : []),
    [lo(old.slice(-30)), 1, "мин. 30 дней"], [hi(old.slice(-30)), 1, "макс. 30 дней"],
  ];
  return zones.map((z) => {
    const v = z.pts.reduce((a, p) => a + p.v, 0) / z.pts.length;
    const last = Math.max(...z.pts.map((p) => p.t));
    const tags = [`${z.pts.length} касан., посл. ${shortDate(last)}`];
    let score = z.score;
    for (const [e, bonus, name] of ext) if (Math.abs(e - v) <= tol) (score += bonus), tags.push(name);
    return { v, score, touches: z.pts.length, lastTouch: last, tags: tags.join(", ") };
  });
}

async function analyze(symbol) {
  const d = await klines(symbol, "1d", LEVEL_DAYS);
  const h4 = await klines(symbol, "4h", H4_CANDLES);
  const fr = await pub("/openApi/swap/v2/quote/premiumIndex", { symbol });
  const oi = await pub("/openApi/swap/v2/quote/openInterest", { symbol }).catch(() => null);
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
    ema20_4h: e20, ema50_4h: e50, ema200_4h: e200,
    vsEma200_4h: (p / e200 - 1) * 100,
    hi30, lo30, pos30: ((p - lo30) / (hi30 - lo30)) * 100,
    atr1dPct: (atr(d) / p) * 100, atr4h: atr(h4),
    oiUsd: Number(oi?.openInterest) || null, // open interest in USDT
    volRatio7to30: avgVol(-8, -1) / avgVol(-31, -1),
    fundingPct: Number(fr.lastFundingRate) * 100,
    // Market structure on 4h: nearest swing (2 days) for stops, 7-day extremes for targets.
    swingHi4h: Math.max(...h4.slice(-12).map((x) => x.h)),
    swingLo4h: Math.min(...h4.slice(-12).map((x) => x.l)),
    hi7d4h: Math.max(...h4.slice(-42).map((x) => x.h)),
    lo7d4h: Math.min(...h4.slice(-42).map((x) => x.l)),
    // Bounce setups: strong horizontal levels and the last day of 4h candles (6 candles, the last still forming).
    levels: findLevels(d, h4, 0.35 * atr(d)).filter((x) => x.score >= 3),
    lo1d4h: Math.min(...h4.slice(-6).map((x) => x.l)),
    hi1d4h: Math.max(...h4.slice(-6).map((x) => x.h)),
    close4h: c4.at(-2), // last closed 4h candle
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

// Open interest history (data/oi.json), kept 3 days: gives the 24h OI change for every coin.
{
  const now = Date.now(), hist = readJson("oi.json", {});
  for (const r of results) {
    if (r.error || !r.oiUsd) continue;
    const h = (hist[r.symbol] ?? []).filter((x) => now - x.t < 72 * 3600e3);
    const dayAgo = h.filter((x) => now - x.t >= 20 * 3600e3).at(-1);
    r.oiCh24h = dayAgo ? (r.oiUsd / dayAgo.v - 1) * 100 : null;
    h.push({ t: now, v: r.oiUsd });
    hist[r.symbol] = h;
  }
  if (args.includes("--send") || args.includes("--vk")) writeJson("oi.json", hist); // dry runs leave history alone
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

// Trade plan settings (override in .env).
const envNum = (name, def) => {
  const v = env(name);
  return v != null && v !== "" && Number.isFinite(+v) ? +v : def;
};
// Pullback to EMA20 4h: R:R from 1:MIN_RR_WEAK up to (not including) 1:MIN_RR. A higher R:R means the price
// already fell far from the 7-day extreme: in the backtest those were reversals, not pullbacks (the old
// "strong" list, 10% takes), so they are not sent. The watch list still wants at least 1:MIN_RR.
const MIN_RR = envNum("SCAN_MIN_RR", 2);
const MIN_RR_WEAK = envNum("SCAN_MIN_RR_WEAK", 1);
const MAX_TREND = 3;                               // keep the pullback list short
const REPEAT_H = 24;                               // same coin+direction within this many hours = repeat
const MAX_WATCH = 8;                               // watch list size
const MAX_WATCH_ATR = 3;                           // watch list: entry at most this many 4h ATRs away
const [RISK_MIN, RISK_MAX] = riskLevels();       // risk per trade, % of deposit (see src/env.js)
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

// Bounce from a strong level (works against the trend too): in the last day the price came to a strong
// horizontal level (see findLevels), the last closed 4h candle closed back on the right side of it,
// and the price has already moved away from the extreme. Entry now, stop behind the extreme of the touch,
// target at the nearest obstacle (EMA 4h or another level).
const BOUNCE_MIN_SCORE = envNum("SCAN_BOUNCE_MIN_SCORE", 4); // level strength, see findLevels
const BOUNCE_MIN_RR = envNum("SCAN_BOUNCE_MIN_RR", 1.5);
const BOUNCE_TOUCH_ATR = 0.5; // the day's extreme came at least this close to the level (4h ATRs)
const BOUNCE_PIERCE_ATR = 1;  // a wick through the level up to this deep still counts as a test
const BOUNCE_MIN_MOVE = 0.5;  // the price already moved this far off the extreme: the bounce has started
const BOUNCE_MAX_DIST = 1.5;  // ...but is no further than this from the level, or the market entry is late
const MAX_BOUNCE = 6;

// Filters from the backtest of Sep–Nov 2026 (every setup kind):
//   momentum: RSI 4h above 55 for a long, below 45 for a short — the move is already going the trade's way;
//   BTC: no alt long while BTC 4h trend is down, no short while it is up;
//   bounces only with the daily trend and only at the market (limit orders on a retest lost money);
//   an entry is valid ENTRY_VALID_H hours: a limit filled later mostly fills on a reversal.
const RSI_LONG_MIN = envNum("SCAN_RSI_LONG_MIN", 55);
const RSI_SHORT_MAX = envNum("SCAN_RSI_SHORT_MAX", 45);
const ENTRY_VALID_H = 4;
const momentumOk = (r, side) => (side === "long" ? r.rsi4h > RSI_LONG_MIN : r.rsi4h < RSI_SHORT_MAX);
const btcOk = (btc, side) => !btc || (side === "long" ? btc.trend4h !== "DN" : btc.trend4h !== "UP");

// Both sides can qualify at once (a range: long from support, short from resistance), so all are returned.
function bouncePlans(r) {
  if (r.atr1dPct > MAX_ATR_D || r.volRatio7to30 < MIN_VOL_RATIO || !r.levels?.length) return [];
  const a = r.atr4h, p = r.price;
  const plans = [];
  for (const side of ["long", "short"]) {
    const dir = side === "long" ? 1 : -1;
    if (side === "long" ? r.fundingPct > MAX_FUNDING : r.fundingPct < -MAX_FUNDING) continue;
    if (r.trend1d === (side === "long" ? "DN" : "UP")) continue; // against the daily trend
    if (!momentumOk(r, side)) continue;
    const ext = side === "long" ? r.lo1d4h : r.hi1d4h;
    // Nearest strong level under the price (long) / above it (short) that the day's extreme tested.
    const lvl = r.levels
      .filter((l) => l.score >= BOUNCE_MIN_SCORE && (p - l.v) * dir > 0)
      .sort((x, y) => (p - x.v) * dir - (p - y.v) * dir)
      .find((l) => (ext - l.v) * dir <= BOUNCE_TOUCH_ATR * a && (l.v - ext) * dir <= BOUNCE_PIERCE_ATR * a);
    if (!lvl) continue;
    if ((r.close4h - lvl.v) * dir <= 0) continue; // the 4h candle has not closed back beyond the level
    if ((p - ext) * dir < BOUNCE_MIN_MOVE * a) continue; // no bounce yet
    // Behind both the level and the wick of the test.
    const stop0 = (side === "long" ? Math.min(ext, lvl.v) : Math.max(ext, lvl.v)) - dir * STOP_BUFFER_ATR * a;
    const plan = (entry) => {
      let stop = stop0;
      if (Math.abs(entry - stop) < MIN_STOP_ATR * a) stop = entry - dir * MIN_STOP_ATR * a;
      const risk = Math.abs(entry - stop);
      // The first obstacle ahead is the target: an EMA 4h or any level at least 1 ATR away.
      const ahead = [[r.ema20_4h, "EMA20 4ч"], [r.ema50_4h, "EMA50 4ч"], [r.ema200_4h, "EMA200 4ч"], ...r.levels.map((l) => [l.v, "уровень"])]
        .filter(([v]) => (v - entry) * dir >= a)
        .sort((x, y) => (x[0] - entry) * dir - (y[0] - entry) * dir)[0];
      const [target, tpBy] = ahead ?? [entry + dir * ATR_TARGET * a, "ATR"];
      const rr = Math.abs(target - entry) / risk;
      return {
        side, entry, stop, target, tpBy, rr, dist: (p - entry) * dir / a, stopPct: (risk / entry) * 100,
        level: lvl.v, levelTags: lvl.tags, levelScore: lvl.score,
      };
    };
    // Entry at the market, only while the price is still near the level.
    if ((p - lvl.v) * dir > BOUNCE_MAX_DIST * a) continue;
    const now = plan(p);
    if (now.rr < BOUNCE_MIN_RR) continue;
    plans.push(now);
  }
  return plans.sort((x, y) => y.levelScore - x.levelScore);
}

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
  if (!momentumOk(r, side)) return null;
  const lv = levels(r, side);
  return lv.rr < MIN_RR_WEAK || lv.rr >= MIN_RR ? null : lv;
}

// Entry / stop / target for a side, without any filters.
function levels(r, side) {
  const long = side === "long", dir = long ? 1 : -1, a = r.atr4h, entry = r.ema20_4h;
  const swing = long ? Math.min(r.swingLo4h, entry) : Math.max(r.swingHi4h, entry);
  let stop = swing - dir * STOP_BUFFER_ATR * a;
  if (Math.abs(entry - stop) < MIN_STOP_ATR * a) stop = entry - dir * MIN_STOP_ATR * a;
  let target = long ? r.hi7d4h : r.lo7d4h, tpBy = "структура";
  if ((target - entry) * dir < 1.5 * a) { target = entry + dir * ATR_TARGET * a; tpBy = "ATR"; }
  const risk = Math.abs(entry - stop), rr = Math.abs(target - entry) / risk;
  const dist = (long ? r.price - entry : entry - r.price) / a;
  return { side, entry, stop, target, tpBy, rr, dist, stopPct: (risk / entry) * 100 };
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
// BTC for the 4h trend filter: from this scan, or analysed on its own when it is not in the list.
let btcPromise;
const btcResult = () => (btcPromise ??= Promise.resolve(results.find((r) => r.symbol === "BTC" && !r.error) ?? safe(analyze("BTC-USDT"))));
const compactUsd = (x) =>
  x >= 1e6 ? `${(x / 1e6).toFixed(1)} млн $` : x >= 1e3 ? `${(x / 1e3).toFixed(0)} тыс $` : `${x.toFixed(0)} $`;

// held: coins with an open position or a pending entry order — no new signals for them.
async function vkSummary(results, deposit, held = new Set()) {
  const DEPOSIT = deposit?.amount ?? 0;
  const ok = results.filter((r) => !r.error);
  const num = (x) => String(+x.toPrecision(5));
  // Whole dollars for big sums, cents for small ones (a small deposit would otherwise show "−0 $").
  const usd = (x) => x.toLocaleString("ru-RU", { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 });
  const ts = new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
  // Fetched on every run, even with no setups: dominance history for the 24h change builds up from these.
  const [btcd, events] = await Promise.all([safe(btcDominance()), safe(todayEvents({ upcomingOnly: true }))]);
  const btc = await btcResult();
  const regime = altRegime(btcd?.change24h, btc?.ch1d);
  const free = (x) => x.t && btcOk(btc, x.t.side) && !held.has(x.r.symbol);

  const all = ok
    .map((r) => ({ r, t: tradePlan(r) }))
    .filter(free)
    .map((x) => ({ ...x, mkt: regimeTag(regime, x.r.symbol, x.t.side) }))
    .sort((a, b) => b.t.rr - a.t.rr);
  const trend = all.slice(0, MAX_TREND);
  // Bounces from strong levels (with the daily trend): a section of its own, every coin is checked,
  // also those already in the trend lists above.
  const taken = new Set(all.map((x) => x.r.symbol));
  const bounce = ok
    .flatMap((r) => bouncePlans(r).map((t) => ({ r, t })))
    .filter(free)
    .map((x) => ({ ...x, mkt: regimeTag(regime, x.r.symbol, x.t.side) }))
    .sort((a, b) => b.t.levelScore - a.t.levelScore)
    .slice(0, MAX_BOUNCE);
  for (const x of bounce) taken.add(x.r.symbol);
  // Watch list: good setups whose entry is still far away — a limit order can wait there.
  const watch = ok
    .filter((r) => !taken.has(r.symbol))
    .map((r) => ({ r, t: watchPlan(r) }))
    .filter((x) => free(x) && regimeTag(regime, x.r.symbol, x.t.side) !== "against")
    .sort((a, b) => a.t.dist - b.t.dist)
    .slice(0, MAX_WATCH);
  if (!trend.length && !bounce.length) {
    // Only the watch list: send it when it changed since the last message, not every 2 hours.
    const key = watch.map((x) => `${x.r.symbol}:${x.t.side}`).sort().join(",");
    if (!watch.length || key === readJson("watch-last.json", {}).key) return null;
  }

  const lines = [`📊 Скан BingX — ${ts} (${TZ_LABEL})`];
  if (DEPOSIT) lines.push(`💼 Депозит: ${usd(DEPOSIT)} $${deposit.source === ".env" ? " (из настроек)" : ""}`);
  if (btcd) {
    const ch = btcd.change24h == null ? "" : ` (${btcd.change24h >= 0 ? "+" : ""}${btcd.change24h.toFixed(2)} за сутки)`;
    lines.push(`₿ Доминация BTC: ${btcd.value.toFixed(1)}%${ch}`);
  }
  if (regime === "alts-weak") lines.push("📉 Доминация растёт, BTC падает → альты слабее: лонги по альтам понижены");
  if (regime === "alts-strong") lines.push("📈 Доминация падает, BTC растёт → альты сильнее: шорты по альтам понижены");
  if (events?.length) lines.push(`📅 Сегодня: ${events.map((e) => `${e.time} ${e.title}`).join("; ")}`);
  if (held.size) lines.push(`📂 Уже в работе: ${[...held].join(", ")} — сигналы по ним не шлются`);
  const until = new Date(Date.now() + ENTRY_VALID_H * 3600e3).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  lines.push(`⏱ Вход действует ${ENTRY_VALID_H} ч, до ${until}: не исполнился — сигнал отменяется`);

  // Repeat: the same coin and direction was already sent in the last 24h. Still shown, just marked.
  const now = Date.now();
  const recent = readSignals().filter((s) => !s.manual && now - s.ts < REPEAT_H * 3600e3);
  const kind = (i) => (i < trend.length ? "trend" : i < trend.length + bounce.length ? "bounce" : "watch");
  const items = [...trend, ...bounce, ...watch];
  const signals = items.map(({ r, t }, i) => ({
    id: `${now.toString(36)}${i}`,
    ts: now,
    symbol: r.symbol,
    side: t.side,
    entry: t.entry,
    stop: t.stop,
    target: t.target,
    rr: +t.rr.toFixed(2),
    stopPct: t.stopPct,
    validH: ENTRY_VALID_H,
    strong: false, // the "strong" list is gone; old signals in the log still have it
    ...(kind(i) === "watch" ? { watch: true } : {}),
    ...(kind(i) === "bounce" ? { bounce: true, level: t.level } : {}),
    // Bounce and trend signals are different ideas: a repeat only within the same kind.
    repeat: recent.some((s) => s.symbol === r.symbol && s.side === t.side && !!s.bounce === (kind(i) === "bounce")),
  }));
  const sig = new Map(items.map((x, i) => [x, signals[i]])); // by list item: a coin may be in two lists

  const liqSyms = [...new Set([...trend, ...bounce].map(({ r }) => r.symbol))];
  const liqList = await Promise.all(liqSyms.map((s) => safe(okxLiquidations(s))));
  const liqs = new Map(liqSyms.map((s, i) => [s, liqList[i]]));
  const section = (title, items) => {
    if (!items.length) return;
    lines.push("", `${title} — ${items.length}`);
    for (const x of items) addPlan(x);
  };
  const addPlan = (item) => {
    const { r, t, mkt } = item;
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
        (mkt === "with" ? " · по рынку" : mkt === "against" ? " · против рынка" : "") +
        (sig.get(item)?.repeat ? " · 🔁 повтор" : ""),
      ...(t.level ? [`📍 Уровень ${num(t.level)} (${t.levelTags}) · тейк: ${t.tpBy}`] : []),
      `▶️ Вход: ${num(t.entry)}${t.level ? " (по рынку)" : ""}`,
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
    if (r.oiUsd) {
      const ch = r.oiCh24h == null ? "" : ` (${r.oiCh24h >= 0 ? "+" : ""}${r.oiCh24h.toFixed(1)}% за сутки)`;
      lines.push(`📈 Открытый интерес: ${compactUsd(r.oiUsd)}${ch}`);
    }
  };
  section(`📉 ОТКАТ К EMA20 4Ч: R:R 1:${MIN_RR_WEAK}–1:${MIN_RR}`, trend);
  section("↩️ ОТСКОК ОТ СИЛЬНОГО УРОВНЯ", bounce);
  if (watch.length) {
    lines.push("", "━━━━━━━━━━━━", `⏳ ЖДЁМ ОТСКОКА К ВХОДУ — ${watch.length}`, `Лимит можно выставить заранее, срок ${ENTRY_VALID_H} ч:`, "");
    for (const item of watch) {
      const { r, t } = item;
      const to = (t.entry / r.price - 1) * 100;
      lines.push(
        `${t.side === "long" ? "🟢" : "🔴"} ${r.symbol}: вход ${num(t.entry)} (${to >= 0 ? "+" : "−"}${Math.abs(to).toFixed(1)}%) · R:R 1:${t.rr.toFixed(1)}` +
          (sig.get(item)?.repeat ? " · 🔁" : ""),
        `     ⛔ ${num(t.stop)} · 🎯 ${num(t.target)}`,
      );
    }
  }
  // Telegram buttons: open a signal at the lower or upper risk (the bot asks to confirm first).
  const buttons = signals.map((s) => [
    { text: `${s.watch ? "⏳" : s.bounce ? (s.side === "long" ? "↩️🟢" : "↩️🔴") : s.side === "long" ? "🟢" : "🔴"} ${s.symbol} ${RISK_MIN}%`, callback_data: `open:${s.id}:${RISK_MIN}` },
    { text: `${s.symbol} ${RISK_MAX}%`, callback_data: `open:${s.id}:${RISK_MAX}` },
  ]);
  const watchKey = watch.map((x) => `${x.r.symbol}:${x.t.side}`).sort().join(",");
  return { text: lines.join("\n"), buttons, signals, watchKey };
}

// Watch list rule: the same trend setup as tradePlan, but the price is still MORE than READY_ATR
// from the entry (up to MAX_WATCH_ATR); the RSI 4h momentum filter applies here too.
function watchPlan(r) {
  const side = r.trend4h === "UP" && r.trend1d === "UP" ? "long" : r.trend4h === "DN" && r.trend1d === "DN" ? "short" : null;
  if (!side || r.atr1dPct > MAX_ATR_D || r.volRatio7to30 < MIN_VOL_RATIO) return null;
  if (side === "long" ? r.fundingPct > MAX_FUNDING : r.fundingPct < -MAX_FUNDING) return null;
  if (!momentumOk(r, side)) return null;
  const lv = levels(r, side);
  if (lv.dist <= READY_ATR || lv.dist > MAX_WATCH_ATR || lv.rr < MIN_RR) return null;
  return lv;
}

// --send (or the old --vk) sends to every configured messenger; --dry (--vk-dry) only prints.
// --coin: detailed analysis and forecast of the given coins, to Telegram only (asked from the bot).
const dry = args.includes("--dry") || args.includes("--vk-dry");
const send = args.includes("--send") || args.includes("--vk");
const coinMode = args.includes("--coin");
// Open positions and pending entry orders: no new signals for those coins, changes go as a message of their own.
const book = !coinMode && (dry || send) ? await fetchBook() : null;
const held = new Set(book ? [...book.positions.map((p) => p.symbol), ...book.orders.filter(isEntryOrder).map((o) => o.symbol)] : []);
const msg = !coinMode && (dry || send) ? await vkSummary(results, await fetchDeposit(), held) : null;
if (book) await positionUpdates(book);
if (coinMode) {
  await coinReports();
} else if ((dry || send) && !msg) {
  console.log(`\nNo setups with R:R >= 1:${MIN_RR_WEAK}, nothing sent.`);
} else if (dry) {
  console.log("\n--- message ---\n" + msg.text);
} else if (send) {
  // --show (/scan from the bot): the signals as a message with buttons, nothing is opened. They are logged
  // as manual, like /coin: otherwise the next cron scan would take them for repeats and not open them.
  // Otherwise, with auto-trading on, the signals are opened on BingX and only a report is sent.
  const show = args.includes("--show");
  // Signals are logged even while paused: the weekly statistics should see them.
  appendSignals(show ? msg.signals.map((x) => ({ ...x, manual: true })) : msg.signals);
  if (!show) writeJson("watch-last.json", { key: msg.watchKey });
  const auto = !show && autoTrading(!/^false$/i.test(env("SCAN_AUTO_TRADE") ?? "true"));
  if (isPaused()) console.log("\nPaused from Telegram, nothing sent.");
  else if (auto && book) await autoTrade(msg.signals);
  else {
    // Auto-trading without the account (no keys / BingX down) would not see open positions: signals instead.
    const note = auto ? "⚠️ Автоторговля не сработала: нет доступа к счёту BingX. Сигналы — для ручного входа.\n\n" : "";
    if (!(await sendSignal(note + msg.text, { tgButtons: msg.buttons }))) process.exitCode = 1;
  }
}

// ---------- auto-trading ----------

// Opens the new signals of this scan on BingX at the lower risk: a limit order at the entry with the stop
// and take attached, like the "open" button in Telegram. As in the backtest: repeats (same coin and
// direction within 24h) and coins already in work are skipped, one order per coin. Unfilled entries are
// cancelled by the bot when the signal's entry time runs out. Telegram gets a short report.
async function autoTrade(signals) {
  const ts = new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
  const hm = (t) => new Date(t).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const n = (x) => String(+Number(x).toPrecision(5));
  const lines = [];
  const done = new Set();
  for (const s of signals) {
    if (s.repeat || done.has(s.symbol) || held.has(s.symbol)) continue;
    done.add(s.symbol);
    const head = `${s.side === "long" ? "🟢" : "🔴"} ${s.symbol} ${s.side === "long" ? "лонг" : "шорт"}`;
    try {
      const p = await planOrder(s, RISK_MIN);
      const clientOrderId = `auto${s.id}`;
      await placeOrder(p, { clientOrderId });
      const expires = s.ts + s.validH * 3600e3;
      if (!p.immediate) addPendingOrder({ symbol: s.symbol, side: p.side, entry: p.entry, clientOrderId, expires });
      lines.push(
        `✅ ${head} · ${s.bounce ? "отскок" : s.watch ? "ожидание" : "откат"} · R:R 1:${s.rr}`,
        `     ${p.immediate ? "вход по рынку" : `лимит ${n(p.entry)} до ${hm(expires)}`} · стоп ${n(p.stop)} (−${p.loss.toFixed(2)} $) · тейк ${n(p.target)} (+${p.gain.toFixed(2)} $)`,
      );
    } catch (e) {
      lines.push(`⚠️ ${head}: не открыт — ${e.message}`);
    }
  }
  if (!lines.length) return console.log("\nAuto-trading: nothing new to open.");
  const text = [`🤖 Автоторговля — ${ts} (${TZ_LABEL}) · риск ${RISK_MIN}% на сделку`, "", ...lines, "", "/auto off — выключить · /pause — пауза"].join("\n");
  if (!(await sendSignal(text))) process.exitCode = 1;
}

// ---------- open positions ----------

// Positions and open orders from BingX; null without API keys or on an error (signals still go out).
async function fetchBook() {
  if (!env("BINGX_API_KEY") || !env("BINGX_SECRET_KEY")) return null;
  try {
    const [positions, orders] = await Promise.all([openPositions(), openOrders()]);
    return { positions, orders };
  } catch (e) {
    console.error(`BingX positions failed: ${e.message}`);
    return null;
  }
}

// Compares every open position with the previous scan (data/positions.json) and sends what changed:
// opened / closed, size, stop and take moved, the 4h or daily trend turning against the position (or back),
// the scanner seeing a setup the other way. Sent even while paused: it is about money already in the market.
// The first run only saves the state, so a deploy does not report every existing position as new.
async function positionUpdates({ positions, orders }) {
  const STATE = "positions.json";
  const prev = readJson(STATE, null);
  const num = (x) => String(+Number(x).toPrecision(5));
  const usd = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} $`;
  const sideRu = (s) => (s === "long" ? "лонг" : "шорт");
  const byResult = new Map(results.filter((r) => !r.error).map((r) => [r.symbol, r]));
  const now = {};
  for (const p of positions) {
    const dir = p.side === "long" ? 1 : -1;
    // Stop and take: closing stop / take-profit orders of this coin and side.
    const closing = orders.filter((o) => o.symbol === p.symbol && (o.positionSide === (p.side === "long" ? "LONG" : "SHORT") || o.positionSide === "BOTH") && o.side === (p.side === "long" ? "SELL" : "BUY"));
    const stop = closing.find((o) => /^STOP/.test(o.type))?.stopPrice || null;
    const take = closing.find((o) => /^TAKE_PROFIT/.test(o.type))?.stopPrice || null;
    const r = byResult.get(p.symbol) ?? (await safe(analyze(`${p.symbol}-USDT`)));
    const against = (t) => (t ? t === (dir > 0 ? "DN" : "UP") : null);
    const opp = p.side === "long" ? "short" : "long";
    const oppSetup = r
      ? (tradePlan(r)?.side === opp && "откат к EMA20") || (bouncePlans(r).some((b) => b.side === opp) && "отскок от уровня") || (watchPlan(r)?.side === opp && "в списке ожидания") || null
      : null;
    now[`${p.symbol}:${p.side}`] = {
      symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entry, pnl: p.pnl, stop, take,
      against4h: against(r?.trend4h), against1d: against(r?.trend1d), oppSetup, price: r?.price,
    };
  }

  const out = [];
  if (prev) {
    for (const [key, x] of Object.entries(now)) {
      const o = prev[key];
      const head = `${x.side === "long" ? "🟢" : "🔴"} ${x.symbol} ${sideRu(x.side)}`;
      if (!o) {
        out.push(`📂 ${head}: открыта позиция ${num(x.qty)} по ${num(x.entry)}` + `${x.stop ? ` · стоп ${num(x.stop)}` : " · ⚠️ без стопа"}${x.take ? ` · тейк ${num(x.take)}` : ""}`);
        continue;
      }
      const ch = [];
      if (Math.abs(x.qty - o.qty) > 1e-9 * Math.max(x.qty, o.qty)) ch.push(x.qty > o.qty ? `➕ объём увеличен: ${num(o.qty)} → ${num(x.qty)}, средняя ${num(x.entry)}` : `➖ частично закрыта: ${num(o.qty)} → ${num(x.qty)}`);
      if (x.stop !== o.stop) ch.push(x.stop ? `⛔ стоп ${o.stop ? `перенесён: ${num(o.stop)} → ` : "выставлен: "}${num(x.stop)}` : "⚠️ стоп снят — позиция без стопа");
      if (x.take !== o.take) ch.push(x.take ? `🎯 тейк ${o.take ? `перенесён: ${num(o.take)} → ` : "выставлен: "}${num(x.take)}` : "🎯 тейк снят");
      if (x.against4h != null && o.against4h != null && x.against4h !== o.against4h) ch.push(x.against4h ? "⚠️ тренд 4ч развернулся против позиции" : "✅ тренд 4ч больше не против позиции");
      if (x.against1d != null && o.against1d != null && x.against1d !== o.against1d) ch.push(x.against1d ? "⚠️ дневной тренд развернулся против позиции" : "✅ дневной тренд больше не против позиции");
      if (x.oppSetup && !o.oppSetup) ch.push(`🔄 сканер видит сетап в обратную сторону (${sideRu(x.side === "long" ? "short" : "long")}, ${x.oppSetup})`);
      if (ch.length) out.push(`${head} · вход ${num(x.entry)}${x.price ? ` · цена ${num(x.price)}` : ""} · PnL ${usd(x.pnl)}`, ...ch.map((c) => `     ${c}`));
    }
    for (const [key, o] of Object.entries(prev)) {
      if (now[key]) continue;
      out.push(`🏁 ${o.side === "long" ? "🟢" : "🔴"} ${o.symbol} ${sideRu(o.side)}: позиция закрыта (PnL на прошлой проверке ${usd(o.pnl)}). Итог — в /journal.`);
    }
  }
  if (!dry) writeJson(STATE, now);
  if (!out.length) return;
  const ts = new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
  const text = [`📂 Изменения по позициям — ${ts} (${TZ_LABEL})`, "", ...out].join("\n");
  if (dry) console.log(`\n--- positions ---\n${text}`);
  else if (!(await sendSignal(text))) process.exitCode = 1;
}

// ---------- /coin: analysis and forecast of one coin ----------

// Technical outlook for the next 1–2 days from the same indicators the scanner uses.
// Each factor adds to a score; the sum gives the bias. Levels come from EMAs and recent swings.
function forecast(r, regime) {
  let score = 0;
  const why = [];
  const add = (v, text) => ((score += v), why.push(text));
  if (r.trend1d === "UP") add(2, "дневной тренд вверх");
  if (r.trend1d === "DN") add(-2, "дневной тренд вниз");
  if (r.trend4h === "UP") add(1, "4-часовой тренд вверх");
  if (r.trend4h === "DN") add(-1, "4-часовой тренд вниз");
  if (r.vsEma200_4h > 0) add(1, `цена выше EMA200 (4ч) на ${r.vsEma200_4h.toFixed(1)}%`);
  else add(-1, `цена ниже EMA200 (4ч) на ${Math.abs(r.vsEma200_4h).toFixed(1)}%`);
  if (r.rsi1d < 30) add(1, `RSI 1д ${r.rsi1d.toFixed(0)} — перепроданность, возможен отскок`);
  if (r.rsi1d > 70) add(-1, `RSI 1д ${r.rsi1d.toFixed(0)} — перекупленность, возможен откат`);
  if (r.rsi4h < 30) add(0.5, `RSI 4ч ${r.rsi4h.toFixed(0)} — локальная перепроданность`);
  if (r.rsi4h > 70) add(-0.5, `RSI 4ч ${r.rsi4h.toFixed(0)} — локальная перекупленность`);
  if (r.fundingPct > MAX_FUNDING) add(-0.5, `фандинг ${r.fundingPct.toFixed(3)}% — перекос в лонги`);
  if (r.fundingPct < -MAX_FUNDING) add(0.5, `фандинг ${r.fundingPct.toFixed(3)}% — перекос в шорты, риск сквиза`);
  if (r.oiCh24h != null && Math.abs(r.oiCh24h) >= 3) {
    if (r.oiCh24h > 0 && r.ch1d > 0) add(1, `OI +${r.oiCh24h.toFixed(0)}% на росте — рост подтверждается новыми позициями`);
    if (r.oiCh24h > 0 && r.ch1d < 0) add(-1, `OI +${r.oiCh24h.toFixed(0)}% на падении — набираются шорты`);
    if (r.oiCh24h < 0 && r.ch1d > 0) why.push(`OI ${r.oiCh24h.toFixed(0)}% на росте — рост на закрытии шортов, слабый`);
    if (r.oiCh24h < 0 && r.ch1d < 0) why.push(`OI ${r.oiCh24h.toFixed(0)}% на падении — выходят лонги`);
  }
  if (r.symbol !== "BTC" && regime === "alts-weak") add(-1, "доминация BTC растёт при падении BTC — альты слабее");
  if (r.symbol !== "BTC" && regime === "alts-strong") add(1, "доминация BTC падает при росте BTC — альты сильнее");
  const bias = score >= 2 ? "up" : score <= -2 ? "down" : "flat";

  // Key levels around the price (merged when closer than 0.3%).
  const cand = [
    [r.ema20_4h, "EMA20 4ч"], [r.ema50_4h, "EMA50 4ч"], [r.ema200_4h, "EMA200 4ч"],
    [r.swingHi4h, "макс. 2 дней"], [r.swingLo4h, "мин. 2 дней"],
    [r.hi7d4h, "макс. 7 дней"], [r.lo7d4h, "мин. 7 дней"], [r.hi30, "макс. 30 дней"], [r.lo30, "мин. 30 дней"],
  ].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [v, n] of cand) {
    const prev = merged.at(-1);
    if (prev && Math.abs(v / prev.v - 1) < 0.003) prev.n += `, ${n}`;
    else merged.push({ v, n });
  }
  const res = merged.filter((x) => x.v > r.price * 1.001).slice(0, 2);
  const sup = merged.filter((x) => x.v < r.price * 0.999).reverse().slice(0, 2);
  return { score, bias, why, res, sup };
}

async function coinReports() {
  const ok = results.filter((r) => !r.error);
  for (const r of results.filter((x) => x.error)) console.error(`${r.symbol}: ${r.error}`);
  if (!ok.length) {
    process.exitCode = 1;
    return;
  }
  const [btcd, btc] = await Promise.all([safe(btcDominance()), btcResult()]);
  const regime = altRegime(btcd?.change24h, btc?.ch1d);
  const n = (x) => String(+x.toPrecision(5));
  const pct = (x) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`);
  const arrow = { UP: "⬆️", DN: "⬇️", MIX: "↔️" };
  const ts = new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });

  for (const r of ok) {
    const f = forecast(r, regime);
    const lq = await safe(okxLiquidations(r.symbol));
    const L = [
      `🔎 ${r.symbol} — анализ ${ts} (${TZ_LABEL})`,
      "",
      `💵 Цена: ${n(r.price)} · 24ч ${pct(r.ch1d)} · 7д ${pct(r.ch7d)} · 30д ${pct(r.ch30d)}`,
      `📊 Тренд: 4ч ${arrow[r.trend4h]} · 1д ${arrow[r.trend1d]} · RSI 4ч ${r.rsi4h.toFixed(0)} / 1д ${r.rsi1d.toFixed(0)}`,
      `〰️ EMA 4ч: 20 → ${n(r.ema20_4h)} · 50 → ${n(r.ema50_4h)} · 200 → ${n(r.ema200_4h)}`,
      `📏 ATR: ${r.atr1dPct.toFixed(1)}% в день · 30 дней: ${n(r.lo30)}–${n(r.hi30)} (цена на ${r.pos30.toFixed(0)}% диапазона)`,
      `💸 Фандинг: ${r.fundingPct.toFixed(4)}%` +
        (r.oiUsd ? ` · OI: ${compactUsd(r.oiUsd)}${r.oiCh24h == null ? "" : ` (${pct(r.oiCh24h)} за сутки)`}` : ""),
    ];
    if (lq && (lq.longs || lq.shorts)) L.push(`💥 Ликвидации OKX 24ч: лонги ${compactUsd(lq.longs)} · шорты ${compactUsd(lq.shorts)}`);

    const title = { up: "📈 Бычий", down: "📉 Медвежий", flat: "↔️ Нейтральный" }[f.bias];
    L.push("", "━━━━━━━━━━━━", `🧭 Прогноз на 1–2 дня: ${title} (оценка ${f.score > 0 ? "+" : ""}${f.score})`, "Почему:");
    for (const w of f.why) L.push(`• ${w}`);
    L.push("", "Уровни:");
    if (f.res.length) L.push(`⬆️ Сопротивление: ${f.res.map((x) => `${n(x.v)} (${x.n})`).join(" · ")}`);
    if (f.sup.length) L.push(`⬇️ Поддержка: ${f.sup.map((x) => `${n(x.v)} (${x.n})`).join(" · ")}`);
    const [r1, r2] = f.res, [s1, s2] = f.sup;
    L.push("", "Сценарии:");
    if (f.bias === "down") {
      if (s1) L.push(`▪️ Основной: ${r1 ? `возможен отскок к ${n(r1.v)}, затем ` : ""}снижение к ${n(s1.v)}${s2 ? `, дальше ${n(s2.v)}` : ""}`);
      if (r1) L.push(`▪️ Отмена: закрепление выше ${n((r2 ?? r1).v)}`);
    } else if (f.bias === "up") {
      if (r1) L.push(`▪️ Основной: ${s1 ? `возможен откат к ${n(s1.v)}, затем ` : ""}рост к ${n(r1.v)}${r2 ? `, дальше ${n(r2.v)}` : ""}`);
      if (s1) L.push(`▪️ Отмена: закрепление ниже ${n((s2 ?? s1).v)}`);
    } else {
      if (s1 && r1) L.push(`▪️ Боковик между ${n(s1.v)} и ${n(r1.v)}`);
      if (r2) L.push(`▪️ Пробой вверх → ${n(r2.v)}`);
      if (s2) L.push(`▪️ Пробой вниз → ${n(s2.v)}`);
    }
    const day = (r.price * r.atr1dPct) / 100;
    L.push(`📐 Обычный размах за сутки: ${n(r.price - day)}–${n(r.price + day)}`);

    // Setup by the scanner's rules: ready now, or what is missing.
    let buttons;
    const side = r.trend4h === "UP" ? "long" : r.trend4h === "DN" ? "short" : null;
    L.push("", "━━━━━━━━━━━━");
    if (!side) {
      L.push("🎯 Сетап: нет — на 4ч нет тренда, вход от EMA20 не работает.");
    } else {
      const ready = btcOk(btc, side) ? tradePlan(r) : null;
      const p = ready ?? levels(r, side);
      L.push(
        `🎯 Сетап: ${side === "long" ? "🟢 ЛОНГ" : "🔴 ШОРТ"} от EMA20 4ч · R:R 1:${p.rr.toFixed(1)}`,
        `▶️ Вход: ${n(p.entry)} · ⛔ Стоп: ${n(p.stop)} · 🎯 Тейк: ${n(p.target)}`,
      );
      const notes = [];
      if (r.trend1d !== (side === "long" ? "UP" : "DN")) notes.push("дневной тренд не подтверждает");
      if (p.dist < 0) notes.push("цена уже прошла вход");
      else if (p.dist > READY_ATR) notes.push(`до входа ${Math.abs((p.entry / r.price - 1) * 100).toFixed(1)}%, цена пока далеко`);
      if (side === "short" && r.rsi4h < 35) notes.push("перепроданность — лучше дождаться отскока");
      if (side === "long" && r.rsi4h > 65) notes.push("перекупленность — лучше дождаться отката");
      if (!momentumOk(r, side)) notes.push(`нет импульса: RSI 4ч ${r.rsi4h.toFixed(0)}, нужно ${side === "long" ? `выше ${RSI_LONG_MIN}` : `ниже ${RSI_SHORT_MAX}`}`);
      if (!btcOk(btc, side)) notes.push("против тренда BTC на 4ч");
      if (p.rr < MIN_RR_WEAK) notes.push("R:R меньше 1:1");
      if (p.rr >= MIN_RR) notes.push(`R:R от 1:${MIN_RR} — откат слишком глубокий, по бэктесту чаще разворот`);
      L.push(ready ? "✅ Готов по правилам сканера" : `⏳ Пока не готов: ${notes.join("; ") || "не прошёл фильтры сканера"}`);
      // Buttons only when the plan makes sense now: price before the entry and R:R at least 1:1.
      if (p.dist >= 0 && p.rr >= MIN_RR_WEAK && p.rr < MIN_RR) {
        const s = {
          id: `${Date.now().toString(36)}c`, ts: Date.now(), symbol: r.symbol, side, entry: p.entry, stop: p.stop,
          target: p.target, rr: +p.rr.toFixed(2), stopPct: p.stopPct, validH: ENTRY_VALID_H, strong: false, repeat: false, manual: true,
        };
        if (!dry) appendSignals([s]);
        buttons = [[RISK_MIN, RISK_MAX].map((k) => ({ text: `${side === "long" ? "🟢" : "🔴"} ${r.symbol} ${k}%`, callback_data: `open:${s.id}:${k}` }))];
      }
    }
    // Bounce from a strong level, the scanner's second setup.
    for (const [j, b] of bouncePlans(r).filter((b) => btcOk(btc, b.side)).entries()) {
      L.push(
        "",
        `↩️ Отскок от уровня ${n(b.level)} (${b.levelTags}): ${b.side === "long" ? "🟢 ЛОНГ" : "🔴 ШОРТ"} · R:R 1:${b.rr.toFixed(1)}`,
        `▶️ Вход: ${n(b.entry)} (по рынку) · ⛔ Стоп: ${n(b.stop)} · 🎯 Тейк: ${n(b.target)} (${b.tpBy})`,
      );
      const s = {
        id: `${Date.now().toString(36)}b${j}`, ts: Date.now(), symbol: r.symbol, side: b.side, entry: b.entry, stop: b.stop,
        target: b.target, rr: +b.rr.toFixed(2), stopPct: b.stopPct, validH: ENTRY_VALID_H, strong: false, bounce: true, level: b.level, repeat: false, manual: true,
      };
      if (!dry) appendSignals([s]);
      buttons = [...(buttons ?? []), [RISK_MIN, RISK_MAX].map((k) => ({ text: `↩️${b.side === "long" ? "🟢" : "🔴"} ${r.symbol} ${k}%`, callback_data: `open:${s.id}:${k}` }))];
    }
    L.push("", "ℹ️ Расчёт по индикаторам, а не гарантия движения.");
    const text = L.join("\n");
    if (dry) console.log(`\n${text}`);
    else await sendTg(text, undefined, buttons).catch((e) => ((process.exitCode = 1), console.error(`Telegram: ${e.message}`)));
  }
}
