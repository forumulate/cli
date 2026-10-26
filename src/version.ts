/**
 * Kept in step with package.json by `cli-version.test.ts` — they had drifted to
 * 0.1.0 and 0.2.1, so `--version` reported a release that was never published.
 * Its own module so `api list` can name the CLI that bundled its operation
 * list without importing `run.ts` (which imports it).
 */
export const VERSION = '0.11.0';
