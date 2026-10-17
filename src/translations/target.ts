/**
 * Which space, library or site a `forumulate translations` command means.
 *
 * A person types a slug (`--space docs`); the API wants ids. Like the content
 * commands' library rule (`content/library.ts`): the org is optional, an
 * ambiguous slug is refused with the orgs named, never guessed.
 */
import type { ForumulateClient, LocaleTarget, Space } from '@forumulate/sdk';
import { orgIdOf, resolveLibrary, TargetError } from '../content/library';

export { TargetError };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SpaceTarget {
  orgId: string;
  spaceId: string;
  name: string;
  type: string;
}

export async function resolveSpace(
  client: ForumulateClient,
  want: { org?: string; space?: string },
): Promise<SpaceTarget> {
  if (!want.space) throw new TargetError('Say which space: --space <id|slug> (or FORUMULATE_SPACE).');
  const space = want.space;
  const orgIds = want.org
    ? [await orgIdOf(client, want.org)]
    : (await client.orgs.list()).orgs.map((o) => o.id);
  const hits: SpaceTarget[] = [];
  for (const orgId of orgIds) {
    const listed = await client.spaces.list(orgId).catch(() => ({ spaces: [] as Space[] }));
    for (const s of listed.spaces)
      if (s.id === space || s.slug === space) hits.push({ orgId, spaceId: s.id, name: s.name, type: s.type });
  }
  if (hits.length === 1) return hits[0]!;
  if (!hits.length) {
    // An id in an org the listing could not reach (a confined token) is still addressable.
    if (UUID.test(space) && want.org) return { orgId: await orgIdOf(client, want.org), spaceId: space, name: space, type: '' };
    throw new TargetError(`No space "${space}"${want.org ? ` in ${want.org}` : ' in any of your organizations'}.`);
  }
  throw new TargetError(`"${space}" names a space in ${hits.length} organizations (${hits.map((h) => h.orgId).join(', ')}); add --org.`);
}

/** `--space` or `--library` — the two things that declare languages. */
export async function resolveLocaleTarget(
  client: ForumulateClient,
  want: { org?: string; space?: string; library?: string },
): Promise<{ orgId: string; target: LocaleTarget; name: string }> {
  if (want.library && !want.space) {
    const lib = await resolveLibrary(client, { org: want.org, library: want.library });
    return { orgId: lib.orgId, target: { libraryId: lib.libraryId }, name: lib.name };
  }
  if (!want.space) throw new TargetError('Say which space or library: --space <id|slug> or --library <id|slug>.');
  const s = await resolveSpace(client, want);
  return { orgId: s.orgId, target: { spaceId: s.spaceId }, name: s.name };
}

/** The org alone (`overrides`), from --org or the only one the caller has. */
export async function resolveOrg(client: ForumulateClient, org?: string): Promise<string> {
  if (org) return orgIdOf(client, org);
  const { orgs } = await client.orgs.list();
  if (orgs.length === 1) return orgs[0]!.id;
  throw new TargetError(`Say which organization: --org <id|slug> (you have ${orgs.length}).`);
}
