import prompts from 'prompts';

export interface PromptDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly read?: (label: string) => Promise<string>;
}

export async function readPassphrase(label: string, deps: PromptDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  if (typeof env.TAINNEL_PASSPHRASE === 'string' && env.TAINNEL_PASSPHRASE.length > 0) {
    return env.TAINNEL_PASSPHRASE;
  }
  if (deps.read) return deps.read(label);
  const r = await prompts({ type: 'password', name: 'p', message: label });
  if (typeof r.p !== 'string' || r.p.length === 0) {
    throw new Error('passphrase required');
  }
  return r.p;
}

export async function readNewPassphrase(deps: PromptDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  if (typeof env.TAINNEL_PASSPHRASE === 'string' && env.TAINNEL_PASSPHRASE.length > 0) {
    return env.TAINNEL_PASSPHRASE;
  }
  const a = await readPassphrase('Choose a passphrase', deps);
  const b = await readPassphrase('Confirm passphrase', deps);
  if (a !== b) throw new Error('passphrases do not match');
  return a;
}
