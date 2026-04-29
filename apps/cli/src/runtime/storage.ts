import { FileStorage } from '@tainnel/sdk';
import { defaultDbDir } from './config.js';

export function openStorage(env: NodeJS.ProcessEnv = process.env, override?: string): FileStorage {
  return new FileStorage({ root: override ?? defaultDbDir(env) });
}
