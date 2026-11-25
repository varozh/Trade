// Settings (VK_*, TG_*, BINGX_*, SCAN_*) from this project's .env win over the process environment:
// other scripts on the same server (e.g. a crontab with its own VK_TOKEN for another community)
// must not hijack the sender. It also works when the script is started without --env-file.
import { readFileSync } from "node:fs";

const ownEnv = (() => {
  try {
    const text = readFileSync(new URL("../.env", import.meta.url), "utf8");
    return Object.fromEntries(
      text.split(/\r?\n/)
        .map((l) => l.match(/^\s*((?:VK|TG|BINGX|SCAN)_[A-Z_]+)\s*=\s*["']?(.*?)["']?\s*$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    );
  } catch {
    return {};
  }
})();

export const env = (name) => ownEnv[name] || process.env[name];

// Split long text by lines so every part fits into one message.
export function splitText(text, max) {
  const parts = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) {
      parts.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) parts.push(cur);
  return parts;
}

// Risk per trade, % of deposit: [lower, upper] (buttons, sizes in messages; auto-trading uses the lower).
// SCAN_RISK_MIN_PCT / SCAN_RISK_MAX_PCT in .env, default 1 and 2, never above RISK_CAP_PCT:
// the backtest had up to 20 stops in a row, at 5% risk that empties the account.
export const RISK_CAP_PCT = 2;
export function riskLevels() {
  // A value above the cap (e.g. the old 5 / 15) is ignored: the default is used instead.
  const num = (name, def) => { const v = Number(env(name)); return v > 0 && v <= RISK_CAP_PCT ? v : def; };
  const lo = num("SCAN_RISK_MIN_PCT", 1);
  const hi = Math.max(num("SCAN_RISK_MAX_PCT", 2), lo);
  return [lo, hi];
}
