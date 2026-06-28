#!/usr/bin/env python3
"""Unit tests for managed FEM runtime export copy helpers."""

from __future__ import annotations

import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "scripts" / "lib" / "runtime_bundle_copy.sh"


def run_bash(script: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-euo", "pipefail", "-c", script],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_runtime_copy_replaces_existing_symlink_with_regular_file(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    dest_dir = tmp_path / "dest"
    source_dir.mkdir()
    dest_dir.mkdir()
    source = source_dir / "libmumps_common-5.4.0.so"
    source.write_text("new shared object\n", encoding="utf-8")
    (dest_dir / "old-target.so").write_text("old shared object\n", encoding="utf-8")
    (dest_dir / source.name).symlink_to("old-target.so")

    result = run_bash(
        f"""
        source {HELPER}
        copy_runtime_entry_replace {source} {dest_dir}
        test ! -L {dest_dir / source.name}
        test "$(cat {dest_dir / source.name})" = "new shared object"
        """
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_runtime_copy_is_idempotent_for_existing_regular_file(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    dest_dir = tmp_path / "dest"
    source_dir.mkdir()
    dest_dir.mkdir()
    source = source_dir / "libpetsc_real.so.3.15"
    source.write_text("first copy\n", encoding="utf-8")
    (dest_dir / source.name).write_text("stale copy\n", encoding="utf-8")

    result = run_bash(
        f"""
        source {HELPER}
        copy_runtime_entry_replace {source} {dest_dir}
        test "$(cat {dest_dir / source.name})" = "first copy"
        printf 'second copy\\n' > {source}
        copy_runtime_entry_replace {source} {dest_dir}
        test "$(cat {dest_dir / source.name})" = "second copy"
        """
    )

    assert result.returncode == 0, result.stderr + result.stdout
