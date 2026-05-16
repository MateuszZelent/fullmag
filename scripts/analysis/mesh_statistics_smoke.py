#!/usr/bin/env python3
"""Smoke benchmark for mesh statistics serialization on medium/large FEM meshes."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
PY_SRC = REPO_ROOT / "packages" / "fullmag-py" / "src"
if str(PY_SRC) not in sys.path:
    sys.path.insert(0, str(PY_SRC))

from fullmag.meshing._gmsh_types import MeshData, MeshQualityReport  # noqa: E402


CASE_ELEMENT_COUNTS = {
    "medium": 5_000,
    "large": 50_000,
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
    return MeshData(
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
    return {
        "case": case,
        "duration_seconds": duration_seconds,
        "edge_length_mean": statistics["edge_length"]["mean"],
        "elements": mesh.n_elements,
        "nodes": mesh.n_nodes,
        "volume_ratio": statistics["volume"]["ratio"],
        "worst_element_count": len(mesh_ir["mesh_statistics"].get("worst_elements", [])),
    }


def run_smoke(cases: list[str], *, max_case_seconds: float | None) -> dict[str, Any]:
    results = [run_case(case) for case in cases]
    failures = [
        result
        for result in results
        if max_case_seconds is not None and result["duration_seconds"] > max_case_seconds
    ]
    return {
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
        help="Fail if any case exceeds this wall-time budget.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    payload = run_smoke(args.cases or list(CASE_ELEMENT_COUNTS), max_case_seconds=args.max_case_seconds)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 1 if payload["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
