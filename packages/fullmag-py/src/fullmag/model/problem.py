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

from fullmag._progress import emit_progress
from fullmag._validation import ensure_unique_names, require_non_empty
from fullmag.model.discretization import DiscretizationHints, FEM
from fullmag.model.dynamics import LLG
from fullmag.model.energy import Demag, Exchange, InterfacialDMI, Zeeman
from fullmag.model.outputs import SaveField, SaveScalar, Snapshot
from fullmag.model.structure import Ferromagnet, Material, Region
from fullmag.model.study import Relaxation, TimeEvolution

IR_VERSION = "0.2.0"
API_VERSION = "0.2.0"
SERIALIZER_VERSION = "0.2.0"

_FEM_MESH_CACHE_VERSION = "v3"


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


def _fem_mesh_cache_key(geometry: object, hints: FEM) -> str:
    payload = {
        "version": _FEM_MESH_CACHE_VERSION,
        "geometry": _geometry_cache_fingerprint(geometry),
        "fem": hints.to_ir(),
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
        )
    return geometry


def build_geometry_assets_for_request(
    *,
    requested_backend: "BackendTarget",
    geometries: Sequence[object],
    discretization: DiscretizationHints | None,
    asset_cache: dict[str, dict[str, Any] | None] | None = None,
) -> dict[str, Any] | None:
    if discretization is None:
        return None

    asset_cache_key = json.dumps(
        {
            "requested_backend": requested_backend.value,
            "geometries": [geometry.to_ir() for geometry in geometries],
            "discretization": discretization.to_ir(),
        },
        sort_keys=True,
    )
    if asset_cache is not None and asset_cache_key in asset_cache:
        cached = asset_cache[asset_cache_key]
        return copy.deepcopy(cached)

    assets: dict[str, list[dict[str, object]]] = {
        "fdm_grid_assets": [],
        "fem_mesh_assets": [],
    }

    if discretization.fdm is not None:
        from fullmag.model.geometry import Cylinder, ImportedGeometry
        from fullmag.meshing import realize_fdm_grid_asset

        for geometry in geometries:
            if isinstance(geometry, (Cylinder, ImportedGeometry)):
                asset = realize_fdm_grid_asset(geometry, discretization.fdm)
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
        from fullmag.meshing import realize_fem_mesh_asset
        from fullmag.meshing.gmsh_bridge import MeshData

        fem_mesh_cache_dir = _fem_mesh_cache_dir()

        for geometry in geometries:
            mesh_source = discretization.fem.mesh
            if mesh_source is None and isinstance(geometry, ImportedGeometry):
                mesh_source = geometry.source
            if mesh_source is not None and mesh_source.lower().endswith(".json"):
                emit_progress(
                    f"Preparing FEM mesh asset for '{geometry.geometry_name}' from MeshIR JSON"
                )
                assets["fem_mesh_assets"].append(
                    {
                        "geometry_name": geometry.geometry_name,
                        "mesh_source": mesh_source,
                    }
                )
            else:
                mesh_cache_key = _fem_mesh_cache_key(geometry, discretization.fem)
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
                    mesh = realize_fem_mesh_asset(geometry, discretization.fem)
                    if cache_path is not None:
                        mesh.save(cache_path)
                        emit_progress(
                            f"Cached FEM mesh for '{geometry.geometry_name}'"
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

    if not assets["fdm_grid_assets"] and not assets["fem_mesh_assets"]:
        result = None
    else:
        result = assets

    if asset_cache is not None:
        asset_cache[asset_cache_key] = copy.deepcopy(result)

    return result


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
            warnings.warn(
                f"cpu_threads={self.cpu_threads} requested but parallel CPU execution is not yet "
                "implemented — the simulation will run single-threaded",
                stacklevel=2,
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


EnergyTerm = Exchange | Demag | InterfacialDMI | Zeeman
OutputSpec = SaveField | SaveScalar | Snapshot


@dataclass(frozen=True, slots=True)
class Problem:
    name: str
    magnets: Sequence[Ferromagnet]
    energy: Sequence[EnergyTerm]
    study: TimeEvolution | Relaxation | None = None
    dynamics: LLG | None = None
    outputs: Sequence[OutputSpec] | None = None
    discretization: DiscretizationHints | None = None
    description: str | None = None
    runtime: RuntimeSelection = field(default_factory=RuntimeSelection)
    runtime_metadata: dict[str, object] = field(default_factory=dict)
    geometry_asset_cache: dict[str, dict[str, Any] | None] = field(
        default_factory=dict,
        repr=False,
        compare=False,
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        if not self.magnets:
            raise ValueError("Problem requires at least one magnet")
        if not self.energy:
            raise ValueError("Problem requires at least one energy term")

        normalized_study = self._normalize_study()
        object.__setattr__(self, "study", normalized_study)

        ensure_unique_names((magnet.name for magnet in self.magnets), "magnet names")
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
    ) -> dict[str, object]:
        runtime = self.runtime.resolved(
            backend=requested_backend,
            mode=execution_mode,
            precision=execution_precision,
        )
        materials = self._collect_materials()
        regions = self._collect_regions()
        geometries = [
            resolve_geometry_sources(geometry, source_root=source_root)
            for geometry in self._collect_geometries()
        ]
        discretization = self._resolve_discretization(runtime.backend_target)
        source_hash = sha256(script_source.encode("utf-8")).hexdigest() if script_source else None
        effective_asset_cache = asset_cache if asset_cache is not None else self.geometry_asset_cache
        geometry_assets = build_geometry_assets_for_request(
            requested_backend=runtime.backend_target,
            geometries=geometries,
            discretization=discretization,
            asset_cache=effective_asset_cache,
        )
        runtime_metadata = dict(self.runtime_metadata)
        runtime_metadata["runtime_selection"] = runtime.to_runtime_metadata()
        if self.discretization is not None and discretization is not self.discretization:
            runtime_metadata["derived_discretization"] = {
                "policy": "fem_from_fdm_cell",
                "fem": discretization.fem.to_ir() if discretization.fem else None,
            }

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
            "materials": [material.to_ir() for material in materials],
            "magnets": [magnet.to_ir() for magnet in self.magnets],
            "energy_terms": [term.to_ir() for term in self.energy],
            "study": self.study.to_ir(),
            "backend_policy": {
                "requested_backend": runtime.backend_target.value,
                "execution_precision": runtime.execution_precision.value,
                "discretization_hints": discretization.to_ir() if discretization else None,
            },
            "validation_profile": {"execution_mode": runtime.execution_mode.value},
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
        derived_fem = FEM(order=1, hmax=min(fdm.default_cell))
        return DiscretizationHints(
            fdm=self.discretization.fdm,
            fem=derived_fem,
            hybrid=self.discretization.hybrid,
        )

    def _normalize_study(self) -> TimeEvolution | Relaxation:
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
            asset_cache=asset_cache,
        )

    def _resolve_geometry_sources(
        self,
        geometry: object,
        *,
        source_root: str | Path | None,
    ) -> object:
        return resolve_geometry_sources(geometry, source_root=source_root)
