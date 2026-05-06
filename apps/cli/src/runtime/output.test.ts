import type { Channel } from '@inferenceroom/pico-protocol';
import { describe, expect, it } from 'vitest';
import { emit, formatChannelTable, jsonLine } from './output.js';

const channel = (id: string): Channel => ({
  id: id as `0x${string}`,
  chainId: 167000,
  contract: '0x0000000000000000000000000000000000000000',
  userA: '0x0000000000000000000000000000000000000001',
  userB: '0x0000000000000000000000000000000000000002',
  token: '0x0000000000000000000000000000000000000000',
  status: 'open',
  openedAt: 0n,
  disputeWindowMs: 86_400_000,
});

describe('output helpers', () => {
  it('jsonLine stringifies bigints as strings', () => {
    expect(jsonLine({ a: 5n })).toBe('{"a":"5"}');
  });

  it('emit appends a newline to the stream', () => {
    let out = '';
    emit(
      { x: 1 },
      {
        write: (s) => {
          out += s;
        },
      },
    );
    expect(out).toBe('{"x":1}\n');
  });

  it('formatChannelTable says (no channels) when empty', () => {
    expect(formatChannelTable([])).toBe('(no channels)');
  });

  it('formatChannelTable renders rows with abbreviated columns', () => {
    const out = formatChannelTable([channel(`0x${'a'.repeat(64)}`)]);
    expect(out.split('\n').length).toBe(2);
    expect(out).toContain('open');
    expect(out).toContain('0xaaaaaaaa');
  });
});
