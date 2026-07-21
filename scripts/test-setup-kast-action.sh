#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
scratch_parent="${TMPDIR:-/tmp}"
scratch="$(mktemp -d "${scratch_parent%/}/kast-action-fixture.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

bundle="${scratch}/bundle"
mkdir -p "${bundle}/bin"
printf '{}\n' > "${bundle}/manifest.json"
cat > "${bundle}/bin/kast" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$1" == "setup" && "$2" == "--source" ]] || exit 2
printf '%s\n' "$*" > "$FIXTURE_LOG"
printf '%s\n' "$KAST_HOME" > "${FIXTURE_LOG}.kast-home"
mkdir -p "${KAST_HOME}/releases/fixture/bin"
cp "$0" "${KAST_HOME}/releases/fixture/bin/kast"
printf '{}\n' > "${KAST_HOME}/releases/fixture/receipt.json"
ln -s "${KAST_HOME}/releases/fixture" "${KAST_HOME}/current"
EOF
chmod 755 "${bundle}/bin/kast"

archive="${scratch}/kast-setup-bundle.tar.gz"
tar -czf "$archive" -C "$scratch" bundle
install_root="${scratch}/install"
github_env="${scratch}/github-env"
github_path="${scratch}/github-path"
fixture_log="${scratch}/setup.log"
: > "$github_env"
: > "$github_path"

RUNNER_OS=Linux \
RUNNER_ARCH=X64 \
INPUT_VERSION=v0.7.11-ci \
INPUT_ARTIFACT_URL="file://${archive}" \
INPUT_ARTIFACT_SHA256="$(compute_sha256 "$archive")" \
INPUT_INSTALL_DIR="$install_root" \
GITHUB_ENV="$github_env" \
GITHUB_PATH="$github_path" \
FIXTURE_LOG="$fixture_log" \
node "${repo_root}/dist/index.js"

grep -Fq 'setup --source ' "$fixture_log" || die "kast setup was not invoked"
[[ "$(cat "${fixture_log}.kast-home")" == "$install_root" ]] || die "setup received the wrong KAST_HOME"
[[ -L "${install_root}/current" ]] || die "setup did not publish current"
[[ -f "${install_root}/current/receipt.json" ]] || die "setup receipt is missing"
grep -Fqx "${install_root}/current/bin" "$github_path" || die "current/bin was not exported to PATH"
grep -Fqx "$install_root" "$github_env" || die "KAST_HOME did not preserve the install root"

printf '%s\n' 'setup-kast action fixture passed'
