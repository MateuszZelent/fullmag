import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
RESTORE_SCRIPT = REPO_ROOT / "scripts/restore_persistent_fem_runtime.sh"
STORAGE_HELPER = REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
CANONICAL_IMAGE = "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4"


def _write_fake_validator(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env python3
import argparse
import hashlib
import os
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-root", type=Path, required=True)
parser.add_argument("--compare-exact", type=Path)
parser.add_argument("--allow-unaddressed-staging", action="store_true")
args = parser.parse_args()

def identity(root):
    result = {}
    for item in sorted(root.rglob("*")):
        relative = str(item.relative_to(root))
        if item.is_symlink():
            result[relative] = ("symlink", os.readlink(item))
        elif item.is_dir():
            result[relative] = ("directory",)
        else:
            result[relative] = ("file", hashlib.sha256(item.read_bytes()).hexdigest())
    return result

if not (args.runtime_root / "manifest.json").is_file():
    raise SystemExit(2)
if args.compare_exact is not None and identity(args.runtime_root) != identity(args.compare_exact):
    raise SystemExit(2)
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_latest_archive(build_root: Path, bundle: Path) -> Path:
    archive = build_root / "runtimes/fem-gpu-host-latest.tar"
    archive.parent.mkdir(parents=True)
    with tarfile.open(archive, "w") as output:
        output.add(bundle, arcname=".")
    return archive


def _inject_mount_metadata(
    root: Path,
    env: dict[str, str],
    *,
    filesystem_type: str = "ext4",
    source: str = "/dev/loop99",
    backing_image: str = CANONICAL_IMAGE,
) -> None:
    fake_bin = root / "fake-bin"
    fake_bin.mkdir()
    findmnt = fake_bin / "findmnt"
    findmnt.write_text(
        "#!/bin/sh\n"
        'case "$*" in\n'
        f'  *"-o FSTYPE"*) printf "%s\\n" "{filesystem_type}" ;;\n'
        f'  *"-o SOURCE"*) printf "%s\\n" "{source}" ;;\n'
        "  *) exit 3 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    findmnt.chmod(0o755)
    sysfs_root = root / "sys/class/block"
    if source.startswith("/dev/loop"):
        backing_file = sysfs_root / Path(source).name / "loop/backing_file"
        backing_file.parent.mkdir(parents=True)
        backing_file.write_text(f"{backing_image}\n", encoding="utf-8")
    env["FULLMAG_LOOP_SYSFS_ROOT"] = str(sysfs_root)
    env["PATH"] = f"{fake_bin}:{env['PATH']}"


@pytest.mark.parametrize(
    ("filesystem_type", "source", "expected_error"),
    [
        ("xfs", "/dev/loop99", "must be an ext4 filesystem"),
        ("ext4", "/dev/sda1", "must use a loop device"),
    ],
)
def test_restore_rejects_invalid_mount_metadata_before_extraction(
    tmp_path: Path,
    filesystem_type: str,
    source: str,
    expected_error: str,
) -> None:
    fake_repo = tmp_path / "repo"
    scripts = fake_repo / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(RESTORE_SCRIPT, scripts / RESTORE_SCRIPT.name)
    (scripts / "lib").mkdir()
    shutil.copy2(STORAGE_HELPER, scripts / "lib" / STORAGE_HELPER.name)
    _write_fake_validator(scripts / "validate_managed_fem_runtime_bundle.py")

    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "manifest.json").write_text(
        json.dumps({"variant": "test-variant"}), encoding="utf-8"
    )
    build_root = tmp_path / "persistent"
    _write_latest_archive(build_root, bundle)
    variants_root = tmp_path / "ordinary-filesystem/variants"
    env = {
        **os.environ,
        "FULLMAG_BUILD_ROOT": str(build_root),
        "FULLMAG_RUNTIME_VARIANTS_ROOT": str(variants_root),
    }
    _inject_mount_metadata(
        tmp_path,
        env,
        filesystem_type=filesystem_type,
        source=source,
    )

    result = subprocess.run(
        ["bash", str(scripts / RESTORE_SCRIPT.name)],
        cwd=fake_repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2, result.stderr
    assert expected_error in result.stderr
    assert not variants_root.exists()


def test_restore_rejects_wrong_loop_backing_image_before_extraction(
    tmp_path: Path,
) -> None:
    fake_repo = tmp_path / "repo"
    scripts = fake_repo / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(RESTORE_SCRIPT, scripts / RESTORE_SCRIPT.name)
    (scripts / "lib").mkdir()
    shutil.copy2(STORAGE_HELPER, scripts / "lib" / STORAGE_HELPER.name)
    _write_fake_validator(scripts / "validate_managed_fem_runtime_bundle.py")
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    (bundle / "manifest.json").write_text(
        json.dumps({"variant": "test-variant"}), encoding="utf-8"
    )
    build_root = tmp_path / "persistent"
    _write_latest_archive(build_root, bundle)
    variants_root = tmp_path / "wrong-backing/variants"
    env = {
        **os.environ,
        "FULLMAG_BUILD_ROOT": str(build_root),
        "FULLMAG_RUNTIME_VARIANTS_ROOT": str(variants_root),
    }
    _inject_mount_metadata(tmp_path, env, backing_image=str(tmp_path / "wrong.ext4"))

    result = subprocess.run(
        ["bash", str(scripts / RESTORE_SCRIPT.name)],
        cwd=fake_repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2, result.stderr
    assert "wrong physical backing image" in result.stderr
    assert CANONICAL_IMAGE in result.stderr
    assert not variants_root.exists()


def test_restore_repairs_corrupt_same_name_variant_from_latest_archive(
    tmp_path: Path,
) -> None:
    fake_repo = tmp_path / "repo"
    scripts = fake_repo / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(RESTORE_SCRIPT, scripts / RESTORE_SCRIPT.name)
    (scripts / "lib").mkdir()
    shutil.copy2(STORAGE_HELPER, scripts / "lib" / STORAGE_HELPER.name)
    _write_fake_validator(scripts / "validate_managed_fem_runtime_bundle.py")

    bundle = tmp_path / "bundle"
    (bundle / "bin").mkdir(parents=True)
    manifest_bytes = json.dumps({"variant": "test-variant"}).encode()
    (bundle / "manifest.json").write_bytes(manifest_bytes)
    (bundle / "bin/fullmag-fem-gpu").write_text("known-good\n", encoding="utf-8")
    (bundle / "bin/fullmag-fem-gpu-link").symlink_to("fullmag-fem-gpu")

    build_root = tmp_path / "persistent"
    _write_latest_archive(build_root, bundle)

    env = os.environ.copy()
    env["FULLMAG_BUILD_ROOT"] = str(build_root)
    durable_runtime_root = tmp_path / "durable-runtime"
    env["FULLMAG_RUNTIME_VARIANTS_ROOT"] = str(durable_runtime_root / "variants")
    _inject_mount_metadata(tmp_path, env)
    command = ["bash", str(scripts / RESTORE_SCRIPT.name)]
    first = subprocess.run(command, cwd=fake_repo, env=env, text=True, capture_output=True)
    assert first.returncode == 0, first.stderr

    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    variant = durable_runtime_root / "variants" / f"test-variant-{manifest_sha}"
    assert (variant / "bin/fullmag-fem-gpu").read_text(encoding="utf-8") == "known-good\n"
    assert (variant / "bin/fullmag-fem-gpu-link").is_symlink()

    (variant / "bin/fullmag-fem-gpu").write_text("corrupt\n", encoding="utf-8")
    second = subprocess.run(command, cwd=fake_repo, env=env, text=True, capture_output=True)
    assert second.returncode == 0, second.stderr
    assert (variant / "bin/fullmag-fem-gpu").read_text(encoding="utf-8") == "known-good\n"
    assert not list(variant.parent.glob("*.restore-backup.*"))
    assert (fake_repo / ".fullmag/runtimes/fem-gpu-host").resolve() == variant.resolve()
    variants_alias = fake_repo / ".fullmag/runtimes/fem-gpu-variants"
    assert variants_alias.is_symlink()
    assert variants_alias.resolve() == (durable_runtime_root / "variants").resolve()
