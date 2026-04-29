import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { htlcMerkleRoot } from '@tainnel/protocol';
import {
  http,
  type Chain,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { DisputeRepo, StateRepo } from './db/repos.js';
import type { Logger } from './logger.js';
import { disputesTotal } from './metrics.js';

export const DISPUTE_ABI = parseAbi([
  'function dispute(bytes32 channelId, bytes state, bytes sigCloser) external',
]);

const CHANNEL_STATE_ABI_PARAMS = [
  {
    type: 'tuple',
    components: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'version', type: 'uint64' },
      { name: 'balanceA', type: 'uint256' },
      { name: 'balanceB', type: 'uint256' },
      { name: 'htlcsRoot', type: 'bytes32' },
      { name: 'finalized', type: 'bool' },
    ],
  },
] as const;

export interface DisputeHandlerDeps {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly contractAddress: Address;
  readonly hubPrivateKey: Hex;
  readonly stateRepo: StateRepo;
  readonly disputeRepo: DisputeRepo;
  readonly logger: Logger;
  readonly publicClient?: PublicClient;
  readonly walletClient?: WalletClient;
}

export interface DisputeNotification {
  readonly channelId: ChannelId;
  readonly attackerVersion: bigint;
  readonly observedAtMs: number;
  readonly closerSide?: 'A' | 'B';
}

export class DisputeHandler {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(private readonly deps: DisputeHandlerDeps) {
    this.account = privateKeyToAccount(deps.hubPrivateKey);
    this.publicClient =
      deps.publicClient ??
      (createPublicClient({
        chain: deps.chain,
        transport: http(deps.rpcUrl),
      }) as unknown as PublicClient);
    this.walletClient =
      deps.walletClient ??
      (createWalletClient({
        account: this.account,
        chain: deps.chain,
        transport: http(deps.rpcUrl),
      }) as unknown as WalletClient);
  }

  async handle(notification: DisputeNotification): Promise<Hex | undefined> {
    disputesTotal.inc();
    const latest = this.deps.stateRepo.latest(notification.channelId);
    if (!latest || latest.state.version <= notification.attackerVersion) {
      this.deps.logger.error(
        {
          channelId: notification.channelId,
          attackerVersion: notification.attackerVersion.toString(),
          ourVersion: latest?.state.version.toString() ?? 'none',
        },
        'cannot dispute: our state is not newer (compromised key or stale local DB?)',
      );
      this.deps.disputeRepo.record({
        channelId: notification.channelId,
        attackerVersion: notification.attackerVersion,
        ourVersion: latest?.state.version ?? 0n,
        observedAt: notification.observedAtMs,
      });
      return undefined;
    }

    this.deps.disputeRepo.record({
      channelId: notification.channelId,
      attackerVersion: notification.attackerVersion,
      ourVersion: latest.state.version,
      observedAt: notification.observedAtMs,
    });

    const encodedState = encodeStateForContract(latest);
    const sigHex = serializeSignatureToHex(
      notification.closerSide === 'B' ? latest.sigB : latest.sigA,
    );
    const data = encodeFunctionData({
      abi: DISPUTE_ABI,
      functionName: 'dispute',
      args: [notification.channelId, encodedState, sigHex],
    });
    const txHash = (await this.walletClient.sendTransaction({
      account: this.account,
      chain: this.deps.chain,
      to: this.deps.contractAddress,
      data,
    })) as Hex;
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 60_000,
    });
    if (receipt.status !== 'success') {
      this.deps.logger.error(
        { channelId: notification.channelId, txHash },
        'dispute tx reverted on-chain',
      );
      return undefined;
    }
    this.deps.disputeRepo.markResponded(notification.channelId, txHash, Date.now());
    this.deps.logger.info({ channelId: notification.channelId, txHash }, 'dispute submitted');
    return txHash;
  }
}

function encodeStateForContract(s: SignedState): Hex {
  return encodeAbiParameters(CHANNEL_STATE_ABI_PARAMS, [
    {
      channelId: s.state.channelId,
      version: s.state.version,
      balanceA: s.state.balanceA,
      balanceB: s.state.balanceB,
      htlcsRoot: htlcMerkleRoot(s.state.htlcs),
      finalized: s.state.finalized,
    },
  ]);
}

function serializeSignatureToHex(sig: { r: Hex; s: Hex; v: number }): Hex {
  const r = strip0x(sig.r).padStart(64, '0');
  const s = strip0x(sig.s).padStart(64, '0');
  const v = sig.v.toString(16).padStart(2, '0');
  return `0x${r}${s}${v}` as Hex;
}

function strip0x(h: string): string {
  return h.startsWith('0x') ? h.slice(2) : h;
}
