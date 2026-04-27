export interface DvmListenerOptions {
  readonly relays: readonly string[];
  readonly kinds: readonly number[];
}

export type DvmEventHandler = (event: {
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}) => void;

export class DvmListener {
  constructor(private readonly opts: DvmListenerOptions) {}

  async start(_handler: DvmEventHandler): Promise<void> {
    throw new Error('not implemented');
  }

  async stop(): Promise<void> {
    throw new Error('not implemented');
  }
}
