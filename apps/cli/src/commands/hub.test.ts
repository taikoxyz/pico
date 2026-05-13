import { describe, expect, it } from 'vitest';
import { hubCommand } from './hub.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('pico hub status', () => {
  it('hits /v1/health + /v1/info + /v1/stats and prints a human summary', async () => {
    const stdout = new StubStream();
    const seen: string[] = [];
    const fetchStub = (async (url: string) => {
      seen.push(url);
      if (url.endsWith('/v1/health')) {
        return jsonResponse({ status: 'ok', checks: { db: 'ok', chain: 'ok' } });
      }
      if (url.endsWith('/v1/info')) {
        return jsonResponse({
          version: 1,
          hubAddress: '0xAaAa',
          chainId: 167000,
          contracts: { PaymentChannel: '0xPC', Adjudicator: '0xAD' },
        });
      }
      if (url.endsWith('/v1/stats')) {
        return jsonResponse({ channels: { total: 0, byStatus: {} } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const cmd = hubCommand({ stdout, fetch: fetchStub });
    await cmd.parseAsync(['node', 'pico', 'status', 'https://hub.example.com/']);
    // All three endpoints hit (in parallel).
    expect(seen.sort()).toEqual(
      [
        'https://hub.example.com/v1/health',
        'https://hub.example.com/v1/info',
        'https://hub.example.com/v1/stats',
      ].sort(),
    );
    expect(stdout.buf).toContain('hub:         https://hub.example.com');
    expect(stdout.buf).toContain('hubAddress:  0xAaAa');
    expect(stdout.buf).toContain('chainId:     167000');
    expect(stdout.buf).toContain('PaymentChannel: 0xPC');
    expect(stdout.buf).toContain('health:      ok');
  });

  it('emits JSON containing all three responses with --json', async () => {
    const stdout = new StubStream();
    const fetchStub = (async (url: string) => {
      if (url.endsWith('/v1/health')) return jsonResponse({ status: 'ok' });
      if (url.endsWith('/v1/info')) return jsonResponse({ chainId: 1 });
      return jsonResponse({ channels: {} });
    }) as typeof fetch;
    const cmd = hubCommand({ stdout, fetch: fetchStub });
    await cmd.parseAsync(['node', 'pico', 'status', 'http://hub.test', '--json']);
    const parsed = JSON.parse(stdout.buf);
    expect(parsed.health.status).toBe('ok');
    expect(parsed.info.chainId).toBe(1);
    expect(parsed.stats).toBeDefined();
  });
});
