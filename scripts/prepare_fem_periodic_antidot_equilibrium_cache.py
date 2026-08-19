#!/usr/bin/env python3
"""Prepare a hash-pinned periodic-antidot equilibrium cache from one run."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "fem_periodic_antidot_equilibrium_cache.v2"
IDENTITY_SCHEMA_VERSION = "fem_periodic_antidot_equilibrium_identity.v1"
CACHE_IDENTITY_NAMESPACE = "fem_periodic_antidot_equilibrium_cache_identity.v1"
_SHA256_RE = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"{label} is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} is invalid JSON: {exc}") from exc
    return _require_object(value, label)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return f"sha256:{digest.hexdigest()}"


def _canonical_json_sha256(namespace: str, value: Any) -> str:
    try:
        encoded = json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"cannot encode canonical cache identity: {exc}") from exc
    digest = hashlib.sha256()
    digest.update(namespace.encode("utf-8"))
    digest.update(b"\0")
    digest.update(encoded)
    return f"sha256:{digest.hexdigest()}"


def _canonical_source_hash(value: Any) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise ValueError("relaxation metadata.source_hash must be a canonical sha256 digest")
    return value if value.startswith("sha256:") else f"sha256:{value}"


def _finite_number(value: Any, label: str, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result) or (positive and result <= 0.0):
        raise ValueError(f"{label} must be a finite {'positive ' if positive else ''}number")
    return result


def _accepted_completion(
    metadata: dict[str, Any],
    scenario: dict[str, Any],
    qualification: dict[str, Any],
) -> dict[str, Any]:
    if qualification.get("converged") is not True:
        raise ValueError("relaxation is not a converged torque equilibrium")
    if qualification.get("stop_reason") != "torque":
        raise ValueError("relaxation stop_reason must be torque")
    if qualification.get("stop_metric_kind") != "max_torque_apm":
        raise ValueError("relaxation stop_metric_kind must be max_torque_apm")
    if qualification.get("stop_metric_unit") != "A/m":
        raise ValueError("relaxation stop_metric_unit must be A/m")
    metric_value = _finite_number(
        qualification.get("stop_metric_value"),
        "relaxation stop_metric_value",
    )
    final_torque_apm = _finite_number(
        qualification.get("final_torque_apm"),
        "relaxation final_torque_apm",
    )
    threshold = _finite_number(
        qualification.get("stop_threshold"),
        "relaxation stop_threshold",
        positive=True,
    )
    authored_threshold = _finite_number(
        scenario.get("equilibrium_torque_tolerance_a_per_m"),
        "periodic-antidot equilibrium_torque_tolerance_a_per_m",
        positive=True,
    )
    if metric_value < 0.0 or final_torque_apm < 0.0:
        raise ValueError("relaxation torque values must be non-negative")
    if metric_value != final_torque_apm:
        raise ValueError("relaxation stop_metric_value must equal final_torque_apm")
    if threshold != authored_threshold:
        raise ValueError("relaxation stop_threshold must equal the authored A/m torque tolerance")
    if metric_value > threshold:
        raise ValueError("relaxation equilibrium does not satisfy its authored torque threshold")
    return {
        "status": metadata["status"],
        "converged": True,
        "stop_reason": "torque",
        "metric_kind": "max_torque_apm",
        "metric_unit": "A/m",
        "metric_value": metric_value,
        "threshold": threshold,
    }


def _find_relax_stage(report_root: Path) -> tuple[Path, str]:
    candidates = sorted(
        path
        for path in report_root.glob("workspace-history/session-*/stages/stage_00_flat_relax")
        if path.is_dir()
    )
    if len(candidates) != 1:
        raise ValueError(
            "report root must contain exactly one workspace-history session with "
            f"stage_00_flat_relax (found {len(candidates)})"
        )
    stage = candidates[0]
    session_id = stage.parents[1].name
    return stage, session_id


def _extract_magnetic_state(
    values: list[Any], segments: list[Any]
) -> list[list[float]]:
    magnetic: list[list[float]] = []
    for segment_index, raw_segment in enumerate(segments):
        segment = _require_object(raw_segment, f"object_segments[{segment_index}]")
        if segment.get("object_id") == "__air__":
            continue
        start = segment.get("node_start")
        count = segment.get("node_count")
        if not isinstance(start, int) or start < 0:
            raise ValueError(f"object_segments[{segment_index}].node_start must be non-negative")
        if not isinstance(count, int) or count < 0:
            raise ValueError(f"object_segments[{segment_index}].node_count must be non-negative")
        end = start + count
        if end > len(values):
            raise ValueError(f"object_segments[{segment_index}] exceeds m_final.values")
        for vector_index, raw_vector in enumerate(values[start:end], start=start):
            vector = raw_vector
            if (
                not isinstance(vector, list)
                or len(vector) != 3
                or any(not isinstance(component, (int, float)) for component in vector)
            ):
                raise ValueError(f"m_final.values[{vector_index}] must be a numeric vector3")
            magnetic.append([float(component) for component in vector])
    if not magnetic:
        raise ValueError("relaxation metadata contains no magnetic object segments")
    return magnetic


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def prepare_cache(report_root: Path, output_root: Path, *, force: bool = False) -> dict[str, Any]:
    report_root = report_root.expanduser().resolve()
    output_root = output_root.expanduser().resolve()
    stage_root, session_id = _find_relax_stage(report_root)
    metadata = _read_json(stage_root / "metadata.json", "relaxation metadata")
    final_state = _read_json(stage_root / "m_final.json", "relaxation m_final")
    if metadata.get("status") != "completed":
        raise ValueError("relaxation stage is not completed")
    if final_state.get("observable") != "m" or final_state.get("unit") not in {
        1,
        "1",
        "dimensionless",
    }:
        raise ValueError("relaxation m_final must be a dimensionless magnetization field")
    values = final_state.get("values")
    if not isinstance(values, list) or not values:
        raise ValueError("relaxation m_final.values must be a non-empty list")

    execution_plan = _require_object(metadata.get("execution_plan"), "execution_plan")
    backend_plan = _require_object(execution_plan.get("backend_plan"), "backend_plan")
    mesh = _require_object(backend_plan.get("mesh"), "backend_plan.mesh")
    nodes = mesh.get("nodes")
    if not isinstance(nodes, list) or len(nodes) != len(values):
        raise ValueError("domain mesh node count must match the full m_final vector count")
    segments = backend_plan.get("object_segments")
    if not isinstance(segments, list):
        raise ValueError("backend_plan.object_segments must be a list")
    magnetic_values = _extract_magnetic_state(values, segments)

    scenario = _require_object(
        _require_object(metadata.get("problem_meta"), "problem_meta").get(
            "runtime_metadata"
        ),
        "problem_meta.runtime_metadata",
    ).get("periodic_antidot_eigensolve")
    scenario = _require_object(scenario, "periodic_antidot_eigensolve")
    if scenario.get("scenario") != "relax_then_eigenmodes_k0":
        raise ValueError("source stage is not the periodic-antidot K0 eigensolve scenario")
    qualification = _require_object(
        metadata.get("fem_cpu_relaxation_qualification"),
        "fem_cpu_relaxation_qualification",
    )
    completion = _accepted_completion(metadata, scenario, qualification)
    source_problem_sha256 = _canonical_source_hash(metadata.get("source_hash"))
    mesh_identity = _require_object(metadata.get("mesh"), "metadata.mesh")
    mesh_generation_id = mesh_identity.get("mesh_generation_id")
    topology_fingerprint = mesh_identity.get("topology_fingerprint")
    if not isinstance(mesh_generation_id, str) or not mesh_generation_id.strip():
        raise ValueError("metadata.mesh.mesh_generation_id must be a non-empty string")
    if (
        not isinstance(topology_fingerprint, str)
        or _SHA256_RE.fullmatch(topology_fingerprint) is None
    ):
        raise ValueError("metadata.mesh.topology_fingerprint must be a canonical sha256 digest")

    if output_root.exists() and any(output_root.iterdir()) and not force:
        raise ValueError(f"output cache is not empty; pass --force to replace known artifacts: {output_root}")
    output_root.mkdir(parents=True, exist_ok=True)
    for name in ("domain_mesh.json", "equilibrium_m.json", "magnetic_m.json", "manifest.json"):
        path = output_root / name
        if path.exists() and path.is_dir():
            raise ValueError(f"cache artifact path is a directory: {path}")

    domain_mesh_path = output_root / "domain_mesh.json"
    equilibrium_state_path = output_root / "equilibrium_m.json"
    magnetic_state_path = output_root / "magnetic_m.json"
    _write_json(domain_mesh_path, mesh)
    shutil.copyfile(stage_root / "m_final.json", equilibrium_state_path)
    _write_json(
        magnetic_state_path,
        {
            "kind": "magnetization_state",
            "observable": "m",
            "format": "json",
            "unit": "dimensionless",
            "source": {
                "kind": "shared_domain_m_final_magnetic_slice",
                "source_run_id": metadata.get("run_id"),
                "source_stage_id": metadata.get("stage_id"),
                "source_step": final_state.get("step"),
                "source_time": final_state.get("time"),
            },
            "vector_count": len(magnetic_values),
            "values": magnetic_values,
        },
    )

    identity = {
        "schema_version": IDENTITY_SCHEMA_VERSION,
        "source_problem_sha256": source_problem_sha256,
        "execution_plan_sha256": _canonical_json_sha256(
            "fem_periodic_antidot_source_execution_plan.v1", execution_plan
        ),
        "equilibrium_contract_sha256": _canonical_json_sha256(
            "fem_periodic_antidot_equilibrium_contract.v1",
            {
                "material": backend_plan.get("material"),
                "enable_exchange": backend_plan.get("enable_exchange"),
                "enable_demag": backend_plan.get("enable_demag"),
                "external_field": backend_plan.get("external_field"),
                "exchange_bc": backend_plan.get("exchange_bc"),
                "demag_realization": backend_plan.get("demag_realization"),
                "air_box_config": backend_plan.get("air_box_config"),
                "periodic_node_pairs": mesh.get("periodic_node_pairs"),
                "periodic_boundary_pairs": mesh.get("periodic_boundary_pairs"),
            },
        ),
        "mesh_content_sha256": _canonical_json_sha256(
            "fem_periodic_antidot_domain_mesh.v1", mesh
        ),
        "node_indexing_sha256": _canonical_json_sha256(
            "fem_periodic_antidot_mesh_indexing.v1",
            {"nodes": nodes, "cells": mesh.get("cells")},
        ),
        "part_registry_sha256": _canonical_json_sha256(
            "fem_periodic_antidot_part_registry.v1",
            {
                "object_segments": segments,
                "mesh_parts": backend_plan.get("mesh_parts"),
                "domain_mesh_mode": backend_plan.get("domain_mesh_mode"),
                "domain_frame": backend_plan.get("domain_frame"),
            },
        ),
    }
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "kind": "fem_periodic_antidot_equilibrium_cache",
        "scenario": "relax_then_eigenmodes_k0",
        "source": {
            "report_root": str(report_root),
            "session_id": session_id,
            "stage_id": metadata.get("stage_id"),
            "run_id": metadata.get("run_id"),
        },
        "mesh": {
            "mesh_generation_id": mesh_generation_id,
            "topology_fingerprint": topology_fingerprint,
            "mesh_name": mesh.get("mesh_name"),
            "node_count": len(nodes),
        },
        "completion": completion,
        "identity": identity,
        "equilibrium": {
            "source_step": final_state.get("step"),
            "source_time": final_state.get("time"),
            "torque_tolerance_t": scenario.get("equilibrium_torque_tolerance_t"),
            "torque_tolerance_a_per_m": completion["threshold"],
            "final_torque_apm": completion["metric_value"],
            "vector_count": len(values),
            "magnetic_vector_count": len(magnetic_values),
        },
        "artifacts": {
            "domain_mesh": {
                "path": "domain_mesh.json",
                "sha256": _sha256(domain_mesh_path),
            },
            "equilibrium_state": {
                "path": "equilibrium_m.json",
                "sha256": _sha256(equilibrium_state_path),
            },
            "magnetic_state": {
                "path": "magnetic_m.json",
                "sha256": _sha256(magnetic_state_path),
            },
        },
        "reuse_policy": {
            "requires_exact_mesh_identity": True,
            "requires_matching_physics_and_materials": True,
            "relaxation_may_be_skipped_only_after_torque_check": True,
        },
    }
    manifest["cache_identity_sha256"] = _canonical_json_sha256(
        CACHE_IDENTITY_NAMESPACE, manifest
    )
    _write_json(output_root / "manifest.json", manifest)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_root", type=Path)
    parser.add_argument("output_root", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        manifest = prepare_cache(args.report_root, args.output_root, force=args.force)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
