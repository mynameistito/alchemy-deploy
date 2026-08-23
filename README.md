# alchemy-deploy

Deploy [Alchemy](https://alchemy.run/) Cloudflare Workers from GitHub Actions with:

- Exact-commit CI gating for production and pull-request previews
- GitHub Deployment records with Cloudflare dashboard links
- One durable preview comment per pull request
- Automatic preview cleanup when a pull request closes

The root action is the recommended integration. It runs the consumer's Alchemy commands, so it works with the project's existing Bun configuration.

## Usage

Copy [`templates/consumer-deploy.yml`](templates/consumer-deploy.yml) to `.github/workflows/deploy.yml`, then replace the example values:

```yaml
name: Deploy

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  pull_request_target:
    types: [opened, reopened, synchronize]
  pull_request:
    types: [closed]

jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: alchemy-deploy-${{ github.event_name == 'workflow_run' && 'prod' || format('pr-{0}', github.event.pull_request.number) }}
      cancel-in-progress: false
    permissions:
      actions: read
      contents: read
      deployments: write
      pull-requests: write
    steps:
      - name: Run Alchemy deployment
        uses: mynameistito/alchemy-deploy@dd03a1f03fceabd097c929783947dd82fdcddc72 # v2.1.1
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          worker-name: my-worker
          deploy-command: bunx --no-install alchemy deploy --stage "$STAGE" --yes
          destroy-command: bunx --no-install alchemy destroy --stage "$STAGE" --yes
          production-stage: prod
          production-url: https://my-worker.example.com
          use-adopt: false
```

The `CI` workflow must be named `CI`, run for `push` and `pull_request`, and check out the pull request head SHA. Keep the triggers, permissions, and environment-based concurrency from the template.

Commands receive the stage in the `STAGE` environment variable. Quote it inside each command as shown above. The action sets `STAGE` to the configured production stage for production and `pr-<number>` for previews.

Add these repository secrets:

| Secret | Description |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A narrowly scoped Cloudflare API token that can deploy and destroy the Worker. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns the Worker. |

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `worker-name` | Yes |  | Base Cloudflare Worker name. |
| `deploy-command` | Yes |  | Alchemy deploy command. It must use `$STAGE` to select the stage. |
| `destroy-command` | Yes |  | Alchemy destroy command for preview cleanup. It must use `$STAGE`. |
| `production-url` | Yes |  | Canonical HTTPS URL for the production deployment. |
| `production-stage` | No | `prod` | Alchemy stage reserved for production. |
| `use-adopt` | No | `false` | Append `--adopt` to the deploy command. |
| `worker-config` | No |  | Optional value passed as `ALCHEMY_WORKER_CONFIG`. |
| `preview-url-pattern` | No | `https://{worker}-{stage}.*.workers.dev` | URL glob used to find the preview URL in deploy output. It must contain `{worker}` and `{stage}`. `*` matches one URL path segment. |
| `ci-workflow` | No | `ci.yml` | CI workflow file used for exact-SHA gating. |
| `production-branch` | No | `main` | Branch allowed to deploy production. |
| `install-command` | No | `bun install --frozen-lockfile` | Frozen Bun dependency installation command. |

## Permissions

The calling workflow must grant the action these permissions:

```yaml
permissions:
  actions: read
  contents: read
  deployments: write
  pull-requests: write
```

Composite actions cannot grant or reduce workflow permissions. Pass `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `GITHUB_TOKEN` explicitly as step environment values. Do not use `secrets: inherit`.

## How It Works

- Production deploys run only from a successful `workflow_run` for `production-branch`.
- Preview deploys run from trusted default-branch action code through `pull_request_target` and only for open, same-repository pull requests.
- Before deploying, the action finds a successful CI run whose `head_sha` exactly matches the candidate commit.
- The deployment checks out that exact commit with checkout credentials removed.
- A successful preview is reported in one durable pull request comment, including the deployment and Cloudflare log links.
- Closing a same-repository pull request destroys its `pr-<number>` stage before the related GitHub Deployment records are deleted.
- Fork pull requests can run consumer CI but never receive deployment credentials or preview deployments.

## Security

Same-repository pull request code runs during preview deployment with Cloudflare credentials. Treat repository write access as secret-bearing access, use a narrowly scoped Cloudflare token, and protect a deployment environment with required reviewers when repository trust warrants it.

The action passes configured commands through environment variables instead of interpolating them into generated shell source. Inputs are trusted repository configuration, not pull request data. API failures preserve the operation and HTTP status without exposing tokens.

## Pinning Releases

Consumers should pin the action to the full 40-character commit SHA of a published release:

```yaml
uses: mynameistito/alchemy-deploy@<full-release-sha> # v2.1.1
```

To upgrade, review the [release notes](https://github.com/mynameistito/alchemy-deploy/releases), resolve the release tag to its full commit SHA, replace the pin, and run the consumer's complete checks. Do not pin to a branch, mutable alias, abbreviated SHA, or unmerged commit.

## Development

```sh
bun install
bun run typecheck
bun test
bun run check
bun run validate:metadata
bun run validate:changesets
```

Run the complete validation suite with `bun run validate`. Releases use [Changesets](https://github.com/changesets/changesets): the release workflow opens the version pull request, then creates an immutable `vX.Y.Z` tag and matching GitHub Release after it merges. Mutable major tags such as `v1` are not maintained.

The reusable reporting implementation is also available under [`actions/deployment-report`](actions/deployment-report), but the root action is the consumer integration path.
