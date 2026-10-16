/**
 * A tar reader for `strapi export --no-encrypt` archives (a gzipped ustar).
 *
 * Hand-rolled because the CLI ships without runtime dependencies beyond the
 * SDK; the format needed is small: 512-byte headers, octal sizes, the ustar
 * `prefix`, and the pax / GNU long-name records writers emit for deep paths.
 */
import { gunzipSync } from 'node:zlib';

const text = (b: Uint8Array, from: number, len: number): string => {
  const end = b.subarray(from, from + len).indexOf(0);
  return Buffer.from(b.subarray(from, from + (end < 0 ? len : end))).toString('utf8');
};

/** Regular files by path (leading `./` and the archive's single wrapper folder kept as written). */
export function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const data = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes)) : bytes;
  const out = new Map<string, Uint8Array>();
  let longName: string | null = null;
  let paxPath: string | null = null;
  for (let at = 0; at + 512 <= data.length; ) {
    if (data.subarray(at, at + 512).every((x) => x === 0)) break;
    const size = parseInt(text(data, at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(data[at + 156] || 48);
    const prefix = text(data, at + 345, 155);
    const name = text(data, at, 100);
    const body = data.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') longName = text(body, 0, body.length);
    else if (type === 'x') {
      // pax records are `<len> key=value\n`; only `path` matters here.
      const m = /\d+ path=([^\n]*)\n/.exec(Buffer.from(body).toString('utf8'));
      paxPath = m ? m[1]! : null;
    } else if (type === '0' || type === '\0') {
      const path = (paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, '');
      out.set(path, body);
      longName = paxPath = null;
    } else longName = paxPath = null;
  }
  return out;
}
