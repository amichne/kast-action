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
)

BOOTSTRAP_MEMBER = "setup-kast/bin/setup-kast.pyz"


class Failure(StrEnum):
    INVALID_INPUT = "INVALID_INPUT"
    UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM"
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
    exitCode: int = 1
    type: Literal["rejected"] = field(default="rejected", init=False)


@dataclass(frozen=True, slots=True)
class _AdmittedSetup:
    url: str
    sha256: str
    root: Path
    version: str
    authorization: str
    timeout: int


@dataclass(frozen=True, slots=True)
class _AuthenticatedArchive:
    path: Path
    sha256: str


@dataclass(frozen=True, slots=True)
class SetupInstalled:
    command: str
    taskCommand: str
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
    if not root.is_absolute() or not timeout.isdecimal() or not 1000 <= int(timeout) <= 1_800_000:
        return Rejected(Failure.INVALID_INPUT, "destination or timeout")
    authorization = values.get("authorization-header", "")
    if authorization and parsed.scheme != "https":
        return Rejected(Failure.INVALID_INPUT, "authorization needs HTTPS")
    return _AdmittedSetup(url, digest, root, version, authorization, int(timeout))


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
    if inputs.authorization:
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
    entry = directory / "setup-kast.pyz"
    try:
        with tarfile.open(archive.path, "r|gz") as incoming:
            for member in incoming:
                if member.name != BOOTSTRAP_MEMBER:
                    continue
                if entry.exists() or not member.isfile() or not 0 < member.size <= 1_048_576:
                    return Rejected(Failure.UNSAFE_BOOTSTRAP, "bundle entry")
                source = incoming.extractfile(member)
                if source is None:
                    return Rejected(Failure.UNSAFE_BOOTSTRAP, "bundle entry")
                with source, entry.open("xb") as out:
                    shutil.copyfileobj(source, out)
    except (OSError, EOFError, tarfile.TarError):
        return Rejected(Failure.UNSAFE_BOOTSTRAP, "bundle archive")
    if not entry.exists():
        return Rejected(Failure.UNSAFE_BOOTSTRAP, "missing bundle installer")
    return entry


def install(inputs: _AdmittedSetup) -> SetupInstalled | Rejected:
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        return Rejected(Failure.UNSUPPORTED_PLATFORM, "host")
    with tempfile.TemporaryDirectory(prefix="setup-kast-") as temporary:
        scratch = Path(temporary).resolve()
        artifact = download(inputs, scratch / "bundle.tar.gz")
        if isinstance(artifact, Rejected):
            return artifact
        entry = bootstrap(artifact, scratch)
        if isinstance(entry, Rejected):
            return entry
        child_environment = {
            "PATH": os.environ.get("PATH", os.defpath),
            "HOME": os.environ.get("HOME", str(scratch)),
            "TMPDIR": str(scratch),
        }
        installed = subprocess.run(
            [
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
            ],
            env=child_environment,
            capture_output=True,
            timeout=1800,
            check=False,
        )
        if installed.returncode != 0:
            for message in (installed.stdout, installed.stderr):
                if message:
                    print(message.decode(errors="replace"), file=sys.stderr, end="")
            status = (
                installed.returncode if installed.returncode > 0 else 128 - installed.returncode
            )
            return Rejected(Failure.INSTALLER_FAILED, "shared Kast installer", status)
        command = inputs.root / "bin/kast"
        task = inputs.root / "bin/kast-task"
        for executable in (command, task):
            if (
                not executable.is_file()
                or executable.is_symlink()
                or not os.access(executable, os.X_OK)
            ):
                return Rejected(Failure.INSTALLED_COMMAND_REJECTED, executable.name)
        version = subprocess.run(
            [str(command), "--version"],
            env=child_environment,
            capture_output=True,
            timeout=60,
            check=False,
        )
        if version.returncode != 0 or version.stdout.decode().strip() != inputs.version:
            return Rejected(Failure.INSTALLED_COMMAND_REJECTED, "installed version")
        return SetupInstalled(
            str(command), str(task), str(inputs.root), inputs.version, artifact.sha256
        )


def export_github(result: SetupInstalled, environment: Mapping[str, str]) -> None:
    entries = {
        "GITHUB_PATH": str(Path(result.command).parent) + "\n",
        "GITHUB_ENV": "KAST_INSTALL_ROOT=" + result.root + "\n",
        "GITHUB_OUTPUT": (
            f"kast-command={result.command}\nkast-task-command={result.taskCommand}\n"
            f"install-root={result.root}\n"
        ),
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
    return result.exitCode if isinstance(result, Rejected) else 0


if __name__ == "__main__":
    raise SystemExit(main())
