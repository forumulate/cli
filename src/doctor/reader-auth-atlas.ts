import type { Check } from '../conformance';
import type { Http } from '../api/http';
import { check } from './probe';

export const READER_AUTH_ATLAS_CHECK = 'reader-auth-atlas';

const TITLE = 'Readers sign in with the Atlas reader provider when the organization uses Atlas';
const MATTERS =
  'A hand-rolled external_jwt route is code you maintain that the Atlas provider does for you: Forumulate verifies Atlas’s own reader token and keys members on (iss, sub).';

interface Recommendation {
  code: string;
  message: string;
  docs?: string;
  patch?: unknown;
  manifest?: unknown;
  relink?: { from: { provider: string }; to: { provider: string; issuer: string | null } } | null;
}

/**
 * `reader-auth-atlas` (FMU-X01): does this organization sign its readers in
 * the recommended way?
 *
 * The rule is the API's, not the CLI's: `GET /orgs/{org}/reader-auth`
 * answers `recommendations`, computed from the org's own configuration (an
 * Atlas issuer on an `external_jwt` provider, a linked Atlas instance), and
 * the manifest plan answers the same list. This prints what it says.
 *
 * Advice, like `robots-params`: a recommendation is a SKIP with the steps,
 * never a FAIL, because signing readers in from your own app is a supported
 * setup and a scheduled doctor must not fail CI over it.
 */
export async function readerAuthAtlasCheck(http: Http, org: string): Promise<Check> {
  let body: { providers?: { method: string }[]; recommendations?: Recommendation[] };
  try {
    body = (await http.send({ method: 'GET', path: `/orgs/${encodeURIComponent(org)}/reader-auth` }))
      .data as typeof body;
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return check(
      READER_AUTH_ATLAS_CHECK,
      TITLE,
      'skip',
      `Could not read the organization's reader sign-in (${err.status ?? 'error'}): it needs a token with org.manage_settings.`,
      '',
    );
  }
  const rec = (body.recommendations ?? []).find((r) => r.code === 'reader_auth.use_atlas');
  if (!rec) {
    const methods = (body.providers ?? []).map((p) => p.method);
    return check(
      READER_AUTH_ATLAS_CHECK,
      TITLE,
      'pass',
      methods.includes('atlas_byo')
        ? 'atlas_byo is configured.'
        : `Nothing to recommend${methods.length ? ` (${methods.join(', ')})` : ''}.`,
      '',
    );
  }
  const lines = [
    `Recommended — ${rec.message}`,
    rec.relink
      ? `  1. Relink the members: POST /orgs/${org}/members/relink ${JSON.stringify({ from: rec.relink.from, to: rec.relink.to })} (dry run first; ?apply=true writes)`
      : null,
    `  ${rec.relink ? '2' : '1'}. Switch: PATCH /orgs/${org}/reader-auth ${JSON.stringify(rec.patch)}`,
    `     or in a manifest (version 2): ${JSON.stringify(rec.manifest)}`,
    rec.docs ? `  See ${rec.docs}` : null,
  ].filter((l): l is string => l !== null);
  return check(READER_AUTH_ATLAS_CHECK, TITLE, 'skip', lines.join('\n'), MATTERS);
}
