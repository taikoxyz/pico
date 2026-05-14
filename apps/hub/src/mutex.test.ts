import { describe, expect, it } from 'vitest';
import { KeyedMutex, Mutex } from './mutex.js';

describe('Mutex', () => {
  it('serializes overlapping work', async () => {
    const m = new Mutex();
    const order: number[] = [];
    const a = m.run(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const b = m.run(async () => {
      order.push(2);
    });
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });

  it('continues after a thrown task', async () => {
    const m = new Mutex();
    await expect(
      m.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    const ok = await m.run(async () => 'ok');
    expect(ok).toBe('ok');
  });
});

describe('KeyedMutex', () => {
  it('runs different keys in parallel', async () => {
    const km = new KeyedMutex<string>();
    let inflight = 0;
    let maxInflight = 0;
    const work = async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
    };
    await Promise.all([km.run('a', work), km.run('b', work)]);
    expect(maxInflight).toBe(2);
  });

  it('serializes per-key', async () => {
    const km = new KeyedMutex<string>();
    let inflight = 0;
    let maxInflight = 0;
    const work = async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
    };
    await Promise.all([km.run('a', work), km.run('a', work)]);
    expect(maxInflight).toBe(1);
  });

  it('frees per-key locks once all work for a key completes (no leak)', async () => {
    const km = new KeyedMutex<string>();
    for (let i = 0; i < 100; i++) {
      await km.run(`key-${i}`, async () => i);
    }
    expect(km.size).toBe(0);
  });

  it('keeps the lock alive while concurrent work for the same key is queued', async () => {
    const km = new KeyedMutex<string>();
    const a = km.run('k', async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const b = km.run('k', async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(km.size).toBe(1);
    await Promise.all([a, b]);
    expect(km.size).toBe(0);
  });
});
