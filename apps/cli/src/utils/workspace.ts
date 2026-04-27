import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

export function findWorkspaceRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`could not locate pnpm-workspace.yaml from ${start}`);
}

export function listWorkspacePackages(): PackageInfo[] {
  const root = findWorkspaceRoot();
  const result: PackageInfo[] = [];

  for (const groupDir of ['packages', 'apps']) {
    const groupPath = join(root, groupDir);
    if (!existsSync(groupPath)) continue;
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(groupPath, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
      if (pkg.name && pkg.version) {
        result.push({ name: pkg.name, version: pkg.version, path: join(groupDir, entry.name) });
      }
    }
  }

  const e2ePkg = join(root, 'e2e', 'package.json');
  if (existsSync(e2ePkg)) {
    const pkg = JSON.parse(readFileSync(e2ePkg, 'utf8')) as { name?: string; version?: string };
    if (pkg.name && pkg.version) {
      result.push({ name: pkg.name, version: pkg.version, path: 'e2e' });
    }
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
