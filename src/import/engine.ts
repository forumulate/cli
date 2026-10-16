/**
 * Lands an `ImportSource` in a content library through the public management
 * API, in the order that makes each step safe to repeat:
 *
 *   1. the model (the source's schema, as a Payload-format config the API's
 *      own reader maps), refusing to remove types the library already has;
 *   2. the media, each file once;
 *   3. every entry as a draft, with a deterministic `Idempotency-Key` so a
 *      re-run returns the entries the first run made instead of duplicating;
 *   4. the references, written once every entry has an id (a reference may
 *      point forward, or in a circle);
 *   5. publishing, last, so a strict type that refuses an entry fails that
 *      entry alone and the draft stays.
 *
 * Re-running an import UPDATES what an earlier run made: the key in step 3 is
 * derived from the source's own record id and the server remembers key → entry
 * (`POST …/items/lookup`), so a record seen before is patched in place instead
 * of being skipped as a replay. A source with several languages lands its
 * other locales as the entry's locale twins, after the entries exist.
 *
 * A failure is recorded against the record that caused it and the import
 * goes on; the report is how the author finds out, never a half-written
 * silence.
 */
import { createHash } from 'node:crypto';
import type { ForumulateClient } from '@forumulate/sdk';
import { coerceFields, type CoerceCtx } from './coerce';
import { slugify as sharedSlugify } from '../publish/scan';
import { ensureLanguages, writeTwins } from './engine-locales';
import { uploadMedia, type MediaDeps, type UploadedFile } from './media';
import { resolveType, type ResolvedFields } from './model-fields';
import type { ImportFiles, ImportReport, ImportSource, RawRecord, RefTarget } from './types';

export interface EngineDeps {
  client: ForumulateClient;
  upload?: (path: string, form: FormData) => Promise<unknown>;
  files: ImportFiles;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** Folder the export lives in; relative media locations are under it. */
  root: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface EngineOptions {
  orgId: string;
  libraryId: string;
  dryRun: boolean;
  /** `source`: publish what the source had published. `all`, or `none` (everything stays a draft). */
  publish: 'source' | 'all' | 'none';
  /** Apply a model that removes content types the library has. */
  allowModelRemovals: boolean;
  /** Milliseconds between writes. */
  pace: number;
}

const key = (type: string, id: string) => `${type}\u0000${id}`;
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function slugOf(s: string | undefined): string | undefined {
  // The CLI's mirror of the product rule (publish/scan.ts), at this door's old cap of 100.
  return sharedSlugify(s ?? '', '', 100) || undefined;
}

/** `Idempotency-Key` for one record: the same export record is the same entry on every run. */
export function entryKey(source: string, library: string, r: Pick<RawRecord, 'type' | 'id'>): string {
  return `imp-${createHash('sha256').update([source, library, r.type, r.id].join('\u0000')).digest('hex').slice(0, 40)}`;
}

export function titleOf(r: RawRecord, fields: ResolvedFields | null): string {
  const pick = (k?: string) => (k && typeof r.values[k] === 'string' && (r.values[k] as string).trim() ? (r.values[k] as string).trim() : undefined);
  return (r.title?.trim() || pick(fields?.titleField) || pick('title') || pick('name') || r.slug || r.id).slice(0, 300);
}

export async function runImport(source: ImportSource, deps: EngineDeps, opts: EngineOptions): Promise<ImportReport> {
  const { client } = deps;
  const { orgId, libraryId } = opts;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pace = () => (opts.pace > 0 ? sleep(opts.pace) : Promise.resolve());
  const report: ImportReport = {
    source: source.name,
    dryRun: opts.dryRun,
    model: { changed: false, version: null, issues: [] },
    entries: { planned: source.records.length, created: 0, updated: 0, translations: 0, published: 0, failed: [] },
    media: { planned: source.media.length, uploaded: 0, failed: [] },
    dropped: [],
    unresolved: [],
    notes: [...source.notes],
  };

  /* 0. which records an earlier run already made (a dry run shows them as updates) */
  const existing = new Map<string, string>();
  try {
    const keys = source.records.map((r) => entryKey(source.name, libraryId, r));
    for (let i = 0; i < keys.length; i += 200) {
      const { found } = await client.content.entries.lookup(orgId, libraryId, keys.slice(i, i + 200));
      for (const [k, id] of Object.entries(found)) existing.set(k, id);
    }
  } catch (e) {
    report.notes.push(`Could not check for entries an earlier import made (${errMessage(e)}); every record is treated as new.`);
  }
  const known = (r: RawRecord) => existing.get(entryKey(source.name, libraryId, r));
  const nUpdate = source.records.filter((r) => known(r)).length;
  report.plan = { new: source.records.length - nUpdate, update: nUpdate };
  if (opts.dryRun) report.entries.translations = source.records.reduce((n, r) => n + Object.keys(r.locales ?? {}).length, 0);

  /* 1. model */
  if (source.modelSource) {
    const body = { format: 'payload' as const, content: source.modelSource };
    const dry = await client.content.model.import(orgId, libraryId, { ...body, dryRun: true });
    report.model = { changed: dry.changed, version: dry.version, issues: dry.issues };
    const removals = dry.diff.filter((c) => c.op === 'remove' && c.target === 'type');
    if (removals.length && !opts.allowModelRemovals) {
      throw new Error(
        `The model would remove content types the library has (${removals.map((c) => c.type).join(', ')}). ` +
          'Nothing was imported. Pass --allow-model-removals if that is meant, or import into an empty library.',
      );
    }
    if (opts.dryRun) return report;
    if (dry.changed) {
      const applied = await client.content.model.import(orgId, libraryId, body);
      report.model.version = applied.version;
    }
  } else if (opts.dryRun) return report;

  /* 2. media */
  const mediaDeps: MediaDeps = { client, upload: deps.upload, files: deps.files, fetchBytes: deps.fetchBytes, root: deps.root };
  const uploaded = new Map<string, UploadedFile>();
  const byAlias = new Map<string, UploadedFile>();
  for (const m of source.media) {
    try {
      const up = await uploadMedia(mediaDeps, orgId, libraryId, m);
      uploaded.set(m.id, up);
      for (const a of [m.id, m.location, m.filename, ...(m.aliases ?? [])]) byAlias.set(a, up);
      if (!up.reused) {
        report.media.uploaded++;
        await pace();
      }
    } catch (e) {
      report.media.failed.push({ id: m.id, message: errMessage(e) });
    }
  }

  /* 3. model as stored, to know what each declared field is */
  const stored = await client.content.model.get(orgId, libraryId);
  const resolved = new Map<string, ResolvedFields | null>();
  const typeOf = (t: string) => {
    if (!resolved.has(t)) resolved.set(t, resolveType(stored.model, t));
    return resolved.get(t) ?? null;
  };

  const exists = new Set(source.records.map((r) => key(r.type, r.id)));
  const typesById = new Map<string, Set<string>>();
  for (const r of source.records) (typesById.get(r.id) ?? typesById.set(r.id, new Set()).get(r.id)!).add(r.type);
  const created = new Map<string, string>();
  const dropped = new Map<string, number>();
  const unresolved = new Map<string, string>();
  let finalPass = false;
  let from = '';

  const lookup = (t: RefTarget): string | null => {
    let type = t.type;
    if (!type) {
      const types = typesById.get(t.id);
      if (types?.size === 1) type = [...types][0];
    }
    if (type && created.has(key(type, t.id))) return created.get(key(type, t.id))!;
    if (finalPass && !(type && exists.has(key(type, t.id)))) unresolved.set(`${from}\u0000${t.type ?? '?'}:${t.id}`, `${t.type ?? '?'}:${t.id}`);
    return null;
  };
  const image = (src: string): string => byAlias.get(src)?.url ?? src;

  const ctxFor = (fields: ResolvedFields, pending: { value: boolean }, sink = dropped): CoerceCtx => ({
    source,
    image,
    asset: (id) => {
      const up = uploaded.get(id) ?? byAlias.get(id);
      return up ? { id: up.id, filename: up.filename } : null;
    },
    entry: lookup,
    blocks: fields.blocks,
    dropped: sink,
    pendingRef: pending,
  });

  /* 4. entries (drafts) */
  const needsRefs: RawRecord[] = [];
  const skippedTypes = new Map<string, number>();
  for (const r of source.records) {
    const fields = typeOf(r.type);
    if (!fields) {
      // Not a failure of the record: its type was not mapped (an auth collection, a type the
      // model refused), and the model issues above already say why. Counted so it is not silent.
      skippedTypes.set(r.type, (skippedTypes.get(r.type) ?? 0) + 1);
      continue;
    }
    try {
      from = `${r.type}:${r.id}`;
      const pending = { value: false };
      const params = coerceFields(fields.fields, r.values, ctxFor(fields, pending), r.type);
      const slug = slugOf(r.slug);
      const before = known(r);
      const res = before
        ? await client.content.entries.update(orgId, libraryId, before, { title: titleOf(r, fields), ...(slug ? { slug } : {}), params })
        : await client.content.entries.create(
            orgId,
            libraryId,
            { title: titleOf(r, fields), ...(slug ? { slug } : {}), preset: r.type, params },
            entryKey(source.name, libraryId, r),
          );
      created.set(key(r.type, r.id), res.item.id);
      if (before) report.entries.updated++;
      else report.entries.created++;
      if (pending.value) needsRefs.push(r);
      await pace();
    } catch (e) {
      report.entries.failed.push({ id: r.id, type: r.type, message: errMessage(e) });
    }
  }

  /* 5. references, now that every entry has an id */
  finalPass = true;
  for (const r of needsRefs) {
    const id = created.get(key(r.type, r.id))!;
    const fields = typeOf(r.type)!;
    try {
      from = `${r.type}:${r.id}`;
      const params = coerceFields(fields.fields, r.values, ctxFor(fields, { value: false }, new Map()), r.type);
      await client.content.entries.setFields(orgId, libraryId, id, params);
      await pace();
    } catch (e) {
      report.entries.failed.push({ id: r.id, type: r.type, message: `references: ${errMessage(e)}` });
    }
  }

  /* 6. locale twins, once every source entry has an id */
  const twinIds = new Map<string, string[]>();
  if (source.records.some((r) => r.locales)) {
    const ready = await ensureLanguages(client, orgId, libraryId, source, report);
    await writeTwins({
      client, orgId, libraryId, records: source.records, ready, ids: created, twinIds, report, pace,
      typeOf, coerce: (decls, values, r) => coerceFields(decls, values, ctxFor(typeOf(r.type)!, { value: false }, new Map()), r.type),
      keyOf: (r) => key(r.type, r.id),
    });
  }

  /* 7. publish */
  if (opts.publish !== 'none') {
    for (const r of source.records) {
      const id = created.get(key(r.type, r.id));
      if (!id || (opts.publish === 'source' && !r.published)) continue;
      for (const target of [id, ...(twinIds.get(key(r.type, r.id)) ?? [])]) {
        try {
          const res = await client.content.entries.publish(orgId, libraryId, target);
          if (res.published !== false && target === id) report.entries.published++;
          await pace();
        } catch (e) {
          report.entries.failed.push({ id: r.id, type: r.type, message: `publish${target === id ? '' : ' (translation)'}: ${errMessage(e)}` });
        }
      }
    }
  }

  for (const [t, n] of skippedTypes) report.notes.push(`${n} record(s) of "${t}" were skipped: the library has no content type of that name (see the model notes above).`);
  report.dropped = [...dropped].map(([field, count]) => ({ field, count })).sort((a, b) => a.field.localeCompare(b.field));
  report.unresolved = [...unresolved].map(([k, to]) => ({ from: k.split('\u0000')[0]!, to }));
  return report;
}
