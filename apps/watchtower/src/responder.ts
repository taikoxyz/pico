import type { Address, ChannelId, Hex, SignedState } from '@tainnel/protocol';
import { encodeChannelStateForOnChain, signatureToHex } from '@tainnel/sdk';
import {
  http,
  type Chain,
  type Hash,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, taiko } from 'viem/chains';
import type { Logger } from './logger.js';

const penaltyAbi = parseAbi([
  'function submitPenaltyProof(bytes32 channelId, bytes penaltyState, bytes signature)',
]);

function chainForId(chainId: number): Chain {
  if (chainId === 167000) return taiko;
  return foundry;
}

export interface PenaltyResponderDeps {
  readonly rpcUrl: string;
  readonly privateKey: Hex;
  readonly paymentChannelAddress: Address;
  readonly chainId: number;
  readonly logger: Logger;
  readonly publicClient?: PublicClient;
  readonly walletClient?: WalletClient;
}

export class PenaltyResponder {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;

  constructor(private readonly deps: PenaltyResponderDeps) {
    const chain = chainForId(deps.chainId);
    const transport = http(deps.rpcUrl);
    this.publicClient =
      deps.publicClient ?? (createPublicClient({ chain, transport }) as PublicClient);
    this.walletClient =
      deps.walletClient ??
      createWalletClient({
        account: privateKeyToAccount(deps.privateKey),
        chain,
        transport,
      });
  }

  async submitPenalty(
    channelId: ChannelId,
    evidence: SignedState,
    closerSide: 'A' | 'B',
  ): Promise<Hash> {
    const account = this.walletClient.account;
    if (!account) throw new Error('responder: walletClient has no account');
    const chain = this.walletClient.chain ?? chainForId(this.deps.chainId);

    const stateBytes = encodeChannelStateForOnChain(evidence.state);
    const sigCloser = signatureToHex(closerSide === 'A' ? evidence.sigA : evidence.sigB);

    try {
      const txHash = await this.walletClient.writeContract({
        address: this.deps.paymentChannelAddress,
        abi: penaltyAbi,
        functionName: 'submitPenaltyProof',
        args: [channelId, stateBytes, sigCloser],
        account,
        chain,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      this.deps.logger.info(
        { channelId, version: evidence.state.version, txHash },
        'penalty proof submitted (100% slash)',
      );
      return txHash;
    } catch (err) {
      const msg = (err as Error).message;
      if (/stale/i.test(msg)) {
        this.deps.logger.error(
          { channelId, version: evidence.state.version },
          'dispute reverted as stale; our state is not newer than posted version',
        );
      }
      throw err;
    }
  }
}
