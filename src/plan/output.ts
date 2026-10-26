/**
 * What `forumulate plan` and `apply` print (DX-D): the API's manifest answer
 * (`ManifestResultV2`), as lines a person reads in a pull request's CI log.
 *
 * A plan lists only what would MOVE — `+` create, `~` update, `-` delete —
 * with the fields each update touches; `unchanged` steps are counted, not
 * listed (`--verbose` lists them), because a forty-page site re-planned after
 * a one-word fix should print one line, not forty. Drift (a page edited
 * outside the manifest) is an update like any other, and its `content` field
 * says so in words.
 */

export interface ManifestStep {
  unit: string;
  ref: string;
  action: 'create' | 'update' | 'unchanged' | 'delete' | 'unsupported';
  diff?: Record<string, { from: unknown; to: unknown }>;
  id?: string | null;
  status?: 'planned' | 'applied' | 'unchanged' | 'failed' | 'skipped';
  readBack?: 'ok' | 'mismatch' | null;
  error?: string;
  shownOnce?: Record<string, string | null>;
}

export interface ManifestAnswer {
  dryRun: boolean;
  ok: boolean;
  steps: ManifestStep[];
  manual?: { kind: string; name?: string; type?: string; value?: string; host?: string; path?: string; origin?: string; for: string }[];
  extras?: { kind: string; space?: string; key: string }[];
  units?: { error?: string; status: string; kind: string; key: string }[];
}

const MARK: Record<ManifestStep['action'], string> = {
  create: '+',
  update: '~',
  delete: '-',
  unchanged: '=',
  unsupported: '?',
};

/** A value short enough for one line of a log. */
function brief(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function stepLine(s: ManifestStep): string {
  const fields = Object.keys(s.diff ?? {});
  return `${MARK[s.action]} ${s.action.padEnd(9)} ${s.unit.padEnd(12)} ${s.ref}${fields.length ? `  (${fields.join(', ')})` : ''}`;
}

export function formatPlan(answer: ManifestAnswer, opts: { diff: boolean; verbose: boolean }): string[] {
  const out: string[] = [];
  for (const s of answer.steps) {
    if (s.action === 'unchanged' && !opts.verbose) continue;
    out.push(stepLine(s));
    if (opts.diff)
      for (const [k, d] of Object.entries(s.diff ?? {})) out.push(`      ${k}: ${brief(d.from)} -> ${brief(d.to)}`);
  }
  out.push(...manualLines(answer));
  const extras = answer.extras ?? [];
  if (extras.length) {
    out.push(`${extras.length} thing(s) here are not in the document and are left alone${opts.verbose ? ':' : ' (--verbose lists them)'}`);
    if (opts.verbose) for (const e of extras) out.push(`    ${e.kind} ${e.space ? `${e.space}/` : ''}${e.key}`);
  }
  const count = (a: ManifestStep['action']) => answer.steps.filter((s) => s.action === a).length;
  const moving = count('create') + count('update') + count('delete');
  out.push(
    moving
      ? `Plan: ${count('create')} to create, ${count('update')} to update, ${count('delete')} to delete, ${count('unchanged')} unchanged.`
      : `No changes. ${count('unchanged')} unchanged.`,
  );
  return out;
}

export function formatApply(answers: ManifestAnswer[], opts: { verbose: boolean }): string[] {
  const out: string[] = [];
  // A step re-sent in a later batch answers `unchanged` there; its first,
  // real outcome is the one to print.
  const seen = new Map<string, ManifestStep>();
  for (const a of answers)
    for (const s of a.steps) {
      const key = `${s.unit}\u0000${s.ref}`;
      if (!seen.has(key) || s.status !== 'unchanged') seen.set(key, s);
    }
  let applied = 0;
  let failed = 0;
  let mismatched = 0;
  for (const s of seen.values()) {
    if (s.status === 'unchanged' && !opts.verbose) continue;
    if (s.status === 'applied') applied++;
    if (s.status === 'failed') failed++;
    if (s.readBack === 'mismatch') mismatched++;
    const rb = s.readBack === 'mismatch' ? '  READ BACK DIFFERS' : s.readBack === 'ok' ? '  (read back ok)' : '';
    out.push(`${(s.status ?? '').padEnd(9)} ${stepLine(s).slice(2)}${rb}${s.error ? `  ${s.error}` : ''}`);
    for (const [field, value] of Object.entries(s.shownOnce ?? {}))
      if (value) out.push(`      ${field} (shown once): ${value}`);
  }
  out.push(...manualLines(answers[answers.length - 1] ?? { dryRun: false, ok: true, steps: [] }));
  out.push(
    `Applied ${applied}${failed ? `, ${failed} failed` : ''}${mismatched ? `, ${mismatched} did not read back as written` : ''}` +
      (answers.length > 1 ? ` (${answers.length} requests).` : '.'),
  );
  return out;
}

function manualLines(answer: ManifestAnswer): string[] {
  const manual = answer.manual ?? [];
  if (!manual.length) return [];
  return [
    'By hand (nothing we can call sets these):',
    ...manual.map((m) =>
      m.kind === 'dns'
        ? `    DNS ${m.type} ${m.name} = ${m.value}  (for ${m.for})`
        : `    proxy ${m.host}${m.path} -> ${m.origin}  (for ${m.for})`,
    ),
  ];
}
