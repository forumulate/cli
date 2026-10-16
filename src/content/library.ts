/**
 * Which content library a `forumulate content` command means.
 *
 * A person types a slug (`--library acme-site`); the API wants ids. The org is
 * optional because a pulled file already names its library by id, and asking
 * for the org as well would be asking for something the CLI can look up. An
 * ambiguous slug (two orgs with an `acme-site`) is refused with the orgs
 * named, never guessed.
 */
import type { ForumulateClient } from '@forumulate/sdk';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LibraryTarget {
  orgId: string;
  libraryId: string;
  name: string;
}

export class TargetError extends Error {}

async function orgIdOf(client: ForumulateClient, org: string): Promise<string> {
  if (UUID.test(org)) return org;
  const { orgs } = await client.orgs.list();
  const hit = orgs.find((o) => o.slug === org || o.id === org);
  if (!hit) throw new TargetError(`No organization "${org}" among yours (forumulate orgs lists them).`);
  return hit.id;
}

export async function resolveLibrary(
  client: ForumulateClient,
  want: { org?: string; library?: string },
): Promise<LibraryTarget> {
  if (!want.library) {
    throw new TargetError('Say which content library: --library <id|slug> (or FORUMULATE_LIBRARY).');
  }
  const library = want.library;
  const orgIds = want.org ? [await orgIdOf(client, want.org)] : (await client.orgs.list()).orgs.map((o) => o.id);
  const hits: LibraryTarget[] = [];
  for (const orgId of orgIds) {
    // An org the caller cannot list libraries in simply has none for them.
    const listed = await client.content.libraries.list(orgId).catch(() => ({ libraries: [] }));
    for (const l of listed.libraries) {
      if (l.id === library || l.slug === library) hits.push({ orgId, libraryId: l.id, name: l.name });
    }
  }
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) {
    throw new TargetError(`No content library "${library}"${want.org ? ` in ${want.org}` : ' in any of your organizations'}.`);
  }
  throw new TargetError(
    `"${library}" names a library in ${hits.length} organizations (${hits.map((h) => h.orgId).join(', ')}); add --org.`,
  );
}
