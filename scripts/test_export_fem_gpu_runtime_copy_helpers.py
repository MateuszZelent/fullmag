#!/usr/bin/env python3
"""Unit tests for managed FEM runtime export copy helpers."""

from __future__ import annotations

import importlib.util
import subprocess
import hashlib
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "scripts" / "lib" / "runtime_bundle_copy.sh"
EXPORT_SCRIPT = REPO_ROOT / "scripts" / "export_fem_gpu_runtime.sh"
VALIDATOR = REPO_ROOT / "scripts" / "validate_managed_fem_runtime_bundle.py"
MANIFEST_BUILDER = REPO_ROOT / "scripts" / "build_managed_fem_runtime_manifest.py"


def load_validator_module():
    spec = importlib.util.spec_from_file_location("managed_bundle_validator", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def run_bash(script: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-euo", "pipefail", "-c", script],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def write_fake_schema_v2_bundle(
    tmp_path: Path,
    *,
    fullmag_cubins: tuple[str, ...] = ("sm_89",),
    hypre_cubins: tuple[str, ...] = ("sm_89",),
) -> tuple[Path, Path, Path]:
    runtime = tmp_path / "runtime"
    bin_dir = runtime / "bin"
    lib_dir = runtime / "lib"
    bin_dir.mkdir(parents=True)
    lib_dir.mkdir()
    binaries = {
        "launcher": bin_dir / "fullmag-fem-gpu",
        "worker": bin_dir / "fullmag-fem-gpu-bin",
        "api": bin_dir / "fullmag-api",
    }
    for path in binaries.values():
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)

    library_specs = {
        "fullmag_fem": ("libfullmag_fem.so.0.1.0", "libfullmag_fem.so.0", True, fullmag_cubins),
        "mfem": ("libmfem.so.4.9.0", "libmfem.so.4.9.0", True, ("sm_89",)),
        "hypre": ("libHYPRE-3.1.0.so", "libHYPRE-3.1.0.so", True, hypre_cubins),
        "libceed": ("libceed.so.0.12.0", "libceed.so", True, ("sm_89",)),
    }
    native_libraries: dict[str, dict[str, object]] = {}
    for name, (filename, soname, cuda_required, cubins) in library_specs.items():
        target = lib_dir / filename
        target.write_bytes(f"synthetic {name}\n".encode())
        manifest_path = target
        if name == "fullmag_fem":
            manifest_path = lib_dir / soname
            manifest_path.symlink_to(target.name)
        native_libraries[name] = {
            "path": str(manifest_path.relative_to(runtime)),
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "soname": soname,
            "loaded_soname": soname,
            "cuda_required": cuda_required,
            "cubins": list(cubins),
            "ptx": ["compute_90"],
        }

    manifest = {
        "schema": 2,
        "runtime": "fem-gpu-host",
        "variant": "test-sm89",
        "binaries": {
            name: str(path.relative_to(runtime)) for name, path in binaries.items()
        },
        "integrity": {
            f"{name}_sha256": hashlib.sha256(path.read_bytes()).hexdigest()
            for name, path in binaries.items()
        },
        "native_libraries": native_libraries,
        "loader_trace": {
            "worker": {
                "libfullmag_fem.so.0": "lib/libfullmag_fem.so.0.1.0",
            },
            "fullmag_fem": {
                "libmfem.so.4.9.0": "lib/libmfem.so.4.9.0",
                "libHYPRE-3.1.0.so": "lib/libHYPRE-3.1.0.so",
                "libceed.so": "lib/libceed.so.0.12.0",
            },
        },
        "build": {
            "mfem_version": "4.9",
            "hypre_version": "3.1.0",
            "libceed_version": "0.12.0",
            "cuda_toolkit": "12.4",
            "cuda_compiler": "nvcc 12.4",
            "requested_cuda_architectures": "80-real;89-real;90-real;90-virtual",
            "effective_cuda_architectures": ["sm_80", "sm_89", "sm_90", "compute_90"],
        },
        "runtime_diagnostics": {
            "device_name": "Synthetic RTX 4080",
            "compute_capability": "8.9",
        },
    }
    (runtime / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    ldd = tmp_path / "ldd"
    ldd.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        f"ROOT = {str(runtime)!r}\n"
        "if sys.argv[1].endswith('fullmag-fem-gpu-bin'):\n"
        "    print(f'libfullmag_fem.so.0 => {ROOT}/lib/libfullmag_fem.so.0.1.0 (0x1)')\n"
        "    print(f'libHYPRE-3.1.0.so => {ROOT}/lib/libHYPRE-3.1.0.so (0x2)')\n"
        "else:\n"
        "    print(f'libmfem.so.4.9.0 => {ROOT}/lib/libmfem.so.4.9.0 (0x2)')\n"
        "    print(f'libHYPRE-3.1.0.so => {ROOT}/lib/libHYPRE-3.1.0.so (0x3)')\n"
        "    print(f'libceed.so => {ROOT}/lib/libceed.so.0.12.0 (0x4)')\n",
        encoding="utf-8",
    )
    ldd.chmod(0o755)
    readelf = tmp_path / "readelf"
    readelf.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, sys\n"
        "name = pathlib.Path(sys.argv[-1]).name\n"
        "soname = {\n"
        " 'libfullmag_fem.so.0.1.0': 'libfullmag_fem.so.0',\n"
        " 'libmfem.so.4.9.0': 'libmfem.so.4.9.0',\n"
        " 'libHYPRE-3.1.0.so': 'libHYPRE-3.1.0.so',\n"
        " 'libceed.so.0.12.0': 'libceed.so',\n"
        "}[name]\n"
        "print(f' 0x000000000000000e (SONAME) Library soname: [{soname}]')\n",
        encoding="utf-8",
    )
    readelf.chmod(0o755)
    return runtime, ldd, readelf


def validate_fake_bundle(
    runtime: Path,
    ldd: Path,
    readelf: Path,
    *extra: str,
    allow_unaddressed_staging: bool = True,
) -> subprocess.CompletedProcess[str]:
    staging_args = ["--allow-unaddressed-staging"] if allow_unaddressed_staging else []
    return subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--runtime-root",
            str(runtime),
            "--ldd",
            str(ldd),
            "--readelf",
            str(readelf),
            *staging_args,
            *extra,
        ],
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


def test_export_script_publishes_only_a_validated_hash_addressed_bundle() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'STAGING_ROOT="${RUNTIME_ROOT}.staging.$$"' in script
    assert 'STAGING_RELATIVE=".fullmag/runtimes/$(basename "${STAGING_ROOT}")"' in script
    assert '-e FULLMAG_RUNTIME_EXPORT_STAGING="${STAGING_RELATIVE}"' in script
    assert 'publish_runtime_bundle() {' in script
    assert 'python3 scripts/validate_managed_fem_runtime_bundle.py' in script
    assert '--runtime-root "${STAGING_ROOT}"' in script
    assert 'mv "${STAGING_ROOT}" "${variant_root}"' in script
    assert 'refusing to replace non-symlink active runtime' in script
    assert 'rm -f "${RUNTIME_ROOT}/manifest.json"' not in script
    assert 'trap cleanup_failed_export EXIT' in script


def test_managed_runtime_validator_requires_api_binary_hash() -> None:
    validator = (REPO_ROOT / "scripts" / "validate_managed_fem_runtime_bundle.py").read_text(
        encoding="utf-8"
    )
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'for name in ("launcher", "worker", "api"):' in validator
    assert '"api_sha256"' in exporter


def test_managed_runtime_validator_rejects_missing_or_mismatched_api(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    files = {"api": runtime / "bin/fullmag-api"}

    valid = validate_fake_bundle(runtime, ldd, readelf)
    assert valid.returncode == 0, valid.stderr

    files["api"].write_text("tampered\n", encoding="utf-8")
    invalid = validate_fake_bundle(runtime, ldd, readelf)
    assert invalid.returncode != 0
    assert "api hash mismatch" in invalid.stderr


def test_managed_runtime_validator_rejects_unaddressed_variant_by_default(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)

    invalid = validate_fake_bundle(
        runtime,
        ldd,
        readelf,
        allow_unaddressed_staging=False,
    )

    assert invalid.returncode != 0
    assert "hash-addressed variant directory mismatch" in invalid.stderr


def test_validator_requires_native_sm89_in_fullmag_separately(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(
        tmp_path, fullmag_cubins=("sm_52",), hypre_cubins=("sm_89",)
    )

    invalid = validate_fake_bundle(
        runtime, ldd, readelf, "--require-native-cubin", "fullmag_fem=sm_89"
    )

    assert invalid.returncode != 0
    assert (
        "native library fullmag_fem is missing required native cubin sm_89"
        in invalid.stderr
    )


def test_validator_requires_native_sm89_in_loaded_hypre_separately(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(
        tmp_path, fullmag_cubins=("sm_89",), hypre_cubins=("sm_52",)
    )

    invalid = validate_fake_bundle(
        runtime, ldd, readelf, "--require-native-cubin", "hypre=sm_89"
    )

    assert invalid.returncode != 0
    assert "native library hypre is missing required native cubin sm_89" in invalid.stderr


def test_validator_bare_native_cubin_requirement_applies_to_fullmag_and_hypre(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(
        tmp_path, fullmag_cubins=("sm_89",), hypre_cubins=("sm_52",)
    )

    invalid = validate_fake_bundle(
        runtime, ldd, readelf, "--require-native-cubin", "sm_89"
    )

    assert invalid.returncode != 0
    assert "native library hypre is missing required native cubin sm_89" in invalid.stderr


def test_validator_hashes_resolved_library_target_not_symlink(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    resolved = runtime / "lib/libfullmag_fem.so.0.1.0"
    resolved.write_bytes(b"tampered resolved object\n")

    invalid = validate_fake_bundle(runtime, ldd, readelf)

    assert invalid.returncode != 0
    assert "fullmag_fem hash mismatch" in invalid.stderr


def test_validator_rejects_loaded_hypre_path_that_differs_from_manifest(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["loader_trace"]["fullmag_fem"]["libHYPRE-3.1.0.so"] = (
        "lib/libHYPRE-other.so"
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    invalid = validate_fake_bundle(runtime, ldd, readelf)

    assert invalid.returncode != 0
    assert "loader trace" in invalid.stderr


def test_validator_rejects_multiple_hypre_libraries_without_binding_provider_proof(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    source = ldd.read_text(encoding="utf-8")
    source = source.replace(
        "if sys.argv[1].endswith('fullmag-fem-gpu-bin'):\n"
        "    print(f'libfullmag_fem.so.0 => {ROOT}/lib/libfullmag_fem.so.0.1.0 (0x1)')\n",
        "if sys.argv[1].endswith('fullmag-fem-gpu-bin'):\n"
        "    print(f'libfullmag_fem.so.0 => {ROOT}/lib/libfullmag_fem.so.0.1.0 (0x1)')\n"
        "    print(f'libHYPRE-3.1.0.so => {ROOT}/lib/libHYPRE-3.1.0.so (0x2)')\n"
        "    print(f'libHYPRE-2.22.1.so => {ROOT}/lib/libHYPRE-2.22.1.so (0x3)')\n",
    )
    ldd.write_text(source, encoding="utf-8")

    invalid = validate_fake_bundle(runtime, ldd, readelf)

    assert invalid.returncode != 0
    assert "HYPRE symbol-provider proof" in invalid.stderr


def test_hypre_binding_proof_rejects_wrong_provider(tmp_path: Path) -> None:
    validator = load_validator_module()
    expected = (tmp_path / "libHYPRE-3.1.0.so").resolve()
    wrong = (tmp_path / "libHYPRE-2.22.1.so").resolve()
    output = (
        f"binding file {tmp_path}/libpetsc_real.so.3.15 [0] to {wrong} [0]: "
        "normal symbol `HYPRE_BoomerAMGSolve'\n"
    )

    try:
        validator.validate_hypre_binding_output(
            output, expected, ("libHYPRE-2.22.1.so", "libHYPRE-3.1.0.so")
        )
    except ValueError as error:
        assert "unexpected provider" in str(error)
    else:
        raise AssertionError("wrong HYPRE provider was accepted")


def test_hypre_binding_proof_requires_petsc_source(tmp_path: Path) -> None:
    validator = load_validator_module()
    expected = (tmp_path / "libHYPRE-3.1.0.so").resolve()
    output = (
        f"binding file {tmp_path}/libmfem.so.4.9.0 [0] to {expected} [0]: "
        "normal symbol `HYPRE_BoomerAMGSolve'\n"
    )

    try:
        validator.validate_hypre_binding_output(
            output, expected, ("libHYPRE-2.22.1.so", "libHYPRE-3.1.0.so")
        )
    except ValueError as error:
        assert "PETSc-to-HYPRE" in str(error)
    else:
        raise AssertionError("binding proof without PETSc source was accepted")


def test_hypre_provider_rejects_missing_expected_library(tmp_path: Path) -> None:
    validator = load_validator_module()
    expected = (tmp_path / "libHYPRE-3.1.0.so").resolve()

    try:
        validator.validate_hypre_symbol_provider(
            tmp_path / "worker",
            tmp_path,
            {},
            expected,
        )
    except ValueError as error:
        assert "does not load manifest HYPRE" in str(error)
    else:
        raise AssertionError("missing manifest HYPRE was accepted")


def test_hypre_provider_rejects_wrong_singleton_library(tmp_path: Path) -> None:
    validator = load_validator_module()
    expected = (tmp_path / "libHYPRE-3.1.0.so").resolve()
    wrong = (tmp_path / "libHYPRE-2.22.1.so").resolve()

    try:
        validator.validate_hypre_symbol_provider(
            tmp_path / "worker",
            tmp_path,
            {"libHYPRE-2.22.1.so": wrong},
            expected,
        )
    except ValueError as error:
        assert "does not load manifest HYPRE" in str(error)
    else:
        raise AssertionError("wrong singleton HYPRE was accepted")


def test_validator_exact_bundle_comparison_hashes_files_and_literal_symlinks(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    for root in (first, second):
        (root / "payload.bin").write_bytes(b"identical\n")
        (root / "dangling.so").symlink_to("missing-target.so")

    same = subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--runtime-root",
            str(first),
            "--compare-exact",
            str(second),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert same.returncode == 0, same.stderr

    (second / "payload.bin").write_bytes(b"changed\n")
    changed = subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--runtime-root",
            str(first),
            "--compare-exact",
            str(second),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert changed.returncode != 0
    assert "exact bundle identity mismatch" in changed.stderr


def test_export_uses_hash_addressed_variants_and_atomic_active_alias() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")

    assert 'VARIANTS_ROOT="${RUNTIME_PARENT}/fem-gpu-variants"' in exporter
    assert 'manifest_sha256="$(sha256sum "${STAGING_ROOT}/manifest.json"' in exporter
    assert 'variant_root="${VARIANTS_ROOT}/${FULLMAG_FEM_RUNTIME_VARIANT}-${manifest_sha256}"' in exporter
    assert 'alias_target="fem-gpu-variants/' in exporter
    assert 'ln -sfn "${alias_target}" "${next_alias}"' in exporter
    assert '--allow-unaddressed-staging' in exporter
    assert '--runtime-root "${variant_root}" --compare-exact "${STAGING_ROOT}"' in exporter
    assert "validate-fem-gpu-runtime-variant" in justfile
    assert "select-fem-gpu-runtime-variant" in justfile
    assert "restore-fem-gpu-runtime-variant" in justfile
    assert "migrate-active-fem-gpu-runtime-to-variant" in justfile
    assert '--compare-exact "$exact_copy"' in justfile
    assert 'mv "$active" "$backup"' in justfile
    assert "restore-active-fem-gpu-runtime-directory-backup" in justfile


def test_exported_readme_describes_published_variant_and_active_alias() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert "publishes an immutable hash-addressed variant" in exporter
    assert "atomically selects it through" in exporter
    assert "not yet automatically resolved" not in exporter
    assert '${RUNTIME_ROOT}/bin/fullmag-fem-gpu examples/' in exporter
    assert '${STAGING_ROOT}/bin/fullmag-fem-gpu examples/' not in exporter
    assert r'\`${RUNTIME_ROOT}\` active-runtime alias' in exporter


def test_manifest_builder_records_actual_loaded_native_libraries(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    cuobjdump = tmp_path / "cuobjdump"
    cuobjdump.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        "print('x.sm_89.cubin' if sys.argv[1] == '--list-elf' else '.target sm_90')\n",
        encoding="utf-8",
    )
    cuobjdump.chmod(0o755)
    nvcc = tmp_path / "nvcc"
    nvcc.write_text(
        "#!/bin/sh\nprintf '%s\\n' 'Cuda compilation tools, release 12.4, V12.4.131'\n",
        encoding="utf-8",
    )
    nvcc.chmod(0o755)

    result = subprocess.run(
        [
            "python3",
            str(MANIFEST_BUILDER),
            "--runtime-root",
            str(runtime),
            "--variant",
            "candidate-sm89",
            "--requested-cuda-architectures",
            "80-real;89-real;90-real;90-virtual",
            "--device-name",
            "Synthetic RTX 4080",
            "--compute-capability",
            "8.9",
            "--driver-version",
            "591.86",
            "--cuobjdump",
            str(cuobjdump),
            "--ldd",
            str(ldd),
            "--readelf",
            str(readelf),
            "--nvcc",
            str(nvcc),
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    manifest = json.loads((runtime / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["schema"] == 2
    assert manifest["native_libraries"]["fullmag_fem"]["cubins"] == ["sm_89"]
    assert manifest["native_libraries"]["hypre"]["path"] == "lib/libHYPRE-3.1.0.so"
    assert manifest["loader_trace"]["fullmag_fem"]["libHYPRE-3.1.0.so"] == (
        "lib/libHYPRE-3.1.0.so"
    )
    assert manifest["build"]["cuda_toolkit"] == "12.4"
    assert manifest["runtime_diagnostics"]["compute_capability"] == "8.9"


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
