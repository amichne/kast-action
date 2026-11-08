# Setup Kast

This action installs a digest-pinned composed Kast distribution on Linux x86_64.
The distribution contains the selected IntelliJ modules, Kotlin analysis, Gradle import, bundled JBR, Host, and Control.
The action delegates installation to Kast's bundled installer.
It adds the private `kast` wrapper to `PATH` for later steps.

This revision replaces the retired daemon-based action.
Historical tags keep their original behavior.
The new contract needs an explicit composed bundle URL, SHA-256 digest, and numeric version.
A released composed bundle is not yet available.
Use a qualified local bundle or an authenticated artifact URL until release publication.

## GitHub Actions

The runner needs Linux x86_64, Python 3.12 or 3.13, and a writable, new installation root.
The bundle includes Java and the native Kast components.
The action does not need an existing IntelliJ installation.

```yaml
steps:
  - uses: actions/checkout@v5
  - uses: actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0 # v7.1.0
    with:
      python-version: '3.12'
  - uses: amichne/kast-action@COMMIT_SHA
    with:
      version: '0.0.0'
      artifact-url: ${{ vars.KAST_COMPOSED_BUNDLE_URL }}
      artifact-sha256: ${{ vars.KAST_COMPOSED_BUNDLE_SHA256 }}
      install-dir: /opt/kast
      trust-workspace: ${{ github.workspace }}
  - run: kast --version
```

Replace `COMMIT_SHA` with the reviewed immutable action revision.
Choose a root that the runner user can create without `sudo`.
Keep the root short because the native Host uses Unix sockets.
An existing installation rejects without replacement.
For an upgrade, install into another short root and explicitly select that wrapper.

## Devin environment blueprint

Devin supports Node 24 actions in `initialize` and `post-build`, not `maintenance`.
Its action reference needs the `github.com/` prefix and an explicit revision.
See the [Devin blueprint reference](https://docs.devin.ai/onboard-devin/environment/blueprint-reference).
Use [the complete example](examples/devin-blueprint.yaml):

```yaml
# Replace the version (in both phases), artifact URL, and BUNDLE_SHA256 before use.
initialize:
  - name: Install Python
    uses: github.com/actions/setup-python@6d4fd22b20465ccc0f7354476588e8df7c9ca0e0
    with:
      python-version: '3.12'
  - name: Install Kast
    uses: github.com/amichne/kast-action@8367b18717ff6b016df8acd815f55ce77e7a28e5
    with:
      version: '0.0.0'
      artifact-url: https://ARTIFACT_HOST/kast-composed-setup-v0.0.0-linux-x86_64.tar.gz
      artifact-sha256: BUNDLE_SHA256
      install-dir: /opt/kast

# Runs on full and differential builds; inherited snapshots skip initialize.
maintenance: |
  set -eu
  test -f /opt/kast/.kast-headless-owned
  test -x /opt/kast/bin/kast
  kast_version=$(/opt/kast/bin/kast --version)
  test "$kast_version" = '0.0.0'
  printf '%s\n' \
    'export KAST_INSTALL_ROOT=/opt/kast' \
    'export PATH="/opt/kast/bin:$PATH"' >> "${ENVRC:?Devin must provide ENVRC}"
```

The action pin is the existing immutable installer revision, not an unpublished maintenance implementation.
Replace the artifact URL, digest, and version with qualified inputs; keep the version in both phases identical.
Kast's separate release pipeline will produce the versioned bundle and checksum.
Coordinate the filename `kast-composed-setup-vVERSION-linux-x86_64.tar.gz` there.
The placeholder URL above does not claim that an asset has been published.

Devin snapshots the installed files, but resets `$ENVRC` at the start of every build.
Inherited differential builds skip `initialize` and run only `maintenance`.
The action's environment additions from the parent build therefore cannot provide discovery in the next build.
The self-contained maintenance shell checks the existing ownership marker, executable wrapper, and expected version, then appends exports to the current `$ENVRC`.
Those exports preserve the existing `PATH` and make `kast` discoverable to subsequent steps and the resulting session.
They change neither `HOME` nor `JAVA_HOME`.
Maintenance does not download, reinstall, upgrade, start the Host, or grant workspace trust.
It needs neither Python nor the action checkout and works when `KAST_INSTALL_ROOT` is initially unset.
Missing installations, failed version checks, and missing or unwritable `$ENVRC` fail the build rather than silently skipping setup.
To change `/opt/kast`, update every installation and maintenance path together and retain a short root.
Use a new root for an upgrade; rebuild the snapshot from scratch if its installation is absent or invalid.
Maintenance commands are surfaced, not automatically executed, at session start.

The example leaves workspace trust unset because a repository can arrive after the snapshot phase.
After the repository exists, use the standalone installer with `--trust-workspace` and a new root for repository-specific setup.
Trust applies only to the named repository in that installation's private IntelliJ profile.
Repository trust permits Gradle build code to run.
A version response does not establish semantic readiness.

## Standalone Linux installation

The same maintained Python bootstrap works outside an action runner.
From a reviewed checkout of this repository, run:

```sh
bin/install-kast \
  --version 0.0.0 \
  --artifact-url file:///tmp/kast-composed-setup.tar.gz \
  --artifact-sha256 BUNDLE_SHA256 \
  --install-dir /opt/kast \
  --trust-workspace /path/to/repository
/opt/kast/bin/kast --version
```

Python 3.12 or 3.13 is necessary.
The bootstrap has no third-party Python dependencies.
For the pinned development procedure, use `mise exec -- uv run --locked --script bin/install-kast --help`.
Outside Actions, select the wrapper by its absolute path or add its directory to `PATH`.

## Inputs and results

| Input | Meaning |
| --- | --- |
| `version` | Exact numeric Kast version, without a `v` prefix. |
| `artifact-url` | HTTPS, HTTP, or local file URL for a `KAST_COMPOSED_SETUP_V1` bundle. |
| `artifact-sha256` | SHA-256 digest of the complete archive. |
| `install-dir` | New canonical root. The default is `/opt/kast`. |
| `trust-workspace` | Optional existing canonical repository root that the caller explicitly trusts. |
| `authorization-header` | Optional authorization value for the artifact origin. Redirects to another origin lose this header. |
| `download-timeout-ms` | Download timeout from 1,000 through 1,800,000 milliseconds. The default is 600,000. |

The action emits `kast-command` and `install-root` outputs.
Its JSON result marks semantic readiness as `NOT_RUN`.
Installation checks the native version command but does not start the Host.
The first semantic request starts the Host and imports the selected repository.
Use a real compiler query to establish semantic readiness for the workspace.

The installer authenticates the archive before it extracts bootstrap code.
The bundled installer then authenticates the archive again and examines every recorded runtime file.
Changed bytes, unsafe archive paths, unsupported hosts, retired inputs, and existing destinations reject.
The original donor digest remains separate from the composed bundle digest in the installation receipts.

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
The Python cases exercise admission, authenticated bootstrap dispatch, rejection, exports, and authorization routing.
The blueprint cases execute its maintenance shell with a fixture wrapper, reset `$ENVRC` between builds, and verify discovery in a fresh shell.
They also check that rejected snapshot state preserves existing exports and installation bytes.
Their fake bundle does not prove native Host behavior.
Kast's [Linux composition report](https://github.com/amichne/kast/blob/feature/linux-composed-host/docs/reviews/linux-composed-install.md) records the separate native corpus.
No live Devin machine result exists in this revision.
