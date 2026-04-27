export interface HubConfig {
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly hubPrivateKey: string;
  readonly rpcUrl: string;
  readonly dbDriver: 'sqlite' | 'postgres';
  readonly dbUrl: string;
  readonly prometheusPort: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const driver = env.DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
  return {
    port: Number(env.PORT ?? 3030),
    logLevel: (env.LOG_LEVEL as HubConfig['logLevel'] | undefined) ?? 'info',
    hubPrivateKey:
      env.HUB_PRIVATE_KEY ?? '0x0000000000000000000000000000000000000000000000000000000000000001',
    rpcUrl: env.RPC_URL ?? 'https://rpc.taiko.xyz',
    dbDriver: driver,
    dbUrl:
      env.DB_URL ??
      (driver === 'sqlite' ? './data/hub.sqlite' : 'postgres://localhost/tainnel_hub'),
    prometheusPort: Number(env.PROMETHEUS_PORT ?? 9090),
  };
}
