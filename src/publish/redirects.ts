import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spacePath, type SpaceCtx } from './context';
import type { ManifestRedirect } from './types';

/**
 * `redirects:` in forumulate.yaml, applied by `publish` (FMU-F09).
 *
 * A docs repository moves pages, and the redirects that keep the old addresses
 * working belong in the same pull request as the move — not in a console
 * someone has to remember to visit after the merge. So a space in the manifest
 * may list them:
 *
 *     redirects:
 *       - { from: /getting-started, to: /quickstart }
 *       - { from: /v1/*, to: /*, status: 301 }
 *
 * or name a CSV file in the redirect manager's columns
 * (`redirects: redirects.csv`, `from,to,status,type,passQuery`).
 *
 * Merged, never replaced: a rule the file does not name is left alone (the
 * console's rules, the platform's rename rules), so declaring three redirects
 * cannot delete three hundred. The write is the redirect manager's own import
 * (`POST …/redirects/import`, mode `merge`), which validates every rule,
 * refuses loops and duplicates, and keeps the platform's rules — one door,
 * whichever way a rule arrives.
 */

/** A minimal CSV split — quoted fields and doubled quotes — for a manifest's CSV file. */
function records(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) out.push([...row, cell]);
  return out.filter((r) => r.some((c) => c.trim()));
}

/** The rules a CSV file declares, by column name when it has a header. */
export function rulesFromCsv(text: string): ManifestRedirect[] {
  const rows = records(text);
  let cols: Record<string, number> = { from: 0, to: 1, status: 2, type: 3, passquery: 4 };
  if (rows[0]?.some((c) => c.trim().toLowerCase() === 'from')) {
    cols = {};
    rows[0].forEach((c, i) => (cols[c.trim().toLowerCase()] = i));
    rows.shift();
  }
  const get = (r: string[], k: string) => (cols[k] === undefined ? '' : (r[cols[k]!] ?? '').trim());
  return rows
    .filter((r) => !r[0]!.trim().startsWith('#'))
    .map((r) => {
      const rule: ManifestRedirect = { from: get(r, 'from'), to: get(r, 'to') };
      const status = Number(get(r, 'status'));
      if ([301, 302, 307, 308].includes(status)) rule.status = status as ManifestRedirect['status'];
      const type = get(r, 'type');
      if (type === 'redirect' || type === 'rewrite') rule.type = type;
      const pass = get(r, 'passquery').toLowerCase();
      if (pass) rule.passQuery = ['true', '1', 'yes'].includes(pass);
      return rule;
    });
}

/** The rules as CSV in the import's columns — what the API is sent. */
export function rulesToCsv(rules: ManifestRedirect[]): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [
    'from,to,status,type,passQuery',
    ...rules.map((r) => [r.from, r.to, r.status ?? '', r.type ?? '', r.passQuery ?? ''].map(q).join(',')),
  ].join('\n');
}

/** What the manifest declares for this space, read from the list or the file. */
export function declaredRedirects(
  spec: { redirects?: ManifestRedirect[] | string },
  manifestFile: string | null,
  root: string,
): ManifestRedirect[] {
  if (!spec.redirects) return [];
  if (Array.isArray(spec.redirects)) return spec.redirects;
  const file = resolve(manifestFile ? dirname(manifestFile) : root, spec.redirects);
  if (!existsSync(file)) throw new Error(`redirects: no file at ${file}`);
  return rulesFromCsv(readFileSync(file, 'utf8'));
}

/** The match key a stored rule and a declared one share (path + query condition). */
const keyOf = (r: { from: string; match?: { query?: unknown } }) =>
  `${r.from}${r.match?.query && r.match.query !== 'ignore' ? `?${JSON.stringify(r.match.query)}` : ''}`;

/** Plan or apply this space's declared redirects. */
export async function syncRedirects(
  ctx: SpaceCtx,
  apply: boolean,
  manifestFile: string | null,
): Promise<void> {
  const declared = declaredRedirects(ctx.spec, manifestFile, ctx.root);
  if (!declared.length) return;
  const live = await ctx.api
    .get<{ redirects: (ManifestRedirect & { auto?: boolean; match?: { query?: unknown } })[] }>(
      spacePath(ctx, '/redirects'),
    )
    .then((r) => r.redirects ?? [])
    .catch(() => []);
  const byKey = new Map(live.map((r) => [keyOf(r), r] as const));
  const changes = declared.filter((d) => {
    const had = byKey.get(keyOf(d));
    return (
      !had ||
      had.auto === true ||
      had.to !== d.to ||
      (had.status ?? 308) !== (d.status ?? 308) ||
      (had.type ?? 'redirect') !== (d.type ?? 'redirect')
    );
  });
  if (!changes.length) {
    ctx.line({ verb: 'same', what: 'redirects', detail: `${declared.length} declared, all in place` });
    return;
  }
  for (const r of changes)
    ctx.line({
      verb: byKey.has(keyOf(r)) ? 'update' : 'create',
      what: `redirect ${r.from}`,
      detail: `→ ${r.to}${r.status ? ` (${r.status})` : ''}`,
    });
  if (!apply) return;
  await ctx.api.post(spacePath(ctx, '/redirects/import'), {
    csv: rulesToCsv(changes),
    mode: 'merge',
  });
}
