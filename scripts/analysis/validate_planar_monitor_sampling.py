#!/usr/bin/env python3
"""Validate the live planar-monitor API and write a bounded science report."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


QUALIFICATION_REQUIREMENTS = (
    ("live-m-xy-plane", "live m magnitude on an XY plane"),
    ("live-m-xz-plane", "live m on an XZ plane"),
    ("live-m-yz-plane", "live m on a YZ plane"),
    ("live-m-scalar-payload", "live scalar payload for a selected m component"),
    ("live-m-vector-payload", "live vector payload for m"),
    ("live-m-arbitrary-components", "arbitrary-frame m components u/v/normal"),
    ("live-m-slab", "measure-weighted live m slab"),
    ("live-m-depth", "live m depth projection"),
    ("live-m-surface", "live m surface projection where legal"),
    ("live-h-eff", "live H_eff"),
    ("live-h-demag", "live H_demag"),
    ("live-material-scalar", "live scalar material field"),
    ("target-domain", "domain monitor target"),
    ("target-magnetic", "magnetic-domain monitor target"),
    ("target-object", "object monitor target"),
    ("target-region-or-part", "region monitor target or exact mesh-part scope"),
    ("target-airbox", "airbox scope where the quantity carrier is legal"),
    ("persisted-m-xy-plane", "persisted snapshot m through the planar resource"),
    ("constant-field-oracle", "constant field in every occupied bin"),
    ("linear-slab-oracle", "analytic linear-field slab average"),
    ("refinement-invariance", "measure-weighted refinement invariance"),
    ("rotated-basis-signs", "right-handed rotated u/v/n basis and signs"),
    ("cross-backend-parity", "FDM/FEM shared-geometry parity"),
    ("fdm-object-isolation", "FDM object isolation"),
    ("airbox-carrier-provenance", "airbox source-carrier provenance"),
    ("fem-compact-full-parity", "compact/full FEM field parity"),
)
NOT_APPLICABLE_CASES = {
    "fdm": {"live-m-surface", "fem-compact-full-parity"},
    "fem": {
        "fdm-object-isolation",
    },
}
NOT_APPLICABLE_REASONS = {
    ("fdm", "live-m-surface"): "surface_projection is not legal for the FDM planar sampler",
    ("fdm", "fem-compact-full-parity"): "FEM carrier layout parity does not apply to FDM",
    ("fem", "fdm-object-isolation"): "FDM grid object isolation does not apply to FEM",
}
SLAB_ORACLE = {
    "field_gradient_z_A_per_m2": 2e12,
    "film_z_bounds_m": [-10e-9, 10e-9],
    "frame_position_z_m": 5e-9,
    "thickness_m": 30e-9,
}
COMPACT_FULL_CONTRACT = (
    "planar_sampling::target_tests::"
    "compact_fem_plane_and_slab_match_equivalent_full_carrier"
)
REPORT_MONITOR_FIELDS = {
    "carrier_revision",
    "exact_sample_identity",
    "field_revision",
    "frame",
    "generation_id",
    "mesh_revision",
    "monitor_hash",
    "monitor_id",
    "monitor_revision",
    "oracle",
    "operator",
    "probe",
    "quantity_id",
    "sample_token",
    "scene_revision",
    "target",
    "mask_exact_sample_identity",
    "mask_identity",
    "vector_exact_sample_identity",
    "vector_constant_max_error",
    "vector_identity",
    "vector_value_count",
}


def validate_qualification_report(report: dict[str, Any]) -> None:
    for field in (
        "execution",
        "head",
        "monitors",
        "qualification_cases",
        "runtime_bundle_identity",
    ):
        if not report.get(field):
            raise ValueError(f"qualification report is missing {field}")
    execution = report["execution"]
    for field in (
        "requested_backend",
        "requested_device",
        "resolved_backend",
        "resolved_device",
    ):
        if not execution.get(field):
            raise ValueError(f"qualification report execution is missing {field}")
    runtime_identity = report["runtime_bundle_identity"]
    for field in ("runtime_bundle_version", "resolved_runtime_family"):
        if not runtime_identity.get(field):
            raise ValueError(f"qualification report runtime identity is missing {field}")
    for monitor_id, monitor in report["monitors"].items():
        missing = sorted(REPORT_MONITOR_FIELDS.difference(monitor))
        if missing:
            raise ValueError(
                f"qualification report monitor {monitor_id} is missing {', '.join(missing)}"
            )


def git_head(repo_root: Path | None = None) -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root or Path(__file__).resolve().parents[2],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def build_qualification_cases(
    *, backend: str, device: str, executed_case_ids: set[str]
) -> list[dict[str, Any]]:
    cases = []
    for case_id, requirement in QUALIFICATION_REQUIREMENTS:
        required = case_id not in NOT_APPLICABLE_CASES[backend]
        passed = required and case_id in executed_case_ids
        status = (
            "not_applicable"
            if not required
            else "passed"
            if passed
            else "blocked"
        )
        cases.append(
            {
                "backend": backend,
                "blocker": None
                if passed
                else NOT_APPLICABLE_REASONS[(backend, case_id)]
                if not required
                else "this managed lane run did not execute this required case",
                "case_id": case_id,
                "device": device,
                "passed": passed,
                "required": required,
                "requirement": requirement,
                "status": status,
            }
        )
    return cases


def build_fdm_gpu_no_go(head: str) -> dict[str, Any]:
    return {
        "schema_version": "viewport-2d-fdm-gpu-gate-v1",
        "head": head,
        "lane": "fdm-gpu",
        "qualified": False,
        "qualification_status": "no_go",
        "reason": (
            "FDM GPU must pass its own runtime gate; FDM CPU evidence is not inherited, "
            "and the required Task 10 recipe matrix has no FDM GPU invocation."
        ),
    }


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


def request_bytes_with_headers(base: str, path: str) -> tuple[bytes, dict[str, str]]:
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=10) as response:
        return response.read(), {key.lower(): value for key, value in response.headers.items()}


def request_bytes(base: str, path: str) -> bytes:
    return request_bytes_with_headers(base, path)[0]


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )


def verify_compact_full_contract_log(log_path: Path, output: Path) -> dict[str, Any]:
    log_bytes = log_path.read_bytes()
    log = log_bytes.decode("utf-8", errors="replace")
    exact_test = (
        "test planar_sampling::target_tests::"
        "compact_fem_plane_and_slab_match_equivalent_full_carrier ... ok"
    )
    passed = exact_test in log and "test result: ok." in log
    report = {
        "contract": COMPACT_FULL_CONTRACT,
        "executor": "container-backed cargo test -p fullmag-api",
        "exit_status": 0 if passed else None,
        "head": git_head(),
        "log_path": str(log_path),
        "log_sha256": hashlib.sha256(log_bytes).hexdigest(),
        "lane_scope": "backend-neutral-sampler-contract",
        "pass": passed,
        "schema_version": "viewport-2d-compact-full-contract-v1",
    }
    write_json(output, report)
    return report


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


def decode_fmvp(payload: bytes, *, expected_components: int) -> list[float]:
    if len(payload) < 48 or payload[:4] != b"FMVP":
        raise ValueError("scalar payload is not FMVP")
    version, kind, components = payload[4], payload[5], payload[6]
    if version not in (2, 3) or kind != 1 or components != expected_components:
        raise ValueError(
            f"unexpected FMVP scalar header version={version} kind={kind} components={components}"
        )
    metadata_length, value_count = struct.unpack_from("<II", payload, 8)
    offset = 48 + metadata_length
    expected = offset + value_count * 8
    if len(payload) != expected:
        raise ValueError(f"FMVP length mismatch: expected {expected}, got {len(payload)}")
    return list(struct.unpack_from(f"<{value_count}d", payload, offset))


def decode_fmvp_scalar(payload: bytes) -> list[float]:
    return decode_fmvp(payload, expected_components=1)


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


def exact_sample_identity_matches(
    meta: dict[str, Any], scalar_headers: dict[str, str]
) -> bool:
    return bool(
        meta.get("sample_token")
        and meta.get("etag")
        and scalar_headers.get("etag") == meta.get("etag")
    )


def canonical_sample_links_match(meta: dict[str, Any]) -> bool:
    expected = {
        "sample_token": str(meta.get("sample_token")),
        "expected_scene_revision": str(meta.get("scene_revision")),
        "expected_monitor_revision": str(meta.get("monitor_revision")),
        "expected_mesh_revision": str(meta.get("mesh_revision")),
        "expected_carrier_revision": str(meta.get("carrier_revision")),
        "expected_field_revision": str(meta.get("field_revision")),
    }
    links = meta.get("links") or {}
    for name in ("scalar", "vectors", "empty_mask", "probe"):
        link = links.get(name)
        if not isinstance(link, str):
            return False
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(link).query)
        if any(query.get(key) != [value] for key, value in expected.items()):
            return False
    return True


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
    stage_id: str | None = None,
    snapshot_id: str | None = None,
    validate_linear_ms: bool = False,
    wait_timeout_s: float = 180.0,
    resolution: int = 32,
    scope_kind: str | None = None,
    expected_field_revision: int | None = None,
) -> dict[str, Any]:
    query_parameters = {
        "component": component,
        "include_mesh": "true",
        "quality": "export",
        "resolution_x": resolution,
        "resolution_y": resolution,
        "vector_budget": 128,
    }
    if stage_id is not None:
        query_parameters["stage_id"] = stage_id
    if snapshot_id is not None:
        query_parameters["snapshot_id"] = snapshot_id
    if scope_kind is not None:
        query_parameters["scope_kind"] = scope_kind
    if expected_field_revision is not None:
        query_parameters["expected_field_revision"] = expected_field_revision
    query = urllib.parse.urlencode(query_parameters)
    prefix = (
        f"/v2/sessions/current/data/fields/{urllib.parse.quote(quantity_id, safe='')}/planar-monitors/"
        f"{urllib.parse.quote(monitor_id, safe='')}"
    )
    meta = wait_json(base, f"{prefix}/meta?{query}", timeout_s=wait_timeout_s)
    if not canonical_sample_links_match(meta):
        raise RuntimeError("planar metadata links do not bind the canonical sample revisions")
    scalar_payload, scalar_headers = request_bytes_with_headers(
        base, meta["links"]["scalar"]
    )
    scalar = decode_fmvp_scalar(scalar_payload)
    vector_identity = None
    vector_value_count = 0
    vector_exact_sample_identity = False
    if quantity_id == "m":
        vector_payload, vector_headers = request_bytes_with_headers(
            base, meta["links"]["vectors"]
        )
        vector_values = decode_fmvp(vector_payload, expected_components=3)
        vector_value_count = len(vector_values)
        vector_identity = vector_headers.get("etag")
        vector_exact_sample_identity = exact_sample_identity_matches(
            meta, vector_headers
        )
    occupancy, mask_headers = request_bytes_with_headers(
        base, meta["links"]["empty_mask"]
    )
    if len(scalar) != len(occupancy):
        raise ValueError(
            f"scalar/mask length mismatch: {len(scalar)} != {len(occupancy)}"
        )
    scalar = [
        value if support in (0, 2, 4) else math.nan
        for value, support in zip(scalar, occupancy, strict=True)
    ]
    vector_constant_max_error = None
    if quantity_id == "m":
        occupied_vectors = [
            vector_values[index * 3 : index * 3 + 3]
            for index, support in enumerate(occupancy)
            if support in (0, 2, 4)
        ]
        if occupied_vectors:
            vector_constant_max_error = max(
                abs(vector[axis] - expected)
                for vector in occupied_vectors
                for axis, expected in enumerate((1.0, 0.0, 0.0))
            )
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
    probe_link = urllib.parse.urlsplit(meta["links"]["probe"])
    probe_query = {
        key: values[-1]
        for key, values in urllib.parse.parse_qs(probe_link.query).items()
    }
    probe_query.update({"u_m": u_m, "v_m": v_m})
    probe = wait_json(
        base,
        probe_link.path + "?" + urllib.parse.urlencode(probe_query),
        timeout_s=wait_timeout_s,
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
    scalar_identity = scalar_headers.get("etag")
    exact_sample_identity = exact_sample_identity_matches(meta, scalar_headers)
    mask_exact_sample_identity = exact_sample_identity_matches(meta, mask_headers)
    report = {
        "basis_order": meta["basis_order"],
        "carrier_revision": meta["carrier_revision"],
        "exact_sample_identity": exact_sample_identity,
        "field_revision": meta["field_revision"],
        "field_source": meta["field_source"],
        "frame": meta["frame"],
        "generation_id": meta["generation_id"],
        "mesh_revision": meta["mesh_revision"],
        "mask_exact_sample_identity": mask_exact_sample_identity,
        "mask_identity": mask_headers.get("etag"),
        "monitor_revision": meta["monitor_revision"],
        "monitor_hash": meta["monitor_hash"],
        "occupancy": meta["occupancy"],
        "oracle": (
            {
                "expected_scalar": 1.0,
                "kind": "constant_unit_magnitude",
            }
            if quantity_id == "m" and component == "magnitude"
            else None
        ),
        "probe": {
            "cell_id": probe.get("cell_id"),
            "element_id": probe.get("element_id"),
            "occupancy": probe["occupancy"],
            "scalar": probe.get("scalar"),
            "world_m": probe["world_m"],
        },
        "sampling_execution": meta["sampling_execution"],
        "sampling_method": meta["sampling_method"],
        "sample_token": meta["sample_token"],
        "scalar_values": [value if math.isfinite(value) else None for value in scalar],
        "scalar_identity": scalar_identity,
        "scene_revision": meta["scene_revision"],
        "scope_id": meta.get("scope_id"),
        "scope_kind": meta["scope_kind"],
        "stats": stats,
        "stage_id": stage_id,
        "snapshot_id": snapshot_id,
        "vector_exact_sample_identity": vector_exact_sample_identity,
        "vector_constant_max_error": vector_constant_max_error,
        "vector_identity": vector_identity,
        "vector_value_count": vector_value_count,
    }
    if validate_linear_ms:
        report["linear_validation"] = linear_ms_validation(meta, scalar, probe)
        report["oracle"] = {
            "analytic": report["linear_validation"]["analytic"],
            "kind": "linear_material_field",
        }
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
        z_m = origin[2] + u_m * u_axis[2] + v_m * v_axis[2]
        if (
            meta.get("sample_support") == "pixel_prism"
            and abs(origin[2] - SLAB_ORACLE["frame_position_z_m"]) <= 1e-15
        ):
            clipped_min = max(
                SLAB_ORACLE["film_z_bounds_m"][0],
                origin[2] - 0.5 * SLAB_ORACLE["thickness_m"],
            )
            clipped_max = min(
                SLAB_ORACLE["film_z_bounds_m"][1],
                origin[2] + 0.5 * SLAB_ORACLE["thickness_m"],
            )
            z_m = 0.5 * (clipped_min + clipped_max)
        expected = 800e3 + 1e12 * x_m + 2e12 * z_m
        comparisons.append((observed, expected))
        serialized_values.append(observed)
    if not comparisons:
        raise ValueError("linear material field contains no finite samples")
    errors = [observed - expected for observed, expected in comparisons]
    rms_error = math.sqrt(sum(error * error for error in errors) / len(errors))
    max_error = max(abs(error) for error in errors)
    probe_world = probe.get("world_m") or [0.0, 0.0, 0.0]
    probe_z_m = float(probe_world[2])
    if (
        meta.get("sample_support") == "pixel_prism"
        and abs(origin[2] - SLAB_ORACLE["frame_position_z_m"]) <= 1e-15
    ):
        clipped_min = max(
            SLAB_ORACLE["film_z_bounds_m"][0],
            origin[2] - 0.5 * SLAB_ORACLE["thickness_m"],
        )
        clipped_max = min(
            SLAB_ORACLE["film_z_bounds_m"][1],
            origin[2] + 0.5 * SLAB_ORACLE["thickness_m"],
        )
        probe_z_m = 0.5 * (clipped_min + clipped_max)
    probe_expected = (
        800e3
        + 1e12 * float(probe_world[0])
        + 2e12 * probe_z_m
    )
    probe_observed = float(probe["scalar"])
    return {
        "analytic": "Ms(x,z)=800000 A/m + (1e12 A/m^2)*x + (2e12 A/m^2)*z",
        "max_abs_error_A_per_m": max_error,
        "probe_abs_error_A_per_m": abs(probe_observed - probe_expected),
        "raster_values_A_per_m": serialized_values,
        "rms_error_A_per_m": rms_error,
    }


def asymmetric_slab_validation(report: dict[str, Any]) -> dict[str, Any]:
    validation = report["linear_validation"]
    frame = report["frame"]
    origin_z = float(frame["origin_m"][2])
    thickness = float(report["operator"]["thickness_m"])
    clipped_min = max(
        SLAB_ORACLE["film_z_bounds_m"][0], origin_z - 0.5 * thickness
    )
    clipped_max = min(
        SLAB_ORACLE["film_z_bounds_m"][1], origin_z + 0.5 * thickness
    )
    if clipped_max <= clipped_min:
        raise ValueError("slab has no clipped support inside the fixture film")
    support_mean_z = 0.5 * (clipped_min + clipped_max)
    center_bias = abs(
        SLAB_ORACLE["field_gradient_z_A_per_m2"] * (origin_z - support_mean_z)
    )
    max_error = float(validation["max_abs_error_A_per_m"])
    return {
        "center_sample_bias_A_per_m": center_bias,
        "clipped_support_z_m": [clipped_min, clipped_max],
        "max_abs_error_A_per_m": max_error,
        "pass": max_error <= 3_000.0 and center_bias > 3_000.0,
        "oracle": SLAB_ORACLE,
        "support_mean_z_m": support_mean_z,
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


def attach_monitor_contract(
    report: dict[str, Any], monitor: dict[str, Any], quantity_id: str, component: str
) -> dict[str, Any]:
    report.update(
        {
            "component": component,
            "monitor_id": monitor["id"],
            "operator": monitor["operator"],
            "quantity_id": quantity_id,
        "target": monitor["target"],
        }
    )
    return report


def attempted_monitor_report(
    base: str,
    monitor: dict[str, Any],
    *,
    component: str,
    quantity_id: str,
    expected_field_revision: int | None = None,
) -> dict[str, Any]:
    try:
        result = attach_monitor_contract(
            monitor_report(
                base,
                monitor["id"],
                component=component,
                quantity_id=quantity_id,
                expected_field_revision=expected_field_revision,
                wait_timeout_s=20.0,
            ),
            monitor,
            quantity_id,
            component,
        )
        if (
            not result["exact_sample_identity"]
            or not result["mask_exact_sample_identity"]
        ):
            return {
                "blocker": "scalar or mask payload ETag does not match the metadata sample identity",
                "passed": False,
                "result": result,
                "status": "blocked",
            }
        if quantity_id == "m" and not result["vector_exact_sample_identity"]:
            return {
                "blocker": "vector payload ETag does not match the metadata sample identity",
                "passed": False,
                "result": result,
                "status": "blocked",
            }
        return {"passed": True, "status": "passed", "result": result}
    except Exception as error:  # noqa: BLE001 - the report must retain exact runtime blockers
        return {
            "blocker": f"{type(error).__name__}: {error}",
            "passed": False,
            "status": "blocked",
        }


def matrix_case_passes(
    case: dict[str, Any], *, expected_frame_preset: str | None = None,
    expected_target: dict[str, str] | None = None,
    expected_quantity_id: str | None = None,
) -> bool:
    if not case.get("passed") or not isinstance(case.get("result"), dict):
        return False
    result = case["result"]
    if (
        not result.get("exact_sample_identity")
        or not result.get("mask_exact_sample_identity")
        or int(result["stats"]["count"]) <= 0
    ):
        return False
    if expected_frame_preset is not None:
        frame = result.get("frame") or {}
        expected_axes = {
            "xz": {
                "normal": [0.0, -1.0, 0.0],
                "u_axis": [1.0, 0.0, 0.0],
                "v_axis": [0.0, 0.0, 1.0],
            },
            "yz": {
                "normal": [1.0, 0.0, 0.0],
                "u_axis": [0.0, 1.0, 0.0],
                "v_axis": [0.0, 0.0, 1.0],
            },
        }[expected_frame_preset]
        if frame.get("preset") != expected_frame_preset or any(
            frame.get(key) != value for key, value in expected_axes.items()
        ):
            return False
    if expected_target is not None:
        target = result.get("target") or {}
        if any(target.get(key) != value for key, value in expected_target.items()):
            return False
    if expected_quantity_id is not None and (
        result.get("quantity_id") != expected_quantity_id
        or not result.get("field_source")
        or result.get("carrier_revision") is None
    ):
        return False
    return True


def wait_for_fresh_monitor_report(
    base: str, monitor_id: str, *, baseline_field_revision: int,
    component: str, quantity_id: str, timeout_s: float = 180.0,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    last: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        last = monitor_report(
            base, monitor_id, component=component, quantity_id=quantity_id,
            wait_timeout_s=10.0,
        )
        if int(last["field_revision"]) > baseline_field_revision:
            return monitor_report(
                base,
                monitor_id,
                component=component,
                quantity_id=quantity_id,
                expected_field_revision=int(last["field_revision"]),
                wait_timeout_s=10.0,
            )
        time.sleep(0.5)
    raise RuntimeError(
        f"solve produced no fresh field revision for {monitor_id}: "
        f"baseline={baseline_field_revision}, last={last and last.get('field_revision')}"
    )


def rotated_basis_validation(
    component_reports: dict[str, dict[str, Any]], expected_world: tuple[float, float, float]
) -> dict[str, Any]:
    frame = component_reports["u"]["frame"]
    axes = {
        "u": frame["u_axis"],
        "v": frame["v_axis"],
        "normal": frame["normal"],
    }
    expected = {
        name: sum(float(a) * float(b) for a, b in zip(axis, expected_world, strict=True))
        for name, axis in axes.items()
    }
    observed = {
        name: float(component_reports[name]["stats"]["mean"])
        for name in ("u", "v", "normal")
    }
    max_abs_error = max(abs(observed[name] - expected[name]) for name in expected)
    handedness = (
        axes["u"][1] * axes["v"][2] - axes["u"][2] * axes["v"][1],
        axes["u"][2] * axes["v"][0] - axes["u"][0] * axes["v"][2],
        axes["u"][0] * axes["v"][1] - axes["u"][1] * axes["v"][0],
    )
    handedness_error = math.sqrt(
        sum((handedness[index] - axes["normal"][index]) ** 2 for index in range(3))
    )
    return {
        "expected": expected,
        "observed": observed,
        "max_abs_error": max_abs_error,
        "right_handed_error": handedness_error,
        "pass": max_abs_error <= 1e-6 and handedness_error <= 1e-12,
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


def wait_for_persisted_snapshot(
    base: str, stage_id: str = "stage-000", timeout_s: float = 180.0
) -> str:
    path = (
        f"/v2/sessions/current/analysis/hysteresis/"
        f"{urllib.parse.quote(stage_id, safe='')}/points"
    )
    deadline = time.monotonic() + timeout_s
    last_resource: dict[str, Any] | None = None
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            resource = request_json(base, path)
            last_resource = resource
            points = resource.get("points")
            if not isinstance(points, list):
                raise RuntimeError(
                    f"hysteresis points resource has no points list: {resource}"
                )
            for point in reversed(points):
                snapshot_id = point.get("snapshot_id") if isinstance(point, dict) else None
                if isinstance(snapshot_id, str) and snapshot_id:
                    return snapshot_id
        except (OSError, urllib.error.HTTPError, json.JSONDecodeError, RuntimeError) as error:
            last_error = error
        time.sleep(0.5)
    raise RuntimeError(
        f"hysteresis stage {stage_id} published no persisted snapshot: "
        f"last_resource={last_resource}, last_error={last_error}"
    )


def synchronize_cross_backend_reports(current_output: Path) -> None:
    report_root = current_output.parent.parent
    fdm_path = report_root / "fdm-cpu" / "science-report.json"
    for fem_lane in ("fem-cpu", "fem-gpu"):
        fem_path = report_root / fem_lane / "science-report.json"
        if not fdm_path.exists() or not fem_path.exists():
            continue
        fdm = json.loads(fdm_path.read_text())
        fem = json.loads(fem_path.read_text())
        try:
            fdm_monitor = fdm["linear_material_monitors"]["xy-plane"]
            fem_monitor = fem["linear_material_monitors"]["xy-plane"]
            fdm_rms = float(
                fdm_monitor["linear_validation"]["rms_error_A_per_m"]
            )
            fem_rms = float(
                fem_monitor["linear_validation"]["rms_error_A_per_m"]
            )
        except (KeyError, TypeError, ValueError) as error:
            metric = {
                "blocker": f"missing or blocked linear material evidence: {error}",
                "comparison_method": "shared_manufactured_field_error",
            }
            gate_id = f"cross_backend_linear_scalar_{fem_lane.replace('-', '_')}"
            for report in (fdm, fem):
                report.setdefault("gates", {})[gate_id] = False
                report.setdefault("metrics", {})[gate_id] = metric
            update_qualification_case(
                fem,
                "cross-backend-parity",
                passed=False,
                blocker=metric["blocker"],
            )
            write_json(fdm_path, fdm)
            write_json(fem_path, fem)
            comparison_path = report_root / f"cross-backend-fdm-cpu-{fem_lane}.json"
            write_json(
                comparison_path,
                {
                        "fdm_report": str(fdm_path),
                        "fem_report": str(fem_path),
                        "metrics": metric,
                        "pass": False,
                        "schema_version": "viewport-2d-cross-backend-report-v2",
                        "status": "blocked",
                },
            )
            continue
        identity_errors = []
        if not fdm.get("head") or fdm.get("head") != fem.get("head"):
            identity_errors.append("HEAD differs")
        if fdm.get("runtime_bundle_identity", {}).get("runtime_bundle_version") != fem.get(
            "runtime_bundle_identity", {}
        ).get("runtime_bundle_version"):
            identity_errors.append("runtime bundle differs")
        for field in ("frame", "monitor_hash", "operator", "quantity_id", "target"):
            if fdm_monitor.get(field) != fem_monitor.get(field):
                identity_errors.append(f"monitor {field} differs")
        if not fdm_monitor.get("exact_sample_identity") or not fem_monitor.get(
            "exact_sample_identity"
        ):
            identity_errors.append("sample identity is not exact")
        fdm_values = fdm_monitor["linear_validation"].get("raster_values_A_per_m")
        fem_values = fem_monitor["linear_validation"].get("raster_values_A_per_m")
        if (
            not isinstance(fdm_values, list)
            or not isinstance(fem_values, list)
            or len(fdm_values) != len(fem_values)
        ):
            identity_errors.append("raster shapes differ")
        if not identity_errors and any(
            (left is None) != (right is None)
            for left, right in zip(fdm_values, fem_values, strict=True)
        ):
            identity_errors.append("raster support masks differ")
        paired = (
            [
                (float(left), float(right))
                for left, right in zip(fdm_values, fem_values, strict=True)
                if left is not None and right is not None
            ]
            if not identity_errors
            else []
        )
        if not paired:
            identity_errors.append("no paired finite raster samples")
        elif (
            int(fdm_monitor["stats"]["count"]) != len(paired)
            or int(fem_monitor["stats"]["count"]) != len(paired)
        ):
            identity_errors.append(
                "finite sample counts do not match the shared support mask"
            )
            paired = []
        if identity_errors:
            metric = {
                "blocker": "; ".join(identity_errors),
                "comparison_method": "samplewise_shared_geometry_raster",
            }
            passed = False
            combined_rms = None
            relative_rms = None
        else:
            scale = max(1.0, *(abs(value) for pair in paired for value in pair))
            relative_rms = math.sqrt(
                math.fsum(
                    ((left / scale) - (right / scale)) ** 2
                    for left, right in paired
                )
                / len(paired)
            )
            candidate_rms = scale * relative_rms
            combined_rms = candidate_rms if math.isfinite(candidate_rms) else None
            passed = relative_rms <= 5e-3
        metric = {
            "comparison_method": "samplewise_shared_geometry_raster",
            "fdm_finite_sample_count": int(fdm_monitor["stats"]["count"]),
            "fdm_rms_A_per_m": fdm_rms,
            "fem_finite_sample_count": int(fem_monitor["stats"]["count"]),
            "fem_rms_A_per_m": fem_rms,
            "relative_rms": relative_rms,
            "rms_A_per_m": combined_rms,
        }
        if identity_errors:
            metric["blocker"] = "; ".join(identity_errors)
        gate_id = f"cross_backend_linear_scalar_{fem_lane.replace('-', '_')}"
        for report in (fdm, fem):
            report["gates"][gate_id] = passed
            report["metrics"][gate_id] = metric
        update_qualification_case(
            fem,
            "cross-backend-parity",
            passed=passed,
            blocker=None if passed else metric.get("blocker", "samplewise parity failed"),
        )
        write_json(fdm_path, fdm)
        write_json(fem_path, fem)
        comparison_path = report_root / f"cross-backend-fdm-cpu-{fem_lane}.json"
        write_json(
            comparison_path,
            {
                    "fdm_report": str(fdm_path),
                    "fem_report": str(fem_path),
                    "metrics": metric,
                    "pass": passed,
                    "status": "passed" if passed else "blocked",
                    "schema_version": "viewport-2d-cross-backend-report-v2",
            },
        )
    if fdm_path.exists():
        fdm = json.loads(fdm_path.read_text())
        gate_ids = (
            "cross_backend_linear_scalar_fem_cpu",
            "cross_backend_linear_scalar_fem_gpu",
        )
        missing = [gate_id for gate_id in gate_ids if gate_id not in fdm.get("gates", {})]
        passed = not missing and all(fdm["gates"].get(gate_id) is True for gate_id in gate_ids)
        blockers = [
            fdm.get("metrics", {}).get(gate_id, {}).get("blocker", f"{gate_id} failed")
            for gate_id in gate_ids
            if fdm.get("gates", {}).get(gate_id) is not True
        ]
        blockers.extend(f"missing {gate_id} report" for gate_id in missing)
        update_qualification_case(
            fdm,
            "cross-backend-parity",
            passed=passed,
            blocker=None if passed else "; ".join(dict.fromkeys(blockers)),
        )
        write_json(fdm_path, fdm)


def update_qualification_case(
    report: dict[str, Any], case_id: str, *, passed: bool, blocker: str | None
) -> None:
    cases = report.get("qualification_cases")
    if not isinstance(cases, list):
        report["qualification_complete"] = False
        report["qualification_status"] = "blocked"
        report["pass"] = False
        return
    for case in cases:
        if case.get("case_id") != case_id or not case.get("required", True):
            continue
        case["passed"] = passed
        case["status"] = "passed" if passed else "blocked"
        case["blocker"] = None if passed else blocker
        break
    report["qualification_complete"] = all(
        not case.get("required", True) or case.get("passed") is True for case in cases
    )
    report["qualification_status"] = (
        "qualified" if report["qualification_complete"] else "blocked"
    )
    report["pass"] = report["qualification_complete"] and all(
        report.get("gates", {}).values()
    )


def compare_samplewise_reports(
    left: dict[str, Any],
    right: dict[str, Any],
    *,
    monitor_path: tuple[str, str],
    require_distinct_mesh: bool,
) -> dict[str, Any]:
    errors: list[str] = []
    try:
        left_monitor = left[monitor_path[0]][monitor_path[1]]
        right_monitor = right[monitor_path[0]][monitor_path[1]]
    except (KeyError, TypeError) as error:
        return {"blocker": f"missing paired monitor evidence: {error}", "pass": False}
    if left.get("head") != right.get("head") or not left.get("head"):
        errors.append("HEAD differs")
    if left.get("backend") != right.get("backend") or left.get("device") != right.get("device"):
        errors.append("managed lane differs")
    if left.get("runtime_bundle_identity") != right.get("runtime_bundle_identity"):
        errors.append("runtime bundle identity differs")
    for field in ("frame", "operator", "quantity_id", "target"):
        if left_monitor.get(field) != right_monitor.get(field):
            errors.append(f"monitor {field} differs")
    if not left_monitor.get("exact_sample_identity") or not right_monitor.get(
        "exact_sample_identity"
    ):
        errors.append("paired scalar sample identity is not exact")
    if not left_monitor.get("mask_exact_sample_identity") or not right_monitor.get(
        "mask_exact_sample_identity"
    ):
        errors.append("paired mask sample identity is not exact")
    if require_distinct_mesh:
        if left_monitor.get("generation_id") == right_monitor.get("generation_id"):
            errors.append(
                "paired executor did not produce a distinct mesh generation identity"
            )
        if left_monitor.get("mesh_revision") == right_monitor.get("mesh_revision"):
            errors.append("paired executor did not produce a distinct mesh revision")
    left_values = (
        left_monitor.get("linear_validation", {}).get("raster_values_A_per_m")
        if monitor_path[0] == "linear_material_monitors"
        else left_monitor.get("scalar_values")
    )
    right_values = (
        right_monitor.get("linear_validation", {}).get("raster_values_A_per_m")
        if monitor_path[0] == "linear_material_monitors"
        else right_monitor.get("scalar_values")
    )
    if (
        not isinstance(left_values, list)
        or not isinstance(right_values, list)
        or len(left_values) != len(right_values)
    ):
        errors.append("paired raster shapes differ")
        pairs: list[tuple[float, float]] = []
    elif any(
        (left_value is None) != (right_value is None)
        for left_value, right_value in zip(left_values, right_values, strict=True)
    ):
        errors.append("paired raster support masks differ")
        pairs = []
    else:
        pairs = [
            (float(left_value), float(right_value))
            for left_value, right_value in zip(left_values, right_values, strict=True)
            if left_value is not None
        ]
    if not pairs:
        errors.append("paired reports have no shared finite raster samples")
    if errors:
        return {"blocker": "; ".join(errors), "pass": False}
    scale = max(1.0, *(abs(value) for pair in pairs for value in pair))
    relative_rms = math.sqrt(
        math.fsum(
            ((left_value / scale) - (right_value / scale)) ** 2
            for left_value, right_value in pairs
        )
        / len(pairs)
    )
    return {
        "finite_sample_count": len(pairs),
        "pass": relative_rms <= 5e-3,
        "relative_rms": relative_rms,
    }


def browser_evidence_is_complete(browser: dict[str, Any]) -> bool:
    required_case_ids = {
        "layer-raster",
        "layer-contours",
        "layer-mesh",
        "layer-boundaries",
        "layer-vectors",
        "layer-probes",
        "layer-points",
        "layer-bounds",
    }
    cases = browser.get("qualification_cases")
    evidence = browser.get("evidence")
    case_ids = (
        {case.get("case_id") for case in cases if isinstance(case, dict)}
        if isinstance(cases, list)
        else set()
    )
    worker_after = browser.get("worker_after")
    worker_baseline = browser.get("worker_baseline")
    return bool(
        isinstance(evidence, list)
        and evidence
        and browser.get("switch_count") == 100
        and isinstance(browser.get("final_webgl"), dict)
        and browser["final_webgl"].get("drawingBufferWidth", 0) > 0
        and browser["final_webgl"].get("drawingBufferHeight", 0) > 0
        and browser.get("memory_before_bytes") is not None
        and browser.get("memory_after_bytes") is not None
        and isinstance(browser.get("performance"), dict)
        and isinstance(worker_after, dict)
        and isinstance(worker_baseline, dict)
        and worker_after.get("active") == worker_baseline.get("active")
        and worker_after.get("created", 0) > worker_baseline.get("created", 0)
        and worker_after.get("created", 0) - worker_baseline.get("created", 0)
        == worker_after.get("terminated", 0) - worker_baseline.get("terminated", 0)
        and required_case_ids.issubset(case_ids)
    )


def mesh_refined_peer_is_valid(report: dict[str, Any]) -> bool:
    monitor = report.get("linear_material_monitors", {}).get("xy-slab", {})
    execution = report.get("execution", {})
    return bool(
        report.get("qualification_profile") == "mesh-refined"
        and monitor.get("exact_sample_identity") is True
        and monitor.get("mask_exact_sample_identity") is True
        and monitor.get("generation_id")
        and monitor.get("mesh_revision") is not None
        and monitor.get("linear_validation", {}).get("raster_values_A_per_m")
        and execution.get("requested_backend") == report.get("backend")
        and execution.get("resolved_backend") == report.get("backend")
        and execution.get("resolved_device") == report.get("device")
        and report.get("runtime_bundle_identity", {}).get("runtime_bundle_version")
    )


def aggregate_qualification_reports(report_root: Path) -> dict[str, Any]:
    """Re-run all cross-lane and paired-executor gates after every lane report."""
    anchor = report_root / "fdm-cpu" / "science-report.json"
    synchronize_cross_backend_reports(anchor)
    lanes: dict[str, Any] = {}
    for lane in ("fdm-cpu", "fem-cpu", "fem-gpu"):
        lane_dir = report_root / lane
        science_path = lane_dir / "science-report.json"
        if not science_path.exists():
            lanes[lane] = {
                "blocker": f"missing managed lane report: {science_path}",
                "pass": False,
                "status": "blocked",
            }
            continue
        science = json.loads(science_path.read_text())
        refinement_path = lane_dir / "refinement-peer-science-report.json"
        if refinement_path.exists():
            refinement_peer = json.loads(refinement_path.read_text())
            if not mesh_refined_peer_is_valid(refinement_peer):
                refinement = {
                    "blocker": (
                        "refinement peer lacks mesh-refined profile, exact sample identity, "
                        "mesh identity, or matching managed execution provenance"
                    ),
                    "pass": False,
                }
            else:
                refinement = compare_samplewise_reports(
                    science,
                    refinement_peer,
                    monitor_path=("linear_material_monitors", "xy-slab"),
                    require_distinct_mesh=True,
                )
        else:
            refinement = {
                "blocker": f"missing managed mesh-refinement executor report: {refinement_path}",
                "pass": False,
            }
        science["refinement_validation"] = refinement
        science.setdefault("gates", {})["mesh_refinement_pair"] = refinement["pass"]
        update_qualification_case(
            science,
            "refinement-invariance",
            passed=refinement["pass"],
            blocker=refinement.get("blocker", "mesh-refinement samplewise parity failed"),
        )
        compact_full: dict[str, Any] | None = None
        if science.get("backend") == "fem":
            contract_path = report_root / "compact-full-contract-report.json"
            if contract_path.exists():
                contract = json.loads(contract_path.read_text())
                contract_matches = bool(
                    contract.get("schema_version")
                    == "viewport-2d-compact-full-contract-v1"
                    and contract.get("contract") == COMPACT_FULL_CONTRACT
                    and contract.get("executor")
                    == "container-backed cargo test -p fullmag-api"
                    and contract.get("exit_status") == 0
                    and contract.get("pass") is True
                    and contract.get("head") == science.get("head")
                    and contract.get("lane_scope")
                    == "backend-neutral-sampler-contract"
                )
                compact_full = {
                    "blocker": (
                        "backend-neutral compact/full sampler contract passed, but no "
                        f"managed {lane} runtime carrier binding report exists"
                    ) if contract_matches else (
                        "paired-carrier contract identity, executor status, or HEAD does not match"
                    ),
                    "contract_report": str(contract_path),
                    "pass": False,
                }
            else:
                compact_full = {
                    "blocker": (
                        "missing explicit compact/full FEM paired-carrier executor report: "
                        f"{contract_path}"
                    ),
                    "pass": False,
                }
            science.setdefault("gates", {})["fem_compact_full_pair"] = compact_full[
                "pass"
            ]
            update_qualification_case(
                science,
                "fem-compact-full-parity",
                passed=compact_full["pass"],
                blocker=compact_full.get(
                    "blocker", "compact/full FEM samplewise parity failed"
                ),
            )
        write_json(science_path, science)
        browser_path = lane_dir / "browser" / "browser-report.json"
        if browser_path.exists():
            browser = json.loads(browser_path.read_text())
            layer_gate = browser.get("unsupported_required_layers", {})
            browser_runtime = browser.get("runtime_bundle_identity", {})
            science_runtime = science.get("runtime_bundle_identity", {})
            science_execution = science.get("execution", {})
            browser_cases = browser.get("qualification_cases")
            browser_evidence = browser.get("evidence")
            browser_evidence_complete = browser_evidence_is_complete(browser)
            runtime_matches = bool(
                browser.get("git_head") == science.get("head")
                and browser.get("backend") == science.get("backend")
                and browser_runtime.get("resolved_device") == science.get("device")
                and browser_runtime.get("requested_backend")
                == science_execution.get("requested_backend")
                and browser_runtime.get("requested_device")
                == science_execution.get("requested_device")
                and browser_runtime.get("resolved_backend")
                == science_execution.get("resolved_backend")
                and browser_runtime.get("resolved_device")
                == science_execution.get("resolved_device")
                and browser_runtime.get("resolved_runtime_family")
                == science_execution.get("resolved_runtime_family")
                and browser_runtime.get("api_contract_version")
                == science_runtime.get("api_contract_version")
                and browser_runtime.get("runtime_bundle_version")
                == science_runtime.get("runtime_bundle_version")
            )
            browser["scientific_qualification"].update(
                {
                    "complete": science.get("qualification_complete") is True,
                    "matches_runtime": runtime_matches,
                    "pass": science.get("pass") is True,
                    "status": science.get("qualification_status", "blocked"),
                }
            )
            browser["pass"] = bool(
                science.get("pass") is True
                and runtime_matches
                and browser_evidence_complete
                and layer_gate.get("pass") is True
                and all(
                    not case.get("required", True) or case.get("passed") is True
                    for case in browser_cases
                )
                and all(
                    evidence.get("status") == "ready"
                    for evidence in browser_evidence
                )
            )
            write_json(browser_path, browser)
            browser_pass = browser["pass"]
        else:
            browser_pass = False
        lanes[lane] = {
            "browser_pass": browser_pass,
            "compact_full": compact_full,
            "pass": bool(science.get("pass") and browser_pass),
            "refinement": refinement,
            "status": "passed" if science.get("pass") and browser_pass else "blocked",
        }
    passed = all(entry.get("pass") is True for entry in lanes.values())
    aggregate = {
        "lanes": lanes,
        "pass": passed,
        "schema_version": "viewport-2d-qualification-aggregate-v1",
        "status": "qualified" if passed else "blocked",
    }
    report_root.mkdir(parents=True, exist_ok=True)
    write_json(report_root / "aggregate-report.json", aggregate)
    return aggregate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--aggregate-report-root", type=Path)
    parser.add_argument("--verify-compact-full-contract-log", type=Path)
    parser.add_argument("--compact-full-contract-output", type=Path)
    parser.add_argument("--api-base")
    parser.add_argument("--backend", choices=("fdm", "fem"))
    parser.add_argument("--device", choices=("cpu", "gpu"))
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--qualification-profile",
        choices=("base", "mesh-refined", "fem-compact", "fem-full"),
        default="base",
    )
    args = parser.parse_args()
    if args.verify_compact_full_contract_log is not None:
        if args.compact_full_contract_output is None:
            parser.error(
                "--compact-full-contract-output is required with "
                "--verify-compact-full-contract-log"
            )
        contract = verify_compact_full_contract_log(
            args.verify_compact_full_contract_log,
            args.compact_full_contract_output,
        )
        if not contract["pass"]:
            raise SystemExit("compact/full contract log did not contain an exact passing test")
        return
    if args.aggregate_report_root is not None:
        aggregate = aggregate_qualification_reports(args.aggregate_report_root)
        if not aggregate["pass"]:
            raise SystemExit(
                f"planar qualification aggregate blocked: {args.aggregate_report_root}"
            )
        print(f"Planar qualification aggregate passed: {args.aggregate_report_root}")
        return
    if not args.api_base or not args.backend or not args.device or args.output is None:
        parser.error(
            "--api-base, --backend, --device, and --output are required outside aggregate mode"
        )

    collection = wait_json(
        args.api_base, "/v2/sessions/current/model/planar-monitors"
    )
    monitor_by_id = {entry["id"]: entry for entry in collection.get("monitors", [])}
    monitor_ids = [entry["id"] for entry in collection.get("monitors", [])]
    oracle_monitor_ids = (
        {"xy-plane", "xy-slab", "depth-mean", "oblique-plane"}
        if args.backend == "fdm"
        else {
            "xy-plane",
            "xy-slab",
            "depth-mean",
            "object-surface",
            "oblique-plane",
        }
    )
    matrix_monitor_ids = {
        "domain-plane",
        "magnetic-plane",
        "region-plane",
        "xz-plane",
        "yz-plane",
    }
    required = oracle_monitor_ids | matrix_monitor_ids
    if args.backend == "fdm":
        required.add("isolation-neighbor-plane")
    missing = sorted(required.difference(monitor_ids))
    if missing:
        raise RuntimeError(f"fixture did not publish required monitors: {missing}")

    linear_monitor_ids = {"xy-plane", "xy-slab"}
    linear_monitors = {
        monitor_id: attach_monitor_contract(
            monitor_report(
                args.api_base,
                monitor_id,
                component="scalar",
                quantity_id="mat_ms",
                validate_linear_ms=True,
            ),
            monitor_by_id[monitor_id],
            "mat_ms",
            "scalar",
        )
        for monitor_id in sorted(linear_monitor_ids)
    }
    isolation_case = None
    if args.backend == "fdm":
        isolation_case = attempted_monitor_report(
            args.api_base,
            monitor_by_id["isolation-neighbor-plane"],
            component="scalar",
            quantity_id="mat_ms",
        )

    pre_solve_fields = {
        quantity_id: monitor_report(
            args.api_base,
            "xy-plane",
            component="magnitude",
            quantity_id=quantity_id,
        )
        for quantity_id in ("m", "H_eff", "H_demag")
    }
    solve_command_id = start_fixture_solver(args.api_base)
    try:
        fresh_xy = wait_for_fresh_monitor_report(
            args.api_base,
            "xy-plane",
            baseline_field_revision=int(pre_solve_fields["m"]["field_revision"]),
            component="magnitude",
            quantity_id="m",
        )
        fresh_fields = {
            quantity_id: wait_for_fresh_monitor_report(
                args.api_base,
                "xy-plane",
                baseline_field_revision=int(
                    pre_solve_fields[quantity_id]["field_revision"]
                ),
                component="magnitude",
                quantity_id=quantity_id,
            )
            for quantity_id in ("H_eff", "H_demag")
        }
        fresh_m_revision = int(fresh_xy["field_revision"])
        monitors = {
            monitor_id: attach_monitor_contract(
                monitor_report(
                    args.api_base,
                    monitor_id,
                    component="magnitude",
                    quantity_id="m",
                    expected_field_revision=fresh_m_revision,
                ),
                monitor_by_id[monitor_id],
                "m",
                "magnitude",
            )
            for monitor_id in sorted(oracle_monitor_ids)
        }
        monitors["xy-plane"] = attach_monitor_contract(
            fresh_xy, monitor_by_id["xy-plane"], "m", "magnitude"
        )
        matrix_monitors = {
            monitor_id: attempted_monitor_report(
                args.api_base,
                monitor_by_id[monitor_id],
                component="magnitude",
                quantity_id="m",
                expected_field_revision=fresh_m_revision,
            )
            for monitor_id in sorted(matrix_monitor_ids)
        }
        field_quantity_cases = {
            quantity_id: {
                "passed": bool(
                    fresh_fields[quantity_id]["exact_sample_identity"]
                    and fresh_fields[quantity_id]["mask_exact_sample_identity"]
                ),
                "result": attach_monitor_contract(
                    fresh_fields[quantity_id],
                    monitor_by_id["xy-plane"],
                    quantity_id,
                    "magnitude",
                ),
                "status": "passed"
                if fresh_fields[quantity_id]["exact_sample_identity"]
                and fresh_fields[quantity_id]["mask_exact_sample_identity"]
                else "blocked",
            }
            for quantity_id in ("H_eff", "H_demag")
        }
        try:
            airbox_result = attach_monitor_contract(
                    monitor_report(
                        args.api_base,
                        "domain-plane",
                        component="magnitude",
                        quantity_id="H_demag",
                        scope_kind="airbox",
                        expected_field_revision=int(
                            fresh_fields["H_demag"]["field_revision"]
                        ),
                    ),
                    monitor_by_id["domain-plane"],
                    "H_demag",
                    "magnitude",
                )
            airbox_passed = (
                    airbox_result["exact_sample_identity"]
                    and airbox_result["mask_exact_sample_identity"]
                    and airbox_result["scope_kind"] == "airbox"
                    and airbox_result["field_source"] == "live"
                    and airbox_result["carrier_revision"] is not None
            )
            airbox_case = {
                "blocker": None
                if airbox_passed
                else "airbox sample did not retain carrier scope and provenance",
                "passed": airbox_passed,
                "result": airbox_result,
                "status": "passed" if airbox_passed else "blocked",
            }
        except Exception as error:  # noqa: BLE001 - exact carrier blocker belongs in report
            airbox_case = {
                "blocker": f"{type(error).__name__}: {error}",
                "passed": False,
                "status": "blocked",
            }
        try:
            snapshot_id = wait_for_persisted_snapshot(args.api_base)
            persisted_result = attach_monitor_contract(
                    monitor_report(
                        args.api_base,
                        "xy-plane",
                        component="magnitude",
                        quantity_id="m",
                        stage_id="stage-000",
                        snapshot_id=snapshot_id,
                    ),
                    monitor_by_id["xy-plane"],
                    "m",
                    "magnitude",
                )
            persisted_passed = (
                persisted_result["snapshot_id"] == snapshot_id
                and persisted_result["stage_id"] == "stage-000"
                and persisted_result["field_source"] == f"stage_snapshot:{snapshot_id}"
                and persisted_result["exact_sample_identity"]
                and persisted_result["mask_exact_sample_identity"]
            )
            persisted_snapshot_case = {
                "blocker": None
                if persisted_passed
                else "persisted planar sample did not resolve the requested fresh stage snapshot",
                "passed": persisted_passed,
                "status": "passed" if persisted_passed else "blocked",
                "result": persisted_result,
            }
        except Exception as error:  # noqa: BLE001 - retain the exact persisted-source blocker
            persisted_snapshot_case = {
                "blocker": f"{type(error).__name__}: {error}",
                "passed": False,
                "status": "blocked",
            }
        rotated_components = {
                component: attach_monitor_contract(
                    monitor_report(
                        args.api_base,
                        "oblique-plane",
                        component=component,
                        quantity_id="m",
                        expected_field_revision=fresh_m_revision,
                    ),
                    monitor_by_id["oblique-plane"],
                    "m",
                    component,
                )
                for component in ("u", "v", "normal")
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
    slab_validation = asymmetric_slab_validation(linear_monitors["xy-slab"])
    refinement_validation = {
        "blocker": (
            "awaiting refinement-peer-science-report.json from the managed "
            "mesh-refined qualification profile"
        ),
        "executor_profile": "mesh-refined",
        "pass": False,
    }
    isolation_validation = None
    if isolation_case is not None:
        isolation_mean_error = (
            abs(float(isolation_case["result"]["stats"]["mean"]) - 400e3)
            if isolation_case["passed"]
            else None
        )
        isolation_validation = {
            "blocker": isolation_case.get("blocker"),
            "expected_neighbor_Ms_A_per_m": 400e3,
            "mean_error_A_per_m": isolation_mean_error,
            "pass": (
                isolation_case["passed"]
                and isolation_mean_error is not None
                and isolation_mean_error <= 1e-6
                and float(linear_monitors["xy-plane"]["stats"]["mean"]) > 700e3
            ),
            "result": isolation_case.get("result"),
        }
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
        "constant_vector_field": all(
            result["vector_constant_max_error"] is not None
            and result["vector_constant_max_error"] <= 1e-6
            for result in monitors.values()
        ),
        "constant_scalar_bins": all(
            float(result["stats"]["max"]) - float(result["stats"]["min"])
            <= 1e-6
            for result in monitors.values()
        ),
        "linear_scalar_analytic_rms": max_linear_rms_error <= 3_000.0,
        "linear_scalar_probe": max_linear_probe_error <= 3_000.0,
        "occupied_support": occupancy_ok,
        "plane_probe_source_identity": probe_id_ok,
        "plane_operator": "xy-plane" in monitors,
        "slab_operator": "xy-slab" in monitors,
        "slab_measure_contract": (
            monitor_by_id["xy-slab"]["operator"].get("kind") == "slab_average"
            and float(
                monitor_by_id["xy-slab"]["operator"].get("thickness_m", 0.0)
            )
            > 0.0
            and slab_validation["pass"]
        ),
        "depth_operator": "depth-mean" in monitors,
        "axis_or_operator_parity": parity_error <= 1e-6,
        "surface_operator": args.backend == "fdm" or "object-surface" in monitors,
        "sampling_is_explicit_cpu_postprocessor": all(
            result["sampling_execution"] == "cpu" for result in monitors.values()
        ),
        "exact_sample_identity": all(
            result["exact_sample_identity"] and result["mask_exact_sample_identity"]
            for result in monitors.values()
        ),
        "exact_vector_sample_identity": all(
            result["vector_exact_sample_identity"] for result in monitors.values()
        ),
    }
    rotated_validation = None
    if rotated_components:
        rotated_validation = rotated_basis_validation(rotated_components, (1.0, 0.0, 0.0))
        gates["rotated_basis_signs"] = rotated_validation["pass"]
    execution, execution_matches = run_execution(
        wait_json(
            args.api_base,
            "/v2/sessions/current/simulation/runs/current",
        ),
        args.backend,
        args.device,
    )
    gates["execution_provenance_matches_requested_lane"] = execution_matches
    status = wait_json(args.api_base, "/v2/sessions/current/status")
    head = git_head()
    passed_case_ids = set()
    exact_oracle_identity = all(
        result["exact_sample_identity"] and result["mask_exact_sample_identity"]
        for result in monitors.values()
    )
    if exact_oracle_identity:
        passed_case_ids.update(
            {
                "live-m-xy-plane",
                "live-m-scalar-payload",
                "live-m-slab",
                "live-m-depth",
                "target-object",
            }
        )
    if gates["exact_vector_sample_identity"]:
        passed_case_ids.add("live-m-vector-payload")
    if isolation_validation and isolation_validation["pass"]:
        passed_case_ids.add("fdm-object-isolation")
    if airbox_case["passed"]:
        passed_case_ids.update({"target-airbox", "airbox-carrier-provenance"})
    if (
        gates["constant_vector_field"]
        and gates["constant_scalar_bins"]
        and exact_oracle_identity
    ):
        passed_case_ids.add("constant-field-oracle")
    if (
        gates["linear_scalar_analytic_rms"]
        and gates["linear_scalar_probe"]
        and gates["slab_measure_contract"]
        and all(
            result["exact_sample_identity"]
            for result in linear_monitors.values()
        )
    ):
        passed_case_ids.update({"linear-slab-oracle", "live-material-scalar"})
    if matrix_case_passes(
        matrix_monitors["xz-plane"], expected_frame_preset="xz"
    ):
        passed_case_ids.add("live-m-xz-plane")
    if matrix_case_passes(
        matrix_monitors["yz-plane"], expected_frame_preset="yz"
    ):
        passed_case_ids.add("live-m-yz-plane")
    if matrix_case_passes(
        matrix_monitors["domain-plane"], expected_target={"kind": "domain"}
    ):
        passed_case_ids.add("target-domain")
    if matrix_case_passes(
        matrix_monitors["magnetic-plane"], expected_target={"kind": "magnetic_domain"}
    ):
        passed_case_ids.add("target-magnetic")
    if matrix_case_passes(
        matrix_monitors["region-plane"],
        expected_target={
            "kind": "region",
            "object_id": "planar_film",
            "region_id": "qualification_core",
        },
    ):
        passed_case_ids.add("target-region-or-part")
    if matrix_case_passes(
        field_quantity_cases["H_eff"], expected_quantity_id="H_eff"
    ):
        passed_case_ids.add("live-h-eff")
    if matrix_case_passes(
        field_quantity_cases["H_demag"], expected_quantity_id="H_demag"
    ):
        passed_case_ids.add("live-h-demag")
    if (
        persisted_snapshot_case["passed"]
        and persisted_snapshot_case["result"]["exact_sample_identity"]
    ):
        passed_case_ids.add("persisted-m-xy-plane")
    if rotated_validation and rotated_validation["pass"]:
        if all(
            result["exact_sample_identity"]
            for result in rotated_components.values()
        ):
            passed_case_ids.update(
                {"live-m-arbitrary-components", "rotated-basis-signs"}
            )
    if (
        args.backend == "fem"
        and monitors["object-surface"]["exact_sample_identity"]
    ):
        passed_case_ids.add("live-m-surface")
    qualification_cases = build_qualification_cases(
        backend=args.backend,
        device=args.device,
        executed_case_ids=passed_case_ids,
    )
    qualification_complete = all(
        not case["required"] or case["passed"] for case in qualification_cases
    )
    report = {
        "backend": args.backend,
        "airbox_case": airbox_case,
        "device": args.device,
        "execution": execution,
        "gates": gates,
        "head": head,
        "metrics": {
            "axis_or_operator_parity_error": parity_error,
            "constant_scalar_range": max(
                float(result["stats"]["max"]) - float(result["stats"]["min"])
                for result in monitors.values()
            ),
            "max_rms_error_from_unit_magnitude": max_error,
            "max_linear_probe_error_A_per_m": max_linear_probe_error,
            "max_linear_rms_error_A_per_m": max_linear_rms_error,
            "asymmetric_slab": slab_validation,
        },
        "monitor_collection_revision": collection["scene_revision"],
        "linear_material_monitors": linear_monitors,
        "field_quantity_cases": field_quantity_cases,
        "fixture_oracle": {"asymmetric_slab": SLAB_ORACLE},
        "isolation_validation": isolation_validation,
        "matrix_monitors": matrix_monitors,
        "monitors": monitors,
        "persisted_snapshot_case": persisted_snapshot_case,
        "refinement_validation": refinement_validation,
        "qualification_cases": qualification_cases,
        "qualification_profile": args.qualification_profile,
        "qualification_complete": qualification_complete,
        "qualification_status": "qualified" if qualification_complete else "blocked",
        "rotated_basis": rotated_validation,
        "rotated_components": rotated_components,
        "runtime_bundle_identity": {
            "api_contract_version": status.get("api_contract_version"),
            "runtime_bundle_version": status.get("runtime_bundle_version"),
            "resolved_runtime_family": execution.get("resolved_runtime_family"),
        },
        "pass": qualification_complete and all(gates.values()),
        "schema_version": "viewport-2d-planar-science-report-v2",
    }
    validate_qualification_report(report)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_json(args.output, report)
    no_go_path = args.output.parent.parent / "fdm-gpu-no-go.json"
    write_json(no_go_path, build_fdm_gpu_no_go(head))
    synchronize_cross_backend_reports(args.output)
    report = json.loads(args.output.read_text())
    if args.qualification_profile == "mesh-refined":
        if not mesh_refined_peer_is_valid(report):
            raise SystemExit(f"invalid mesh-refined peer report: {args.output}")
        print(f"Planar mesh-refinement peer report captured: {args.output}")
        return
    if not report["pass"]:
        raise SystemExit(
            f"planar science qualification {report['qualification_status']}: "
            f"{args.output}"
        )
    print(
        f"Planar science report {report['qualification_status']}: {args.output}"
    )


if __name__ == "__main__":
    main()
