# alchemy-deploy

Deploy [Alchemy](https://alchemy.run/) Cloudflare Workers from GitHub Actions with:

- Exact-commit CI gating for production and pull-request previews
- GitHub Deployment records with Cloudflare dashboard links
- One durable preview comment per pull request
- Automatic preview cleanup when a pull request closes

The root action is the recommended integration. Production commands run from the exact trusted production commit. PR previews use a prebuilt CI artifact and this action's pinned Alchemy runtime to create a first-class Worker Preview.

PR preview deployment does not check out or execute pull-request-controlled Alchemy configuration. Build the Worker in CI without Cloudflare or GitHub write credentials, then upload its complete, runtime-ready bundle as an Actions artifact. The trusted action downloads that artifact from the exact successful CI run and Alchemy uploads its bytes with `bundle: false`. The bundle itself is untrusted code and runs on Cloudflare once deployed; it never runs in the credentialed deployment process. Fork PRs remain ineligible for privileged deployment.

## Usage

Copy [`templates/consumer-deploy.yml`](templates/consumer-deploy.yml) to `.github/workflows/deploy.yml`, then replace the example values:

```yaml
name: Deploy

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
  pull_request:
    types: [closed]

jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: alchemy-deploy-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.event.workflow_run.event == 'pull_request' && format('pr-{0}', github.event.workflow_run.pull_requests[0].number) || github.event.workflow_run.event == 'push' && 'prod' || 'invalid' }}
      cancel-in-progress: false
    permissions:
      actions: read
      contents: read
      deployments: write
      pull-requests: write
    steps:
      - name: Run Alchemy deployment
        uses: mynameistito/alchemy-deploy@<full-release-sha> # v3.0.0
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

The `CI` workflow must be named `CI`, run for `push` and `pull_request`, check out the pull request head SHA, and upload the built Worker bundle as an artifact before succeeding. Keep the triggers, permissions, and environment-based concurrency from the template.

Production commands receive the stage in `STAGE`. PR Preview deploy and cleanup use the trusted action-owned stack and the `pr-<number>` stage; they never run consumer commands.

Add an upload step after the credential-free Worker build in CI. Adjust `path` and `preview-entrypoint` to the output of the project's bundler:

```yaml
- name: Upload Worker Preview bundle
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
  with:
    name: alchemy-worker
    path: path/to/built-worker/
    if-no-files-found: error
```

Upload every runtime module needed by the bundle. Do not upload Alchemy stack files or build scripts, and do not rely on executing a post-download build. Alchemy beta.79 reads the prebuilt files as bytes and uses `preview: { of: <production-worker> }`.

Add these repository secrets:

| Secret | Description |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | A narrowly scoped Cloudflare API token that can deploy and destroy the Worker. |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns the Worker. |

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `worker-name` | Yes |  | Base Cloudflare Worker name. |
| `deploy-command` | Yes |  | Trusted production deploy command. It must use `$STAGE` to select the stage. |
| `destroy-command` | Yes |  | Retained for compatibility; first-class Preview cleanup uses the trusted Alchemy stack. |
| `production-url` | Yes |  | Canonical HTTPS URL for the production deployment. |
| `production-stage` | No | `prod` | Alchemy stage reserved for production. |
| `use-adopt` | No | `false` | Append `--adopt` to the deploy command. |
| `worker-config` | No |  | Optional JSON object of environment bindings for the trusted Preview stack. |
| `preview-artifact` | No | `alchemy-worker` | CI artifact name containing the complete Worker bundle. |
| `preview-entrypoint` | No | `index.js` | Entrypoint path relative to the artifact root; it must resolve to a regular file inside the artifact. |
| `preview-compatibility-date` | No |  | Compatibility date to use for the Preview Worker; set it to the production Worker’s date. |
| `preview-compatibility-flags` | No | `[]` | JSON array of compatibility flags to use for the Preview Worker. |
| `preview-url-pattern` | No | `https://{stage}-{worker}.*.workers.dev` | URL glob for the Preview URL. It must contain `{worker}` and `{stage}`. First-class Preview URLs use stage-worker ordering. `*` matches one URL path segment. |
| `ci-workflow` | No | `ci.yml` | CI workflow file used for exact-SHA gating. |
| `production-branch` | No | `main` | Branch allowed to deploy production. |
| `install-command` | No | `bun install --frozen-lockfile` | Frozen Bun dependency installation command. |
| `reconcile` | No | `false` | Destroy previews whose pull request is no longer open. Run it from a scheduled job so a missed `pull_request: closed` event cannot leave a preview Worker serving. |

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

A scheduled reconcile needs `actions: read`, `contents: read`, `deployments: write`, and `pull-requests: read`.

Preview cleanup runs on the `pull_request: closed` event, so it is skipped whenever that run does not execute or fails, for example when a Dependabot-sourced run receives no Cloudflare credentials. Add a nightly reconcile job so those previews are still destroyed:

```yaml
on:
  schedule:
    - cron: "23 4 * * *"

jobs:
  reconcile:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      deployments: write
      pull-requests: read
    steps:
      - name: Reconcile preview deployments
        uses: mynameistito/alchemy-deploy@<full-release-sha>
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          worker-name: <worker-name>
          deploy-command: bunx --no-install alchemy deploy --stage "$STAGE" --yes
          destroy-command: bunx --no-install alchemy destroy --stage "$STAGE" --yes
          reconcile: true
          production-url: https://<worker>.example.com
```

The reconcile finds this action's Preview records, resolves each pull request, and deletes only the matching first-class Preview when the pull request is closed. Stages whose pull request is still open, or whose lookup failed, are left untouched. Destroying a Preview does not destroy its parent production Worker.

## How It Works

- Production deploys run only from a successful `workflow_run` for `production-branch`.
- Preview deploys run from trusted default-branch action code through `workflow_run` and only for open, same-repository pull requests. The action downloads the artifact from the exact successful CI run and does not check out the PR commit.
- Before deploying, the action finds a successful CI run whose `head_sha` exactly matches the candidate commit.
- Production checks out the exact trusted production commit with checkout credentials removed. PR previews consume only the opaque artifact from the exact CI run.
- A successful preview is reported in one durable pull request comment, including the deployment and Cloudflare log links.
- Closing a same-repository pull request destroys its `pr-<number>` stage before the related GitHub Deployment records are deleted.
- A scheduled reconcile destroys any `pr-<number>` stage whose pull request is closed but whose cleanup never ran, then deletes the leftover GitHub Deployment records.
- Fork pull requests can run consumer CI but never receive deployment credentials or preview deployments.

## Security

The PR artifact is untrusted input. The trusted action validates that the selected entrypoint remains a regular file inside the artifact, and Alchemy reads the bundle with `bundle: false` without evaluating it in the credentialed deployment process. Keep CI builds credential-free. The deployed Worker runs on Cloudflare, so configure its bindings deliberately. Worker Preview service bindings may still target production services; use a separate Alchemy stage when the whole infrastructure environment must be isolated.

## Worker Preview semantics

This integration uses Alchemy `2.0.0-beta.79`, including [Alchemy PR #1563](https://github.com/alchemy-run/alchemy/pull/1563). That release models branch/PR Previews as first-class resources: the trusted stack declares `preview: { of: parentWorker }`, updates the Preview named by the PR stage, and destroys that Preview without deleting or routing traffic to its production parent.

Do not treat every Alchemy `version` as a PR Preview:

- Use `preview.of` for a named branch/PR Preview with its own URL and isolated same-Worker Durable Object state.
- Use `version.parent` with `version.traffic` for a canary or gradual rollout of the parent Worker.
- Use `version.traffic: 0` when uploading a Worker version without routing production traffic.

Previews are not a full multi-service stage: service bindings may still resolve to production Workers, and production routes, crons, and queue consumers remain attached to the parent. Keep a separate Alchemy stage when the PR needs isolated databases, services, or other infrastructure. Previews are public unless the parent is protected; custom-domain Preview URLs require `domain: { name, previews: true }` on the parent and Cloudflare private-beta availability.

The action passes configured commands through environment variables instead of interpolating them into generated shell source. PR-controlled source, build scripts, and Alchemy configuration are never run with Cloudflare or GitHub write credentials. API failures preserve the operation and HTTP status without exposing tokens.

## Pinning Releases

Consumers should pin the action to the full 40-character commit SHA of a published release:

```yaml
uses: mynameistito/alchemy-deploy@<full-release-sha> # v2.2.0
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
