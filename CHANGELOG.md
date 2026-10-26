# Changelog

Releases of `@forumulate/cli`. Earlier versions are described in the git history of
`packages/cli` (`release(cli): …` commits).

## 0.11.0 (unreleased)

The output contract, the token named, and publishing that knows what it overwrites.

### Added (DX-D)

- `forumulate plan [forumulate.yaml]` / `forumulate apply`: one version-2 document for a
  whole site — spaces with their languages, SEO, translations, front door, contact form
  and About parts; Markdown folders as pages with locale twins (`page.es.md` or
  `es/page.md`; front matter `title`, `slug`, `seoTitle`, `seoDescription`,
  `canonicalUrl`, `sections`, `collection`, `order`); redirects; sites with their config
  and members. `plan` prints the diff (`--diff` field by field, `--check` exits 1 when it
  is not empty); `apply` writes it through `PUT /orgs/{org}/manifest?apply=true` in
  batches (`--batch`), every write read back; `--prune` removes only what the manifest
  wrote. Local images are uploaded once by content hash.

### Added (FMU wave 2c)

- `forumulate validate [dir]`: checks `forumulate.yaml`, every Markdown file's front matter
  and any file whose `$schema` names `https://forumulate.com/schemas/2026-12-01/<name>.json`,
  with did-you-mean hints (`footerColumns[].title` → `heading`). Exit 2 when invalid.
- `forumulate theme explain --space <s>`: the theme the reader renders and the layer behind
  every key (space, site, brand, org, look, default).
- `forumulate sites brand get|set|refresh|remove <siteId>`: a site's brand file.

### Fixed

- `--json` (and every output) piped into another program is no longer cut at 64 KiB /
  128 KiB. The CLI waits for stdout to drain, sets `process.exitCode`, and exits non-zero
  when a write fails (a full disk, a closed pipe).
- `publish --help`, `doctor --help` and every other top-level command print their own
  help (every flag, the `forumulate.yaml` keys, exit codes, an example) instead of the
  global page. `forumulate help <command>` prints the same.

### Added

- Documented exit codes: 0 ok, 1 failed (read-back mismatch, doctor FAIL), 2 usage,
  3 auth, 4 not found, 5 conflict.
- `--out <file>` on every command; `--jsonl` with `--paginate` streams one row per line.
- `whoami` shows the token source (`--token` › `FORUMULATE_TOKEN` › `credentials.json`),
  the PAT's id, name, last four characters, expiry, narrowing and the API base;
  `auth status --json` for scripts. Unknown `FORUMULATE_*` variables are named with a
  did-you-mean.
- `api list --refresh`: the live API's operation list (ETag-revalidated), used from then on;
  the footer says whether it counted the bundled or the live list.
- `publish --purge page|space|none` (default page), reported per CDN (`edge: none` when no
  CDN fronts the addresses); `--json` prints `{space, created, updated, unchanged, trashed,
  purged, verify, diffUrl}`; each run is recorded and fires `publish.completed`
  (`--no-report` to skip).
- `publish` refuses to overwrite pages edited in the studio since the last publish:
  `CONFLICT <slug> edited in studio by <name> at <time>`, exit 5; `--force` overwrites.
- `cache purge --space … [--page …]` / `--all-spaces`: drop cached copies, delete nothing.
- `spaces destroy` / `items destroy` (`--confirm <slug>`): delete a trashed space or page for
  good. `purge` remains as their old name.
- `spaces list --deleted true` shows `deletedAt` and `purgeAfter` (trash retention).
- `sites replace` prints the dry-run diff and asks before writing unless `--yes`.
- `openapi relabel <spec> --landing-slug … --landing-title … --landing-description …`.
- `doctor`: `canonical-both-addresses`, `sitemap-crawl`, `cache-consistency`,
  `root-redirect`, `meta-description`, `llms-txt`, `favicon`, `consent-tag` (any CMP) and
  `white-label-leaks`; `--site <slug>`, `--json`, exit 1 on any FAIL; a GitHub Action
  template in `examples/github-action-doctor.yml`.

### Deprecated

- `publish <orgId> <spaceId> <folder>` and `publish <orgId> <spaceId> <pageId>`: they still
  work and print the form to use instead on stderr. The one form is
  `publish <folder> --org … --space …`.
