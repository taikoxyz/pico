import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeInvoiceEnvelope } from '../runtime/invoice-envelope.js';
import { invoiceCommand } from './invoice.js';

class StubStream {
  buf = '';
  write(s: string): void {
    this.buf += s;
  }
}

const PK = '0x0000000000000000000000000000000000000000000000000000000000000b0b' as const;

describe('pico invoice', () => {
  it('create prints a base64 envelope that decodes back to an Invoice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-inv-'));
    const stdout = new StubStream();
    const cmd = invoiceCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      storageOverride: join(dir, 'db'),
    });
    await cmd.parseAsync(['node', 'pico', 'create', '--amount', '50000', '--memo', 'svc']);
    const env = stdout.buf.trim();
    expect(env.startsWith('pico1:')).toBe(true);
    const decoded = decodeInvoiceEnvelope(env);
    expect(decoded.amount).toBe(50_000n);
    expect(decoded.memo).toBe('svc');
  });

  it('create --json includes invoice + preimage + envelope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-inv-'));
    const stdout = new StubStream();
    const cmd = invoiceCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      storageOverride: join(dir, 'db'),
    });
    await cmd.parseAsync([
      'node',
      'pico',
      'create',
      '--amount',
      '1000',
      '--json',
      '--reveal-preimage',
    ]);
    const obj = JSON.parse(stdout.buf.trim()) as {
      envelope: string;
      preimage: string;
      paymentHash: string;
    };
    expect(obj.envelope.startsWith('pico1:')).toBe(true);
    expect(obj.preimage).toMatch(/^0x[0-9a-f]{64}$/);
    expect(obj.paymentHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('list prints (no invoices) when empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-inv-'));
    const stdout = new StubStream();
    const cmd = invoiceCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      storageOverride: join(dir, 'db'),
    });
    await cmd.parseAsync(['node', 'pico', 'list']);
    expect(stdout.buf).toContain('(no invoices)');
  });

  it('list shows a created invoice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-inv-'));
    const root = join(dir, 'db');
    const make = invoiceCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout: new StubStream(),
      storageOverride: root,
    });
    await make.parseAsync(['node', 'pico', 'create', '--amount', '777']);
    const stdout = new StubStream();
    const list = invoiceCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout,
      storageOverride: root,
    });
    await list.parseAsync(['node', 'pico', 'list']);
    expect(stdout.buf).toContain('issued');
    expect(stdout.buf).toContain('amount=777');
  });

  it('show requires the paymentHash to exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-inv-'));
    const cmd = invoiceCommand({
      env: { PICO_CONFIG_DIR: dir, PICO_PRIVATE_KEY: PK },
      stdout: new StubStream(),
      storageOverride: join(dir, 'db'),
    });
    await expect(cmd.parseAsync(['node', 'pico', 'show', `0x${'aa'.repeat(32)}`])).rejects.toThrow(
      /not found/,
    );
  });
});
