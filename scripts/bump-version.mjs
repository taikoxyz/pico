#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('usage: pnpm bump-version <semver>   (e.g. pnpm bump-version 1.1.0)');
  process.exit(1);
}

const config = JSON.parse(readFileSync(resolve(ROOT, '.changeset/config.json'), 'utf8'));
const ignored = new Set(config.ignore ?? []);

const pkgPaths = ['apps', 'packages'].flatMap((root) =>
  readdirSync(resolve(ROOT, root), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => resolve(ROOT, root, d.name, 'package.json'))
    .filter((p) => existsSync(p)),
);

let bumped = 0;
for (const path of pkgPaths) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  if (pkg.private || ignored.has(pkg.name)) continue;
  const before = pkg.version;
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.info(`${pkg.name}: ${before} -> ${version}`);
  bumped += 1;
}

if (bumped === 0) {
  console.error(
    'no publishable packages found (non-private, not in .changeset/config.json ignore)',
  );
  process.exit(1);
}

const generator = resolve(ROOT, 'apps/cli/scripts/generate-versions.mjs');
if (existsSync(generator)) {
  const r = spawnSync(process.execPath, [generator], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
