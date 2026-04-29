import { CliError } from './errors.js';

const USDC_DECIMALS = 6;

/** Parse a USDC amount string ("5", "0.5", "5.123456") into a 6-decimal bigint. */
export function parseUsdc(input: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new CliError(`invalid USDC amount: ${input}`, { code: 'BAD_AMOUNT' });
  }
  const [whole, frac = ''] = input.split('.');
  if (frac.length > USDC_DECIMALS) {
    throw new CliError(`USDC amount has more than ${USDC_DECIMALS} decimal places: ${input}`, {
      code: 'BAD_AMOUNT',
    });
  }
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole ?? '0') * 10n ** BigInt(USDC_DECIMALS) + BigInt(padded || '0');
}

export function formatUsdc(amount: bigint): string {
  const negative = amount < 0n;
  const v = negative ? -amount : amount;
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  const out = fracStr ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${out}` : out;
}
