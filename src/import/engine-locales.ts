/**
 * The locale half of an import: make sure the library has the source's
 * languages, then write each record's other-locale values as the entry's
 * locale twins.
 *
 * Kept apart from the engine because it is a separate mechanism with its own
 * failure rule: a language the library refuses, or a twin the API rejects, is
 * reported against that language / record and the rest of the import goes on.
 */
import type { ForumulateClient } from '@forumulate/sdk';
import type { ResolvedFields } from './model-fields';
import type { FieldDecl, ImportReport, ImportSource, RawRecord } from './types';

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Adds the source's non-default languages the library lacks; returns the codes
 * the library has afterwards (the only ones twins can be written in).
 */
export async function ensureLanguages(
  client: ForumulateClient,
  orgId: string,
  libraryId: string,
  source: ImportSource,
  report: ImportReport,
): Promise<Set<string>> {
  const have = await client.content.locales.list(orgId, libraryId);
  const codes = new Set(have.locales.map((l) => l.code));
  const sourceDefault = source.languages?.find((l) => l.default)?.code;
  if (sourceDefault && sourceDefault !== have.sourceLocale) {
    report.notes.push(
      `The export's default language is ${sourceDefault} but the library's source language is ${have.sourceLocale}; ` +
        `the default-language values were written as ${have.sourceLocale}.`,
    );
  }
  const wanted = new Set(Object.keys(Object.assign({}, ...source.records.map((r) => r.locales ?? {}))));
  for (const code of wanted) {
    if (codes.has(code)) continue;
    const label = source.languages?.find((l) => l.code === code)?.label ?? code;
    try {
      const added = await client.content.locales.add(orgId, libraryId, { code, label });
      for (const l of added.locales) codes.add(l.code);
    } catch (e) {
      report.notes.push(`Language ${code} could not be added to the library (${errMessage(e)}); its translations were skipped.`);
    }
  }
  return codes;
}

export interface TwinJob {
  client: ForumulateClient;
  orgId: string;
  libraryId: string;
  records: RawRecord[];
  ready: ReadonlySet<string>;
  /** Source entry ids by the engine's record key. */
  ids: ReadonlyMap<string, string>;
  /** Filled: record key → the twin entry ids written (they are published with the source). */
  twinIds: Map<string, string[]>;
  report: ImportReport;
  pace: () => Promise<void>;
  typeOf: (type: string) => ResolvedFields | null;
  coerce: (decls: FieldDecl[], values: Record<string, unknown>, r: RawRecord) => Record<string, unknown>;
  keyOf: (r: RawRecord) => string;
}

export async function writeTwins(j: TwinJob): Promise<void> {
  for (const r of j.records) {
    const id = j.ids.get(j.keyOf(r));
    const type = j.typeOf(r.type);
    if (!id || !type || !r.locales) continue;
    // The API refuses a non-localized field on a twin (the source entry owns it), so only localized ones go.
    const decls = type.fields.filter((f) => f.localized);
    for (const [code, values] of Object.entries(r.locales)) {
      if (!j.ready.has(code)) continue;
      try {
        const own = Object.fromEntries(Object.entries(values).filter(([k]) => decls.some((d) => d.key === k)));
        const fields = j.coerce(decls, own, r);
        if (!Object.keys(fields).length) continue;
        const res = await j.client.content.entries.writeLocale(j.orgId, j.libraryId, id, code, fields);
        j.report.entries.translations++;
        (j.twinIds.get(j.keyOf(r)) ?? j.twinIds.set(j.keyOf(r), []).get(j.keyOf(r))!).push(res.entryId);
        await j.pace();
      } catch (e) {
        j.report.entries.failed.push({ id: r.id, type: r.type, message: `translation ${code}: ${errMessage(e)}` });
      }
    }
  }
}
