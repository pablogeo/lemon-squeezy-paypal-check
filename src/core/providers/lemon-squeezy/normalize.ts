// Lemon Squeezy record → normalized SourceSubscription (BRIEF 3.1 state mapping, 5.1 detection).
import type { IntervalUnit, SourceState, SourceSubscription } from '../types';
import type { LsPrice, LsSubscription } from './guards';

/** Statuses that still renew. Stranded = PayPal + not cancelled + one of these. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'on_trial', 'past_due']);

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'on_trial',
  'active',
  'paused',
  'past_due',
  'unpaid',
  'cancelled',
  'expired',
]);

export function mapState(status: string, endsAt: Date | null, now: Date): SourceState {
  switch (status) {
    case 'active':
      return 'paid';
    case 'on_trial':
      return 'trial';
    case 'past_due':
    case 'unpaid':
      return 'unpaid';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return endsAt !== null && endsAt.getTime() > now.getTime() ? 'cancelled_in_grace' : 'ended';
    case 'expired':
      return 'ended';
    default:
      // Unknown future status: never stranded, listed under "needs review".
      return 'ended';
  }
}

export function paidThroughFor(state: SourceState, renewsAt: Date | null, endsAt: Date | null): Date | null {
  if (state === 'paid' || state === 'trial') return renewsAt;
  if (state === 'cancelled_in_grace') return endsAt;
  return null;
}

export function classify(sub: Pick<LsSubscription, 'status' | 'cancelled' | 'paymentProcessor' | 'cardBrand'>): {
  stranded: boolean;
  needsReview: string | null;
} {
  const live = LIVE_STATUSES.has(sub.status) && !sub.cancelled;
  if (!KNOWN_STATUSES.has(sub.status)) return { stranded: false, needsReview: 'unknown_status' };

  if (sub.paymentProcessor === 'paypal') {
    if (live) return { stranded: true, needsReview: null };
    if (sub.status === 'paused') return { stranded: false, needsReview: 'paused' };
    if (sub.status === 'unpaid') return { stranded: false, needsReview: 'unpaid' };
    return { stranded: false, needsReview: null };
  }
  if (sub.paymentProcessor === 'stripe') {
    // Non-card methods (e.g. Cash App Pay) only matter if the seller is leaving Stripe.
    if (live && sub.cardBrand === null) return { stranded: false, needsReview: 'non_card_method' };
    return { stranded: false, needsReview: null };
  }
  // Docs say only 'stripe' | 'paypal'; anything else is surfaced, not guessed.
  return { stranded: false, needsReview: live ? 'unknown_processor' : null };
}

const INTERVAL_UNITS: ReadonlySet<string> = new Set(['day', 'week', 'month', 'year']);

export function priceTerms(price: LsPrice | null): {
  unitPriceCents: number | null;
  interval: { unit: IntervalUnit; count: number } | null;
} {
  if (!price) return { unitPriceCents: null, interval: null };
  const q = price.renewalIntervalQuantity;
  const interval =
    price.renewalIntervalUnit !== null &&
    INTERVAL_UNITS.has(price.renewalIntervalUnit) &&
    q !== null &&
    Number.isInteger(q) &&
    q > 0
      ? { unit: price.renewalIntervalUnit as IntervalUnit, count: q }
      : null;

  // Only a standard, non-usage-based subscription price has a single unit price.
  // package / graduated / volume and usage-based prices are reported as "MRR unknown".
  const flat =
    price.category === 'subscription' &&
    price.scheme === 'standard' &&
    price.usageAggregation === null &&
    price.unitPrice !== null &&
    Number.isInteger(price.unitPrice) &&
    price.unitPrice >= 0;

  return { unitPriceCents: flat ? price.unitPrice : null, interval };
}

export function normalizeSubscription(input: {
  sub: LsSubscription;
  price: LsPrice | null;
  priceId: string | null;
  quantity: number;
  currency: string | null;
  now: Date;
}): SourceSubscription {
  const { sub, price, priceId, quantity, currency, now } = input;
  const state = mapState(sub.status, sub.endsAt, now);
  const { stranded, needsReview } = classify(sub);
  const { unitPriceCents, interval } = priceTerms(price);
  return {
    sourceSubscriptionId: sub.id,
    sourceCustomerId: sub.customerId,
    sourceAccountId: sub.storeId,
    productName: sub.productName,
    planName: sub.variantName,
    sourceVariantId: sub.variantId,
    sourcePriceId: priceId,
    email: sub.userEmail,
    name: sub.userName,
    state,
    rawStatus: sub.status,
    paidThrough: paidThroughFor(state, sub.renewsAt, sub.endsAt),
    quantity,
    unitPriceCents,
    currency,
    interval,
    stranded,
    needsReview,
    isTest: sub.testMode,
  };
}
