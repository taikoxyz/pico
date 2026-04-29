import { describe, expect, it } from 'vitest';
import { configDir, defaultDbDir, defaultKeyFilePath } from './config.js';

describe('runtime config', () => {
  it('TAINNEL_CONFIG_DIR overrides everything', () => {
    expect(configDir({ TAINNEL_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(defaultKeyFilePath({ TAINNEL_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x/key.enc');
    expect(defaultDbDir({ TAINNEL_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x/db');
  });

  it('XDG_CONFIG_HOME wins over HOME default', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/u/x' })).toBe('/u/x/tainnel');
  });

  it('falls back to ~/.config/tainnel', () => {
    expect(configDir({ HOME: '/h' })).toBe('/h/.config/tainnel');
  });
});
