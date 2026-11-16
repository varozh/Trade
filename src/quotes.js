// Public BingX market data shared by the scanner and the alerts: watchlist, candles, retries.
import { BingXClient } from "./bingx.js";

// Favorites from the BingX account (edit as needed): base names without -USDT, separated by spaces.
export const WATCHLIST = `BTC ETH SOL ZEC XRP 1000PEPE HYPE AVAX AAVE ARB BNB SUI LINK ENA DOGE UNI TAO ADA ASTER
PUMP ZRO APT TIA OP ETHFI FARTCOIN DASH TRX WIF PENGU STRK LDO USELESS AERO XPL SPX WLFI 1000BONK ZK
MORPHO MYX ARC MNT FLOKI RATS ANSEM SOON TWT`;

// "sol", "SOLUSDT", "sol/usdt" → "SOL-USDT". No arguments → the whole watchlist.
export function toSymbols(list) {
  const src = list.length ? list : WATCHLIST.split(/\s+/).filter(Boolean);
  return src.map((s) => {
    const x = s.toUpperCase().replace(/[/_]/g, "-");
    return x.includes("-") ? x : `${x.replace(/USDT$/, "")}-USDT`;
  });
}

// Market data always comes from the live API (demo has its own, thinner prices).
const client = new BingXClient({ demo: false });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pub(path, params, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await client.get(path, params, { signed: false });
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1000 * (i + 1)); // rate limit: back off and retry
    }
  }
}

// Candles oldest → newest; the last one is still forming.
export const klines = async (symbol, interval, limit) =>
  (await pub("/openApi/swap/v3/quote/klines", { symbol, interval, limit }))
    .map((k) => ({ t: +k.time, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }))
    .sort((a, b) => a.t - b.t);
