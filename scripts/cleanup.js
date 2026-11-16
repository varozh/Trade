// Daily housekeeping: nothing older than about two weeks is kept.
//   *.log          – rotated once a week: x.log → x.log.1 (the previous x.log.1 is deleted),
//                    so the logs always cover the last 7–14 days
//   signals.jsonl  – signals older than 14 days are dropped (weekly statistics needs only 7)
//
//   node scripts/cleanup.js
import { readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readJson, writeJson, readSignals, writeSignals } from "../src/store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const D = 864e5, now = Date.now(), KEEP = 14 * D;

// Logs
const state = readJson("cleanup.json", {});
for (const f of readdirSync(ROOT).filter((f) => f.endsWith(".log"))) {
  const path = join(ROOT, f);
  const rotated = state[f] ?? statSync(path).birthtimeMs ?? now;
  if (now - rotated >= 7 * D) {
    rmSync(`${path}.1`, { force: true });
    renameSync(path, `${path}.1`);
    state[f] = now;
    console.log(`rotated ${f}`);
  } else if (!state[f]) {
    state[f] = now;
  }
}
writeJson("cleanup.json", state);

// Signals
const signals = readSignals();
const kept = signals.filter((s) => now - s.ts < KEEP);
if (kept.length !== signals.length) {
  writeSignals(kept);
  console.log(`signals: dropped ${signals.length - kept.length}`);
}
