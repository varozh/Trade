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
