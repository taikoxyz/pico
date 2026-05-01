import type { DbDriver } from '../types.js';
import { ChannelRepo } from './channel-repo.js';
import { DisputeRepo } from './dispute-repo.js';
import { HtlcRepo } from './htlc-repo.js';
import { KvRepo } from './kv-repo.js';
import { NonceRepo } from './nonce-repo.js';
import { PaymentRepo } from './payment-repo.js';
import { RouteRepo } from './route-repo.js';
import { StateRepo } from './state-repo.js';

export { ChannelRepo } from './channel-repo.js';
export { StateRepo, StaleVersionError } from './state-repo.js';
export { HtlcRepo } from './htlc-repo.js';
export type { HtlcRecord, HtlcLifecycleState, SaveHtlcInput } from './htlc-repo.js';
export { PaymentRepo } from './payment-repo.js';
export type { PaymentRecord, PaymentStatus, CreatePaymentInput } from './payment-repo.js';
export { NonceRepo, DuplicateNonceError } from './nonce-repo.js';
export { DisputeRepo } from './dispute-repo.js';
export type { DisputeRecord, DisputeResolution } from './dispute-repo.js';
export { KvRepo } from './kv-repo.js';
export { RouteRepo } from './route-repo.js';
export type { PaymentRoute, RouteState } from './route-repo.js';

export interface Repos {
  readonly channels: ChannelRepo;
  readonly states: StateRepo;
  readonly htlcs: HtlcRepo;
  readonly payments: PaymentRepo;
  readonly nonces: NonceRepo;
  readonly disputes: DisputeRepo;
  readonly kv: KvRepo;
  readonly routes: RouteRepo;
}

export function buildRepos(db: DbDriver): Repos {
  return {
    channels: new ChannelRepo(db),
    states: new StateRepo(db),
    htlcs: new HtlcRepo(db),
    payments: new PaymentRepo(db),
    nonces: new NonceRepo(db),
    disputes: new DisputeRepo(db),
    kv: new KvRepo(db),
    routes: new RouteRepo(db),
  };
}
