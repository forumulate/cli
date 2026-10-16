import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ForumulateClient, ModelFileFormat, ModelOp } from '@forumulate/sdk';
import { resolveLibrary, TargetError } from './library';
import { issueLines, pushReport } from './render';
import { generateTypes } from './types-gen';

/**
 * `forumulate content types | pull | push` (plan P4-T1, P4-T2).
 *
 * The CLI is thin on purpose: the model file is converted and diffed by the
 * API (`…/model/export`, `…/model/import`), so the CLI, the studio and any
 * other client agree on what a push means. What lives here is the terminal
 * side: files, the library a slug means, the diff a person reads, and the
 * confirmation before anything is written.
 */

export interface ContentDeps {
  client: ForumulateClient;
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** A visible question (y/N). Absent where nobody can answer: `--yes` is then required to apply. */
  ask?: (question: string) => Promise<string>;
  files?: { read(path: string): string; write(path: string, text: string): void; exists(path: string): boolean };
}

/** Flags of `content` that carry a value (`--out file`), so the value is not read as an argument. */
export const CONTENT_VALUE_FLAGS = ['--library', '--out', '--format', '--schema', '--rename', '--rename-type', '--rename-block'];

const disk = {
  read: (p: string) => readFileSync(p, 'utf8'),
  write: (p: string, t: string) => writeFileSync(p, t),
  exists: (p: string) => existsSync(p),
};

class UsageError extends Error {}

/** `--x v` and `--x=v`, every occurrence. */
function valuesOf(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out;
}

const PAIR = /^([^=]+)=([^=]+)$/;

/**
 * `--rename post.headline=title`, `--rename block:hero.heading=title`,
 * `--rename library:subtitle=tagline`; the new name may be a key (the field
 * stays where it is) or the full path. A diff cannot tell a rename from a
 * removal plus an addition, so this is how a push keeps the values.
 */
export function renameOps(argv: readonly string[]): ModelOp[] {
  const ops: ModelOp[] = [];
  for (const spec of valuesOf(argv, '--rename')) {
    const m = PAIR.exec(spec);
    if (!m) throw new UsageError(`--rename takes type.field=newName, not "${spec}".`);
    const [, left, right] = m as unknown as [string, string, string];
    let scope: { type?: string; blockType?: string } = {};
    let path: string;
    if (left.startsWith('block:') || left.startsWith('library:')) {
      const rest = left.slice(left.indexOf(':') + 1);
      if (left.startsWith('block:')) {
        const dot = rest.indexOf('.');
        if (dot < 0) throw new UsageError(`--rename block:<blockType>.<field>=newName, not "${spec}".`);
        scope = { blockType: rest.slice(0, dot) };
        path = rest.slice(dot + 1);
      } else path = rest;
    } else {
      const dot = left.indexOf('.');
      if (dot < 0) throw new UsageError(`--rename <type>.<field>=newName, not "${spec}".`);
      scope = { type: left.slice(0, dot) };
      path = left.slice(dot + 1);
    }
    const to = right.includes('.') ? right : [...path.split('.').slice(0, -1), right].join('.');
    ops.push({ op: 'renameField', ...scope, from: path, to });
  }
  for (const [flag, op] of [['--rename-type', 'renameType'], ['--rename-block', 'renameBlockType']] as const) {
    for (const spec of valuesOf(argv, flag)) {
      const m = PAIR.exec(spec);
      if (!m) throw new UsageError(`${flag} takes old=new, not "${spec}".`);
      ops.push({ op, from: m[1]!, to: m[2]! });
    }
  }
  return ops;
}

function formatOf(value: string | undefined, file?: string): ModelFileFormat {
  if (value === 'json' || value === 'payload') return value;
  if (value !== undefined) throw new UsageError(`--format is json or payload, not "${value}".`);
  if (!file || /\.json$/i.test(file)) return 'json';
  if (/\.(c|m)?(t|j)s$/i.test(file)) return 'payload';
  throw new UsageError(`Cannot tell the format of ${file}; pass --format json|payload.`);
}

/** The library and model version a pulled file names, when it does. */
function fileHeader(format: ModelFileFormat, content: string): { library?: string; version?: number } {
  if (format === 'payload') {
    const library = /^\s*\/\/\s*forumulate:library\s+(\S+)/m.exec(content)?.[1];
    const version = /^\s*\/\/\s*forumulate:model-version\s+(\d+)/m.exec(content)?.[1];
    return { library, version: version ? Number(version) : undefined };
  }
  try {
    const parsed = JSON.parse(content) as { library?: { id?: unknown }; version?: unknown };
    return {
      library: typeof parsed.library?.id === 'string' ? parsed.library.id : undefined,
      version: typeof parsed.version === 'number' ? parsed.version : undefined,
    };
  } catch {
    return {}; // The API names what is wrong with it.
  }
}

export async function runContent(argv: readonly string[], positional: readonly string[], deps: ContentDeps): Promise<number> {
  const files = deps.files ?? disk;
  const env = deps.env ?? process.env;
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => valuesOf(argv, name)[0];
  const json = flag('--json');
  const [sub, ...rest] = positional;
  const want = (fromFile?: string) => ({
    org: value('--org') ?? env.FORUMULATE_ORG,
    library: value('--library') ?? env.FORUMULATE_LIBRARY ?? fromFile,
  });

  try {
    switch (sub) {
      case 'types': {
        const out = value('--out') ?? 'forumulate.d.ts';
        let schema: unknown;
        let libraryId: string | undefined;
        const schemaFile = value('--schema');
        if (schemaFile) {
          schema = JSON.parse(files.read(schemaFile));
        } else {
          const target = await resolveLibrary(deps.client, want());
          libraryId = target.libraryId;
          schema = await deps.client.content.model.schema(target.orgId, target.libraryId, flag('--preview') ? { audience: 'preview' } : {});
        }
        const command = schemaFile
          ? `forumulate content types --schema ${schemaFile} --out ${out}`
          : `forumulate content types --library ${want().library} --out ${out}${flag('--preview') ? ' --preview' : ''}`;
        const generated = generateTypes(schema, { libraryId, command });
        if (flag('--check')) {
          // For CI after a `content.model.changed` webhook: fail when the committed types are stale.
          const current = files.exists(out) ? files.read(out).replace(/\r\n/g, '\n') : null;
          if (current === generated.source) {
            deps.out(`${out} is up to date.`);
            return 0;
          }
          deps.err(`${out} is ${current === null ? 'missing' : 'out of date with the model'}; run without --check to regenerate it.`);
          return 1;
        }
        files.write(out, generated.source);
        deps.out(
          `Wrote ${out}: ${generated.types.length} collection${generated.types.length === 1 ? '' : 's'}, ` +
            `${generated.globals.length} global${generated.globals.length === 1 ? '' : 's'}, ` +
            `${generated.blocks.length} block type${generated.blocks.length === 1 ? '' : 's'}.`,
        );
        return 0;
      }
      case 'pull': {
        const format = formatOf(value('--format'));
        const target = await resolveLibrary(deps.client, want());
        const res = await deps.client.content.model.export(target.orgId, target.libraryId, format);
        const out = value('--out') ?? res.filename;
        files.write(out, res.content);
        if (json) deps.out(JSON.stringify({ file: out, version: res.version, issues: res.issues }, null, 2));
        else {
          deps.out(`Wrote ${out} from "${target.name}" (model version ${res.version}).`);
          for (const line of issueLines(res.issues)) deps.out(line);
        }
        return 0;
      }
      case 'push': {
        const file =
          rest[0] ?? ['forumulate.content.json', 'forumulate.payload.ts'].find((f) => files.exists(f));
        if (!file) throw new UsageError('No model file: name one, or run in a folder with forumulate.content.json or forumulate.payload.ts.');
        const content = files.read(file);
        const format = formatOf(value('--format'), file);
        const header = fileHeader(format, content);
        const target = await resolveLibrary(deps.client, want(header.library));
        const ops = renameOps(argv);
        const force = flag('--force');
        const body = { format, content, ...(ops.length ? { ops } : {}), ...(force ? { force } : {}) };
        const dry = await deps.client.content.model.import(target.orgId, target.libraryId, { ...body, dryRun: true });
        if (json && (flag('--dry-run') || !dry.changed)) {
          deps.out(JSON.stringify(dry, null, 2));
          return 0;
        }
        if (!json) {
          deps.out(`${file} → "${target.name}" (model version ${dry.version}):`);
          for (const line of pushReport(dry)) deps.out(line);
          if (dry.changed && header.version !== undefined && header.version !== dry.version && !force) {
            deps.err(`This file was pulled at version ${header.version}; the library is at ${dry.version}. Pull again, or apply with --force.`);
          }
        }
        if (flag('--dry-run') || !dry.changed) return 0;
        if (!flag('--yes')) {
          if (!deps.ask) {
            deps.err('Nothing applied: pass --yes to apply without a prompt (or --dry-run to only look).');
            return 1;
          }
          const answer = (await deps.ask(`Apply ${dry.diff.length || 'these'} change(s) to "${target.name}"? [y/N] `)).trim().toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            deps.out('Nothing applied.');
            return 0;
          }
        }
        const applied = await deps.client.content.model.import(target.orgId, target.libraryId, body);
        if (json) deps.out(JSON.stringify(applied, null, 2));
        else deps.out(applied.applied ? `Applied: "${target.name}" is at model version ${applied.version}.` : 'Nothing to apply.');
        return 0;
      }
      default:
        deps.err(`Usage: forumulate content types|pull|push … (forumulate help)`);
        return 1;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof TargetError) {
      deps.err(e.message);
      return 1;
    }
    throw e;
  }
}
