from __future__ import annotations

import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
PRUNE = ROOT / "scripts/prune_managed_fem_runtimes.sh"


def make_variant(root: Path, name: str, mtime: int) -> Path:
    variant = root / "fem-gpu-variants" / name
    (variant / "bin").mkdir(parents=True)
    (variant / "bin" / "fullmag-api").write_text("api", encoding="utf-8")
    os.utime(variant, (mtime, mtime))
    return variant


def make_unqualified_schema2_variant(root: Path, name: str, mtime: int) -> Path:
    variant = make_variant(root, name, mtime)
    (variant / "manifest.json").write_text(
        '{"schema": 2, "runtime": "fem-gpu-host"}\n', encoding="utf-8"
    )
    return variant


def test_prune_preserves_active_in_use_and_latest_variants(tmp_path: Path) -> None:
    runtime = tmp_path / "runtimes"
    variants = runtime / "fem-gpu-variants"
    variants.mkdir(parents=True)
    active = make_variant(variants.parent, f"hypre-baseline-{'a' * 64}", 10)
    in_use = make_variant(variants.parent, f"hypre-baseline-{'b' * 64}", 20)
    latest = make_variant(variants.parent, f"hypre-baseline-{'c' * 64}", 30)
    old = make_variant(variants.parent, f"hypre-baseline-{'d' * 64}", 5)
    candidate_latest = make_variant(variants.parent, f"candidate-sm89-{'e' * 64}", 30)
    candidate_old = make_variant(variants.parent, f"candidate-sm89-{'f' * 64}", 5)
    legacy = make_variant(variants.parent, "legacy-schema1-20260720", 40)
    (runtime / "fem-gpu-host").symlink_to(
        f"fem-gpu-variants/hypre-baseline-{'a' * 64}"
    )
    (runtime / "fem-gpu-host.staging.old").mkdir()
    (runtime / "fem-gpu-host.directory-backup.old").mkdir()

    proc = tmp_path / "proc"
    (proc / "100").mkdir(parents=True)
    (proc / "100" / "exe").symlink_to(in_use / "bin" / "fullmag-api")

    result = subprocess.run(
        ["bash", str(PRUNE)],
        cwd=ROOT,
        env={
            **os.environ,
            "FULLMAG_RUNTIME_PARENT": str(runtime),
            "FULLMAG_RUNTIME_PROC_ROOT": str(proc),
            "FULLMAG_RUNTIME_KEEP_PER_FAMILY": "1",
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert active.is_dir()
    assert in_use.is_dir()
    assert latest.is_dir()
    assert candidate_latest.is_dir()
    assert not old.exists()
    assert not candidate_old.exists()
    assert not legacy.exists()
    assert not (runtime / "fem-gpu-host.staging.old").exists()
    assert not (runtime / "fem-gpu-host.directory-backup.old").exists()


def test_prune_removes_unqualified_schema2_variants(tmp_path: Path) -> None:
    runtime = tmp_path / "runtimes"
    variants = runtime / "fem-gpu-variants"
    variants.mkdir(parents=True)
    active = make_variant(variants.parent, f"hypre-baseline-{'a' * 64}", 20)
    stale = make_unqualified_schema2_variant(
        variants.parent, f"candidate-sm89-{'b' * 64}", 30
    )
    (runtime / "fem-gpu-host").symlink_to(
        f"fem-gpu-variants/{active.name}"
    )

    result = subprocess.run(
        ["bash", str(PRUNE)],
        cwd=ROOT,
        env={**os.environ, "FULLMAG_RUNTIME_PARENT": str(runtime)},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert active.exists()
    assert not stale.exists()


def test_prune_ignores_deleted_process_worktree(tmp_path: Path) -> None:
    runtime = tmp_path / "runtimes"
    variants = runtime / "fem-gpu-variants"
    variants.mkdir(parents=True)
    active = make_variant(variants.parent, f"hypre-baseline-{'a' * 64}", 20)
    stale = make_unqualified_schema2_variant(
        variants.parent, f"candidate-sm89-{'b' * 64}", 30
    )
    (runtime / "fem-gpu-host").symlink_to(f"fem-gpu-variants/{active.name}")

    proc = tmp_path / "proc"
    (proc / "100").mkdir(parents=True)
    (proc / "100" / "cwd").symlink_to(f"{runtime / 'fem-gpu-variants'} (deleted)")

    result = subprocess.run(
        ["bash", str(PRUNE)],
        cwd=ROOT,
        env={
            **os.environ,
            "FULLMAG_RUNTIME_PARENT": str(runtime),
            "FULLMAG_RUNTIME_PROC_ROOT": str(proc),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert active.exists()
    assert not stale.exists()


def test_prune_does_not_resolve_unrelated_process_mount_path(tmp_path: Path) -> None:
    """An unrelated stale FUSE path must not be touched by the pruner."""
    runtime = tmp_path / "runtimes"
    variants = runtime / "fem-gpu-variants"
    variants.mkdir(parents=True)
    active = make_variant(variants.parent, f"hypre-baseline-{'a' * 64}", 20)
    (runtime / "fem-gpu-host").symlink_to(f"fem-gpu-variants/{active.name}")

    proc = tmp_path / "proc"
    (proc / "100").mkdir(parents=True)
    (proc / "100" / "cmdline").write_bytes(
        b"/bin/tool\0/mnt/foreign-sshfs/stale\0"
    )
    (proc / "100" / "exe").symlink_to("/bin/true")
    (proc / "100" / "cwd").symlink_to("/")

    marker = tmp_path / "readlink-foreign-called"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "readlink").write_text(
        "#!/bin/sh\n"
        "for arg do case \"$arg\" in /mnt/foreign-sshfs/*) touch \"$MARKER\";; esac; done\n"
        "exec /usr/bin/readlink \"$@\"\n",
        encoding="utf-8",
    )
    (fake_bin / "readlink").chmod(0o755)

    result = subprocess.run(
        ["bash", str(PRUNE)],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "MARKER": str(marker),
            "FULLMAG_RUNTIME_PARENT": str(runtime),
            "FULLMAG_RUNTIME_PROC_ROOT": str(proc),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not marker.exists()


def test_prune_reads_process_links_without_resolving_unrelated_mounts(
    tmp_path: Path,
) -> None:
    """Process cwd/exe inspection must not recurse into an unrelated mount."""
    runtime = tmp_path / "runtimes"
    variants = runtime / "fem-gpu-variants"
    variants.mkdir(parents=True)
    active = make_variant(variants.parent, f"hypre-baseline-{'a' * 64}", 20)
    (runtime / "fem-gpu-host").symlink_to(f"fem-gpu-variants/{active.name}")

    proc = tmp_path / "proc"
    (proc / "100").mkdir(parents=True)
    (proc / "100" / "cwd").symlink_to("/mnt/foreign-sshfs/stale")
    (proc / "100" / "exe").symlink_to("/bin/true")

    marker = tmp_path / "readlink-f-called"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "readlink").write_text(
        "#!/bin/sh\n"
        "if [ \"$1\" = \"-f\" ] && case \"$2\" in \"$PROC_ROOT\"/*) true;; *) false;; esac; then touch \"$MARKER\"; fi\n"
        "exec /usr/bin/readlink \"$@\"\n",
        encoding="utf-8",
    )
    (fake_bin / "readlink").chmod(0o755)

    result = subprocess.run(
        ["bash", str(PRUNE)],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
            "MARKER": str(marker),
            "PROC_ROOT": str(proc),
            "FULLMAG_RUNTIME_PARENT": str(runtime),
            "FULLMAG_RUNTIME_PROC_ROOT": str(proc),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not marker.exists()


def test_prune_does_not_hang_on_runtime_process_links(tmp_path: Path) -> None:
    runtime = tmp_path / "runtimes"
    variants = runtime / "fem-gpu-variants"
    variants.mkdir(parents=True)
    active = make_variant(variants.parent, f"hypre-baseline-{'a' * 64}", 20)
    (runtime / "fem-gpu-host").symlink_to(f"fem-gpu-variants/{active.name}")

    proc = tmp_path / "proc"
    (proc / "100").mkdir(parents=True)
    (proc / "100" / "cwd").symlink_to(active)
    shim_dir = tmp_path / "bin"
    shim_dir.mkdir()
    readlink_shim = shim_dir / "readlink"
    readlink_shim.write_text(
        "#!/usr/bin/env bash\n"
        "if [ \"${1:-}\" = '-f' ]; then\n"
        "  case \"${*: -1}\" in */proc/100/cwd) sleep 5 ;; esac\n"
        "fi\n"
        "exec /usr/bin/readlink \"$@\"\n",
        encoding="utf-8",
    )
    readlink_shim.chmod(0o755)

    result = subprocess.run(
        ["bash", str(PRUNE)],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{shim_dir}:{os.environ['PATH']}",
            "FULLMAG_RUNTIME_PARENT": str(runtime),
            "FULLMAG_RUNTIME_PROC_ROOT": str(proc),
            "FULLMAG_RUNTIME_READLINK_TIMEOUT": "0.1",
        },
        text=True,
        capture_output=True,
        timeout=2,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert active.exists()
