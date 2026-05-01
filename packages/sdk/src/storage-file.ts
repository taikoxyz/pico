import { closeSync, fsyncSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  Channel,
  ChannelId,
  Invoice,
  PaymentHash,
  Preimage,
  SignedState,
} from '@tainnel/protocol';
import { randomNonce16 } from './crypto.js';
import {
  type InvoiceRecord,
  type SerializedChannel,
  type SerializedInvoiceRecord,
  type SerializedSignedState,
  deserializeChannel,
  deserializeInvoiceRecord,
  deserializeSignedState,
  serializeChannel,
  serializeInvoiceRecord,
  serializeSignedState,
} from './storage-shared.js';
import type { ChannelStorage } from './storage.js';

export interface FileStorageOptions {
  readonly root: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOrUndefined<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomNonce16()}.tmp`;
  // F-05: write with restrictive 0o600 mode so leaked preimages or signed
  // states are not world-readable on multi-user hosts.
  await writeFile(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  // F-05: fsync the file before rename so the new contents are durable
  // across power loss before the directory entry is updated.
  try {
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // fsync is best-effort; on filesystems that don't support it (or in
    // sandboxed CI environments), continue.
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  // F-05: fsync the parent directory entry so the rename is durable across
  // power loss. Best-effort; some platforms (Windows) require different flags.
  try {
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // ignore
  }
}

export class FileStorage implements ChannelStorage {
  private readonly root: string;
  private readonly channelsDir: string;
  private readonly statesDir: string;
  private readonly invoicesDir: string;
  private dirsReady = false;

  constructor(opts: FileStorageOptions) {
    this.root = opts.root;
    this.channelsDir = join(opts.root, 'channels');
    this.statesDir = join(opts.root, 'states');
    this.invoicesDir = join(opts.root, 'invoices');
  }

  private async ensureDirs(): Promise<void> {
    if (this.dirsReady) return;
    // F-05: create directories with restrictive 0o700 mode so other local
    // users cannot read channel state, signed states, or invoice preimages.
    await mkdir(this.channelsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.statesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.invoicesDir, { recursive: true, mode: 0o700 });
    this.dirsReady = true;
  }

  private channelPath(id: ChannelId): string {
    return join(this.channelsDir, `${id}.json`);
  }
  private statePath(id: ChannelId): string {
    return join(this.statesDir, `${id}.json`);
  }
  private invoicePath(paymentHash: PaymentHash): string {
    return join(this.invoicesDir, `${paymentHash}.json`);
  }

  async saveChannel(channel: Channel): Promise<void> {
    await this.ensureDirs();
    await writeJsonAtomic(this.channelPath(channel.id), serializeChannel(channel));
  }

  async loadChannel(id: ChannelId): Promise<Channel | undefined> {
    const data = await readJsonOrUndefined<SerializedChannel>(this.channelPath(id));
    return data ? deserializeChannel(data) : undefined;
  }

  async saveState(channelId: ChannelId, state: SignedState): Promise<void> {
    await this.ensureDirs();
    await writeJsonAtomic(this.statePath(channelId), serializeSignedState(state));
  }

  async loadLatestState(channelId: ChannelId): Promise<SignedState | undefined> {
    const data = await readJsonOrUndefined<SerializedSignedState>(this.statePath(channelId));
    return data ? deserializeSignedState(data) : undefined;
  }

  async list(): Promise<readonly Channel[]> {
    if (!(await exists(this.channelsDir))) return [];
    const files = await readdir(this.channelsDir);
    const out: Channel[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const data = await readJsonOrUndefined<SerializedChannel>(join(this.channelsDir, file));
      if (data) out.push(deserializeChannel(data));
    }
    return out;
  }

  async saveInvoice(invoice: Invoice, preimage: Preimage): Promise<void> {
    await this.ensureDirs();
    const existing = await this.loadInvoice(invoice.paymentHash);
    const record: InvoiceRecord = {
      invoice,
      preimage,
      ...(existing?.consumedAt !== undefined ? { consumedAt: existing.consumedAt } : {}),
    };
    await writeJsonAtomic(this.invoicePath(invoice.paymentHash), serializeInvoiceRecord(record));
  }

  async loadInvoice(paymentHash: PaymentHash): Promise<InvoiceRecord | undefined> {
    const data = await readJsonOrUndefined<SerializedInvoiceRecord>(this.invoicePath(paymentHash));
    return data ? deserializeInvoiceRecord(data) : undefined;
  }

  async markInvoiceConsumed(paymentHash: PaymentHash, consumedAtMs: number): Promise<void> {
    const existing = await this.loadInvoice(paymentHash);
    if (!existing) return;
    if (existing.consumedAt !== undefined) return;
    await writeJsonAtomic(
      this.invoicePath(paymentHash),
      serializeInvoiceRecord({ ...existing, consumedAt: consumedAtMs }),
    );
  }

  async delete(id: ChannelId): Promise<void> {
    await rm(this.channelPath(id), { force: true });
    await rm(this.statePath(id), { force: true });
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
    this.dirsReady = false;
  }
}
