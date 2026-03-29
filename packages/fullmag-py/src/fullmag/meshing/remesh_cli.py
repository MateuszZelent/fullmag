#!/usr/bin/env python3
"""CLI remesh subprocess: reads JSON config on stdin, outputs new mesh JSON on stdout.

Used by the Rust CLI wait_for_solve gate to re-generate an FEM mesh with
updated parameters (hmax, algorithm, etc.) without re-running the entire
Python script.

Protocol:
  stdin  → JSON: { geometry, hmax, order, mesh_options }
  stdout → JSON: { mesh_name, nodes, elements, element_markers,
                    boundary_faces, boundary_markers, quality }
  stderr → progress lines (prefixed with __FULLMAG_PROGRESS__)
"""
from __future__ import annotations

import json
import sys
from typing import Any

from fullmag.meshing.gmsh_bridge import (
    MeshOptions,
    generate_mesh,
)
from fullmag.model.geometry import (
    Box,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    ImportedGeometry,
    Intersection,
    Translate,
    Union,
)


def _geometry_from_ir(entry: dict[str, Any]) -> Any:
    """Reconstruct a Geometry object from an IR geometry entry."""
    kind = entry.get("kind", "")

    if kind == "box":
        size = entry["size"]
        return Box(size[0], size[1], size[2])
    if kind == "cylinder":
        return Cylinder(entry["radius"], entry["height"])
    if kind == "ellipsoid":
        radii = entry["radii"]
        return Ellipsoid(radii[0], radii[1], radii[2])
    if kind == "sphere":
        r = entry["radius"]
        return Ellipsoid(r, r, r)  # Sphere → Ellipsoid with equal radii
    if kind == "ellipse":
        radii = entry["radii"]
        return Ellipse(radii[0], radii[1], entry["height"])
    if kind == "imported_geometry":
        return ImportedGeometry(
            source=entry["source"],
            scale=entry.get("scale", 1.0),
        )
    if kind == "difference":
        return Difference(
            base=_geometry_from_ir(entry["base"]),
            tool=_geometry_from_ir(entry["tool"]),
        )
    if kind == "union":
        return Union(
            a=_geometry_from_ir(entry["a"]),
            b=_geometry_from_ir(entry["b"]),
        )
    if kind == "intersection":
        return Intersection(
            a=_geometry_from_ir(entry["a"]),
            b=_geometry_from_ir(entry["b"]),
        )
    if kind == "translate":
        by = entry["by"]
        return Translate(
            geometry=_geometry_from_ir(entry["base"]),
            offset=(by[0], by[1], by[2]),
        )
    raise ValueError(f"unsupported geometry kind for remesh: {kind!r}")


def _mesh_options_from_dict(opts: dict[str, Any]) -> MeshOptions:
    """Build MeshOptions from a dict (as sent by the GUI)."""
    return MeshOptions(
        algorithm_2d=opts.get("algorithm_2d", 6),
        algorithm_3d=opts.get("algorithm_3d", 1),
        hmin=opts.get("hmin"),
        size_factor=opts.get("size_factor", 1.0),
        size_from_curvature=opts.get("size_from_curvature", 0),
        smoothing_steps=opts.get("smoothing_steps", 1),
        optimize=opts.get("optimize"),
        optimize_iters=opts.get("optimize_iterations", 1),
        compute_quality=opts.get("compute_quality", True),
        per_element_quality=opts.get("per_element_quality", False),
    )


def main() -> None:
    raw = sys.stdin.read()
    config = json.loads(raw)

    geometry = _geometry_from_ir(config["geometry"])
    mesh_opts_dict = config.get("mesh_options", {})
    # hmax can come from mesh_options (GUI override) or top-level config
    hmax = mesh_opts_dict.get("hmax") or config["hmax"]
    order = config.get("order", 1)
    mesh_opts = _mesh_options_from_dict(mesh_opts_dict)

    mesh_data = generate_mesh(geometry, hmax=hmax, order=order, options=mesh_opts)

    result: dict[str, Any] = {
        "mesh_name": config.get("mesh_name", "remeshed"),
        "nodes": mesh_data.nodes.tolist(),
        "elements": mesh_data.elements.tolist(),
        "element_markers": mesh_data.element_markers.tolist(),
        "boundary_faces": mesh_data.boundary_faces.tolist(),
        "boundary_markers": mesh_data.boundary_markers.tolist(),
    }

    if mesh_data.quality is not None:
        q = mesh_data.quality
        result["quality"] = {
            "nElements": q.n_elements,
            "sicnMin": q.sicn_min,
            "sicnMax": q.sicn_max,
            "sicnMean": q.sicn_mean,
            "sicnP5": q.sicn_p5,
            "sicnHistogram": q.sicn_histogram,
            "gammaMin": q.gamma_min,
            "gammaMean": q.gamma_mean,
            "gammaHistogram": q.gamma_histogram,
            "volumeMin": q.volume_min,
            "volumeMax": q.volume_max,
            "volumeMean": q.volume_mean,
            "volumeStd": q.volume_std,
            "avgQuality": q.avg_quality,
        }

    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
