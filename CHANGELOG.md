# Changelog

## 3.2.0

### Minor Changes

- c28e5ca: Support explicit preprovisioned KV, D1 and Secrets Store references in trusted Worker Previews.
- 19dfb17: Add opt-in native Worker Preview rate-limit bindings.
- 960e0b7: Add an optional preview-only secret string map that deploys values as Cloudflare secret bindings.

  Clear alternate GitHub/1Password bootstrap and preview-input aliases from consumer subprocesses.

  Add opt-in preprovisioned HTTP state for trusted Preview deployment and cleanup, with origin-pinned authenticated transport.

### Patch Changes

- 6fe4532: Keep the 1Password bootstrap token out of action steps and consumer commands.

## 3.1.8

### Patch Changes

- 90e6d8e: Allow protected callers to deploy explicitly approved fork preview commits and pass independently resolved pull request numbers.

## 3.1.7

### Patch Changes

- c55d26d: Update the pinned artifact download action used for isolated Worker Preview artifacts.

## 3.1.6

### Patch Changes

- 56153e3: Update the deployment preview runtime for Alchemy v2 beta.84 and current stable Effect 4 packages. Import Cloudflare resources from the dedicated `@alchemy.run/cloudflare` package.

## 3.1.5

### Patch Changes

- b1db061: Update Alchemy and runtime dependencies.

## 3.1.4

### Patch Changes

- 93f233a: Use Node 24-compatible artifact actions for PR previews: `actions/download-artifact` v8 in the action and `actions/upload-artifact` v7 in the consumer example. They require Actions runner v2.327.1 or newer; GitHub-hosted runners already meet this requirement.

## 3.1.3

### Patch Changes

- a205af0: Update the trusted Alchemy runtime to beta.80 and align its Effect dependencies with stable Effect 4.

## 3.1.2

### Patch Changes

- d4981ca: Expose the trusted Worker Preview artifact helper through package exports and install its compatible Node platform runtime.

## 3.1.1

### Patch Changes

- 41fa5b0: Align the bundled Alchemy CLI with the Effect CLI and Bun platform APIs it imports at runtime.
- 9dfbf0f: Run the Alchemy CLI smoke test from an isolated temporary directory.

## 3.1.0

### Minor Changes

- 7f89ef9: Allow Worker Preview artifacts to include a validated static asset directory and pass its routing configuration to Alchemy.

## 3.0.0

### Major Changes

- 35199af: Deploy PR Worker Previews from credential-free CI artifacts using Alchemy 2.0.0-beta.79 and first-class `preview.of` resources. PR-controlled build output is no longer executed by the privileged deployment job. Consumers must upload a complete Worker bundle from CI and configure its artifact name and entrypoint.

### Patch Changes

- 654ea3a: Fix lint findings and update development dependencies.

## 2.4.0

### Minor Changes

- fcdf99d: Add a scheduled preview reconcile that destroys preview stages whose pull request is no longer open, so a missed `pull_request: closed` event cannot leave a preview Worker serving after its pull request closed.

### Patch Changes

- ab5a3c6: Ignore deployment records this action did not create when resolving the deploy policy and preview cleanup.
- 2dfde87: Retry one Alchemy deployment when the Cloudflare State Store returns HTTP 500 during planning.

## 2.3.2

### Patch Changes

- aed01de: Support cleaning up fork pull-request previews from the base repository context.

## 2.3.1

### Patch Changes

- 1e7eb24: Keep policy resolution independent of the consumer workspace and terminally report deployments when link resolution fails.

## 2.3.0

### Minor Changes

- f6c8de4: Run deployment URL and Cloudflare logs link resolution through the tested TypeScript action runtime instead of duplicated shell parsing.
- 4f14e4e: Run deployment policy resolution through the TypeScript action runtime boundary instead of duplicated shell policy logic.

### Patch Changes

- 0fa367c: Verify published action runtime paths and release gates locally.
- 9e7ad9f: Clean documented action contracts and remove a stale GitHub adapter comment.
- d010fa5: Isolate privileged deployment execution and scope preview cleanup by worker identity.
- 5566084: Provision reproducible Bun runtimes and action-local dependencies for both composite actions.
- 301566a: Keep final deployment freshness checks on the TypeScript runtime path and add composite-action contract coverage.
- afc9ec3: Move deployment lifecycle sequencing behind a typed TypeScript orchestration boundary while preserving consumer command semantics.

## 2.2.0

### Minor Changes

- cadcc6a: Harden preview and production deployment gating by resolving pull requests from trusted workflow runs, validating exact head SHAs, isolating preview concurrency, and preventing duplicate deployment identities.

## 2.1.2

### Patch Changes

- f7f56de: Allow preview deployments after successful pull-request workflow runs without exposing secrets through `pull_request_target`.

## 2.1.1

### Patch Changes

- ed54102: Standardize internal `src` imports on the `@/*` alias and parse external GitHub, YAML, and Changesets data at their boundaries.
- 822629b: Upgrade the Changesets CLI used to validate and release package metadata.
- 2b6a28a: Upgrade the pinned GitHub Actions used by CI, release, deployment, and the composite action, while reading the Bun runtime from `package.json`.
- ae59975: Upgrade the YAML parser used by repository metadata validation.

## 2.1.0

### Minor Changes

- 1efd140: Run same-repository preview deployments from trusted workflow-run events instead of pull-request-target events.

## 2.0.2

### Patch Changes

- d7b2556: Trim quoted Alchemy output URLs before matching the configured preview URL pattern.

## 2.0.1

### Patch Changes

- 8a40eda: Fix preview URL extraction in the Marketplace action so successful Alchemy deploys complete reporting and preview comments.

## 2.0.0

### Major Changes

- b9605d8: Redesign the root Marketplace action to own the complete single-job Alchemy deployment lifecycle. Consumers now invoke the action directly with an immutable release SHA while retaining workflow triggers, permissions, concurrency, and explicit secret mapping.

## 1.0.1

### Patch Changes

- f6c77a9: Keep Cloudflare preview log links within the comment job so GitHub does not suppress them as secret-bearing job outputs.

## 1.0.0

### Major Changes

- fb35c7b: Release the secure Alchemy deployment workflow and deployment-report action.

### Patch Changes

- 3c0b08b: Recognize generated Changesets version commits during release validation.

All notable changes use [Changesets](https://github.com/changesets/changesets).
