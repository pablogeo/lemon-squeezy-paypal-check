// Bundles the CLI into one unminified ESM file with zero runtime dependencies, then:
// - fails if the bundle pulls in any npm package or imports anything but Node built-ins,
// - fails if it names any host other than api.lemonsqueezy.com (and the site URL it prints),
// - writes cli/dist/package.json (name and version from src/config/cli.json), README and LICENSE,
//   so `npm publish cli/dist` publishes exactly the audited file,
// - computes the SHA-256 the README and the site publish (src/config/cli-release.json,
//   public/downloads/<file>.sha256) and, with --site, copies the file to public/downloads.
// The same script builds the standalone public CLI repository (see cli/make-repo.mjs).
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(root, 'src/config/cli.json'), 'utf8'));
const siteUrl = /SITE_URL = '([^']+)'/.exec(readFileSync(join(root, 'src/config/brand.ts'), 'utf8'))?.[1];
const siteHost = siteUrl ? new URL(siteUrl).host : null;
const distDir = join(root, 'cli', 'dist');
const outfile = join(distDir, cfg.fileName);

function writeIfChanged(path, content) {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== content) writeFileSync(path, content);
}

export async function buildCli({ site = false } = {}) {
  const result = await build({
    entryPoints: [join(root, 'cli', 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    minify: false,
    sourcemap: false,
    metafile: true,
    legalComments: 'inline',
    tsconfig: join(root, 'tsconfig.json'),
    banner: {
      js: [
        '#!/usr/bin/env node',
        `// Lemon Squeezy PayPal subscriber check v${cfg.version}. MIT License.`,
        '// Single file, no dependencies. Talks only to https://api.lemonsqueezy.com.',
      ].join('\n'),
    },
    logLevel: 'warning',
  });

  const fromPackages = Object.keys(result.metafile.inputs).filter((p) => p.includes('node_modules'));
  if (fromPackages.length) throw new Error(`CLI bundle includes npm packages: ${fromPackages.join(', ')}`);

  const code = readFileSync(outfile, 'utf8');
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const specifiers = [...code.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  const external = specifiers.filter((s) => !builtins.has(s));
  if (external.length) throw new Error(`CLI bundle has non-builtin imports: ${[...new Set(external)].join(', ')}`);
  const hosts = [...new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase().replace(/\.+$/, '')))];
  // The site URL is only printed ("upload it at …"); the mock-server test proves it is never requested.
  const unexpected = hosts.filter((h) => h !== 'api.lemonsqueezy.com' && h !== siteHost);
  if (unexpected.length) throw new Error(`CLI bundle references unexpected hosts: ${unexpected.join(', ')}`);

  const sha256 = createHash('sha256').update(readFileSync(outfile)).digest('hex');

  writeFileSync(
    join(distDir, 'package.json'),
    `${JSON.stringify(
      {
        name: cfg.packageName,
        version: cfg.version,
        description: 'Find the PayPal subscribers that cannot migrate off Lemon Squeezy, and the revenue at stake.',
        license: 'MIT',
        type: 'module',
        bin: { [cfg.packageName]: `./${cfg.fileName}` },
        files: [cfg.fileName, 'README.md', 'LICENSE'],
        engines: { node: '>=18' },
      },
      null,
      2,
    )}\n`,
  );
  copyFileSync(join(root, 'cli', 'README.md'), join(distDir, 'README.md'));
  copyFileSync(join(root, 'cli', 'LICENSE'), join(distDir, 'LICENSE'));

  writeIfChanged(
    join(root, 'src', 'config', 'cli-release.json'),
    `${JSON.stringify({ version: cfg.version, fileName: cfg.fileName, sha256 }, null, 2)}\n`,
  );
  if (site) {
    mkdirSync(join(root, 'public', 'downloads'), { recursive: true });
    copyFileSync(outfile, join(root, 'public', 'downloads', cfg.fileName));
    writeFileSync(join(root, 'public', 'downloads', `${cfg.fileName}.sha256`), `${sha256}  ${cfg.fileName}\n`);
  }
  return { outfile, sha256, inputs: Object.keys(result.metafile.inputs) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { outfile: out, sha256 } = await buildCli({ site: process.argv.includes('--site') });
  console.log(`built ${out}\nsha256 ${sha256}`);
}
