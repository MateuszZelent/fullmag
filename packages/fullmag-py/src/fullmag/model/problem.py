from __future__ import annotations

import copy
import json
import os
import warnings
from dataclasses import dataclass, field, replace
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import Any, Mapping, Sequence

from fullmag._progress import (
    emit_progress,
    emit_progress_event,
    indeterminate_progress_phase,
)
from fullmag._validation import ensure_unique_names, require_non_empty
from fullmag.init.textures import PresetTexture
from fullmag.model.antenna import (
    AntennaFieldSource,
    DriveActivation,
    FieldTarget,
    GeometryMaskFieldProfile,
    RegionalFieldDrive,
    SincFieldProfile,
    SpinWaveExcitationAnalysis,
    UniformFieldProfile,
)
from fullmag.model.couplings import Coupling
from fullmag.model.constraints import FrozenSpins
from fullmag.model.current_transport import CurrentTransport
from fullmag.model.discretization import DiscretizationHints, FEM, PerObjectMeshRecipe
from fullmag.model.dynamics import LLG
from fullmag.model.domain_frame import build_domain_frame, geometry_bounds
from fullmag.model.energy import BulkDMI, CubicAnisotropy, Demag, Exchange, InterfacialDMI, Magnetoelastic, OerstedField, OerstedCylinder, PiecewiseLinear, StaticFieldMap, ThermalNoise, UniaxialAnisotropy, Zeeman
from fullmag.model.spin_torque import (
    LegacySpinTorque,
    PrescribedSpinOrbitTorque,
    SpinOrbitTorque,
    SpinTorqueModule,
)
from fullmag.model.spin_transport import DriftDiffusionSpinTorque, SpinDriftDiffusion
from fullmag.model.mechanics import (
    ElasticBody,
    ElasticMaterial,
    MagnetostrictionLaw,
    MechanicalBoundaryCondition,
    MechanicalLoad,
)
from fullmag.model.physics_scope import build_physics_graph
from fullmag.model.outputs import (
    SaveDispersion,
    SaveField,
    SaveMode,
    SaveScalar,
    SaveSpectrum,
    Snapshot,
)
from fullmag.model.planar_monitor import PlanarMonitor
from fullmag.model.structure import (
    Ferromagnet,
    Material,
    MaterialParameterAssignment,
    ObjectRegion,
    Region,
)
from fullmag.model.study import Eigenmodes, FrequencyResponse, Relaxation, TimeEvolution
from fullmag.model.selection import SelectionDefinition

IR_VERSION = "0.3.0"
API_VERSION = "0.3.0"
SERIALIZER_VERSION = "0.3.0"

_FDM_M2_OPERATOR_VERSION = "fdm_coupled_charge_spin_fv_block_gmres.v1"
_FEM_M2_OPERATOR_VERSION = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1"

# Keep the shared-domain cache namespace separate from the older per-object
# ``.npz`` cache.  The version is part of the digest, so changing the cache
# document or the generation contract cannot silently reuse an old artifact.
_FEM_MESH_CACHE_VERSION = "v6"
_FEM_SHARED_DOMAIN_CACHE_SCHEMA = "fullmag.fem.shared-domain-cache.v1"


@dataclass(frozen=True, slots=True)
class FdmPbc:
    axes: tuple[bool, bool, bool]
    demag: str = "open"
    image_counts: tuple[int, int, int] | None = None

    def __post_init__(self) -> None:
        axes = tuple(bool(value) for value in self.axes)
        if len(axes) != 3:
            raise ValueError("FdmPbc.axes must contain exactly three booleans")
        object.__setattr__(self, "axes", axes)

        demag = self.demag.strip().lower()
        if demag not in {"open", "truncated_images", "periodic_airbox_k0"}:
            raise ValueError(
                "FdmPbc.demag must be 'open', 'truncated_images', or 'periodic_airbox_k0'"
            )
        object.__setattr__(self, "demag", demag)

        if demag != "truncated_images" and self.image_counts is not None:
            raise ValueError("FdmPbc.image_counts require demag='truncated_images'")

        if self.image_counts is not None:
            counts = tuple(int(value) for value in self.image_counts)
            if len(counts) != 3:
                raise ValueError("FdmPbc.image_counts must contain exactly three integers")
            if any(value < 0 for value in counts):
                raise ValueError("FdmPbc.image_counts must be non-negative")
            object.__setattr__(self, "image_counts", counts)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "axes": ["periodic" if enabled else "open" for enabled in self.axes],
            "demag": self.demag,
        }
        if self.image_counts is not None:
            payload["image_counts"] = list(self.image_counts)
        return payload


def _pbc_to_ir(pbc: FdmPbc | tuple[bool, bool, bool] | None) -> dict[str, object] | None:
    if pbc is None:
        return None
    if isinstance(pbc, FdmPbc):
        return pbc.to_ir()
    return FdmPbc(tuple(bool(value) for value in pbc)).to_ir()


def _fdm_cell_centers_from_asset(asset: dict[str, Any]) -> list[list[float]]:
    cells = [int(value) for value in asset.get("cells", [0, 0, 0])]
    cell_size = [float(value) for value in asset.get("cell_size", [0.0, 0.0, 0.0])]
    origin = [float(value) for value in asset.get("origin", [0.0, 0.0, 0.0])]
    points: list[list[float]] = []
    for kz in range(cells[2]):
        z = origin[2] + (kz + 0.5) * cell_size[2]
        for ky in range(cells[1]):
            y = origin[1] + (ky + 0.5) * cell_size[1]
            for kx in range(cells[0]):
                x = origin[0] + (kx + 0.5) * cell_size[0]
                points.append([x, y, z])
    return points


def _node_mask_for_region_marker(mesh_ir: dict[str, Any], marker: int) -> list[bool]:
    nodes = mesh_ir.get("nodes") or []
    elements = mesh_ir.get("elements") or []
    element_markers = mesh_ir.get("element_markers") or []
    active = [False] * len(nodes)
    for element, element_marker in zip(elements, element_markers, strict=False):
        if int(element_marker) != marker:
            continue
        for node_index in element:
            index = int(node_index)
            if 0 <= index < len(active):
                active[index] = True
    return active


def _object_transform_for_magnet_geometry(geometry: object) -> dict[str, object]:
    from fullmag.model.geometry import Translate

    translation = [0.0, 0.0, 0.0]
    cursor = geometry
    while isinstance(cursor, Translate):
        offset = cursor.offset
        translation[0] += float(offset[0])
        translation[1] += float(offset[1])
        translation[2] += float(offset[2])
        cursor = cursor.geometry

    bounds_min, bounds_max = geometry_bounds(geometry)
    transform: dict[str, object] = {
        "translation": translation,
        "rotation_quat": [0.0, 0.0, 0.0, 1.0],
        "scale": [1.0, 1.0, 1.0],
        "pivot": [0.0, 0.0, 0.0],
    }
    if bounds_min is not None and bounds_max is not None:
        transform["object_bounds_min"] = [float(value) for value in bounds_min]
        transform["object_bounds_max"] = [float(value) for value in bounds_max]
    return transform


def _materialize_preset_texture_initial_conditions(
    magnets_ir: list[dict[str, Any]],
    magnets: Sequence["Ferromagnet"],
    geometry_assets: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not geometry_assets:
        return magnets_ir

    from fullmag.runtime.initial_state import prepare_initial_magnetization

    fdm_assets = {
        str(asset.get("geometry_name")): dict(asset)
        for asset in (geometry_assets.get("fdm_grid_assets") or [])
    }
    fem_assets = {
        str(asset.get("geometry_name")): dict(asset)
        for asset in (geometry_assets.get("fem_mesh_assets") or [])
    }
    domain_asset = geometry_assets.get("fem_domain_mesh_asset")
    domain_mesh_ir = (
        dict(domain_asset.get("mesh"))
        if isinstance(domain_asset, dict) and isinstance(domain_asset.get("mesh"), dict)
        else None
    )
    region_markers = {
        str(entry.get("geometry_name")): int(entry.get("marker"))
        for entry in ((domain_asset or {}).get("region_markers") or [])
        if isinstance(entry, dict)
        and isinstance(entry.get("geometry_name"), str)
        and isinstance(entry.get("marker"), int)
    }

    materialized = copy.deepcopy(magnets_ir)
    for magnet_ir, magnet in zip(materialized, magnets, strict=True):
        initial = magnet_ir.get("initial_magnetization")
        if not isinstance(initial, dict) or initial.get("kind") != "preset_texture":
            continue
        if initial.get("preset_kind") == "uniform":
            params = initial.get("preset_params")
            direction = params.get("direction") if isinstance(params, dict) else None
            if isinstance(direction, list) and len(direction) == 3:
                from fullmag.init.preset_eval import evaluate_preset_texture

                value = evaluate_preset_texture(
                    "uniform", {"direction": direction}, [(0.0, 0.0, 0.0)]
                ).values[0]
                magnet_ir["initial_magnetization"] = {
                    "kind": "uniform",
                    "value": [float(component) for component in value],
                }
                continue
        object_transform = _object_transform_for_magnet_geometry(magnet.geometry)

        geometry_name = magnet.geometry.geometry_name
        sampled_values: list[list[float]] | None = None

        if domain_asset is not None and (
            geometry_name in region_markers or magnet.name in region_markers
        ):
            # Shared-domain FEM meshes are reordered by the Rust planner before
            # execution. Keep analytic preset_texture descriptors intact so they
            # are sampled on the final node ordering instead of pre-sampling a
            # fragile full-domain array here.
            continue
        elif geometry_name in fdm_assets:
            asset = fdm_assets[geometry_name]
            sample_points = _fdm_cell_centers_from_asset(asset)
            sampled = prepare_initial_magnetization(
                initial,
                sample_points,
                object_transform=object_transform,
            )
            active_mask = asset.get("active_mask")
            if isinstance(active_mask, list) and len(active_mask) == len(sampled):
                sampled_values = [
                    vector.tolist() if bool(active_mask[index]) else [0.0, 0.0, 0.0]
                    for index, vector in enumerate(sampled)
                ]
            else:
                sampled_values = sampled.tolist()
        elif geometry_name in fem_assets:
            mesh_wrapper = fem_assets[geometry_name]
            mesh_ir = mesh_wrapper.get("mesh") if isinstance(mesh_wrapper.get("mesh"), dict) else None
            if mesh_ir is not None:
                sampled = prepare_initial_magnetization(
                    initial,
                    mesh_ir.get("nodes") or [],
                    object_transform=object_transform,
                )
                sampled_values = sampled.tolist()
        if sampled_values is None:
            raise ValueError(
                f"magnet '{magnet.name}' uses preset_texture but no executable mesh/grid assets were available for pre-sampling"
            )

        magnet_ir["initial_magnetization"] = {
            "kind": "sampled_field",
            "values": sampled_values,
        }

    return materialized


def _fem_mesh_cache_dir() -> Path | None:
    raw = os.environ.get("FULLMAG_FEM_MESH_CACHE_DIR")
    if raw is not None and not raw.strip():
        return None
    if raw:
        path = Path(raw).expanduser()
    else:
        path = Path.cwd() / ".fullmag" / "local" / "cache" / "fem_meshes"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _geometry_cache_fingerprint(geometry: object) -> dict[str, object]:
    from fullmag.model.geometry import ImportedGeometry

    fingerprint: dict[str, object] = {
        "geometry": geometry.to_ir(),
    }
    if isinstance(geometry, ImportedGeometry):
        source_path = Path(geometry.source)
        fingerprint["source_path"] = str(source_path)
        if source_path.exists():
            stat = source_path.stat()
            fingerprint["source_stat"] = {
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
            }
    return fingerprint


def _fem_mesh_cache_key(
    geometry: object,
    hints: FEM,
    *,
    study_universe: dict[str, object] | None = None,
    mesh_workflow: dict[str, object] | None = None,
    per_object_recipes: Mapping[str, PerObjectMeshRecipe] | None = None,
) -> str:
    payload = {
        "version": _FEM_MESH_CACHE_VERSION,
        "geometry": _geometry_cache_fingerprint(geometry),
        "fem": hints.to_ir(),
        "study_universe": study_universe,
        "mesh_workflow": mesh_workflow,
        "per_object_recipes": {
            str(name): recipe.to_ir()
            for name, recipe in (per_object_recipes or {}).items()
        },
    }
    return sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


def _fem_shared_domain_cache_document(
    geometries: Sequence[object],
    hints: FEM,
    *,
    study_universe: dict[str, object] | None,
    mesh_workflow: dict[str, object] | None,
    per_object_recipes: Mapping[str, PerObjectMeshRecipe] | None,
    object_regions: Sequence[dict[str, object]] | None,
) -> tuple[str, dict[str, object]]:
    """Return the persistent identity for a generated shared FEM domain.

    The cache is deliberately keyed from the resolved source geometry
    fingerprints (including imported-file stat data), not only from object
    names.  This keeps a stale cache from surviving an STL/STEP replacement
    while avoiding a repository-wide source scan on every run.
    """
    document: dict[str, object] = {
        "schema": _FEM_SHARED_DOMAIN_CACHE_SCHEMA,
        "version": _FEM_MESH_CACHE_VERSION,
        "geometries": [
            _geometry_cache_fingerprint(geometry) for geometry in geometries
        ],
        "fem": hints.to_ir(),
        "study_universe": study_universe,
        "mesh_workflow": mesh_workflow,
        "per_object_recipes": {
            str(name): recipe.to_ir()
            for name, recipe in (per_object_recipes or {}).items()
        },
        "object_regions": [dict(region) for region in (object_regions or [])],
    }
    encoded = json.dumps(
        document,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return sha256(encoded).hexdigest(), document


def _mesh_boundary_semantic_map(mesh: object) -> dict[str, int]:
    """Build a stable boundary map without importing the world module.

    Cache persistence only needs semantic marker coverage.  Preserve a role in
    the name where the typed mesh exposes one, and fall back to a marker-only
    name for legacy meshes.
    """
    raw_markers = getattr(mesh, "boundary_markers", None)
    if raw_markers is None:
        return {}
    markers = [int(value) for value in raw_markers.tolist()]
    raw_roles = getattr(mesh, "facet_roles", None)
    roles = [str(value) for value in raw_roles.tolist()] if raw_roles is not None else []
    result: dict[str, int] = {}
    for marker in sorted(set(markers)):
        marker_roles = sorted(
            {
                roles[index]
                for index, value in enumerate(markers)
                if value == marker and index < len(roles)
            }
        )
        role = marker_roles[0] if len(marker_roles) == 1 else "boundary"
        result[f"{role}_{marker}"] = marker
    return result


def resolve_geometry_sources(
    geometry: object,
    *,
    source_root: str | Path | None,
) -> object:
    if source_root is None:
        return geometry

    from fullmag.model.geometry import (
        Difference,
        ImportedGeometry,
        Intersection,
        Translate,
        Union,
    )

    root = Path(source_root)

    if isinstance(geometry, ImportedGeometry):
        source_path = Path(geometry.source)
        if source_path.is_absolute():
            return geometry
        return ImportedGeometry(
            source=str((root / source_path).resolve()),
            scale=geometry.scale,
            name=geometry.name,
            volume=geometry.volume,
        )
    if isinstance(geometry, Difference):
        return Difference(
            base=resolve_geometry_sources(geometry.base, source_root=source_root),
            tool=resolve_geometry_sources(geometry.tool, source_root=source_root),
            name=geometry.name,
        )
    if isinstance(geometry, Intersection):
        return Intersection(
            a=resolve_geometry_sources(geometry.a, source_root=source_root),
            b=resolve_geometry_sources(geometry.b, source_root=source_root),
            name=geometry.name,
        )
    if isinstance(geometry, Union):
        return Union(
            a=resolve_geometry_sources(geometry.a, source_root=source_root),
            b=resolve_geometry_sources(geometry.b, source_root=source_root),
            name=geometry.name,
        )
    if isinstance(geometry, Translate):
        return Translate(
            geometry=resolve_geometry_sources(geometry.geometry, source_root=source_root),
            offset=geometry.offset,
            name=geometry.name,
        )
    return geometry


def build_geometry_assets_for_request(
    *,
    requested_backend: "BackendTarget",
    geometries: Sequence[object],
    discretization: DiscretizationHints | None,
    study_universe: dict[str, object] | None = None,
    mesh_workflow: dict[str, object] | None = None,
    per_object_recipes: Mapping[str, PerObjectMeshRecipe] | None = None,
    object_regions: Sequence[dict[str, object]] | None = None,
    asset_cache: dict[str, dict[str, Any] | None] | None = None,
    _copy_cached_assets: bool = True,
    _realized_domain_mesh_sink: list[
        tuple[object, list[dict[str, object]], object | None]
    ] | None = None,
) -> dict[str, Any] | None:
    if discretization is None:
        return None

    fdm_only = requested_backend == BackendTarget.FDM or (
        requested_backend == BackendTarget.AUTO
        and discretization.fdm is not None
        and discretization.fem is None
    )
    asset_cache_key = _geometry_asset_cache_key(
        requested_backend=requested_backend,
        geometries=geometries,
        discretization=discretization,
        study_universe=study_universe,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
        object_regions=object_regions,
        fdm_only=fdm_only,
    )
    if asset_cache is not None and asset_cache_key in asset_cache:
        cached = asset_cache[asset_cache_key]
        return copy.deepcopy(cached) if _copy_cached_assets else cached

    assets: dict[str, Any] = {
        "fdm_grid_assets": [],
        "fem_mesh_assets": [],
    }
    explicit_domain_mesh_source = None
    explicit_domain_region_markers = None
    explicit_domain_object_region_markers = None
    if isinstance(mesh_workflow, dict):
        source_value = mesh_workflow.get("domain_mesh_source")
        region_markers_value = mesh_workflow.get("domain_region_markers")
        object_region_markers_value = mesh_workflow.get("domain_object_region_markers")
        if isinstance(source_value, str) and source_value.strip():
            explicit_domain_mesh_source = source_value
            if not isinstance(region_markers_value, list) or not region_markers_value:
                raise ValueError(
                    "explicit shared-domain mesh assets require a non-empty domain_region_markers payload"
                )
            explicit_domain_region_markers = []
            for entry in region_markers_value:
                if not isinstance(entry, dict):
                    raise ValueError(
                        "domain_region_markers entries must be mappings with geometry_name and marker"
                    )
                geometry_name = entry.get("geometry_name")
                marker = entry.get("marker")
                if not isinstance(geometry_name, str) or not geometry_name.strip():
                    raise ValueError("domain_region_markers geometry_name must be a non-empty string")
                if not isinstance(marker, int) or marker <= 0:
                    raise ValueError("domain_region_markers marker must be a positive int")
                explicit_domain_region_markers.append(
                    {"geometry_name": geometry_name, "marker": marker}
                )
            if object_region_markers_value is not None:
                if not isinstance(object_region_markers_value, list):
                    raise ValueError(
                        "domain_object_region_markers entries must be mappings with geometry_name and marker"
                    )
                explicit_domain_object_region_markers = []
                seen_object_region_markers: set[int] = set()
                seen_object_region_geometries: set[str] = set()
                for entry in object_region_markers_value:
                    if not isinstance(entry, dict):
                        raise ValueError(
                            "domain_object_region_markers entries must be mappings with geometry_name and marker"
                        )
                    geometry_name = entry.get("geometry_name")
                    marker = entry.get("marker")
                    if not isinstance(geometry_name, str) or not geometry_name.strip():
                        raise ValueError(
                            "domain_object_region_markers geometry_name must be a non-empty string"
                        )
                    if not isinstance(marker, int) or marker <= 0:
                        raise ValueError("domain_object_region_markers marker must be a positive int")
                    if geometry_name in seen_object_region_geometries:
                        raise ValueError(
                            f"domain_object_region_markers duplicates geometry_name {geometry_name!r}"
                        )
                    if marker in seen_object_region_markers:
                        raise ValueError(
                            f"domain_object_region_markers duplicates marker {marker}"
                        )
                    seen_object_region_geometries.add(geometry_name)
                    seen_object_region_markers.add(marker)
                    explicit_domain_object_region_markers.append(
                        {"geometry_name": geometry_name, "marker": marker}
                    )

    if discretization.fdm is not None:
        from fullmag.model.geometry import Cylinder, ImportedGeometry
        from fullmag.meshing import realize_fdm_grid_asset

        for geometry in geometries:
            should_realize = isinstance(geometry, (Cylinder, ImportedGeometry)) or study_universe is not None
            if should_realize:
                asset = realize_fdm_grid_asset(
                    geometry,
                    discretization.fdm,
                    study_universe=study_universe,
                )
                assets["fdm_grid_assets"].append(asset.to_ir(geometry.geometry_name))

    should_build_fem_assets = (
        requested_backend == BackendTarget.FEM
        or (
            requested_backend == BackendTarget.AUTO
            and discretization.fem is not None
            and discretization.fem.mesh is not None
        )
    )

    if should_build_fem_assets and discretization.fem is not None:
        from fullmag._core import validate_mesh_ir
        from fullmag.model.geometry import ImportedGeometry
        from fullmag.meshing import (
            realize_fem_mesh_asset,
        )
        from fullmag.meshing.asset_pipeline import (
            _drop_degenerate_tetrahedra,
            realize_fem_domain_mesh_asset_from_components_with_report,
        )
        from fullmag.meshing.gmsh_bridge import MeshData

        fem_mesh_cache_dir: Path | None = None
        has_shared_domain_mesh_asset = (
            explicit_domain_mesh_source is not None or study_universe is not None
        )

        if not has_shared_domain_mesh_asset:
            for geometry in geometries:
                imported_surface_only = (
                    discretization.fem.mesh is None
                    and isinstance(geometry, ImportedGeometry)
                    and geometry.volume == "surface"
                )
                mesh_source = discretization.fem.mesh
                if mesh_source is None and isinstance(geometry, ImportedGeometry):
                    mesh_source = geometry.source
                if mesh_source is not None and mesh_source.lower().endswith(".json"):
                    emit_progress(
                        f"Preparing FEM mesh asset for '{geometry.geometry_name}' from MeshIR JSON"
                    )
                    mesh_path = Path(mesh_source).expanduser()
                    with mesh_path.open("r", encoding="utf-8") as handle:
                        mesh_ir = json.load(handle)
                    is_valid = validate_mesh_ir(mesh_ir)
                    if is_valid is False:
                        raise ValueError(
                            f"MeshIR asset for '{geometry.geometry_name}' failed Rust validation"
                        )
                    assets["fem_mesh_assets"].append(
                        {
                            "geometry_name": geometry.geometry_name,
                            "mesh_source": mesh_source,
                            "mesh": mesh_ir,
                        }
                    )
                else:
                    if fem_mesh_cache_dir is None:
                        fem_mesh_cache_dir = _fem_mesh_cache_dir()
                    mesh_cache_key = _fem_mesh_cache_key(
                        geometry,
                        discretization.fem,
                        study_universe=study_universe,
                        mesh_workflow=mesh_workflow,
                        per_object_recipes=per_object_recipes,
                    )
                    cache_path = (
                        fem_mesh_cache_dir.joinpath(f"{mesh_cache_key}.npz")
                        if fem_mesh_cache_dir is not None
                        else None
                    )
                    mesh: MeshData | None = None
                    if cache_path is not None and cache_path.exists():
                        emit_progress(
                            f"Reusing cached FEM mesh for '{geometry.geometry_name}'"
                        )
                        mesh = MeshData.load(cache_path)
                    else:
                        emit_progress(
                            f"Preparing FEM mesh asset for '{geometry.geometry_name}'"
                        )
                        mesh = realize_fem_mesh_asset(
                            geometry,
                            discretization.fem,
                            study_universe=study_universe,
                            mesh_workflow=mesh_workflow,
                            per_object_recipes=dict(per_object_recipes or {}),
                        )
                        mesh = _drop_degenerate_tetrahedra(
                            mesh,
                            context=f"Generated FEM mesh for '{geometry.geometry_name}'",
                            fallbacks_triggered=[],
                        )
                        if cache_path is not None and not imported_surface_only:
                            mesh.save(cache_path)
                            emit_progress(
                                f"Cached FEM mesh for '{geometry.geometry_name}'"
                            )
                    if imported_surface_only:
                        raise ValueError(
                            f"geometry '{geometry.geometry_name}' uses "
                            "ImportedGeometry(volume='surface'), which is preview-only. "
                            "The FEM solver requires tetrahedral volume elements. "
                            "Use volume='full' to build an executable FEM mesh."
                        )
                    emit_progress(
                        f"FEM mesh ready for '{geometry.geometry_name}': "
                        f"{mesh.n_nodes} nodes, {mesh.n_elements} elements, "
                        f"{mesh.n_boundary_faces} boundary faces"
                    )
                    mesh_ir = mesh.to_ir(geometry.geometry_name)
                    is_valid = validate_mesh_ir(mesh_ir)
                    if is_valid is False:
                        raise ValueError(
                            f"generated mesh asset for '{geometry.geometry_name}' failed Rust validation"
                        )
                    assets["fem_mesh_assets"].append(
                        {
                            "geometry_name": geometry.geometry_name,
                            "mesh_source": None,
                            "mesh": mesh_ir,
                        }
                    )

        if explicit_domain_mesh_source is not None:
            source_suffix = Path(explicit_domain_mesh_source).suffix.lower()
            if source_suffix in {".fullmag-mesh", ".msh", ".mphtxt"}:
                from fullmag.meshing.persistence import (
                    import_comsol_mesh,
                    import_gmsh_mesh,
                    load_mesh_artifact,
                )

                if source_suffix == ".fullmag-mesh":
                    artifact = load_mesh_artifact(explicit_domain_mesh_source)
                elif source_suffix == ".mphtxt":
                    artifact = import_comsol_mesh(explicit_domain_mesh_source)
                else:
                    artifact = import_gmsh_mesh(explicit_domain_mesh_source)
                if artifact.region_markers != explicit_domain_region_markers:
                    raise ValueError(
                        "explicit shared-domain mesh region markers do not match the persisted artifact"
                    )
                if (
                    explicit_domain_object_region_markers is not None
                    and artifact.object_region_markers
                    != explicit_domain_object_region_markers
                ):
                    raise ValueError(
                        "explicit shared-domain object-region markers do not match the persisted artifact"
                    )
                persisted_domain_asset = {
                    "mesh_source": explicit_domain_mesh_source,
                    "mesh": artifact.mesh.to_ir(artifact.mesh_name),
                    "region_markers": artifact.region_markers,
                    "object_region_markers": artifact.object_region_markers,
                }
                if artifact.build_report is not None:
                    persisted_domain_asset["build_report"] = artifact.build_report
                assets["fem_domain_mesh_asset"] = persisted_domain_asset
            else:
                assets["fem_domain_mesh_asset"] = {
                    "mesh_source": explicit_domain_mesh_source,
                    "mesh": None,
                    "region_markers": explicit_domain_region_markers,
                    "object_region_markers": explicit_domain_object_region_markers or [],
                }
        elif study_universe is not None:
            authored_regions = list(object_regions or [])

            # A generated shared-domain mesh is much more expensive than the
            # surrounding Python model assembly. Reuse a certified native
            # artifact between independent runs, while retaining the full
            # portable audit on every cache read. The cache is best-effort: a
            # corrupt, interrupted, or old entry is ignored and replaced only
            # after a fresh mesh has completed successfully.
            if fem_mesh_cache_dir is None:
                fem_mesh_cache_dir = _fem_mesh_cache_dir()
            shared_cache_path: Path | None = None
            shared_cache_document: dict[str, object] | None = None
            shared_cache_key: str | None = None
            if fem_mesh_cache_dir is not None:
                (
                    shared_cache_key,
                    shared_cache_document,
                ) = _fem_shared_domain_cache_document(
                    geometries,
                    discretization.fem,
                    study_universe=study_universe,
                    mesh_workflow=mesh_workflow,
                    per_object_recipes=per_object_recipes,
                    object_regions=authored_regions,
                )
                shared_cache_dir = fem_mesh_cache_dir / "shared_domains"
                shared_cache_dir.mkdir(parents=True, exist_ok=True)
                shared_cache_path = shared_cache_dir / f"{shared_cache_key}.fullmag-mesh"

            cached_shared_domain = False
            domain_mesh = None
            region_markers = None
            build_report = None
            if shared_cache_path is not None and shared_cache_path.exists():
                from fullmag.meshing.persistence import (
                    MeshArtifactError,
                    load_mesh_artifact,
                )

                try:
                    cached_artifact = load_mesh_artifact(
                        shared_cache_path,
                        expected_authoring_document=shared_cache_document,
                    )
                    cached_provenance = dict(cached_artifact.provenance or {})
                    if cached_provenance.get("cache_key") != shared_cache_key:
                        raise MeshArtifactError(
                            "shared-domain cache provenance does not match cache key"
                        )
                except (MeshArtifactError, OSError, ValueError, TypeError, KeyError) as exc:
                    emit_progress(
                        "Ignoring invalid cached shared-domain FEM mesh "
                        f"'{shared_cache_path}': {exc}"
                    )
                else:
                    domain_mesh = cached_artifact.mesh
                    region_markers = [
                        dict(entry) for entry in cached_artifact.region_markers
                    ]
                    build_report = cached_artifact.build_report
                    cached_shared_domain = True
                    emit_progress(
                        "Reusing cached shared-domain FEM mesh "
                        f"({domain_mesh.n_nodes} nodes, {domain_mesh.n_elements} elements)"
                    )

            if not cached_shared_domain:
                domain_mesh, region_markers, build_report = (
                    realize_fem_domain_mesh_asset_from_components_with_report(
                        list(geometries),
                        discretization.fem,
                        study_universe=study_universe,
                        mesh_workflow=mesh_workflow,
                        per_object_recipes=dict(per_object_recipes or {}),
                        object_regions=authored_regions,
                    )
                )
                if shared_cache_path is not None:
                    from fullmag.meshing.persistence import save_mesh_artifact

                    if build_report is not None:
                        report_payload = (
                            dict(build_report.to_dict())
                            if callable(getattr(build_report, "to_dict", None))
                            else dict(build_report)
                        )
                    else:
                        report_payload = None
                    object_region_markers = (
                        report_payload.get("object_region_markers", [])
                        if report_payload is not None
                        else []
                    )
                    save_mesh_artifact(
                        shared_cache_path,
                        mesh=domain_mesh,
                        mesh_name="study_domain",
                        authoring_document=shared_cache_document or {},
                        region_markers=region_markers,
                        object_region_markers=object_region_markers,
                        boundary_map=_mesh_boundary_semantic_map(domain_mesh),
                        build_report=report_payload,
                        provenance={
                            "origin": "generated_shared_domain_cache",
                            "cache_key": shared_cache_key,
                            "cache_schema": _FEM_SHARED_DOMAIN_CACHE_SCHEMA,
                        },
                    )
                    emit_progress(f"Cached shared-domain FEM mesh at '{shared_cache_path}'")

            assert domain_mesh is not None
            assert region_markers is not None
            if _realized_domain_mesh_sink is not None:
                # The public asset remains JSON MeshIR for the ProblemIR
                # contract, while the state owner can retain this exact typed
                # mesh for the immediately-following persistence operation.
                # This avoids a JSON -> NumPy rehydration of the same large
                # mixed CSR payload.
                _realized_domain_mesh_sink.append(
                    (
                        domain_mesh,
                        [dict(entry) for entry in region_markers],
                        build_report,
                    )
                )
            with indeterminate_progress_phase(
                phase="postprocessing",
                progress_label="serializing and validating shared-domain mesh",
                message="Serializing and validating the shared-domain mesh",
            ):
                domain_mesh_ir = domain_mesh.to_ir("study_domain")
                # ``MeshData.to_ir`` already performs the native mixed-mesh
                # certificate audit for a certified prism/pyramid/tet mesh.
                # Running the generic JSON validator immediately afterwards
                # reparses and walks the same 800k-cell payload.  Keep that
                # preflight for source-only/generic meshes, where no mixed
                # certificate provides the stronger proof.
                is_valid = (
                    True
                    if domain_mesh.mixed_layer_topology_certificate is not None
                    else validate_mesh_ir(domain_mesh_ir)
                )
            if is_valid is False:
                raise ValueError(
                    "generated shared FEM domain mesh asset failed Rust validation"
                )
            domain_asset = {
                "mesh_source": None,
                "mesh": domain_mesh_ir,
                "region_markers": region_markers,
                "object_region_markers": (
                    list(build_report.get("object_region_markers", []))
                    if isinstance(build_report, Mapping)
                    else (
                        list(build_report.object_region_markers)
                        if build_report is not None
                        else []
                    )
                ),
            }
            if build_report is not None:
                domain_asset["build_report"] = (
                    dict(build_report)
                    if isinstance(build_report, Mapping)
                    else build_report.to_dict()
                )
            assets["fem_domain_mesh_asset"] = domain_asset

    if (
        not assets["fdm_grid_assets"]
        and not assets["fem_mesh_assets"]
        and assets.get("fem_domain_mesh_asset") is None
    ):
        result = None
    else:
        result = assets

    if asset_cache is not None:
        asset_cache[asset_cache_key] = (
            copy.deepcopy(result) if _copy_cached_assets else result
        )

    return result


def _geometry_asset_cache_key(
    *,
    requested_backend: "BackendTarget",
    geometries: Sequence[object],
    discretization: DiscretizationHints,
    study_universe: dict[str, object] | None,
    mesh_workflow: dict[str, object] | None,
    per_object_recipes: Mapping[str, PerObjectMeshRecipe] | None,
    object_regions: Sequence[dict[str, object]] | None,
    fdm_only: bool,
) -> str:
    """Build a cache identity for the products actually realized.

    FDM grid voxelization consumes geometry, cell size and study-universe
    bounds.  Region coefficients, textures and FEM mesh policy are separate
    realization products and must not evict an identical grid asset.
    """
    payload: dict[str, object] = {
        "requested_backend": requested_backend.value,
        "geometries": [geometry.to_ir() for geometry in geometries],
        "discretization": discretization.to_ir(),
        "study_universe": study_universe,
    }
    if not fdm_only:
        payload["mesh_workflow"] = mesh_workflow
        payload["per_object_recipes"] = {
            str(name): recipe.to_ir()
            for name, recipe in (per_object_recipes or {}).items()
        }
        payload["object_regions"] = list(object_regions or [])
    return json.dumps(payload, sort_keys=True)


class ExecutionMode(str, Enum):
    STRICT = "strict"
    EXTENDED = "extended"
    HYBRID = "hybrid"


class BackendTarget(str, Enum):
    AUTO = "auto"
    FDM = "fdm"
    FEM = "fem"
    HYBRID = "hybrid"


class ExecutionPrecision(str, Enum):
    SINGLE = "single"
    DOUBLE = "double"


class DeviceTarget(str, Enum):
    AUTO = "auto"
    CPU = "cpu"
    CUDA = "cuda"
    GPU = "gpu"


@dataclass(frozen=True, slots=True)
class RuntimeSelection:
    backend_target: BackendTarget = BackendTarget.AUTO
    device_target: DeviceTarget = DeviceTarget.AUTO
    gpu_count: int = 0
    device_index: int | None = None
    cpu_threads: int | None = None
    execution_mode: ExecutionMode = ExecutionMode.STRICT
    execution_precision: ExecutionPrecision = ExecutionPrecision.DOUBLE

    def __post_init__(self) -> None:
        object.__setattr__(self, "backend_target", BackendTarget(self.backend_target))
        object.__setattr__(self, "device_target", DeviceTarget(self.device_target))
        object.__setattr__(self, "execution_mode", ExecutionMode(self.execution_mode))
        object.__setattr__(self, "execution_precision", ExecutionPrecision(self.execution_precision))
        if self.gpu_count < 0:
            raise ValueError("gpu_count must be >= 0")
        if self.gpu_count > 1:
            raise ValueError(
                "gpu_count > 1 requests multi-GPU execution, but multi-GPU execution is not implemented"
            )
        if self.device_index is not None and self.device_index < 0:
            raise ValueError("device_index must be >= 0")
        if self.cpu_threads is not None and self.cpu_threads <= 0:
            raise ValueError("cpu_threads must be >= 1")
        if self.cpu_threads is not None and self.cpu_threads > 1:
            import logging
            logging.getLogger("fullmag.runtime").info(
                "cpu_threads=%d — rayon thread pool will use %d threads",
                self.cpu_threads,
                self.cpu_threads,
            )
        if self.device_target in {DeviceTarget.CPU, DeviceTarget.AUTO} and self.device_index is not None:
            raise ValueError("device_index requires device_target='cuda' or 'gpu'")
        if self.device_target in {DeviceTarget.CPU, DeviceTarget.AUTO} and self.gpu_count != 0:
            raise ValueError("gpu_count requires device_target='cuda' or 'gpu'")

    def engine(self, backend: BackendTarget | str) -> "RuntimeSelection":
        normalized_backend = backend.value if isinstance(backend, BackendTarget) else str(backend).lower()
        return RuntimeSelection(
            backend_target=BackendTarget(normalized_backend),
            device_target=self.device_target,
            gpu_count=self.gpu_count,
            device_index=self.device_index,
            cpu_threads=self.cpu_threads,
            execution_mode=self.execution_mode,
            execution_precision=self.execution_precision,
        )

    def device(self, index: int) -> "RuntimeSelection":
        if self.device_target not in {DeviceTarget.CUDA, DeviceTarget.GPU}:
            raise ValueError("device(index) requires device_target='cuda' or 'gpu'")
        return RuntimeSelection(
            backend_target=self.backend_target,
            device_target=self.device_target,
            gpu_count=self.gpu_count or 1,
            device_index=index,
            cpu_threads=self.cpu_threads,
            execution_mode=self.execution_mode,
            execution_precision=self.execution_precision,
        )

    def cpu(self) -> "RuntimeSelection":
        return RuntimeSelection(
            backend_target=self.backend_target,
            device_target=DeviceTarget.CPU,
            gpu_count=0,
            device_index=None,
            cpu_threads=self.cpu_threads,
            execution_mode=self.execution_mode,
            execution_precision=self.execution_precision,
        )

    def cuda(self, gpu_count: int = 1) -> "RuntimeSelection":
        return RuntimeSelection(
            backend_target=self.backend_target,
            device_target=DeviceTarget.CUDA,
            gpu_count=gpu_count,
            device_index=self.device_index,
            cpu_threads=self.cpu_threads,
            execution_mode=self.execution_mode,
            execution_precision=self.execution_precision,
        )

    def gpu(self, gpu_count: int = 1) -> "RuntimeSelection":
        """Alias for :meth:`cuda`.  Deprecated — use ``.cuda()`` instead."""
        warnings.warn(
            "RuntimeSelection.gpu() is deprecated — use .cuda() instead; "
            "'gpu' and 'cuda' are synonyms in Fullmag",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.cuda(gpu_count=gpu_count)

    def threads(self, cpu_threads: int) -> "RuntimeSelection":
        return RuntimeSelection(
            backend_target=self.backend_target,
            device_target=self.device_target,
            gpu_count=self.gpu_count,
            device_index=self.device_index,
            cpu_threads=cpu_threads,
            execution_mode=self.execution_mode,
            execution_precision=self.execution_precision,
        )

    def mode(self, execution_mode: ExecutionMode | str) -> "RuntimeSelection":
        normalized_mode = (
            execution_mode.value if isinstance(execution_mode, ExecutionMode) else str(execution_mode).lower()
        )
        return RuntimeSelection(
            backend_target=self.backend_target,
            device_target=self.device_target,
            gpu_count=self.gpu_count,
            device_index=self.device_index,
            cpu_threads=self.cpu_threads,
            execution_mode=ExecutionMode(normalized_mode),
            execution_precision=self.execution_precision,
        )

    def precision(self, execution_precision: ExecutionPrecision | str) -> "RuntimeSelection":
        normalized_precision = (
            execution_precision.value
            if isinstance(execution_precision, ExecutionPrecision)
            else str(execution_precision).lower()
        )
        return RuntimeSelection(
            backend_target=self.backend_target,
            device_target=self.device_target,
            gpu_count=self.gpu_count,
            device_index=self.device_index,
            cpu_threads=self.cpu_threads,
            execution_mode=self.execution_mode,
            execution_precision=ExecutionPrecision(normalized_precision),
        )

    def resolved(
        self,
        *,
        backend: BackendTarget | str | None = None,
        mode: ExecutionMode | str | None = None,
        precision: ExecutionPrecision | str | None = None,
    ) -> "RuntimeSelection":
        resolved = self
        if backend is not None:
            resolved = resolved.engine(backend)
        if mode is not None:
            resolved = resolved.mode(mode)
        if precision is not None:
            resolved = resolved.precision(precision)
        return resolved

    def to_runtime_metadata(self) -> dict[str, object]:
        return {
            "backend": self.backend_target.value,
            "device": self.device_target.value,
            "gpu_count": self.gpu_count,
            "device_index": self.device_index,
            "cpu_threads": self.cpu_threads,
            "execution_mode": self.execution_mode.value,
            "execution_precision": self.execution_precision.value,
        }


backend = RuntimeSelection()


EnergyTerm = Exchange | Demag | InterfacialDMI | BulkDMI | Zeeman | StaticFieldMap | Magnetoelastic | UniaxialAnisotropy | OerstedCylinder | OerstedField | CubicAnisotropy | ThermalNoise
CurrentModule = AntennaFieldSource | CurrentTransport
LegacyOutputSpec = SaveField | SaveScalar | Snapshot
OutputSpec = LegacyOutputSpec | SaveSpectrum | SaveMode | SaveDispersion


def _material_has_anisotropy(material: Material) -> bool:
    return any(
        value is not None
        for value in (
            material.Ku1,
            material.Ku2,
            material.Kc1,
            material.Kc2,
            material.Kc3,
            material.Ku_field,
            material.Ku2_field,
            material.Kc1_field,
            material.Kc2_field,
            material.Kc3_field,
        )
    )


def _merged_legacy_material_value(
    existing: object,
    requested: object,
    *,
    name: str,
) -> object:
    if existing is not None and existing != requested:
        raise ValueError(
            f"legacy anisotropy energy term conflicts with Material.{name}; "
            "author anisotropy only on the Material"
        )
    return requested


def _migrate_legacy_anisotropy_energy_terms(
    magnets: Sequence[Ferromagnet],
    energy: Sequence[EnergyTerm],
) -> tuple[Sequence[Ferromagnet], Sequence[EnergyTerm]]:
    legacy_terms = [
        term
        for term in energy
        if isinstance(term, (UniaxialAnisotropy, CubicAnisotropy))
    ]
    if not legacy_terms:
        return magnets, energy

    materials_by_name: dict[str, Material] = {}
    for magnet in magnets:
        existing = materials_by_name.get(magnet.material.name)
        if existing is not None and existing != magnet.material:
            raise ValueError(
                f"material '{magnet.material.name}' is defined multiple times with different values"
            )
        materials_by_name[magnet.material.name] = magnet.material
    if len(materials_by_name) != 1:
        raise ValueError(
            "legacy anisotropy energy terms require a single material target; "
            "set Ku1/Ku2/anisU or Kc1/Kc2/Kc3/anisC1/anisC2 on each Material instead"
        )

    material = next(iter(materials_by_name.values()))
    updates: dict[str, object] = {}
    for term in legacy_terms:
        if isinstance(term, UniaxialAnisotropy):
            updates["Ku1"] = _merged_legacy_material_value(
                updates.get("Ku1", material.Ku1), term.ku1, name="Ku1"
            )
            updates["Ku2"] = _merged_legacy_material_value(
                updates.get("Ku2", material.Ku2), term.ku2, name="Ku2"
            )
            updates["anisU"] = _merged_legacy_material_value(
                updates.get("anisU", material.anisU), term.axis, name="anisU"
            )
        else:
            updates["Kc1"] = _merged_legacy_material_value(
                updates.get("Kc1", material.Kc1), term.kc1, name="Kc1"
            )
            updates["Kc2"] = _merged_legacy_material_value(
                updates.get("Kc2", material.Kc2), term.kc2, name="Kc2"
            )
            updates["Kc3"] = _merged_legacy_material_value(
                updates.get("Kc3", material.Kc3), term.kc3, name="Kc3"
            )
            updates["anisC1"] = _merged_legacy_material_value(
                updates.get("anisC1", material.anisC1), term.axis1, name="anisC1"
            )
            updates["anisC2"] = _merged_legacy_material_value(
                updates.get("anisC2", material.anisC2), term.axis2, name="anisC2"
            )

    migrated_material = replace(material, **updates)
    return (
        [replace(magnet, material=migrated_material) for magnet in magnets],
        [term for term in energy if not isinstance(term, (UniaxialAnisotropy, CubicAnisotropy))],
    )


def _is_spin_torque_module(value: object) -> bool:
    return hasattr(value, "to_ir_module")


def _normalize_spin_torque_modules(
    legacy_spin_torque: LegacySpinTorque | None,
    spin_torques: Sequence[SpinTorqueModule] | SpinTorqueModule | None,
) -> tuple[SpinTorqueModule, ...]:
    has_canonical_modules = False
    if spin_torques is not None:
        if _is_spin_torque_module(spin_torques):
            has_canonical_modules = True
        else:
            has_canonical_modules = len(spin_torques) > 0

    if legacy_spin_torque is not None and has_canonical_modules:
        raise ValueError(
            "Use either spin_torque=... (legacy single-module API) or "
            "spin_torques=[...] (canonical multi-module API), not both"
        )

    if spin_torques in (None, ()):
        return (legacy_spin_torque,) if legacy_spin_torque is not None else ()

    if _is_spin_torque_module(spin_torques):
        return (spin_torques,)

    normalized: list[SpinTorqueModule] = []
    for index, module in enumerate(spin_torques):
        if not _is_spin_torque_module(module):
            raise TypeError(
                f"spin_torques[{index}] must be a spin torque module with to_ir_module(), "
                f"got {type(module).__name__}"
            )
        normalized.append(module)
    return tuple(normalized)


def _spin_torque_modules_ir(problem: "Problem") -> list[dict[str, object]]:
    return [module.to_ir_module() for module in problem.spin_torques]


def _legacy_spin_torque_fields(problem: "Problem") -> dict[str, object]:
    if len(problem.spin_torques) != 1:
        return {}
    to_ir_fields = getattr(problem.spin_torques[0], "to_ir_fields", None)
    if not callable(to_ir_fields):
        return {}
    fields = to_ir_fields()
    if not isinstance(fields, dict):
        raise TypeError("spin torque module to_ir_fields() must return dict[str, object]")
    return fields


def _current_module_name_map(
    current_modules: Sequence[CurrentModule],
) -> dict[str, CurrentModule]:
    return {module.name: module for module in current_modules}


def _spin_transport_modules_ir(problem: "Problem") -> list[dict[str, object]]:
    """Lower spin transport with the coupling owned by its charge source."""

    current_modules_by_name = _current_module_name_map(problem.current_modules)
    lowered: list[dict[str, object]] = []
    for module in problem.spin_transports:
        source = current_modules_by_name.get(module.current_source_id)
        coupling = source.coupling if isinstance(source, CurrentTransport) else None
        lowered.append(module.to_ir(coupling=coupling))
    return lowered


def _legacy_spatial_envelope(profile: dict[str, object] | None):
    payload = profile or {"kind": "uniform"}
    kind = str(payload.get("kind") or "").strip().lower()
    if kind == "uniform":
        return UniformFieldProfile()
    if kind == "sinc":
        return SincFieldProfile(
            axis=payload.get("axis", (1.0, 0.0, 0.0)),  # type: ignore[arg-type]
            period_m=float(payload.get("period_m", payload.get("period", 0.0))),
            center_m=float(payload.get("center_m", payload.get("center", 0.0))),
            width_m=(
                None
                if payload.get("width_m", payload.get("width")) is None
                else float(payload.get("width_m", payload.get("width")))
            ),
            window=str(payload.get("window") or "none"),
        )
    raise ValueError(f"unsupported legacy prescribed_zeeman_mask spatial profile {kind!r}")


def _migrate_legacy_prescribed_field_sources(
    current_modules: Sequence[CurrentModule],
    field_drives: Sequence[RegionalFieldDrive],
) -> tuple[tuple[CurrentModule, ...], tuple[RegionalFieldDrive, ...]]:
    retained: list[CurrentModule] = []
    migrated = list(field_drives)
    for module in current_modules:
        if not isinstance(module, AntennaFieldSource) or module.model != "prescribed_zeeman_mask":
            retained.append(module)
            continue
        assert module.object is not None
        assert module.B is not None
        migrated.append(
            RegionalFieldDrive(
                id=module.name,
                name=module.name,
                target=FieldTarget.global_domain(),
                amplitude_B_T=float(module.B),
                direction=module.direction,
                spatial_profile=GeometryMaskFieldProfile(
                    object_id=module.object,
                    envelope=_legacy_spatial_envelope(module.spatial_profile),
                ),
                waveform=module.waveform or Constant(),
                time_origin="stage_local",
                activation=DriveActivation.all_time_evolution(),
                migration={"migrated_from": "prescribed_zeeman_mask"},
            )
        )
    return tuple(retained), tuple(migrated)


def _module_kind(module: CurrentModule) -> str:
    if isinstance(module, AntennaFieldSource):
        return "antenna_field_source"
    if isinstance(module, CurrentTransport):
        return "current_transport"
    return type(module).__name__


def _builder_source_kind(entrypoint_kind: str) -> str:
    if entrypoint_kind.startswith("flat_"):
        return "flat_script"
    if entrypoint_kind == "build":
        return "build_function"
    if entrypoint_kind == "problem":
        return "problem_object"
    if entrypoint_kind.startswith("interactive_"):
        return "interactive_command"
    return "problem_model"


def _builder_editable_scopes(
    problem: "Problem",
    *,
    mesh_workflow: dict[str, object] | None,
    study_universe: dict[str, object] | None,
) -> list[str]:
    scopes = ["runtime"]
    if study_universe is not None:
        scopes.append("universe")
    scopes.extend(["geometry", "materials", "energies", "study", "outputs"])
    if any(isinstance(module, AntennaFieldSource) for module in problem.current_modules):
        scopes.append("antennas")
    if any(isinstance(module, CurrentTransport) for module in problem.current_modules):
        scopes.append("current_transport")
    if problem.field_drives:
        scopes.append("field_drives")
    if problem.spin_transports:
        scopes.append("spin_transport")
    if mesh_workflow is not None or (
        problem.discretization is not None and problem.discretization.fem is not None
    ):
        scopes.append("meshing")
    # STNO scopes (F03)
    if problem.spin_torques:
        scopes.append("spin_torque")
    if problem.temperature is not None:
        scopes.append("thermal")
    if any(isinstance(t, (OerstedCylinder, OerstedField)) for t in problem.energy):
        scopes.append("oersted")
    return scopes


def build_problem_builder_manifest(
    problem: "Problem",
    *,
    runtime: "RuntimeSelection",
    entrypoint_kind: str,
    source_root: str | Path | None,
    mesh_workflow: dict[str, object] | None,
    study_pipeline: dict[str, object] | None = None,
) -> dict[str, object]:
    runtime_metadata = problem.runtime_metadata if isinstance(problem.runtime_metadata, dict) else {}
    study_universe = (
        runtime_metadata.get("study_universe")
        if isinstance(runtime_metadata.get("study_universe"), dict)
        else None
    )
    script_api_surface = (
        runtime_metadata.get("script_api_surface")
        if isinstance(runtime_metadata.get("script_api_surface"), str)
        else None
    )
    materials = problem._collect_materials()
    regions = problem._collect_regions()
    geometries = [
        resolve_geometry_sources(geometry, source_root=source_root)
        for geometry in problem._collect_geometries()
    ]
    domain_frame = build_domain_frame(
        geometries=list(geometries),
        source_root=source_root,
        study_universe=study_universe,
    )
    editable_scopes = _builder_editable_scopes(
        problem,
        mesh_workflow=mesh_workflow,
        study_universe=study_universe,
    )
    manifest = {
        "schema_version": "model_builder.v1",
        "source_kind": _builder_source_kind(entrypoint_kind),
        "entrypoint_kind": entrypoint_kind,
        "script_api_surface": script_api_surface,
        "editable_via_ui": True,
        "editable_scopes": editable_scopes,
        "canonical_script_strategy": "canonical_rewrite",
        "problem": {
            "name": problem.name,
            "description": problem.description,
            "runtime": runtime.to_runtime_metadata(),
            "universe": study_universe,
            "domain_frame": domain_frame,
            "geometry": [geometry.to_ir() for geometry in geometries],
            "regions": [region.to_ir() for region in regions],
            "materials": [material.to_ir() for material in materials],
            "magnets": [magnet.to_ir() for magnet in problem.magnets],
            "energy_terms": [term.to_ir() for term in problem.energy],
            "current_modules": [module.to_ir() for module in problem.current_modules],
            "field_drives": [drive.to_ir() for drive in problem.field_drives],
            "planar_monitors": [monitor.to_ir() for monitor in problem.monitors],
            "excitation_analysis": problem.excitation_analysis.to_ir()
            if problem.excitation_analysis is not None
            else None,
            "study": problem.study.to_ir(),
            "discretization": problem.discretization.to_ir() if problem.discretization else None,
            "mesh_workflow": mesh_workflow,
            # STNO / drive fields (F02)
            "spin_torque": _legacy_spin_torque_fields(problem) or None,
            "spin_torque_modules": _spin_torque_modules_ir(problem),
            "temperature": problem.temperature,
        },
    }
    if study_pipeline is not None:
        manifest["study_pipeline"] = copy.deepcopy(study_pipeline)
    return manifest


def build_script_sync_manifest(
    *,
    entrypoint_kind: str,
    editable_scopes: Sequence[str],
    study_pipeline: dict[str, object] | None = None,
) -> dict[str, object]:
    manifest = {
        "schema_version": "script_sync.v1",
        "source_kind": _builder_source_kind(entrypoint_kind),
        "entrypoint_kind": entrypoint_kind,
        "source_of_truth": "model_builder",
        "rewrite_strategy": "canonical_rewrite",
        "editable_scopes": list(editable_scopes),
        "phase": "round_trip_canonical_sync",
    }
    if study_pipeline is not None:
        manifest["study_pipeline_version"] = study_pipeline.get("version")
        nodes = study_pipeline.get("nodes")
        manifest["study_pipeline_node_count"] = len(nodes) if isinstance(nodes, list) else 0
    return manifest


def _normalize_study_pipeline_value(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    version = value.get("version")
    nodes = value.get("nodes")
    if not isinstance(version, str) or not version.strip():
        return None
    if nodes is not None and not isinstance(nodes, list):
        return None
    return copy.deepcopy(value)


def _validate_constraint_frame_reference(
    frame: object, object_ids: set[str]
) -> None:
    if not isinstance(frame, Mapping) or frame.get("kind") != "object":
        return
    object_id = frame.get("object_id")
    if object_id not in object_ids:
        raise ValueError(f"selection_unknown_object: {object_id!r}")


def _validate_constraint_scalar_references(
    scalar: object, object_ids: set[str]
) -> None:
    if not isinstance(scalar, Mapping):
        return
    if scalar.get("kind") == "coordinate":
        _validate_constraint_frame_reference(scalar.get("frame"), object_ids)
    nested = scalar.get("value")
    if isinstance(nested, Mapping):
        _validate_constraint_scalar_references(nested, object_ids)


def _validate_constraint_selector_references(
    selector: object,
    definitions: Mapping[str, Mapping[str, object]],
    object_ids: set[str],
    region_ids: set[tuple[str, str]],
    resolving: frozenset[str] = frozenset(),
) -> None:
    if not isinstance(selector, Mapping):
        raise TypeError("constraint selector must be a selection mapping")
    kind = selector.get("kind")
    if kind == "in_object":
        object_id = selector.get("object_id")
        if object_id not in object_ids:
            raise ValueError(f"selection_unknown_object: {object_id!r}")
        return
    if kind == "in_region":
        reference = (selector.get("object_id"), selector.get("region_id"))
        if reference not in region_ids:
            raise ValueError(
                f"selection_unknown_region: {reference[0]!r}/{reference[1]!r}"
            )
        return
    if kind == "inside_geometry":
        _validate_constraint_frame_reference(selector.get("frame"), object_ids)
        return
    if kind in {"compare", "approx"}:
        for key in ("lhs", "rhs", "value", "target"):
            _validate_constraint_scalar_references(selector.get(key), object_ids)
        return
    if kind == "between":
        _validate_constraint_scalar_references(selector.get("value"), object_ids)
        return
    if kind in {"and", "or", "xor"}:
        expressions = selector.get("expressions")
        if isinstance(expressions, Sequence):
            for child in expressions:
                _validate_constraint_selector_references(
                    child, definitions, object_ids, region_ids, resolving
                )
        return
    if kind == "not":
        _validate_constraint_selector_references(
            selector.get("expression"),
            definitions,
            object_ids,
            region_ids,
            resolving,
        )
        return
    if kind == "ref":
        selection_id = selector.get("selection_id")
        definition = definitions.get(selection_id) if isinstance(selection_id, str) else None
        if definition is None:
            raise ValueError(f"selection_unknown_reference: {selection_id!r}")
        if selection_id in resolving:
            raise ValueError(f"selection_reference_cycle: {selection_id!r}")
        _validate_constraint_selector_references(
            definition.get("expression"),
            definitions,
            object_ids,
            region_ids,
            resolving | {selection_id},
        )


def _validate_authored_mixed_p1_scope(
    *,
    runtime_selection: dict[str, object],
    mesh_workflow: dict[str, object] | None,
    materials: Sequence[object],
    energy_terms: Sequence[object],
) -> None:
    if (
        runtime_selection.get("backend") != "fem"
        or runtime_selection.get("execution_mode") != "strict"
    ):
        return
    per_geometry = (
        mesh_workflow.get("per_geometry")
        if isinstance(mesh_workflow, dict)
        else None
    )
    if not isinstance(per_geometry, list):
        return
    requests_mixed_p1 = any(
        isinstance(recipe, dict)
        and recipe.get("mesh_strategy") == "swept_prism"
        and recipe.get("transition_policy") == "pyramid_to_tetrahedra"
        and recipe.get("order") == 1
        for recipe in per_geometry
    )
    if not requests_mixed_p1:
        return

    material_payloads = [
        material.to_ir()
        for material in materials
        if hasattr(material, "to_ir")
    ]
    energy_payloads = [
        term.to_ir()
        for term in energy_terms
        if hasattr(term, "to_ir")
    ]
    device = runtime_selection.get("device")
    dmi_kinds = {"interfacial_dmi", "bulk_dmi"}
    has_dmi = any(payload.get("kind") in dmi_kinds for payload in energy_payloads) or any(
        payload.get(key) is not None
        for payload in material_payloads
        for key in ("interfacial_dmi", "bulk_dmi", "dind_field", "dbulk_field")
    )
    failed: list[str] = []
    if device not in {"cpu", "cuda", "gpu"}:
        failed.append("device_not_explicit_cpu_or_gpu")
    exchange_count = sum(
        payload.get("kind") == "exchange" for payload in energy_payloads
    )
    qualified_demag_count = sum(
        payload.get("kind") == "demag"
        and payload.get("realization")
        in {"auto", "poisson_robin", "poisson_dirichlet"}
        for payload in energy_payloads
    )
    if exchange_count == 0:
        failed.append("missing_exchange")
    elif exchange_count != 1:
        failed.append("exchange_term_count_not_one")
    if qualified_demag_count == 0:
        failed.append("missing_qualified_demag")
    elif qualified_demag_count != 1:
        failed.append("demag_term_count_not_one")
    if any(
        payload.get("kind")
        not in {"exchange", "demag", "zeeman", "interfacial_dmi", "bulk_dmi"}
        for payload in energy_payloads
    ):
        failed.append("unsupported_energy_term")
    if device in {"cuda", "gpu"} and has_dmi:
        failed.append("gpu_dmi_kernel_not_mixed_p1")
    if len(material_payloads) != 1:
        failed.append("material_count_not_one")
    if any(
        payload.get(key) is not None
        for payload in material_payloads
        for key in (
            "ms_field",
            "a_field",
            "alpha_field",
        )
    ):
        failed.append("unsupported_material_field_or_dmi")

    if failed:
        raise ValueError(
            "fem_mixed_p1_scope_rejected: "
            f"phase=authored_preflight; failed_predicates=[{','.join(failed)}]; "
            "qualified_scope=exchange+uniform_or_nodal_uniaxial_or_cubic_anisotropy+cpu_dmi_only+auto_or_poisson_open_boundary_order_one; fallback=none"
        )


@dataclass(frozen=True, slots=True)
class Problem:
    name: str
    magnets: Sequence[Ferromagnet]
    energy: Sequence[EnergyTerm]
    study: TimeEvolution | Relaxation | Eigenmodes | FrequencyResponse | None = None
    dynamics: LLG | None = None
    outputs: Sequence[LegacyOutputSpec] | None = None
    discretization: DiscretizationHints | None = None
    description: str | None = None
    runtime: RuntimeSelection = field(default_factory=RuntimeSelection)
    runtime_metadata: dict[str, object] = field(default_factory=dict)
    auxiliary_geometries: Sequence[object] = ()
    auxiliary_geometry_roles: Mapping[str, str] = field(default_factory=dict)
    current_modules: Sequence[CurrentModule] = ()
    field_drives: Sequence[RegionalFieldDrive] = ()
    couplings: Sequence[Coupling] = ()
    monitors: Sequence[PlanarMonitor] = ()
    excitation_analysis: SpinWaveExcitationAnalysis | None = None
    geometry_asset_cache: dict[str, dict[str, Any] | None] = field(
        default_factory=dict,
        repr=False,
        compare=False,
    )
    # Legacy single-module spin-transfer torque.
    spin_torque: LegacySpinTorque | None = None
    # Canonical torque family. Allows more than one module to be authored.
    spin_torques: Sequence[SpinTorqueModule] = ()
    # Stage-local activation state for canonical torque modules.
    spin_torque_activation: Mapping[str, bool] = field(default_factory=dict)
    spin_transports: Sequence[SpinDriftDiffusion] = ()
    # Temperature for Brown thermal field [K] (optional, 0 = no noise)
    temperature: float | None = None
    # Magnetoelastic (optional)
    elastic_materials: Sequence[ElasticMaterial] = ()
    elastic_bodies: Sequence[ElasticBody] = ()
    magnetostriction_laws: Sequence[MagnetostrictionLaw] = ()
    mechanical_bcs: Sequence[MechanicalBoundaryCondition] = ()
    mechanical_loads: Sequence[MechanicalLoad] = ()
    selections: Sequence[SelectionDefinition] = ()
    magnetization_constraints: Sequence[FrozenSpins] = ()

    # Periodic boundary conditions (per-axis, for FDM)
    pbc: FdmPbc | tuple[bool, bool, bool] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        roles = {
            require_non_empty(str(name), "auxiliary_geometry_roles.name"): require_non_empty(
                str(role), "auxiliary_geometry_roles.role"
            ).lower()
            for name, role in self.auxiliary_geometry_roles.items()
        }
        allowed_roles = {"geometry", "conductor", "electrode", "antenna"}
        invalid_roles = sorted(set(roles.values()) - allowed_roles)
        if invalid_roles:
            raise ValueError(
                "auxiliary_geometry_roles contains unsupported type(s): "
                + ", ".join(invalid_roles)
            )
        auxiliary_names = {
            str(getattr(geometry, "geometry_name", ""))
            for geometry in self.auxiliary_geometries
        }
        unknown_roles = sorted(set(roles) - auxiliary_names)
        if unknown_roles:
            raise ValueError(
                "auxiliary_geometry_roles references unknown geometry object(s): "
                + ", ".join(unknown_roles)
            )
        object.__setattr__(self, "auxiliary_geometry_roles", roles)
        if not self.magnets:
            raise ValueError("Problem requires at least one magnet")
        if not self.energy and not any(
            _material_has_anisotropy(magnet.material) for magnet in self.magnets
        ):
            raise ValueError(
                "Problem requires at least one interaction or material anisotropy"
            )

        migrated_magnets, migrated_energy = _migrate_legacy_anisotropy_energy_terms(
            self.magnets,
            self.energy,
        )
        object.__setattr__(self, "magnets", migrated_magnets)
        object.__setattr__(self, "energy", migrated_energy)

        normalized_current_modules, normalized_field_drives = (
            _migrate_legacy_prescribed_field_sources(
                self.current_modules,
                self.field_drives,
            )
        )
        object.__setattr__(self, "current_modules", normalized_current_modules)
        object.__setattr__(self, "field_drives", normalized_field_drives)

        normalized_study = self._normalize_study()
        object.__setattr__(self, "study", normalized_study)
        normalized_spin_torques = _normalize_spin_torque_modules(
            self.spin_torque,
            self.spin_torques,
        )
        object.__setattr__(self, "spin_torque", None)
        object.__setattr__(self, "spin_torques", normalized_spin_torques)
        activation = {}
        for module_id, enabled in self.spin_torque_activation.items():
            normalized_id = require_non_empty(str(module_id), "spin_torque_activation.module_id")
            if not isinstance(enabled, bool):
                raise TypeError("spin_torque_activation values must be bool")
            activation[normalized_id] = enabled
        torque_ids = {
            str(payload.get("id") or payload.get("name"))
            for payload in (module.to_ir_module() for module in normalized_spin_torques)
        }
        unknown_activation = sorted(set(activation) - torque_ids)
        if unknown_activation:
            raise ValueError(
                "spin_torque_activation references unknown module id(s): "
                + ", ".join(unknown_activation)
            )
        object.__setattr__(self, "spin_torque_activation", activation)
        ensure_unique_names(
            (
                module.name
                for module in normalized_spin_torques
                if isinstance(module, (PrescribedSpinOrbitTorque, SpinOrbitTorque))
            ),
            "prescribed SOT ids",
        )

        if self.temperature is not None and self.temperature < 0.0:
            raise ValueError("temperature must be >= 0")

        # Validate ThermalNoise ↔ temperature consistency (F01)
        thermal_terms = [t for t in self.energy if isinstance(t, ThermalNoise)]
        if len(thermal_terms) > 1:
            raise ValueError(
                "at most one ThermalNoise energy term is allowed"
            )
        if thermal_terms and self.temperature is not None:
            tn = thermal_terms[0]
            if abs(tn.temperature - self.temperature) > 1e-6:
                raise ValueError(
                    f"ThermalNoise.temperature ({tn.temperature} K) conflicts with "
                    f"Problem.temperature ({self.temperature} K); use one or the other, "
                    f"or ensure they match"
                )

        ensure_unique_names((magnet.name for magnet in self.magnets), "magnet names")
        explicit_object_ids = [
            magnet.object_id for magnet in self.magnets if magnet.object_id is not None
        ]
        ensure_unique_names(explicit_object_ids, "magnet object_ids")
        self._validate_magnetization_constraints()
        ensure_unique_names(
            (module.name for module in self.current_modules), "current module names"
        )
        ensure_unique_names((drive.id for drive in self.field_drives), "field drive ids")
        ensure_unique_names((drive.name for drive in self.field_drives), "field drive names")
        if any(not isinstance(drive, RegionalFieldDrive) for drive in self.field_drives):
            raise TypeError("Problem.field_drives must contain RegionalFieldDrive objects")
        magnetic_object_ids = {magnet.name for magnet in self.magnets}
        region_ids = {
            (region.owner_object, region.region_id) for region in self._collect_object_regions()
        }
        geometry_ids = {
            getattr(geometry, "geometry_name", "") for geometry in self._collect_geometries()
        }
        for drive in self.field_drives:
            target = drive.target
            if target.kind in {"object", "region"} and target.object_id not in magnetic_object_ids:
                raise ValueError(
                    f"field drive {drive.id!r} target object {target.object_id!r} is not magnetic"
                )
            if target.kind == "region" and (target.object_id, target.region_id) not in region_ids:
                raise ValueError(
                    f"field drive {drive.id!r} target region {target.region_id!r} does not exist"
                )
            if isinstance(drive.spatial_profile, GeometryMaskFieldProfile):
                if drive.spatial_profile.object_id not in geometry_ids:
                    raise ValueError(
                        f"field drive {drive.id!r} geometry mask {drive.spatial_profile.object_id!r} does not exist"
                    )
        ensure_unique_names(
            (coupling.coupling_id for coupling in self.couplings), "coupling ids"
        )
        if any(not isinstance(monitor, PlanarMonitor) for monitor in self.monitors):
            raise TypeError("Problem.monitors must contain PlanarMonitor objects")
        ensure_unique_names((monitor.id for monitor in self.monitors), "planar monitor ids")
        ensure_unique_names(
            (monitor.name for monitor in self.monitors),
            "planar monitor names",
        )
        current_modules_by_name = _current_module_name_map(self.current_modules)
        ensure_unique_names((module.id for module in self.spin_transports), "spin transport ids")
        spin_transports_by_id = {module.id: module for module in self.spin_transports}
        for module in self.spin_transports:
            source_module = current_modules_by_name.get(module.current_source_id)
            if not isinstance(source_module, CurrentTransport):
                raise ValueError(
                    f"spin transport current_source_id={module.current_source_id!r} must reference a CurrentTransport"
                )
            if source_module.coupling == "bidirectional":
                if module.mode != "steady":
                    raise ValueError(
                        "bidirectional charge-spin transport currently requires mode='steady'"
                    )
                fem_m2 = (
                    module.solver.operator_version == _FEM_M2_OPERATOR_VERSION
                    or (
                        source_module.solver is not None
                        and source_module.solver.operator_version == _FEM_M2_OPERATOR_VERSION
                    )
                )
                if fem_m2:
                    if module.solver.operator_version != _FEM_M2_OPERATOR_VERSION:
                        raise ValueError(
                            "FEM bidirectional charge-spin transport requires spin "
                            f"operator_version='{_FEM_M2_OPERATOR_VERSION}'"
                        )
                    if (
                        source_module.solver is None
                        or source_module.solver.operator_version != _FEM_M2_OPERATOR_VERSION
                    ):
                        raise ValueError(
                            "FEM bidirectional charge-spin transport requires charge "
                            f"operator_version='{_FEM_M2_OPERATOR_VERSION}'"
                        )
                    if module.solver.reciprocal_nonlinear is not None:
                        raise ValueError(
                            "bounded FEM bidirectional charge-spin transport does not "
                            "accept reciprocal_nonlinear solver policy"
                        )
                else:
                    if module.solver.reciprocal_nonlinear is None:
                        raise ValueError(
                            "FDM bidirectional charge-spin transport requires "
                            "reciprocal_nonlinear solver policy"
                        )
                    if module.solver.operator_version != _FDM_M2_OPERATOR_VERSION:
                        raise ValueError(
                            "FDM bidirectional charge-spin transport requires "
                            f"operator_version='{_FDM_M2_OPERATOR_VERSION}'"
                        )
                    if (
                        source_module.solver is None
                        or source_module.solver.operator_version != _FDM_M2_OPERATOR_VERSION
                    ):
                        raise ValueError(
                            "FDM bidirectional charge-spin transport requires charge "
                            f"operator_version='{_FDM_M2_OPERATOR_VERSION}'"
                        )
            elif module.solver.reciprocal_nonlinear is not None:
                raise ValueError(
                    "reciprocal_nonlinear solver policy requires a bidirectional CurrentTransport source"
                )
        if self.excitation_analysis is not None:
            source_module = current_modules_by_name.get(self.excitation_analysis.source)
            if source_module is None:
                raise ValueError(
                    "excitation_analysis.source must reference one of Problem.current_modules"
                )
            if not isinstance(source_module, AntennaFieldSource):
                raise ValueError(
                    "excitation_analysis.source must reference an AntennaFieldSource"
                )
        for module in self.spin_torques:
            if isinstance(module, DriftDiffusionSpinTorque):
                if module.solve_id not in spin_transports_by_id:
                    raise ValueError(
                        f"drift-diffusion torque solve_id={module.solve_id!r} must reference Problem.spin_transports"
                    )
                continue
            current_source = getattr(module, "current_source", None)
            if current_source is None:
                continue
            source_module = current_modules_by_name.get(current_source)
            if source_module is None:
                raise ValueError(
                    f"spin torque current_source={current_source!r} must reference one of Problem.current_modules"
                )
            if not isinstance(source_module, CurrentTransport):
                raise ValueError(
                    f"spin torque current_source={current_source!r} must reference a CurrentTransport, got {_module_kind(source_module)}"
                )
        for term in self.energy:
            if not isinstance(term, OerstedField):
                continue
            source_module = current_modules_by_name.get(term.source)
            if source_module is None:
                raise ValueError(
                    f"OerstedField source={term.source!r} must reference one of Problem.current_modules"
                )
            if not isinstance(source_module, CurrentTransport):
                raise ValueError(
                    f"OerstedField source={term.source!r} must reference a CurrentTransport, got {_module_kind(source_module)}"
                )
        self._validate_material_consistency()
        self._validate_geometry_consistency()
        self._validate_region_consistency()

    def to_ir(
        self,
        *,
        requested_backend: BackendTarget | None = None,
        execution_mode: ExecutionMode | None = None,
        execution_precision: ExecutionPrecision | None = None,
        script_source: str | None = None,
        source_root: str | Path | None = None,
        entrypoint_kind: str = "direct",
        asset_cache: dict[str, dict[str, Any] | None] | None = None,
        include_geometry_assets: bool = True,
        study_pipeline: dict[str, object] | None = None,
        _copy_cached_geometry_assets: bool = True,
    ) -> dict[str, object]:
        runtime = self.runtime.resolved(
            backend=requested_backend,
            mode=execution_mode,
            precision=execution_precision,
        )
        materials = self._collect_materials()
        regions = self._collect_regions()
        object_regions = self._collect_object_regions()
        geometries = [
            resolve_geometry_sources(geometry, source_root=source_root)
            for geometry in self._collect_geometries()
        ]
        discretization = self._resolve_discretization(runtime.backend_target)
        pbc_ir = _pbc_to_ir(self.pbc)
        if (
            runtime.backend_target == BackendTarget.FDM
            and pbc_ir is not None
            and pbc_ir.get("demag") == "periodic_airbox_k0"
        ):
            raise ValueError(
                "pbc.demag='periodic_airbox_k0' is FEM-only; FDM supports "
                "'open' and 'truncated_images' demag policies"
            )
        source_hash = sha256(script_source.encode("utf-8")).hexdigest() if script_source else None
        effective_asset_cache = asset_cache if asset_cache is not None else self.geometry_asset_cache
        runtime_metadata = dict(self.runtime_metadata)
        runtime_metadata["runtime_selection"] = runtime.to_runtime_metadata()
        effective_study_pipeline = _normalize_study_pipeline_value(study_pipeline)
        if effective_study_pipeline is None:
            effective_study_pipeline = _normalize_study_pipeline_value(
                runtime_metadata.get("study_pipeline")
            )
        if effective_study_pipeline is not None:
            runtime_metadata["study_pipeline"] = copy.deepcopy(effective_study_pipeline)
        if self.discretization is not None and discretization is not self.discretization:
            runtime_metadata["derived_discretization"] = {
                "policy": "fem_from_fdm_cell",
                "fem": discretization.fem.to_ir() if discretization.fem else None,
            }
        mesh_workflow = runtime_metadata.get("mesh_workflow")
        if not isinstance(mesh_workflow, dict):
            mesh_workflow = None
        _validate_authored_mixed_p1_scope(
            runtime_selection=runtime_metadata["runtime_selection"],
            mesh_workflow=mesh_workflow,
            materials=materials,
            energy_terms=self.energy,
        )
        study_universe = (
            runtime_metadata.get("study_universe")
            if isinstance(runtime_metadata.get("study_universe"), dict)
            else None
        )
        domain_frame = build_domain_frame(
            geometries=list(geometries),
            source_root=source_root,
            study_universe=study_universe,
        )
        if domain_frame is not None:
            runtime_metadata["domain_frame"] = domain_frame
        builder_manifest = build_problem_builder_manifest(
            self,
            runtime=runtime,
            entrypoint_kind=entrypoint_kind,
            source_root=source_root,
            mesh_workflow=mesh_workflow,
            study_pipeline=effective_study_pipeline,
        )
        runtime_metadata["model_builder"] = builder_manifest
        runtime_metadata["script_sync"] = build_script_sync_manifest(
            entrypoint_kind=entrypoint_kind,
            editable_scopes=builder_manifest.get("editable_scopes", []),
            study_pipeline=effective_study_pipeline,
        )
        geometry_assets = None
        if include_geometry_assets:
            per_object_recipes = {
                magnet.geometry.geometry_name: magnet.mesh
                for magnet in self.magnets
                if isinstance(magnet.mesh, PerObjectMeshRecipe)
            }
            owner_geometry_names = {
                magnet.name: magnet.geometry.geometry_name for magnet in self.magnets
            }
            object_region_mesh_specs = []
            for region in object_regions:
                payload = region.to_ir()
                payload["owner_geometry_name"] = owner_geometry_names.get(
                    region.owner_object,
                    "",
                )
                object_region_mesh_specs.append(payload)
            geometry_assets = build_geometry_assets_for_request(
                requested_backend=runtime.backend_target,
                geometries=geometries,
                discretization=discretization,
                study_universe=study_universe,
                mesh_workflow=mesh_workflow,
                per_object_recipes=per_object_recipes,
                object_regions=object_region_mesh_specs,
                asset_cache=effective_asset_cache,
                _copy_cached_assets=_copy_cached_geometry_assets,
            )
        magnets_ir = [magnet.to_ir() for magnet in self.magnets]
        magnets_ir = _materialize_preset_texture_initial_conditions(
            magnets_ir,
            self.magnets,
            geometry_assets,
        )

        spin_torque_payload: dict[str, object] = {}
        if self.spin_torques:
            spin_torque_payload["spin_torque_modules"] = _spin_torque_modules_ir(self)
        spin_torque_payload.update(_legacy_spin_torque_fields(self))

        physics_objects = [
            {
                "schema_version": "physics_object.v1",
                "object_id": name,
                "name": name,
                "type": role,
                "geometry_id": name,
                "material_assignment_ids": [],
            }
            for name, role in self.auxiliary_geometry_roles.items()
            if role != "antenna"
        ]

        result = {
            "ir_version": IR_VERSION,
            "problem_meta": {
                "name": self.name,
                "description": self.description,
                "script_language": "python",
                "script_source": script_source,
                "script_api_version": API_VERSION,
                "serializer_version": SERIALIZER_VERSION,
                "entrypoint_kind": entrypoint_kind,
                "source_hash": source_hash,
                "runtime_metadata": runtime_metadata,
                "backend_revision": None,
                "seeds": [],
            },
            "geometry": {"entries": [geometry.to_ir() for geometry in geometries]},
            "geometry_assets": geometry_assets,
            "regions": [region.to_ir() for region in regions],
            "object_regions": [
                region.to_ir() for region in object_regions
            ],
            "materials": [material.to_ir() for material in materials],
            "material_parameter_fields": [
                assignment.to_ir()
                for assignment in self._collect_material_parameter_fields()
            ],
            "couplings": [coupling.to_ir() for coupling in self.couplings],
            "planar_monitors": [monitor.to_ir() for monitor in self.monitors],
            "field_drives": [drive.to_ir() for drive in self.field_drives],
            "magnets": magnets_ir,
            "selections": [selection.to_ir() for selection in self.selections],
            "magnetization_constraints": [
                constraint.to_ir(selections=self.selections)
                for constraint in self._collect_magnetization_constraints()
            ],
            "energy_terms": [term.to_ir() for term in self.energy],
            "current_modules": [module.to_ir() for module in self.current_modules],
            "spin_transport_modules": _spin_transport_modules_ir(self),
            # Presence/scope/activation is canonical and independent of the
            # constitutive family payloads above.
            "physics_graph": build_physics_graph(self).to_ir(),
            "excitation_analysis": self.excitation_analysis.to_ir()
            if self.excitation_analysis is not None
            else None,
            "study": self.study.to_ir(),
            "backend_policy": {
                "requested_backend": runtime.backend_target.value,
                "execution_precision": runtime.execution_precision.value,
                "discretization_hints": discretization.to_ir() if discretization else None,
            },
            "validation_profile": {"execution_mode": runtime.execution_mode.value},
            # Spin-torque family
            **spin_torque_payload,
            # Temperature
            **({
                "temperature": self.temperature,
            } if self.temperature is not None else {}),
            # Magnetoelastic extensions
            "elastic_materials": [em.to_ir() for em in self.elastic_materials],
            "elastic_bodies": [eb.to_ir() for eb in self.elastic_bodies],
            "magnetostriction_laws": [ml.to_ir() for ml in self.magnetostriction_laws],
            "mechanical_bcs": [bc.to_ir() for bc in self.mechanical_bcs],
            "mechanical_loads": [ml.to_ir() for ml in self.mechanical_loads],
            # Periodic boundary conditions
            **({"pbc": pbc_ir} if pbc_ir is not None else {}),
        }
        if physics_objects:
            result["physics_objects"] = physics_objects
        return result

    def _collect_magnetization_constraints(self) -> tuple[FrozenSpins, ...]:
        collected: list[FrozenSpins] = list(self.magnetization_constraints)
        study_constraints = getattr(self.study, "constraints", ())
        collected.extend(study_constraints)
        for magnet in self.magnets:
            collected.extend(magnet._magnetization_constraints)
            for region in magnet.object_regions:
                collected.extend(region._magnetization_constraints)
        return tuple(collected)

    def _validate_magnetization_constraints(self) -> None:
        if any(not isinstance(selection, SelectionDefinition) for selection in self.selections):
            raise TypeError("Problem.selections must contain SelectionDefinition objects")
        ensure_unique_names(
            (selection.selection_id for selection in self.selections),
            "selection ids",
        )
        constraints = self._collect_magnetization_constraints()
        if any(not isinstance(constraint, FrozenSpins) for constraint in constraints):
            raise TypeError(
                "Problem.magnetization_constraints must contain FrozenSpins objects"
            )
        ids: set[str] = set()
        object_ids = {
            magnet.object_id for magnet in self.magnets if magnet.object_id is not None
        }
        region_ids = {
            (region.owner_object, region.region_id)
            for region in self._collect_object_regions()
        }
        stage_ids = {
            str(node.get("id"))
            for node in (
                self.runtime_metadata.get("study_pipeline", {}).get("nodes", [])
                if isinstance(self.runtime_metadata.get("study_pipeline"), Mapping)
                else []
            )
            if isinstance(node, Mapping) and isinstance(node.get("id"), str)
        }
        has_study_pipeline = isinstance(
            self.runtime_metadata.get("study_pipeline"), Mapping
        )
        definitions = {selection.selection_id: selection.to_ir() for selection in self.selections}
        for selection in self.selections:
            _validate_constraint_selector_references(
                selection.expression.to_ir(),
                definitions,
                object_ids,
                region_ids,
                frozenset({selection.selection_id}),
            )
        for constraint in constraints:
            if constraint.id in ids:
                raise ValueError(
                    f"duplicate magnetization constraint id {constraint.id!r}"
                )
            ids.add(constraint.id)
            _validate_constraint_selector_references(
                constraint.selector.to_ir(), definitions, object_ids, region_ids
            )
            payload = constraint.to_ir(selections=self.selections)
            activation = payload["activation"]
            if activation["kind"] == "stage_ids" and has_study_pipeline:
                for stage_id in activation["stage_ids"]:
                    if stage_id not in stage_ids:
                        raise ValueError(
                            f"magnetization constraint {constraint.id!r} activation stage id {stage_id!r} does not exist"
                        )

    def _resolve_discretization(
        self,
        requested_backend: BackendTarget,
    ) -> DiscretizationHints | None:
        if self.discretization is None:
            return None

        if requested_backend != BackendTarget.FEM:
            return self.discretization
        if self.discretization.fem is not None:
            return self.discretization

        fdm = self.discretization.fdm
        if fdm is None or fdm.default_cell is None:
            return self.discretization

        # Bootstrap policy: when the user requests FEM but only provides an
        # FDM reference cell, derive a first mesh size from the finest FDM
        # spacing. This keeps one script runnable on both backends, while more
        # advanced meshing controls remain an explicit FEM API feature.
        derived_fem = FEM(order=1, maximum_element_size=min(fdm.default_cell))
        return DiscretizationHints(
            fdm=self.discretization.fdm,
            fem=derived_fem,
            hybrid=self.discretization.hybrid,
        )

    def _normalize_study(self) -> TimeEvolution | Relaxation | Eigenmodes | FrequencyResponse:
        if self.study is not None and (self.dynamics is not None or self.outputs is not None):
            raise ValueError(
                "Problem accepts either study=... or the legacy dynamics=... and outputs=... shape, not both"
            )
        if self.study is not None:
            return self.study
        if self.dynamics is None:
            raise ValueError("Problem requires study=... or legacy dynamics=...")
        if not self.outputs:
            raise ValueError("Problem requires study outputs or legacy outputs=...")
        return TimeEvolution(dynamics=self.dynamics, outputs=self.outputs)

    def _collect_geometries(self) -> list[object]:
        geometries: list[object] = []
        seen: set[str] = set()
        for magnet in self.magnets:
            name = magnet.geometry.geometry_name
            if name not in seen:
                geometries.append(magnet.geometry)
                seen.add(name)
        for geometry in self.auxiliary_geometries:
            name = geometry.geometry_name
            if name not in seen:
                geometries.append(geometry)
                seen.add(name)
        return geometries

    def _validate_geometry_consistency(self) -> None:
        seen: dict[str, dict[str, object]] = {}
        for magnet in self.magnets:
            geometry = magnet.geometry
            geometry_ir = geometry.to_ir()
            if geometry.geometry_name in seen and seen[geometry.geometry_name] != geometry_ir:
                raise ValueError(
                    f"geometry '{geometry.geometry_name}' is defined multiple times with different values"
                )
            seen[geometry.geometry_name] = geometry_ir
        for geometry in self.auxiliary_geometries:
            geometry_ir = geometry.to_ir()
            if geometry.geometry_name in seen and seen[geometry.geometry_name] != geometry_ir:
                raise ValueError(
                    f"geometry '{geometry.geometry_name}' is defined multiple times with different values"
                )
            seen[geometry.geometry_name] = geometry_ir

    def _collect_materials(self) -> list[Material]:
        materials: list[Material] = []
        seen: set[str] = set()
        for magnet in self.magnets:
            if magnet.material.name not in seen:
                materials.append(magnet.material)
                seen.add(magnet.material.name)
        return materials

    def _validate_material_consistency(self) -> None:
        seen: dict[str, dict[str, object]] = {}
        for magnet in self.magnets:
            material_ir = magnet.material.to_ir()
            if magnet.material.name in seen and seen[magnet.material.name] != material_ir:
                raise ValueError(
                    f"material '{magnet.material.name}' is defined multiple times with different values"
                )
            seen[magnet.material.name] = material_ir

    def _collect_regions(self) -> list[Region]:
        regions: list[Region] = []
        seen: set[str] = set()
        for magnet in self.magnets:
            if magnet.region is not None:
                region = magnet.region
            else:
                region = Region(name=magnet.region_name, geometry=magnet.geometry)
            if region.name not in seen:
                regions.append(region)
                seen.add(region.name)
        for geometry in self.auxiliary_geometries:
            geometry_name = geometry.geometry_name
            role = self.auxiliary_geometry_roles.get(geometry_name)
            if role is None or role == "antenna" or geometry_name in seen:
                continue
            regions.append(Region(name=geometry_name, geometry=geometry))
            seen.add(geometry_name)
        return regions

    def _collect_object_regions(self) -> list[ObjectRegion]:
        regions: list[ObjectRegion] = []
        seen: set[str] = set()
        for magnet in self.magnets:
            for region in magnet.object_regions:
                if region.region_id in seen:
                    raise ValueError(
                        f"object region_id '{region.region_id}' is defined multiple times"
                    )
                regions.append(region)
                seen.add(region.region_id)
        return regions

    def _collect_material_parameter_fields(self) -> list[MaterialParameterAssignment]:
        assignments: list[MaterialParameterAssignment] = []
        seen: set[str] = set()
        for magnet in self.magnets:
            for assignment in magnet.material_parameter_fields:
                if assignment.assignment_id in seen:
                    raise ValueError(
                        f"material parameter assignment_id '{assignment.assignment_id}' is defined multiple times"
                    )
                assignments.append(assignment)
                seen.add(assignment.assignment_id)
        return assignments

    def _validate_region_consistency(self) -> None:
        seen: dict[str, str] = {}
        for magnet in self.magnets:
            region_name = magnet.region_name
            geometry_name = magnet.geometry.geometry_name
            if region_name in seen and seen[region_name] != geometry_name:
                raise ValueError(
                    f"region '{region_name}' is bound to conflicting geometries"
                )
            seen[region_name] = geometry_name
        for geometry in self.auxiliary_geometries:
            geometry_name = geometry.geometry_name
            role = self.auxiliary_geometry_roles.get(geometry_name)
            if role not in {"conductor", "electrode", "geometry"}:
                continue
            if geometry_name in seen and seen[geometry_name] != geometry_name:
                raise ValueError(
                    f"region '{geometry_name}' is bound to conflicting geometries"
                )
            seen[geometry_name] = geometry_name

    def _build_geometry_assets(
        self,
        *,
        requested_backend: BackendTarget,
        geometries: Sequence[object],
        discretization: DiscretizationHints | None,
        asset_cache: dict[str, dict[str, Any] | None] | None = None,
    ) -> dict[str, Any] | None:
        return build_geometry_assets_for_request(
            requested_backend=requested_backend,
            geometries=geometries,
            discretization=discretization,
            per_object_recipes={
                magnet.geometry.geometry_name: magnet.mesh
                for magnet in self.magnets
                if isinstance(magnet.mesh, PerObjectMeshRecipe)
            },
            mesh_workflow=(
                self.runtime_metadata.get("mesh_workflow")
                if isinstance(self.runtime_metadata.get("mesh_workflow"), dict)
                else None
            ),
            asset_cache=asset_cache,
        )

    def _resolve_geometry_sources(
        self,
        geometry: object,
        *,
        source_root: str | Path | None,
    ) -> object:
        return resolve_geometry_sources(geometry, source_root=source_root)
