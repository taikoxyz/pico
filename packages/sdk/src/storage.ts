import type { Channel, ChannelId, SignedState } from '@tainnel/protocol';
import { StorageError } from './errors.js';

export interface ChannelStorage {
  saveChannel(channel: Channel): Promise<void>;
  loadChannel(id: ChannelId): Promise<Channel | undefined>;
  saveState(channelId: ChannelId, state: SignedState): Promise<void>;
  loadLatestState(channelId: ChannelId): Promise<SignedState | undefined>;
  list(): Promise<readonly Channel[]>;
  delete(id: ChannelId): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStorage implements ChannelStorage {
  private readonly channels = new Map<ChannelId, Channel>();
  private readonly states = new Map<ChannelId, SignedState>();

  async saveChannel(channel: Channel): Promise<void> {
    this.channels.set(channel.id, channel);
  }
  async loadChannel(id: ChannelId): Promise<Channel | undefined> {
    return this.channels.get(id);
  }
  async saveState(channelId: ChannelId, state: SignedState): Promise<void> {
    if (!this.channels.has(channelId)) {
      throw new StorageError(
        `cannot save state for unknown channel ${channelId}`,
        'UNKNOWN_CHANNEL',
      );
    }
    if (state.state.channelId !== channelId) {
      throw new StorageError('state.channelId does not match key', 'CHANNEL_ID_MISMATCH');
    }
    const existing = this.states.get(channelId);
    if (existing && state.state.version <= existing.state.version) {
      throw new StorageError(
        `attempt to overwrite state v${existing.state.version} with older v${state.state.version}`,
        'STALE_STATE',
      );
    }
    this.states.set(channelId, state);
  }
  async loadLatestState(channelId: ChannelId): Promise<SignedState | undefined> {
    return this.states.get(channelId);
  }
  async list(): Promise<readonly Channel[]> {
    return Array.from(this.channels.values());
  }
  async delete(id: ChannelId): Promise<void> {
    this.channels.delete(id);
    this.states.delete(id);
  }
  async clear(): Promise<void> {
    this.channels.clear();
    this.states.clear();
  }
}

interface SerializedHtlc {
  readonly id: string;
  readonly direction: 'AtoB' | 'BtoA';
  readonly amount: string;
  readonly paymentHash: string;
  readonly expiryMs: string;
}

interface SerializedChannelState {
  readonly channelId: string;
  readonly version: string;
  readonly balanceA: string;
  readonly balanceB: string;
  readonly htlcs: SerializedHtlc[];
  readonly finalized: boolean;
}

interface SerializedSignedState {
  readonly state: SerializedChannelState;
  readonly sigA: { r: string; s: string; v: number };
  readonly sigB: { r: string; s: string; v: number };
}

interface SerializedChannel {
  readonly id: string;
  readonly chainId: number;
  readonly contract: string;
  readonly userA: string;
  readonly userB: string;
  readonly token: string;
  readonly status: string;
  readonly openedAt: string;
  readonly disputeWindowMs: number;
}

interface ChannelFile {
  readonly version: 1;
  readonly channel: SerializedChannel;
  readonly state?: SerializedSignedState;
}

function serializeChannel(c: Channel): SerializedChannel {
  return {
    id: c.id,
    chainId: c.chainId,
    contract: c.contract,
    userA: c.userA,
    userB: c.userB,
    token: c.token,
    status: c.status,
    openedAt: c.openedAt.toString(),
    disputeWindowMs: c.disputeWindowMs,
  };
}

function deserializeChannel(s: SerializedChannel): Channel {
  return {
    id: s.id as Channel['id'],
    chainId: s.chainId as Channel['chainId'],
    contract: s.contract as Channel['contract'],
    userA: s.userA as Channel['userA'],
    userB: s.userB as Channel['userB'],
    token: s.token as Channel['token'],
    status: s.status as Channel['status'],
    openedAt: BigInt(s.openedAt),
    disputeWindowMs: s.disputeWindowMs,
  };
}

function serializeSignedState(ss: SignedState): SerializedSignedState {
  return {
    state: {
      channelId: ss.state.channelId,
      version: ss.state.version.toString(),
      balanceA: ss.state.balanceA.toString(),
      balanceB: ss.state.balanceB.toString(),
      htlcs: ss.state.htlcs.map((h) => ({
        id: h.id,
        direction: h.direction,
        amount: h.amount.toString(),
        paymentHash: h.paymentHash,
        expiryMs: h.expiryMs.toString(),
      })),
      finalized: ss.state.finalized,
    },
    sigA: { r: ss.sigA.r, s: ss.sigA.s, v: ss.sigA.v },
    sigB: { r: ss.sigB.r, s: ss.sigB.s, v: ss.sigB.v },
  };
}

function deserializeSignedState(s: SerializedSignedState): SignedState {
  return {
    state: {
      channelId: s.state.channelId as SignedState['state']['channelId'],
      version: BigInt(s.state.version),
      balanceA: BigInt(s.state.balanceA),
      balanceB: BigInt(s.state.balanceB),
      htlcs: s.state.htlcs.map((h) => ({
        id: h.id as SignedState['state']['htlcs'][number]['id'],
        direction: h.direction,
        amount: BigInt(h.amount),
        paymentHash: h.paymentHash as SignedState['state']['htlcs'][number]['paymentHash'],
        expiryMs: BigInt(h.expiryMs),
      })),
      finalized: s.state.finalized,
    },
    sigA: { r: s.sigA.r as `0x${string}`, s: s.sigA.s as `0x${string}`, v: s.sigA.v },
    sigB: { r: s.sigB.r as `0x${string}`, s: s.sigB.s as `0x${string}`, v: s.sigB.v },
  };
}

export interface FileStorageDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<readonly string[]>;
  exists(path: string): Promise<boolean>;
}

export class FileStorage implements ChannelStorage {
  private readonly dir: string;
  private readonly fs: FileStorageDeps;
  private initialized = false;

  constructor(dir: string, fs: FileStorageDeps) {
    this.dir = dir;
    this.fs = fs;
  }

  static async createNode(dir: string): Promise<FileStorage> {
    const fsMod = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const deps: FileStorageDeps = {
      readFile: (p) => fsMod.readFile(p, 'utf8'),
      writeFile: (p, d) => fsMod.writeFile(p, d, 'utf8'),
      rename: (a, b) => fsMod.rename(a, b),
      unlink: (p) => fsMod.unlink(p),
      mkdir: async (p) => {
        await fsMod.mkdir(p, { recursive: true });
      },
      readdir: (p) => fsMod.readdir(p),
      exists: async (p) =>
        fsMod
          .stat(p)
          .then(() => true)
          .catch(() => false),
    };
    const store = new FileStorage(pathMod.resolve(dir), deps);
    await store.init();
    return store;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.fs.mkdir(this.channelsDir());
    this.initialized = true;
  }

  private channelsDir(): string {
    return `${this.dir}/channels`;
  }

  private filePath(id: ChannelId): string {
    return `${this.channelsDir()}/${id}.json`;
  }

  private tmpPath(id: ChannelId): string {
    return `${this.filePath(id)}.tmp`;
  }

  private async readFileFor(id: ChannelId): Promise<ChannelFile | undefined> {
    const path = this.filePath(id);
    if (!(await this.fs.exists(path))) return undefined;
    try {
      const raw = await this.fs.readFile(path);
      return JSON.parse(raw) as ChannelFile;
    } catch (err) {
      throw new StorageError(`failed to read ${path}: ${(err as Error).message}`, 'READ_FAILED');
    }
  }

  private async atomicWrite(id: ChannelId, file: ChannelFile): Promise<void> {
    await this.init();
    const tmp = this.tmpPath(id);
    const target = this.filePath(id);
    await this.fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
    await this.fs.rename(tmp, target);
  }

  async saveChannel(channel: Channel): Promise<void> {
    const existing = await this.readFileFor(channel.id);
    const file: ChannelFile = {
      version: 1,
      channel: serializeChannel(channel),
      ...(existing?.state ? { state: existing.state } : {}),
    };
    await this.atomicWrite(channel.id, file);
  }

  async loadChannel(id: ChannelId): Promise<Channel | undefined> {
    const file = await this.readFileFor(id);
    return file ? deserializeChannel(file.channel) : undefined;
  }

  async saveState(channelId: ChannelId, state: SignedState): Promise<void> {
    if (state.state.channelId !== channelId) {
      throw new StorageError('state.channelId does not match key', 'CHANNEL_ID_MISMATCH');
    }
    const existing = await this.readFileFor(channelId);
    if (!existing) {
      throw new StorageError(
        `cannot save state for unknown channel ${channelId}`,
        'UNKNOWN_CHANNEL',
      );
    }
    if (existing.state) {
      const prevVersion = BigInt(existing.state.state.version);
      if (state.state.version <= prevVersion) {
        throw new StorageError(
          `attempt to overwrite state v${prevVersion} with older v${state.state.version}`,
          'STALE_STATE',
        );
      }
    }
    const file: ChannelFile = {
      version: 1,
      channel: existing.channel,
      state: serializeSignedState(state),
    };
    await this.atomicWrite(channelId, file);
  }

  async loadLatestState(channelId: ChannelId): Promise<SignedState | undefined> {
    const file = await this.readFileFor(channelId);
    return file?.state ? deserializeSignedState(file.state) : undefined;
  }

  async list(): Promise<readonly Channel[]> {
    await this.init();
    const entries = await this.fs.readdir(this.channelsDir());
    const out: Channel[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry.endsWith('.tmp.json')) continue;
      const id = entry.slice(0, -'.json'.length) as ChannelId;
      const file = await this.readFileFor(id);
      if (file) out.push(deserializeChannel(file.channel));
    }
    return out;
  }

  async delete(id: ChannelId): Promise<void> {
    const path = this.filePath(id);
    if (await this.fs.exists(path)) await this.fs.unlink(path);
  }

  async clear(): Promise<void> {
    const channels = await this.list();
    for (const c of channels) await this.delete(c.id);
  }
}
