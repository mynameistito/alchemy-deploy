# Changelog

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
