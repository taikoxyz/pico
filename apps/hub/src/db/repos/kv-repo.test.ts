import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, makeTestDb } from './_test-helpers.js';

describe('KvRepo', () => {
  let h: TestDb;
  beforeEach(async () => {
    h = await makeTestDb();
  });
  afterEach(async () => h.cleanup());

  it('round-trips a value and overwrites on set', async () => {
    expect(await h.repos.kv.get('foo')).toBeUndefined();
    await h.repos.kv.set('foo', '1');
    expect(await h.repos.kv.get('foo')).toBe('1');
    await h.repos.kv.set('foo', '2');
    expect(await h.repos.kv.get('foo')).toBe('2');
  });

  it('remove deletes the value', async () => {
    await h.repos.kv.set('bar', 'baz');
    await h.repos.kv.remove('bar');
    expect(await h.repos.kv.get('bar')).toBeUndefined();
  });
});
