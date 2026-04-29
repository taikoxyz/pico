import { CliError } from './errors.js';

export interface HubUrls {
  readonly ws: string;
  readonly http: string;
}

export function deriveHubUrls(input: string): HubUrls {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new CliError(`invalid --hub URL: ${input}`, { code: 'BAD_HUB_URL' });
  }
  switch (parsed.protocol) {
    case 'ws:':
      return { ws: ensureWsPath(parsed), http: `http://${parsed.host}` };
    case 'wss:':
      return { ws: ensureWsPath(parsed), http: `https://${parsed.host}` };
    case 'http:':
      return { ws: `ws://${parsed.host}/v1/ws`, http: `http://${parsed.host}` };
    case 'https:':
      return { ws: `wss://${parsed.host}/v1/ws`, http: `https://${parsed.host}` };
    default:
      throw new CliError(`unsupported --hub URL scheme: ${parsed.protocol}`, {
        code: 'BAD_HUB_URL',
      });
  }
}

function ensureWsPath(u: URL): string {
  const hasPath = u.pathname && u.pathname !== '/' && u.pathname !== '';
  const path = hasPath ? u.pathname : '/v1/ws';
  return `${u.protocol}//${u.host}${path}`;
}
