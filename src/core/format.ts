// Formatting shared by the web checker and the CLI.

export function formatMoney(cents: number, currency: string | null): string {
  const amount = cents / 100;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
    } catch {
      // Unknown ISO code: fall through.
    }
  }
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

export function formatDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
}

/** "Nov 26, 2026, 16:02 UTC" */
export function formatDateTimeUtc(d: Date): string {
  return `${formatDate(d)}, ${d.toISOString().slice(11, 16)} UTC`;
}

export function formatPct(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

export const NEEDS_REVIEW_LABELS: Record<string, string> = {
  paused: 'PayPal subscriptions that are paused',
  unpaid: 'PayPal subscriptions marked unpaid (payment retries exhausted)',
  non_card_method:
    'Stripe-processed subscriptions paid without a card (e.g. Cash App Pay). Only relevant if you are leaving Stripe.',
  unknown_status: 'Subscriptions with a status this tool does not recognise',
  unknown_processor: 'Live subscriptions with an unrecognised payment processor',
};
