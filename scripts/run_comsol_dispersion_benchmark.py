#!/usr/bin/env python3
"""Run the COMSOL-aligned C0/C1/A1 benchmark from one managed build.

This is a host-side orchestration entry point.  It consumes a completed
``fem-cpu-slepc-modal-v1`` runner job, verifies the exact source capsule,
runtime receipt and pinned image, and then runs the already-built runtime in
the repository's ``fem-modal-cpu`` Compose service.  It never builds an image
or a native target and it does not silently replace the CPU/SLEPc lane.

The benchmark model itself is deliberately kept in
``tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py``.
The cases are selected with ``FULLMAG_COMSOL_DISPERSION_CASE`` and are run
sequentially so the output is easy to compare with the COMSOL guide.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import uuid
from typing import Any, Mapping, Sequence


# The script is normally executed as ``python scripts/<name>.py``.  Keep the
# imports independent of the caller's current working directory so direct
# invocation and the just entry point use the same resolver modules.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import fullmag_storage  # noqa: E402  (the path setup above is intentional)
from local_runner.build_executor import validate_build_receipt  # noqa: E402
from local_runner.build_source import bind_identity  # noqa: E402
from local_runner.worker_entrypoint import canonical, verify_source  # noqa: E402
from validate_comsol_dispersion_scientific_gate import (  # noqa: E402
    EVIDENCE_RELATIVE_PATH,
    EVIDENCE_SCHEMA,
    GATE_SCHEMA as SCIENTIFIC_GATE_SCHEMA,
    validate_case as validate_scientific_case,
    validate_requested_cases,
)


PROFILE = "fem-cpu-slepc-modal-v1"
RUNTIME_PROFILE = "fem-cpu-slepc-runtime-v1"
SUPPORTED_PROFILES = (PROFILE, RUNTIME_PROFILE)
EXPECTED_IMAGE_DIGEST = "sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7"
RECEIPT_SCHEMA = "fullmag.local-runner.build-receipt.v1"
CONTRACT_SCHEMA = "fullmag.fem.cpu.slepc_modal_contract_result.v1"
RUN_REQUEST_SCHEMA = "fullmag.comsol-dispersion-benchmark.request.v1"
RUN_RESULT_SCHEMA = "fullmag.comsol-dispersion-benchmark.result.v1"
DEFAULT_TIMEOUT_SECONDS = 6 * 60 * 60
CONTAINER_TIMEOUT_GRACE_SECONDS = 30
HOST_COMPOSE_GRACE_SECONDS = 60
DOCKER_LIFECYCLE_TIMEOUT_SECONDS = 30
CONTAINER_LABEL_COMPONENT = "com.fullmag.component"
CONTAINER_LABEL_JOB = "com.fullmag.job-id"
CONTAINER_LABEL_RUN = "com.fullmag.run-id"
CONTAINER_COMPONENT = "dispersion-benchmark"
JOB_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
SHA256_RE = re.compile(r"[a-f0-9]{64}\Z")
CAPTURE_ID_RE = re.compile(r"[a-f0-9]{32}\Z")
COMMIT_RE = re.compile(r"[a-f0-9]{40}(?:[a-f0-9]{24})?\Z")
IMAGE_RE = re.compile(r"sha256:[a-f0-9]{64}\Z")
CONTAINER_ID_RE = re.compile(r"[a-f0-9]{64}\Z")
CASES = ("c0", "c1", "a1")
DEFAULT_CASES = CASES
PUBLIC_MODEL_FILES = (
    "tests/__init__.py",
    "tests/standard_problems/__init__.py",
    "tests/standard_problems/mumag/__init__.py",
    "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/__init__.py",
    "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py",
    "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py",
)
REQUIRED_RUNTIME_ARTIFACTS = (
    "outputs/.fullmag/local/bin/fullmag-bin",
    "outputs/.fullmag/local/bin/fullmag-api",
    "outputs/.fullmag/local/_fullmag_core.so",
    "outputs/.fullmag/local/launcher-build-mode",
    "source-identity.json",
)
MODAL_TARGET = "fem_poisson_airbox_modal_eigen_slepc_contract"
FLOQUET_TARGETS = (
    "fem_floquet_magnetic_operator_contract",
    "fem_floquet_bloch_scalar_contract",
    "fem_floquet_airbox_operator_contract",
    "fem_floquet_dynamic_demag_k_contract",
    "fem_floquet_waveguide_demag_k_contract",
    "fem_floquet_waveguide_cross_section_contract",
    "fem_floquet_modal_solver_contract",
)
MODAL_TARGETS = (MODAL_TARGET, *FLOQUET_TARGETS)
REQUIRED_CASE_ARTIFACTS = (
    "metadata.json",
    "eigen/spectrum.v2.json",
    "eigen/branches.v2.json",
    "eigen/dispersion.csv",
    "eigen/diagnostics/solver.v1.json",
    "eigen/metadata/eigen_summary.json",
    "frequency_domain/manifest.v1.json",
)
# The native modal summary carries the accepted relax-to-eigen certificate.
# For a shared-domain FEM run that certificate intentionally contains the
# node-wise equilibrium fields, so its JSON is larger than the small control
# plane artifacts.  Keep a bounded, explicit budget rather than applying the
# generic 16 MiB JSON limit and rejecting a valid native result.
MAX_EIGEN_SUMMARY_BYTES = 256 * 1024 * 1024
MAX_EXTERNAL_EVIDENCE_FILES = 4096
MAX_EXTERNAL_EVIDENCE_BYTES = 512 * 1024 * 1024


class BenchmarkError(RuntimeError):
    """A failed managed benchmark preflight or execution contract."""


@dataclass(frozen=True)
class BuildContext:
    layout: Mapping[str, Any]
    job: Mapping[str, Any]
    manifest: Mapping[str, Any]
    native_identity: Mapping[str, Any]
    receipt: Mapping[str, Any]
    run_root: Path
    artifacts: Path
    capsule: Path
    source_tree: Path
    runtime_root: Path


def _is_reparse(path: Path) -> bool:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return False
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & 0x400
    )


def _regular_file(path: Path, label: str) -> Path:
    if _is_reparse(path) or not path.is_file():
        raise BenchmarkError(f"{label} is not a regular file: {path}")
    return path


def _regular_dir(path: Path, label: str) -> Path:
    if _is_reparse(path) or not path.is_dir():
        raise BenchmarkError(f"{label} is not a regular directory: {path}")
    return path


def _json_file(path: Path, label: str, *, max_bytes: int = 16 * 1024 * 1024) -> dict[str, Any]:
    _regular_file(path, label)
    if path.stat().st_size > max_bytes:
        raise BenchmarkError(f"{label} is oversized: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise BenchmarkError(f"{label} is not valid UTF-8 JSON: {path}") from error
    if not isinstance(value, dict):
        raise BenchmarkError(f"{label} must be a JSON object: {path}")
    return value


def _sha256_file(path: Path) -> str:
    _regular_file(path, "file")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _same_path(left: Path | str, right: Path | str) -> bool:
    return os.path.normcase(os.path.abspath(str(left))) == os.path.normcase(
        os.path.abspath(str(right))
    )


def _safe_relative(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise BenchmarkError(f"unsafe {label} path")
    posix = PurePosixPath(value)
    windows = PureWindowsPath(value)
    if (
        posix.is_absolute()
        or windows.anchor
        or any(part in {"", ".", ".."} for part in value.split("/"))
        or posix.as_posix() != value
    ):
        raise BenchmarkError(f"noncanonical {label} path")
    return value


def _contained_path(root: Path, relative: str, label: str) -> Path:
    _safe_relative(relative, label)
    candidate = root.joinpath(*PurePosixPath(relative).parts)
    try:
        return fullmag_storage.validate_path(candidate, root, label)
    except (fullmag_storage.StorageError, OSError, ValueError) as error:
        raise BenchmarkError(f"{label} escapes managed storage") from error


def _read_job(layout: Mapping[str, Any], job_id: str) -> dict[str, Any]:
    if not JOB_ID_RE.fullmatch(job_id):
        raise BenchmarkError("invalid runner job id")
    storage = Path(layout["storage_root"])
    database = fullmag_storage.validate_path(
        storage / "index" / "runner-jobs.sqlite", storage, "runner database"
    )
    _regular_file(database, "runner database")
    connection: sqlite3.Connection | None = None
    try:
        uri = database.as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            """
            SELECT job_id, owner, worktree_id, source_digest, profile,
                   operation, payload, state, exit_code
            FROM jobs WHERE job_id=?
            """,
            (job_id,),
        ).fetchone()
    except sqlite3.Error as error:
        raise BenchmarkError("cannot read the runner job database") from error
    finally:
        if connection is not None:
            connection.close()
    if row is None:
        raise BenchmarkError("runner job was not found")
    job = dict(row)
    try:
        job["payload"] = json.loads(job["payload"])
    except (TypeError, ValueError) as error:
        raise BenchmarkError("runner job payload is not valid JSON") from error
    if not isinstance(job["payload"], dict):
        raise BenchmarkError("runner job payload is not an object")

    if job.get("profile") not in SUPPORTED_PROFILES:
        raise BenchmarkError("runner job does not satisfy benchmark preflight: profile")

    expected = {
        "worktree_id": layout["worktree_id"],
        "operation": "build",
        "state": "succeeded",
        "exit_code": 0,
    }
    for key, value in expected.items():
        if job.get(key) != value:
            raise BenchmarkError(f"runner job does not satisfy benchmark preflight: {key}")
    if not isinstance(job.get("source_digest"), str) or not SHA256_RE.fullmatch(
        job["source_digest"]
    ):
        raise BenchmarkError("runner job source digest is invalid")

    payload = job["payload"]
    origin = payload.get("origin_repo")
    if not isinstance(origin, str) or not _same_path(origin, layout["repo_root"]):
        raise BenchmarkError("runner job origin does not match this worktree")
    capture_id = payload.get("capture_id")
    if not isinstance(capture_id, str) or not CAPTURE_ID_RE.fullmatch(capture_id):
        raise BenchmarkError("runner job capture identity is invalid")
    expected_capsule = f"runs/{layout['worktree_id']}/{capture_id}/source"
    if payload.get("capsule_relative") != expected_capsule:
        raise BenchmarkError("runner job capsule path is not canonical")
    native = payload.get("native_source_identity")
    if not isinstance(native, dict):
        raise BenchmarkError("runner job has no native source identity")
    if native.get("schema") != "fullmag.source-snapshot.v2":
        raise BenchmarkError("runner job native source identity has an unknown schema")
    if not isinstance(native.get("head_commit_full"), str) or not COMMIT_RE.fullmatch(
        native["head_commit_full"]
    ):
        raise BenchmarkError("runner job native commit identity is invalid")
    if not isinstance(native.get("source_snapshot_sha256"), str) or not SHA256_RE.fullmatch(
        native["source_snapshot_sha256"]
    ):
        raise BenchmarkError("runner job native snapshot identity is invalid")
    return job


def _validated_build_evidence(
    artifacts: Path,
    profile: str,
    native_identity: Mapping[str, Any],
) -> dict[str, Any]:
    """Select evidence after canonical validate_build_receipt has verified hashes.

    Runtime-only builds do not claim CTest execution. Their production probes
    are checked by the canonical receipt validator before this helper runs.
    """
    if profile == PROFILE:
        contract = _validate_contract(
            artifacts / "contracts" / "slepc-modal" / "result.json", native_identity
        )
        return {"kind": "native_build_and_ctest", "source": contract["source"]}
    if profile != RUNTIME_PROFILE:
        raise BenchmarkError("unsupported benchmark build profile")
    attestation = _json_file(artifacts / "runtime-attestation.json", "runtime attestation")
    expected_source = {
        "commit": native_identity["head_commit_full"],
        "snapshot_sha256": native_identity["source_snapshot_sha256"],
    }
    if (
        attestation.get("schema") != "fullmag.fem.slepc_runtime.attestation.v1"
        or attestation.get("status") != "pass"
        or attestation.get("source") != expected_source
    ):
        raise BenchmarkError("runtime build evidence source or status mismatch")
    return {"kind": "native_build_and_runtime_probes", "source": expected_source}


def _validate_contract(
    contract_path: Path,
    native_identity: Mapping[str, Any],
) -> dict[str, Any]:
    contract = _json_file(contract_path, "SLEPc modal contract result")
    if (
        contract.get("schema") != CONTRACT_SCHEMA
        or contract.get("scenario") != "slepc-modal"
        or contract.get("status") != "pass"
    ):
        raise BenchmarkError("SLEPc modal contract is missing or failed")
    expected_source = {
        "commit": native_identity["head_commit_full"],
        "snapshot_sha256": native_identity["source_snapshot_sha256"],
    }
    if contract.get("source") != expected_source:
        raise BenchmarkError("SLEPc modal contract source identity mismatch")
    expected_requested = {
        "backend": "fem",
        "device": "cpu",
        "precision": "double",
        "slepc": True,
    }
    if contract.get("requested") != expected_requested:
        raise BenchmarkError("SLEPc modal requested execution mismatch")
    expected_resolved = {**expected_requested, "fallback_used": False}
    if contract.get("resolved") != expected_resolved:
        raise BenchmarkError("SLEPc modal resolved execution permits a fallback")
    build = contract.get("build")
    if not isinstance(build, dict):
        raise BenchmarkError("SLEPc modal contract lacks build metadata")
    options = build.get("options")
    required_options = {
        "-DFULLMAG_ENABLE_CUDA=ON",
        "-DFULLMAG_ENABLE_FEM_GPU=OFF",
        "-DFULLMAG_USE_MFEM_STACK=ON",
        "-DFULLMAG_FEM_WITH_SLEPC=ON",
    }
    if (
        build.get("modal_target") != MODAL_TARGET
        or tuple(build.get("floquet_targets", ())) != FLOQUET_TARGETS
        or not isinstance(options, list)
        or not required_options.issubset(options)
        or build.get("ctest_completed") is not True
        or build.get("executed_targets") != list(MODAL_TARGETS)
    ):
        raise BenchmarkError("SLEPc modal contract does not prove its exact CMake/CTest lane")
    attestation = contract.get("attestation")
    if not isinstance(attestation, dict):
        raise BenchmarkError("SLEPc modal contract lacks attestations")
    junit = attestation.get("ctest_junit")
    if (
        not isinstance(junit, dict)
        or junit.get("status") != "pass"
        or junit.get("testcase_count") != len(MODAL_TARGETS)
        or junit.get("skipped_count") != 0
        or junit.get("failure_count") != 0
        or junit.get("testcases") != list(MODAL_TARGETS)
    ):
        raise BenchmarkError("SLEPc modal contract does not prove all CTest targets passed")
    cmake = attestation.get("cmake")
    cache_options = cmake.get("options") if isinstance(cmake, dict) else None
    if not isinstance(cmake, dict) or cmake.get("status") != "pass" or not isinstance(
        cache_options, dict
    ):
        raise BenchmarkError("SLEPc modal contract lacks CMake attestation")
    for name, value in {
        "FULLMAG_ENABLE_CUDA": "ON",
        "FULLMAG_ENABLE_FEM_GPU": "OFF",
        "FULLMAG_USE_MFEM_STACK": "ON",
        "FULLMAG_FEM_WITH_SLEPC": "ON",
    }.items():
        if (
            not isinstance(cache_options.get(name), dict)
            or str(cache_options[name].get("value", "")).upper() != value
        ):
            raise BenchmarkError("SLEPc modal CMake cache attestation mismatch")
    runtime = attestation.get("runtime")
    availability = runtime.get("availability") if isinstance(runtime, dict) else None
    if (
        not isinstance(runtime, dict)
        or runtime.get("status") != "pass"
        or not isinstance(availability, dict)
        or availability.get("native_fem_cpu_available") is not True
        or "source snapshot:" not in str(runtime.get("startup_stamp", ""))
    ):
        raise BenchmarkError("SLEPc modal runtime attestation does not prove native CPU")
    dependency = attestation.get("dependency")
    dependency_values = dependency.get("dependency") if isinstance(dependency, dict) else None
    if (
        not isinstance(dependency, dict)
        or dependency.get("status") != "pass"
        or not isinstance(dependency_values, dict)
        or dependency_values.get("petsc_available") is not True
        or dependency_values.get("slepc_available") is not True
        or dependency_values.get("modal_eigen_native_cpu_slepc_available") is not True
        or not dependency_values.get("petsc_version")
        or not dependency_values.get("slepc_version")
    ):
        raise BenchmarkError("SLEPc modal dependency attestation is incomplete")
    resolution = attestation.get("resolution")
    precision = resolution.get("precision") if isinstance(resolution, dict) else None
    if (
        not isinstance(resolution, dict)
        or resolution.get("status") != "pass"
        or resolution.get("resolved") != expected_resolved
        or not isinstance(precision, dict)
        or precision.get("value") != "double"
        or "PETSC_USE_REAL_DOUBLE" not in str(precision.get("basis", ""))
        or "sizeof(PetscReal)" not in str(precision.get("basis", ""))
    ):
        raise BenchmarkError("SLEPc modal precision/resolution attestation is incomplete")
    return contract


def _validate_build_context(layout: Mapping[str, Any], job: Mapping[str, Any]) -> BuildContext:
    storage = Path(layout["storage_root"])
    payload = job["payload"]
    capsule = _contained_path(storage, payload["capsule_relative"], "source capsule")
    _regular_dir(capsule, "source capsule")
    try:
        manifest = verify_source(capsule, job["source_digest"])
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise BenchmarkError("source capsule verification failed") from error
    native_identity = payload["native_source_identity"]
    if not isinstance(manifest.get("repo_root"), str) or not _same_path(
        manifest["repo_root"], layout["repo_root"]
    ):
        raise BenchmarkError("source capsule origin differs from this worktree")
    if manifest.get("resolved_commit") != native_identity.get("head_commit_full"):
        raise BenchmarkError("source capsule commit differs from native build identity")
    try:
        bind_identity(native_identity, manifest)
    except (ValueError, KeyError, TypeError) as error:
        raise BenchmarkError("source capsule is not bound to the native build identity") from error
    manifest_files = {
        entry.get("path") for entry in manifest.get("files", []) if isinstance(entry, dict)
    }
    missing = [relative for relative in PUBLIC_MODEL_FILES if relative not in manifest_files]
    if missing:
        raise BenchmarkError(
            "benchmark model is absent from the immutable source capsule; resubmit with "
            f"--include-untracked tests/standard_problems/mumag/comsol_nonzero_k_dispersion ({missing[0]})"
        )
    source_tree = _contained_path(capsule, "tree", "source tree")
    _regular_dir(source_tree, "source tree")

    run_root = _contained_path(storage, f"runs/{job['worktree_id']}/{job['job_id']}", "build run")
    _regular_dir(run_root, "build run")
    artifacts = _contained_path(run_root, "artifacts", "build artifacts")
    _regular_dir(artifacts, "build artifacts")
    receipt_path = _contained_path(artifacts, "build-receipt.json", "build receipt")
    receipt = _json_file(receipt_path, "build receipt", max_bytes=4 * 1024 * 1024)
    if receipt.get("schema") != RECEIPT_SCHEMA:
        raise BenchmarkError("build receipt schema mismatch")
    try:
        # Reuse the canonical receipt verifier so every artifact record is
        # checked before any runtime bind is constructed.
        validate_build_receipt(
            artifacts,
            job,
            {"image_digest": EXPECTED_IMAGE_DIGEST},
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise BenchmarkError("managed build receipt verification failed") from error
    if receipt.get("image_digest") != EXPECTED_IMAGE_DIGEST:
        raise BenchmarkError("build receipt image digest is not the pinned modal image")
    if receipt.get("qualification") != "NOT VERIFIED" or receipt.get("state") != "succeeded":
        raise BenchmarkError("build receipt is not a completed unqualified build")
    if receipt.get("source_digest") != job["source_digest"]:
        raise BenchmarkError("build receipt source digest differs from runner job")
    if receipt.get("native_source_identity") != native_identity:
        raise BenchmarkError("build receipt native source identity differs from runner job")
    if receipt.get("native_source_identity_sha256") != hashlib.sha256(
        canonical(native_identity)
    ).hexdigest():
        raise BenchmarkError("build receipt native source identity hash is invalid")

    entries = receipt.get("artifacts")
    if not isinstance(entries, list):
        raise BenchmarkError("build receipt artifact records are missing")
    entry_paths = {
        entry.get("path") for entry in entries if isinstance(entry, dict)
    }
    missing_runtime = [relative for relative in REQUIRED_RUNTIME_ARTIFACTS if relative not in entry_paths]
    if missing_runtime:
        raise BenchmarkError(f"modal runtime artifact is missing: {missing_runtime[0]}")
    identity_path = _contained_path(artifacts, "source-identity.json", "source identity artifact")
    if _json_file(identity_path, "source identity artifact") != native_identity:
        raise BenchmarkError("source identity artifact differs from runner job")
    runtime_root = _contained_path(artifacts, "outputs/.fullmag/local", "modal runtime")
    _regular_dir(runtime_root, "modal runtime")
    for relative in (
        "bin/fullmag-bin",
        "bin/fullmag-api",
        "_fullmag_core.so",
        "launcher-build-mode",
    ):
        _regular_file(runtime_root.joinpath(*relative.split("/")), "modal runtime artifact")
    marker = runtime_root / "launcher-build-mode"
    if marker.read_text(encoding="utf-8").strip() != "fem-cpu":
        raise BenchmarkError("modal runtime launcher marker is not fem-cpu")
    lib_dir = runtime_root / "lib"
    _regular_dir(lib_dir, "modal runtime library directory")
    fem_libraries = tuple(
        path
        for path in lib_dir.iterdir()
        if path.name.startswith("libfullmag_fem.so") and path.is_file() and not _is_reparse(path)
    )
    if not fem_libraries:
        raise BenchmarkError("modal runtime has no regular libfullmag_fem.so library")
    evidence = _validated_build_evidence(artifacts, job["profile"], native_identity)
    # Keep a compact immutable identity view for the run manifest.  The full
    # receipt remains in the build run and is never copied or rewritten.
    receipt_artifact_hashes = {
        entry["path"]: {"size": entry["size"], "sha256": entry["sha256"]}
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    return BuildContext(
        layout=layout,
        job=job,
        manifest=manifest,
        native_identity=native_identity,
        receipt={
            **receipt,
            "contract_source": evidence["source"],
            "build_evidence_kind": evidence["kind"],
            "artifact_hashes": receipt_artifact_hashes,
        },
        run_root=run_root,
        artifacts=artifacts,
        capsule=capsule,
        source_tree=source_tree,
        runtime_root=runtime_root,
    )


def _inspect_image(
    image_digest: str,
    *,
    run: Any = subprocess.run,
) -> dict[str, Any]:
    if not IMAGE_RE.fullmatch(image_digest):
        raise BenchmarkError("benchmark image identity is not an immutable digest")
    try:
        completed = run(
            ["docker", "image", "inspect", image_digest],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        raise BenchmarkError("Docker image inspection could not start") from error
    if completed.returncode != 0:
        raise BenchmarkError("pinned FEM modal image is not available locally")
    try:
        inspected = json.loads(completed.stdout)
    except (TypeError, ValueError) as error:
        raise BenchmarkError("Docker image inspection returned invalid JSON") from error
    if (
        not isinstance(inspected, list)
        or len(inspected) != 1
        or not isinstance(inspected[0], dict)
        or inspected[0].get("Id") != image_digest
        or inspected[0].get("Config", {}).get("Volumes")
    ):
        raise BenchmarkError("pinned FEM modal image identity/volume contract mismatch")
    return {
        "id": inspected[0]["Id"],
        "repo_tags": inspected[0].get("RepoTags", []),
        "repo_digests": inspected[0].get("RepoDigests", []),
    }


def _shell_case_command(cases: Sequence[str]) -> str:
    """Build the fixed container command; case values are allow-listed."""

    if not cases or any(case not in CASES for case in cases):
        raise BenchmarkError("benchmark cases must be selected from c0, c1, a1")
    lines = [
        "set -eu",
        "runtime_bin=/workspace/.fullmag/local/bin/fullmag-bin",
        "source_script=/workspace/capsule/tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py",
        "pythonpath=/workspace/capsule/packages/fullmag-py/src:/workspace/.fullmag/local",
        'test -x "$runtime_bin"',
        'test -f "$source_script"',
    ]
    for case in cases:
        quoted_case = shlex.quote(case)
        lines.extend(
            [
                f"case_dir=/workspace/benchmark-output/{case}",
                'mkdir "$case_dir"',
                f"FULLMAG_COMSOL_DISPERSION_CASE={quoted_case} \\",
                "FULLMAG_API_PORT=0 \\",
                "FULLMAG_DISABLE_PREVIEW_3D=1 \\",
                "FULLMAG_DISABLE_CHARTS=1 \\",
                "FULLMAG_FEM_EXECUTION=cpu \\",
                "FULLMAG_FEM_MFEM_DEVICE=cpu \\",
                "FULLMAG_FEM_WITH_SLEPC=ON \\",
                "FULLMAG_USE_MFEM_STACK=ON \\",
                "FULLMAG_FEM_REQUIRE_CEED=1 \\",
                "FULLMAG_FEM_REQUIRE_GPU=0 \\",
                "FULLMAG_PYTHON=/usr/local/bin/python3 \\",
                'PYTHONPATH="$pythonpath" \\',
                'LD_LIBRARY_PATH=/workspace/.fullmag/local/lib:/usr/local/cuda/compat:/opt/fullmag-deps/lib \\',
                '"$runtime_bin" "$source_script" --backend fem --mode strict --precision double --headless --json --output-dir "$case_dir" >"$case_dir/runtime.log" 2>&1',
            ]
        )
    return "\n".join(lines) + "\n"


def _container_identity(context: BuildContext, output_dir: Path) -> dict[str, Any]:
    """Return the immutable identity used for one Compose benchmark container.

    The output directory is allocated before Compose is invoked and is rejected
    when it already exists. Hashing its absolute path therefore gives this run
    a collision-resistant, Docker-safe identity without putting host paths into
    labels or names.
    """

    job_id = context.job.get("job_id")
    if not isinstance(job_id, str) or not JOB_ID_RE.fullmatch(job_id):
        raise BenchmarkError("benchmark container identity has an invalid job id")
    output_path = os.path.abspath(str(output_dir))
    run_id = hashlib.sha256(
        f"{job_id}\0{output_path}".encode("utf-8", errors="strict")
    ).hexdigest()[:32]
    return {
        "name": f"fullmag-dispersion-{run_id}",
        "labels": {
            CONTAINER_LABEL_COMPONENT: CONTAINER_COMPONENT,
            CONTAINER_LABEL_JOB: job_id,
            CONTAINER_LABEL_RUN: run_id,
        },
        "run_id": run_id,
    }


def _expected_container_mounts(
    context: BuildContext, output_dir: Path
) -> tuple[dict[str, Any], ...]:
    return (
        {
            "source": os.path.abspath(str(context.source_tree)),
            "destination": "/workspace/capsule",
            "read_only": True,
        },
        {
            "source": os.path.abspath(str(context.runtime_root)),
            "destination": "/workspace/.fullmag/local",
            "read_only": True,
        },
        {
            "source": os.path.abspath(str(output_dir)),
            "destination": "/workspace/benchmark-output",
            "read_only": False,
        },
    )


def _normalized_mount_source(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    normalized = value.replace("\\", "/").rstrip("/")
    # Keep the separator representation canonical after Windows path
    # normalization.  ntpath.normcase() lowercases and changes `/` back to
    # `\\`, which would make the `/host_mnt/<drive>/...` projection below
    # impossible to recognize.
    return normalized.casefold() if os.name == "nt" else normalized


def _mount_source_matches(actual: object, expected: str) -> bool:
    actual_normalized = _normalized_mount_source(actual)
    expected_normalized = _normalized_mount_source(expected)
    if actual_normalized is None or expected_normalized is None:
        return False
    if actual_normalized == expected_normalized:
        return True
    # Docker Desktop may expose a Windows bind source through its Linux VM.
    # Accept only the canonical /host_mnt/<drive>/ projection of the exact
    # expected host path; all other representations remain blocked.
    if os.name == "nt" and len(expected_normalized) >= 3 and expected_normalized[1:3] == ":/":
        drive = expected_normalized[0].lower()
        projected = f"/host_mnt/{drive}{expected_normalized[2:]}"
        return actual_normalized == projected
    return False


def _inspect_benchmark_container(
    identity: Mapping[str, Any],
    expected_mounts: Sequence[Mapping[str, Any]],
    *,
    run: Any = subprocess.run,
) -> dict[str, Any]:
    """Inspect one exact container and fail closed on identity uncertainty."""

    name = identity.get("name")
    labels = identity.get("labels")
    if (
        not isinstance(name, str)
        or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,127}", name)
        or not isinstance(labels, Mapping)
    ):
        return {"status": "blocked", "reason": "invalid benchmark container identity"}
    try:
        completed = run(
            ["docker", "container", "inspect", name],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_LIFECYCLE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return {"status": "blocked", "reason": "container inspect timed out"}
    except OSError as error:
        return {"status": "blocked", "reason": f"container inspect failed: {error}"}
    if completed.returncode != 0:
        diagnostic = str(getattr(completed, "stderr", "") or "").lower()
        if "no such object" in diagnostic or "no such container" in diagnostic:
            return {"status": "absent", "verified": True}
        return {
            "status": "blocked",
            "reason": "container inspect returned a non-terminal Docker error",
        }
    try:
        payload = json.loads(completed.stdout)
    except (TypeError, ValueError):
        return {"status": "blocked", "reason": "container inspect returned invalid JSON"}
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], Mapping):
        return {"status": "blocked", "reason": "container inspect returned an ambiguous object"}
    inspected = payload[0]
    container_id = inspected.get("Id")
    if not isinstance(container_id, str) or not CONTAINER_ID_RE.fullmatch(container_id):
        return {"status": "blocked", "reason": "container inspect did not return a full ID"}
    if inspected.get("Name") != f"/{name}":
        return {"status": "blocked", "reason": "container name identity mismatch"}
    config = inspected.get("Config")
    actual_labels = config.get("Labels") if isinstance(config, Mapping) else None
    if not isinstance(actual_labels, Mapping) or any(
        actual_labels.get(key) != value for key, value in labels.items()
    ):
        return {"status": "blocked", "reason": "container labels identity mismatch"}
    image = inspected.get("Image")
    configured_image = config.get("Image") if isinstance(config, Mapping) else None
    if EXPECTED_IMAGE_DIGEST not in {image, configured_image}:
        return {"status": "blocked", "reason": "container image identity mismatch"}
    mounts = inspected.get("Mounts")
    if not isinstance(mounts, list) or len(mounts) != len(expected_mounts):
        return {"status": "blocked", "reason": "container mount set is not exact"}
    actual_by_destination: dict[str, Mapping[str, Any]] = {}
    for mount in mounts:
        if not isinstance(mount, Mapping):
            return {"status": "blocked", "reason": "container mount entry is invalid"}
        destination = mount.get("Destination")
        if not isinstance(destination, str) or destination in actual_by_destination:
            return {"status": "blocked", "reason": "container mount destinations are ambiguous"}
        actual_by_destination[destination] = mount
    for expected in expected_mounts:
        destination = expected.get("destination")
        actual = actual_by_destination.get(destination)
        if actual is None:
            return {"status": "blocked", "reason": f"container mount is missing: {destination}"}
        if not _mount_source_matches(actual.get("Source"), str(expected.get("source"))):
            return {"status": "blocked", "reason": f"container mount source mismatch: {destination}"}
        if actual.get("RW") != (not bool(expected.get("read_only"))):
            return {"status": "blocked", "reason": f"container mount mode mismatch: {destination}"}
    return {"status": "owned", "container_id": container_id, "inspect": dict(inspected)}


def _cleanup_benchmark_container(
    context: BuildContext,
    output_dir: Path,
    *,
    run: Any = subprocess.run,
) -> dict[str, Any]:
    """Stop and remove only a fully attested container for this run."""

    identity = _container_identity(context, output_dir)
    expected_mounts = _expected_container_mounts(context, output_dir)
    inspected = _inspect_benchmark_container(identity, expected_mounts, run=run)
    if inspected.get("status") == "absent":
        return {"status": "verified_absent", "container_name": identity["name"]}
    if inspected.get("status") != "owned":
        return {
            "status": "blocked",
            "container_name": identity["name"],
            "reason": inspected.get("reason", "container ownership could not be verified"),
        }
    container_id = inspected["container_id"]
    current = inspected["inspect"]
    state = current.get("State") if isinstance(current, Mapping) else None
    if not isinstance(state, Mapping):
        return {"status": "blocked", "container_name": identity["name"], "reason": "container state is missing"}
    try:
        if state.get("Running") is True:
            stopped = run(
                ["docker", "container", "stop", "--time", "10", container_id],
                capture_output=True,
                text=True,
                check=False,
                timeout=DOCKER_LIFECYCLE_TIMEOUT_SECONDS,
            )
            if stopped.returncode != 0:
                return {
                    "status": "blocked",
                    "container_name": identity["name"],
                    "container_id": container_id,
                    "reason": "owned container stop failed",
                }
            inspected = _inspect_benchmark_container(identity, expected_mounts, run=run)
            if inspected.get("status") != "owned":
                return {
                    "status": "blocked",
                    "container_name": identity["name"],
                    "container_id": container_id,
                    "reason": "container identity could not be reverified after stop",
                }
            state = inspected["inspect"].get("State", {})
            if not isinstance(state, Mapping) or state.get("Running") is not False:
                return {
                    "status": "blocked",
                    "container_name": identity["name"],
                    "container_id": container_id,
                    "reason": "owned container did not reach exited state",
                }
        removed = run(
            ["docker", "container", "rm", container_id],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_LIFECYCLE_TIMEOUT_SECONDS,
        )
        if removed.returncode != 0:
            final = _inspect_benchmark_container(identity, expected_mounts, run=run)
            if final.get("status") == "absent":
                return {"status": "verified_absent", "container_name": identity["name"]}
            return {
                "status": "blocked",
                "container_name": identity["name"],
                "container_id": container_id,
                "reason": "owned container removal failed",
            }
    except (subprocess.TimeoutExpired, OSError) as error:
        return {
            "status": "blocked",
            "container_name": identity["name"],
            "container_id": container_id,
            "reason": f"container cleanup failed: {error}",
        }
    final = _inspect_benchmark_container(identity, expected_mounts, run=run)
    if final.get("status") != "absent":
        return {
            "status": "blocked",
            "container_name": identity["name"],
            "container_id": container_id,
            "reason": "container removal was not verified",
        }
    return {
        "status": "removed",
        "verified": True,
        "container_name": identity["name"],
        "container_id": container_id,
    }


def _compose_command(
    context: BuildContext,
    output_dir: Path,
    cases: Sequence[str],
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> list[str]:
    if not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 7 * 24 * 60 * 60:
        raise BenchmarkError("benchmark timeout must be between 1 and 604800 seconds")
    # The modal benchmark is a closed, file-backed computation.  It does not
    # need service-to-service networking, and creating Compose's project
    # bridge is fragile on long-lived Docker Desktop hosts whose address pool
    # is exhausted.  Reset the service's inherited development mounts as well:
    # on Windows the base target `${FULLMAG_FRONTEND_ROOT}` would otherwise be
    # interpolated as a second drive-qualified host path.  The command below
    # supplies the three exact benchmark mounts explicitly.
    override_path = output_dir / "compose.benchmark.override.yaml"
    if output_dir.is_dir():
        override_path.write_text(
            "services:\n"
            "  fem-modal-cpu:\n"
            "    network_mode: none\n"
            "    volumes: !reset []\n",
            encoding="utf-8",
            newline="\n",
        )
    compose_file = context.source_tree / "compose.yaml"
    command = [
        "docker",
        "compose",
        "-f",
        str(compose_file),
        "-f",
        str(override_path),
        "--profile",
        "fem-modal-cpu",
        "run",
        "--rm",
        "--no-deps",
        "--pull",
        "never",
        "-T",
        "-w",
        "/workspace/capsule",
        "-v",
        f"{context.source_tree}:/workspace/capsule:ro",
        "-v",
        f"{context.runtime_root}:/workspace/.fullmag/local:ro",
        "-v",
        f"{output_dir}:/workspace/benchmark-output:rw",
    ]
    for key, value in (
        ("FULLMAG_FEM_GPU_IMAGE", EXPECTED_IMAGE_DIGEST),
        ("FULLMAG_FEM_EXECUTION", "cpu"),
        ("FULLMAG_FEM_MFEM_DEVICE", "cpu"),
        ("FULLMAG_FEM_WITH_SLEPC", "ON"),
        ("FULLMAG_USE_MFEM_STACK", "ON"),
        ("FULLMAG_FEM_REQUIRE_CEED", "1"),
        ("FULLMAG_FEM_REQUIRE_GPU", "0"),
        ("FULLMAG_API_PORT", "0"),
        ("FULLMAG_DISABLE_PREVIEW_3D", "1"),
        ("FULLMAG_DISABLE_CHARTS", "1"),
        ("FULLMAG_STATE_ROOT", "/workspace/benchmark-output/state"),
        ("FULLMAG_PYTHON", "/usr/local/bin/python3"),
        ("PYTHONPATH", "/workspace/capsule/packages/fullmag-py/src:/workspace/.fullmag/local"),
        ("LD_LIBRARY_PATH", "/workspace/.fullmag/local/lib:/usr/local/cuda/compat:/opt/fullmag-deps/lib"),
        ("FULLMAG_REPO_ROOT", "/workspace/capsule"),
    ):
        command.extend(("-e", f"{key}={value}"))
    identity = _container_identity(context, output_dir)
    command.extend(("--name", identity["name"]))
    for key, value in sorted(identity["labels"].items()):
        command.extend(("--label", f"{key}={value}"))
    # The inner watchdog owns the solver deadline.  The host watchdog below is
    # only a second fence for a wedged Docker/Compose client and includes enough
    # grace for TERM, container exit and Compose's --rm bookkeeping.
    container_timeout = str(math.ceil(timeout_seconds))
    command.extend(
        (
            "fem-modal-cpu",
            "timeout",
            "--foreground",
            "--signal=TERM",
            f"--kill-after={CONTAINER_TIMEOUT_GRACE_SECONDS}s",
            container_timeout,
            "bash",
            "-lc",
            _shell_case_command(cases),
        )
    )
    # The image is supplied through the host environment as well as -e: the
    # former selects the Compose service image, while the latter records the
    # requested runtime setting inside the container.
    return command


def _compose_environment(layout: Mapping[str, Any]) -> dict[str, str]:
    environment = dict(os.environ)
    environment.update({str(key): str(value) for key, value in layout["env"].items()})
    if os.name == "nt":
        # Keep explicit `C:\\...:/container/path` bind mounts unambiguous in
        # Docker Compose's Windows path conversion layer.
        environment["COMPOSE_CONVERT_WINDOWS_PATHS"] = "1"
    environment["FULLMAG_FEM_GPU_IMAGE"] = EXPECTED_IMAGE_DIGEST
    environment["FULLMAG_FEM_EXECUTION"] = "cpu"
    environment["FULLMAG_FEM_MFEM_DEVICE"] = "cpu"
    environment["FULLMAG_FEM_WITH_SLEPC"] = "ON"
    environment["FULLMAG_USE_MFEM_STACK"] = "ON"
    environment["FULLMAG_FEM_REQUIRE_CEED"] = "1"
    environment["FULLMAG_FEM_REQUIRE_GPU"] = "0"
    return environment


def _new_output_dir(
    context: BuildContext,
    requested: str | None,
) -> Path:
    storage = Path(context.layout["storage_root"])
    if requested is not None:
        candidate = Path(requested).expanduser()
        if not candidate.is_absolute():
            candidate = Path(context.layout["repo_root"]) / candidate
        try:
            candidate = fullmag_storage.validate_path(candidate, storage, "benchmark output")
        except (fullmag_storage.StorageError, OSError, ValueError) as error:
            raise BenchmarkError("benchmark output must be inside canonical storage") from error
        if candidate.exists() or _is_reparse(candidate):
            raise BenchmarkError(f"benchmark output already exists: {candidate}")
        candidate.parent.mkdir(parents=True, exist_ok=True)
        return candidate
    parent = _contained_path(
        storage,
        f"runs/{context.job['worktree_id']}/{context.job['job_id']}/comsol-dispersion",
        "benchmark run root",
    )
    if parent.exists() and _is_reparse(parent):
        raise BenchmarkError("benchmark run root is a reparse point")
    parent.mkdir(parents=True, exist_ok=True)
    for _ in range(8):
        candidate = parent / uuid.uuid4().hex
        if not candidate.exists() and not _is_reparse(candidate):
            return candidate
    raise BenchmarkError("could not allocate a unique benchmark output directory")


def _write_new_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise BenchmarkError(f"refusing to replace existing benchmark receipt: {path}") from error


def _stage_external_scientific_evidence(
    case_dir: Path,
    case: str,
    evidence_root: Path,
    artifact_bindings: Mapping[str, str],
) -> dict[str, Any]:
    """Stage an operator-supplied evidence bundle without weakening binding.

    The source layout is ``<evidence-root>/<case>/validation/scientific_gate.v1.json``
    plus the comparison artifacts referenced by relative paths in that JSON.
    Files are copied into the new run at the same relative paths, so the
    existing scientific validator can hash-bind every comparison artifact to
    the staged bundle.  Primary numeric artifacts are never overwritten.
    """
    root = _regular_dir(evidence_root, "scientific evidence root")
    source_case = _regular_dir(root / case, f"scientific evidence case {case}")
    source_evidence_path = source_case / EVIDENCE_RELATIVE_PATH
    supplied = _json_file(
        source_evidence_path,
        f"external {case} scientific evidence",
        max_bytes=16 * 1024 * 1024,
    )
    if supplied.get("schema_version") != EVIDENCE_SCHEMA:
        raise BenchmarkError(f"external {case} evidence has an unsupported schema_version")
    if supplied.get("case_id") != case:
        raise BenchmarkError(f"external {case} evidence case_id does not match its directory")
    supplied_bindings = supplied.get("artifact_bindings")
    if not isinstance(supplied_bindings, Mapping):
        raise BenchmarkError(f"external {case} evidence is missing artifact_bindings")
    for key, expected in artifact_bindings.items():
        if supplied_bindings.get(key) != expected:
            raise BenchmarkError(
                f"external {case} evidence binding does not match the current {key} artifact"
            )
    if not isinstance(supplied.get("analytic_controls"), Mapping):
        raise BenchmarkError(f"external {case} evidence is missing analytic_controls")
    if not isinstance(supplied.get("convergence"), Mapping):
        raise BenchmarkError(f"external {case} evidence is missing convergence controls")

    copied_files = 0
    copied_bytes = 0
    for source in source_case.rglob("*"):
        if _is_reparse(source):
            raise BenchmarkError(f"external {case} evidence contains a reparse point: {source}")
        if not source.is_file():
            continue
        relative = source.relative_to(source_case)
        if relative.as_posix() == EVIDENCE_RELATIVE_PATH.as_posix():
            continue
        size = source.stat().st_size
        copied_files += 1
        copied_bytes += size
        if copied_files > MAX_EXTERNAL_EVIDENCE_FILES:
            raise BenchmarkError(f"external {case} evidence contains too many files")
        if copied_bytes > MAX_EXTERNAL_EVIDENCE_BYTES:
            raise BenchmarkError(f"external {case} evidence is oversized")
        destination = _contained_path(
            case_dir,
            relative.as_posix(),
            f"external {case} evidence destination",
        )
        if destination.exists() or _is_reparse(destination):
            raise BenchmarkError(
                f"external {case} evidence would overwrite an existing primary artifact: {relative.as_posix()}"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)

    result = dict(supplied)
    result["artifact_bindings"] = dict(artifact_bindings)
    result["evidence_provenance"] = {
        "source": "operator_supplied",
        "source_sha256": _sha256_file(source_evidence_path),
        "staged_relative_root": "case_output_root",
        "copied_file_count": copied_files,
        "copied_byte_count": copied_bytes,
    }
    return result


def _run_request(
    context: BuildContext,
    output_dir: Path,
    cases: Sequence[str],
    command: Sequence[str],
    scientific_evidence_root: Path | None = None,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    identity = _container_identity(context, output_dir)
    script_path = Path(context.source_tree) / "scripts" / "run_comsol_dispersion_benchmark.py"
    return {
        "schema": RUN_REQUEST_SCHEMA,
        "status": "prepared",
        "qualification": "NOT VERIFIED",
        "created_at_unix": time.time(),
        "operation": "comsol-dispersion-benchmark",
        "cases": list(cases),
        "public_model": "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py",
        "job": {
            "job_id": context.job["job_id"],
            "worktree_id": context.job["worktree_id"],
            "profile": context.job["profile"],
            "source_digest": context.job["source_digest"],
        },
        "source": {
            "capsule_relative": context.job["payload"]["capsule_relative"],
            "resolved_commit": context.manifest["resolved_commit"],
            "source_snapshot_sha256": context.native_identity["source_snapshot_sha256"],
            "public_model_files": list(PUBLIC_MODEL_FILES),
        },
        "runtime": {
            "image_digest": EXPECTED_IMAGE_DIGEST,
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "slepc": True,
            "artifact_root": "build-run/artifacts/outputs/.fullmag/local",
        },
        "scientific_gate": {
            "schema": SCIENTIFIC_GATE_SCHEMA,
            "evidence_relative_path": "validation/scientific_gate.v1.json",
            "missing_evidence_policy": "NOT VERIFIED",
            "external_bundle": scientific_evidence_root is not None,
        },
        "lifecycle": {
            "container_name": identity["name"],
            "container_labels": dict(identity["labels"]),
            "container_timeout_seconds": math.ceil(timeout_seconds),
            "host_timeout_seconds": math.ceil(
                timeout_seconds
                + CONTAINER_TIMEOUT_GRACE_SECONDS
                + HOST_COMPOSE_GRACE_SECONDS
            ),
            "cleanup_policy": "exact-id-after-identity-and-mount-attestation",
        },
        "output_dir": str(output_dir),
        "orchestrator_sha256": _sha256_file(Path(__file__).resolve()),
        "compose_command": list(command),
        "artifact_hashes": context.receipt["artifact_hashes"],
    }


def _validate_case_artifacts(case_dir: Path, case: str) -> dict[str, Any]:
    _regular_dir(case_dir, f"benchmark case output {case}")
    required_hashes: dict[str, dict[str, Any]] = {}
    for relative in REQUIRED_CASE_ARTIFACTS:
        artifact = case_dir.joinpath(*relative.split("/"))
        _regular_file(artifact, f"benchmark case artifact {case}/{relative}")
        if artifact.stat().st_size == 0:
            raise BenchmarkError(f"benchmark case artifact is empty: {case}/{relative}")
        required_hashes[relative] = {
            "size": artifact.stat().st_size,
            "sha256": _sha256_file(artifact),
        }
    spectrum = _json_file(case_dir / "eigen/spectrum.v2.json", f"{case} spectrum")
    branches = _json_file(case_dir / "eigen/branches.v2.json", f"{case} branches")
    _json_file(
        case_dir / "eigen/metadata/eigen_summary.json",
        f"{case} eigen summary",
        max_bytes=MAX_EIGEN_SUMMARY_BYTES,
    )
    _json_file(case_dir / "frequency_domain/manifest.v1.json", f"{case} frequency-domain manifest")
    if spectrum.get("schema_version") != "eigen_spectrum.v2":
        raise BenchmarkError(f"{case} spectrum schema is invalid")
    if branches.get("schema_version") != "eigen_branches.v2":
        raise BenchmarkError(f"{case} branches schema is invalid")
    dispersion = case_dir / "eigen/dispersion.csv"
    with dispersion.open("r", encoding="utf-8-sig", newline="") as stream:
        header = stream.readline().strip().split(",")
        rows = sum(1 for _ in stream)
    required_columns = {"kx_rad_per_m", "ky_rad_per_m", "frequency_hz"}
    if not required_columns.issubset(header) or rows < 1:
        raise BenchmarkError(f"{case} dispersion CSV has no usable mode rows")
    mode_vectors = tuple(case_dir.glob("eigen/mode_fields/sample_*/mode_*/vector.bin"))
    if not mode_vectors or any(_is_reparse(path) or not path.is_file() or path.stat().st_size == 0 for path in mode_vectors):
        raise BenchmarkError(f"{case} has no complete complex mode field payload")
    potential_files = tuple(case_dir.glob("eigen/mode_fields/sample_*/mode_*/potential_full.bin"))
    potential_manifests = tuple(case_dir.glob("eigen/mode_fields/sample_*/mode_*/physical_potential.v1.json"))
    if case in {"c1", "a1"} and (
        not potential_files
        or not potential_manifests
        or any(_is_reparse(path) or not path.is_file() or path.stat().st_size == 0 for path in potential_files)
    ):
        raise BenchmarkError(f"{case} has no full physical scalar-potential payload")
    return {
        "case": case,
        "required_artifacts": list(REQUIRED_CASE_ARTIFACTS),
        "required_artifact_hashes": required_hashes,
        "dispersion_rows": rows,
        "mode_field_count": len(mode_vectors),
        "physical_potential_count": len(potential_files),
    }


def _write_scientific_evidence(
    case_dir: Path,
    case: str,
    artifact_result: Mapping[str, Any],
    scientific_evidence_root: Path | None = None,
) -> None:
    """Bind the primary numeric artifacts without inventing missing science.

    The runner can prove artifact identity and native execution here.  Mesh,
    airbox, mode-count and Kalinikos–Slavin controls require separate managed
    runs, so they are recorded as pending until those bundles are supplied;
    the scientific gate remains fail-closed in the meantime.
    """
    manifest = _json_file(
        case_dir / "frequency_domain/manifest.v1.json",
        f"{case} frequency-domain manifest",
    )
    diagnostics = _json_file(
        case_dir / "eigen/diagnostics/solver.v1.json",
        f"{case} solver diagnostics",
    )
    validation = manifest.get("validation")
    validation = validation if isinstance(validation, Mapping) else {}
    solver_model = diagnostics.get("solver_model")
    production_attested = (
        diagnostics.get("production_native_solver_available") is True
        and diagnostics.get("validation_only") is not True
        and isinstance(manifest.get("resolved_execution"), Mapping)
        and manifest["resolved_execution"].get("reference_or_production") == "production"
    )
    frequency_source = validation.get("dispersion_frequency_source")
    if frequency_source is None and production_attested:
        frequency_source = "native_solver_attested"
    dynamic_source = validation.get("dynamic_demag_operator_source")
    hashes = artifact_result.get("required_artifact_hashes")
    if not isinstance(hashes, Mapping):
        raise BenchmarkError(f"{case} artifact hash map is missing")
    required_bindings = {
        "metadata.json": "metadata_sha256",
        "eigen/spectrum.v2.json": "spectrum_v2_sha256",
        "eigen/branches.v2.json": "branches_v2_sha256",
        "eigen/dispersion.csv": "dispersion_csv_sha256",
        "frequency_domain/manifest.v1.json": "manifest_sha256",
        "eigen/diagnostics/solver.v1.json": "solver_diagnostics_sha256",
    }
    artifact_bindings: dict[str, str] = {}
    for relative, binding_key in required_bindings.items():
        record = hashes.get(relative)
        if not isinstance(record, Mapping) or not isinstance(record.get("sha256"), str):
            raise BenchmarkError(f"{case} artifact hash is missing for {relative}")
        artifact_bindings[binding_key] = record["sha256"]
    pending_reason = (
        "separate managed comparison bundles are required; the primary run "
        "must not be reused as convergence evidence"
    )
    evidence = {
        "schema_version": EVIDENCE_SCHEMA,
        "case_id": case,
        "numeric_run": {
            "frequency_source": frequency_source,
            "solver_model": solver_model,
            "analytic_solver_used_for_frequencies": (
                False
                if frequency_source
                in {"native_solver_attested", "numeric_modal_solver_with_analytic_comparison"}
                else None
            ),
            "dynamic_demag_operator_source": dynamic_source,
        },
        "artifact_bindings": artifact_bindings,
        "analytic_controls": {},
        "convergence": {
            "mesh": {"status": "pending", "reason": pending_reason},
            "airbox": (
                {
                    "status": "not_applicable",
                    "reason": "C0 disables dynamic demagnetization by construction",
                }
                if case == "c0"
                else {"status": "pending", "reason": pending_reason}
            ),
            "mode_count": {"status": "pending", "reason": pending_reason},
        },
    }
    if scientific_evidence_root is not None:
        external = _stage_external_scientific_evidence(
            case_dir,
            case,
            scientific_evidence_root,
            artifact_bindings,
        )
        # The external package supplies only independently produced controls
        # and comparison runs.  Keep the current run's numeric identity as the
        # binding authority, after the strict equality checks above.
        evidence.update(external)
        evidence["artifact_bindings"] = artifact_bindings
    _write_new_json(case_dir / EVIDENCE_RELATIVE_PATH, evidence)


def _execute(
    context: BuildContext,
    output_dir: Path,
    cases: Sequence[str],
    command: Sequence[str],
    *,
    timeout_seconds: float,
    scientific_evidence_root: Path | None = None,
) -> int:
    request = _run_request(
        context,
        output_dir,
        cases,
        command,
        scientific_evidence_root,
        timeout_seconds=timeout_seconds,
    )
    _write_new_json(output_dir / "run-request.json", request)
    compose_log = output_dir / "compose.log"
    started = time.time()
    return_code: int | None = None
    timed_out = False
    interrupted = False
    execution_error: str | None = None
    container_timed_out = False
    host_timeout_seconds = (
        math.ceil(timeout_seconds)
        + CONTAINER_TIMEOUT_GRACE_SECONDS
        + HOST_COMPOSE_GRACE_SECONDS
    )
    try:
        with compose_log.open("x", encoding="utf-8", newline="") as stream:
            process = subprocess.run(
                list(command),
                cwd=context.layout["repo_root"],
                env=_compose_environment(context.layout),
                stdin=subprocess.DEVNULL,
                stdout=stream,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=host_timeout_seconds,
                text=True,
            )
            return_code = process.returncode
            container_timed_out = return_code == 124
    except subprocess.TimeoutExpired:
        timed_out = True
        execution_error = "host Compose watchdog expired after the container deadline and grace period"
    except KeyboardInterrupt:
        interrupted = True
        execution_error = "benchmark interrupted by operator"
    except OSError as error:
        execution_error = f"managed Compose benchmark could not start: {error}"

    cleanup: dict[str, Any] = {"status": "not_requested"}
    needs_cleanup = (
        timed_out
        or interrupted
        or execution_error is not None
        or (return_code is not None and return_code != 0)
    )
    if needs_cleanup:
        try:
            cleanup = _cleanup_benchmark_container(context, output_dir)
        except (BenchmarkError, OSError, ValueError, TypeError, KeyboardInterrupt) as error:
            cleanup = {"status": "blocked", "reason": f"container cleanup could not be attempted: {error}"}

    case_results: list[dict[str, Any]] = []
    scientific_case_results: dict[str, dict[str, Any]] = {}
    scientific_gate: dict[str, Any] | None = None
    artifact_error: str | None = None
    if return_code == 0 and not timed_out and not interrupted and execution_error is None:
        try:
            for case in cases:
                artifact_result = _validate_case_artifacts(output_dir / case, case)
                _write_scientific_evidence(
                    output_dir / case,
                    case,
                    artifact_result,
                    scientific_evidence_root,
                )
                scientific_result = validate_scientific_case(
                    output_dir / case,
                    case,
                    parameters_path=Path(context.source_tree)
                    / "docs"
                    / "guides"
                    / "comsol-dispersion-benchmark"
                    / "parameters.json",
                    kpath_path=Path(context.source_tree)
                    / "docs"
                    / "guides"
                    / "comsol-dispersion-benchmark"
                    / "kpath.csv",
                )
                case_results.append(
                    {
                        **artifact_result,
                        "scientific_gate": scientific_result,
                    }
                )
                scientific_case_results[case] = scientific_result
            scientific_gate = validate_requested_cases(scientific_case_results, cases)
        except (BenchmarkError, OSError, UnicodeError, ValueError) as error:
            artifact_error = str(error)
    if (
        return_code == 0
        and not timed_out
        and not interrupted
        and execution_error is None
        and artifact_error is None
        and cleanup.get("status") != "blocked"
    ):
        status = (
            "completed_qualified"
            if scientific_gate is not None and scientific_gate.get("status") == "qualified"
            else "completed_unqualified"
        )
        qualification = (
            "QUALIFIED"
            if status == "completed_qualified"
            else "NOT VERIFIED"
        )
    else:
        status = "failed"
        qualification = "NOT VERIFIED"
    result = {
        "schema": RUN_RESULT_SCHEMA,
        "status": status,
        "qualification": qualification,
        "started_at_unix": started,
        "finished_at_unix": time.time(),
        "return_code": return_code,
        "timed_out": timed_out,
        "container_timed_out": container_timed_out,
        "interrupted": interrupted,
        "execution_error": execution_error,
        "cleanup": cleanup,
        "compose_log": "compose.log",
        "cases": case_results,
        "requested_cases": list(cases),
        "artifact_error": artifact_error,
        "scientific_gate": scientific_gate
        or {
            "schema_version": SCIENTIFIC_GATE_SCHEMA,
            "status": "not_qualified",
            "qualification": "NOT VERIFIED",
            "requested_cases": list(cases),
            "reasons": ["scientific gate did not run because the managed execution or artifact gate failed"],
        },
        "source": {
            "job_id": context.job["job_id"],
            "worktree_id": context.job["worktree_id"],
            "profile": context.job["profile"],
            "source_digest": context.job["source_digest"],
            "resolved_commit": context.manifest["resolved_commit"],
            "source_snapshot_sha256": context.native_identity["source_snapshot_sha256"],
        },
        "runtime": {
            "image_digest": EXPECTED_IMAGE_DIGEST,
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "slepc": True,
        },
    }
    _write_new_json(output_dir / "run-result.json", result)
    return 0 if status in {"completed_unqualified", "completed_qualified"} else 1


def _parse_cases(value: str) -> tuple[str, ...]:
    raw = [item.strip().lower() for item in value.split(",") if item.strip()]
    if not raw:
        raise argparse.ArgumentTypeError("at least one benchmark case is required")
    if len(set(raw)) != len(raw):
        raise argparse.ArgumentTypeError("benchmark cases must be unique")
    unknown = [item for item in raw if item not in CASES]
    if unknown:
        raise argparse.ArgumentTypeError("benchmark cases must be c0, c1, or a1")
    return tuple(raw)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root",
        "--worktree",
        dest="repo_root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="the Fullmag checkout whose canonical storage is used",
    )
    parser.add_argument("--job-id", required=True, help="completed fem-cpu-slepc-modal-v1 job")
    parser.add_argument(
        "--cases",
        type=_parse_cases,
        default=DEFAULT_CASES,
        help="comma-separated allow-listed controls (default: c0,c1,a1)",
    )
    parser.add_argument("--output-dir", help="new output directory inside canonical storage")
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="wall-clock limit enforced inside the container (default: 21600)",
    )
    parser.add_argument(
        "--scientific-evidence-root",
        type=Path,
        help=(
            "optional operator-supplied evidence root with "
            "<case>/validation/scientific_gate.v1.json and its comparison artifacts; "
            "without it the gate remains NOT VERIFIED"
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="verify the build and print the exact plan without contacting Docker",
    )
    args = parser.parse_args(argv)
    if not 1 <= args.timeout_seconds <= 7 * 24 * 60 * 60:
        parser.error("--timeout-seconds must be between 1 and 604800")
    try:
        layout = fullmag_storage.resolve_layout(args.repo_root, "windows-native")
        if not args.dry_run:
            fullmag_storage.initialize(layout)
        job = _read_job(layout, args.job_id)
        # A direct invocation and a just invocation share the same per-worktree
        # lock.  The special just route deliberately bypasses the generic
        # container-heavy lock because this command consumes an already
        # completed runner job; build_lock still blocks an active runner lease.
        if args.dry_run:
            context = _validate_build_context(layout, job)
            output_dir = Path(args.output_dir) if args.output_dir else Path(
                layout["storage_root"]
            ) / "runs" / layout["worktree_id"] / args.job_id / "comsol-dispersion" / "<new-run>"
            command = _compose_command(
                context,
                output_dir,
                args.cases,
                timeout_seconds=args.timeout_seconds,
            )
            print(
                json.dumps(
                    {
                        "schema": RUN_REQUEST_SCHEMA,
                        "status": "dry_run",
                        "qualification": "NOT VERIFIED",
                        "job_id": args.job_id,
                        "cases": list(args.cases),
                        "image_digest": EXPECTED_IMAGE_DIGEST,
                        "compose_command": command,
                        "source_tree": str(context.source_tree),
                        "runtime_root": str(context.runtime_root),
                        "scientific_evidence_root": (
                            str(args.scientific_evidence_root)
                            if args.scientific_evidence_root is not None
                            else None
                        ),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
        with fullmag_storage.build_lock(layout):
            # Re-read under the lock so a coordinator cannot finish/reconcile
            # the source job between the preflight and the Compose bind setup.
            locked_job = _read_job(layout, args.job_id)
            context = _validate_build_context(layout, locked_job)
            _inspect_image(EXPECTED_IMAGE_DIGEST)
            output_dir = _new_output_dir(context, args.output_dir)
            output_dir.mkdir(parents=True, exist_ok=False)
            command = _compose_command(
                context,
                output_dir,
                args.cases,
                timeout_seconds=args.timeout_seconds,
            )
            return _execute(
                context,
                output_dir,
                args.cases,
                command,
                timeout_seconds=args.timeout_seconds,
                scientific_evidence_root=args.scientific_evidence_root,
            )
    except (BenchmarkError, fullmag_storage.StorageError, OSError, ValueError, sqlite3.Error) as error:
        print(f"comsol-dispersion-benchmark: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
