#!/usr/bin/env python3
"""Proof one real managed GPU study through the public Docker workspace API.

The existing ``verify_docker_all_runtime.py`` proves that a run is owned by
the managed Windows storage and by the pinned two-service Compose project.
This driver adds the application proof after those checks: it imports a
canonical Python source through the public same-origin API, prepares and
submits the exact immutable Study inputs supplied by the caller, observes one
accepted task to terminal success, and validates the native GPU artifacts and
released resource lease in the receipt-owned container.

``--study-input`` is intentionally required.  The API does not derive a
StudyPlan or StudyProblemCatalog from the SceneDocument produced by the
script-import endpoint; silently inventing those inputs would make this a
fake acceptance proof.

This is a runtime proof, not a scientific parity or qualification test.  It
does not stop, restart, remove, or prune any container.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import fullmag_storage as storage
import verify_docker_all_runtime as runtime


VERIFICATION_SCHEMA = "fullmag.docker-fem-gpu-workspace-verification.v1"
MAX_INPUT_BYTES = 4 * 1024 * 1024
MAX_API_BYTES = 16 * 1024 * 1024
MAX_CONTAINER_JSON_BYTES = 16 * 1024 * 1024
MAX_EVIDENCE_BYTES = 128 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,160}$")
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

REQUIRED_ROUTES = (
    "/v2/platform/capabilities",
    "/v2/platform/openapi.json",
    "/v2/persistence/projects/from-script",
    "/v2/persistence/projects/{project_id}/run-intent",
    "/v2/persistence/projects/{project_id}/runs",
    "/v2/persistence/projects/{project_id}/runs/{run_id}",
    "/v2/persistence/projects/{project_id}/runs/{run_id}/materialization",
)

LIFECYCLE_RANK = {
    "accepted": 0,
    "queued": 1,
    "preparing": 2,
    "running": 3,
    "stopping": 4,
    "succeeded": 5,
}
TERMINAL_FAILURES = {"failed", "cancelled", "interrupted"}
ACTIVE_LEASE_STATES = {"active", "held", "claimed"}


class ProofError(RuntimeError):
    """A fail-closed workspace proof failure."""


@dataclass(frozen=True)
class Lane:
    name: str
    backend: str
    snapshot_schema: str
    snapshot_file: str


LANES = {
    "fem-gpu": Lane(
        "fem-gpu",
        "fem",
        "fullmag.fem.gpu.accepted-state-snapshot.v1",
        "solver/fem_gpu_accepted_state_snapshot.v1.json",
    ),
    "fdm-gpu": Lane(
        "fdm-gpu",
        "fdm",
        "fullmag.fdm.gpu.accepted-state-snapshot.v1",
        "solver/fdm_gpu_accepted_state_snapshot.v1.json",
    ),
}


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProofError(f"JSON document contains duplicate key {key!r}")
        result[key] = value
    return result


def _parse_json_bytes(raw: bytes, label: str, *, maximum: int = MAX_API_BYTES) -> Any:
    if len(raw) > maximum:
        raise ProofError(f"{label} exceeds the bounded read limit")
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, ProofError) as error:
        raise ProofError(f"{label} is not valid bounded JSON: {error}") from error


def _require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProofError(f"{label} must be a JSON object")
    return value


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProofError(f"{label} must be a non-empty string")
    return value


def _require_digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ProofError(f"{label} must be a canonical sha256 digest")
    return value


def _json_digest(value: Any) -> str:
    """Match Fullmag's canonical JSON digest for typed, scalar receipts."""
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _sha256_prefixed(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _canonical_field(data: bytearray, value: bytes) -> None:
    data.extend(len(value).to_bytes(8, "big"))
    data.extend(value)


def _observation_clock_digest(clock: Mapping[str, Any]) -> str:
    accepted_step = clock.get("accepted_step")
    time_seconds = clock.get("time_seconds")
    dt_seconds = clock.get("dt_seconds")
    if not isinstance(accepted_step, int) or accepted_step <= 0:
        raise ProofError("accepted GPU state clock accepted_step must be positive")
    if not isinstance(time_seconds, (int, float)) or not math.isfinite(float(time_seconds)):
        raise ProofError("accepted GPU state clock time_seconds must be finite")
    if dt_seconds is not None and (
        not isinstance(dt_seconds, (int, float))
        or not math.isfinite(float(dt_seconds))
        or float(dt_seconds) <= 0
    ):
        raise ProofError("accepted GPU state clock dt_seconds is invalid")
    # Rust hashes f64::to_bits, not a textual float representation.
    raw = bytearray()
    _canonical_field(raw, b"fullmag.observation-clock.v1")
    _canonical_field(raw, accepted_step.to_bytes(8, "big", signed=False))
    import struct

    _canonical_field(raw, struct.pack(">d", float(time_seconds)))
    if dt_seconds is None:
        _canonical_field(raw, b"\x00")
    else:
        _canonical_field(raw, b"\x01")
        _canonical_field(raw, struct.pack(">d", float(dt_seconds)))
    return _sha256_prefixed(bytes(raw))


def _accepted_state_digests(clock: Mapping[str, Any], carriers: Mapping[str, bytes]) -> tuple[str, str]:
    """Reproduce fullmag-quantities accepted_state_digests for small envelopes."""
    clock_bytes = bytearray()
    _canonical_field(clock_bytes, b"fullmag.observation-clock.v1")
    accepted_step = clock.get("accepted_step")
    time_seconds = clock.get("time_seconds")
    dt_seconds = clock.get("dt_seconds")
    if not isinstance(accepted_step, int) or accepted_step <= 0:
        raise ProofError("accepted state accepted_step must be positive")
    if not isinstance(time_seconds, (int, float)) or not math.isfinite(float(time_seconds)):
        raise ProofError("accepted state time_seconds must be finite")
    import struct

    _canonical_field(clock_bytes, accepted_step.to_bytes(8, "big", signed=False))
    _canonical_field(clock_bytes, struct.pack(">d", float(time_seconds)))
    if dt_seconds is None:
        _canonical_field(clock_bytes, b"\x00")
    else:
        if not isinstance(dt_seconds, (int, float)) or not math.isfinite(float(dt_seconds)) or float(dt_seconds) <= 0:
            raise ProofError("accepted state dt_seconds is invalid")
        _canonical_field(clock_bytes, b"\x01")
        _canonical_field(clock_bytes, struct.pack(">d", float(dt_seconds)))
    state_bytes = bytearray()
    _canonical_field(state_bytes, b"fullmag.accepted-state.v1")
    _canonical_field(state_bytes, bytes(clock_bytes))
    ordered = sorted(carriers.items())
    if not ordered:
        raise ProofError("accepted state has no primary carriers")
    _canonical_field(state_bytes, len(ordered).to_bytes(8, "big", signed=False))
    for carrier_id, carrier_bytes in ordered:
        if not carrier_id or not isinstance(carrier_bytes, bytes):
            raise ProofError("accepted state carrier is malformed")
        _canonical_field(state_bytes, carrier_id.encode("utf-8"))
        _canonical_field(state_bytes, carrier_bytes)
    return _sha256_prefixed(bytes(clock_bytes)), _sha256_prefixed(bytes(state_bytes))


def _redact(value: Any, *, key: str = "") -> Any:
    normalized = key.lower()
    if normalized in {"archive_base64", "text"} and isinstance(value, str):
        return {"bytes": len(value.encode("utf-8")), "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest()}
    if any(token in normalized for token in ("lease_token", "secret", "authorization", "password")):
        return "<redacted>"
    if isinstance(value, dict):
        return {str(item_key): _redact(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, list):
        return [_redact(item, key=key) for item in value[:64]]
    return value


def _bounded_response_summary(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _bounded_response_summary(item) for key, item in list(value.items())[:128]}
    if isinstance(value, list):
        return [_bounded_response_summary(item) for item in value[:16]]
    if isinstance(value, str) and len(value) > 1024:
        return {"bytes": len(value.encode("utf-8")), "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest()}
    return value


class ApiClient:
    """Bounded same-origin JSON client; it never targets backend port 8081."""

    def __init__(self, receipt_url: str, evidence_root: Path):
        parsed = urllib.parse.urlparse(receipt_url)
        if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.port is None:
            raise ProofError("run receipt URL must be a loopback HTTP URL")
        self.base = f"{parsed.scheme}://{parsed.netloc}"
        self.port = parsed.port
        self.evidence_root = evidence_root
        self.sequence = 0

    def request(self, method: str, path: str, body: Mapping[str, Any] | None = None) -> tuple[int, Any]:
        if not path.startswith("/v2/") or "8081" in self.base:
            raise ProofError("workspace proof may use only the public same-origin API")
        self.sequence += 1
        sequence = f"api-{self.sequence:04d}"
        request_value = _redact(body) if body is not None else None
        runtime._write_json(self.evidence_root / f"{sequence}-request.json", {
            "method": method,
            "url": self.base + path,
            "body": request_value,
        })
        encoded = None
        headers = {"Accept": "application/json"}
        if body is not None:
            encoded = json.dumps(body, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(encoded) > MAX_API_BYTES:
                raise ProofError(f"request {path} exceeds bounded API request size")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=encoded, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=15.0) as response:
                raw = response.read(MAX_API_BYTES + 1)
                status = int(response.status)
        except urllib.error.HTTPError as error:
            raw = error.read(MAX_API_BYTES + 1)
            status = int(error.code)
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise ProofError(f"same-origin API request {path} failed: {error}") from error
        if len(raw) > MAX_API_BYTES:
            raise ProofError(f"API response {path} exceeds bounded response size")
        try:
            document = _parse_json_bytes(raw, f"API response {path}")
        except ProofError:
            document = {"raw_sha256": hashlib.sha256(raw).hexdigest(), "raw_bytes": len(raw)}
        runtime._write_json(self.evidence_root / f"{sequence}-response.json", {
            "status": status,
            "url": self.base + path,
            "body": _redact(_bounded_response_summary(document)),
        })
        if status < 200 or status >= 300:
            raise ProofError(f"same-origin API {method} {path} returned HTTP {status}: {_bounded_response_summary(document)}")
        return status, document


def _read_input(path: Path) -> dict[str, Any]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ProofError("--study-input must be an existing regular absolute file")
    raw = path.read_bytes()
    document = _parse_json_bytes(raw, "study input", maximum=MAX_INPUT_BYTES)
    return _require_mapping(document, "study input")


def _load_lane_inputs(path: Path, lane: Lane) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, str]]:
    document = _read_input(path)
    study_plan = _require_mapping(document.get("study_plan"), "study input.study_plan")
    catalog = _require_mapping(document.get("study_problem_catalog"), "study input.study_problem_catalog")
    authored = document.get("run_authoring")
    if authored is None:
        intent = _require_mapping(document.get("run_intent"), "study input.run_intent")
        specification = _require_mapping(intent.get("specification"), "study input.run_intent.specification")
        authored = {
            "parameters": specification.get("parameters", {}),
            "seeds": specification.get("seeds", {}),
            "dependencies": specification.get("dependencies", []),
            "scheduling_priority": specification.get("scheduling_priority", 0),
            "requested_execution": specification.get("requested_execution"),
        }
    authored = _require_mapping(authored, "study input.run_authoring")
    requested = _require_mapping(authored.get("requested_execution"), "run_authoring.requested_execution")
    expected = {"backend": lane.backend, "device": "gpu", "precision": "double", "mode": "strict"}
    if {key: requested.get(key) for key in expected} != expected:
        raise ProofError(f"study input requested_execution must be exact {expected}")
    generated = dict(authored)
    generated["run_id"] = f"run-docker-{lane.name}-{uuid.uuid4().hex}"
    generated["idempotency_key"] = f"docker-proof-{lane.name}-{uuid.uuid4().hex}"
    for key, default in (("parameters", {}), ("seeds", {}), ("dependencies", []), ("scheduling_priority", 0)):
        generated.setdefault(key, default)
    if not isinstance(generated["parameters"], dict) or not isinstance(generated["seeds"], dict) or not isinstance(generated["dependencies"], list) or not isinstance(generated["scheduling_priority"], int):
        raise ProofError("study input run_authoring has invalid scalar fields")
    asset_paths = document.get("asset_paths", {})
    if not isinstance(asset_paths, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in asset_paths.items()):
        raise ProofError("study input.asset_paths must be a string map")
    return study_plan, catalog, generated, dict(asset_paths)


def _canonical_script(lane: Lane) -> str:
    return f'''import fullmag as fm

study = fm.study("docker_{lane.name.replace('-', '_')}_workspace")
study.engine("{lane.backend}")
study.device("gpu", precision="double")
study.mode("strict")
body = study.geometry(fm.Box(20e-9, 20e-9, 5e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.1
body.m = fm.texture.uniform(1, 0, 0)
study.run(1e-12)
'''


def _validate_openapi(document: Any) -> dict[str, Any]:
    document = _require_mapping(document, "OpenAPI document")
    paths = document.get("paths")
    if not isinstance(paths, dict):
        raise ProofError("OpenAPI document has no paths object")
    missing = [route for route in REQUIRED_ROUTES if route not in paths]
    if missing:
        raise ProofError("public API is missing required immutable study routes: " + ", ".join(missing))
    return {"status": "PASS", "route_count": len(paths), "required_routes": list(REQUIRED_ROUTES)}


def _validate_capabilities(document: Any) -> dict[str, Any]:
    document = _require_mapping(document, "capabilities response")
    return {"status": "PASS", "sha256": _json_digest(document), "keys": sorted(document)[:64]}


def _project_path(project_id: str, suffix: str = "") -> str:
    if not ID_RE.fullmatch(project_id):
        raise ProofError("API returned an unsafe project identity")
    return "/v2/persistence/projects/" + urllib.parse.quote(project_id, safe="._-") + suffix


def _run_path(project_id: str, run_id: str, suffix: str = "") -> str:
    if not ID_RE.fullmatch(run_id):
        raise ProofError("API returned an unsafe run identity")
    return _project_path(project_id, "/runs/" + urllib.parse.quote(run_id, safe="._-") + suffix)


def _requested_execution(value: Any, lane: Lane) -> dict[str, Any]:
    requested = _require_mapping(value, "requested_execution")
    expected = {"backend": lane.backend, "device": "gpu", "precision": "double", "mode": "strict"}
    for key, wanted in expected.items():
        if requested.get(key) != wanted:
            raise ProofError(f"API run requested_execution.{key} is {requested.get(key)!r}, expected {wanted!r}")
    return {key: requested.get(key) for key in expected}


def _task_summary(task: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: task.get(key)
        for key in (
            "task_id", "lifecycle", "readiness", "observation", "attempt_id",
            "ownership_epoch", "resolved_input_fingerprint", "artifact_ids",
            "resource_id", "accepted_state_ref",
        )
    }


def _validate_task_progress(document: Any, project_id: str, run_id: str, lane: Lane, history: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    document = _require_mapping(document, "run resource")
    if document.get("project_id") != project_id or document.get("run_id") != run_id:
        raise ProofError("run resource identity differs from the accepted API identity")
    _requested_execution(document.get("requested_execution"), lane)
    if document.get("catalog_state") != "materialized" or not isinstance(document.get("catalog_revision"), int):
        raise ProofError("accepted run has no materialized task catalog")
    tasks = document.get("tasks")
    if not isinstance(tasks, list) or len(tasks) != 1:
        raise ProofError("workspace proof requires exactly one accepted task")
    task = _require_mapping(tasks[0], "run task")
    task_id = _require_string(task.get("task_id"), "run task.task_id")
    lifecycle = task.get("lifecycle")
    if lifecycle in TERMINAL_FAILURES:
        raise ProofError(f"accepted GPU task reached terminal failure lifecycle {lifecycle!r}")
    if lifecycle not in LIFECYCLE_RANK:
        raise ProofError(f"accepted GPU task has unknown lifecycle {lifecycle!r}")
    previous = history[-1]["lifecycle"] if history else None
    if previous is not None and LIFECYCLE_RANK[lifecycle] < LIFECYCLE_RANK[previous]:
        raise ProofError(f"accepted GPU task lifecycle regressed from {previous!r} to {lifecycle!r}")
    summary = _task_summary(task)
    history.append({"lifecycle": lifecycle, "task": summary})
    if lifecycle != "succeeded":
        return task, {"task_id": task_id, "lifecycle": lifecycle, "terminal": False}
    accepted_ref = task.get("accepted_state_ref")
    if not isinstance(accepted_ref, dict):
        raise ProofError("succeeded GPU task has no accepted_state_ref")
    return task, {
        "task_id": task_id,
        "lifecycle": lifecycle,
        "terminal": True,
        "poll_count": len(history),
        "distinct_lifecycles": sorted({entry["lifecycle"] for entry in history}, key=lambda value: LIFECYCLE_RANK[value]),
    }


def _find_execution_provenance(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        direct = value.get("execution_provenance")
        if isinstance(direct, dict):
            return direct
        if any(
            key in value
            for key in (
                "execution_engine",
                "fdm_gpu_execution_receipt",
                "fem_gpu_execution_receipt",
                "execution_resolution",
            )
        ):
            return value
        for child in value.values():
            found = _find_execution_provenance(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_execution_provenance(child)
            if found:
                return found
    return {}


def _validate_resolution(provenance: Mapping[str, Any], lane: Lane) -> dict[str, Any]:
    resolution = provenance.get("execution_resolution")
    resolution = _require_mapping(resolution, "final artifact execution_resolution")
    expected = {"backend": lane.backend, "device": "gpu", "precision": "double", "mode": "strict"}
    for section in ("authored_request", "effective_request", "resolved_execution"):
        request = _require_mapping(resolution.get(section), f"execution_resolution.{section}")
        for key, wanted in expected.items():
            if request.get(key) != wanted:
                raise ProofError(f"{section}.{key} does not prove the requested GPU lane")
    if resolution.get("resolution_mode") != "exact" or resolution.get("fallback_occurred") is not False or resolution.get("fallback_reason") is not None:
        raise ProofError("final artifact execution_resolution records fallback or non-exact resolution")
    return {"resolution_mode": resolution["resolution_mode"], "fallback_occurred": False}


def _mask(receipt: Mapping[str, Any], key: str) -> int:
    value = receipt.get(key)
    if not isinstance(value, int) or value < 0:
        raise ProofError(f"GPU receipt {key} is invalid")
    return value


def _validate_fdm_receipt(provenance: Mapping[str, Any]) -> dict[str, Any]:
    receipt = _require_mapping(provenance.get("fdm_gpu_execution_receipt"), "FDM GPU execution receipt")
    required = {"requested": "gpu", "resolved": "device_resident", "executed": "cuda_fdm", "device": "cuda:0", "precision": "double"}
    for key, wanted in required.items():
        if receipt.get(key) != wanted:
            raise ProofError(f"FDM GPU receipt {key} is {receipt.get(key)!r}, expected {wanted!r}")
    if receipt.get("fallback_count") != 0 or receipt.get("accounting_valid") is not True:
        raise ProofError("FDM GPU receipt permits fallback or has invalid accounting")
    required_mask = _mask(receipt, "required_operator_mask")
    if required_mask == 0 or _mask(receipt, "resolved_device_operator_mask") != required_mask or _mask(receipt, "executed_device_operator_mask") != required_mask:
        raise ProofError("FDM GPU receipt has no required device operator mask")
    for key in ("resolved_host_operator_mask", "resolved_unknown_operator_mask", "executed_host_operator_mask", "executed_unknown_operator_mask"):
        if _mask(receipt, key) != 0:
            raise ProofError(f"FDM GPU receipt contains non-device {key}")
    transfer = _require_mapping(receipt.get("transfer_counts"), "FDM GPU transfer_counts")
    for key in (
        "hot_loop_full_vector_h2d_count",
        "hot_loop_full_vector_h2d_bytes",
        "hot_loop_full_vector_d2h_count",
        "hot_loop_full_vector_d2h_bytes",
        "hot_loop_host_compute_count",
    ):
        if transfer.get(key) != 0:
            raise ProofError(f"FDM GPU receipt records hot-loop host activity in {key}")
    if not isinstance(receipt.get("operator_residency"), list) or not receipt["operator_residency"]:
        raise ProofError("FDM GPU receipt has no operator residency evidence")
    for operator in receipt["operator_residency"]:
        operator = _require_mapping(operator, "FDM GPU operator residency")
        if operator.get("location") not in {"device", "host_scalar"}:
            raise ProofError("FDM GPU receipt contains a non-device operator")
    policy = receipt.get("precision_policy")
    policy = _require_mapping(policy, "FDM GPU precision_policy")
    if policy.get("requested") != "double" or policy.get("requested") != receipt.get("precision") or policy.get("accounting_valid") is not True:
        raise ProofError("FDM GPU precision policy is not strict double")
    resolved_components = _require_mapping(policy.get("resolved"), "precision_policy.resolved")
    executed_components = _require_mapping(policy.get("executed"), "precision_policy.executed")
    if resolved_components != executed_components:
        raise ProofError("FDM GPU precision policy resolved/executed components differ")
    for components in (resolved_components, executed_components):
        if any(components.get(key) != "double" for key in ("storage", "compute", "fft", "reduction")):
            raise ProofError("FDM GPU precision policy contains a non-double component")
    if transfer.get("hot_loop_host_sync_count", 0) > transfer.get("hot_loop_control_scalar_host_sync_count", 0):
        raise ProofError("FDM GPU receipt contains an unclassified hot-loop host synchronization")
    workspace = receipt.get("gpu_workspace")
    if workspace is not None:
        workspace = _require_mapping(workspace, "FDM GPU workspace telemetry")
        if workspace.get("setup_complete") is not True or workspace.get("precision") != "double" or workspace.get("accounting_valid") is not True or not isinstance(workspace.get("observed_step_count"), int) or workspace["observed_step_count"] <= 0:
            raise ProofError("FDM GPU workspace telemetry does not prove a completed double step")
    return {"requested": receipt["requested"], "resolved": receipt["resolved"], "executed": receipt["executed"], "device": receipt["device"], "precision": receipt["precision"], "receipt_sha256": _json_digest(receipt)}


def _validate_fem_receipt(provenance: Mapping[str, Any]) -> dict[str, Any]:
    receipt = _require_mapping(provenance.get("fem_gpu_execution_receipt"), "FEM GPU execution receipt")
    required = {"requested": "strict_device", "resolved": "device_resident", "executed": "cuda_fem", "precision": "double", "device_ordinal": 0}
    for key, wanted in required.items():
        if receipt.get(key) != wanted:
            raise ProofError(f"FEM GPU receipt {key} is {receipt.get(key)!r}, expected {wanted!r}")
    if receipt.get("fallback_count") != 0 or receipt.get("accounting_valid") is not True or not isinstance(receipt.get("accepted_step_count"), int) or receipt["accepted_step_count"] <= 0:
        raise ProofError("FEM GPU receipt permits fallback or has no accepted step")
    required_mask = _mask(receipt, "required_operator_mask")
    for key in ("resolved_device_operator_mask", "executed_device_operator_mask"):
        if _mask(receipt, key) != required_mask or required_mask == 0:
            raise ProofError(f"FEM GPU receipt {key} does not equal the required device mask")
    for key in ("resolved_host_operator_mask", "resolved_unknown_operator_mask", "executed_host_operator_mask", "executed_unknown_operator_mask", "hot_loop_compute_h2d_bytes", "hot_loop_compute_d2h_bytes", "hot_loop_compute_host_sync_count"):
        if _mask(receipt, key) != 0:
            raise ProofError(f"FEM GPU receipt records forbidden host activity in {key}")
    return {"requested": receipt["requested"], "resolved": receipt["resolved"], "executed": receipt["executed"], "precision": receipt["precision"], "device_ordinal": receipt["device_ordinal"], "receipt_sha256": _json_digest(receipt)}


def _validate_snapshot(snapshot: Mapping[str, Any], lane: Lane, accepted_ref: Mapping[str, Any], receipt: Mapping[str, Any]) -> dict[str, Any]:
    if snapshot.get("schema_version") != lane.snapshot_schema:
        raise ProofError("accepted state snapshot schema does not match the selected GPU lane")
    clock = _require_mapping(snapshot.get("clock"), "accepted state snapshot.clock")
    _observation_clock_digest(clock)
    if snapshot.get("clock_digest") != accepted_ref.get("id", {}).get("clock_digest") or snapshot.get("state_digest") != accepted_ref.get("id", {}).get("state_digest"):
        raise ProofError("accepted state snapshot identity differs from the API accepted_state_ref")
    if lane.backend == "fdm":
        if snapshot.get("primary_carrier_ids") != ["fdm.gpu.magnetization-digest.f64be.v1"]:
            raise ProofError("FDM GPU snapshot carrier set is not canonical")
        _require_digest(snapshot.get("magnetization_digest"), "FDM GPU magnetization_digest")
        clock_digest, state_digest = _accepted_state_digests(clock, {"fdm.gpu.magnetization-digest.f64be.v1": str(snapshot["magnetization_digest"]).encode("ascii")})
        if snapshot.get("clock_digest") != clock_digest or snapshot.get("state_digest") != state_digest:
            raise ProofError("FDM GPU snapshot carrier digest does not validate")
        return {"schema": snapshot["schema_version"], "clock": clock, "state_digest": snapshot["state_digest"], "gpu_uuid_sidecar": False}
    expected_carriers = [
        "fem.gpu.native-local-node-values-f64le.v1",
        "fem.gpu.native-local-node-map.v1",
        "fem.gpu.native-indexed-geometry.v1",
        "fem.gpu.execution-receipt.v1",
    ]
    if snapshot.get("primary_carrier_ids") != expected_carriers:
        raise ProofError("FEM GPU snapshot carrier set is not canonical")
    gpu_uuid = _require_string(snapshot.get("gpu_uuid"), "FEM GPU snapshot gpu_uuid")
    for key in ("values_sha256", "native_node_map_sha256", "native_indexed_geometry_sha256", "gpu_execution_receipt_sha256", "gpu_execution_identity_sha256"):
        _require_digest(snapshot.get(key), f"FEM GPU snapshot {key}")
    if snapshot.get("gpu_execution_receipt_sha256") != receipt.get("receipt_sha256"):
        raise ProofError("FEM GPU snapshot receipt digest differs from the final typed receipt")
    identity = bytearray()
    for value in (b"fullmag.fem.gpu.execution-identity.v1", str(snapshot["gpu_execution_receipt_sha256"]).encode("ascii"), gpu_uuid.encode("utf-8")):
        _canonical_field(identity, value)
    if _sha256_prefixed(bytes(identity)) != snapshot.get("gpu_execution_identity_sha256"):
        raise ProofError("FEM GPU snapshot execution identity is not bound to receipt and UUID")
    carriers = {
        expected_carriers[0]: str(snapshot["values_sha256"]).encode("ascii"),
        expected_carriers[1]: str(snapshot["native_node_map_sha256"]).encode("ascii"),
        expected_carriers[2]: str(snapshot["native_indexed_geometry_sha256"]).encode("ascii"),
        expected_carriers[3]: bytes(identity),
    }
    clock_digest, state_digest = _accepted_state_digests(clock, carriers)
    if snapshot.get("clock_digest") != clock_digest or snapshot.get("state_digest") != state_digest:
        raise ProofError("FEM GPU snapshot native carrier digest does not validate")
    return {"schema": snapshot["schema_version"], "clock": clock, "state_digest": snapshot["state_digest"], "gpu_uuid": gpu_uuid, "native_map_digest": snapshot["native_node_map_sha256"], "native_geometry_digest": snapshot["native_indexed_geometry_sha256"]}


def _container_artifact_probe(container: str, run_id: str, task: Mapping[str, Any], lane: Lane, log_root: Path) -> dict[str, Any]:
    task_id = _require_string(task.get("task_id"), "task.task_id")
    attempt_id = _require_string(task.get("attempt_id"), "task.attempt_id")
    epoch = task.get("ownership_epoch")
    if not isinstance(epoch, int) or epoch <= 0:
        raise ProofError("succeeded task has no positive ownership_epoch")
    for value, label in ((run_id, "run_id"), (task_id, "task_id"), (attempt_id, "attempt_id")):
        if not ID_RE.fullmatch(value):
            raise ProofError(f"unsafe {label} returned by API")
    probe = r'''
import json, os, pathlib, sys

run_id, task_id, attempt_id, epoch, snapshot_file = sys.argv[1:]
base = pathlib.Path('/state/.fullmag/runs') / run_id / 'worker-attempts' / task_id / attempt_id / ('epoch-' + epoch)
MAX = 16 * 1024 * 1024
def reject_link(path):
    if path.is_symlink():
        raise RuntimeError('artifact path is a symlink: ' + str(path))
def reject_ancestor_links(path, stop):
    current = path
    while True:
        reject_link(current)
        if current == stop:
            break
        if current.parent == current:
            raise RuntimeError('artifact path escaped its state root')
        current = current.parent
def read_json(path):
    reject_link(path)
    st = path.stat()
    if not path.is_file() or st.st_size > MAX:
        raise RuntimeError('artifact is not bounded regular JSON: ' + str(path))
    with path.open('rb') as handle:
        raw = handle.read(MAX + 1)
    if len(raw) > MAX:
        raise RuntimeError('artifact exceeds bounded read: ' + str(path))
    return json.loads(raw.decode('utf-8'))
def summary(value, depth=0):
    if depth > 5:
        return '<depth-limit>'
    if isinstance(value, dict):
        return {key: summary(item, depth + 1) for key, item in list(value.items())[:128]}
    if isinstance(value, list):
        return {'items': len(value), 'head': [summary(item, depth + 1) for item in value[:4]]}
    if isinstance(value, str) and len(value) > 1024:
        import hashlib
        return {'bytes': len(value.encode('utf-8')), 'sha256': hashlib.sha256(value.encode('utf-8')).hexdigest()}
    return value
state_root = pathlib.Path('/state')
reject_ancestor_links(base, state_root)
if not base.is_dir() or base.is_symlink():
    raise RuntimeError('worker attempt directory is missing or linked')
completed = read_json(base / 'worker_execution_completed.v1.json')
final = read_json(base / 'm_final.json')
snapshot = read_json(base / snapshot_file)
def find_provenance(value):
    if isinstance(value, dict):
        if isinstance(value.get('execution_provenance'), dict):
            return value['execution_provenance']
        if any(key in value for key in ('execution_engine', 'fdm_gpu_execution_receipt', 'fem_gpu_execution_receipt', 'execution_resolution')):
            return value
        for child in value.values():
            found = find_provenance(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_provenance(child)
            if found:
                return found
    return {}
leases = []
# The accepted Docker store is mounted at /state, but its canonical run
# records live below the immutable project store.  Worker attempts and
# resource leases share that store-relative run identity; do not look under
# the legacy host-side /.fullmag path, which can contain an unrelated marker.
lease_root = pathlib.Path('/state/runs/docker-all/session-store/runs') / run_id / 'resource_leases'
if lease_root.is_dir() and not lease_root.is_symlink():
    reject_ancestor_links(lease_root, state_root)
    for path in sorted(lease_root.glob('*/*.json')):
        reject_link(path)
        reject_ancestor_links(path.parent, state_root)
        document = read_json(path)
        binding = document.get('host_launch_binding') if isinstance(document, dict) else None
        uuids = []
        def collect(value, key=''):
            if isinstance(value, dict):
                for child_key, child in value.items():
                    if child_key in ('exclusive_gpu_uuids', 'gpu_uuids', 'device_uuids', 'allowed_gpu_uuids') and isinstance(child, list):
                        uuids.extend(item for item in child if isinstance(item, str))
                    if child_key == 'gpu_vram_bytes_by_uuid' and isinstance(child, dict):
                        uuids.extend(item for item in child if isinstance(item, str))
                    collect(child, child_key)
            elif isinstance(value, list):
                for child in value:
                    collect(child, key)
        collect(binding)
        leases.append({'path': str(path.relative_to(pathlib.Path('/state'))), 'resource_id': document.get('resource_id'), 'schema_version': document.get('schema_version'), 'state': document.get('state'), 'kind': document.get('kind'), 'run_id': document.get('run_id'), 'task_id': document.get('task_id'), 'attempt_id': document.get('attempt_id'), 'ownership_epoch': document.get('ownership_epoch'), 'budget': summary(document.get('budget')), 'gpu_uuids': sorted(set(uuids)), 'host_launch_binding': summary(binding)})
if not leases:
    raise RuntimeError('accepted run has no durable resource lease evidence')
print(json.dumps({'base': str(base), 'completed': summary(completed), 'final': summary(final), 'snapshot': summary(snapshot), 'execution_provenance': summary(find_provenance(final)), 'leases': leases}, sort_keys=True, separators=(',', ':')))
'''
    result = runtime._docker_exec(container, ("/usr/local/bin/python3", "-c", probe, run_id, task_id, attempt_id, str(epoch), lane.snapshot_file), timeout=60.0, log_root=log_root, log_name=f"{lane.name}-artifact-probe")
    value = runtime._parse_json_bytes(result.stdout, f"{lane.name} container artifact probe", maximum=MAX_CONTAINER_JSON_BYTES)
    return _require_mapping(value, f"{lane.name} container artifact probe")


def _validate_artifacts(probe: Mapping[str, Any], lane: Lane, task: Mapping[str, Any], accepted_ref: Mapping[str, Any]) -> dict[str, Any]:
    completed = _require_mapping(probe.get("completed"), "worker completion receipt")
    if completed.get("schema_version") != "fullmag.accepted_worker_execution.v1" or completed.get("status") != "completed" or not isinstance(completed.get("completed_step_count"), int) or completed["completed_step_count"] <= 0:
        raise ProofError("worker completion receipt does not prove terminal successful execution")
    if completed.get("accepted_state_ref") != accepted_ref:
        raise ProofError("worker completion receipt accepted_state_ref differs from API resource")
    final = _require_mapping(probe.get("final"), "final magnetization artifact")
    provenance = _require_mapping(probe.get("execution_provenance"), "final execution provenance")
    resolution = _validate_resolution(provenance, lane)
    receipt = _validate_fem_receipt(provenance) if lane.backend == "fem" else _validate_fdm_receipt(provenance)
    snapshot = _validate_snapshot(_require_mapping(probe.get("snapshot"), "accepted state snapshot"), lane, accepted_ref, receipt)
    lease_documents = probe.get("leases")
    if not isinstance(lease_documents, list) or not lease_documents:
        raise ProofError("no resource lease documents were returned")
    expected_run_id = _require_mapping(accepted_ref.get("id"), "accepted_state_ref.id").get("run_id")
    expected_task_id = _require_string(task.get("task_id"), "task.task_id")
    expected_attempt_id = _require_string(task.get("attempt_id"), "task.attempt_id")
    expected_epoch = task.get("ownership_epoch")
    if not isinstance(expected_run_id, str) or not isinstance(expected_epoch, int) or expected_epoch <= 0:
        raise ProofError("accepted task identity is incomplete")
    if any(
        not isinstance(lease, dict)
        or lease.get("kind") != "gpu"
        or lease.get("schema_version") != "resource_lease.v1"
        or lease.get("state") not in {"active", "released"}
        or lease.get("run_id") != expected_run_id
        or lease.get("task_id") != expected_task_id
        or lease.get("attempt_id") != expected_attempt_id
        or lease.get("ownership_epoch") != expected_epoch
        or not isinstance(lease.get("budget"), dict)
        or not isinstance(lease["budget"].get("gpu_memory_bytes"), int)
        or lease["budget"]["gpu_memory_bytes"] <= 0
        or not isinstance(lease.get("host_launch_binding"), dict)
        or lease["host_launch_binding"].get("schema_version") != "host_launch_binding.v1"
        for lease in lease_documents
    ):
        raise ProofError("GPU task lease evidence is not an exact host-bound GPU lease")
    gpu_uuids = sorted({uuid_value for lease in lease_documents if isinstance(lease, dict) for uuid_value in (lease.get("gpu_uuids") or []) if isinstance(uuid_value, str) and uuid_value})
    if not gpu_uuids:
        raise ProofError("GPU task has no real ledger GPU UUID in its host launch binding")
    if lane.backend == "fem" and snapshot.get("gpu_uuid") not in gpu_uuids:
        raise ProofError("FEM accepted-state GPU UUID differs from the authoritative lease binding")
    if lane.backend == "fdm" and len(gpu_uuids) != 1:
        raise ProofError("FDM accepted-state has no single host-ledger GPU UUID to bind the CUDA ordinal")
    active = [lease for lease in lease_documents if isinstance(lease, dict) and lease.get("state") in ACTIVE_LEASE_STATES]
    if active:
        raise ProofError("terminal accepted task still has an active resource lease")
    resource_ids = sorted({lease.get("resource_id") for lease in lease_documents if isinstance(lease.get("resource_id"), str) and lease.get("resource_id")})
    task_resource_id = task.get("resource_id")
    if task_resource_id is not None and task_resource_id not in resource_ids:
        raise ProofError("terminal GPU task resource identity differs from its lease evidence")
    if not resource_ids:
        raise ProofError("terminal GPU task has no lease resource identity")
    return {
        "completion": {"schema": completed["schema_version"], "status": completed["status"], "completed_step_count": completed["completed_step_count"]},
        "execution_resolution": resolution,
        "gpu_execution_receipt": receipt,
        "accepted_state_snapshot": snapshot,
        "lease_release": {"status": "PASS", "lease_count": len(lease_documents), "gpu_uuids": gpu_uuids, "resource_id": task_resource_id or resource_ids[0]},
    }


def _write_failure(root: Path, message: str) -> None:
    try:
        (root / "failure.txt").write_text(message + "\n", encoding="utf-8")
    except OSError:
        pass


def verify(repo: Path, run_receipt: Path, study_input: Path, lane_name: str, *, timeout_seconds: int = 3600) -> dict[str, Any]:
    lane = LANES.get(lane_name)
    if lane is None:
        raise ProofError(f"unsupported GPU lane {lane_name!r}")
    if os.name != "nt":
        raise ProofError("run this proof with native Windows Python so the Docker Desktop and storage attestations are visible")
    if not 30 <= timeout_seconds <= 24 * 3600:
        raise ProofError("timeout_seconds must be between 30 and 86400")
    receipt, assembly, layout, run_root, state, assembly_path = runtime._validate_run_bundle(repo.resolve(), run_receipt)
    if receipt.get("frontend_mode") != "dev":
        raise ProofError("workspace API proof requires a dev frontend run receipt")
    with storage.build_lock(layout):
        receipt, assembly, layout, run_root, state, assembly_path = runtime._validate_run_bundle(repo.resolve(), run_receipt)
        verification_id = uuid.uuid4().hex
        verification_root = storage.validate_path(state / "verification" / verification_id, state, "FEM/FDM workspace verification root")
        verification_root.parent.mkdir(exist_ok=True)
        verification_root.mkdir(exist_ok=False, mode=0o700)
        verifier_path = verification_root / "verification-receipt.json"
        verifier: dict[str, Any] = {
            "schema": VERIFICATION_SCHEMA,
            "state": "starting",
            "qualification": "runtime_workspace_gpu_api_not_scientific_parity",
            "lane": lane.name,
            "run_receipt": str(Path(run_receipt).resolve()),
            "run_root": str(run_root),
            "state_root": str(state),
            "assembly_receipt": str(assembly_path),
            "source_commit": assembly.get("commit"),
            "image_id": receipt.get("image_id"),
            "verification_id": verification_id,
            "resources_retained_on_failure": True,
            "unit_tests_compiled": False,
        }
        runtime._write_json(verifier_path, verifier)
        try:
            verifier["storage_attestation"] = runtime._validate_storage_attestation(receipt, assembly, run_root, state)
            backend_document, container_attestation = runtime._validate_container(receipt, assembly, run_root, state, verification_root)
            if container_attestation.get("frontend_mode") != "dev":
                raise ProofError("validated runtime topology is not a dev frontend")
            container = str(receipt["container_id"])
            public_port = int(container_attestation["port"])
            client = ApiClient(str(receipt["url"]), verification_root)
            if client.port != public_port:
                raise ProofError("public API URL port differs from the validated frontend port")
            verifier["container_attestation"] = {
                "backend_container_id": container,
                "frontend_container_id": container_attestation.get("frontend_container_id"),
                "image_id": receipt.get("image_id"),
                "network": receipt.get("network_id"),
                "public_port": public_port,
                "source_root": receipt.get("source_root"),
                "package_root": assembly.get("package_root"),
                "frontend_inputs": container_attestation.get("frontend"),
            }
            status, capabilities = client.request("GET", "/v2/platform/capabilities")
            verifier["capabilities"] = _validate_capabilities(capabilities)
            status, openapi = client.request("GET", "/v2/platform/openapi.json")
            verifier["openapi"] = _validate_openapi(openapi)
            study_plan, catalog, authoring, asset_paths = _load_lane_inputs(study_input, lane)
            script = _canonical_script(lane)
            source_sha256 = hashlib.sha256(script.encode("utf-8")).hexdigest()
            project_name = f"docker-{lane.name}-{uuid.uuid4().hex[:12]}"
            _, imported = client.request("POST", "/v2/persistence/projects/from-script", {
                "source": {"name": f"{project_name}.py", "text": script},
                "script_item_id": None,
                "project_name": project_name,
                "origin": "managed-docker-workspace-gpu-proof",
                "consent": {"executed_by_user": True},
            })
            imported = _require_mapping(imported, "from-script response")
            project_id = _require_string(imported.get("project_id"), "from-script project_id")
            revision = imported.get("revision")
            if not isinstance(revision, int) or revision < 0:
                raise ProofError("from-script response has no valid definition revision")
            archive = _require_string(imported.get("archive_base64"), "from-script archive_base64")
            script_import = _require_mapping(imported.get("script_import"), "from-script script_import")
            if script_import.get("sha256") != source_sha256:
                raise ProofError("from-script source digest differs from the submitted canonical source")
            fidelity = _require_mapping(script_import.get("fidelity"), "from-script script fidelity")
            if fidelity.get("scene_exported") is not True:
                raise ProofError("from-script did not export a canonical SceneDocument")
            verifier["script_import"] = {"project_id": project_id, "revision": revision, "source_sha256": source_sha256, "scene_exported": True}
            _, prepared = client.request("POST", _project_path(project_id, "/run-intent"), {
                "archive_base64": archive,
                "expected_revision": revision,
                "run_authoring": authoring,
                "study_plan": study_plan,
                "study_problem_catalog": catalog,
                "asset_paths": asset_paths,
            })
            prepared = _require_mapping(prepared, "run-intent response")
            if prepared.get("project_id") != project_id or prepared.get("definition_revision") != revision:
                raise ProofError("run-intent response identity differs from imported project")
            canonical_intent = _require_mapping(prepared.get("run_intent"), "run-intent canonical run_intent")
            specification = _require_mapping(canonical_intent.get("specification"), "canonical run_intent.specification")
            _requested_execution(specification.get("requested_execution"), lane)
            run_id = _require_string(specification.get("run_id"), "canonical run_intent run_id")
            verifier["prepared_run_intent"] = {"run_id": run_id, "payload_fingerprint": prepared.get("payload_fingerprint"), "requested_execution": specification.get("requested_execution")}
            _, submitted = client.request("POST", _project_path(project_id, "/runs"), {
                "archive_base64": archive,
                "run_intent": canonical_intent,
                "study_plan": study_plan,
                "study_problem_catalog": catalog,
                "asset_paths": asset_paths,
            })
            submitted = _require_mapping(submitted, "run submit response")
            if submitted.get("disposition") != "accepted" or submitted.get("run_id") != run_id:
                raise ProofError("run submit was not a new accepted durable run")
            verifier["submission"] = {"disposition": submitted.get("disposition"), "execution_state": submitted.get("execution_state"), "run_id": run_id, "payload_fingerprint": submitted.get("payload_fingerprint")}
            _, materialized = client.request("POST", _run_path(project_id, run_id, "/materialization"))
            materialized = _require_mapping(materialized, "run materialization response")
            task_ids = materialized.get("task_ids")
            if materialized.get("execution_state") != "pending_preparation" or not isinstance(task_ids, list) or len(task_ids) != 1 or not all(isinstance(item, str) for item in task_ids):
                raise ProofError("run materialization did not create exactly one pending task")
            verifier["materialization"] = {"execution_state": materialized.get("execution_state"), "catalog_revision": materialized.get("catalog_revision"), "task_ids": task_ids}
            history: list[dict[str, Any]] = []
            deadline = time.monotonic() + timeout_seconds
            task: dict[str, Any] | None = None
            progress: dict[str, Any] | None = None
            while time.monotonic() < deadline:
                _, run_document = client.request("GET", _run_path(project_id, run_id))
                task, progress = _validate_task_progress(run_document, project_id, run_id, lane, history)
                if progress.get("terminal"):
                    break
                time.sleep(1.0)
            if task is None or progress is None or not progress.get("terminal"):
                raise ProofError("accepted GPU task did not reach terminal success before timeout")
            accepted_ref = _require_mapping(task.get("accepted_state_ref"), "task.accepted_state_ref")
            verifier["progress"] = progress
            probe = _container_artifact_probe(container, run_id, task, lane, verification_root)
            verifier["artifacts"] = _validate_artifacts(probe, lane, task, accepted_ref)
            verifier["state"] = "succeeded"
            verifier["health"] = "PASS"
        except Exception as error:
            verifier.update(state="failed_resources_retained", error=str(error))
            _write_failure(verification_root, str(error))
            raise
        finally:
            runtime._write_json(verifier_path, verifier)
        return verifier


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--study-input", type=Path, required=True, help="canonical JSON containing study_plan and study_problem_catalog")
    parser.add_argument("--lane", choices=sorted(LANES), required=True, help="GPU accepted-study lane to exercise")
    parser.add_argument("run_receipt", type=Path, help="receipt.json produced by docker-all start")
    parser.add_argument("--timeout-seconds", type=int, default=3600)
    args = parser.parse_args(argv)
    try:
        result = verify(args.repo_root, args.run_receipt, args.study_input, args.lane, timeout_seconds=args.timeout_seconds)
    except Exception as error:
        print(f"Docker GPU workspace proof failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"receipt": str(Path(args.run_receipt).resolve()), **result}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
