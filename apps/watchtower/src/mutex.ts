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
