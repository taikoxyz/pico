import { describe, expect, it } from 'vitest';
import { findWorkspaceRoot, listWorkspacePackages } from './workspace.js';

describe('workspace utils', () => {
  it('finds the pnpm workspace root', () => {
    expect(findWorkspaceRoot()).toMatch(/amsterdam-v1$/);
  });

  it('lists every workspace package', () => {
    const packages = listWorkspacePackages();
    const names = packages.map((p) => p.name);
    expect(names).toContain('@tainnel/protocol');
    expect(names).toContain('@tainnel/state-machine');
    expect(names).toContain('@tainnel/hub');
  });
});
