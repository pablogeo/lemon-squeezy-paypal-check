// One check run: list the key's stores, scan each, build the report. Used by the web checker
// (with page/time limits and client-disconnect abort) and by the CLI (no limits).
import { buildCheckerReport, type CheckerReport } from './report';
import type { SourceCredentials, SourceProvider, SourceSubscription } from './providers/types';

export type CheckProgress = {
  accountId: string;
  accountName: string;
  pagesFetched: number;
  lastPage: number | null;
  totalPages: number;
};

export class CheckAbortedError extends Error {
  constructor() {
    super('The check was cancelled.');
    this.name = 'CheckAbortedError';
  }
}

export async function runCheck(options: {
  source: SourceProvider;
  creds: SourceCredentials;
  now: Date;
  /** Stop after this many subscription pages and return a partial report. */
  maxPages?: number;
  /** Stop after this many milliseconds and return a partial report. */
  maxMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: CheckProgress) => void;
}): Promise<CheckerReport> {
  const { source, creds, now } = options;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (options.signal?.aborted) throw new CheckAbortedError();
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  // Mutable box: the timer callback writes it, so TypeScript must not narrow it away.
  const stop: { reason: 'page_limit' | 'time_limit' | null } = { reason: null };
  const timer =
    options.maxMs !== undefined
      ? setTimeout(() => {
          stop.reason ??= 'time_limit';
          ctrl.abort();
        }, options.maxMs)
      : null;

  const subscriptions: SourceSubscription[] = [];
  let accounts: Awaited<ReturnType<SourceProvider['listAccounts']>> = [];
  let totalPages = 0;
  let skippedRows = 0;

  try {
    accounts = await source.listAccounts(creds, ctrl.signal);
    for (const account of accounts) {
      let accountSkipped = 0;
      let pageLimitHit = false;
      const rows = source.scan(
        creds,
        account.id,
        (p) => {
          totalPages += 1;
          accountSkipped = p.skippedRows;
          if (options.maxPages !== undefined && totalPages > options.maxPages) {
            pageLimitHit = true;
            return;
          }
          options.onProgress?.({
            accountId: account.id,
            accountName: account.name,
            pagesFetched: p.pagesFetched,
            lastPage: p.lastPage,
            totalPages,
          });
        },
        ctrl.signal,
      );
      for await (const row of rows) {
        if (pageLimitHit) break; // rows from the page past the limit are discarded
        subscriptions.push(row);
      }
      skippedRows += accountSkipped;
      if (pageLimitHit) {
        stop.reason = 'page_limit';
        break;
      }
    }
  } catch (err) {
    if (options.signal?.aborted) throw new CheckAbortedError();
    if (!(ctrl.signal.aborted && stop.reason === 'time_limit')) throw err;
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }

  return buildCheckerReport({
    accounts,
    subscriptions,
    now,
    cutoffAt: source.preset.cutoffAt,
    partialReason: stop.reason,
    skippedRows,
  });
}
