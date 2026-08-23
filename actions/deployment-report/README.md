# Deployment Report Action

The composite action manages GitHub Deployment records and durable pull request comments for an Alchemy deployment.

Install Bun before invoking the action and pin the action to a released full 40-character commit SHA.

```yaml
- uses: mynameistito/alchemy-deploy/actions/deployment-report@<full-40-character-release-sha> # v1.0.0
  env:
    GITHUB_TOKEN: ${{ github.token }}
  with:
    mode: create
    stage: prod
    production-stage: prod
    worker-name: example-worker
    deployment-sha: ${{ github.sha }}
```

Supported modes are `create`, `complete`, `comment`, and `cleanup`. `complete` requires a deployment ID, outcome, and logs URL. `comment` requires a pull request number, outcome, and logs URL. `cleanup` rejects production and malformed preview stages, marks every matching deployment inactive, and then deletes each record.

Grant only the permission required by the selected mode: `deployments: write` for `create`, `complete`, and `cleanup`; `pull-requests: write` for `comment`.
