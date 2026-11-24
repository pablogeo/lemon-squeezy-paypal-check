// Normalized monthly value (BRIEF 5.1): unitPriceCents × quantity × factor, where
// month → 1/q, year → 1/(12q), week → 4.348214/q, day → 30.4375/q (q = interval count).
import type { IntervalUnit, SourceSubscription } from './providers/types';

export const MONTHLY_FACTOR: Readonly<Record<IntervalUnit, number>> = {
  month: 1,
  year: 1 / 12,
  week: 4.348214,
  day: 30.4375,
};

export function monthlyFactor(interval: { unit: IntervalUnit; count: number }): number {
  return MONTHLY_FACTOR[interval.unit] / interval.count;
}

/** Exact (unrounded) monthly value in cents, or null when the price is unknown or usage-based. */
export function monthlyValueCents(
  sub: Pick<SourceSubscription, 'unitPriceCents' | 'quantity' | 'interval'>,
): number | null {
  if (sub.unitPriceCents === null || sub.interval === null) return null;
  return sub.unitPriceCents * sub.quantity * monthlyFactor(sub.interval);
}
