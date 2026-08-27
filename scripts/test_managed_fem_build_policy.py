from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "scripts" / "lib" / "managed_fem_build_policy.sh"


def resolve_policy(*, profile: str | None, reuse: str | None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.pop("FULLMAG_NATIVE_STORAGE_PROFILE", None)
    environment.pop("FULLMAG_FEM_RUNTIME_REUSE_BUILD", None)
    if profile is not None:
        environment["FULLMAG_NATIVE_STORAGE_PROFILE"] = profile
    if reuse is not None:
        environment["FULLMAG_FEM_RUNTIME_REUSE_BUILD"] = reuse
    return subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            'source "$1"; resolve_managed_fem_build_policy; printf "%s" "$FULLMAG_FEM_RUNTIME_REUSE_BUILD"',
            "bash",
            str(HELPER),
        ],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize(
    ("profile", "reuse", "expected"),
    [
        (None, None, "0"),
        ("canonical", None, "0"),
        ("local-d", None, "1"),
        ("canonical", "1", "1"),
        ("local-d", "0", "0"),
    ],
)
def test_build_policy_resolves_profile_defaults_and_explicit_overrides(
    profile: str | None, reuse: str | None, expected: str
) -> None:
    result = resolve_policy(profile=profile, reuse=reuse)

    assert result.returncode == 0, result.stderr
    assert result.stdout == expected


@pytest.mark.parametrize(
    ("profile", "reuse"),
    [
        ("unsupported", None),
        ("canonical", ""),
        ("local-d", "2"),
    ],
)
def test_build_policy_rejects_unknown_profiles_and_reuse_values(
    profile: str, reuse: str | None
) -> None:
    result = resolve_policy(profile=profile, reuse=reuse)

    assert result.returncode == 2
    assert "managed_fem_build_policy" in result.stderr


def test_nightly_checksum_freshness_rebuilds_rust_source_with_old_mtime(
    tmp_path: Path,
) -> None:
    crate = tmp_path / "checksum-freshness"
    source = crate / "src" / "main.rs"
    source.parent.mkdir(parents=True)
    (crate / "Cargo.toml").write_text(
        '[package]\nname = "checksum-freshness-smoke"\nversion = "0.1.0"\n'
        'edition = "2021"\n',
        encoding="utf-8",
    )
    source.write_text('fn main() { println!("first"); }\n', encoding="utf-8")
    target = tmp_path / "cargo-target"
    command = [
        "cargo",
        "+nightly",
        "-Z",
        "checksum-freshness",
        "build",
        "--quiet",
        "--manifest-path",
        str(crate / "Cargo.toml"),
    ]
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(target)

    first = subprocess.run(
        command,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert first.returncode == 0, first.stderr

    source.write_text('fn main() { println!("other"); }\n', encoding="utf-8")
    os.utime(source, (1, 1))
    second = subprocess.run(
        command,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert second.returncode == 0, second.stderr

    binary = subprocess.run(
        [str(target / "debug" / "checksum-freshness-smoke")],
        capture_output=True,
        text=True,
        check=False,
    )
    assert binary.returncode == 0, binary.stderr
    assert binary.stdout.strip() == "other"
