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
  step: 1 | 2 | 3;
  subject: string;
  bodyMarkdown: string;
};

export type ProviderPreset = {
  displayName: string;
  /** lemon_squeezy: 2027-03-31T00:00:00Z (no hour published; deliberately the early edge of the day). */
  cutoffAt: Date | null;
  /** Trademark / non-affiliation lines. */
  disclaimers: string[];
  /** Steps 1–3. */
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
  /** Present iff capabilities.supportsLiveRefresh. Milestone 2. */
  refresh?(creds: SourceCredentials, sourceSubscriptionId: string): Promise<SourceSubscription>;
  /** Present iff capabilities.supportsApiCancel. Milestone 3. */
  cancel?(creds: SourceCredentials, sourceSubscriptionId: string): Promise<void>;
}

// --- Milestone 2 / 3 interfaces. Declared now so the names are final; no implementation yet. ---

export type DestPlan = {
  priceId: string;
  productName: string;
  unitAmount: number | null;
  currency: string;
  interval: { unit: IntervalUnit; count: number };
};

export interface DestinationProvider {
  /** 'stripe' */
  id: string;
  validateCredentials(creds: unknown): Promise<{ ok: boolean; livemode: boolean; error?: string }>;
  listPlans(creds: unknown): Promise<DestPlan[]>;
  findCustomerByEmail(creds: unknown, email: string): Promise<string | null>;
  dryRun(creds: unknown, mapping: unknown, mode: string): Promise<{ ok: boolean; strategy?: string; error?: string }>;
  createCheckout(
    creds: unknown,
    input: unknown,
  ): Promise<{ sessionId: string; url: string; expiresAt: Date; strategy: string; deferralUntil: Date | null }>;
  getCheckout(
    creds: unknown,
    sessionId: string,
  ): Promise<{
    status: 'open' | 'complete' | 'expired';
    destSubscriptionId?: string;
    destCustomerId?: string;
    subscriptionStatus?: string;
  }>;
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

export interface EmailProvider {
  /** 'resend' */
  id: string;
  send(
    creds: unknown,
    message: EmailMessage,
    idempotencyKey: string,
  ): Promise<{ ok: true } | { ok: false; retryTomorrow: boolean; error: string }>;
}
