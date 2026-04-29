import type { Address, Channel, ChannelId, Hex } from '@tainnel/protocol';
import type { BalanceSummary, PaymentResult } from '@tainnel/sdk';
import pc from 'picocolors';
import { formatUsdc } from './units.js';

export interface HubStatusInfo {
  readonly status: string;
  readonly dbReady: boolean;
  readonly chainReady: boolean;
  readonly address: Address;
  readonly chainId: number;
  readonly version: string;
  readonly url: string;
}

export interface ChannelRow {
  readonly channel: Channel;
  readonly balance: BalanceSummary | undefined;
}

export interface ChannelOpenedInfo {
  readonly channelId: ChannelId;
  readonly txHash: Hex;
  readonly status: string;
  readonly counterparty: Address;
  readonly amount: bigint;
}

export interface ChannelClosedInfo {
  readonly channelId: ChannelId;
  readonly cooperative: boolean;
  readonly status: string;
  readonly paidUs?: bigint;
  readonly paidCounterparty?: bigint;
  readonly txHash?: Hex;
}

export interface Renderer {
  channelOpened(info: ChannelOpenedInfo): void;
  channelList(rows: readonly ChannelRow[]): void;
  channelClosed(info: ChannelClosedInfo): void;
  paymentSent(result: PaymentResult & { to: Address }): void;
  hubStatus(info: HubStatusInfo): void;
  error(err: Error): void;
}

class PrettyRenderer implements Renderer {
  channelOpened(info: ChannelOpenedInfo): void {
    process.stdout.write(`${pc.green('✓ channel opened')}\n`);
    process.stdout.write(`  id:           ${pc.cyan(info.channelId)}\n`);
    process.stdout.write(`  counterparty: ${info.counterparty}\n`);
    process.stdout.write(`  amount:       ${formatUsdc(info.amount)} USDC\n`);
    process.stdout.write(`  status:       ${info.status}\n`);
    process.stdout.write(`  tx:           ${pc.dim(info.txHash)}\n`);
  }

  channelList(rows: readonly ChannelRow[]): void {
    if (rows.length === 0) {
      process.stdout.write(pc.dim('no local channels\n'));
      return;
    }
    process.stdout.write(
      `${pc.bold('id'.padEnd(70))} ${pc.bold('status'.padEnd(20))} ${pc.bold('us'.padStart(14))} ${pc.bold('counterparty'.padStart(14))} ${pc.bold('htlcs'.padStart(8))}\n`,
    );
    for (const r of rows) {
      const us = r.balance ? formatUsdc(r.balance.balanceUs) : '?';
      const cp = r.balance ? formatUsdc(r.balance.balanceCounterparty) : '?';
      const htlcs = r.balance ? formatUsdc(r.balance.pendingHtlcsTotal) : '?';
      process.stdout.write(
        `${pc.cyan(r.channel.id.padEnd(70))} ${r.channel.status.padEnd(20)} ${us.padStart(14)} ${cp.padStart(14)} ${htlcs.padStart(8)}\n`,
      );
    }
  }

  channelClosed(info: ChannelClosedInfo): void {
    process.stdout.write(`${pc.green('✓ channel closed')}\n`);
    process.stdout.write(`  id:           ${pc.cyan(info.channelId)}\n`);
    process.stdout.write(`  mode:         ${info.cooperative ? 'cooperative' : 'unilateral'}\n`);
    process.stdout.write(`  status:       ${info.status}\n`);
    if (info.paidUs !== undefined && info.paidCounterparty !== undefined) {
      process.stdout.write(`  paid us:      ${formatUsdc(info.paidUs)} USDC\n`);
      process.stdout.write(`  paid them:    ${formatUsdc(info.paidCounterparty)} USDC\n`);
    }
    if (info.txHash) {
      process.stdout.write(`  tx:           ${pc.dim(info.txHash)}\n`);
    }
  }

  paymentSent(result: PaymentResult & { to: Address }): void {
    process.stdout.write(`${pc.green('✓ payment settled')}\n`);
    process.stdout.write(`  to:        ${result.to}\n`);
    process.stdout.write(`  channel:   ${pc.cyan(result.channelId)}\n`);
    process.stdout.write(`  htlc:      ${pc.dim(result.htlcId)}\n`);
    process.stdout.write(`  preimage:  ${pc.dim(result.preimage)}\n`);
  }

  hubStatus(info: HubStatusInfo): void {
    const ok = info.status === 'ok';
    const head = ok ? pc.green('● healthy') : pc.yellow(`● ${info.status}`);
    process.stdout.write(`${head}  ${pc.bold(info.url)}\n`);
    process.stdout.write(`  address:   ${info.address}\n`);
    process.stdout.write(`  chainId:   ${info.chainId}\n`);
    process.stdout.write(`  version:   ${info.version}\n`);
    process.stdout.write(`  db ready:  ${info.dbReady}\n`);
    process.stdout.write(`  chain rdy: ${info.chainReady}\n`);
  }

  error(err: Error): void {
    process.stderr.write(`${pc.red('✗')} ${err.message}\n`);
  }
}

class JsonRenderer implements Renderer {
  channelOpened(info: ChannelOpenedInfo): void {
    emit({ kind: 'channel.opened', ...info });
  }
  channelList(rows: readonly ChannelRow[]): void {
    emit({
      kind: 'channel.list',
      channels: rows.map((r) => ({
        id: r.channel.id,
        chainId: r.channel.chainId,
        status: r.channel.status,
        userA: r.channel.userA,
        userB: r.channel.userB,
        token: r.channel.token,
        contract: r.channel.contract,
        balanceUs: r.balance?.balanceUs,
        balanceCounterparty: r.balance?.balanceCounterparty,
        pendingHtlcsTotal: r.balance?.pendingHtlcsTotal,
      })),
    });
  }
  channelClosed(info: ChannelClosedInfo): void {
    emit({ kind: 'channel.closed', ...info });
  }
  paymentSent(result: PaymentResult & { to: Address }): void {
    emit({ kind: 'payment.sent', ...result });
  }
  hubStatus(info: HubStatusInfo): void {
    emit({ kind: 'hub.status', ...info });
  }
  error(err: Error): void {
    process.stderr.write(`${JSON.stringify({ kind: 'error', message: err.message })}\n`);
  }
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, replacer)}\n`);
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export const prettyRenderer: Renderer = new PrettyRenderer();
export const jsonRenderer: Renderer = new JsonRenderer();

export function pickRenderer(useJson: boolean): Renderer {
  return useJson ? jsonRenderer : prettyRenderer;
}
