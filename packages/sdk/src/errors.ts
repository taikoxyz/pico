export class SdkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SdkError';
  }
}

export class TransportError extends SdkError {
  constructor(message: string, code = 'TRANSPORT_ERROR') {
    super(message, code);
    this.name = 'TransportError';
  }
}

export class TransportClosedError extends TransportError {
  constructor() {
    super('transport is closed', 'TRANSPORT_CLOSED');
    this.name = 'TransportClosedError';
  }
}

export class TransportTimeoutError extends TransportError {
  constructor(kind: string, timeoutMs: number) {
    super(`timed out waiting for ${kind} after ${timeoutMs}ms`, 'TRANSPORT_TIMEOUT');
    this.name = 'TransportTimeoutError';
  }
}

export class StorageError extends SdkError {
  constructor(message: string, code = 'STORAGE_ERROR') {
    super(message, code);
    this.name = 'StorageError';
  }
}

export class WalletError extends SdkError {
  constructor(message: string, code = 'WALLET_ERROR') {
    super(message, code);
    this.name = 'WalletError';
  }
}

export class ChannelClientError extends SdkError {
  constructor(message: string, code = 'CHANNEL_CLIENT_ERROR') {
    super(message, code);
    this.name = 'ChannelClientError';
  }
}

export class UnknownChannelError extends ChannelClientError {
  constructor(id: string) {
    super(`unknown channel ${id}`, 'UNKNOWN_CHANNEL');
    this.name = 'UnknownChannelError';
  }
}

export class PaymentTimeoutError extends ChannelClientError {
  constructor(htlcId: string) {
    super(`hub did not settle htlc ${htlcId} before expiry`, 'PAYMENT_TIMEOUT');
    this.name = 'PaymentTimeoutError';
  }
}

export class PaymentRejectedError extends ChannelClientError {
  constructor(reason: string) {
    super(`hub rejected payment: ${reason}`, 'PAYMENT_REJECTED');
    this.name = 'PaymentRejectedError';
  }
}

export class CloseRejectedError extends ChannelClientError {
  constructor(reason: string) {
    super(`hub rejected cooperative close: ${reason}`, 'CLOSE_REJECTED');
    this.name = 'CloseRejectedError';
  }
}
