/**
 * `translations pull | push`, `labels pull | push`, `overrides pull | push`:
 * the file round trips a TMS (or a person with an editor) sits in the middle of.
 *
 * Every push is a diff first: each file is compared with what the API holds
 * now, and only what differs is written — so a second push of the same files
 * writes nothing (idempotent), and `--dry-run` prints exactly what a real push
 * would send.
 */
import { translationDoorOf, type ForumulateClient, type LabelScope, type TranslationCoverage, type TranslationDoor } from '@forumulate/sdk';
import { fileStem, readTranslationFile, stubHash, writeTranslationFile, type TranslationFile } from './files';
import { fromXliff, toXliff, type XliffFile } from './xliff';

export interface SyncFiles {
  read(path: string): string;
  write(path: string, text: string): void;
  exists(path: string): boolean;
  /** Every file under a folder, recursively, as paths joinable with it. */
  list(dir: string): string[];
}

export interface SyncDeps {
  client: ForumulateClient;
  out: (line: string) => void;
  err: (line: string) => void;
  files: SyncFiles;
}

const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;

/** Write one file per piece per language under `<out>/<locale>/`. */
export async function pullPieces(
  deps: SyncDeps,
  at: { orgId: string; spaceId: string },
  coverage: TranslationCoverage,
  opts: { out: string; locales: string[]; only?: string[]; includeMissing: boolean },
): Promise<{ written: string[]; skipped: number }> {
  const t = deps.client.translations;
  const knownDoor = translationDoorOf(coverage.spaceType);
  const written: string[] = [];
  let skipped = 0;
  const used = new Set<string>();
  for (const item of coverage.items) {
    if (opts.only && !opts.only.some((o) => o === item.id || o === item.slug)) continue;
    let stem = fileStem(item.slug, item.id);
    if (used.has(stem)) stem = `${stem}-${item.id.slice(0, 8)}`;
    used.add(stem);
    for (const locale of opts.locales) {
      const cell = item.locales[locale];
      if (!cell) continue;
      const path = join(join(opts.out, locale), `${stem}.md`);
      let file: TranslationFile;
      if (cell.state === 'missing' || (knownDoor === 'page' && !cell.id)) {
        if (!opts.includeMissing) {
          skipped += 1;
          continue;
        }
        // A stub carrying the original, for a translator to replace.
        const { item: src } = await deps.client.request<{ item: { title: string; markdown: string } }>(
          'GET',
          `/orgs/${at.orgId}/spaces/${at.spaceId}/items/${item.id}`,
        );
        file = {
          space: at.spaceId,
          piece: item.id,
          locale,
          door: knownDoor,
          title: src.title,
          markdown: src.markdown ?? '',
          state: 'missing',
          source: stubHash(src.title, src.markdown ?? ''),
        };
      } else {
        const tr = await t.get(at.orgId, at.spaceId, item.id, locale, { door: knownDoor });
        file = {
          space: at.spaceId,
          piece: item.id,
          locale,
          door: tr.door,
          title: tr.title ?? item.title,
          markdown: tr.markdown ?? '',
          excerpt: tr.excerpt ?? undefined,
          updates: tr.updates,
          published: tr.state === 'draft' ? false : tr.door === 'incident' ? undefined : true,
          state: tr.state,
        };
      }
      deps.files.write(path, writeTranslationFile(file));
      written.push(path);
    }
  }
  return { written, skipped };
}

export interface PushPlan {
  path: string;
  piece: string;
  locale: string;
  action: 'write' | 'unchanged' | 'stub' | 'other-space';
  fields: string[];
}

/** Compare every pulled file under `dir` with the API, then (unless dry) write what differs. */
export async function pushPieces(
  deps: SyncDeps,
  at: { orgId: string; spaceId: string },
  opts: { dir: string; locales?: string[]; dryRun: boolean },
): Promise<PushPlan[]> {
  const t = deps.client.translations;
  const plans: PushPlan[] = [];
  for (const path of deps.files.list(opts.dir).filter((p) => p.endsWith('.md')).sort()) {
    const f = readTranslationFile(deps.files.read(path));
    if (!f) continue;
    if (opts.locales && !opts.locales.includes(f.locale)) continue;
    const plan: PushPlan = { path, piece: f.piece, locale: f.locale, action: 'unchanged', fields: [] };
    plans.push(plan);
    if (f.space && f.space !== at.spaceId) {
      plan.action = 'other-space';
      continue;
    }
    if (f.source && f.source === stubHash(f.title, f.markdown)) {
      plan.action = 'stub';
      continue;
    }
    const door = (f.door || undefined) as TranslationDoor | undefined;
    const now = await t.get(at.orgId, at.spaceId, f.piece, f.locale, { door });
    if ((now.title ?? '') !== f.title) plan.fields.push('title');
    if ((now.markdown ?? '').trim() !== f.markdown.trim()) plan.fields.push('markdown');
    if (f.excerpt !== undefined && (now.excerpt ?? '') !== f.excerpt) plan.fields.push('excerpt');
    if (f.updates && JSON.stringify(now.updates ?? {}) !== JSON.stringify({ ...(now.updates ?? {}), ...f.updates }))
      plan.fields.push('updates');
    if (f.published === true && now.state === 'draft') plan.fields.push('published');
    if (!plan.fields.length) continue;
    plan.action = 'write';
    if (opts.dryRun) continue;
    await t.put(
      at.orgId,
      at.spaceId,
      f.piece,
      f.locale,
      {
        // A topic's PUT replaces the translation (title required); a page's
        // title is its own PATCH, sent only when it changed.
        title: now.door === 'page' && !plan.fields.includes('title') ? undefined : f.title,
        markdown: plan.fields.includes('markdown') || now.door !== 'page' ? f.markdown : undefined,
        excerpt: f.excerpt,
        updates: f.updates,
        published: f.published,
      },
      { door: now.door },
    );
  }
  return plans;
}

export type TableFormat = 'json' | 'xliff';

export function tableFormat(value: string | undefined, file?: string): TableFormat {
  if (value === 'json' || value === 'xliff') return value;
  if (value !== undefined) throw new Error(`--format is json or xliff, not "${value}".`);
  return file && /\.(xlf|xliff)$/i.test(file) ? 'xliff' : 'json';
}

/** The chrome dictionary, as JSON (`{labels}`) or XLIFF over every owner string. */
export async function pullLabels(
  deps: SyncDeps,
  orgId: string,
  scope: LabelScope,
  opts: { format: TableFormat; locales?: string[] },
): Promise<string> {
  const listing = await deps.client.translations.labels.strings(orgId, scope);
  const locales = opts.locales ?? listing.languages;
  if (opts.format === 'json') {
    const labels = Object.fromEntries(Object.entries(listing.labels).filter(([l]) => locales.includes(l)));
    return `${JSON.stringify({ labels }, null, 2)}\n`;
  }
  const rows = listing.strings as { text: string; dictionary: Record<string, string> }[];
  const files: XliffFile[] = locales.map((locale) => ({
    locale,
    units: rows.map((r) => ({ id: r.text, source: r.text, target: typeof r.dictionary[locale] === 'string' ? r.dictionary[locale]! : '' })),
  }));
  return toXliff(files, { original: 'labels' });
}

/** The words that differ from the dictionary now, as a PATCH body; unchanged words are not sent. */
export async function pushLabels(
  deps: SyncDeps,
  orgId: string,
  scope: LabelScope,
  text: string,
  opts: { format: TableFormat; dryRun: boolean },
): Promise<{ changes: { locale: string; text: string; to: unknown }[] }> {
  const listing = await deps.client.translations.labels.strings(orgId, scope);
  const incoming: Record<string, Record<string, unknown>> =
    opts.format === 'json'
      ? ((JSON.parse(text) as { labels?: Record<string, Record<string, unknown>> }).labels ?? {})
      : Object.fromEntries(
          fromXliff(text).map((f) => [f.locale, Object.fromEntries(f.units.filter((u) => u.target.trim()).map((u) => [u.id, u.target]))]),
        );
  const changes: { locale: string; text: string; to: unknown }[] = [];
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [locale, words] of Object.entries(incoming)) {
    for (const [original, to] of Object.entries(words ?? {})) {
      const now = listing.labels[locale]?.[original];
      if (JSON.stringify(now) === JSON.stringify(to)) continue;
      changes.push({ locale, text: original, to });
      (patch[locale] ??= {})[original] = to;
    }
  }
  if (changes.length && !opts.dryRun) await deps.client.translations.labels.merge(orgId, scope, patch);
  return { changes };
}

export async function pullOverrides(
  deps: SyncDeps,
  orgId: string,
  opts: { format: TableFormat; locales?: string[] },
): Promise<string> {
  const { overrides } = await deps.client.translations.overrides.list(orgId);
  const byLocale: Record<string, Record<string, string>> = {};
  for (const o of overrides) if (!opts.locales || opts.locales.includes(o.locale)) (byLocale[o.locale] ??= {})[o.key] = o.value;
  if (opts.format === 'json') return `${JSON.stringify({ overrides: byLocale }, null, 2)}\n`;
  // The English each key replaces, so the TMS shows the translator the source.
  const { catalog } = await deps.client.translations.overrides.catalog(orgId).catch(() => ({ catalog: {} as Record<string, string> }));
  const locales = opts.locales ?? Object.keys(byLocale);
  return toXliff(
    locales.map((locale) => ({
      locale,
      units: Object.entries(byLocale[locale] ?? {}).map(([key, value]) => ({ id: key, source: catalog[key] ?? key, target: value })),
    })),
    { original: 'translation-overrides' },
  );
}

export async function pushOverrides(
  deps: SyncDeps,
  orgId: string,
  text: string,
  opts: { format: TableFormat; dryRun: boolean; prune: boolean },
): Promise<{ set: { locale: string; key: string }[]; removed: { locale: string; key: string }[] }> {
  const { overrides } = await deps.client.translations.overrides.list(orgId);
  const incoming: Record<string, Record<string, string>> =
    opts.format === 'json'
      ? ((JSON.parse(text) as { overrides?: Record<string, Record<string, string>> }).overrides ?? {})
      : Object.fromEntries(
          fromXliff(text).map((f) => [f.locale, Object.fromEntries(f.units.filter((u) => u.target.trim()).map((u) => [u.id, u.target]))]),
        );
  const set: { locale: string; key: string }[] = [];
  const removed: { locale: string; key: string }[] = [];
  for (const [locale, keys] of Object.entries(incoming))
    for (const [key, value] of Object.entries(keys ?? {})) {
      if (overrides.some((o) => o.locale === locale && o.key === key && o.value === value)) continue;
      set.push({ locale, key });
      if (!opts.dryRun) await deps.client.translations.overrides.set(orgId, { locale, key, value: String(value) });
    }
  if (opts.prune)
    for (const o of overrides) {
      if (incoming[o.locale]?.[o.key] !== undefined) continue;
      removed.push({ locale: o.locale, key: o.key });
      if (!opts.dryRun) await deps.client.translations.overrides.remove(orgId, { locale: o.locale, key: o.key });
    }
  return { set, removed };
}
