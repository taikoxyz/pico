import type {
  Channel,
  ChannelId,
  Invoice,
  PaymentHash,
  Preimage,
  SignedState,
} from '@inferenceroom/pico-protocol';
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

export interface IndexedDBStorageOptions {
  readonly dbName?: string;
  readonly factory?: IDBFactory;
}

const STORE_CHANNELS = 'channels';
const STORE_STATES = 'states';
const STORE_INVOICES = 'invoices';
const SCHEMA_VERSION = 1;
const DEFAULT_DB_NAME = 'pico-sdk';

interface StoredStateRecord extends SerializedSignedState {
  readonly _channelId: string;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.addEventListener('success', () => resolve(req.result));
    req.addEventListener('error', () => reject(req.error ?? new Error('IDBRequest failed')));
  });
}

function txToPromise(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('error', () => reject(tx.error ?? new Error('IDBTransaction failed')));
    tx.addEventListener('abort', () => reject(tx.error ?? new Error('IDBTransaction aborted')));
  });
}

export class IndexedDBStorage implements ChannelStorage {
  private readonly dbName: string;
  private readonly factory: IDBFactory;
  private dbPromise: Promise<IDBDatabase> | undefined;

  constructor(opts: IndexedDBStorageOptions = {}) {
    this.dbName = opts.dbName ?? DEFAULT_DB_NAME;
    const fac = opts.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!fac) {
      throw new Error('IndexedDBStorage: no IDBFactory available (pass opts.factory)');
    }
    this.factory = fac;
  }

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const open = this.factory.open(this.dbName, SCHEMA_VERSION);
      open.addEventListener('upgradeneeded', () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(STORE_CHANNELS)) {
          db.createObjectStore(STORE_CHANNELS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_STATES)) {
          db.createObjectStore(STORE_STATES, { keyPath: '_channelId' });
        }
        if (!db.objectStoreNames.contains(STORE_INVOICES)) {
          db.createObjectStore(STORE_INVOICES, { keyPath: 'invoice.paymentHash' });
        }
      });
      open.addEventListener('success', () => {
        // F-05: request that the browser treat this storage as persistent
        // (not subject to eviction under disk pressure). Best-effort; some
        // browsers prompt the user, others auto-grant when the origin has
        // engagement signals. We never fail open() on denial — the SDK
        // surfaces the result via persistenceGranted() so callers can warn.
        const nav = (
          globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }
        ).navigator;
        const storage = nav?.storage;
        const persistFn = storage?.persist;
        if (storage && typeof persistFn === 'function') {
          persistFn
            .call(storage)
            .then((granted) => {
              this.persistGranted = granted;
            })
            .catch(() => {
              this.persistGranted = false;
            });
        }
        resolve(open.result);
      });
      open.addEventListener('error', () => reject(open.error ?? new Error('open failed')));
      open.addEventListener('blocked', () => reject(new Error('open blocked')));
    });
    return this.dbPromise;
  }

  private persistGranted: boolean | undefined;

  /**
   * F-05: returns true if the browser has confirmed this storage is
   * persistent (not auto-evictable). Returns undefined while the request is
   * still pending or if the API is unavailable. Browser callers SHOULD warn
   * the user when this is false.
   */
  persistenceGranted(): boolean | undefined {
    return this.persistGranted;
  }

  private async withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.openDb();
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = await Promise.resolve(fn(store));
    await txToPromise(tx);
    return result;
  }

  async saveChannel(channel: Channel): Promise<void> {
    await this.withStore(STORE_CHANNELS, 'readwrite', (store) => {
      store.put(serializeChannel(channel));
    });
  }

  async loadChannel(id: ChannelId): Promise<Channel | undefined> {
    const data = await this.withStore(STORE_CHANNELS, 'readonly', (store) =>
      reqToPromise(store.get(id) as IDBRequest<SerializedChannel | undefined>),
    );
    return data ? deserializeChannel(data) : undefined;
  }

  async saveState(channelId: ChannelId, state: SignedState): Promise<void> {
    const record: StoredStateRecord = { _channelId: channelId, ...serializeSignedState(state) };
    await this.withStore(STORE_STATES, 'readwrite', (store) => {
      store.put(record);
    });
  }

  async loadLatestState(channelId: ChannelId): Promise<SignedState | undefined> {
    const data = await this.withStore(STORE_STATES, 'readonly', (store) =>
      reqToPromise(store.get(channelId) as IDBRequest<StoredStateRecord | undefined>),
    );
    return data ? deserializeSignedState(data) : undefined;
  }

  async list(): Promise<readonly Channel[]> {
    const items = await this.withStore(STORE_CHANNELS, 'readonly', (store) =>
      reqToPromise(store.getAll() as IDBRequest<SerializedChannel[]>),
    );
    return items.map(deserializeChannel);
  }

  async saveInvoice(invoice: Invoice, preimage: Preimage): Promise<void> {
    const existing = await this.loadInvoice(invoice.paymentHash);
    const record: InvoiceRecord = {
      invoice,
      preimage,
      ...(existing?.consumedAt !== undefined ? { consumedAt: existing.consumedAt } : {}),
    };
    await this.withStore(STORE_INVOICES, 'readwrite', (store) => {
      store.put(serializeInvoiceRecord(record));
    });
  }

  async loadInvoice(paymentHash: PaymentHash): Promise<InvoiceRecord | undefined> {
    const data = await this.withStore(STORE_INVOICES, 'readonly', (store) =>
      reqToPromise(store.get(paymentHash) as IDBRequest<SerializedInvoiceRecord | undefined>),
    );
    return data ? deserializeInvoiceRecord(data) : undefined;
  }

  async markInvoiceConsumed(paymentHash: PaymentHash, consumedAtMs: number): Promise<void> {
    const existing = await this.loadInvoice(paymentHash);
    if (!existing) return;
    if (existing.consumedAt !== undefined) return;
    await this.withStore(STORE_INVOICES, 'readwrite', (store) => {
      store.put(serializeInvoiceRecord({ ...existing, consumedAt: consumedAtMs }));
    });
  }

  async delete(id: ChannelId): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction([STORE_CHANNELS, STORE_STATES], 'readwrite');
    tx.objectStore(STORE_CHANNELS).delete(id);
    tx.objectStore(STORE_STATES).delete(id);
    await txToPromise(tx);
  }

  async clear(): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction([STORE_CHANNELS, STORE_STATES, STORE_INVOICES], 'readwrite');
    tx.objectStore(STORE_CHANNELS).clear();
    tx.objectStore(STORE_STATES).clear();
    tx.objectStore(STORE_INVOICES).clear();
    await txToPromise(tx);
  }

  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = undefined;
  }
}
