import type { OpenedChannel } from './client.js';

export class SdkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}

export class UnknownPaymentHashError extends SdkError {
  constructor(paymentHash: string) {
    super(`unknown payment hash: ${paymentHash}`, 'UNKNOWN_PAYMENT_HASH');
    this.name = 'UnknownPaymentHashError';
  }
}

export class InvoiceExpiredError extends SdkError {
  constructor(expiryMs: bigint, nowMs: bigint) {
    super(`invoice expired at ${expiryMs} (now ${nowMs})`, 'INVOICE_EXPIRED');
    this.name = 'InvoiceExpiredError';
  }
}

export class InvoiceVerificationError extends SdkError {
  constructor(reason: string) {
    super(`invoice verification failed: ${reason}`, 'INVOICE_VERIFICATION');
    this.name = 'InvoiceVerificationError';
  }
}

export class HtlcExpiredLocallyError extends SdkError {
  constructor(htlcId: string) {
    super(`htlc ${htlcId} expired before settlement`, 'HTLC_EXPIRED_LOCALLY');
    this.name = 'HtlcExpiredLocallyError';
  }
}

export class PreimageMismatchError extends SdkError {
  constructor() {
    super('preimage does not match payment hash', 'PREIMAGE_MISMATCH');
    this.name = 'PreimageMismatchError';
  }
}

export class HubTimeoutError extends SdkError {
  constructor(operation: string, timeoutMs: number) {
    super(`hub did not respond to ${operation} within ${timeoutMs}ms`, 'HUB_TIMEOUT');
    this.name = 'HubTimeoutError';
  }
}

export class ChannelNotOpenError extends SdkError {
  constructor(channelId: string, status: string) {
    super(`channel ${channelId} is not open (status=${status})`, 'CHANNEL_NOT_OPEN');
    this.name = 'ChannelNotOpenError';
  }
}

export class TransportClosedError extends SdkError {
  constructor() {
    super('transport is closed', 'TRANSPORT_CLOSED');
    this.name = 'TransportClosedError';
  }
}

/// Thrown by `ChannelClient.open()` when the on-chain openChannel tx succeeded
/// and the channel was persisted locally, but the subsequent hub subscribe
/// request failed (timeout, hub down, indexer gap). The on-chain action is
/// irreversible; callers can recover by resubscribing later (e.g. `pico listen`).
export class PostOpenSubscribeError extends SdkError {
  constructor(
    public readonly opened: OpenedChannel,
    public readonly cause: Error,
  ) {
    super(
      `channel opened on-chain (tx ${opened.txHash}) but hub subscribe failed: ${cause.message}`,
      'POST_OPEN_SUBSCRIBE',
    );
    this.name = 'PostOpenSubscribeError';
  }
}
