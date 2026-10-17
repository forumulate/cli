import type { GroupDef, VerbDef } from './resource';

/**
 * The look and the address of what readers see: a space's theme (live and
 * draft, and the portable bundle), the sites that join spaces under one
 * domain, and the GitHub sync that keeps docs in a repository.
 *
 * `theme pull`/`push` was the ask: a theme kept in git and pushed from CI.
 * `export`/`import` move the whole bundle; `draft …` stages a change and
 * `draft publish` makes it live, the same two steps the studio takes.
 */

/** The draft verbs a space's and a site's theme share; the two differ only in operationIds. */
function draftVerbs(ops: {
  get: string;
  set: string;
  patch: string;
  discard: string;
  publish: string;
  apply: string;
}): Record<string, VerbDef> {
  return {
    'draft get': { op: ops.get, about: 'The theme draft, if there is one' },
    'draft set': { op: ops.set, about: 'Replace the draft (--data @theme.json)' },
    'draft patch': {
      op: ops.patch,
      about: 'Merge into the draft (--primaryColor …, --data @patch.json)',
    },
    'draft apply': {
      op: ops.apply,
      about: 'Stage a marketplace component into the draft (--componentId)',
    },
    'draft discard': { op: ops.discard, about: 'Throw the draft away', destructive: true },
    'draft publish': { op: ops.publish, about: 'Make the draft live (--force)' },
  };
}

export const SITE_GROUPS: GroupDef[] = [
  {
    name: 'theme',
    noun: 'theme',
    about: 'a space’s reader theme: live, draft, and the portable bundle',
    defaultVerb: 'get',
    verbs: {
      get: { op: 'SpaceSettings_getTheme', about: 'The live theme' },
      set: { op: 'SpaceSettings_setTheme', about: 'Replace the live theme (--data @theme.json)' },
      patch: {
        op: 'SpaceSettings_patchTheme',
        about: 'Change some keys of the live theme (--primaryColor "#0a7")',
      },
      ...draftVerbs({
        get: 'SpaceSettings_getThemeDraft',
        set: 'SpaceSettings_setThemeDraft',
        patch: 'SpaceSettings_patchThemeDraft',
        discard: 'SpaceSettings_discardThemeDraft',
        publish: 'SpaceSettings_publishThemeDraft',
        apply: 'ThemeBundle_applySpace',
      }),
      export: {
        op: 'ThemeBundle_exportSpace',
        about: 'The theme as a portable bundle (--json > theme.json)',
      },
      import: {
        op: 'ThemeBundle_importSpace',
        about: 'Load a bundle into the draft (--data @theme.json)',
      },
    },
  },
  {
    name: 'sites',
    noun: 'site',
    about: 'sites: several spaces under one domain and one theme',
    defaultVerb: 'list',
    verbs: {
      list: { op: 'Site_list', about: 'List sites', columns: ['id', 'slug', 'name', 'createdAt'] },
      get: { op: 'Site_get', about: 'Get one site', args: ['siteId'] },
      create: {
        op: 'Site_create',
        about: 'Create a site (--slug, --spaceIds a,b)',
        args: ['name'],
      },
      update: { op: 'Site_update', about: 'Change some of it (--dryRun true)', args: ['siteId'] },
      replace: {
        op: 'Site_replace',
        about: 'Replace its whole config (--data @site.json)',
        args: ['siteId'],
      },
      delete: { op: 'Site_remove', about: 'Delete a site', args: ['siteId'], destructive: true },
      staging: {
        op: 'Site_setStaging',
        about: 'Turn the staging copy on or off (true|false)',
        args: ['siteId', 'staging'],
      },
      'domains list': {
        op: 'Site_listDomains',
        about: 'The site’s domains',
        args: ['siteId'],
        columns: ['id', 'hostname', 'basePath', 'verified', 'active'],
      },
      'domains add': {
        op: 'Site_addDomain',
        about: 'Add a domain (--basePath)',
        args: ['siteId', 'hostname'],
      },
      'domains subdomain': {
        op: 'Site_allocateSubdomain',
        about: 'Take a free subdomain',
        args: ['siteId', 'subdomain'],
      },
      'domains setup': {
        op: 'Site_domainSetup',
        about: 'What a domain is still waiting for',
        args: ['siteId', 'domainId'],
      },
      'domains www': {
        op: 'Site_setDomainWww',
        about: 'Also redirect www. (true|false)',
        args: ['siteId', 'domainId', 'alsoRedirectWww'],
      },
      'domains verify': {
        op: 'Site_verifyDomain',
        about: 'Re-run verification',
        args: ['siteId', 'domainId'],
      },
      'domains activate': {
        op: 'Site_activateDomain',
        about: 'Start serving it',
        args: ['siteId', 'domainId'],
      },
      'domains remove': {
        op: 'Site_removeDomain',
        about: 'Remove a domain',
        args: ['siteId', 'domainId'],
        destructive: true,
      },
      'theme export': {
        op: 'ThemeBundle_exportSite',
        about: 'The site theme as a bundle',
        args: ['siteId'],
      },
      'theme import': {
        op: 'ThemeBundle_importSite',
        about: 'Load a bundle into the site draft (--data @theme.json)',
        args: ['siteId'],
      },
      ...Object.fromEntries(
        Object.entries(
          draftVerbs({
            get: 'ThemeBundle_siteDraft',
            set: 'ThemeBundle_setSiteDraft',
            patch: 'ThemeBundle_patchSiteDraft',
            discard: 'ThemeBundle_discardSiteDraft',
            publish: 'ThemeBundle_publishSiteDraft',
            apply: 'ThemeBundle_applySite',
          }),
        ).map(([verb, v]) => [verb, { ...v, args: ['siteId'] }]),
      ),
    },
  },
  {
    name: 'reader',
    noun: 'page',
    about:
      'what a visitor is served: public pages and the blog, its feeds, as the public API answers',
    defaultVerb: 'page',
    verbs: {
      page: {
        op: 'Public_page',
        about: 'A page as readers get it (--locale, --version, --share)',
        args: ['pageId'],
      },
      markdown: {
        op: 'Public_pageMarkdown',
        about: 'A page as Markdown (--locale; --form source)',
        args: ['pageId'],
      },
      version: {
        op: 'Public_pageVersion',
        about: 'A page in one docs version (--version)',
        args: ['pageId'],
      },
      pdf: { op: 'Public_pagePdf', about: 'A page as PDF', args: ['pageId'], download: 'page.pdf' },
      'blog index': {
        op: 'PublicBlog_index',
        about: 'The blog’s front page (--tag, --author, --series, --month)',
        columns: ['slug', 'title', 'publishedAt'],
      },
      'blog article': { op: 'PublicBlog_article', about: 'One article', args: ['slug'] },
      'blog markdown': {
        op: 'PublicBlog_pieceMarkdown',
        about: 'One article as Markdown (--locale)',
        args: ['slug'],
      },
      'blog search': { op: 'PublicBlog_search', about: 'Search the blog', args: ['q...'] },
      'blog tags': { op: 'PublicBlog_tags', about: 'Its tags' },
      'blog archive': { op: 'PublicBlog_archive', about: 'Articles by month' },
      'blog series': { op: 'PublicBlog_series', about: 'Its series' },
      'blog permalink': {
        op: 'PublicBlog_permalink',
        about: 'What an old or custom path resolves to',
        args: ['path'],
      },
      'blog rss': { op: 'PublicBlog_rss', about: 'The RSS feed (rss.xml)', download: 'rss.xml' },
      'blog feed': {
        op: 'PublicBlog_rssAlias',
        about: 'The RSS feed at its feed.xml address',
        download: 'feed.xml',
      },
      'blog json-feed': {
        op: 'PublicBlog_jsonFeed',
        about: 'The JSON Feed',
        download: 'feed.json',
      },
    },
  },
  {
    name: 'github',
    aliases: ['git'],
    noun: 'GitHub connection',
    about: 'a docs space synced with a repository (GitHub, GitLab, Bitbucket)',
    defaultVerb: 'status',
    verbs: {
      status: { op: 'Github_status', about: 'The connection and its last sync' },
      connect: {
        op: 'Github_connect',
        about: 'Connect a repo (--token, --branch, --path, --provider)',
        args: ['repo'],
      },
      import: { op: 'Github_import', about: 'Pull the repository into the space now' },
      export: { op: 'Github_export', about: 'Push the space to the repository now' },
      'pull-request': {
        op: 'Github_pullRequest',
        about: 'Open a pull request from a change request',
        args: ['crId'],
      },
      'egress-ips': {
        op: 'Github_egressIps',
        about: 'The addresses we connect from (for a firewall)',
      },
    },
  },
];
