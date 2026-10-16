import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { defName, generateTypes, toType } from './types-gen';

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8');
/** schema.json for a library built from the website template (kept current by the API's cli-fixture test). */
const website = () => JSON.parse(fixture('website.schema.json')) as { $defs: Record<string, any> };
const site = fixture('reference-site.ts.txt');

/** Type-checks in-memory files with the real compiler, strict; returns the diagnostics. */
function compile(files: Record<string, string>, extra: ts.CompilerOptions = {}): string[] {
  const options: ts.CompilerOptions = {
    ...extra,
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  // Windows hosts spell paths with backslashes and a drive: compare after normalising.
  const virtual = (name: string) => {
    const at = name.replace(/\\/g, '/').indexOf('/virtual/');
    return at < 0 ? undefined : name.replace(/\\/g, '/').slice(at + '/virtual/'.length);
  };
  const { getSourceFile, fileExists, readFile, directoryExists } = host;
  host.directoryExists = (name) => virtual(`${name}/`) !== undefined || (directoryExists?.call(host, name) ?? false);
  host.getSourceFile = (name, lang, ...rest) => {
    const key = virtual(name);
    return key !== undefined && key in files
      ? ts.createSourceFile(name, files[key]!, lang)
      : getSourceFile.call(host, name, lang, ...rest);
  };
  host.fileExists = (name) => {
    const key = virtual(name);
    return key !== undefined ? key in files : fileExists.call(host, name);
  };
  host.readFile = (name) => {
    const key = virtual(name);
    return key !== undefined ? files[key] : readFile.call(host, name);
  };
  const program = ts.createProgram(Object.keys(files).map((f) => `/virtual/${f}`), options, host);
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('forumulate content types (P4-T1)', () => {
  it('generates the website template types (snapshot)', async () => {
    const out = generateTypes(website(), { libraryId: '00000000-0000-4000-8000-0000000000aa' });
    expect(out.types).toEqual(['route', 'page', 'menu', 'post']);
    expect(out.globals).toEqual(['site', 'header', 'footer', 'strings']);
    expect(out.blocks).toEqual(['hero', 'text', 'features', 'cta', 'image']);
    await expect(out.source).toMatchFileSnapshot('./__snapshots__/website.d.ts.snap');
  });

  it('the reference site compiles against them, strict', () => {
    const { source } = generateTypes(website());
    expect(compile({ 'forumulate.d.ts': source, 'site.ts': site })).toEqual([]);
  });

  it("the reference site (templates/marketing-next) accepts them in place of its hand-written field types", () => {
    const root = path.resolve(__dirname, '../../../..');
    const fields = readFileSync(path.join(root, 'templates/marketing-next/lib/fields.ts'), 'utf8');
    const names = ['PageFields', 'PostFields', 'RouteFields', 'MenuFields', 'SiteFields', 'HeaderFields', 'FooterFields'];
    const check = [
      "import type * as Gen from './forumulate';",
      "import type * as Site from './fields';",
      ...names.map((n) => `export const ${n[0]!.toLowerCase()}${n.slice(1)}: Site.${n} = {} as Gen.${n};`),
    ].join('\n');
    const errors = compile(
      { 'forumulate.d.ts': generateTypes(website()).source, 'fields.ts': fields, 'check.ts': check },
      // The site imports Entry and Media from @forumulate/next/content, which re-exports these.
      { baseUrl: root, paths: { '@forumulate/next/content': ['packages/embed/src/content/types.ts'] } },
    );
    expect(errors).toEqual([]);
  });

  it('a model change makes tsc flag the stale field', () => {
    // The model renames post.excerpt to post.summary.
    const schema = website();
    const post = schema.$defs['type.post'];
    post.properties = Object.fromEntries(
      Object.entries(post.properties as Record<string, unknown>).map(([k, v]) => [k === 'excerpt' ? 'summary' : k, v]),
    );
    const errors = compile({ 'forumulate.d.ts': generateTypes(schema).source, 'site.ts': site });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Property 'excerpt' does not exist on type 'PostFields'/);
  });

  it('a new block type makes the exhaustive renderer fail to compile', () => {
    const schema = website();
    schema.$defs['block.quote'] = {
      title: 'Quote',
      type: 'object',
      required: ['id', 'blockType'],
      properties: { id: { type: 'string' }, blockType: { const: 'quote' }, text: { type: 'string' } },
    };
    const errors = compile({ 'forumulate.d.ts': generateTypes(schema).source, 'site.ts': site });
    expect(errors.some((e) => /'QuoteBlock' is not assignable to type 'never'/.test(e))).toBe(true);
  });

  it('types a json field from its own schema, refs included', () => {
    expect(
      toType({
        type: 'object',
        required: ['price'],
        properties: { price: { $ref: '#/$defs/json.post.meta.money' }, tags: { type: 'array', items: { enum: ['a', 'b'] } } },
      }),
    ).toBe('{\n  price: JsonPostMetaMoney;\n  tags?: ("a" | "b")[];\n}');
    expect(defName('json.post.meta~2')).toBe('JsonPostMeta2');
    expect(toType({ type: ['string', 'null'] })).toBe('string | null');
    expect(toType({ oneOf: [{ $ref: '#/$defs/block.hero' }, { $ref: '#/$defs/block.cta' }] })).toBe('HeroBlock | CtaBlock');
    expect(toType({ type: 'object', additionalProperties: { type: 'number' } })).toBe('Record<string, number>');
  });

  it('refuses something that is not a library schema', () => {
    expect(() => generateTypes({ type: 'object' })).toThrow(/\$defs/);
  });
});
