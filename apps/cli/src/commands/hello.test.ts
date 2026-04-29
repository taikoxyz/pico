import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { helloCommand } from './hello.js';

let infos: string[] = [];
let original: typeof console.info;

beforeEach(() => {
  infos = [];
  original = console.info;
  console.info = (...args: unknown[]) => {
    infos.push(args.map((a) => String(a)).join(' '));
  };
});
afterEach(() => {
  console.info = original;
});

describe('hello command', () => {
  it('lists workspace packages', async () => {
    await helloCommand().parseAsync(['node', 'hello']);
    const all = infos.join('\n');
    expect(all).toContain('@tainnel/cli');
    expect(all).toContain('@tainnel/sdk');
    expect(all).toMatch(/\d+ packages/);
  });
});
