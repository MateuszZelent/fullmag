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
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace").strip()
            last_error = RuntimeError(
                f"HTTP {error.code} {error.reason}: {body or '<empty response body>'}"
            )
            time.sleep(0.5)
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


def finite_stats(
    values: list[float], *, reference: float | None = None
) -> dict[str, float | int]:
    finite = [value for value in values if math.isfinite(value)]
    if not finite:
        raise ValueError("planar scalar payload contains no finite samples")
    mean = sum(finite) / len(finite)
    stats: dict[str, float | int] = {
        "count": len(finite),
        "max": max(finite),
        "mean": mean,
        "min": min(finite),
    }
    if reference is not None:
        stats["rms_error"] = math.sqrt(
            sum((value - reference) ** 2 for value in finite) / len(finite)
        )
    return stats


def occupied_probe_coordinates(
    meta: dict[str, Any], values: list[float], occupancy: bytes
) -> tuple[float, float]:
    width, height = (int(value) for value in meta["resolution"])
    bounds = meta["frame"]["bounds_uv_m"]
    if len(values) != len(occupancy):
        raise ValueError(
            f"scalar/mask length mismatch: {len(values)} != {len(occupancy)}"
        )
    candidates: list[tuple[float, int, float, float]] = []
    for index, (value, support) in enumerate(zip(values, occupancy, strict=True)):
        if support not in (0, 2, 4) or not math.isfinite(value):
            continue
        x_index = index % width
        y_index = index // width
        u_m = bounds[0] + (x_index + 0.5) * (bounds[1] - bounds[0]) / width
        v_m = bounds[2] + (y_index + 0.5) * (bounds[3] - bounds[2]) / height
        candidates.append((u_m * u_m + v_m * v_m, index, u_m, v_m))
    if not candidates:
        raise ValueError("planar field contains no occupied samples for a probe")
    _, _, u_m, v_m = min(candidates)
    return u_m, v_m


def monitor_report(
    base: str,
    monitor_id: str,
    *,
    component: str,
    quantity_id: str,
    validate_linear_ms: bool = False,
) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "component": component,
            "include_mesh": "true",
            "quality": "export",
            "resolution_x": 32,
            "resolution_y": 32,
            "vector_budget": 128,
        }
    )
    prefix = (
        f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity_id, safe='')}/planar-monitors/"
        f"{urllib.parse.quote(monitor_id, safe='')}"
    )
    meta = wait_json(base, f"{prefix}/meta?{query}")
    scalar = decode_fmvp_scalar(request_bytes(base, f"{prefix}/scalar?{query}"))
    occupancy = request_bytes(base, f"{prefix}/empty-mask?{query}")
    if len(scalar) != len(occupancy):
        raise ValueError(
            f"scalar/mask length mismatch: {len(scalar)} != {len(occupancy)}"
        )
    scalar = [
        value if support in (0, 2, 4) else math.nan
        for value, support in zip(scalar, occupancy, strict=True)
    ]
    try:
        u_m, v_m = occupied_probe_coordinates(meta, scalar, occupancy)
    except ValueError as error:
        occupancy_counts = {
            code: occupancy.count(code) for code in sorted(set(occupancy))
        }
        raise ValueError(
            f"{error}: monitor_id={monitor_id!r}, occupancy_codes={occupancy_counts}, "
            f"meta_occupancy={meta.get('occupancy')!r}"
        ) from error
    probe = wait_json(
        base,
        f"{prefix}/probe?"
        + urllib.parse.urlencode(
            {
                "component": component,
                "resolution_x": meta["resolution"][0],
                "resolution_y": meta["resolution"][1],
                "u_m": u_m,
                "v_m": v_m,
            }
        ),
    )
    if probe.get("scalar") is None:
        raise RuntimeError(
            "occupied raster sample resolved to an empty probe: "
            f"monitor_id={monitor_id!r}, u_m={u_m}, v_m={v_m}, "
            f"sample_support={meta.get('sample_support')!r}, "
            f"probe_occupancy={probe.get('occupancy')!r}, "
            f"probe_cell_id={probe.get('cell_id')!r}, "
            f"probe_element_id={probe.get('element_id')!r}"
        )
    stats = finite_stats(scalar, reference=1.0 if quantity_id == "m" else None)
    report = {
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
    if validate_linear_ms:
        report["linear_validation"] = linear_ms_validation(meta, scalar, probe)
    return report


def linear_ms_validation(
    meta: dict[str, Any],
    values: list[float],
    probe: dict[str, Any],
) -> dict[str, Any]:
    width, height = (int(value) for value in meta["resolution"])
    bounds = meta["frame"]["bounds_uv_m"]
    origin = meta["frame"]["origin_m"]
    u_axis = meta["frame"]["u_axis"]
    v_axis = meta["frame"]["v_axis"]
    comparisons: list[tuple[float, float]] = []
    serialized_values: list[float | None] = []
    for index, observed in enumerate(values):
        if not math.isfinite(observed):
            serialized_values.append(None)
            continue
        x_index = index % width
        y_index = index // width
        u_m = bounds[0] + (x_index + 0.5) * (bounds[1] - bounds[0]) / width
        v_m = bounds[2] + (y_index + 0.5) * (bounds[3] - bounds[2]) / height
        x_m = origin[0] + u_m * u_axis[0] + v_m * v_axis[0]
        expected = 800e3 + 1e12 * x_m
        comparisons.append((observed, expected))
        serialized_values.append(observed)
    if not comparisons:
        raise ValueError("linear material field contains no finite samples")
    errors = [observed - expected for observed, expected in comparisons]
    rms_error = math.sqrt(sum(error * error for error in errors) / len(errors))
    max_error = max(abs(error) for error in errors)
    probe_world = probe.get("world_m") or [0.0, 0.0, 0.0]
    probe_expected = 800e3 + 1e12 * float(probe_world[0])
    probe_observed = float(probe["scalar"])
    return {
        "analytic": "Ms(x)=800000 A/m + (1e12 A/m^2)*x",
        "max_abs_error_A_per_m": max_error,
        "probe_abs_error_A_per_m": abs(probe_observed - probe_expected),
        "raster_values_A_per_m": serialized_values,
        "rms_error_A_per_m": rms_error,
    }


def run_execution(
    run: dict[str, Any], expected_backend: str, expected_device: str
) -> tuple[dict[str, Any], bool]:
    execution = {
        "requested_backend": run.get("requested_backend"),
        "requested_device": run.get("requested_device"),
        "resolved_backend": run.get("resolved_backend"),
        "resolved_device": run.get("resolved_device"),
        "resolved_runtime_family": run.get("resolved_runtime_family"),
    }
    requested_device_matches = (
        execution["requested_device"] in {"gpu", "cuda"}
        if expected_device == "gpu"
        else execution["requested_device"] == expected_device
    )
    matches = all(
        (
            execution["requested_backend"] == expected_backend,
            requested_device_matches,
            execution["resolved_backend"] == expected_backend,
            execution["resolved_device"] == expected_device,
            isinstance(execution["resolved_runtime_family"], str),
            bool(execution["resolved_runtime_family"]),
        )
    )
    return execution, matches


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


def is_terminal_stop_conflict(status: int, body: str) -> bool:
    if status != 409:
        return False
    return any(
        message in body
        for message in (
            "stop command requires a compatible runtime state; got completed",
            "stop command requires a compatible runtime state; got idle",
            "stop command requires a compatible runtime state; got ready",
            "stage control command requires an active stage",
        )
    )


def is_transitional_stop_conflict(status: int, body: str) -> bool:
    return (
        status == 409
        and "stop command requires a compatible runtime state; got waiting_for_compute"
        in body
    )


def stop_fixture_solver(base: str, solve_command_id: str) -> None:
    deadline = time.monotonic() + 10.0
    while True:
        try:
            stop = post_json(
                base,
                "/v2/sessions/current/simulation/commands",
                {
                    "client_intent_id": (
                        f"viewport-2d-planar-smoke:stop:{time.time_ns()}"
                    ),
                    "kind": "stop",
                    "reason": f"viewport_2d_planar_monitor_smoke:{solve_command_id}",
                    "requested_at_unix_ms": int(time.time() * 1000),
                    "target": {"kind": "current_stage"},
                },
            )
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace").strip()
            if is_terminal_stop_conflict(error.code, body):
                return
            if (
                is_transitional_stop_conflict(error.code, body)
                and time.monotonic() < deadline
            ):
                time.sleep(0.1)
                continue
            raise RuntimeError(
                f"stop command failed with HTTP {error.code} {error.reason}: "
                f"{body or '<empty response body>'}"
            ) from error
        if not stop.get("accepted"):
            raise RuntimeError(f"stop command was rejected: {stop}")
        return


def synchronize_cross_backend_reports(current_output: Path) -> None:
    report_root = current_output.parent.parent
    fdm_path = report_root / "fdm-cpu" / "science-report.json"
    for fem_lane in ("fem-cpu", "fem-gpu"):
        fem_path = report_root / fem_lane / "science-report.json"
        if not fdm_path.exists() or not fem_path.exists():
            continue
        fdm = json.loads(fdm_path.read_text())
        fem = json.loads(fem_path.read_text())
        fdm_monitor = fdm["linear_material_monitors"]["xy-plane"]
        fem_monitor = fem["linear_material_monitors"]["xy-plane"]
        fdm_rms = float(
            fdm_monitor["linear_validation"]["rms_error_A_per_m"]
        )
        fem_rms = float(
            fem_monitor["linear_validation"]["rms_error_A_per_m"]
        )
        combined_rms = math.sqrt(0.5 * (fdm_rms * fdm_rms + fem_rms * fem_rms))
        scale = max(
            1.0,
            0.5
            * (
                abs(float(fdm_monitor["stats"]["mean"]))
                + abs(float(fem_monitor["stats"]["mean"]))
            ),
        )
        relative_rms = combined_rms / scale
        passed = relative_rms <= 5e-3
        metric = {
            "comparison_method": "shared_manufactured_field_error",
            "fdm_finite_sample_count": int(fdm_monitor["stats"]["count"]),
            "fdm_rms_A_per_m": fdm_rms,
            "fem_finite_sample_count": int(fem_monitor["stats"]["count"]),
            "fem_rms_A_per_m": fem_rms,
            "relative_rms": relative_rms,
            "rms_A_per_m": combined_rms,
        }
        gate_id = f"cross_backend_linear_scalar_{fem_lane.replace('-', '_')}"
        for path, report in ((fdm_path, fdm), (fem_path, fem)):
            report["gates"][gate_id] = passed
            report["metrics"][gate_id] = metric
            report["pass"] = all(report["gates"].values())
            path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        comparison_path = report_root / f"cross-backend-fdm-cpu-{fem_lane}.json"
        comparison_path.write_text(
            json.dumps(
                {
                    "fdm_report": str(fdm_path),
                    "fem_report": str(fem_path),
                    "metrics": metric,
                    "pass": passed,
                    "schema_version": "viewport-2d-cross-backend-report-v2",
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )


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

    linear_monitors = {
        monitor_id: monitor_report(
            args.api_base,
            monitor_id,
            component="scalar",
            quantity_id="mat_ms",
            validate_linear_ms=True,
        )
        for monitor_id in sorted(required)
    }

    solve_command_id = start_fixture_solver(args.api_base)
    try:
        monitors = {
            monitor_id: monitor_report(
                args.api_base,
                monitor_id,
                component="magnitude",
                quantity_id="m",
            )
            for monitor_id in sorted(required)
        }
    finally:
        stop_fixture_solver(args.api_base, solve_command_id)
    max_error = max(
        float(result["stats"]["rms_error"])
        for result in monitors.values()
    )
    max_linear_rms_error = max(
        float(result["linear_validation"]["rms_error_A_per_m"])
        for result in linear_monitors.values()
    )
    max_linear_probe_error = max(
        float(result["linear_validation"]["probe_abs_error_A_per_m"])
        for result in linear_monitors.values()
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
        "linear_scalar_analytic_rms": max_linear_rms_error <= 3_000.0,
        "linear_scalar_probe": max_linear_probe_error <= 3_000.0,
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
    execution, execution_matches = run_execution(
        wait_json(
            args.api_base,
            "/v2/sessions/current/simulation/runs/current",
        ),
        args.backend,
        args.device,
    )
    gates["execution_provenance_matches_requested_lane"] = execution_matches
    report = {
        "backend": args.backend,
        "device": args.device,
        "execution": execution,
        "gates": gates,
        "metrics": {
            "axis_or_operator_parity_error": parity_error,
            "max_rms_error_from_unit_magnitude": max_error,
            "max_linear_probe_error_A_per_m": max_linear_probe_error,
            "max_linear_rms_error_A_per_m": max_linear_rms_error,
        },
        "monitor_collection_revision": collection["scene_revision"],
        "linear_material_monitors": linear_monitors,
        "monitors": monitors,
        "pass": all(gates.values()),
        "schema_version": "viewport-2d-planar-science-report-v1",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    synchronize_cross_backend_reports(args.output)
    report = json.loads(args.output.read_text())
    if not report["pass"]:
        raise SystemExit(f"planar science gates failed: {args.output}")
    print(f"Planar science report passed: {args.output}")


if __name__ == "__main__":
    main()
