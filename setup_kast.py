"""Download an authenticated composed bundle and delegate its installation to Kast."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from http.client import HTTPMessage
from pathlib import Path
from typing import IO, Literal

INPUT_NAMES = (
    "version",
    "artifact-url",
    "artifact-sha256",
    "install-dir",
    "authorization-header",
    "download-timeout-ms",
    "trust-workspace",
)

BOOTSTRAP_FILES = frozenset(
    {
        "setup-kast/bin/setup-kast",
        "setup-kast/packaging/composed_bundle.py",
        "setup-kast/packaging/managed_headless.py",
    }
)


class Failure(StrEnum):
    INVALID_INPUT = "INVALID_INPUT"
    UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM"
    EXISTING_INSTALLATION = "EXISTING_INSTALLATION"
    DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
    CHECKSUM_MISMATCH = "CHECKSUM_MISMATCH"
    UNSAFE_BOOTSTRAP = "UNSAFE_BOOTSTRAP"
    INSTALLER_FAILED = "INSTALLER_FAILED"
    INSTALLED_COMMAND_REJECTED = "INSTALLED_COMMAND_REJECTED"
    EFFECT_FAILED = "EFFECT_FAILED"


@dataclass(frozen=True, slots=True)
class Rejected:
    reason: Failure
    stage: str
    type: Literal["rejected"] = field(default="rejected", init=False)


@dataclass(frozen=True, slots=True)
class _AdmittedSetup:
    url: str
    sha256: str
    root: Path
    version: str
    authorization: str
    timeout: int
    trust_workspace: Path | None


@dataclass(frozen=True, slots=True)
class _AuthenticatedArchive:
    path: Path
    sha256: str


@dataclass(frozen=True, slots=True)
class SetupInstalled:
    command: str
    root: str
    version: str
    bundleSha256: str
    type: Literal["installed"] = field(default="installed", init=False)
    semanticReadiness: Literal["NOT_RUN"] = field(default="NOT_RUN", init=False)


def admission(values: Mapping[str, str]) -> _AdmittedSetup | Rejected:
    if set(values) - set(INPUT_NAMES):
        return Rejected(Failure.INVALID_INPUT, "unknown or retired input")
    if any("\n" in value or "\r" in value or "\x00" in value for value in values.values()):
        return Rejected(Failure.INVALID_INPUT, "multiline input")
    version, url, digest = (
        values.get(name, "") for name in ("version", "artifact-url", "artifact-sha256")
    )
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or not re.fullmatch(
        "[a-f0-9]{64}", digest
    ):
        return Rejected(Failure.INVALID_INPUT, "version or digest")
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return Rejected(Failure.INVALID_INPUT, "artifact URL")
    if parsed.scheme not in {"https", "http", "file"} or (
        parsed.scheme == "file" and parsed.netloc not in {"", "localhost"}
    ):
        return Rejected(Failure.INVALID_INPUT, "artifact URL")
    root = Path(values.get("install-dir", "/opt/kast"))
    timeout = values.get("download-timeout-ms", "600000")
    if (
        not root.is_absolute()
        or root.resolve() != root
        or not timeout.isdecimal()
        or not 1000 <= int(timeout) <= 1_800_000
    ):
        return Rejected(Failure.INVALID_INPUT, "destination or timeout")
    # Native lifecycle sockets need a short, canonical destination.
    socket = root / "state/home/.kast/ide-lifecycle" / ("0" * 32) / "host.sock"
    if len(os.fsencode(socket)) > 100:
        return Rejected(Failure.INVALID_INPUT, "destination exceeds socket limit")
    trust_raw = values.get("trust-workspace", "")
    trust = Path(trust_raw) if trust_raw else None
    if trust is not None and (
        trust.resolve() != trust
        or not trust.is_dir()
        or root.is_relative_to(trust)
        or trust.is_relative_to(root)
    ):
        return Rejected(Failure.INVALID_INPUT, "trusted workspace")
    return _AdmittedSetup(
        url, digest, root, version, values.get("authorization-header", ""), int(timeout), trust
    )


class OriginRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: HTTPMessage,
        newurl: str,
    ) -> urllib.request.Request | None:
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and (
            urllib.parse.urlsplit(req.full_url)[:2] != urllib.parse.urlsplit(newurl)[:2]
        ):
            redirected.remove_header("Authorization")
        return redirected


def download(inputs: _AdmittedSetup, target: Path) -> _AuthenticatedArchive | Rejected:
    request = urllib.request.Request(inputs.url)
    if inputs.authorization and urllib.parse.urlsplit(inputs.url).scheme in {"https", "http"}:
        request.add_header("Authorization", inputs.authorization)
    try:
        opener = urllib.request.build_opener(OriginRedirect())
        with (
            opener.open(request, timeout=inputs.timeout / 1000) as response,
            target.open("xb") as out,
        ):
            shutil.copyfileobj(response, out)
    except (OSError, urllib.error.URLError):
        return Rejected(Failure.DOWNLOAD_FAILED, "artifact download")
    with target.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != inputs.sha256:
        return Rejected(Failure.CHECKSUM_MISMATCH, "artifact download")
    target.chmod(0o400)
    return _AuthenticatedArchive(target, digest)


def bootstrap(archive: _AuthenticatedArchive, directory: Path) -> Path | Rejected:
    found: set[str] = set()
    try:
        with tarfile.open(archive.path, "r:*") as incoming:
            for member in incoming:
                if member.name not in BOOTSTRAP_FILES:
                    continue
                if not member.isfile() or member.name in found or member.size > 1_048_576:
                    return Rejected(Failure.UNSAFE_BOOTSTRAP, "bundle entry")
                incoming.extract(member, directory, filter="data")
                found.add(member.name)
                if frozenset(found) == BOOTSTRAP_FILES:
                    break
    except (OSError, tarfile.TarError):
        return Rejected(Failure.UNSAFE_BOOTSTRAP, "bundle archive")
    if frozenset(found) != BOOTSTRAP_FILES:
        return Rejected(Failure.UNSAFE_BOOTSTRAP, "missing modern bundle installer")
    return directory / "setup-kast/bin/setup-kast"


def install(inputs: _AdmittedSetup) -> SetupInstalled | Rejected:
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        return Rejected(Failure.UNSUPPORTED_PLATFORM, "host")
    if inputs.root.exists():
        return Rejected(Failure.EXISTING_INSTALLATION, "destination")
    with tempfile.TemporaryDirectory(prefix="setup-kast-") as temporary:
        scratch = Path(temporary).resolve()
        artifact = download(inputs, scratch / "bundle.tar.gz")
        if isinstance(artifact, Rejected):
            return artifact
        entry = bootstrap(artifact, scratch / "bootstrap")
        if isinstance(entry, Rejected):
            return entry
        child_environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": os.environ.get("HOME", str(scratch)),
            "TMPDIR": str(scratch),
        }
        arguments = [
            sys.executable,
            str(entry),
            "--root",
            str(inputs.root),
            "--version",
            inputs.version,
            "--archive",
            str(artifact.path),
            "--archive-sha256",
            artifact.sha256,
        ]
        if inputs.trust_workspace is not None:
            arguments.extend(("--trust-workspace", str(inputs.trust_workspace)))
        installed = subprocess.run(
            arguments,
            env=child_environment,
            capture_output=True,
            timeout=1800,
            check=False,
        )
        if installed.returncode != 0:
            if installed.stdout:
                print(installed.stdout.decode(errors="replace"), file=sys.stderr)
            return Rejected(Failure.INSTALLER_FAILED, "shared Kast installer")
    command = inputs.root / "bin/kast"
    if (
        not command.is_file()
        or command.is_symlink()
        or not os.access(command, os.X_OK)
        or not (inputs.root / ".kast-headless-owned").is_file()
    ):
        return Rejected(Failure.INSTALLED_COMMAND_REJECTED, "installed wrapper")
    version = subprocess.run(
        [str(command), "--version"], capture_output=True, timeout=60, check=False
    )
    if version.returncode != 0 or version.stdout.decode().strip() != inputs.version:
        return Rejected(Failure.INSTALLED_COMMAND_REJECTED, "installed version")
    return SetupInstalled(str(command), str(inputs.root), inputs.version, artifact.sha256)


def export_github(result: SetupInstalled, environment: Mapping[str, str]) -> None:
    entries = {
        "GITHUB_PATH": str(Path(result.command).parent) + "\n",
        "GITHUB_ENV": "KAST_INSTALL_ROOT=" + result.root + "\n",
        "GITHUB_OUTPUT": "kast-command=" + result.command + "\ninstall-root=" + result.root + "\n",
    }
    for key, content in entries.items():
        path = environment.get(key)
        if path:
            with Path(path).open("a") as output:
                _ = output.write(content)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    names = INPUT_NAMES
    for name in names:
        value = os.environ.get(
            "INPUT_" + name.upper(), os.environ.get("INPUT_" + name.upper().replace("-", "_"))
        )
        _ = parser.add_argument("--" + name, default=value)
    args = parser.parse_args()
    values = {
        name: value
        for name in names
        if isinstance(value := getattr(args, name.replace("-", "_")), str)
    }
    allowed_environment = {
        "INPUT_" + name.upper().replace("-", separator)
        for name in names
        for separator in ("-", "_")
    }
    if any(name.startswith("INPUT_") and name not in allowed_environment for name in os.environ):
        values["unknown-action-input"] = "present"
    try:
        admitted = admission(values)
        result = install(admitted) if isinstance(admitted, _AdmittedSetup) else admitted
        if isinstance(result, SetupInstalled):
            export_github(result, os.environ)
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        result = Rejected(Failure.EFFECT_FAILED, type(error).__name__)
    print(json.dumps(asdict(result), indent=2))
    return 0 if isinstance(result, SetupInstalled) else 1


if __name__ == "__main__":
    raise SystemExit(main())
