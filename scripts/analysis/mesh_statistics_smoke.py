#!/usr/bin/env python3
"""Smoke benchmark for mesh statistics serialization on medium/large FEM meshes."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_SRC = REPO_ROOT / "packages" / "fullmag-py" / "src"
if str(PY_SRC) not in sys.path:
    sys.path.insert(0, str(PY_SRC))

from fullmag.meshing._gmsh_types import MeshData, MeshQualityReport  # noqa: E402
from fullmag.meshing.remesh_cli import _write_topology_artifact_if_needed  # noqa: E402


CASE_ELEMENT_COUNTS = {
    "medium": 5_000,
    "large": 50_000,
}

RELEASE_BUDGET_PROFILES = {
    "release-smoke": {
        "medium": 1.0,
        "large": 5.0,
    },
}


def _histogram(values: np.ndarray, *, lo: float, hi: float) -> list[int]:
    counts, _ = np.histogram(values, bins=20, range=(lo, hi))
    return counts.astype(int).tolist()


def build_synthetic_tet_mesh(element_count: int) -> MeshData:
    if element_count <= 0:
        raise ValueError("element_count must be positive")

    base = np.arange(element_count, dtype=np.float64)[:, None] * 2.0
    nodes = np.empty((element_count, 4, 3), dtype=np.float64)
    nodes[:, 0, :] = np.column_stack([base[:, 0], np.zeros(element_count), np.zeros(element_count)])
    nodes[:, 1, :] = np.column_stack([base[:, 0] + 1.0, np.zeros(element_count), np.zeros(element_count)])
    nodes[:, 2, :] = np.column_stack([base[:, 0], np.ones(element_count), np.zeros(element_count)])
    nodes[:, 3, :] = np.column_stack([base[:, 0], np.zeros(element_count), np.ones(element_count)])
    flat_nodes = nodes.reshape(element_count * 4, 3)
    elements = np.arange(element_count * 4, dtype=np.int32).reshape(element_count, 4)
    markers = np.ones((element_count,), dtype=np.int32)
    boundary_faces = np.zeros((0, 3), dtype=np.int32)
    boundary_markers = np.zeros((0,), dtype=np.int32)

    sicn = np.linspace(0.2, 1.0, element_count, dtype=np.float64)
    gamma = np.linspace(0.1, 0.95, element_count, dtype=np.float64)
    volumes = np.full((element_count,), 1.0 / 6.0, dtype=np.float64)
    quality = MeshQualityReport(
        n_elements=element_count,
        sicn_min=float(sicn.min()),
        sicn_max=float(sicn.max()),
        sicn_mean=float(sicn.mean()),
        sicn_p5=float(np.percentile(sicn, 5)),
        sicn_histogram=_histogram(sicn, lo=-1.0, hi=1.0),
        gamma_min=float(gamma.min()),
        gamma_mean=float(gamma.mean()),
        gamma_histogram=_histogram(gamma, lo=0.0, hi=1.0),
        volume_min=float(volumes.min()),
        volume_max=float(volumes.max()),
        volume_mean=float(volumes.mean()),
        volume_std=float(volumes.std()),
        avg_quality=float(sicn.mean()),
        element_sicn=sicn.tolist(),
        element_gamma=gamma.tolist(),
        element_volume=volumes.tolist(),
        element_tags=list(range(1, element_count + 1)),
    )
    return MeshData.from_legacy_tet4(
        nodes=flat_nodes,
        elements=elements,
        element_markers=markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
        quality=quality,
    )


def run_case(case: str, *, element_count: int | None = None) -> dict[str, Any]:
    resolved_count = element_count if element_count is not None else CASE_ELEMENT_COUNTS[case]
    mesh = build_synthetic_tet_mesh(resolved_count)
    started = time.perf_counter()
    mesh_ir = mesh.to_ir(f"synthetic_{case}")
    duration_seconds = time.perf_counter() - started
    statistics = mesh_ir["mesh_statistics"]["global"]

    artifact_started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="fullmag-topology-smoke-") as tmp_dir:
        topology_artifact = _write_topology_artifact_if_needed(
            mesh,
            mesh_name=f"synthetic_{case}",
            topology_artifact_dir=tmp_dir,
            inline_topology_max_bytes=0,
        )
        if topology_artifact is None:
            raise RuntimeError("topology artifact was not written")
        artifact_path = Path(str(topology_artifact["path"]))
        artifact_payload = json.loads(artifact_path.read_text(encoding="utf-8"))
        artifact_node_count = len(artifact_payload["nodes"])
        artifact_element_count = len(artifact_payload["cell_types"])
        topology_artifact_byte_size = int(topology_artifact["byte_size"])
        topology_artifact_kind = str(topology_artifact["kind"])
    topology_artifact_seconds = time.perf_counter() - artifact_started

    return {
        "case": case,
        "duration_seconds": duration_seconds,
        "edge_length_mean": statistics["edge_length"]["mean"],
        "elements": mesh.n_elements,
        "nodes": mesh.n_nodes,
        "topology_artifact_byte_size": topology_artifact_byte_size,
        "topology_artifact_elements": artifact_element_count,
        "topology_artifact_kind": topology_artifact_kind,
        "topology_artifact_nodes": artifact_node_count,
        "topology_artifact_seconds": topology_artifact_seconds,
        "volume_ratio": statistics["volume"]["ratio"],
        "worst_element_count": len(mesh_ir["mesh_statistics"].get("worst_elements", [])),
    }


def resolve_case_budgets(
    cases: list[str],
    *,
    budget_profile: str | None,
    max_case_seconds: float | None,
) -> dict[str, float]:
    if budget_profile is not None:
        profile = RELEASE_BUDGET_PROFILES[budget_profile]
        budgets = {case: float(profile[case]) for case in cases if case in profile}
    else:
        budgets = {}
    if max_case_seconds is not None:
        budgets.update({case: float(max_case_seconds) for case in cases})
    return budgets


def budget_failures(
    results: list[dict[str, Any]],
    budgets: dict[str, float],
    *,
    duration_key: str,
) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    for result in results:
        case = str(result["case"])
        budget = budgets.get(case)
        duration = float(result[duration_key])
        if budget is not None and duration > budget:
            failure = dict(result)
            failure["budget_seconds"] = budget
            failure["duration_key"] = duration_key
            failures.append(failure)
    return failures


def run_smoke(
    cases: list[str],
    *,
    max_case_seconds: float | None,
    budget_profile: str | None = None,
) -> dict[str, Any]:
    results = [run_case(case) for case in cases]
    budgets = resolve_case_budgets(
        cases,
        budget_profile=budget_profile,
        max_case_seconds=max_case_seconds,
    )
    failures = budget_failures(results, budgets, duration_key="duration_seconds")
    failures.extend(
        budget_failures(
            results,
            budgets,
            duration_key="topology_artifact_seconds",
        )
    )
    return {
        "budget_profile": budget_profile,
        "case_budgets_seconds": budgets,
        "cases": results,
        "failed": len(failures) > 0,
        "failures": failures,
        "max_case_seconds": max_case_seconds,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--case",
        action="append",
        choices=sorted(CASE_ELEMENT_COUNTS),
        dest="cases",
        help="Case to run. Defaults to medium and large.",
    )
    parser.add_argument(
        "--max-case-seconds",
        type=float,
        default=None,
        help="Override and fail if any case exceeds this wall-time budget.",
    )
    parser.add_argument(
        "--budget-profile",
        choices=sorted(RELEASE_BUDGET_PROFILES),
        default=None,
        help="Named release budget profile to apply per case.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    payload = run_smoke(
        args.cases or list(CASE_ELEMENT_COUNTS),
        max_case_seconds=args.max_case_seconds,
        budget_profile=args.budget_profile,
    )
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 1 if payload["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
