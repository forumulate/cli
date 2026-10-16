import { describe, expect, it } from 'vitest';
import { coerceFields, type CoerceCtx } from './coerce';
import type { FieldDecl, ImportSource } from './types';

const source = {
  richText: (raw: unknown) => (typeof raw === 'string' ? { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] } : null),
  mediaId: (raw: unknown) => (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null),
  refs: (raw: unknown) => (Array.isArray(raw) ? raw : [raw]).map((id) => ({ id: String(id) })),
} as unknown as ImportSource;

function ctx(): CoerceCtx {
  return {
    source,
    image: (s) => s,
    asset: (id) => (id === 'missing' ? null : { id: `A${id}`, filename: `${id}.png` }),
    entry: (t) => (t.id === 'known' ? 'E1' : null),
    blocks: new Map<string, FieldDecl[]>([['hero', [{ key: 'heading', type: 'text' }]]]),
    dropped: new Map(),
    pendingRef: { value: false },
  };
}
const run = (fields: FieldDecl[], raw: Record<string, unknown>, c = ctx()) => ({ out: coerceFields(fields, raw, c, 't'), c });

describe('coerceFields', () => {
  it('converts by declared type, not by guessing from the value', () => {
    const { out } = run(
      [
        { key: 'a', type: 'text' }, { key: 'n', type: 'number' }, { key: 'b', type: 'boolean' },
        { key: 'd', type: 'datetime' }, { key: 'day', type: 'date' }, { key: 'code', type: 'code' },
        { key: 'id', type: 'text' }, { key: 'j', type: 'json' },
      ],
      { a: 5, n: '12.5', b: 'true', d: '2025-01-02', day: '2025-03-04T23:30:00-05:00', code: 'x = 1', id: 7, j: { k: [1] } },
    );
    expect(out).toEqual({ a: '5', n: 12.5, b: true, d: '2025-01-02T00:00:00.000Z', day: '2025-03-04', code: { language: 'text', code: 'x = 1' }, id: '7', j: { k: [1] } });
  });

  it('counts what cannot be converted or has no field, and writes neither', () => {
    const { out, c } = run([{ key: 'n', type: 'number' }, { key: 'd', type: 'date' }], { n: 'abc', d: 'not a date', extra: 1, gone: null });
    expect(out).toEqual({});
    expect([...c.dropped]).toEqual([['t.n', 1], ['t.d', 1], ['t.extra', 1]]);
  });

  it('wraps raw lists into the one-field rows the model uses for many values', () => {
    const tags: FieldDecl = { key: 'tags', type: 'array', fields: [{ key: 'value', type: 'text' }] };
    const files: FieldDecl = { key: 'files', type: 'array', fields: [{ key: 'value', type: 'media' }] };
    const { out } = run([tags, files], { tags: ['a', 'b'], files: [1, 2, 'missing'] });
    expect(out).toEqual({ tags: [{ value: 'a' }, { value: 'b' }], files: [{ value: { assetId: 'A1' } }, { value: { assetId: 'A2' } }, {}] });
  });

  it('leaves rows that already name their field, and ignores row ids', () => {
    const rows: FieldDecl = { key: 'rows', type: 'array', fields: [{ key: 'size', type: 'text' }, { key: 'body', type: 'richText' }] };
    const { out } = run([rows], { rows: [{ id: 'x', size: 'half', body: 'Hi' }] });
    expect(out.rows).toEqual([{ size: 'half', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] } }]);
  });

  it('blocks keep their type, drop unknown block types, and skip bookkeeping keys', () => {
    const { out, c } = run([{ key: 'layout', type: 'blocks' }], { layout: [{ id: 'q', blockType: 'hero', blockName: 'n', heading: 'H' }, { blockType: 'archive' }, { _type: 'hero', heading: 'S' }] });
    expect(out.layout).toEqual([{ blockType: 'hero', heading: 'H' }, { blockType: 'hero', heading: 'S' }]);
    expect([...c.dropped.keys()]).toEqual(['t.layout[1]<archive>']);
  });

  it('references: resolved ones are written, missing ones mark the entry for a second pass', () => {
    const { out, c } = run(
      [{ key: 'one', type: 'reference' }, { key: 'many', type: 'reference', hasMany: true }, { key: 'none', type: 'reference' }],
      { one: 'known', many: ['known', 'later'], none: 'later' },
    );
    expect(out).toEqual({ one: { kind: 'entry', id: 'E1' }, many: [{ kind: 'entry', id: 'E1' }] });
    expect(c.pendingRef.value).toBe(true);
  });

  it('media and groups', () => {
    const { out } = run([{ key: 'm', type: 'media' }, { key: 'f', type: 'file' }, { key: 'g', type: 'group', fields: [{ key: 'x', type: 'text' }] }], { m: 3, f: 4, g: { x: 'y', z: 1 } });
    expect(out).toEqual({ m: { assetId: 'A3' }, f: { assetId: 'A4', name: '4.png' }, g: { x: 'y' } });
  });
});
