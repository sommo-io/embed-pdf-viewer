#!/usr/bin/env node
// sommo-io fork: pack our patched EmbedPDF packages as release tarballs.
//
//   node scripts/sommo-publish.mjs 3.0.0-next.14-sommo.1 [out dir]
//
// Each package in PACKAGES is packed with pnpm (workspace: ranges and
// publishConfig resolved as for npm), versioned <upstream>-sommo.<n> and
// written to <out dir> (default: sommo-dist/) as
// embedpdf-<name>-<version>.tgz. The workflow attaches them to the GitHub
// Release of the tag; consumers install them by URL through npm overrides
// ("@embedpdf/engine-core": "https://github.com/…/releases/download/…tgz").
// Build the packages first (`npx turbo run build --filter=…`). Each tarball
// also gets the repository's LICENSE and NOTICE (Apache-2.0 4(a), 4(d)).
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Every package with a "sommo-io fork" change.
const PACKAGES = [
  'packages/engine/core',
  'packages/engine/main',
  'packages/engine/services',
  'packages/core/main',
  'packages/core/annotation',
  'packages/plugin/actions',
  'packages/plugin/annotation',
  'packages/plugin/form',
  'packages/plugin/link',
  'packages/plugin/measurement',
  'packages/plugin/metadata',
  'packages/plugin/render',
  'packages/plugin/selection',
  'packages/plugin/signature',
  'packages/plugin/stage',
];

const [version, outArg] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+-[0-9A-Za-z.-]*sommo\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/sommo-publish.mjs <upstream version>-sommo.<n> [out dir]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(outArg ?? join(root, 'sommo-dist'));
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const dir of PACKAGES) {
  const pkgDir = join(root, dir);
  const upstream = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (!version.startsWith(`${upstream.version}-`)) {
    throw new Error(
      `${upstream.name} is ${upstream.version}; the version must be ${upstream.version}-sommo.<n>`,
    );
  }
  const work = mkdtempSync(join(tmpdir(), 'sommo-pack-'));
  execFileSync('pnpm', ['pack', '--pack-destination', work], { cwd: pkgDir, stdio: 'inherit' });
  const tarball = readdirSync(work).find((name) => name.endsWith('.tgz'));
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', work]);
  const packed = join(work, 'package');
  const manifest = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
  manifest.version = version;
  manifest.repository = {
    type: 'git',
    url: 'git+https://github.com/sommo-io/embed-pdf-viewer.git',
    directory: dir,
  };
  writeFileSync(join(packed, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(join(root, 'LICENSE'), join(packed, 'LICENSE'));
  copyFileSync(join(root, 'NOTICE'), join(packed, 'NOTICE'));
  const file = `embedpdf-${upstream.name.replace(/^@embedpdf\//, '')}-${version}.tgz`;
  execFileSync('tar', ['-czf', join(outDir, file), '-C', work, 'package']);
  rmSync(work, { recursive: true, force: true });
  console.log(`packed ${upstream.name}@${version} -> ${file}`);
}
