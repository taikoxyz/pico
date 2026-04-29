import { describe, expect, it } from 'vitest';
import { hubCommand } from './hub.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

describe('tainnel hub status', () => {
  it('hits /v1/health and prints the body', async () => {
    const stdout = new StubStream();
    const fetchStub = (async (url: string) => {
      expect(url).toBe('https://hub.example.com/v1/health');
      return new Response(JSON.stringify({ status: 'ok', version: '0.0.0' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const cmd = hubCommand({ stdout, fetch: fetchStub });
    await cmd.parseAsync(['node', 'tainnel', 'status', 'https://hub.example.com/']);
    expect(stdout.buf).toContain('"status":"ok"');
  });

  it('falls back to /health when /v1/health is 404', async () => {
    const stdout = new StubStream();
    let calls = 0;
    const fetchStub = (async (url: string) => {
      calls++;
      if (url.endsWith('/v1/health')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const cmd = hubCommand({ stdout, fetch: fetchStub });
    await cmd.parseAsync(['node', 'tainnel', 'status', 'http://hub.test']);
    expect(stdout.buf).toContain('"status":"ok"');
    expect(calls).toBe(2);
  });
});
