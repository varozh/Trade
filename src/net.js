// fetch with retries on network errors ("fetch failed", timeouts, resets). HTTP answers are returned as is:
// an error reply from the API is not a network problem and is not retried.
export async function fetchRetry(url, init = {}, { tries = 3, timeoutMs = 20000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      // Node hides the real reason (ETIMEDOUT, ECONNRESET, ENOTFOUND, …) in e.cause.
      const why = [e.cause?.code, e.cause?.message, e.name === "TimeoutError" ? "timeout" : null].filter(Boolean).join(" ");
      if (i >= tries) throw new Error(`${e.message}${why ? ` (${why})` : ""}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}
