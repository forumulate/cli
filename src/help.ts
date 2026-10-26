/** `forumulate help`. The resource groups print their own (`forumulate spaces --help`). */
export const HELP = `forumulate — Forumulate command-line interface

Usage:
  forumulate <command> [args]

Commands:
  login [--token <pat>]              Store a token for this API, so every other
                                     command stops needing FORUMULATE_TOKEN in
                                     the environment
  logout                             Forget the stored token
  whoami [--json]                    Who you are, and WHICH token: its source (--token,
                                     FORUMULATE_TOKEN or credentials.json), id, name,
                                     last 4, expiry, narrowing and the API base
  auth status [--json]               The same report, for scripts
  config set|get|unset|list          Defaults: org, space, library, api-version
                                     (\`forumulate config set org acme\`)

Every API operation:
  api list [--tag t] [--search w]    Discover operations and their summaries
           [--refresh]               ...from the live API's spec, not the bundled one
  api describe <operationId>         Parameters and body schema, as flags
  api <operationId> [args] [flags]   Call it: --<param> value, --data @f.json,
  api <METHOD> <path> [flags]        --field a.b=v, --paginate, --json

Resources (each: <group> --help lists its verbs and the operation each calls):
  Org:      orgs | members | invites | groups | roles | service-accounts (bots)
            tokens (pats) | keys | integration-tokens (int-tokens)
            webhooks | extensions | audit
  Spaces:   spaces | snapshots | shape | domains | assets | space-types (types)
  Docs:     items (pages) | docs | collections | versions | change-requests (crs)
            openapi | sdks | github (git)
  Content:  blog | forum | changelog | roadmap | status | events | course
            careers | forms   (blog/forum/changelog/status: translations …)
  CMS:      libraries | entries | media | releases | environments (envs)
  Site:     theme | sites | reader
  Jobs:     jobs | backups | imports | manifest   (starters take --wait [--timeout s])
  search <query...> [--org]          e.g. spaces create Docs --slug docs --type DOCS
                                          items create --space docs --file a.md --publish
                                          docs schedule set <pageId> <when> --space docs
                                          webhooks deliveries <id>; webhooks replay <id> <d>
      --out <file>  where a file answer goes (SDK archive, PDF, CSV export)
  cache purge --space <s> [--page p] Drop cached copies (web tier + every CDN); deletes
                                     nothing
  completion bash|zsh|fish           Shell completion script

Older forms, unchanged:
  orgs                               List your organizations
  spaces <orgId>                     List spaces in an org
  items <orgId> <spaceId>            List what is in a space, with where each
                                     piece's content lives
  search <orgId> <query...>          Unified search across docs/forum/blog
  dev <folder>                       Preview a folder of Markdown locally, rendered
                                     by your space's own renderer; reloads on save.
      --org <id> --space <id> [--port 4321] [--site <your docs URL>]
  publish <folder> --org <o> --space <s>
                                     Publish a folder of Markdown: one folder per
                                     collection, front matter, assets, order,
                                     and a forumulate.yaml manifest for space,
                                     site, theme, OpenAPI and monitors. Re-runs
                                     change only what changed, then read back.
      --org <id|slug> --space <id|slug>   (or org:/space: in the manifest)
      --dry-run   print the plan, write nothing (no token needed for a
                  public space)
      --prune     remove pages/posts/collections with no file (to the trash)
      --only a,b  just these slugs, files, folders, or manifest parts
                  (site, theme, settings, openapi, monitors)
      --force     re-send every page even if it looks unchanged
      --no-verify skip the read-back      --pace <ms> gap between writes
      --manifest <file>  a manifest somewhere else
      --diff      print the changed paragraphs and fields of each update
      --purge page|space|none   what to drop from the cache (default page),
                  reported per CDN
      --json      one summary: created, updated, unchanged, trashed, purged,
                  verify, diffUrl (the run is recorded; publish.completed fires)
      Pages edited in the studio since the last publish are not overwritten
      without --force.   Full reference: forumulate publish --help
  sync <folder>                      Content as code: the same folder publish,
                                     PLAN BY DEFAULT. Posts (blog), pages
                                     (docs, custom, legal), FAQ questions,
                                     changelog releases and blog categories,
                                     matched by slug; images uploaded once by
                                     content hash; README, LICENSE, _drafts/,
                                     dotfiles skipped. Guide:
                                     https://forumulate.com/guides/content-as-code
      --apply     write the plan (then read it back)
      --prune     also remove what has no file (to the trash)
      --diff      print the changed paragraphs and fields of each update
      --org, --space, --only, --force, --no-verify, --pace, --manifest, --json
                  as for publish
  plan [forumulate.yaml]             The whole site as one document (version: 2):
                                     spaces and their SEO, languages, front doors,
                                     contact form and About parts, Markdown pages
                                     with locale twins, redirects, sites. Prints
                                     the diff; writes nothing. --check exits 1
                                     when it is not empty. Full reference:
                                     forumulate plan --help
  apply [forumulate.yaml]            Carry that plan out, idempotently, every
                                     write read back; --prune also removes what
                                     the manifest wrote and no longer declares
  check links [folder]               Broken internal links, #anchors, pictures and
                                     (--external) outside links in a folder, before
                                     publishing; exit 1 when any is broken
      --space <s> [--org <o>]        the same report for a published space
      --allow-redirect <hosts>       --ignore <text>   --json
  publish <folder> --preview <name>  Send the change to a preview link instead of
                                     publishing it (--comment posts it on the PR)
  publish <orgId> <spaceId> <pageId> (deprecated) Publish a page — use items publish
  publish <orgId> <spaceId> <dir>    (deprecated) — use publish <dir> --org --space
  domains <orgId> <spaceId>          List this space's domains and their state
  domains verify <orgId> <spaceId> <hostname>
                                     Re-run verification and say what is missing
  snapshot <orgId> <spaceId> <label> Create a space version snapshot
  content types --library <id|slug>  TypeScript for a content library's model:
                                     collections, globals, the block union
      [--org <id|slug>] [--out forumulate.d.ts] [--preview] [--schema <file>]
      [--check]   fail (exit 1) when the file is out of date, write nothing
  content pull --library <id|slug>   Write the model to forumulate.content.json
      [--format json|payload] [--out <file>]   (payload: forumulate.payload.ts)
  content push [file]                Show the diff against the library, then
                                     apply it as a new model version
      [--library …] [--dry-run] [--yes] [--force]
      [--rename type.field=new | block:hero.field=new | library:field=new]
      [--rename-type old=new] [--rename-block old=new]
  import <payload|contentful|sanity|strapi|wordpress> <export path>
                                     Bring another CMS's content into a library:
                                     model, media, entries, references (always
                                     shows a dry run first)
                                     Re-running updates entries a
                                     previous import made. strapi takes a
                                     folder or an unencrypted export .tar.gz
      --library <id|slug> [--org …] [--dry-run] [--yes]
      [--config payload.config.ts]   (payload) the config that becomes the model
      [--publish source|all|none]    what to publish (default: what was live)
      [--allow-model-removals] [--pace <ms>] [--base-url <url>] (strapi uploads)
  translations (alias i18n)          Every translation capability, one vocabulary
      locales list|add|relabel|remove|set   a space's (--space) or library's
                  (--library) languages; set es=Español fr [--prune] is exact
      status      each piece × language: missing/draft/published/outdated
                  [--locale es,fr] [--fail-on missing,outdated] (exit 1)
      pull        one Markdown file per piece per language → [--out translations]
                  [--locale …] [--only slug,…] [--include-missing] (stubs)
      push [dir]  diff the files against the API, write what changed [--dry-run]
      auto        machine-translate with YOUR DeepL/AI key --locale es
                  [--state missing,outdated] [--only …] [--force] [--publish]
                  [--library … --entry id,…] [--dry-run]
      labels pull|push [file]       chrome words (--site <id> | --space …)
      overrides pull|push [file]    org UI string overrides [--prune]
                  [--format json|xliff] for labels and overrides
      item-locale <itemId> <locale|none>  correct a piece's declared language
      remove <pieceId> <locale>     one translation (--yes)
      entry <entryId> <locale>      a library entry's twin [--fields f.json]
      name <locale> <name…>         a space's (or --collection's) name
      switcher get|set <f.json>     the org's reader language switcher
      provider status|connect|disconnect   your DeepL key (DEEPL_API_KEY)
  conformance <collectionUrl>        Run the Content Sync Protocol suite against
                                     any platform's collection endpoint
  validate [dir]                     Check forumulate.yaml, front matter and $schema
                                     files against the published schemas, with
                                     did-you-mean hints. --json; exit 2 if invalid
  doctor <readerUrl> | --site <s>    Check a live site from the outside: health,
                                     canonical on both addresses, sitemap, cache
                                     consistency, root redirect, descriptions,
                                     llms.txt, favicon, consent tag, white-label
                                     leaks. --json; exit 1 on any FAIL
  help [command]                     Show this help, or a command's own
                                     (every command also takes --help)

Environment:
  FORUMULATE_TOKEN   Personal Access Token (Bearer). Overrides a stored one, so
                     CI keeps working exactly as it did; --token overrides it.
                     Mint one at
                     https://forumulate.com/account/tokens
  FORUMULATE_URL     The site (default https://forumulate.com); the API is its
                     /api, i.e. https://forumulate.com/api. A value already
                     ending in /api is used as-is.
  FORUMULATE_API_URL Exact API base, for a local API with no /api prefix
                     (http://localhost:4000). Wins over FORUMULATE_URL.
  FORUMULATE_ORG, FORUMULATE_SPACE, FORUMULATE_LIBRARY
                     Defaults for --org, --space and --library; they beat
                     \`forumulate config set\`, a flag beats both.
  FORUMULATE_API_VERSION
                     Forumulate-Version for api/resource commands
                     (default 2026-12-01).

The SDK (ForumulateClient.fromEnv) and the MCP server (@forumulate/mcp) read
the same variables. Guide: https://forumulate.com/guides/api-tokens-and-scopes

Every FORUMULATE_* variable not listed above is reported (with the one you
probably meant) by \`forumulate whoami\` and on any authentication failure.

Flags:
  --json          Emit raw JSON instead of a formatted summary (stdout only;
                  progress and warnings go to stderr)
  --out <file>    Write stdout to a file (never truncated; non-zero exit if the
                  write fails). content/translations use --out for their own file
  --jsonl         With --paginate: one JSON row per line, streamed
  --token <pat>   The token for this run, on every command. Precedence:
                  --token, then FORUMULATE_TOKEN, then credentials.json. On an
                  operation with a \`token\` parameter of its own (registries
                  set, github connect, domains acme-challenge) the flag is that
                  parameter; set FORUMULATE_TOKEN for the PAT there
  --dry-run       (api, resources) print the request instead of sending it
  --dry-run       Plan the work and write nothing (publish of a directory)
  --version       Print the CLI version

Exit status:
  0 ok   1 failed (verification mismatch, doctor FAIL)   2 usage
  3 auth (no token, 401, token not allowed)   4 not found
  5 conflict (409/412, edited in the studio since your last publish)
`;
