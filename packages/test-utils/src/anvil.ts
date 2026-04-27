export interface AnvilForkOptions {
  readonly forkUrl: string;
  readonly forkBlockNumber?: bigint;
  readonly chainId?: number;
  readonly port?: number;
  readonly mnemonic?: string;
}

export interface AnvilHandle {
  readonly rpcUrl: string;
  readonly chainId: number;
  stop(): Promise<void>;
}

export async function startAnvilFork(_opts: AnvilForkOptions): Promise<AnvilHandle> {
  throw new Error('not implemented');
}
