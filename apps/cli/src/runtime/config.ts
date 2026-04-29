import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TAINNEL_CONFIG_DIR) return env.TAINNEL_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'tainnel');
  return join(env.HOME ?? homedir(), '.config', 'tainnel');
}

export function defaultKeyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'key.enc');
}

export function defaultDbDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), 'db');
}
