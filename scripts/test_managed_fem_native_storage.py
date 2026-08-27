from __future__ import annotations

import os
from pathlib import Path
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "scripts/lib/managed_fem_native_storage.sh"
EXPORTER = REPO_ROOT / "scripts/export_fem_gpu_runtime.sh"
RESTORER = REPO_ROOT / "scripts/restore_persistent_fem_runtime.sh"


def _resolve(profile: str | None = None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    if profile is None:
        environment.pop("FULLMAG_NATIVE_STORAGE_PROFILE", None)
    else:
        environment["FULLMAG_NATIVE_STORAGE_PROFILE"] = profile
    return subprocess.run(
        [
            "bash",
            "--noprofile",
            "--norc",
            "-euo",
            "pipefail",
            "-c",
            'source "$1"; resolve_managed_fem_native_storage; printf "%s\\n" "$FULLMAG_NATIVE_BUILD_STORAGE_ROOT" "$FULLMAG_NATIVE_BUILD_IMAGE" "$FULLMAG_NATIVE_MOUNT_VIEW"',
            "bash",
            str(HELPER),
        ],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )


def test_default_profile_resolves_existing_canonical_storage() -> None:
    result = _resolve()

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        "/zfn2/mateuszz/git/fullmag",
        "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4",
        "/mnt/fullmag-zfn2-native",
    ]


def test_local_d_profile_resolves_local_ext4_image() -> None:
    result = _resolve("local-d")

    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [
        "/mnt/d/git/fullmag",
        "/mnt/d/git/fullmag/fullmag-native.ext4",
        "/mnt/fullmag-zfn2-native",
    ]


def test_unknown_profile_fails_closed() -> None:
    result = _resolve("somewhere-else")

    assert result.returncode == 2
    assert "FULLMAG_NATIVE_STORAGE_PROFILE" in result.stderr


def test_exporter_and_restorer_use_the_shared_storage_profile_resolver() -> None:
    exporter = EXPORTER.read_text(encoding="utf-8")
    restorer = RESTORER.read_text(encoding="utf-8")

    assert 'source "${SOURCE_ROOT}/scripts/lib/managed_fem_native_storage.sh"' in exporter
    assert 'source "${REPO_ROOT}/scripts/lib/managed_fem_native_storage.sh"' in restorer
    assert "resolve_managed_fem_native_storage" in exporter
    assert "resolve_managed_fem_native_storage" in restorer
    assert 'readonly FULLMAG_NATIVE_BUILD_IMAGE="/zfn2/' not in exporter
    assert 'readonly FULLMAG_NATIVE_BUILD_IMAGE="/zfn2/' not in restorer
