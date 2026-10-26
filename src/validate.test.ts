import { describe, expect, it } from 'vitest';
import { collectDocuments, runValidateCommand } from './validate';
import type { Http } from './api/http';

/** FMU-D11: `forumulate validate <dir>` sends every config document to the published schemas. */
const tree: Record<string, string> = {
  '/site/forumulate.yaml': 'org: acme\nspace: docs\ntheme: { primaryColor: "#0a7" }\n',
  '/site/docs/intro.md': '---\ntitle: Intro\nseo_title: Hi\n---\n# Intro\n',
  '/site/docs/plain.md': '# No front matter\n',
  '/site/theme.json': JSON.stringify({
    $schema: 'https://forumulate.com/schemas/2026-12-01/space-theme.json',
    primary_color: '#000000',
  }),
  '/site/package.json': '{"name":"x"}',
};
const files = { list: () => Object.keys(tree), read: (p: string) => tree[p]! };

describe('forumulate validate', () => {
  it('collects the manifest, front matter and $schema files only', () => {
    const problems: string[] = [];
    const docs = collectDocuments('/site', files, problems);
    expect(docs.map((d) => [d.schema, d.source])).toEqual([
      ['forumulate-yaml', 'forumulate.yaml'],
      ['front-matter', 'docs/intro.md'],
      ['space-theme', 'theme.json'],
    ]);
    expect(docs[2]!.document).toEqual({ primary_color: '#000000' });
    expect(problems).toEqual([]);
  });

  it('prints each issue with its hint and exits 2 when one is invalid', async () => {
    const sent: unknown[] = [];
    const http = {
      send: async (req: { body: unknown }) => {
        sent.push(req.body);
        return {
          status: 200,
          headers: new Headers(),
          data: {
            results: [
              { schema: 'forumulate-yaml', source: 'forumulate.yaml', valid: true, issues: [] },
              { schema: 'front-matter', source: 'docs/intro.md', valid: true, issues: [] },
              {
                schema: 'space-theme',
                source: 'theme.json',
                valid: false,
                issues: [
                  {
                    path: 'primary_color',
                    message: '`primary_color` is not a key this document takes.',
                    severity: 'error',
                    hint: '`primary_color`: did you mean `primaryColor`? Every key is camelCase.',
                  },
                ],
              },
            ],
          },
        };
      },
    } as unknown as Http;
    const out: string[] = [];
    const code = await runValidateCommand(['/site'], { out: (l) => out.push(l), err: () => {}, http, files });
    expect(code).toBe(2);
    expect((sent[0] as { documents: unknown[] }).documents).toHaveLength(3);
    expect(out.join('\n')).toContain('ERROR    theme.json primary_color');
    expect(out.join('\n')).toContain('did you mean `primaryColor`');
  });
});
