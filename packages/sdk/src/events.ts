import type { Channel, ChannelId, Htlc, Preimage } from '@tainnel/protocol';

export interface SdkEventMap {
  'htlc:incoming': { channelId: ChannelId; htlc: Htlc };
  'htlc:settled': {
    channelId: ChannelId;
    htlc: Htlc;
    preimage: Preimage;
    direction: 'incoming' | 'outgoing';
  };
  'htlc:failed': { channelId: ChannelId; htlc: Htlc; reason: string };
  'channel:opened': { channel: Channel };
  'channel:closed': { channelId: ChannelId };
  error: { error: Error; context?: string };
}

export type SdkEventName = keyof SdkEventMap;
export type SdkEventHandler<E extends SdkEventName> = (payload: SdkEventMap[E]) => void;

export class TypedEventEmitter<M> {
  private readonly handlers = new Map<keyof M, Set<(payload: M[keyof M]) => void>>();

  on<E extends keyof M>(event: E, handler: (payload: M[E]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: M[keyof M]) => void);
    return () => this.off(event, handler);
  }

  off<E extends keyof M>(event: E, handler: (payload: M[E]) => void): void {
    this.handlers.get(event)?.delete(handler as (payload: M[keyof M]) => void);
  }

  emit<E extends keyof M>(event: E, payload: M[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        (h as (p: M[E]) => void)(payload);
      } catch (err) {
        if (event !== 'error' && this.handlers.has('error' as keyof M)) {
          this.emit(
            'error' as E,
            { error: err as Error, context: `handler for ${String(event)}` } as M[E],
          );
        }
      }
    }
  }
}
