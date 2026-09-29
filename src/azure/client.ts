// A small ARM client for the browser: bearer token, retries on throttling and server errors, readable errors.
export const ARM = "https://management.azure.com";
export const PORTAL = "https://portal.azure.com";
const MAX_TRIES = 8; // per request, when Cost Management throttles us

export class AzureError extends Error {
  constructor(public status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
  }
}
export class TooManyPages extends Error {}
export class Cancelled extends Error {
  constructor() { super("cancelled"); }
}

export type Log = (msg: string) => void;
export type TokenSource = () => Promise<string>;

/** Cost Management throttles per scope, per client type and per QPU, each with its own *-retry-after header.
 * Wait for the longest one. Browsers only show headers ARM exposes to CORS; without one, back off by attempt. */
function retryAfter(headers: Headers, attempt: number): number {
  let wait = 0;
  headers.forEach((v, k) => {
    if (k.toLowerCase().endsWith("retry-after") && /^\d+$/.test(v.trim())) wait = Math.max(wait, Number(v));
  });
  return wait > 0 ? wait : Math.min(60, 5 * attempt);
}

function errorMessage(raw: string): string {
  try {
    const err = JSON.parse(raw).error;
    if (err) return `${err.code ?? ""}: ${err.message ?? ""}`.replace(/^: |: $/g, "");
  } catch { /* not JSON */ }
  return raw.slice(0, 300);
}

export function explain(e: unknown): string {
  if (e instanceof Cancelled) return "Cancelled.";
  if (!(e instanceof AzureError)) return String((e as Error)?.message ?? e);
  const hints: string[] = [];
  if (e.status === 401) hints.push("Your token is missing or expired. Sign in again (or paste a fresh token).");
  if (e.status === 403) hints.push("You need the Cost Management Reader (or Reader) role on the subscription or scope.");
  if (e.status === 429) hints.push("Cost Management kept throttling. Wait a minute and try again, or read fewer subscriptions.");
  if (e.status === 0) hints.push("Check your network connection. A browser extension or proxy blocking management.azure.com also shows up here.");
  return `Azure error: ${e.message}` + (hints.length ? "\n→ " + hints.join("\n→ ") : "");
}

export class Azure {
  requests = 0;

  constructor(private token: TokenSource, public log: Log = () => {}, private signal?: AbortSignal) {}

  private sleep(seconds: number) {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, seconds * 1000);
      this.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Cancelled()); }, { once: true });
    });
  }

  async call<T = any>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    url = url.startsWith("https://") ? url : ARM + url;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      if (this.signal?.aborted) throw new Cancelled();
      const headers = { Authorization: "Bearer " + (await this.token()), "Content-Type": "application/json" };
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: this.signal });
      } catch (e) { // the network, not Azure, said no (or the run was cancelled)
        if (this.signal?.aborted) throw new Cancelled();
        const reason = (e as Error).message;
        if (attempt === MAX_TRIES) throw new AzureError(0, `network error: ${reason}`);
        this.log(`    network error (${reason}); retrying in ${5 * attempt}s ...`);
        await this.sleep(5 * attempt);
        continue;
      }
      this.requests++;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_TRIES) {
        const wait = retryAfter(res.headers, attempt);
        const why = res.status === 429 ? "Azure is throttling us" : "Azure had a server error";
        this.log(`    ${why} (HTTP ${res.status}); waiting ${wait}s ...`);
        await this.sleep(wait);
        continue;
      }
      const raw = await res.text();
      if (res.status >= 400) throw new AzureError(res.status, errorMessage(raw));
      return (raw ? JSON.parse(raw) : {}) as T;
    }
    throw new AzureError(0, "unreachable");
  }
}
