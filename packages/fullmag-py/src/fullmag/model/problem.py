from __future__ import annotations

import copy
import json
import os
import warnings
from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import Any, Sequence

from fullmag._progress import emit_progress, emit_progress_event
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
from fullmag.model.current_transport import CurrentTransport
from fullmag.model.discretization import DiscretizationHints, FEM
from fullmag.model.dynamics import LLG
from fullmag.model.domain_frame import build_domain_frame, geometry_bounds
from fullmag.model.energy import BulkDMI, Constant, CubicAnisotropy, Demag, Exchange, InterfacialDMI, Magnetoelastic, OerstedField, OerstedCylinder, PiecewiseLinear, ThermalNoise, UniaxialAnisotropy, Zeeman
from fullmag.model.spin_torque import LegacySpinTorque, SpinTorqueModule
from fullmag.model.mechanics import (
    ElasticBody,
    ElasticMaterial,
    MagnetostrictionLaw,
    MechanicalBoundaryCondition,
    MechanicalLoad,
)
from fullmag.model.outputs import (
    SaveDispersion,
    SaveField,
    SaveMode,
    SaveScalar,
    SaveSpectrum,
    Snapshot,
)
from fullmag.model.structure import (
    Ferromagnet,
    Material,
    MaterialParameterAssignment,
    ObjectRegion,
    Region,
)
from fullmag.model.study import Eigenmodes, FrequencyResponse, Relaxation, TimeEvolution

IR_VERSION = "0.2.0"
API_VERSION = "0.2.0"
SERIALIZER_VERSION = "0.2.0"

_FEM_MESH_CACHE_VERSION = "v5"


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
) -> str:
    payload = {
        "version": _FEM_MESH_CACHE_VERSION,
        "geometry": _geometry_cache_fingerprint(geometry),
        "fem": hints.to_ir(),
        "study_universe": study_universe,
        "mesh_workflow": mesh_workflow,
    }
    return sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()


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
    object_regions: Sequence[dict[str, object]] | None = None,
    asset_cache: dict[str, dict[str, Any] | None] | None = None,
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
        object_regions=object_regions,
        fdm_only=fdm_only,
    )
    if asset_cache is not None and asset_cache_key in asset_cache:
        cached = asset_cache[asset_cache_key]
        return copy.deepcopy(cached)

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
            assets["fem_domain_mesh_asset"] = {
                "mesh_source": explicit_domain_mesh_source,
                "mesh": None,
                "region_markers": explicit_domain_region_markers,
                "object_region_markers": explicit_domain_object_region_markers or [],
            }
        elif study_universe is not None:
            authored_regions = list(object_regions or [])
            domain_mesh, region_markers, build_report = (
                realize_fem_domain_mesh_asset_from_components_with_report(
                    list(geometries),
                    discretization.fem,
                    study_universe=study_universe,
                    mesh_workflow=mesh_workflow,
                    object_regions=authored_regions,
                )
            )
            domain_mesh_ir = domain_mesh.to_ir("study_domain")
            is_valid = validate_mesh_ir(domain_mesh_ir)
            if is_valid is False:
                raise ValueError(
                    "generated shared FEM domain mesh asset failed Rust validation"
                )
            domain_asset = {
                "mesh_source": None,
                "mesh": domain_mesh_ir,
                "region_markers": region_markers,
                "object_region_markers": (
                    build_report.object_region_markers
                    if build_report is not None
                    else []
                ),
            }
            if build_report is not None:
                domain_asset["build_report"] = build_report.to_dict()
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
        asset_cache[asset_cache_key] = copy.deepcopy(result)

    return result


def _geometry_asset_cache_key(
    *,
    requested_backend: "BackendTarget",
    geometries: Sequence[object],
    discretization: DiscretizationHints,
    study_universe: dict[str, object] | None,
    mesh_workflow: dict[str, object] | None,
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


EnergyTerm = Exchange | Demag | InterfacialDMI | BulkDMI | Zeeman | Magnetoelastic | UniaxialAnisotropy | OerstedCylinder | OerstedField | CubicAnisotropy | ThermalNoise
CurrentModule = AntennaFieldSource | CurrentTransport
LegacyOutputSpec = SaveField | SaveScalar | Snapshot
OutputSpec = LegacyOutputSpec | SaveSpectrum | SaveMode | SaveDispersion


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
    current_modules: Sequence[CurrentModule] = ()
    field_drives: Sequence[RegionalFieldDrive] = ()
    couplings: Sequence[Coupling] = ()
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
    # Temperature for Brown thermal field [K] (optional, 0 = no noise)
    temperature: float | None = None
    # Magnetoelastic (optional)
    elastic_materials: Sequence[ElasticMaterial] = ()
    elastic_bodies: Sequence[ElasticBody] = ()
    magnetostriction_laws: Sequence[MagnetostrictionLaw] = ()
    mechanical_bcs: Sequence[MechanicalBoundaryCondition] = ()
    mechanical_loads: Sequence[MechanicalLoad] = ()

    # Periodic boundary conditions (per-axis, for FDM)
    pbc: FdmPbc | tuple[bool, bool, bool] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        if not self.magnets:
            raise ValueError("Problem requires at least one magnet")
        if not self.energy:
            raise ValueError("Problem requires at least one energy term")

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
        object.__setattr__(self, "spin_torques", normalized_spin_torques)

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
        current_modules_by_name = _current_module_name_map(self.current_modules)
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
                object_regions=object_region_mesh_specs,
                asset_cache=effective_asset_cache,
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

        return {
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
            "magnets": magnets_ir,
            "energy_terms": [term.to_ir() for term in self.energy],
            "current_modules": [module.to_ir() for module in self.current_modules],
            "field_drives": [drive.to_ir() for drive in self.field_drives],
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
            **({"pbc": pbc_ir} if (pbc_ir := _pbc_to_ir(self.pbc)) is not None else {}),
        }

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
