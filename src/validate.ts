import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Http } from './api/http';
import { apiBaseFromEnv } from './api-base';
import { resolveToken } from './credentials';
import { EXIT, EXIT_CODES_HELP, exitCodeForError } from './exit-codes';
import { MANIFEST_NAMES } from './publish/reserved';
import { splitFront } from './publish/frontmatter';

/**
 * `forumulate validate <dir>` (FMU-D11): check a folder's configuration
 * against the published schemas before publishing it.
 *
 * Reads the manifest (`forumulate.yaml`), the front matter of every Markdown
 * file, and any JSON/YAML file whose `$schema` names one of our schemas
 * (`https://forumulate.com/schemas/<date>/<name>.json`) — a theme kept in
 * git, a site config — and sends them to `POST /schemas/<date>/validate`.
 * The server holds the zod schemas the API validates writes with, so this
 * answers exactly what the publish would, did-you-mean included, without the
 * CLI carrying a second copy of every schema. No token needed.
 */
export const SCHEMA_VERSION = '2026-12-01';
const SCHEMA_NAMES = ['site-config', 'space-theme', 'forumulate-yaml', 'front-matter', 'forum-category'];
const SCHEMA_URL = /\/schemas\/(\d{4}-\d{2}-\d{2})\/([a-z-]+)\.json$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);
const MAX_FILES = 5000;
const BATCH = 400;

export const VALIDATE_HELP = `forumulate validate — check a folder's configuration against the published schemas

Usage:
  forumulate validate [dir] [--json]

Checks forumulate.yaml, every Markdown file's front matter, and any JSON or YAML
file whose "$schema" names https://forumulate.com/schemas/${SCHEMA_VERSION}/<name>.json
(site-config, space-theme, forumulate-yaml, front-matter, forum-category).
Each problem is printed with its file, key path and did-you-mean. Unknown
front matter keys are warnings (they are ignored on publish); everything else
is an error.

${EXIT_CODES_HELP}
  (validate: 0 when every document is valid, 2 when one is not)`;

export interface ValidateDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  http?: Http;
  userAgent?: string;
  /** The global `--token` (FMU-DOC01); beats FORUMULATE_TOKEN and the stored token. */
  flagToken?: string;
  /** File access, injected so tests touch no disk. */
  files?: {
    list: (dir: string) => string[];
    read: (path: string) => string;
  };
}

interface Doc {
  schema: string;
  document: unknown;
  source: string;
}

interface Result {
  schema: string;
  source?: string;
  valid: boolean;
  issues: { path: string; message: string; severity: 'error' | 'warning'; hint?: string }[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (out.length >= MAX_FILES) break;
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The documents a folder holds, each with the schema it is checked against. */
export function collectDocuments(
  root: string,
  files: NonNullable<ValidateDeps['files']>,
  problems: string[],
): Doc[] {
  const docs: Doc[] = [];
  for (const path of files.list(root)) {
    const rel = relative(root, path) || path;
    const base = rel.split(/[\\/]/).pop() ?? rel;
    const ext = extname(base).toLowerCase();
    try {
      if (MANIFEST_NAMES.includes(base) && !rel.includes('/') && !rel.includes('\\')) {
        const text = files.read(path);
        docs.push({ schema: 'forumulate-yaml', document: ext === '.json' ? JSON.parse(text) : parseYaml(text), source: rel });
      } else if (ext === '.md' || ext === '.mdx') {
        const { data, raw } = splitFront(files.read(path));
        if (raw !== null) docs.push({ schema: 'front-matter', document: data, source: rel });
      } else if (ext === '.json' || ext === '.yaml' || ext === '.yml') {
        const text = files.read(path);
        if (!text.includes('/schemas/')) continue;
        const doc = (ext === '.json' ? JSON.parse(text) : parseYaml(text)) as Record<string, unknown> | null;
        const m = typeof doc?.$schema === 'string' ? SCHEMA_URL.exec(doc.$schema) : null;
        if (!m || !SCHEMA_NAMES.includes(m[2]!)) continue;
        if (m[1] !== SCHEMA_VERSION)
          problems.push(`${rel}: names schemas of ${m[1]}; this CLI checks ${SCHEMA_VERSION}.`);
        const { $schema: _s, ...rest } = doc!;
        docs.push({ schema: m[2]!, document: rest, source: rel });
      }
    } catch (e) {
      problems.push(`${rel}: ${(e as Error).message}`);
    }
  }
  return docs;
}

export async function runValidateCommand(argv: string[], deps: ValidateDeps): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.out(VALIDATE_HELP);
    return EXIT.OK;
  }
  const json = argv.includes('--json');
  const positionals = argv.filter((a) => !a.startsWith('--'));
  if (positionals.length > 1) {
    deps.err('Usage: forumulate validate [dir] [--json]');
    return EXIT.USAGE;
  }
  const root = resolve(positionals[0] ?? '.');
  const files = deps.files ?? {
    list: (d: string) => walk(d),
    read: (p: string) => readFileSync(p, 'utf8'),
  };
  const problems: string[] = [];
  let docs: Doc[];
  try {
    docs = collectDocuments(root, files, problems);
  } catch (e) {
    deps.err(`Cannot read ${root}: ${(e as Error).message}`);
    return EXIT.USAGE;
  }
  const env = deps.env ?? process.env;
  const baseUrl = apiBaseFromEnv(env);
  const http =
    deps.http ??
    new Http({
      baseUrl,
      token: resolveToken(baseUrl, env, deps.flagToken),
      userAgent: deps.userAgent ?? '@forumulate/cli',
    });
  const results: Result[] = [];
  try {
    for (let i = 0; i < docs.length; i += BATCH) {
      const res = await http.send({
        method: 'POST',
        path: `/schemas/${SCHEMA_VERSION}/validate`,
        body: { documents: docs.slice(i, i + BATCH) },
      });
      results.push(...(((res.data as { results?: Result[] }).results ?? []) as Result[]));
    }
  } catch (e) {
    deps.err(`Validation failed: ${(e as Error).message}`);
    return exitCodeForError(e);
  }

  const invalid = results.filter((r) => !r.valid).length + problems.length;
  if (json) {
    deps.out(JSON.stringify({ root, checked: results.length, invalid, problems, results }, null, 2));
  } else {
    for (const p of problems) deps.out(`ERROR    ${p}`);
    for (const r of results)
      for (const i of r.issues) {
        const where = `${r.source ?? r.schema}${i.path ? ` ${i.path}` : ''}`;
        deps.out(`${i.severity === 'error' ? 'ERROR  ' : 'WARNING'}  ${where}: ${i.message}`);
        if (i.hint) deps.out(`         ${i.hint}`);
      }
    deps.out(
      `${results.length} document(s) checked, ${invalid} invalid` +
        (docs.length === 0 ? ' (no forumulate.yaml, front matter or $schema file found)' : '') +
        '.',
    );
  }
  return invalid > 0 ? EXIT.USAGE : EXIT.OK;
}
