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
