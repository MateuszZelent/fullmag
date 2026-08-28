#!/usr/bin/env python3
"""Unit tests for managed FEM runtime export copy helpers."""

from __future__ import annotations

import importlib.util
import subprocess
import hashlib
import json
import os
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
HELPER = REPO_ROOT / "scripts" / "lib" / "runtime_bundle_copy.sh"
IMAGE_IDENTITY_HELPER = REPO_ROOT / "scripts" / "lib" / "managed_fem_image_identity.sh"
EXPORT_SCRIPT = REPO_ROOT / "scripts" / "export_fem_gpu_runtime.sh"
VALIDATOR = REPO_ROOT / "scripts" / "validate_managed_fem_runtime_bundle.py"
MANIFEST_BUILDER = REPO_ROOT / "scripts" / "build_managed_fem_runtime_manifest.py"
MESH_FIELD_NAMES = (
    "abi_version", "struct_size", "nodes_xyz", "nodes_xyz_len", "cell_types",
    "cell_types_len", "cell_offsets", "cell_offsets_len", "cell_nodes",
    "cell_nodes_len", "cell_global_ordinals", "cell_global_ordinals_len",
    "cell_markers", "cell_markers_len", "facet_types", "facet_types_len",
    "facet_roles", "facet_roles_len", "facet_offsets", "facet_offsets_len",
    "facet_nodes", "facet_nodes_len", "facet_global_ordinals",
    "facet_global_ordinals_len", "facet_markers", "facet_markers_len",
    "periodic_node_pairs", "periodic_node_pairs_len",
    "periodic_boundary_pair_markers", "periodic_boundary_pair_markers_len",
)
MESH_FIELD_OFFSETS = dict(
    zip(MESH_FIELD_NAMES, [0, 4, *range(8, 232, 8)], strict=True)
)


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
    hypre_memory_variant: str = "baseline",
    hypre_configure_flags: tuple[str, ...] = ("--without-umpire",),
    hypre_config_macros: dict[str, bool] | None = None,
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
    stamp = (
        "[fullmag] build: 1970-01-01T00:00:00Z | commit: "
        + "0123abcd" * 5
        + " | dirty | source snapshot: "
        + "45" * 32
    )
    for name, path in binaries.items():
        startup = f"printf '%s\\n' {stamp!r} >&2\n" if name in {"worker", "api"} else ""
        path.write_text(f"#!/bin/sh\n{startup}exit 0\n", encoding="utf-8")
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
        if name == "fullmag_fem":
            source = r'''
#include <stdint.h>
#include <stdio.h>
typedef struct {
  uint32_t abi_version, struct_size, mesh_desc_abi_version, mesh_desc_struct_size;
  uint32_t field_count, reserved;
  uint64_t field_offsets[30];
  char layout_fingerprint[96];
} mesh_layout;
typedef struct {
  char magic[40];
  uint32_t record_version, record_size, endian_tag, reserved;
  mesh_layout layout;
} mesh_record;
__attribute__((used, section(".fullmag_fem_abi"), aligned(8), visibility("default")))
const mesh_record fullmag_fem_mesh_abi_record_v1 = {
  "FULLMAG_FEM_MESH_ABI_RECORD_V1", 1, sizeof(mesh_record), 0x01020304, 0,
  {1, sizeof(mesh_layout), 2, 232, 30, 0,
   {0,4,8,16,24,32,40,48,56,64,72,80,88,96,104,112,120,128,
    136,144,152,160,168,176,184,192,200,208,216,224},
   "fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals"}
};
int fullmag_fem_get_mesh_abi_layout(mesh_layout *out) {
  static const uint64_t offsets[30] = {
    0,4,8,16,24,32,40,48,56,64,72,80,88,96,104,112,120,128,
    136,144,152,160,168,176,184,192,200,208,216,224
  };
  if (!out) return -1;
  *out = (mesh_layout){0};
  out->abi_version = 1; out->struct_size = sizeof(*out);
  out->mesh_desc_abi_version = 2; out->mesh_desc_struct_size = 232;
  out->field_count = 30;
  for (unsigned i = 0; i < 30; ++i) out->field_offsets[i] = offsets[i];
  snprintf(out->layout_fingerprint, sizeof(out->layout_fingerprint), "%s",
    "fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals");
  return 0;
}
'''
            compiled = subprocess.run(
                ["cc", "-shared", "-fPIC", "-x", "c", "-", "-o", str(target)],
                input=source,
                text=True,
                capture_output=True,
                check=False,
            )
            assert compiled.returncode == 0, compiled.stderr
        else:
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

    if hypre_config_macros is None:
        hypre_config_macros = {
            "HYPRE_USING_UMPIRE": False,
            "HYPRE_USING_UMPIRE_DEVICE": False,
            "HYPRE_USING_DEVICE_MALLOC_ASYNC": False,
            "HYPRE_USING_THRUST_ASYNC": False,
        }
    manifest = {
        "schema": 3,
        "runtime": "fem-gpu-host",
        "variant": "test-sm89",
        "parent_manifest_sha256": "0" * 64,
        "source_provenance": {
            "git_commit": "0123abcd" * 5,
            "git_tree": "2" * 40,
            "dirty": False,
            "dirty_patch_sha256": None,
            "source_inputs_sha256": "3" * 64,
            "source_input_manifest": "scripts/managed_fem_runtime_source_inputs.v1.txt",
        },
        "build_identity": {
            "git_commit": "0123abcd" * 5,
            "git_tree": "2" * 40,
            "worktree_state": "dirty",
            "source_snapshot_sha256": "45" * 32,
        },
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
        "native_abi": {
            "mesh_desc_abi_version": 2,
            "mesh_desc_struct_size": 232,
            "mesh_desc_layout_fingerprint": (
                "fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals"
            ),
            "mesh_desc_field_offsets": MESH_FIELD_OFFSETS,
        },
        "build": {
            "mfem_version": "4.9",
            "hypre_version": "3.1.0",
            "libceed_version": "0.12.0",
            "cuda_toolkit": "12.4",
            "cuda_compiler": "nvcc 12.4",
            "requested_cuda_architectures": "80-real;89-real;90-real;90-virtual",
            "effective_cuda_architectures": ["sm_80", "sm_89", "sm_90", "compute_90"],
            "hypre_gpu_architectures": "60 70 80 89 90",
            "hypre_memory_variant": hypre_memory_variant,
            "hypre_configure_flags": list(hypre_configure_flags),
            "hypre_config_macros": hypre_config_macros,
            "hypre_config_header_sha256": "f" * 64,
            "source_inputs": {
                "justfile_sha256": "4" * 64,
                "dockerfile_sha256": "5" * 64,
                "source_input_manifest_sha256": "6" * 64,
            },
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


def test_export_script_refreshes_identity_before_configured_release_clean() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    identity_clean_index = script.find("cargo +nightly clean -p fullmag-build-info")
    release_clean_index = script.find("cargo +nightly clean --workspace --release")
    build_index = script.find("cargo +nightly -Z checksum-freshness build")
    copy_index = script.find('FEM_LIB="$(only_native_lib_dir')

    assert identity_clean_index != -1
    assert release_clean_index != -1
    assert build_index != -1
    assert copy_index != -1
    assert identity_clean_index < release_clean_index < build_index < copy_index
    assert "stale_fem_native_artifacts" in script
    assert "stale fullmag-fem-sys native artifacts remain after targeted clean" in script


def test_export_script_defaults_to_bounded_parallel_cargo_builds() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert ': "${FULLMAG_FEM_RUNTIME_CARGO_JOBS:=8}"' in script
    assert 'cargo +nightly -Z checksum-freshness build -j "$cargo_jobs"' in script


def test_managed_runtime_staleness_uses_exact_source_snapshot_identity() -> None:
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    ensure_recipe = justfile.split("ensure-managed-fem-runtime:", 1)[1].split(
        "\ninspect-managed-fem-frequency-domain-deps:", 1
    )[0]

    assert "capture_source_snapshot_identity.py" in ensure_recipe
    assert "--ignore-non-runtime-dirty" in ensure_recipe
    assert '--require-source-snapshot-sha256 "$source_snapshot"' in ensure_recipe
    assert '! -path \\"*/tests/*\\"' not in ensure_recipe
    assert '! -name \\"tests.rs\\"' not in ensure_recipe
    assert '--allow-source-drift' in ensure_recipe
    assert 'bash scripts/prune_managed_fem_runtimes.sh' in ensure_recipe
    assert 'FULLMAG_RUNTIME_PRUNE:-1' in ensure_recipe
    assert 'runtime_rebuilt=0' in ensure_recipe
    assert 'runtime_rebuilt=1' in ensure_recipe
    assert 'if [ "$runtime_rebuilt" = "1" ] || [ "$runtime_reused_for_non_runtime_changes" = "1" ]; then' in ensure_recipe


def test_export_script_restores_runtime_bundle_to_host_owner() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'FULLMAG_HOST_UID="$(id -u)"' in script
    assert 'FULLMAG_HOST_GID="$(id -g)"' in script
    assert 'chown -R "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}"' in script
    assert 'chmod -R u+rwX,go+rX,go-w ${runtime_root}' in script
    assert 'chown "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" .fullmag' not in script
    assert 'chmod u+rwx,go+rx,go-w .fullmag' not in script
    assert 'stat -c "%u:%g" .fullmag/runtimes/fem-gpu-host' not in script


def test_export_script_restores_staging_owner_when_container_build_fails() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    trap_index = script.find("trap restore_staging_owner EXIT")
    build_index = script.find("cargo +nightly -Z checksum-freshness build")

    assert "restore_staging_owner() {" in script
    assert 'chown -R "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" "${runtime_root}"' in script
    assert trap_index != -1
    assert build_index != -1
    assert trap_index < build_index


def test_export_script_serializes_runtime_bundle_mutation_with_flock() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    lock_index = script.find(
        'RUNTIME_LOCK="${RUNTIME_PARENT}/.fem-gpu-host.export.v2.lock"'
    )
    flock_index = script.find(
        'setsid flock -E 75 -w "${FULLMAG_RUNTIME_EXPORT_LOCK_TIMEOUT_SECONDS}" '
        '--close "${RUNTIME_LOCK}"'
    )
    compose_index = script.find(
        'build_managed_fem_image "${docker_build_ref}" "${docker_compatibility_ref}"'
    )

    assert lock_index != -1
    assert flock_index != -1
    assert compose_index != -1
    assert lock_index < flock_index < compose_index
    assert ': "${FULLMAG_RUNTIME_EXPORT_LOCK_TIMEOUT_SECONDS:=1800}"' in script


def test_export_lock_descriptor_is_not_inherited_by_child_processes() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'FULLMAG_RUNTIME_EXPORT_LOCK_HELD' in script
    assert (
        'setsid flock -E 75 -w "${FULLMAG_RUNTIME_EXPORT_LOCK_TIMEOUT_SECONDS}" '
        '--close "${RUNTIME_LOCK}"'
    ) in script
    assert 'lock_acquired_marker="${lock_state_dir}/acquired"' in script
    assert 'exec 9>"${RUNTIME_LOCK}"' not in script
    assert "flock -n 9" not in script
    assert "flock -u 9" not in script
    assert "exec 9>&-" not in script
    assert '.fem-gpu-host.export.lock"' not in script


def test_export_keeps_the_live_lock_wrapper_when_building_the_immutable_snapshot() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'exec bash "${SOURCE_SNAPSHOT_ROOT}/scripts/export_fem_gpu_runtime.sh"' not in script
    assert 'cd "${SOURCE_SNAPSHOT_ROOT}"' in script
    assert 'verify_source_snapshot_identity\ncd "${SOURCE_SNAPSHOT_ROOT}"' in script


def test_export_script_pins_built_image_id_across_export_and_validation() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")
    compose = (REPO_ROOT / "compose.yaml").read_text(encoding="utf-8")
    identity_helper = IMAGE_IDENTITY_HELPER.read_text(encoding="utf-8")
    manifest_builder = MANIFEST_BUILDER.read_text(encoding="utf-8")

    build_index = script.find(
        'build_managed_fem_image "${docker_build_ref}" "${docker_compatibility_ref}"'
    )
    capture_index = script.find('docker_image_id="${MANAGED_FEM_BUILT_IMAGE_ID}"')
    export_index = script.find(
        'FULLMAG_FEM_GPU_IMAGE="${docker_image_id}" docker compose --profile fem-gpu run'
    )
    validate_index = script.find('  "${docker_image_id}"')

    assert 'image: ${FULLMAG_FEM_GPU_IMAGE:-fullmag/fem-gpu:local}' in compose
    assert build_index != -1
    assert capture_index != -1
    assert export_index != -1
    assert validate_index != -1
    assert build_index < capture_index < export_index < validate_index
    assert 'capture_managed_fem_image_id fullmag/fem-gpu:local' not in script
    assert script.count("observe_managed_fem_image_tag") == 1
    assert 'remove_managed_fem_build_ref "${docker_build_ref}"' in script
    final_cleanup_index = script.rfind(
        'remove_managed_fem_build_ref "${docker_build_ref}"'
    )
    trap_clear_index = script.rfind("trap - EXIT")
    assert validate_index < final_cleanup_index < trap_clear_index
    assert '--observed-docker-image-id "${observed_docker_image_id}"' in script
    assert "managed FEM image tag drift detected" in identity_helper
    assert 'FULLMAG_FEM_GPU_IMAGE="${build_image_ref}"' in identity_helper
    assert 'capture_managed_fem_image_id "${build_image_ref}"' in identity_helper
    assert 'docker image tag "${MANAGED_FEM_BUILT_IMAGE_ID}"' in identity_helper
    assert 'docker image rm "${build_image_ref}"' in identity_helper
    assert "docker image rm --force" not in identity_helper
    assert 'current_image_id="$(docker image inspect "${image_ref}"' in identity_helper
    assert '"drift_observed"' in manifest_builder


def test_export_uses_a_stable_compose_project_name() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    image_helper = IMAGE_IDENTITY_HELPER.read_text(encoding="utf-8")

    assert 'FULLMAG_COMPOSE_PROJECT_NAME="fullmag-fem-${FULLMAG_WORKTREE_TARGET_DIGEST:0:16}"' in exporter
    assert 'export COMPOSE_PROJECT_NAME="${FULLMAG_COMPOSE_PROJECT_NAME}"' in exporter
    assert 'COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-fullmag-fem-runtime}" \\' in image_helper


def test_managed_fem_build_capture_ignores_compatibility_retag(
    tmp_path: Path,
) -> None:
    fake_docker = tmp_path / "docker"
    calls = tmp_path / "docker-calls"
    fake_docker.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s\n' "${FULLMAG_FEM_GPU_IMAGE:-<unset>}" "$*" >> "${FAKE_DOCKER_CALLS}"
if [ "$1" = "compose" ]; then
  exit 0
fi
if [ "$1 $2" = "image inspect" ]; then
  case "$3" in
    fullmag/fem-gpu:runtime-export-test) printf 'sha256:%064d\n' 1 ;;
    fullmag/fem-gpu:local) printf 'sha256:%064d\n' 2 ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1 $2" = "image tag" ]; then
  exit 0
fi
exit 1
""",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)

    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            f"""
source "{IMAGE_IDENTITY_HELPER}"
build_managed_fem_image \\
  fullmag/fem-gpu:runtime-export-test \\
  fullmag/fem-gpu:local
printf '%s\n' "${{MANAGED_FEM_BUILT_IMAGE_ID}}"
""",
        ],
        cwd=REPO_ROOT,
        env={
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "FAKE_DOCKER_CALLS": str(calls),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == f"sha256:{1:064d}"
    docker_calls = calls.read_text(encoding="utf-8").splitlines()
    assert docker_calls == [
        "fullmag/fem-gpu:runtime-export-test|compose --profile fem-gpu build fem-gpu",
        "<unset>|image inspect fullmag/fem-gpu:runtime-export-test --format {{.Id}}",
        f"<unset>|image tag sha256:{1:064d} fullmag/fem-gpu:local",
    ]


def test_managed_fem_image_identity_warns_and_keeps_pinned_id_on_retag(
    tmp_path: Path,
) -> None:
    fake_docker = tmp_path / "docker"
    counter = tmp_path / "inspect-count"
    fake_docker.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
count=0
if [ -f \"${FAKE_DOCKER_COUNTER}\" ]; then
  count=\"$(cat \"${FAKE_DOCKER_COUNTER}\")\"
fi
count=$((count + 1))
printf '%s\\n' \"${count}\" > \"${FAKE_DOCKER_COUNTER}\"
if [ \"${count}\" -eq 1 ]; then
  printf 'sha256:%064d\\n' 1
else
  printf 'sha256:%064d\\n' 2
fi
""",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)

    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            f"""
source \"{IMAGE_IDENTITY_HELPER}\"
built_image_id=\"$(capture_managed_fem_image_id fullmag/fem-gpu:local)\"
observe_managed_fem_image_tag fullmag/fem-gpu:local \"${{built_image_id}}\"
""",
        ],
        cwd=REPO_ROOT,
        env={
            "PATH": f"{tmp_path}:/usr/bin:/bin",
            "FAKE_DOCKER_COUNTER": str(counter),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stdout.strip() == f"sha256:{2:064d}"
    assert "managed FEM image tag drift detected" in result.stderr
    assert f"built=sha256:{1:064d}" in result.stderr
    assert f"current=sha256:{2:064d}" in result.stderr


def test_export_script_publishes_only_a_validated_hash_addressed_bundle() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'STAGING_ROOT="${FULLMAG_CONTAINER_TARGET_DIR}/runtime-export-staging.$$"' in script
    assert '-e FULLMAG_RUNTIME_EXPORT_STAGING="/workspace/target/runtime-export-staging.$$"' in script
    assert 'publish_runtime_bundle() {' in script
    assert 'python3 scripts/validate_managed_fem_runtime_bundle.py' in script
    assert '--runtime-root "${STAGING_ROOT}"' in script
    assert 'mv "${STAGING_ROOT}" "${variant_root}"' in script
    assert 'tar -C "${variant_root}" -cf "${persistent_staging_archive}" .' in script
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


def test_managed_runtime_validator_requires_soname_key_but_allows_absent_dt_soname(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["native_libraries"]["libceed"]["soname"] = None
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    readelf.write_text(
        readelf.read_text(encoding="utf-8").replace(
            "print(f' 0x000000000000000e (SONAME) Library soname: [{soname}]')",
            "if name != 'libceed.so.0.12.0':\n"
            "    print(f' 0x000000000000000e (SONAME) Library soname: [{soname}]')",
        ),
        encoding="utf-8",
    )

    valid = validate_fake_bundle(runtime, ldd, readelf)

    assert valid.returncode == 0, valid.stderr

    for label, mutate in (
        ("missing", lambda entry: entry.pop("soname")),
        ("empty", lambda entry: entry.__setitem__("soname", "")),
        ("numeric", lambda entry: entry.__setitem__("soname", 1)),
    ):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entry = manifest["native_libraries"]["libceed"]
        mutate(entry)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        invalid = validate_fake_bundle(runtime, ldd, readelf)

        assert invalid.returncode == 2, label
        assert "native library libceed soname must be null or a nonempty string" in invalid.stderr


def test_managed_runtime_validator_requires_exact_build_identity(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)

    valid = validate_fake_bundle(
        runtime,
        ldd,
        readelf,
        "--require-git-commit",
        "0123abcd" * 5,
        "--require-worktree-state",
        "dirty",
        "--require-source-snapshot-sha256",
        "45" * 32,
    )
    assert valid.returncode == 0, valid.stderr

    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["build_identity"]["git_commit"] = "unknown"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    unknown = validate_fake_bundle(runtime, ldd, readelf)
    assert unknown.returncode == 2
    assert "build identity git commit is invalid" in unknown.stderr

    manifest["build_identity"]["git_commit"] = "89abcdef" * 5
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    mismatched = validate_fake_bundle(
        runtime,
        ldd,
        readelf,
        "--require-git-commit",
        "0123abcd" * 5,
        "--require-worktree-state",
        "dirty",
    )
    assert mismatched.returncode == 2
    assert "build identity git commit mismatch" in mismatched.stderr

    manifest["build_identity"]["git_commit"] = "0123abcd" * 5
    manifest["build_identity"]["worktree_state"] = "clean"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    wrong_state = validate_fake_bundle(
        runtime,
        ldd,
        readelf,
        "--require-git-commit",
        "0123abcd" * 5,
        "--require-worktree-state",
        "dirty",
    )
    assert wrong_state.returncode == 2
    assert "build identity worktree state mismatch" in wrong_state.stderr


def test_managed_runtime_validator_binds_manifest_to_cli_and_api_startup_stamps(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    api = runtime / "bin/fullmag-api"
    api.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' '[fullmag] build: 1970-01-01T00:00:00Z | commit: "
        + "0123abcd" * 5
        + " | dirty | source snapshot: "
        + "67" * 32
        + "' >&2\nexit 0\n",
        encoding="utf-8",
    )
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["integrity"]["api_sha256"] = hashlib.sha256(api.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    invalid = validate_fake_bundle(runtime, ldd, readelf)

    assert invalid.returncode == 2
    assert "API startup build identity mismatch" in invalid.stderr


def test_managed_runtime_validator_reports_startup_stderr_when_stamp_is_missing(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    worker = runtime / "bin/fullmag-fem-gpu-bin"
    worker.write_text(
        "#!/bin/sh\nprintf '%s\\n' 'loader failure detail' >&2\nexit 127\n",
        encoding="utf-8",
    )
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["integrity"]["worker_sha256"] = hashlib.sha256(worker.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    invalid = validate_fake_bundle(runtime, ldd, readelf)

    assert invalid.returncode == 2
    assert "CLI startup build identity is missing" in invalid.stderr
    assert "exit status 127" in invalid.stderr
    assert "loader failure detail" in invalid.stderr


def test_export_uses_immutable_source_snapshot_when_host_worktree_drifts() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    resolve_index = exporter.index("python3 scripts/capture_source_snapshot_identity.py")
    compose_index = exporter.index('FULLMAG_FEM_GPU_IMAGE="${docker_image_id}" docker compose')
    manifest_index = exporter.index('python3 scripts/build_managed_fem_runtime_manifest.py')
    publish_index = exporter.index("publish_runtime_bundle() {")

    assert resolve_index < compose_index < manifest_index < publish_index
    assert '--materialize "${materialize_root}"' in exporter
    assert 'source-cache.${source_snapshot_sha256}' in exporter
    assert 'FULLMAG_RUNTIME_PUBLICATION_REPO_ROOT="${REPO_ROOT}"' in exporter
    assert 'exec bash "${SOURCE_SNAPSHOT_ROOT}/scripts/export_fem_gpu_runtime.sh"' not in exporter
    assert 'verify_source_snapshot_identity\ncd "${SOURCE_SNAPSHOT_ROOT}"' in exporter
    assert 'cd "${SOURCE_SNAPSHOT_ROOT}"' in exporter
    assert '-v "${SOURCE_SNAPSHOT_ROOT}:/workspace:ro"' in exporter
    assert '-v "${REPO_ROOT}:/workspace"' not in exporter
    assert '-e FULLMAG_SOURCE_GIT_COMMIT="${FULLMAG_SOURCE_GIT_COMMIT}"' in exporter
    assert '-e FULLMAG_SOURCE_WORKTREE_STATE="${FULLMAG_SOURCE_WORKTREE_STATE}"' in exporter
    assert '-e FULLMAG_SOURCE_SNAPSHOT_SHA256="${FULLMAG_SOURCE_SNAPSHOT_SHA256}"' in exporter
    assert '--git-commit "${FULLMAG_SOURCE_GIT_COMMIT}"' in exporter
    assert '--worktree-state "${FULLMAG_SOURCE_WORKTREE_STATE}"' in exporter
    assert '--require-git-commit "${FULLMAG_SOURCE_GIT_COMMIT}"' in exporter
    assert '--require-worktree-state "${FULLMAG_SOURCE_WORKTREE_STATE}"' in exporter
    assert '--source-snapshot-sha256 "${FULLMAG_SOURCE_SNAPSHOT_SHA256}"' in exporter
    assert '--require-source-snapshot-sha256 "${FULLMAG_SOURCE_SNAPSHOT_SHA256}"' in exporter
    assert '--verify-materialized-snapshot "${SOURCE_SNAPSHOT_ROOT}"' in exporter
    assert "--ignore-non-runtime-dirty" in exporter
    assert '--allow-source-drift' in exporter
    assert "capture_source_snapshot_identity.py" in exporter
    source_capture = (
        REPO_ROOT / "scripts/capture_source_snapshot_identity.py"
    ).read_text(encoding="utf-8")
    assert "source identity changed during managed FEM runtime build" in source_capture
    assert 'grep -aFq "commit: ${FULLMAG_SOURCE_GIT_COMMIT}' not in exporter


def test_export_does_not_trust_public_bootstrap_environment_or_cleanup_foreign_paths() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'source_snapshot_owned=0' in exporter
    assert 'source_identity_owned=0' in exporter
    assert 'validate_bootstrapped_source_snapshot() {' in exporter
    assert 'SOURCE_ROOT' in exporter
    assert 'FULLMAG_CONTAINER_TARGET_DIR' in exporter
    assert 'source-snapshot.*' in exporter
    assert '[ ! -L "${path}" ]' in exporter
    assert 'materialize_root="$(mktemp -d "${FULLMAG_CONTAINER_TARGET_DIR}/source-snapshot.' in exporter
    assert '--materialize-existing-empty' in exporter

    function_start = exporter.index("cleanup_failed_export() {")
    function_end = exporter.index("\n}\n", function_start) + len("\n}")
    cleanup_function = exporter[function_start:function_end]
    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            (
                'docker_build_ref=""\n'
                'docker_build_ref_marker=""\n'
                'persistent_staging_archive=""\n'
                'persistent_validation_root=""\n'
                'STAGING_ROOT=""\n'
                'source_identity_file="/foreign/identity.json"\n'
                'SOURCE_SNAPSHOT_ROOT="/foreign/snapshot"\n'
                'source_identity_owned=0\n'
                'source_snapshot_owned=0\n'
                'rm() { printf "unexpected rm: %s\\n" "$*" >&2; return 99; }\n'
                'chmod() { printf "unexpected chmod: %s\\n" "$*" >&2; return 99; }\n'
                f"{cleanup_function}\n"
                'trap cleanup_failed_export EXIT\n'
                'exit 17\n'
            ),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 17
    assert "unexpected" not in result.stderr


def test_export_keeps_identity_through_final_verify_and_publication(
    tmp_path: Path,
) -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    verification_start = exporter.index("verify_source_snapshot_identity() {")
    verification_end = exporter.index("\n}\n", verification_start) + len("\n}")
    verification_function = exporter[verification_start:verification_end]
    function_start = exporter.index("finalize_verified_source_publication() {")
    function_end = exporter.index("\n}\n", function_start) + len("\n}")
    lifecycle_function = exporter[function_start:function_end]
    assert 'chmod -R u+w "${SOURCE_SNAPSHOT_ROOT}" 2>/dev/null || true' in lifecycle_function
    snapshot = tmp_path / "source-snapshot.test"
    identity = tmp_path / "source-identity.test.json"
    snapshot.mkdir()
    identity.write_text("{}\n", encoding="utf-8")
    lifecycle_log = tmp_path / "lifecycle.log"

    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            (
                f'FULLMAG_CONTAINER_TARGET_DIR={str(tmp_path)!r}\n'
                f'SOURCE_SNAPSHOT_ROOT={str(snapshot)!r}\n'
                f'source_identity_file={str(identity)!r}\n'
                f'LIFECYCLE_LOG={str(lifecycle_log)!r}\n'
                'SOURCE_ROOT=/captured/source\n'
                'REPO_ROOT=/original/repo\n'
                'source_snapshot_owned=1\n'
                'source_identity_owned=1\n'
                'FULLMAG_RUNTIME_PRUNE=0\n'
                'is_canonical_source_snapshot_path() {\n'
                '  [ "$1" = "$SOURCE_SNAPSHOT_ROOT" ] && [ -d "$1" ] && [ ! -L "$1" ]\n'
                '}\n'
                'is_canonical_source_identity_path() {\n'
                '  [ "$1" = "$source_identity_file" ] && [ -f "$1" ] && [ ! -L "$1" ]\n'
                '}\n'
                'python3() {\n'
                '  test "$4" = "--compare"\n'
                '  test "$5" = "$source_identity_file"\n'
                '  test -f "$5"\n'
                '  printf "verify:%s\\n" "$5" >> "$LIFECYCLE_LOG"\n'
                '}\n'
                'publish_runtime_bundle() {\n'
                '  test -f "$source_identity_file"\n'
                '  printf "publish:%s\\n" "$source_identity_file" >> "$LIFECYCLE_LOG"\n'
                '}\n'
                f"{verification_function}\n{lifecycle_function}\n"
                'finalize_verified_source_publication\n'
                'test ! -e "$SOURCE_SNAPSHOT_ROOT"\n'
                'test ! -e "$source_identity_file"\n'
                'test "$source_snapshot_owned" = 0\n'
                'test "$source_identity_owned" = 0\n'
            ),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout
    assert lifecycle_log.read_text(encoding="utf-8").splitlines() == [
        f"verify:{identity}",
        f"publish:{identity}",
    ]

    container_complete = exporter.index("container-side export complete")
    lifecycle_definition = exporter.index("finalize_verified_source_publication() {")
    intervening = exporter[container_complete:lifecycle_definition]
    assert 'rm -f -- "${source_identity_file}"' not in intervening
    assert 'source_identity_file=""' not in intervening


def test_failed_nested_bootstrap_verify_cleans_owned_snapshot_without_relaunch(
    tmp_path: Path,
) -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    def bash_function(name: str) -> str:
        start = exporter.index(f"{name}() {{")
        end = exporter.index("\n}\n", start) + len("\n}")
        return exporter[start:end]

    snapshot = tmp_path / "source-snapshot.nested"
    identity = tmp_path / "source-identity.nested.json"
    snapshot.mkdir()
    identity.write_text("{}\n", encoding="utf-8")
    lifecycle_log = tmp_path / "nested.log"
    functions = "\n".join(
        bash_function(name)
        for name in (
            "is_canonical_source_snapshot_path",
            "is_materialized_source_snapshot_path",
            "is_canonical_source_identity_path",
            "cleanup_failed_export",
            "verify_source_snapshot_identity",
            "validate_bootstrapped_source_snapshot",
            "resolve_source_snapshot_bootstrap",
        )
    )
    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            (
                f'FULLMAG_CONTAINER_TARGET_DIR={str(tmp_path)!r}\n'
                f'bootstrapped_source_snapshot_root={str(snapshot)!r}\n'
                f'bootstrapped_source_identity_file={str(identity)!r}\n'
                f'SOURCE_ROOT={str(snapshot)!r}\n'
                'REPO_ROOT=/original/repo\n'
                'SOURCE_SNAPSHOT_ROOT=""\n'
                'source_identity_file=""\n'
                'source_snapshot_owned=0\n'
                'source_identity_owned=0\n'
                'docker_build_ref=""\n'
                'docker_build_ref_marker=""\n'
                'persistent_staging_archive=""\n'
                'persistent_validation_root=""\n'
                'STAGING_ROOT=""\n'
                f'LIFECYCLE_LOG={str(lifecycle_log)!r}\n'
                'python3() { printf "verify-failed\\n" >> "$LIFECYCLE_LOG"; return 23; }\n'
                'bootstrap_new_source_snapshot() { printf "relaunch\\n" >> "$LIFECYCLE_LOG"; return 0; }\n'
                f"{functions}\n"
                'trap cleanup_failed_export EXIT\n'
                'resolve_source_snapshot_bootstrap\n'
            ),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 23, result.stderr + result.stdout
    assert lifecycle_log.read_text(encoding="utf-8").splitlines() == [
        "verify-failed"
    ]
    assert not snapshot.exists()
    assert not identity.exists()


def test_source_bootstrap_launches_once_only_when_both_handoff_vars_are_absent() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    start = exporter.index("resolve_source_snapshot_bootstrap() {")
    end = exporter.index("\n}\n", start) + len("\n}")
    resolver = exporter[start:end]
    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            (
                f"{resolver}\n"
                'launches=0\n'
                'bootstrap_new_source_snapshot() { launches=$((launches + 1)); }\n'
                'validate_bootstrapped_source_snapshot() { return 99; }\n'
                'bootstrapped_source_snapshot_root=""\n'
                'bootstrapped_source_identity_file=""\n'
                'resolve_source_snapshot_bootstrap\n'
                'test "$launches" = 1\n'
                'bootstrapped_source_snapshot_root=/supplied/snapshot\n'
                'bootstrapped_source_identity_file=""\n'
                'if resolve_source_snapshot_bootstrap; then exit 91; else status=$?; fi\n'
                'test "$status" = 2\n'
                'test "$launches" = 1\n'
            ),
        ],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr + result.stdout


def test_export_revalidates_source_immediately_before_alias_switch() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    function_start = exporter.index("publish_runtime_bundle() {")
    function_end = exporter.index("\n}\n", function_start) + len("\n}")
    publication = exporter[function_start:function_end]

    verify_index = publication.rindex("verify_source_snapshot_identity")
    prune_index = publication.index('FULLMAG_RUNTIME_PARENT="${RUNTIME_PARENT}"')
    migrate_index = publication.index("migrate_managed_fem_runtime_variants")
    link_index = publication.index('ln -sfn "${alias_target}"')
    switch_index = publication.index('mv -Tf "${repo_next_alias}"')

    assert prune_index < migrate_index < verify_index < link_index < switch_index
    assert "source_identity_file" not in publication[verify_index:link_index]


def test_managed_runtime_validator_rejects_mismatched_mesh_abi(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["native_abi"]["mesh_desc_layout_fingerprint"] = "stale-layout"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    invalid = validate_fake_bundle(runtime, ldd, readelf)

    assert invalid.returncode != 0
    assert "mesh descriptor ABI mismatch" in invalid.stderr


def test_validator_rejects_hypre_memory_variant_macro_mismatch(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(
        tmp_path,
        hypre_memory_variant="cuda_async",
        hypre_configure_flags=("--without-umpire", "--enable-device-malloc-async"),
    )

    invalid = validate_fake_bundle(runtime, ldd, readelf)

    assert invalid.returncode != 0
    assert "cuda_async requires HYPRE_USING_DEVICE_MALLOC_ASYNC=1" in invalid.stderr


def test_validator_accepts_exact_cuda_async_hypre_memory_contract(tmp_path: Path) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(
        tmp_path,
        hypre_memory_variant="cuda_async",
        hypre_configure_flags=("--without-umpire", "--enable-device-malloc-async"),
        hypre_config_macros={
            "HYPRE_USING_UMPIRE": False,
            "HYPRE_USING_UMPIRE_DEVICE": False,
            "HYPRE_USING_DEVICE_MALLOC_ASYNC": True,
            "HYPRE_USING_THRUST_ASYNC": False,
        },
    )

    valid = validate_fake_bundle(runtime, ldd, readelf)

    assert valid.returncode == 0, valid.stderr


def test_task10_build_path_declares_fail_closed_hypre_variants() -> None:
    dockerfile = (REPO_ROOT / "docker/fem-gpu/Dockerfile").read_text(encoding="utf-8")
    compose = (REPO_ROOT / "compose.yaml").read_text(encoding="utf-8")
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")

    assert 'ARG FULLMAG_HYPRE_MEMORY_VARIANT="baseline"' in dockerfile
    assert "ENV UMPIRE_REF=v2024.07.0" in dockerfile
    assert 'FULLMAG_HYPRE_MEMORY_VARIANT' in compose
    for variant in ("baseline", "umpire", "cuda_async", "thrust_async"):
        assert variant in dockerfile
    assert "./configure --help" in dockerfile
    assert "required HYPRE configure flag is unavailable" in dockerfile
    assert "hypre-build-metadata.json" in dockerfile
    assert "q.write_text(json.dumps(out,indent=2,sort_keys=True)+chr(10))" in dockerfile
    assert 're.search(r"^#define\\s+"' in dockerfile
    assert '--hypre-build-metadata "/opt/fullmag-deps/share/fullmag/hypre-build-metadata.json"' in exporter
    assert "build-fem-hypre-memory-variant variant:" in justfile
    assert "build-all-fem-hypre-memory-variants:" in justfile
    assert "FULLMAG_HYPRE_MEMORY_VARIANT" in justfile
    assert "hypre-${FULLMAG_HYPRE_MEMORY_VARIANT}" in exporter

    deps_stage, runtime_stage = dockerfile.split(
        "FROM cuda-base-normalized AS fem-gpu-dev", 1
    )
    assert deps_stage.index('ARG FULLMAG_HYPRE_MEMORY_VARIANT="baseline"') > deps_stage.index(
        "make -C /tmp/build/libCEED"
    )
    assert deps_stage.index("ENV UMPIRE_REF=v2024.07.0") > deps_stage.index(
        "make -C /tmp/build/libCEED"
    )
    assert runtime_stage.index(
        'ARG FULLMAG_HYPRE_MEMORY_VARIANT="baseline"'
    ) > runtime_stage.index("COPY --from=deps")


def test_managed_runtime_exports_cuda_dependency_closure_without_driver_libraries() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert "copy_shared_library_dependency_closure ${runtime_root}/lib/libfullmag_fem.so.0 cuda" in exporter
    assert "copy_shared_library_dependency_closure ${runtime_root}/lib/libfullmag_fdm.so.0 cuda" in exporter
    assert "cuda:/usr/local/cuda-*/*|cuda:/usr/local/cuda/*" in exporter
    assert "system:/lib/*|system:/lib64/*|system:/usr/lib/*|system:/usr/lib64/*" in exporter
    assert "|libcuda|libnvidia-[^/]+)\\.so" in exporter
    for library in ("libcurand.so*", "libcublas.so*", "libcusparse.so*", "libnvrtc-builtins.so*"):
        assert f"/usr/local/cuda-12.4/targets/x86_64-linux/lib/{library}" in exporter

    assert "/usr/local/cuda-12.4/targets/x86_64-linux/lib/libcuda.so" not in exporter


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

    assert 'VARIANTS_ROOT="${FULLMAG_CONTAINER_TARGET_DIR}/runtime-variants"' in exporter
    assert 'STAGING_ROOT="${FULLMAG_CONTAINER_TARGET_DIR}/runtime-export-staging.$$"' in exporter
    assert '.fullmag/runtimes/fem-gpu-host.staging' not in exporter
    assert 'manifest_sha256="$(sha256sum "${STAGING_ROOT}/manifest.json"' in exporter
    assert 'variant_root="${VARIANTS_ROOT}/${FULLMAG_FEM_RUNTIME_VARIANT}-${manifest_sha256}"' in exporter
    assert 'alias_target="fem-gpu-variants/$(basename "${variant_root}")"' in exporter
    assert 'migrate_managed_fem_runtime_variants "${variants_alias}" "${VARIANTS_ROOT}"' in exporter
    assert 'ln -sfn "${alias_target}" "${repo_next_alias}"' in exporter
    assert 'PERSISTENT_LATEST_ARCHIVE=' in exporter
    assert '--allow-unaddressed-staging' in exporter
    assert '--runtime-root "${variant_root}" --compare-exact "${STAGING_ROOT}"' in exporter
    assert "validate-fem-gpu-runtime-variant" in justfile
    assert "select-fem-gpu-runtime-variant" in justfile
    assert "restore-fem-gpu-runtime-variant" in justfile
    assert "migrate-active-fem-gpu-runtime-to-variant" in justfile
    assert '--compare-exact "$exact_copy"' in justfile
    assert 'mv "$active" "$backup"' in justfile
    assert "restore-active-fem-gpu-runtime-directory-backup" in justfile


def test_export_mounts_durable_staging_for_container_postprocessing() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'FULLMAG_RUNTIME_EXPORT_STAGING="/workspace/target/runtime-export-staging.$$"' in exporter
    assert '-v "${FULLMAG_CONTAINER_TARGET_DIR}:/managed-runtime-target"' in exporter
    assert '--runtime-root "/managed-runtime-target/runtime-export-staging.$$"' in exporter
    assert '-v "${FULLMAG_CONTAINER_TARGET_DIR}:/workspace/managed-runtime-target"' not in exporter


def test_export_keeps_container_temp_registry_and_build_log_on_durable_ext4() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert '-e TMPDIR="/workspace/target/tmp"' in exporter
    assert '-e CARGO_HOME="/workspace/target/cargo-home"' in exporter
    assert 'mkdir -p "${TMPDIR}" "${CARGO_HOME}"' in exporter
    assert 'tee "${TMPDIR}/fullmag-build.log"' in exporter
    assert "tee /tmp/fullmag-build.log" not in exporter
    assert '-e TMPDIR="/managed-runtime-target/tmp"' in exporter


def test_export_can_resume_safely_without_cleaning_completed_target() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'source "${SOURCE_ROOT}/scripts/lib/managed_fem_build_policy.sh"' in exporter
    assert "resolve_managed_fem_build_policy" in exporter
    assert 'case "${FULLMAG_FEM_RUNTIME_REUSE_BUILD}" in' in exporter
    assert 'if [ "${FULLMAG_FEM_RUNTIME_REUSE_BUILD}" = "0" ]; then' in exporter
    assert "cargo +nightly clean --workspace --release" in exporter
    assert "cargo +nightly -Z checksum-freshness build -j \"$cargo_jobs\"" in exporter
    assert "reusing the task-specific target through Cargo checksum freshness" in exporter


def test_export_reuses_a_stable_source_snapshot_path_for_cargo_freshness() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert 'source-cache.${source_snapshot_sha256}' in exporter
    assert "source snapshot cache" in exporter
    assert "mv \"${materialize_root}\" \"${SOURCE_SNAPSHOT_ROOT}\"" in exporter
    assert 'materialize_root="$(mktemp -d "${FULLMAG_CONTAINER_TARGET_DIR}/source-snapshot.' in exporter


def test_export_defaults_to_exact_persistent_build_root() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    native_storage_helper = (
        REPO_ROOT / "scripts/lib/managed_fem_native_storage.sh"
    ).read_text(encoding="utf-8")
    storage_helper = (
        REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
    ).read_text(encoding="utf-8")

    assert (
        'source "${SOURCE_ROOT}/scripts/lib/managed_fem_native_storage.sh"'
        in exporter
    )
    assert "resolve_managed_fem_native_storage" in exporter
    assert (
        'FULLMAG_NATIVE_BUILD_STORAGE_ROOT="/zfn2/mateuszz/git/fullmag"'
        in native_storage_helper
    )
    assert 'readonly FULLMAG_BUILD_ROOT="${FULLMAG_NATIVE_BUILD_STORAGE_ROOT}"' in exporter
    assert (
        'readonly FULLMAG_CONTAINER_TARGET_ROOT='
        '"${FULLMAG_NATIVE_MOUNT_VIEW}/managed-fem-runtime"'
        in exporter
    )
    assert 'readonly FULLMAG_CONTAINER_TARGET_DIR=' in exporter
    assert "validate_managed_fem_runtime_storage_target" in exporter
    assert 'findmnt -n -o FSTYPE --target "${probe_path}"' in storage_helper
    assert 'findmnt -n -o SOURCE --target "${probe_path}"' in storage_helper
    assert '-v "${FULLMAG_CONTAINER_TARGET_DIR}:/workspace/target"' in exporter
    assert 'fullmag-managed-fem-runtime-build:/workspace/target' not in exporter


def test_export_publishes_durable_copy_before_switching_aliases() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    archive_index = exporter.index('tar -C "${variant_root}"')
    latest_index = exporter.index('mv -f "${persistent_staging_archive}"')
    repo_alias_index = exporter.index('mv -Tf "${repo_next_alias}"')
    assert archive_index < latest_index < repo_alias_index


def test_export_archive_copy_verification_is_profile_aware_and_overridable() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert ': "${FULLMAG_NATIVE_STORAGE_PROFILE:=canonical}"' in exporter
    assert ': "${FULLMAG_RUNTIME_ARCHIVE_COPY_VERIFY:=auto}"' in exporter
    assert 'case "${FULLMAG_RUNTIME_ARCHIVE_COPY_VERIFY}" in' in exporter
    assert 'local-d) FULLMAG_RUNTIME_ARCHIVE_COPY_VERIFY=0 ;;' in exporter
    assert 'canonical) FULLMAG_RUNTIME_ARCHIVE_COPY_VERIFY=1 ;;' in exporter
    assert 'if [ "${FULLMAG_RUNTIME_ARCHIVE_COPY_VERIFY}" = "1" ]; then' in exporter
    assert 'cmp -s "${persistent_archive}" "${persistent_staging_archive}"' in exporter
    assert "archive validation remains enabled" in exporter


def test_export_validates_persistent_archive_before_switching_repo_alias() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")

    archive_index = exporter.index('tar -C "${variant_root}"')
    validate_index = exporter.index(
        'validate_persistent_runtime_archive "${persistent_archive}" "${variant_root}"'
    )
    alias_index = exporter.index('mv -Tf "${repo_next_alias}"')
    assert archive_index < validate_index < alias_index


def test_export_archive_validation_scratch_contract_uses_task_ext4_target() -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    function_start = exporter.index("validate_persistent_runtime_archive() {")
    function_end = exporter.index("\n}\n", function_start) + len("\n}")
    validation_function = exporter[function_start:function_end]

    assert "FULLMAG_CONTAINER_TARGET_DIR" in validation_function
    assert "validate_container_target_dir" in validation_function
    assert "${TMPDIR:-/tmp}" not in validation_function
    assert "trap 'exit 129' HUP" in exporter
    assert "trap 'exit 130' INT" in exporter
    assert "trap 'exit 143' TERM" in exporter


def test_failed_export_cleanup_is_best_effort_and_preserves_signal_status(
    tmp_path: Path,
) -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    function_start = exporter.index("cleanup_failed_export() {")
    function_end = exporter.index("\n}\n", function_start) + len("\n}")
    cleanup_function = exporter[function_start:function_end]
    cleanup_log = tmp_path / "cleanup.log"
    environment = os.environ.copy()
    environment["CLEANUP_LOG"] = str(cleanup_log)

    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            (
                'docker_build_ref="image-ref"\n'
                'docker_build_ref_marker="marker"\n'
                'persistent_staging_archive="archive"\n'
                'persistent_validation_root="validation"\n'
                'STAGING_ROOT="staging"\n'
                'remove_managed_fem_build_ref() { printf "image:%s\\n" "$1" >> "$CLEANUP_LOG"; }\n'
                'rmdir() { printf "rmdir:%s\\n" "$*" >> "$CLEANUP_LOG"; }\n'
                'rm_calls=0\n'
                'rm() {\n'
                '  rm_calls=$((rm_calls + 1))\n'
                '  printf "rm:%s\\n" "$*" >> "$CLEANUP_LOG"\n'
                '  [ "$rm_calls" -ne 1 ]\n'
                '}\n'
                f"{cleanup_function}\n"
                'trap cleanup_failed_export EXIT\n'
                'exit 143\n'
            ),
        ],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 143, result.stderr
    assert cleanup_log.read_text(encoding="utf-8").splitlines() == [
        "image:image-ref",
        "rmdir:-- marker",
        "rm:-f -- archive",
        "rm:-rf -- validation",
        "rm:-rf -- staging",
    ]


def test_export_archive_validation_scratch_is_unique_and_ignores_tmpdir(
    tmp_path: Path,
) -> None:
    exporter = EXPORT_SCRIPT.read_text(encoding="utf-8")
    function_start = exporter.index("validate_persistent_runtime_archive() {")
    function_end = exporter.index("\n}\n", function_start) + len("\n}")
    validation_function = exporter[function_start:function_end]
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    scratch_paths = tmp_path / "scratch-paths.txt"
    fake_tar = fake_bin / "tar"
    fake_tar.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "[ \"$1\" = \"-C\" ]\n"
        "printf '%s\\n' \"$2\" >> \"$SCRATCH_PATHS\"\n",
        encoding="utf-8",
    )
    fake_tar.chmod(0o755)
    fake_python = fake_bin / "python3"
    fake_python.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
    fake_python.chmod(0o755)
    task_target = tmp_path / "task-ext4-target"
    task_target.mkdir()
    unrelated_tmpdir = tmp_path / "tmpdir"
    unrelated_tmpdir.mkdir()
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "SCRATCH_PATHS": str(scratch_paths),
            "TMPDIR": str(unrelated_tmpdir),
            "FULLMAG_SOURCE_GIT_COMMIT": "0123abcd" * 5,
            "FULLMAG_SOURCE_WORKTREE_STATE": "dirty",
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": "45" * 32,
        }
    )
    result = subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            (
                'FULLMAG_CONTAINER_TARGET_DIR="$1"\n'
                'persistent_validation_root=""\n'
                'validate_container_target_dir() { :; }\n'
                f"{validation_function}\n"
                'validate_persistent_runtime_archive "$2" "$3"\n'
                'validate_persistent_runtime_archive "$2" "$3"\n'
            ),
            "bash",
            str(task_target),
            str(tmp_path / "runtime.tar"),
            str(tmp_path / "expected-runtime"),
        ],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    observed = [Path(line) for line in scratch_paths.read_text().splitlines()]
    assert len(observed) == 2
    assert observed[0] != observed[1]
    assert all(path.parent == task_target / "runtime-archive-validation" for path in observed)
    assert all(unrelated_tmpdir not in path.parents for path in observed)
    assert all(not path.exists() for path in observed)


def test_fullmag_fem_launch_always_ensures_managed_runtime_unless_forced() -> None:
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    fullmag_recipe = justfile.split('fullmag opt_1=""', 1)[1].split(
        "\nrun-fdm-cpu-smoke:", 1
    )[0]

    assert (
        'if [ "$force" = "true" ]; then just rebuild-fem-runtime; '
        'else just ensure-managed-fem-runtime; fi;'
    ) in fullmag_recipe
    assert 'if [ "$build" = "false" ]' not in fullmag_recipe


def test_ensure_managed_runtime_rebuilds_an_invalid_bundle() -> None:
    justfile = (REPO_ROOT / "justfile").read_text(encoding="utf-8")
    ensure_recipe = justfile.split("ensure-managed-fem-runtime:", 1)[1].split(
        "\ninspect-managed-fem-frequency-domain-deps:", 1
    )[0]

    assert "Managed FEM runtime bundle is invalid; restoring the persistent build first." in ensure_recipe
    assert "bash scripts/restore_persistent_fem_runtime.sh" in ensure_recipe
    assert "if ! validate_current >/dev/null 2>&1; then" in ensure_recipe
    assert "source scripts/lib/managed_fem_build_policy.sh" in ensure_recipe
    assert "resolve_managed_fem_build_policy" in ensure_recipe
    assert "FULLMAG_FEM_RUNTIME_REUSE_BUILD=0 just rebuild-fem-runtime" not in ensure_recipe
    assert (
        "FULLMAG_ALLOW_DIRTY_RUNTIME_EXPORT=1 "
        'FULLMAG_FEM_RUNTIME_REUSE_BUILD="$FULLMAG_FEM_RUNTIME_REUSE_BUILD" '
        "just rebuild-fem-runtime"
    ) in ensure_recipe
    assert "runtime_rebuilt=1" in ensure_recipe
    assert "capture_source_snapshot_identity.py" in ensure_recipe
    assert '--compare "$identity_file"' in ensure_recipe
    assert "--require-source-snapshot-sha256" in ensure_recipe
    assert "-newer" not in ensure_recipe


def test_managed_runtime_validator_rejects_schema_2_without_legacy_fallback(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["schema"] = 2
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = validate_fake_bundle(runtime, ldd, readelf)

    assert result.returncode == 2
    assert "expected schema 3" in result.stderr


def test_managed_runtime_validator_rejects_obsolete_source_manifest_sha256(
    tmp_path: Path,
) -> None:
    runtime, ldd, readelf = write_fake_schema_v2_bundle(tmp_path)
    manifest_path = runtime / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["source_manifest_sha256"] = "f" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = validate_fake_bundle(runtime, ldd, readelf)

    assert result.returncode == 2
    assert "rejects obsolete source_manifest_sha256" in result.stderr


def test_make_install_cli_uses_external_cargo_target_variable() -> None:
    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")

    assert 'FULLMAG_CARGO_TARGET_DIR' in makefile
    assert 'CARGO_TARGET_DIR=.fullmag/target' not in makefile


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
    hypre_build_metadata = tmp_path / "hypre-build-metadata.json"
    hypre_build_metadata.write_text(
        json.dumps(
            {
                "hypre_gpu_architectures": "60 70 80 89 90",
                "hypre_memory_variant": "baseline",
                "hypre_configure_flags": ["--without-umpire"],
                "hypre_config_macros": {
                    "HYPRE_USING_UMPIRE": False,
                    "HYPRE_USING_UMPIRE_DEVICE": False,
                    "HYPRE_USING_DEVICE_MALLOC_ASYNC": False,
                    "HYPRE_USING_THRUST_ASYNC": False,
                },
                "hypre_config_header_sha256": "f" * 64,
            }
        ),
        encoding="utf-8",
    )
    source_provenance = tmp_path / "source-provenance.json"
    source_provenance.write_text(
        json.dumps(
            {
                "source_provenance": {
                    "git_commit": "0123abcd" * 5,
                    "git_tree": "89abcdef" * 5,
                    "dirty": False,
                    "dirty_patch_sha256": None,
                    "source_inputs_sha256": "e" * 64,
                    "source_input_manifest": (
                        "scripts/managed_fem_runtime_source_inputs.v1.txt"
                    ),
                },
                "build_inputs": {
                    "justfile_sha256": "a" * 64,
                    "dockerfile_sha256": "b" * 64,
                    "source_input_manifest_sha256": "c" * 64,
                },
            }
        ),
        encoding="utf-8",
    )
    previous_manifest_sha256 = hashlib.sha256(
        (runtime / "manifest.json").read_bytes()
    ).hexdigest()

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
            "--hypre-build-metadata",
            str(hypre_build_metadata),
            "--source-provenance-json",
            str(source_provenance),
            "--device-name",
            "Synthetic RTX 4080",
            "--compute-capability",
            "8.9",
            "--driver-version",
            "591.86",
            "--git-commit",
            "0123abcd" * 5,
            "--git-tree",
            "89abcdef" * 5,
            "--worktree-state",
            "dirty",
            "--source-snapshot-sha256",
            "45" * 32,
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
    assert manifest["schema"] == 3
    assert "source_manifest_sha256" not in manifest
    assert manifest["parent_manifest_sha256"] == previous_manifest_sha256
    assert manifest["source_provenance"] == {
        "git_commit": "0123abcd" * 5,
        "git_tree": "89abcdef" * 5,
        "dirty": False,
        "dirty_patch_sha256": None,
        "source_inputs_sha256": "e" * 64,
        "source_input_manifest": "scripts/managed_fem_runtime_source_inputs.v1.txt",
    }
    assert manifest["build"]["source_inputs"] == {
        "justfile_sha256": "a" * 64,
        "dockerfile_sha256": "b" * 64,
        "source_input_manifest_sha256": "c" * 64,
    }
    assert manifest["native_libraries"]["fullmag_fem"]["cubins"] == ["sm_89"]
    assert manifest["native_libraries"]["hypre"]["path"] == "lib/libHYPRE-3.1.0.so"
    assert manifest["loader_trace"]["fullmag_fem"]["libHYPRE-3.1.0.so"] == (
        "lib/libHYPRE-3.1.0.so"
    )
    assert manifest["build"]["cuda_toolkit"] == "12.4"
    assert manifest["build"]["hypre_memory_variant"] == "baseline"
    assert manifest["runtime_diagnostics"]["compute_capability"] == "8.9"
    assert manifest["build_identity"] == {
        "git_commit": "0123abcd" * 5,
        "git_tree": "89abcdef" * 5,
        "worktree_state": "dirty",
        "source_snapshot_sha256": "45" * 32,
    }
    assert manifest["native_abi"] == {
        "mesh_desc_abi_version": 2,
        "mesh_desc_struct_size": 232,
        "mesh_desc_layout_fingerprint": (
            "fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals"
        ),
        "mesh_desc_field_offsets": MESH_FIELD_OFFSETS,
    }


def test_export_script_hashes_host_source_provenance_before_starting_docker_build() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    provenance_index = script.find("python3 scripts/hash_managed_fem_runtime_sources.py")
    build_index = script.find(
        'build_managed_fem_image "${docker_build_ref}" "${docker_compatibility_ref}"'
    )

    assert provenance_index != -1
    assert build_index != -1
    assert provenance_index < build_index
    assert "FULLMAG_ALLOW_DIRTY_RUNTIME_EXPORT" in script
    assert '--source-provenance-json "/managed-runtime-target/' in script
    assert ".fullmag/runtimes/$(basename" not in script
    assert "FULLMAG_BOOTSTRAPPED_SOURCE_PROVENANCE_FILE" in script


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


def test_export_script_bundles_native_libraries_before_importing_pyo3_module() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    fem_bundle_index = script.find(
        'copy_native_library_group "$FEM_LIB" libfullmag_fem'
    )
    pyo3_import_index = script.find(
        'LD_LIBRARY_PATH="${runtime_root}/lib:${LD_LIBRARY_PATH:-}" '
        'PYTHONPATH="${runtime_root}" python3 -c "import _fullmag_core;'
    )

    assert fem_bundle_index != -1
    assert pyo3_import_index != -1
    assert fem_bundle_index < pyo3_import_index


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


def test_export_reuse_uses_checksum_freshness_instead_of_snapshot_mtime() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert "cargo +nightly -Z checksum-freshness build" in script
    assert 'FULLMAG_FEM_RUNTIME_REUSE_BUILD="${FULLMAG_FEM_RUNTIME_REUSE_BUILD}"' in script
    assert "cargo +nightly clean --workspace --release" in script


def test_export_invalidates_only_native_sys_crates_when_native_inputs_change() -> None:
    script = EXPORT_SCRIPT.read_text(encoding="utf-8")

    assert "managed_fem_native_build_inputs.v1.txt" in script
    assert "FULLMAG_NATIVE_BUILD_SOURCE_SHA256" in script
    assert '["build_inputs"]["source_input_manifest_sha256"]' in script
    assert "FULLMAG_MANAGED_FEM_IMAGE_ID" in script
    assert ".fullmag-managed-fem-native-build-v1" in script
    assert (
        "cargo +nightly clean -p fullmag-fem-sys -p fullmag-fdm-sys"
        in script
    )
    assert (
        'native_build_fingerprint="fullmag-managed-fem-native-build.v1'
        in script
    )
    assert '${FULLMAG_CUDA_ARCHITECTURES}' in script
    assert '${FULLMAG_ENABLE_NVTX}' in script

    build_index = script.find(
        "cargo +nightly -Z checksum-freshness build"
    )
    stamp_move_index = script.find(
        'mv "${native_build_stamp_tmp}" "${native_build_stamp}"'
    )
