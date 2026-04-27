export interface MockHubHandle {
  readonly url: string;
  stop(): Promise<void>;
}

export async function startMockHub(_opts?: { port?: number }): Promise<MockHubHandle> {
  throw new Error('not implemented');
}
