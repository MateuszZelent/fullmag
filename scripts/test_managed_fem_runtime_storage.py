from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess


REPO_ROOT = Path(__file__).resolve().parents[1]
STORAGE_HELPER = REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
EXPORTER = REPO_ROOT / "scripts/export_fem_gpu_runtime.sh"


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


def _rebind(
    active: Path,
    alias: Path,
    durable: Path,
    variant: Path,
    validator: Path,
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    return subprocess.run(
        [
            "bash", "-euo", "pipefail", "-c",
            (
                'source "$1"; rebind_managed_fem_runtime_aliases '
                '"$2" "$3" "$4" "$5" "$6"'
            ),
            "bash",
            str(STORAGE_HELPER),
            str(active),
            str(alias),
            str(durable),
            str(variant),
            str(validator),
        ],
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


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
    assert "prepare_managed_fem_runtime_variants_for_rebind" in exporter
    assert 'rebind_managed_fem_runtime_aliases "${RUNTIME_ROOT}"' in exporter
    assert 'source "${REPO_ROOT}/scripts/lib/managed_fem_runtime_storage.sh"' in restorer
    assert "prepare_managed_fem_runtime_variants_for_rebind" in restorer
    assert 'rebind_managed_fem_runtime_aliases "${runtime_parent}/fem-gpu-host"' in restorer
    assert "validate_managed_fem_runtime_storage_target" in restorer
    assert restorer.index("validate_managed_fem_runtime_storage_target") < restorer.index(
        'tar -C "${staging}"'
    )


def test_rebind_operation_does_not_call_legacy_copy_delete_migration() -> None:
    helper = STORAGE_HELPER.read_text(encoding="utf-8")
    start = helper.index("rebind_managed_fem_runtime_aliases() {")
    body = helper[start:]

    assert "migrate_managed_fem_runtime_variants" not in body
    assert "cp -a" not in body
    assert "rm -rf" not in body


def test_rebind_switches_profiles_without_copying_or_deleting_old_variants(
    tmp_path: Path,
) -> None:
    runtime_parent = tmp_path / "repo/.fullmag/runtimes"
    runtime_parent.mkdir(parents=True)
    active = runtime_parent / "fem-gpu-host"
    alias = runtime_parent / "fem-gpu-variants"
    old_root = tmp_path / "old/variants"
    old_variant = _variant(old_root, "old", "old-payload")
    new_root = tmp_path / "new/variants"
    new_variant = _variant(new_root, "new", "new-payload")
    alias.symlink_to(old_root)
    active.symlink_to("fem-gpu-variants/old")
    validator = tmp_path / "validator.py"
    _validator(validator)

    result = _rebind(active, alias, new_root, new_variant, validator)

    assert result.returncode == 0, result.stderr
    assert active.is_symlink()
    assert os.readlink(active) == "fem-gpu-variants/new"
    assert active.resolve() == new_variant.resolve()
    assert alias.resolve() == new_root.resolve()
    assert old_variant.is_dir() and not old_variant.is_symlink()
    assert (old_variant / "bin/worker").read_text(encoding="utf-8") == "old-payload"
    assert sorted(path.name for path in old_root.iterdir()) == ["old"]
    assert sorted(path.name for path in new_root.iterdir()) == ["new"]


def test_rebind_keeps_active_runtime_resolvable_after_each_atomic_switch_failure(
    tmp_path: Path,
) -> None:
    validator = tmp_path / "validator.py"
    _validator(validator)

    for fail_on_call in (1, 2, 3):
        case = tmp_path / f"case-{fail_on_call}"
        runtime_parent = case / "repo/.fullmag/runtimes"
        runtime_parent.mkdir(parents=True)
        active = runtime_parent / "fem-gpu-host"
        alias = runtime_parent / "fem-gpu-variants"
        old_root = case / "old/variants"
        old_variant = _variant(old_root, "old", "old-payload")
        new_root = case / "new/variants"
        new_variant = _variant(new_root, "new", "new-payload")
        alias.symlink_to(old_root)
        active.symlink_to("fem-gpu-variants/old")
        fake_bin = case / "bin"
        fake_bin.mkdir()
        counter = case / "mv-counter"
        fake_mv = fake_bin / "mv"
        fake_mv.write_text(
            "#!/bin/sh\n"
            'count=0; [ ! -f "$MV_COUNTER" ] || count="$(cat "$MV_COUNTER")"\n'
            'count=$((count + 1)); printf "%s\\n" "$count" > "$MV_COUNTER"\n'
            'if [ "$count" = "$MV_FAIL_ON" ]; then exit 86; fi\n'
            'exec /bin/mv "$@"\n',
            encoding="utf-8",
        )
        fake_mv.chmod(0o755)
        environment_path = f"{fake_bin}:{os.environ['PATH']}"
        environment = os.environ.copy()
        environment["PATH"] = environment_path
        environment["MV_COUNTER"] = str(counter)
        environment["MV_FAIL_ON"] = str(fail_on_call)
        result = subprocess.run(
            [
                "bash", "-euo", "pipefail", "-c",
                (
                    'source "$1"; rebind_managed_fem_runtime_aliases '
                    '"$2" "$3" "$4" "$5" "$6"'
                ),
                "bash",
                str(STORAGE_HELPER),
                str(active),
                str(alias),
                str(new_root),
                str(new_variant),
                str(validator),
            ],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode != 0
        assert active.is_symlink()
        assert active.resolve().is_dir()
        assert (active.resolve() / "bin/worker").is_file()
        assert old_variant.is_dir()
        assert new_variant.is_dir()


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
