// Real-time alerts for the watchlist, meant to run every 30 minutes from cron.
// Looks at the last 30 minutes (two 15m candles) of every coin and reports:
//   ⚡ sharp move      – the 30-min change is several times bigger than usual for this coin
//   📈/📉 breakout     – price closed beyond the 2-day (or 30-day) high/low it was inside 30 min ago
//   📊 volume spike    – 30-min turnover is several times the usual
// Nothing is sent when nothing happened. The same alert for a coin is not repeated for REPEAT_H hours.
//
//   node --env-file=.env scripts/alerts.js            – check and send
//   node --env-file=.env scripts/alerts.js --dry      – print only, nothing saved or sent
//   node --env-file=.env scripts/alerts.js SOL HYPE   – only these coins
import { readFileSync, writeFileSync } from "node:fs";
import { toSymbols, klines, sleep } from "../src/quotes.js";
import { sendAll } from "../src/notify.js";
import { env } from "../src/env.js";
import { TZ, TZ_LABEL } from "../src/market.js";
import { isPaused } from "../src/store.js";

const num = (name, def) => {
  const v = env(name);
  return v != null && v !== "" && Number.isFinite(+v) ? +v : def;
};
const MOVE_X = num("ALERT_MOVE_X", 3);             // move ≥ this × the coin's usual 30-min move…
const MOVE_MIN = num("ALERT_MOVE_MIN_PCT", 2);     // …and at least this many %
const VOL_X = num("ALERT_VOLUME_X", 4);            // turnover ≥ this × usual 30-min turnover…
const VOL_MIN = num("ALERT_VOLUME_MIN_USD", 300e3); // …and at least this many $ (skips dead coins)
const REPEAT_H = num("ALERT_REPEAT_HOURS", 2);     // do not repeat the same alert sooner than this

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const symbols = toSymbols(args.filter((a) => !a.startsWith("--")));

const STATE_FILE = new URL("../.alerts-state.json", import.meta.url);
const loadState = () => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const fmt = (x) => String(+x.toPrecision(5));
const pct = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`;
const money = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)} млн $` : `${(x / 1e3).toFixed(0)} тыс $`);

async function check(symbol) {
  // ~2 days of 15m candles. The last candle is still forming, so "now" is its current close.
  const m15 = await klines(symbol, "15m", 200);
  const d1 = await klines(symbol, "1d", 31);
  if (m15.length < 50) return [];
  const last = m15.at(-1), price = last.c;
  const before = m15.at(-3).c; // close 30 minutes ago
  const hist = m15.slice(0, -2); // everything before the last 30 minutes
  const found = [];

  // ⚡ Sharp move: compare with the median 30-min move over the last 2 days.
  const moves = [];
  for (let i = 2; i < hist.length; i++) moves.push(Math.abs(hist[i].c / hist[i - 2].c - 1) * 100);
  const usualMove = median(moves);
  const move = (price / before - 1) * 100;
  if (Math.abs(move) >= Math.max(MOVE_MIN, MOVE_X * usualMove)) {
    found.push({
      key: `move${move > 0 ? "up" : "dn"}`,
      text: `⚡ резкое движение ${pct(move)} за 30 мин (обычно ±${usualMove.toFixed(1)}%)`,
    });
  }

  // 📈/📉 Breakout: was inside the range 30 min ago, now beyond it. 30-day levels beat 2-day ones.
  const hi2d = Math.max(...hist.map((x) => x.h)), lo2d = Math.min(...hist.map((x) => x.l));
  const past30 = d1.slice(0, -1); // completed days
  const hi30 = Math.max(...past30.map((x) => x.h)), lo30 = Math.min(...past30.map((x) => x.l));
  if (price > hi2d && before <= hi2d) {
    const big = price > hi30 && before <= hi30;
    found.push({ key: "breakup", text: `📈 пробой максимума ${big ? "30 дней" : "2 дней"} ${fmt(big ? hi30 : hi2d)}` });
  } else if (price < lo2d && before >= lo2d) {
    const big = price < lo30 && before >= lo30;
    found.push({ key: "breakdn", text: `📉 пробой минимума ${big ? "30 дней" : "2 дней"} ${fmt(big ? lo30 : lo2d)}` });
  }

  // 📊 Volume spike: the last 30 min against the median 30 min of the last 2 days (in $).
  const usd = (k) => k.v * k.c;
  const vols = [];
  for (let i = 1; i < hist.length; i += 2) vols.push(usd(hist[i]) + usd(hist[i - 1]));
  const usualVol = median(vols);
  // The forming candle is partial: scale it to a full 15 minutes so early runs are not underestimated.
  const elapsed = Math.min(1, Math.max(0.2, (Date.now() - last.t) / 900e3));
  const vol = usd(m15.at(-2)) + usd(last) / elapsed;
  if (usualVol > 0 && vol >= VOL_X * usualVol && vol >= VOL_MIN) {
    found.push({ key: "vol", text: `📊 всплеск объёма ×${(vol / usualVol).toFixed(1)} за 30 мин (${money(vol)})` });
  }

  return found.map((f) => ({ ...f, symbol: symbol.replace("-USDT", ""), price, move }));
}

const alerts = [];
for (const s of symbols) {
  try {
    alerts.push(...(await check(s)));
  } catch (e) {
    console.error(`${s}: ${e.message}`);
  }
  await sleep(150);
}

// Drop alerts already sent recently; remember the new ones.
const now = Date.now(), state = loadState();
for (const k of Object.keys(state)) if (now - state[k] > 24 * 3600e3) delete state[k];
const fresh = alerts.filter((a) => !(now - (state[`${a.symbol}:${a.key}`] ?? 0) < REPEAT_H * 3600e3));

if (isPaused()) {
  console.log(`${new Date().toISOString()} paused from Telegram, nothing sent.`);
  process.exit(0);
}
if (!fresh.length) {
  console.log(`${new Date().toISOString()} ${alerts.length ? "only repeated alerts" : "no alerts"}, nothing sent.`);
  process.exit(0);
}

// One block per coin, biggest movers first.
const byCoin = new Map();
for (const a of fresh) byCoin.set(a.symbol, [...(byCoin.get(a.symbol) ?? []), a]);
const coins = [...byCoin.entries()].sort((a, b) => Math.abs(b[1][0].move) - Math.abs(a[1][0].move));
const ts = new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
const lines = [`🚨 Алерты BingX — ${ts} (${TZ_LABEL})`];
for (const [sym, list] of coins) {
  lines.push("", `▪️ ${sym}: ${fmt(list[0].price)} (${pct(list[0].move)} за 30 мин)`);
  for (const a of list) lines.push(`     ${a.text}`);
}
const text = lines.join("\n");

if (dry) {
  console.log(text);
} else if (await sendAll(text)) {
  for (const a of fresh) state[`${a.symbol}:${a.key}`] = now;
  writeFileSync(STATE_FILE, JSON.stringify(state));
} else {
  process.exitCode = 1;
}
