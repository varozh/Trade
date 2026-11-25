// Real-time alerts for the watchlist, meant to run every 30 minutes from cron.
// Looks at the last 30 minutes (two 15m candles) of every coin and reports:
//   ⚡ sharp move      – the 30-min change is several times bigger than usual for this coin
//   📈/📉 breakout     – price went clearly beyond the 30-day high/low it was inside 30 min ago
//   📊 volume spike    – 30-min turnover is several times the usual AND the price actually moved
// Noise control:
//   - a coin is quiet for REPEAT_H hours after any alert, unless the move has since grown ESCALATE_X times;
//   - when many coins move the same way at once (whole market), one short market block is sent instead;
//   - at most MAX_COINS coins per message.
// Nothing is sent when nothing happened.
//
//   node --env-file=.env scripts/alerts.js            – check and send
//   node --env-file=.env scripts/alerts.js --dry      – print only, nothing saved or sent
//   node --env-file=.env scripts/alerts.js SOL HYPE   – only these coins
import { readFileSync, writeFileSync } from "node:fs";
import { toSymbols, klines, sleep } from "../src/quotes.js";
import { sendInfo } from "../src/notify.js";
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
const BREAK_MARGIN = num("ALERT_BREAK_MARGIN_PCT", 0.5); // breakout must clear the level by this many %
const BREAK_MOVE = num("ALERT_BREAK_MOVE_PCT", 1);  // …with at least this 30-min move
const VOL_MOVE = num("ALERT_VOLUME_MOVE_PCT", 1.5); // volume spike counts only with at least this move
const REPEAT_H = num("ALERT_REPEAT_HOURS", 4);     // a coin stays quiet this long after an alert…
const ESCALATE_X = num("ALERT_ESCALATE_X", 2);     // …unless its move grew this many times since
const MARKET_N = num("ALERT_MARKET_COINS", 6);     // this many coins moving one way = market move
const MAX_COINS = num("ALERT_MAX_COINS", 6);       // coins per message at most

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
const coinsRu = (n) => {
  const d = n % 10, dd = n % 100;
  return `${n} ${d === 1 && dd !== 11 ? "монета" : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? "монеты" : "монет"}`;
};
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

  // 📈/📉 Breakout of the 30-day range: was inside it 30 min ago, now clearly beyond, with a real move.
  // (2-day highs/lows are broken many times a day and were pure noise.)
  const past30 = d1.slice(0, -1); // completed days
  const hi30 = Math.max(...past30.map((x) => x.h)), lo30 = Math.min(...past30.map((x) => x.l));
  if (Math.abs(move) >= BREAK_MOVE) {
    if (before <= hi30 && price >= hi30 * (1 + BREAK_MARGIN / 100)) {
      found.push({ key: "breakup", text: `📈 пробой максимума 30 дней ${fmt(hi30)}` });
    } else if (before >= lo30 && price <= lo30 * (1 - BREAK_MARGIN / 100)) {
      found.push({ key: "breakdn", text: `📉 пробой минимума 30 дней ${fmt(lo30)}` });
    }
  }

  // 📊 Volume spike: the last 30 min against the median 30 min of the last 2 days (in $).
  const usd = (k) => k.v * k.c;
  const vols = [];
  for (let i = 1; i < hist.length; i += 2) vols.push(usd(hist[i]) + usd(hist[i - 1]));
  const usualVol = median(vols);
  // The forming candle is partial: scale it to a full 15 minutes so early runs are not underestimated.
  const elapsed = Math.min(1, Math.max(0.2, (Date.now() - last.t) / 900e3));
  const vol = usd(m15.at(-2)) + usd(last) / elapsed;
  if (usualVol > 0 && vol >= VOL_X * usualVol && vol >= VOL_MIN && Math.abs(move) >= VOL_MOVE) {
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

// Per coin: quiet for REPEAT_H hours after an alert, unless the move has grown ESCALATE_X times.
// State: { "SOL": { t: <ms>, move: <%> } }. Old-format entries ("SOL:vol": ms) are dropped.
const now = Date.now(), state = loadState();
for (const k of Object.keys(state)) {
  if (typeof state[k] !== "object" || !state[k] || now - state[k].t > 24 * 3600e3) delete state[k];
}
const byCoin = new Map();
for (const a of alerts) byCoin.set(a.symbol, [...(byCoin.get(a.symbol) ?? []), a]);
const fresh = [...byCoin.entries()].filter(([sym, list]) => {
  const prev = state[sym];
  if (!prev || now - prev.t >= REPEAT_H * 3600e3) return true;
  return Math.abs(list[0].move) >= ESCALATE_X * Math.max(Math.abs(prev.move), MOVE_MIN);
});

if (isPaused()) {
  console.log(`${new Date().toISOString()} paused from Telegram, nothing sent.`);
  process.exit(0);
}
if (!fresh.length) {
  console.log(`${new Date().toISOString()} ${alerts.length ? "only repeated alerts" : "no alerts"}, nothing sent.`);
  process.exit(0);
}

// Biggest movers first.
fresh.sort((a, b) => Math.abs(b[1][0].move) - Math.abs(a[1][0].move));
const ts = new Date().toLocaleString("ru-RU", { timeZone: TZ, dateStyle: "short", timeStyle: "short" });
const lines = [`🚨 Алерты BingX — ${ts} (${TZ_LABEL})`];

// Whole market moving one way: one short block instead of a block per coin.
const up = fresh.filter(([, l]) => l[0].move > 0), dn = fresh.filter(([, l]) => l[0].move < 0);
const side = up.length >= MARKET_N ? up : dn.length >= MARKET_N ? dn : null;
const shown = side ? fresh.filter((c) => !side.includes(c)) : fresh;
if (side) {
  const top = side.slice(0, 5).map(([sym, l]) => `${sym} ${pct(l[0].move)}`).join(", ");
  const rest = side.length > 5 ? ` и ещё ${side.length - 5}` : "";
  lines.push("", `🌊 весь рынок ${side === up ? "растёт" : "падает"}: ${coinsRu(side.length)} за 30 мин`, `     ${top}${rest}`);
}
for (const [sym, list] of shown.slice(0, MAX_COINS)) {
  lines.push("", `▪️ ${sym}: ${fmt(list[0].price)} (${pct(list[0].move)} за 30 мин)`);
  for (const a of list) lines.push(`     ${a.text}`);
}
if (shown.length > MAX_COINS) lines.push("", `…и ещё ${coinsRu(shown.length - MAX_COINS)}`);
const text = lines.join("\n");

if (dry) {
  console.log(text);
} else if (await sendInfo(text)) {
  for (const [sym, list] of fresh) state[sym] = { t: now, move: list[0].move };
  writeFileSync(STATE_FILE, JSON.stringify(state));
} else {
  process.exitCode = 1;
}
