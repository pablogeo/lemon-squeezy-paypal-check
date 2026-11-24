// Single place for the brand and the operator's legal details.
// Pure constants: imported by the app, the worker, and the CLI bundle.
import cliConfig from './cli.json';

/** Working name. Never hardcode it anywhere else (copy, emails, DB names, package names, metadata keys). */
export const BRAND_NAME = 'ReLink';

export const LEGAL_NAME = 'Pablo Perez';
export const SUPPORT_EMAIL = 'support@relinkpay.com';

/** Public site. The CLI prints it (never contacts it): "Upload it only in your campaign at …". */
export const SITE_URL = 'https://relinkpay.com';

// The CLI's identity lives in cli.json (read by cli/build.mjs too). Only what the CLI itself prints
// is exported here; distribution details (repo, download URLs) live in cli-distribution.ts, which
// the CLI bundle never imports.
export const CLI_FILE_NAME: string = cliConfig.fileName;
export const CLI_VERSION: string = cliConfig.version;


export const GUARANTEE_TERMS =
  'Full refund if fewer than 3 subscribers re-home (campaigns of 10+ subscribers, requested within 30 days of launch).';

export const SUPPORT_TERMS = 'Replies within 1 business day.';

export type TierId = 'starter' | 'growth' | 'pro';

export const TIERS: ReadonlyArray<{ id: TierId; name: string; priceUsd: number; maxSubscribers: number }> = [
  { id: 'starter', name: 'Starter', priceUsd: 49, maxSubscribers: 50 },
  { id: 'growth', name: 'Growth', priceUsd: 99, maxSubscribers: 300 },
  { id: 'pro', name: 'Pro', priceUsd: 199, maxSubscribers: 2000 },
];
