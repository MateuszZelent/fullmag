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
import os
import sys
from typing import Any

import numpy as np

from fullmag._progress import emit_progress
from fullmag.meshing.asset_pipeline import (
    SharedDomainBuildReport,
    realize_fem_domain_mesh_asset_from_components_with_report,
)
from fullmag.meshing.gmsh_bridge import (
    MeshOptions,
    SizeFieldData,
    generate_mesh,
    remesh_with_size_field,
)
from fullmag.model.discretization import FEM
from fullmag.model.geometry import (
    ArchWaveguide,
    Box,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    ImportedGeometry,
    Intersection,
    SinWaveguide,
    Translate,
    Union,
)


def _geometry_from_ir(entry: dict[str, Any]) -> Any:
    """Reconstruct a Geometry object from an IR geometry entry."""
    kind = entry.get("kind", "")

    if kind == "box":
        size = entry["size"]
        return Box(size[0], size[1], size[2], name=entry.get("name", "box"))
    if kind == "cylinder":
        return Cylinder(entry["radius"], entry["height"], name=entry.get("name", "cylinder"))
    if kind == "sin_waveguide":
        return SinWaveguide(
            entry["length"],
            entry["width"],
            entry["height"],
            entry["period"],
            entry["amplitude"],
            phase=entry.get("phase", 0.0),
            z0=entry.get("z0", 0.0),
            name=entry.get("name", "sin_waveguide"),
        )
    if kind == "arch_waveguide":
        return ArchWaveguide(
            entry["length"],
            entry["width"],
            entry["height"],
            entry["arch_height"],
            z0=entry.get("z0", 0.0),
            name=entry.get("name", "arch_waveguide"),
        )
    if kind == "ellipsoid":
        radii = entry["radii"]
        return Ellipsoid(radii[0], radii[1], radii[2], name=entry.get("name", "ellipsoid"))
    if kind == "sphere":
        r = entry["radius"]
        return Ellipsoid(r, r, r, name=entry.get("name", "sphere"))  # Sphere → Ellipsoid with equal radii
    if kind == "ellipse":
        radii = entry["radii"]
        return Ellipse(radii[0], radii[1], entry["height"], name=entry.get("name", "ellipse"))
    if kind == "imported_geometry":
        raw_scale = entry.get("scale", 1.0)
        # Rust serializes ImportedGeometryScaleIR as {"Uniform": f} or {"Anisotropic": [x,y,z]}
        if isinstance(raw_scale, dict):
            if "Uniform" in raw_scale:
                raw_scale = raw_scale["Uniform"]
            elif "Anisotropic" in raw_scale:
                raw_scale = tuple(raw_scale["Anisotropic"])
        return ImportedGeometry(
            source=entry["source"],
            scale=raw_scale,
            volume=entry.get("volume", "full"),
            name=entry.get("name"),
        )
    if kind == "difference":
        return Difference(
            base=_geometry_from_ir(entry["base"]),
            tool=_geometry_from_ir(entry["tool"]),
            name=entry.get("name", "difference"),
        )
    if kind == "union":
        return Union(
            a=_geometry_from_ir(entry["a"]),
            b=_geometry_from_ir(entry["b"]),
            name=entry.get("name", "union"),
        )
    if kind == "intersection":
        return Intersection(
            a=_geometry_from_ir(entry["a"]),
            b=_geometry_from_ir(entry["b"]),
            name=entry.get("name", "intersection"),
        )
    if kind == "translate":
        by = entry["by"]
        return Translate(
            geometry=_geometry_from_ir(entry["base"]),
            offset=(by[0], by[1], by[2]),
            name=entry.get("name"),
        )
    raise ValueError(f"unsupported geometry kind for remesh: {kind!r}")


def _mesh_options_from_dict(opts: dict[str, Any]) -> MeshOptions:
    """Build MeshOptions from a dict (as sent by the GUI)."""
    return MeshOptions(
        algorithm_2d=opts.get("algorithm_2d", 6),
        algorithm_3d=opts.get("algorithm_3d", 1),
        hmin=opts.get("hmin"),
        calibrate_for=opts.get("calibrate_for"),
        size_preset=opts.get("size_preset"),
        size_factor=opts.get("size_factor", 1.0),
        size_from_curvature=opts.get("size_from_curvature", 0),
        curvature_factor=opts.get("curvature_factor"),
        growth_rate=opts.get("growth_rate"),
        narrow_regions=opts.get("narrow_regions", 0),
        narrow_region_resolution=opts.get("narrow_region_resolution"),
        smoothing_steps=opts.get("smoothing_steps", 1),
        optimize=opts.get("optimize"),
        optimize_iters=opts.get("optimize_iterations", 1),
        size_fields=opts.get("size_fields", []),
        compute_quality=opts.get("compute_quality", True),
        per_element_quality=opts.get("per_element_quality", True),
    )


def _size_field_from_dict(raw: dict[str, Any]) -> SizeFieldData:
    node_coords = raw.get("node_coords")
    h_values = raw.get("h_values")
    return SizeFieldData(
        node_coords=np.asarray(node_coords, dtype=np.float64),
        h_values=np.asarray(h_values, dtype=np.float64),
    )


def _mesh_result_payload(
    mesh_data: Any,
    *,
    mesh_name: str,
    generation_mode: str,
    mesh_provenance: dict[str, Any],
    size_field_stats: dict[str, Any] | None = None,
    region_markers: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    mesh_ir = mesh_data.to_ir(mesh_name)
    result: dict[str, Any] = {
        "mesh_name": mesh_name,
        "nodes": mesh_data.nodes.tolist(),
        "elements": mesh_data.elements.tolist(),
        "element_markers": mesh_data.element_markers.tolist(),
        "boundary_faces": mesh_data.boundary_faces.tolist(),
        "boundary_markers": mesh_data.boundary_markers.tolist(),
        "periodic_boundary_pairs": list(mesh_ir.get("periodic_boundary_pairs", [])),
        "periodic_node_pairs": list(mesh_ir.get("periodic_node_pairs", [])),
        "mesh_statistics": mesh_ir.get("mesh_statistics"),
        "generation_mode": generation_mode,
        "mesh_provenance": mesh_provenance,
    }

    if size_field_stats is not None:
        result["size_field_stats"] = size_field_stats

    if region_markers is not None:
        result["region_markers"] = region_markers

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

    return result


def _describe_remesh_job(
    mode: str,
    hmax: float,
    order: int,
    *,
    declared_universe: dict[str, Any] | None = None,
    mesh_options: dict[str, Any] | None = None,
) -> str:
    summary = (
        f"Remesh: accepted - mode={mode}, maximum_element_size={float(hmax):.3e}, order=P{int(order)}"
    )
    per_geometry = mesh_options.get("per_geometry") if isinstance(mesh_options, dict) else None
    local_override_count = (
        sum(
            1
            for entry in per_geometry
            if isinstance(entry, dict)
            and isinstance(entry.get("hmax"), (int, float, str))
            and str(entry.get("hmax")).strip() not in {"", "None"}
        )
        if isinstance(per_geometry, list)
        else 0
    )
    if mode != "shared_domain_manual_remesh" or not isinstance(declared_universe, dict):
        return (
            f"{summary}, local_object_overrides={local_override_count}"
            if local_override_count > 0
            else summary
        )
    airbox_hmax = declared_universe.get("airbox_hmax")
    scope_bits = ["scope=shared_domain"]
    if isinstance(airbox_hmax, (int, float)) and float(airbox_hmax) > 0.0:
        scope_bits.extend(
            [
                f"body_maximum_element_size={float(hmax):.3e}",
                f"airbox_maximum_element_size={float(airbox_hmax):.3e}",
            ]
        )
    if local_override_count > 0:
        scope_bits.append(f"local_object_overrides={local_override_count}")
    return f"{summary}, {', '.join(scope_bits)}"


def main() -> None:
    try:
        raw = sys.stdin.read()
        config = json.loads(raw)

        mode = str(config.get("mode", "manual_remesh") or "manual_remesh")
        geometry = (
            _geometry_from_ir(config["geometry"])
            if mode != "shared_domain_manual_remesh"
            else None
        )
        mesh_opts_dict = config.get("mesh_options", {})
        # hmax can come from mesh_options (GUI override) or top-level config
        hmax = mesh_opts_dict.get("hmax") or config["hmax"]
        order = config.get("order", 1)
        mesh_opts = _mesh_options_from_dict(mesh_opts_dict)
        if mode == "adaptive_size_field":
            mesh_opts.compute_quality = bool(mesh_opts_dict.get("compute_quality", True))
            mesh_opts.per_element_quality = bool(mesh_opts_dict.get("per_element_quality", True))
        emit_progress(
            _describe_remesh_job(
                mode,
                float(hmax),
                int(order),
                declared_universe=(
                    config.get("declared_universe")
                    if isinstance(config.get("declared_universe"), dict)
                    else config.get("study_universe")
                ),
                mesh_options=mesh_opts_dict,
            )
        )
        region_markers = None
        shared_domain_report: SharedDomainBuildReport | None = None

        # Redirect the real stdout fd to /dev/null during mesh generation —
        # C libraries like MMG3D print progress banners directly to fd 1,
        # bypassing Python's sys.stdout, which would corrupt the JSON we
        # send back to the Rust caller.
        real_stdout_fd = os.dup(1)
        devnull_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull_fd, 1)
        os.close(devnull_fd)
        try:
            if mode == "adaptive_size_field":
                if not isinstance(config.get("size_field"), dict):
                    raise ValueError(
                        "adaptive_size_field mode requires a size_field payload with node_coords and h_values"
                    )
                size_field = _size_field_from_dict(config["size_field"])
                mesh_data = remesh_with_size_field(
                    geometry,
                    size_field=size_field,
                    hmax=hmax,
                    order=order,
                    options=mesh_opts,
                )
            elif mode == "shared_domain_manual_remesh":
                raw_geometries = config.get("geometries")
                if not isinstance(raw_geometries, list) or not raw_geometries:
                    raise ValueError(
                        "shared_domain_manual_remesh mode requires a non-empty geometries payload"
                    )
                declared_universe = config.get("declared_universe")
                if not isinstance(declared_universe, dict):
                    declared_universe = config.get("study_universe")
                if not isinstance(declared_universe, dict):
                    raise ValueError(
                        "shared_domain_manual_remesh mode requires a declared_universe payload"
                    )
                geometries = [_geometry_from_ir(entry) for entry in raw_geometries]
                mesh_workflow = {
                    "mesh_options": mesh_opts_dict,
                    "per_geometry": (
                        mesh_opts_dict.get("per_geometry")
                        if isinstance(mesh_opts_dict.get("per_geometry"), list)
                        else []
                    ),
                }
                mesh_data, region_markers, shared_domain_report = (
                    realize_fem_domain_mesh_asset_from_components_with_report(
                    geometries,
                    FEM(order=int(order), maximum_element_size=float(hmax)),
                    study_universe=declared_universe,
                    mesh_workflow=mesh_workflow,
                    )
                )
            elif mode == "manual_remesh":
                mesh_data = generate_mesh(geometry, hmax=hmax, order=order, options=mesh_opts)
            else:
                raise ValueError(
                    f"unsupported remesh_cli mode {mode!r}; expected 'manual_remesh', "
                    "'adaptive_size_field' or 'shared_domain_manual_remesh'"
                )
        finally:
            # Flush any C-level buffered output (still aimed at /dev/null)
            # before restoring the real stdout fd.
            import ctypes
            libc = ctypes.CDLL(None)
            libc.fflush(None)
            os.dup2(real_stdout_fd, 1)
            os.close(real_stdout_fd)
            # Re-attach Python's sys.stdout to the restored fd 1
            sys.stdout = os.fdopen(1, "w", closefd=False)

        size_field_stats = None
        if mode == "adaptive_size_field":
            size_field = _size_field_from_dict(config["size_field"])
            size_field_stats = {
                "n_nodes": int(size_field.node_coords.shape[0]),
                "h_min": float(np.min(size_field.h_values)),
                "h_max": float(np.max(size_field.h_values)),
                "h_mean": float(np.mean(size_field.h_values)),
            }

        shared_domain_report_payload = (
            shared_domain_report.to_dict()
            if shared_domain_report is not None
            else None
        )

        result = _mesh_result_payload(
            mesh_data,
            mesh_name=config.get("mesh_name", "remeshed"),
            generation_mode=mode,
            mesh_provenance={
                "geometry_kind": (
                    "shared_domain"
                    if mode == "shared_domain_manual_remesh"
                    else config["geometry"].get("kind")
                ),
                "order": int(order),
                "hmax": float(hmax),
                "mesh_options": mesh_opts_dict,
                "shared_domain_build_mode": (
                    shared_domain_report.build_mode
                    if shared_domain_report is not None
                    else None
                ),
                "fallbacks_triggered": (
                    shared_domain_report_payload["fallbacks_triggered"]
                    if shared_domain_report_payload is not None
                    else []
                ),
                "effective_airbox_target": (
                    shared_domain_report_payload["effective_airbox_target"]
                    if shared_domain_report_payload is not None
                    else None
                ),
                "effective_per_object_targets": (
                    shared_domain_report_payload["effective_per_object_targets"]
                    if shared_domain_report_payload is not None
                    else None
                ),
                "used_size_field_kinds": (
                    shared_domain_report_payload["used_size_field_kinds"]
                    if shared_domain_report_payload is not None
                    else []
                ),
                "operation_statuses": (
                    shared_domain_report_payload["operation_statuses"]
                    if shared_domain_report_payload is not None
                    else []
                ),
                "thin_film_diagnostics": (
                    shared_domain_report_payload["thin_film_diagnostics"]
                    if shared_domain_report_payload is not None
                    else []
                ),
                "shared_domain_build_report": shared_domain_report_payload,
            },
            size_field_stats=size_field_stats,
            region_markers=region_markers,
        )

        json.dump(result, sys.stdout, separators=(",", ":"))
        sys.stdout.flush()
    except Exception as exc:
        import traceback
        print(json.dumps({"error": str(exc), "traceback": traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)
