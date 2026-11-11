# Setup Kast

This action installs a digest-pinned Kast archive on Linux x86_64.
The archive contains Control, the Host, bundled JBR, and the runtime for Kotlin analysis and Gradle import.
Kast's installer creates the private installation.
The action exports `kast` and `kast-task` for later steps.

## GitHub Actions

Use a Linux x86_64 runner with Node 24, Python 3.12 or 3.13 on `PATH`, and core OS tools.
Supply the URL, SHA-256 digest, and version of a complete Linux archive.
Use a short, canonical root that the runner user can create.
Keep that root at its original path.

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: amichne/kast-action@ACTION_COMMIT_SHA
    with:
      version: '0.0.0'
      artifact-url: ${{ vars.KAST_COMPOSED_BUNDLE_URL }}
      artifact-sha256: ${{ vars.KAST_COMPOSED_BUNDLE_SHA256 }}
      install-dir: /tmp/kast
  - run: kast --version
  - run: kast-task "$(pwd -P)" -- kast workspace wait --wait 180000
```

Replace `ACTION_COMMIT_SHA` with the reviewed immutable action revision.
Replace `0.0.0` with the archive's exact version.
Kast rejects an existing destination.
For an upgrade, install the new archive into a new short root.

## Devin environment blueprint

Use a Linux x86_64 image that supplies system Python 3.12 or 3.13.
Devin accepts Node 24 actions in `initialize` and `post-build`.
Use shell commands in `maintenance`.
The action reference needs the `github.com/` prefix and an explicit revision.
[Devin blueprint reference](https://docs.devin.ai/onboard-devin/environment/blueprint-reference)

The example uses a placeholder URL and a fixed root.
Replace the action revision, archive URL, digest, and both version values.
If the runner user cannot create `/opt/kast`, use the same short writable root in both phases.
[Blueprint example](examples/devin-blueprint.yaml)

```yaml
# Replace ACTION_COMMIT_SHA, both versions, the artifact URL, and BUNDLE_SHA256.
initialize:
  - name: Install Kast with system Python
    uses: github.com/amichne/kast-action@ACTION_COMMIT_SHA
    with:
      version: '0.0.0'
      artifact-url: https://ARTIFACT_HOST/kast-composed-setup-v0.0.0-linux-x86_64.tar.gz
      artifact-sha256: BUNDLE_SHA256
      install-dir: /opt/kast

knowledge:
  - name: Kast task workspace
    contents: |
      Run each Kast command through kast-task from the root of the actual checkout.
      Use kast-task "$(pwd -P)" -- kast followed by the required Kast arguments.

# Full and differential builds run maintenance. Inherited snapshots skip initialize.
maintenance: |
  set -eu
  test -x /opt/kast/bin/kast-task
  kast_version=$(/opt/kast/bin/kast --version)
  test "$kast_version" = '0.0.0'
  printf '%s\n' \
    'export KAST_INSTALL_ROOT=/opt/kast' \
    'export PATH="/opt/kast/bin:$PATH"' >> "${ENVRC:?Devin must provide ENVRC}"
```

Devin resets `$ENVRC` before each build.
An inherited differential build skips `initialize`.
Maintenance runs a passive version check and restores discovery for the two commands.
The reusable installation starts with no workspace grant or running Host.
Maintenance preserves that state and leaves the session's `HOME` and `JAVA_HOME` in place.

After the actual checkout exists, use `kast-task` from its root.
The command grants trust to the exact workspace and runs the requested command in the private environment.
Workspace trust permits Gradle build code to run.
The first request that needs the Host starts it.

```sh
kast-task "$(pwd -P)" -- kast workspace wait --wait 180000
```

To qualify a snapshot, use the same archive in a separate disposable installation and a disposable fixture workspace.
Run a compiler query in a fresh session from a full build.
Repeat it in a fresh session from an inherited differential build.
Record the archive digest, build and session identifiers, workspace identity, and query result for each case.
Use the reusable root only for passive discovery checks during the builds.

## Standalone Linux installation

Run the same adapter from a reviewed checkout.

```sh
python3 -I bin/install-kast \
  --version 0.0.0 \
  --artifact-url file:///tmp/kast-composed-setup.tar.gz \
  --artifact-sha256 BUNDLE_SHA256 \
  --install-dir /opt/kast
/opt/kast/bin/kast --version
```

The adapter uses the standard library and dispatches the archive's `zipapp` with the same Python interpreter.
Use the installed commands by absolute path or add their directory to `PATH`.

## Inputs and results

| Input | Meaning |
| --- | --- |
| `version` | Exact numeric Kast version, without a `v` prefix. |
| `artifact-url` | HTTPS, HTTP, or local file URL for the complete Linux archive. |
| `artifact-sha256` | SHA-256 digest of the complete archive. |
| `install-dir` | New canonical root. The default is `/opt/kast`. |
| `authorization-header` | Optional authorization value for the HTTPS artifact origin. Redirects to another origin lose this header. |
| `download-timeout-ms` | Download timeout from 1,000 through 1,800,000 milliseconds. The default is 600,000. |

The action authenticates the archive before it dispatches the installer.
Kast owns runtime file admission, root identity, and workspace trust.
The action emits `kast-command`, `kast-task-command`, and `install-root`.
Its installation result reports `semanticReadiness: NOT_RUN`.
A real compiler query establishes semantic readiness for the named workspace.

## Development and evidence

```sh
mise exec -- npm ci
mise exec -- npm run lint
mise exec -- npm test
mise exec -- uv run --locked ruff check .
mise exec -- uv run --locked ruff format --check .
mise exec -- uv run --locked pyright
mise exec -- uv run --locked pytest -q
```

Commit `dist/index.js` after a TypeScript change.
The fixtures cover Node signal delivery, Python dispatch, archive rejection, provider exports, and restored discovery after `$ENVRC` resets.
Native Host behavior needs evidence from the actual archive.
Live Devin qualification needs a full-build session and an inherited differential-build session.
