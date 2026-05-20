# kast-action

Install Kast CLI and headless backend in GitHub Actions, Devin sessions, Blueprint declarations, and Copilot Cloud agents.

## Usage

```yaml
steps:
  - uses: amichne/kast-action@v1
    with:
      version: v1.2.3

  - run: kast --help
```

## Why Node.js?

This is a Node.js action (`runs.using: node20`), not a composite or Docker action.
Node.js actions work in all GHA-compatible environments including Devin Blueprint
declarative setups and Copilot Cloud agents where Docker and composite actions
are unavailable.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `version` | `latest` | Kast release tag to install |
| `install-root` | `$HOME/.kast-agent` | Installation root directory |
| `workspace` | `$GITHUB_WORKSPACE` | Git workspace for Copilot extension |
| `token` | `${{ github.token }}` | GitHub token for release downloads |
| `skip-copilot-extension` | `false` | Skip Copilot extension install |

## Outputs

| Output | Description |
|--------|-------------|
| `version` | Resolved Kast version |
| `install-root` | Installation root path |
| `kast-bin` | Absolute path to kast binary |

## Caching

Uses `@actions/tool-cache` to cache the downloaded bundle in the runner's tool
cache (`$RUNNER_TOOL_CACHE`). The bundle is downloaded once per version per
runner and reused across subsequent workflow runs on that runner.
