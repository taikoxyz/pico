import type { WebSocket as WsWebSocket } from '@fastify/websocket';
import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  SignedCooperativeClose,
  SignedState,
} from '@pico/protocol';
import type { ClientToHubMessage, HubMessage, HubToClientMessage } from '@pico/sdk';
import { decodeHubMessage, encodeHubMessage, hexToSignature } from '@pico/sdk';
import {
  StateAdmissionError,
  admitClose,
  admitHtlcOffer,
  admitSignedState,
  buildChannelStateTypedData,
  buildCooperativeCloseTypedData,
} from '@pico/state-machine';
import type { FastifyInstance } from 'fastify';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type SignedEnvelope, verifyEnvelope } from '../auth/envelope.js';
import type { ChannelPool } from '../channel-pool.js';
import type { Database } from '../db/index.js';
import { type Repos, buildRepos } from '../db/repos/index.js';
import { FlatPlusBpsFeePolicy } from '../fee-policy.js';
import type { LiquidityTracker } from '../liquidity.js';
import type { Logger } from '../logger.js';
import type { HubMetrics } from '../metrics.js';
import { KeyedMutex } from '../mutex.js';
import { type InflightHtlc, Router } from '../router.js';

interface SubscriberSession {
  readonly socket: WsWebSocket;
  readonly address: Address;
}

export interface WsDeps {
  readonly channelPool: ChannelPool;
  readonly liquidity: LiquidityTracker;
  readonly repos: Repos;
  readonly db: Database;
  readonly metrics: HubMetrics;
  readonly logger: Logger;
  readonly hubPrivateKey: `0x${string}`;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly hubFeeBps: bigint;
  readonly hubFeeFlat: bigint;
  readonly requireSignedEnvelope: boolean;
  readonly nonceWindowMs: number;
  readonly paymentRetentionPerChannel: number;
}

export interface WsHandle {
  readonly hubAccount: PrivateKeyAccount;
  registerChannel(channel: Channel, initialState?: SignedState): Promise<void>;
}

function isSignedEnvelope(value: unknown): value is SignedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nonce === 'string' &&
    typeof v.ts === 'number' &&
    typeof v.payload === 'string' &&
    typeof v.sig === 'string'
  );
}

export async function registerWsRoutes(app: FastifyInstance, deps: WsDeps): Promise<WsHandle> {
  const hubAccount = privateKeyToAccount(deps.hubPrivateKey);
  const router = new Router({
    channelPool: deps.channelPool,
    feePolicy: new FlatPlusBpsFeePolicy(deps.hubFeeBps, deps.hubFeeFlat),
    hubAccount,
    chainId: deps.chainId,
    verifyingContract: deps.verifyingContract,
    logger: deps.logger,
  });
  await router.hydrate(deps.repos);

  const sessions = new Map<string, SubscriberSession>();
  // Serializes route+sign+save per outgoing channel to prevent the hub
  // from signing two conflicting same-version states under concurrency.
  // Locks are taken in deterministic ChannelId order (lowest first) when a
  // pay handler must lock both incoming and outgoing channels (H-04).
  const channelMutex = new KeyedMutex<ChannelId>();
  function lockOrder(a: ChannelId, b: ChannelId): readonly [ChannelId, ChannelId] {
    return a < b ? [a, b] : [b, a];
  }

  function send(socket: WsWebSocket, msg: HubToClientMessage): void {
    socket.send(encodeHubMessage(msg));
  }

  function sendError(socket: WsWebSocket, requestId: string, code: string, message: string): void {
    send(socket, { id: requestId, kind: 'error', code, message, requestId });
  }

  let paymentPruneRunning = false;
  let paymentPruneQueued = false;

  function schedulePaymentPrune(): void {
    if (deps.paymentRetentionPerChannel <= 0) return;
    paymentPruneQueued = true;
    if (paymentPruneRunning) return;
    paymentPruneRunning = true;
    void runQueuedPaymentPrunes();
  }

  async function runQueuedPaymentPrunes(): Promise<void> {
    try {
      while (paymentPruneQueued) {
        paymentPruneQueued = false;
        try {
          await deps.repos.payments.prunePerChannel(deps.paymentRetentionPerChannel);
        } catch (err) {
          deps.logger.warn({ err: (err as Error).message }, 'payment retention prune failed');
        }
      }
    } finally {
      paymentPruneRunning = false;
      if (paymentPruneQueued) schedulePaymentPrune();
    }
  }

  function knownPartiesForChannel(channel: Channel): ReadonlySet<Address> {
    return new Set([channel.userA, channel.userB] as Address[]);
  }

  async function handleSubscribe(
    socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'subscribe' }>,
  ): Promise<void> {
    const key = msg.address.toLowerCase();
    sessions.set(key, { socket, address: msg.address });
    const channels = deps.channelPool
      .list()
      .filter((c) => c.userA.toLowerCase() === key || c.userB.toLowerCase() === key);
    const pending = router.pendingForRecipient(msg.address);
    send(socket, {
      id: msg.id,
      kind: 'subscribeAck',
      sessionId: `hub-${msg.address}-${Date.now()}`,
      channels,
      pendingHtlcs: pending.map((i) => ({
        channelId: i.outgoingChannelId,
        htlc: i.outgoingHtlc,
      })),
    });
    for (const item of pending) {
      send(socket, {
        id: `offer-${item.outgoingHtlcId}`,
        kind: 'htlcOffer',
        channelId: item.outgoingChannelId,
        htlc: item.outgoingHtlc,
        signedStateBeforeHtlc: item.outgoingHubSigned,
      });
    }
  }

  async function handlePay(
    socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'pay' }>,
  ): Promise<void> {
    const incomingChannel = deps.channelPool.get(msg.channelId);
    if (!incomingChannel) {
      sendError(socket, msg.id, 'UNKNOWN_CHANNEL', `unknown channel ${msg.channelId}`);
      return;
    }
    const senderAddr =
      incomingChannel.userA.toLowerCase() === hubAccount.address.toLowerCase()
        ? incomingChannel.userB
        : incomingChannel.userA;

    const incomingPrev = deps.channelPool.latest(incomingChannel.id);
    try {
      await admitHtlcOffer(
        msg.signedState,
        {
          channel: incomingChannel,
          chainId: deps.chainId,
          verifyingContract: deps.verifyingContract,
        },
        {
          prev: incomingPrev?.state,
          allowEqualVersion: true,
          allowPartialSigs: true,
          requireSignerAddresses: [senderAddr],
          expectedHtlc: msg.htlc,
        },
      );
    } catch (err) {
      const code = err instanceof StateAdmissionError ? err.code : 'INVALID_STATE';
      sendError(socket, msg.id, code, (err as Error).message);
      return;
    }
    await deps.channelPool.recordState(incomingChannel.id, msg.signedState);

    // Serialize route+sign+persist per outgoing channel to prevent equivocation
    // (H-04). We don't yet know the outgoing channel id until router.route()
    // resolves it, so first take a sender-keyed lock to serialize concurrent
    // pays from the same sender, then route under a per-outgoing-channel
    // pre-route step. To keep things simple, lock the incoming channel here;
    // the per-outgoing-channel mutex is taken inside router.route via the
    // channel-pool's existing locks.
    const result = await channelMutex.run(incomingChannel.id, async () => {
      let routed: Awaited<ReturnType<typeof router.route>>;
      try {
        routed = await router.route({
          incomingChannel,
          incomingSignedState: msg.signedState,
          incomingHtlc: msg.htlc,
          recipient: msg.recipient,
          amount: msg.amount,
          paymentHash: msg.paymentHash,
        });
      } catch (err) {
        return { kind: 'rejected' as const, reason: (err as Error).message };
      }

      // Hold the outgoing-channel mutex across the persistence sequence so
      // two concurrent pays cannot both record same-version state.
      return channelMutex.run(routed.outgoingChannel.id, async () => {
        const inflight: InflightHtlc = {
          incomingChannelId: incomingChannel.id,
          incomingHtlcId: msg.htlc.id,
          incomingSignedState: msg.signedState,
          incomingSenderAddress: senderAddr,
          outgoingChannelId: routed.outgoingChannel.id,
          outgoingHtlcId: routed.outgoingHtlc.id,
          outgoingHtlc: routed.outgoingHtlc,
          outgoingHubSigned: routed.outgoingHubSigned,
          recipient: msg.recipient,
        };

        // Reserve liquidity BEFORE any durable state changes. If the outbound
        // channel is oversubscribed we must reject without advancing channel
        // state or persisting a route, otherwise the hub commits to forwarding
        // past its outbound cap.
        try {
          deps.liquidity.reserveOutbound(routed.outgoingChannel.id, routed.outgoingHtlc.amount);
        } catch (err) {
          return { kind: 'rejected' as const, reason: (err as Error).message };
        }

        await deps.channelPool.recordState(routed.outgoingChannel.id, routed.outgoingHubSigned);

        try {
          await deps.db.driver.transaction(async (tx) => {
            const txRepos = buildRepos(tx);
            await txRepos.htlcs.save({
              htlc: msg.htlc,
              channelId: incomingChannel.id,
              state: 'inflight',
              incomingChannelId: incomingChannel.id,
              outgoingChannelId: routed.outgoingChannel.id,
            });
            await txRepos.htlcs.save({
              htlc: routed.outgoingHtlc,
              channelId: routed.outgoingChannel.id,
              state: 'inflight',
              incomingChannelId: incomingChannel.id,
              outgoingChannelId: routed.outgoingChannel.id,
            });
            await txRepos.payments.create({
              id: `${msg.channelId}-${msg.htlc.id}`,
              paymentHash: msg.paymentHash,
              incomingChannelId: incomingChannel.id,
              outgoingChannelId: routed.outgoingChannel.id,
              incomingHtlcId: msg.htlc.id,
              outgoingHtlcId: routed.outgoingHtlc.id,
              recipient: msg.recipient,
              amount: msg.amount,
              fee: routed.fee,
              status: 'in_flight',
            });
            // WS-9: persist the route so router.hydrate() can rebuild
            // in-memory inflight maps after a restart.
            await txRepos.routes.insert({
              incomingChannelId: incomingChannel.id,
              incomingHtlcId: msg.htlc.id,
              outgoingChannelId: routed.outgoingChannel.id,
              outgoingHtlcId: routed.outgoingHtlc.id,
              sender: senderAddr,
              recipient: msg.recipient,
              paymentHash: msg.paymentHash,
              incomingSignedState: msg.signedState,
              outgoingHubSigned: routed.outgoingHubSigned,
              outgoingHtlc: routed.outgoingHtlc,
            });
          });
        } catch (err) {
          deps.liquidity.releaseReservation(routed.outgoingChannel.id, routed.outgoingHtlc.amount);
          return { kind: 'tx_failed' as const, reason: (err as Error).message };
        }

        router.recordInflight(inflight);
        return { kind: 'ok' as const, routed };
      });
    });

    if (result.kind === 'rejected' || result.kind === 'tx_failed') {
      const reason =
        result.kind === 'rejected' ? result.reason : `db transaction failed: ${result.reason}`;
      send(socket, {
        id: `fail-${msg.htlc.id}`,
        kind: 'paymentFailed',
        channelId: msg.channelId,
        htlcId: msg.htlc.id,
        reason,
      });
      deps.metrics.paymentsTotal.inc({ result: 'rejected' });
      return;
    }
    const routed = result.routed;

    const recipientSession = sessions.get(msg.recipient.toLowerCase());
    if (!recipientSession) {
      deps.logger.info(
        { htlcId: routed.outgoingHtlc.id, recipient: msg.recipient },
        'recipient offline; HTLC queued for redelivery on subscribe',
      );
      return;
    }

    send(recipientSession.socket, {
      id: `offer-${routed.outgoingHtlc.id}`,
      kind: 'htlcOffer',
      channelId: routed.outgoingChannel.id,
      htlc: routed.outgoingHtlc,
      signedStateBeforeHtlc: routed.outgoingHubSigned,
      ...(msg.keysendPayload !== undefined ? { keysendPayload: msg.keysendPayload } : {}),
    });
  }

  async function handleHtlcSettle(
    socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'htlcSettle' }>,
  ): Promise<void> {
    const inflight = router.peekByOutgoingId(msg.htlcId);
    if (!inflight) {
      deps.logger.warn({ htlcId: msg.htlcId }, 'htlcSettle for unknown outgoing htlc');
      sendError(socket, msg.id, 'UNKNOWN_HTLC', `unknown outgoing htlc ${msg.htlcId}`);
      return;
    }
    if (inflight.outgoingChannelId !== msg.channelId) {
      sendError(
        socket,
        msg.id,
        'CHANNEL_MISMATCH',
        `htlcSettle channelId ${msg.channelId} does not match route ${inflight.outgoingChannelId}`,
      );
      return;
    }
    const outgoingChannel = deps.channelPool.get(inflight.outgoingChannelId);
    if (!outgoingChannel) {
      sendError(socket, msg.id, 'UNKNOWN_CHANNEL', 'outgoing channel missing');
      return;
    }
    try {
      await admitSignedState(
        msg.signedState,
        {
          channel: outgoingChannel,
          chainId: deps.chainId,
          verifyingContract: deps.verifyingContract,
        },
        {
          prev: inflight.outgoingHubSigned.state,
          allowEqualVersion: true,
          allowPartialSigs: true,
          requireSignerAddresses: [inflight.recipient],
        },
      );
    } catch (err) {
      const code = err instanceof StateAdmissionError ? err.code : 'INVALID_STATE';
      sendError(socket, msg.id, code, (err as Error).message);
      return;
    }
    // Validation passed; now consume the inflight entry atomically.
    router.takeByOutgoingId(msg.htlcId);
    try {
      await deps.repos.routes.markSettled(inflight.outgoingHtlcId);
    } catch (err) {
      deps.logger.warn(
        { err: (err as Error).message, outgoingHtlcId: inflight.outgoingHtlcId },
        'route already marked or missing; continuing settle',
      );
    }
    const settledIncoming = await router.settleIncoming(inflight, msg.preimage, msg.signedState);
    await deps.channelPool.recordState(inflight.incomingChannelId, settledIncoming);
    deps.liquidity.releaseReservation(inflight.outgoingChannelId, inflight.outgoingHtlc.amount);
    await deps.repos.htlcs.setState(inflight.incomingHtlcId, 'settled');
    await deps.repos.htlcs.setState(inflight.outgoingHtlcId, 'settled');
    await deps.repos.payments.settle(
      `${inflight.incomingChannelId}-${inflight.incomingHtlcId}`,
      msg.preimage,
    );
    schedulePaymentPrune();
    deps.metrics.paymentsTotal.inc({ result: 'settled' });

    const senderSession = sessions.get(inflight.incomingSenderAddress.toLowerCase());
    if (!senderSession) {
      deps.logger.warn({ sender: inflight.incomingSenderAddress }, 'sender not subscribed');
      return;
    }
    send(senderSession.socket, {
      id: `settle-${inflight.incomingHtlcId}`,
      kind: 'paymentSettle',
      channelId: inflight.incomingChannelId,
      htlcId: inflight.incomingHtlcId,
      preimage: msg.preimage,
      signedStateAfterSettle: settledIncoming,
    });
  }

  async function handleHtlcFail(
    socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'htlcFail' }>,
  ): Promise<void> {
    const inflight = router.peekByOutgoingId(msg.htlcId);
    if (!inflight) {
      deps.logger.warn({ htlcId: msg.htlcId }, 'htlcFail for unknown outgoing htlc');
      sendError(socket, msg.id, 'UNKNOWN_HTLC', `unknown outgoing htlc ${msg.htlcId}`);
      return;
    }
    if (inflight.outgoingChannelId !== msg.channelId) {
      sendError(
        socket,
        msg.id,
        'CHANNEL_MISMATCH',
        `htlcFail channelId ${msg.channelId} does not match route ${inflight.outgoingChannelId}`,
      );
      return;
    }
    router.takeByOutgoingId(msg.htlcId);
    try {
      await deps.repos.routes.markFailed(inflight.outgoingHtlcId);
    } catch (err) {
      deps.logger.warn(
        { err: (err as Error).message, outgoingHtlcId: inflight.outgoingHtlcId },
        'route already marked or missing; continuing fail',
      );
    }
    const failedIncoming = await router.failIncoming(inflight);
    await deps.channelPool.recordState(inflight.incomingChannelId, failedIncoming);
    deps.liquidity.releaseReservation(inflight.outgoingChannelId, inflight.outgoingHtlc.amount);
    await deps.repos.htlcs.setState(inflight.incomingHtlcId, 'failed');
    await deps.repos.htlcs.setState(inflight.outgoingHtlcId, 'failed');
    await deps.repos.payments.fail(
      `${inflight.incomingChannelId}-${inflight.incomingHtlcId}`,
      msg.reason,
    );
    schedulePaymentPrune();
    deps.metrics.paymentsTotal.inc({ result: 'failed' });

    const senderSession = sessions.get(inflight.incomingSenderAddress.toLowerCase());
    if (!senderSession) return;
    send(senderSession.socket, {
      id: `fail-${inflight.incomingHtlcId}`,
      kind: 'paymentFailed',
      channelId: inflight.incomingChannelId,
      htlcId: inflight.incomingHtlcId,
      reason: msg.reason,
    });
  }

  async function handlePayDirect(
    socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'payDirect' }>,
  ): Promise<void> {
    const ch = deps.channelPool.get(msg.channelId);
    if (!ch) {
      sendError(socket, msg.id, 'UNKNOWN_CHANNEL', `unknown channel ${msg.channelId}`);
      return;
    }
    const senderAddrDirect =
      ch.userA.toLowerCase() === hubAccount.address.toLowerCase() ? ch.userB : ch.userA;
    const prevDirect = deps.channelPool.latest(msg.channelId);
    try {
      await admitSignedState(
        msg.signedState,
        {
          channel: ch,
          chainId: deps.chainId,
          verifyingContract: deps.verifyingContract,
        },
        {
          prev: prevDirect?.state,
          allowEqualVersion: true,
          allowPartialSigs: true,
          requireSignerAddresses: [senderAddrDirect],
        },
      );
    } catch (err) {
      const code = err instanceof StateAdmissionError ? err.code : 'INVALID_STATE';
      sendError(socket, msg.id, code, (err as Error).message);
      return;
    }
    const sigHex = await hubAccount.signTypedData(
      buildChannelStateTypedData(msg.signedState.state, deps.chainId, deps.verifyingContract),
    );
    const sig = hexToSignature(sigHex);
    const hubIsA = ch.userA.toLowerCase() === hubAccount.address.toLowerCase();
    const acked: SignedState = {
      state: msg.signedState.state,
      sigA: hubIsA ? sig : msg.signedState.sigA,
      sigB: hubIsA ? msg.signedState.sigB : sig,
    };
    await deps.channelPool.recordState(msg.channelId, acked);
    deps.metrics.paymentsTotal.inc({ result: 'direct' });
    send(socket, {
      id: msg.id,
      kind: 'payDirectAck',
      channelId: msg.channelId,
      signedState: acked,
    });
  }

  async function handleCloseRequest(
    socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'closeRequest' }>,
  ): Promise<void> {
    const ch = deps.channelPool.get(msg.channelId);
    if (!ch) {
      sendError(socket, msg.id, 'UNKNOWN_CHANNEL', `unknown channel ${msg.channelId}`);
      return;
    }
    const latest = deps.channelPool.latest(msg.channelId);
    if (!latest) {
      sendError(socket, msg.id, 'NO_STATE', `no signed state for channel ${msg.channelId}`);
      return;
    }
    if (latest.state.htlcs.length > 0 || msg.signedState.state.htlcs.length > 0) {
      sendError(socket, msg.id, 'PENDING_HTLCS', 'cooperative close requires no in-flight HTLCs');
      return;
    }
    if (
      msg.signedState.state.channelId !== msg.channelId ||
      msg.signedState.state.version !== latest.state.version + 1n ||
      msg.signedState.state.balanceA !== latest.state.balanceA ||
      msg.signedState.state.balanceB !== latest.state.balanceB ||
      msg.signedCooperativeClose.close.channelId !== msg.channelId ||
      msg.signedCooperativeClose.close.finalBalanceA !== msg.signedState.state.balanceA ||
      msg.signedCooperativeClose.close.finalBalanceB !== msg.signedState.state.balanceB ||
      !msg.signedState.state.finalized
    ) {
      sendError(socket, msg.id, 'INVALID_CLOSE', 'cooperative close does not match final state');
      return;
    }
    const senderAddrClose =
      ch.userA.toLowerCase() === hubAccount.address.toLowerCase() ? ch.userB : ch.userA;
    try {
      await admitClose(
        msg.signedState,
        {
          channel: ch,
          chainId: deps.chainId,
          verifyingContract: deps.verifyingContract,
        },
        { allowPartialSigs: true, requireSignerAddresses: [senderAddrClose] },
      );
    } catch (err) {
      sendError(socket, msg.id, 'INVALID_CLOSE', (err as Error).message);
      return;
    }
    const sigHex = await hubAccount.signTypedData(
      buildChannelStateTypedData(msg.signedState.state, deps.chainId, deps.verifyingContract),
    );
    const closeSigHex = await hubAccount.signTypedData(
      buildCooperativeCloseTypedData(
        msg.signedCooperativeClose.close,
        deps.chainId,
        deps.verifyingContract,
      ),
    );
    const sig = hexToSignature(sigHex);
    const closeSig = hexToSignature(closeSigHex);
    const hubIsA = ch.userA.toLowerCase() === hubAccount.address.toLowerCase();
    const countersigned: SignedState = {
      state: msg.signedState.state,
      sigA: hubIsA ? sig : msg.signedState.sigA,
      sigB: hubIsA ? msg.signedState.sigB : sig,
    };
    const countersignedClose: SignedCooperativeClose = {
      close: msg.signedCooperativeClose.close,
      sigA: hubIsA ? closeSig : msg.signedCooperativeClose.sigA,
      sigB: hubIsA ? msg.signedCooperativeClose.sigB : closeSig,
    };
    await deps.channelPool.recordState(msg.channelId, countersigned);
    send(socket, {
      id: msg.id,
      kind: 'closeResponse',
      channelId: msg.channelId,
      signedCloseState: countersigned,
      signedCooperativeClose: countersignedClose,
    });
  }

  function authorizedSignerForChannel(
    signer: Address | undefined,
    channelId: ChannelId,
  ): { ok: true } | { ok: false; reason: string } {
    if (signer === undefined) return { ok: true };
    const ch = deps.channelPool.get(channelId);
    if (!ch) return { ok: false, reason: `unknown channel ${channelId}` };
    const lower = signer.toLowerCase();
    if (lower === ch.userA.toLowerCase() || lower === ch.userB.toLowerCase()) {
      return { ok: true };
    }
    return { ok: false, reason: `signer ${signer} is not a party of channel ${channelId}` };
  }

  async function dispatch(
    socket: WsWebSocket,
    msg: HubMessage,
    signer: Address | undefined,
  ): Promise<void> {
    switch (msg.kind) {
      case 'subscribe':
        if (signer && signer.toLowerCase() !== msg.address.toLowerCase()) {
          sendError(
            socket,
            msg.id,
            'UNAUTHORIZED',
            `subscribe signer ${signer} does not match address ${msg.address}`,
          );
          return;
        }
        return handleSubscribe(socket, msg);
      case 'pay': {
        const auth = authorizedSignerForChannel(signer, msg.channelId);
        if (!auth.ok) {
          sendError(socket, msg.id, 'UNAUTHORIZED', auth.reason);
          return;
        }
        return handlePay(socket, msg);
      }
      case 'htlcSettle':
        return handleHtlcSettle(socket, msg);
      case 'htlcFail':
        return handleHtlcFail(socket, msg);
      case 'payDirect': {
        const auth = authorizedSignerForChannel(signer, msg.channelId);
        if (!auth.ok) {
          sendError(socket, msg.id, 'UNAUTHORIZED', auth.reason);
          return;
        }
        return handlePayDirect(socket, msg);
      }
      case 'closeRequest': {
        const auth = authorizedSignerForChannel(signer, msg.channelId);
        if (!auth.ok) {
          sendError(socket, msg.id, 'UNAUTHORIZED', auth.reason);
          return;
        }
        return handleCloseRequest(socket, msg);
      }
      default:
        return;
    }
  }

  async function authorizeAndDispatch(socket: WsWebSocket, raw: string): Promise<void> {
    let parsedAny: unknown;
    try {
      parsedAny = JSON.parse(raw) as unknown;
    } catch (err) {
      deps.logger.warn({ err: (err as Error).message }, 'ws message: invalid JSON');
      return;
    }
    let inner: HubMessage;
    let signer: Address | undefined;
    if (deps.requireSignedEnvelope) {
      if (!isSignedEnvelope(parsedAny)) {
        deps.logger.warn('signed envelope required but message is unwrapped');
        return;
      }
      const channels = deps.channelPool.list();
      const knownSigners = new Set<Address>();
      for (const c of channels) {
        for (const a of knownPartiesForChannel(c)) knownSigners.add(a);
      }
      const verify = await verifyEnvelope({
        envelope: parsedAny,
        knownSigners,
        nonceRepo: deps.repos.nonces,
        windowMs: deps.nonceWindowMs,
      });
      if (!verify.ok) {
        deps.logger.warn({ reason: verify.reason }, 'envelope verification failed');
        return;
      }
      try {
        inner = decodeHubMessage(verify.payload);
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message }, 'inner payload decode failed');
        return;
      }
      signer = verify.signer;
    } else {
      try {
        inner = decodeHubMessage(raw);
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message }, 'ws message decode failed');
        return;
      }
    }
    return dispatch(socket, inner, signer);
  }

  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw: Buffer) => {
      void authorizeAndDispatch(socket, raw.toString('utf8')).catch((err) => {
        deps.logger.error({ err }, 'ws handler error');
      });
    });
    socket.on('close', () => {
      for (const [k, sess] of sessions) {
        if (sess.socket === socket) sessions.delete(k);
      }
    });
  });

  return {
    hubAccount,
    async registerChannel(channel: Channel, initialState?: SignedState): Promise<void> {
      await deps.channelPool.register(channel, initialState);
      const seedState = initialState ?? deps.channelPool.latest(channel.id);
      if (seedState) {
        const hubIsA = channel.userA.toLowerCase() === hubAccount.address.toLowerCase();
        deps.liquidity.set(channel.id, {
          outbound: hubIsA ? seedState.state.balanceA : seedState.state.balanceB,
          inbound: hubIsA ? seedState.state.balanceB : seedState.state.balanceA,
        });
      }
    },
  };
}
