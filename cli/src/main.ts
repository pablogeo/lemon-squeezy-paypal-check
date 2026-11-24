// Lemon Squeezy PayPal subscriber check: command-line version.
// Bundled into one unminified file with zero runtime dependencies (Node.js 18+).
// It talks only to https://api.lemonsqueezy.com (and api.stripe.com, only to verify a cancel when
// you give it your restricted key), never writes an API key to disk, and never contacts our server.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { BRAND_NAME, CLI_FILE_NAME, CLI_VERSION, SITE_URL } from '@/config/brand';
import { parseCancelList, type CancelListItem, type CancelResultItem, type CancelResultsFile } from '@/core/cancel-files';
import { CheckAbortedError, runCheck } from '@/core/checker';
import { writeExport } from '@/core/export-file/write';
import { formatDate, formatMoney, formatPct, NEEDS_REVIEW_LABELS } from '@/core/format';
import { createLemonSqueezySource } from '@/core/providers/lemon-squeezy/source';
import type { SourceAccount, SourceProvider, SourceSubscription } from '@/core/providers/types';
import type { CheckerReport, StoreReport } from '@/core/report';

const MRR_LABEL = 'list price, in store currency, before discounts and tax';

const HELP = `Lemon Squeezy PayPal subscriber check (${BRAND_NAME} CLI v${CLI_VERSION})

Usage:
  node ${CLI_FILE_NAME} [check] [--json]
  node ${CLI_FILE_NAME} export [--out stranded.json] [--store <id>]
  node ${CLI_FILE_NAME} cancel cancel-list.json [--yes] [--no-verify] [--out cancel-results.json]

Commands:
  check     (default) print the report: PayPal subscribers, revenue at stake, renewals by week.
            Nothing leaves your machine.
  export    write the stranded subscribers of one store to a file you upload to your campaign.
  cancel    cancel the old subscriptions of customers who already re-subscribed, from the
            cancel-list.json your dashboard gives you. Each one is re-checked with Lemon Squeezy
            (and with Stripe when STRIPE_API_KEY holds your restricted key) before anything is
            deleted, and you confirm the final list. Writes cancel-results.json to upload.

The API key is read from LEMONSQUEEZY_API_KEY, or asked for at a hidden prompt. It is never
written to disk. Lemon Squeezy keys are full-access: create a dedicated key, delete it afterwards.

Options:
  --json        (check) print the report as JSON
  --out <file>  (export) where to write the file, default stranded.json
  --store <id>  (export) which store, when the key can see more than one
  --yes         (cancel) skip the confirmation prompt
  --no-verify   (cancel) proceed without checking Stripe (not recommended)
  --out <file>  (cancel) where to write the results, default cancel-results.json
  --help        show this help
  --version     show the version
`;

type Args = {
  command: 'check' | 'export' | 'cancel';
  json: boolean;
  out: string;
  store: string | null;
  file: string | null;
  yes: boolean;
  noVerify: boolean;
};

class UsageError extends Error {}

function parseArgs(argv: string[]): Args | 'help' | 'version' {
  const args: Args = { command: 'check', json: false, out: 'stranded.json', store: null, file: null, yes: false, noVerify: false };
  const rest = [...argv];
  if (rest[0] === 'check' || rest[0] === 'export' || rest[0] === 'cancel') args.command = rest.shift() as Args['command'];
  if (args.command === 'cancel') args.out = 'cancel-results.json';
  while (rest.length) {
    const a = rest.shift()!;
    if (a === '--help' || a === '-h' || a === 'help') return 'help';
    if (a === '--version') return 'version';
    if (a === '--json' && args.command === 'check') args.json = true;
    else if (args.command === 'cancel' && a === '--yes') args.yes = true;
    else if (args.command === 'cancel' && a === '--no-verify') args.noVerify = true;
    else if (args.command === 'cancel' && !a.startsWith('--') && !args.file) args.file = a;
    else if (args.command === 'cancel' && a === '--out') {
      const v = rest.shift();
      if (!v || v.startsWith('--')) throw new UsageError('--out needs a value');
      args.out = v;
    } else if ((a === '--out' || a === '--store') && args.command === 'export') {
      const v = rest.shift();
      if (!v || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      if (a === '--out') args.out = v;
      else args.store = v;
    } else throw new UsageError(`Unknown option for ${args.command}: ${a}`);
  }
  return args;
}

function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    // Piped input: take the first line.
    return new Promise((done) => {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk: string) => (data += chunk));
      stdin.on('end', () => done(data.split(/\r?\n/)[0]?.trim() ?? ''));
    });
  }
  return new Promise((done, fail) => {
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          return done(value.trim());
        }
        if (ch === '\u0003') {
          finish();
          return fail(new Error('cancelled'));
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

function bar(n: number, max: number, width = 24): string {
  return '#'.repeat(max ? Math.max(n ? 1 : 0, Math.round((n / max) * width)) : 0);
}

function storeText(s: StoreReport, cutoffAt: string | null, lines: string[]): void {
  lines.push(`Store: ${s.accountName}${s.currency ? ` (${s.currency})` : ''}  [id ${s.accountId}]`);
  lines.push(
    `  PayPal subscribers who must re-subscribe: ${s.strandedCount} of ${s.liveCount} live subscriptions (${formatPct(s.paypalSharePct)})`,
  );
  lines.push(`  Monthly revenue at stake: ${formatMoney(s.strandedMrrCents, s.currency)}  (${MRR_LABEL})`);
  if (s.mrrUnknownCount) lines.push(`  Not included above: ${s.mrrUnknownCount} on usage-based, tiered or unreadable prices`);
  if (s.inPaymentRetryCount) lines.push(`  Past due (payment being retried): ${s.inPaymentRetryCount}`);
  if (cutoffAt && s.paidBeyondCutoffCount)
    lines.push(`  Already paid through after ${formatDate(cutoffAt)}: ${s.paidBeyondCutoffCount}`);

  if (s.byPlan.length) {
    lines.push('', '  By plan:');
    const width = Math.min(40, Math.max(...s.byPlan.map((p) => `${p.productName} · ${p.planName ?? '-'}`.length)));
    for (const p of s.byPlan) {
      const name = `${p.productName} · ${p.planName ?? '-'}`.padEnd(width);
      const unknown = p.mrrUnknownCount ? ` + ${p.mrrUnknownCount} unknown` : '';
      lines.push(`    ${name}  ${String(p.count).padStart(5)}  ${formatMoney(p.monthlyValueCents, s.currency)}/mo${unknown}`);
    }
  }

  const weeks = s.renewalWeeks.filter((w) => w.count > 0);
  if (weeks.length) {
    const max = Math.max(...weeks.map((w) => w.count));
    lines.push('', '  Paid period ends, by week:');
    for (const w of weeks) {
      lines.push(`    ${formatDate(w.weekStart).padEnd(13)} ${String(w.count).padStart(4)}  ${bar(w.count, max)}`);
    }
  }

  const review = Object.entries(s.needsReview).filter(([, n]) => n > 0);
  if (review.length) {
    lines.push('', '  Needs a look (not counted above):');
    for (const [reason, n] of review) lines.push(`    ${n} · ${NEEDS_REVIEW_LABELS[reason] ?? reason}`);
  }
  lines.push('');
}

function reportText(report: CheckerReport): string {
  const lines: string[] = [`Lemon Squeezy PayPal subscriber check (${BRAND_NAME} CLI v${CLI_VERSION})`];
  if (report.cutoffAt) lines.push(`Lemon Squeezy stops processing payments on ${formatDate(report.cutoffAt)}.`);
  lines.push('');
  if (report.testModeOnly) {
    lines.push('This key only sees test-mode data. Create a live-mode key in Lemon Squeezy and run again.');
    return lines.join('\n');
  }
  if (report.stores.length === 0) {
    lines.push('This key does not have access to any store.');
    return lines.join('\n');
  }
  for (const s of report.stores) storeText(s, report.cutoffAt, lines);
  const mrr = Object.entries(report.totals.mrrByCurrency)
    .map(([c, v]) => formatMoney(v, c === 'unknown' ? null : c))
    .join(' + ');
  lines.push(`Total: ${report.totals.strandedCount} PayPal subscribers must re-subscribe${mrr ? `; ${mrr}/month at list price` : ''}.`);
  if (report.testRowsIgnored) lines.push(`${report.testRowsIgnored} test-mode subscriptions were ignored.`);
  if (report.skippedRows) lines.push(`${report.skippedRows} subscriptions could not be read and were skipped.`);
  if (report.totals.strandedCount > 0 && report.totals.strandedCount < 5) {
    lines.push('', 'With fewer than 5 PayPal subscribers, emailing them yourself is probably simplest.');
  }
  if (report.totals.strandedCount > 0) {
    lines.push('', `To start a campaign: node ${CLI_FILE_NAME} export --out stranded.json`);
  }
  return lines.join('\n');
}

async function runCheckCommand(source: SourceProvider, apiKey: string, json: boolean, signal: AbortSignal): Promise<number> {
  const tty = process.stderr.isTTY;
  const report = await runCheck({
    source,
    creds: { apiKey },
    now: new Date(),
    signal,
    onProgress: (p) => {
      const msg = `${p.accountName}: page ${p.pagesFetched}${p.lastPage ? ` of ${p.lastPage}` : ''}`;
      process.stderr.write(tty ? `\r${msg}   ` : `${msg}\n`);
    },
  });
  if (tty) process.stderr.write('\r\x1b[K');
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${reportText(report)}\n`);
  return 0;
}

async function runExportCommand(source: SourceProvider, apiKey: string, args: Args, signal: AbortSignal): Promise<number> {
  const creds = { apiKey };
  const accounts = await source.listAccounts(creds, signal);
  let account: SourceAccount | undefined;
  if (args.store) {
    account = accounts.find((a) => a.id === args.store);
    if (!account) {
      process.stderr.write(`No store with id ${args.store}. Stores this key can see:\n${storeList(accounts)}`);
      return 2;
    }
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    process.stderr.write(
      accounts.length === 0
        ? 'This key does not have access to any store.\n'
        : `This key can see ${accounts.length} stores. Pick one with --store <id>:\n${storeList(accounts)}`,
    );
    return 2;
  }
  if (!account) return 2;

  const rows: SourceSubscription[] = [];
  const tty = process.stderr.isTTY;
  for await (const row of source.scan(
    creds,
    account.id,
    (p) => {
      const msg = `${account.name}: page ${p.pagesFetched}${p.lastPage ? ` of ${p.lastPage}` : ''}`;
      process.stderr.write(tty ? `\r${msg}   ` : `${msg}\n`);
    },
    signal,
  )) {
    rows.push(row);
  }
  if (tty) process.stderr.write('\r\x1b[K');

  if (rows.length > 0 && rows.every((r) => r.isTest)) {
    process.stderr.write('This key only sees test-mode data. Create a live-mode key in Lemon Squeezy and run again.\n');
    return 2;
  }

  const { json, file } = writeExport({ sourceProvider: source.id, account, subscriptions: rows, now: new Date() });
  const outPath = resolve(args.out);
  // Customer data: readable by the current user only.
  writeFileSync(outPath, json, { encoding: 'utf8', mode: 0o600 });

  const stranded = file.subscriptions.filter((s) => s.stranded).length;
  const review = file.subscriptions.length - stranded;
  process.stdout.write(
    [
      `Wrote ${outPath}`,
      `  Store: ${account.name}`,
      `  ${stranded} stranded PayPal subscribers${review ? `, ${review} more flagged for review` : ''}.`,
      '',
      `This file contains customer names and emails. Upload it only in your campaign at ${SITE_URL}.`,
      '',
    ].join('\n'),
  );
  return 0;
}

const PAYPAL_FLAGGED = new Set(['paused', 'unpaid']);

/** Reads the customer's new Stripe subscription: it must be active or trialing and point back at this LS subscription. */
async function verifyStripe(stripeKey: string, item: CancelListItem): Promise<string | null> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(item.destSubscriptionId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      metadata?: Record<string, string>;
      error?: { message?: string };
    } | null;
    if (!res.ok) return `Stripe: ${body?.error?.message ?? `HTTP ${res.status}`}`;
    if (body?.status !== 'active' && body?.status !== 'trialing') return `Stripe subscription is ${body?.status ?? 'unknown'}`;
    if (body.metadata?.source_subscription_id !== item.sourceSubscriptionId) {
      return 'Stripe subscription belongs to another Lemon Squeezy subscription';
    }
    return null;
  } catch {
    return 'Could not reach Stripe';
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((done) => rl.question(question, done));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function runCancelCommand(source: SourceProvider, apiKey: string, args: Args): Promise<number> {
  if (!args.file) {
    process.stderr.write('Pass the cancel-list.json your dashboard gave you: cancel cancel-list.json\n');
    return 2;
  }
  let text: string;
  try {
    text = readFileSync(resolve(args.file), 'utf8');
  } catch {
    process.stderr.write(`Cannot read ${args.file}\n`);
    return 2;
  }
  const parsed = parseCancelList(text);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const list = parsed.file;
  const stripeKey = process.env.STRIPE_API_KEY?.trim() ?? '';
  if (stripeKey && !/^rk_(live|test)_/.test(stripeKey)) {
    process.stderr.write('STRIPE_API_KEY must be a restricted key (rk_…). Secret keys are refused.\n');
    return 2;
  }
  if (!stripeKey && !args.noVerify) {
    process.stderr.write(
      "Without STRIPE_API_KEY the CLI cannot check that each customer's new Stripe subscription is active.\n" +
        'Set STRIPE_API_KEY to your restricted key, or pass --no-verify to continue without that check.\n',
    );
    return 2;
  }
  if (!stripeKey) process.stderr.write('Warning: not verifying with Stripe (--no-verify).\n');

  const creds = { apiKey };
  const results: CancelResultItem[] = [];
  const toCancel: Array<{ item: CancelListItem; overlap: boolean }> = [];
  for (const item of list.items) {
    const skip = (reason: string) => results.push({ sourceSubscriptionId: item.sourceSubscriptionId, outcome: 'skipped', reason, overlap: false });
    let live: SourceSubscription;
    try {
      live = await source.refresh!(creds, item.sourceSubscriptionId);
    } catch (err) {
      const kind = err instanceof Error && 'kind' in err ? (err as { kind: unknown }).kind : null;
      if (kind === 'auth') throw err;
      if (kind === 'not_found') skip('missing in Lemon Squeezy');
      else {
        results.push({
          sourceSubscriptionId: item.sourceSubscriptionId,
          outcome: 'failed',
          reason: err instanceof Error ? err.message : 'read failed',
          overlap: false,
        });
      }
      continue;
    }
    if (live.state === 'cancelled_in_grace' || live.state === 'ended') {
      skip('already cancelled');
      continue;
    }
    if (!live.stranded && !PAYPAL_FLAGGED.has(live.needsReview ?? '')) {
      skip('not a PayPal subscription');
      continue;
    }
    if (live.email.trim().toLowerCase() !== item.email.trim().toLowerCase()) {
      skip('email differs from the list');
      continue;
    }
    if (stripeKey) {
      const problem = await verifyStripe(stripeKey, item);
      if (problem) {
        skip(problem);
        continue;
      }
    }
    // The old platform renewed after the cancel-by date: still cancel, and flag it for a refund.
    const overlap = live.paidThrough !== null && live.paidThrough.getTime() > Date.parse(item.cancelBy);
    toCancel.push({ item, overlap });
  }

  const lines = [`Campaign ${list.campaignId}: ${toCancel.length} to cancel, ${results.length} skipped or failed.`, ''];
  for (const t of toCancel) {
    lines.push(
      `  cancel   ${t.item.email}  ${t.item.productName}  (cancel by ${formatDate(t.item.cancelBy)})${t.overlap ? '  [already renewed: refund the latest payment]' : ''}`,
    );
  }
  for (const r of results) lines.push(`  ${r.outcome.padEnd(7)}  ${r.sourceSubscriptionId}  ${r.reason ?? ''}`);
  process.stdout.write(`${lines.join('\n')}\n\n`);

  if (toCancel.length && !args.yes && !(await confirm(`Cancel these ${toCancel.length} Lemon Squeezy subscriptions? [y/N] `))) {
    process.stderr.write('Nothing cancelled.\n');
    return 1;
  }
  for (const t of toCancel) {
    try {
      await source.cancel!(creds, t.item.sourceSubscriptionId);
      results.push({ sourceSubscriptionId: t.item.sourceSubscriptionId, outcome: 'cancelled', overlap: t.overlap });
    } catch (err) {
      results.push({
        sourceSubscriptionId: t.item.sourceSubscriptionId,
        outcome: 'failed',
        reason: err instanceof Error ? err.message : 'cancel failed',
        overlap: t.overlap,
      });
    }
  }
  const out: CancelResultsFile = { schemaVersion: 1, campaignId: list.campaignId, completedAt: new Date().toISOString(), items: results };
  const outPath = resolve(args.out);
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const done = results.filter((r) => r.outcome === 'cancelled').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  process.stdout.write(`Cancelled ${done}, failed ${failed}. Wrote ${outPath}\nUpload it in your campaign at ${SITE_URL} so the dashboard knows.\n`);
  return failed ? 1 : 0;
}

function storeList(accounts: SourceAccount[]): string {
  return accounts.map((a) => `  ${a.id}  ${a.name}${a.currency ? ` (${a.currency})` : ''}\n`).join('');
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : 'Bad arguments'}\n\n${HELP}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args === 'version') {
    process.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }

  let apiKey = process.env.LEMONSQUEEZY_API_KEY?.trim() ?? '';
  if (!apiKey) {
    try {
      apiKey = await readHiddenLine('Lemon Squeezy API key (input hidden): ');
    } catch {
      return 130;
    }
  }
  if (!apiKey) {
    process.stderr.write('No API key given. Set LEMONSQUEEZY_API_KEY or paste it at the prompt.\n');
    return 2;
  }

  const ctrl = new AbortController();
  process.once('SIGINT', () => ctrl.abort());
  const source = createLemonSqueezySource();

  try {
    if (args.command === 'cancel') return await runCancelCommand(source, apiKey, args);
    return args.command === 'export'
      ? await runExportCommand(source, apiKey, args, ctrl.signal)
      : await runCheckCommand(source, apiKey, args.json, ctrl.signal);
  } catch (err) {
    if (process.stderr.isTTY) process.stderr.write('\n');
    if (err instanceof CheckAbortedError || (err instanceof Error && 'kind' in err && err.kind === 'aborted')) return 130;
    const kind = err instanceof Error && 'kind' in err ? (err as { kind: unknown }).kind : null;
    process.stderr.write(`${err instanceof Error && err.name === 'LsApiError' ? err.message : 'Unexpected error.'}\n`);
    return kind === 'auth' ? 2 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
