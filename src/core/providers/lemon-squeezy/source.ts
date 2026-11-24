// LemonSqueezySource (BRIEF 3.1, 5.1). The same code runs in the CLI (check, export, cancel) and,
// for one-time-key and connected campaigns, on the server.
import type { ScanProgress, SourceAccount, SourceCredentials, SourceProvider, SourceSubscription } from '../types';
import { createLsClient, LsApiError, type FetchLike, type LsClient, type Sleep } from './client';
import { asSingleData, parsePrice, parseStore, parseSubscription, type LsPrice, type LsSubscription } from './guards';
import { classify, normalizeSubscription } from './normalize';
import { lemonSqueezyPreset } from './preset';

export const LEMON_SQUEEZY_ID = 'lemon_squeezy';

export type LemonSqueezySourceOptions = {
  /** Injected in tests, the demo, and the CLI's mock run. Defaults to global fetch. */
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: () => Date;
  timeoutMs?: number;
};

type PriceCache = { byId: Map<string, Promise<LsPrice | null>>; byVariant: Map<string, Promise<LsPrice | null>> };

/** A missing or unreadable price makes that row "MRR unknown"; it does not fail the scan. Auth and abort still do. */
async function softFail(fn: () => Promise<LsPrice | null>): Promise<LsPrice | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LsApiError && (err.kind === 'auth' || err.kind === 'aborted')) throw err;
    return null;
  }
}

export function newestPrice(prices: LsPrice[]): LsPrice | null {
  const candidates = prices.some((p) => p.category === 'subscription') ? prices.filter((p) => p.category === 'subscription') : prices;
  let best: LsPrice | null = null;
  for (const p of candidates) {
    const tp = p.createdAt?.getTime() ?? -Infinity;
    const tb = best?.createdAt?.getTime() ?? -Infinity;
    if (best === null || tp > tb || (tp === tb && Number(p.id) > Number(best.id))) best = p;
  }
  return best;
}

/** The subscription item's price (possibly grandfathered), or the variant's newest price with quantity 1. */
async function resolvePrice(client: LsClient, sub: LsSubscription, cache: PriceCache, signal?: AbortSignal) {
  let priceId = sub.firstItem?.priceId ?? null;
  let price: LsPrice | null = null;
  if (sub.firstItem && priceId) {
    const id = priceId;
    let p = cache.byId.get(id);
    if (!p) {
      p = softFail(async () => parsePrice(asSingleData(await client.getJson(`/v1/prices/${encodeURIComponent(id)}`, signal))));
      cache.byId.set(id, p);
    }
    price = await p;
  } else if (!sub.firstItem && sub.variantId) {
    const variantId = sub.variantId;
    let p = cache.byVariant.get(variantId);
    if (!p) {
      p = softFail(async () => {
        const found: LsPrice[] = [];
        for await (const page of client.paginate(`/v1/prices?filter[variant_id]=${encodeURIComponent(variantId)}&page[size]=100`, signal)) {
          for (const item of page.data) {
            const pr = parsePrice(item);
            if (pr) found.push(pr);
          }
        }
        return newestPrice(found);
      });
      cache.byVariant.set(variantId, p);
    }
    price = await p;
    priceId = price?.id ?? null;
  }
  return { price, priceId, quantity: sub.firstItem?.quantity ?? 1 };
}

async function storeCurrency(client: LsClient, accountId: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const store = parseStore(asSingleData(await client.getJson(`/v1/stores/${encodeURIComponent(accountId)}`, signal)));
    return store?.currency ?? null;
  } catch (err) {
    if (err instanceof LsApiError && err.kind === 'not_found') return null;
    throw err;
  }
}

async function readSubscription(client: LsClient, id: string, signal?: AbortSignal): Promise<LsSubscription> {
  const sub = parseSubscription(asSingleData(await client.getJson(`/v1/subscriptions/${encodeURIComponent(id)}`, signal)));
  if (!sub) throw new LsApiError('bad_response', 'Lemon Squeezy returned an unreadable subscription.');
  return sub;
}

export function createLemonSqueezySource(options: LemonSqueezySourceOptions = {}): SourceProvider {
  const now = options.now ?? (() => new Date());
  const clientFor = (creds: SourceCredentials): LsClient =>
    createLsClient(creds.apiKey, { fetch: options.fetch, sleep: options.sleep, timeoutMs: options.timeoutMs });

  return {
    id: LEMON_SQUEEZY_ID,
    capabilities: { supportsLiveRefresh: true, supportsApiCancel: true, requiresApiKey: true },
    preset: lemonSqueezyPreset,

    async listAccounts(creds, signal) {
      const client = clientFor(creds);
      const accounts: SourceAccount[] = [];
      for await (const page of client.paginate('/v1/stores?page[size]=100', signal)) {
        for (const item of page.data) {
          const store = parseStore(item);
          if (store) accounts.push({ id: store.id, name: store.name, currency: store.currency });
        }
      }
      return accounts;
    },

    scan(creds, accountId, onProgress, signal) {
      return scanStore(clientFor(creds), accountId, now(), onProgress, signal);
    },

    /** One subscription, live (connected mode at click time, the CLI before cancelling). */
    async refresh(creds, sourceSubscriptionId) {
      const client = clientFor(creds);
      const signal = AbortSignal.timeout(options.timeoutMs ?? 5_000);
      const sub = await readSubscription(client, sourceSubscriptionId, signal);
      const { price, priceId, quantity } = await resolvePrice(client, sub, { byId: new Map(), byVariant: new Map() }, signal);
      const currency = await storeCurrency(client, sub.storeId, signal);
      return normalizeSubscription({ sub, price, priceId, quantity, currency, now: now() });
    },

    /**
     * DELETE, then read the subscription back: it counts as cancelled only if Lemon Squeezy now
     * shows it cancelled. (Its docs do not say whether DELETE works for PayPal subscriptions, so
     * the result is never assumed; see docs/API_NOTES.md.)
     */
    async cancel(creds, sourceSubscriptionId) {
      const client = clientFor(creds);
      await client.deleteJson(`/v1/subscriptions/${encodeURIComponent(sourceSubscriptionId)}`);
      const after = await readSubscription(client, sourceSubscriptionId);
      if (!after.cancelled && after.status !== 'cancelled' && after.status !== 'expired') {
        throw new LsApiError(
          'not_cancelled',
          'Lemon Squeezy did not cancel this subscription. Cancel it by hand in the Lemon Squeezy dashboard.',
        );
      }
    },
  };
}

async function* scanStore(
  client: LsClient,
  accountId: string,
  scanNow: Date,
  onProgress: ((p: ScanProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): AsyncGenerator<SourceSubscription> {
  const currency = await storeCurrency(client, accountId, signal);
  const cache: PriceCache = { byId: new Map(), byVariant: new Map() };
  let pagesFetched = 0;
  let skippedRows = 0;
  const path = `/v1/subscriptions?filter[store_id]=${encodeURIComponent(accountId)}&page[size]=100`;
  for await (const page of client.paginate(path, signal)) {
    pagesFetched += 1;
    const rows: LsSubscription[] = [];
    for (const item of page.data) {
      const sub = parseSubscription(item);
      if (sub) rows.push(sub);
      else skippedRows += 1;
    }
    onProgress?.({ accountId, pagesFetched, lastPage: page.lastPage, skippedRows });

    for (const sub of rows) {
      const { stranded, needsReview } = classify(sub);
      // Prices are resolved only for rows anyone will look at: live, non-test, stranded or flagged.
      const wantsPrice = !sub.testMode && (stranded || needsReview !== null);
      const resolved = wantsPrice
        ? await resolvePrice(client, sub, cache, signal)
        : { price: null, priceId: sub.firstItem?.priceId ?? null, quantity: sub.firstItem?.quantity ?? 1 };
      yield normalizeSubscription({ sub, ...resolved, currency, now: scanNow });
    }
  }
}
