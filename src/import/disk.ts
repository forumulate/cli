import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { ImportFiles } from './types';

export const diskFiles: ImportFiles = {
  read: (p) => readFileSync(p, 'utf8'),
  readBytes: (p) => new Uint8Array(readFileSync(p)),
  exists: (p) => existsSync(p),
  list: (d) => readdirSync(d).sort(),
  isDir: (p) => existsSync(p) && statSync(p).isDirectory(),
};

export async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
