import { describe, expect, it } from 'vitest';
import { payCommand } from './pay.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;

describe('tainnel pay arg validation', () => {
  it('rejects --invoice + --keysend', async () => {
    const cmd = payCommand({
      env: { TAINNEL_PRIVATE_KEY: PK },
      stdout: new StubStream(),
    });
    await expect(
      cmd.parseAsync(['node', 'tainnel', '--invoice', 'tainnel1:abc', '--keysend']),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('rejects neither --invoice nor --keysend', async () => {
    const cmd = payCommand({
      env: { TAINNEL_PRIVATE_KEY: PK },
      stdout: new StubStream(),
    });
    await expect(cmd.parseAsync(['node', 'tainnel'])).rejects.toThrow(/required/);
  });
});
