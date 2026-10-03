"""Run one receipt-bound frozen signed-fifteen probe through the managed FEM runtime."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence

import de_frozen_v2_runtime_adapter as adapter
import freeze_signed_de_probe_inputs as freezer
import run_comsol_dispersion_benchmark as managed
import run_de_100nm_pilot as pilot
import validate_de_frozen_v2_probe as validator


REQUEST_SCHEMA = validator.REQUEST_SCHEMA
RESULT_SCHEMA = validator.RESULT_SCHEMA
RESOURCE_SCHEMA = "fullmag.de.frozen_v2_probe.resource_allocation.v1"
PROBE_CASE = pilot.SIGNED_FIFTEEN_PILOT
EXPECTED_RESOURCE_OVERRIDE = (
    "services:\n"
    "  fem-modal-cpu:\n"
    "    network_mode: none\n"
    "    volumes: !reset []\n"
    "    cpus: 4.0\n"
    "    mem_limit: 8g\n"
)
RESOURCE_CHECK_SCRIPT = r'''python3 - <<'PY'
import json
import math
import os
from pathlib import Path

required_cpu = 4.0
required_memory = 8 * 1024**3
cpu_fields = Path("/sys/fs/cgroup/cpu.max").read_text(encoding="ascii").split()
if len(cpu_fields) != 2 or cpu_fields[0] == "max":
    raise SystemExit("resource allocation evidence requires finite cgroup v2 cpu.max")
try:
    quota = int(cpu_fields[0])
    period = int(cpu_fields[1])
    affinity = len(os.sched_getaffinity(0))
    memory_max = int(Path("/sys/fs/cgroup/memory.max").read_text(encoding="ascii").strip())
except (OSError, ValueError, ZeroDivisionError) as error:
    raise SystemExit(f"resource allocation evidence is invalid: {error}")
if quota <= 0 or period <= 0 or affinity <= 0 or memory_max <= 0:
    raise SystemExit("resource allocation evidence contains non-positive limits")
effective_cpu = min(float(affinity), quota / period)
if effective_cpu < required_cpu or memory_max < required_memory:
    raise SystemExit("resource allocation is below four CPU cores or 8 GiB")
record = {
    "schema_version": "fullmag.de.frozen_v2_probe.resource_allocation.v1",
    "status": "pass",
    "qualification": "NOT VERIFIED",
    "requested_cpu_cores": required_cpu,
    "requested_memory_bytes": required_memory,
    "cpu_quota": quota,
    "cpu_period": period,
    "cpu_affinity_count": affinity,
    "effective_cpu_cores": effective_cpu,
    "memory_max_bytes": memory_max,
    "allocation_sources": ["cgroup_v2_cpu_max", "cgroup_v2_memory_max", "sched_getaffinity"],
}
target = Path("/workspace/benchmark-output/de-smoke-signed-fifteen/validation/resource_allocation.v1.json")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
PY'''


class ProbeLaunchError(RuntimeError):
    """Managed frozen-v2 preflight or execution could not satisfy its contract."""


def _write_new_json(path: Path, value: Mapping[str, Any]) -> bytes:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    try:
        with path.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    except FileExistsError as error:
        raise ProbeLaunchError(f"refusing to replace existing run receipt: {path}") from error
    return raw


def _require_context(context: managed.BuildContext, job_id: str, source_digest: str) -> None:
    if context.job.get("job_id") != job_id:
        raise ProbeLaunchError("managed context job id changed during preflight")
    if context.job.get("source_digest") != source_digest:
        raise ProbeLaunchError("managed runtime source digest differs from the required digest")
    if context.job.get("profile") != managed.CPU_ABI_RUNTIME_PROFILE:
        raise ProbeLaunchError("managed runtime profile must be fem-cpu-slepc-runtime-v2")
    try:
        managed.bind_identity(context.native_identity, context.manifest)
    except (ValueError, KeyError, TypeError) as error:
        raise ProbeLaunchError(f"managed capsule is not bound to its native source identity: {error}") from error
    payload_identity = context.job.get("payload", {}).get("native_source_identity")
    if payload_identity != dict(context.native_identity):
        raise ProbeLaunchError("managed context native identity differs from the completed job receipt")


def _consumer_hashes(repo_root: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for relative in validator._REQUIRED_CONSUMERS:
        path = repo_root.joinpath(*relative.split("/"))
        try:
            if not path.resolve(strict=True).is_relative_to(repo_root):
                raise ProbeLaunchError(f"host consumer escapes repository root: {relative}")
            size, digest = validator._sha256_file(path)
        except (OSError, ValueError) as error:
            raise ProbeLaunchError(f"cannot hash required host consumer {relative}: {error}") from error
        if size <= 0:
            raise ProbeLaunchError(f"required host consumer is empty: {relative}")
        hashes[relative] = digest
    return dict(sorted(hashes.items()))


def _source_and_bundle_bindings(
    context: managed.BuildContext,
    prepared: adapter.PreparedFrozenV2Probe,
    bundle_path: Path,
    storage_root: Path,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    model_identity = {
        "kind": "versioned_standalone_input",
        "commit": prepared.model_source_commit,
        "sha256": prepared.source_model_sha256,
    }
    try:
        manifest = freezer.validate_bundle(bundle_path, storage_root)
        numerics = validator._source_parameters(bundle_path, manifest, prepared.source_model_sha256)
    except (OSError, ValueError, KeyError, TypeError, managed.BenchmarkError) as error:
        raise ProbeLaunchError(f"frozen source receipt gate failed: {error}") from error
    bundle = {
        "path": str(bundle_path.resolve(strict=True)),
        "storage_root": str(storage_root.resolve(strict=True)),
        "container_input_root": prepared.container_input_root,
        "manifest_sha256": prepared.manifest_sha256,
        "file_table_sha256": prepared.closure_file_table_sha256,
        "run_request_sha256": prepared.run_request_sha256,
        "run_result_sha256": prepared.run_result_sha256,
        "metadata_raw_sha256": prepared.metadata_raw_sha256,
        "mesh_ir_raw_sha256": prepared.mesh_ir_raw_sha256,
        "selected_equilibrium_bundle_path": prepared.selected_equilibrium_bundle_path,
        "selected_equilibrium_raw_sha256": prepared.selected_equilibrium_raw_sha256,
        "selected_equilibrium_native_content_sha256": prepared.selected_equilibrium_native_content_sha256,
        "source_mesh_topology_sha256": prepared.source_mesh_topology_sha256,
        "modal_mesh_topology_fingerprint_v3": prepared.modal_mesh_topology_fingerprint_v3,
        "source_sample_indices": list(prepared.source_sample_indices),
        "k_vectors_rad_per_m": [list(vector) for vector in prepared.k_vectors_rad_per_m],
    }
    model = {
        "original": {
            "commit": prepared.model_source_commit,
            "path": prepared.model_source_path,
            "sha256": prepared.source_model_sha256,
        },
        "derived_script_sha256": prepared.runtime_script_sha256,
    }
    return bundle, model, {"numerics": numerics, "manifest": manifest}


def _runtime_environment(prepared: adapter.PreparedFrozenV2Probe, mode: str) -> dict[str, str]:
    return prepared.environment_for_mode(mode)


def _resource_override(output_dir: Path) -> None:
    override = output_dir / "compose.benchmark.override.yaml"
    try:
        actual = override.read_text(encoding="utf-8")
    except OSError as error:
        raise ProbeLaunchError("managed Compose resource override is missing") from error
    if actual != EXPECTED_RESOURCE_OVERRIDE:
        raise ProbeLaunchError("managed Compose resource allocation is not exactly 4 CPU / 8 GiB")


def _insert_resource_evidence(shell: str) -> str:
    marker = 'mkdir "$case_dir"\n'
    if shell.count(marker) != 1:
        raise ProbeLaunchError("managed signed-fifteen command has no unique case directory setup")
    return shell.replace(marker, marker + RESOURCE_CHECK_SCRIPT + "\n", 1)


def compose_probe_command(
    context: managed.BuildContext,
    output_dir: Path,
    prepared: adapter.PreparedFrozenV2Probe,
    storage_root: Path,
    staged_model: Path,
    mode: str,
    numerics: Mapping[str, Any],
    *,
    timeout_seconds: float,
) -> list[str]:
    """Compose the adapter-derived script with the existing managed headless route."""
    if mode not in {"serial", "adaptive"}:
        raise ProbeLaunchError("mode must be serial or adaptive")
    if not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 7 * 24 * 60 * 60:
        raise ProbeLaunchError("timeout must be between 1 and 604800 seconds")
    environment = _runtime_environment(prepared, mode)
    model_meta = numerics.get("model_metadata")
    if not isinstance(model_meta, Mapping):
        raise ProbeLaunchError("receipt-bound model metadata is missing")
    frequency = numerics.get("frequency_window_hz")
    if not isinstance(frequency, list) or len(frequency) != 2:
        raise ProbeLaunchError("receipt-bound full frequency window is missing")
    values = {
        "eps_prefilter": numerics["eps_prefilter"],
        "shifted_ksp_rtol": numerics["shifted_ksp_rtol"],
        "gmres_restart": numerics["gmres_restart"],
        "shifted_ksp_type": numerics["shifted_ksp_type"],
        "frequency_min_ghz": environment["FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ"],
        "frequency_max_ghz": environment["FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ"],
        "mesh_level": environment["FULLMAG_DE_SMOKE_MESH_LEVEL"],
        "thickness_layers": environment["FULLMAG_DE_SMOKE_THICKNESS_LAYERS"],
    }
    command = pilot.compose_command(
        context,
        output_dir,
        timeout_seconds=timeout_seconds,
        pilot=PROBE_CASE,
        external_model=True,
        parallel_mode=mode,
        spectral_target="frequency_window",
        solver_rtol=environment["FULLMAG_DE_SMOKE_SOLVER_RTOL"],
        **values,
    )
    _resource_override(output_dir)
    model_mount = f"{output_dir / 'model-input.py'}:/workspace/benchmark-model.py:ro"
    replacements = [index for index, item in enumerate(command) if item == model_mount]
    if len(replacements) != 1:
        raise ProbeLaunchError("managed command does not contain exactly one derived-model mount")
    command[replacements[0]] = f"{staged_model}:/workspace/benchmark-model.py:ro"
    try:
        launch_check = adapter.verify_bundle_for_launch(prepared, storage_root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ProbeLaunchError(f"frozen bundle changed before command construction: {error}") from error
    if launch_check.get("runtime_script_sha256") != prepared.runtime_script_sha256:
        raise ProbeLaunchError("adapter-derived script hash changed before command construction")
    try:
        bundle_mount_index = next(
            index for index, item in enumerate(command)
            if item == "fem-modal-cpu" and index + 1 < len(command) and command[index + 1] == "timeout"
        )
    except StopIteration as error:
        raise ProbeLaunchError("managed command has no pinned fem-modal-cpu service invocation") from error
    injected = ["-v", f"{prepared.bundle_path}:/workspace/benchmark-input:ro"]
    for key, value in sorted(environment.items()):
        injected.extend(("-e", f"{key}={value}"))
    command[bundle_mount_index:bundle_mount_index] = injected
    command[-1] = _insert_resource_evidence(command[-1])
    return command


def _extra_mounts(prepared: adapter.PreparedFrozenV2Probe, staged_model: Path) -> list[dict[str, Any]]:
    return [
        {
            "type": "bind",
            "source": os.path.abspath(str(staged_model)),
            "destination": "/workspace/benchmark-model.py",
            "read_only": True,
        },
        {
            "type": "bind",
            "source": os.path.abspath(str(prepared.bundle_path)),
            "destination": "/workspace/benchmark-input",
            "read_only": True,
        },
    ]


def _execute_compose(
    context: managed.BuildContext,
    output_dir: Path,
    command: Sequence[str],
    extra_mounts: Sequence[Mapping[str, Any]],
    timeout_seconds: float,
) -> dict[str, Any]:
    compose_log = output_dir / "compose.log"
    host_timeout = math.ceil(
        timeout_seconds
        + managed.CONTAINER_TIMEOUT_GRACE_SECONDS
        + managed.HOST_COMPOSE_GRACE_SECONDS
    )
    started = time.time()
    return_code: int | None = None
    timed_out = False
    interrupted = False
    execution_error: str | None = None
    container_timed_out = False
    try:
        with compose_log.open("x", encoding="utf-8", newline="") as stream:
            completed = subprocess.run(
                list(command),
                cwd=context.layout["repo_root"],
                env=managed._compose_environment(context.layout, context.image_digest),
                stdin=subprocess.DEVNULL,
                stdout=stream,
                stderr=subprocess.STDOUT,
                check=False,
                timeout=host_timeout,
                text=True,
            )
            return_code = completed.returncode
            container_timed_out = return_code == 124
    except subprocess.TimeoutExpired:
        timed_out = True
        execution_error = "host Compose watchdog expired after the solver deadline and grace period"
    except KeyboardInterrupt:
        interrupted = True
        execution_error = "managed probe interrupted by operator"
    except OSError as error:
        execution_error = f"managed Compose probe could not start: {error}"
    try:
        cleanup = managed._cleanup_benchmark_container(
            context, output_dir, extra_mounts=extra_mounts
        )
    except (managed.BenchmarkError, OSError, ValueError, TypeError, KeyboardInterrupt) as error:
        cleanup = {"status": "blocked", "reason": f"exact container cleanup could not be verified: {error}"}
    return {
        "started_at_unix": started,
        "finished_at_unix": time.time(),
        "return_code": return_code,
        "timed_out": timed_out,
        "container_timed_out": container_timed_out,
        "interrupted": interrupted,
        "execution_error": execution_error,
        "cleanup": cleanup,
        "compose_log": "compose.log",
    }


def _stage_derived_model(output_dir: Path, prepared: adapter.PreparedFrozenV2Probe) -> Path:
    stage_dir = output_dir.parent / f".{output_dir.name}.frozen-v2-input"
    if stage_dir.exists() or managed._is_reparse(stage_dir):
        raise ProbeLaunchError(f"derived-model staging path already exists: {stage_dir}")
    stage_dir.mkdir(parents=False, exist_ok=False)
    model_path = stage_dir / "benchmark-model.py"
    try:
        with model_path.open("xb") as stream:
            stream.write(prepared.runtime_script_bytes)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError as error:
        raise ProbeLaunchError(f"cannot stage the adapter-derived probe source: {error}") from error
    size, digest = validator._sha256_file(model_path)
    if size != len(prepared.runtime_script_bytes) or digest != prepared.runtime_script_sha256:
        raise ProbeLaunchError("staged derived-model bytes differ from the frozen adapter")
    return model_path


def _request_value(
    context: managed.BuildContext,
    prepared: adapter.PreparedFrozenV2Probe,
    bundle: Mapping[str, Any],
    model: Mapping[str, Any],
    numerics: Mapping[str, Any],
    repo_root: Path,
    output_dir: Path,
    staged_model: Path,
    mode: str,
    timeout_seconds: float,
    command: Sequence[str],
) -> dict[str, Any]:
    model_identity = {
        "kind": "versioned_standalone_input",
        "commit": prepared.model_source_commit,
        "sha256": prepared.source_model_sha256,
    }
    policy = pilot.signed_fifteen_campaign_identity(model_identity, mode)
    container = managed._container_identity(context, output_dir)
    source = {
        "capsule_relative": context.job["payload"]["capsule_relative"],
        "resolved_commit": context.manifest["resolved_commit"],
        "source_snapshot_sha256": context.native_identity["source_snapshot_sha256"],
        "native_source_identity": dict(context.native_identity),
        "native_source_identity_sha256": hashlib.sha256(
            managed.canonical(context.native_identity)
        ).hexdigest(),
    }
    return {
        "schema_version": REQUEST_SCHEMA,
        "status": "prepared",
        "qualification": "NOT VERIFIED",
        "created_at_unix": time.time(),
        "operation": "de-frozen-v2-managed-probe",
        "repo_root": str(repo_root),
        "output_dir": str(output_dir),
        "mode": mode,
        "mode_policy": policy,
        "job": {
            "job_id": context.job["job_id"],
            "worktree_id": context.job["worktree_id"],
            "profile": context.job["profile"],
            "source_digest": context.job["source_digest"],
        },
        "source": source,
        "runtime": {
            "profile": context.job["profile"],
            "image_digest": context.image_digest,
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "resource_allocation": {"cpu_cores": 4.0, "memory_bytes": 8 * 1024**3},
        },
        "bundle": dict(bundle),
        "model": {
            **dict(model),
            "derived_script_path": str(staged_model),
        },
        "numerics": dict(numerics),
        "samples": [
            {
                "sample_index": index,
                "source_sample_index": prepared.source_sample_indices[index],
                "k_vector_rad_per_m": list(prepared.k_vectors_rad_per_m[index]),
            }
            for index in range(3)
        ],
        "consumer_hashes": _consumer_hashes(repo_root),
        "lifecycle": {
            "container_name": container["name"],
            "container_labels": dict(container["labels"]),
            "container_timeout_seconds": math.ceil(timeout_seconds),
            "host_timeout_seconds": math.ceil(
                timeout_seconds
                + managed.CONTAINER_TIMEOUT_GRACE_SECONDS
                + managed.HOST_COMPOSE_GRACE_SECONDS
            ),
            "cleanup_policy": "exact-id-after-identity-and-mount-attestation",
        },
        "compose_command": list(command),
        "orchestrator_sha256": validator._sha256_file(Path(__file__).resolve())[1],
        "artifact_validation": {
            "status": "pending_native_execution",
            "qualification": "NOT VERIFIED",
        },
    }


def _write_failure_result(
    output_dir: Path,
    request: Mapping[str, Any],
    request_raw: bytes,
    *,
    error: str,
    cleanup: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    case_dir = output_dir / PROBE_CASE
    hashes: dict[str, dict[str, Any]] = {}
    if case_dir.is_dir():
        try:
            hashes = validator.collect_probe_artifact_hashes(case_dir)
        except validator.ProbeValidationError as hash_error:
            error = f"{error}; artifact inventory error: {hash_error}"
    return {
        "schema_version": RESULT_SCHEMA,
        "status": "failed",
        "qualification": "NOT VERIFIED",
        "request_sha256": hashlib.sha256(request_raw).hexdigest(),
        "return_code": None,
        "timed_out": False,
        "execution_error": error,
        "cleanup": dict(cleanup or {"status": "not_started"}),
        "compose_log": "compose.log",
        "mode": request["mode"],
        "job": request["job"],
        "source": request["source"],
        "bundle": request["bundle"],
        "model": request["model"],
        "numerics": request["numerics"],
        "mode_policy": request["mode_policy"],
        "artifacts": {
            "case_artifact_hashes": hashes,
            "native_validation": {"status": "failed", "qualification": "NOT VERIFIED", "error": error},
        },
    }


def run_probe(
    *,
    repo_root: Path,
    job_id: str,
    runtime_source_digest: str,
    bundle_path: Path,
    mode: str,
    output_dir_requested: str,
    timeout_seconds: float,
) -> tuple[int, dict[str, Any]]:
    if mode not in {"serial", "adaptive"}:
        raise ProbeLaunchError("mode must be serial or adaptive")
    if not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 7 * 24 * 60 * 60:
        raise ProbeLaunchError("timeout must be between 1 and 604800 seconds")
    repo_root = repo_root.resolve(strict=True)
    layout = managed.fullmag_storage.resolve_layout(repo_root, "windows-native")
    if Path(layout["repo_root"]).resolve(strict=True) != repo_root:
        raise ProbeLaunchError("storage resolver did not select the requested repository worktree")
    managed.fullmag_storage.initialize(layout)
    job = managed._read_job(layout, job_id)
    if job.get("source_digest") != runtime_source_digest:
        raise ProbeLaunchError("requested runtime source digest differs from the completed job")
    if job.get("profile") != managed.CPU_ABI_RUNTIME_PROFILE:
        raise ProbeLaunchError("job must use the fem-cpu-slepc-runtime-v2 managed profile")
    context = managed._validate_build_context(layout, job)
    _require_context(context, job_id, runtime_source_digest)
    storage_root = Path(layout["storage_root"])
    try:
        prepared = adapter.prepare_frozen_v2_probe(bundle_path, storage_root)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ProbeLaunchError(f"frozen accepted signed-fifteen bundle preflight failed: {error}") from error
    bundle, model, source_values = _source_and_bundle_bindings(context, prepared, bundle_path, storage_root)
    numerics = source_values["numerics"]

    with managed.fullmag_storage.build_lock(layout):
        locked_job = managed._read_job(layout, job_id)
        if locked_job.get("source_digest") != runtime_source_digest:
            raise ProbeLaunchError("managed runtime source digest changed while waiting for storage lock")
        context = managed._validate_build_context(layout, locked_job)
        _require_context(context, job_id, runtime_source_digest)
        try:
            prepared = adapter.prepare_frozen_v2_probe(bundle_path, storage_root)
            adapter.verify_bundle_for_launch(prepared, storage_root)
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ProbeLaunchError(f"frozen bundle failed launch-time verification: {error}") from error
        bundle, model, source_values = _source_and_bundle_bindings(context, prepared, bundle_path, storage_root)
        numerics = source_values["numerics"]
        managed._inspect_image(context.image_digest)
        output_dir = managed._new_output_dir(context, output_dir_requested)
        output_dir.mkdir(parents=True, exist_ok=False)
        staged_model = _stage_derived_model(output_dir, prepared)
        command = compose_probe_command(
            context,
            output_dir,
            prepared,
            storage_root,
            staged_model,
            mode,
            numerics,
            timeout_seconds=timeout_seconds,
        )
        extra_mounts = _extra_mounts(prepared, staged_model)
        request = _request_value(
            context,
            prepared,
            bundle,
            model,
            numerics,
            repo_root,
            output_dir,
            staged_model,
            mode,
            timeout_seconds,
            command,
        )
        request_raw = _write_new_json(output_dir / "run-request.json", request)

        try:
            adapter.verify_bundle_for_launch(prepared, storage_root)
            if _consumer_hashes(repo_root) != request["consumer_hashes"]:
                raise ProbeLaunchError("host consumer sources changed after the request receipt was written")
            staged_size, staged_sha = validator._sha256_file(staged_model)
            if staged_size != len(prepared.runtime_script_bytes) or staged_sha != prepared.runtime_script_sha256:
                raise ProbeLaunchError("derived source changed immediately before managed launch")
            if prepared.environment_for_mode(mode) != _runtime_environment(prepared, mode):
                raise ProbeLaunchError("mode-specific runtime policy changed before launch")
        except (OSError, ValueError, KeyError, TypeError, ProbeLaunchError) as error:
            result = _write_failure_result(output_dir, request, request_raw, error=str(error))
            _write_new_json(output_dir / "run-result.json", result)
            return 2, result

        execution = _execute_compose(context, output_dir, command, extra_mounts, timeout_seconds)
        artifact_error: str | None = None
        case_dir = output_dir / PROBE_CASE
        artifact_hashes: dict[str, dict[str, Any]] = {}
        case_summary: dict[str, Any] | None = None
        if execution["return_code"] == 0 and not execution["timed_out"] and not execution["execution_error"]:
            try:
                adapter.verify_bundle_for_launch(prepared, storage_root)
                if _consumer_hashes(repo_root) != request["consumer_hashes"]:
                    raise ProbeLaunchError("host consumer sources changed during managed execution")
                staged_size, staged_sha = validator._sha256_file(staged_model)
                if staged_size != len(prepared.runtime_script_bytes) or staged_sha != prepared.runtime_script_sha256:
                    raise ProbeLaunchError("adapter-derived source changed during managed execution")
                case_summary = managed._validate_case_artifacts(case_dir, "c1")
                artifact_hashes = validator.collect_probe_artifact_hashes(case_dir)
            except (managed.BenchmarkError, ProbeLaunchError, validator.ProbeValidationError,
                    OSError, ValueError, KeyError, TypeError) as error:
                artifact_error = str(error)
                if case_dir.is_dir():
                    try:
                        artifact_hashes = validator.collect_probe_artifact_hashes(case_dir)
                    except validator.ProbeValidationError as inventory_error:
                        artifact_error += f"; artifact inventory error: {inventory_error}"
        elif case_dir.is_dir():
            try:
                artifact_hashes = validator.collect_probe_artifact_hashes(case_dir)
            except validator.ProbeValidationError as error:
                artifact_error = f"artifact inventory error: {error}"

        successful_process = (
            execution["return_code"] == 0
            and not execution["timed_out"]
            and not execution["interrupted"]
            and execution["execution_error"] is None
            and execution["cleanup"].get("status") != "blocked"
        )
        status = "completed_unqualified" if successful_process else "failed"
        result: dict[str, Any] = {
            "schema_version": RESULT_SCHEMA,
            "status": status,
            "qualification": "NOT VERIFIED",
            "request_sha256": hashlib.sha256(request_raw).hexdigest(),
            **execution,
            "artifact_error": artifact_error,
            "mode": request["mode"],
            "job": request["job"],
            "source": request["source"],
            "bundle": request["bundle"],
            "model": request["model"],
            "numerics": request["numerics"],
            "mode_policy": request["mode_policy"],
            "artifacts": {
                "case_artifact_hashes": artifact_hashes,
                "case_summary": case_summary,
                "native_validation": {
                    "status": "pending",
                    "qualification": "NOT VERIFIED",
                },
            },
            "artifact_validation": {"status": "NOT VERIFIED", "qualification": "NOT VERIFIED"},
        }
        if status == "completed_unqualified" and artifact_error is None and case_dir.is_dir():
            try:
                validation = validator.validate_probe_artifacts_from_values(
                    case_dir,
                    output_dir / "run-request.json",
                    request_raw,
                    request,
                    result,
                )
                result["artifacts"]["native_validation"] = validation
                result["artifact_validation"] = {
                    "status": validation["status"],
                    "qualification": "NOT VERIFIED",
                    "pending_requirements": validation["pending_requirements"],
                }
            except (validator.ProbeValidationError, OSError, ValueError, KeyError, TypeError) as error:
                artifact_error = str(error)
                result["artifact_error"] = artifact_error
                result["artifacts"]["native_validation"] = {
                    "status": "failed",
                    "qualification": "NOT VERIFIED",
                    "error": artifact_error,
                }
                result["artifact_validation"] = {
                    "status": "failed",
                    "qualification": "NOT VERIFIED",
                    "error": artifact_error,
                }
        elif artifact_error is not None:
            result["artifacts"]["native_validation"] = {
                "status": "failed",
                "qualification": "NOT VERIFIED",
                "error": artifact_error,
            }
            result["artifact_validation"] = {
                "status": "failed",
                "qualification": "NOT VERIFIED",
                "error": artifact_error,
            }
        _write_new_json(output_dir / "run-result.json", result)
        return (0 if status == "completed_unqualified" and artifact_error is None else 1), result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--runtime-source-digest", required=True)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--mode", required=True, choices=("serial", "adaptive"))
    parser.add_argument("--output-dir", required=True)
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=managed.DEFAULT_TIMEOUT_SECONDS,
        help="bounded solver deadline used by the existing managed CPU route",
    )
    args = parser.parse_args(argv)
    try:
        exit_code, result = run_probe(
            repo_root=args.repo_root,
            job_id=args.job_id,
            runtime_source_digest=args.runtime_source_digest,
            bundle_path=args.bundle,
            mode=args.mode,
            output_dir_requested=args.output_dir,
            timeout_seconds=args.timeout_seconds,
        )
    except (ProbeLaunchError, managed.BenchmarkError, managed.fullmag_storage.StorageError,
            OSError, ValueError, TypeError, KeyError) as error:
        print(f"de-frozen-v2-probe: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
