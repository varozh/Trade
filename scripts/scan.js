// Market scanner for BingX USDT-M perpetuals: trend, RSI, ATR, funding and 30-day range per symbol.
// Public data only, no API keys needed.
//
// Usage:
//   npm run scan                      – scan the default watchlist (WATCHLIST below)
//   npm run scan -- BTC ETH SOL       – scan given symbols
//   npm run scan -- --json            – raw JSON instead of a table
import { BingXClient } from "../src/bingx.js";

// Favorites from the BingX account (edit as needed).
const WATCHLIST = `BTC ETH SOL ZEC XRP 1000PEPE HYPE AVAX AAVE ARB BNB SUI LINK ENA DOGE UNI TAO ADA ASTER
PUMP ZRO APT TIA OP ETHFI FARTCOIN DASH TRX WIF PENGU STRK LDO USELESS AERO XPL SPX WLFI 1000BONK ZK
MORPHO MYX ARC MNT FLOKI RATS ANSEM`;

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const userSyms = args.filter((a) => !a.startsWith("--"));
const symbols = (userSyms.length ? userSyms : WATCHLIST.split(/\s+/).filter(Boolean)).map((s) => {
  const x = s.toUpperCase().replace(/[/_]/g, "-");
  return x.includes("-") ? x : `${x.replace(/USDT$/, "")}-USDT`;
});

// Market data always comes from the live API (demo has its own, thinner prices).
const client = new BingXClient({ demo: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pub(path, params, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await client.get(path, params, { signed: false });
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1000 * (i + 1)); // rate limit: back off and retry
    }
  }
}

const klines = async (symbol, interval, limit) =>
  (await pub("/openApi/swap/v3/quote/klines", { symbol, interval, limit }))
    .map((k) => ({ t: +k.time, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }))
    .sort((a, b) => a.t - b.t);

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
