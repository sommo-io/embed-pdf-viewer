#!/usr/bin/env node
// sommo-io fork: publish our patched EmbedPDF packages to GitHub Packages.
//
//   node scripts/sommo-publish.mjs 3.0.0-next.14-sommo.1 [--dry-run]
//
// Each package in PACKAGES is packed with pnpm (workspace: ranges and
// publishConfig resolved as for npm), renamed to @sommo-io/embedpdf-<name>
// at the given version and published to npm.pkg.github.com. pdf-editor
// installs them through npm overrides
// ("@embedpdf/engine-services": "npm:@sommo-io/embedpdf-engine-services@…").
// Build the packages first (`npx turbo run build --filter=…`). Auth comes
// from NODE_AUTH_TOKEN (a token with write:packages, or the workflow's
// GITHUB_TOKEN).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PACKAGES = [
  'packages/engine/services',
  'packages/core/annotation',
  'packages/plugin/annotation',
];
const REGISTRY = 'https://npm.pkg.github.com';

const [version, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]*sommo\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/sommo-publish.mjs <upstream version>-sommo.<n> [--dry-run]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
for (const dir of PACKAGES) {
  const pkgDir = join(root, dir);
  const upstream = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (!version.startsWith(`${upstream.version}-`)) {
    throw new Error(
      `${upstream.name} is ${upstream.version}; the version must be ${upstream.version}-sommo.<n>`,
    );
  }
  const out = mkdtempSync(join(tmpdir(), 'sommo-pack-'));
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: pkgDir, stdio: 'inherit' });
  const tarball = readdirSync(out).find((name) => name.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(out, tarball), '-C', out]);
  const packed = join(out, 'package');
  const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
  const name = `@sommo-io/embedpdf-${upstream.name.replace(/^@embedpdf\//, '')}`;
  manifest.name = name;
  manifest.version = version;
  manifest.publishConfig = { registry: REGISTRY };
  manifest.repository = {
    type: 'git',
    url: 'git+https://github.com/sommo-io/embed-pdf-viewer.git',
    directory: dir,
  };
  writeFileSync(join(packed, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const args = ['publish', packed, '--registry', REGISTRY, '--tag', 'sommo'];
  if (dryRun) args.push('--dry-run');
  execFileSync('npm', args, { stdio: 'inherit' });
  console.log(
    `${dryRun ? 'would publish' : 'published'} ${name}@${version} (from ${upstream.name}@${upstream.version})`,
  );
}
