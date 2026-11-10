#!/usr/bin/env node
// BingX USDT-M perpetual futures MCP server.
//
// Env:
//   BINGX_API_KEY, BINGX_SECRET_KEY   – API credentials
//   BINGX_DEMO=true|false             – demo (VST) account, default true
//   BINGX_ENABLE_TRADING=true|false   – allow order/position-changing tools, default false
//   BINGX_MAX_NOTIONAL_USDT=number    – optional cap on one order's notional value
//   BINGX_MAX_LEVERAGE=number         – optional cap on leverage
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BingXClient, BingXError } from "./bingx.js";

const env = process.env;
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v) => (v === undefined || v === "" ? undefined : Number(v));

const config = {
  demo: bool(env.BINGX_DEMO, true),
  tradingEnabled: bool(env.BINGX_ENABLE_TRADING, false),
  maxNotional: num(env.BINGX_MAX_NOTIONAL_USDT),
  maxLeverage: num(env.BINGX_MAX_LEVERAGE),
};

const client = new BingXClient({
  apiKey: env.BINGX_API_KEY,
  secretKey: env.BINGX_SECRET_KEY,
  demo: config.demo,
});

const server = new McpServer({ name: "bingx-futures", version: "1.0.0" });

// ---------- helpers ----------
function normSymbol(s) {
  let x = String(s).trim().toUpperCase().replace(/[/_]/g, "-");
  if (!x.includes("-")) x = x.endsWith("USDT") ? `${x.slice(0, -4)}-USDT` : `${x}-USDT`;
  return x;
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });

function tool(name, description, shape, handler, { trading = false } = {}) {
  server.registerTool(
    name,
    {
      description: trading
        ? `${description} [TRADING — changes account state on ${config.demo ? "DEMO (VST)" : "LIVE"} account]`
        : description,
      inputSchema: shape,
      annotations: trading ? { destructiveHint: true } : { readOnlyHint: true },
    },
    async (args) => {
      try {
        if (trading && !config.tradingEnabled) {
          return fail("Trading tools are disabled. Set BINGX_ENABLE_TRADING=true to enable them.");
        }
        return ok(await handler(args ?? {}));
      } catch (e) {
        if (e instanceof BingXError) return fail(`BingX ${e.code}: ${e.message}`);
        return fail(e?.message || String(e));
      }
    },
  );
}

async function lastPrice(symbol) {
  const d = await client.get("/openApi/swap/v2/quote/price", { symbol }, { signed: false });
  return Number(d.price);
}

async function isHedgeMode() {
  const d = await client.get("/openApi/swap/v1/positionSide/dual", {});
  return String(d?.dualSidePosition) === "true";
}

async function checkNotional(symbol, quantity, price) {
  if (!config.maxNotional) return;
  const p = price ?? (await lastPrice(symbol));
  const notional = p * quantity;
  if (notional > config.maxNotional) {
    throw new Error(
      `Order notional ${notional.toFixed(2)} USDT exceeds BINGX_MAX_NOTIONAL_USDT=${config.maxNotional}`,
    );
  }
}

function checkLeverage(lev) {
  if (config.maxLeverage && lev > config.maxLeverage) {
    throw new Error(`Leverage ${lev} exceeds BINGX_MAX_LEVERAGE=${config.maxLeverage}`);
  }
}

const symbolArg = z.string().describe("Contract, e.g. BTC-USDT (BTC, BTCUSDT also accepted)");
const optSymbol = symbolArg.optional();
const direction = z.enum(["LONG", "SHORT"]).describe("Position direction");
const timeRange = {
  startTime: z.number().int().optional().describe("Start, unix ms"),
  endTime: z.number().int().optional().describe("End, unix ms"),
};

// ---------- info ----------
tool("get_status", "Server configuration: demo/live, trading enabled, limits, keys present.", {}, async () => ({
  mode: config.demo ? "DEMO (VST)" : "LIVE",
  baseUrl: client.baseUrl,
  tradingEnabled: config.tradingEnabled,
  maxNotionalUSDT: config.maxNotional ?? null,
  maxLeverage: config.maxLeverage ?? null,
  apiKeysConfigured: client.hasKeys,
}));

// ---------- market data (public) ----------
tool("get_price", "Latest price of a contract.", { symbol: symbolArg }, ({ symbol }) =>
  client.get("/openApi/swap/v2/quote/price", { symbol: normSymbol(symbol) }, { signed: false }),
);

tool("get_ticker_24h", "24h ticker statistics. Omit symbol for all contracts.", { symbol: optSymbol }, ({ symbol }) =>
  client.get("/openApi/swap/v2/quote/ticker", { symbol: symbol && normSymbol(symbol) }, { signed: false }),
);

tool(
  "get_klines",
  "Candlesticks (OHLCV).",
  {
    symbol: symbolArg,
    interval: z
      .enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M"])
      .default("1h"),
    limit: z.number().int().min(1).max(1440).default(100),
    ...timeRange,
  },
  ({ symbol, interval, limit, startTime, endTime }) =>
    client.get(
      "/openApi/swap/v3/quote/klines",
      { symbol: normSymbol(symbol), interval, limit, startTime, endTime },
      { signed: false },
    ),
);

tool(
  "get_orderbook",
  "Order book depth.",
  { symbol: symbolArg, limit: z.enum(["5", "10", "20", "50", "100", "500", "1000"]).default("20") },
  ({ symbol, limit }) =>
    client.get("/openApi/swap/v2/quote/depth", { symbol: normSymbol(symbol), limit }, { signed: false }),
);

tool("get_funding_rate", "Mark price, index price and current funding rate.", { symbol: optSymbol }, ({ symbol }) =>
  client.get("/openApi/swap/v2/quote/premiumIndex", { symbol: symbol && normSymbol(symbol) }, { signed: false }),
);

tool(
  "get_contract_info",
  "Contract specs: min quantity, step size, price precision, max leverage.",
  { symbol: optSymbol },
  async ({ symbol }) => {
    const all = await client.get("/openApi/swap/v2/quote/contracts", {}, { signed: false });
    return symbol ? all.filter((c) => c.symbol === normSymbol(symbol)) : all;
  },
);

// ---------- account (private, read-only) ----------
tool("get_balance", "Futures account balance, equity, unrealized PnL, available margin.", {}, () =>
  client.get("/openApi/swap/v3/user/balance", {}),
);

tool("get_positions", "Open positions.", { symbol: optSymbol }, ({ symbol }) =>
  client.get("/openApi/swap/v2/user/positions", { symbol: symbol && normSymbol(symbol) }),
);

tool("get_open_orders", "Currently open (pending) orders.", { symbol: optSymbol }, ({ symbol }) =>
  client.get("/openApi/swap/v2/trade/openOrders", { symbol: symbol && normSymbol(symbol) }),
);

tool(
  "get_order",
  "Details of one order.",
  { symbol: symbolArg, orderId: z.string() },
  ({ symbol, orderId }) => client.get("/openApi/swap/v2/trade/order", { symbol: normSymbol(symbol), orderId }),
);

tool(
  "get_order_history",
  "Order history (filled, cancelled, etc.) for a contract.",
  { symbol: symbolArg, limit: z.number().int().min(1).max(1000).default(100), ...timeRange },
  ({ symbol, limit, startTime, endTime }) =>
    client.get("/openApi/swap/v2/trade/allOrders", { symbol: normSymbol(symbol), limit, startTime, endTime }),
);

tool(
  "get_trade_fills",
  "Executed trades (fills). Time range is required by BingX; defaults to last 7 days.",
  { symbol: optSymbol, ...timeRange },
  ({ symbol, startTime, endTime }) => {
    const end = endTime ?? Date.now();
    const start = startTime ?? end - 7 * 24 * 3600 * 1000;
    return client.get("/openApi/swap/v2/trade/allFillOrders", {
      symbol: symbol && normSymbol(symbol),
      tradingUnit: "COIN",
      startTs: start,
      endTs: end,
    });
  },
);

tool(
  "get_income_history",
  "Realized PnL, funding fees, commissions and transfers.",
  {
    symbol: optSymbol,
    incomeType: z
      .enum(["TRANSFER", "REALIZED_PNL", "FUNDING_FEE", "TRADING_FEE", "INSURANCE_CLEAR", "TRIAL_FUND", "ADL", "SYSTEM_DEDUCTION"])
      .optional(),
    limit: z.number().int().min(1).max(1000).default(100),
    ...timeRange,
  },
  ({ symbol, incomeType, limit, startTime, endTime }) =>
    client.get("/openApi/swap/v2/user/income", {
      symbol: symbol && normSymbol(symbol),
      incomeType,
      limit,
      startTime,
      endTime,
    }),
);

tool("get_leverage", "Current leverage for a contract.", { symbol: symbolArg }, ({ symbol }) =>
  client.get("/openApi/swap/v2/trade/leverage", { symbol: normSymbol(symbol) }),
);

tool("get_margin_type", "Margin type (ISOLATED / CROSSED) for a contract.", { symbol: symbolArg }, ({ symbol }) =>
  client.get("/openApi/swap/v2/trade/marginType", { symbol: normSymbol(symbol) }),
);

tool("get_position_mode", "Hedge mode (separate LONG/SHORT) or one-way mode.", {}, async () => ({
  hedgeMode: await isHedgeMode(),
}));

// ---------- trading ----------
tool(
  "set_leverage",
  "Set leverage for a contract.",
  {
    symbol: symbolArg,
    leverage: z.number().int().min(1).max(150),
    side: z.enum(["LONG", "SHORT", "BOTH"]).default("BOTH").describe("BOTH in one-way mode"),
  },
  async ({ symbol, leverage, side }) => {
    checkLeverage(leverage);
    const sym = normSymbol(symbol);
    const sides = side === "BOTH" && (await isHedgeMode()) ? ["LONG", "SHORT"] : [side];
    const out = [];
    for (const s of sides) out.push(await client.post("/openApi/swap/v2/trade/leverage", { symbol: sym, side: s, leverage }));
    return out;
  },
  { trading: true },
);

tool(
  "set_margin_type",
  "Set margin type for a contract (no open positions/orders allowed).",
  { symbol: symbolArg, marginType: z.enum(["ISOLATED", "CROSSED"]) },
  ({ symbol, marginType }) =>
    client.post("/openApi/swap/v2/trade/marginType", { symbol: normSymbol(symbol), marginType }),
  { trading: true },
);

tool(
  "open_position",
  "Open or add to a futures position (market or limit), optionally with leverage, stop-loss and take-profit.",
  {
    symbol: symbolArg,
    direction,
    quantity: z.number().positive().describe("Size in base coin (e.g. 0.01 BTC)"),
    type: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
    price: z.number().positive().optional().describe("Required for LIMIT"),
    leverage: z.number().int().min(1).max(150).optional().describe("Set leverage before the order"),
    stopLossPrice: z.number().positive().optional(),
    takeProfitPrice: z.number().positive().optional(),
    clientOrderId: z.string().optional(),
  },
  async (a) => {
    const symbol = normSymbol(a.symbol);
    if (a.type === "LIMIT" && !a.price) throw new Error("price is required for LIMIT orders");
    await checkNotional(symbol, a.quantity, a.price);
    const hedge = await isHedgeMode();
    const positionSide = hedge ? a.direction : "BOTH";
    if (a.leverage) {
      checkLeverage(a.leverage);
      await client.post("/openApi/swap/v2/trade/leverage", { symbol, side: positionSide, leverage: a.leverage });
    }
    const params = {
      symbol,
      side: a.direction === "LONG" ? "BUY" : "SELL",
      positionSide,
      type: a.type,
      quantity: a.quantity,
      price: a.type === "LIMIT" ? a.price : undefined,
      clientOrderID: a.clientOrderId,
    };
    if (a.stopLossPrice)
      params.stopLoss = { type: "STOP_MARKET", stopPrice: a.stopLossPrice, workingType: "MARK_PRICE" };
    if (a.takeProfitPrice)
      params.takeProfit = { type: "TAKE_PROFIT_MARKET", stopPrice: a.takeProfitPrice, workingType: "MARK_PRICE" };
    return client.post("/openApi/swap/v2/trade/order", params);
  },
  { trading: true },
);

async function findPosition(symbol, dir) {
  const positions = await client.get("/openApi/swap/v2/user/positions", { symbol });
  const pos = (positions || []).find((p) => {
    const amt = Number(p.positionAmt);
    if (!amt) return false;
    if (p.positionSide === "LONG" || p.positionSide === "SHORT") return p.positionSide === dir;
    return dir === "LONG" ? amt > 0 : amt < 0;
  });
  if (!pos) throw new Error(`No open ${dir} position on ${symbol}`);
  return pos;
}

tool(
  "close_position",
  "Close a position fully or partially (market or limit, reduce-only).",
  {
    symbol: symbolArg,
    direction,
    quantity: z.number().positive().optional().describe("Omit to close the whole position"),
    type: z.enum(["MARKET", "LIMIT"]).default("MARKET"),
    price: z.number().positive().optional(),
  },
  async (a) => {
    const symbol = normSymbol(a.symbol);
    if (a.type === "LIMIT" && !a.price) throw new Error("price is required for LIMIT orders");
    const pos = await findPosition(symbol, a.direction);
    const size = Math.abs(Number(pos.positionAmt));
    const qty = a.quantity ? Math.min(a.quantity, size) : size;
    const hedge = pos.positionSide === "LONG" || pos.positionSide === "SHORT";
    return client.post("/openApi/swap/v2/trade/order", {
      symbol,
      side: a.direction === "LONG" ? "SELL" : "BUY",
      positionSide: hedge ? a.direction : "BOTH",
      reduceOnly: hedge ? undefined : "true",
      type: a.type,
      quantity: qty,
      price: a.type === "LIMIT" ? a.price : undefined,
    });
  },
  { trading: true },
);

tool(
  "set_stop_loss_take_profit",
  "Attach stop-loss and/or take-profit orders to an existing position (whole size).",
  {
    symbol: symbolArg,
    direction,
    stopLossPrice: z.number().positive().optional(),
    takeProfitPrice: z.number().positive().optional(),
  },
  async (a) => {
    if (!a.stopLossPrice && !a.takeProfitPrice) throw new Error("Give stopLossPrice and/or takeProfitPrice");
    const symbol = normSymbol(a.symbol);
    const pos = await findPosition(symbol, a.direction);
    const qty = Math.abs(Number(pos.positionAmt));
    const hedge = pos.positionSide === "LONG" || pos.positionSide === "SHORT";
    const base = {
      symbol,
      side: a.direction === "LONG" ? "SELL" : "BUY",
      positionSide: hedge ? a.direction : "BOTH",
      reduceOnly: hedge ? undefined : "true",
      quantity: qty,
      workingType: "MARK_PRICE",
    };
    const out = {};
    if (a.stopLossPrice)
      out.stopLoss = await client.post("/openApi/swap/v2/trade/order", { ...base, type: "STOP_MARKET", stopPrice: a.stopLossPrice });
    if (a.takeProfitPrice)
      out.takeProfit = await client.post("/openApi/swap/v2/trade/order", {
        ...base,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: a.takeProfitPrice,
      });
    return out;
  },
  { trading: true },
);

tool(
  "place_order",
  "Advanced: raw BingX swap order (any type: LIMIT, MARKET, STOP_MARKET, TAKE_PROFIT_MARKET, TRAILING_STOP_MARKET, ...).",
  {
    symbol: symbolArg,
    side: z.enum(["BUY", "SELL"]),
    positionSide: z.enum(["LONG", "SHORT", "BOTH"]),
    type: z.string(),
    quantity: z.number().positive().optional(),
    price: z.number().positive().optional(),
    stopPrice: z.number().positive().optional(),
    reduceOnly: z.boolean().optional(),
    timeInForce: z.enum(["GTC", "IOC", "FOK", "PostOnly"]).optional(),
    workingType: z.enum(["MARK_PRICE", "CONTRACT_PRICE", "INDEX_PRICE"]).optional(),
    priceRate: z.number().optional().describe("Callback rate for trailing stop"),
    clientOrderId: z.string().optional(),
  },
  async (a) => {
    const symbol = normSymbol(a.symbol);
    if (a.quantity && !a.reduceOnly) await checkNotional(symbol, a.quantity, a.price);
    const { clientOrderId, reduceOnly, ...rest } = a;
    return client.post("/openApi/swap/v2/trade/order", {
      ...rest,
      symbol,
      reduceOnly: reduceOnly === undefined ? undefined : String(reduceOnly),
      clientOrderID: clientOrderId,
    });
  },
  { trading: true },
);

tool(
  "cancel_order",
  "Cancel one open order.",
  { symbol: symbolArg, orderId: z.string() },
  ({ symbol, orderId }) => client.delete("/openApi/swap/v2/trade/order", { symbol: normSymbol(symbol), orderId }),
  { trading: true },
);

tool(
  "cancel_all_orders",
  "Cancel all open orders for a contract.",
  { symbol: symbolArg },
  ({ symbol }) => client.delete("/openApi/swap/v2/trade/allOpenOrders", { symbol: normSymbol(symbol) }),
  { trading: true },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `bingx-mcp started: ${config.demo ? "DEMO" : "LIVE"}, trading ${config.tradingEnabled ? "ENABLED" : "disabled"}`,
);
