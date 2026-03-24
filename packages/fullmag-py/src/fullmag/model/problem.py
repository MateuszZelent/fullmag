from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from hashlib import sha256
from typing import Any, Sequence

from fullmag._validation import ensure_unique_names, require_non_empty
from fullmag.model.discretization import DiscretizationHints
from fullmag.model.dynamics import LLG
from fullmag.model.energy import Demag, Exchange, InterfacialDMI, Zeeman
from fullmag.model.outputs import SaveField, SaveScalar
from fullmag.model.structure import Ferromagnet, Material, Region
from fullmag.model.study import TimeEvolution

IR_VERSION = "0.2.0"
API_VERSION = "0.2.0"
SERIALIZER_VERSION = "0.2.0"
IR_VERSION = "0.2.0"
API_VERSION = "0.2.0"
SERIALIZER_VERSION = "0.2.0"


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


EnergyTerm = Exchange | Demag | InterfacialDMI | Zeeman
OutputSpec = SaveField | SaveScalar


@dataclass(frozen=True, slots=True)
class Problem:
    name: str
    magnets: Sequence[Ferromagnet]
    energy: Sequence[EnergyTerm]
    study: TimeEvolution | None = None
    dynamics: LLG | None = None
    outputs: Sequence[OutputSpec] | None = None
    discretization: DiscretizationHints | None = None
    description: str | None = None
    runtime_metadata: dict[str, object] = field(default_factory=dict)

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
        requested_backend: BackendTarget = BackendTarget.AUTO,
        execution_mode: ExecutionMode = ExecutionMode.STRICT,
        execution_precision: ExecutionPrecision = ExecutionPrecision.DOUBLE,
        script_source: str | None = None,
        entrypoint_kind: str = "direct",
    ) -> dict[str, object]:
        materials = self._collect_materials()
        regions = self._collect_regions()
        geometries = self._collect_geometries()
        geometries = self._collect_geometries()
        source_hash = sha256(script_source.encode("utf-8")).hexdigest() if script_source else None
        geometry_assets = self._build_geometry_assets(
            requested_backend=requested_backend,
            geometries=geometries,
        )

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
                "runtime_metadata": self.runtime_metadata,
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
                "requested_backend": requested_backend.value,
                "execution_precision": execution_precision.value,
                "discretization_hints": self.discretization.to_ir() if self.discretization else None,
            },
            "validation_profile": {"execution_mode": execution_mode.value},
        }

    def _normalize_study(self) -> TimeEvolution:
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
    ) -> dict[str, Any] | None:
        if self.discretization is None:
            return None

        assets: dict[str, list[dict[str, object]]] = {
            "fdm_grid_assets": [],
            "fem_mesh_assets": [],
        }

        if self.discretization.fdm is not None:
            from fullmag.model.geometry import Cylinder, ImportedGeometry
            from fullmag.meshing import realize_fdm_grid_asset

            for geometry in geometries:
                if isinstance(geometry, (Cylinder, ImportedGeometry)):
                    asset = realize_fdm_grid_asset(geometry, self.discretization.fdm)
                    assets["fdm_grid_assets"].append(asset.to_ir(geometry.geometry_name))

        should_build_fem_assets = (
            requested_backend == BackendTarget.FEM
            or (
                requested_backend == BackendTarget.AUTO
                and self.discretization.fem is not None
                and self.discretization.fem.mesh is not None
            )
        )

        if should_build_fem_assets and self.discretization.fem is not None:
            from fullmag._core import validate_mesh_ir
            from fullmag.model.geometry import ImportedGeometry
            from fullmag.meshing import realize_fem_mesh_asset

            for geometry in geometries:
                mesh = realize_fem_mesh_asset(geometry, self.discretization.fem)
                mesh_ir = mesh.to_ir(geometry.geometry_name)
                is_valid = validate_mesh_ir(mesh_ir)
                if is_valid is False:
                    raise ValueError(f"generated mesh asset for '{geometry.geometry_name}' failed Rust validation")
                mesh_source = self.discretization.fem.mesh
                if mesh_source is None and isinstance(geometry, ImportedGeometry):
                    mesh_source = geometry.source
                assets["fem_mesh_assets"].append(
                    {
                        "geometry_name": geometry.geometry_name,
                        "mesh_source": mesh_source,
                        "mesh": mesh_ir,
                    }
                )

        if not assets["fdm_grid_assets"] and not assets["fem_mesh_assets"]:
            return None
        return assets
