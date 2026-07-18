#!/usr/bin/env python3
"""Validate the live planar-monitor API and write a bounded science report."""

from __future__ import annotations

import argparse
import json
import math
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def request_json(base: str, path: str) -> dict[str, Any]:
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=10) as response:
        return json.load(response)


def post_json(base: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def request_bytes(base: str, path: str) -> bytes:
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=10) as response:
        return response.read()


def wait_json(base: str, path: str, timeout_s: float = 180.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return request_json(base, path)
        except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(0.5)
    raise RuntimeError(f"resource did not become ready: {path}: {last_error}")


def decode_fmvp_scalar(payload: bytes) -> list[float]:
    if len(payload) < 48 or payload[:4] != b"FMVP":
        raise ValueError("scalar payload is not FMVP")
    version, kind, components = payload[4], payload[5], payload[6]
    if version not in (2, 3) or kind != 1 or components != 1:
        raise ValueError(
            f"unexpected FMVP scalar header version={version} kind={kind} components={components}"
        )
    metadata_length, value_count = struct.unpack_from("<II", payload, 8)
    offset = 48 + metadata_length
    expected = offset + value_count * 8
    if len(payload) != expected:
        raise ValueError(f"FMVP length mismatch: expected {expected}, got {len(payload)}")
    return list(struct.unpack_from(f"<{value_count}d", payload, offset))


def finite_stats(values: list[float]) -> dict[str, float | int]:
    finite = [value for value in values if math.isfinite(value)]
    if not finite:
        raise ValueError("planar scalar payload contains no finite samples")
    mean = sum(finite) / len(finite)
    return {
        "count": len(finite),
        "max": max(finite),
        "mean": mean,
        "min": min(finite),
        "rms_error_from_unit_magnitude": math.sqrt(
            sum((value - 1.0) ** 2 for value in finite) / len(finite)
        ),
    }


def monitor_report(base: str, monitor_id: str) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "component": "magnitude",
            "include_mesh": "true",
            "quality": "export",
            "resolution_x": 32,
            "resolution_y": 32,
            "vector_budget": 128,
        }
    )
    prefix = (
        f"/v2/sessions/current/data/fields/m/planar-monitors/"
        f"{urllib.parse.quote(monitor_id, safe='')}"
    )
    meta = wait_json(base, f"{prefix}/meta?{query}")
    scalar = decode_fmvp_scalar(request_bytes(base, f"{prefix}/scalar?{query}"))
    bounds = meta["frame"]["bounds_uv_m"]
    u_m = (bounds[0] + bounds[1]) * 0.5
    v_m = (bounds[2] + bounds[3]) * 0.5
    probe = wait_json(
        base,
        f"{prefix}/probe?"
        + urllib.parse.urlencode(
            {"component": "magnitude", "u_m": u_m, "v_m": v_m}
        ),
    )
    stats = finite_stats(scalar)
    return {
        "basis_order": meta["basis_order"],
        "field_revision": meta["field_revision"],
        "generation_id": meta["generation_id"],
        "mesh_revision": meta["mesh_revision"],
        "monitor_revision": meta["monitor_revision"],
        "occupancy": meta["occupancy"],
        "probe": {
            "cell_id": probe.get("cell_id"),
            "element_id": probe.get("element_id"),
            "occupancy": probe["occupancy"],
            "scalar": probe.get("scalar"),
            "world_m": probe["world_m"],
        },
        "sampling_execution": meta["sampling_execution"],
        "sampling_method": meta["sampling_method"],
        "stats": stats,
    }


def status_execution(status: dict[str, Any]) -> dict[str, Any]:
    session = status.get("session") or {}
    return {
        "requested_backend": session.get("requested_backend"),
        "requested_device": session.get("requested_device"),
        "resolved_backend": session.get("resolved_backend"),
        "resolved_device": session.get("resolved_device"),
        "resolved_runtime_family": session.get("resolved_runtime_family"),
    }


def start_fixture_solver(base: str) -> str:
    command = post_json(
        base,
        "/v2/sessions/current/simulation/commands",
        {
            "client_intent_id": f"viewport-2d-planar-smoke:{time.time_ns()}",
            "kind": "solve",
            "reason": "viewport_2d_planar_monitor_smoke",
            "requested_at_unix_ms": int(time.time() * 1000),
            "target": {"kind": "study"},
        },
    )
    command_id = command.get("command_id")
    if not command.get("accepted") or not isinstance(command_id, str):
        raise RuntimeError(f"solve command was rejected: {command}")
    return command_id


def stop_fixture_solver(base: str, solve_command_id: str) -> None:
    stop = post_json(
        base,
        "/v2/sessions/current/simulation/commands",
        {
            "client_intent_id": f"viewport-2d-planar-smoke:stop:{time.time_ns()}",
            "kind": "stop",
            "reason": f"viewport_2d_planar_monitor_smoke:{solve_command_id}",
            "requested_at_unix_ms": int(time.time() * 1000),
            "target": {"kind": "current_stage"},
        },
    )
    if not stop.get("accepted"):
        raise RuntimeError(f"stop command was rejected: {stop}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-base", required=True)
    parser.add_argument("--backend", choices=("fdm", "fem"), required=True)
    parser.add_argument("--device", choices=("cpu", "gpu"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    collection = wait_json(
        args.api_base, "/v2/sessions/current/model/planar-monitors"
    )
    monitor_ids = [entry["id"] for entry in collection.get("monitors", [])]
    required = (
        {"xy-plane", "xy-slab", "depth-mean", "oblique-plane"}
        if args.backend == "fdm"
        else {"xy-plane", "xy-slab", "depth-mean", "object-surface"}
    )
    missing = sorted(required.difference(monitor_ids))
    if missing:
        raise RuntimeError(f"fixture did not publish required monitors: {missing}")

    solve_command_id = start_fixture_solver(args.api_base)
    try:
        monitors = {
            monitor_id: monitor_report(args.api_base, monitor_id)
            for monitor_id in sorted(required)
        }
    finally:
        stop_fixture_solver(args.api_base, solve_command_id)
    max_error = max(
        float(result["stats"]["rms_error_from_unit_magnitude"])
        for result in monitors.values()
    )
    occupancy_ok = all(
        result["occupancy"]["occupied"] + result["occupancy"]["partial"] > 0
        for result in monitors.values()
    )
    probe_id_ok = all(
        (
            result["probe"]["cell_id"] is not None
            if args.backend == "fdm"
            else result["probe"]["element_id"] is not None
        )
        for monitor_id, result in monitors.items()
        if monitor_id in {"xy-plane"}
    )
    axis_mean = float(monitors["xy-plane"]["stats"]["mean"])
    comparison_monitor = "oblique-plane" if args.backend == "fdm" else "xy-slab"
    parity_error = abs(
        axis_mean - float(monitors[comparison_monitor]["stats"]["mean"])
    )
    gates = {
        "constant_vector_unit_magnitude": max_error <= 1e-6,
        "occupied_support": occupancy_ok,
        "plane_probe_source_identity": probe_id_ok,
        "plane_operator": "xy-plane" in monitors,
        "slab_operator": "xy-slab" in monitors,
        "depth_operator": "depth-mean" in monitors,
        "axis_or_operator_parity": parity_error <= 1e-6,
        "surface_operator": args.backend == "fdm" or "object-surface" in monitors,
        "sampling_is_explicit_cpu_postprocessor": all(
            result["sampling_execution"] == "cpu" for result in monitors.values()
        ),
    }
    report = {
        "backend": args.backend,
        "device": args.device,
        "execution": status_execution(
            wait_json(args.api_base, "/v2/sessions/current/status")
        ),
        "gates": gates,
        "metrics": {
            "axis_or_operator_parity_error": parity_error,
            "max_rms_error_from_unit_magnitude": max_error,
        },
        "monitor_collection_revision": collection["scene_revision"],
        "monitors": monitors,
        "pass": all(gates.values()),
        "schema_version": "viewport-2d-planar-science-report-v1",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if not report["pass"]:
        raise SystemExit(f"planar science gates failed: {args.output}")
    print(f"Planar science report passed: {args.output}")


if __name__ == "__main__":
    main()
