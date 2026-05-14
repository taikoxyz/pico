export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const next = this.tail.then(() => fn());
    this.tail = next.catch(() => undefined);
    return next.finally(() => {
      this.pending--;
    });
  }

  get inflight(): number {
    return this.pending;
  }
}

export class KeyedMutex<K> {
  private readonly locks = new Map<K, Mutex>();

  run<T>(key: K, fn: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    const heldLock = lock;
    return heldLock.run(fn).finally(() => {
      if (heldLock.inflight === 0 && this.locks.get(key) === heldLock) {
        this.locks.delete(key);
      }
    });
  }

  get size(): number {
    return this.locks.size;
  }
}
