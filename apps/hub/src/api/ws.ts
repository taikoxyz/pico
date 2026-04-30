import type { WebSocket as WsWebSocket } from '@fastify/websocket';
import type { Address, ChainId, Channel, SignedState } from '@tainnel/protocol';
import type { ClientToHubMessage, HubMessage, HubToClientMessage } from '@tainnel/sdk';
import { decodeHubMessage, encodeHubMessage, hexToSignature } from '@tainnel/sdk';
import { buildChannelStateTypedData } from '@tainnel/state-machine';
import type { FastifyInstance } from 'fastify';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import type { ChannelPool } from '../channel-pool.js';
import { FlatPlusBpsFeePolicy } from '../fee-policy.js';
import type { Logger } from '../logger.js';
import { type InflightHtlc, Router } from '../router.js';

interface SubscriberSession {
  readonly socket: WsWebSocket;
  readonly address: Address;
}

export interface WsDeps {
  readonly channelPool: ChannelPool;
  readonly logger: Logger;
  readonly hubPrivateKey: `0x${string}`;
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly hubFeeBps: bigint;
  readonly hubFeeFlat: bigint;
}

export interface WsHandle {
  readonly hubAccount: PrivateKeyAccount;
  registerChannel(channel: Channel, initialState?: SignedState): void;
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

    deps.channelPool.recordState(incomingChannel.id, msg.signedState);

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
      send(socket, {
        id: `fail-${msg.htlc.id}`,
        kind: 'paymentFailed',
        channelId: msg.channelId,
        htlcId: msg.htlc.id,
        reason: (err as Error).message,
      });
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
    deps.channelPool.recordState(routed.outgoingChannel.id, routed.outgoingHubSigned);

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
    deps.channelPool.recordState(inflight.incomingChannelId, settledIncoming);
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
    deps.channelPool.recordState(inflight.incomingChannelId, failedIncoming);
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
    deps.channelPool.recordState(msg.channelId, acked);
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
    const sigHex = await hubAccount.signTypedData(
      buildChannelStateTypedData(msg.signedState.state, deps.chainId, deps.verifyingContract),
    );
    const sig = hexToSignature(sigHex);
    const hubIsA = ch.userA.toLowerCase() === hubAccount.address.toLowerCase();
    const countersigned: SignedState = {
      state: msg.signedState.state,
      sigA: hubIsA ? sig : msg.signedState.sigA,
      sigB: hubIsA ? msg.signedState.sigB : sig,
    };
    deps.channelPool.recordState(msg.channelId, countersigned);
    send(socket, {
      id: msg.id,
      kind: 'closeResponse',
      channelId: msg.channelId,
      signedCloseState: countersigned,
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

  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw: Buffer) => {
      let msg: HubMessage;
      try {
        msg = decodeHubMessage(raw.toString('utf8'));
      } catch (err) {
        deps.logger.warn({ err: (err as Error).message }, 'invalid ws message');
        return;
      }
      void dispatch(socket, msg).catch((err) => {
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
    registerChannel(channel: Channel, initialState?: SignedState): void {
      deps.channelPool.register(channel);
      if (initialState) deps.channelPool.recordState(channel.id, initialState);
    },
  };
}
