import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  Hex,
  Htlc,
  HtlcId,
  SignedCooperativeClose,
  SignedState,
} from '@tainnel/protocol';
import { buildChannelStateTypedData, buildCooperativeCloseTypedData } from '@tainnel/state-machine';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type AddressInfo, type WebSocket, WebSocketServer } from 'ws';
import {
  type ClientToHubMessage,
  type HubMessage,
  type HubToClientMessage,
  type PayMessage,
  decodeHubMessage,
  encodeHubMessage,
} from '../hub-protocol.js';
import { hexToSignature } from '../signature-codec.js';

export interface MockHubOptions {
  readonly port?: number;
  readonly channels?: readonly Channel[];
  readonly chainId: ChainId;
  readonly verifyingContract: Address;
  readonly hubPrivateKey?: Hex;
  readonly hubFeeBps?: bigint;
}

export interface PendingHtlc {
  readonly channelId: ChannelId;
  readonly htlc: Htlc;
  readonly senderAddress: Address;
  readonly signedStateBeforeHtlc: SignedState;
  readonly keysendPayload?: PayMessage['keysendPayload'];
}

export interface MockHubHandle {
  readonly url: string;
  readonly hubAddress: Address;
  pendingHtlcs(): readonly PendingHtlc[];
  registerChannel(channel: Channel): void;
  stop(): Promise<void>;
}

interface SubscriberSession {
  readonly socket: WebSocket;
  readonly address: Address;
  readonly encryptionPubkey?: Hex;
}

export async function startMockHub(opts: MockHubOptions): Promise<MockHubHandle> {
  const wss = new WebSocketServer({ port: opts.port ?? 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;

  const hubAccount: PrivateKeyAccount | undefined = opts.hubPrivateKey
    ? privateKeyToAccount(opts.hubPrivateKey)
    : undefined;

  const channels = new Map<ChannelId, Channel>();
  for (const ch of opts.channels ?? []) channels.set(ch.id, ch);

  const sessions = new Map<Address, SubscriberSession>();
  const pendingHtlcs = new Map<HtlcId, PendingHtlc>();

  function send(socket: WebSocket, msg: HubToClientMessage): void {
    socket.send(encodeHubMessage(msg));
  }

  function findChannelsForAddress(address: Address): Channel[] {
    const addrLower = address.toLowerCase();
    return Array.from(channels.values()).filter(
      (c) => c.userA.toLowerCase() === addrLower || c.userB.toLowerCase() === addrLower,
    );
  }

  async function handleMessage(socket: WebSocket, msg: ClientToHubMessage): Promise<void> {
    if (msg.kind === 'subscribe') {
      const session: SubscriberSession = {
        socket,
        address: msg.address,
        ...(msg.encryptionPubkey !== undefined ? { encryptionPubkey: msg.encryptionPubkey } : {}),
      };
      sessions.set(msg.address.toLowerCase() as Address, session);
      const yours = findChannelsForAddress(msg.address);
      const yourPending: { channelId: ChannelId; htlc: Htlc }[] = [];
      for (const p of pendingHtlcs.values()) {
        const ch = channels.get(p.channelId);
        if (!ch) continue;
        const counterparty =
          ch.userA.toLowerCase() === p.senderAddress.toLowerCase() ? ch.userB : ch.userA;
        if (counterparty.toLowerCase() === msg.address.toLowerCase()) {
          yourPending.push({ channelId: p.channelId, htlc: p.htlc });
        }
      }
      send(socket, {
        id: msg.id,
        kind: 'subscribeAck',
        sessionId: `mock-${msg.address}-${Date.now()}`,
        channels: yours,
        pendingHtlcs: yourPending,
      });
      return;
    }

    if (msg.kind === 'pay') {
      const ch = channels.get(msg.channelId);
      if (!ch) {
        send(socket, {
          id: msg.id,
          kind: 'error',
          code: 'UNKNOWN_CHANNEL',
          message: `unknown channel ${msg.channelId}`,
          requestId: msg.id,
        });
        return;
      }
      const senderAddress =
        ch.userA.toLowerCase() === msg.recipient.toLowerCase() ? ch.userB : ch.userA;
      pendingHtlcs.set(msg.htlc.id, {
        channelId: msg.channelId,
        htlc: msg.htlc,
        senderAddress,
        signedStateBeforeHtlc: msg.signedState,
        ...(msg.keysendPayload !== undefined ? { keysendPayload: msg.keysendPayload } : {}),
      });
      const recipientSession = sessions.get(msg.recipient.toLowerCase() as Address);
      if (!recipientSession) {
        pendingHtlcs.delete(msg.htlc.id);
        send(socket, {
          id: msg.id,
          kind: 'paymentFailed',
          channelId: msg.channelId,
          htlcId: msg.htlc.id,
          reason: 'recipient not subscribed',
        });
        return;
      }
      send(recipientSession.socket, {
        id: `offer-${msg.htlc.id}`,
        kind: 'htlcOffer',
        channelId: msg.channelId,
        htlc: msg.htlc,
        signedStateBeforeHtlc: msg.signedState,
        ...(msg.keysendPayload !== undefined ? { keysendPayload: msg.keysendPayload } : {}),
      });
      return;
    }

    if (msg.kind === 'htlcSettle') {
      const pending = pendingHtlcs.get(msg.htlcId);
      pendingHtlcs.delete(msg.htlcId);
      if (!pending) return;
      const senderSession = sessions.get(pending.senderAddress.toLowerCase() as Address);
      if (!senderSession) return;
      send(senderSession.socket, {
        id: `settle-${msg.htlcId}`,
        kind: 'paymentSettle',
        channelId: msg.channelId,
        htlcId: msg.htlcId,
        preimage: msg.preimage,
        signedStateAfterSettle: msg.signedState,
      });
      return;
    }

    if (msg.kind === 'htlcFail') {
      const pending = pendingHtlcs.get(msg.htlcId);
      pendingHtlcs.delete(msg.htlcId);
      if (!pending) return;
      const senderSession = sessions.get(pending.senderAddress.toLowerCase() as Address);
      if (!senderSession) return;
      send(senderSession.socket, {
        id: `fail-${msg.htlcId}`,
        kind: 'paymentFailed',
        channelId: msg.channelId,
        htlcId: msg.htlcId,
        reason: msg.reason,
      });
      return;
    }

    if (msg.kind === 'payDirect') {
      const ch = channels.get(msg.channelId);
      if (!ch) {
        send(socket, {
          id: msg.id,
          kind: 'error',
          code: 'UNKNOWN_CHANNEL',
          message: `unknown channel ${msg.channelId}`,
          requestId: msg.id,
        });
        return;
      }
      let acked = msg.signedState;
      if (hubAccount) {
        const stateSig = await hubAccount.signTypedData(
          buildChannelStateTypedData(msg.signedState.state, opts.chainId, opts.verifyingContract),
        );
        const hubSig = hexToSignature(stateSig);
        const hubIsA = ch.userA.toLowerCase() === hubAccount.address.toLowerCase();
        acked = {
          state: msg.signedState.state,
          sigA: hubIsA ? hubSig : msg.signedState.sigA,
          sigB: hubIsA ? msg.signedState.sigB : hubSig,
        };
      }
      send(socket, {
        id: msg.id,
        kind: 'payDirectAck',
        channelId: msg.channelId,
        signedState: acked,
      });
      return;
    }

    if (msg.kind === 'closeRequest') {
      const ch = channels.get(msg.channelId);
      if (!ch) {
        send(socket, {
          id: msg.id,
          kind: 'error',
          code: 'UNKNOWN_CHANNEL',
          message: `unknown channel ${msg.channelId}`,
          requestId: msg.id,
        });
        return;
      }
      if (msg.signedState.state.htlcs.length > 0) {
        send(socket, {
          id: msg.id,
          kind: 'error',
          code: 'PENDING_HTLCS',
          message: 'cooperative close requires no in-flight HTLCs',
          requestId: msg.id,
        });
        return;
      }
      if (
        msg.signedState.state.channelId !== msg.channelId ||
        msg.signedCooperativeClose.close.channelId !== msg.channelId ||
        msg.signedCooperativeClose.close.finalBalanceA !== msg.signedState.state.balanceA ||
        msg.signedCooperativeClose.close.finalBalanceB !== msg.signedState.state.balanceB ||
        !msg.signedState.state.finalized
      ) {
        send(socket, {
          id: msg.id,
          kind: 'error',
          code: 'INVALID_CLOSE',
          message: 'cooperative close does not match final state',
          requestId: msg.id,
        });
        return;
      }
      let countersignedState = msg.signedState;
      let countersignedClose: SignedCooperativeClose = msg.signedCooperativeClose;
      if (hubAccount) {
        const stateSig = await hubAccount.signTypedData(
          buildChannelStateTypedData(msg.signedState.state, opts.chainId, opts.verifyingContract),
        );
        const closeSigHex = await hubAccount.signTypedData(
          buildCooperativeCloseTypedData(
            msg.signedCooperativeClose.close,
            opts.chainId,
            opts.verifyingContract,
          ),
        );
        const hubSig = hexToSignature(stateSig);
        const closeSig = hexToSignature(closeSigHex);
        const hubIsA = ch.userA.toLowerCase() === hubAccount.address.toLowerCase();
        countersignedState = {
          state: msg.signedState.state,
          sigA: hubIsA ? hubSig : msg.signedState.sigA,
          sigB: hubIsA ? msg.signedState.sigB : hubSig,
        };
        countersignedClose = {
          close: msg.signedCooperativeClose.close,
          sigA: hubIsA ? closeSig : msg.signedCooperativeClose.sigA,
          sigB: hubIsA ? msg.signedCooperativeClose.sigB : closeSig,
        };
      }
      send(socket, {
        id: msg.id,
        kind: 'closeResponse',
        channelId: msg.channelId,
        signedCloseState: countersignedState,
        signedCooperativeClose: countersignedClose,
      });
      return;
    }
  }

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      let msg: HubMessage;
      try {
        msg = decodeHubMessage(raw.toString('utf8'));
      } catch {
        return;
      }
      if (
        msg.kind === 'subscribe' ||
        msg.kind === 'pay' ||
        msg.kind === 'payDirect' ||
        msg.kind === 'htlcSettle' ||
        msg.kind === 'htlcFail' ||
        msg.kind === 'closeRequest'
      ) {
        void handleMessage(socket, msg);
      }
    });
    socket.on('close', () => {
      for (const [addr, sess] of sessions) {
        if (sess.socket === socket) sessions.delete(addr);
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}`,
    hubAddress: hubAccount?.address ?? ('0x0000000000000000000000000000000000000000' as Address),
    pendingHtlcs(): readonly PendingHtlc[] {
      return Array.from(pendingHtlcs.values());
    },
    registerChannel(ch: Channel): void {
      channels.set(ch.id, ch);
    },
    stop(): Promise<void> {
      return new Promise<void>((resolve) => {
        for (const c of wss.clients) {
          try {
            c.terminate();
          } catch {
            // ignore
          }
        }
        wss.close(() => resolve());
      });
    },
  };
}
