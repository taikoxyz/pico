export interface WatchtowerConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly privateKey: string;
  readonly rpcUrl: string;
  readonly dbUrl: string;
  readonly mode: 'self-hosted' | 'service';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WatchtowerConfig {
  const mode = env.MODE === 'service' ? 'service' : 'self-hosted';
  return {
    port: Number(env.PORT ?? 3031),
    logLevel: env.LOG_LEVEL ?? 'info',
    privateKey:
      env.WATCHTOWER_PRIVATE_KEY ??
      '0x0000000000000000000000000000000000000000000000000000000000000002',
    rpcUrl: env.RPC_URL ?? 'https://rpc.taiko.xyz',
    dbUrl: env.DB_URL ?? './data/watchtower.sqlite',
    mode,
  };
}
