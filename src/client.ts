import type { JwtMinter } from "./auth.js";
import { log } from "./log.js";
import type { ErrorResponse, ListResponse, Resource, SingleResponse } from "./types.js";

const BASE = "https://api.appstoreconnect.apple.com";

export class AscApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errors: ErrorResponse["errors"],
    public readonly url: string,
    public readonly method: string,
  ) {
    const summary = errors.length
      ? errors.map((e) => `[${e.code}] ${e.title}${e.detail ? `: ${e.detail}` : ""}${e.source?.pointer ? ` (${e.source.pointer})` : ""}`).join("; ")
      : `HTTP ${status}`;
    super(`App Store Connect API error: ${method} ${url} → ${summary}`);
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set false to skip Authorization (used for pre-signed asset PUTs). */
  auth?: boolean;
  /** Override timeout; default 60s for JSON, 0 (none) for binary uploads. */
  timeoutMs?: number;
  /** Response is binary or empty (PUT to upload URL). */
  raw?: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 5;

export class AscClient {
  constructor(private readonly minter: JwtMinter) {}

  async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = path.startsWith("http") ? withQuery(path, opts.query) : withQuery(`${BASE}${path}`, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.auth !== false) {
      headers.Authorization = `Bearer ${await this.minter.getToken()}`;
    }
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      if (Buffer.isBuffer(opts.body) || opts.body instanceof Uint8Array) {
        body = opts.body as unknown as BodyInit;
      } else {
        body = JSON.stringify(opts.body);
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
      }
    }
    const timeoutMs = opts.timeoutMs ?? (opts.raw ? 0 : DEFAULT_TIMEOUT_MS);

    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= MAX_RETRIES) {
      attempt++;
      const ac = new AbortController();
      const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
      try {
        const res = await fetch(url, { method, headers, body, signal: ac.signal });
        if (timer) clearTimeout(timer);

        // Honor X-Rate-Limit headers for visibility.
        const rl = res.headers.get("x-rate-limit");
        if (rl) log.debug("X-Rate-Limit", { path, method, rl });

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          const backoff = retryAfter ?? Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
          log.warn(`retrying ${method} ${url} after ${backoff}ms`, { status: res.status, attempt });
          if (attempt > MAX_RETRIES) {
            const errs = await safeReadErrors(res);
            throw new AscApiError(res.status, errs, url, method);
          }
          await sleep(backoff);
          continue;
        }
        if (res.status === 204) return undefined as T;
        if (!res.ok) {
          const errs = await safeReadErrors(res);
          throw new AscApiError(res.status, errs, url, method);
        }
        if (opts.raw) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        return JSON.parse(text) as T;
      } catch (err) {
        if (timer) clearTimeout(timer);
        if (err instanceof AscApiError) throw err;
        lastErr = err;
        const isAbort = (err as Error)?.name === "AbortError";
        const isNetwork = isAbort || /(ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed)/i.test(String((err as Error)?.message));
        if (!isNetwork || attempt > MAX_RETRIES) throw err;
        const backoff = Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        log.warn(`network retry ${method} ${url} in ${backoff}ms`, { err: String((err as Error).message) });
        await sleep(backoff);
      }
    }
    throw lastErr ?? new Error("exhausted retries");
  }

  get<T = unknown>(path: string, opts?: RequestOptions) { return this.request<T>("GET", path, opts); }
  post<T = unknown>(path: string, body: unknown, opts?: RequestOptions) { return this.request<T>("POST", path, { ...opts, body }); }
  patch<T = unknown>(path: string, body: unknown, opts?: RequestOptions) { return this.request<T>("PATCH", path, { ...opts, body }); }
  delete<T = unknown>(path: string, opts?: RequestOptions) { return this.request<T>("DELETE", path, opts); }

  /** Walk JSON:API paginated results until exhausted or `max` reached. */
  async getAll<A = Record<string, unknown>>(path: string, opts: RequestOptions & { max?: number } = {}): Promise<Resource<A>[]> {
    const max = opts.max ?? 1000;
    const out: Resource<A>[] = [];
    let next: string | undefined;
    let first = true;
    while (out.length < max) {
      const page = first
        ? await this.request<ListResponse<A>>("GET", path, { ...opts, query: { ...(opts.query ?? {}), limit: opts.query?.limit ?? 200 } })
        : await this.request<ListResponse<A>>("GET", next!, { auth: opts.auth, headers: opts.headers });
      first = false;
      for (const r of page.data) {
        out.push(r);
        if (out.length >= max) break;
      }
      if (!page.links?.next) break;
      next = page.links.next;
    }
    return out;
  }

  // Convenience wrappers matching the most common shape we use.
  async getOne<A = Record<string, unknown>>(path: string, query?: RequestOptions["query"]) {
    return (await this.get<SingleResponse<A>>(path, { query })).data;
  }
  async list<A = Record<string, unknown>>(path: string, query?: RequestOptions["query"]) {
    return (await this.get<ListResponse<A>>(path, { query })).data;
  }
}

function withQuery(url: string, q?: RequestOptions["query"]): string {
  if (!q) return url;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) usp.set(k, v.join(","));
    else usp.set(k, String(v));
  }
  const s = usp.toString();
  if (!s) return url;
  return url.includes("?") ? `${url}&${s}` : `${url}?${s}`;
}

async function safeReadErrors(res: Response): Promise<ErrorResponse["errors"]> {
  try {
    const j = (await res.json()) as ErrorResponse;
    return j.errors ?? [{ status: String(res.status), code: "UNKNOWN", title: res.statusText }];
  } catch {
    const text = await safeText(res);
    return [{ status: String(res.status), code: "UNKNOWN", title: res.statusText, detail: text.slice(0, 500) }];
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const date = Date.parse(h);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
