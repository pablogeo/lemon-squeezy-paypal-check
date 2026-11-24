// The free checker's report, shared by the web checker and the CLI. Pure and JSON-serializable.
import { monthlyValueCents } from './mrr';
import type { SourceAccount, SourceSubscription } from './providers/types';

export type PlanBreakdown = {
  productName: string;
  planName: string | null;
  sourceVariantId: string | null;
  count: number;
  /** Rounded sum over rows with a known price. */
  monthlyValueCents: number;
  mrrUnknownCount: number;
};

export type WeekBucket = {
  /** Monday, UTC, YYYY-MM-DD. */
  weekStart: string;
  count: number;
  monthlyValueCents: number;
};

export type StoreReport = {
  accountId: string;
  accountName: string;
  currency: string | null;
  /** Live (paying, trialing, or in payment retry), non-test subscriptions on any processor. */
  liveCount: number;
  strandedCount: number;
  /** Stranded share of live subscriptions, 0–100, one decimal. null when there are none. */
  paypalSharePct: number | null;
  /** List price, in store currency, before discounts and tax. */
  strandedMrrCents: number;
  /** Stranded rows whose price is usage-based, tiered or unknown: excluded from the MRR sum. */
  mrrUnknownCount: number;
  byPlan: PlanBreakdown[];
  /** Stranded subscribers by the week their paid period ends, from this week to the cutoff week. */
  renewalWeeks: WeekBucket[];
  /** Stranded subscribers whose payment is being retried (no paid-through date). */
  inPaymentRetryCount: number;
  /** Stranded subscribers already paid through beyond the cutoff. */
  paidBeyondCutoffCount: number;
  /** Listed separately, never in the headline number. */
  needsReview: Record<string, number>;
};

export type CheckerReport = {
  generatedAt: string;
  cutoffAt: string | null;
  partial: boolean;
  partialReason: 'page_limit' | 'time_limit' | null;
  /** Every row was a test-mode row: the user pasted a test-mode key. */
  testModeOnly: boolean;
  testRowsIgnored: number;
  /** Rows the source could not read. */
  skippedRows: number;
  stores: StoreReport[];
  totals: {
    strandedCount: number;
    liveCount: number;
    /** currency code (or "unknown") → rounded cents */
    mrrByCurrency: Record<string, number>;
  };
};

const DAY_MS = 86_400_000;

export function weekStartUtc(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - dow * DAY_MS);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const LIVE_STATES = new Set(['paid', 'trial', 'unpaid']);

export function buildStoreReport(
  account: SourceAccount,
  rows: SourceSubscription[],
  now: Date,
  cutoffAt: Date | null,
): StoreReport {
  const live = rows.filter((r) => LIVE_STATES.has(r.state));
  const stranded = rows.filter((r) => r.stranded);

  let mrrExact = 0;
  let mrrUnknownCount = 0;
  const plans = new Map<string, PlanBreakdown & { exact: number }>();
  const needsReview: Record<string, number> = {};

  for (const r of rows) {
    if (r.needsReview) needsReview[r.needsReview] = (needsReview[r.needsReview] ?? 0) + 1;
  }

  // Weekly timeline: this week through the cutoff week (or 52 weeks without a cutoff).
  const firstWeek = weekStartUtc(now);
  const lastWeek = cutoffAt ? weekStartUtc(new Date(cutoffAt.getTime() - 1)) : new Date(firstWeek.getTime() + 51 * 7 * DAY_MS);
  const weeks = new Map<string, { count: number; exact: number }>();
  for (let t = firstWeek.getTime(); t <= lastWeek.getTime(); t += 7 * DAY_MS) {
    weeks.set(isoDay(new Date(t)), { count: 0, exact: 0 });
  }

  let inPaymentRetryCount = 0;
  let paidBeyondCutoffCount = 0;

  for (const r of stranded) {
    const value = monthlyValueCents(r);
    if (value === null) mrrUnknownCount += 1;
    else mrrExact += value;

    const key = `${r.productName}\u0000${r.planName ?? ''}\u0000${r.sourceVariantId ?? ''}`;
    const plan = plans.get(key) ?? {
      productName: r.productName,
      planName: r.planName,
      sourceVariantId: r.sourceVariantId,
      count: 0,
      monthlyValueCents: 0,
      mrrUnknownCount: 0,
      exact: 0,
    };
    plan.count += 1;
    if (value === null) plan.mrrUnknownCount += 1;
    else plan.exact += value;
    plans.set(key, plan);

    if (r.paidThrough === null) {
      inPaymentRetryCount += 1;
    } else if (cutoffAt && r.paidThrough.getTime() >= cutoffAt.getTime()) {
      paidBeyondCutoffCount += 1;
    } else {
      // Anything already past (stale data) lands in the current week.
      const wk = isoDay(weekStartUtc(r.paidThrough < now ? now : r.paidThrough));
      const bucket = weeks.get(wk);
      if (bucket) {
        bucket.count += 1;
        bucket.exact += value ?? 0;
      }
    }
  }

  const byPlan = [...plans.values()]
    .map(({ exact, ...p }) => ({ ...p, monthlyValueCents: Math.round(exact) }))
    .sort((a, b) => b.count - a.count || b.monthlyValueCents - a.monthlyValueCents);

  return {
    accountId: account.id,
    accountName: account.name,
    currency: account.currency,
    liveCount: live.length,
    strandedCount: stranded.length,
    paypalSharePct: live.length ? Math.round((stranded.length / live.length) * 1000) / 10 : null,
    strandedMrrCents: Math.round(mrrExact),
    mrrUnknownCount,
    byPlan,
    renewalWeeks: [...weeks.entries()].map(([weekStart, b]) => ({
      weekStart,
      count: b.count,
      monthlyValueCents: Math.round(b.exact),
    })),
    inPaymentRetryCount,
    paidBeyondCutoffCount,
    needsReview,
  };
}

export function buildCheckerReport(input: {
  accounts: SourceAccount[];
  subscriptions: SourceSubscription[];
  now: Date;
  cutoffAt: Date | null;
  partialReason?: 'page_limit' | 'time_limit' | null;
  skippedRows?: number;
}): CheckerReport {
  const { accounts, subscriptions, now, cutoffAt } = input;
  const real = subscriptions.filter((s) => !s.isTest);
  const testRowsIgnored = subscriptions.length - real.length;

  const stores = accounts.map((account) =>
    buildStoreReport(
      account,
      real.filter((s) => s.sourceAccountId === account.id),
      now,
      cutoffAt,
    ),
  );

  const mrrByCurrency: Record<string, number> = {};
  for (const s of stores) {
    if (s.strandedCount === 0) continue;
    const cur = s.currency ?? 'unknown';
    mrrByCurrency[cur] = (mrrByCurrency[cur] ?? 0) + s.strandedMrrCents;
  }

  return {
    generatedAt: now.toISOString(),
    cutoffAt: cutoffAt ? cutoffAt.toISOString() : null,
    partial: Boolean(input.partialReason),
    partialReason: input.partialReason ?? null,
    testModeOnly: subscriptions.length > 0 && real.length === 0,
    testRowsIgnored,
    skippedRows: input.skippedRows ?? 0,
    stores,
    totals: {
      strandedCount: stores.reduce((n, s) => n + s.strandedCount, 0),
      liveCount: stores.reduce((n, s) => n + s.liveCount, 0),
      mrrByCurrency,
    },
  };
}
