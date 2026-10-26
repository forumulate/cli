import { VALIDATE_HELP } from './validate';
import { DOCTOR_HELP } from './doctor/command';
import { EXIT_CODES_HELP } from './exit-codes';
import { WHOAMI_HELP } from './whoami';
import { CACHE_HELP } from './cache-command';
// `forumulate check links` — its help lives beside the command it documents.
import { CHECK_HELP as CHECK_LINKS_HELP } from './check/command';

/**
 * Each top-level command's own `--help` (FMU-B14).
 *
 * `publish --help` and `doctor --help` printed the global help — a page about
 * everything, saying almost nothing about the command asked for: not every
 * flag, not the `forumulate.yaml` keys, not the exit codes, no example. The
 * resource groups always printed their own; these are the commands that did
 * not. `help-commands.test.ts` walks every top-level command and fails when one
 * falls back to the global page again.
 */
const OUTPUT = `Output (every command):
  --json          the result as JSON on stdout; progress and warnings go to stderr
  --out <file>    write stdout to a file instead (never truncated, exit 1 if the write fails)`;

export const PUBLISH_HELP = `forumulate publish — publish a folder of Markdown into a space

Usage:
  forumulate publish <folder> --org <id|slug> --space <id|slug> [flags]

  (org: and space: may come from forumulate.yaml, FORUMULATE_ORG / FORUMULATE_SPACE
  or \`forumulate config set\` instead of the flags.)

  One folder per collection, front matter for titles, slugs, order and SEO, assets
  uploaded once by content hash. A re-run changes only what changed, then reads the
  space back and fails if anything did not land.

Flags:
  --dry-run          print the plan; write nothing (no token needed for a public space)
  --prune            move pages/posts/collections with no file to the trash
  --only a,b         just these slugs, files, folders, or manifest parts
                     (site, theme, settings, openapi, monitors)
  --force            re-send every page even if it looks unchanged, AND overwrite pages
                     edited in the studio since the last publish
  --purge page|space|none
                     what to drop from the cache when done (default page): page = every
                     page this run changed; space = the whole space (a title in the
                     navigation changed); none = leave the CDN alone. Reported per CDN.
  --no-verify        skip the read-back           --pace <ms> gap between writes (250)
  --manifest <file>  a forumulate.yaml somewhere else
  --diff             print the changed paragraphs and fields of each update
  --no-report        do not record this run (publish.completed is not sent)
  --json             one JSON summary: {space, created, updated, unchanged, trashed,
                     purged, verify, diffUrl, runId, lines, errors}
  --out <file>       write that output to a file
  --preview <name>   publish nothing: send the pages this run would add or change (and
                     with --prune, remove) to a preview named <name> (pr-123) and print
                     its link — the space as the change would publish it, on its own
                     addresses, for 7 days (previews.ttl_days). Same name again: same
                     link, renewed. --json adds previews[{urls, summary, comment}].
  --preview-ttl <d>  a shorter life for the preview link, in days
  --comment          with --preview in CI: post the link and diff table on the pull
                     request (GitHub, Gitea, GitLab, Bitbucket; GITHUB_TOKEN /
                     GITEA_TOKEN / GITLAB_TOKEN / BITBUCKET_TOKEN), editing it on re-runs

Studio edits: a page edited in the studio (or through the API) since this folder was
last published is not overwritten. The run stops before writing and prints
  CONFLICT <slug> edited in studio by <name> at <time>
Pull the change into the file, or re-run with --force to overwrite it.

forumulate.yaml keys:
  org, space            where to publish (one space), or
  spaces: [{path, space, create: {type, name, visibility}, rootCollection,
            theme, settings, tags, openapi: [{file|url, collection, ...}], monitors,
            redirects: [{from, to, status?, type?}] or a CSV file name,
                        redirects are merged into the space's table, never replaced
            about: {...} | about.yaml (an ABOUT space's parts)}]
  site: {...}           the site configuration (applied with PATCH semantics)
  theme: {...}          the space theme
  Guide: https://forumulate.com/guides/content-as-code

Older forms (deprecated; they print a notice on stderr):
  publish <orgId> <spaceId> <folder>   → publish <folder> --org … --space …
  publish <orgId> <spaceId> <pageId>   → forumulate items publish <pageId> --space …

Examples:
  forumulate publish docs --org acme --space docs --dry-run
  forumulate publish docs --org acme --space docs --purge space --json --out run.json
  forumulate publish docs --org acme --space docs --preview pr-123 --comment

${OUTPUT}

${EXIT_CODES_HELP}`;

export const SYNC_HELP = `forumulate sync — the same folder publish, plan by default

Usage:
  forumulate sync <folder> [--apply] [--prune] [--diff] [--org …] [--space …]

  Without --apply it plans and writes nothing; with --apply it is \`publish\`.
  Takes every publish flag (--only, --force, --purge, --no-verify, --pace,
  --manifest, --json). See \`forumulate publish --help\` for them and the
  forumulate.yaml keys.

${OUTPUT}

${EXIT_CODES_HELP}`;

export const PLAN_HELP = `forumulate plan / forumulate apply — one document for a whole site

Usage:
  forumulate plan  [forumulate.yaml] [--org <id|slug>] [--diff] [--check] [--prune] [--verbose]
  forumulate apply [forumulate.yaml] [--org <id|slug>] [--prune] [--batch <n>] [--verbose]

  Reads a version-2 forumulate.yaml and the Markdown folders it names, and sends it to
  PUT /orgs/{org}/manifest: plan is the dry run (the diff, nothing written), apply
  writes it. Every unit goes through the endpoint that owns it, is read back after the
  write, and is recorded, so a re-apply of the same files writes nothing and a page
  edited in the studio since the last apply shows as drift.

Flags:
  --org <o>        the organization (else \`org:\` in the file, else FORUMULATE_ORG)
  --diff           plan: print each changed field, from -> to
  --check          plan: exit 1 when anything would change (drift detection in CI)
  --prune          also delete what this manifest created earlier and no longer
                   declares — only for the kinds the file declares (pages go to the trash)
  --batch <n>      apply: changed pages per request (default 20; the edge cuts a request at 30 s)
  --verbose        list unchanged steps and everything left alone
  --json           the API's answer (plan) or {ok, batches} (apply)

forumulate.yaml (version: 2):
  version: 2
  org: acme
  spaces:  [{slug, name, type, visibility, settings, theme, redirects, collections,
            locales: [{code, label}], seo: {...}, translations: {<code>: {name,
            description, seoTitle, seoDescription}}, preset, piecePreset, frontDoor,
            contactForm: {...} | file.yaml (CONTACT), about: {...} | file.yaml (ABOUT)}]
  pages:   [{dir: content/docs, space: docs, collection?, locales?}  a Markdown folder:
            page.md + page.es.md or es/page.md twins; front matter title, slug,
            seoTitle, seoDescription, canonicalUrl, sections, collection, order
            (or a 01- prefix), draft; sub-folders are collections
            | {space, slug, title, body, ...}]                         or one page inline
  sites:   [{slug, name, spaces: [slugs], config: {...}, configMode: merge|replace}]
  domains, reader_auth, consent, connectors, executor, webhooks, status_monitors,
  brand, prune — as PUT /orgs/{org}/manifest documents them.
  Guide: https://forumulate.com/guides/forumulate-yaml-apply

Examples:
  forumulate plan --diff
  forumulate plan --check            # CI: fail when the site drifted from the repository
  forumulate apply --prune

${OUTPUT}

${EXIT_CODES_HELP}`;

export const DEV_HELP = `forumulate dev — preview a folder of Markdown locally

Usage:
  forumulate dev <folder> --org <id|slug> --space <id|slug> [--port 4321] [--site <url>]

  Renders with your space's own renderer and reloads on save. Nothing is written
  to the space.

${EXIT_CODES_HELP}`;

export const LOGIN_HELP = `forumulate login — store a token for this API

Usage:
  forumulate login [--token <pat>]      (asks for it, hidden, when not given)

  The token is checked against the API first, then stored in
  ~/.config/forumulate/credentials.json (mode 0600), keyed by API base, so a
  staging token is never sent to production. On every later command a
  --token beats FORUMULATE_TOKEN, which beats the stored token.
  Mint a token at https://forumulate.com/account/tokens

${EXIT_CODES_HELP}`;

export const LOGOUT_HELP = `forumulate logout — forget the stored token for this API

Usage:
  forumulate logout

  Warns when FORUMULATE_TOKEN is still set, because it still wins.

${EXIT_CODES_HELP}`;

export const SNAPSHOT_HELP = `forumulate snapshot — save a version snapshot of a space

Usage:
  forumulate snapshot <orgId> <spaceId> <label…> [--json]
  (also: forumulate snapshots --help)

${EXIT_CODES_HELP}`;

export const CONFORMANCE_HELP = `forumulate conformance — run the Content Sync Protocol suite

Usage:
  forumulate conformance <collectionUrl> [--json]

  Runs against any platform's collection endpoint, ours included. Exit 1 when a
  check fails.

${EXIT_CODES_HELP}`;

export const CONTENT_HELP = `forumulate content — a content library's model as code

Usage:
  forumulate content types --library <id|slug> [--org …] [--out forumulate.d.ts]
                           [--preview] [--schema <file>] [--check]
  forumulate content pull --library <id|slug> [--format json|payload] [--out <file>]
  forumulate content push [file] [--library …] [--dry-run] [--yes] [--force]
      [--rename type.field=new | block:hero.field=new | library:field=new]
      [--rename-type old=new] [--rename-block old=new]

  Here --out names the file the command writes (not a stdout redirect).

${EXIT_CODES_HELP}`;

export const IMPORT_HELP = `forumulate import — bring another CMS's content into a library

Usage:
  forumulate import <payload|contentful|sanity|strapi|wordpress> <export path>
      --library <id|slug> [--org …] [--dry-run] [--yes]
      [--config payload.config.ts] [--publish source|all|none]
      [--allow-model-removals] [--pace <ms>] [--base-url <url>]

  Always shows a dry run first; a re-run updates what a previous import made.

${OUTPUT}

${EXIT_CODES_HELP}`;

export const TRANSLATIONS_HELP = `forumulate translations (alias i18n) — every translation capability

Usage:
  forumulate translations locales list|add|relabel|remove|set [--space …|--library …]
  forumulate translations status [--locale es,fr] [--fail-on missing,outdated]
  forumulate translations pull [--out translations] [--locale …] [--only …]
  forumulate translations push [dir] [--dry-run]
  forumulate translations auto --locale es [--state missing,outdated] [--publish]
  forumulate translations labels|overrides pull|push [file] [--format json|xliff]
  forumulate translations item-locale <itemId> <locale|none>
  forumulate translations remove <pieceId> <locale> --yes
  forumulate translations entry <entryId> <locale> [--fields f.json]
  forumulate translations name <locale> <name…>
  forumulate translations switcher get|set <f.json>
  forumulate translations provider status|connect|disconnect

  Here --out names the folder or file the command writes.

${EXIT_CODES_HELP}`;

/** The command → its own help. A command missing here prints the global help. */
export const COMMAND_HELP: Readonly<Record<string, string>> = {
  publish: PUBLISH_HELP,
  sync: SYNC_HELP,
  dev: DEV_HELP,
  doctor: DOCTOR_HELP,
  validate: VALIDATE_HELP,
  login: LOGIN_HELP,
  logout: LOGOUT_HELP,
  whoami: WHOAMI_HELP,
  auth: WHOAMI_HELP,
  cache: CACHE_HELP,
  snapshot: SNAPSHOT_HELP,
  conformance: CONFORMANCE_HELP,
  content: CONTENT_HELP,
  import: IMPORT_HELP,
  translations: TRANSLATIONS_HELP,
  i18n: TRANSLATIONS_HELP,
  check: CHECK_LINKS_HELP,
  plan: PLAN_HELP,
  apply: PLAN_HELP,
};
