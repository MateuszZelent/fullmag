import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
RESTORE_SCRIPT = REPO_ROOT / "scripts/restore_persistent_fem_runtime.sh"
STORAGE_HELPER = REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
CANONICAL_IMAGE = "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4"
NATIVE_2_IMAGE = "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native-2.ext4"


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


def test_native_2_restore_requires_native_2_backing_before_extraction(
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
    variants_root = tmp_path / "native-2/variants"
    env = {
        **os.environ,
        "FULLMAG_BUILD_ROOT": str(build_root),
        "FULLMAG_RUNTIME_VARIANTS_ROOT": str(variants_root),
        "FULLMAG_NATIVE_STORAGE_PROFILE": "native-2",
    }
    _inject_mount_metadata(tmp_path, env, backing_image=CANONICAL_IMAGE)

    result = subprocess.run(
        ["bash", str(scripts / RESTORE_SCRIPT.name)],
        cwd=fake_repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2, result.stderr
    assert NATIVE_2_IMAGE in result.stderr
    assert CANONICAL_IMAGE in result.stderr
    assert not variants_root.exists()


def test_native_2_restore_rebinds_active_runtime_from_canonical_root(
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
    (bundle / "bin/fullmag-fem-gpu").write_text("native-2\n", encoding="utf-8")
    build_root = tmp_path / "persistent"
    archive = _write_latest_archive(build_root, bundle)
    old_root = tmp_path / "canonical/variants"
    old_variant = old_root / "old"
    (old_variant / "bin").mkdir(parents=True)
    (old_variant / "bin/fullmag-fem-gpu").write_text("canonical\n", encoding="utf-8")
    runtime_parent = fake_repo / ".fullmag/runtimes"
    runtime_parent.mkdir(parents=True)
    (runtime_parent / "fem-gpu-variants").symlink_to(old_root)
    (runtime_parent / "fem-gpu-host").symlink_to("fem-gpu-variants/old")
    new_root = tmp_path / "native-2/variants"
    env = {
        **os.environ,
        "FULLMAG_BUILD_ROOT": str(build_root),
        "FULLMAG_RUNTIME_VARIANTS_ROOT": str(new_root),
        "FULLMAG_NATIVE_STORAGE_PROFILE": "native-2",
    }
    _inject_mount_metadata(tmp_path, env, backing_image=NATIVE_2_IMAGE)

    result = subprocess.run(
        ["bash", str(scripts / RESTORE_SCRIPT.name)],
        cwd=fake_repo,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    manifest_sha = hashlib.sha256(manifest_bytes).hexdigest()
    new_variant = new_root / f"test-variant-{manifest_sha}"
    assert archive == build_root / "runtimes/fem-gpu-host-latest.tar"
    assert (runtime_parent / "fem-gpu-host").resolve() == new_variant.resolve()
    assert os.readlink(runtime_parent / "fem-gpu-host") == (
        f"fem-gpu-variants/{new_variant.name}"
    )
    assert (runtime_parent / "fem-gpu-variants").resolve() == new_root.resolve()
    assert (old_variant / "bin/fullmag-fem-gpu").read_text(encoding="utf-8") == "canonical\n"


def test_concurrent_profile_restores_share_export_lock_and_cannot_interleave_rebind(
    tmp_path: Path,
) -> None:
    fake_repo = tmp_path / "repo"
    scripts = fake_repo / "scripts"
    scripts.mkdir(parents=True)
    shutil.copy2(RESTORE_SCRIPT, scripts / RESTORE_SCRIPT.name)
    (scripts / "lib").mkdir()
    shutil.copy2(STORAGE_HELPER, scripts / "lib" / STORAGE_HELPER.name)
    _write_fake_validator(scripts / "validate_managed_fem_runtime_bundle.py")

    canonical_bundle = tmp_path / "canonical-bundle"
    (canonical_bundle / "bin").mkdir(parents=True)
    canonical_manifest = json.dumps({"variant": "canonical-a"}).encode()
    (canonical_bundle / "manifest.json").write_bytes(canonical_manifest)
    (canonical_bundle / "bin/fullmag-fem-gpu").write_text(
        "canonical\n", encoding="utf-8"
    )
    canonical_build_root = tmp_path / "canonical-build"
    _write_latest_archive(canonical_build_root, canonical_bundle)

    native_2_bundle = tmp_path / "native-2-bundle"
    (native_2_bundle / "bin").mkdir(parents=True)
    native_2_manifest = json.dumps({"variant": "native-2-b"}).encode()
    (native_2_bundle / "manifest.json").write_bytes(native_2_manifest)
    (native_2_bundle / "bin/fullmag-fem-gpu").write_text(
        "native-2\n", encoding="utf-8"
    )
    native_2_build_root = tmp_path / "native-2-build"
    _write_latest_archive(native_2_build_root, native_2_bundle)

    canonical_variants = tmp_path / "canonical/variants"
    native_2_variants = tmp_path / "native-2/variants"
    canonical_env = {
        **os.environ,
        "FULLMAG_BUILD_ROOT": str(canonical_build_root),
        "FULLMAG_RUNTIME_VARIANTS_ROOT": str(canonical_variants),
    }
    native_2_env = {
        **os.environ,
        "FULLMAG_BUILD_ROOT": str(native_2_build_root),
        "FULLMAG_RUNTIME_VARIANTS_ROOT": str(native_2_variants),
        "FULLMAG_NATIVE_STORAGE_PROFILE": "native-2",
    }
    canonical_env.pop("FULLMAG_RUNTIME_EXPORT_LOCK_HELD", None)
    native_2_env.pop("FULLMAG_RUNTIME_EXPORT_LOCK_HELD", None)
    canonical_mount = tmp_path / "canonical-mount"
    native_2_mount = tmp_path / "native-2-mount"
    canonical_mount.mkdir()
    native_2_mount.mkdir()
    _inject_mount_metadata(canonical_mount, canonical_env)
    _inject_mount_metadata(
        native_2_mount, native_2_env, backing_image=NATIVE_2_IMAGE
    )

    canonical_direct = tmp_path / "canonical-direct"
    release_canonical = tmp_path / "release-canonical"
    canonical_mv = canonical_mount / "fake-bin/mv"
    canonical_mv.write_text(
        "#!/bin/sh\n"
        "pause=0\n"
        "for argument in \"$@\"; do\n"
        '  case "$argument" in *.direct-next.*) pause=1 ;; esac\n'
        "done\n"
        'if [ "$pause" = 1 ]; then\n'
        "  /bin/mv \"$@\"\n"
        '  : > "$DIRECT_SWITCH_MARKER"\n'
        '  while [ ! -e "$RELEASE_REBIND" ]; do sleep 0.01; done\n'
        "  exit 0\n"
        "fi\n"
        "exec /bin/mv \"$@\"\n",
        encoding="utf-8",
    )
    canonical_mv.chmod(0o755)
    canonical_env["DIRECT_SWITCH_MARKER"] = str(canonical_direct)
    canonical_env["RELEASE_REBIND"] = str(release_canonical)

    native_2_variants_switched = tmp_path / "native-2-variants-switched"
    release_native_2 = tmp_path / "release-native-2"
    native_2_lock_attempt = tmp_path / "native-2-lock-attempt"
    native_2_lock_acquired = tmp_path / "native-2-lock-acquired"
    native_2_mv = native_2_mount / "fake-bin/mv"
    native_2_mv.write_text(
        "#!/bin/sh\n"
        "pause=0\n"
        "for argument in \"$@\"; do\n"
        '  case "$argument" in *fem-gpu-variants.next.*) pause=1 ;; esac\n'
        "done\n"
        'if [ "$pause" = 1 ]; then\n'
        "  /bin/mv \"$@\"\n"
        '  : > "$VARIANTS_SWITCH_MARKER"\n'
        '  while [ ! -e "$RELEASE_REBIND" ]; do sleep 0.01; done\n'
        "  exit 0\n"
        "fi\n"
        "exec /bin/mv \"$@\"\n",
        encoding="utf-8",
    )
    native_2_mv.chmod(0o755)
    native_2_flock = native_2_mount / "fake-bin/flock"
    native_2_flock.write_text(
        "#!/bin/sh\n"
        ': > "$LOCK_ATTEMPT_MARKER"\n'
        'if [ "$1" = -n ]; then exec /usr/bin/flock "$@"; fi\n'
        'close_option="$1"\n'
        'lock_path="$2"\n'
        "shift 2\n"
        "exec /usr/bin/flock \"$close_option\" \"$lock_path\" "
        "sh -c ': > \"$LOCK_ACQUIRED_MARKER\"; exec \"$@\"' sh \"$@\"\n",
        encoding="utf-8",
    )
    native_2_flock.chmod(0o755)
    native_2_env["VARIANTS_SWITCH_MARKER"] = str(native_2_variants_switched)
    native_2_env["RELEASE_REBIND"] = str(release_native_2)
    native_2_env["LOCK_ATTEMPT_MARKER"] = str(native_2_lock_attempt)
    native_2_env["LOCK_ACQUIRED_MARKER"] = str(native_2_lock_acquired)

    command = ["bash", str(scripts / RESTORE_SCRIPT.name)]
    canonical_process = subprocess.Popen(
        command,
        cwd=fake_repo,
        env=canonical_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    native_2_process: subprocess.Popen[str] | None = None

    def wait_for(path: Path, process: subprocess.Popen[str]) -> None:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if path.exists():
                return
            assert process.poll() is None, f"process exited before creating {path}"
            time.sleep(0.01)
        raise AssertionError(f"timed out waiting for {path}")

    try:
        wait_for(canonical_direct, canonical_process)
        native_2_process = subprocess.Popen(
            command,
            cwd=fake_repo,
            env=native_2_env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if native_2_lock_attempt.exists() or native_2_variants_switched.exists():
                break
            assert native_2_process.poll() is None
            time.sleep(0.01)
        second_restore_waited_for_lock = (
            native_2_lock_attempt.exists()
            and not native_2_lock_acquired.exists()
            and not native_2_variants_switched.exists()
        )

        release_canonical.touch()
        _, canonical_stderr = canonical_process.communicate(timeout=5)
        assert canonical_process.returncode == 0, canonical_stderr
        wait_for(native_2_lock_acquired, native_2_process)
        wait_for(native_2_variants_switched, native_2_process)
        release_native_2.touch()
        _, native_2_stderr = native_2_process.communicate(timeout=5)
        assert native_2_process.returncode == 0, native_2_stderr
    finally:
        release_canonical.touch()
        release_native_2.touch()
        for process in (canonical_process, native_2_process):
            if process is not None and process.poll() is None:
                process.terminate()
                process.communicate(timeout=5)

    assert second_restore_waited_for_lock
    runtime_parent = fake_repo / ".fullmag/runtimes"
    manifest_sha = hashlib.sha256(native_2_manifest).hexdigest()
    native_2_variant = native_2_variants / f"native-2-b-{manifest_sha}"
    active = runtime_parent / "fem-gpu-host"
    variants_alias = runtime_parent / "fem-gpu-variants"
    assert os.readlink(active) == f"fem-gpu-variants/{native_2_variant.name}"
    assert variants_alias.resolve() == native_2_variants.resolve()
    assert active.resolve() == native_2_variant.resolve()


def test_restore_reuses_export_lock_wrapper_before_archive_or_rebind() -> None:
    restorer = RESTORE_SCRIPT.read_text(encoding="utf-8")
    exporter = (REPO_ROOT / "scripts/export_fem_gpu_runtime.sh").read_text(
        encoding="utf-8"
    )
    lock_declaration = (
        'RUNTIME_LOCK="${runtime_parent}/.fem-gpu-host.export.v2.lock"'
    )

    assert lock_declaration in restorer
    assert '.fem-gpu-host.export.v2.lock"' in exporter
    assert 'FULLMAG_RUNTIME_EXPORT_LOCK_HELD' in restorer
    assert 'exec flock --close "${RUNTIME_LOCK}" bash "$0" "$@"' in restorer
    lock_index = restorer.index('if [ "${FULLMAG_RUNTIME_EXPORT_LOCK_HELD:-0}"')
    assert lock_index < restorer.index('[ -f "${archive}" ]')
    assert lock_index < restorer.index('tar -C "${staging}"')
    assert lock_index < restorer.index("rebind_managed_fem_runtime_aliases")


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
