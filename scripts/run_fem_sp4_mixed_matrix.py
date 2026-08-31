#!/usr/bin/env python3
"""Execute the staged FEM SP4 mixed-P1 relaxation matrix fail-closed."""

from __future__ import annotations

import argparse
import csv
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from typing import Callable, Iterator, Sequence

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts import plan_fem_sp4_mixed_matrix as planner
from scripts import verify_fem_mixed_prism_airbox_runtime as bounded_gate


SCHEMA = "fullmag.fem.sp4.mixed-matrix-execution.v1"
RUN_SCHEMA = "fullmag.fem.sp4.mixed-matrix-run.v1"
SUMMARY_FILENAME = "execution-summary.v1.json"
RUN_MANIFEST = "run-manifest.v1.json"
RUNTIME_LOG = "runtime.log"
REQUIRED_ARTIFACTS = ("metadata.json", "scalars.csv", "m_final.json")
FULL_MATRIX_CONVERGENCE = "full_matrix_convergence"
ONE_STEP_RUNTIME_SMOKE = "one_step_runtime_smoke"
EVIDENCE_MODES = (FULL_MATRIX_CONVERGENCE, ONE_STEP_RUNTIME_SMOKE)
BOUNDED_SOURCE = REPO_ROOT / "tests/standard_problems/mumag/sp4/fem/problem.py"
DEFAULT_RUNTIME_MANIFEST = REPO_ROOT / ".fullmag/runtimes/fem-gpu-host/manifest.json"
PINNED_RUNTIME_MANIFEST = "runtime-manifest.schema3.json"
RUNTIME_VALIDATOR_RECEIPT = "runtime-validator-receipt.json"
SOURCE_SNAPSHOT_FILENAME = "source-snapshot.v2.json"
CANONICAL_NATIVE_MOUNT = Path("/mnt/fullmag-zfn2-native")
CANONICAL_NATIVE_BACKING_IMAGE = Path(
    "/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4"
)
LOCAL_D_NATIVE_BACKING_IMAGE = Path("/mnt/d/git/fullmag/fullmag-native.ext4")
MANAGED_STORAGE_HELPER = REPO_ROOT / "scripts/lib/managed_fem_runtime_storage.sh"
TOPOLOGY_FINGERPRINT = re.compile(r"sha256:[0-9a-f]{64}")
SHA256 = re.compile(r"[0-9a-f]{64}")
SCALAR_CSV_SERIALIZATION_RTOL = 1.0e-15
DIMENSIONLESS_RECOMPUTATION_ATOL = 16.0 * sys.float_info.epsilon
MAX_MAGNETIZATION_NORM_DEFECT = 1.0e-9
MIXED_QUALITY_METRIC = "tetra_decomposition_scaled_jacobian.v1"
MIXED_SCALED_JACOBIAN_P05_MIN = 0.1
REQUIRED_NATIVE_LIBRARIES = ("fullmag_fem", "mfem", "hypre", "libceed")


class ExecutionError(RuntimeError):
    """Raised when the mixed SP4 matrix cannot complete exactly as planned."""


def _native_backing_image() -> Path:
    profile = os.environ.get("FULLMAG_NATIVE_STORAGE_PROFILE", "canonical")
    if profile == "canonical":
        return CANONICAL_NATIVE_BACKING_IMAGE
    if profile == "local-d":
        return LOCAL_D_NATIVE_BACKING_IMAGE
    raise ExecutionError(
        "unsupported FULLMAG_NATIVE_STORAGE_PROFILE: "
        f"{profile} (expected canonical or local-d)"
    )


Launch = Callable[
    [dict[str, object], Path, dict[str, str], Path],
    int,
]


def _canonical_json_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(_canonical_json_bytes(payload))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _write_json_new(path: Path, payload: object) -> None:
    """Atomically create JSON without ever replacing existing evidence."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(_canonical_json_bytes(payload))
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError as error:
            raise ExecutionError(f"refusing to overwrite existing evidence: {path}") from error
    finally:
        if temporary.exists():
            temporary.unlink()


def _write_bytes_new(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError as error:
            raise ExecutionError(f"refusing to overwrite existing evidence: {path}") from error
    finally:
        if temporary.exists():
            temporary.unlink()


def _reject_symlink_ancestors(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if os.path.lexists(current) and current.is_symlink():
            raise ExecutionError(f"path ancestor must not be a symlink: {current}")


def _validate_durable_storage(
    durable_root: Path,
    *,
    mount_view: Path = CANONICAL_NATIVE_MOUNT,
    expected_backing_image: Path | None = None,
    loop_sysfs_root: Path = Path("/sys/block"),
) -> None:
    """Require the canonical loop-backed ext4 storage contract."""

    if expected_backing_image is None:
        expected_backing_image = _native_backing_image()

    try:
        durable_root.relative_to(mount_view)
    except ValueError as error:
        raise ExecutionError(
            f"durable root must be below the canonical native mount: {mount_view}"
        ) from error
    validation = subprocess.run(
        (
            "bash",
            "-eu",
            "-o",
            "pipefail",
            "-c",
            'source "$1"; validate_managed_fem_runtime_storage_target "$2" "$3" "$4"',
            "fullmag-sp4-storage-validation",
            str(MANAGED_STORAGE_HELPER),
            str(durable_root),
            str(expected_backing_image),
            str(loop_sysfs_root),
        ),
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if validation.returncode != 0:
        detail = validation.stderr.strip() or validation.stdout.strip()
        raise ExecutionError(
            f"durable root failed exact ext4 backing validation: {detail}"
        )
    mount = subprocess.run(
        (
            "findmnt",
            "-n",
            "-o",
            "TARGET,FSTYPE,SOURCE",
            "--target",
            str(mount_view),
        ),
        capture_output=True,
        text=True,
        check=False,
    )
    fields = mount.stdout.strip().split()
    if (
        mount.returncode != 0
        or len(fields) != 3
        or fields[0] != str(mount_view)
        or fields[1] != "ext4"
        or not re.fullmatch(r"/dev/loop[0-9]+", fields[2])
    ):
        raise ExecutionError(
            f"canonical native mount is not the exact mounted ext4 loop filesystem: {mount_view}"
        )


def _validated_report_root(report_root: Path, durable_root: Path) -> tuple[Path, Path]:
    if not durable_root.is_absolute() or not report_root.is_absolute():
        raise ExecutionError("durable root and report root must be absolute paths")
    durable_root = Path(os.path.abspath(durable_root))
    report_root = Path(os.path.abspath(report_root))
    _reject_symlink_ancestors(durable_root)
    if not durable_root.exists() or not durable_root.is_dir():
        raise ExecutionError(f"durable root is not an existing directory: {durable_root}")
    if durable_root.is_symlink():
        raise ExecutionError(f"durable root must not be a symlink: {durable_root}")
    try:
        relative_report = report_root.relative_to(durable_root)
    except ValueError as error:
        raise ExecutionError(
            f"report root must be contained by durable root: {report_root}"
        ) from error
    if not relative_report.parts:
        raise ExecutionError("report root must not equal durable root")
    current = durable_root
    for part in relative_report.parts:
        current = current / part
        if current.is_symlink():
            raise ExecutionError(
                f"report root must not contain symlinks: {current}"
            )
        if current.exists() and not current.is_dir():
            raise ExecutionError(
                f"report root component is not a directory: {current}"
            )
    return report_root, durable_root


@contextmanager
def _execution_lock(report_root: Path) -> Iterator[None]:
    lock_path = report_root.parent / f".{report_root.name}.execution.lock"
    descriptor = os.open(
        lock_path,
        os.O_RDWR
        | os.O_CREAT
        | os.O_CLOEXEC
        | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ExecutionError(f"matrix execution lock is not a regular file: {lock_path}")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ExecutionError(
                f"mixed SP4 matrix execution is already in progress: {lock_path}"
            ) from error
        os.ftruncate(descriptor, 0)
        os.write(descriptor, f"pid={os.getpid()}\n".encode("ascii"))
        os.fsync(descriptor)
        yield
    finally:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _verify_plan(plan: dict[str, object]) -> None:
    if plan.get("schema") != planner.SCHEMA:
        raise ExecutionError("unsupported mixed SP4 matrix plan schema")
    expected = dict(plan)
    digest = expected.pop("plan_sha256", None)
    if not isinstance(digest, str) or hashlib.sha256(
        _canonical_json_bytes(expected)
    ).hexdigest() != digest:
        raise ExecutionError("mixed SP4 matrix plan hash mismatch")
    run_specs = plan.get("run_specs")
    if not isinstance(run_specs, list) or plan.get("run_spec_count") != len(run_specs):
        raise ExecutionError("mixed SP4 matrix plan run count mismatch")


def _case_identity(spec: dict[str, object]) -> dict[str, object]:
    return {
        key: value
        for key, value in spec.items()
        if key not in {"disposition", "reuse_from_stage"}
    }


def collect_execution_cases(
    plans: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    """Return the 15 unique execute cases while validating declared reuse."""

    seen: dict[str, dict[str, object]] = {}
    paths: dict[str, str] = {}
    ordered: list[dict[str, object]] = []
    for plan in plans:
        _verify_plan(plan)
        for raw_spec in plan["run_specs"]:  # type: ignore[index]
            if not isinstance(raw_spec, dict):
                raise ExecutionError("mixed SP4 matrix run spec must be an object")
            spec = dict(raw_spec)
            run_id = spec.get("run_id")
            artifact_path = spec.get("artifact_path")
            disposition = spec.get("disposition")
            if not isinstance(run_id, str) or not run_id:
                raise ExecutionError("mixed SP4 matrix run spec has invalid run_id")
            if not isinstance(artifact_path, str) or not artifact_path:
                raise ExecutionError(f"{run_id} has invalid artifact_path")
            path = Path(artifact_path)
            if path.is_absolute() or ".." in path.parts:
                raise ExecutionError(f"{run_id} has unsafe artifact_path")
            identity = _case_identity(spec)
            if disposition == "reuse":
                previous = seen.get(run_id)
                if previous is None or previous != identity:
                    raise ExecutionError(
                        f"{run_id} declares missing or mismatched reused evidence"
                    )
                continue
            if disposition != "execute":
                raise ExecutionError(f"{run_id} has unsupported disposition")
            if run_id in seen:
                raise ExecutionError(f"duplicate execute run_id: {run_id}")
            prior_run = paths.get(artifact_path)
            if prior_run is not None:
                raise ExecutionError(
                    f"artifact path collision between {prior_run} and {run_id}"
                )
            seen[run_id] = identity
            paths[artifact_path] = run_id
            ordered.append(spec)
    if len(ordered) != 15:
        raise ExecutionError(
            f"mixed SP4 matrix requires exactly 15 unique execute cases; got {len(ordered)}"
        )
    return ordered


def _environment(spec: dict[str, object], max_steps: int) -> dict[str, str]:
    return {
        "FULLMAG_SP4_PHASE": str(spec["phase"]),
        "FULLMAG_SP4_COMPATIBILITY": "native",
        "FULLMAG_SP4_TOPOLOGY_VARIANT": str(spec["topology_variant"]),
        "FULLMAG_SP4_LAYERS": str(spec["layers"]),
        "FULLMAG_SP4_MESH": str(spec["mesh_level"]),
        "FULLMAG_SP4_AIRBOX": str(spec["airbox_id"]),
        "FULLMAG_SP4_DEVICE": str(spec["device"]),
        "FULLMAG_SP4_CASE": "case-a",
        "FULLMAG_SP4_RELAX_ALGORITHM": str(spec["relaxation_algorithm"]),
        "FULLMAG_SP4_RELAX_MAX_STEPS": str(max_steps),
        "FULLMAG_SP4_RELAX_TOL_APM": str(spec["torque_tolerance_apm"]),
        "FULLMAG_GMSH_THREADS": "1",
        "FULLMAG_FEM_GPU_DEMAG_MODE": "device_hypre_poisson",
    }


def _default_launch(
    spec: dict[str, object],
    artifact_dir: Path,
    environment: dict[str, str],
    log_path: Path,
) -> int:
    process_environment = os.environ.copy()
    process_environment.update(environment)
    with log_path.open("xb") as log:
        completed = subprocess.run(
            ("just", "fem-sp4-run", str(spec["device"]), str(artifact_dir)),
            cwd=REPO_ROOT,
            env=process_environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
        )
    return completed.returncode


def _summary_base(
    plans: Sequence[dict[str, object]],
    cases: Sequence[dict[str, object]],
    max_steps: int,
    evidence_mode: str,
) -> dict[str, object]:
    return {
        "schema": SCHEMA,
        "status": "running",
        "qualifying": False,
        "qualification_claim": planner.QUALIFICATION_CLAIM,
        "deferred_axes": list(planner.DEFERRED_AXES),
        "stage1_layers": {
            "status": "execution_only_deferred",
            "convergence_claimed": False,
        },
        "stage2_airbox": {
            "status": "execution_only_deferred",
            "convergence_claimed": False,
        },
        "max_steps": max_steps,
        "evidence_mode": evidence_mode,
        "planned_case_count": len(cases),
        "executed_case_count": 0,
        "completed_case_count": 0,
        "plan_identities": [
            {
                "requested_stage": plan["requested_stage"],
                "plan_sha256": plan["plan_sha256"],
                "source_snapshot_sha256": plan["source_snapshot_sha256"],
            }
            for plan in plans
        ],
        "completed_run_ids": [],
    }


def _preflight_output_paths(
    report_root: Path,
    cases: Sequence[dict[str, object]],
) -> None:
    for spec in cases:
        artifact_dir = report_root / str(spec["artifact_path"])
        current = report_root
        for part in artifact_dir.relative_to(report_root).parts:
            current /= part
            if current.is_symlink():
                raise ExecutionError(f"report root must not contain symlinks: {current}")
            if current.exists() and not current.is_dir():
                raise ExecutionError(f"report root component is not a directory: {current}")
        case_dir = artifact_dir.parent
        _require_new_case_paths(spec, artifact_dir, case_dir)
    summary_path = report_root / SUMMARY_FILENAME
    if os.path.lexists(summary_path):
        raise ExecutionError(f"refusing to overwrite existing matrix summary: {summary_path}")
    pinned_manifest = report_root / PINNED_RUNTIME_MANIFEST
    if os.path.lexists(pinned_manifest):
        raise ExecutionError(
            f"refusing to overwrite existing runtime identity: {pinned_manifest}"
        )
    source_snapshot = report_root / SOURCE_SNAPSHOT_FILENAME
    if os.path.lexists(source_snapshot):
        raise ExecutionError(
            f"refusing to overwrite existing source identity: {source_snapshot}"
        )
    for stage in planner.STAGES:
        plan_dir = report_root / "plans" / stage
        if os.path.lexists(plan_dir):
            raise ExecutionError(f"refusing to overwrite existing matrix plan: {plan_dir}")


def _require_new_case_paths(
    spec: dict[str, object],
    artifact_dir: Path,
    case_dir: Path,
) -> None:
    for path in (artifact_dir, case_dir / RUN_MANIFEST, case_dir / RUNTIME_LOG):
        if os.path.lexists(path):
            raise ExecutionError(f"refusing to overwrite existing case: {spec['run_id']}")


def _regular_file(path: Path) -> None:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ExecutionError(f"missing required artifacts: {path.name}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ExecutionError(f"required artifact must be a regular file: {path}")


def _sha256_file(path: Path) -> str:
    _regular_file(path)
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise ExecutionError(f"cannot hash required artifact: {path}") from error
    return digest.hexdigest()


def _json_object(path: Path) -> dict[str, object]:
    _regular_file(path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ExecutionError(f"required artifact is not valid JSON: {path}") from error
    if not isinstance(payload, dict):
        raise ExecutionError(f"required artifact must contain a JSON object: {path}")
    return payload


def _run_authoritative_runtime_validator(
    runtime_manifest: Path,
    build_identity: dict[str, object],
    compute_capability: str,
) -> dict[str, object]:
    validator = REPO_ROOT / "scripts/validate_managed_fem_runtime_bundle.py"
    command = (
        sys.executable,
        str(validator),
        "--runtime-root",
        str(runtime_manifest.resolve().parent),
        "--require-git-commit",
        str(build_identity["git_commit"]),
        "--require-worktree-state",
        str(build_identity["worktree_state"]),
        "--require-source-snapshot-sha256",
        str(build_identity["source_snapshot_sha256"]),
        "--require-compute-capability",
        compute_capability,
    )
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ExecutionError(
            f"authoritative managed runtime bundle validation failed: {detail}"
        )
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ExecutionError("authoritative runtime validator returned invalid JSON") from error
    if not isinstance(result, dict) or result.get("bundle") != "valid":
        raise ExecutionError("authoritative runtime validator did not prove a valid bundle")
    expected = {
        "git_commit": build_identity["git_commit"],
        "worktree_state": build_identity["worktree_state"],
        "source_snapshot_sha256": build_identity["source_snapshot_sha256"],
        "compute_capability": compute_capability,
        "source_identity_compatibility": "exact-schema-3",
    }
    for field, value in expected.items():
        if result.get(field) != value:
            raise ExecutionError(
                f"authoritative runtime validator receipt {field} is inconsistent"
            )
    return {
        "validator": str(validator.resolve()),
        "validator_sha256": _sha256_file(validator),
        "runtime_root": str(runtime_manifest.resolve().parent),
        "result": result,
    }


def _read_runtime_identity(path: Path) -> dict[str, object]:
    _regular_file(path)
    try:
        before = path.stat()
        manifest_bytes = path.read_bytes()
        after = path.stat()
        manifest = json.loads(manifest_bytes)
    except (OSError, json.JSONDecodeError) as error:
        raise ExecutionError(f"managed runtime manifest is unreadable: {path}") from error
    if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
        after.st_size,
        after.st_mtime_ns,
        after.st_ctime_ns,
    ):
        raise ExecutionError("managed runtime manifest changed while reading")
    if not isinstance(manifest, dict) or manifest.get("schema") != 3:
        raise ExecutionError("managed runtime manifest must use schema 3")
    if manifest.get("runtime") != "fem-gpu-host":
        raise ExecutionError("managed runtime manifest has the wrong runtime identity")
    variant = manifest.get("variant")
    if not isinstance(variant, str) or not variant:
        raise ExecutionError("managed runtime manifest variant is missing")
    build_identity = _object(manifest.get("build_identity"), "runtime build_identity")
    expected_fields = {
        "git_commit": re.compile(r"[0-9a-f]{40}"),
        "source_snapshot_sha256": SHA256,
    }
    for field, pattern in expected_fields.items():
        value = build_identity.get(field)
        if not isinstance(value, str) or pattern.fullmatch(value) is None:
            raise ExecutionError(f"managed runtime build_identity.{field} is invalid")
    if build_identity.get("worktree_state") not in {"clean", "dirty"}:
        raise ExecutionError("managed runtime build_identity.worktree_state is invalid")
    integrity = _object(manifest.get("integrity"), "runtime integrity")
    integrity_identity: dict[str, str] = {}
    for field in ("launcher_sha256", "worker_sha256", "api_sha256"):
        value = integrity.get(field)
        if not isinstance(value, str) or SHA256.fullmatch(value) is None:
            raise ExecutionError(f"managed runtime integrity.{field} is invalid")
        integrity_identity[field] = value
    libraries = _object(manifest.get("native_libraries"), "runtime native_libraries")
    library_identity: dict[str, dict[str, object]] = {}
    for name in REQUIRED_NATIVE_LIBRARIES:
        entry = _object(libraries.get(name), f"runtime native library {name}")
        path_value = entry.get("path")
        if not isinstance(path_value, str) or not path_value:
            raise ExecutionError(f"managed runtime native library {name}.path is invalid")
        soname_value = entry.get("soname")
        if soname_value is not None and (
            not isinstance(soname_value, str) or not soname_value
        ):
            raise ExecutionError(f"managed runtime native library {name}.soname is invalid")
        loaded_soname_value = entry.get("loaded_soname")
        if not isinstance(loaded_soname_value, str) or not loaded_soname_value:
            raise ExecutionError(
                f"managed runtime native library {name}.loaded_soname is invalid"
            )
        digest = entry.get("sha256")
        if not isinstance(digest, str) or SHA256.fullmatch(digest) is None:
            raise ExecutionError(f"managed runtime native library {name}.sha256 is invalid")
        if entry.get("cuda_required") is not True:
            raise ExecutionError(f"managed runtime native library {name}.cuda_required must be true")
        for field in ("cubins", "ptx"):
            values = entry.get(field)
            if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
                raise ExecutionError(f"managed runtime native library {name}.{field} is invalid")
        if not entry["cubins"] and not entry["ptx"]:
            raise ExecutionError(f"managed runtime native library {name} has no CUDA code objects")
        library_identity[name] = dict(entry)
    build = _object(manifest.get("build"), "runtime build")
    native_build_identity: dict[str, str] = {}
    for field in ("mfem_version", "hypre_version", "libceed_version", "cuda_toolkit"):
        value = build.get(field)
        if not isinstance(value, str) or not value:
            raise ExecutionError(f"managed runtime build.{field} is invalid")
        native_build_identity[field] = value
    diagnostics = _object(manifest.get("runtime_diagnostics"), "runtime diagnostics")
    gpu_device_identity: dict[str, str] = {}
    for field in ("device_name", "compute_capability", "cuda_driver_version"):
        value = diagnostics.get(field)
        if not isinstance(value, str) or not value:
            raise ExecutionError(f"managed runtime diagnostics.{field} is invalid")
        gpu_device_identity[field] = value
    authoritative_receipt = _run_authoritative_runtime_validator(
        path, build_identity, gpu_device_identity["compute_capability"]
    )
    return {
        "schema": 3,
        "runtime_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "runtime": "fem-gpu-host",
        "variant": variant,
        "build_identity": dict(build_identity),
        "integrity_identity": integrity_identity,
        "native_library_identity": library_identity,
        "native_build_identity": native_build_identity,
        "gpu_device_identity": gpu_device_identity,
        "authoritative_validator_receipt": authoritative_receipt,
    }


def _pin_execution_identity(
    plans: Sequence[dict[str, object]],
    report_root: Path,
    runtime_manifest: Path,
) -> dict[str, object]:
    snapshots = {plan.get("source_snapshot_sha256") for plan in plans}
    if len(snapshots) != 1:
        raise ExecutionError("mixed SP4 matrix plans do not share one source snapshot")
    [plan_snapshot] = snapshots
    if not isinstance(plan_snapshot, str) or SHA256.fullmatch(plan_snapshot) is None:
        raise ExecutionError("mixed SP4 matrix plan source snapshot is invalid")
    runtime_identity = _read_runtime_identity(runtime_manifest)
    runtime_build_identity = _object(
        runtime_identity.get("build_identity"), "runtime build_identity"
    )
    if runtime_build_identity.get("source_snapshot_sha256") != plan_snapshot:
        raise ExecutionError(
            "runtime source snapshot does not match the planned source snapshot"
        )
    first_plan = plans[0]
    expected_worktree_state = (
        "dirty" if first_plan.get("source_snapshot_dirty") is True else "clean"
    )
    if runtime_build_identity.get("git_commit") != first_plan.get("head_commit_full"):
        raise ExecutionError("runtime Git commit does not match the planned source snapshot")
    if runtime_build_identity.get("worktree_state") != expected_worktree_state:
        raise ExecutionError(
            "runtime worktree state does not match the planned source snapshot"
        )
    try:
        manifest_bytes = runtime_manifest.read_bytes()
    except OSError as error:
        raise ExecutionError("managed runtime manifest cannot be pinned") from error
    if hashlib.sha256(manifest_bytes).hexdigest() != runtime_identity["runtime_manifest_sha256"]:
        raise ExecutionError("managed runtime manifest changed before it was pinned")
    _write_bytes_new(report_root / PINNED_RUNTIME_MANIFEST, manifest_bytes)
    _write_json_new(
        report_root / RUNTIME_VALIDATOR_RECEIPT,
        runtime_identity["authoritative_validator_receipt"],
    )
    source_snapshot = {
        "schema": first_plan.get("source_snapshot_schema"),
        **{
            key: first_plan.get(key)
            for key in (
                "head_commit_full",
                "head_tree_sha256",
                "git_status_porcelain_v1",
                "dirty_path_content",
                "source_snapshot_dirty",
                "dirty_content_sha256",
                "source_snapshot_sha256",
            )
        },
    }
    _write_json_new(report_root / SOURCE_SNAPSHOT_FILENAME, source_snapshot)
    return {
        "plan_source_snapshot_sha256": plan_snapshot,
        "bounded_source_sha256": _sha256_file(BOUNDED_SOURCE),
        **runtime_identity,
    }


def _assert_execution_identity(
    execution_identity: dict[str, object],
    *,
    plan_root: Path,
    runtime_manifest: Path,
) -> None:
    current_source = planner._source_identity()
    if (
        current_source.get("source_snapshot_sha256")
        != execution_identity.get("plan_source_snapshot_sha256")
    ):
        raise ExecutionError("planned source snapshot identity changed")
    if _sha256_file(BOUNDED_SOURCE) != execution_identity.get("bounded_source_sha256"):
        raise ExecutionError("bounded SP4 source identity changed")
    current_runtime = _read_runtime_identity(runtime_manifest)
    expected_runtime = {
        key: execution_identity.get(key)
        for key in (
            "schema",
            "runtime_manifest_sha256",
            "runtime",
            "variant",
            "build_identity",
            "integrity_identity",
            "native_library_identity",
            "native_build_identity",
            "gpu_device_identity",
            "authoritative_validator_receipt",
        )
    }
    if current_runtime != expected_runtime:
        raise ExecutionError("managed runtime identity changed")


def _validate_gpu_execution(
    metadata: dict[str, object],
    execution: dict[str, object],
    qualification: dict[str, object],
    executed_steps: int,
    execution_identity: dict[str, object],
) -> dict[str, object]:
    manifest_device = _object(
        execution_identity.get("gpu_device_identity"), "runtime GPU device identity"
    )
    for field in ("device_name", "compute_capability"):
        if execution.get(field) != manifest_device.get(field):
            raise ExecutionError("GPU execution device identity does not match pinned runtime")
    native_build = _object(
        execution_identity.get("native_build_identity"), "runtime native build identity"
    )
    if execution.get("mfem_version") != native_build.get("mfem_version"):
        raise ExecutionError("GPU execution MFEM identity does not match pinned runtime")
    if execution.get("mfem_device") != "cuda":
        raise ExecutionError("GPU execution mfem_device must be exactly 'cuda'")
    expected = {
        "fem_execution_mode": "all_in_gpu_legacy_sparse",
        "fem_data_residency": "device_source_of_truth",
        "fem_exchange_operator_mode": "legacy_sparse_gpu",
        "uses_cuda_kernels": True,
        "uses_gpu_poisson": True,
        "fem_demag_operator_mode": "device_hypre_poisson",
        "hypre_execution_policy": "device",
        "demag_residency": "device",
        "fem_gpu_state_allocated": True,
    }
    for field, value in expected.items():
        if execution.get(field) != value:
            raise ExecutionError(f"GPU execution {field} must be {value!r}")
    policy = _object(qualification.get("device_policy"), "GPU device policy")
    policy_expected = {
        "execution_mode": "all_in_gpu_legacy_sparse",
        "data_residency": "device_source_of_truth",
        "exchange_operator_mode": "legacy_sparse_gpu",
        "demag_operator_mode": "device_hypre_poisson",
        "uses_cuda_kernels": True,
        "uses_gpu_poisson": True,
        "hot_loop_exchange_host_sync_count": 0,
        "hot_loop_compute_host_sync_count": 0,
    }
    for field, value in policy_expected.items():
        if policy.get(field) != value:
            raise ExecutionError(f"GPU device policy {field} must be {value!r}")
    fields = (
        "hot_loop_host_sync_count",
        "hot_loop_exchange_h2d_bytes",
        "hot_loop_exchange_d2h_bytes",
        "hot_loop_exchange_host_sync_count",
        "hot_loop_compute_h2d_bytes",
        "hot_loop_compute_d2h_bytes",
        "hot_loop_compute_host_sync_count",
        "hot_loop_control_scalar_d2h_bytes",
        "hot_loop_control_scalar_host_sync_count",
    )
    telemetry: dict[str, int] = {}
    for field in fields:
        value = execution.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ExecutionError(f"GPU execution {field} must be a nonnegative integer")
        telemetry[field] = value
    for scope in ("exchange", "compute"):
        for suffix in ("h2d_bytes", "d2h_bytes", "host_sync_count"):
            field = f"hot_loop_{scope}_{suffix}"
            if telemetry[field] != 0:
                raise ExecutionError(f"GPU scoped transfer telemetry {field} must be zero")
    control_syncs = telemetry["hot_loop_control_scalar_host_sync_count"]
    control_bytes = telemetry["hot_loop_control_scalar_d2h_bytes"]
    if telemetry["hot_loop_host_sync_count"] != control_syncs:
        raise ExecutionError("GPU host syncs must be control-scalar-only")
    if policy.get("hot_loop_control_scalar_host_sync_count") != control_syncs:
        raise ExecutionError("GPU qualification and provenance control-sync counts differ")
    algorithm = qualification.get("relaxation_algorithm")
    total_rhs_evals = qualification.get("total_rhs_evals")
    rejected_attempts = qualification.get("rejected_attempts")
    for value, label in (
        (total_rhs_evals, "total_rhs_evals"),
        (rejected_attempts, "rejected_attempts"),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ExecutionError(f"GPU qualification {label} must be a nonnegative integer")
    assert isinstance(total_rhs_evals, int) and isinstance(rejected_attempts, int)
    try:
        counter_contract = bounded_gate.validated_algorithm_counter_budget(
            str(algorithm), executed_steps, total_rhs_evals, rejected_attempts
        )
    except bounded_gate.ContractError as error:
        raise ExecutionError(f"GPU algorithm counter contract failed: {error}") from error
    sync_budget = counter_contract["control_sync_budget"]
    byte_budget = (
        sync_budget * bounded_gate.GPU_SCALAR_RESULT_SLOTS * bounded_gate.DOUBLE_BYTES
    )
    if control_syncs > sync_budget or control_bytes > byte_budget:
        raise ExecutionError("GPU control-scalar readbacks exceed the bounded gate budget")
    if control_bytes % bounded_gate.DOUBLE_BYTES != 0:
        raise ExecutionError("GPU control-scalar bytes must contain complete doubles")
    if (control_syncs == 0) != (control_bytes == 0):
        raise ExecutionError("GPU control-scalar bytes and syncs disagree")
    demag = _object(metadata.get("demag_runtime"), "GPU demag runtime")
    if demag.get("hypre_version") != native_build.get("hypre_version"):
        raise ExecutionError("GPU Hypre identity does not match pinned runtime")
    if demag.get("mfem_device") != "cuda":
        raise ExecutionError("GPU demag runtime mfem_device must be exactly 'cuda'")
    if demag.get("runtime_solver") != "HyprePCG" or demag.get("runtime_preconditioner") != "HypreBoomerAMG":
        raise ExecutionError("GPU demag runtime must prove HyprePCG/HypreBoomerAMG")
    tolerance = _finite(demag.get("relative_tolerance"), "GPU demag tolerance")
    residual = _finite(demag.get("final_residual_norm"), "GPU demag residual")
    if not 0.0 < tolerance <= 1.0e-12 or not 0.0 <= residual <= tolerance:
        raise ExecutionError("GPU demag residual must satisfy the strict tolerance")
    return {
        **telemetry,
        "allowed_control_scalar_host_sync_count": sync_budget,
        "allowed_control_scalar_d2h_bytes": byte_budget,
        "total_rhs_evals": total_rhs_evals,
        "rejected_attempts": rejected_attempts,
        "minimum_rhs_evals": counter_contract["minimum_rhs_evals"],
    }


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ExecutionError(f"{label} must be an object")
    return value


def _equal_float(actual: object, expected: object, label: str) -> None:
    if isinstance(actual, bool) or not isinstance(actual, (int, float)):
        raise ExecutionError(f"{label} must be numeric")
    if isinstance(expected, bool) or not isinstance(expected, (int, float)):
        raise ExecutionError(f"invalid planned {label}")
    if not math.isclose(float(actual), float(expected), rel_tol=1.0e-12, abs_tol=1.0e-21):
        raise ExecutionError(f"{label} does not match the run spec")


def _scalar_final_values(path: Path) -> tuple[int, dict[str, float]]:
    _regular_file(path)
    try:
        with path.open(newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
    except (OSError, UnicodeDecodeError) as error:
        raise ExecutionError(f"cannot read scalar artifact: {path}") from error
    if not rows:
        raise ExecutionError("scalars.csv must contain at least one row")
    previous = -1
    for index, row in enumerate(rows):
        try:
            step_value = float(row["step"])
            numeric_values = [float(value) for value in row.values() if value not in (None, "")]
        except (KeyError, TypeError, ValueError) as error:
            raise ExecutionError(f"scalars.csv row {index} is malformed") from error
        if not step_value.is_integer() or int(step_value) < previous:
            raise ExecutionError("scalars.csv steps must be nonnegative and monotonic")
        if not numeric_values or not all(math.isfinite(value) for value in numeric_values):
            raise ExecutionError(f"scalars.csv row {index} contains non-finite values")
        previous = int(step_value)
    final_row = rows[-1]
    required = (
        "E_ex",
        "E_demag",
        "E_total",
        "max_torque_Apm",
        "max_torque_T",
    )
    try:
        values = {field: float(final_row[field]) for field in required}
    except (KeyError, TypeError, ValueError) as error:
        raise ExecutionError("scalars.csv is missing final energy or torque evidence") from error
    if not all(math.isfinite(value) for value in values.values()):
        raise ExecutionError("scalars.csv final energy or torque is non-finite")
    return previous, values


def _finite(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ExecutionError(f"{label} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ExecutionError(f"{label} must be finite")
    return result


def _cross_check_scalar(
    observed: float,
    expected: float,
    label: str,
) -> None:
    delta = abs(observed - expected)
    allowed = SCALAR_CSV_SERIALIZATION_RTOL * max(abs(observed), abs(expected))
    if delta > allowed:
        raise ExecutionError(
            f"scalars.csv final {label} does not match relaxation qualification"
        )


def _magnetic_node_indices(metadata: dict[str, object], node_count: int) -> set[int]:
    execution_plan = _object(metadata.get("execution_plan"), "execution_plan")
    backend_plan = _object(execution_plan.get("backend_plan"), "execution_plan.backend_plan")
    parts = backend_plan.get("mesh_parts")
    if not isinstance(parts, list):
        raise ExecutionError("execution_plan.backend_plan.mesh_parts must be an array")
    indices: set[int] = set()
    for part_index, raw_part in enumerate(parts):
        part = _object(raw_part, f"mesh_parts[{part_index}]")
        if part.get("role") != "magnetic_object":
            continue
        explicit = part.get("node_indices", [])
        if not isinstance(explicit, list):
            raise ExecutionError(f"mesh_parts[{part_index}].node_indices must be an array")
        if explicit:
            for value in explicit:
                if (
                    isinstance(value, bool)
                    or not isinstance(value, int)
                    or not 0 <= value < node_count
                ):
                    raise ExecutionError("magnetic node index is outside mesh.node_count")
                indices.add(value)
            continue
        selector = _object(part.get("node_selector"), f"mesh_parts[{part_index}].node_selector")
        if selector.get("kind") != "node_range":
            raise ExecutionError("magnetic node selector must be node_range")
        start = selector.get("start")
        count = selector.get("count")
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            for value in (start, count)
        ):
            raise ExecutionError("magnetic node range is malformed")
        assert isinstance(start, int) and isinstance(count, int)
        if start + count > node_count:
            raise ExecutionError("magnetic node range exceeds mesh.node_count")
        indices.update(range(start, start + count))
    if not indices:
        raise ExecutionError("execution plan has no magnetic_object node selection")
    return indices


def _validate_certificate(certificate: dict[str, object], layers: int) -> None:
    required_fields = {
        "requested_sweep_direction",
        "resolved_sweep_direction",
        "plane_tolerance_m",
        "transition_shell_thickness_m",
        "transition_shell_interface_tri3_count",
        "interface_marker",
        "outer_boundary_marker",
        "magnetic_bounds_min_m",
        "magnetic_bounds_max_m",
        "airbox_bounds_min_m",
        "airbox_bounds_max_m",
        "magnetic_bounds_relative_error",
        "airbox_bounds_relative_error",
        "topology_fingerprint_version",
        "cell_family_counts_by_marker",
        "facet_family_counts_by_role_marker",
        "jacobian_minima_m3_by_family",
        "quality_metric",
        "scaled_jacobian_minima_by_family",
        "scaled_jacobian_p05_by_family",
        "magnetic_volume_m3",
        "expected_magnetic_volume_m3",
        "magnetic_relative_volume_error",
        "air_volume_m3",
        "shared_domain_volume_m3",
        "expected_shared_domain_volume_m3",
        "shared_domain_relative_volume_error",
        "marker_coverage_complete",
        "nonconforming_face_count",
        "orphan_face_count",
        "nonmanifold_face_count",
        "coincident_interface_face_count",
        "gmsh_version",
        "strategy",
        "effective_gmsh_thread_count",
        "deterministic_inputs",
    }
    missing = required_fields - set(certificate)
    if missing:
        raise ExecutionError(f"mixed topology certificate is incomplete: {sorted(missing)}")
    requested_direction = certificate.get("requested_sweep_direction")
    resolved_direction = certificate.get("resolved_sweep_direction")
    if requested_direction != "auto" and requested_direction != resolved_direction:
        raise ExecutionError("mixed topology certificate changed sweep direction")
    if requested_direction not in {"auto", "x", "y", "z"} or resolved_direction not in {
        "x", "y", "z"
    }:
        raise ExecutionError("mixed topology certificate sweep direction is invalid")
    if certificate.get("topology_fingerprint_version") != "v3":
        raise ExecutionError("mixed topology certificate fingerprint version must be v3")
    planes = certificate.get("magnetic_plane_coordinates_m")
    if not isinstance(planes, list) or len(planes) != layers + 1:
        raise ExecutionError("mixed topology certificate has the wrong node-plane count")
    finite_planes = [_finite(value, "magnetic plane") for value in planes]
    if any(right <= left for left, right in zip(finite_planes, finite_planes[1:])):
        raise ExecutionError("mixed topology certificate planes must increase")
    if certificate.get("marker_coverage_complete") is not True:
        raise ExecutionError("mixed topology certificate marker coverage is incomplete")
    for field in (
        "nonconforming_face_count",
        "orphan_face_count",
        "nonmanifold_face_count",
        "coincident_interface_face_count",
    ):
        if certificate.get(field) != 0:
            raise ExecutionError(f"mixed topology certificate {field} must be zero")
    if certificate.get("quality_metric") != MIXED_QUALITY_METRIC:
        raise ExecutionError("mixed topology certificate quality metric is unsupported")
    expected_families = {"prism6", "pyramid5", "tet4"}
    for field in (
        "jacobian_minima_m3_by_family",
        "scaled_jacobian_minima_by_family",
        "scaled_jacobian_p05_by_family",
    ):
        values = _object(certificate.get(field), f"certificate {field}")
        if set(values) != expected_families:
            raise ExecutionError(f"mixed topology certificate {field} is incomplete")
        numeric = [
            _finite(value, f"certificate {field}.{family}")
            for family, value in values.items()
        ]
        if any(value <= 0.0 for value in numeric):
            raise ExecutionError(f"mixed topology certificate {field} must be positive")
        if field == "scaled_jacobian_p05_by_family" and any(
            value < MIXED_SCALED_JACOBIAN_P05_MIN for value in numeric
        ):
            raise ExecutionError("mixed topology certificate quality gate failed")
    if certificate.get("gmsh_version") != "4.15.2":
        raise ExecutionError("mixed topology certificate Gmsh version is unqualified")
    if certificate.get("strategy") != "shared_geo_extrusion_partitioned_pyramid_tet.v2":
        raise ExecutionError("mixed topology certificate strategy is unqualified")
    if certificate.get("effective_gmsh_thread_count") != 1:
        raise ExecutionError("mixed topology certificate must use one Gmsh thread")
    deterministic_inputs = certificate.get("deterministic_inputs")
    if not isinstance(deterministic_inputs, dict) or not deterministic_inputs:
        raise ExecutionError("mixed topology certificate deterministic inputs are malformed")
    for field in ("plane_tolerance_m", "transition_shell_thickness_m"):
        if _finite(certificate.get(field), f"certificate {field}") <= 0.0:
            raise ExecutionError(f"mixed topology certificate {field} must be positive")
    for field in (
        "magnetic_volume_m3",
        "expected_magnetic_volume_m3",
        "air_volume_m3",
        "shared_domain_volume_m3",
        "expected_shared_domain_volume_m3",
    ):
        if _finite(certificate.get(field), f"certificate {field}") <= 0.0:
            raise ExecutionError(f"mixed topology certificate {field} must be positive")
    for field in (
        "magnetic_bounds_relative_error",
        "airbox_bounds_relative_error",
        "magnetic_relative_volume_error",
        "shared_domain_relative_volume_error",
    ):
        error = _finite(certificate.get(field), f"certificate {field}")
        if error < 0.0 or error > 1.0e-8:
            raise ExecutionError(f"mixed topology certificate {field} exceeds 1e-8")
    for prefix in ("magnetic", "airbox"):
        minimum = certificate.get(f"{prefix}_bounds_min_m")
        maximum = certificate.get(f"{prefix}_bounds_max_m")
        if (
            not isinstance(minimum, list)
            or not isinstance(maximum, list)
            or len(minimum) != 3
            or len(maximum) != 3
        ):
            raise ExecutionError(f"mixed topology certificate {prefix} bounds are malformed")
        lower = [_finite(value, f"certificate {prefix} bounds") for value in minimum]
        upper = [_finite(value, f"certificate {prefix} bounds") for value in maximum]
        if any(right <= left for left, right in zip(lower, upper, strict=True)):
            raise ExecutionError(f"mixed topology certificate {prefix} bounds do not increase")
    interface_marker = certificate.get("interface_marker")
    outer_marker = certificate.get("outer_boundary_marker")
    if (
        isinstance(interface_marker, bool)
        or not isinstance(interface_marker, int)
        or interface_marker < 1
        or isinstance(outer_marker, bool)
        or not isinstance(outer_marker, int)
        or outer_marker < 1
        or interface_marker == outer_marker
    ):
        raise ExecutionError("mixed topology certificate markers are invalid")
    tri_count = certificate.get("transition_shell_interface_tri3_count")
    if isinstance(tri_count, bool) or not isinstance(tri_count, int) or tri_count < 1:
        raise ExecutionError("mixed topology certificate transition interface is empty")


def _validate_case_artifacts(
    spec: dict[str, object],
    artifact_dir: Path,
    log_path: Path,
    max_steps: int,
    execution_identity: dict[str, object] | None = None,
    evidence_mode: str = FULL_MATRIX_CONVERGENCE,
) -> dict[str, object]:
    if evidence_mode not in EVIDENCE_MODES:
        raise ExecutionError(f"unsupported mixed SP4 evidence mode: {evidence_mode}")
    if artifact_dir.is_symlink() or not artifact_dir.is_dir():
        raise ExecutionError(f"artifact directory must be a regular directory: {artifact_dir}")
    metadata_path = artifact_dir / "metadata.json"
    scalars_path = artifact_dir / "scalars.csv"
    final_path = artifact_dir / "m_final.json"
    metadata = _json_object(metadata_path)
    final = _json_object(final_path)
    _regular_file(log_path)

    if metadata.get("status") != "completed":
        raise ExecutionError("runtime metadata status must be completed")
    expected_source_hash = (
        execution_identity.get("bounded_source_sha256")
        if execution_identity is not None
        else _sha256_file(BOUNDED_SOURCE)
    )
    if metadata.get("source_hash") != expected_source_hash:
        raise ExecutionError("runtime metadata source_hash does not match bounded source")
    requested = _object(metadata.get("requested_execution"), "requested_execution")
    expected_requested = {
        "backend": "fem",
        "device": spec["device"],
        "precision": "double",
        "mode": "strict",
        "fallback_policy": "forbidden",
    }
    if requested != expected_requested:
        raise ExecutionError("requested execution does not match the run spec")
    execution = _object(metadata.get("execution_provenance"), "execution_provenance")
    engine = "fem_cpu_native" if spec["device"] == "cpu" else "fem_native_gpu"
    if execution.get("execution_engine") != engine:
        raise ExecutionError("runtime execution engine does not match the run spec")
    if execution.get("precision") != "double":
        raise ExecutionError("runtime precision must be double")
    if execution.get("lossy_fallback_used") is not False:
        raise ExecutionError("runtime must prove that no fallback was used")
    if execution.get("resolved_fallback") not in (None, "None"):
        raise ExecutionError("runtime resolved fallback must be absent")

    runtime = _object(
        _object(metadata.get("problem_meta"), "problem_meta").get("runtime_metadata"),
        "runtime_metadata",
    )
    domain = _object(runtime.get("domain_frame"), "runtime domain_frame")
    universe = _object(domain.get("declared_universe"), "declared universe")
    dimensions = universe.get("size")
    if not isinstance(dimensions, list) or len(dimensions) != 3:
        raise ExecutionError("declared airbox dimensions are malformed")
    expected_dimensions = spec["airbox_dimensions_m"]
    if not isinstance(expected_dimensions, list) or len(expected_dimensions) != 3:
        raise ExecutionError("planned airbox dimensions are malformed")
    for index, (actual, expected) in enumerate(zip(dimensions, expected_dimensions, strict=True)):
        _equal_float(actual, expected, f"airbox dimension {index}")
    _equal_float(universe.get("airbox_hmax"), spec["airbox_hmax_m"], "airbox hmax")
    workflow = _object(runtime.get("mesh_workflow"), "mesh_workflow")
    per_geometry = workflow.get("per_geometry")
    if not isinstance(per_geometry, list) or len(per_geometry) != 1:
        raise ExecutionError("mesh_workflow must contain exactly one magnetic geometry")
    magnetic_mesh = _object(per_geometry[0], "magnetic mesh workflow")
    _equal_float(
        magnetic_mesh.get("maximum_element_size", magnetic_mesh.get("hmax")),
        spec["mesh_hmax_m"],
        "magnetic hmax",
    )
    if magnetic_mesh.get("through_thickness_elements") != spec["layers"]:
        raise ExecutionError("magnetic layer count does not match the run spec")

    mesh = _object(metadata.get("mesh"), "mesh metadata")
    fingerprint = mesh.get("topology_fingerprint")
    if not isinstance(fingerprint, str) or TOPOLOGY_FINGERPRINT.fullmatch(fingerprint) is None:
        raise ExecutionError("mesh topology fingerprint is not canonical")
    report = _object(mesh.get("mesh_build_report"), "mesh build report")
    if report.get("fallbacks_triggered") != [] or report.get("degraded") is not False:
        raise ExecutionError("mesh build must prove no fallback or degradation")
    provenance = _object(report.get("mixed_topology_provenance"), "mixed topology provenance")
    certificate = _object(
        report.get("mixed_layer_topology_certificate"),
        "mixed layer topology certificate",
    )
    certificate_fingerprint = certificate.get("topology_fingerprint")
    if (
        not isinstance(certificate_fingerprint, str)
        or TOPOLOGY_FINGERPRINT.fullmatch(certificate_fingerprint) is None
    ):
        raise ExecutionError("mixed topology certificate fingerprint is not canonical")
    expected_topology = {
        "requested_topology": spec["topology_variant"],
        "resolved_topology": spec["topology_variant"],
        "requested_device": spec["device"],
        "precision": "double",
        "accepted_certificate_fingerprint": certificate_fingerprint,
    }
    for key, expected in expected_topology.items():
        if provenance.get(key) != expected:
            raise ExecutionError(f"mixed topology provenance {key} does not match the run spec")
    if certificate.get("schema_version") != "mixed_layer_topology_certificate.v1":
        raise ExecutionError("mixed topology certificate schema is unsupported")
    if certificate.get("certificate_status") != "accepted":
        raise ExecutionError("mixed topology certificate must be accepted")
    if certificate.get("fallbacks_triggered") != []:
        raise ExecutionError("mixed topology certificate must prove no fallback")
    layers = spec["layers"]
    if (
        certificate.get("requested_layer_count") != layers
        or certificate.get("realized_layer_count") != layers
    ):
        raise ExecutionError("mixed topology certificate layer count does not match the run spec")
    if not isinstance(layers, int):
        raise ExecutionError("planned magnetic layer count is invalid")
    _validate_certificate(certificate, layers)
    parts = _object(certificate.get("cell_family_counts_by_part"), "certificate mesh parts")
    if set(parts) != {"magnetic", "transition_air", "far_air"}:
        raise ExecutionError("mixed topology certificate mesh parts are incomplete")
    magnetic = _object(parts.get("magnetic"), "certificate magnetic cells")
    if (
        set(magnetic) != {"prism6"}
        or not isinstance(magnetic.get("prism6"), int)
        or magnetic["prism6"] <= 0
    ):
        raise ExecutionError("mixed topology certificate must prove prism6-only magnetic cells")
    transition = _object(parts.get("transition_air"), "certificate transition-air cells")
    if set(transition) != {"pyramid5", "tet4"} or any(
        isinstance(transition.get(family), bool)
        or not isinstance(transition.get(family), int)
        or int(transition[family]) <= 0
        for family in ("pyramid5", "tet4")
    ):
        raise ExecutionError("mixed topology certificate transition air is incomplete")
    far_air = _object(parts.get("far_air"), "certificate far-air cells")
    if (
        set(far_air) != {"tet4"}
        or not isinstance(far_air.get("tet4"), int)
        or far_air["tet4"] <= 0
    ):
        raise ExecutionError("mixed topology certificate far air must be tet4-only")

    qualification = _object(
        metadata.get(f"fem_{spec['device']}_relaxation_qualification"),
        "relaxation qualification",
    )
    if qualification.get("relaxation_algorithm") != spec["relaxation_algorithm"]:
        raise ExecutionError("relaxation algorithm does not match the run spec")
    executed_steps = qualification.get("executed_steps")
    if (
        isinstance(executed_steps, bool)
        or not isinstance(executed_steps, int)
        or executed_steps < 0
        or executed_steps > max_steps
    ):
        raise ExecutionError("executed relaxation steps exceed the requested max_steps")
    final_torque_apm = _finite(
        qualification.get("final_torque_apm"), "final_torque_apm"
    )
    final_torque_t = _finite(
        qualification.get("final_torque_t"), "final_torque_t"
    )
    if final_torque_apm < 0.0 or final_torque_t < 0.0:
        raise ExecutionError("mixed-P1 relaxation torque must be nonnegative")
    _equal_float(
        final_torque_t,
        final_torque_apm * (4e-7 * math.pi),
        "final torque T/A/m conversion",
    )
    converged = qualification.get("converged")
    if evidence_mode == ONE_STEP_RUNTIME_SMOKE:
        if max_steps != 1 or executed_steps != 1:
            raise ExecutionError("one-step runtime smoke must execute exactly one relaxation step")
        if converged is False:
            expected_stop_provenance = {
                "stop_reason": "max_steps",
                "stop_metric_kind": "steps",
                "stop_metric_name": "steps",
                "stop_metric_unit": "count",
            }
            for field, expected in expected_stop_provenance.items():
                if qualification.get(field) != expected:
                    raise ExecutionError(
                        "non-converged one-step runtime smoke must prove max_steps completion"
                    )
            stop_metric_value = _finite(
                qualification.get("stop_metric_value"),
                "one-step runtime smoke stop metric value",
            )
            if stop_metric_value != executed_steps:
                raise ExecutionError(
                    "one-step runtime smoke stop metric value must equal executed_steps"
                )
            stop_threshold = _finite(
                qualification.get("stop_threshold"),
                "one-step runtime smoke stop threshold",
            )
            if stop_threshold != max_steps:
                raise ExecutionError(
                    "one-step runtime smoke stop threshold must equal max_steps"
                )
        elif converged is not True:
            raise ExecutionError("one-step runtime smoke convergence state must be explicit")
    elif converged is not True:
        raise ExecutionError("mixed-P1 relaxation did not converge")

    if converged is True:
        requested_tolerance_apm = _finite(
            spec.get("torque_tolerance_apm"), "planned torque_tolerance_apm"
        )
        requested_tolerance_t = _finite(
            spec.get("torque_tolerance_t"), "planned torque_tolerance_t"
        )
        if requested_tolerance_apm <= 0.0 or requested_tolerance_t <= 0.0:
            raise ExecutionError("planned mixed-P1 torque tolerance must be positive")
        _equal_float(
            qualification.get("stop_threshold"),
            requested_tolerance_apm,
            "relaxation stop threshold",
        )
        expected_stop_provenance = {
            "stop_reason": "torque",
            "stop_metric_kind": "max_torque_apm",
            "stop_metric_unit": "A/m",
            "stop_metric_name": "max_torque_apm",
        }
        for field, expected in expected_stop_provenance.items():
            if qualification.get(field) != expected:
                raise ExecutionError(f"relaxation {field} does not prove torque convergence")
        stop_metric_value = _finite(
            qualification.get("stop_metric_value"), "stop_metric_value"
        )
        if stop_metric_value < 0.0:
            raise ExecutionError("mixed-P1 relaxation torque must be nonnegative")
        _equal_float(
            stop_metric_value,
            final_torque_apm,
            "relaxation stop metric value",
        )
        if (
            final_torque_apm > requested_tolerance_apm
            or final_torque_t > requested_tolerance_t
        ):
            raise ExecutionError("mixed-P1 relaxation torque exceeds 1e-6 T")
    energy_terms = _object(
        qualification.get("final_energy_terms_j"), "final energy terms"
    )
    expected_scalars = {
        "E_ex": _finite(energy_terms.get("E_ex"), "final_energy_terms_j.E_ex"),
        "E_demag": _finite(
            energy_terms.get("E_demag"), "final_energy_terms_j.E_demag"
        ),
        "E_total": _finite(
            energy_terms.get("E_total"), "final_energy_terms_j.E_total"
        ),
        "max_torque_Apm": final_torque_apm,
        "max_torque_T": final_torque_t,
    }
    scalar_step, scalar_values = _scalar_final_values(scalars_path)
    if scalar_step != executed_steps:
        raise ExecutionError("scalars.csv final step does not match runtime qualification")
    for field, expected in expected_scalars.items():
        _cross_check_scalar(scalar_values[field], expected, field)
    if final.get("observable") != "m" or final.get("unit") != "dimensionless":
        raise ExecutionError("m_final.json has invalid observable identity")
    if final.get("step") != executed_steps:
        raise ExecutionError("m_final.json step does not match runtime qualification")
    final_provenance = _object(final.get("provenance"), "m_final.json provenance")
    if final_provenance.get("source_hash") != expected_source_hash:
        raise ExecutionError("m_final.json source identity does not match bounded source")
    if (
        final_provenance.get("execution_engine") != engine
        or final_provenance.get("precision") != "double"
    ):
        raise ExecutionError("m_final.json runtime identity does not match metadata")
    values = final.get("values")
    node_count = mesh.get("node_count")
    if isinstance(node_count, bool) or not isinstance(node_count, int) or node_count < 1:
        raise ExecutionError("mesh node_count must be a positive integer")
    if not isinstance(values, list) or len(values) != node_count:
        raise ExecutionError("m_final.json vector count does not match mesh node_count")
    for index, vector in enumerate(values):
        if (
            not isinstance(vector, list)
            or len(vector) != 3
            or any(
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                for value in vector
            )
        ):
            raise ExecutionError(f"m_final.json vector {index} is malformed")
    magnetic_nodes = _magnetic_node_indices(metadata, node_count)
    recomputed_norm_defect = max(
        abs(
            math.sqrt(
                sum(float(component) * float(component) for component in values[index])
            )
            - 1.0
        )
        for index in magnetic_nodes
    )
    recorded_norm_defect = _finite(qualification.get("norm_defect"), "norm_defect")
    if abs(recomputed_norm_defect - recorded_norm_defect) > DIMENSIONLESS_RECOMPUTATION_ATOL:
        raise ExecutionError(
            "m_final.json recomputed norm defect does not match relaxation qualification"
        )
    if recorded_norm_defect > MAX_MAGNETIZATION_NORM_DEFECT:
        raise ExecutionError("final magnetization norm defect exceeds the frozen bound")
    gpu_telemetry: dict[str, int] | None = None
    if spec["device"] == "gpu":
        gpu_telemetry = _validate_gpu_execution(
            metadata,
            execution,
            qualification,
            executed_steps,
            execution_identity
            if execution_identity is not None
            else _object(None, "pinned execution identity"),
        )
    try:
        runtime_log = log_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise ExecutionError("runtime log is unreadable") from error
    if f"resolved_engine_id={engine} fallback=None" not in runtime_log:
        raise ExecutionError("runtime log does not prove the exact engine with no fallback")
    evidence = {
        "execution_engine": engine,
        "executed_steps": executed_steps,
        "topology_fingerprint": fingerprint,
        "certificate_fingerprint": certificate["topology_fingerprint"],
        "bounded_source_sha256": expected_source_hash,
        "recomputed_norm_defect": recomputed_norm_defect,
        "final_scalar_values": scalar_values,
        "metadata_sha256": _sha256_file(metadata_path),
        "scalars_sha256": _sha256_file(scalars_path),
        "m_final_sha256": _sha256_file(final_path),
        "runtime_log_sha256": _sha256_file(log_path),
        "final_magnetization": values,
    }
    if gpu_telemetry is not None:
        evidence["gpu_transfer_telemetry"] = gpu_telemetry
    if execution_identity is not None:
        evidence["execution_identity"] = execution_identity
    return evidence


def _parity_scalar(
    label: str,
    cpu: object,
    gpu: object,
    *,
    rtol: float,
    atol: float,
) -> dict[str, float | str]:
    cpu_value = _finite(cpu, f"CPU {label}")
    gpu_value = _finite(gpu, f"GPU {label}")
    delta = abs(cpu_value - gpu_value)
    allowed = atol + rtol * max(abs(cpu_value), abs(gpu_value))
    if delta > allowed:
        raise ExecutionError(
            f"Stage 3 CPU/GPU {label} parity failed: delta={delta}, allowed={allowed}"
        )
    return {
        "cpu": cpu_value,
        "gpu": gpu_value,
        "absolute_delta": delta,
        "allowed_delta": allowed,
        "status": "pass",
    }


def _compare_stage3_pairs(
    cases: Sequence[dict[str, object]],
    evidence_by_run_id: dict[str, dict[str, object]],
) -> list[dict[str, object]]:
    pair_candidates = [
        spec
        for spec in cases
        if spec.get("layers") == 1
        and spec.get("mesh_level") == "medium"
        and spec.get("airbox_id") == "baseline"
    ]
    algorithms = sorted({str(spec["relaxation_algorithm"]) for spec in pair_candidates})
    pairs: list[dict[str, object]] = []
    for algorithm in algorithms:
        lanes = {
            str(spec["device"]): spec
            for spec in pair_candidates
            if spec.get("relaxation_algorithm") == algorithm
        }
        if set(lanes) != {"cpu", "gpu"}:
            raise ExecutionError(
                f"Stage 3 CPU/GPU pair is incomplete for {algorithm}"
            )
        cpu = evidence_by_run_id[str(lanes["cpu"]["run_id"])]
        gpu = evidence_by_run_id[str(lanes["gpu"]["run_id"])]
        if cpu.get("topology_fingerprint") != gpu.get("topology_fingerprint"):
            raise ExecutionError("Stage 3 CPU/GPU topology fingerprint mismatch")
        if cpu.get("certificate_fingerprint") != gpu.get("certificate_fingerprint"):
            raise ExecutionError("Stage 3 CPU/GPU certificate identity mismatch")
        cpu_vectors = cpu.get("final_magnetization")
        gpu_vectors = gpu.get("final_magnetization")
        if not isinstance(cpu_vectors, list) or not isinstance(gpu_vectors, list):
            raise ExecutionError("Stage 3 CPU/GPU final magnetization is unavailable")
        if len(cpu_vectors) != len(gpu_vectors) or not cpu_vectors:
            raise ExecutionError("Stage 3 CPU/GPU final magnetization shapes differ")
        component_deltas: list[float] = []
        for cpu_vector, gpu_vector in zip(cpu_vectors, gpu_vectors, strict=True):
            if (
                not isinstance(cpu_vector, list)
                or not isinstance(gpu_vector, list)
                or len(cpu_vector) != 3
                or len(gpu_vector) != 3
            ):
                raise ExecutionError("Stage 3 CPU/GPU final magnetization is malformed")
            component_deltas.extend(
                abs(float(left) - float(right))
                for left, right in zip(cpu_vector, gpu_vector, strict=True)
            )
        max_delta = max(component_deltas)
        if max_delta > bounded_gate.STATE_MAX_COMPONENT_ATOL:
            raise ExecutionError(
                "Stage 3 CPU/GPU final magnetization parity failed: "
                f"delta={max_delta}, allowed={bounded_gate.STATE_MAX_COMPONENT_ATOL}"
            )
        cpu_scalars = _object(cpu.get("final_scalar_values"), "CPU final scalars")
        gpu_scalars = _object(gpu.get("final_scalar_values"), "GPU final scalars")
        energy = {
            field: _parity_scalar(
                field,
                cpu_scalars.get(field),
                gpu_scalars.get(field),
                rtol=bounded_gate.ENERGY_RTOL,
                atol=bounded_gate.ENERGY_ATOL_J,
            )
            for field in ("E_ex", "E_demag", "E_total")
        }
        torque = {
            "max_torque_Apm": _parity_scalar(
                "max_torque_Apm",
                cpu_scalars.get("max_torque_Apm"),
                gpu_scalars.get("max_torque_Apm"),
                rtol=bounded_gate.TORQUE_RTOL,
                atol=bounded_gate.TORQUE_ATOL_APM,
            ),
            "max_torque_T": _parity_scalar(
                "max_torque_T",
                cpu_scalars.get("max_torque_T"),
                gpu_scalars.get("max_torque_T"),
                rtol=bounded_gate.TORQUE_RTOL,
                atol=bounded_gate.TORQUE_ATOL_T,
            ),
        }
        pairs.append(
            {
                "relaxation_algorithm": algorithm,
                "cpu_run_id": lanes["cpu"]["run_id"],
                "gpu_run_id": lanes["gpu"]["run_id"],
                "topology_fingerprint": cpu["topology_fingerprint"],
                "certificate_fingerprint": cpu["certificate_fingerprint"],
                "final_magnetization": {
                    "max_component_abs_delta": max_delta,
                    "allowed_delta": bounded_gate.STATE_MAX_COMPONENT_ATOL,
                    "status": "pass",
                },
                "final_energy_terms_j": energy,
                "final_torque": torque,
                "field_parity": {
                    "status": "not_available_in_matrix_artifacts",
                    "qualification_claimed": False,
                },
                "status": "pass",
            }
        )
    if len(pairs) != 3:
        raise ExecutionError(f"Stage 3 requires exactly three CPU/GPU pairs; got {len(pairs)}")
    return pairs


def execute_matrix(
    report_root: Path,
    *,
    durable_root: Path,
    max_steps: int = 50_000,
    evidence_mode: str = FULL_MATRIX_CONVERGENCE,
    launch: Launch = _default_launch,
    runtime_manifest: Path = DEFAULT_RUNTIME_MANIFEST,
) -> dict[str, object]:
    if isinstance(max_steps, bool) or max_steps <= 0:
        raise ExecutionError("max_steps must be a positive integer")
    if evidence_mode not in EVIDENCE_MODES:
        raise ExecutionError(f"unsupported mixed SP4 evidence mode: {evidence_mode}")
    if evidence_mode == ONE_STEP_RUNTIME_SMOKE and max_steps != 1:
        raise ExecutionError("one-step runtime smoke requires max_steps=1")
    report_root, durable_root = _validated_report_root(report_root, durable_root)
    _validate_durable_storage(durable_root)
    report_root.parent.mkdir(parents=True, exist_ok=True)
    with _execution_lock(report_root):
        plan_root = report_root / "plans"
        captured_source = planner._source_identity()
        plans = [
            planner.build_plan(
                stage,
                output_dir=plan_root / stage,
                source_identity=captured_source,
            )
            for stage in planner.STAGES
        ]
        snapshot_ids = {plan["source_snapshot_sha256"] for plan in plans}
        if len(snapshot_ids) != 1:
            raise ExecutionError("mixed SP4 matrix plans do not share one source snapshot")
        cases = collect_execution_cases(plans)
        _preflight_output_paths(report_root, cases)
        execution_identity = _pin_execution_identity(
            plans, report_root, runtime_manifest
        )
        emitted_plans = [
            planner.emit_plan(
                stage,
                plan_root / stage,
                source_identity=captured_source,
            )
            for stage in planner.STAGES
        ]
        if [plan["plan_sha256"] for plan in emitted_plans] != [
            plan["plan_sha256"] for plan in plans
        ]:
            raise ExecutionError("mixed SP4 matrix source changed during plan emission")
        summary = _summary_base(plans, cases, max_steps, evidence_mode)
        summary["durable_root"] = str(durable_root)
        summary["report_root"] = str(report_root)
        summary["execution_identity"] = execution_identity
        _write_json_new(report_root / SUMMARY_FILENAME, summary)

        evidence_by_run_id: dict[str, dict[str, object]] = {}
        for spec in cases:
            try:
                _assert_execution_identity(
                    execution_identity,
                    plan_root=plan_root,
                    runtime_manifest=runtime_manifest,
                )
            except ExecutionError as error:
                summary["status"] = "failed"
                summary["failed_case"] = {
                    "run_id": spec["run_id"],
                    "failure_kind": "identity_drift",
                    "failure_detail": str(error),
                }
                _write_json(report_root / SUMMARY_FILENAME, summary)
                raise
            artifact_dir = report_root / str(spec["artifact_path"])
            artifact_dir, _ = _validated_report_root(artifact_dir, report_root)
            case_dir = artifact_dir.parent
            manifest_path = case_dir / RUN_MANIFEST
            log_path = case_dir / RUNTIME_LOG
            _require_new_case_paths(spec, artifact_dir, case_dir)
            case_dir.mkdir(parents=True, exist_ok=True)
            environment = _environment(spec, max_steps)
            manifest: dict[str, object] = {
                "schema": RUN_SCHEMA,
                "status": "running",
                "qualifying": False,
                "qualification_claim": planner.QUALIFICATION_CLAIM,
                "deferred_axes": list(planner.DEFERRED_AXES),
                "evidence_mode": evidence_mode,
                "scientific_scope": {
                    "status": (
                        "execution_only_deferred"
                        if spec["stage_id"] in {"stage1_layers", "stage2_airbox"}
                        else "runtime_pair_evidence_only"
                    ),
                    "convergence_claimed": False,
                },
                "run_spec": spec,
                "environment": environment,
                "execution_identity": execution_identity,
                "plan_sha256": next(
                    plan["plan_sha256"]
                    for plan in plans
                    if plan["requested_stage"] == spec["stage_id"]
                ),
            }
            _write_json_new(manifest_path, manifest)
            summary["executed_case_count"] = int(summary["executed_case_count"]) + 1
            _write_json(report_root / SUMMARY_FILENAME, summary)
            print(f"[fem-sp4-mixed] running {spec['run_id']}", flush=True)
            try:
                exit_status = launch(spec, artifact_dir, environment, log_path)
            except OSError as error:
                manifest["status"] = "failed"
                manifest["failure_kind"] = "launcher_error"
                manifest["failure_detail"] = str(error)
                _write_json(manifest_path, manifest)
                summary["status"] = "failed"
                summary["failed_case"] = {
                    "run_id": spec["run_id"],
                    "failure_kind": "launcher_error",
                    "failure_detail": str(error),
                }
                _write_json(report_root / SUMMARY_FILENAME, summary)
                raise ExecutionError(
                    f"{spec['run_id']} launcher failed: {error}"
                ) from error
            manifest["exit_status"] = exit_status
            if exit_status != 0:
                manifest["status"] = "failed"
                _write_json(manifest_path, manifest)
                summary["status"] = "failed"
                summary["failed_case"] = {
                    "run_id": spec["run_id"],
                    "exit_status": exit_status,
                }
                _write_json(report_root / SUMMARY_FILENAME, summary)
                raise ExecutionError(
                    f"{spec['run_id']} exited with status {exit_status}"
                )
            try:
                _assert_execution_identity(
                    execution_identity,
                    plan_root=plan_root,
                    runtime_manifest=runtime_manifest,
                )
            except ExecutionError as error:
                manifest["status"] = "failed"
                manifest["failure_kind"] = "identity_drift"
                manifest["failure_detail"] = str(error)
                _write_json(manifest_path, manifest)
                summary["status"] = "failed"
                summary["failed_case"] = {
                    "run_id": spec["run_id"],
                    "exit_status": exit_status,
                    "failure_kind": "identity_drift",
                    "failure_detail": str(error),
                }
                _write_json(report_root / SUMMARY_FILENAME, summary)
                raise
            try:
                evidence = _validate_case_artifacts(
                    spec,
                    artifact_dir,
                    log_path,
                    max_steps,
                    execution_identity,
                    evidence_mode,
                )
            except ExecutionError as error:
                missing = [
                    name
                    for name in REQUIRED_ARTIFACTS
                    if not os.path.lexists(artifact_dir / name)
                ]
                manifest["status"] = "failed"
                manifest["failure_kind"] = "invalid_artifacts"
                manifest["failure_detail"] = str(error)
                if missing:
                    manifest["missing_artifacts"] = missing
                _write_json(manifest_path, manifest)
                summary["status"] = "failed"
                summary["failed_case"] = {
                    "run_id": spec["run_id"],
                    "exit_status": exit_status,
                    "failure_kind": "invalid_artifacts",
                    "failure_detail": str(error),
                }
                if missing:
                    failed_case = summary["failed_case"]
                    assert isinstance(failed_case, dict)
                    failed_case["missing_artifacts"] = missing
                _write_json(report_root / SUMMARY_FILENAME, summary)
                raise
            persisted_evidence = dict(evidence)
            persisted_evidence.pop("final_magnetization", None)
            manifest["artifact_evidence"] = persisted_evidence
            manifest["status"] = "completed_nonqualifying"
            _write_json(manifest_path, manifest)
            evidence_by_run_id[str(spec["run_id"])] = evidence
            completed = summary["completed_run_ids"]
            assert isinstance(completed, list)
            completed.append(spec["run_id"])
            summary["completed_case_count"] = len(completed)
            _write_json(report_root / SUMMARY_FILENAME, summary)

        try:
            summary["stage3_cpu_gpu_pairs"] = _compare_stage3_pairs(
                cases, evidence_by_run_id
            )
        except ExecutionError as error:
            summary["status"] = "failed"
            summary["failed_case"] = {
                "failure_kind": "stage3_cpu_gpu_pair",
                "failure_detail": str(error),
            }
            _write_json(report_root / SUMMARY_FILENAME, summary)
            raise
        summary["status"] = "completed_nonqualifying"
        _write_json(report_root / SUMMARY_FILENAME, summary)
        return summary


def _parse_arguments(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--durable-root", type=Path, required=True)
    parser.add_argument("--report-root", type=Path, required=True)
    parser.add_argument("--max-steps", type=int, default=50_000)
    parser.add_argument(
        "--evidence-mode",
        choices=EVIDENCE_MODES,
        default=FULL_MATRIX_CONVERGENCE,
    )
    parser.add_argument(
        "--runtime-manifest", type=Path, default=DEFAULT_RUNTIME_MANIFEST
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parse_arguments(argv)
    try:
        summary = execute_matrix(
            arguments.report_root,
            durable_root=arguments.durable_root,
            max_steps=arguments.max_steps,
            evidence_mode=arguments.evidence_mode,
            runtime_manifest=arguments.runtime_manifest,
        )
    except (ExecutionError, planner.PlanError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summary, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
