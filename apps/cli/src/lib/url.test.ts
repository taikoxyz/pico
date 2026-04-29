import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { deriveHubUrls } from './url.js';

describe('deriveHubUrls', () => {
  it('http base: derives ws + http', () => {
    expect(deriveHubUrls('http://localhost:3030')).toEqual({
      ws: 'ws://localhost:3030/v1/ws',
      http: 'http://localhost:3030',
    });
  });

  it('https base: derives wss + https', () => {
    expect(deriveHubUrls('https://hub.tainnel.xyz')).toEqual({
      ws: 'wss://hub.tainnel.xyz/v1/ws',
      http: 'https://hub.tainnel.xyz',
    });
  });

  it('ws base with explicit /v1/ws path: preserves path, derives http', () => {
    expect(deriveHubUrls('ws://127.0.0.1:8080/v1/ws')).toEqual({
      ws: 'ws://127.0.0.1:8080/v1/ws',
      http: 'http://127.0.0.1:8080',
    });
  });

  it('ws base with no path: defaults ws path to /v1/ws', () => {
    expect(deriveHubUrls('ws://localhost:3030')).toEqual({
      ws: 'ws://localhost:3030/v1/ws',
      http: 'http://localhost:3030',
    });
  });

  it('wss base: maps to https', () => {
    expect(deriveHubUrls('wss://hub.example/v1/ws')).toEqual({
      ws: 'wss://hub.example/v1/ws',
      http: 'https://hub.example',
    });
  });

  it('throws on unsupported scheme', () => {
    expect(() => deriveHubUrls('ftp://example')).toThrow(CliError);
  });

  it('throws on invalid URL string', () => {
    expect(() => deriveHubUrls('not a url')).toThrow(CliError);
  });
});
