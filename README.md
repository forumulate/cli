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

The token is stored per API in `~/.config/forumulate/credentials.json`, readable only by you. In CI, set `FORUMULATE_TOKEN` instead; it always wins over a stored token.

| Variable             | Default                  | Meaning                                                                          |
| -------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `FORUMULATE_TOKEN`   | stored token             | Personal Access Token.                                                           |
| `FORUMULATE_URL`     | `https://forumulate.com` | The site. The API is its `/api`. A value already ending in `/api` is used as-is. |
| `FORUMULATE_API_URL` | none                     | Exact API base, for a local API with no `/api` prefix (`http://localhost:4000`). |

The SDK (`ForumulateClient.fromEnv()`) and the MCP server ([`@forumulate/mcp`](https://www.npmjs.com/package/@forumulate/mcp)) read the same variables, so one environment configures all three.

## Quickstart

```sh
forumulate orgs                      # id  slug  name
forumulate spaces acme               # an org id or its slug
forumulate items acme <spaceId>      # what is in a space, and where its content lives
```

## Common tasks

**1. Publish a folder of markdown (docs-as-code).** Each `.md` file becomes a page; its slug comes from front matter or the file name. Existing pages with the same slug are updated, new ones are created, and both are published. Pages with no file are reported and left alone.

```sh
forumulate publish acme <spaceId> ./docs --dry-run   # show the plan, write nothing
forumulate publish acme <spaceId> ./docs
```

**2. Publish one page by id.**

```sh
forumulate publish acme <spaceId> <pageId>
```

**3. Search docs, forum and blog together.**

```sh
forumulate search acme rate limits
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

Add `--json` to any command for raw JSON, `--version` for the version, and `forumulate help` for the full list. Every command exits non-zero on failure, so it works in a pipeline.

### In CI

```yaml
# GitHub Actions
- run: npx -y @forumulate/cli publish acme ${{ vars.DOCS_SPACE_ID }} ./docs
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
