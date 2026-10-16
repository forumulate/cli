/**
 * A model push's diff and issues, as lines a person reads before saying yes.
 *
 * `+` adds, `-` removes, `~` changes, one line per change, addressed the way
 * the model is (`post.author`, `block hero.heading`, `post setting
 * titleField`), so the line is what the author would search the file for.
 * Pure: the command prints what this returns.
 */
import type { ContentModelImportResult, ModelChangeLine, ModelFileIssue, ModelOp } from '@forumulate/sdk';

const show = (v: unknown): string => {
  if (v === undefined) return '(none)';
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

const MARK = { add: '+', remove: '-', change: '~' } as const;

function where(c: ModelChangeLine): string {
  const block = c.blockType ? `block ${c.blockType}` : '';
  const scope = [c.type, block].filter(Boolean).join(' ');
  return c.path ? (scope ? `${scope}.${c.path}` : c.path) : scope;
}

export function diffLines(diff: readonly ModelChangeLine[]): string[] {
  return diff.map((c) => {
    const mark = MARK[c.op];
    switch (c.target) {
      case 'type':
        if (c.op === 'change') return `${mark} type ${c.type}  ${c.property}: ${show(c.before)} → ${show(c.after)}`;
        return `${mark} type ${c.type}  ${show(c.op === 'add' ? c.after : c.before)}`;
      case 'setting':
        return `${mark} ${c.type}  setting ${c.property}: ${show(c.before)} → ${show(c.after)}`;
      case 'blockType':
        if (c.op === 'change') return `${mark} ${where(c)}  ${c.property}: ${show(c.before)} → ${show(c.after)}`;
        return `${mark} ${where(c)}  ${show(c.op === 'add' ? c.after : c.before)}`;
      default: {
        if (c.op === 'add') return `${mark} ${where(c)}  (${String(c.after)})`;
        if (c.op === 'remove') return `${mark} ${where(c)}  (${String(c.before)})`;
        if (c.property === 'order') {
          const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : show(v));
          return `${mark} ${where(c) || c.type || ''}  order: ${list(c.before)} → ${list(c.after)}`;
        }
        return `${mark} ${where(c)}  ${c.property}: ${show(c.before)} → ${show(c.after)}`;
      }
    }
  });
}

export function opLine(op: ModelOp): string {
  const scope = 'blockType' in op && op.blockType ? `block ${op.blockType}.` : 'type' in op && op.type ? `${op.type}.` : '';
  switch (op.op) {
    case 'renameField':
      return `rename ${scope}${op.from} → ${op.to}`;
    case 'removeField':
      return `remove ${scope}${op.path}  (values hidden, restorable for 30 days)`;
    case 'restoreField':
      return `restore ${scope}${op.path}`;
    case 'renameType':
      return `rename type ${op.from} → ${op.to}`;
    case 'renameBlockType':
      return `rename block ${op.from} → ${op.to}`;
  }
}

export function issueLines(issues: readonly ModelFileIssue[]): string[] {
  if (!issues.length) return [];
  const width = Math.max(...issues.map((i) => i.kind.length));
  return [
    `Not carried over as written (${issues.length}):`,
    ...issues.map((i) => `  ${i.kind.padEnd(width)}  ${i.path || '(config)'}  ${i.message}`),
  ];
}

/** The whole report of a push (dry or not). */
export function pushReport(r: ContentModelImportResult): string[] {
  const out: string[] = [];
  if (!r.changed) out.push('No changes: the file matches the library model.');
  else if (r.storageOnly) out.push('No content type changes; the stored model is rearranged (a field moved between the library shape and a type).');
  else out.push(`${r.diff.length} change${r.diff.length === 1 ? '' : 's'}:`, ...diffLines(r.diff).map((l) => `  ${l}`));
  if (r.changed && r.ops.length) out.push('Operations:', ...r.ops.map((o) => `  ${opLine(o)}`));
  out.push(...issueLines(r.issues));
  return out;
}
