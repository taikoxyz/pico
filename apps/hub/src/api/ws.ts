import type { WebSocket as WsWebSocket } from '@fastify/websocket';
import type {
  Address,
  ChainId,
  Channel,
  SignedCooperativeClose,
  SignedState,
} from '@tainnel/protocol';
import type { ClientToHubMessage, HubMessage, HubToClientMessage } from '@tainnel/sdk';
import { decodeHubMessage, encodeHubMessage, hexToSignature } from '@tainnel/sdk';
import { buildChannelStateTypedData, buildCooperativeCloseTypedData } from '@tainnel/state-machine';
import type { FastifyInstance } from 'fastify';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type SignedEnvelope, verifyEnvelope } from '../auth/envelope.js';
import type { ChannelPool } from '../channel-pool.js';
import type { Repos } from '../db/repos/index.js';
import { FlatPlusBpsFeePolicy } from '../fee-policy.js';
import type { LiquidityTracker } from '../liquidity.js';
import type { Logger } from '../logger.js';
import type { HubMetrics } from '../metrics.js';
import { type InflightHtlc, Router } from '../router.js';

interface SubscriberSession {
  readonly socket: WsWebSocket;
  readonly address: Address;
}

export interface WsDeps {
  readonly channelPool: ChannelPool;
  readonly liquidity: LiquidityTracker;
  readonly repos: Repos;
  readonly metrics: HubMetrics;
  readonly logger: Logger;
  readonly hubPrivateKey: `0x${string}`;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly hubFeeBps: bigint;
  readonly hubFeeFlat: bigint;
  readonly requireSignedEnvelope: boolean;
  readonly nonceWindowMs: number;
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

  const sessions = new Map<string, SubscriberSession>();

  function send(socket: WsWebSocket, msg: HubToClientMessage): void {
    socket.send(encodeHubMessage(msg));
  }

  function sendError(socket: WsWebSocket, requestId: string, code: string, message: string): void {
    send(socket, { id: requestId, kind: 'error', code, message, requestId });
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

    await deps.channelPool.recordState(incomingChannel.id, msg.signedState);

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
      const reason = (err as Error).message;
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
    router.recordInflight(inflight);
    await deps.channelPool.recordState(routed.outgoingChannel.id, routed.outgoingHubSigned);

    await deps.repos.htlcs.save({
      htlc: msg.htlc,
      channelId: incomingChannel.id,
      state: 'inflight',
      incomingChannelId: incomingChannel.id,
      outgoingChannelId: routed.outgoingChannel.id,
    });
    await deps.repos.htlcs.save({
      htlc: routed.outgoingHtlc,
      channelId: routed.outgoingChannel.id,
      state: 'inflight',
      incomingChannelId: incomingChannel.id,
      outgoingChannelId: routed.outgoingChannel.id,
    });
    await deps.repos.payments.create({
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
    try {
      deps.liquidity.reserveOutbound(routed.outgoingChannel.id, routed.outgoingHtlc.amount);
    } catch (err) {
      deps.logger.warn(
        { err: (err as Error).message, channelId: routed.outgoingChannel.id },
        'liquidity reservation failed (continuing — state already advanced)',
      );
    }

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
    _socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'htlcSettle' }>,
  ): Promise<void> {
    const inflight = router.takeByOutgoingId(msg.htlcId);
    if (!inflight) {
      deps.logger.warn({ htlcId: msg.htlcId }, 'htlcSettle for unknown outgoing htlc');
      return;
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
    _socket: WsWebSocket,
    msg: Extract<ClientToHubMessage, { kind: 'htlcFail' }>,
  ): Promise<void> {
    const inflight = router.takeByOutgoingId(msg.htlcId);
    if (!inflight) {
      deps.logger.warn({ htlcId: msg.htlcId }, 'htlcFail for unknown outgoing htlc');
      return;
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

  async function dispatch(socket: WsWebSocket, msg: HubMessage): Promise<void> {
    switch (msg.kind) {
      case 'subscribe':
        return handleSubscribe(socket, msg);
      case 'pay':
        return handlePay(socket, msg);
      case 'htlcSettle':
        return handleHtlcSettle(socket, msg);
      case 'htlcFail':
        return handleHtlcFail(socket, msg);
      case 'payDirect':
        return handlePayDirect(socket, msg);
      case 'closeRequest':
        return handleCloseRequest(socket, msg);
      default:
        return;
    }
  }

  async function authorizeAndDispatch(socket: WsWebSocket, raw: string): Promise<void> {
    const parsedAny = JSON.parse(raw) as unknown;
    let inner: HubMessage;
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
      inner = decodeHubMessage(verify.payload);
    } else {
      inner = decodeHubMessage(raw);
    }
    return dispatch(socket, inner);
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
    },
  };
}
