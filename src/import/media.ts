/**
 * Files of an export into the library's media, once each.
 *
 * Re-running an import must not store every picture again, so the stored name
 * carries a hash of the bytes (the `forumulate publish` convention) and the
 * library is asked for that name first. Source files are addressed three ways
 * (their own id, their file name, the URL a body links them by); all three
 * resolve to the one asset.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { ForumulateClient } from '@forumulate/sdk';
import type { ImportFiles, SourceMedia } from './types';

export interface UploadedFile {
  id: string;
  url: string;
  filename: string;
}

export interface MediaDeps {
  client: ForumulateClient;
  upload?: (path: string, form: FormData) => Promise<unknown>;
  files: ImportFiles;
  /** Bytes of a remote file. */
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** Folder that relative `location`s are under. */
  root: string;
}

const REMOTE = /^https?:\/\//i;

export function storedName(bytes: Uint8Array, filename: string): { hash: string; name: string } {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  return { hash, name: `${hash}-${filename.replace(/[^\w.-]+/g, '-')}` };
}

export async function uploadMedia(
  deps: MediaDeps,
  orgId: string,
  libraryId: string,
  m: SourceMedia,
): Promise<UploadedFile & { reused: boolean }> {
  const bytes = REMOTE.test(m.location)
    ? await deps.fetchBytes(m.location)
    : deps.files.readBytes(isAbsolute(m.location) ? m.location : join(deps.root, m.location));
  const { hash, name } = storedName(bytes, m.filename);
  const found = await deps.client.content.assets.list(orgId, libraryId, { search: hash, limit: 50 });
  const hit = found.assets.find((a) => a.filename === name);
  if (hit) return { id: hit.id, url: hit.url, filename: hit.filename, reused: true };
  if (!deps.upload) throw new Error('asset upload is not available in this environment');
  const form = new FormData();
  form.set('file', new Blob([Buffer.from(bytes)], m.contentType ? { type: m.contentType } : undefined), name);
  const res = (await deps.upload(`/orgs/${orgId}/content/libraries/${libraryId}/assets`, form)) as { asset?: UploadedFile };
  if (!res.asset?.id) throw new Error(`upload of ${m.filename} answered without an asset`);
  return { id: res.asset.id, url: res.asset.url, filename: res.asset.filename ?? name, reused: false };
}
