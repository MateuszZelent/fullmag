from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[1]
STORAGE_HELPER = REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
EXPORTER = REPO_ROOT / "scripts/export_fem_gpu_runtime.sh"
ENSURE_STORAGE_PREFLIGHT = REPO_ROOT / "scripts/prepare_managed_fem_runtime_storage.sh"


def _validator(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env python3
import argparse, hashlib, os
from pathlib import Path
p = argparse.ArgumentParser()
p.add_argument('--runtime-root', type=Path, required=True)
p.add_argument('--compare-exact', type=Path)
p.add_argument('--allow-unaddressed-staging', action='store_true')
a = p.parse_args()
def identity(root):
    out = {}
    for item in sorted(root.rglob('*')):
        rel = str(item.relative_to(root))
        if item.is_symlink(): out[rel] = ('link', os.readlink(item))
        elif item.is_dir(): out[rel] = ('dir',)
        else: out[rel] = ('file', hashlib.sha256(item.read_bytes()).hexdigest())
    return out
if not (a.runtime_root / 'manifest.json').is_file(): raise SystemExit(2)
if a.compare_exact and identity(a.runtime_root) != identity(a.compare_exact): raise SystemExit(2)
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _variant(root: Path, name: str, payload: str = "payload") -> Path:
    variant = root / name
    (variant / "bin").mkdir(parents=True)
    (variant / "manifest.json").write_text('{"schema": 2}\n', encoding="utf-8")
    (variant / "bin/worker").write_text(payload, encoding="utf-8")
    return variant


def _migrate(alias: Path, durable: Path, validator: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash", "-euo", "pipefail", "-c",
            'source "$1"; migrate_managed_fem_runtime_variants "$2" "$3" "$4"',
            "bash", str(STORAGE_HELPER), str(alias), str(durable), str(validator),
        ],
        text=True,
        capture_output=True,
        check=False,
    )


def _select_alias(
    alias: Path,
    selected: Path,
    *,
    retarget_from: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            'source "$1"; select_managed_fem_runtime_variants_alias "$2" "$3" "$4"',
            "bash",
            str(STORAGE_HELPER),
            str(alias),
            str(selected),
            str(retarget_from) if retarget_from is not None else "",
        ],
        text=True,
        capture_output=True,
        check=False,
    )


def test_ensure_selector_retargets_only_the_expected_canonical_alias(
    tmp_path: Path,
) -> None:
    canonical = tmp_path / "canonical/runtime-variants"
    selected = tmp_path / "alternate/runtime-variants"
    canonical.mkdir(parents=True)
    selected.mkdir(parents=True)
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    alias.parent.mkdir(parents=True)
    alias.symlink_to(canonical, target_is_directory=True)

    result = _select_alias(alias, selected, retarget_from=canonical)

    assert result.returncode == 0, result.stderr
    assert alias.resolve() == selected.resolve()
    assert canonical.is_dir()


def test_ensure_selector_rejects_an_unrecognized_existing_alias(
    tmp_path: Path,
) -> None:
    canonical = tmp_path / "canonical/runtime-variants"
    selected = tmp_path / "alternate/runtime-variants"
    unexpected = tmp_path / "unexpected/runtime-variants"
    for path in (canonical, selected, unexpected):
        path.mkdir(parents=True)
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    alias.parent.mkdir(parents=True)
    alias.symlink_to(unexpected, target_is_directory=True)

    result = _select_alias(alias, selected, retarget_from=canonical)

    assert result.returncode == 2
    assert alias.resolve() == unexpected.resolve()


def _prepare_preflight_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo = tmp_path / "repo"
    scripts = repo / "scripts"
    library = scripts / "lib"
    library.mkdir(parents=True)
    shutil.copy2(ENSURE_STORAGE_PREFLIGHT, scripts / ENSURE_STORAGE_PREFLIGHT.name)
    shutil.copy2(STORAGE_HELPER, library / STORAGE_HELPER.name)
    slug = re.sub(r"[^A-Za-z0-9._-]", "-", repo.name)
    digest = hashlib.sha256(str(repo).encode()).hexdigest()
    canonical = (
        Path("/mnt/fullmag-zfn2-native")
        / "managed-fem-runtime"
        / f"{slug}-{digest}"
        / "runtime-variants"
    )
    alias = repo / ".fullmag/runtimes/fem-gpu-variants"
    alias.parent.mkdir(parents=True)
    alias.symlink_to(canonical, target_is_directory=True)
    return repo, alias


def _fake_findmnt(tmp_path: Path, *, filesystem_type: str) -> Path:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    findmnt = fake_bin / "findmnt"
    findmnt.write_text(
        "#!/bin/sh\n"
        'case "$*" in\n'
        '  *"-o TARGET"*) echo /mnt/g ;;\n'
        f'  *"-o FSTYPE"*) echo {filesystem_type} ;;\n'
        '  *"-o OPTIONS"*) echo rw,nosuid,nodev,aname=drvfs ;;\n'
        '  *"-o SOURCE"*) echo /dev/loop99 ;;\n'
        "  *) exit 3 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    findmnt.chmod(0o755)
    return fake_bin


def test_explicit_ensure_preflight_rejects_missing_alternate_image_before_retarget(
    tmp_path: Path,
) -> None:
    repo, alias = _prepare_preflight_repo(tmp_path)
    original_target = os.readlink(alias)
    fake_bin = _fake_findmnt(tmp_path, filesystem_type="9p")
    env = {
        **os.environ,
        "FULLMAG_MANAGED_FEM_STORAGE_ROOT": "/mnt/g/git",
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }

    result = subprocess.run(
        ["bash", str(repo / "scripts" / ENSURE_STORAGE_PREFLIGHT.name)],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2, result.stderr
    assert "expected a regular ext4 backing image" in result.stderr
    assert os.readlink(alias) == original_target


def test_explicit_ensure_preflight_rejects_missing_ext4_mount_before_retarget(
    tmp_path: Path,
) -> None:
    repo, alias = _prepare_preflight_repo(tmp_path)
    original_target = os.readlink(alias)
    fake_bin = _fake_findmnt(tmp_path, filesystem_type="9p")
    env = {
        **os.environ,
        "FULLMAG_MANAGED_FEM_STORAGE_ROOT": "/zfn2/mateuszz/git/fullmag",
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }

    result = subprocess.run(
        ["bash", str(repo / "scripts" / ENSURE_STORAGE_PREFLIGHT.name)],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2, result.stderr
    assert "must be an ext4 filesystem" in result.stderr
    assert os.readlink(alias) == original_target


def test_explicit_storage_selection_atomically_retargets_existing_durable_alias(
    tmp_path: Path,
) -> None:
    old_durable = tmp_path / "old/variants"
    old_variant = _variant(old_durable, "old", "preserve-me")
    new_durable = tmp_path / "new/variants"
    new_durable.mkdir(parents=True)
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    alias.parent.mkdir(parents=True)
    alias.symlink_to(old_durable, target_is_directory=True)
    validator = tmp_path / "validator.py"
    _validator(validator)

    result = _migrate(
        alias,
        new_durable,
        validator,
        retarget_from=old_durable,
    )

    assert result.returncode == 0, result.stderr
    assert alias.is_symlink()
    assert alias.resolve() == new_durable.resolve()
    assert (old_variant / "bin/worker").read_text(encoding="utf-8") == "preserve-me"


def test_default_storage_rejects_retargeting_existing_durable_alias(
    tmp_path: Path,
) -> None:
    old_durable = tmp_path / "old/variants"
    _variant(old_durable, "old")
    new_durable = tmp_path / "new/variants"
    new_durable.mkdir(parents=True)
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    alias.parent.mkdir(parents=True)
    alias.symlink_to(old_durable, target_is_directory=True)
    validator = tmp_path / "validator.py"
    _validator(validator)

    result = _migrate(alias, new_durable, validator)

    assert result.returncode == 2
    assert alias.resolve() == old_durable.resolve()


def test_migrates_valid_legacy_variants_then_selects_durable_alias(tmp_path: Path) -> None:
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    durable = tmp_path / "durable/variants"
    validator = tmp_path / "validator.py"
    _validator(validator)
    _variant(alias, "one")
    _variant(alias, "two")

    result = _migrate(alias, durable, validator)

    assert result.returncode == 0, result.stderr
    assert alias.is_symlink()
    assert alias.resolve() == durable.resolve()
    assert (durable / "one/bin/worker").read_text(encoding="utf-8") == "payload"
    assert (durable / "two/bin/worker").read_text(encoding="utf-8") == "payload"


def test_export_and_restore_use_the_validated_storage_migration() -> None:
    exporter = EXPORTER.read_text(encoding="utf-8")
    restorer = (REPO_ROOT / "scripts/restore_persistent_fem_runtime.sh").read_text(
        encoding="utf-8"
    )

    assert 'source "${SOURCE_ROOT}/scripts/lib/managed_fem_runtime_storage.sh"' in exporter
    assert 'migrate_managed_fem_runtime_variants "${variants_alias}"' in exporter
    assert 'source "${REPO_ROOT}/scripts/lib/managed_fem_runtime_storage.sh"' in restorer
    assert 'migrate_managed_fem_runtime_variants "${variants_alias}"' in restorer
    assert "validate_managed_fem_runtime_storage_target" in restorer
    assert restorer.index("validate_managed_fem_runtime_storage_target") < restorer.index(
        'tar -C "${staging}"'
    )


def test_migration_rejects_mismatched_collision_without_deleting_legacy(tmp_path: Path) -> None:
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    durable = tmp_path / "durable/variants"
    validator = tmp_path / "validator.py"
    _validator(validator)
    legacy = _variant(alias, "same", "legacy")
    _variant(durable, "same", "different")

    result = _migrate(alias, durable, validator)

    assert result.returncode != 0
    assert alias.is_dir() and not alias.is_symlink()
    assert (legacy / "bin/worker").read_text(encoding="utf-8") == "legacy"


def test_migration_accepts_only_an_exact_existing_durable_collision(tmp_path: Path) -> None:
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    durable = tmp_path / "durable/variants"
    validator = tmp_path / "validator.py"
    _validator(validator)
    legacy = _variant(alias, "same", "identical")
    durable_variant = durable / "same"
    shutil.copytree(legacy, durable_variant, symlinks=True)

    result = _migrate(alias, durable, validator)

    assert result.returncode == 0, result.stderr
    assert alias.is_symlink()
    assert alias.resolve() == durable.resolve()
    assert (durable_variant / "bin/worker").read_text(encoding="utf-8") == "identical"


def test_migration_rejects_exact_collision_symlinked_outside_durable_root(
    tmp_path: Path,
) -> None:
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    durable = tmp_path / "durable/variants"
    external = tmp_path / "external"
    validator = tmp_path / "validator.py"
    _validator(validator)
    legacy = _variant(alias, "same", "identical")
    external_variant = external / "same"
    shutil.copytree(legacy, external_variant, symlinks=True)
    durable.mkdir(parents=True)
    (durable / "same").symlink_to(external_variant, target_is_directory=True)

    result = _migrate(alias, durable, validator)

    assert result.returncode != 0
    assert alias.is_dir() and not alias.is_symlink()
    assert legacy.is_dir() and not legacy.is_symlink()
    assert (legacy / "bin/worker").read_text(encoding="utf-8") == "identical"
    assert (durable / "same").is_symlink()


def test_migration_rejects_invalid_variant_before_deleting_any_source(tmp_path: Path) -> None:
    alias = tmp_path / "repo/.fullmag/runtimes/fem-gpu-variants"
    durable = tmp_path / "durable/variants"
    validator = tmp_path / "validator.py"
    _validator(validator)
    valid = _variant(alias, "valid")
    invalid = alias / "invalid"
    invalid.mkdir(parents=True)

    result = _migrate(alias, durable, validator)

    assert result.returncode != 0
    assert valid.exists()
    assert invalid.exists()
    assert alias.is_dir() and not alias.is_symlink()


def test_launcher_recovers_repo_root_through_two_runtime_symlinks(tmp_path: Path) -> None:
    source = EXPORTER.read_text(encoding="utf-8")
    launcher = source.split("<<'EOF'\n", 1)[1].split("\nEOF", 1)[0]
    repo = tmp_path / "repo"
    durable_variant = tmp_path / "durable/variants/test-variant"
    (durable_variant / "bin").mkdir(parents=True)
    launcher_path = durable_variant / "bin/fullmag-fem-gpu"
    launcher_path.write_text(launcher, encoding="utf-8")
    launcher_path.chmod(0o755)
    worker = durable_variant / "bin/fullmag-fem-gpu-bin"
    worker.write_text('#!/bin/sh\nprintf "%s\\n" "$FULLMAG_REPO_ROOT"\n', encoding="utf-8")
    worker.chmod(0o755)
    runtime_parent = repo / ".fullmag/runtimes"
    runtime_parent.mkdir(parents=True)
    (runtime_parent / "fem-gpu-variants").symlink_to(durable_variant.parent)
    (runtime_parent / "fem-gpu-host").symlink_to("fem-gpu-variants/test-variant")

    result = subprocess.run(
        [str(runtime_parent / "fem-gpu-host/bin/fullmag-fem-gpu")],
        cwd=repo,
        env={**os.environ, "LD_LIBRARY_PATH": "", "PYTHONPATH": ""},
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(repo)
