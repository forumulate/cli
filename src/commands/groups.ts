import { API_GROUPS } from './groups-api';
import { COMMUNITY_GROUPS } from './groups-community';
import { CONTENT_GROUPS } from './groups-content';
import { DOCS_GROUPS } from './groups-docs';
import { JOB_GROUPS } from './groups-jobs';
import { ORG_GROUPS } from './groups-org';
import { SITE_GROUPS } from './groups-site';
import { SPACE_GROUPS } from './groups-spaces';
import { TYPE_GROUPS } from './groups-types';
import type { GroupDef } from './resource';

/**
 * The resource commands, as data. Each verb is one operation in the bundled
 * spec; `resource.ts` derives the flags. `operations.test.ts` asserts every
 * operationId named here exists, so a renamed route breaks the build, not a
 * customer's script.
 *
 * The verbs are the same everywhere — list, get, create, update, delete, and
 * publish where a thing has a draft — because that is what `gh`, `stripe` and
 * `vercel` taught people to type. A sub-resource is a two-word verb
 * (`libraries keys rotate`, `docs schedule set`), never a third word.
 *
 * One file per domain (`groups-*.ts`), each with its own reason in its header;
 * this one only puts them in the order `forumulate help` lists them.
 */
const SEARCH: GroupDef = {
  name: 'search',
  noun: 'result',
  about: 'unified search across docs, forum and blog, and what it is missing',
  verbs: {
    query: {
      op: 'UnifiedSearch_search_',
      about: 'Search (--type docs|forum|blog, --limit); `search query <words>` for a verb word',
      args: ['q...'],
      columns: ['sourceType', 'title', 'url'],
    },
    semantic: {
      op: 'UnifiedSearch_semanticSearch',
      about: 'Search by meaning (your embedding provider; --mode)',
      args: ['q...'],
      columns: ['sourceType', 'title', 'url', 'score'],
    },
    recent: { op: 'UnifiedSearch_recent', about: 'Your recent searches' },
    tags: { op: 'UnifiedSearch_tags', about: 'Every tag across the organization' },
    tag: { op: 'UnifiedSearch_tagHub_', about: 'Everything carrying one tag', args: ['tag'] },
    gaps: {
      op: 'UnifiedSearch_gaps',
      about: 'Searches that found nothing (--days)',
      columns: ['query', 'count', 'lastSearchedAt'],
    },
    reindex: { op: 'UnifiedSearch_reindex', about: 'Rebuild the search index' },
  },
  defaultVerb: 'query',
  bareArgs: true,
};

export const GROUPS: GroupDef[] = [
  ...ORG_GROUPS,
  ...SPACE_GROUPS,
  ...DOCS_GROUPS,
  ...API_GROUPS,
  ...COMMUNITY_GROUPS,
  ...TYPE_GROUPS,
  ...CONTENT_GROUPS,
  ...SITE_GROUPS,
  ...JOB_GROUPS,
  SEARCH,
];

export function findGroup(name: string): GroupDef | undefined {
  return GROUPS.find((g) => g.name === name || g.aliases?.includes(name));
}
