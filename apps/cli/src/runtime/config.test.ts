import { describe, expect, it } from 'vitest';
import { configDir, defaultDbDir, defaultKeyFilePath } from './config.js';

describe('runtime config', () => {
  it('PICO_CONFIG_DIR overrides everything', () => {
    expect(configDir({ PICO_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x');
    expect(defaultKeyFilePath({ PICO_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x/key.enc');
    expect(defaultDbDir({ PICO_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x/db');
  });

  it('XDG_CONFIG_HOME wins over HOME default', () => {
    expect(configDir({ XDG_CONFIG_HOME: '/u/x' })).toBe('/u/x/pico');
  });

  it('falls back to ~/.config/pico', () => {
    expect(configDir({ HOME: '/h' })).toBe('/h/.config/pico');
  });
});
