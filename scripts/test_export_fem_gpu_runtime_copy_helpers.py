#!/usr/bin/env python3
"""Unit tests for managed FEM runtime export copy helpers."""

from __future__ import annotations

import subprocess
import hashlib
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "scripts" / "lib" / "runtime_bundle_copy.sh"
EXPORT_SCRIPT = REPO_ROOT / "scripts" / "export_fem_gpu_runtime.sh"
VALIDATOR = REPO_ROOT / "scripts" / "validate_managed_fem_runtime_bundle.py"


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


def test_runtime_copy_replaces_existing_symlink_with_source_symlink(tmp_path: Path) -> None:
    source_dir = tmp_path / "source"
    dest_dir = tmp_path / "dest"
    source_dir.mkdir()
    dest_dir.mkdir()
    (source_dir / "libsuitesparseconfig.so.5.10.1").write_text(
        "versioned shared object\n",
        encoding="utf-8",
    )
    (source_dir / "libsuitesparseconfig.so.5").symlink_to(
        "libsuitesparseconfig.so.5.10.1"
    )
    (dest_dir / "old-target.so").write_text("old shared object\n", encoding="utf-8")
    (dest_dir / "libsuitesparseconfig.so.5").symlink_to("old-target.so")

    result = run_bash(
        f"""
        source {HELPER}
        copy_runtime_entry_replace {source_dir / "libsuitesparseconfig.so.5"} {dest_dir}
        test -L {dest_dir / "libsuitesparseconfig.so.5"}
        test "$(readlink {dest_dir / "libsuitesparseconfig.so.5"})" = "libsuitesparseconfig.so.5.10.1"
        """
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_runtime_copy_dependency_closure_can_copy_same_resolved_library_twice(
    tmp_path: Path,
) -> None:
    source_dir = tmp_path / "source"
    dest_dir = tmp_path / "dest"
    source_dir.mkdir()
    dest_dir.mkdir()
    resolved = source_dir / "libtrilinos_ml.so.13.2"
    requested = source_dir / "libtrilinos_ml.so"
    resolved.write_text("trilinos ml\n", encoding="utf-8")
    requested.symlink_to(resolved.name)

    result = run_bash(
        f"""
        source {HELPER}
        copy_runtime_resolved_dependency_pair {requested} {resolved} {dest_dir}
        copy_runtime_resolved_dependency_pair {requested} {resolved} {dest_dir}
        test -L {dest_dir / requested.name}
        test "$(readlink {dest_dir / requested.name})" = "{resolved.name}"
        test "$(cat {dest_dir / resolved.name})" = "trilinos ml"
        """
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_runtime_soname_link_is_noop_when_resolved_name_is_unversioned(
    tmp_path: Path,
) -> None:
    dest_dir = tmp_path / "dest"
    dest_dir.mkdir()
    soname = dest_dir / "libslepc_real.so"
    soname.write_text("unversioned shared object\n", encoding="utf-8")

    result = run_bash(
        f"""
        source {HELPER}
        ensure_runtime_soname_link {dest_dir} libslepc_real libslepc_real.so
        test ! -L {soname}
        test "$(cat {soname})" = "unversioned shared object"
        """
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_runtime_soname_link_replaces_existing_entry_with_versioned_symlink(
    tmp_path: Path,
) -> None:
    dest_dir = tmp_path / "dest"
    dest_dir.mkdir()
    (dest_dir / "libpetsc_real.so").write_text("stale entry\n", encoding="utf-8")
    (dest_dir / "libpetsc_real.so.3.15").write_text("versioned shared object\n", encoding="utf-8")

    result = run_bash(
        f"""
        source {HELPER}
        ensure_runtime_soname_link {dest_dir} libpetsc_real libpetsc_real.so.3.15
        test -L {dest_dir / "libpetsc_real.so"}
        test "$(readlink {dest_dir / "libpetsc_real.so"})" = "libpetsc_real.so.3.15"
        """
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_runtime_soname_link_uses_force_no_dereference_symlink_creation() -> None:
    helper = HELPER.read_text(encoding="utf-8")

    assert 'ln -sfn "$resolved_name" "$soname"' in helper


def test_export_script_recreates_unversioned_fullmag_native_library_links() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    function_start = script.find("copy_native_library_group() {")
    function_end = script.find("resolve_pkg_library_path()", function_start)
    native_copy_function = script[function_start:function_end]

    assert function_start != -1
    assert function_end != -1
    assert 'ensure_runtime_soname_link "$dest_dir" "$stem" "$resolved_name"' in native_copy_function
    assert 'copy_native_library_group "$FEM_LIB" libfullmag_fem' in script
    assert 'copy_native_library_group "$FDM_LIB" libfullmag_fdm' in script


def test_export_script_forces_fem_sys_native_rebuild_before_copying_libraries() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    clean_index = script.find("cargo clean -p fullmag-fem-sys")
    build_index = script.find("cargo +nightly build")
    copy_index = script.find('FEM_LIB="$(latest_native_lib_dir')

    assert clean_index != -1
    assert build_index != -1
    assert copy_index != -1
    assert clean_index < build_index < copy_index


def test_export_script_restores_runtime_bundle_to_host_owner() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'FULLMAG_HOST_UID="$(id -u)"' in script
    assert 'FULLMAG_HOST_GID="$(id -g)"' in script
    assert 'chown "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" .fullmag .fullmag/runtimes' in script
    assert 'chown -R "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}"' in script
    assert 'chmod u+rwx,go+rx,go-w .fullmag .fullmag/runtimes' in script
    assert 'chmod -R u+rwX,go+rX,go-w ${runtime_root}' in script
    assert 'stat -c "%u:%g" .fullmag/runtimes/fem-gpu-host' not in script


def test_export_script_restores_staging_owner_when_container_build_fails() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    trap_index = script.find("trap restore_staging_owner EXIT")
    build_index = script.find("cargo +nightly build")

    assert "restore_staging_owner() {" in script
    assert 'chown -R "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" "${runtime_root}"' in script
    assert trap_index != -1
    assert build_index != -1
    assert trap_index < build_index


def test_export_script_serializes_runtime_bundle_mutation_with_flock() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    lock_index = script.find('RUNTIME_LOCK="${RUNTIME_PARENT}/.fem-gpu-host.export.lock"')
    flock_index = script.find('flock 9')
    compose_index = script.find("docker compose --profile fem-gpu build fem-gpu")

    assert lock_index != -1
    assert flock_index != -1
    assert compose_index != -1
    assert lock_index < flock_index < compose_index


def test_export_script_publishes_only_a_validated_staging_bundle() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'STAGING_ROOT="${RUNTIME_ROOT}.staging.$$"' in script
    assert 'FULLMAG_RUNTIME_EXPORT_STAGING=".fullmag/runtimes/$(basename "${STAGING_ROOT}")"' in script
    assert 'publish_runtime_bundle() {' in script
    assert 'python3 scripts/validate_managed_fem_runtime_bundle.py --runtime-root "${STAGING_ROOT}"' in script
    assert 'mv "${RUNTIME_ROOT}" "${backup_root}"' in script
    assert 'mv "${STAGING_ROOT}" "${RUNTIME_ROOT}"' in script
    assert 'rm -f "${RUNTIME_ROOT}/manifest.json"' in script
    assert 'trap cleanup_failed_export EXIT' in script


def test_managed_runtime_validator_requires_api_binary_hash() -> None:
    validator = (REPO_ROOT / "scripts" / "validate_managed_fem_runtime_bundle.py").read_text(
        encoding="utf-8"
    )
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'for name in ("launcher", "worker", "api"):' in validator
    assert '"api_sha256"' in exporter


def test_managed_runtime_validator_rejects_missing_or_mismatched_api(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    bin_dir = runtime / "bin"
    bin_dir.mkdir(parents=True)
    files = {
        "launcher": bin_dir / "fullmag-fem-gpu",
        "worker": bin_dir / "fullmag-fem-gpu-bin",
        "api": bin_dir / "fullmag-api",
    }
    for path in files.values():
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
    manifest = {
        "runtime": "fem-gpu-host",
        "binaries": {name: str(path.relative_to(runtime)) for name, path in files.items()},
        "integrity": {
            f"{name}_sha256": hashlib.sha256(path.read_bytes()).hexdigest()
            for name, path in files.items()
        },
    }
    (runtime / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    valid = subprocess.run(
        ["python3", str(VALIDATOR), "--runtime-root", str(runtime)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert valid.returncode == 0, valid.stderr

    files["api"].write_text("tampered\n", encoding="utf-8")
    invalid = subprocess.run(
        ["python3", str(VALIDATOR), "--runtime-root", str(runtime)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert invalid.returncode != 0
    assert "api hash mismatch" in invalid.stderr


def test_export_script_replaces_existing_runtime_binaries_before_copying() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    function_start = script.find("copy_runtime_binary() {")
    function_end = script.find("copy_runtime_binary target/release/fullmag", function_start)
    copy_binary_function = script[function_start:function_end]

    assert function_start != -1
    assert function_end != -1
    assert 'rm -rf -- "$dest"' in copy_binary_function
    assert 'cp --remove-destination "$src" "$dest"' in copy_binary_function
    assert 'chmod 755 "$dest"' in copy_binary_function


def test_export_script_skips_unversioned_soname_symlink_before_recreating_it() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'if [ "$(basename "$src")" = "${stem}.so" ]; then' in script
    assert 'ensure_runtime_soname_link "$dest_dir" "$stem" "$resolved_name"' in script


def test_export_script_replaces_existing_versioned_native_symlinks() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    function_start = script.find("copy_library_group_entry_replace() {")
    function_end = script.find("copy_native_library_group() {", function_start)
    copy_entry_function = script[function_start:function_end]

    assert function_start != -1
    assert function_end != -1
    assert 'ln -sfn "$(readlink "$src")" "$dest"' in copy_entry_function
