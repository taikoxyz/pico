export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  constructor(message: string, opts: { code?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = opts.code ?? 'CLI_ERROR';
    this.exitCode = opts.exitCode ?? 1;
  }
}
