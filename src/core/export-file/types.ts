// Export file (BRIEF 3.1): what the CLI writes in `local` mode and the server reads on upload.
// Provider-neutral. Dates are ISO 8601 strings on disk and Date objects in memory.
import type { SourceSubscription } from '../providers/types';

export const EXPORT_SCHEMA_VERSION = 1;
/** BRIEF 7: uploads are size-limited (default 10 MB). */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
export const MAX_EXPORT_ROWS = 100_000;

export type ExportAccount = { id: string; name: string; currency: string | null };

export type ExportFile = {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  sourceProvider: string;
  /** ISO 8601 */
  exportedAt: string;
  account: ExportAccount;
  /** Only rows where `stranded` is true or `needsReview` is set; never test rows. */
  subscriptions: SourceSubscription[];
};
