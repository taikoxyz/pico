/* Test-only helpers shared across CLI test suites. */

/** Take a stream of stdout writes (one or more strings concatenated), strip
 * trailing whitespace, and return the last newline-delimited line parsed as
 * JSON. Throws (failing the test) if there are no lines. Replaces the
 * non-null-assertion pattern `JSON.parse(arr.pop()!)`. */
export function lastJsonLine<T = Record<string, unknown>>(stdout: string | readonly string[]): T {
  const joined = Array.isArray(stdout) ? stdout.join('') : (stdout as string);
  const lines = joined.trim().split('\n');
  const last = lines[lines.length - 1];
  if (last === undefined || last.length === 0) {
    throw new Error(`expected at least one stdout line, got:\n${joined}`);
  }
  return JSON.parse(last) as T;
}
