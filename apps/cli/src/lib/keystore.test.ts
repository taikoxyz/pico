import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { loadPrivateKey } from './keystore.js';

const VALID = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('loadPrivateKey', () => {
  it('returns the env var when valid', () => {
    expect(loadPrivateKey({ TAINNEL_PRIVATE_KEY: VALID })).toBe(VALID);
  });

  it('throws CliError when unset', () => {
    expect(() => loadPrivateKey({})).toThrow(CliError);
  });

  it('throws CliError when empty', () => {
    expect(() => loadPrivateKey({ TAINNEL_PRIVATE_KEY: '' })).toThrow(CliError);
  });

  it.each([
    'no-prefix',
    '0xshort',
    `${VALID}deadbeef`, // too long
    `0xZZ${VALID.slice(4)}`, // contains non-hex
  ])('throws on malformed input: %s', (bad) => {
    expect(() => loadPrivateKey({ TAINNEL_PRIVATE_KEY: bad })).toThrow(CliError);
  });

  it('does not include the raw key in the malformed error message', () => {
    const sentinel = `0x${'de'.repeat(40)}`; // wrong length, recognizable substring
    try {
      loadPrivateKey({ TAINNEL_PRIVATE_KEY: sentinel });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('de'.repeat(32));
      expect((err as Error).message).not.toContain(sentinel);
    }
  });
});
