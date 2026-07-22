#!/usr/bin/env python3
"""Qualify FEM preview handoff through real CLI, API, and Control Room surfaces."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import signal
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / ".fullmag/runtimes/fem-gpu-host/bin/fullmag-fem-gpu"
API = ROOT / ".fullmag/runtimes/fem-gpu-host/bin/fullmag-api"
PYTHON = Path(
    os.environ.get(
        "FULLMAG_MATRIX_PYTHON",
        ROOT / ".fullmag/local/python/bin/python",
    )
)
FIXTURE = ROOT / "examples/fem_preview_surface_matrix.py"
CONTROL_ROOM_ROOT = ROOT / "apps/control-room/out"
CONTROL_ROOM_SMOKE = ROOT / "apps/control-room/scripts/smoke-fem-preview-freshness.mjs"

MODES = ("disabled", "m", "H_demag", "full_cache")
CADENCES = (10, 25, 50)
MATRIX_MAX_STEPS = max(CADENCES) + 2
SURFACES = ("headless", "interactive_no_browser", "control_room")
TERMINAL_STAGE_STATES = {"completed", "failed", "cancelled", "rejected", "skipped", "stopped"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-port", type=int, default=18197)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--timeout-seconds", type=float, default=240.0)
    parser.add_argument("--mode", choices=MODES, action="append")
    parser.add_argument("--cadence", choices=CADENCES, type=int, action="append")
    parser.add_argument("--surface", choices=SURFACES, action="append")
    parser.add_argument("--report-dir", type=Path)
    return parser.parse_args()


def require_inputs() -> None:
    required = (RUNTIME, API, PYTHON, FIXTURE, CONTROL_ROOM_SMOKE, CONTROL_ROOM_ROOT / "index.html")
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError("preview matrix prerequisites are missing:\n" + "\n".join(missing))


def request_bytes(base: str, path: str, *, timeout: float = 10.0) -> bytes:
    request = urllib.request.Request(base + path, headers={"Accept": "application/octet-stream"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def get_json(base: str, path: str, *, timeout: float = 10.0) -> dict[str, Any]:
    request = urllib.request.Request(base + path, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
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


def field_resource_proof(base: str, mode: str, timeout_seconds: float) -> dict[str, Any]:
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

    def completed_meta() -> dict[str, Any] | None:
        meta = get_json(
            base,
            f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity, safe='')}/meta",
        )
        if meta.get("state") not in {"complete", "stale_complete"}:
            return None
        if meta.get("source_step") != MATRIX_MAX_STEPS:
            raise ValueError(
                f"observed {quantity} source_step={meta.get('source_step')} "
                f"state={meta.get('state')} source_revision={meta.get('source_revision')}"
            )
        return meta

    meta = poll(
        f"terminal-step {quantity} field metadata",
        timeout_seconds,
        completed_meta,
    )
    binary = request_bytes(
        base,
        f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity, safe='')}"
        "/samples/vector?component=full&scope_kind=full",
    )
    value_bytes, mask_bytes = canonical_fmvp_payload(binary)
    return {
        "_field_values": [value[0] for value in struct.iter_unpack("<d", value_bytes)],
        "field_state": meta.get("state"),
        "mask_sha256": hashlib.sha256(mask_bytes).hexdigest(),
        "payload_sha256": hashlib.sha256(value_bytes).hexdigest(),
        "source_revision": meta.get("source_revision"),
        "source_step": meta.get("source_step"),
    }


def canonical_fmvp_payload(payload: bytes) -> tuple[bytes, bytes]:
    if len(payload) < 48 or payload[:4] != b"FMVP":
        raise RuntimeError("field response is not a valid FMVP payload")
    version, n_comp = payload[4], payload[6]
    metadata_length = struct.unpack_from("<I", payload, 8)[0] if version == 3 else 0
    value_count = struct.unpack_from("<I", payload, 12)[0]
    value_offset = 48 + metadata_length
    expected = value_offset + value_count * 8
    if version not in {2, 3} or n_comp == 0 or len(payload) != expected:
        raise RuntimeError("field response has inconsistent FMVP header lengths")
    if version == 2:
        mask = b"legacy_count_only:" + struct.pack("<I", value_count // n_comp)
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
    return payload[value_offset:], mask


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


def is_startup_clock_regression(error: RuntimeError, runtime_log_path: Path) -> bool:
    if "interactive runtime exited before solve gate" not in str(error):
        return False
    try:
        runtime_log = runtime_log_path.read_text(encoding="utf-8")
    except OSError:
        return False
    return re.search(
        r"timestamp \d+ precedes (?:RuntimeStartup|ScriptMaterialization) start \d+",
        runtime_log,
    ) is not None


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
    env.update(
        {
            "FULLMAG_API_PORT": str(api_port),
            "FULLMAG_CPU_THREADS": "1",
            "FULLMAG_FDM_EXECUTION": "cpu",
            "FULLMAG_FEM_EXECUTION": "gpu",
            "FULLMAG_GMSH_THREADS": "1",
            "FULLMAG_PREVIEW_EVERY_N": str(cadence),
            "FULLMAG_PREVIEW_MATRIX_MAX_STEPS": str(MATRIX_MAX_STEPS),
            "FULLMAG_PREVIEW_MATRIX_MODE": mode,
            "FULLMAG_PREVIEW_MATRIX_SURFACE": surface,
            "FULLMAG_PYTHON": str(PYTHON),
            "FULLMAG_RELAX_DEVICE": "gpu",
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
) -> dict[str, Any]:
    env = common_runtime_env(mode, cadence, surface, no_opener_path, api_port)
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
                if surface == "control_room":
                    browser_env = env.copy()
                    browser_env.update(
                        {
                            "CONTROL_ROOM_API_BASE_URL": api_base,
                            "CONTROL_ROOM_PREVIEW_MATRIX_TIMEOUT_MS": str(int(timeout_seconds * 1000)),
                            "CONTROL_ROOM_URL": api_base + "/workspace",
                        }
                    )
                    browser = browser_smoke(browser_env, browser_log_path, timeout_seconds)
                submit_command(api_base, "solve", f"fem_preview_surface_matrix:{session_id}")
                wait_terminal_stage(api_base, timeout_seconds)
                field_proof = field_resource_proof(api_base, mode, timeout_seconds)
                if browser is not None:
                    browser_proof = finish_browser_smoke(browser, browser_log_path, timeout_seconds)
                    browser = None
                    if browser_proof.get("payloadSha256") != field_proof.get("payload_sha256"):
                        raise RuntimeError(
                            "Control Room subscriber payload hash differs from direct resource payload"
                        )
                    if browser_proof.get("maskSha256") != field_proof.get("mask_sha256"):
                        raise RuntimeError(
                            "Control Room subscriber mask hash differs from direct resource mask"
                        )
            finally:
                if browser is not None:
                    browser.terminate()
                    try:
                        browser.wait(timeout=10.0)
                    except subprocess.TimeoutExpired:
                        browser.kill()
                close_interactive_runtime(api_base, runtime, timeout_seconds)

    proof = {
        **artifact_proof(output_dir),
        **field_proof,
        "browser_field_request_count": browser_proof.get("fieldRequestCount") if browser_proof else None,
        "elapsed_ms": (time.perf_counter() - started) * 1000.0,
    }
    return proof


def assert_equivalence(rows: list[dict[str, Any]]) -> dict[str, Any]:
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
    enabled = [row for row in rows if row["mode"] != "disabled" and row["surface"] != "headless"]
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

    with tempfile.TemporaryDirectory(prefix="fullmag-preview-no-opener-") as no_opener_dir:
        which_wrapper = Path(no_opener_dir) / "which"
        which_wrapper.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        which_wrapper.chmod(0o755)
        with api_log_path.open("w", encoding="utf-8") as api_log:
            api = subprocess.Popen(
                [str(API)],
                cwd=ROOT,
                env=api_env,
                stdout=api_log,
                stderr=subprocess.STDOUT,
                text=True,
            )
            rows: list[dict[str, Any]] = []
            warmup_count = 0
            try:
                wait_api(api_base, api, args.timeout_seconds)
                for mode in modes:
                    for cadence in cadences:
                        for surface in surfaces:
                            for repeat in range(args.repeats + 1):
                                warmup = repeat == 0
                                label = f"{mode}-c{cadence}-{surface}-r{repeat}"
                                print(f"[fem-preview-matrix] {label} ({'warmup' if warmup else 'measured'})", flush=True)
                                attempt = 0
                                while True:
                                    attempt_label = label if attempt == 0 else f"{label}-clock-retry-{attempt}"
                                    try:
                                        proof = run_row(
                                            api_base=api_base,
                                            api_port=args.api_port,
                                            cadence=cadence,
                                            mode=mode,
                                            no_opener_path=no_opener_dir,
                                            output_dir=outputs_dir / attempt_label,
                                            row_log_dir=logs_dir / attempt_label,
                                            surface=surface,
                                            timeout_seconds=args.timeout_seconds,
                                        )
                                        break
                                    except RuntimeError as error:
                                        runtime_log_path = logs_dir / attempt_label / "runtime.log"
                                        if attempt == 0 and is_startup_clock_regression(error, runtime_log_path):
                                            attempt += 1
                                            print(
                                                f"[fem-preview-matrix] {label} retrying once after host clock regression",
                                                flush=True,
                                            )
                                            continue
                                        raise
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
            finally:
                api.send_signal(signal.SIGTERM)
                try:
                    api.wait(timeout=10.0)
                except subprocess.TimeoutExpired:
                    api.kill()
                    api.wait(timeout=10.0)

    if len(rows) != expected_measured_rows:
        raise RuntimeError(f"matrix row count mismatch: {len(rows)} != {expected_measured_rows}")
    (report_dir / "raw_rows.json").write_text(json.dumps(rows) + "\n", encoding="utf-8")
    equivalence = assert_equivalence(rows)
    columns = [column for column in rows[0] if not column.startswith("_")]
    with (report_dir / "matrix.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(
            {column: row[column] for column in columns}
            for row in rows
        )
    elapsed_values = sorted(float(row["elapsed_ms"]) for row in rows)
    summary = {
        "cadences": list(cadences),
        "equivalence": equivalence,
        "measured_rows": len(rows),
        "modes": list(modes),
        "p50_surface_elapsed_ms": elapsed_values[len(elapsed_values) // 2],
        "repeats_per_variant": args.repeats,
        "surfaces": list(surfaces),
        "warmup_rows": warmup_count,
    }
    (report_dir / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(f"[fem-preview-matrix] PASS {json.dumps(summary, sort_keys=True)}")
    print(f"[fem-preview-matrix] report_dir={report_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
