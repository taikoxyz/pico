export class StateMachineError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'StateMachineError';
  }
}

export class StaleVersionError extends StateMachineError {
  constructor(current: bigint, attempted: bigint) {
    super(`stale version: current=${current} attempted=${attempted}`, 'STALE_VERSION');
    this.name = 'StaleVersionError';
  }
}

export class BalanceMismatchError extends StateMachineError {
  constructor() {
    super('balance change does not preserve channel total', 'BALANCE_MISMATCH');
    this.name = 'BalanceMismatchError';
  }
}

export class UnknownHtlcError extends StateMachineError {
  constructor(id: string) {
    super(`unknown htlc id: ${id}`, 'UNKNOWN_HTLC');
    this.name = 'UnknownHtlcError';
  }
}
