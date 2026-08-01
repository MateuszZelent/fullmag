#!/usr/bin/env python3
"""Fail closed on drift in the checked-in periodic-antidot LLG fixture."""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def close(actual: float, expected: float, tolerance: float = 1.0e-18) -> bool:
    return abs(actual - expected) <= tolerance


def main() -> int:
    try:
        manifest_path = Path(sys.argv[1])
        manifest: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
        require(
            manifest.get("schema_version") == "fem_periodic_antidot_llg_qualification_problem.v1",
            "unexpected periodic-antidot qualification manifest schema",
        )
        mesh_path = manifest_path.with_name(str(manifest["mesh_asset"]))
        mesh_bytes = mesh_path.read_bytes()
        require(
            hashlib.sha256(mesh_bytes).hexdigest() == manifest["mesh_sha256"],
            "periodic-antidot qualification mesh digest drifted",
        )
        mesh: dict[str, Any] = json.loads(mesh_bytes)
        counts = manifest["expected_counts"]
        nodes = mesh["nodes"]
        elements = mesh["elements"]
        markers = mesh["element_markers"]
        require(len(nodes) == counts["nodes"], "periodic-antidot node count drifted")
        require(len(elements) == len(markers) == counts["elements"], "periodic-antidot element count drifted")
        require(markers.count(1) + markers.count(2) == counts["magnetic_elements"], "magnetic element count drifted")
        require(markers.count(0) == counts["air_elements"], "air element count drifted")
        magnetic_nodes = {
            node
            for element, marker in zip(elements, markers, strict=True)
            if marker in (1, 2)
            for node in element
        }
        require(len(magnetic_nodes) == counts["magnetic_nodes"], "magnetic node count drifted")
        require(
            len(mesh["periodic_node_pairs"]) == counts["periodic_node_pairs"],
            "periodic node-pair count drifted",
        )
        require(
            {pair["pair_id"] for pair in mesh["periodic_node_pairs"]} == {"x_faces", "y_faces"},
            "periodic node pairs must cover exactly x_faces and y_faces",
        )
        require(
            {pair["pair_id"] for pair in mesh["periodic_boundary_pairs"]} == {"x_faces", "y_faces"},
            "periodic boundary pairs must cover exactly x_faces and y_faces",
        )
        magnetic_bounds = [
            (min(nodes[node][axis] for node in magnetic_nodes), max(nodes[node][axis] for node in magnetic_nodes))
            for axis in range(3)
        ]
        expected_half_extent = [4.0e-8, 4.0e-8, 4.0e-9]
        for axis, half_extent in enumerate(expected_half_extent):
            require(close(magnetic_bounds[axis][0], -half_extent), f"magnetic lower bound axis {axis} drifted")
            require(close(magnetic_bounds[axis][1], half_extent), f"magnetic upper bound axis {axis} drifted")
        minimum_radius = min(math.hypot(nodes[node][0], nodes[node][1]) for node in magnetic_nodes)
        require(close(minimum_radius, 1.0e-8), "antidot hole radius drifted")
        require(manifest["periodicity"]["axes"] == ["periodic", "periodic", "open"], "fixture must keep x/y periodic and z open")
        require(manifest["periodicity"]["demag"] == "periodic_airbox_k0", "fixture must keep periodic_airbox_k0")
    except (IndexError, KeyError, OSError, TypeError, ValueError, RuntimeError) as error:
        print(f"FAIL: {error}")
        return 1
    print("FEM periodic-antidot LLG qualification asset PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
