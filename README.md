# kast-action

Install a prebuilt Kast Linux x64 headless runtime and optional Gradle
read-only dependency cache in GitHub Actions, Devin blueprints, and mirrored
ephemeral workspaces.

## Usage

```yaml
steps:
  - uses: actions/setup-java@v5
    with:
      java-version: "21"
      distribution: "temurin"

  - name: Install artifact decompression tools
    run: |
      if ! command -v zstd >/dev/null 2>&1; then
        sudo apt-get update
        sudo apt-get install -y --no-install-recommends zstd
      fi

  - uses: amichne/kast-action@v1
    with:
      version: "1.2.3"
      artifact-url: "$KAST_HEADLESS_URL"
      artifact-sha256: "$KAST_HEADLESS_SHA256"
      manifest-url: "$KAST_RUNTIME_MANIFEST_URL"
      install-dir: /opt/kast

  - run: kast --version
```

The action writes `KAST_HOME`, `KAST_CACHE_HOME`, and `KAST_CONFIG_HOME` to
`GITHUB_ENV`, and adds the installed `bin` directory to `GITHUB_PATH`.

## Devin and Marketplace Mirrors

Devin blueprints use the GitHub Action URL form:

```yaml
initialize:
  - name: Install Kast headless runtime
    uses: github.com/amichne/kast-action@v1
    with:
      version: "1.2.3"
      artifact-url: "$KAST_HEADLESS_URL"
      artifact-sha256: "$KAST_HEADLESS_SHA256"
      manifest-url: "$KAST_RUNTIME_MANIFEST_URL"
      gradle-ro-cache-url: "$KAST_GRADLE_RO_CACHE_URL"
      gradle-ro-cache-sha256: "$KAST_GRADLE_RO_CACHE_SHA256"
      fail-on-cache-miss: "true"
      install-dir: /opt/kast
```

For mirrored environments, mirror both this action repository and the release
artifacts consumed by the action:

- `kast-headless-linux-x64.tar.zst`
- `kast-runtime-manifest.json`
- `gradle-ro-dep-cache.tar.zst`, when using the optional Gradle cache

Pin the action mirror to a tag or commit and keep runtime artifact checksums
strict. The action never prints full HTTP artifact URLs, so signed URL query
parameters stay out of failure logs.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | yes | | Kast semver path segment, such as `1.2.3` or `v1.2.3` |
| `artifact-url` | yes | | `file://`, absolute path, HTTP, or HTTPS URL for `kast-headless-linux-x64.tar.zst` |
| `artifact-sha256` | yes | | SHA-256 digest for the runtime archive |
| `manifest-url` | no | | Sidecar `kast-runtime-manifest.json`; omit only when the archive already contains the manifest |
| `authorization-header` | no | | Default HTTP `Authorization` header for all downloads |
| `artifact-authorization-header` | no | | Runtime archive header override |
| `manifest-authorization-header` | no | | Manifest header override |
| `install-dir` | no | `/opt/kast` | Managed install root |
| `gradle-ro-cache-url` | no | | URL for `gradle-ro-dep-cache.tar.zst` |
| `gradle-ro-cache-sha256` | no | | SHA-256 digest for the Gradle cache archive |
| `gradle-ro-cache-authorization-header` | no | | Gradle cache header override |
| `fail-on-cache-miss` | no | `false` | Fail when the optional Gradle cache cannot be installed |
| `strict` | no | `true` | Fail when `kast doctor` exits non-zero |
| `download-attempts` | no | `3` | Download retry count, range `1..10` |
| `download-retry-delay-ms` | no | `1000` | Delay between download attempts |
| `download-timeout-ms` | no | `120000` | Per-attempt HTTP timeout |

## Runtime Contract

The runtime archive must contain regular files for:

- `bin/kast`
- `lib/runtime-libs/classpath.txt`
- `idea/modules/module-descriptors.dat`
- an `idea/` directory

The action rejects unsafe archive paths, symbolic links, unsupported archive
member types, checksum mismatches, manifest/archive digest mismatches, and
runtime manifests outside schema version `1`.

The optional Gradle cache archive must contain `gradle-ro/modules-2` at the
archive root. The action rejects lock files, Gradle GC metadata, unsafe archive
paths, symbolic links, and unsupported archive member types before publishing
the cache.

## Development

```bash
npm ci
npm run lint
npm test
npm run test:fixtures
```

The fixture test covers successful install, retries, checksum failures, unsafe
archives, invalid manifests, unsupported platforms, Gradle cache handling,
strict `kast doctor` rollback, and log redaction for signed artifact URLs.
