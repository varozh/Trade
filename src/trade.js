// Opening a position from a scanner signal: limit order at the entry, with stop-loss and take-profit attached.
// Size: losing exactly riskPct of the account equity when the stop is hit. Leverage: SCAN_LEVERAGE (30).
// Needs BINGX_API_KEY / BINGX_SECRET_KEY with the trading permission.
import { BingXClient } from "./bingx.js";
import { env } from "./env.js";

export const client = new BingXClient({
  apiKey: env("BINGX_API_KEY"),
  secretKey: env("BINGX_SECRET_KEY"),
  demo: /^true$/i.test(env("BINGX_DEMO") ?? "false"),
});
export const LEVERAGE = Number(env("SCAN_LEVERAGE")) || 30;

let contracts = null;
async function contract(symbol) {
  if (!contracts) {
    const list = await client.get("/openApi/swap/v2/quote/contracts", {}, { signed: false });
    contracts = new Map(list.map((c) => [c.symbol, c]));
  }
  const c = contracts.get(symbol);
  if (!c) throw new Error(`контракт ${symbol} не найден на BingX`);
  return c;
}

export async function account() {
  const d = await client.get("/openApi/swap/v3/user/balance", {});
  const u = [d].flat().find((x) => x?.asset === "USDT" || x?.asset === "VST");
  return { equity: Number(u?.equity) || 0, available: Number(u?.availableMargin) || 0 };
}

export async function lastPrice(symbol) {
  return Number((await client.get("/openApi/swap/v2/quote/price", { symbol }, { signed: false })).price);
}

const floorTo = (x, digits) => Math.floor(x * 10 ** digits) / 10 ** digits;
const roundTo = (x, digits) => Number(x.toFixed(digits));

// Everything needed to show the order before it is sent. Throws with a readable reason if it cannot be placed.
export async function planOrder(signal, riskPct) {
  const symbol = `${signal.symbol}-USDT`;
  const [c, acc, price] = await Promise.all([contract(symbol), account(), lastPrice(symbol)]);
  const long = signal.side === "long";
  const entry = roundTo(signal.entry, c.pricePrecision);
  const stop = roundTo(signal.stop, c.pricePrecision);
  const target = roundTo(signal.target, c.pricePrecision);

  if (long ? price <= stop : price >= stop) throw new Error(`цена ${price} уже за стопом ${stop}, сигнал устарел`);
  if (long ? price >= target : price <= target) throw new Error(`цена ${price} уже дошла до тейка ${target}, сигнал устарел`);

  const riskUsd = (acc.equity * riskPct) / 100;
  const qty = floorTo(riskUsd / Math.abs(entry - stop), c.quantityPrecision);
  const notional = qty * entry, margin = notional / LEVERAGE;
  if (qty <= 0 || qty < Number(c.tradeMinQuantity) || notional < Number(c.tradeMinUSDT)) {
    throw new Error(`объём ${qty} (${notional.toFixed(2)} $) меньше минимального ордера BingX: ${c.tradeMinQuantity} ${c.asset} / ${c.tradeMinUSDT} $`);
  }
  if (margin > acc.available) throw new Error(`нужна маржа ${margin.toFixed(2)} $, свободно ${acc.available.toFixed(2)} $`);

  return {
    symbol, side: signal.side, riskPct, entry, stop, target, qty, notional, margin, price,
    loss: qty * Math.abs(entry - stop), gain: qty * Math.abs(target - entry),
    // Price already past the entry: the limit order fills at once at the market.
    immediate: long ? price <= entry : price >= entry,
    asset: c.asset,
  };
}

async function isHedgeMode() {
  const d = await client.get("/openApi/swap/v1/positionSide/dual", {});
  return String(d?.dualSidePosition) === "true";
}

// test: BingX checks the order without placing it (/trade/order/test), leverage is not changed.
// clientOrderId: our own id, used to find and cancel the order later (BingX order ids are 19 digits,
// too long for a JS number).
export async function placeOrder(p, { test = false, clientOrderId } = {}) {
  const positionSide = (await isHedgeMode()) ? (p.side === "long" ? "LONG" : "SHORT") : "BOTH";
  if (!test) await client.post("/openApi/swap/v2/trade/leverage", { symbol: p.symbol, side: positionSide, leverage: LEVERAGE });
  const params = {
    symbol: p.symbol,
    side: p.side === "long" ? "BUY" : "SELL",
    positionSide,
    type: "LIMIT",
    price: p.entry,
    quantity: p.qty,
    stopLoss: { type: "STOP_MARKET", stopPrice: p.stop, workingType: "MARK_PRICE" },
    takeProfit: { type: "TAKE_PROFIT_MARKET", stopPrice: p.target, workingType: "MARK_PRICE" },
    ...(clientOrderId ? { clientOrderId } : {}),
  };
  return client.post(test ? "/openApi/swap/v2/trade/order/test" : "/openApi/swap/v2/trade/order", params);
}

export async function openPositions() {
  const list = [await client.get("/openApi/swap/v2/user/positions", {})].flat().filter((p) => p && Number(p.positionAmt));
  return list.map((p) => ({
    symbol: p.symbol.replace("-USDT", ""),
    side: p.positionSide === "SHORT" || Number(p.positionAmt) < 0 ? "short" : "long",
    qty: Math.abs(Number(p.positionAmt)),
    entry: Number(p.avgPrice),
    pnl: Number(p.unrealizedProfit),
    leverage: Number(p.leverage),
  }));
}

// Open orders of the account: pending entries and the stop / take orders of open positions.
export async function openOrders() {
  const d = await client.get("/openApi/swap/v2/trade/openOrders", {});
  return (d?.orders ?? []).map((o) => ({
    symbol: o.symbol.replace("-USDT", ""),
    side: o.side, // BUY / SELL
    positionSide: o.positionSide, // LONG / SHORT / BOTH
    type: o.type,
    price: Number(o.price) || 0,
    stopPrice: Number(o.stopPrice) || 0,
    reduceOnly: String(o.reduceOnly) === "true",
    clientOrderId: o.clientOrderID ?? o.clientOrderId ?? "",
  }));
}
// An order that opens a position (not a stop, take or closing order).
export const isEntryOrder = (o) =>
  /^(LIMIT|MARKET|TRIGGER_LIMIT|TRIGGER_MARKET)$/.test(o.type) && !o.reduceOnly &&
  (o.positionSide === "LONG" ? o.side === "BUY" : o.positionSide === "SHORT" ? o.side === "SELL" : true);

export async function orderStatus(symbol, clientOrderId) {
  const d = await client.get("/openApi/swap/v2/trade/order", { symbol: `${symbol}-USDT`, clientOrderId });
  return (d?.order ?? d)?.status; // NEW, PENDING, PARTIALLY_FILLED, FILLED, CANCELLED, EXPIRED…
}
export async function cancelOrder(symbol, clientOrderId) {
  return client.delete("/openApi/swap/v2/trade/order", { symbol: `${symbol}-USDT`, clientOrderId });
}
