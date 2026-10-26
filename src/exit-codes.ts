/**
 * The exit codes every `forumulate` command answers with (FMU-D05).
 *
 * A pipeline reads the exit code, not the prose. Everything used to be 0 or 1,
 * so a CI step could not tell "the token is wrong" from "the page the manifest
 * names is gone" from "somebody edited this in the studio" — three failures with
 * three different fixes, one of which (auth) should page a person and two of
 * which should not. These are documented in `forumulate help` and on every
 * command's own `--help`; changing one is a breaking change for every script
 * that branches on it.
 */
export const EXIT = {
  /** Done, and verified where the command verifies. */
  OK: 0,
  /** The work ran but the result is wrong: a read-back mismatch, a doctor FAIL, a failed check. */
  FAILED: 1,
  /** The command line itself is wrong: unknown command, missing argument, contradictory flags. */
  USAGE: 2,
  /** No token, or the API refused the one given (401, or a 403 about the token's own scope). */
  AUTH: 3,
  /** The org, space, page or operation named does not exist (404). */
  NOT_FOUND: 4,
  /** The write collided with something: a 409/412, or studio edits a publish would overwrite. */
  CONFLICT: 5,
  /** `--wait` gave up: the job was still running when `--timeout` passed (FMU-D03; `timeout(1)`'s code). */
  TIMEOUT: 124,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** The block `--help` prints, so every command documents the same table. */
export const EXIT_CODES_HELP = `Exit status:
  0  ok          1  failed (verification mismatch, doctor FAIL)
  2  usage       3  auth (no token, 401, token not allowed)
  4  not found   5  conflict (409/412, edited in the studio since your last publish)
  124 --wait timed out (the job keeps running; with --wait, a failed job is 1)`;

/**
 * The exit code an API error maps to.
 *
 * A 403 is auth only when it is about the CREDENTIAL (`rbac.forbidden` names
 * the token's scope); a 403 because the user lacks a role is still "the token
 * you gave cannot do this", which is the same fix — use another token — so both
 * are 3. A 422 is the caller's input, so it is a usage error.
 */
export function exitCodeForError(e: unknown): ExitCode {
  const err = e as { status?: number; code?: string; exitCode?: number } | null;
  if (err && typeof err.exitCode === 'number') return err.exitCode as ExitCode;
  // A Cloudflare block page is the edge refusing the request before the API saw
  // it — the token was never read, so "use another token" (3) would send a
  // person to the wrong fix. It is a failed call (1); the message names the edge.
  if (err?.code === 'edge.blocked') return EXIT.FAILED;
  const status = err?.status;
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404 || status === 410) return EXIT.NOT_FOUND;
  if (status === 409 || status === 412) return EXIT.CONFLICT;
  if (status === 400 || status === 422) return EXIT.USAGE;
  return EXIT.FAILED;
}
