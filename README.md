# alchemy-deploy

Shared GitHub deployment automation for Bun/Alchemy Cloudflare Workers. It gates deployments on successful CI for the exact commit, isolates pull-request stages, records GitHub deployments, updates one durable preview comment, and destroys previews before deleting their deployment records.

## Consumer setup

1. Copy `templates/consumer-deploy.yml` to `.github/workflows/deploy.yml`.
2. Replace `worker-name`, commands, `production-stage`, `production-url`, and `use-adopt`. Set `worker-config` only when the consumer stack reads `ALCHEMY_WORKER_CONFIG`.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.
4. Ensure `.github/workflows/ci.yml` is named `CI`, runs for `push` and `pull_request`, and checks out the PR head SHA.
5. Replace `REPLACE_WITH_FULL_40_CHARACTER_RELEASE_SHA` with the immutable full commit SHA behind a published `vX.Y.Z` release. Metadata validation permits this placeholder only inside `templates/`; it is never valid in an active workflow.

Commands receive `STAGE` as an environment variable. Keep quoting in the command itself:

```yaml
deploy-command: bunx --no-install alchemy deploy --stage "$STAGE" --yes
destroy-command: bunx --no-install alchemy destroy --stage "$STAGE" --yes
use-adopt: true
```

`preview-url-pattern` is a URL glob. It must contain `{worker}` and `{stage}`; `*` matches a single URL path segment. Its default matches Alchemy Worker URLs such as `https://worker-pr-42.account.workers.dev`.

## Security model

- Production runs only from a successful `workflow_run` for `production-branch`.
- Preview resolution runs trusted default-branch workflow code through `pull_request_target`, but only same-repository PRs qualify.
- The resolver polls the configured CI workflow for a completed successful run whose `head_sha` exactly equals the candidate SHA.
- Deployment checks out that exact SHA without persisted checkout credentials.
- Closed-PR cleanup checks out the trusted default branch, accepts only `pr-<positive integer>`, and never deletes GitHub deployment evidence unless Alchemy destroy succeeds.
- Cleanup is expected to be skipped during production and ordinary preview deployment runs because its explicit condition accepts only same-repository `pull_request.closed` events.
- Fork PRs run consumer CI but never receive deployment credentials.
- Same-repository PR code executes during preview deployment with Cloudflare credentials. Treat repository write access as secret-bearing access, use a narrowly scoped Cloudflare token, and protect a deployment environment with required reviewer approval when repository trust warrants it.
- Consumer commands are passed through environment variables rather than interpolated into generated shell source. Inputs are trusted repository configuration, not PR data.

## Deployment report action

`actions/deployment-report` requires Bun to be installed and supports `create`, `complete`, `comment`, and `cleanup`. Inputs are parsed before API calls. API failures preserve operation and HTTP status without exposing the token. Comment lookup and deployment cleanup paginate all GitHub results.

The caller grants `actions: read`, `contents: read`, `deployments: write`, and `pull-requests: write`; each called job narrows that set. Pass only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, never `secrets: inherit`.

The committed logo is `assets/alchemy.svg`; comments reference its immutable implementation commit.

## Development

```sh
bun install
bun run typecheck
bun test
bun run check
bun run validate:metadata
bun run validate:changesets
```

Releases use Changesets. The initial changeset promotes `0.0.0` to `1.0.0`, and the release workflow opens the version pull request. When that PR merges, the workflow detects the package version change, creates an immutable `vX.Y.Z` tag at the merge commit, and creates the matching GitHub Release. Existing matching tags/releases are reused; a tag pointing at another commit fails the workflow. Mutable major tags such as `v1` are not created or maintained.

To upgrade a consumer, review the release notes, resolve the release tag to its full 40-character commit SHA, replace the workflow/action pin, and run the consumer's complete local and GitHub Actions checks. Never pin a consumer to a branch, mutable alias, abbreviated SHA, or unmerged commit.

## Action pins

Third-party Actions are pinned to verified commit SHAs resolved from their upstream Git tags:

| Action              | Version  | SHA                                        | Source                      |
| ------------------- | -------- | ------------------------------------------ | --------------------------- |
| `actions/checkout`  | `v7.0.1` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | `actions/checkout` tag API  |
| `oven-sh/setup-bun` | `v2.0.2` | `735343b667d3e6f658f44d0eca948eb6282f2b76` | `oven-sh/setup-bun` tag API |
| `changesets/action` | `v1.5.3` | `e0145edc7d9d8679003495b11f87bd8ef63c0cba` | `changesets/action` tag API |
