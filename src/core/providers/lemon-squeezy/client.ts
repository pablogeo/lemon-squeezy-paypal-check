// Minimal Lemon Squeezy HTTP client: global fetch only, no third-party imports.
// - Pinned to https://api.lemonsqueezy.com: a `links.next` pointing anywhere else is refused,
//   so the Authorization header can never be sent to another host.
// - Every call has a timeout; 429 and transient failures retry with bounded backoff.
// - Error messages never contain the API key or response bodies.
import { asListBody, isRecord, type LsListBody } from './guards';

export const LS_API_ORIGIN = 'https://api.lemonsqueezy.com';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export type LsErrorKind =
  | 'auth'
  | 'not_found'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'bad_request'
  | 'bad_response'
  | 'aborted'
  | 'foreign_host'
  | 'not_cancelled';

export class LsApiError extends Error {
  readonly kind: LsErrorKind;
  readonly status: number | null;
  constructor(kind: LsErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'LsApiError';
    this.kind = kind;
    this.status = status;
  }
}

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function abortedError(): LsApiError {
  return new LsApiError('aborted', 'The scan was cancelled.');
}

export type LsClientOptions = {
  fetch?: FetchLike;
  sleep?: Sleep;
  timeoutMs?: number;
  maxRateLimitRetries?: number;
  maxTransientRetries?: number;
};

export type LsClient = {
  getJson(pathOrUrl: string, signal?: AbortSignal): Promise<unknown>;
  /** DELETE (cancel). Same timeouts, retries and host pinning as GET. */
  deleteJson(pathOrUrl: string, signal?: AbortSignal): Promise<unknown>;
  paginate(firstPath: string, signal?: AbortSignal): AsyncGenerator<LsListBody>;
};

export function resolveLsUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith('/v1/')) return LS_API_ORIGIN + pathOrUrl;
  let url: URL;
  try {
    url = new URL(pathOrUrl);
  } catch {
    throw new LsApiError('foreign_host', 'Refusing to follow an invalid Lemon Squeezy URL.');
  }
  if (url.origin !== LS_API_ORIGIN) {
    throw new LsApiError('foreign_host', 'Refusing to send the API key to a host other than api.lemonsqueezy.com.');
  }
  return url.toString();
}

export function createLsClient(apiKey: string, options: LsClientOptions = {}): LsClient {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 6;
  const maxTransientRetries = options.maxTransientRetries ?? 3;

  const headers = {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    Authorization: `Bearer ${apiKey}`,
  };

  async function attempt(url: string, signal?: AbortSignal, method: 'GET' | 'DELETE' = 'GET'): Promise<{ status: number; text: string; remaining: number | null }> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method, headers, signal: ctrl.signal, redirect: 'error' });
      const text = await res.text();
      const remainingHeader = res.headers.get('x-ratelimit-remaining');
      const remaining = remainingHeader !== null && remainingHeader !== '' ? Number(remainingHeader) : null;
      return { status: res.status, text, remaining: Number.isFinite(remaining) ? remaining : null };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function getJson(pathOrUrl: string, signal?: AbortSignal, method: 'GET' | 'DELETE' = 'GET'): Promise<unknown> {
    const url = resolveLsUrl(pathOrUrl);
    let rateLimited = 0;
    let transient = 0;

    for (;;) {
      if (signal?.aborted) throw abortedError();
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        result = await attempt(url, signal, method);
      } catch {
        if (signal?.aborted) throw abortedError();
        if (transient < maxTransientRetries) {
          transient += 1;
          await sleep(1000 * 2 ** (transient - 1), signal);
          continue;
        }
        throw new LsApiError('network', 'Could not reach Lemon Squeezy (network error or timeout).');
      }

      const { status, text, remaining } = result;
      if (status >= 200 && status < 300) {
        // Stay under 300 calls/minute: slow down when the window is nearly used up.
        if (remaining !== null && remaining <= 2) await sleep(5000, signal);
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new LsApiError('bad_response', 'Lemon Squeezy returned a response that is not JSON.', status);
        }
      }
      if (status === 429) {
        if (rateLimited < maxRateLimitRetries) {
          rateLimited += 1;
          await sleep(Math.min(60_000, 2000 * 2 ** (rateLimited - 1)), signal);
          continue;
        }
        throw new LsApiError('rate_limited', 'Lemon Squeezy rate limit reached. Try again in a minute.', status);
      }
      if (status === 401 || status === 403) {
        throw new LsApiError(
          'auth',
          `Lemon Squeezy rejected this API key (HTTP ${status}). Check that you copied the whole key and that it has not expired or been deleted.`,
          status,
        );
      }
      if (status === 404) throw new LsApiError('not_found', 'Lemon Squeezy returned 404 Not Found.', status);
      if (status >= 500) {
        if (transient < maxTransientRetries) {
          transient += 1;
          await sleep(1000 * 2 ** (transient - 1), signal);
          continue;
        }
        throw new LsApiError('upstream', `Lemon Squeezy is not responding normally (HTTP ${status}).`, status);
      }
      throw new LsApiError('bad_request', `Lemon Squeezy refused the request (HTTP ${status}${errorTitle(text)}).`, status);
    }
  }

  async function* paginate(firstPath: string, signal?: AbortSignal): AsyncGenerator<LsListBody> {
    const seen = new Set<string>();
    let next: string | null = firstPath;
    while (next !== null) {
      const url = resolveLsUrl(next);
      if (seen.has(url)) throw new LsApiError('bad_response', 'Lemon Squeezy pagination looped back to a page it already returned.');
      seen.add(url);
      const body = asListBody(await getJson(url, signal));
      if (!body) throw new LsApiError('bad_response', 'Lemon Squeezy returned a list response without a data array.');
      yield body;
      next = body.next;
    }
  }

  return { getJson: (p, sig) => getJson(p, sig), deleteJson: (p, sig) => getJson(p, sig, 'DELETE'), paginate };
}

/** Only the short JSON:API error title, never the full body. */
function errorTitle(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && Array.isArray(parsed.errors) && isRecord(parsed.errors[0])) {
      const title = parsed.errors[0].title;
      if (typeof title === 'string' && title.length < 120) return `: ${title}`;
    }
  } catch {
    // not JSON
  }
  return '';
}
