// Extra market context for the scanner: BTC dominance, US macro events, recent liquidations.
// All sources are public and need no keys:
//   BTC dominance  – CoinGecko /global
//   macro calendar – Forex Factory weekly JSON (high-impact USD events: FOMC, CPI, NFP, …)
//   liquidations   – OKX public liquidation orders (positions already liquidated, not a forecast)
import { readFileSync, writeFileSync } from "node:fs";

const STATE_FILE = new URL("../.scan-state.json", import.meta.url);
const UA = { "User-Agent": "Mozilla/5.0 (bingx-scanner)" };

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveState(s) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {
    /* state is a cache only */
  }
}

async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---------- BTC dominance ----------

// Current BTC dominance and its change over ~24h (from values saved by previous runs).
export async function btcDominance() {
  const g = await getJson("https://api.coingecko.com/api/v3/global");
  const now = Date.now(), value = g.data.market_cap_percentage.btc;
  const state = loadState();
  const hist = (state.btcd ?? []).filter((h) => now - h.t < 48 * 3600e3);
  const dayAgo = hist.filter((h) => now - h.t >= 20 * 3600e3).at(-1); // oldest-enough sample
  hist.push({ t: now, v: value });
  saveState({ ...state, btcd: hist });
  return { value, change24h: dayAgo ? value - dayAgo.v : null };
}

// ---------- Macro calendar ----------

const MSK = "Europe/Moscow";
const dayKey = (d) => d.toLocaleDateString("sv-SE", { timeZone: MSK }); // YYYY-MM-DD in Moscow time

// Russian names for the usual market movers; anything else keeps its original title.
const EVENT_RU = [
  [/FOMC Meeting Minutes/i, "Протокол заседания ФРС (FOMC)"],
  [/FOMC Statement|Federal Funds Rate/i, "Решение ФРС по ставке (FOMC)"],
  [/FOMC Press Conference/i, "Пресс-конференция ФРС (FOMC)"],
  [/FOMC Member|FOMC/i, "ФРС (FOMC)"],
  [/Fed Chair.*Speaks/i, "Выступление главы ФРС"],
  [/Core CPI/i, "Базовая инфляция CPI"],
  [/CPI/i, "Инфляция CPI"],
  [/Core PPI/i, "Базовые цены производителей PPI"],
  [/PPI/i, "Цены производителей PPI"],
  [/Core PCE/i, "Базовая инфляция PCE"],
  [/PCE/i, "Инфляция PCE"],
  [/Non-Farm/i, "Занятость вне с/х (NFP)"],
  [/Unemployment Rate/i, "Уровень безработицы"],
  [/Unemployment Claims/i, "Заявки на пособие по безработице"],
  [/Core Retail Sales/i, "Базовые розничные продажи"],
  [/Retail Sales/i, "Розничные продажи"],
  [/GDP/i, "ВВП"],
  [/ISM Manufacturing PMI/i, "Деловая активность ISM (производство)"],
  [/ISM Services PMI/i, "Деловая активность ISM (услуги)"],
  [/JOLTS/i, "Вакансии JOLTS"],
  [/Consumer Sentiment/i, "Потребительские настроения"],
];
const ruTitle = (t) => EVENT_RU.find(([re]) => re.test(t))?.[1] ?? t;

// High-impact USD events of the current week; cached for 6h (Forex Factory asks not to hammer it).
async function weekEvents() {
  const state = loadState();
  if (state.ff && Date.now() - state.ff.t < 6 * 3600e3) return state.ff.events;
  let all;
  try {
    all = await getJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
  } catch (e) {
    // Rate limited or down: an older copy of this week's calendar is still good.
    if (state.ff && Date.now() - state.ff.t < 3 * 24 * 3600e3) return state.ff.events;
    throw e;
  }
  const events = all
    .filter((e) => e.country === "USD" && e.impact === "High")
    .map((e) => ({ title: e.title, date: e.date, forecast: e.forecast, previous: e.previous }));
  saveState({ ...loadState(), ff: { t: Date.now(), events } });
  return events;
}

// Today's (Moscow date) high-impact USD events, time in MSK. upcomingOnly drops those already past.
export async function todayEvents({ upcomingOnly = false } = {}) {
  const now = new Date(), today = dayKey(now);
  return (await weekEvents())
    .map((e) => ({ ...e, at: new Date(e.date) }))
    .filter((e) => dayKey(e.at) === today && (!upcomingOnly || e.at > now))
    .sort((a, b) => a.at - b.at)
    .map((e) => ({
      time: e.at.toLocaleTimeString("ru-RU", { timeZone: MSK, hour: "2-digit", minute: "2-digit" }),
      title: ruTitle(e.title),
      forecast: e.forecast,
      previous: e.previous,
    }));
}

// ---------- Liquidations (OKX) ----------

let ctValCache = null;
async function ctVal(instId) {
  if (!ctValCache) {
    const r = await getJson("https://www.okx.com/api/v5/public/instruments?instType=SWAP");
    ctValCache = new Map(r.data.map((i) => [i.instId, Number(i.ctVal)]));
  }
  return ctValCache.get(instId);
}

// Liquidations on OKX over the last `hours` (latest 100 orders at most) for a coin like "BTC".
// Returns USD totals for liquidated longs and shorts and the price zone with the most volume.
export async function okxLiquidations(symbol, hours = 24) {
  const coin = symbol.replace(/^1000/, ""); // OKX has PEPE-USDT, not 1000PEPE-USDT
  const instId = `${coin}-USDT-SWAP`;
  const cv = await ctVal(instId);
  if (!cv) return null; // not listed on OKX
  const r = await getJson(`https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${coin}-USDT&state=filled&limit=100`);
  const since = Date.now() - hours * 3600e3;
  const rows = (r.data?.[0]?.details ?? [])
    .filter((d) => +d.ts >= since)
    .map((d) => ({ side: d.posSide, px: +d.bkPx, usd: +d.sz * cv * +d.bkPx }));
  if (!rows.length) return { longs: 0, shorts: 0, zone: null };
  const sum = (side) => rows.filter((x) => x.side === side).reduce((a, x) => a + x.usd, 0);
  // Zone: group into ~0.5% price bins and take the heaviest one.
  const mid = rows.reduce((a, x) => a + x.px, 0) / rows.length, step = mid * 0.005;
  const bins = new Map();
  for (const x of rows) {
    const k = Math.floor(x.px / step);
    const b = bins.get(k) ?? { usd: 0, long: 0, lo: Infinity, hi: 0 };
    b.usd += x.usd;
    if (x.side === "long") b.long += x.usd;
    b.lo = Math.min(b.lo, x.px);
    b.hi = Math.max(b.hi, x.px);
    bins.set(k, b);
  }
  const top = [...bins.values()].sort((a, b) => b.usd - a.usd)[0];
  return {
    longs: sum("long"),
    shorts: sum("short"),
    zone: { lo: top.lo, hi: top.hi, usd: top.usd, side: top.long >= top.usd / 2 ? "long" : "short" },
  };
}
