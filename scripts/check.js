// Quick connectivity check: public market data, and account data if keys are set.
// Usage: node scripts/check.js   (reads BINGX_* env vars)
import { BingXClient } from "../src/bingx.js";

const demo = !/^(0|false|no|off)$/i.test(process.env.BINGX_DEMO ?? "true");
const c = new BingXClient({
  apiKey: process.env.BINGX_API_KEY,
  secretKey: process.env.BINGX_SECRET_KEY,
  demo,
});

console.log(`Base URL: ${c.baseUrl}`);
const price = await c.get("/openApi/swap/v2/quote/price", { symbol: "BTC-USDT" }, { signed: false });
console.log("BTC-USDT price:", price.price);

if (c.hasKeys) {
  const bal = await c.get("/openApi/swap/v3/user/balance", {});
  console.log("Balance:", JSON.stringify(bal, null, 2));
  const pos = await c.get("/openApi/swap/v2/user/positions", {});
  console.log("Open positions:", Array.isArray(pos) ? pos.length : pos);
} else {
  console.log("API keys not set — skipped account checks.");
}
