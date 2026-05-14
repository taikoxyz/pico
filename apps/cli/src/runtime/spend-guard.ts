import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir } from './config.js';

export interface SpendCaps {
  readonly perTxRaw?: bigint;
  readonly dailyRaw?: bigint;
}

export function spendCapsFromEnv(env: NodeJS.ProcessEnv = process.env): SpendCaps {
  const out: { perTxRaw?: bigint; dailyRaw?: bigint } = {};
  if (env.PICO_PAYMENT_MAX_RAW) {
    out.perTxRaw = BigInt(env.PICO_PAYMENT_MAX_RAW);
  }
  if (env.PICO_PAYMENT_DAILY_RAW) {
    out.dailyRaw = BigInt(env.PICO_PAYMENT_DAILY_RAW);
  }
  return out;
}

export function defaultSpendLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PICO_SPEND_LEDGER ?? join(configDir(env), 'spend-ledger.json');
}

type LedgerByDay = Record<string, string>;

function isoDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function readLedger(path: string): LedgerByDay {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LedgerByDay;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(path: string, ledger: LedgerByDay): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
  try {
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* best effort */
  }
  renameSync(tmp, path);
}

function pruneOlderThanDays(
  ledger: LedgerByDay,
  days: number,
  now: Date = new Date(),
): LedgerByDay {
  const cutoff = new Date(now.getTime() - days * 86400_000);
  const cutoffKey = isoDay(cutoff);
  const out: LedgerByDay = {};
  for (const [day, value] of Object.entries(ledger)) {
    if (day >= cutoffKey) out[day] = value;
  }
  return out;
}

export function assertWithinCaps(
  caps: SpendCaps,
  amountRaw: bigint,
  ledgerPath: string = defaultSpendLedgerPath(),
  now: Date = new Date(),
): void {
  if (caps.perTxRaw !== undefined && amountRaw > caps.perTxRaw) {
    throw new Error(
      `payment amount ${amountRaw} exceeds PICO_PAYMENT_MAX_RAW=${caps.perTxRaw}; raise the cap or split the payment`,
    );
  }
  if (caps.dailyRaw !== undefined) {
    const ledger = readLedger(ledgerPath);
    const today = isoDay(now);
    const todaySoFar = BigInt(ledger[today] ?? '0');
    if (todaySoFar + amountRaw > caps.dailyRaw) {
      throw new Error(
        `payment of ${amountRaw} (raw) would exceed PICO_PAYMENT_DAILY_RAW=${caps.dailyRaw} (already spent ${todaySoFar} today); cap is summed across tokens in raw base units`,
      );
    }
  }
}

export function recordSpend(
  amountRaw: bigint,
  ledgerPath: string = defaultSpendLedgerPath(),
  now: Date = new Date(),
): void {
  const ledger = pruneOlderThanDays(readLedger(ledgerPath), 7, now);
  const today = isoDay(now);
  const todaySoFar = BigInt(ledger[today] ?? '0');
  ledger[today] = (todaySoFar + amountRaw).toString();
  writeLedger(ledgerPath, ledger);
}
