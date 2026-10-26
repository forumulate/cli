# @forumulate/cli

The `forumulate` command: manage [Forumulate](https://forumulate.com) organizations, spaces and pages from a terminal or CI, publish a directory of markdown, and check a live site the way readers and crawlers see it. Built on [`@forumulate/sdk`](https://www.npmjs.com/package/@forumulate/sdk).

## Install

```sh
npm install -g @forumulate/cli
# or, without installing:
npx -y @forumulate/cli help
```

Node 20 or newer.

## Authenticate

Mint a Personal Access Token at **Account → Tokens** ([forumulate.com/account/tokens](https://forumulate.com/account/tokens)). Give it `read` + `write` to publish. [API tokens and scopes](https://forumulate.com/guides/api-tokens-and-scopes) explains the two gates a token passes.

```sh
forumulate login            # prompts for the token (not echoed), checks it, stores it
forumulate whoami
```

The token is stored per API in `~/.config/forumulate/credentials.json`, readable only by you. In CI, set `FORUMULATE_TOKEN` instead; it wins over a stored token. For one run, every command also takes `--token <pat>`, which wins over both: the precedence is `--token`, then `FORUMULATE_TOKEN`, then `credentials.json` (`forumulate whoami` prints which one it used). On the few operations with a `token` field of their own (`sdks registries set`, `github connect`, `domains acme-challenge`) `--token` is that field.

| Variable             | Default                  | Meaning                                                                          |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `FORUMULATE_TOKEN`   | stored token             | Personal Access Token.                                                           |
| `FORUMULATE_URL`     | `https://forumulate.com` | The site. The API is its `/api`. A value already ending in `/api` is used as-is. |
| `FORUMULATE_API_URL` | none                     | Exact API base, for a local API with no `/api` prefix (`http://localhost:4000`). |

The SDK (`ForumulateClient.fromEnv()`) and the MCP server ([`@forumulate/mcp`](https://www.npmjs.com/package/@forumulate/mcp)) read the same variables, so one environment configures all three.

## Quickstart

```sh
forumulate config set org acme       # the default for every --org
forumulate orgs list                 # id  slug  name
forumulate spaces list               # the spaces in acme
forumulate items list --space docs   # what is in a space, and where its content lives
forumulate api list --search webhook # every API operation, by summary
```

## Resource commands

Every group takes the same verbs (`list`, `get`, `create`, `update`, `delete`, and `publish` where a thing has a draft), the same scope flags (`--org`, `--space`, `--library`, each an id or a slug), and `--json` for the API's answer untouched. `forumulate <group> --help` lists a group's verbs and the operation each one calls.

| Group | Verbs |
| --- | --- |
| `orgs list\|get\|create\|update\|delete`, `orgs deepl status\|set\|clear`, `orgs strings list\|set\|remove` | Your organizations, their DeepL key, and their own wording for interface strings. |
| `members list\|update\|remove\|sign-out\|reassign` | People in an org. |
| `invites list\|create\|bulk\|revoke\|pending\|accept\|redeem\|join`, `invites links list\|create\|revoke` | Invitations you send (one, many, or a shareable link) and the ones waiting for you. |
| `groups …`, `roles …`, `service-accounts` / `bots` `… tokens list\|create\|revoke` | Groups and join requests, custom roles, and non-human members with their tokens. |
| `tokens` / `pats` `list\|scopes\|create\|rotate\|rename\|revoke` | Your personal access tokens, by id or by name. |
| `webhooks list\|events\|create\|update\|delete\|test\|rotate-secret\|deliveries\|replay` | Endpoints, their deliveries, and replays. |
| `extensions …`, `audit list\|actions\|export` | Installed extensions and the marketplace; the audit log (export as CSV). |
| `spaces list\|overview\|get\|create\|update\|delete\|restore\|purge\|duplicate\|move\|rename\|access\|preview`, `spaces slugs list\|forget` | Spaces in an org: slugs, moves, copies and the trash. |
| `snapshots list\|create\|restore\|delete`, `shape get\|set\|patch\|preset\|kinds …` | Space snapshots, and a space's shape override. |
| `items` / `pages` `list\|get\|content\|create\|update\|write\|section\|fields\|chunks\|verify\|publish\|delete` | Any piece in a space. `--file page.md` fills the body; front matter sets `title` and `slug`. |
| `docs list\|get\|save\|publish\|unpublish\|history\|diff\|rollback\|move\|duplicate\|…`, `docs schedule get\|set\|cancel`, `docs checkpoints …`, `docs trash …`, `docs import zip\|docx\|url\|files`, `docs locales …`, `docs search` | A docs space's pages: drafts, revisions, scheduled publishing, rollback, the trash, imports and languages. |
| `collections …`, `versions list\|create\|update\|default\|delete\|settings\|configure` | Collections and their page order; docs versions. |
| `change-requests` / `crs` `list\|open\|review\|approve\|merge\|close\|rebase\|comment\|…`, `crs reviewers …`, `crs rules get\|set` | Proposed docs changes, review and merge rules. |
| `openapi list\|register\|resync\|lint\|import\|generate\|…`, `openapi sdk languages\|get\|download` | OpenAPI specs behind reference pages, and the SDKs generated from them. |
| `sdks packages\|register\|publish\|publishes`, `sdks registries list\|set\|test\|remove` | Publishing those SDKs to package registries. |
| `blog`, `forum`, `changelog` `list\|get\|create\|update\|publish\|delete\|…` | Articles, topics and releases; scheduling, pinning, settings, flags, polls, replies. `create --file post.md --publish`. |
| `blog` / `forum` / `changelog` / `status` `translations list\|get\|put\|remove\|auto` | One piece's translations at its own door. `translations` (below) is the whole-space workflow. |
| `roadmap board\|get\|submit\|update\|status\|vote\|comment\|merge\|proxy-votes …` | A roadmap space. |
| `status board`, `status incidents …`, `status components …`, `status channels …`, `status groups get\|set` | A status space: incidents, components, where they are announced. |
| `events …`, `course outline\|enrol\|complete`, `careers …`, `forms …` | Events and RSVPs, course progress, job applications, forms and submissions (CSV export). |
| `libraries list\|get\|create\|update\|delete`, `libraries members\|locales\|model\|keys …` | Headless CMS libraries: grants, languages, the model, delivery keys. |
| `entries list\|types\|get\|create\|update\|fields\|patch\|publish\|bulk\|trash\|restore\|lock …\|locale get\|set` | A library's entries. |
| `media …`, `releases list\|create\|add\|schedule\|publish\|rollback\|…`, `environments` / `envs list\|fork\|compare\|promote` | Library media, content releases, and sandbox environments. |
| `domains list\|add\|setup\|verify\|activate\|www\|allow-ips\|redirect\|remove\|…`, `assets list\|all\|upload\|download\|delete` | Custom domains on a space (by id or hostname), and its uploaded files. |
| `theme get\|set\|patch\|export\|import`, `theme draft get\|set\|patch\|apply\|discard\|publish` | A space's theme: kept in git with `export`/`import`, staged as a draft, then published. |
| `sites …`, `sites domains …`, `sites theme export\|import`, `sites draft …` | Sites: several spaces under one domain and theme. |
| `github status\|connect\|import\|export\|pull-request` | Sync a docs space with a repository. |
| `reader page\|markdown\|pdf\|version`, `reader blog index\|article\|rss\|json-feed\|…` | What a reader is served, as the public API answers it (`--out` for a PDF or feed). |
| `space-types list\|get\|presets\|slots` | What each kind of space is. |
| `search <query…>`, `search semantic\|recent\|tags\|tag\|gaps\|reindex` | Unified search across docs, forum and blog, and the searches that found nothing. |

Flags are derived from the API itself: every query parameter of the operation (`--limit`, `--state`) and every top-level body field (`--name`, `--visibility`) is a flag, and `--data`/`--field` work as they do under `forumulate api`. A Markdown file with front matter fills an item, post, topic or release: `title` and `slug` come from the front matter unless you pass them.

```sh
forumulate spaces create Guides --slug guides --type DOCS --visibility PUBLIC
forumulate items create --space guides --file getting-started.md --publish
forumulate webhooks create https://hooks.example.com/f --events page.published,post.created
forumulate webhooks deliveries <webhookId> && forumulate webhooks replay <webhookId> <deliveryId>
forumulate tokens rotate ci-deploy --graceMinutes 60
forumulate status incidents create "API latency" --space status --severity minor
```

`delete`, `remove` and `revoke` ask first; `--yes` skips the question, and with no terminal (CI) `--yes` is required. `--dry-run` prints the request instead of sending it. A command whose answer is a file (an SDK archive, a PDF, a CSV export) writes it to `--out <file>`, and one that uploads (`assets upload`, `media upload`, `docs import zip`) takes the local path as its argument.

```sh
forumulate docs schedule set <pageId> 2026-11-01T09:00:00Z --space guides
forumulate docs rollback <pageId> <revisionId> --mode draft --space guides
forumulate crs open "Rate limits rewrite" --space guides && forumulate crs merge <crId> --space guides
forumulate openapi resync <specId> --space reference --background true
forumulate releases create "Spring launch" && forumulate releases schedule <releaseId> 2026-03-01T08:00:00Z
forumulate theme export --space docs --json > theme.json && forumulate theme import --space docs --data @theme.json
forumulate blog translations auto <postId> es --space blog
forumulate audit export --from 2026-10-01 --out audit.csv
```

## `forumulate api`: every operation

The resource commands cover the daily work. `forumulate api` covers the rest — every operation in the API, from a copy of the OpenAPI document bundled with the CLI.

```sh
forumulate api list --tag Webhook                 # operationId, method, path, summary
forumulate api describe Space_create              # parameters as flags, the body as fields
forumulate api Space_list acme --limit 20         # path params positionally…
forumulate api Space_get --orgId acme --spaceId <id>   # …or by name (--org-id works too)
forumulate api GET /orgs/{orgId}/members --paginate --json
forumulate api POST /orgs/acme/spaces --data @space.json
cat body.json | forumulate api Item_putContent acme <spaceId> <itemId> --data -
forumulate api Space_update acme <spaceId> --field settings.overview="Start here"
```

- **Parameters**: `--<name> value` for path, query and header parameters; a repeated flag is joined with commas (how every array parameter here is spelled). Path parameters may be positional, in path order; `orgId` defaults to `--org`, `FORUMULATE_ORG`, then `forumulate config`. `-p name=value` sets one whose name collides with a CLI flag.
- **Body**: `--data '{…}'`, `--data @file.json` or `--data -` (stdin), then `--field a.b=value` (typed by the body schema; `a:=<json>` for raw JSON), then any `--<field>` the body declares. Multipart operations take `--form name=value` and `--form file=@path`.
- **Output**: a list prints as a table with a footer saying whether there is more (`--cursor <next>`), a single resource as `key  value` lines; `--json` prints the body as received; `--paginate` follows `page.nextCursor` to the end and prints one merged list; `--columns a,b` picks table columns; `-i` adds the status and headers.
- **Transport**: `Forumulate-Version: 2026-12-01` on every request (`--api-version` or `forumulate config set api-version` to pin another), an `Idempotency-Key` on every write that declares one (the same key on a retry), and retries for a 429 (honouring `Retry-After`) and for a 502/503/504 on a request that is safe to repeat.
- **Exit status** is 0 on a 2xx and 1 on anything else, including a usage error, so it works in a pipeline.

A route newer than your copy of the CLI still works as `forumulate api <METHOD> <path>`; it is sent as written.

## Configuration and completion

```sh
forumulate config set org acme            # also: space, library, api-version
forumulate config list                    # value and where it came from
eval "$(forumulate completion zsh)"       # or bash; fish: forumulate completion fish > ~/.config/fish/completions/forumulate.fish
```

A flag beats the environment (`FORUMULATE_ORG`, `FORUMULATE_SPACE`, `FORUMULATE_LIBRARY`, `FORUMULATE_API_VERSION`), and the environment beats `~/.config/forumulate/config.json`. Completion covers commands, verbs, operationIds and each operation's flags.

## Common tasks

**1. Publish a folder of Markdown (docs-as-code).** One folder per collection, nested folders as parent pages, front matter for title, slug, description, icon, tags, order and any other page field, images uploaded, links rewritten. Blog and changelog folders become posts. Re-runs change only what changed; `--prune` removes what the folder no longer has; the space is read back afterwards. An optional `forumulate.yaml` sets the space's settings and theme, the site, an OpenAPI reference and status monitors. See [Publish a folder of Markdown from git](https://forumulate.com/guides/publish-from-git) and `examples/publish-docs.yml` for GitHub Actions.

```sh
forumulate publish ./docs --org acme --space docs --dry-run   # the plan (no token needed for a public space)
forumulate publish ./docs --org acme --space docs --prune
forumulate publish . --only getting-started,theme             # just these
```

**1b. Sync a folder (content as code).** `forumulate sync <folder>` is the same engine as a plan by default: `--apply` writes it, `--diff` shows what changes inside each post or page, `--prune` removes what has no file. A `forumulate.yml` maps folders to spaces: blog posts, docs pages, FAQ questions (with `short-answer:` and `related:` slots), changelog releases and blog categories (`tags:` in the manifest or `_tags.yml`: label, colour, cover, icon, parent). Matched by slug, images uploaded once by content hash, `README`/`LICENSE`/`_drafts/`/dotfiles skipped — and a second run writes nothing. See [Content as code](https://forumulate.com/guides/content-as-code).

```sh
forumulate sync .                   # the plan
forumulate sync . --diff            # the plan, with paragraph and field diffs
forumulate sync . --apply --prune   # do it, read it back
```

**2. Publish one page by id.**

```sh
forumulate items publish <pageId> --org acme --space docs
```

**3. Search docs, forum and blog together.**

```sh
forumulate search rate limits --org acme   # or, older form: forumulate search acme rate limits
```

**4. Snapshot a space before a big change.**

```sh
forumulate snapshot acme <spaceId> "Before the v2 migration"
```

**5. Check a custom domain.**

```sh
forumulate domains acme <spaceId>                         # each domain and its state
forumulate domains verify acme <spaceId> docs.acme.dev   # re-check, and print the DNS still missing
```

**6. Manage translations.** Use `forumulate translations`, or its alias `forumulate i18n`. It covers every translation capability: a space's or library's languages, coverage, a file round trip, machine translation with your own key, chrome labels, interface overrides, names and the switcher. See [Translations everywhere](https://forumulate.com/guides/translations-everywhere).

```sh
forumulate translations locales set es=Español fr --space docs     # declare exactly these
forumulate translations status --space docs --fail-on missing,outdated   # CI gate (exit 1)
forumulate translations pull --space docs --include-missing        # translations/<locale>/<slug>.md
forumulate translations push --space docs --dry-run                # the diff; drop --dry-run to apply
forumulate translations auto --space docs --locale es              # your DeepL key; missing + outdated
forumulate translations labels pull --space docs --format xliff    # for your TMS
forumulate translations overrides push overrides.json --prune
```

Add `--json` to any command for raw JSON, `--version` for the version, and `forumulate help` for the full list. Every command exits non-zero on failure, so it works in a pipeline. The older positional forms — `spaces <orgId>`, `items <orgId> <spaceId>`, `search <orgId> <query…>`, `domains [verify] <orgId> <spaceId>` — still work and print exactly what they did.

### In CI

```yaml
# GitHub Actions
- run: npx -y @forumulate/cli publish ./docs --org acme --space ${{ vars.DOCS_SPACE_ID }}
  env:
    FORUMULATE_TOKEN: ${{ secrets.FORUMULATE_TOKEN }}
- run: npx -y @forumulate/cli translations status --org acme --space docs --fail-on missing,outdated
  env:
    FORUMULATE_TOKEN: ${{ secrets.FORUMULATE_TOKEN }}
```

## `forumulate conformance`

Runs the Content Sync Protocol suite against a collection endpoint, ours or any other platform's:

```sh
forumulate conformance https://forumulate.com/api/orgs/acme/spaces/<spaceId>/items
```

## `forumulate doctor`

Check a live site from the outside, the way a reader and a crawler see it:

```sh
forumulate doctor https://your-domain.example.com/docs
```

It needs no token, because none of this is private. Each check is something
customers have found out about after their readers did:

| Check                | What a failure means                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health`             | The health endpoint answered something other than JSON. A plain-text 500 during a deploy reads as a permanent bug, so a careful client stops retrying a few-minute outage. On your own domain `/api` is yours, so the platform's mount is asked instead — `<section>/_api/health` for a path-mounted section, `/_api/health` for a domain that is the whole site — and only a mount that does not answer is reported as skipped. |
| `public-read`        | A logged-out reader is redirected to sign-in. Public docs behind a login are invisible to readers and to crawlers — and invisible from inside a signed-in session, which is why this is worth a command.                                                                                                                                                                                                                         |
| `canonical`          | The `rel=canonical` names another host. Search engines credit the canonical host, so a platform URL here hands your authority to the platform.                                                                                                                                                                                                                                                                                   |
| `html-untouched`     | Something in the path is rewriting your markup. Cloudflare's Email Obfuscation is the usual one: it injects a decoder script with no CSP nonce, so the script is refused and every address on the page renders as `[email protected]` with a dead link.                                                                                                                                                                          |
| `cache-headers`      | The document is served `no-store` or with no `Cache-Control`, so every reader pays full origin latency and a CDN in front of it does nothing.                                                                                                                                                                                                                                                                                    |
| `robots` / `sitemap` | `robots.txt` disallows the path, or names no sitemap. A `Disallow` here means the page is never indexed, however good it is. Only the `User-agent: *` group counts — a rule aimed at one named crawler is a deliberate choice.                                                                                                                                                                                                   |
| `crawler-access`     | A crawler gets a different status from a reader. A WAF rule or bot challenge that answers crawlers differently removes the site from search with nothing in any log to say so.                                                                                                                                                                                                                                                   |
| `feeds`              | No feed beside the page. Readers and aggregators look next to the content, not at an API URL.                                                                                                                                                                                                                                                                                                                                    |

Exit code is non-zero when anything failed, so it works in a deploy pipeline.
`--json` gives the full report. The checks speak plain HTTP and assume nothing
about the server, so pointing it at a staging mount — or at a competitor —
produces the same report: a doctor that only passes on its author's deployment
is a checklist with extra steps.

## Related

- [`@forumulate/sdk`](https://www.npmjs.com/package/@forumulate/sdk): the typed TypeScript client this CLI is built on.
- [`@forumulate/mcp`](https://www.npmjs.com/package/@forumulate/mcp): connect Claude, Cursor or VS Code to your organization.
- [API reference](https://forumulate.com/reference) · [Guides](https://forumulate.com/guides) · [Community](https://forumulate.com/community)

## License

MIT

---

## About this repository

This repository is a public mirror, refreshed on each Forumulate release
(one commit per release). Pull requests are welcome; accepted changes are
applied upstream and arrive here with the next release.

- API reference: https://forumulate.com/reference
- Guides: https://forumulate.com/guides
- Community and support: https://forumulate.com/community
- Source: https://github.com/forumulate/cli
