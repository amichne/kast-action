"""Transport cases use real children. They do not establish native Kast behavior."""

import hashlib
import io
import tarfile
import tempfile
import urllib.request
from collections.abc import Iterator
from contextlib import contextmanager
from http.client import HTTPMessage
from pathlib import Path
from unittest.mock import patch

import pytest

import setup_kast as setup

ENTRY = b"""import argparse
from pathlib import Path
p = argparse.ArgumentParser()
for name in ("root", "version", "archive", "archive-sha256"):
    p.add_argument("--" + name, required=True)
a = p.parse_args()
root = Path(a.root)
root.mkdir()
(root / "bin").mkdir()
(root / ".kast-headless-owned").write_text("fixture only")
command = root / "bin/kast"
command.write_text("#!/usr/bin/env python3\\nprint('" + a.version + "')\\n")
command.chmod(0o700)
(root / "received.txt").write_text(a.archive_sha256)
"""


@contextmanager
def linux_observation() -> Iterator[None]:
    with (
        patch.object(setup.platform, "system", return_value="Linux"),
        patch.object(
            setup.platform,
            "machine",
            return_value="x86_64",
        ),
    ):
        yield


@pytest.fixture
def destination() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="ka-", dir="/tmp") as temporary:
        yield Path(temporary).resolve() / "i"


def artifact(tmp_path: Path, *, unsafe: bool = False) -> Path:
    path = tmp_path / "bundle ; dollar$.tar.gz"
    with tarfile.open(path, "w:gz") as out:
        for name in sorted(setup.BOOTSTRAP_FILES):
            info = tarfile.TarInfo(name)
            raw = ENTRY if name.endswith("bin/setup-kast") else b"# transport fixture"
            if unsafe and name.endswith("bin/setup-kast"):
                info.type = tarfile.SYMTYPE
                info.linkname = "../../outside"
                out.addfile(info)
            else:
                info.size = len(raw)
                out.addfile(info, io.BytesIO(raw))
    return path


def inputs(path: Path, root: Path):
    result = setup.admission(
        {
            "version": "0.0.0",
            "artifact-url": path.as_uri(),
            "artifact-sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "install-dir": str(root),
        }
    )
    assert not isinstance(result, setup.Rejected), result
    return result


def test_real_child_uses_current_bundle_entry_and_exports_only_installation_facts(
    tmp_path: Path,
    destination: Path,
) -> None:
    admitted = inputs(artifact(tmp_path), destination)
    with linux_observation():
        result = setup.install(admitted)
    assert isinstance(result, setup.SetupInstalled), result
    assert result.command == str(destination / "bin/kast")
    assert result.version == "0.0.0" and result.semanticReadiness == "NOT_RUN"
    assert (destination / "received.txt").read_text() == admitted.sha256
    environment = {
        name: str(tmp_path / name) for name in ("GITHUB_PATH", "GITHUB_ENV", "GITHUB_OUTPUT")
    }
    setup.export_github(result, environment)
    assert Path(environment["GITHUB_PATH"]).read_text() == str(destination / "bin") + "\n"
    assert (
        Path(environment["GITHUB_ENV"]).read_text()
        == "KAST_INSTALL_ROOT=" + str(destination) + "\n"
    )
    assert "kast-command=" + result.command in Path(environment["GITHUB_OUTPUT"]).read_text()


def test_changed_archive_rejects_before_installer_effects(
    tmp_path: Path, destination: Path
) -> None:
    path = artifact(tmp_path)
    admitted = inputs(path, destination)
    _ = path.write_bytes(path.read_bytes() + b"changed")
    with linux_observation():
        assert setup.install(admitted) == setup.Rejected(
            setup.Failure.CHECKSUM_MISMATCH, "artifact download"
        )
    assert not destination.exists()


def test_existing_destination_preserves_its_bytes_without_download(destination: Path) -> None:
    destination.mkdir()
    sentinel = destination / "foreign"
    _ = sentinel.write_bytes(b"preserve me")
    admitted = setup.admission(
        {
            "version": "0.0.0",
            "artifact-url": "https://invalid.example/never-requested",
            "artifact-sha256": "a" * 64,
            "install-dir": str(destination),
        }
    )
    assert not isinstance(admitted, setup.Rejected)
    with (
        linux_observation(),
        patch.object(setup, "download", side_effect=AssertionError("unexpected download")),
    ):
        assert setup.install(admitted) == setup.Rejected(
            setup.Failure.EXISTING_INSTALLATION, "destination"
        )
    assert sentinel.read_bytes() == b"preserve me"


def test_bootstrap_symlink_rejects_without_activation(tmp_path: Path, destination: Path) -> None:
    admitted = inputs(artifact(tmp_path, unsafe=True), destination)
    with linux_observation():
        assert setup.install(admitted) == setup.Rejected(
            setup.Failure.UNSAFE_BOOTSTRAP, "bundle entry"
        )
    assert not destination.exists()


@pytest.mark.parametrize(
    "field,value",
    [
        ("artifact-sha256", "not-a-digest"),
        ("version", "../escape"),
        ("install-dir", "relative"),
        ("artifact-url", "ftp://host/bundle"),
        ("authorization-header", "secret\nnext"),
        ("download-timeout-ms", "0"),
    ],
)
def test_invalid_ingress_never_becomes_installation_input(field: str, value: str) -> None:
    values = {
        "version": "0.0.0",
        "artifact-url": "https://example.com/bundle",
        "artifact-sha256": "a" * 64,
        "install-dir": "/opt/kast",
    }
    values[field] = value
    assert isinstance(setup.admission(values), setup.Rejected)


def test_retired_input_rejects_instead_of_silently_skipping_its_behavior() -> None:
    assert setup.admission({"gradle-ro-cache-url": "https://example.com/cache"}) == setup.Rejected(
        setup.Failure.INVALID_INPUT,
        "unknown or retired input",
    )


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://artifact.example/other", "Bearer fixture"),
        ("https://different.example/other", None),
        ("http://artifact.example/other", None),
    ],
)
def test_authorization_stays_scoped_to_the_original_origin(url: str, expected: str | None) -> None:
    request = urllib.request.Request("https://artifact.example/bundle")
    request.add_header("Authorization", "Bearer fixture")
    result = setup.OriginRedirect().redirect_request(
        request,
        io.BytesIO(),
        302,
        "Found",
        HTTPMessage(),
        url,
    )
    assert result is not None and result.get_header("Authorization") == expected
