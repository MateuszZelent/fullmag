#!/usr/bin/env python3
"""Qualify FEM preview handoff through real CLI, API, and Control Room surfaces."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import signal
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu"
API = ROOT / ".fullmag/runtimes/fem-gpu-host/bin/fullmag-api"


def matrix_python_path(raw: str) -> Path:
    # The venv interpreter is commonly a symlink to the base executable.
    # Resolving it would discard pyvenv.cfg discovery and escape the venv.
    return Path(raw).expanduser().absolute()


PYTHON = matrix_python_path(os.environ.get("FULLMAG_MATRIX_PYTHON", sys.executable))
REQUIRED_MATRIX_PYTHON_MODULES = (
    "numpy",
    "scipy",
    "gmsh",
    "meshio",
    "trimesh",
    "h5py",
    "zarr",
)
FIXTURE = ROOT / "examples/fem_preview_surface_matrix.py"
CONTROL_ROOM_ROOT = ROOT / "apps/control-room/out"
CONTROL_ROOM_SMOKE = ROOT / "apps/control-room/scripts/smoke-fem-preview-freshness.mjs"

MODES = ("disabled", "m", "H_demag", "full_cache")
CADENCES = (10, 25, 50)
MATRIX_MAX_STEPS = max(CADENCES) + 2
SURFACES = ("headless", "interactive_no_browser", "control_room")
TERMINAL_STAGE_STATES = {"completed", "failed", "cancelled", "rejected", "skipped", "stopped"}
PRODUCTION_CALLBACK_DEADLINE_NS = 2_000_000
ENERGY_RELATIVE_TOLERANCE = 5e-8
ENERGY_ABSOLUTE_TOLERANCE_J = 1e-28
ENERGY_DENSITY_TO_SCALAR = {
    "eden_ex": "E_ex",
    "eden_demag": "E_demag",
    "eden_ext": "E_ext",
    "eden_ani": "E_ani",
    "eden_dmi": "E_dmi",
    "eden_total": "E_total",
}
ENERGY_QUALIFICATION = os.environ.get("FULLMAG_TASK5_ENERGY_QUALIFICATION", "")
PROFILE_PERSIST_ARTIFACT = os.environ.get(
    "FULLMAG_MATRIX_PROFILE_PERSIST_ARTIFACT", "0"
).strip().lower() in {"1", "true", "yes", "on"}
FULL_CACHE_TERMINAL_QUANTITIES = (
    "m",
    "H_ex",
    "H_demag",
    "H_ext",
    "H_eff",
    "torque",
    "H_ani_cubic",
    "eden_ex",
    "eden_demag",
    "eden_ext",
    "eden_ani",
    "eden_total",
)
PROFILE_PERSIST_OVERHEAD_FIELDS = (
    "last_persist_wall_time_ns",
    "total_persist_wall_time_ns",
    "persist_enqueued_count",
    "persist_completed_count",
)


def empty_energy_proof() -> dict[str, Any]:
    return {
        "energy_comparisons": None,
        "energy_fixture_cubic": None,
        "energy_qualification": None,
        "energy_fixture_ms_location": None,
        "energy_fixture_regional_ms_range": None,
        "energy_projection_locations": None,
    }


def matrix_csv_columns(rows: list[dict[str, Any]]) -> list[str]:
    """Return the explicit ordered union of public evidence columns."""
    return list(
        dict.fromkeys(
            column
            for row in rows
            for column in row
            if not column.startswith("_")
        )
    )


def matrix_csv_record(
    row: dict[str, Any],
    columns: list[str],
) -> dict[str, Any]:
    """Rectangularize an intentionally heterogeneous evidence row with nulls."""
    return {
        column: row[column] if column in row else None
        for column in columns
    }


def require_matrix_python(python: Path = PYTHON) -> None:
    expected_prefix = python.parent.parent.absolute()
    try:
        probe = subprocess.run(
            [
                str(python),
                "-c",
                (
                    "import importlib, pathlib, sys\n"
                    f"expected_prefix = pathlib.Path({str(expected_prefix)!r})\n"
                    "actual_prefix = pathlib.Path(sys.prefix).absolute()\n"
                    "if actual_prefix != expected_prefix:\n"
                    "    raise SystemExit(\n"
                    "        f'unexpected sys.prefix: {actual_prefix}; expected {expected_prefix}'\n"
                    "    )\n"
                    f"modules = {REQUIRED_MATRIX_PYTHON_MODULES!r}\n"
                    "failed = []\n"
                    "for module in modules:\n"
                    "    try:\n"
                    "        importlib.import_module(module)\n"
                    "    except Exception as error:\n"
                    "        failed.append(f'{module}: {error}')\n"
                    "if failed:\n"
                    "    raise SystemExit('missing required modules: ' + '; '.join(failed))\n"
                ),
            ],
            capture_output=True,
            text=True,
        )
    except OSError as error:
        raise RuntimeError(f"matrix Python preflight failed for {python}: {error}") from error
    if probe.returncode != 0:
        detail = (probe.stderr or probe.stdout or f"exit {probe.returncode}").strip()
        raise RuntimeError(f"matrix Python preflight failed for {python}: {detail}")


def preterminal_quantities_for_mode(mode: str) -> tuple[str, ...]:
    if mode == "m":
        return ("m",)
    if mode == "H_demag":
        return ("H_demag",)
    return ()


def requires_primary_live_proof(mode: str) -> bool:
    return mode in {"m", "H_demag"}


def requires_terminal_full_cache_proof(mode: str) -> bool:
    return mode == "full_cache"


def terminal_quantities_for_mode(mode: str) -> tuple[str, ...]:
    if not requires_terminal_full_cache_proof(mode):
        return ()
    if ENERGY_QUALIFICATION == "dg0_ms":
        return tuple(
            quantity
            for quantity in FULL_CACHE_TERMINAL_QUANTITIES
            if quantity not in {"H_ani_cubic", "eden_ani"}
        )
    if ENERGY_QUALIFICATION == "uniaxial":
        return tuple(
            "H_ani" if quantity == "H_ani_cubic" else quantity
            for quantity in FULL_CACHE_TERMINAL_QUANTITIES
        )
    if ENERGY_QUALIFICATION == "cubic":
        return FULL_CACHE_TERMINAL_QUANTITIES
    without_anisotropy = tuple(
        quantity
        for quantity in FULL_CACHE_TERMINAL_QUANTITIES
        if quantity not in {"H_ani_cubic", "eden_ani"}
    )
    if ENERGY_QUALIFICATION == "interfacial_dmi":
        return without_anisotropy + ("H_dmi", "eden_dmi")
    if ENERGY_QUALIFICATION == "bulk_dmi":
        return without_anisotropy + ("H_dmi_bulk", "eden_dmi")
    return FULL_CACHE_TERMINAL_QUANTITIES


def requires_browser_consumed_response(mode: str, surface: str) -> bool:
    return mode in {"m", "H_demag"} and surface == "control_room"


def requires_browser_pending_state(mode: str, surface: str) -> bool:
    return mode == "full_cache" and surface == "control_room"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-port", type=int, default=18197)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--timeout-seconds", type=float, default=240.0)
    parser.add_argument("--mode", choices=MODES, action="append")
    parser.add_argument("--cadence", choices=CADENCES, type=int, action="append")
    parser.add_argument("--surface", choices=SURFACES, action="append")
    parser.add_argument("--report-dir", type=Path)
    parser.add_argument("--skip-retention-proof", action="store_true")
    return parser.parse_args()


def matrix_api_batches(
    *,
    modes: tuple[str, ...],
    cadences: tuple[int, ...],
    surfaces: tuple[str, ...],
    repeats: int,
) -> Iterator[tuple[tuple[str, int, str, int], ...]]:
    """Keep one warmup and its measured repeats on one bounded API lifecycle."""
    for mode in modes:
        for cadence in cadences:
            for surface in surfaces:
                yield tuple(
                    (mode, cadence, surface, repeat)
                    for repeat in range(repeats + 1)
                )


def require_inputs() -> None:
    required = (RUNTIME, API, PYTHON, FIXTURE, CONTROL_ROOM_SMOKE, CONTROL_ROOM_ROOT / "index.html")
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("preview matrix prerequisites are missing:\n" + "\n".join(missing))


def request_bytes(base: str, path: str, *, timeout: float = 10.0) -> bytes:
    url = base + path
    request = urllib.request.Request(url, headers={"Accept": "application/octet-stream"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"GET {url} failed: HTTP {error.code}: {body}"
        ) from error


def get_json(base: str, path: str, *, timeout: float = 10.0) -> dict[str, Any]:
    request = urllib.request.Request(base + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError(f"GET {path} did not return a JSON object")
    return value


def get_optional_json(
    base: str,
    path: str,
    *,
    timeout: float = 10.0,
) -> dict[str, Any] | None:
    request = urllib.request.Request(base + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status == 204:
            return None
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError(f"GET {path} did not return a JSON object")
    return value


def post_json(base: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10.0) as response:
        value = json.load(response)
    if not isinstance(value, dict):
        raise RuntimeError(f"POST {path} did not return a JSON object")
    return value


def poll(
    label: str,
    timeout_seconds: float,
    read: Callable[[], Any],
) -> Any:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            value = read()
            if value:
                return value
        except (OSError, ValueError, urllib.error.HTTPError) as error:
            last_error = error
        time.sleep(0.1)
    suffix = f": {last_error}" if last_error else ""
    raise RuntimeError(f"timed out waiting for {label}{suffix}")


def wait_api(base: str, process: subprocess.Popen[str], timeout_seconds: float) -> None:
    def ready() -> bool:
        if process.poll() is not None:
            raise RuntimeError(f"fullmag-api exited early with {process.returncode}")
        return get_json(base, "/healthz").get("status") == "ok"

    poll("managed fullmag-api", timeout_seconds, ready)
    request_bytes(base, "/workspace", timeout=10.0)


def stop_api_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=10.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10.0)


@contextmanager
def api_lifecycle(
    *,
    api_base: str,
    api_env: dict[str, str],
    api_log_path: Path,
    label: str,
    timeout_seconds: float,
) -> Iterator[None]:
    with api_log_path.open("a", encoding="utf-8") as api_log:
        api_log.write(f"\n[preview-matrix-api-lifecycle] start {label}\n")
        api_log.flush()
        api = subprocess.Popen(
            [str(API)],
            cwd=ROOT,
            env=api_env,
            stdout=api_log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            wait_api(api_base, api, timeout_seconds)
            yield
        finally:
            stop_api_process(api)


def session_id_or_none(base: str) -> str | None:
    try:
        status = get_json(base, "/v2/sessions/current/status")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise
    session = status.get("session")
    return session.get("session_id") if isinstance(session, dict) else None


def wait_for_new_interactive_session(
    base: str,
    previous_session_id: str | None,
    runtime: subprocess.Popen[str],
    timeout_seconds: float,
) -> str:
    def ready() -> str | None:
        if runtime.poll() is not None:
            raise RuntimeError(f"interactive runtime exited before solve gate with {runtime.returncode}")
        current = session_id_or_none(base)
        if not current or current == previous_session_id:
            return None
        solver = get_json(base, "/v2/sessions/current/simulation/solver/status")
        state = str(solver.get("runtime_state") or solver.get("runtime_status_kind") or "")
        return current if state == "waiting_for_compute" else None

    return poll("new interactive session at waiting_for_compute", timeout_seconds, ready)


def submit_command(base: str, kind: str, reason: str) -> str:
    target = "study" if kind == "solve" else "run"
    response = post_json(
        base,
        "/v2/sessions/current/simulation/commands",
        {
            "client_intent_id": f"fem-preview-matrix:{kind}:{time.time_ns()}",
            "kind": kind,
            "reason": reason,
            "requested_at_unix_ms": int(time.time() * 1000),
            "target": {"kind": target},
        },
    )
    command_id = response.get("command_id")
    if not response.get("accepted") or not isinstance(command_id, str):
        raise RuntimeError(f"{kind} command was rejected: {response}")
    return command_id


def enable_solver_profile(base: str, timeout_seconds: float) -> None:
    response = post_json(
        base,
        "/v2/sessions/current/simulation/commands",
        {
            "client_intent_id": f"fem-preview-matrix:profile:{time.time_ns()}",
            "kind": "set_solver_profile",
            "profile": {
                "enabled": True,
                "sample_every": 1,
                "sample_interval_wall_ms": 0,
                "max_samples": 256,
                "emit_engine_log": False,
                "persist_artifact": PROFILE_PERSIST_ARTIFACT,
            },
            "reason": "fem_preview_surface_matrix_production_callback_proof",
            "requested_at_unix_ms": int(time.time() * 1000),
            "target": {"kind": "study"},
        },
    )
    if not response.get("accepted"):
        raise RuntimeError(f"solver profiler command was rejected: {response}")

    def enabled() -> bool:
        profile = get_json(base, "/v2/sessions/current/diagnostics/solver-profile")
        config = profile.get("config")
        return (
            profile.get("state") == "active"
            and isinstance(config, dict)
            and config.get("enabled") is True
            and config.get("sample_every") == 1
            and config.get("persist_artifact") is PROFILE_PERSIST_ARTIFACT
        )

    poll("enabled production solver profiler", timeout_seconds, enabled)


def execution_is_terminal(base: str) -> bool:
    execution = get_optional_json(base, "/v2/sessions/current/simulation/stages/execution")
    if execution is None:
        return False
    stages = execution.get("stages")
    if not isinstance(stages, list) or not stages:
        return False
    states = {str(stage.get("status")) for stage in stages if isinstance(stage, dict)}
    return bool(states) and states.issubset(TERMINAL_STAGE_STATES)


def wait_terminal_stage(base: str, timeout_seconds: float) -> dict[str, Any]:
    def terminal() -> dict[str, Any] | None:
        execution = get_json(base, "/v2/sessions/current/simulation/stages/execution")
        stages = execution.get("stages")
        if not isinstance(stages, list) or not stages:
            return None
        states = {str(stage.get("status")) for stage in stages if isinstance(stage, dict)}
        if states and states.issubset(TERMINAL_STAGE_STATES):
            failed = states.intersection({"failed", "cancelled", "rejected"})
            if failed:
                raise RuntimeError(f"FEM preview matrix stage ended unsuccessfully: {sorted(failed)}")
            return execution
        return None

    return poll("terminal FEM stage", timeout_seconds, terminal)


def close_interactive_runtime(base: str, runtime: subprocess.Popen[str], timeout_seconds: float) -> None:
    try:
        submit_command(base, "close", "fem_preview_surface_matrix_complete")
    except (RuntimeError, urllib.error.HTTPError):
        pass
    try:
        runtime.wait(timeout=min(10.0, timeout_seconds))
    except subprocess.TimeoutExpired:
        runtime.send_signal(signal.SIGTERM)
        try:
            runtime.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            runtime.kill()
            runtime.wait(timeout=10.0)


def observe_preterminal_field_resources(
    base: str,
    quantities: tuple[str, ...],
    timeout_seconds: float,
) -> dict[str, dict[str, Any]]:
    observed: dict[str, dict[str, Any]] = {}
    deadline = time.monotonic() + timeout_seconds
    last_seen: dict[str, Any] = {}
    while time.monotonic() < deadline:
        if execution_is_terminal(base):
            missing = sorted(set(quantities) - set(observed))
            raise RuntimeError(
                "stage became terminal before required asynchronous field publication: "
                f"missing={missing} last_seen={last_seen}"
            )
        for quantity in quantities:
            if quantity in observed:
                continue
            try:
                meta = get_json(
                    base,
                    f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity, safe='')}/meta",
                )
            except urllib.error.HTTPError as error:
                if error.code in {404, 409}:
                    continue
                raise
            last_seen[quantity] = {
                "source_revision": meta.get("source_revision"),
                "source_step": meta.get("source_step"),
                "state": meta.get("state"),
            }
            source_step = meta.get("source_step")
            if (
                meta.get("state") not in {"complete", "stale_complete"}
                or not isinstance(source_step, int)
                or source_step >= MATRIX_MAX_STEPS
            ):
                continue
            binary = request_bytes(
                base,
                f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity, safe='')}"
                "/samples/vector?component=full&scope_kind=full",
            )
            decoded = decode_fmvp_payload(binary)
            if execution_is_terminal(base):
                continue
            observed[quantity] = {
                "meta": meta,
                "node_indices": decoded["node_indices"],
                "values": decoded["values"],
                "mask_sha256": hashlib.sha256(decoded["mask_bytes"]).hexdigest(),
                "payload_sha256": hashlib.sha256(decoded["value_bytes"]).hexdigest(),
                "observed_before_terminal": True,
            }
        if len(observed) == len(quantities):
            return observed
        time.sleep(0.02)
    missing = sorted(set(quantities) - set(observed))
    raise RuntimeError(
        "timed out waiting for pre-terminal asynchronous field publication: "
        f"missing={missing} last_seen={last_seen}"
    )


def solver_profile_persistence_contract_error(
    *,
    expected: bool,
    configured: object,
    artifact_refs: object,
    persistence_failed: object,
    overhead: object,
) -> str | None:
    if configured is not expected:
        return f"config.persist_artifact={configured!r}, expected {expected}"
    if not isinstance(persistence_failed, bool):
        return f"persistence_failed must be a boolean, got {persistence_failed!r}"
    if persistence_failed:
        return "persistence_failed=true"
    if not isinstance(artifact_refs, list):
        return f"artifact_refs must be a list, got {artifact_refs!r}"
    if not expected:
        return None
    if not artifact_refs or any(
        not isinstance(artifact_ref, str) or not artifact_ref.strip()
        for artifact_ref in artifact_refs
    ):
        return f"persist-on artifact_refs must contain nonempty strings, got {artifact_refs!r}"
    if not isinstance(overhead, dict):
        return f"persist-on overhead must be an object, got {overhead!r}"
    for field in PROFILE_PERSIST_OVERHEAD_FIELDS:
        value = overhead.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return f"persist-on overhead.{field} must be a non-negative integer, got {value!r}"
    if overhead["total_persist_wall_time_ns"] < overhead["last_persist_wall_time_ns"]:
        return "persist-on overhead total_persist_wall_time_ns is below last_persist_wall_time_ns"
    enqueued = overhead["persist_enqueued_count"]
    completed = overhead["persist_completed_count"]
    if enqueued == 0:
        return "persist-on overhead.persist_enqueued_count must be greater than zero"
    if completed != enqueued:
        return (
            "persist-on overhead.persist_completed_count must acknowledge every enqueue: "
            f"completed={completed} enqueued={enqueued}"
        )
    return None


def callback_profile_proof(
    base: str, mode: str, persistence_timeout_seconds: float = 0.0
) -> dict[str, Any]:
    profile = get_json(base, "/v2/sessions/current/diagnostics/solver-profile")
    if mode == "disabled":
        if profile.get("preview_3d_disabled") is not True:
            raise RuntimeError("disabled row did not expose preview_3d_disabled=true")
    config = profile.get("config")
    if profile.get("state") != "active" or not isinstance(config, dict) or not config.get("enabled"):
        raise RuntimeError(f"enabled row lacks an enabled production solver profile: {profile}")
    persistence_deadline = time.monotonic() + persistence_timeout_seconds
    while True:
        config = profile.get("config")
        persistence_error = solver_profile_persistence_contract_error(
            expected=PROFILE_PERSIST_ARTIFACT,
            configured=config.get("persist_artifact") if isinstance(config, dict) else None,
            artifact_refs=profile.get("artifact_refs"),
            persistence_failed=profile.get("persistence_failed"),
            overhead=profile.get("overhead"),
        )
        overhead = profile.get("overhead")
        persistence_pending = (
            PROFILE_PERSIST_ARTIFACT
            and isinstance(overhead, dict)
            and isinstance(overhead.get("persist_enqueued_count"), int)
            and not isinstance(overhead.get("persist_enqueued_count"), bool)
            and isinstance(overhead.get("persist_completed_count"), int)
            and not isinstance(overhead.get("persist_completed_count"), bool)
            and overhead["persist_enqueued_count"] > overhead["persist_completed_count"] >= 0
            and profile.get("persistence_failed") is False
        )
        if persistence_error is None or not persistence_pending or time.monotonic() >= persistence_deadline:
            break
        time.sleep(0.02)
        profile = get_json(base, "/v2/sessions/current/diagnostics/solver-profile")
    if persistence_error is not None:
        raise RuntimeError(
            "enabled row lacks terminal solver-profile persistence proof: "
            f"{persistence_error}"
        )
    persistence_proof = {
        "solver_profile_artifact_refs": profile.get("artifact_refs", []),
        "solver_profile_overhead": profile.get("overhead"),
        "solver_profile_persist_artifact": config.get("persist_artifact") is True,
        "solver_profile_persistence_failed": profile.get("persistence_failed"),
    }
    if mode == "disabled":
        return {
            "callback_deadline_ns": PRODUCTION_CALLBACK_DEADLINE_NS,
            "callback_handoff_count": 0,
            "callback_handoff_max_ns": None,
            "callback_handoff_p50_ns": None,
            "schedule_fence_max_ns": None,
            "schedule_fence_p50_ns": None,
            "callback_plus_fence_max_ns": None,
            "callback_thread_cpu_max_ns": None,
            "callback_thread_cpu_p50_ns": None,
            "callback_wall_outlier_count": 0,
            "callback_wall_outlier_max_ns": None,
            "callback_wall_outlier_details": [],
            **persistence_proof,
            "worst_callback_detail": None,
            "worst_submit_detail": None,
        }
    samples = profile.get("latest_samples")
    if not isinstance(samples, list):
        raise RuntimeError("production solver profile latest_samples is not a list")
    handoff_ns: list[int] = []
    fence_ns: list[int] = []
    end_to_end_ns: list[int] = []
    sample_details: list[dict[str, int]] = []
    for sample in samples:
        if not isinstance(sample, dict) or int(sample.get("step", MATRIX_MAX_STEPS)) >= MATRIX_MAX_STEPS:
            continue
        phases = sample.get("phases")
        if not isinstance(phases, list):
            continue
        phase_times = {
            str(phase.get("id")): int(phase.get("wall_time_ns", 0))
            for phase in phases
            if isinstance(phase, dict)
        }
        fence = phase_times.get("preview_schedule_fence", 0)
        if fence > 0:
            fence_ns.append(fence)
        preview_ns = phase_times.get("preview", 0) + phase_times.get("cached_preview", 0)
        if preview_ns == 0:
            continue
        total = preview_ns + phase_times.get("orchestration", 0)
        handoff_ns.append(total)
        end_to_end_ns.append(total + fence)
        sample_details.append(
            {
                "step": int(sample.get("step", 0)),
                "preview_ns": preview_ns,
                "orchestration_ns": phase_times.get("orchestration", 0),
                "total_ns": total,
                "harvest_query_ns": phase_times.get("preview_harvest_query", 0),
                "result_promotion_ns": phase_times.get("preview_result_promotion", 0),
                "can_accept_ns": phase_times.get("preview_can_accept", 0),
                "vector_snapshot_schedule_ns": phase_times.get(
                    "preview_vector_snapshot_schedule", 0
                ),
                "energy_snapshot_schedule_ns": phase_times.get(
                    "preview_energy_snapshot_schedule", 0
                ),
                "queue_coalescing_ns": phase_times.get("preview_queue_coalescing", 0),
                "submit_ns": phase_times.get("preview_submit", 0),
                "submit_stage_ns": phase_times.get("preview_submit_stage", 0),
                "submit_descriptor_ns": phase_times.get("preview_submit_descriptor", 0),
                "submit_channel_alloc_ns": phase_times.get(
                    "preview_submit_channel_alloc", 0
                ),
                "submit_try_send_ns": phase_times.get("preview_submit_try_send", 0),
                "submit_bookkeeping_ns": phase_times.get(
                    "preview_submit_bookkeeping", 0
                ),
                "submit_thread_cpu_ns": phase_times.get(
                    "preview_submit_thread_cpu", 0
                ),
                "submit_descheduled_ns": max(
                    0,
                    phase_times.get("preview_submit", 0)
                    - phase_times.get("preview_submit_thread_cpu", 0),
                ),
                "callback_thread_cpu_ns": phase_times.get(
                    "preview_callback_thread_cpu", 0
                ),
                "callback_descheduled_ns": max(
                    0,
                    total - phase_times.get("preview_callback_thread_cpu", 0),
                ),
                "schedule_fence_ns": fence,
                "callback_plus_fence_ns": total + fence,
            }
        )
    if not handoff_ns:
        raise RuntimeError("enabled row has no pre-terminal production preview profile samples")
    ordered = sorted(handoff_ns)
    ordered_callback_cpu = sorted(
        detail["callback_thread_cpu_ns"] for detail in sample_details
    )
    ordered_fences = sorted(fence_ns)
    maximum = ordered[-1]
    worst_callback_detail = max(sample_details, key=lambda detail: detail["total_ns"])
    worst_submit_detail = max(sample_details, key=lambda detail: detail["submit_ns"])
    callback_p50 = ordered[len(ordered) // 2]
    if callback_p50 >= PRODUCTION_CALLBACK_DEADLINE_NS:
        raise RuntimeError(
            "production preview handoff p50 exceeded the solver callback deadline: "
            f"p50_ns={callback_p50} deadline_ns={PRODUCTION_CALLBACK_DEADLINE_NS}"
        )
    missing_callback_cpu = [
        detail for detail in sample_details if detail["callback_thread_cpu_ns"] <= 0
    ]
    if missing_callback_cpu:
        raise RuntimeError(
            "production preview handoff is missing callback thread CPU diagnostics: "
            f"samples={missing_callback_cpu}"
        )
    callback_cpu_max = ordered_callback_cpu[-1]
    if callback_cpu_max >= PRODUCTION_CALLBACK_DEADLINE_NS:
        offenders = sorted(
            (
                detail
                for detail in sample_details
                if detail["callback_thread_cpu_ns"] >= PRODUCTION_CALLBACK_DEADLINE_NS
            ),
            key=lambda detail: detail["callback_thread_cpu_ns"],
            reverse=True,
        )
        raise RuntimeError(
            "production preview handoff thread CPU exceeded the solver callback deadline: "
            f"max_ns={callback_cpu_max} deadline_ns={PRODUCTION_CALLBACK_DEADLINE_NS} "
            f"offenders={offenders}"
        )
    wall_outliers = sorted(
        (
            detail
            for detail in sample_details
            if detail["total_ns"] >= PRODUCTION_CALLBACK_DEADLINE_NS
        ),
        key=lambda detail: detail["total_ns"],
        reverse=True,
    )
    unclassified_wall_outliers = [
        detail
        for detail in wall_outliers
        if detail["callback_descheduled_ns"]
        < detail["total_ns"] - PRODUCTION_CALLBACK_DEADLINE_NS
    ]
    if unclassified_wall_outliers:
        raise RuntimeError(
            "production preview handoff wall outlier is not explained by scheduler "
            f"deschedule: offenders={unclassified_wall_outliers}"
        )
    return {
        "callback_deadline_ns": PRODUCTION_CALLBACK_DEADLINE_NS,
        "callback_handoff_count": len(ordered),
        "callback_handoff_max_ns": maximum,
        "callback_handoff_p50_ns": callback_p50,
        "schedule_fence_max_ns": ordered_fences[-1] if ordered_fences else 0,
        "schedule_fence_p50_ns": (
            ordered_fences[len(ordered_fences) // 2] if ordered_fences else 0
        ),
        "callback_plus_fence_max_ns": max(end_to_end_ns, default=maximum),
        "callback_thread_cpu_max_ns": callback_cpu_max,
        "callback_thread_cpu_p50_ns": ordered_callback_cpu[
            len(ordered_callback_cpu) // 2
        ],
        "callback_wall_outlier_count": len(wall_outliers),
        "callback_wall_outlier_max_ns": (
            wall_outliers[0]["total_ns"] if wall_outliers else None
        ),
        "callback_wall_outlier_details": wall_outliers,
        **persistence_proof,
        "worst_callback_detail": worst_callback_detail,
        "worst_submit_detail": worst_submit_detail,
    }


def terminal_field_resource_proof(base: str, mode: str, timeout_seconds: float) -> dict[str, Any]:
    profile = get_json(base, "/v2/sessions/current/diagnostics/solver-profile")
    if mode == "disabled":
        if profile.get("preview_3d_disabled") is not True:
            raise RuntimeError("disabled row did not expose preview_3d_disabled=true")
        return {
            "_field_values": [],
            "field_state": None,
            "mask_sha256": None,
            "payload_sha256": None,
            "source_revision": None,
            "source_step": None,
        }

    quantity = "H_demag" if mode in {"H_demag", "full_cache"} else "m"
    completed = completed_field_resources(
        base,
        (quantity,),
        MATRIX_MAX_STEPS,
        timeout_seconds,
    )[quantity]
    meta = completed["meta"]
    return {
        "_field_values": completed["values"],
        "field_state": meta.get("state"),
        "mask_sha256": completed["mask_sha256"],
        "payload_sha256": completed["payload_sha256"],
        "source_revision": meta.get("source_revision"),
        "source_step": meta.get("source_step"),
    }


def completed_field_resources(
    base: str,
    quantities: tuple[str, ...],
    expected_source_step: int,
    timeout_seconds: float,
) -> dict[str, dict[str, Any]]:
    completed: dict[str, dict[str, Any]] = {}
    last_seen: dict[str, Any] = {}
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        for quantity in quantities:
            if quantity in completed:
                continue
            try:
                meta = get_json(
                    base,
                    f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity, safe='')}/meta",
                )
            except urllib.error.HTTPError as error:
                if error.code in {404, 409}:
                    continue
                raise
            last_seen[quantity] = {
                "source_revision": meta.get("source_revision"),
                "source_step": meta.get("source_step"),
                "state": meta.get("state"),
            }
            if (
                meta.get("state") not in {"complete", "stale_complete"}
                or meta.get("source_step") != expected_source_step
            ):
                continue
            binary = request_bytes(
                base,
                f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity, safe='')}"
                "/samples/vector?component=full&scope_kind=full",
            )
            decoded = decode_fmvp_payload(binary)
            completed[quantity] = {
                "meta": meta,
                "node_indices": decoded["node_indices"],
                "values": decoded["values"],
                "mask_sha256": hashlib.sha256(decoded["mask_bytes"]).hexdigest(),
                "payload_sha256": hashlib.sha256(decoded["value_bytes"]).hexdigest(),
            }
        if len(completed) == len(quantities):
            return completed
        time.sleep(0.02)
    missing = sorted(set(quantities) - set(completed))
    raise RuntimeError(
        "timed out waiting for terminal field materialization: "
        f"missing={missing} expected_source_step={expected_source_step} last_seen={last_seen}"
    )


def decode_fmvp_payload(payload: bytes) -> dict[str, Any]:
    if len(payload) < 48 or payload[:4] != b"FMVP":
        raise RuntimeError("field response is not a valid FMVP payload")
    version, n_comp = payload[4], payload[6]
    metadata_length = struct.unpack_from("<I", payload, 8)[0] if version == 3 else 0
    value_count = struct.unpack_from("<I", payload, 12)[0]
    value_offset = 48 + metadata_length
    expected = value_offset + value_count * 8
    if version not in {2, 3} or n_comp == 0 or len(payload) != expected:
        raise RuntimeError("field response has inconsistent FMVP header lengths")
    point_count = value_count // n_comp
    if version == 2:
        mask = b"legacy_count_only:" + struct.pack("<I", point_count)
        node_indices = list(range(point_count))
    else:
        metadata = payload[48:value_offset]
        if len(metadata) < 68 or metadata[:4] != b"FMMI":
            raise RuntimeError("FMVP v3 metadata is invalid")
        indexing = struct.unpack_from("<I", metadata, 56)[0]
        node_count = struct.unpack_from("<I", metadata, 60)[0]
        scope_kind_length, scope_id_length = struct.unpack_from("<HH", metadata, 64)
        node_start = 68 + scope_kind_length + scope_id_length
        node_end = node_start + node_count * 4
        if node_end > len(metadata):
            raise RuntimeError("FMVP v3 node-index mask exceeds metadata")
        mask = struct.pack("<II", indexing, node_count) + metadata[node_start:node_end]
        node_indices = [
            value[0]
            for value in struct.iter_unpack("<I", metadata[node_start:node_end])
        ]
        if indexing in {0, 3}:
            if node_indices:
                raise RuntimeError("FMVP v3 implicit indexing unexpectedly includes node indices")
            node_indices = list(range(point_count))
        elif indexing in {1, 2}:
            if len(node_indices) != point_count:
                raise RuntimeError(
                    "FMVP v3 explicit node-index count differs from the field point count"
                )
        else:
            raise RuntimeError(f"FMVP v3 field indexing code is unsupported: {indexing}")
    value_bytes = payload[value_offset:]
    return {
        "mask_bytes": mask,
        "node_indices": node_indices,
        "values": [value[0] for value in struct.iter_unpack("<d", value_bytes)],
        "value_bytes": value_bytes,
    }


def artifact_proof(output_dir: Path) -> dict[str, Any]:
    artifact = output_dir / "m_final.json"
    if not artifact.is_file():
        raise RuntimeError(f"missing final magnetization artifact: {artifact}")
    value = json.loads(artifact.read_text(encoding="utf-8"))
    canonical_values = json.dumps(value.get("values"), separators=(",", ":"), allow_nan=False)
    quantized_values = json.dumps(
        [
            [round(float(component), 12) for component in vector]
            for vector in value.get("values", [])
        ],
        separators=(",", ":"),
        allow_nan=False,
    )
    layout = value.get("layout") if isinstance(value.get("layout"), dict) else {}
    canonical_mask = json.dumps(
        {
            "active_mask": layout.get("active_mask"),
            "magnetic_node_indices": layout.get("magnetic_node_indices"),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return {
        "_artifact_m_values": value.get("values", []),
        "artifact_m_mask_sha256": hashlib.sha256(canonical_mask.encode()).hexdigest(),
        "artifact_m_quantized_sha256": hashlib.sha256(quantized_values.encode()).hexdigest(),
        "artifact_m_sha256": hashlib.sha256(canonical_values.encode()).hexdigest(),
    }


def h_demag_terminal_artifact_proof(
    output_dir: Path,
    expected_source_step: int,
) -> dict[str, Any]:
    zarr_dir = output_dir / "fields" / "H_demag.zarr"
    metadata_path = zarr_dir / ".zarray"
    attributes_path = zarr_dir / ".zattrs"
    samples_path = zarr_dir / "samples.csv"
    if not metadata_path.is_file() or not attributes_path.is_file() or not samples_path.is_file():
        raise RuntimeError(f"H_demag Zarr artifact is incomplete: {zarr_dir}")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    attributes = json.loads(attributes_path.read_text(encoding="utf-8"))
    shape = metadata.get("shape")
    chunks = metadata.get("chunks")
    if (
        metadata.get("zarr_format") != 2
        or metadata.get("dtype") != "<f8"
        or metadata.get("compressor") is not None
        or metadata.get("order") != "C"
        or not isinstance(shape, list)
        or len(shape) != 3
        or shape[1] != 3
        or not isinstance(shape[2], int)
        or shape[2] <= 0
        or chunks != [1, 3, shape[2]]
        or attributes.get("axes") != ["sample", "component", "cell"]
        or attributes.get("storage_layout") != "soa_component_major"
    ):
        raise RuntimeError(f"unsupported H_demag Zarr storage contract: {metadata} {attributes}")

    with samples_path.open(encoding="utf-8", newline="") as handle:
        samples = list(csv.DictReader(handle))
    matching = [row for row in samples if int(row["step"]) == expected_source_step]
    if len(matching) != 1:
        raise RuntimeError(
            "H_demag Zarr must contain exactly one terminal sample: "
            f"step={expected_source_step} matches={len(matching)}"
        )
    sample = matching[0]
    cell_count = int(sample["cell_count"])
    if (
        sample.get("dtype") != "<f8"
        or int(sample["scalar_bytes"]) != 8
        or cell_count != shape[2]
    ):
        raise RuntimeError(f"H_demag terminal sample metadata is inconsistent: {sample}")
    chunk_path = zarr_dir / sample["chunk_key"]
    chunk = chunk_path.read_bytes()
    expected_bytes = 3 * cell_count * 8
    if len(chunk) != expected_bytes:
        raise RuntimeError(
            f"H_demag terminal chunk has {len(chunk)} bytes, expected {expected_bytes}: {chunk_path}"
        )

    component_bytes = [
        chunk[index * cell_count * 8 : (index + 1) * cell_count * 8]
        for index in range(3)
    ]
    aos_bytes = b"".join(
        component_bytes[component][cell * 8 : (cell + 1) * 8]
        for cell in range(cell_count)
        for component in range(3)
    )
    values = [value[0] for value in struct.iter_unpack("<d", aos_bytes)]
    return {
        "_artifact_h_demag_terminal_values": values,
        "artifact_h_demag_terminal_aos_sha256": hashlib.sha256(aos_bytes).hexdigest(),
        "artifact_h_demag_terminal_chunk_key": sample["chunk_key"],
        "artifact_h_demag_terminal_source_step": expected_source_step,
    }


def headless_runtime_proof(output_dir: Path) -> dict[str, Any]:
    metadata_path = output_dir / "metadata.json"
    qualification_path = output_dir / "qualification.json"
    scalars_path = output_dir / "scalars.csv"
    if not metadata_path.is_file() or not qualification_path.is_file() or not scalars_path.is_file():
        raise RuntimeError("headless row is missing metadata, qualification, or scalar artifacts")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    qualification = json.loads(qualification_path.read_text(encoding="utf-8"))
    provenance = metadata.get("execution_provenance")
    if not isinstance(provenance, dict):
        raise RuntimeError("headless metadata lacks execution_provenance")
    required = {
        "fem_gpu_state_allocated": True,
        "fem_gpu_rk_uses_cuda_kernels": True,
        "mfem_device": "cuda",
        "precision": "double",
    }
    mismatched = {
        key: {"actual": provenance.get(key), "expected": expected}
        for key, expected in required.items()
        if provenance.get(key) != expected
    }
    if mismatched:
        raise RuntimeError(f"headless GPU execution provenance mismatch: {mismatched}")
    if qualification.get("accepted_steps") != MATRIX_MAX_STEPS:
        raise RuntimeError(
            "headless qualification did not record every requested step: "
            f"{qualification.get('accepted_steps')} != {MATRIX_MAX_STEPS}"
        )
    with scalars_path.open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if len(rows) != MATRIX_MAX_STEPS or int(rows[-1]["step"]) != MATRIX_MAX_STEPS:
        raise RuntimeError(
            "headless scalar artifact is incomplete: "
            f"rows={len(rows)} final_step={rows[-1].get('step') if rows else None}"
        )
    for column in ("E_ex", "E_demag", "E_ext", "E_ani", "E_total"):
        if not math.isfinite(float(rows[-1][column])):
            raise RuntimeError(f"headless final scalar {column} is not finite")
    return {
        "headless_device_name": provenance.get("device_name"),
        "headless_gpu_provenance": True,
        "headless_scalar_rows": len(rows),
    }


def tetrahedron_volume(nodes: list[list[float]], element: list[int]) -> float:
    a, b, c, d = (nodes[index] for index in element)
    ab = [b[index] - a[index] for index in range(3)]
    ac = [c[index] - a[index] for index in range(3)]
    ad = [d[index] - a[index] for index in range(3)]
    cross = [
        ac[1] * ad[2] - ac[2] * ad[1],
        ac[2] * ad[0] - ac[0] * ad[2],
        ac[0] * ad[1] - ac[1] * ad[0],
    ]
    return abs(sum(ab[index] * cross[index] for index in range(3))) / 6.0


def scalar_rows_by_step(output_dir: Path) -> dict[int, dict[str, float]]:
    with (output_dir / "scalars.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {
        int(row["step"]): {key: float(value) for key, value in row.items() if key != "step"}
        for row in rows
    }


def energy_density_cache_proof(
    output_dir: Path,
    fields: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    metadata = json.loads((output_dir / "metadata.json").read_text(encoding="utf-8"))
    backend_plan = metadata.get("execution_plan", {}).get("backend_plan", {})
    material = backend_plan.get("material", {})
    mesh = backend_plan.get("mesh", {})
    elements = mesh.get("elements")
    element_markers = mesh.get("element_markers")
    nodes = mesh.get("nodes")
    ms_field = material.get("ms_field")
    ms_element_field = backend_plan.get("ms_element_field")
    kc1_field = backend_plan.get("kc1_field")
    resolved_cubic = material.get("cubic_anisotropy_kc1") == 48e3 or (
        isinstance(kc1_field, list)
        and any(math.isclose(float(value), 48e3) for value in kc1_field)
    )
    if ENERGY_QUALIFICATION in {"", "cubic"} and not resolved_cubic:
        raise RuntimeError("energy fixture did not resolve cubic anisotropy into the native plan")
    if not isinstance(elements, list) or not isinstance(element_markers, list) or not isinstance(nodes, list):
        raise RuntimeError("energy comparison lacks native tetrahedral mesh topology")
    if ENERGY_QUALIFICATION == "dg0_ms":
        if ms_field is not None:
            raise RuntimeError("DG0 qualification acquired an illegal nodal Ms projection")
        if not isinstance(ms_element_field, list) or len(ms_element_field) != len(elements):
            raise RuntimeError("DG0 qualification did not reach the native plan as Ms_element_field")
        positive_ms = [float(value) for value in ms_element_field if float(value) > 0.0]
        if not positive_ms or min(positive_ms) >= max(positive_ms):
            raise RuntimeError("DG0 Ms field is not spatially varying")
    elif ENERGY_QUALIFICATION in {"uniaxial", "cubic", "interfacial_dmi", "bulk_dmi"}:
        if ms_field is not None or ms_element_field is not None:
            raise RuntimeError("dedicated energy qualification must use uniform scalar Ms")
        dind = backend_plan.get("interfacial_dmi")
        dbulk = backend_plan.get("bulk_dmi")
        uniaxial = material.get("uniaxial_anisotropy")
        if uniaxial is None:
            uniaxial = material.get("uniaxial_anisotropy_ku1")
        if ENERGY_QUALIFICATION == "uniaxial" and not (
            isinstance(uniaxial, (int, float))
            and float(uniaxial) != 0.0
            and not resolved_cubic
            and dind is None
            and dbulk is None
        ):
            raise RuntimeError("uniaxial qualification did not resolve only the uniaxial operator")
        if ENERGY_QUALIFICATION == "cubic" and not (
            resolved_cubic and uniaxial is None and dind is None and dbulk is None
        ):
            raise RuntimeError("cubic qualification did not resolve only the cubic operator")
        if ENERGY_QUALIFICATION == "interfacial_dmi" and not (
            isinstance(dind, (int, float)) and float(dind) != 0.0 and dbulk is None
        ):
            raise RuntimeError("interfacial DMI qualification did not resolve only Dind")
        if ENERGY_QUALIFICATION == "bulk_dmi" and not (
            isinstance(dbulk, (int, float)) and float(dbulk) != 0.0 and dind is None
        ):
            raise RuntimeError("bulk DMI qualification did not resolve only Dbulk")
        positive_ms = [float(material.get("saturation_magnetisation", 0.0))]
    else:
        if not isinstance(ms_field, list) or len(ms_field) != len(nodes):
            raise RuntimeError("energy fixture did not resolve the regional Ms override as a nodal field")
        positive_ms = [float(value) for value in ms_field if float(value) > 0.0]
        if not positive_ms or min(positive_ms) >= max(positive_ms):
            raise RuntimeError("regional Ms field is not spatially varying")
    ms_range = [min(positive_ms), max(positive_ms)]

    compared_quantities = {
        quantity: scalar
        for quantity, scalar in ENERGY_DENSITY_TO_SCALAR.items()
        if quantity != "eden_dmi"
    }
    if ENERGY_QUALIFICATION == "dg0_ms":
        compared_quantities = {
            quantity: ENERGY_DENSITY_TO_SCALAR[quantity]
            for quantity in ("eden_ex", "eden_demag", "eden_ext", "eden_total")
        }
    elif ENERGY_QUALIFICATION in {"uniaxial", "cubic"}:
        compared_quantities = {
            quantity: ENERGY_DENSITY_TO_SCALAR[quantity]
            for quantity in ("eden_ani", "eden_total")
        }
    elif ENERGY_QUALIFICATION in {"interfacial_dmi", "bulk_dmi"}:
        compared_quantities = {
            quantity: ENERGY_DENSITY_TO_SCALAR[quantity]
            for quantity in ("eden_dmi", "eden_total")
        }

    scalars = scalar_rows_by_step(output_dir)
    comparisons: dict[str, Any] = {}
    projection_locations: set[str] = set()
    for quantity, scalar_column in compared_quantities.items():
        field = fields.get(quantity)
        if field is None:
            raise RuntimeError(f"missing pre-terminal cached energy field {quantity}")
        meta = field["meta"]
        expected_location = (
            "fem_nodal_conservative_tetra_projection"
            if ENERGY_QUALIFICATION == "dg0_ms"
            else "fem_nodal_visualization_projection"
        )
        if meta.get("location") != expected_location:
            raise RuntimeError(
                f"{quantity} hides its non-canonical projection contract: location={meta.get('location')}"
            )
        projection_locations.add(expected_location)
        source_step = int(meta["source_step"])
        scalar_row = scalars.get(source_step)
        if scalar_row is None:
            raise RuntimeError(f"no native scalar row for {quantity} source_step={source_step}")
        values = field["values"]
        node_indices = field["node_indices"]
        if len(values) != len(node_indices):
            raise RuntimeError(f"{quantity} values/node-index lengths differ")
        by_node = dict(zip(node_indices, values))
        projected_energy = 0.0
        for marker, element in zip(element_markers, elements):
            if int(marker) == 0:
                continue
            try:
                nodal_values = [float(by_node[int(index)]) for index in element]
            except KeyError as error:
                raise RuntimeError(
                    f"{quantity} payload omits magnetic element node {error.args[0]}"
                ) from error
            projected_energy += tetrahedron_volume(nodes, element) * sum(nodal_values) / 4.0
        native_energy = scalar_row[scalar_column]
        if quantity in {"eden_ani", "eden_dmi"} and abs(native_energy) <= ENERGY_ABSOLUTE_TOLERANCE_J:
            raise RuntimeError(
                f"{ENERGY_QUALIFICATION} produced a zero {scalar_column} scalar energy"
            )
        absolute_error = abs(projected_energy - native_energy)
        relative_error = absolute_error / max(abs(native_energy), ENERGY_ABSOLUTE_TOLERANCE_J)
        if absolute_error > ENERGY_ABSOLUTE_TOLERANCE_J and relative_error > ENERGY_RELATIVE_TOLERANCE:
            raise RuntimeError(
                f"{quantity} projection/native scalar mismatch at step {source_step}: "
                f"projection={projected_energy:.17e} scalar={native_energy:.17e} "
                f"abs={absolute_error:.3e} rel={relative_error:.3e}"
            )
        comparisons[quantity] = {
            "absolute_error_j": absolute_error,
            "native_scalar_j": native_energy,
            "projected_integral_j": projected_energy,
            "relative_error": relative_error,
            "source_step": source_step,
        }
    return {
        "energy_comparisons": comparisons,
        "energy_fixture_cubic": resolved_cubic,
        "energy_qualification": ENERGY_QUALIFICATION or "baseline_nodal_ms",
        "energy_fixture_ms_location": (
            "element_dg0" if ENERGY_QUALIFICATION == "dg0_ms" else
            "uniform" if ENERGY_QUALIFICATION in {
                "uniaxial", "cubic", "interfacial_dmi", "bulk_dmi"
            } else
            "nodal_p1"
        ),
        "energy_fixture_regional_ms_range": ms_range,
        "energy_projection_locations": sorted(projection_locations),
    }


def browser_smoke(
    env: dict[str, str],
    log_path: Path,
    timeout_seconds: float,
) -> subprocess.Popen[str]:
    log = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen(
        ["node", str(CONTROL_ROOM_SMOKE)],
        cwd=ROOT,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        text=True,
    )
    process._fullmag_log = log  # type: ignore[attr-defined]
    return process


def stop_browser_process(process: subprocess.Popen[str]) -> None:
    try:
        process.terminate()
        try:
            process.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10.0)
    finally:
        log = getattr(process, "_fullmag_log", None)
        if log is not None and not log.closed:
            log.close()


def wait_browser_smoke_ready(
    process: subprocess.Popen[str],
    log_path: Path,
    timeout_seconds: float,
) -> None:
    def ready() -> bool:
        if process.poll() is not None:
            output = log_path.read_text(encoding="utf-8")
            raise RuntimeError(
                f"Control Room freshness smoke exited before observer readiness ({process.returncode}):\n"
                f"{output[-4000:]}"
            )
        try:
            output = log_path.read_text(encoding="utf-8")
        except OSError:
            return False
        return "FEM preview browser observer ready" in output

    poll("Control Room browser response observer", timeout_seconds, ready)


def finish_browser_smoke(process: subprocess.Popen[str], log_path: Path, timeout_seconds: float) -> dict[str, Any]:
    try:
        return_code = process.wait(timeout=timeout_seconds)
    finally:
        log = getattr(process, "_fullmag_log", None)
        if log is not None:
            log.close()
    output = log_path.read_text(encoding="utf-8")
    if return_code != 0:
        raise RuntimeError(f"Control Room freshness smoke failed ({return_code}):\n{output[-4000:]}")
    marker = "FEM preview browser proof: "
    proof_lines = [line for line in output.splitlines() if marker in line]
    if not proof_lines:
        raise RuntimeError(f"Control Room smoke did not emit proof JSON:\n{output[-4000:]}")
    return json.loads(proof_lines[-1].split(marker, 1)[1])


def common_runtime_env(
    mode: str,
    cadence: int,
    surface: str,
    no_opener_path: str,
    api_port: int,
) -> dict[str, str]:
    env = os.environ.copy()
    resolved_device = "cpu" if ENERGY_QUALIFICATION == "dg0_ms" else "gpu"
    env.update(
        {
            "FULLMAG_API_PORT": str(api_port),
            "FULLMAG_CPU_THREADS": "1",
            "FULLMAG_FDM_EXECUTION": "cpu",
            "FULLMAG_FEM_EXECUTION": resolved_device,
            "FULLMAG_GMSH_THREADS": "1",
            "FULLMAG_PREVIEW_EVERY_N": str(cadence),
            "FULLMAG_PREVIEW_MATRIX_MAX_STEPS": str(MATRIX_MAX_STEPS),
            "FULLMAG_PREVIEW_MATRIX_MODE": mode,
            "FULLMAG_PREVIEW_MATRIX_SURFACE": surface,
            "FULLMAG_PYTHON": str(PYTHON),
            "FULLMAG_RELAX_DEVICE": resolved_device,
            "PYTHONPATH": str(ROOT / "packages/fullmag-py/src"),
            "RAYON_NUM_THREADS": "1",
        }
    )
    env["PATH"] = no_opener_path + os.pathsep + env.get("PATH", "")
    if mode == "disabled":
        env["FULLMAG_DISABLE_PREVIEW_3D"] = "1"
    else:
        env.pop("FULLMAG_DISABLE_PREVIEW_3D", None)
    return env


def run_row(
    *,
    api_base: str,
    api_port: int,
    cadence: int,
    mode: str,
    no_opener_path: str,
    output_dir: Path,
    row_log_dir: Path,
    surface: str,
    timeout_seconds: float,
    materialization_delay_ms: int | None = None,
    require_retained_interval: bool = False,
) -> dict[str, Any]:
    env = common_runtime_env(mode, cadence, surface, no_opener_path, api_port)
    if materialization_delay_ms is not None:
        env["FULLMAG_ENABLE_TEST_HOOKS"] = "1"
        env["FULLMAG_TEST_FEM_PREVIEW_MATERIALIZATION_DELAY_MS"] = str(
            materialization_delay_ms
        )
    else:
        env.pop("FULLMAG_ENABLE_TEST_HOOKS", None)
        env.pop("FULLMAG_TEST_FEM_PREVIEW_MATERIALIZATION_DELAY_MS", None)
    runtime_log_path = row_log_dir / "runtime.log"
    browser_log_path = row_log_dir / "browser.log"
    row_log_dir.mkdir(parents=True, exist_ok=False)
    command = [
        str(RUNTIME),
        str(FIXTURE),
        "--backend",
        "fem",
        "--output-dir",
        str(output_dir),
        "--workspace-root",
        str(row_log_dir / "session-root"),
    ]
    started = time.perf_counter()
    browser: subprocess.Popen[str] | None = None
    browser_proof: dict[str, Any] | None = None
    callback_proof: dict[str, Any]
    live_fields: dict[str, dict[str, Any]] = {}
    terminal_cache_fields: dict[str, dict[str, Any]] = {}

    feature_flags_path = row_log_dir / "feature_flags.json"
    feature_flags_path.write_text(
        json.dumps(
            {
                "disable_charts": False,
                "disable_preview_2d": False,
                "disable_preview_3d": mode == "disabled",
                "disable_session_state_broadcast": False,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    env["FULLMAG_FEATURE_FLAGS_FILE"] = str(feature_flags_path)

    with runtime_log_path.open("w", encoding="utf-8") as runtime_log:
        if surface == "headless":
            completed = subprocess.run(
                command + ["--headless", "--json"],
                cwd=ROOT,
                env=env,
                stdout=runtime_log,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=timeout_seconds,
            )
            if completed.returncode != 0:
                output = runtime_log_path.read_text(encoding="utf-8")
                raise RuntimeError(f"headless runtime failed ({completed.returncode}):\n{output[-4000:]}")
            field_proof = {
                "_field_values": [],
                "field_state": None,
                "mask_sha256": None,
                "payload_sha256": None,
                "source_revision": None,
                "source_step": None,
            }
            callback_proof = {
                "callback_deadline_ns": None,
                "callback_handoff_count": None,
                "callback_handoff_max_ns": None,
                "callback_handoff_p50_ns": None,
                "schedule_fence_max_ns": None,
                "schedule_fence_p50_ns": None,
                "callback_plus_fence_max_ns": None,
                "callback_thread_cpu_max_ns": None,
                "callback_thread_cpu_p50_ns": None,
                "callback_wall_outlier_count": 0,
                "callback_wall_outlier_max_ns": None,
                "callback_wall_outlier_details": [],
                "worst_callback_detail": None,
                "worst_submit_detail": None,
            }
        else:
            previous_session_id = session_id_or_none(api_base)
            runtime = subprocess.Popen(
                [str(RUNTIME), "-i", *command[1:], "--web-port", str(api_port)],
                cwd=ROOT,
                env=env,
                stdout=runtime_log,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                session_id = wait_for_new_interactive_session(
                    api_base, previous_session_id, runtime, timeout_seconds
                )
                enable_solver_profile(api_base, timeout_seconds)
                if surface == "control_room":
                    browser_env = env.copy()
                    browser_env.update(
                        {
                            "CONTROL_ROOM_API_BASE_URL": api_base,
                            "CONTROL_ROOM_PREVIEW_MATRIX_TIMEOUT_MS": str(int(timeout_seconds * 1000)),
                            "CONTROL_ROOM_PREVIEW_MATRIX_POLL_MS": (
                                "10" if require_retained_interval else "100"
                            ),
                            "CONTROL_ROOM_REQUIRE_RETAINED_INTERVAL": (
                                "1" if require_retained_interval else "0"
                            ),
                            "CONTROL_ROOM_URL": api_base + "/workspace",
                        }
                    )
                    browser = browser_smoke(browser_env, browser_log_path, timeout_seconds)
                    wait_browser_smoke_ready(browser, browser_log_path, timeout_seconds)
                submit_command(api_base, "solve", f"fem_preview_surface_matrix:{session_id}")
                required_quantities = preterminal_quantities_for_mode(mode)
                if required_quantities:
                    live_fields = observe_preterminal_field_resources(
                        api_base,
                        required_quantities,
                        timeout_seconds,
                    )
                wait_terminal_stage(api_base, timeout_seconds)
                terminal_quantities = terminal_quantities_for_mode(mode)
                if terminal_quantities:
                    terminal_cache_fields = completed_field_resources(
                        api_base,
                        terminal_quantities,
                        MATRIX_MAX_STEPS,
                        timeout_seconds,
                    )
                field_proof = terminal_field_resource_proof(api_base, mode, timeout_seconds)
                callback_proof = callback_profile_proof(api_base, mode, timeout_seconds)
                if browser is not None:
                    browser_proof = finish_browser_smoke(browser, browser_log_path, timeout_seconds)
                    browser = None
                    if (
                        requires_browser_consumed_response(mode, surface)
                        and browser_proof.get("observedBeforeTerminal") is not True
                    ):
                        raise RuntimeError(
                            "Control Room did not consume a field response before terminal finalization"
                        )
                    if requires_browser_pending_state(mode, surface) and (
                        browser_proof.get("observedBeforeTerminal") is not True
                        or browser_proof.get("preterminalMaterializationState")
                        not in {"pending", "stale_complete"}
                        or browser_proof.get("terminalFieldResponseObserved") is not True
                        or not browser_proof.get("terminalCanvasSha256")
                        or not browser_proof.get("payloadSha256")
                    ):
                        raise RuntimeError(
                            "Control Room did not preserve pending/stale full-cache state "
                            "and consume the terminal field response"
                        )
                    if (
                        require_retained_interval
                        and browser_proof.get("retainedFrameObserved") is not True
                    ):
                        raise RuntimeError(
                            "Control Room did not retain a topology-compatible pending/stale field frame"
                        )
            finally:
                if browser is not None:
                    stop_browser_process(browser)
                close_interactive_runtime(api_base, runtime, timeout_seconds)

    primary_live = None
    if requires_primary_live_proof(mode) and surface != "headless":
        primary_quantity = "H_demag" if mode in {"H_demag", "full_cache"} else "m"
        primary_live = live_fields.get(primary_quantity)
    energy_proof = empty_energy_proof()
    if requires_terminal_full_cache_proof(mode) and surface != "headless":
        energy_proof = energy_density_cache_proof(output_dir, terminal_cache_fields)
    h_demag_artifact: dict[str, Any] = {
        "_artifact_h_demag_terminal_values": [],
        "artifact_h_demag_terminal_aos_sha256": None,
        "artifact_h_demag_terminal_chunk_key": None,
        "artifact_h_demag_terminal_source_step": None,
        "terminal_h_demag_matches_artifact": None,
    }
    if mode in {"H_demag", "full_cache"}:
        h_demag_artifact.update(
            h_demag_terminal_artifact_proof(output_dir, MATRIX_MAX_STEPS)
        )
        if surface != "headless":
            terminal_hash = field_proof.get("payload_sha256")
            artifact_hash = h_demag_artifact["artifact_h_demag_terminal_aos_sha256"]
            h_demag_artifact["terminal_h_demag_matches_artifact"] = (
                terminal_hash == artifact_hash
                and field_proof.get("source_step") == MATRIX_MAX_STEPS
                and field_proof.get("field_state") in {"complete", "stale_complete"}
            )
            if h_demag_artifact["terminal_h_demag_matches_artifact"] is not True:
                raise RuntimeError(
                    "terminal H_demag API payload differs from the step-52 Zarr oracle: "
                    f"mode={mode} cadence={cadence} surface={surface} "
                    f"terminal={terminal_hash} artifact={artifact_hash} "
                    f"source_step={field_proof.get('source_step')} "
                    f"state={field_proof.get('field_state')} output={output_dir}"
                )
            cached_h_demag = terminal_cache_fields.get("H_demag")
            if cached_h_demag is not None and cached_h_demag["payload_sha256"] != artifact_hash:
                raise RuntimeError(
                    "full-cache terminal H_demag differs from the step-52 Zarr oracle: "
                    f"cache={cached_h_demag['payload_sha256']} artifact={artifact_hash} "
                    f"output={output_dir}"
                )
        print(
            "[fem-preview-matrix] H_demag provenance "
            f"mode={mode} cadence={cadence} surface={surface} "
            f"terminal={field_proof.get('payload_sha256')} "
            f"browser={browser_proof.get('payloadSha256') if browser_proof else None} "
            f"zarr={h_demag_artifact['artifact_h_demag_terminal_aos_sha256']} "
            f"source_step={field_proof.get('source_step')} "
            f"state={field_proof.get('field_state')}",
            flush=True,
        )
    headless_proof = (
        headless_runtime_proof(output_dir)
        if surface == "headless"
        else {
            "headless_device_name": None,
            "headless_gpu_provenance": None,
            "headless_scalar_rows": None,
        }
    )
    proof = {
        **artifact_proof(output_dir),
        **field_proof,
        **callback_proof,
        **energy_proof,
        **h_demag_artifact,
        **headless_proof,
        "browser_field_request_count": browser_proof.get("fieldRequestCount") if browser_proof else None,
        "browser_observed_before_terminal": (
            browser_proof.get("observedBeforeTerminal") if browser_proof else None
        ),
        "browser_response_payload_sha256": (
            browser_proof.get("payloadSha256") if browser_proof else None
        ),
        "browser_response_url": browser_proof.get("responseUrl") if browser_proof else None,
        "browser_preterminal_canvas_sha256": (
            browser_proof.get("preterminalCanvasSha256") if browser_proof else None
        ),
        "browser_preterminal_materialization_state": (
            browser_proof.get("preterminalMaterializationState") if browser_proof else None
        ),
        "browser_terminal_canvas_sha256": (
            browser_proof.get("terminalCanvasSha256") if browser_proof else None
        ),
        "browser_terminal_field_response_observed": (
            browser_proof.get("terminalFieldResponseObserved") if browser_proof else None
        ),
        "browser_retained_canvas_sha256": (
            browser_proof.get("retainedCanvasSha256") if browser_proof else None
        ),
        "browser_retained_frame_observed": (
            browser_proof.get("retainedFrameObserved") if browser_proof else None
        ),
        "browser_retained_materialization_state": (
            browser_proof.get("retainedMaterializationState") if browser_proof else None
        ),
        "terminal_cache_fields": {
            quantity: {
                "mask_sha256": field["mask_sha256"],
                "payload_sha256": field["payload_sha256"],
                "source_revision": field["meta"].get("source_revision"),
                "source_step": field["meta"].get("source_step"),
                "state": field["meta"].get("state"),
            }
            for quantity, field in terminal_cache_fields.items()
        },
        "elapsed_ms": (time.perf_counter() - started) * 1000.0,
        "live_field_state": primary_live["meta"].get("state") if primary_live else None,
        "live_mask_sha256": primary_live.get("mask_sha256") if primary_live else None,
        "live_observed_before_terminal": (
            primary_live.get("observed_before_terminal") if primary_live else None
        ),
        "live_payload_sha256": primary_live.get("payload_sha256") if primary_live else None,
        "live_source_revision": (
            primary_live["meta"].get("source_revision") if primary_live else None
        ),
        "live_source_step": primary_live["meta"].get("source_step") if primary_live else None,
    }
    return proof


def assert_equivalence(rows: list[dict[str, Any]]) -> dict[str, Any]:
    interactive_rows = [row for row in rows if row["surface"] != "headless"]
    enabled_interactive = [
        row for row in rows if row["mode"] != "disabled" and row["surface"] != "headless"
    ]
    bad_callbacks = [
        (row["mode"], row["cadence"], row["surface"], row["repeat"])
        for row in enabled_interactive
        if not isinstance(row.get("callback_handoff_max_ns"), int)
        or not isinstance(row.get("callback_handoff_p50_ns"), int)
        or row["callback_handoff_p50_ns"] >= PRODUCTION_CALLBACK_DEADLINE_NS
        or not isinstance(row.get("callback_thread_cpu_max_ns"), int)
        or row["callback_thread_cpu_max_ns"] >= PRODUCTION_CALLBACK_DEADLINE_NS
        or not isinstance(row.get("callback_wall_outlier_details"), list)
        or row.get("callback_wall_outlier_count")
        != len(row.get("callback_wall_outlier_details", []))
    ]
    if bad_callbacks:
        raise RuntimeError(f"production callback proof missing for rows: {bad_callbacks}")
    bad_profile_persistence = []
    for row in interactive_rows:
        persistence_error = solver_profile_persistence_contract_error(
            expected=PROFILE_PERSIST_ARTIFACT,
            configured=row.get("solver_profile_persist_artifact"),
            artifact_refs=row.get("solver_profile_artifact_refs"),
            persistence_failed=row.get("solver_profile_persistence_failed"),
            overhead=row.get("solver_profile_overhead"),
        )
        if persistence_error is not None:
            bad_profile_persistence.append(
                (
                    row["mode"],
                    row["cadence"],
                    row["surface"],
                    row["repeat"],
                    persistence_error,
                )
            )
    if bad_profile_persistence:
        raise RuntimeError(
            "terminal solver-profile persistence proof missing for rows: "
            f"{bad_profile_persistence}"
        )
    primary_live_rows = [
        row for row in enabled_interactive if requires_primary_live_proof(str(row["mode"]))
    ]
    bad_live = [
        (row["mode"], row["cadence"], row["surface"], row["repeat"])
        for row in primary_live_rows
        if row.get("live_observed_before_terminal") is not True
        or not isinstance(row.get("live_source_step"), int)
        or row["live_source_step"] >= MATRIX_MAX_STEPS
    ]
    if bad_live:
        raise RuntimeError(f"production live async/callback proof missing for rows: {bad_live}")
    bad_browser = [
        (row["mode"], row["cadence"], row["repeat"])
        for row in enabled_interactive
        if requires_browser_consumed_response(str(row["mode"]), str(row["surface"]))
        and (
            row.get("browser_observed_before_terminal") is not True
            or not row.get("browser_response_payload_sha256")
            or not row.get("browser_preterminal_canvas_sha256")
        )
    ]
    if bad_browser:
        raise RuntimeError(f"Control Room consumed-response proof missing for rows: {bad_browser}")
    bad_full_cache_browser = [
        (row["cadence"], row["repeat"])
        for row in enabled_interactive
        if requires_browser_pending_state(str(row["mode"]), str(row["surface"]))
        and (
            row.get("browser_observed_before_terminal") is not True
            or row.get("browser_preterminal_materialization_state")
            not in {"pending", "stale_complete"}
            or row.get("browser_terminal_field_response_observed") is not True
            or not row.get("browser_terminal_canvas_sha256")
            or not row.get("browser_response_payload_sha256")
        )
    ]
    if bad_full_cache_browser:
        raise RuntimeError(
            "Control Room full-cache pending/terminal proof missing for rows: "
            f"{bad_full_cache_browser}"
        )
    bad_headless = [
        (row["mode"], row["cadence"], row["repeat"])
        for row in rows
        if row["surface"] == "headless"
        and (
            row.get("headless_gpu_provenance") is not True
            or row.get("headless_scalar_rows") != MATRIX_MAX_STEPS
        )
    ]
    if bad_headless:
        raise RuntimeError(f"headless execution proof missing for rows: {bad_headless}")
    energy_rows = [
        row
        for row in rows
        if row["mode"] == "full_cache"
        and row["surface"] != "headless"
    ]
    expected_energy_quantities = {
        "dg0_ms": {"eden_ex", "eden_demag", "eden_ext", "eden_total"},
        "uniaxial": {"eden_ani", "eden_total"},
        "cubic": {"eden_ani", "eden_total"},
        "interfacial_dmi": {"eden_dmi", "eden_total"},
        "bulk_dmi": {"eden_dmi", "eden_total"},
    }.get(ENERGY_QUALIFICATION, set(ENERGY_DENSITY_TO_SCALAR) - {"eden_dmi"})
    bad_energy = [
        (row["surface"], row["repeat"])
        for row in energy_rows
        if not isinstance(row.get("energy_comparisons"), dict)
        or set(row["energy_comparisons"]) != expected_energy_quantities
        or (
            ENERGY_QUALIFICATION in {"", "cubic"}
            and row.get("energy_fixture_cubic") is not True
        )
    ]
    if bad_energy:
        raise RuntimeError(f"managed energy-density cache comparisons missing: {bad_energy}")

    expected_terminal_cache = set(terminal_quantities_for_mode("full_cache"))
    bad_terminal_cache = []
    terminal_cache_payloads = {
        quantity: set() for quantity in expected_terminal_cache
    }
    terminal_cache_masks = {
        quantity: set() for quantity in expected_terminal_cache
    }
    for row in energy_rows:
        fields = row.get("terminal_cache_fields")
        if not isinstance(fields, dict) or set(fields) != expected_terminal_cache:
            bad_terminal_cache.append(
                (row["cadence"], row["surface"], row["repeat"], "quantity_set")
            )
            continue
        for quantity, field in fields.items():
            if (
                not isinstance(field, dict)
                or field.get("state") not in {"complete", "stale_complete"}
                or field.get("source_step") != MATRIX_MAX_STEPS
                or not field.get("payload_sha256")
                or not field.get("mask_sha256")
            ):
                bad_terminal_cache.append(
                    (row["cadence"], row["surface"], row["repeat"], quantity)
                )
                continue
            terminal_cache_payloads[quantity].add(str(field["payload_sha256"]))
            terminal_cache_masks[quantity].add(str(field["mask_sha256"]))
    if bad_terminal_cache:
        raise RuntimeError(
            f"full-cache terminal materialization proof missing: {bad_terminal_cache}"
        )
    bad_terminal_equivalence = {
        quantity: {
            "payloads": len(terminal_cache_payloads[quantity]),
            "masks": len(terminal_cache_masks[quantity]),
        }
        for quantity in expected_terminal_cache
        if energy_rows
        and (
            len(terminal_cache_payloads[quantity]) != 1
            or len(terminal_cache_masks[quantity]) != 1
        )
    }
    if bad_terminal_equivalence:
        raise RuntimeError(
            "full-cache terminal payload equivalence failed: "
            f"{bad_terminal_equivalence}"
        )

    h_demag_rows = [row for row in rows if row["mode"] in {"H_demag", "full_cache"}]
    interactive_h_demag_rows = [
        row for row in h_demag_rows if row["surface"] != "headless"
    ]
    bad_h_demag_artifact = [
        (row["mode"], row["cadence"], row["surface"], row["repeat"])
        for row in interactive_h_demag_rows
        if row.get("terminal_h_demag_matches_artifact") is not True
        or row.get("payload_sha256")
        != row.get("artifact_h_demag_terminal_aos_sha256")
        or row.get("artifact_h_demag_terminal_source_step") != MATRIX_MAX_STEPS
    ]
    if bad_h_demag_artifact:
        raise RuntimeError(
            "terminal H_demag/Zarr oracle equivalence missing for rows: "
            f"{bad_h_demag_artifact}"
        )
    h_demag_artifact_hashes = {
        str(row["artifact_h_demag_terminal_aos_sha256"])
        for row in h_demag_rows
        if row.get("artifact_h_demag_terminal_aos_sha256")
    }
    h_demag_terminal_hashes = {
        str(row["payload_sha256"])
        for row in interactive_h_demag_rows
        if row.get("payload_sha256")
    }
    if h_demag_rows and (
        len(h_demag_artifact_hashes) != 1
        or h_demag_terminal_hashes != h_demag_artifact_hashes
    ):
        raise RuntimeError(
            "terminal H_demag does not have one cross-surface Zarr-authoritative payload: "
            f"terminal={sorted(h_demag_terminal_hashes)} "
            f"artifacts={sorted(h_demag_artifact_hashes)}"
        )

    m_hashes = {row["artifact_m_sha256"] for row in rows}
    quantized_m_hashes = {row["artifact_m_quantized_sha256"] for row in rows}
    m_masks = {row["artifact_m_mask_sha256"] for row in rows}
    if len(m_masks) != 1:
        raise RuntimeError(
            f"final magnetization artifact mask equivalence failed: masks={len(m_masks)}"
        )
    reference_values = [
        float(component)
        for vector in rows[0]["_artifact_m_values"]
        for component in vector
    ]
    max_artifact_delta = 0.0
    for row in rows[1:]:
        values = [
            float(component)
            for vector in row["_artifact_m_values"]
            for component in vector
        ]
        if len(values) != len(reference_values):
            raise RuntimeError("final magnetization artifact vector lengths differ")
        max_artifact_delta = max(
            max_artifact_delta,
            max((abs(actual - expected) for actual, expected in zip(values, reference_values)), default=0.0),
        )
    if max_artifact_delta > 1e-12:
        raise RuntimeError(
            "final magnetization artifacts differ beyond floating-point roundoff: "
            f"max_abs_delta={max_artifact_delta:.3e}"
        )
    enabled = enabled_interactive
    payload_groups: dict[str, set[str]] = {"m": set(), "H_demag": set()}
    mask_groups: dict[str, set[str]] = {"m": set(), "H_demag": set()}
    preview_raw_deltas: dict[str, dict[str, float | int]] = {}
    for row in enabled:
        quantity = "H_demag" if row["mode"] in {"H_demag", "full_cache"} else "m"
        payload_groups[quantity].add(str(row["payload_sha256"]))
        mask_groups[quantity].add(str(row["mask_sha256"]))
    for quantity in payload_groups:
        quantity_rows = [
            row
            for row in enabled
            if ("H_demag" if row["mode"] in {"H_demag", "full_cache"} else "m")
            == quantity
        ]
        if not quantity_rows:
            continue
        reference = quantity_rows[0]["_field_values"]
        max_abs = 0.0
        max_scaled_relative = 0.0
        max_ulp = 0
        for row in quantity_rows[1:]:
            values = row["_field_values"]
            if len(values) != len(reference):
                raise RuntimeError(f"{quantity} preview vector lengths differ")
            for actual, expected in zip(values, reference):
                delta = abs(actual - expected)
                scale = max(abs(actual), abs(expected), 1.0)
                max_abs = max(max_abs, delta)
                max_scaled_relative = max(max_scaled_relative, delta / scale)
                max_ulp = max(max_ulp, float_ulp_distance(actual, expected))
        print(
            f"[fem-preview-matrix] {quantity} raw repeat deltas: "
            f"hashes={len(payload_groups[quantity])} max_abs={max_abs:.17g} "
            f"max_scaled_relative={max_scaled_relative:.17g} max_ulp={max_ulp}",
            flush=True,
        )
        preview_raw_deltas[quantity] = {
            "max_abs": max_abs,
            "max_scaled_relative": max_scaled_relative,
            "max_ulp": max_ulp,
        }
    bad = {
        quantity: {"payloads": len(payload_groups[quantity]), "masks": len(mask_groups[quantity])}
        for quantity in payload_groups
        if payload_groups[quantity]
        and (len(payload_groups[quantity]) != 1 or len(mask_groups[quantity]) != 1)
    }
    if bad:
        raise RuntimeError(f"interactive preview payload equivalence failed: {bad}")
    return {
        "artifact_m_mask_sha256": next(iter(m_masks)),
        "artifact_m_exact_hash_variants": len(m_hashes),
        "artifact_m_exact_sha256": sorted(m_hashes),
        "artifact_m_max_abs_cross_surface_delta": max_artifact_delta,
        "artifact_m_quantized_hash_variants": len(quantized_m_hashes),
        "artifact_m_quantized_sha256": sorted(quantized_m_hashes),
        "preview_mask_sha256_by_quantity": {
            quantity: next(iter(values)) for quantity, values in mask_groups.items() if values
        },
        "preview_payload_sha256_by_quantity": {
            quantity: next(iter(values)) for quantity, values in payload_groups.items() if values
        },
        "preview_raw_cross_surface_delta_by_quantity": preview_raw_deltas,
        "terminal_h_demag_zarr_aos_sha256": next(
            iter(h_demag_artifact_hashes), None
        ),
        "terminal_h_demag_zarr_verified_rows": len(interactive_h_demag_rows),
        "full_cache_terminal_payload_sha256_by_quantity": {
            quantity: next(iter(values))
            for quantity, values in terminal_cache_payloads.items()
            if values
        },
        "full_cache_terminal_mask_sha256_by_quantity": {
            quantity: next(iter(values))
            for quantity, values in terminal_cache_masks.items()
            if values
        },
        "production_callback_max_ns": max(
            (int(row["callback_handoff_max_ns"]) for row in enabled_interactive),
            default=0,
        ),
        "production_callback_thread_cpu_max_ns": max(
            (int(row["callback_thread_cpu_max_ns"]) for row in enabled_interactive),
            default=0,
        ),
        "production_callback_wall_outlier_count": sum(
            int(row["callback_wall_outlier_count"]) for row in enabled_interactive
        ),
        "production_callback_wall_outlier_max_ns": max(
            (int(row.get("callback_wall_outlier_max_ns") or 0) for row in enabled_interactive),
            default=0,
        ),
        "production_schedule_fence_max_ns": max(
            (int(row.get("schedule_fence_max_ns") or 0) for row in enabled_interactive),
            default=0,
        ),
        "production_callback_plus_fence_max_ns": max(
            (
                int(row.get("callback_plus_fence_max_ns") or 0)
                for row in enabled_interactive
            ),
            default=0,
        ),
        "production_live_async_rows": len(primary_live_rows),
        "managed_energy_comparison_rows": len(energy_rows),
    }


def float_ulp_distance(actual: float, expected: float) -> int:
    def ordered(value: float) -> int:
        bits = struct.unpack("<Q", struct.pack("<d", value))[0]
        if bits & (1 << 63):
            return (~bits) & ((1 << 64) - 1)
        return bits | (1 << 63)

    return abs(ordered(actual) - ordered(expected))


def main() -> int:
    args = parse_args()
    if args.repeats < 1:
        raise ValueError("--repeats must be positive")
    require_matrix_python()
    require_inputs()
    modes = tuple(args.mode or MODES)
    cadences = tuple(args.cadence or CADENCES)
    surfaces = tuple(args.surface or SURFACES)
    expected_measured_rows = len(modes) * len(cadences) * len(surfaces) * args.repeats
    timestamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    report_dir = (args.report_dir or ROOT / ".fullmag/reports/fem-preview-surface-matrix" / timestamp).resolve()
    report_dir.mkdir(parents=True, exist_ok=False)
    logs_dir = report_dir / "logs"
    outputs_dir = report_dir / "outputs"
    logs_dir.mkdir()
    outputs_dir.mkdir()
    api_base = f"http://127.0.0.1:{args.api_port}"
    api_log_path = report_dir / "api.log"
    api_env = os.environ.copy()
    api_env.update(
        {
            "FULLMAG_API_PORT": str(args.api_port),
            "FULLMAG_PYTHON": str(PYTHON),
            "FULLMAG_WEB_STATIC_DIR": str(CONTROL_ROOM_ROOT),
            "PYTHONPATH": str(ROOT / "packages/fullmag-py/src"),
        }
    )
    runtime_lib = ROOT / ".fullmag/runtimes/fem-gpu-host/lib"
    previous_library_path = api_env.get("LD_LIBRARY_PATH", "")
    api_env["LD_LIBRARY_PATH"] = str(runtime_lib) + (
        os.pathsep + previous_library_path if previous_library_path else ""
    )
    api_log_path.write_text("", encoding="utf-8")
    batches = list(
        matrix_api_batches(
            modes=modes,
            cadences=cadences,
            surfaces=surfaces,
            repeats=args.repeats,
        )
    )
    api_lifecycle_labels: list[str] = []

    with tempfile.TemporaryDirectory(prefix="fullmag-preview-no-opener-") as no_opener_dir:
        which_wrapper = Path(no_opener_dir) / "which"
        which_wrapper.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        which_wrapper.chmod(0o755)
        rows: list[dict[str, Any]] = []
        warmup_count = 0
        retention_proof: dict[str, Any] | None = None
        if not args.skip_retention_proof:
            retention_label = "retention-H_demag-c10-control_room"
            api_lifecycle_labels.append(retention_label)
            print(
                f"[fem-preview-matrix] {retention_label} (dedicated 80ms delayed production-path proof)",
                flush=True,
            )
            with api_lifecycle(
                api_base=api_base,
                api_env=api_env,
                api_log_path=api_log_path,
                label=retention_label,
                timeout_seconds=args.timeout_seconds,
            ):
                retention_proof = run_row(
                    api_base=api_base,
                    api_port=args.api_port,
                    cadence=min(CADENCES),
                    materialization_delay_ms=80,
                    mode="H_demag",
                    no_opener_path=no_opener_dir,
                    output_dir=outputs_dir / retention_label,
                    require_retained_interval=True,
                    row_log_dir=logs_dir / retention_label,
                    surface="control_room",
                    timeout_seconds=args.timeout_seconds,
                )
                if (
                    retention_proof.get("browser_observed_before_terminal") is not True
                    or retention_proof.get("browser_retained_frame_observed") is not True
                    or retention_proof.get("browser_retained_materialization_state")
                    not in {"pending", "stale_complete"}
                    or not retention_proof.get("browser_retained_canvas_sha256")
                    or not retention_proof.get("browser_response_payload_sha256")
                ):
                    raise RuntimeError(
                        "dedicated delayed Control Room retained-frame proof is incomplete: "
                        f"{retention_proof}"
                    )
                serialized_retention_proof = {
                    key: value
                    for key, value in retention_proof.items()
                    if not key.startswith("_")
                }
                (report_dir / "retention_proof.json").write_text(
                    json.dumps(serialized_retention_proof, indent=2) + "\n",
                    encoding="utf-8",
                )
        for batch in batches:
            mode, cadence, surface, _ = batch[0]
            lifecycle_label = f"{mode}-c{cadence}-{surface}"
            api_lifecycle_labels.append(lifecycle_label)
            with api_lifecycle(
                api_base=api_base,
                api_env=api_env,
                api_log_path=api_log_path,
                label=lifecycle_label,
                timeout_seconds=args.timeout_seconds,
            ):
                for mode, cadence, surface, repeat in batch:
                    warmup = repeat == 0
                    label = f"{mode}-c{cadence}-{surface}-r{repeat}"
                    print(f"[fem-preview-matrix] {label} ({'warmup' if warmup else 'measured'})", flush=True)
                    proof = run_row(
                        api_base=api_base,
                        api_port=args.api_port,
                        cadence=cadence,
                        mode=mode,
                        no_opener_path=no_opener_dir,
                        output_dir=outputs_dir / label,
                        row_log_dir=logs_dir / label,
                        surface=surface,
                        timeout_seconds=args.timeout_seconds,
                    )
                    row = {
                        "cadence": cadence,
                        "mode": mode,
                        "repeat": repeat,
                        "surface": surface,
                        "warmup": warmup,
                        **proof,
                    }
                    if warmup:
                        warmup_count += 1
                    else:
                        rows.append(row)

    if len(rows) != expected_measured_rows:
        raise RuntimeError(f"matrix row count mismatch: {len(rows)} != {expected_measured_rows}")
    (report_dir / "api_lifecycles.json").write_text(
        json.dumps(
            {
                "count": len(api_lifecycle_labels),
                "labels": api_lifecycle_labels,
                "max_rows_per_lifecycle": args.repeats + 1,
                "retention_has_dedicated_lifecycle": not args.skip_retention_proof,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (report_dir / "raw_rows.json").write_text(json.dumps(rows) + "\n", encoding="utf-8")
    equivalence = assert_equivalence(rows)
    columns = matrix_csv_columns(rows)
    with (report_dir / "matrix.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(matrix_csv_record(row, columns) for row in rows)
    elapsed_values = sorted(float(row["elapsed_ms"]) for row in rows)
    callback_values = sorted(
        int(row["callback_handoff_max_ns"])
        for row in rows
        if isinstance(row.get("callback_handoff_max_ns"), int)
    )
    callback_p50_values = sorted(
        int(row["callback_handoff_p50_ns"])
        for row in rows
        if isinstance(row.get("callback_handoff_p50_ns"), int)
    )
    callback_thread_cpu_values = sorted(
        int(row["callback_thread_cpu_max_ns"])
        for row in rows
        if isinstance(row.get("callback_thread_cpu_max_ns"), int)
    )
    callback_wall_outlier_count = sum(
        int(row.get("callback_wall_outlier_count") or 0) for row in rows
    )
    callback_wall_outlier_max_ns = max(
        (int(row.get("callback_wall_outlier_max_ns") or 0) for row in rows),
        default=0,
    )
    schedule_fence_values = sorted(
        int(row["schedule_fence_max_ns"])
        for row in rows
        if isinstance(row.get("schedule_fence_max_ns"), int)
    )
    callback_plus_fence_values = sorted(
        int(row["callback_plus_fence_max_ns"])
        for row in rows
        if isinstance(row.get("callback_plus_fence_max_ns"), int)
    )
    summary = {
        "api_lifecycle_count": len(api_lifecycle_labels),
        "api_lifecycle_max_rows": args.repeats + 1,
        "cadences": list(cadences),
        "equivalence": equivalence,
        "measured_rows": len(rows),
        "modes": list(modes),
        "p50_surface_elapsed_ms": elapsed_values[len(elapsed_values) // 2],
        "production_callback_deadline_ns": PRODUCTION_CALLBACK_DEADLINE_NS,
        "production_callback_max_ns": callback_values[-1] if callback_values else None,
        "production_callback_p50_row_max_ns": (
            callback_values[len(callback_values) // 2] if callback_values else None
        ),
        "production_callback_worst_row_p50_ns": (
            callback_p50_values[-1] if callback_p50_values else None
        ),
        "production_callback_thread_cpu_max_ns": (
            callback_thread_cpu_values[-1] if callback_thread_cpu_values else None
        ),
        "production_callback_wall_outlier_count": callback_wall_outlier_count,
        "production_callback_wall_outlier_max_ns": (
            callback_wall_outlier_max_ns if callback_wall_outlier_count else None
        ),
        "production_schedule_fence_max_ns": (
            schedule_fence_values[-1] if schedule_fence_values else None
        ),
        "production_callback_plus_fence_max_ns": (
            callback_plus_fence_values[-1] if callback_plus_fence_values else None
        ),
        "repeats_per_variant": args.repeats,
        "retention_proof": (
            {
                "browser_response_payload_sha256": retention_proof.get(
                    "browser_response_payload_sha256"
                ),
                "browser_retained_canvas_sha256": retention_proof.get(
                    "browser_retained_canvas_sha256"
                ),
                "browser_retained_materialization_state": retention_proof.get(
                    "browser_retained_materialization_state"
                ),
                "production_callback_max_ns": retention_proof.get(
                    "callback_handoff_max_ns"
                ),
            }
            if retention_proof is not None
            else None
        ),
        "surfaces": list(surfaces),
        "warmup_rows": warmup_count,
    }
    (report_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"[fem-preview-matrix] PASS {json.dumps(summary, sort_keys=True)}")
    print(f"[fem-preview-matrix] report_dir={report_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
