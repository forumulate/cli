/**
 * What changed in a piece's words, for `--diff`.
 *
 * "update post launch — content" says that something changed and not what,
 * and the customer publishers we were shown each grew a diff printer for the
 * same reason: a plan nobody can check is a plan somebody approves blind.
 *
 * Compared by PARAGRAPH, not by line: the file is hard-wrapped and the stored
 * page is one line per paragraph, so a line diff would report every wrapped
 * paragraph as rewritten (the same lesson `compare.ts` records). Each
 * paragraph is collapsed to one line first, then the two lists are diffed.
 */

/** Paragraphs, each on one line, front matter and the leading title dropped. */
function paragraphs(markdown: string): string[] {
  let s = markdown.replace(/\r\n?/g, '\n');
  s = s.replace(/^﻿?---\n[\s\S]*?\n---[ \t]*\n?/, '');
  const footer = s.search(/\n-{3,}\s*\n+#{1,3} For AI agents\b/);
  if (footer >= 0) s = s.slice(0, footer);
  s = s.replace(/^(?:\s*#\s+[^\n]*(?:\n|$))+/, '');
  return s
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Longest-common-subsequence table walk over two short lists. */
function lcsOps(a: string[], b: string[]): { op: ' ' | '-' | '+'; text: string }[] {
  const n = a.length;
  const m = b.length;
  // A pathological pair (thousands of paragraphs each) is reported whole.
  if (n * m > 400_000)
    return [...a.map((t) => ({ op: '-' as const, text: t })), ...b.map((t) => ({ op: '+' as const, text: t }))];
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { op: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: '-', text: a[i++]! });
    else out.push({ op: '+', text: b[j++]! });
  }
  while (i < n) out.push({ op: '-', text: a[i++]! });
  while (j < m) out.push({ op: '+', text: b[j++]! });
  return out;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * `-` what is live, `+` what the file says, with one paragraph of context
 * around each change; at most `max` lines, then a count of the rest. Empty
 * when the paragraphs are the same.
 */
export function textDiff(live: string, file: string, max = 30): string[] {
  const ops = lcsOps(paragraphs(live), paragraphs(file));
  if (!ops.some((o) => o.op !== ' ')) return [];
  const show = new Set<number>();
  ops.forEach((o, k) => {
    if (o.op === ' ') return;
    for (let d = -1; d <= 1; d++) if (k + d >= 0 && k + d < ops.length) show.add(k + d);
  });
  const lines: string[] = [];
  let last = -1;
  for (const k of [...show].sort((x, y) => x - y)) {
    if (last >= 0 && k > last + 1) lines.push('  …');
    lines.push(`${ops[k]!.op} ${clip(ops[k]!.text)}`);
    last = k;
  }
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `  … ${lines.length - max} more line(s)`];
}

/** One line per changed field, for a front-matter or settings change. */
export function fieldDiff(
  live: Record<string, unknown> | undefined,
  want: Record<string, unknown>,
  keys: string[],
): string[] {
  const show = (v: unknown) => clip(v === undefined ? '(unset)' : JSON.stringify(v), 100);
  return keys.map((k) => `~ ${k}: ${show(live?.[k])} → ${show(want[k])}`);
}
