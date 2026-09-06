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

import hashlib
import json
import math
import os
import struct
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from fullmag._progress import emit_progress
from fullmag._validation import TypedValidationError, parse_bool, parse_finite_float, parse_integer
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
from fullmag.meshing.quality import (
    build_typed_quality_summary,
    validate_adjacent_size_growth,
)
from fullmag.meshing.fmmq import _canonical_json, build_fmmq_v2_spec, write_fmmq_v2
from fullmag.meshing._gmsh_types import (
    _MESH_SIZE_PRESET_DEFAULTS,
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
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise TypedValidationError(
                code="string_value_error",
                pointer="/mesh_options/string",
                message="value must be a non-empty string",
                value=type(value).__name__,
            )
        return value.strip()

    def _positive_float(value: Any, field: str) -> float | None:
        return parse_finite_float(
            value,
            f"/mesh_options/{field}",
            positive=True,
            allow_none=True,
            allow_numeric_string=True,
        )

    def _positive_int(value: Any, field: str) -> int | None:
        return parse_integer(
            value,
            f"/mesh_options/{field}",
            minimum=1,
            allow_none=True,
            allow_numeric_string=True,
        )

    def _non_negative_int(value: Any, field: str, default: int) -> int:
        parsed = parse_integer(
            default if value is None else value,
            f"/mesh_options/{field}",
            minimum=0,
            allow_numeric_string=True,
        )
        return int(parsed)

    def _int_list(value: Any, field: str) -> list[int] | None:
        if value is None:
            return None
        if not isinstance(value, list):
            raise TypeError(f"/mesh_options/{field} must be a list of integers")
        return [
            int(parse_integer(
                item,
                f"/mesh_options/{field}/{index}",
                minimum=1,
                allow_numeric_string=True,
            ))
            for index, item in enumerate(value)
        ]

    def _bool(value: Any, field: str, default: bool) -> bool:
        parsed = parse_bool(
            default if value is None else value,
            f"/mesh_options/{field}",
        )
        return bool(parsed)

    def _string_list(value: Any, field: str) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise TypeError(f"/mesh_options/{field} must be a list of strings")
        result: list[str] = []
        for index, item in enumerate(value):
            if not isinstance(item, str) or not item.strip():
                raise ValueError(f"/mesh_options/{field}/{index} must be a non-empty string")
            result.append(item.strip())
        return result

    algorithm_2d = parse_integer(
        opts.get("algorithm_2d", 6),
        "/mesh_options/algorithm_2d",
        minimum=1,
        allow_numeric_string=True,
    )
    algorithm_3d = parse_integer(
        opts.get("algorithm_3d", 1),
        "/mesh_options/algorithm_3d",
        minimum=1,
        allow_numeric_string=True,
    )
    size_from_curvature = _non_negative_int(
        opts.get("size_from_curvature"), "size_from_curvature", 0
    )
    narrow_regions = _non_negative_int(opts.get("narrow_regions"), "narrow_regions", 0)
    smoothing_steps = _non_negative_int(opts.get("smoothing_steps"), "smoothing_steps", 1)
    optimize_iters = _positive_int(opts.get("optimize_iterations", 1), "optimize_iters")

    return MeshOptions(
        algorithm_2d=int(algorithm_2d),
        algorithm_3d=int(algorithm_3d),
        hmin=_positive_float(opts.get("hmin"), "hmin"),
        calibrate_for=opts.get("calibrate_for"),
        size_preset=opts.get("size_preset"),
        size_factor=_positive_float(opts.get("size_factor", 1.0), "size_factor") or 1.0,
        size_from_curvature=size_from_curvature,
        curvature_factor=_positive_float(opts.get("curvature_factor"), "curvature_factor"),
        growth_rate=_positive_float(opts.get("growth_rate"), "growth_rate"),
        narrow_regions=narrow_regions,
        narrow_region_resolution=_positive_float(
            opts.get("narrow_region_resolution"), "narrow_region_resolution"
        ),
        smoothing_steps=smoothing_steps,
        optimize=opts.get("optimize"),
        optimize_iters=int(optimize_iters or 1),
        size_fields=opts.get("size_fields", []),
        compute_quality=_bool(opts.get("compute_quality"), "compute_quality", True),
        per_element_quality=_bool(
            opts.get("per_element_quality"), "per_element_quality", True
        ),
        boundary_layer_count=_positive_int(
            opts.get("boundary_layer_count"), "boundary_layer_count"
        ),
        boundary_layer_thickness=_positive_float(
            opts.get("boundary_layer_thickness"), "boundary_layer_thickness"
        ),
        boundary_layer_stretching=_positive_float(
            opts.get("boundary_layer_stretching"), "boundary_layer_stretching"
        ),
        boundary_layer_target_surface_tags=_int_list(
            opts.get("boundary_layer_target_surface_tags"),
            "boundary_layer_target_surface_tags",
        ),
        boundary_layer_target_curve_tags=_int_list(
            opts.get("boundary_layer_target_curve_tags"),
            "boundary_layer_target_curve_tags",
        ),
        mesh_strategy=_nonempty_str(opts.get("mesh_strategy")),
        through_thickness_elements=_positive_int(
            opts.get("through_thickness_elements"), "through_thickness_elements"
        ),
        through_thickness_distribution=_nonempty_str(
            opts.get("through_thickness_distribution")
        ),
        through_thickness_element_ratio=_positive_float(
            opts.get("through_thickness_element_ratio"),
            "through_thickness_element_ratio",
        ),
        through_thickness_symmetric=_bool(
            opts.get("through_thickness_symmetric"),
            "through_thickness_symmetric",
            False,
        ),
        sweep_face_meshing=_nonempty_str(opts.get("sweep_face_meshing")),
        sweep_direction=_nonempty_str(opts.get("sweep_direction")),
        sweep_source=_nonempty_str(opts.get("sweep_source")),
        sweep_destination=_nonempty_str(opts.get("sweep_destination")),
        periodic_pair_ids=_string_list(opts.get("periodic_pair_ids"), "periodic_pair_ids"),
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
        + mesh_data.cell_types.nbytes
        + mesh_data.cell_offsets.nbytes
        + mesh_data.cell_nodes.nbytes
        + mesh_data.cell_global_ordinals.nbytes
        + mesh_data.cell_mesh_parts.nbytes
        + mesh_data.element_markers.nbytes
        + mesh_data.facet_types.nbytes
        + mesh_data.facet_roles.nbytes
        + mesh_data.facet_global_ordinals.nbytes
        + mesh_data.facet_offsets.nbytes
        + mesh_data.facet_nodes.nbytes
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
        prefix=f".{_safe_artifact_prefix(mesh_name)}-topology-",
        suffix=".json.tmp",
        dir=target_dir,
        text=True,
    )
    temporary_path = Path(path)
    # Keep the final name hidden until the complete JSON document has been
    # flushed and verified.  The random suffix supplied by ``mkstemp`` makes
    # concurrent remesh writers independent while ``os.replace`` provides the
    # reader-facing atomic publication point.
    artifact_stem = temporary_path.name.removeprefix(".").removesuffix(".json.tmp")
    artifact_path = target_dir / f"{artifact_stem}.json"
    payload = {
        "schema_version": 2,
        "mesh_name": mesh_name,
        "nodes": mesh_data.nodes.tolist(),
        "cell_types": mesh_data.cell_types.tolist(),
        "cell_offsets": mesh_data.cell_offsets.tolist(),
        "cell_nodes": mesh_data.cell_nodes.tolist(),
        "cell_global_ordinals": mesh_data.cell_global_ordinals.tolist(),
        "cell_mesh_parts": mesh_data.cell_mesh_parts.tolist(),
        "element_markers": mesh_data.element_markers.tolist(),
        "facet_types": mesh_data.facet_types.tolist(),
        "facet_roles": mesh_data.facet_roles.tolist(),
        "facet_global_ordinals": mesh_data.facet_global_ordinals.tolist(),
        "facet_offsets": mesh_data.facet_offsets.tolist(),
        "facet_nodes": mesh_data.facet_nodes.tolist(),
        "boundary_markers": mesh_data.boundary_markers.tolist(),
        "periodic_boundary_pairs": list(mesh_data.periodic_boundary_pairs),
        "periodic_node_pairs": list(mesh_data.periodic_node_pairs),
        "periodic_mesh_certificate": mesh_data.periodic_mesh_certificate,
        "mixed_layer_topology_certificate": (
            mesh_data.mixed_layer_topology_certificate.to_dict()
            if mesh_data.mixed_layer_topology_certificate is not None
            else None
        ),
    }
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as fp:
            json.dump(payload, fp, separators=(",", ":"))
            fp.flush()
            os.fsync(fp.fileno())
        if temporary_path.stat().st_size <= 0:
            raise IOError("topology artifact is empty before publication")
        os.replace(temporary_path, artifact_path)
    finally:
        temporary_path.unlink(missing_ok=True)

    return {
        "kind": "remesh_topology_json",
        "schema_version": 2,
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
    # Keep the temporary payload in a private directory and promote it with a
    # single replace.  Readers therefore observe either a complete generation
    # or the previous one; an interrupted writer cannot leave a partially
    # named ``.fmmq`` artifact in the publication directory.
    temporary_dir = Path(
        tempfile.mkdtemp(
            prefix=f".{_safe_artifact_prefix(mesh_name)}-quality-",
            dir=target_dir,
        )
    )
    temporary_path = temporary_dir / "payload.fmmq"
    artifact_path = target_dir / f"{temporary_dir.name[1:]}.fmmq"
    flags = 0
    for _metric, flag, _array in arrays:
        flags |= flag

    try:
        with temporary_path.open("wb") as fp:
            fp.write(b"FMMQ")
            fp.write(bytes([_QUALITY_DATA_VERSION, _QUALITY_DATA_KIND_F64]))
            fp.write(struct.pack("<HIIQQ", 0, element_count, flags, 0, 0))
            for _metric, _flag, array in arrays:
                fp.write(array.tobytes(order="C"))
            fp.flush()
            os.fsync(fp.fileno())
        expected_size = _QUALITY_DATA_HEADER_LEN + 8 * element_count * len(arrays)
        if temporary_path.stat().st_size != expected_size:
            raise IOError(
                "FMMQ quality payload size mismatch before publication: "
                f"expected {expected_size}, got {temporary_path.stat().st_size}"
            )
        os.replace(temporary_path, artifact_path)
    finally:
        temporary_path.unlink(missing_ok=True)
        temporary_dir.rmdir()

    return {
        "kind": "fmmq.v1",
        "schema_version": 1,
        "path": str(artifact_path),
        "byte_size": artifact_path.stat().st_size,
        "element_count": element_count,
        "metrics": [metric for metric, _flag, _array in arrays],
    }


def _fmmq_v2_identity(
    mesh: Any,
    *,
    mesh_name: str,
    mesh_provenance: dict[str, Any],
) -> dict[str, Any]:
    """Build explicit identity metadata for the typed FMMQ v2 carrier.

    Remesh jobs do not always receive a persisted scene/policy revision.  Such
    payloads are still structurally useful, but are marked ``unbound`` so a
    production verifier cannot confuse them with a sealed runtime artifact.
    """
    topology_fingerprint = mesh.topology_fingerprint_v3()
    options = mesh_provenance.get("mesh_options")
    options = options if isinstance(options, dict) else {}
    policy_fingerprint = mesh_provenance.get("policy_fingerprint") or options.get("policy_fingerprint")
    if not isinstance(policy_fingerprint, str) or not policy_fingerprint.strip():
        policy_bytes = json.dumps(
            options,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
        policy_fingerprint = f"unbound:sha256:{hashlib.sha256(policy_bytes).hexdigest()}"
    mesh_revision = mesh_provenance.get("mesh_revision") or mesh_provenance.get("source_scene_revision")
    if mesh_revision is None:
        mesh_revision = "unbound"
    artifact_id = mesh_provenance.get("artifact_id")
    if not isinstance(artifact_id, str) or not artifact_id.strip():
        artifact_id = f"sha256:{hashlib.sha256(f'{mesh_name}|{topology_fingerprint}|{policy_fingerprint}|{mesh_revision}'.encode()).hexdigest()}"
    identity_status = (
        "bound"
        if not str(policy_fingerprint).startswith("unbound:") and mesh_revision != "unbound"
        else "unbound"
    )
    return {
        "topology_fingerprint_version": "v3",
        "topology_fingerprint": topology_fingerprint,
        "policy_fingerprint": str(policy_fingerprint),
        "mesh_revision": mesh_revision,
        "artifact_id": artifact_id,
        "mesh_name": mesh_name,
        "certifier_build": {
            "name": "fullmag-python-reference",
            "version": "fmmq-v2",
        },
        "identity_status": identity_status,
        "sidecar_identity": {
            key: mesh_provenance[key]
            for key in (
                "source_scene_revision",
                "geometry_realization_revision",
                "generation_id",
                "source_snapshot_sha256",
            )
            if key in mesh_provenance
        },
    }


def _write_quality_data_artifact_v2_if_available(
    mesh_data: Any,
    *,
    mesh_name: str,
    mesh_provenance: dict[str, Any],
    quality_artifact_dir: str | Path | None,
    adjacent_growth_report: Any | None = None,
) -> dict[str, Any] | None:
    """Publish the typed FMMQ v2 carrier next to the legacy v1 artifact."""
    try:
        identity = _fmmq_v2_identity(
            mesh_data,
            mesh_name=mesh_name,
            mesh_provenance=mesh_provenance,
        )
        element_count, identity, metrics = build_fmmq_v2_spec(
            mesh_data,
            identity=identity,
            adjacent_growth_report=adjacent_growth_report,
        )
    except (TypeError, AttributeError):
        # A mesh without the typed topology interface cannot produce a v2
        # carrier.  Validation/identity failures are deliberately propagated
        # so a malformed quality artifact cannot be silently downgraded to
        # the legacy v1 path.
        return None
    target_dir = _resolve_quality_artifact_dir(quality_artifact_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    # A fixed ``mesh_name`` path lets two concurrent remesh jobs replace each
    # other's carrier even though the writer itself publishes atomically.  Use
    # the complete canonical identity as the filename key so distinct
    # topology/policy/revision combinations have independent publication
    # points while repeated publication of the same identity remains
    # deterministic and idempotent.
    identity_token = hashlib.sha256(_canonical_json(identity)).hexdigest()
    target = target_dir / (
        f"{_safe_artifact_prefix(mesh_name)}-quality-v2-{identity_token}.fmmq"
    )
    return write_fmmq_v2(
        target,
        element_count=element_count,
        identity=identity,
        metrics=metrics,
    )


def _mesh_result_payload(
    mesh_data: Any,
    *,
    mesh_name: str,
    generation_mode: str,
    mesh_provenance: dict[str, Any],
    size_field_stats: dict[str, Any] | None = None,
    region_markers: list[dict[str, Any]] | None = None,
    object_region_markers: list[dict[str, Any]] | None = None,
    topology_artifact_dir: str | Path | None = None,
    inline_topology_max_bytes: int | None = None,
) -> dict[str, Any]:
    mesh = mesh_data.oriented_copy()
    mesh.validate_strict(require_positive_orientation=True)
    tet4_only = bool(np.all(mesh.cell_types == "tet4") and np.all(mesh.facet_types == "tri3"))
    mesh_statistics = (
        _mesh_statistics_report_to_ir(_build_mesh_statistics_report(mesh, mesh_name))
        if tet4_only
        else None
    )
    def _extract_growth_rate_from_dict(
        d: dict[str, Any],
        pointer_prefix: str,
    ) -> tuple[float | None, str | None]:
        g = d.get("growth_rate")
        mg = d.get("maximum_element_growth_rate")
        if g is not None and mg is not None:
            g_f = float(parse_finite_float(g, f"{pointer_prefix}/growth_rate", positive=True, allow_numeric_string=True))
            mg_f = float(parse_finite_float(mg, f"{pointer_prefix}/maximum_element_growth_rate", positive=True, allow_numeric_string=True))
            if not math.isclose(g_f, mg_f, rel_tol=1e-7, abs_tol=1e-9):
                raise TypedValidationError(
                    code="conflicting_growth_rate_alias",
                    pointer=f"{pointer_prefix}/maximum_element_growth_rate",
                    message=f"Conflicting growth_rate ({g}) and maximum_element_growth_rate ({mg})",
                )
            return g_f, f"{pointer_prefix}/growth_rate"
        if g is not None:
            g_f = float(parse_finite_float(g, f"{pointer_prefix}/growth_rate", positive=True, allow_numeric_string=True))
            return g_f, f"{pointer_prefix}/growth_rate"
        if mg is not None:
            mg_f = float(parse_finite_float(mg, f"{pointer_prefix}/maximum_element_growth_rate", positive=True, allow_numeric_string=True))
            return mg_f, f"{pointer_prefix}/maximum_element_growth_rate"
        preset = d.get("size_preset")
        if isinstance(preset, str) and preset.strip() in _MESH_SIZE_PRESET_DEFAULTS:
            return float(_MESH_SIZE_PRESET_DEFAULTS[preset.strip()]["growth_rate"]), f"{pointer_prefix}/size_preset"
        return None, None

    raw_mesh_options = mesh_provenance.get("mesh_options")
    options_growth = None
    options_pointer = None
    if isinstance(raw_mesh_options, dict):
        options_growth, options_pointer = _extract_growth_rate_from_dict(
            raw_mesh_options, "/mesh_provenance/mesh_options"
        )
    root_growth, root_pointer = _extract_growth_rate_from_dict(
        mesh_provenance, "/mesh_provenance"
    )

    if options_growth is not None and root_growth is not None:
        if not math.isclose(options_growth, root_growth, rel_tol=1e-7, abs_tol=1e-9):
            raise TypedValidationError(
                code="conflicting_growth_rate_specification",
                pointer="/mesh_provenance/growth_rate",
                message=f"Conflicting growth_rate in mesh_options ({options_growth}) and mesh_provenance ({root_growth})",
            )

    resolved_growth = options_growth if options_growth is not None else root_growth

    from fullmag.meshing._mesh_targets import _geometry_name_aliases

    name_to_marker: dict[str, int] = {}
    for rm_list in (region_markers, object_region_markers):
        if isinstance(rm_list, (list, tuple)):
            for entry in rm_list:
                if isinstance(entry, dict):
                    name = entry.get("geometry_name") or entry.get("geometry") or entry.get("name")
                    marker = entry.get("marker") or entry.get("material_marker")
                    if name is not None and marker is not None:
                        try:
                            m_int = int(marker)
                            for alias in _geometry_name_aliases(str(name)):
                                if alias in name_to_marker and name_to_marker[alias] != m_int:
                                    raise ValueError(
                                        f"Conflicting region marker alias mapping for '{alias}': "
                                        f"{name_to_marker[alias]} vs {m_int}"
                                    )
                                name_to_marker[alias] = m_int
                        except (ValueError, TypeError):
                            raise

    scope_growth_rates: dict[str, float] = {}

    def _record_scope(name: str, rate: float) -> None:
        key = str(name)
        scope_growth_rates[key] = rate
        matched = False
        for alias in _geometry_name_aliases(key):
            scope_growth_rates[alias] = rate
            if alias in name_to_marker:
                m_int = name_to_marker[alias]
                scope_growth_rates[str(m_int)] = rate
                scope_growth_rates[f"marker:{m_int}"] = rate
                matched = True
        if key == "air":
            scope_growth_rates["0"] = rate
            scope_growth_rates["marker:0"] = rate
            matched = True
        elif hasattr(mesh, "cell_mesh_parts") and key in set(mesh.cell_mesh_parts):
            matched = True
        if name_to_marker and not matched:
            raise ValueError(
                f"unmapped_growth_scope: scope '{name}' cannot be matched to any "
                f"known region marker, geometry alias, or cell role"
            )

    per_geom = mesh_provenance.get("per_geometry")
    if not per_geom and isinstance(raw_mesh_options, dict):
        per_geom = raw_mesh_options.get("per_geometry")
    if not per_geom and isinstance(mesh_provenance.get("shared_domain_build_report"), dict):
        per_geom = mesh_provenance["shared_domain_build_report"].get("per_geometry")
    if isinstance(per_geom, list):
        for idx, entry in enumerate(per_geom):
            if isinstance(entry, dict):
                r_val, _ = _extract_growth_rate_from_dict(entry, f"/mesh_provenance/per_geometry/{idx}")
                name = entry.get("geometry") or entry.get("geometry_name")
                if r_val is not None and name:
                    _record_scope(str(name), r_val)

    recipes = mesh_provenance.get("per_object_recipes") or mesh_provenance.get("recipes")
    if isinstance(recipes, dict):
        for r_name, r_entry in recipes.items():
            if isinstance(r_entry, dict):
                r_val, _ = _extract_growth_rate_from_dict(r_entry, f"/mesh_provenance/recipes/{r_name}")
                if r_val is not None:
                    _record_scope(str(r_name), r_val)

    eff_targets = mesh_provenance.get("effective_per_object_targets")
    if not eff_targets and isinstance(mesh_provenance.get("shared_domain_build_report"), dict):
        eff_targets = mesh_provenance["shared_domain_build_report"].get("effective_per_object_targets")
    if isinstance(eff_targets, dict):
        for t_name, t_entry in eff_targets.items():
            if isinstance(t_entry, dict):
                r_val, _ = _extract_growth_rate_from_dict(t_entry, f"/mesh_provenance/effective_per_object_targets/{t_name}")
                if r_val is not None:
                    _record_scope(str(t_name), r_val)

    airbox_entry = mesh_provenance.get("airbox")
    if airbox_entry is None and isinstance(raw_mesh_options, dict):
        airbox_entry = raw_mesh_options.get("airbox")
    if airbox_entry is None:
        airbox_entry = mesh_provenance.get("effective_airbox_target")
    if airbox_entry is None and isinstance(mesh_provenance.get("shared_domain_build_report"), dict):
        airbox_entry = mesh_provenance["shared_domain_build_report"].get("effective_airbox_target")
    if isinstance(airbox_entry, dict):
        a_val, _ = _extract_growth_rate_from_dict(airbox_entry, "/mesh_provenance/airbox")
        if a_val is not None:
            _record_scope("air", a_val)

    if resolved_growth is None and scope_growth_rates:
        unique_rates = set(scope_growth_rates.values())
        if len(unique_rates) == 1:
            resolved_growth = next(iter(unique_rates))

    growth_report = None
    if resolved_growth is not None or scope_growth_rates:
        growth_report = validate_adjacent_size_growth(
            mesh,
            resolved_growth_rate=resolved_growth,
            scope_growth_rates=scope_growth_rates or None,
            tolerance=0.0,
            require_pairs=len(mesh.cell_types) > 1,
        )
    # Do not publish topology or quality artifacts until every declared
    # post-mesh gate has passed.  In particular, an invalid growth report must
    # leave no partial artifact that downstream readers could mistake for a
    # valid mesh result.
    typed_quality_summary = build_typed_quality_summary(mesh).to_dict()
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
    quality_data_artifact_v2 = _write_quality_data_artifact_v2_if_available(
        mesh,
        mesh_name=mesh_name,
        mesh_provenance=mesh_provenance,
        quality_artifact_dir=topology_artifact_dir,
        adjacent_growth_report=growth_report,
    )
    inline_topology = topology_artifact is None
    result: dict[str, Any] = {
        "mesh_name": mesh_name,
        "nodes": mesh.nodes.tolist() if inline_topology else [],
        "cell_types": mesh.cell_types.tolist() if inline_topology else [],
        "cell_offsets": mesh.cell_offsets.tolist() if inline_topology else [0],
        "cell_nodes": mesh.cell_nodes.tolist() if inline_topology else [],
        "cell_global_ordinals": mesh.cell_global_ordinals.tolist() if inline_topology else [],
        "cell_mesh_parts": mesh.cell_mesh_parts.tolist() if inline_topology else [],
        "element_markers": mesh.element_markers.tolist() if inline_topology else [],
        "facet_types": mesh.facet_types.tolist() if inline_topology else [],
        "facet_roles": mesh.facet_roles.tolist() if inline_topology else [],
        "facet_global_ordinals": mesh.facet_global_ordinals.tolist() if inline_topology else [],
        "facet_offsets": mesh.facet_offsets.tolist() if inline_topology else [0],
        "facet_nodes": mesh.facet_nodes.tolist() if inline_topology else [],
        "boundary_markers": mesh.boundary_markers.tolist() if inline_topology else [],
        "periodic_boundary_pairs": list(mesh.periodic_boundary_pairs) if inline_topology else [],
        "periodic_node_pairs": list(mesh.periodic_node_pairs) if inline_topology else [],
        "periodic_mesh_certificate": mesh.periodic_mesh_certificate,
        "mixed_layer_topology_certificate": (
            mesh.mixed_layer_topology_certificate.to_dict()
            if inline_topology and mesh.mixed_layer_topology_certificate is not None
            else None
        ),
        "generation_mode": generation_mode,
        "mesh_provenance": mesh_provenance,
    }

    if mesh_statistics is not None:
        result["mesh_statistics"] = mesh_statistics

    result["typed_quality_summary"] = typed_quality_summary

    if topology_artifact is not None:
        result["topology_artifact"] = topology_artifact

    if quality_data_artifact is not None:
        result["quality_data_artifact"] = quality_data_artifact

    if quality_data_artifact_v2 is not None:
        result["quality_data_artifact_v2"] = quality_data_artifact_v2

    if size_field_stats is not None:
        result["size_field_stats"] = size_field_stats

    # ``Mesh.SmoothRatio`` is only a generator hint.  When a resolved growth
    # target is present, publish an independent post-mesh measurement so
    # callers can distinguish the requested value from the realized face-
    # neighbor ratios.  Invalid growth is rejected above before this payload
    # is published; a successful report is therefore a hard post-mesh gate.
    if growth_report is not None:
        result["adjacent_size_growth"] = growth_report.to_dict()

    if region_markers is not None:
        result["region_markers"] = region_markers

    if object_region_markers is not None:
        result["object_region_markers"] = object_region_markers

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
        object_regions = (
            config.get("object_regions")
            if isinstance(config.get("object_regions"), list)
            else None
        )
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
                        object_regions=object_regions,
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
            try:
                if hasattr(ctypes.cdll, "msvcrt"):
                    ctypes.cdll.msvcrt.fflush(None)
                else:
                    libc = ctypes.CDLL(None)
                    libc.fflush(None)
            except Exception:
                pass
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
            object_region_markers=(
                shared_domain_report.object_region_markers
                if shared_domain_report is not None
                else None
            ),
        )

        json.dump(result, sys.stdout, separators=(",", ":"))
        sys.stdout.flush()
    except Exception as exc:
        import traceback
        print(json.dumps({"error": str(exc), "traceback": traceback.format_exc()}), file=sys.stderr)
        sys.exit(1)
