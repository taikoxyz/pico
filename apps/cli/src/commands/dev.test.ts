import { describe, expect, it } from 'vitest';
import { devCommand } from './dev.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

describe('tainnel dev mock-hub', () => {
  it('spawns and exits cleanly on abort', async () => {
    const stdout = new StubStream();
    const ctrl = new AbortController();
    const cmd = devCommand({ stdout, signal: ctrl.signal });
    const promise = cmd.parseAsync(['node', 'tainnel', 'mock-hub']);
    setTimeout(() => ctrl.abort(), 100);
    await promise;
    expect(stdout.buf).toContain('ws://127.0.0.1:');
  });
});
