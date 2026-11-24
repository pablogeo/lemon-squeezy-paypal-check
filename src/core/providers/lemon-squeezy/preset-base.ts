// The part of the Lemon Squeezy preset everything needs, the CLI included: name, cutoff and the
// non-affiliation line. The site's copy (landing text, email templates) lives in ./preset.ts and is
// attached only by the server wiring (src/server/providers.ts), so editing site copy never changes
// the CLI file or its published SHA-256.
import type { ProviderPreset } from '../types';

/** LS has not published an hour; this is deliberately the early edge of the day. */
export const LEMON_SQUEEZY_CUTOFF = new Date('2027-03-31T00:00:00Z');

export const lemonSqueezyPresetBase: ProviderPreset = {
  displayName: 'Lemon Squeezy',
  cutoffAt: LEMON_SQUEEZY_CUTOFF,
  disclaimers: ['Not affiliated with Lemon Squeezy, Stripe, or PayPal.'],
  defaultEmailTemplates: [],
  landingCopy: {},
};
