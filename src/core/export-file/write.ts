// writeExport: used by the CLI. Pure, dependency-free (bundled into the zero-dependency CLI).
import type { SourceSubscription } from '../providers/types';
import { EXPORT_SCHEMA_VERSION, type ExportAccount, type ExportFile } from './types';

/** The rows an export may contain: stranded or flagged for review, never test rows, this account only. */
export function exportableRows(rows: SourceSubscription[], accountId: string): SourceSubscription[] {
  return rows.filter((r) => !r.isTest && r.sourceAccountId === accountId && (r.stranded || r.needsReview !== null));
}

export function buildExport(input: {
  sourceProvider: string;
  account: ExportAccount;
  subscriptions: SourceSubscription[];
  now: Date;
}): ExportFile {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    sourceProvider: input.sourceProvider,
    exportedAt: input.now.toISOString(),
    account: { id: input.account.id, name: input.account.name, currency: input.account.currency },
    subscriptions: exportableRows(input.subscriptions, input.account.id),
  };
}

/** Serialises an export. Date fields become ISO strings via JSON.stringify. */
export function writeExport(input: Parameters<typeof buildExport>[0]): { json: string; file: ExportFile } {
  const file = buildExport(input);
  return { json: `${JSON.stringify(file, null, 2)}\n`, file };
}
