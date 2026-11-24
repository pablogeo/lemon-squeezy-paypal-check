// LemonSqueezySource (BRIEF 3.1, 5.1). Milestone 1 implements listAccounts + scan.
// refresh() arrives in Milestone 2 and cancel() in Milestone 3.
import type { ScanProgress, SourceAccount, SourceCredentials, SourceProvider, SourceSubscription } from '../types';
import { createLsClient, LsApiError, type FetchLike, type LsClient, type Sleep } from './client';
import { asSingleData, parsePrice, parseStore, parseSubscription, type LsPrice } from './guards';
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
  const priceById = new Map<string, Promise<LsPrice | null>>();
  const newestPriceByVariant = new Map<string, Promise<LsPrice | null>>();

  const lookupPrice = (priceId: string) => {
    let p = priceById.get(priceId);
    if (!p) {
      p = softFail(async () => parsePrice(asSingleData(await client.getJson(`/v1/prices/${encodeURIComponent(priceId)}`, signal))));
      priceById.set(priceId, p);
    }
    return p;
  };
  const lookupNewestVariantPrice = (variantId: string) => {
    let p = newestPriceByVariant.get(variantId);
    if (!p) {
      p = softFail(async () => {
        const found: LsPrice[] = [];
        const path = `/v1/prices?filter[variant_id]=${encodeURIComponent(variantId)}&page[size]=100`;
        for await (const page of client.paginate(path, signal)) {
          for (const item of page.data) {
            const price = parsePrice(item);
            if (price) found.push(price);
          }
        }
        return newestPrice(found);
      });
      newestPriceByVariant.set(variantId, p);
    }
    return p;
  };

  let pagesFetched = 0;
  let skippedRows = 0;
  const path = `/v1/subscriptions?filter[store_id]=${encodeURIComponent(accountId)}&page[size]=100`;
  for await (const page of client.paginate(path, signal)) {
    pagesFetched += 1;
    const rows = [];
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
      let priceId = sub.firstItem?.priceId ?? null;
      let price: LsPrice | null = null;
      if (wantsPrice) {
        if (sub.firstItem && priceId) {
          price = await lookupPrice(priceId);
        } else if (!sub.firstItem && sub.variantId) {
          // No subscription item (e.g. free trial): the variant's newest price, quantity 1.
          price = await lookupNewestVariantPrice(sub.variantId);
          priceId = price?.id ?? null;
        }
      }
      yield normalizeSubscription({
        sub,
        price,
        priceId,
        quantity: sub.firstItem?.quantity ?? 1,
        currency,
        now: scanNow,
      });
    }
  }
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
  const candidates = prices.some((p) => p.category === 'subscription')
    ? prices.filter((p) => p.category === 'subscription')
    : prices;
  let best: LsPrice | null = null;
  for (const p of candidates) {
    if (best === null || compareNewest(p, best) > 0) best = p;
  }
  return best;
}

function compareNewest(a: LsPrice, b: LsPrice): number {
  const ta = a.createdAt?.getTime() ?? -Infinity;
  const tb = b.createdAt?.getTime() ?? -Infinity;
  if (ta !== tb) return ta - tb;
  return Number(a.id) - Number(b.id);
}
