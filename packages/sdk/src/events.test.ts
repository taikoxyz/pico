import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from './events.js';

interface TestMap {
  hello: { name: string };
  error: { error: Error; context?: string };
}

describe('TypedEventEmitter', () => {
  it('dispatches to registered handlers', () => {
    const e = new TypedEventEmitter<TestMap>();
    const calls: string[] = [];
    e.on('hello', ({ name }) => calls.push(name));
    e.emit('hello', { name: 'world' });
    expect(calls).toEqual(['world']);
  });

  it('off removes a handler', () => {
    const e = new TypedEventEmitter<TestMap>();
    const handler = vi.fn();
    e.on('hello', handler);
    e.off('hello', handler);
    e.emit('hello', { name: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('on returns an unsubscribe function', () => {
    const e = new TypedEventEmitter<TestMap>();
    const handler = vi.fn();
    const off = e.on('hello', handler);
    off();
    e.emit('hello', { name: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('thrown handler errors are routed to the error event', () => {
    const e = new TypedEventEmitter<TestMap>();
    const errors: Error[] = [];
    e.on('error', ({ error }) => errors.push(error));
    e.on('hello', () => {
      throw new Error('boom');
    });
    e.emit('hello', { name: 'x' });
    expect(errors[0]?.message).toBe('boom');
  });

  it('emitting an unregistered event is a no-op', () => {
    const e = new TypedEventEmitter<TestMap>();
    expect(() => e.emit('hello', { name: 'x' })).not.toThrow();
  });
});
