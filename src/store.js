// Small JSON files in data/ (git-ignored): signal log, OI history, bot pause flag, …
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";

const DIR = new URL("../data/", import.meta.url);
mkdirSync(DIR, { recursive: true });
export const dataFile = (name) => new URL(name, DIR);

export function readJson(name, def) {
  try {
    return JSON.parse(readFileSync(dataFile(name), "utf8"));
  } catch {
    return def;
  }
}
export function writeJson(name, value) {
  writeFileSync(dataFile(name), JSON.stringify(value));
}

// ---------- signal log (one JSON object per line) ----------
export function readSignals() {
  try {
    return readFileSync(dataFile("signals.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
export function appendSignals(list) {
  if (list.length) appendFileSync(dataFile("signals.jsonl"), list.map((s) => JSON.stringify(s)).join("\n") + "\n");
}
export function writeSignals(list) {
  writeFileSync(dataFile("signals.jsonl"), list.map((s) => JSON.stringify(s)).join("\n") + (list.length ? "\n" : ""));
}

// ---------- pause (set from Telegram) ----------
export const pausedUntil = () => readJson("pause.json", {}).until ?? 0;
export const isPaused = () => Date.now() < pausedUntil();
export const setPause = (until) => writeJson("pause.json", { until });

// ---------- auto-trading (scanner opens its signals on BingX itself) ----------
// On unless SCAN_AUTO_TRADE=false in .env; /auto on|off in Telegram overrides that.
export function autoTrading(envDefault) {
  const v = readJson("auto.json", {}).on;
  return typeof v === "boolean" ? v : envDefault;
}
export const setAutoTrading = (on) => writeJson("auto.json", { on });

// ---------- entry orders waiting to be filled ----------
// Limit entries placed by the bot or the auto-trader; the bot cancels them when the signal's entry expires.
const PENDING = "pending-orders.json";
export const readPendingOrders = () => readJson(PENDING, []);
export const writePendingOrders = (list) => writeJson(PENDING, list);
export const addPendingOrder = (o) => writePendingOrders([...readPendingOrders(), o]);
