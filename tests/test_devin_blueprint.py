"""Execute the example's maintenance shell, not a second installer implementation."""

import os
import subprocess
from pathlib import Path
from textwrap import dedent

import pytest

REPOSITORY = Path(__file__).resolve().parent.parent


def maintenance(root: Path) -> str:
    example = (REPOSITORY / "examples/devin-blueprint.yaml").read_text()
    _, separator, body = example.partition("maintenance: |\n")
    assert separator, "Inherited snapshots need a self-contained maintenance run step"
    assert "uses:" not in body, "Devin rejects actions in maintenance"
    return dedent(body).replace("/opt/kast", str(root))


def wrapper(root: Path, *, version: str = "0.0.0", exit_code: int = 0) -> Path:
    (root / "bin").mkdir(parents=True)
    command = root / "bin/kast"
    _ = command.write_text(f"#!/bin/sh\nprintf '%s\\n' '{version}'\nexit {exit_code}\n")
    command.chmod(0o700)
    task = root / "bin/kast-task"
    _ = task.write_text("#!/bin/sh\nexit 42\n")
    task.chmod(0o700)
    return command


def test_inherited_snapshot_restores_discovery_after_each_envrc_reset(tmp_path: Path) -> None:
    root = tmp_path / "kast"
    _ = wrapper(root)
    envrc = tmp_path / "envrc ; dollar$"
    original = "export EXISTING=preserved\n"
    # No initialize, action environment, Python, download or installer is available here.
    environment = {
        "PATH": "/usr/bin:/bin",
        "ENVRC": str(envrc),
        "HOME": str(tmp_path / "original-home"),
        "JAVA_HOME": str(tmp_path / "original-java"),
    }
    for _build in range(2):
        _ = envrc.write_text(original)
        result = subprocess.run(
            ["/bin/bash", "-c", maintenance(root)],
            env=environment,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
        assert envrc.read_text() == (
            original + f"export KAST_INSTALL_ROOT={root}\n" + f'export PATH="{root}/bin:$PATH"\n'
        )
        # A fresh shell must find kast after reading ENVRC, with the old PATH retained.
        session = subprocess.run(
            [
                "/bin/bash",
                "-c",
                '. "$ENVRC"; command -v kast; command -v kast-task; kast --version; '
                'printf "%s\\n" "$KAST_INSTALL_ROOT" "$PATH" "$EXISTING" "$HOME" "$JAVA_HOME"',
            ],
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )
        assert session.returncode == 0, session.stderr
        assert session.stdout.splitlines() == [
            str(root / "bin/kast"),
            str(root / "bin/kast-task"),
            "0.0.0",
            str(root),
            f"{root}/bin:/usr/bin:/bin",
            "preserved",
            environment["HOME"],
            environment["JAVA_HOME"],
        ]
    assert sorted(path.relative_to(root).as_posix() for path in root.rglob("*")) == [
        "bin",
        "bin/kast",
        "bin/kast-task",
    ]


@pytest.mark.parametrize(
    "state", ["missing", "missing-task", "not-executable", "wrong-version", "failed"]
)
def test_rejected_snapshot_does_not_export_or_replace_installation(
    tmp_path: Path, state: str
) -> None:
    root = tmp_path / "kast"
    if state != "missing":
        command = wrapper(
            root,
            version="9.9.9" if state == "wrong-version" else "0.0.0",
            exit_code=1 if state == "failed" else 0,
        )
        if state == "missing-task":
            (root / "bin/kast-task").unlink()
        elif state == "not-executable":
            command.chmod(0o600)
    before = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
    envrc = tmp_path / "envrc"
    _ = envrc.write_text("# keep existing exports\n")
    result = subprocess.run(
        ["/bin/bash", "-c", maintenance(root)],
        env={"PATH": "/usr/bin:/bin", "ENVRC": str(envrc)},
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    assert envrc.read_text() == "# keep existing exports\n"
    assert {path: path.read_bytes() for path in root.rglob("*") if path.is_file()} == before


@pytest.mark.parametrize("envrc_state", ["absent", "empty", "directory"])
def test_missing_or_unwritable_envrc_fails(tmp_path: Path, envrc_state: str) -> None:
    root = tmp_path / "kast"
    _ = wrapper(root)
    environment = {"PATH": os.defpath}
    if envrc_state != "absent":
        environment["ENVRC"] = "" if envrc_state == "empty" else str(tmp_path)
    result = subprocess.run(
        ["/bin/bash", "-c", maintenance(root)], env=environment, capture_output=True, check=False
    )
    assert result.returncode != 0


def test_readme_blueprint_matches_executable_example() -> None:
    readme = (REPOSITORY / "README.md").read_text().split("## Devin environment blueprint", 1)[1]
    snippet = readme.split("```yaml\n", 1)[1].split("```", 1)[0]
    assert snippet.strip() == (REPOSITORY / "examples/devin-blueprint.yaml").read_text().strip()
