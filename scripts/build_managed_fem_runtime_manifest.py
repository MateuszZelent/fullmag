#!/usr/bin/env python3
"""Build a schema-v3 manifest from the libraries the managed FEM worker loads."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping

from inspect_cuda_architectures import inspect_cuda_binary
from validate_managed_fem_runtime_bundle import loader_trace, query_mesh_abi, read_soname, sha256


def relative_to_runtime(path: Path, runtime_root: Path) -> str:
    resolved = path.resolve()
    if not resolved.is_relative_to(runtime_root):
        raise ValueError(f"loaded native library escapes runtime root: {resolved}")
    return str(resolved.relative_to(runtime_root))


def select_loaded_library(
    trace: Mapping[str, Path],
    *,
    prefix: str,
    exact: str | None = None,
) -> tuple[str, Path]:
    if exact is not None and exact in trace:
        return exact, trace[exact]
    matches = [(soname, path) for soname, path in trace.items() if soname.startswith(prefix)]
    if len(matches) != 1:
        raise ValueError(
            f"loader trace must resolve exactly one {prefix} library, got "
            f"{[soname for soname, _ in matches]}"
        )
    return matches[0]


def nvcc_metadata(nvcc: str) -> tuple[str, str]:
    try:
        result = subprocess.run(
            [nvcc, "--version"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        raise ValueError(f"failed to execute {nvcc}: {exc}") from exc
    if result.returncode != 0:
        raise ValueError(f"{nvcc} --version failed: {result.stderr.strip()}")
    output = result.stdout.strip()
    match = re.search(r"\brelease\s+([0-9]+\.[0-9]+)\b", output)
    if match is None:
        raise ValueError(f"could not parse CUDA toolkit version from {nvcc} output")
    return match.group(1), output.splitlines()[-1]


def source_provenance_from_host(
    path: Path,
) -> tuple[Mapping[str, object], Mapping[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError("host source provenance payload must be an object")
    provenance = payload.get("source_provenance")
    build_inputs = payload.get("build_inputs")
    if not isinstance(provenance, Mapping) or not isinstance(build_inputs, Mapping):
        raise ValueError("host source provenance payload is incomplete")
    expected_provenance = {
        "git_commit",
        "git_tree",
        "dirty",
        "dirty_patch_sha256",
        "source_inputs_sha256",
        "source_input_manifest",
    }
    if set(provenance) != expected_provenance:
        raise ValueError("host source provenance fields do not match schema v3")
    for field in ("git_commit", "git_tree"):
        value = provenance[field]
        if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{40}", value) is None:
            raise ValueError(f"host source provenance {field} is invalid")
    value = provenance["source_inputs_sha256"]
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("host source provenance source_inputs_sha256 is invalid")
    if not isinstance(provenance["dirty"], bool):
        raise ValueError("host source provenance dirty flag is invalid")
    dirty_patch_sha256 = provenance["dirty_patch_sha256"]
    if provenance["dirty"]:
        if (
            not isinstance(dirty_patch_sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", dirty_patch_sha256) is None
        ):
            raise ValueError("dirty host source provenance requires dirty_patch_sha256")
    elif dirty_patch_sha256 is not None:
        raise ValueError("clean host source provenance must have null dirty_patch_sha256")
    if provenance["source_input_manifest"] != "scripts/managed_fem_runtime_source_inputs.v1.txt":
        raise ValueError("host source provenance input manifest is invalid")
    expected_build_inputs = {
        "justfile_sha256",
        "dockerfile_sha256",
        "source_input_manifest_sha256",
    }
    if set(build_inputs) != expected_build_inputs or any(
        not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None
        for value in build_inputs.values()
    ):
        raise ValueError("host source provenance build inputs are invalid")
    return provenance, build_inputs


def build_manifest(args: argparse.Namespace) -> Mapping[str, object]:
    runtime_root = args.runtime_root.resolve()
    manifest_path = runtime_root / "manifest.json"
    previous = json.loads(manifest_path.read_text(encoding="utf-8"))
    previous_manifest_sha256 = sha256(manifest_path)
    source_provenance, source_build_inputs = source_provenance_from_host(
        args.source_provenance_json
    )
    if source_provenance["git_commit"] != args.git_commit:
        raise ValueError(
            "host source provenance git_commit differs from managed build identity"
        )
    if source_provenance["git_tree"] != args.git_tree:
        raise ValueError(
            "host source provenance git_tree differs from managed build identity"
        )
    binaries = previous.get("binaries")
    if not isinstance(binaries, Mapping):
        binaries = {
            "launcher": "bin/fullmag-fem-gpu",
            "worker": "bin/fullmag-fem-gpu-bin",
            "api": "bin/fullmag-api",
        }
    resolved_binaries = {
        name: (runtime_root / str(binaries[name])).resolve()
        for name in ("launcher", "worker", "api")
    }
    for name, path in resolved_binaries.items():
        if not path.is_file():
            raise ValueError(f"managed FEM {name} is missing: {path}")

    worker_trace = loader_trace(
        resolved_binaries["worker"],
        runtime_root,
        args.ldd,
        allow_missing_sonames=("libcuda.so.1",),
    )
    fullmag_loaded_soname, fullmag_path = select_loaded_library(
        worker_trace, prefix="libfullmag_fem.so"
    )
    fullmag_trace = loader_trace(
        fullmag_path,
        runtime_root,
        args.ldd,
        allow_missing_sonames=("libcuda.so.1",),
    )
    mfem_soname, mfem_path = select_loaded_library(fullmag_trace, prefix="libmfem.so")
    hypre_soname, hypre_path = select_loaded_library(
        fullmag_trace,
        prefix="libHYPRE",
        exact="libHYPRE-3.1.0.so",
    )
    libceed_soname, libceed_path = select_loaded_library(fullmag_trace, prefix="libceed.so")
    selected = {
        "fullmag_fem": (fullmag_loaded_soname, fullmag_path),
        "mfem": (mfem_soname, mfem_path),
        "hypre": (hypre_soname, hypre_path),
        "libceed": (libceed_soname, libceed_path),
    }

    native_libraries: dict[str, dict[str, object]] = {}
    effective_architectures: set[str] = set()
    for name, (loaded_soname, path) in selected.items():
        objects = inspect_cuda_binary(
            path, cuobjdump=args.cuobjdump, cuda_required=True
        )
        effective_architectures.update(objects.cubins)
        effective_architectures.update(objects.ptx)
        native_libraries[name] = {
            "path": relative_to_runtime(path, runtime_root),
            "sha256": sha256(path),
            "soname": read_soname(path, args.readelf),
            "loaded_soname": loaded_soname,
            "cuda_required": True,
            "cubins": list(objects.cubins),
            "ptx": list(objects.ptx),
        }

    cuda_toolkit, cuda_compiler = nvcc_metadata(args.nvcc)
    hypre_build_metadata = json.loads(
        args.hypre_build_metadata.read_text(encoding="utf-8")
    )
    for key in (
        "hypre_gpu_architectures",
        "hypre_memory_variant",
        "hypre_configure_flags",
        "hypre_config_macros",
    ):
        if key not in hypre_build_metadata:
            raise ValueError(f"HYPRE build metadata is missing {key}")
    loader_contract = {
        "worker": {
            fullmag_loaded_soname: relative_to_runtime(fullmag_path, runtime_root),
        },
        "fullmag_fem": {
            soname: relative_to_runtime(path, runtime_root)
            for soname, path in (
                (mfem_soname, mfem_path),
                (hypre_soname, hypre_path),
                (libceed_soname, libceed_path),
            )
        },
    }
    diagnostics: Mapping[str, object] = {}
    if args.runtime_diagnostics_json is not None:
        diagnostics = json.loads(
            args.runtime_diagnostics_json.read_text(encoding="utf-8")
        )
    device_name = args.device_name or diagnostics.get("device_name")
    compute_capability = args.compute_capability or diagnostics.get("compute_capability")
    driver_version = args.driver_version or diagnostics.get("cuda_driver_version")
    if not all(isinstance(value, str) and value for value in (device_name, compute_capability, driver_version)):
        raise ValueError(
            "runtime diagnostics require device name, compute capability, and CUDA driver version"
        )
    created_at = args.created_at or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    if re.fullmatch(r"[0-9a-f]{40}", args.git_commit) is None:
        raise ValueError("managed FEM build identity git commit must be 40 lowercase hex digits")
    if re.fullmatch(r"[0-9a-f]{40}", args.git_tree) is None:
        raise ValueError("managed FEM build identity git tree must be 40 lowercase hex digits")
    if args.worktree_state not in {"clean", "dirty"}:
        raise ValueError("managed FEM build identity worktree state must be clean or dirty")
    if re.fullmatch(r"[0-9a-f]{64}", args.source_snapshot_sha256) is None:
        raise ValueError("managed FEM source snapshot must be 64 lowercase hex digits")
    built_image_id = args.docker_image_id or previous.get("docker_image_id", "")
    observed_image_id = args.observed_docker_image_id or None
    manifest: dict[str, object] = {
        "schema": 3,
        "runtime": "fem-gpu-host",
        "variant": args.variant,
        "docker_image": "fullmag/fem-gpu:local",
        "docker_image_id": built_image_id,
        "docker_image_tag_observation": {
            "ref": "fullmag/fem-gpu:local",
            "built_image_id": built_image_id,
            "observed_image_id": observed_image_id,
            "drift_observed": observed_image_id != built_image_id,
        },
        "created_at": created_at,
        "parent_manifest_sha256": previous_manifest_sha256,
        "source_provenance": dict(source_provenance),
        "build_identity": {
            "git_commit": args.git_commit,
            "git_tree": args.git_tree,
            "worktree_state": args.worktree_state,
            "source_snapshot_sha256": args.source_snapshot_sha256,
        },
        "binaries": {name: str(binaries[name]) for name in resolved_binaries},
        "integrity": {
            f"{name}_sha256": sha256(path) for name, path in resolved_binaries.items()
        },
        "native_libraries": native_libraries,
        "loader_trace": loader_contract,
        "dependencies": {
            "mfem_version": getattr(args, "mfem_version", "4.9") or "4.9",
            "hypre_version": getattr(args, "hypre_version", "3.1.0") or "3.1.0",
            "libceed_version": getattr(args, "libceed_version", "0.12.0") or "0.12.0",
            "petsc_version": getattr(args, "petsc_version", "3.24.6") or "3.24.6",
            "slepc_version": getattr(args, "slepc_version", "3.24.3") or "3.24.3",
            "cuda_toolkit": cuda_toolkit,
        },
        "build": {
            "mfem_version": getattr(args, "mfem_version", "4.9") or "4.9",
            "hypre_version": getattr(args, "hypre_version", "3.1.0") or "3.1.0",
            "libceed_version": getattr(args, "libceed_version", "0.12.0") or "0.12.0",
            "cuda_toolkit": cuda_toolkit,
            "cuda_compiler": cuda_compiler,
            "requested_cuda_architectures": args.requested_cuda_architectures,
            "effective_cuda_architectures": sorted(effective_architectures),
            "source_inputs": dict(source_build_inputs),
            **hypre_build_metadata,
        },
        "runtime_diagnostics": {
            "device_name": device_name,
            "compute_capability": compute_capability,
            "cuda_driver_version": driver_version,
        },
        "python_modules": previous.get("python_modules", {"_fullmag_core": "_fullmag_core.so"}),
        "frequency_domain_dependencies": previous.get(
            "frequency_domain_dependencies", {}
        ),
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--variant", required=True)
    parser.add_argument("--requested-cuda-architectures", required=True)
    parser.add_argument("--hypre-build-metadata", type=Path, required=True)
    parser.add_argument("--source-provenance-json", type=Path, required=True)
    parser.add_argument("--device-name")
    parser.add_argument("--compute-capability")
    parser.add_argument("--driver-version")
    parser.add_argument("--runtime-diagnostics-json", type=Path)
    parser.add_argument("--docker-image-id")
    parser.add_argument("--observed-docker-image-id")
    parser.add_argument("--created-at")
    parser.add_argument("--git-commit", required=True)
    parser.add_argument("--git-tree", required=True)
    parser.add_argument("--worktree-state", required=True)
    parser.add_argument("--source-snapshot-sha256", required=True)
    parser.add_argument("--mfem-version")
    parser.add_argument("--hypre-version")
    parser.add_argument("--libceed-version")
    parser.add_argument("--petsc-version")
    parser.add_argument("--slepc-version")
    parser.add_argument("--cuobjdump", default="cuobjdump")
    parser.add_argument("--ldd", default="ldd")
    parser.add_argument("--readelf", default="readelf")
    parser.add_argument("--nvcc", default="nvcc")
    args = parser.parse_args()
    try:
        manifest = build_manifest(args)
        print(
            json.dumps(
                {
                    "runtime": manifest["runtime"],
                    "variant": manifest["variant"],
                    "manifest": "schema-v3-written",
                },
                sort_keys=True,
            )
        )
    except (OSError, ValueError, json.JSONDecodeError, KeyError) as exc:
        print(f"MANAGED_FEM_RUNTIME_MANIFEST_ERROR={exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
