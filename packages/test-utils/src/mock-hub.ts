import type {
  Address,
  ChainId,
  Channel,
  ChannelId,
  ChannelState,
  Hex,
  Htlc,
  HtlcId,
  SignedCooperativeClose,
  SignedState,
  TopUpFeePolicy,
} from '@inferenceroom/pico-protocol';
import {
  type ClientToHubMessage,
  type HubMessage,
  type HubToClientMessage,
  type PayMessage,
  decodeHubMessage,
  encodeHubMessage,
  hexToSignature,
} from '@inferenceroom/pico-sdk';
import {
  buildChannelStateTypedData,
  buildCooperativeCloseTypedData,
} from '@inferenceroom/pico-state-machine';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import { type AddressInfo, type WebSocket, WebSocketServer } from 'ws';

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

export interface PushProposeTopUpArgs {
  readonly toAddress: Address;
  readonly channelId: ChannelId;
  readonly offerId: Hex;
  readonly amount: bigint;
  readonly prevStateVersion: bigint;
  readonly newState: ChannelState;
  readonly validUntil: bigint;
  readonly feePolicy?: TopUpFeePolicy | null;
  readonly minLifetime?: bigint | null;
  readonly maxInFlightHtlcs?: number;
  readonly partialAccepted?: boolean;
}

export interface PushProposeTopUpResult {
  readonly accepted: boolean;
  readonly signedNewState?: SignedState;
  readonly reason?: string;
}

export interface MockHubHandle {
  readonly url: string;
  readonly hubAddress: Address;
  pendingHtlcs(): readonly PendingHtlc[];
  registerChannel(channel: Channel, initialState?: SignedState): void;
  /**
   * Push a `proposeTopUp` envelope to the connected user (protocol-spec §8.6)
   * and await `acceptTopUp` / `rejectTopUp`.
   *
   * v1.1 status: stubbed. The SDK does not yet model `proposeTopUp` /
   * `acceptTopUp` / `rejectTopUp` in `ClientToHubMessage` /
   * `HubToClientMessage` (Wave B2 / Wave D scope), so wiring the WS
   * dispatcher is deferred to Wave D4. Calling this method currently throws.
   */
  pushProposeTopUp(args: PushProposeTopUpArgs): Promise<PushProposeTopUpResult>;
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
  const latestStates = new Map<ChannelId, SignedState>();

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
      latestStates.set(msg.channelId, msg.signedState);
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
      latestStates.set(msg.channelId, msg.signedState);
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
      if (msg.signedState) latestStates.set(msg.channelId, msg.signedState);
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
      latestStates.set(msg.channelId, acked);
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
      const latest = latestStates.get(msg.channelId);
      if (!latest) {
        send(socket, {
          id: msg.id,
          kind: 'error',
          code: 'NO_STATE',
          message: `no signed state for channel ${msg.channelId}`,
          requestId: msg.id,
        });
        return;
      }
      if (latest.state.htlcs.length > 0 || msg.signedState.state.htlcs.length > 0) {
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
        msg.signedState.state.version !== latest.state.version + 1n ||
        msg.signedState.state.balanceA !== latest.state.balanceA ||
        msg.signedState.state.balanceB !== latest.state.balanceB ||
        msg.signedCooperativeClose.close.channelId !== msg.channelId ||
        msg.signedCooperativeClose.close.finalBalanceA !== msg.signedState.state.balanceA ||
        msg.signedCooperativeClose.close.finalBalanceB !== msg.signedState.state.balanceB ||
        msg.signedCooperativeClose.close.version !== msg.signedState.state.version ||
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
      // protocol-spec §1, §6.2: the contract enforces `block.timestamp <= validUntil`,
      // so a hub MUST refuse to counter-sign an already-stale close.
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      if (msg.signedCooperativeClose.close.validUntil < nowSec) {
        send(socket, {
          id: msg.id,
          kind: 'error',
          code: 'CLOSE_EXPIRED',
          message: 'cooperative close validUntil is in the past',
          requestId: msg.id,
        });
        return;
      }
      // v1.1 invariant: the user is responsible for setting `version` and
      // `validUntil` on the CooperativeClose. The hub merely counter-signs the
      // exact same close payload — the typed-data signature binds those fields,
      // so propagating `msg.signedCooperativeClose.close` unchanged into
      // `countersignedClose` is sufficient.
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
    registerChannel(ch: Channel, initialState?: SignedState): void {
      channels.set(ch.id, ch);
      if (initialState) latestStates.set(ch.id, initialState);
    },
    async pushProposeTopUp(_args: PushProposeTopUpArgs): Promise<PushProposeTopUpResult> {
      // Stubbed: SDK message kinds for proposeTopUp / acceptTopUp / rejectTopUp
      // are not yet plumbed through `ClientToHubMessage` / `HubToClientMessage`
      // (see protocol-spec §8.6). Wave D4 will wire this once the SDK lands
      // those message kinds and we can route incoming acceptTopUp/rejectTopUp
      // back to the awaiting Promise without unsafe casts.
      throw new Error('pushProposeTopUp: not implemented in MockHub (Wave D4 will wire this)');
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
