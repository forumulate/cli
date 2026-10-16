/**
 * The report of an import as lines a person reads: what the model needed,
 * what landed, and above all what did NOT, since an import that says only
 * "done" hides exactly the part the author has to act on.
 */
import { issueLines } from '../content/render';
import type { ImportReport } from './types';

export function reportLines(r: ImportReport): string[] {
  const out: string[] = [];
  const verb = r.dryRun ? 'would be' : 'were';
  out.push(
    r.model.changed
      ? `Model: ${r.dryRun ? 'would change' : 'changed'} (version ${r.model.version ?? '?'}).`
      : 'Model: unchanged.',
  );
  out.push(...issueLines(r.model.issues as never));
  if (r.dryRun) {
    out.push(`${r.entries.planned} entr${r.entries.planned === 1 ? 'y' : 'ies'} and ${r.media.planned} file${r.media.planned === 1 ? '' : 's'} ${verb} imported from ${r.source}.`);
    if (r.plan) out.push(`  ${r.plan.new} new, ${r.plan.update} already imported before (they would be updated in place).`);
    if (r.entries.translations) out.push(`  ${r.entries.translations} translation${r.entries.translations === 1 ? '' : 's'} (locale twins) would be written.`);
  } else {
    out.push(`Media: ${r.media.uploaded} uploaded of ${r.media.planned} (files already in the library are reused).`);
    out.push(`Entries: ${r.entries.created} created, ${r.entries.updated} updated of ${r.entries.planned}, ${r.entries.published} published.`);
    if (r.entries.translations) out.push(`Translations: ${r.entries.translations} locale twin${r.entries.translations === 1 ? '' : 's'} written.`);
  }
  if (r.dropped.length) {
    out.push(`Values with no matching field in the model (${r.dropped.length}):`);
    for (const d of r.dropped) out.push(`  ${d.field}  ×${d.count}`);
  }
  if (r.unresolved.length) {
    out.push(`References to records that are not in the export (${r.unresolved.length}):`);
    for (const u of r.unresolved) out.push(`  ${u.from} → ${u.to}`);
  }
  for (const f of r.media.failed) out.push(`Media failed: ${f.id}: ${f.message}`);
  for (const f of r.entries.failed) out.push(`Entry failed: ${f.type} ${f.id}: ${f.message}`);
  for (const n of r.notes) out.push(`Note: ${n}`);
  return out;
}

/** Non-zero when anything failed, so a script can tell a clean import from a partial one. */
export const exitCode = (r: ImportReport): number => (r.entries.failed.length || r.media.failed.length ? 1 : 0);
