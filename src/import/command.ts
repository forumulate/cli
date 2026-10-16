import { dirname, join } from 'node:path';
import type { ForumulateClient } from '@forumulate/sdk';
import { resolveLibrary, TargetError } from '../content/library';
import { readContentfulExport } from './contentful';
import { diskFiles, fetchBytes as diskFetch } from './disk';
import { runImport } from './engine';
import { readPayloadExport } from './payload';
import { reportLines, exitCode } from './report';
import { readSanityExport } from './sanity';
import { readStrapiExport } from './strapi';
import { isStrapiArchive, STRAPI_ARCHIVE_ROOT, strapiArchiveFiles } from './strapi-archive';
import type { ImportFiles, ImportSource } from './types';
import { readWordpressExport } from './wordpress';

/**
 * `forumulate import <platform> <path> --library <id|slug>` (plan P4-T3, T4).
 *
 * Reads the export, shows what the model needs and what would land (a dry run
 * is always the first step), and writes only after a yes or `--yes`. Talks to
 * the library through the same management API every other client uses.
 */

export interface ImportDeps {
  client: ForumulateClient;
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<string>;
  upload?: (path: string, form: FormData) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  files?: ImportFiles;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

export const IMPORT_PLATFORMS = ['payload', 'contentful', 'sanity', 'strapi', 'wordpress'] as const;
export const IMPORT_VALUE_FLAGS = ['--config', '--publish', '--base-url', '--media-collection'];

class UsageError extends Error {}

function valuesOf(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out;
}

export function readSource(platform: string, path: string, argv: readonly string[], files: ImportFiles): ImportSource {
  const value = (n: string) => valuesOf(argv, n)[0];
  switch (platform) {
    case 'payload': {
      const config = value('--config');
      const media = valuesOf(argv, '--media-collection');
      return readPayloadExport(path, files, { configPath: config, ...(media.length ? { mediaCollections: media } : {}) });
    }
    case 'contentful':
      return readContentfulExport(files.read(path));
    case 'sanity':
      return readSanityExport(files.read(files.isDir(path) ? join(path, 'data.ndjson') : path));
    case 'strapi':
      return readStrapiExport(path, files, { baseUrl: value('--base-url') });
    case 'wordpress':
      return readWordpressExport(files.read(path));
    default:
      throw new UsageError(`Unknown platform "${platform}". Import from: ${IMPORT_PLATFORMS.join(', ')}.`);
  }
}

export async function runImportCommand(argv: readonly string[], positional: readonly string[], deps: ImportDeps): Promise<number> {
  let files = deps.files ?? diskFiles;
  const env = deps.env ?? process.env;
  const flag = (n: string) => argv.includes(n);
  const value = (n: string) => valuesOf(argv, n)[0];
  const [platform, given] = positional;
  let path = given;
  try {
    // `strapi export --no-encrypt` writes one archive: unpack it in memory and read it as a folder.
    if (platform === 'strapi' && path && isStrapiArchive(path) && !files.isDir(path)) {
      files = strapiArchiveFiles(files.readBytes(path), path);
      path = STRAPI_ARCHIVE_ROOT;
    }
    if (!platform || !path) throw new UsageError(`Usage: forumulate import <${IMPORT_PLATFORMS.join('|')}> <export path> --library <id|slug>`);
    const publish = value('--publish') ?? 'source';
    if (publish !== 'source' && publish !== 'all' && publish !== 'none') throw new UsageError('--publish is source, all or none.');
    const target = await resolveLibrary(deps.client, { org: value('--org') ?? env.FORUMULATE_ORG, library: value('--library') ?? env.FORUMULATE_LIBRARY });
    const source = readSource(platform, path, argv, files);
    const root = files.isDir(path) ? path : dirname(path);
    const engineDeps = {
      client: deps.client,
      upload: deps.upload,
      files,
      fetchBytes: deps.fetchBytes ?? diskFetch,
      root,
      sleep: deps.sleep,
    };
    const base = {
      orgId: target.orgId,
      libraryId: target.libraryId,
      publish,
      allowModelRemovals: flag('--allow-model-removals'),
      pace: Number(value('--pace') ?? 0) || 0,
    } as const;

    const dry = await runImport(source, engineDeps, { ...base, dryRun: true });
    if (flag('--json') && flag('--dry-run')) {
      deps.out(JSON.stringify(dry, null, 2));
      return 0;
    }
    if (!flag('--json')) {
      deps.out(`${platform} export ${path} → "${target.name}":`);
      for (const l of reportLines(dry)) deps.out(l);
    }
    if (flag('--dry-run')) return 0;
    if (!flag('--yes')) {
      if (!deps.ask) {
        deps.err('Nothing imported: pass --yes to import without a prompt (or --dry-run to only look).');
        return 1;
      }
      const a = (await deps.ask(`Import ${dry.entries.planned} entries and ${dry.media.planned} files into "${target.name}"? [y/N] `)).trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') {
        deps.out('Nothing imported.');
        return 0;
      }
    }
    const done = await runImport(source, engineDeps, { ...base, dryRun: false });
    if (flag('--json')) deps.out(JSON.stringify(done, null, 2));
    else for (const l of reportLines(done)) deps.out(l);
    return exitCode(done);
  } catch (e) {
    if (e instanceof UsageError || e instanceof TargetError) {
      deps.err(e.message);
      return 1;
    }
    deps.err(`Import stopped: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
