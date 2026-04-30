export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => fn());
    this.tail = next.catch(() => undefined);
    return next;
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
    return lock.run(fn);
  }
}
