import type { Channel } from '@inferenceroom/pico-protocol';

const REPLACER = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

export function jsonLine(obj: unknown): string {
  return JSON.stringify(obj, REPLACER);
}

export interface WritableStream {
  write(s: string): void;
}

export function emit(obj: unknown, stream: WritableStream = process.stdout): void {
  stream.write(`${jsonLine(obj)}\n`);
}

export function formatChannelTable(channels: readonly Channel[]): string {
  if (channels.length === 0) return '(no channels)';
  const header = 'ID            STATUS                COUNTERPARTY';
  const rows = channels.map((c) => {
    const id = `${c.id.slice(0, 12)}…`;
    const status = c.status.padEnd(20);
    const cp = `${c.userA.slice(0, 8)}…  ${c.userB.slice(0, 8)}…`;
    return `${id}  ${status}  ${cp}`;
  });
  return [header, ...rows].join('\n');
}
