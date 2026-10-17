import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { translationDoorOf, type ForumulateClient, type LabelScope, type TranslationCoverage, type TranslationState } from '@forumulate/sdk';
import { resolveLibrary } from '../content/library';
import { resolveLocaleTarget, resolveOrg, resolveSpace, TargetError } from './target';
import { ExtraUsage, runExtra } from './extras';
import {
  pullLabels,
  pullOverrides,
  pullPieces,
  pushLabels,
  pushOverrides,
  pushPieces,
  tableFormat,
  type SyncFiles,
} from './sync';

/**
 * `forumulate translations …` (alias `i18n`): every translation capability the
 * API has, from a terminal — a developer reported the CLI could not touch
 * translations at all, while the console, the API and the agent server could.
 *
 * Thin like `content`: the SDK's `client.translations` does the routing by
 * space type, so the CLI, the SDK and the MCP tools agree on what a
 * translation is. What lives here is the terminal side: slugs to ids, files,
 * a table a person reads, exit codes a CI job reads.
 */

export interface TranslationsDeps {
  client: ForumulateClient;
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  ask?: (question: string) => Promise<string>;
  files?: SyncFiles;
}

/** The subcommands, as data — `test/translation-surfaces.test.ts` checks the registry against it. */
export const TRANSLATIONS_COMMANDS = [
  'locales list',
  'locales add',
  'locales relabel',
  'locales remove',
  'locales set',
  'status',
  'pull',
  'push',
  'auto',
  'labels pull',
  'labels push',
  'overrides pull',
  'overrides push',
  'item-locale',
  'remove',
  'entry',
  'name',
  'switcher',
  'provider',
] as const;

export const TRANSLATIONS_VALUE_FLAGS = ['--site', '--locale', '--fail-on', '--state', '--entry', '--fields', '--collection', '--description'];

const disk: SyncFiles = {
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, t) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, t);
  },
  exists: (p) => existsSync(p),
  list: (dir) => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    };
    if (existsSync(dir)) walk(dir);
    return out;
  },
};

class UsageError extends Error {}

function valuesOf(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out;
}

/** `--locale es,fr --locale de` → ['es','fr','de']. */
const listOf = (argv: readonly string[], name: string): string[] | undefined => {
  const v = valuesOf(argv, name).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  return v.length ? v : undefined;
};

const STATES: readonly TranslationState[] = ['missing', 'draft', 'published', 'outdated'];
function statesOf(argv: readonly string[], name: string, fallback?: TranslationState[]): TranslationState[] | undefined {
  const v = listOf(argv, name);
  if (!v) return fallback;
  for (const s of v) if (!STATES.includes(s as TranslationState)) throw new UsageError(`${name} takes ${STATES.join(',')}, not "${s}".`);
  return v as TranslationState[];
}

/** What the reader's switcher would call a language, when no label is given ("español"). */
function nativeName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const NO_PROVIDER =
  'This organization has no translation provider connected, and there is no platform key: machine translation uses your own. ' +
  'Connect a DeepL key in Settings → Integrations (or PUT /orgs/{orgId}/deepl), then run this again.';

export async function runTranslations(argv: readonly string[], positional: readonly string[], deps: TranslationsDeps): Promise<number> {
  const files = deps.files ?? disk;
  const env = deps.env ?? process.env;
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => valuesOf(argv, name)[0];
  const json = flag('--json');
  const dump = (v: unknown) => deps.out(JSON.stringify(v, null, 2));
  const want = () => ({
    org: value('--org') ?? env.FORUMULATE_ORG,
    space: value('--space') ?? (value('--library') ? undefined : env.FORUMULATE_SPACE),
    library: value('--library') ?? env.FORUMULATE_LIBRARY,
  });
  const t = deps.client.translations;
  const [sub, ...rest] = positional;

  try {
    switch (sub) {
      case 'locales': {
        const [verb = 'list', ...args] = rest;
        const { orgId, target, name } = await resolveLocaleTarget(deps.client, want());
        if (verb === 'list') {
          const locales = await t.locales.list(orgId, target);
          if (json) dump(locales);
          else for (const l of locales) deps.out(`${l.code}  ${l.label}${l.isSource ? '  (source)' : ''}`);
          return 0;
        }
        if (verb === 'add' || verb === 'relabel') {
          const [code, ...label] = args;
          if (!code) throw new UsageError(`Usage: forumulate translations locales ${verb} <code> [label]`);
          const text = label.join(' ') || nativeName(code);
          const locales = verb === 'add' ? await t.locales.add(orgId, target, { code, label: text }) : await t.locales.relabel(orgId, target, code, text);
          if (json) dump(locales);
          else deps.out(`${verb === 'add' ? 'Added' : 'Renamed'} ${code} (“${text}”) on "${name}".`);
          return 0;
        }
        if (verb === 'remove') {
          const [code] = args;
          if (!code) throw new UsageError('Usage: forumulate translations locales remove <code> [--yes]');
          if (!flag('--yes')) {
            const answer = deps.ask ? (await deps.ask(`Remove ${code} from "${name}"? Its translations go to the trash. [y/N] `)).trim().toLowerCase() : '';
            if (answer !== 'y' && answer !== 'yes') {
              deps.err(deps.ask ? 'Nothing removed.' : 'Nothing removed: pass --yes to remove a language without a prompt.');
              return 1;
            }
          }
          const locales = await t.locales.remove(orgId, target, code);
          if (json) dump(locales);
          else deps.out(`Removed ${code} from "${name}".`);
          return 0;
        }
        if (verb === 'set') {
          if (!args.length) throw new UsageError('Usage: forumulate translations locales set <code[=Label]>... [--prune]');
          const wanted = args.map((a) => {
            const [code, ...label] = a.split('=');
            return { code: code!, label: label.join('=') || nativeName(code!) };
          });
          const res = await t.locales.set(orgId, target, wanted, { prune: flag('--prune') });
          if (json) dump(res);
          else {
            const said = [
              res.added.length && `added ${res.added.join(', ')}`,
              res.relabeled.length && `renamed ${res.relabeled.join(', ')}`,
              res.removed.length && `removed ${res.removed.join(', ')}`,
            ].filter(Boolean);
            deps.out(said.length ? `"${name}": ${said.join('; ')}.` : `"${name}" already declares exactly these languages.`);
          }
          return 0;
        }
        throw new UsageError('Usage: forumulate translations locales list|add|relabel|remove|set …');
      }

      case 'status': {
        const s = await resolveSpace(deps.client, want());
        const cov = await t.status(s.orgId, s.spaceId);
        const locales = listOf(argv, '--locale') ?? cov.locales.map((l) => l.code);
        const failOn = statesOf(argv, '--fail-on', []) ?? [];
        const failing = failingCells(cov, locales, failOn);
        if (json) dump({ ...cov, failOn, failing: failing.length });
        else renderStatus(deps.out, s.name, cov, locales);
        if (failing.length) {
          deps.err(`FAIL: ${failing.length} translation(s) ${failOn.join(' or ')} in ${locales.join(', ')}.`);
          return 1;
        }
        return 0;
      }

      case 'pull': {
        const s = await resolveSpace(deps.client, want());
        const cov = await t.status(s.orgId, s.spaceId);
        const out = value('--out') ?? 'translations';
        const res = await pullPieces({ ...deps, files }, s, cov, {
          out,
          locales: listOf(argv, '--locale') ?? cov.locales.map((l) => l.code),
          only: listOf(argv, '--only'),
          includeMissing: flag('--include-missing'),
        });
        if (json) dump(res);
        else
          deps.out(
            `Wrote ${res.written.length} file(s) under ${out}/` +
              (res.skipped ? `; ${res.skipped} missing translation(s) not written (add --include-missing for stubs).` : '.'),
          );
        return 0;
      }

      case 'push': {
        const s = await resolveSpace(deps.client, want());
        const dir = rest[0] ?? value('--out') ?? 'translations';
        const dryRun = flag('--dry-run');
        const plans = await pushPieces({ ...deps, files }, s, { dir, locales: listOf(argv, '--locale'), dryRun });
        if (json) dump(plans);
        else {
          for (const p of plans.filter((x) => x.action !== 'unchanged'))
            deps.out(
              p.action === 'write'
                ? `  ${dryRun ? 'would write' : 'wrote'}  ${p.locale}  ${p.path}  (${p.fields.join(', ')})`
                : p.action === 'stub'
                  ? `  skip   ${p.locale}  ${p.path}  (still the original's words)`
                  : `  skip   ${p.locale}  ${p.path}  (pulled from another space)`,
            );
          const n = plans.filter((x) => x.action === 'write').length;
          deps.out(`${n} translation(s) ${dryRun ? 'would change' : 'changed'}; ${plans.filter((x) => x.action === 'unchanged').length} unchanged.`);
        }
        return 0;
      }

      case 'auto':
        return await runAuto(argv, deps, want(), { json, dump, listOf, statesOf, value });

      case 'labels': {
        const [verb, file] = rest;
        const site = value('--site');
        const sp = site ? null : await resolveSpace(deps.client, want());
        const orgId = sp ? sp.orgId : await resolveOrg(deps.client, want().org);
        const scope: LabelScope = sp ? { spaceId: sp.spaceId } : { siteId: site! };
        const syncDeps = { ...deps, files };
        if (verb === 'pull') {
          const format = tableFormat(value('--format'), value('--out'));
          const out = value('--out') ?? (format === 'xliff' ? 'labels.xlf' : 'labels.json');
          files.write(out, await pullLabels(syncDeps, orgId, scope, { format, locales: listOf(argv, '--locale') }));
          deps.out(`Wrote ${out}.`);
          return 0;
        }
        if (verb === 'push') {
          if (!file) throw new UsageError('Usage: forumulate translations labels push <file> (--site <id> | --space <id|slug>) [--dry-run]');
          const res = await pushLabels(syncDeps, orgId, scope, files.read(file), { format: tableFormat(value('--format'), file), dryRun: flag('--dry-run') });
          if (json) dump(res);
          else {
            for (const c of res.changes) deps.out(`  ${c.locale}  “${c.text}” → ${JSON.stringify(c.to)}`);
            deps.out(`${res.changes.length} word(s) ${flag('--dry-run') ? 'would change' : 'changed'}.`);
          }
          return 0;
        }
        throw new UsageError('Usage: forumulate translations labels pull|push …');
      }

      case 'overrides': {
        const [verb, file] = rest;
        const orgId = await resolveOrg(deps.client, want().org);
        const syncDeps = { ...deps, files };
        if (verb === 'pull') {
          const format = tableFormat(value('--format'), value('--out'));
          const out = value('--out') ?? (format === 'xliff' ? 'overrides.xlf' : 'overrides.json');
          files.write(out, await pullOverrides(syncDeps, orgId, { format, locales: listOf(argv, '--locale') }));
          deps.out(`Wrote ${out}.`);
          return 0;
        }
        if (verb === 'push') {
          if (!file) throw new UsageError('Usage: forumulate translations overrides push <file> [--dry-run] [--prune]');
          const res = await pushOverrides(syncDeps, orgId, files.read(file), {
            format: tableFormat(value('--format'), file),
            dryRun: flag('--dry-run'),
            prune: flag('--prune'),
          });
          if (json) dump(res);
          else {
            const verbWord = flag('--dry-run') ? 'would ' : '';
            deps.out(`${res.set.length} override(s) ${verbWord}set, ${res.removed.length} ${verbWord}removed.`);
          }
          return 0;
        }
        throw new UsageError('Usage: forumulate translations overrides pull|push …');
      }

      case 'item-locale': {
        const [itemId, locale] = rest;
        if (!itemId || !locale) throw new UsageError('Usage: forumulate translations item-locale <itemId> <locale|none> --space <id|slug>');
        const s = await resolveSpace(deps.client, want());
        const res = await t.setItemLocale(s.orgId, s.spaceId, itemId, locale === 'none' ? null : locale);
        if (json) dump(res);
        else deps.out(`${itemId} is declared ${res.item.locale ?? 'without a language'}.`);
        return 0;
      }

      default: {
        const extra = await runExtra(sub, { argv, rest, deps, files, want, value, json });
        if (extra !== null) return extra;
        deps.err(
          'Usage: forumulate translations locales|status|pull|push|auto|labels|overrides|item-locale|remove|entry|name|switcher|provider … (forumulate help)',
        );
        return 1;
      }
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof TargetError || e instanceof ExtraUsage) {
      deps.err(e.message);
      return 1;
    }
    if ((e as { code?: string }).code === 'ai.unavailable') {
      deps.err(NO_PROVIDER);
      return 1;
    }
    throw e;
  }
}

/** Every (piece, language) cell in one of `states`, for the selected languages. */
export function failingCells(cov: TranslationCoverage, locales: string[], states: TranslationState[]) {
  if (!states.length) return [];
  return cov.items.flatMap((item) =>
    locales.flatMap((l) => (item.locales[l] && states.includes(item.locales[l]!.state) ? [{ item, locale: l }] : [])),
  );
}

function renderStatus(out: (l: string) => void, name: string, cov: TranslationCoverage, locales: string[]): void {
  out(`Translations of "${name}" — ${cov.items.length} ${cov.kind}(s)${cov.truncated ? ' (first 1,000)' : ''}`);
  if (!locales.length) {
    out('This space declares no languages yet: forumulate translations locales add <code> --space …');
    return;
  }
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));
  out(pad('', 12) + locales.map((l) => pad(l, 10)).join(''));
  for (const st of STATES) out(pad(st, 12) + locales.map((l) => pad(String(cov.totals[l]?.[st] ?? 0), 10)).join(''));
  const todo = cov.items.flatMap((i) =>
    locales.flatMap((l) => (i.locales[l] && i.locales[l]!.state !== 'published' ? [`  ${pad(l, 6)}${pad(i.locales[l]!.state, 10)}${i.slug ?? i.id}  ${i.title}`] : [])),
  );
  if (todo.length) out('');
  for (const line of todo) out(line);
}

async function runAuto(
  argv: readonly string[],
  deps: TranslationsDeps,
  want: { org?: string; space?: string; library?: string },
  h: {
    json: boolean;
    dump: (v: unknown) => void;
    listOf: typeof listOf;
    statesOf: typeof statesOf;
    value: (n: string) => string | undefined;
  },
): Promise<number> {
  const t = deps.client.translations;
  const locales = h.listOf(argv, '--locale');
  if (!locales) throw new UsageError('Say which language(s): --locale es[,fr].');
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  if (want.library && !want.space) {
    const entries = h.listOf(argv, '--entry');
    if (!entries) throw new UsageError('Say which entries: --entry <id>[,<id>] (a library is translated entry by entry).');
    const lib = await resolveLibrary(deps.client, want);
    const results: unknown[] = [];
    for (const locale of locales)
      for (const entryId of entries) {
        if (dryRun) {
          deps.out(`  would translate ${entryId} → ${locale}`);
          continue;
        }
        const r = await t.autoEntry(lib.orgId, lib.libraryId, entryId, locale, { force });
        results.push(r);
        for (const x of r.results) deps.out(`  ${x.ok ? 'ok  ' : 'FAIL'}  ${x.entryId} → ${locale}${x.error ? `  ${x.error}` : ''}`);
      }
    if (h.json) h.dump(results);
    return 0;
  }
  const s = await resolveSpace(deps.client, want);
  // Say so before the first piece, not after a run of identical 409s.
  if (!dryRun && !(await t.deepl.status(s.orgId)).configured) {
    deps.err(NO_PROVIDER);
    return 1;
  }
  const states = h.statesOf(argv, '--state', ['missing', 'outdated'])!;
  const only = h.listOf(argv, '--only');
  const cov = await t.status(s.orgId, s.spaceId);
  const work = cov.items
    .filter((i) => !only || only.some((o) => o === i.id || o === i.slug))
    .flatMap((i) => locales.filter((l) => i.locales[l] && states.includes(i.locales[l]!.state)).map((l) => ({ item: i, locale: l })));
  const done: { id: string; locale: string; ok: boolean; error?: string }[] = [];
  for (const { item, locale } of work) {
    if (dryRun) {
      deps.out(`  would translate ${item.slug ?? item.id} → ${locale} (${item.locales[locale]!.state})`);
      continue;
    }
    try {
      await t.auto(s.orgId, s.spaceId, item.id, locale, { force, published: argv.includes('--publish'), door: translationDoorOf(cov.spaceType) });
      done.push({ id: item.id, locale, ok: true });
      if (!h.json) deps.out(`  ok    ${item.slug ?? item.id} → ${locale}`);
    } catch (e) {
      const err = e as { status?: number; code?: string; message?: string };
      if (err.code === 'ai.unavailable') throw e;
      done.push({ id: item.id, locale, ok: false, error: err.message });
      if (!h.json) deps.out(`  FAIL  ${item.slug ?? item.id} → ${locale}  ${err.message ?? ''}`);
    }
  }
  if (h.json) h.dump({ planned: work.length, results: done });
  else deps.out(`${dryRun ? work.length + ' would be translated' : `${done.filter((d) => d.ok).length} translated, ${done.filter((d) => !d.ok).length} failed`}.`);
  return done.some((d) => !d.ok) ? 1 : 0;
}
