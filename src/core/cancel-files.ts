// Cancel list and results (BRIEF 3.1). Hand-written validation (no zod): the CLI bundles this.

export const CANCEL_SCHEMA_VERSION = 1;

/** cancel-list.json: written by the dashboard for converted subscribers not yet confirmed cancelled. */
export type CancelListItem = {
  sourceSubscriptionId: string;
  email: string;
  productName: string;
  destSubscriptionId: string;
  /** ISO 8601: the old subscription must be cancelled before this instant. */
  cancelBy: string;
};
export type CancelListFile = { schemaVersion: 1; campaignId: string; generatedAt: string; items: CancelListItem[] };

export type CancelOutcome = 'cancelled' | 'skipped' | 'failed';

export type CancelResultItem = {
  sourceSubscriptionId: string;
  outcome: CancelOutcome;
  reason?: string;
  /** The live renewal date was already later than cancelBy: the old platform renewed. */
  overlap: boolean;
};
/**
 * cancel-results.json: written by the CLI, uploaded to the dashboard. The brief specifies `items`;
 * schemaVersion, campaignId and completedAt are added so an upload can be matched to its campaign.
 */
export type CancelResultsFile = { schemaVersion: 1; campaignId: string; completedAt: string; items: CancelResultItem[] };

export const MAX_CANCEL_FILE_BYTES = 10 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 320) => typeof v === 'string' && v.length > 0 && v.length <= max;
const iso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function parseCancelList(text: string): { ok: true; file: CancelListFile } | { ok: false; error: string } {
  if (text.length > MAX_CANCEL_FILE_BYTES) return { ok: false, error: 'The file is larger than 10 MB.' };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not JSON.' };
  }
  if (!isObj(v) || v.schemaVersion !== CANCEL_SCHEMA_VERSION || !str(v.campaignId, 64) || !iso(v.generatedAt) || !Array.isArray(v.items)) {
    return { ok: false, error: 'This is not a cancel list from the dashboard.' };
  }
  for (const [i, it] of v.items.entries()) {
    if (!isObj(it) || !str(it.sourceSubscriptionId, 128) || !str(it.email) || !str(it.productName, 500) || !str(it.destSubscriptionId, 255) || !iso(it.cancelBy)) {
      return { ok: false, error: `Item ${i + 1} is incomplete.` };
    }
  }
  return { ok: true, file: v as unknown as CancelListFile };
}

export function parseCancelResults(text: string): { ok: true; file: CancelResultsFile } | { ok: false; error: string } {
  if (text.length > MAX_CANCEL_FILE_BYTES) return { ok: false, error: 'The file is larger than 10 MB.' };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not JSON.' };
  }
  if (!isObj(v) || v.schemaVersion !== CANCEL_SCHEMA_VERSION || !str(v.campaignId, 64) || !iso(v.completedAt) || !Array.isArray(v.items)) {
    return { ok: false, error: 'This is not a cancel-results file from the CLI.' };
  }
  for (const [i, it] of v.items.entries()) {
    if (
      !isObj(it) ||
      !str(it.sourceSubscriptionId, 128) ||
      !['cancelled', 'skipped', 'failed'].includes(String(it.outcome)) ||
      typeof it.overlap !== 'boolean' ||
      (it.reason !== undefined && !str(it.reason, 500))
    ) {
      return { ok: false, error: `Result ${i + 1} is malformed.` };
    }
  }
  return { ok: true, file: v as unknown as CancelResultsFile };
}
