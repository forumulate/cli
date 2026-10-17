/** `forumulate help`. The resource groups print their own (`forumulate spaces --help`). */
export const HELP = `forumulate — Forumulate command-line interface

Usage:
  forumulate <command> [args]

Commands:
  login [--token <pat>]              Store a token for this API, so every other
                                     command stops needing FORUMULATE_TOKEN in
                                     the environment
  logout                             Forget the stored token
  whoami                             Show the authenticated user
  config set|get|unset|list          Defaults: org, space, library, api-version
                                     (\`forumulate config set org acme\`)

Every API operation:
  api list [--tag t] [--search w]    Discover operations and their summaries
  api describe <operationId>         Parameters and body schema, as flags
  api <operationId> [args] [flags]   Call it: --<param> value, --data @f.json,
  api <METHOD> <path> [flags]        --field a.b=v, --paginate, --json

Resources (each: <group> --help lists its verbs and the operation each calls):
  Org:      orgs | members | invites | groups | roles | service-accounts (bots)
            tokens (pats) | webhooks | extensions | audit
  Spaces:   spaces | snapshots | shape | domains | assets | space-types (types)
  Docs:     items (pages) | docs | collections | versions | change-requests (crs)
            openapi | sdks | github (git)
  Content:  blog | forum | changelog | roadmap | status | events | course
            careers | forms   (blog/forum/changelog/status: translations …)
  CMS:      libraries | entries | media | releases | environments (envs)
  Site:     theme | sites | reader
  search <query...> [--org]          e.g. spaces create Docs --slug docs --type DOCS
                                          items create --space docs --file a.md --publish
                                          docs schedule set <pageId> <when> --space docs
                                          webhooks deliveries <id>; webhooks replay <id> <d>
      --out <file>  where a file answer goes (SDK archive, PDF, CSV export)
  completion bash|zsh|fish           Shell completion script

Older forms, unchanged:
  orgs                               List your organizations
  spaces <orgId>                     List spaces in an org
  items <orgId> <spaceId>            List what is in a space, with where each
                                     piece's content lives
  search <orgId> <query...>          Unified search across docs/forum/blog
  publish <folder>                   Publish a folder of Markdown: one folder per
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
  publish <orgId> <spaceId> <pageId> Publish a page
  publish <orgId> <spaceId> <dir>    The folder form, with org and space given
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
  doctor <readerUrl>                 Check a live site from the outside: health,
                                     public read, canonical, cache headers,
                                     crawler access, feeds, HTML rewriting
  help                               Show this help

Environment:
  FORUMULATE_TOKEN   Personal Access Token (Bearer). Overrides a stored one, so
                     CI keeps working exactly as it did. Mint one at
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

Flags:
  --json          Emit raw JSON instead of a formatted summary
  --dry-run       (api, resources) print the request instead of sending it
  --dry-run       Plan the work and write nothing (publish of a directory)
  --version       Print the CLI version
`;
