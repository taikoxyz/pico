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
