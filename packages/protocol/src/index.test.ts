import { describe, expect, it } from 'vitest';
import {
  NOSTR_EVENT_KINDS,
  NOSTR_KIND_RANGE,
  PROTOCOL_VERSION,
  SUPPORTED_CHAIN_IDS,
  TAIKO_MAINNET_CHAIN_ID,
  isNostrPicoKind,
} from './index.js';

describe('@pico/protocol', () => {
  it('exposes a protocol version', () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('lists Taiko mainnet as a supported chain (Hoodi excluded until deployed)', () => {
    expect(SUPPORTED_CHAIN_IDS).toContain(TAIKO_MAINNET_CHAIN_ID);
    expect(SUPPORTED_CHAIN_IDS).toHaveLength(1);
  });

  it('keeps every Nostr event kind inside the reserved range', () => {
    for (const kind of Object.values(NOSTR_EVENT_KINDS)) {
      expect(isNostrPicoKind(kind)).toBe(true);
      expect(kind).toBeGreaterThanOrEqual(NOSTR_KIND_RANGE.min);
      expect(kind).toBeLessThanOrEqual(NOSTR_KIND_RANGE.max);
    }
  });
});
