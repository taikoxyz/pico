import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findWorkspaceRoot, listWorkspacePackages } from './workspace.js';

describe('workspace utils', () => {
  it('finds the directory containing pnpm-workspace.yaml', () => {
    const root = findWorkspaceRoot();
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('lists every workspace package', () => {
    const packages = listWorkspacePackages();
    const names = packages.map((p) => p.name);
    expect(names).toContain('@inferenceroom/pico-protocol');
    expect(names).toContain('@inferenceroom/pico-state-machine');
    expect(names).toContain('@inferenceroom/pico-hub');
  });
});
