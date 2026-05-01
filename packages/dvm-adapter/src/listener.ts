/**
 * @experimental DVM/Nostr relay listener — NOT implemented in v1.
 *
 * Calling `start()` or `stop()` throws. The class is kept exported as a
 * shape stub so integrators can program against the eventual interface,
 * but no production flow may rely on it. Will be implemented in Phase 2.
 */
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

  /** @experimental Throws — DVM listener is a Phase-2 feature. */
  async start(_handler: DvmEventHandler): Promise<void> {
    throw new Error(
      'DvmListener.start: DVM/Nostr relay listener is not implemented in v1 (experimental, Phase 2)',
    );
  }

  /** @experimental Throws — DVM listener is a Phase-2 feature. */
  async stop(): Promise<void> {
    throw new Error(
      'DvmListener.stop: DVM/Nostr relay listener is not implemented in v1 (experimental, Phase 2)',
    );
  }
}
