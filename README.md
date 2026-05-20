# kast-action

Install Kast CLI and headless backend in GitHub Actions and headless agent sessions.

## Usage

```yaml
steps:
  - uses: amichne/kast-action@v1
    with:
      version: v1.2.3

  - run: kast --help
```

## Enterprise and GHES mirrors

For runners without public egress, mirror both this action and the headless
bundle. Do not rely on `latest` inside enterprise workflows; pin the version
and checksum.

```yaml
steps:
  - uses: aexp-mirror/kast-action@v1
    with:
      version: v1.2.3
      bundle-url: https://github.aexp.com/<org>/<repo>/releases/download/v1.2.3/kast-headless-agent-v1.2.3-linux-x64.zip
      bundle-sha256: <sha256>
      skip-copilot-extension: true

  - run: kast --help
```

When `bundle-url` is set, the action:

- Downloads that exact URL.
- Requires and verifies `bundle-sha256` before extraction or cache writes.
- Requires `version` to be pinned.
- Skips GitHub.com release lookup and public asset URL construction.
- Uses a tool-cache key that includes `kast-headless-agent`, version, platform,
  and the checksum.

The `token` input is attached to an explicit `bundle-url` only when the URL
origin matches `$GITHUB_SERVER_URL`. Other mirror URLs must be reachable by the
runner without that token.

## Why Node.js?

This is a Node.js action (`runs.using: node20`), not a composite or Docker action.
Node.js actions work in GHA-compatible environments where Docker and composite
actions are unavailable.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `version` | `latest` | Kast release tag to install |
| `platform` | `linux-x64` | Headless bundle platform identifier |
| `bundle-url` | unset | Exact mirrored bundle URL; bypasses GitHub.com release lookup |
| `bundle-sha256` | unset | Expected SHA-256 for the downloaded bundle |
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
cache (`$RUNNER_TOOL_CACHE`). Public downloads are cached by action tool name,
version, and platform. Mirrored downloads with `bundle-sha256` are cached by
action tool name, version, platform, and checksum, so changing the checksum for
the same version forces a separate cache entry.

## Artifact model

Mirror these release assets for headless bootstrap:

| Asset | Purpose |
|-------|---------|
| `kast-headless-agent-vX.Y.Z-linux-x64.zip` | Self-contained headless agent bundle consumed by this action |
| `SHA256SUMS` | Public checksum source used to verify mirrored assets |

Do not substitute `kast-vX.Y.Z-*.zip` assets for the headless bundle. Those are
developer-machine Homebrew assets and are separate from the headless bootstrap
artifact consumed by this action.

## Runner requirements

The action and bundle installer expect these tools on the runner:

- `bash`
- `git`
- `python3`
- `curl`
- Java 21

## Mirror process

The public Kast release publishes the headless bundle and `SHA256SUMS`. Keep the
internal mirror job outside the public repository and make it perform these
steps for each pinned version:

```bash
set -euo pipefail

version="v1.2.3"
asset="kast-headless-agent-${version}-linux-x64.zip"
base_url="https://github.com/amichne/kast/releases/download/${version}"

curl -fsSLO "${base_url}/SHA256SUMS"
curl -fsSLO "${base_url}/${asset}"

sha256sum --check --ignore-missing SHA256SUMS

internal_sha256="$(sha256sum "${asset}" | awk '{print $1}')"
printf '%s  %s\n' "${internal_sha256}" "${asset}" > SHA256SUMS.internal

# Upload "${asset}" and SHA256SUMS.internal to the internal GHES release.
```

Enterprise default policy:

- Mirror both `kast-action` and `kast-headless-agent-vX.Y.Z-linux-x64.zip`.
- Allow no public egress from runners.
- Require pinned `version` and `bundle-sha256`.
- Set `skip-copilot-extension: true` unless repository mutation by setup action
  is approved.
