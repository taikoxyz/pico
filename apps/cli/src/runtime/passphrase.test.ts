import { describe, expect, it } from 'vitest';
import { readNewPassphrase, readPassphrase } from './passphrase.js';

describe('passphrase helpers', () => {
  it('uses PICO_PASSPHRASE if set', async () => {
    expect(await readPassphrase('x', { env: { PICO_PASSPHRASE: 'sekret' } })).toBe('sekret');
    expect(await readNewPassphrase({ env: { PICO_PASSPHRASE: 'sekret' } })).toBe('sekret');
  });

  it('prompts via injected reader when env var unset', async () => {
    let calls = 0;
    const r = await readPassphrase('x', {
      env: {},
      read: async () => {
        calls += 1;
        return 'pw';
      },
    });
    expect(r).toBe('pw');
    expect(calls).toBe(1);
  });

  it('readNewPassphrase rejects mismatch', async () => {
    let n = 0;
    await expect(
      readNewPassphrase({
        env: {},
        read: async () => (n++ === 0 ? 'a' : 'b'),
      }),
    ).rejects.toThrow(/match/);
  });

  it('readNewPassphrase confirms matching pair', async () => {
    const r = await readNewPassphrase({ env: {}, read: async () => 'good-pw' });
    expect(r).toBe('good-pw');
  });
});
