import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadManifest } from './manifest';

/** `about:` in forumulate.yaml: a map of parts, or a file beside the manifest. */
describe('the about manifest key', () => {
  const write = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'about-manifest-'));
    const file = join(dir, 'forumulate.yaml');
    writeFileSync(file, text);
    return file;
  };

  it('reads the parts inline', () => {
    const m = loadManifest(
      write('org: acme\nspaces:\n  - path: about\n    space: about\n    about:\n      mission: Make work lighter.\n'),
    );
    expect(m.spaces[0]!.about).toEqual({ mission: 'Make work lighter.' });
  });

  it('keeps a file name for the sync to read', () => {
    const m = loadManifest(write('org: acme\nspace: about\nabout: about.yaml\n'));
    expect(m.spaces[0]!.about).toBe('about.yaml');
  });

  it('refuses a list where the parts belong', () => {
    expect(() => loadManifest(write('org: acme\nspace: about\nabout: [1, 2]\n'))).toThrow(/about/);
  });
});
