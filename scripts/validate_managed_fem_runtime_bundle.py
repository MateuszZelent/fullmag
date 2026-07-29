#!/usr/bin/env python3
"""Fail closed when the managed FEM bundle manifest disagrees with its files."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Mapping, Sequence


REQUIRED_NATIVE_LIBRARIES = ("fullmag_fem", "mfem", "hypre", "libceed")
REQUIRED_BUILD_METADATA = (
    "mfem_version",
    "hypre_version",
    "libceed_version",
    "cuda_toolkit",
    "cuda_compiler",
    "requested_cuda_architectures",
    "effective_cuda_architectures",
    "hypre_gpu_architectures",
    "hypre_memory_variant",
    "hypre_configure_flags",
    "hypre_config_macros",
    "hypre_config_header_sha256",
)
MESH_ABI_QUERY = Path(__file__).with_name("query_fem_mesh_abi.py")

HYPRE_MEMORY_VARIANT_CONTRACTS = {
    "baseline": {
        "required_flags": {"--without-umpire"},
        "macros": {
            "HYPRE_USING_UMPIRE": False,
            "HYPRE_USING_UMPIRE_DEVICE": False,
            "HYPRE_USING_DEVICE_MALLOC_ASYNC": False,
            "HYPRE_USING_THRUST_ASYNC": False,
        },
    },
    "umpire": {
        "required_flags": {"--with-umpire", "--with-umpire-device"},
        "macros": {
            "HYPRE_USING_UMPIRE": True,
            "HYPRE_USING_UMPIRE_DEVICE": True,
            "HYPRE_USING_DEVICE_MALLOC_ASYNC": False,
            "HYPRE_USING_THRUST_ASYNC": False,
        },
    },
    "cuda_async": {
        "required_flags": {"--without-umpire", "--enable-device-malloc-async"},
        "macros": {
            "HYPRE_USING_UMPIRE": False,
            "HYPRE_USING_UMPIRE_DEVICE": False,
            "HYPRE_USING_DEVICE_MALLOC_ASYNC": True,
            "HYPRE_USING_THRUST_ASYNC": False,
        },
    },
    "thrust_async": {
        "required_flags": {"--without-umpire", "--enable-thrust-async"},
        "macros": {
            "HYPRE_USING_UMPIRE": False,
            "HYPRE_USING_UMPIRE_DEVICE": False,
            "HYPRE_USING_DEVICE_MALLOC_ASYNC": False,
            "HYPRE_USING_THRUST_ASYNC": True,
        },
    },
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def exact_bundle_identity(runtime_root: Path) -> Mapping[str, Mapping[str, object]]:
    runtime_root = runtime_root.resolve()
    if not runtime_root.is_dir():
        raise ValueError(f"managed FEM bundle directory is missing: {runtime_root}")
    identity: dict[str, Mapping[str, object]] = {}
    for path in sorted(runtime_root.rglob("*"), key=lambda item: str(item.relative_to(runtime_root))):
        relative = str(path.relative_to(runtime_root))
        if path.is_symlink():
            identity[relative] = {"type": "symlink", "target": os.readlink(path)}
        elif path.is_dir():
            identity[relative] = {"type": "directory"}
        elif path.is_file():
            identity[relative] = {
                "type": "file",
                "size": path.stat().st_size,
                "sha256": sha256(path),
            }
        else:
            raise ValueError(f"unsupported filesystem entry in managed FEM bundle: {path}")
    return identity


def compare_exact_bundles(first: Path, second: Path) -> int:
    first_identity = exact_bundle_identity(first)
    second_identity = exact_bundle_identity(second)
    if first_identity != second_identity:
        differing = sorted(
            key
            for key in set(first_identity).union(second_identity)
            if first_identity.get(key) != second_identity.get(key)
        )
        raise ValueError(
            "exact bundle identity mismatch: " + ", ".join(differing[:10])
        )
    return len(first_identity)


def require_mapping(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError(f"managed FEM manifest has no {label} contract")
    return value


def query_mesh_abi(library: Path, runtime_root: Path) -> Mapping[str, object]:
    environment = os.environ.copy()
    existing = environment.get("LD_LIBRARY_PATH")
    environment["LD_LIBRARY_PATH"] = str(runtime_root / "lib") + (
        f":{existing}" if existing else ""
    )
    try:
        result = subprocess.run(
            [sys.executable, str(MESH_ABI_QUERY), str(library)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
    except OSError as exc:
        raise ValueError(f"failed to execute mesh ABI query: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ValueError(f"managed FEM mesh ABI query failed: {detail}")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError("managed FEM mesh ABI query returned invalid JSON") from exc
    return require_mapping(value, "queried native_abi")


def validate_hypre_memory_build_contract(build: Mapping[str, object]) -> None:
    variant = build.get("hypre_memory_variant")
    contract = HYPRE_MEMORY_VARIANT_CONTRACTS.get(variant)
    if contract is None:
        raise ValueError(f"unsupported HYPRE memory variant: {variant!r}")
    flags_value = build.get("hypre_configure_flags")
    if not isinstance(flags_value, list) or not all(
        isinstance(flag, str) and flag for flag in flags_value
    ):
        raise ValueError("managed FEM HYPRE configure flags are invalid")
    flags = set(flags_value)
    missing_flags = contract["required_flags"].difference(flags)
    if missing_flags:
        raise ValueError(
            f"{variant} is missing required HYPRE configure flags: "
            + ", ".join(sorted(missing_flags))
        )
    macros = require_mapping(build.get("hypre_config_macros"), "HYPRE config macros")
    for macro, expected in contract["macros"].items():
        actual = macros.get(macro)
        if actual is not expected:
            expected_value = 1 if expected else 0
            raise ValueError(
                f"{variant} requires {macro}={expected_value}; got {actual!r}"
            )
    config_header_sha256 = build.get("hypre_config_header_sha256")
    if (
        not isinstance(config_header_sha256, str)
        or len(config_header_sha256) != 64
        or any(character not in "0123456789abcdef" for character in config_header_sha256)
    ):
        raise ValueError("managed FEM HYPRE config-header SHA-256 is invalid")


def resolve_bundle_path(runtime_root: Path, relative: object, label: str) -> Path:
    if not isinstance(relative, str) or not relative:
        raise ValueError(f"managed FEM manifest has no {label} path")
    path = (runtime_root / relative).resolve()
    if not path.is_relative_to(runtime_root):
        raise ValueError(f"managed FEM {label} escapes runtime root: {relative}")
    if not path.is_file():
        raise ValueError(f"managed FEM {label} is missing: {path}")
    return path


def read_soname(path: Path, readelf: str) -> str | None:
    try:
        result = subprocess.run(
            [readelf, "-d", str(path)],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        raise ValueError(f"failed to execute {readelf}: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ValueError(f"{readelf} failed for {path}: {detail}")
    match = re.search(r"\(SONAME\).*?\[([^]]+)]", result.stdout)
    if match is None:
        return None
    return match.group(1)


def parse_ldd(output: str) -> Mapping[str, Path]:
    loaded: dict[str, Path] = {}
    for line in output.splitlines():
        match = re.match(r"^\s*(\S+)\s+=>\s+(\S+)", line)
        if match is not None and match.group(2) != "not":
            loaded[match.group(1)] = Path(match.group(2)).resolve()
            continue
        match = re.match(r"^\s*(/\S+)\s+\(", line)
        if match is not None:
            path = Path(match.group(1)).resolve()
            loaded[path.name] = path
    return loaded


def loader_trace(
    path: Path,
    runtime_root: Path,
    ldd: str,
    *,
    allow_missing_sonames: Sequence[str] = (),
) -> Mapping[str, Path]:
    environment = os.environ.copy()
    existing = environment.get("LD_LIBRARY_PATH")
    environment["LD_LIBRARY_PATH"] = str(runtime_root / "lib") + (
        f":{existing}" if existing else ""
    )
    try:
        result = subprocess.run(
            [ldd, str(path)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
    except OSError as exc:
        raise ValueError(f"failed to execute {ldd}: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ValueError(f"loader trace failed for {path}: {detail}")
    unresolved = {
        match.group(1)
        for line in result.stdout.splitlines()
        if (match := re.match(r"^\s*(\S+)\s+=>\s+not found\s*$", line))
    }
    unexpected_unresolved = unresolved.difference(allow_missing_sonames)
    if unexpected_unresolved:
        raise ValueError(
            f"loader trace has unresolved dependency for {path}: "
            + ", ".join(sorted(unexpected_unresolved))
        )
    return parse_ldd(result.stdout)


def validate_hypre_symbol_provider(
    worker: Path,
    runtime_root: Path,
    worker_trace: Mapping[str, Path],
    expected_hypre: Path,
) -> tuple[int, tuple[str, ...]]:
    hypre_entries = tuple(
        sorted(
            (soname, path.resolve())
            for soname, path in worker_trace.items()
            if soname.startswith("libHYPRE")
        )
    )
    loaded_hypre = tuple(soname for soname, _ in hypre_entries)
    expected_hypre = expected_hypre.resolve()
    if not any(path == expected_hypre for _, path in hypre_entries):
        loaded = ", ".join(f"{soname} => {path}" for soname, path in hypre_entries)
        raise ValueError(
            "worker loader trace does not load manifest HYPRE "
            f"{expected_hypre}; loaded: {loaded or 'none'}"
        )
    if len(loaded_hypre) <= 1:
        return 0, loaded_hypre

    environment = os.environ.copy()
    existing = environment.get("LD_LIBRARY_PATH")
    environment["LD_LIBRARY_PATH"] = str(runtime_root / "lib") + (
        f":{existing}" if existing else ""
    )
    environment["LD_BIND_NOW"] = "1"
    environment["LD_DEBUG"] = "bindings"
    try:
        result = subprocess.run(
            [str(worker), "--help"],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
    except OSError as exc:
        raise ValueError(f"failed to execute HYPRE binding proof: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ValueError(f"HYPRE binding proof failed for {worker}: {detail}")

    return validate_hypre_binding_output(
        result.stderr + "\n" + result.stdout, expected_hypre, loaded_hypre
    )


def validate_hypre_binding_output(
    output: str,
    expected_hypre: Path,
    loaded_hypre: tuple[str, ...],
) -> tuple[int, tuple[str, ...]]:
    bindings: list[tuple[Path, Path, str]] = []
    pattern = re.compile(
        r"binding file\s+(\S+)\s+\[[^]]+]\s+to\s+(\S+)\s+\[[^]]+]"
        r": normal symbol [`'](HYPRE_[^`']+)[`']"
    )
    for match in pattern.finditer(output):
        bindings.append(
            (Path(match.group(1)).resolve(), Path(match.group(2)).resolve(), match.group(3))
        )
    if not bindings:
        raise ValueError(
            "multiple HYPRE libraries are loaded but LD_BIND_NOW produced no public "
            "HYPRE symbol-provider proof"
        )

    wrong_providers = sorted(
        {str(target) for _, target, _ in bindings if target != expected_hypre}
    )
    if wrong_providers:
        raise ValueError(
            "public HYPRE symbols bind to an unexpected provider: "
            + ", ".join(wrong_providers)
        )
    if not any(source.name.startswith("libpetsc") for source, _, _ in bindings):
        raise ValueError(
            "multiple HYPRE libraries are loaded but PETSc-to-HYPRE provider proof is missing"
        )
    return len(bindings), loaded_hypre


def parse_native_requirements(values: Sequence[str]) -> Sequence[tuple[str, str]]:
    requirements: list[tuple[str, str]] = []
    for value in values:
        if "=" in value:
            library, sm = value.split("=", 1)
            targets = (library,)
        else:
            sm = value
            targets = ("fullmag_fem", "hypre")
        if not re.fullmatch(r"sm_[0-9]+", sm):
            raise ValueError(f"invalid native cubin requirement: {value}")
        for library in targets:
            if library not in REQUIRED_NATIVE_LIBRARIES:
                raise ValueError(f"unknown native library in cubin requirement: {library}")
            requirements.append((library, sm))
    return tuple(requirements)


def validate_bundle(
    runtime_root: Path,
    *,
    ldd: str,
    readelf: str,
    native_requirements: Sequence[tuple[str, str]],
    required_compute_capability: str | None,
    allow_unaddressed_staging: bool,
) -> Mapping[str, object]:
    runtime_root = runtime_root.resolve()
    manifest_path = runtime_root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != 2:
        raise ValueError("unsupported managed FEM manifest schema; expected schema 2")
    variant = manifest.get("variant")
    if not isinstance(variant, str) or not variant:
        raise ValueError("managed FEM manifest has no variant")
    if not allow_unaddressed_staging:
        expected_directory = f"{variant}-{sha256(manifest_path)}"
        if runtime_root.name != expected_directory:
            raise ValueError(
                "hash-addressed variant directory mismatch: "
                f"expected {expected_directory}, got {runtime_root.name}"
            )

    binaries = require_mapping(manifest.get("binaries"), "binaries")
    integrity = require_mapping(manifest.get("integrity"), "integrity")
    resolved_binaries: dict[str, Path] = {}
    for name in ("launcher", "worker", "api"):
        path = resolve_bundle_path(runtime_root, binaries.get(name), name)
        if not os.access(path, os.X_OK):
            raise ValueError(f"managed FEM {name} is not executable: {path}")
        expected = integrity.get(f"{name}_sha256")
        if not isinstance(expected, str):
            raise ValueError(f"managed FEM manifest has no {name} hash")
        actual = sha256(path)
        if actual != expected:
            raise ValueError(
                f"managed FEM {name} hash mismatch: expected {expected}, got {actual}"
            )
        resolved_binaries[name] = path

    native_libraries = require_mapping(
        manifest.get("native_libraries"), "native_libraries"
    )
    resolved_libraries: dict[str, Path] = {}
    for name in REQUIRED_NATIVE_LIBRARIES:
        entry = require_mapping(native_libraries.get(name), f"native library {name}")
        path = resolve_bundle_path(runtime_root, entry.get("path"), f"native library {name}")
        expected = entry.get("sha256")
        if not isinstance(expected, str):
            raise ValueError(f"managed FEM native library {name} has no sha256")
        actual = sha256(path)
        if actual != expected:
            raise ValueError(
                f"managed FEM native library {name} hash mismatch: "
                f"expected {expected}, got {actual}"
            )
        expected_soname = entry.get("soname")
        actual_soname = read_soname(path, readelf)
        if actual_soname != expected_soname:
            raise ValueError(
                f"managed FEM native library {name} SONAME mismatch: "
                f"expected {expected_soname}, got {actual_soname}"
            )
        loaded_soname = entry.get("loaded_soname")
        if not isinstance(loaded_soname, str) or not loaded_soname:
            raise ValueError(
                f"managed FEM native library {name} has no loaded_soname"
            )
        cubins = entry.get("cubins")
        ptx = entry.get("ptx")
        if not isinstance(cubins, list) or not all(isinstance(item, str) for item in cubins):
            raise ValueError(f"managed FEM native library {name} has invalid cubin metadata")
        if not isinstance(ptx, list) or not all(isinstance(item, str) for item in ptx):
            raise ValueError(f"managed FEM native library {name} has invalid PTX metadata")
        if entry.get("cuda_required") is True and not cubins and not ptx:
            raise ValueError(
                f"managed FEM native library {name} requires CUDA but has no code objects"
            )
        resolved_libraries[name] = path

    native_abi = require_mapping(manifest.get("native_abi"), "native_abi")
    queried_native_abi = query_mesh_abi(resolved_libraries["fullmag_fem"], runtime_root)
    if dict(native_abi) != dict(queried_native_abi):
        raise ValueError(
            "managed FEM mesh descriptor ABI mismatch: "
            f"manifest {dict(native_abi)}, built library {dict(queried_native_abi)}"
        )

    for name, sm in native_requirements:
        cubins = native_libraries[name]["cubins"]
        if sm not in cubins:
            raise ValueError(
                f"native library {name} is missing required native cubin {sm}; "
                f"found {cubins}"
            )

    trace_contract = require_mapping(manifest.get("loader_trace"), "loader_trace")
    trace_sources = {
        "worker": resolved_binaries["worker"],
        "fullmag_fem": resolved_libraries["fullmag_fem"],
    }
    actual_traces: dict[str, Mapping[str, Path]] = {}
    for source_name, source_path in trace_sources.items():
        expected_trace = require_mapping(
            trace_contract.get(source_name), f"loader trace {source_name}"
        )
        actual_trace = loader_trace(source_path, runtime_root, ldd)
        actual_traces[source_name] = actual_trace
        for soname, relative in expected_trace.items():
            expected_path = resolve_bundle_path(
                runtime_root, relative, f"loader trace {source_name}:{soname}"
            )
            actual_path = actual_trace.get(str(soname))
            if actual_path is None or actual_path != expected_path:
                raise ValueError(
                    f"loader trace mismatch for {source_name}:{soname}: "
                    f"expected {expected_path}, got {actual_path}"
                )

    fullmag_trace = require_mapping(trace_contract.get("fullmag_fem"), "loader trace fullmag_fem")
    expected_loaded_sonames = {
        str(
            require_mapping(native_libraries[name], f"native library {name}").get(
                "loaded_soname"
            )
        )
        for name in ("mfem", "hypre", "libceed")
    }
    missing_sonames = expected_loaded_sonames.difference(fullmag_trace)
    if missing_sonames:
        raise ValueError(
            "loader trace for fullmag_fem omits managed native libraries: "
            + ", ".join(sorted(missing_sonames))
        )

    hypre_binding_count, loaded_hypre_sonames = validate_hypre_symbol_provider(
        resolved_binaries["worker"],
        runtime_root,
        actual_traces["worker"],
        resolved_libraries["hypre"],
    )

    build = require_mapping(manifest.get("build"), "build metadata")
    for key in REQUIRED_BUILD_METADATA:
        if key not in build or build[key] in (None, "", []):
            raise ValueError(f"managed FEM build metadata is missing {key}")
    validate_hypre_memory_build_contract(build)
    diagnostics = require_mapping(
        manifest.get("runtime_diagnostics"), "runtime_diagnostics"
    )
    compute_capability = diagnostics.get("compute_capability")
    if not isinstance(compute_capability, str) or not compute_capability:
        raise ValueError("managed FEM runtime diagnostics have no compute capability")
    if (
        required_compute_capability is not None
        and compute_capability != required_compute_capability
    ):
        raise ValueError(
            "managed FEM runtime compute capability mismatch: "
            f"expected {required_compute_capability}, got {compute_capability}"
        )
    return {
        "runtime": manifest.get("runtime"),
        "variant": manifest.get("variant"),
        "bundle": "valid",
        "compute_capability": compute_capability,
        "loaded_hypre_sonames": loaded_hypre_sonames,
        "hypre_binding_provider": str(resolved_libraries["hypre"]),
        "hypre_binding_count": hypre_binding_count,
    }


def main() -> None:
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--ldd", default="ldd")
    parser.add_argument("--readelf", default="readelf")
    parser.add_argument("--require-native-cubin", action="append", default=[])
    parser.add_argument("--require-compute-capability")
    parser.add_argument("--compare-exact", type=Path)
    parser.add_argument("--allow-unaddressed-staging", action="store_true")
    args = parser.parse_args()
    try:
        if args.compare_exact is not None:
            entry_count = compare_exact_bundles(args.runtime_root, args.compare_exact)
            print(
                json.dumps(
                    {"bundle": "exact-match", "entry_count": entry_count},
                    sort_keys=True,
                )
            )
            return
        result = validate_bundle(
            args.runtime_root,
            ldd=args.ldd,
            readelf=args.readelf,
            native_requirements=parse_native_requirements(args.require_native_cubin),
            required_compute_capability=args.require_compute_capability,
            allow_unaddressed_staging=args.allow_unaddressed_staging,
        )
        print(json.dumps(result, sort_keys=True))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"MANAGED_FEM_RUNTIME_VALIDATION_ERROR={exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
