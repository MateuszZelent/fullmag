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
import struct
import sys
import tempfile
from pathlib import Path
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
from fullmag.meshing._gmsh_types import (
    _build_mesh_statistics_report,
    _mesh_statistics_report_to_ir,
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

_DEFAULT_INLINE_TOPOLOGY_MAX_BYTES = 8 * 1024 * 1024
_QUALITY_DATA_HEADER_LEN = 32
_QUALITY_DATA_VERSION = 1
_QUALITY_DATA_KIND_F64 = 1
_QUALITY_DATA_FLAG_SICN = 1 << 0
_QUALITY_DATA_FLAG_GAMMA = 1 << 1
_QUALITY_DATA_FLAG_VOLUME = 1 << 2


def _geometry_from_ir(entry: dict[str, Any]) -> Any:
    """Reconstruct a Geometry object from an IR geometry entry."""
    kind = entry.get("kind", "")

    if kind == "box":
        size = entry["size"]
        return Box(size[0], size[1], size[2], name=entry.get("name", "box"))
    if kind == "cylinder":
        return Cylinder(
            entry["radius"],
            entry["height"],
            name=entry.get("name", "cylinder"),
            axis=tuple(entry.get("axis", (0.0, 0.0, 1.0))),
        )
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

    def _nonempty_str(value: Any) -> str | None:
        return value if isinstance(value, str) and value.strip() else None

    def _positive_float(value: Any) -> float | None:
        if value is None:
            return None
        parsed = float(value)
        return parsed if parsed > 0.0 else None

    def _positive_int(value: Any) -> int | None:
        if value is None:
            return None
        parsed = int(value)
        return parsed if parsed > 0 else None

    def _int_list(value: Any) -> list[int] | None:
        if not isinstance(value, list):
            return None
        return [int(item) for item in value]

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
        boundary_layer_count=_positive_int(opts.get("boundary_layer_count")),
        boundary_layer_thickness=_positive_float(opts.get("boundary_layer_thickness")),
        boundary_layer_stretching=_positive_float(opts.get("boundary_layer_stretching")),
        boundary_layer_target_surface_tags=_int_list(
            opts.get("boundary_layer_target_surface_tags")
        ),
        boundary_layer_target_curve_tags=_int_list(
            opts.get("boundary_layer_target_curve_tags")
        ),
        mesh_strategy=_nonempty_str(opts.get("mesh_strategy")),
        through_thickness_elements=_positive_int(opts.get("through_thickness_elements")),
        through_thickness_distribution=_nonempty_str(
            opts.get("through_thickness_distribution")
        ),
        through_thickness_element_ratio=_positive_float(
            opts.get("through_thickness_element_ratio")
        ),
        through_thickness_symmetric=bool(opts.get("through_thickness_symmetric", False)),
        sweep_face_meshing=_nonempty_str(opts.get("sweep_face_meshing")),
        sweep_source=_nonempty_str(opts.get("sweep_source")),
        sweep_destination=_nonempty_str(opts.get("sweep_destination")),
    )


def _size_field_from_dict(raw: dict[str, Any]) -> SizeFieldData:
    node_coords = raw.get("node_coords")
    h_values = raw.get("h_values")
    return SizeFieldData(
        node_coords=np.asarray(node_coords, dtype=np.float64),
        h_values=np.asarray(h_values, dtype=np.float64),
    )


def _resolve_inline_topology_max_bytes(override: int | None) -> int:
    if override is not None:
        return int(override)
    raw = os.environ.get("FULLMAG_REMESH_INLINE_TOPOLOGY_MAX_BYTES")
    if raw is None or not raw.strip():
        return _DEFAULT_INLINE_TOPOLOGY_MAX_BYTES
    return int(raw)


def _resolve_topology_artifact_dir(explicit: str | Path | None) -> Path:
    if explicit is not None:
        return Path(explicit)
    raw_dir = os.environ.get("FULLMAG_REMESH_TOPOLOGY_ARTIFACT_DIR")
    if raw_dir and raw_dir.strip():
        return Path(raw_dir)
    cache_dir = os.environ.get("FULLMAG_FEM_MESH_CACHE_DIR")
    if cache_dir and cache_dir.strip():
        return Path(cache_dir) / "remesh_topology"
    return Path(tempfile.gettempdir()) / "fullmag-remesh-topology"


def _resolve_quality_artifact_dir(explicit: str | Path | None) -> Path:
    if explicit is not None:
        return Path(explicit)
    raw_dir = os.environ.get("FULLMAG_REMESH_QUALITY_ARTIFACT_DIR")
    if raw_dir and raw_dir.strip():
        return Path(raw_dir)
    cache_dir = os.environ.get("FULLMAG_FEM_MESH_CACHE_DIR")
    if cache_dir and cache_dir.strip():
        return Path(cache_dir) / "remesh_quality"
    return Path(tempfile.gettempdir()) / "fullmag-remesh-quality"


def _topology_byte_count(mesh_data: Any) -> int:
    return int(
        mesh_data.nodes.nbytes
        + mesh_data.elements.nbytes
        + mesh_data.element_markers.nbytes
        + mesh_data.boundary_faces.nbytes
        + mesh_data.boundary_markers.nbytes
    )


def _safe_artifact_prefix(mesh_name: str) -> str:
    safe = "".join(
        char if char.isalnum() or char in {"-", "_"} else "_"
        for char in mesh_name
    ).strip("_")
    return (safe or "mesh")[:64]


def _write_topology_artifact_if_needed(
    mesh_data: Any,
    *,
    mesh_name: str,
    topology_artifact_dir: str | Path | None,
    inline_topology_max_bytes: int | None,
) -> dict[str, Any] | None:
    topology_bytes = _topology_byte_count(mesh_data)
    if topology_bytes <= _resolve_inline_topology_max_bytes(inline_topology_max_bytes):
        return None

    target_dir = _resolve_topology_artifact_dir(topology_artifact_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    handle, path = tempfile.mkstemp(
        prefix=f"{_safe_artifact_prefix(mesh_name)}-topology-",
        suffix=".json",
        dir=target_dir,
        text=True,
    )
    artifact_path = Path(path)
    payload = {
        "schema_version": 1,
        "mesh_name": mesh_name,
        "nodes": mesh_data.nodes.tolist(),
        "elements": mesh_data.elements.tolist(),
        "element_markers": mesh_data.element_markers.tolist(),
        "boundary_faces": mesh_data.boundary_faces.tolist(),
        "boundary_markers": mesh_data.boundary_markers.tolist(),
        "periodic_boundary_pairs": list(mesh_data.periodic_boundary_pairs),
        "periodic_node_pairs": list(mesh_data.periodic_node_pairs),
    }
    with os.fdopen(handle, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, separators=(",", ":"))
        fp.flush()
        os.fsync(fp.fileno())

    return {
        "kind": "remesh_topology_json",
        "schema_version": 1,
        "path": str(artifact_path),
        "byte_size": artifact_path.stat().st_size,
        "topology_nbytes": topology_bytes,
    }


def _quality_array(values: list[float] | None, *, element_count: int, metric: str) -> np.ndarray | None:
    if values is None:
        return None
    array = np.asarray(values, dtype=np.float64)
    if array.shape != (element_count,):
        raise ValueError(
            f"per-element {metric} quality array length mismatch: "
            f"expected {element_count}, got {array.size}"
        )
    if not np.all(np.isfinite(array)):
        raise ValueError(f"per-element {metric} quality array contains non-finite values")
    return array.astype("<f8", copy=False)


def _write_quality_data_artifact_if_available(
    mesh_data: Any,
    *,
    mesh_name: str,
    quality_artifact_dir: str | Path | None,
) -> dict[str, Any] | None:
    quality = getattr(mesh_data, "quality", None)
    if quality is None:
        return None

    element_count = int(quality.n_elements)
    arrays: list[tuple[str, int, np.ndarray]] = []
    sicn = _quality_array(quality.element_sicn, element_count=element_count, metric="sicn")
    gamma = _quality_array(quality.element_gamma, element_count=element_count, metric="gamma")
    volume = _quality_array(quality.element_volume, element_count=element_count, metric="volume")
    if sicn is not None:
        arrays.append(("sicn", _QUALITY_DATA_FLAG_SICN, sicn))
    if gamma is not None:
        arrays.append(("gamma", _QUALITY_DATA_FLAG_GAMMA, gamma))
    if volume is not None:
        arrays.append(("volume", _QUALITY_DATA_FLAG_VOLUME, volume))
    if not arrays:
        return None

    target_dir = _resolve_quality_artifact_dir(quality_artifact_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    handle, path = tempfile.mkstemp(
        prefix=f"{_safe_artifact_prefix(mesh_name)}-quality-",
        suffix=".fmmq",
        dir=target_dir,
    )
    artifact_path = Path(path)
    flags = 0
    for _metric, flag, _array in arrays:
        flags |= flag

    with os.fdopen(handle, "wb") as fp:
        fp.write(b"FMMQ")
        fp.write(bytes([_QUALITY_DATA_VERSION, _QUALITY_DATA_KIND_F64]))
        fp.write(struct.pack("<HIIQQ", 0, element_count, flags, 0, 0))
        for _metric, _flag, array in arrays:
            fp.write(array.tobytes(order="C"))
        fp.flush()
        os.fsync(fp.fileno())

    return {
        "kind": "fmmq.v1",
        "schema_version": 1,
        "path": str(artifact_path),
        "byte_size": artifact_path.stat().st_size,
        "element_count": element_count,
        "metrics": [metric for metric, _flag, _array in arrays],
    }


def _mesh_result_payload(
    mesh_data: Any,
    *,
    mesh_name: str,
    generation_mode: str,
    mesh_provenance: dict[str, Any],
    size_field_stats: dict[str, Any] | None = None,
    region_markers: list[dict[str, Any]] | None = None,
    topology_artifact_dir: str | Path | None = None,
    inline_topology_max_bytes: int | None = None,
) -> dict[str, Any]:
    mesh = mesh_data.oriented_copy()
    mesh.validate_strict(require_positive_orientation=True)
    mesh_statistics = _mesh_statistics_report_to_ir(
        _build_mesh_statistics_report(mesh, mesh_name)
    )
    topology_artifact = _write_topology_artifact_if_needed(
        mesh,
        mesh_name=mesh_name,
        topology_artifact_dir=topology_artifact_dir,
        inline_topology_max_bytes=inline_topology_max_bytes,
    )
    quality_data_artifact = _write_quality_data_artifact_if_available(
        mesh,
        mesh_name=mesh_name,
        quality_artifact_dir=topology_artifact_dir,
    )
    inline_topology = topology_artifact is None
    result: dict[str, Any] = {
        "mesh_name": mesh_name,
        "nodes": mesh.nodes.tolist() if inline_topology else [],
        "elements": mesh.elements.tolist() if inline_topology else [],
        "element_markers": mesh.element_markers.tolist() if inline_topology else [],
        "boundary_faces": mesh.boundary_faces.tolist() if inline_topology else [],
        "boundary_markers": mesh.boundary_markers.tolist() if inline_topology else [],
        "periodic_boundary_pairs": list(mesh.periodic_boundary_pairs) if inline_topology else [],
        "periodic_node_pairs": list(mesh.periodic_node_pairs) if inline_topology else [],
        "mesh_statistics": mesh_statistics,
        "generation_mode": generation_mode,
        "mesh_provenance": mesh_provenance,
    }

    if topology_artifact is not None:
        result["topology_artifact"] = topology_artifact

    if quality_data_artifact is not None:
        result["quality_data_artifact"] = quality_data_artifact

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
                "magnetic_submesh_signatures": (
                    shared_domain_report_payload["magnetic_submesh_signatures"]
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
