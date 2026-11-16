// Daily report: the most active BingX futures by 24h turnover (crypto only: stock/commodity "NC…" contracts
// and gold tokens are left out). Coins missing from the watchlist are marked 🆕.
//
//   node --env-file=.env scripts/top.js           – send
//   node --env-file=.env scripts/top.js --dry     – print only
import { pub, watchlist } from "../src/quotes.js";
import { sendAll } from "../src/notify.js";
import { TZ } from "../src/market.js";

const dry = process.argv.includes("--dry");
const TOP = 20;          // coins in the main list
const MOVERS_MIN = 5e6;  // gainers/losers only among coins with at least this 24h turnover, $

const watch = new Set(watchlist());
const all = (await pub("/openApi/swap/v2/quote/ticker", {}))
  .filter((x) => x.symbol.endsWith("-USDT") && !/^NC/.test(x.symbol) && !/^(XAUT|PAXG)-/.test(x.symbol))
  .map((x) => ({ sym: x.symbol.replace("-USDT", ""), vol: +x.quoteVolume, ch: +x.priceChangePercent, price: +x.lastPrice }))
  .filter((x) => x.vol > 0)
  .sort((a, b) => b.vol - a.vol);

const money = (x) => (x >= 1e9 ? `${(x / 1e9).toFixed(1)} млрд $` : x >= 1e6 ? `${(x / 1e6).toFixed(0)} млн $` : `${(x / 1e3).toFixed(0)} тыс $`);
const pct = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`;
const date = new Date().toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "long" });

const lines = [`🔥 Самые активные монеты BingX за 24ч — ${date}`, ""];
all.slice(0, TOP).forEach((x, i) => {
  lines.push(`${i + 1}. ${x.sym} · ${money(x.vol)} · ${pct(x.ch)}${watch.has(x.sym) ? "" : " 🆕"}`);
});

const liquid = all.filter((x) => x.vol >= MOVERS_MIN);
const up = [...liquid].sort((a, b) => b.ch - a.ch).slice(0, 5);
const dn = [...liquid].sort((a, b) => a.ch - b.ch).slice(0, 5);
lines.push(
  "",
  "━━━━━━━━━━━━",
  `🚀 Рост (оборот от ${money(MOVERS_MIN)}): ${up.map((x) => `${x.sym} ${pct(x.ch)}`).join(", ")}`,
  `🩸 Падение: ${dn.map((x) => `${x.sym} ${pct(x.ch)}`).join(", ")}`,
);
const fresh = all.slice(0, TOP).filter((x) => !watch.has(x.sym)).map((x) => x.sym);
if (fresh.length) lines.push("", `🆕 Нет в списке сканера: ${fresh.join(", ")}`);

const text = lines.join("\n");
if (dry) console.log(text);
// Telegram: one "➕ SYM" button per new coin, handled by the bot (adds it to the watchlist).
else if (!(await sendAll(text, { tgButtons: chunk(fresh.map((s) => ({ text: `➕ ${s}`, callback_data: `add:${s}` })), 3) }))) {
  process.exitCode = 1;
}

function chunk(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}
