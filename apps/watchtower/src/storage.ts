import type { ChannelId, SignedState } from '@tainnel/protocol';

export interface EncryptedBackup {
  readonly channelId: ChannelId;
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly version: bigint;
}

export interface BackupStore {
  put(blob: EncryptedBackup): Promise<void>;
  latest(channelId: ChannelId): Promise<EncryptedBackup | undefined>;
}

export interface PlainStateStore {
  put(state: SignedState): Promise<void>;
  latest(channelId: ChannelId): Promise<SignedState | undefined>;
}

export class MemoryBackupStore implements BackupStore {
  private readonly map = new Map<ChannelId, EncryptedBackup>();
  async put(blob: EncryptedBackup): Promise<void> {
    const existing = this.map.get(blob.channelId);
    if (!existing || blob.version > existing.version) {
      this.map.set(blob.channelId, blob);
    }
  }
  async latest(channelId: ChannelId): Promise<EncryptedBackup | undefined> {
    return this.map.get(channelId);
  }
}
