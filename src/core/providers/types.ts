// Provider boundaries (BRIEF.md section 3.1).
// Naming and call-site discipline only: v1 has exactly one implementation of each
// interface (LemonSqueezySource, StripeDestination, ResendEmail). No registry, no
// dynamic loading, no base classes.

export type IntervalUnit = 'day' | 'week' | 'month' | 'year';

export type SourceState = 'paid' | 'trial' | 'unpaid' | 'paused' | 'cancelled_in_grace' | 'ended';

export type SourceSubscription = {
  sourceSubscriptionId: string;
  sourceCustomerId: string | null;
  sourceAccountId: string;
  productName: string;
  planName: string | null;
  sourceVariantId: string | null;
  sourcePriceId: string | null;
  email: string;
  name: string | null;
  state: SourceState;
  rawStatus: string;
  /** null when state is 'unpaid' or 'ended' (and 'paused'). */
  paidThrough: Date | null;
  quantity: number;
  /** null when usage-based, tiered, or unknown. */
  unitPriceCents: number | null;
  currency: string | null;
  interval: { unit: IntervalUnit; count: number } | null;
  /** The source decides what cannot migrate. */
  stranded: boolean;
  /** e.g. 'paused', 'unpaid', 'non_card_method'. Listed separately, never in the headline number. */
  needsReview: string | null;
  isTest: boolean;
};

export type SourceAccount = {
  id: string;
  name: string;
  currency: string | null;
};

export type ScanProgress = {
  accountId: string;
  pagesFetched: number;
  /** From the source's own pagination metadata, for display only. */
  lastPage: number | null;
  /** Rows the source could not read (missing required fields); counted, never guessed. */
  skippedRows: number;
};

export type EmailTemplate = {
  kind: 'step_1' | 'step_2' | 'step_3' | 'comeback';
  subject: string;
  bodyMarkdown: string;
};

export type ProviderPreset = {
  displayName: string;
  /** lemon_squeezy: 2027-03-31T00:00:00Z (no hour published; deliberately the early edge of the day). */
  cutoffAt: Date | null;
  /** Trademark / non-affiliation lines. */
  disclaimers: string[];
  /** Steps 1–3 and the come-back reminder. */
  defaultEmailTemplates: EmailTemplate[];
  landingCopy: Record<string, string>;
};

export type SourceCredentials = { apiKey: string };

export interface SourceProvider {
  /** 'lemon_squeezy' */
  id: string;
  capabilities: {
    supportsLiveRefresh: boolean;
    supportsApiCancel: boolean;
    requiresApiKey: boolean;
  };
  preset: ProviderPreset;
  // `signal` is the one addition to the brief's signatures: the checker must abort
  // in-flight upstream calls when the browser disconnects (BRIEF 5.2).
  listAccounts(creds: SourceCredentials, signal?: AbortSignal): Promise<SourceAccount[]>;
  scan(
    creds: SourceCredentials,
    accountId: string,
    onProgress?: (progress: ScanProgress) => void,
    signal?: AbortSignal,
  ): AsyncIterable<SourceSubscription>;
  /** Present iff capabilities.supportsLiveRefresh. */
  refresh?(creds: SourceCredentials, sourceSubscriptionId: string): Promise<SourceSubscription>;
  /** Present iff capabilities.supportsApiCancel. Must confirm the cancel took effect (re-read) or throw. */
  cancel?(creds: SourceCredentials, sourceSubscriptionId: string): Promise<void>;
}

// --- Destination (Milestone 2) -------------------------------------------------------------

export type DestCredentials = { apiKey: string };

export type DestPlan = {
  priceId: string;
  productName: string;
  /** Minor units; null for tiered or custom prices. */
  unitAmount: number | null;
  currency: string;
  interval: { unit: IntervalUnit; count: number };
  /** Managed Payments needs an eligible tax code on the product. */
  taxCode: string | null;
};

export type DryRunMapping = {
  priceId: string;
  priceInterval: { unit: IntervalUnit; count: number };
  couponId: string | null;
  automaticTax: boolean;
};

export type CheckoutInput = {
  destMode: 'stripe_managed' | 'stripe_standard';
  automaticTax: boolean;
  priceId: string;
  priceInterval: { unit: IntervalUnit; count: number };
  quantity: number;
  couponId: string | null;
  token: string;
  appUrl: string;
  customerEmail: string;
  metadata: {
    migration_token: string;
    source_provider: string;
    source_subscription_id: string;
    source_customer_id: string;
    campaign_id: string;
  };
  state: SourceState;
  paidThrough: Date | null;
  resolvedStrategy: 'anchor' | 'trial' | null;
  /** Sessions already created for this subscriber with the same deferral target. */
  attempt: number;
  now: Date;
};

export interface DestinationProvider {
  /** 'stripe' */
  id: string;
  validateCredentials(creds: DestCredentials): Promise<{ ok: boolean; livemode: boolean; error?: string }>;
  listPlans(creds: DestCredentials): Promise<DestPlan[]>;
  findCustomerByEmail(creds: DestCredentials, email: string): Promise<string | null>;
  dryRun(
    creds: DestCredentials,
    mapping: DryRunMapping,
    mode: 'stripe_managed' | 'stripe_standard',
  ): Promise<{ ok: boolean; strategy?: string; error?: string }>;
  createCheckout(
    creds: DestCredentials,
    input: CheckoutInput,
  ): Promise<{ sessionId: string; url: string; expiresAt: Date; strategy: string; deferralUntil: Date | null }>;
  getCheckout(
    creds: DestCredentials,
    sessionId: string,
  ): Promise<{
    status: 'open' | 'complete' | 'expired';
    destSubscriptionId?: string;
    destCustomerId?: string;
    subscriptionStatus?: string;
    clientReferenceId?: string;
    /** Present while the session is open, so it can be reused. */
    url?: string;
  }>;
  /** The new subscription, checked before the old one is cancelled automatically (BRIEF 5.6). Null if missing. */
  getSubscription(creds: DestCredentials, subscriptionId: string): Promise<{ status: string; metadata: Record<string, string> } | null>;
}

export type EmailMessage = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
};

export type EmailCredentials = { apiKey: string };

export interface EmailProvider {
  /** 'resend' */
  id: string;
  send(
    creds: EmailCredentials,
    message: EmailMessage,
    idempotencyKey: string,
  ): Promise<
    | { ok: true }
    | { ok: false; retryTomorrow: boolean; error: string; auth?: boolean; rateLimited?: boolean; monthlyQuota?: boolean }
  >;
}
