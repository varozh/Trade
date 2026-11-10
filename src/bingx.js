// Minimal BingX REST client (USDT-M perpetual swap API).
import crypto from "node:crypto";

const LIVE_URL = "https://open-api.bingx.com";
const DEMO_URL = "https://open-api-vst.bingx.com"; // VST demo trading

export class BingXError extends Error {
  constructor(message, code, payload) {
    super(message);
    this.code = code;
    this.payload = payload;
  }
}

export class BingXClient {
  constructor({ apiKey, secretKey, demo = true, recvWindow = 5000, timeoutMs = 15000 } = {}) {
    this.apiKey = apiKey || "";
    this.secretKey = secretKey || "";
    this.demo = demo;
    this.baseUrl = demo ? DEMO_URL : LIVE_URL;
    this.recvWindow = recvWindow;
    this.timeoutMs = timeoutMs;
  }

  get hasKeys() {
    return Boolean(this.apiKey && this.secretKey);
  }

  // Build query string: keys sorted, values raw for signing, encoded for sending.
  static buildQuery(params) {
    const keys = Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
      .sort();
    const raw = keys.map((k) => `${k}=${params[k]}`).join("&");
    const encoded = keys.map((k) => `${k}=${encodeURIComponent(String(params[k]))}`).join("&");
    return { raw, encoded };
  }

  sign(payload) {
    return crypto.createHmac("sha256", this.secretKey).update(payload).digest("hex");
  }

  async request(method, path, params = {}, { signed = true } = {}) {
    const p = { ...params };
    for (const [k, v] of Object.entries(p)) {
      if (v !== null && typeof v === "object") p[k] = JSON.stringify(v);
    }
    if (signed) {
      if (!this.hasKeys) {
        throw new BingXError("BINGX_API_KEY / BINGX_SECRET_KEY are not set", "NO_KEYS");
      }
      p.timestamp = Date.now();
      p.recvWindow = this.recvWindow;
    }
    const { raw, encoded } = BingXClient.buildQuery(p);
    let qs = encoded;
    if (signed) qs += (qs ? "&" : "") + `signature=${this.sign(raw)}`;

    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const headers = { "User-Agent": "bingx-mcp/1.0" };
    if (this.apiKey) headers["X-BX-APIKEY"] = this.apiKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BingXError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    if (!res.ok || (body.code !== undefined && body.code !== 0)) {
      throw new BingXError(body.msg || `HTTP ${res.status}`, body.code ?? res.status, body);
    }
    return body.data !== undefined ? body.data : body;
  }

  get(path, params, opts) {
    return this.request("GET", path, params, opts);
  }
  post(path, params, opts) {
    return this.request("POST", path, params, opts);
  }
  delete(path, params, opts) {
    return this.request("DELETE", path, params, opts);
  }
}
