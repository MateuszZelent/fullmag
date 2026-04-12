"""Flat mumax-inspired scripting API.

Provides global-state convenience functions that build a ``Problem`` internally.
Advanced users and multi-magnet problems can still use the class-based API directly.

Usage::

    import fullmag as fm

    fm.engine("fdm")
    fm.device("cuda:0")
    fm.cell(5e-9, 5e-9, 10e-9)

    layer = fm.geometry(fm.Box(1000e-9, 1000e-9, 10e-9))
    layer.Ms    = 800e3
    layer.Aex   = 13e-12
    layer.alpha = 0.5
    layer.m     = fm.uniform(1, 0, 0)

    fm.save("m", every=50e-12)
    fm.run(5e-10)

Multi-magnet example::

    py = fm.geometry(fm.Box(1000e-9, 1000e-9, 10e-9), name="py")
    py.Ms = 800e3; py.Aex = 13e-12; py.alpha = 0.5

    co = fm.geometry(fm.Box(1000e-9, 1000e-9, 5e-9).translate(0, 0, 7.5e-9), name="co")
    co.Ms = 1400e3; co.Aex = 30e-12; co.alpha = 0.02
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from fullmag._progress import emit_progress
from fullmag._validation import as_vector3, require_non_empty, require_non_negative, require_positive
from fullmag.model.antenna import (
    AntennaFieldSource,
    Antenna,
    RfDrive,
    SpinWaveExcitationAnalysis,
)
from fullmag.model.energy import Demag, Exchange, InterfacialDMI, Zeeman
from fullmag.model.dynamics import AdaptiveTimestep, DEFAULT_GAMMA, LLG
from fullmag.model.outputs import SaveField, SaveScalar, SaveSpectrum, SaveMode, SaveDispersion, Snapshot, parse_snapshot_quantity
from fullmag.model.study import Eigenmodes, Relaxation, TimeEvolution
from fullmag.model.structure import Ferromagnet, Material, Region
from fullmag.model.problem import (
    BackendTarget,
    build_geometry_assets_for_request,
    DeviceTarget,
    DiscretizationHints,
    ExecutionMode,
    ExecutionPrecision,
    Problem,
    resolve_geometry_sources,
    RuntimeSelection,
)
from fullmag.model.discretization import FDM, FEM

_MESH_SIZE_CALIBRATIONS = ("general_physics",)
_MESH_SIZE_PRESET_ALIASES = {
    "extra fine": "extra_fine",
    "extrafine": "extra_fine",
    "very_fine": "extra_fine",
}
_MESH_SIZE_PRESETS = ("coarse", "normal", "fine", "finer", "extra_fine")


def _normalize_mesh_calibration(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return None
    if normalized not in _MESH_SIZE_CALIBRATIONS:
        raise ValueError(
            f"calibrate_for must be one of {_MESH_SIZE_CALIBRATIONS!r}, got {value!r}"
        )
    return normalized


def _normalize_mesh_preset(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower().replace("-", "_")
    if not normalized:
        return None
    normalized = _MESH_SIZE_PRESET_ALIASES.get(normalized, normalized)
    if normalized not in _MESH_SIZE_PRESETS:
        raise ValueError(f"size_preset must be one of {_MESH_SIZE_PRESETS!r}, got {value!r}")
    return normalized


# ---------------------------------------------------------------------------
# Magnet handle — returned by fm.geometry()
# ---------------------------------------------------------------------------

class MagnetHandle:
    """Per-magnet configuration handle.

    Returned by ``fm.geometry()``. Assign material properties directly::

        layer = fm.geometry(fm.Box(1e-6, 1e-6, 1e-8))
        layer.Ms    = 800e3
        layer.Aex   = 13e-12
        layer.alpha = 0.5
        layer.m     = fm.uniform(1, 0, 0)
    """

    def __init__(self, shape: object, name: str = "body") -> None:
        self._shape = shape
        self._name = name
        self.region_name: str | None = None
        self.Ms: float | None = None
        self.Aex: float | None = None
        self.alpha: float = 0.01
        self.Dind: float | None = None
        self.Ku1: float | None = None
        self.anisU: tuple[float, float, float] | None = None
        self._m_value: Any = None
        self._m_proxy = MagnetizationHandle(self)
        self._mesh_spec = _MeshSpecState()
        self._last_mesh_quality: object | None = None
        self.mesh = GeometryMeshHandle(self)

    def __repr__(self) -> str:
        return f"MagnetHandle({self._name!r}, Ms={self.Ms}, Aex={self.Aex}, m={self._m_value!r})"

    @property
    def m(self) -> "MagnetizationHandle":
        return self._m_proxy

    @m.setter
    def m(self, value: Any) -> None:
        self._m_value = value

    def _resolved_geometry(self) -> object:
        """Return geometry with a stable per-magnet geometry asset name."""
        geom = self._shape
        if hasattr(geom, "name"):
            import copy

            geom = copy.copy(geom)
            object.__setattr__(geom, "name", f"{self._name}_geom")
        return geom

    def _to_ferromagnet(self) -> Ferromagnet:
        """Convert to class-based Ferromagnet."""
        if self.Ms is None:
            raise ValueError(f"Magnet '{self._name}': Ms not set")
        if self.Aex is None:
            raise ValueError(f"Magnet '{self._name}': Aex not set")

        mat = Material(
            name=f"mat_{self._name}",
            Ms=self.Ms,
            A=self.Aex,
            alpha=self.alpha,
            Ku1=self.Ku1,
            anisU=as_vector3(self.anisU, "anisU") if self.anisU is not None else None,
        )

        if self._m_value is None:
            from fullmag.init.magnetization import UniformMagnetization
            m0 = UniformMagnetization((1, 0, 0))
        else:
            m0 = self._m_value

        resolved_geometry = self._resolved_geometry()
        region_name = require_non_empty(self.region_name, "region_name") if self.region_name else None
        region = (
            Region(name=region_name, geometry=resolved_geometry)
            if region_name is not None
            else None
        )

        return Ferromagnet(
            name=self._name,
            geometry=resolved_geometry,
            material=mat,
            region=region,
            m0=m0,
        )


class MagnetizationHandle:
    """Mutable magnetization slot bound to one flat-script geometry."""

    def __init__(self, owner: MagnetHandle) -> None:
        self._owner = owner

    @property
    def value(self) -> Any:
        return self._owner._m_value

    def get(self) -> Any:
        return self._owner._m_value

    def set(self, value: Any) -> Any:
        self._owner._m_value = value
        return value

    def clear(self) -> None:
        self._owner._m_value = None

    def loadfile(
        self,
        path: str | Path,
        *,
        format: str = "auto",
        dataset: str | None = None,
        sample: int = -1,
    ):
        from fullmag.init import load_magnetization

        state = load_magnetization(path, format=format, dataset=dataset, sample=sample)
        self._owner._m_value = state
        return state

    def savefile(
        self,
        path: str | Path,
        *,
        format: str = "auto",
        dataset: str = "values",
    ) -> Path:
        from fullmag.init import SampledMagnetization, save_magnetization

        value = self._owner._m_value
        if value is None:
            raise ValueError("magnetization slot is empty")
        if not isinstance(value, SampledMagnetization):
            raise ValueError(
                "savefile() requires explicit sampled magnetization data; "
                "save a simulation Result or load a sampled state first"
            )
        return save_magnetization(path, value, format=format, dataset=dataset)

    def __bool__(self) -> bool:
        return self._owner._m_value is not None

    def __repr__(self) -> str:
        return repr(self._owner._m_value)


@dataclass
class _MeshOperationSpec:
    kind: str
    params: dict[str, object] = field(default_factory=dict)


@dataclass
class _MeshSpecState:
    hmax: float | str | None = None
    hmin: float | None = None
    order: int | None = None
    source: str | None = None
    calibrate_for: str | None = None
    size_preset: str | None = None
    build_requested: bool = False
    operations: list[_MeshOperationSpec] = field(default_factory=list)
    # Algorithm
    algorithm_2d: int | None = None
    algorithm_3d: int | None = None
    # Optimization
    optimize_method: str | None = None
    optimize_iterations: int = 1
    smoothing_steps: int = 1
    # Size control
    size_factor: float = 1.0
    size_from_curvature: int = 0
    curvature_factor: float | None = None
    growth_rate: float | None = None
    narrow_regions: int = 0
    narrow_region_resolution: float | None = None
    size_fields: list[dict[str, object]] = field(default_factory=list)
    # Quality
    compute_quality: bool = False
    per_element_quality: bool = False

    def is_configured(self) -> bool:
        return (
            self.hmax is not None
            or self.hmin is not None
            or self.order is not None
            or self.source is not None
            or self.calibrate_for is not None
            or self.size_preset is not None
            or self.algorithm_2d is not None
            or self.algorithm_3d is not None
            or self.optimize_method is not None
            or self.optimize_iterations != 1
            or self.smoothing_steps != 1
            or not math.isclose(self.size_factor, 1.0)
            or self.size_from_curvature != 0
            or self.curvature_factor is not None
            or self.growth_rate is not None
            or self.narrow_regions != 0
            or self.narrow_region_resolution is not None
            or self.compute_quality
            or self.per_element_quality
            or bool(self.size_fields)
            or bool(self.operations)
        )


class GeometryMeshHandle:
    """Explicit mesh workflow API bound to one flat-script geometry/magnet.

    Usage::

        flower = fm.geometry(fm.ImportedGeometry(source="nanoflower.stl"))
        flower.mesh(hmax=5e-9, algorithm_3d=10, optimize="Netgen")
        flower.mesh.size_field("Ball", VIn=1e-9, VOut=5e-9, Radius=20e-9)
        flower.mesh.build()
        report = flower.mesh.quality()
    """

    def __init__(self, owner: MagnetHandle) -> None:
        self._owner = owner

    def __call__(
        self,
        *,
        hmax: float | str | None = None,
        hmin: float | None = None,
        order: int | None = None,
        source: str | None = None,
        calibrate_for: str | None = None,
        size_preset: str | None = None,
        algorithm_2d: int | None = None,
        algorithm_3d: int | None = None,
        optimize: str | None = None,
        optimize_iterations: int | None = None,
        smoothing_steps: int | None = None,
        size_factor: float | None = None,
        size_from_curvature: int | None = None,
        curvature_factor: float | None = None,
        growth_rate: float | None = None,
        narrow_regions: int | None = None,
        narrow_region_resolution: float | None = None,
        compute_quality: bool | None = None,
        per_element_quality: bool | None = None,
    ) -> "GeometryMeshHandle":
        return self.configure(
            hmax=hmax, hmin=hmin, order=order, source=source,
            calibrate_for=calibrate_for, size_preset=size_preset,
            algorithm_2d=algorithm_2d, algorithm_3d=algorithm_3d,
            optimize=optimize, optimize_iterations=optimize_iterations,
            smoothing_steps=smoothing_steps, size_factor=size_factor,
            size_from_curvature=size_from_curvature,
            curvature_factor=curvature_factor,
            growth_rate=growth_rate, narrow_regions=narrow_regions,
            narrow_region_resolution=narrow_region_resolution,
            compute_quality=compute_quality,
            per_element_quality=per_element_quality,
        )

    def configure(
        self,
        *,
        hmax: float | str | None = None,
        hmin: float | None = None,
        order: int | None = None,
        source: str | None = None,
        calibrate_for: str | None = None,
        size_preset: str | None = None,
        algorithm_2d: int | None = None,
        algorithm_3d: int | None = None,
        optimize: str | None = None,
        optimize_iterations: int | None = None,
        smoothing_steps: int | None = None,
        size_factor: float | None = None,
        size_from_curvature: int | None = None,
        curvature_factor: float | None = None,
        growth_rate: float | None = None,
        narrow_regions: int | None = None,
        narrow_region_resolution: float | None = None,
        compute_quality: bool | None = None,
        per_element_quality: bool | None = None,
    ) -> "GeometryMeshHandle":
        """Configure mesh generation parameters.

        Parameters
        ----------
        hmax : float, optional
            Maximum element size (SI metres).
        hmin : float, optional
            Minimum element size (SI metres).
        order : int, optional
            FEM basis order used by the solver (1 = linear, 2 = quadratic).
            The stored mesh topology remains first-order.
        source : str, optional
            Path to external mesh file.
        calibrate_for : str, optional
            High-level calibration profile. Currently ``"general_physics"``.
        size_preset : str, optional
            COMSOL-like size preset: ``"coarse"``, ``"normal"``, ``"fine"``,
            ``"finer"``, or ``"extra_fine"``.
        algorithm_2d : int, optional
            Gmsh 2D meshing algorithm (1=MeshAdapt, 5=Delaunay, 6=Frontal).
        algorithm_3d : int, optional
            Gmsh 3D meshing algorithm (1=Delaunay, 4=Frontal, 7=MMG3D, 10=HXT).
        optimize : str, optional
            Post-mesh optimization: "Netgen", "HighOrder", "Laplace2D", etc.
        optimize_iterations : int, optional
            Number of optimization passes.
        smoothing_steps : int, optional
            Laplacian smoothing steps after meshing.
        size_factor : float, optional
            Global mesh size scaling factor.
        size_from_curvature : int, optional
            Points per 2π curvature (0 = disabled).
        curvature_factor : float, optional
            COMSOL-like curvature refinement factor. Lower values mean stronger
            curvature-based refinement when ``size_from_curvature`` is not set.
        growth_rate : float, optional
            Target growth ratio between neighboring elements (`Mesh.SmoothRatio`).
        narrow_regions : int, optional
            Minimum elements across narrow gaps (0 = disabled).
        narrow_region_resolution : float, optional
            COMSOL-like narrow-gap resolution strength. Higher values mean
            stronger refinement when ``narrow_regions`` is not set.
        compute_quality : bool, optional
            Extract SICN/gamma quality metrics after meshing.
        per_element_quality : bool, optional
            Include per-element quality arrays (for visualization).
        """
        spec = self._owner._mesh_spec
        if hmax is not None:
            if isinstance(hmax, str) and hmax != "auto":
                raise ValueError(f"hmax must be a positive float or \"auto\", got {hmax!r}")
            spec.hmax = hmax
        if hmin is not None:
            spec.hmin = hmin
        if order is not None:
            spec.order = order
        if source is not None:
            spec.source = source
        if calibrate_for is not None:
            spec.calibrate_for = _normalize_mesh_calibration(calibrate_for)
        if size_preset is not None:
            spec.size_preset = _normalize_mesh_preset(size_preset)
        if algorithm_2d is not None:
            spec.algorithm_2d = algorithm_2d
        if algorithm_3d is not None:
            spec.algorithm_3d = algorithm_3d
        if optimize is not None:
            spec.optimize_method = optimize
        if optimize_iterations is not None:
            spec.optimize_iterations = optimize_iterations
        if smoothing_steps is not None:
            spec.smoothing_steps = smoothing_steps
        if size_factor is not None:
            spec.size_factor = size_factor
        if size_from_curvature is not None:
            spec.size_from_curvature = size_from_curvature
        if curvature_factor is not None:
            spec.curvature_factor = float(curvature_factor)
        if growth_rate is not None:
            spec.growth_rate = growth_rate
        if narrow_regions is not None:
            spec.narrow_regions = narrow_regions
        if narrow_region_resolution is not None:
            spec.narrow_region_resolution = float(narrow_region_resolution)
        if compute_quality is not None:
            spec.compute_quality = compute_quality
        if per_element_quality is not None:
            spec.per_element_quality = per_element_quality
        return self

    def algorithm(self, *, dim2: int | None = None, dim3: int | None = None) -> "GeometryMeshHandle":
        """Set meshing algorithms.

        Examples::

            flower.mesh.algorithm(dim3=10)  # HXT for 3D
            flower.mesh.algorithm(dim2=6, dim3=1)  # Frontal-Delaunay 2D, Delaunay 3D
        """
        if dim2 is not None:
            self._owner._mesh_spec.algorithm_2d = dim2
        if dim3 is not None:
            self._owner._mesh_spec.algorithm_3d = dim3
        return self

    def size_field(self, kind: str, **params: object) -> "GeometryMeshHandle":
        """Add a Gmsh mesh size field.

        Examples::

            flower.mesh.size_field("Ball",
                VIn=1e-9, VOut=5e-9,
                Radius=20e-9,
                XCenter=0, YCenter=0, ZCenter=0,
            )
            flower.mesh.size_field("Box", VIn=2e-9, VOut=5e-9,
                XMin=-50e-9, XMax=50e-9,
                YMin=-50e-9, YMax=50e-9,
                ZMin=-5e-9, ZMax=5e-9,
            )
        """
        self._owner._mesh_spec.size_fields.append({"kind": kind, "params": dict(params)})
        return self

    def build(self) -> "GeometryMeshHandle":
        self._owner._mesh_spec.build_requested = True
        if _capture_enabled:
            return self
        _build_explicit_mesh_assets()
        return self

    def optimize(self, method: str | None = None, iterations: int = 1) -> "GeometryMeshHandle":
        self._owner._mesh_spec.operations.append(
            _MeshOperationSpec(
                kind="optimize",
                params={"method": method or "default", "iterations": iterations},
            )
        )
        return self

    def refine(self, steps: int = 1) -> "GeometryMeshHandle":
        self._owner._mesh_spec.operations.append(
            _MeshOperationSpec(kind="refine", params={"steps": steps})
        )
        return self

    def smooth(self, iterations: int = 1) -> "GeometryMeshHandle":
        self._owner._mesh_spec.operations.append(
            _MeshOperationSpec(kind="smooth", params={"iterations": iterations})
        )
        return self

    def quality(self) -> object | None:
        """Return the last quality report if ``compute_quality`` was enabled.

        Returns the ``MeshQualityReport`` from the most recent ``build()`` call,
        or ``None`` if quality extraction was not requested.
        """
        return self._owner._last_mesh_quality


# ---------------------------------------------------------------------------
# Study-root builder metadata
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class StudyUniverseConfig:
    """Study-level world/domain box used by the emerging study builder."""

    mode: str = "auto"
    size: tuple[float, float, float] | None = None
    center: tuple[float, float, float] = (0.0, 0.0, 0.0)
    padding: tuple[float, float, float] = (0.0, 0.0, 0.0)
    airbox_hmax: float | None = None

    def __post_init__(self) -> None:
        if self.mode not in {"auto", "manual"}:
            raise ValueError("universe mode must be 'auto' or 'manual'")
        if self.size is not None:
            normalized_size = as_vector3(self.size, "size")
            for index, component in enumerate(normalized_size):
                require_positive(component, f"size[{index}]")
            object.__setattr__(self, "size", normalized_size)
        object.__setattr__(self, "center", as_vector3(self.center, "center"))
        normalized_padding = as_vector3(self.padding, "padding")
        for index, component in enumerate(normalized_padding):
            require_non_negative(component, f"padding[{index}]")
        object.__setattr__(self, "padding", normalized_padding)
        if self.airbox_hmax is not None:
            object.__setattr__(self, "airbox_hmax", float(self.airbox_hmax))
            require_positive(self.airbox_hmax, "airbox_hmax")
        if self.mode == "manual" and self.size is None:
            raise ValueError("manual universe mode requires an explicit size")

    def to_ir(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "size": list(self.size) if self.size is not None else None,
            "center": list(self.center),
            "padding": list(self.padding),
            "airbox_hmax": self.airbox_hmax,
        }


# ---------------------------------------------------------------------------
# World state singleton
# ---------------------------------------------------------------------------

@dataclass
class _WorldState:
    """Mutable accumulator for the flat API — one per script."""

    # Engine
    _backend: str = "auto"
    _device: str = "auto"
    _gpu_count: int = 0
    _device_index: int | None = None
    _precision: str | None = None
    _boundary_correction: str | None = None  # "none" | "volume" | "full"

    # Grid
    _cell: tuple[float, float, float] | None = None
    _hmax: float | str | None = None
    _fem_order: int = 1
    _mesh_source: str | None = None
    _api_surface: str = "flat"
    _study_universe: StudyUniverseConfig | None = None
    _domain_mesh_source: str | None = None
    _domain_region_markers: list[dict[str, object]] | None = None
    _demag_realization: str | None = None

    # Magnets (ordered)
    _magnets: list[MagnetHandle] = field(default_factory=list)

    # External field
    _b_ext: tuple[float, float, float] | None = None

    # Solver
    _dt: float | None = None
    _max_error: float | None = None
    _integrator: str | None = None
    _gamma: float | None = None
    _interactive: bool = False
    _wait_for_solve: bool = False
    _adaptive_mesh: dict[str, object] | None = None

    # Periodic boundary conditions (per-axis)
    _pbc: tuple[bool, bool, bool] | None = None

    # Outputs
    _outputs: list = field(default_factory=list)
    _current_modules: list[AntennaFieldSource] = field(default_factory=list)
    _excitation_analysis: SpinWaveExcitationAnalysis | None = None
    _last_result: Any | None = None
    _last_step: Any | None = None

    # Problem name
    _name: str = "fullmag_sim"

    # Shared geometry/mesh asset cache for flat scripts.
    _geometry_asset_cache: dict[str, dict[str, object] | None] = field(default_factory=dict)
    _default_mesh_spec: _MeshSpecState = field(default_factory=_MeshSpecState)
    _script_source_root: Path | None = None


# Module-level singleton
_state = _WorldState()
_capture_enabled = False
_capture_skip_geometry_assets = False


@dataclass(frozen=True, slots=True)
class CapturedStage:
    problem: Problem
    entrypoint_kind: str
    default_until_seconds: float | None = None


_captured_stages: list[CapturedStage] = []

_MU_0 = 4.0e-7 * math.pi
_MU_B = 9.274_010_078_3e-24
_HBAR = 1.054_571_817e-34


_SCALAR_QUANTITY_ATTRS: Mapping[str, str] = {
    "E_ex": "e_ex",
    "E_demag": "e_demag",
    "E_ext": "e_ext",
    "E_ani": "e_ani",
    "E_dmi": "e_dmi",
    "E_total": "e_total",
    "mx": "mx",
    "my": "my",
    "mz": "mz",
    "max_dm_dt": "max_dm_dt",
    "max_h_eff": "max_h_eff",
    "max_h_demag": "max_h_demag",
}
_VECTOR_QUANTITIES = {
    "m",
    "H_ex",
    "H_demag",
    "H_ext",
    "H_ant",
    "H_eff",
    "H_ani",
    "H_dmi",
    "H_mel",
    "H_ani_cubic",
    "H_dmi_bulk",
    "H_oe",
    "H_therm",
    # Second wave (QB-17)
    "dm_dt",
    "torque_stt",
    "torque_sot",
    # Legacy B-field aliases
    "B_exch",
    "B_demag",
    "B_ext",
    "B_eff",
}
_VECTOR_COMPONENTS = {"x": 0, "y": 1, "z": 2, "0": 0, "1": 1, "2": 2}
_B_ALIAS_TO_H = {
    "B_exch": "H_ex",
    "B_demag": "H_demag",
    "B_ext": "H_ext",
    "B_eff": "H_eff",
}


def _normalize_quantity_name(quantity: str) -> str:
    key = str(quantity).strip()
    lowered = key.lower()
    for candidate in _SCALAR_QUANTITY_ATTRS:
        if candidate.lower() == lowered:
            return candidate
    for candidate in _VECTOR_QUANTITIES:
        if candidate.lower() == lowered:
            return candidate
    raise ValueError(f"Unsupported quantity {quantity!r}")


def _latest_result():
    if _state._last_result is None:
        raise RuntimeError("No simulation result available yet. Run fm.run() or fm.relax() first.")
    return _state._last_result


def _latest_step():
    if _state._last_step is None:
        raise RuntimeError("No step statistics available yet. Run fm.run() or fm.relax() first.")
    return _state._last_step


def _resolve_region_key(region: str | int) -> str:
    if isinstance(region, int):
        if region < 0:
            raise ValueError("region index must be non-negative")
        if region < len(_state._magnets):
            return _state._magnets[region]._name
        return str(region)
    if not isinstance(region, str) or not region.strip():
        raise ValueError("region must be a non-empty string or non-negative integer")
    return region


def _safe_step_value(step: object, attr: str, default: float = float("nan")) -> float:
    value = getattr(step, attr, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_scalar_quantity_value(quantity_name: str, *, region: str | int | None = None) -> float:
    attr = _SCALAR_QUANTITY_ATTRS[quantity_name]
    if region is None:
        return _safe_step_value(_latest_step(), attr)
    region_key = _resolve_region_key(region)
    step = _latest_step()
    per_object = getattr(step, "per_object_scalars", None)
    if not isinstance(per_object, Mapping):
        raise RuntimeError(
            f"Quantity {quantity_name} for region={region_key!r} is not available in this backend/result."
        )
    region_map = per_object.get(region_key)
    if not isinstance(region_map, Mapping):
        available = ", ".join(sorted(str(name) for name in per_object.keys()))
        hint = f" Available regions: {available}." if available else ""
        raise RuntimeError(f"Region {region_key!r} is not available in this result.{hint}")
    if attr in region_map:
        return float(region_map[attr])
    if quantity_name in region_map:
        return float(region_map[quantity_name])
    raise RuntimeError(f"Region {region_key!r} does not provide quantity {quantity_name!r}.")


def _coerce_vector_component_index(component: str | int) -> int:
    key = str(component).lower().strip()
    if key not in _VECTOR_COMPONENTS:
        raise ValueError("component must be one of 'x', 'y', 'z', 0, 1, 2")
    return _VECTOR_COMPONENTS[key]


def _vector_average_from_last_step(quantity_name: str) -> tuple[float, float, float]:
    if quantity_name in _B_ALIAS_TO_H:
        h_avg = _vector_average_from_last_step(_B_ALIAS_TO_H[quantity_name])
        return (_MU_0 * h_avg[0], _MU_0 * h_avg[1], _MU_0 * h_avg[2])
    if quantity_name == "m":
        step = _latest_step()
        return (
            _safe_step_value(step, "mx"),
            _safe_step_value(step, "my"),
            _safe_step_value(step, "mz"),
        )
    raise RuntimeError(
        f"{quantity_name}.average() is not available yet. Field-vector averages are not emitted by the runner."
    )


def _vector_get_from_last_result(quantity_name: str) -> object:
    if quantity_name in _B_ALIAS_TO_H:
        h_values = _vector_get_from_last_result(_B_ALIAS_TO_H[quantity_name])
        converted: list[list[float]] = []
        for vec in h_values:
            converted.append([
                _MU_0 * float(vec[0]),
                _MU_0 * float(vec[1]),
                _MU_0 * float(vec[2]),
            ])
        return converted
    result = _latest_result()
    if quantity_name == "m":
        final_m = getattr(result, "final_magnetization", None)
        if final_m is None:
            raise RuntimeError("Latest result does not contain final_magnetization.")
        return final_m
    raise RuntimeError(
        f"{quantity_name}.get() is not available yet. Field snapshots are not present in runtime Result."
    )


def _record_result(result: object) -> None:
    _state._last_result = result
    steps = getattr(result, "steps", None)
    if steps:
        _state._last_step = steps[-1]
    else:
        _state._last_step = None


def _set_magnetization_continuation_from_result(result: object) -> None:
    final_m = getattr(result, "final_magnetization", None)
    if final_m is None:
        raise RuntimeError("run_while continuation requires final_magnetization in the runtime Result.")
    if len(_state._magnets) != 1:
        raise RuntimeError("run_while currently supports continuation only for scripts with exactly one magnet.")
    from fullmag.init import SampledMagnetization

    _state._magnets[0].m = SampledMagnetization(final_m)


class QuantityCondition:
    """Lazy boolean expression over runtime quantities."""

    def __init__(self, left: object, op: str, right: object) -> None:
        self._left = left
        self._op = op
        self._right = right

    def evaluate(self) -> bool:
        left = _resolve_condition_operand(self._left)
        right = _resolve_condition_operand(self._right)
        if self._op == "<":
            return left < right
        if self._op == "<=":
            return left <= right
        if self._op == ">":
            return left > right
        if self._op == ">=":
            return left >= right
        if self._op == "==":
            return left == right
        if self._op == "!=":
            return left != right
        raise ValueError(f"Unsupported condition operator: {self._op}")

    def __bool__(self) -> bool:
        return self.evaluate()

    def __repr__(self) -> str:
        return f"QuantityCondition({self._left!r} {self._op} {self._right!r})"


def _resolve_condition_operand(value: object) -> float:
    if isinstance(value, QuantityHandle):
        return float(value)
    if isinstance(value, QuantityRegionView):
        return float(value)
    if isinstance(value, QuantityComponentHandle):
        return float(value)
    return float(value)


class _ComparableQuantityMixin:
    def _condition(self, op: str, other: object) -> QuantityCondition:
        return QuantityCondition(self, op, other)

    def __lt__(self, other: object) -> QuantityCondition:
        return self._condition("<", other)

    def __le__(self, other: object) -> QuantityCondition:
        return self._condition("<=", other)

    def __gt__(self, other: object) -> QuantityCondition:
        return self._condition(">", other)

    def __ge__(self, other: object) -> QuantityCondition:
        return self._condition(">=", other)

    def __eq__(self, other: object) -> QuantityCondition:  # type: ignore[override]
        return self._condition("==", other)

    def __ne__(self, other: object) -> QuantityCondition:  # type: ignore[override]
        return self._condition("!=", other)


class QuantityHandle(_ComparableQuantityMixin):
    """MuMax-style runtime quantity handle (scalar or vector)."""

    def __init__(
        self,
        quantity_name: str,
        *,
        kind: str,
        region: str | int | None = None,
        component: str | int | None = None,
    ) -> None:
        normalized_name = _normalize_quantity_name(quantity_name)
        if kind not in {"scalar", "vector"}:
            raise ValueError("quantity kind must be 'scalar' or 'vector'")
        self._name = normalized_name
        self._kind = kind
        self._region = region
        self._component = component

    @property
    def name(self) -> str:
        return self._name

    def get(self) -> object:
        if self._kind == "scalar":
            return _coerce_scalar_quantity_value(self._name, region=self._region)
        if self._component is not None:
            idx = _coerce_vector_component_index(self._component)
            vector = self.average()
            return float(vector[idx])
        return _vector_get_from_last_result(self._name)

    def Get(self) -> object:
        return self.get()

    def average(self) -> tuple[float, float, float]:
        if self._kind != "vector":
            raise TypeError(f"{self._name}.average() is only valid for vector quantities.")
        vector = _vector_average_from_last_step(self._name)
        if self._component is not None:
            idx = _coerce_vector_component_index(self._component)
            return (float(vector[idx]), 0.0, 0.0)
        return vector

    def Average(self) -> tuple[float, float, float]:
        return self.average()

    def region(self, name_or_index: str | int) -> "QuantityRegionView":
        return QuantityRegionView(self, name_or_index)

    def Region(self, name_or_index: str | int) -> "QuantityRegionView":
        return self.region(name_or_index)

    def comp(self, component: str | int) -> "QuantityComponentHandle":
        return QuantityComponentHandle(self, component)

    def Comp(self, component: str | int) -> "QuantityComponentHandle":
        return self.comp(component)

    def __float__(self) -> float:
        value = self.get()
        if isinstance(value, (tuple, list)):
            raise TypeError(f"{self._name} is vector-valued. Use .average(), .comp(), or .get().")
        return float(value)

    def __repr__(self) -> str:
        try:
            if self._kind == "scalar":
                value = self.get()
                return f"{self._name}={float(value):.6e}"
            if self._component is not None:
                value = self.get()
                return f"{self._name}[{self._component}]={float(value):.6e}"
            avg = self.average()
            return (
                f"{self._name}.avg=({avg[0]:.6e}, {avg[1]:.6e}, {avg[2]:.6e})"
            )
        except Exception as exc:
            return f"{self._name}(<unavailable: {exc}>)"

    __str__ = __repr__


class QuantityRegionView(_ComparableQuantityMixin):
    def __init__(self, handle: QuantityHandle, region: str | int) -> None:
        self._handle = QuantityHandle(
            handle.name,
            kind=handle._kind,
            region=region,
            component=handle._component,
        )
        self._region = region

    def get(self) -> object:
        return self._handle.get()

    def Get(self) -> object:
        return self.get()

    def average(self) -> tuple[float, float, float]:
        return self._handle.average()

    def Average(self) -> tuple[float, float, float]:
        return self.average()

    def comp(self, component: str | int) -> "QuantityComponentHandle":
        return QuantityComponentHandle(self._handle, component)

    def Comp(self, component: str | int) -> "QuantityComponentHandle":
        return self.comp(component)

    def __float__(self) -> float:
        return float(self._handle)

    def __repr__(self) -> str:
        return f"{self._handle.name}.region({self._region!r}) -> {self.get()!r}"

    __str__ = __repr__


class QuantityComponentHandle(_ComparableQuantityMixin):
    def __init__(self, handle: QuantityHandle, component: str | int) -> None:
        self._handle = QuantityHandle(
            handle.name,
            kind=handle._kind,
            region=handle._region,
            component=component,
        )
        self._component = component

    def get(self) -> float:
        value = self._handle.get()
        return float(value)

    def Get(self) -> float:
        return self.get()

    def __float__(self) -> float:
        return self.get()

    def __repr__(self) -> str:
        return f"{self._handle.name}.comp({self._component!r})={self.get():.6e}"

    __str__ = __repr__


@dataclass(frozen=True, slots=True)
class RunWhileConfig:
    chunk_time: float
    max_time: float | None = None
    max_steps: int | None = None
    relax: bool = False

    def __post_init__(self) -> None:
        require_positive(self.chunk_time, "chunk_time")
        if self.max_time is None and self.max_steps is None:
            raise ValueError("RunWhile requires max_time or max_steps as a safety guard.")
        if self.max_time is not None:
            require_positive(self.max_time, "max_time")
        if self.max_steps is not None and self.max_steps <= 0:
            raise ValueError("max_steps must be a positive integer")


E_ex = QuantityHandle("E_ex", kind="scalar")
E_demag = QuantityHandle("E_demag", kind="scalar")
E_ext = QuantityHandle("E_ext", kind="scalar")
E_ani = QuantityHandle("E_ani", kind="scalar")
E_dmi = QuantityHandle("E_dmi", kind="scalar")
E_total = QuantityHandle("E_total", kind="scalar")
mx = QuantityHandle("mx", kind="scalar")
my = QuantityHandle("my", kind="scalar")
mz = QuantityHandle("mz", kind="scalar")
max_dm_dt = QuantityHandle("max_dm_dt", kind="scalar")
max_h_eff = QuantityHandle("max_h_eff", kind="scalar")
max_h_demag = QuantityHandle("max_h_demag", kind="scalar")

m = QuantityHandle("m", kind="vector")
H_ex = QuantityHandle("H_ex", kind="vector")
H_demag = QuantityHandle("H_demag", kind="vector")
H_ext = QuantityHandle("H_ext", kind="vector")
H_eff = QuantityHandle("H_eff", kind="vector")

B_exch = QuantityHandle("B_exch", kind="vector")
B_demag = QuantityHandle("B_demag", kind="vector")
B_ext = QuantityHandle("B_ext", kind="vector")
B_eff = QuantityHandle("B_eff", kind="vector")


def _gamma_from_g_factor(g_factor: float) -> float:
    return _MU_0 * g_factor * (_MU_B / _HBAR)


def _estimate_auto_hmax() -> float:
    """Estimate optimal hmax from the exchange length of registered magnets.

    Uses ``l_ex = sqrt(2A / (mu0 * Ms^2))`` — the fundamental length scale
    below which exchange dominates.  Returns ``min(l_ex)`` across all magnets
    that have both ``Ms`` and ``Aex`` set.
    """
    l_ex_values: list[float] = []
    for handle in _state._magnets:
        if handle.Ms is not None and handle.Aex is not None and handle.Ms > 0:
            l_ex = math.sqrt(2.0 * handle.Aex / (_MU_0 * handle.Ms ** 2))
            l_ex_values.append(l_ex)
    if l_ex_values:
        chosen = min(l_ex_values)
        emit_progress(
            f"hmax='auto': exchange length(s) {[f'{v*1e9:.2f} nm' for v in l_ex_values]}, "
            f"using hmax = {chosen*1e9:.2f} nm"
        )
        return chosen
    raise ValueError(
        "hmax='auto' requires at least one magnetic geometry with explicit Ms and Aex. "
        "Fullmag no longer applies an implicit fallback mesh size."
    )


def _normalize_domain_region_markers(
    region_markers: Any,
) -> list[dict[str, object]]:
    if isinstance(region_markers, dict):
        items = region_markers.items()
    elif isinstance(region_markers, (list, tuple)):
        normalized_items: list[tuple[str, int]] = []
        for entry in region_markers:
            if isinstance(entry, dict):
                geometry_name = entry.get("geometry_name")
                marker = entry.get("marker")
            elif isinstance(entry, (list, tuple)) and len(entry) == 2:
                geometry_name, marker = entry
            else:
                raise TypeError(
                    "region_markers entries must be {'geometry_name': ..., 'marker': ...} mappings "
                    "or (geometry_name, marker) pairs"
                )
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                raise ValueError("region_markers geometry_name must be a non-empty string")
            if not isinstance(marker, int) or marker <= 0:
                raise ValueError("region_markers marker must be a positive int")
            normalized_items.append((geometry_name, marker))
        items = normalized_items
    else:
        raise TypeError(
            "region_markers must be a mapping, list of mappings, or list of (geometry_name, marker) pairs"
        )

    normalized: list[dict[str, object]] = []
    seen_geometry_names: set[str] = set()
    seen_markers: set[int] = set()
    for geometry_name, marker in items:
        if not isinstance(geometry_name, str) or not geometry_name.strip():
            raise ValueError("region_markers geometry_name must be a non-empty string")
        if not isinstance(marker, int) or marker <= 0:
            raise ValueError("region_markers marker must be a positive int")
        if geometry_name in seen_geometry_names:
            raise ValueError(f"region_markers duplicates geometry_name {geometry_name!r}")
        if marker in seen_markers:
            raise ValueError(f"region_markers duplicates marker {marker}")
        seen_geometry_names.add(geometry_name)
        seen_markers.add(marker)
        normalized.append({"geometry_name": geometry_name, "marker": marker})
    if not normalized:
        raise ValueError("region_markers must not be empty")
    return normalized


def reset() -> None:
    """Reset world state to defaults (useful between scripts)."""
    global _state
    _state = _WorldState()


def begin_script_capture(source_root: str | Path | None = None) -> None:
    """Enable loader capture mode for flat scripts."""
    global _capture_enabled, _captured_stages, _capture_skip_geometry_assets
    reset()
    _state._script_source_root = Path(source_root).resolve() if source_root is not None else None
    _capture_enabled = True
    _capture_skip_geometry_assets = False
    _captured_stages = []


def set_script_capture_lightweight_assets(enabled: bool) -> None:
    global _capture_skip_geometry_assets
    _capture_skip_geometry_assets = bool(enabled)


def finish_script_capture() -> list[CapturedStage]:
    """Return captured flat-script execution data and clear capture mode."""
    global _capture_enabled, _captured_stages, _capture_skip_geometry_assets
    captured = list(_captured_stages)
    _capture_enabled = False
    _capture_skip_geometry_assets = False
    _captured_stages = []
    reset()
    return captured


def capture_workspace_problem() -> Problem | None:
    """Materialize the current flat-script world without requiring run()/relax()."""
    if not _capture_enabled or not _state._magnets:
        return None
    previous_interactive = _state._interactive
    _state._interactive = True
    try:
        return _build_problem()
    finally:
        _state._interactive = previous_interactive


def _configure_study_universe(
    *,
    mode: str | None = None,
    size: Sequence[float] | None = None,
    center: Sequence[float] | None = None,
    padding: Sequence[float] | None = None,
    airbox_hmax: float | None = None,
) -> StudyUniverseConfig:
    current = _state._study_universe or StudyUniverseConfig()
    universe = StudyUniverseConfig(
        mode=current.mode if mode is None else mode,
        size=current.size if size is None else as_vector3(size, "size"),
        center=current.center if center is None else as_vector3(center, "center"),
        padding=current.padding if padding is None else as_vector3(padding, "padding"),
        airbox_hmax=current.airbox_hmax if airbox_hmax is None else float(airbox_hmax),
    )
    _state._study_universe = universe
    return universe


class StudyBuilder:
    """Study-root facade over the current script-local world state."""

    def __init__(self, problem_name: str | None = None) -> None:
        _state._api_surface = "study"
        if problem_name is not None:
            name(problem_name)

    def name(self, problem_name: str) -> "StudyBuilder":
        name(problem_name)
        return self

    def engine(self, backend: str) -> "StudyBuilder":
        engine(backend)
        return self

    def device(self, spec: str, *, precision: str | None = None) -> "StudyBuilder":
        device(spec, precision=precision)
        return self

    def cell(self, dx: float, dy: float, dz: float) -> "StudyBuilder":
        cell(dx, dy, dz)
        return self

    def boundary_correction(self, mode: str) -> "StudyBuilder":
        boundary_correction(mode)
        return self

    def mesh(
        self,
        *,
        hmax: float | str | None = None,
        hmin: float | None = None,
        order: int | None = None,
        source: str | None = None,
        calibrate_for: str | None = None,
        size_preset: str | None = None,
        algorithm_2d: int | None = None,
        algorithm_3d: int | None = None,
        optimize: str | None = None,
        optimize_iterations: int | None = None,
        smoothing_steps: int | None = None,
        size_factor: float | None = None,
        size_from_curvature: int | None = None,
        curvature_factor: float | None = None,
        growth_rate: float | None = None,
        narrow_regions: int | None = None,
        narrow_region_resolution: float | None = None,
        compute_quality: bool | None = None,
        per_element_quality: bool | None = None,
    ) -> "StudyBuilder":
        object_mesh_defaults(
            hmax=hmax,
            hmin=hmin,
            order=order,
            source=source,
            calibrate_for=calibrate_for,
            size_preset=size_preset,
            algorithm_2d=algorithm_2d,
            algorithm_3d=algorithm_3d,
            optimize=optimize,
            optimize_iterations=optimize_iterations,
            smoothing_steps=smoothing_steps,
            size_factor=size_factor,
            size_from_curvature=size_from_curvature,
            curvature_factor=curvature_factor,
            growth_rate=growth_rate,
            narrow_regions=narrow_regions,
            narrow_region_resolution=narrow_region_resolution,
            compute_quality=compute_quality,
            per_element_quality=per_element_quality,
        )
        return self

    def object_mesh_defaults(
        self,
        *,
        hmax: float | str | None = None,
        hmin: float | None = None,
        order: int | None = None,
        source: str | None = None,
        calibrate_for: str | None = None,
        size_preset: str | None = None,
        algorithm_2d: int | None = None,
        algorithm_3d: int | None = None,
        optimize: str | None = None,
        optimize_iterations: int | None = None,
        smoothing_steps: int | None = None,
        size_factor: float | None = None,
        size_from_curvature: int | None = None,
        curvature_factor: float | None = None,
        growth_rate: float | None = None,
        narrow_regions: int | None = None,
        narrow_region_resolution: float | None = None,
        compute_quality: bool | None = None,
        per_element_quality: bool | None = None,
    ) -> "StudyBuilder":
        """Configure shared default mesher settings for magnetic objects in this study."""
        object_mesh_defaults(
            hmax=hmax,
            hmin=hmin,
            order=order,
            source=source,
            calibrate_for=calibrate_for,
            size_preset=size_preset,
            algorithm_2d=algorithm_2d,
            algorithm_3d=algorithm_3d,
            optimize=optimize,
            optimize_iterations=optimize_iterations,
            smoothing_steps=smoothing_steps,
            size_factor=size_factor,
            size_from_curvature=size_from_curvature,
            curvature_factor=curvature_factor,
            growth_rate=growth_rate,
            narrow_regions=narrow_regions,
            narrow_region_resolution=narrow_region_resolution,
            compute_quality=compute_quality,
            per_element_quality=per_element_quality,
        )
        return self

    def hmax(self, value: float | str) -> "StudyBuilder":
        hmax(value)
        return self

    def fem_order(self, order_value: int) -> "StudyBuilder":
        fem_order(order_value)
        return self

    def build_mesh(self) -> "StudyBuilder":
        build_mesh()
        return self

    def build_domain_mesh(self) -> "StudyBuilder":
        build_domain_mesh()
        return self

    def interactive(self, enabled: bool = True) -> "StudyBuilder":
        interactive(enabled)
        return self

    def wait_for_solve(self, enabled: bool = True) -> "StudyBuilder":
        wait_for_solve(enabled)
        return self

    def adaptive_mesh(
        self,
        enabled: bool = True,
        *,
        policy: str = "manual",
        theta: float = 0.3,
        h_min: float | None = None,
        h_max: float | None = None,
        max_passes: int = 5,
        error_tolerance: float | None = None,
        chunk_until_seconds: float | None = None,
        steps_per_pass: int | None = None,
    ) -> "StudyBuilder":
        adaptive_mesh(
            enabled,
            policy=policy,
            theta=theta,
            h_min=h_min,
            h_max=h_max,
            max_passes=max_passes,
            error_tolerance=error_tolerance,
            chunk_until_seconds=chunk_until_seconds,
            steps_per_pass=steps_per_pass,
        )
        return self

    def universe(
        self,
        *,
        mode: str | None = None,
        size: Sequence[float] | None = None,
        center: Sequence[float] | None = None,
        padding: Sequence[float] | None = None,
        airbox_hmax: float | None = None,
    ) -> "StudyBuilder":
        _configure_study_universe(
            mode=mode,
            size=size,
            center=center,
            padding=padding,
            airbox_hmax=airbox_hmax,
        )
        return self

    def demag(self, *, realization: str | None = None) -> "StudyBuilder":
        demag(realization=realization)
        return self

    def airbox(self, *, hmax: float | None = None) -> "StudyBuilder":
        """Configure airbox mesh element size, as a distinct step from the universe geometry."""
        _configure_study_universe(airbox_hmax=hmax)
        return self

    def domain_mesh(
        self,
        source: str | Path,
        *,
        region_markers: Any,
    ) -> "StudyBuilder":
        domain_mesh(source, region_markers=region_markers)
        return self

    def geometry(self, shape: object, name: str = "body") -> MagnetHandle:
        return geometry(shape, name=name)

    def solver(
        self,
        *,
        dt: float | None = None,
        max_error: float | None = None,
        integrator: str | None = None,
        gamma: float | None = None,
        g: float | None = None,
    ) -> "StudyBuilder":
        solver(dt=dt, max_error=max_error, integrator=integrator, gamma=gamma, g=g)
        return self

    def b_ext(
        self,
        magnitude: float,
        by: float | None = None,
        bz: float | None = None,
        *,
        theta: float | None = None,
        phi: float | None = None,
    ) -> "StudyBuilder":
        b_ext(magnitude, by, bz, theta=theta, phi=phi)
        return self

    def save(
        self,
        quantity: str,
        *,
        every: float | None = None,
        indices: Sequence[int] | None = None,
    ) -> "StudyBuilder":
        save(quantity, every=every, indices=indices)
        return self

    def snapshot(
        self,
        layer_or_quantity: "str | MagnetHandle",
        quantity: str | None = None,
        *,
        every: float,
    ) -> "StudyBuilder":
        snapshot(layer_or_quantity, quantity, every=every)
        return self

    def tableautosave(self, every: float) -> "StudyBuilder":
        tableautosave(every)
        return self

    def antenna_field_source(
        self,
        *,
        name: str,
        antenna: Antenna,
        drive: RfDrive,
        solver: str = "mqs_2p5d_az",
        air_box_factor: float = 12.0,
    ) -> AntennaFieldSource:
        return antenna_field_source(
            name=name,
            antenna=antenna,
            drive=drive,
            solver=solver,
            air_box_factor=air_box_factor,
        )

    def spin_wave_excitation(
        self,
        *,
        source: str,
        method: str = "source_k_profile",
        propagation_axis: Sequence[float] = (1.0, 0.0, 0.0),
        k_max_rad_per_m: float | None = None,
        samples: int = 256,
    ) -> SpinWaveExcitationAnalysis:
        return spin_wave_excitation(
            source=source,
            method=method,
            propagation_axis=propagation_axis,
            k_max_rad_per_m=k_max_rad_per_m,
            samples=samples,
        )

    def run(self, until: float) -> Any:
        return run(until)

    def run_while(
        self,
        condition: QuantityCondition | Callable[[], bool] | bool,
        *,
        chunk_time: float,
        max_time: float | None = None,
        max_steps: int | None = None,
        relax: bool = False,
        **kwargs: object,
    ) -> Any:
        return run_while(
            condition,
            chunk_time=chunk_time,
            max_time=max_time,
            max_steps=max_steps,
            relax=relax,
            **kwargs,
        )

    def RunWhile(
        self,
        condition: QuantityCondition | Callable[[], bool] | bool,
        *,
        chunk_time: float,
        max_time: float | None = None,
        max_steps: int | None = None,
        relax: bool = False,
        **kwargs: object,
    ) -> Any:
        return self.run_while(
            condition,
            chunk_time=chunk_time,
            max_time=max_time,
            max_steps=max_steps,
            relax=relax,
            **kwargs,
        )

    def relax(
        self,
        *,
        tol: float = 1e-6,
        max_steps: int = 50_000,
        algorithm: str = "llg_overdamped",
        energy_tolerance: float | None = None,
        relax_alpha: float | None = 1.0,
    ) -> Any:
        return relax(
            tol=tol,
            max_steps=max_steps,
            algorithm=algorithm,
            energy_tolerance=energy_tolerance,
            relax_alpha=relax_alpha,
        )

    def eigenmodes(
        self,
        *,
        count: int = 10,
        target: str = "lowest",
        target_frequency: float | None = None,
        include_demag: bool = True,
        equilibrium_source: str = "relax",
        equilibrium_artifact: str | None = None,
        normalization: str = "unit_l2",
        damping_policy: str = "ignore",
        k_vector: tuple[float, float, float] | None = None,
        bc: str = "free",
    ) -> Any:
        return eigenmodes(
            count=count,
            target=target,
            target_frequency=target_frequency,
            include_demag=include_demag,
            equilibrium_source=equilibrium_source,
            equilibrium_artifact=equilibrium_artifact,
            normalization=normalization,
            damping_policy=damping_policy,
            k_vector=k_vector,
            bc=bc,
        )


def study(problem_name: str | None = None) -> StudyBuilder:
    """Return a study-root facade over the current script-local builder state."""
    if problem_name is not None:
        require_non_empty(problem_name, "problem_name")
    return StudyBuilder(problem_name)


def demag(*, realization: str | None = None) -> None:
    """Configure the demag realization / outer-boundary policy for the flat API."""
    if realization is not None:
        Demag(realization=realization)
    _state._demag_realization = realization


# ---------------------------------------------------------------------------
# Engine / backend
# ---------------------------------------------------------------------------

def engine(backend: str) -> None:
    """Set computation backend: ``"fdm"``, ``"fem"``, or ``"auto"``."""
    _state._backend = backend.lower()


def device(spec: str, *, precision: str | None = None) -> None:
    """Set device and optionally execution precision.

    Examples::

        fm.device("cpu")
        fm.device("cuda:0")
        fm.device("cuda:0", precision="single")
    """
    spec = spec.lower()
    if spec == "cpu":
        _state._device = "cpu"
        _state._gpu_count = 0
        _state._device_index = None
    elif spec.startswith("cuda"):
        _state._device = "cuda"
        parts = spec.split(":")
        if len(parts) > 1:
            _state._device_index = int(parts[1])
        _state._gpu_count = 1
    elif spec == "gpu":
        _state._device = "gpu"
        _state._gpu_count = 1
    else:
        _state._device = spec
    if precision is not None:
        _state._precision = precision.lower()


def cell(dx: float, dy: float, dz: float) -> None:
    """Set FDM cell size in meters."""
    _state._cell = (dx, dy, dz)


def boundary_correction(mode: str) -> None:
    """Set FDM boundary correction mode.

    Parameters
    ----------
    mode : str
        ``"none"``  — standard binary mask (default).
        ``"volume"`` — T0: volume-fraction weighted exchange + demag (φ-weighted).
        ``"full"``   — T1: ECB boundary stencil + sparse demag correction (García-Cervera).
    """
    allowed = ("none", "volume", "full")
    if mode not in allowed:
        raise ValueError(f"boundary_correction must be one of {allowed!r}, got {mode!r}")
    _state._boundary_correction = mode


def pbc(x: bool = False, y: bool = False, z: bool = False) -> None:
    """Enable periodic boundary conditions for FDM along the given axes.

    Parameters
    ----------
    x, y, z : bool
        Set to ``True`` to make the corresponding axis periodic.
    """
    if not any((x, y, z)):
        _state._pbc = None
    else:
        _state._pbc = (bool(x), bool(y), bool(z))


def object_mesh_defaults(
    *,
    hmax: float | str | None = None,
    hmin: float | None = None,
    order: int | None = None,
    source: str | None = None,
    calibrate_for: str | None = None,
    size_preset: str | None = None,
    algorithm_2d: int | None = None,
    algorithm_3d: int | None = None,
    optimize: str | None = None,
    optimize_iterations: int | None = None,
    smoothing_steps: int | None = None,
    size_factor: float | None = None,
    size_from_curvature: int | None = None,
    curvature_factor: float | None = None,
    growth_rate: float | None = None,
    narrow_regions: int | None = None,
    narrow_region_resolution: float | None = None,
    compute_quality: bool | None = None,
    per_element_quality: bool | None = None,
) -> None:
    """Configure shared default mesher settings for magnetic objects in the flat API."""
    if hmax is not None:
        if isinstance(hmax, str) and hmax != "auto":
            raise ValueError(f"hmax must be a positive float or \"auto\", got {hmax!r}")
        _state._default_mesh_spec.hmax = hmax
        _state._hmax = hmax
    if hmin is not None:
        _state._default_mesh_spec.hmin = hmin
    if order is not None:
        _state._default_mesh_spec.order = order
        _state._fem_order = order
    if source is not None:
        _state._default_mesh_spec.source = source
        _state._mesh_source = source
    if calibrate_for is not None:
        _state._default_mesh_spec.calibrate_for = _normalize_mesh_calibration(calibrate_for)
    if size_preset is not None:
        _state._default_mesh_spec.size_preset = _normalize_mesh_preset(size_preset)
    if algorithm_2d is not None:
        _state._default_mesh_spec.algorithm_2d = algorithm_2d
    if algorithm_3d is not None:
        _state._default_mesh_spec.algorithm_3d = algorithm_3d
    if optimize is not None:
        _state._default_mesh_spec.optimize_method = optimize
    if optimize_iterations is not None:
        _state._default_mesh_spec.optimize_iterations = optimize_iterations
    if smoothing_steps is not None:
        _state._default_mesh_spec.smoothing_steps = smoothing_steps
    if size_factor is not None:
        _state._default_mesh_spec.size_factor = size_factor
    if size_from_curvature is not None:
        _state._default_mesh_spec.size_from_curvature = size_from_curvature
    if curvature_factor is not None:
        _state._default_mesh_spec.curvature_factor = float(curvature_factor)
    if growth_rate is not None:
        _state._default_mesh_spec.growth_rate = growth_rate
    if narrow_regions is not None:
        _state._default_mesh_spec.narrow_regions = narrow_regions
    if narrow_region_resolution is not None:
        _state._default_mesh_spec.narrow_region_resolution = float(narrow_region_resolution)
    if compute_quality is not None:
        _state._default_mesh_spec.compute_quality = compute_quality
    if per_element_quality is not None:
        _state._default_mesh_spec.per_element_quality = per_element_quality


def mesh(
    *,
    hmax: float | str | None = None,
    hmin: float | None = None,
    order: int | None = None,
    source: str | None = None,
    calibrate_for: str | None = None,
    size_preset: str | None = None,
    algorithm_2d: int | None = None,
    algorithm_3d: int | None = None,
    optimize: str | None = None,
    optimize_iterations: int | None = None,
    smoothing_steps: int | None = None,
    size_factor: float | None = None,
    size_from_curvature: int | None = None,
    curvature_factor: float | None = None,
    growth_rate: float | None = None,
    narrow_regions: int | None = None,
    narrow_region_resolution: float | None = None,
    compute_quality: bool | None = None,
    per_element_quality: bool | None = None,
) -> None:
    """Compatibility alias for ``object_mesh_defaults(...)``."""
    object_mesh_defaults(
        hmax=hmax,
        hmin=hmin,
        order=order,
        source=source,
        calibrate_for=calibrate_for,
        size_preset=size_preset,
        algorithm_2d=algorithm_2d,
        algorithm_3d=algorithm_3d,
        optimize=optimize,
        optimize_iterations=optimize_iterations,
        smoothing_steps=smoothing_steps,
        size_factor=size_factor,
        size_from_curvature=size_from_curvature,
        curvature_factor=curvature_factor,
        growth_rate=growth_rate,
        narrow_regions=narrow_regions,
        narrow_region_resolution=narrow_region_resolution,
        compute_quality=compute_quality,
        per_element_quality=per_element_quality,
    )


def hmax(val: float | str) -> None:
    """Compatibility alias for ``fm.object_mesh_defaults(hmax=...)``."""
    object_mesh_defaults(hmax=val)


def fem_order(order: int) -> None:
    """Compatibility alias for ``fm.object_mesh_defaults(order=...)``."""
    object_mesh_defaults(order=order)


def build_mesh() -> None:
    """Materialize the shared FEM mesh asset for the current flat-script model."""
    _state._default_mesh_spec.build_requested = True
    if _capture_enabled:
        return
    _build_explicit_mesh_assets()


def build_domain_mesh() -> None:
    """Materialize one shared-domain FEM mesh from the current airbox, object defaults and object overrides."""
    build_mesh()


def domain_mesh(
    source: str | Path,
    *,
    region_markers: Any,
) -> None:
    """Attach an explicit shared-domain FEM mesh asset.

    Parameters
    ----------
    source : str or Path
        Path to a precomputed shared-domain mesh asset (currently `.json` MeshIR).
    region_markers : mapping | sequence
        Magnetic-region marker table. Accepted forms:
        `{"left": 1, "right": 2}`,
        `[("left", 1), ("right", 2)]`,
        or `[{"geometry_name": "left", "marker": 1}, ...]`.
    """
    rendered_source = str(Path(source))
    if not rendered_source.strip():
        raise ValueError("domain_mesh source must not be empty")
    _state._domain_mesh_source = rendered_source
    _state._domain_region_markers = _normalize_domain_region_markers(region_markers)


def interactive(enabled: bool = True) -> None:
    """Request that the launcher keep the session open after the run.

    This is the script-owned counterpart of ``fullmag -i``.
    """
    _state._interactive = bool(enabled)


def wait_for_solve(enabled: bool = True) -> None:
    """Gate solver execution: parse/materialize → WAIT → user clicks Compute → solve.

    When enabled, the launcher pauses after mesh generation so the user can
    inspect the workspace in the GUI before committing to the solver.
    Supported for the interactive FDM and FEM solve paths. Mesh re-generation
    during the wait gate remains FEM-specific.
    """
    _state._wait_for_solve = bool(enabled)


def adaptive_mesh(
    enabled: bool = True,
    *,
    policy: str = "manual",
    theta: float = 0.3,
    h_min: float | None = None,
    h_max: float | None = None,
    max_passes: int = 5,
    error_tolerance: float | None = None,
    chunk_until_seconds: float | None = None,
    steps_per_pass: int | None = None,
) -> None:
    """Configure FEM adaptive mesh policy metadata for the runtime/orchestrator.

    This call is declarative: it stores the requested adaptive-mesh policy
    in runtime metadata so the control room and future orchestration layers
    can inspect it. Current runtimes may ignore parts of this payload until
    the full AFEM execution loop is enabled.
    """
    if policy not in {"manual", "auto"}:
        raise ValueError("adaptive_mesh policy must be 'manual' or 'auto'")
    if theta <= 0.0 or theta > 1.0:
        raise ValueError("adaptive_mesh theta must satisfy 0 < theta <= 1")
    if max_passes < 0:
        raise ValueError("adaptive_mesh max_passes must be >= 0")
    if h_min is not None and h_min <= 0.0:
        raise ValueError("adaptive_mesh h_min must be positive")
    if h_max is not None and h_max <= 0.0:
        raise ValueError("adaptive_mesh h_max must be positive")
    if h_min is not None and h_max is not None and h_min > h_max:
        raise ValueError("adaptive_mesh h_min must be <= h_max")
    if error_tolerance is not None and error_tolerance <= 0.0:
        raise ValueError("adaptive_mesh error_tolerance must be positive")
    if chunk_until_seconds is not None and chunk_until_seconds <= 0.0:
        raise ValueError("adaptive_mesh chunk_until_seconds must be positive")
    if steps_per_pass is not None and steps_per_pass <= 0:
        raise ValueError("adaptive_mesh steps_per_pass must be > 0")

    _state._adaptive_mesh = {
        "enabled": bool(enabled),
        "policy": policy,
        "theta": float(theta),
        "h_min": h_min,
        "h_max": h_max,
        "max_passes": int(max_passes),
        "error_tolerance": error_tolerance,
        "chunk_until_seconds": chunk_until_seconds,
        "steps_per_pass": steps_per_pass,
    }


def _mesh_source_root() -> Path:
    if _state._script_source_root is not None:
        return _state._script_source_root
    return Path.cwd()


def _collect_flat_geometries() -> list[object]:
    return [handle._resolved_geometry() for handle in _state._magnets]


def _resolve_flat_fem_hint() -> FEM | None:
    s = _state

    def _mesh_api_explicitly_declared() -> bool:
        if s._domain_mesh_source is not None:
            return True
        if s._default_mesh_spec.is_configured() or s._default_mesh_spec.build_requested:
            return True
        if s._default_mesh_spec.operations or s._default_mesh_spec.size_fields:
            return True
        for handle in s._magnets:
            if (
                handle._mesh_spec.is_configured()
                or handle._mesh_spec.build_requested
                or handle._mesh_spec.operations
                or handle._mesh_spec.size_fields
            ):
                return True
        return False

    fem_backend_requested = s._backend in {"fem", "hybrid"}
    explicit_mesh_api = _mesh_api_explicitly_declared()
    if not fem_backend_requested and not explicit_mesh_api:
        # Pure FDM/auto paths with no FEM mesh declarations should not be
        # forced through FEM hmax validation.
        return None

    def _explicit_object_hmaxs() -> list[float | str]:
        values: list[float | str] = []
        for handle in s._magnets:
            if handle._mesh_spec.hmax is not None:
                values.append(handle._mesh_spec.hmax)
        return values

    explicit_specs = [handle._mesh_spec for handle in s._magnets if handle._mesh_spec.is_configured()]
    build_requested = any(handle._mesh_spec.build_requested for handle in s._magnets)
    operation_specs = [handle._mesh_spec for handle in s._magnets if handle._mesh_spec.operations]
    default_spec = s._default_mesh_spec
    build_requested = build_requested or default_spec.build_requested
    study_surface = s._api_surface == "study"
    explicit_domain_mesh = s._domain_mesh_source is not None
    default_mesh_declared = (
        default_spec.is_configured()
        or bool(default_spec.operations)
        or bool(default_spec.size_fields)
    )

    if study_surface:
        candidate_specs = [default_spec] if default_mesh_declared else []
    else:
        candidate_specs = explicit_specs or ([default_spec] if default_spec.is_configured() else [])
    if operation_specs and not candidate_specs:
        candidate_specs = operation_specs
    if build_requested and not candidate_specs:
        candidate_specs = [default_spec]

    if candidate_specs:
        shared_hmax = candidate_specs[0].hmax
        if not study_surface:
            explicit_hmaxs = [spec.hmax for spec in candidate_specs if spec.hmax is not None]
            if explicit_hmaxs:
                if all(isinstance(value, (int, float)) for value in explicit_hmaxs):
                    shared_hmax = max(float(value) for value in explicit_hmaxs)
                elif len({str(value) for value in explicit_hmaxs}) == 1:
                    shared_hmax = explicit_hmaxs[0]
                else:
                    raise ValueError(
                        "Per-geometry FEM hmax values currently support either all-numeric values "
                        "or one shared symbolic value (for example, all 'auto')."
                    )
    else:
        shared_hmax = s._hmax
    shared_order = candidate_specs[0].order if candidate_specs and candidate_specs[0].order is not None else s._fem_order
    shared_source = candidate_specs[0].source if candidate_specs else s._mesh_source

    if not study_surface:
        for spec in candidate_specs[1:]:
            if (
                spec.order is not None and spec.order != shared_order
            ) or (
                spec.source is not None and spec.source != shared_source
            ):
                raise ValueError(
                    "Per-geometry FEM mesh order/source settings are not yet supported in the flat-script IR. "
                    "Use one shared order/source for all geometries in this script."
                )

    generated_shared_domain = (
        study_surface
        and s._study_universe is not None
        and not explicit_domain_mesh
        and shared_source is None
    )

    resolved_hmax = shared_hmax
    if generated_shared_domain:
        strict_domain_requirements = build_requested
        airbox_hmax = s._study_universe.airbox_hmax
        if airbox_hmax is None:
            has_shared_base_hmax = isinstance(shared_hmax, (int, float)) or shared_hmax == "auto"
            if strict_domain_requirements and not has_shared_base_hmax:
                raise ValueError(
                    "Generated shared-domain FEM mesh requires an explicit airbox mesh size. "
                    "Set study.airbox(hmax=...) or study.universe(..., airbox_hmax=...)."
                )
            explicit_hmaxs = _explicit_object_hmaxs()
            if isinstance(shared_hmax, (int, float)):
                resolved_hmax = float(shared_hmax)
            elif shared_hmax == "auto":
                resolved_hmax = "auto"
            elif explicit_hmaxs and all(isinstance(value, (int, float)) for value in explicit_hmaxs):
                resolved_hmax = max(float(value) for value in explicit_hmaxs)
            elif explicit_hmaxs and len(set(explicit_hmaxs)) == 1 and explicit_hmaxs[0] == "auto":
                resolved_hmax = "auto"
            else:
                resolved_hmax = "auto"
            emit_progress(
                "No explicit airbox_hmax provided for generated shared-domain FEM mesh; "
                "falling back to implicit base mesh size"
            )
        else:
            resolved_hmax = float(airbox_hmax)
        missing_object_hmax = [
            handle._name for handle in s._magnets if handle._mesh_spec.hmax is None
        ] if default_spec.hmax is None else []
        if missing_object_hmax:
            if strict_domain_requirements:
                missing_names = ", ".join(repr(name) for name in missing_object_hmax)
                raise ValueError(
                    "Generated shared-domain FEM mesh requires an explicit object mesh hmax for every "
                    "magnetic geometry unless study.object_mesh_defaults(hmax=...) is set. "
                    f"Missing hmax for: {missing_names}."
                )
            emit_progress(
                "No explicit per-object hmax for all magnetic geometries; "
                "using shared-domain base mesh size as compatibility fallback"
            )
        if isinstance(resolved_hmax, (int, float)):
            emit_progress(
                "Using shared-domain base mesh size "
                f"({resolved_hmax * 1e9:.2f} nm)"
            )
    elif resolved_hmax is None and study_surface:
        explicit_hmaxs = _explicit_object_hmaxs()
        if explicit_hmaxs:
            if all(isinstance(value, (int, float)) for value in explicit_hmaxs):
                resolved_hmax = max(float(value) for value in explicit_hmaxs)
                emit_progress(
                    "Using the coarsest explicit object hmax as the mesh base size "
                    f"({resolved_hmax * 1e9:.2f} nm)"
                )
            elif len(set(explicit_hmaxs)) == 1 and explicit_hmaxs[0] == "auto":
                resolved_hmax = "auto"

    if resolved_hmax is None and (shared_source is not None or explicit_domain_mesh):
        # A prebuilt mesh source does not need a generator-side hmax, but the
        # current FEM hint contract still requires one numeric placeholder.
        resolved_hmax = 5e-9

    if resolved_hmax is None and shared_source is None:
        # Keep legacy scripts runnable: when no explicit FEM mesh size is
        # provided, derive it from material exchange length heuristics.
        resolved_hmax = "auto"
        emit_progress(
            "No explicit FEM mesh hmax configured; falling back to implicit auto mesh-size heuristic"
        )

    # Resolve "auto" sentinel → exchange-length-based float
    if resolved_hmax == "auto":
        resolved_hmax = _estimate_auto_hmax()

    return FEM(order=shared_order or 1, hmax=resolved_hmax, mesh=shared_source)


def _mesh_spec_declares_override(spec: _MeshSpecState) -> bool:
    return spec.is_configured()


def _mesh_spec_to_metadata(spec: _MeshSpecState) -> dict[str, object]:
    payload: dict[str, object] = {}
    if spec.hmax is not None:
        payload["hmax"] = spec.hmax
    if spec.hmin is not None:
        payload["hmin"] = spec.hmin
    if spec.order is not None:
        payload["order"] = spec.order
    if spec.source is not None:
        payload["source"] = spec.source
    if spec.calibrate_for is not None:
        payload["calibrate_for"] = spec.calibrate_for
    if spec.size_preset is not None:
        payload["size_preset"] = spec.size_preset
    if spec.build_requested:
        payload["build_requested"] = True
    if spec.algorithm_2d is not None:
        payload["algorithm_2d"] = spec.algorithm_2d
    if spec.algorithm_3d is not None:
        payload["algorithm_3d"] = spec.algorithm_3d
    if spec.optimize_method is not None:
        payload["optimize"] = spec.optimize_method
    if spec.optimize_iterations != 1:
        payload["optimize_iterations"] = spec.optimize_iterations
    if spec.smoothing_steps != 1:
        payload["smoothing_steps"] = spec.smoothing_steps
    if not math.isclose(spec.size_factor, 1.0):
        payload["size_factor"] = spec.size_factor
    if spec.size_from_curvature != 0:
        payload["size_from_curvature"] = spec.size_from_curvature
    if spec.curvature_factor is not None:
        payload["curvature_factor"] = spec.curvature_factor
    if spec.growth_rate is not None:
        payload["growth_rate"] = spec.growth_rate
    if spec.narrow_regions != 0:
        payload["narrow_regions"] = spec.narrow_regions
    if spec.narrow_region_resolution is not None:
        payload["narrow_region_resolution"] = spec.narrow_region_resolution
    if spec.compute_quality:
        payload["compute_quality"] = True
    if spec.per_element_quality:
        payload["per_element_quality"] = True
    if spec.size_fields:
        payload["size_fields"] = list(spec.size_fields)
    if spec.operations:
        payload["operations"] = [
            {"kind": operation.kind, "params": dict(operation.params)}
            for operation in spec.operations
        ]
    return payload


def _collect_mesh_workflow_metadata() -> dict[str, object] | None:
    configured_handles = [handle for handle in _state._magnets if handle._mesh_spec.is_configured()]
    explicit_domain_mesh = _state._domain_mesh_source is not None
    operations = []
    for handle in _state._magnets:
        for operation in handle._mesh_spec.operations:
            operations.append(
                {
                    "geometry": handle._name,
                    "kind": operation.kind,
                    "params": dict(operation.params),
                }
            )
    if _state._default_mesh_spec.operations:
        for operation in _state._default_mesh_spec.operations:
            operations.append(
                {
                    "geometry": "*",
                    "kind": operation.kind,
                    "params": dict(operation.params),
                }
            )
    build_requested = _state._default_mesh_spec.build_requested or any(
        handle._mesh_spec.build_requested for handle in _state._magnets
    )
    explicit_mesh_api = bool(
        configured_handles
        or _state._default_mesh_spec.is_configured()
        or build_requested
        or operations
        or explicit_domain_mesh
    )
    if not explicit_mesh_api:
        return None
    fem_hint = _resolve_flat_fem_hint()

    # Collect MeshOptions from specs
    if _state._api_surface == "study":
        primary_spec = _state._default_mesh_spec
    else:
        all_specs = configured_handles + [_state._default_mesh_spec] if not configured_handles else configured_handles
        primary_spec = all_specs[0]._mesh_spec if hasattr(all_specs[0], "_mesh_spec") else all_specs[0]
        if hasattr(primary_spec, "_mesh_spec"):
            primary_spec = primary_spec._mesh_spec
    mesh_options = {}
    if primary_spec.algorithm_2d is not None:
        mesh_options["algorithm_2d"] = primary_spec.algorithm_2d
    if primary_spec.algorithm_3d is not None:
        mesh_options["algorithm_3d"] = primary_spec.algorithm_3d
    if primary_spec.hmin is not None:
        mesh_options["hmin"] = primary_spec.hmin
    if primary_spec.calibrate_for is not None:
        mesh_options["calibrate_for"] = primary_spec.calibrate_for
    if primary_spec.size_preset is not None:
        mesh_options["size_preset"] = primary_spec.size_preset
    if primary_spec.optimize_method is not None:
        mesh_options["optimize"] = primary_spec.optimize_method
    if primary_spec.optimize_iterations != 1:
        mesh_options["optimize_iterations"] = primary_spec.optimize_iterations
    if primary_spec.smoothing_steps != 1:
        mesh_options["smoothing_steps"] = primary_spec.smoothing_steps
    if primary_spec.size_factor != 1.0:
        mesh_options["size_factor"] = primary_spec.size_factor
    if primary_spec.size_from_curvature > 0:
        mesh_options["size_from_curvature"] = primary_spec.size_from_curvature
    if primary_spec.curvature_factor is not None:
        mesh_options["curvature_factor"] = primary_spec.curvature_factor
    if primary_spec.growth_rate is not None:
        mesh_options["growth_rate"] = primary_spec.growth_rate
    if primary_spec.narrow_regions > 0:
        mesh_options["narrow_regions"] = primary_spec.narrow_regions
    if primary_spec.narrow_region_resolution is not None:
        mesh_options["narrow_region_resolution"] = primary_spec.narrow_region_resolution
    if primary_spec.compute_quality:
        mesh_options["compute_quality"] = True
    if primary_spec.per_element_quality:
        mesh_options["per_element_quality"] = True
    if primary_spec.size_fields:
        mesh_options["size_fields"] = list(primary_spec.size_fields)

    per_geometry = []
    for handle in _state._magnets:
        entry = {
            "geometry": handle._name,
            "mode": "custom" if _mesh_spec_declares_override(handle._mesh_spec) else "inherit",
        }
        entry.update(_mesh_spec_to_metadata(handle._mesh_spec))
        per_geometry.append(entry)

    mesh_workflow = {
        "explicit_mesh_api": True,
        "build_requested": build_requested,
        "build_target": "domain" if (_state._study_universe is not None or explicit_domain_mesh) else "mesh",
        "fem": fem_hint.to_ir() if fem_hint is not None else None,
        "operations": operations,
        "mesh_options": mesh_options if mesh_options else None,
        "default_mesh": _mesh_spec_to_metadata(_state._default_mesh_spec),
        "per_geometry": per_geometry,
    }
    if explicit_domain_mesh:
        mesh_workflow["domain_mesh_mode"] = "explicit_shared_domain_mesh"
        mesh_workflow["domain_mesh_source"] = _state._domain_mesh_source
        mesh_workflow["domain_region_markers"] = list(_state._domain_region_markers or [])
    elif _state._study_universe is not None:
        mesh_workflow["domain_mesh_mode"] = "generated_shared_domain_mesh"
    return mesh_workflow


def _build_explicit_mesh_assets() -> None:
    geometries = _collect_flat_geometries()
    if not geometries:
        raise ValueError("No geometries defined — call fm.geometry(...) before build_mesh()")

    fem_hint = _resolve_flat_fem_hint()
    if fem_hint is None:
        raise ValueError(
            "No FEM mesh configuration available. Set fm.object_mesh_defaults(...), call body.mesh(...), "
            "or choose the FEM backend before build_mesh()."
        )

    resolved_geometries = [
        resolve_geometry_sources(geometry, source_root=_mesh_source_root())
        for geometry in geometries
    ]
    discretization_kwargs: dict[str, Any] = {"fem": fem_hint}
    if _state._cell is not None:
        discretization_kwargs["fdm"] = FDM(cell=_state._cell)
    emit_progress("Building explicit FEM mesh asset")
    assets = build_geometry_assets_for_request(
        requested_backend=BackendTarget.FEM,
        geometries=resolved_geometries,
        discretization=DiscretizationHints(**discretization_kwargs),
        mesh_workflow=_collect_mesh_workflow_metadata(),
        asset_cache=_state._geometry_asset_cache,
    )
    _cache_mesh_quality_reports(assets)


def _mesh_quality_report_from_ir(payload: Mapping[str, object]) -> object | None:
    from fullmag.meshing.gmsh_bridge import MeshQualityReport

    try:
        return MeshQualityReport(
            n_elements=int(payload["n_elements"]),
            sicn_min=float(payload["sicn_min"]),
            sicn_max=float(payload["sicn_max"]),
            sicn_mean=float(payload["sicn_mean"]),
            sicn_p5=float(payload["sicn_p5"]),
            sicn_histogram=[int(value) for value in payload.get("sicn_histogram", [])],
            gamma_min=float(payload["gamma_min"]),
            gamma_mean=float(payload["gamma_mean"]),
            gamma_histogram=[int(value) for value in payload.get("gamma_histogram", [])],
            volume_min=float(payload["volume_min"]),
            volume_max=float(payload["volume_max"]),
            volume_mean=float(payload["volume_mean"]),
            volume_std=float(payload["volume_std"]),
            avg_quality=float(payload["avg_quality"]),
            element_sicn=None,
            element_gamma=None,
        )
    except (KeyError, TypeError, ValueError):
        return None


def _quality_payload_for_mesh_ir(mesh_ir: Mapping[str, object]) -> object | None:
    raw_per_domain = mesh_ir.get("per_domain_quality")
    if not isinstance(raw_per_domain, Mapping):
        return None

    per_domain: dict[int, object] = {}
    for marker_raw, report_raw in raw_per_domain.items():
        if not isinstance(report_raw, Mapping):
            continue
        report = _mesh_quality_report_from_ir(report_raw)
        if report is None:
            continue
        try:
            marker = int(marker_raw)
        except (TypeError, ValueError):
            continue
        per_domain[marker] = report

    if not per_domain:
        return None
    if len(per_domain) == 1:
        return next(iter(per_domain.values()))
    return per_domain


def _cache_mesh_quality_reports(assets: dict[str, Any] | None) -> None:
    for handle in _state._magnets:
        handle._last_mesh_quality = None

    if not isinstance(assets, dict):
        return

    handles_by_alias: dict[str, MagnetHandle] = {}
    for handle in _state._magnets:
        handles_by_alias[handle._name] = handle
        resolved = handle._resolved_geometry()
        geometry_name = getattr(resolved, "geometry_name", None)
        if isinstance(geometry_name, str) and geometry_name:
            handles_by_alias[geometry_name] = handle

    for entry in assets.get("fem_mesh_assets", []):
        if not isinstance(entry, Mapping):
            continue
        geometry_name = entry.get("geometry_name")
        mesh_payload = entry.get("mesh")
        if not isinstance(geometry_name, str) or not isinstance(mesh_payload, Mapping):
            continue
        handle = handles_by_alias.get(geometry_name)
        if handle is None and geometry_name.endswith("_geom"):
            handle = handles_by_alias.get(geometry_name[: -len("_geom")])
        if handle is None:
            continue
        handle._last_mesh_quality = _quality_payload_for_mesh_ir(mesh_payload)


# ---------------------------------------------------------------------------
# Geometry → MagnetHandle
# ---------------------------------------------------------------------------

def geometry(shape: object, name: str = "body") -> MagnetHandle:
    """Register a magnet and return its configuration handle.

    Returns a ``MagnetHandle`` on which to set material parameters::

        layer = fm.geometry(fm.Box(1e-6, 1e-6, 1e-8), name="py")
        layer.Ms  = 800e3
        layer.Aex = 13e-12

    Multiple calls register multiple magnets.
    """
    handle = MagnetHandle(shape, name)
    _state._magnets.append(handle)
    return handle


# ---------------------------------------------------------------------------
# Solver
# ---------------------------------------------------------------------------

def solver(
    *,
    dt: float | None = None,
    max_error: float | None = None,
    integrator: str | None = None,
    gamma: float | None = None,
    g: float | None = None,
) -> None:
    """Configure the time integrator.

    Parameters
    ----------
    dt : float, optional
        Fixed timestep in seconds. When ``max_error`` is also provided, this
        becomes the initial timestep for adaptive RK23/RK45 stepping.
    max_error : float, optional
        Adaptive integrator error tolerance.
    integrator : str, optional
        Integrator name: ``"heun"``, ``"rk4"``, ``"rk23"``, ``"rk45"``.
    gamma : float, optional
        Gyromagnetic ratio in Fullmag internal units of ``m / (A s)``.
    g : float, optional
        Electron ``g``-factor. When provided, Fullmag derives
        ``gamma = mu0 * g * mu_B / hbar``.
    """
    if gamma is not None and g is not None:
        raise ValueError("solver() accepts either gamma=... or g=..., not both")
    if dt is not None:
        _state._dt = dt
    if max_error is not None:
        _state._max_error = max_error
    if integrator is not None:
        _state._integrator = integrator
    if gamma is not None:
        if gamma <= 0.0:
            raise ValueError("gamma must be positive")
        _state._gamma = gamma
    elif g is not None:
        if g <= 0.0:
            raise ValueError("g must be positive")
        _state._gamma = _gamma_from_g_factor(g)


# ---------------------------------------------------------------------------
# External fields
# ---------------------------------------------------------------------------

def b_ext(
    magnitude: float,
    by: float | None = None,
    bz: float | None = None,
    *,
    theta: float | None = None,
    phi: float | None = None,
) -> None:
    """Set uniform external field **B** in Tesla.

    Two calling conventions:

    * **Cartesian** – ``fm.b_ext(bx, by, bz)``
    * **Spherical** – ``fm.b_ext(magnitude, theta=…, phi=…)``
      where *theta* is the polar angle from +z (degrees)
      and *phi* is the azimuthal angle from +x in the xy-plane (degrees).
    """
    import math

    if theta is not None or phi is not None:
        # Spherical mode: magnitude + angles
        if by is not None or bz is not None:
            raise TypeError(
                "Cannot mix positional (bx,by,bz) with keyword (theta,phi) arguments"
            )
        _theta = math.radians(theta if theta is not None else 0.0)
        _phi = math.radians(phi if phi is not None else 0.0)
        bx = magnitude * math.sin(_theta) * math.cos(_phi)
        by_val = magnitude * math.sin(_theta) * math.sin(_phi)
        bz_val = magnitude * math.cos(_theta)
        _state._b_ext = (bx, by_val, bz_val)
    else:
        # Cartesian mode: b_ext(bx, by, bz)
        if by is None or bz is None:
            raise TypeError("b_ext() requires either (bx, by, bz) or (magnitude, theta=…, phi=…)")
        _state._b_ext = (magnitude, by, bz)


def antenna_field_source(
    *,
    name: str,
    antenna: Antenna,
    drive: RfDrive,
    solver: str = "mqs_2p5d_az",
    air_box_factor: float = 12.0,
) -> AntennaFieldSource:
    source = AntennaFieldSource(
        name=name,
        antenna=antenna,
        drive=drive,
        solver=solver,
        air_box_factor=air_box_factor,
    )
    _state._current_modules.append(source)
    return source


def spin_wave_excitation(
    *,
    source: str,
    method: str = "source_k_profile",
    propagation_axis: Sequence[float] = (1.0, 0.0, 0.0),
    k_max_rad_per_m: float | None = None,
    samples: int = 256,
) -> SpinWaveExcitationAnalysis:
    analysis = SpinWaveExcitationAnalysis(
        source=source,
        method=method,
        propagation_axis=tuple(float(component) for component in propagation_axis),
        k_max_rad_per_m=k_max_rad_per_m,
        samples=samples,
    )
    _state._excitation_analysis = analysis
    return analysis


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

_SCALAR_QUANTITIES = {
    "E_ex",
    "E_demag",
    "E_ext",
    "E_ani",
    "E_dmi",
    "E_total",
    "time",
    "step",
    "solver_dt",
    "mx",
    "my",
    "mz",
    "max_h_eff",
    "max_dm_dt",
    "max_h_demag",
}
_TABLE_DEFAULT_SCALARS = (
    "time",
    "step",
    "solver_dt",
    "mx",
    "my",
    "mz",
    "E_total",
    "max_dm_dt",
    "max_h_eff",
)


_EIGEN_QUANTITIES = {"spectrum", "mode", "dispersion"}


def save(
    quantity: str,
    *,
    every: float | None = None,
    indices: Sequence[int] | None = None,
) -> None:
    """Register an output quantity to save periodically.

    Parameters
    ----------
    quantity : str
        Field name (``"m"``, ``"H_demag"``, ``"H_eff"``),
        scalar name (``"E_ex"``, ``"E_total"``, ``"max_h_eff"``),
        or eigen quantity (``"spectrum"``, ``"mode"``, ``"dispersion"``).
    every : float, optional
        Save interval in seconds.  Required for field/scalar outputs,
        ignored for eigen outputs.
    indices : sequence of int, optional
        Mode indices for ``"mode"`` output.
    """
    if quantity in _EIGEN_QUANTITIES:
        if quantity == "spectrum":
            _state._outputs.append(SaveSpectrum())
        elif quantity == "mode":
            if indices is None:
                raise ValueError("save('mode', indices=[...]) requires mode indices")
            _state._outputs.append(SaveMode(indices=tuple(indices)))
        elif quantity == "dispersion":
            _state._outputs.append(SaveDispersion())
        return
    if every is None:
        raise ValueError("save() requires every= for field/scalar outputs")
    if quantity in _SCALAR_QUANTITIES or quantity.startswith("E_"):
        _state._outputs.append(SaveScalar(scalar=quantity, every=every))
    else:
        _state._outputs.append(SaveField(field=quantity, every=every))


def snapshot(
    layer_or_quantity: "str | MagnetHandle",
    quantity: str | None = None,
    *,
    every: float,
) -> None:
    """Register a periodic field-component snapshot.

    Parameters
    ----------
    layer_or_quantity : str or MagnetHandle
        If a string, it is parsed as the quantity (e.g. ``"mz"``, ``"m"``,
        ``"H_demag_x"``).  If a :class:`MagnetHandle`, it selects the layer
        and the second positional argument is the quantity.
    quantity : str, optional
        Quantity string when *layer_or_quantity* is a layer handle.
    every : float
        Snapshot interval in seconds.

    Examples
    --------
    ::

        fm.snapshot("mz", every=1e-13)            # mz of all layers
        fm.snapshot(layer, "mz", every=1e-13)     # mz of specific layer
        fm.snapshot("H_demag_x", every=50e-12)    # x-component of demag field
    """
    layer_name: str | None = None

    if isinstance(layer_or_quantity, MagnetHandle):
        # fm.snapshot(layer, "mz", every=...)
        if quantity is None:
            raise TypeError(
                "snapshot(layer, quantity, *, every=...) requires a quantity string "
                "when the first arg is a layer handle"
            )
        layer_name = layer_or_quantity._name
        raw_quantity = quantity
    elif isinstance(layer_or_quantity, str):
        # fm.snapshot("mz", every=...)
        if quantity is not None:
            raise TypeError(
                "snapshot() got two string arguments — pass a layer handle as the "
                "first arg if you want layer-specific snapshots"
            )
        raw_quantity = layer_or_quantity
    else:
        raise TypeError(
            f"snapshot() first arg must be a str or MagnetHandle, got {type(layer_or_quantity).__name__}"
        )

    field, component = parse_snapshot_quantity(raw_quantity)
    _state._outputs.append(Snapshot(field=field, component=component, every=every, layer=layer_name))


def tableautosave(every: float) -> None:
    """Configure a mumax-style scalar table autosave cadence.

    Registers the default time-series table columns:
    ``time``, ``step``, ``solver_dt``, averaged ``mx/my/mz``,
    ``E_total``, ``max_dm_dt``, and ``max_h_eff``.
    Existing scalar outputs for those names are replaced so the cadence is
    always unambiguous.
    """
    retained_outputs = []
    for output in _state._outputs:
        if isinstance(output, SaveScalar) and output.scalar in _TABLE_DEFAULT_SCALARS:
            continue
        retained_outputs.append(output)
    _state._outputs = retained_outputs
    for scalar in _TABLE_DEFAULT_SCALARS:
        _state._outputs.append(SaveScalar(scalar=scalar, every=every))


def name(problem_name: str) -> None:
    """Set the simulation name."""
    _state._name = problem_name


# ---------------------------------------------------------------------------
# Build Problem from accumulated state
# ---------------------------------------------------------------------------

def _build_problem(
    *,
    study_kind: str = "time_evolution",
    relax_algorithm: str = "llg_overdamped",
    relax_torque_tolerance: float = 1e-6,
    relax_energy_tolerance: float | None = None,
    relax_max_steps: int = 50_000,
    eigen_count: int = 10,
    eigen_target: str = "lowest",
    eigen_target_frequency: float | None = None,
    eigen_include_demag: bool = True,
    eigen_equilibrium_source: str = "relax",
    eigen_equilibrium_artifact: str | None = None,
    eigen_normalization: str = "unit_l2",
    eigen_damping_policy: str = "ignore",
    eigen_k_vector: tuple[float, float, float] | None = None,
    eigen_spin_wave_bc: str | dict[str, object] = "free",
) -> Problem:
    """Construct a Problem from the current world state."""
    s = _state

    # ── Validate ──
    if not s._magnets:
        raise ValueError("No magnets defined — call fm.geometry(...) first")

    # Convert handles to Ferromagnet objects
    magnets = [h._to_ferromagnet() for h in s._magnets]

    # Energy terms — default to Exchange + Demag (like mumax)
    energy: list = [Exchange(), Demag(realization=s._demag_realization)]
    # Check if any magnet has DMI
    for h in s._magnets:
        if h.Dind is not None:
            energy.append(InterfacialDMI(D=h.Dind))
            break
    if s._b_ext is not None:
        energy.append(Zeeman(B=s._b_ext))

    # Outputs
    outputs = s._outputs if s._outputs else [
        SaveField(field="m", every=1e-12),
        SaveScalar(scalar="E_total", every=1e-12),
    ]

    # Dynamics
    llg_kwargs: dict[str, Any] = {}
    if s._max_error is not None:
        adaptive_kwargs: dict[str, Any] = {"atol": s._max_error}
        if s._dt is not None:
            adaptive_kwargs["dt_initial"] = s._dt
        llg_kwargs["adaptive_timestep"] = AdaptiveTimestep(**adaptive_kwargs)
    elif s._dt is not None:
        llg_kwargs["fixed_timestep"] = s._dt
    if s._integrator is not None:
        llg_kwargs["integrator"] = s._integrator
    if s._gamma is not None and not math.isclose(s._gamma, DEFAULT_GAMMA):
        llg_kwargs["gamma"] = s._gamma
    dynamics = LLG(**llg_kwargs)

    # Discretization
    disc_kwargs: dict[str, Any] = {}
    if s._cell is not None:
        fdm_kwargs: dict[str, Any] = {"cell": s._cell}
        if s._boundary_correction is not None:
            fdm_kwargs["boundary_correction"] = s._boundary_correction
        disc_kwargs["fdm"] = FDM(**fdm_kwargs)
    fem_hint = _resolve_flat_fem_hint()
    if fem_hint is not None:
        disc_kwargs["fem"] = fem_hint

    # Runtime
    rt = RuntimeSelection()
    if s._backend != "auto":
        rt = rt.engine(s._backend)
    if s._device == "cuda":
        rt = rt.cuda(s._gpu_count)
        if s._device_index is not None:
            rt = rt.device(s._device_index)
    elif s._device == "cpu":
        rt = rt.cpu()
    elif s._device == "gpu":
        rt = rt.gpu(s._gpu_count)
    if s._precision is not None:
        rt = rt.precision(s._precision)

    runtime_metadata: dict[str, Any] = {"interactive_session_requested": s._interactive}
    runtime_metadata["script_api_surface"] = s._api_surface
    if s._study_universe is not None:
        runtime_metadata["study_universe"] = s._study_universe.to_ir()
    if s._wait_for_solve:
        runtime_metadata["wait_for_solve"] = True
    if s._adaptive_mesh is not None:
        runtime_metadata["adaptive_mesh"] = dict(s._adaptive_mesh)
    mesh_workflow = _collect_mesh_workflow_metadata()
    if mesh_workflow is not None:
        runtime_metadata["mesh_workflow"] = mesh_workflow

    # Partition outputs: eigen-specific vs time-domain (field/scalar/snapshot).
    _EIGEN_OUTPUT_TYPES = (SaveSpectrum, SaveMode, SaveDispersion)
    eigen_outputs = [o for o in outputs if isinstance(o, _EIGEN_OUTPUT_TYPES)]
    td_outputs = [o for o in outputs if not isinstance(o, _EIGEN_OUTPUT_TYPES)]

    if study_kind == "relaxation":
        study = Relaxation(
            outputs=td_outputs or [
                SaveField(field="m", every=1e-12),
                SaveScalar(scalar="E_total", every=1e-12),
            ],
            algorithm=relax_algorithm,
            torque_tolerance=relax_torque_tolerance,
            energy_tolerance=relax_energy_tolerance,
            max_steps=relax_max_steps,
            dynamics=dynamics,
        )
    elif study_kind == "eigenmodes":
        if not eigen_outputs:
            eigen_outputs = [SaveSpectrum()]
        study = Eigenmodes(
            outputs=eigen_outputs,
            count=eigen_count,
            target=eigen_target,
            target_frequency=eigen_target_frequency,
            include_demag=eigen_include_demag,
            equilibrium_source=eigen_equilibrium_source,
            equilibrium_artifact=eigen_equilibrium_artifact,
            normalization=eigen_normalization,
            damping_policy=eigen_damping_policy,
            spin_wave_bc=eigen_spin_wave_bc,
            k_vector=eigen_k_vector,
            dynamics=dynamics,
        )
    else:
        study = TimeEvolution(dynamics=dynamics, outputs=td_outputs or outputs)

    return Problem(
        name=s._name,
        magnets=magnets,
        energy=energy,
        study=study,
        discretization=DiscretizationHints(**disc_kwargs) if disc_kwargs else None,
        runtime=rt,
        runtime_metadata=runtime_metadata,
        current_modules=tuple(s._current_modules),
        excitation_analysis=s._excitation_analysis,
        geometry_asset_cache=s._geometry_asset_cache,
        pbc=s._pbc,
    )


# ---------------------------------------------------------------------------
# Run / Relax
# ---------------------------------------------------------------------------

def run(until: float) -> Any:
    """Build the problem and run until the given simulation time."""
    if until <= 0.0:
        raise ValueError("run(until) requires a positive stop time")
    from fullmag.runtime import Simulation
    problem = _build_problem()
    if _capture_enabled:
        _captured_stages.append(
            CapturedStage(
                problem=problem,
                entrypoint_kind="flat_run",
                default_until_seconds=until,
            )
        )
        return problem
    result = Simulation(problem).run(until=until)
    _record_result(result)
    return result


def _evaluate_runwhile_condition(condition: QuantityCondition | Callable[[], bool] | bool) -> bool:
    if isinstance(condition, QuantityCondition):
        return condition.evaluate()
    if callable(condition):
        return bool(condition())
    return bool(condition)


def run_while(
    condition: QuantityCondition | Callable[[], bool] | bool,
    *,
    chunk_time: float,
    max_time: float | None = None,
    max_steps: int | None = None,
    relax: bool = False,
    **kwargs: object,
) -> Any:
    """Run in chunks while a condition is true, with explicit safety guards.

    Notes
    -----
    * `chunk_time` is in seconds of simulation time.
    * At least one guard (`max_time` or `max_steps`) is required.
    * `max_steps` guards the accumulated solver steps across all chunks.
    """
    relax_kwargs: dict[str, object] = {}
    relax_fn = globals()["relax"]
    if kwargs:
        if relax:
            allowed = {"tol", "algorithm", "energy_tolerance", "relax_alpha"}
            unsupported = sorted(set(kwargs) - allowed)
            if unsupported:
                names = ", ".join(unsupported)
                raise TypeError(f"Unsupported run_while keyword arguments: {names}")
            relax_kwargs = {key: kwargs[key] for key in allowed if key in kwargs}
        else:
            unsupported = ", ".join(sorted(kwargs))
            raise TypeError(f"Unsupported run_while keyword arguments: {unsupported}")
    cfg = RunWhileConfig(
        chunk_time=float(chunk_time),
        max_time=max_time,
        max_steps=max_steps,
        relax=relax,
    )

    if _capture_enabled:
        if cfg.relax:
            initial_dt = _safe_step_value(_state._last_step, "dt", 1e-13)
            dt_ref = initial_dt if initial_dt > 0.0 else 1e-13
            chunk_steps = max(1, int(math.ceil(cfg.chunk_time / dt_ref)))
            if cfg.max_steps is not None:
                chunk_steps = min(chunk_steps, cfg.max_steps)
            return relax_fn(
                tol=float(relax_kwargs.get("tol", 1e-6)),
                max_steps=chunk_steps,
                algorithm=str(relax_kwargs.get("algorithm", "llg_overdamped")),
                energy_tolerance=relax_kwargs.get("energy_tolerance"),  # type: ignore[arg-type]
                relax_alpha=relax_kwargs.get("relax_alpha", 1.0),  # type: ignore[arg-type]
            )
        until = cfg.max_time if cfg.max_time is not None else cfg.chunk_time * float(cfg.max_steps)
        return run(until)

    total_time = 0.0
    total_solver_steps = 0
    last_result: Any | None = None
    needs_warmup = _state._last_step is None and isinstance(condition, QuantityCondition)

    while True:
        if cfg.max_steps is not None and total_solver_steps >= cfg.max_steps:
            break
        if cfg.max_time is not None and total_time >= cfg.max_time:
            break
        if not needs_warmup and not _evaluate_runwhile_condition(condition):
            break

        chunk = cfg.chunk_time
        if cfg.max_time is not None:
            chunk = min(chunk, cfg.max_time - total_time)
            if chunk <= 0.0:
                break

        if cfg.relax:
            dt_ref = _safe_step_value(_state._last_step, "dt", 1e-13)
            if not math.isfinite(dt_ref) or dt_ref <= 0.0:
                dt_ref = 1e-13
            chunk_steps = max(1, int(math.ceil(chunk / dt_ref)))
            if cfg.max_steps is not None:
                remaining = cfg.max_steps - total_solver_steps
                if remaining <= 0:
                    break
                chunk_steps = min(chunk_steps, remaining)
            last_result = relax_fn(
                tol=float(relax_kwargs.get("tol", 1e-6)),
                max_steps=chunk_steps,
                algorithm=str(relax_kwargs.get("algorithm", "llg_overdamped")),
                energy_tolerance=relax_kwargs.get("energy_tolerance"),  # type: ignore[arg-type]
                relax_alpha=relax_kwargs.get("relax_alpha", 1.0),  # type: ignore[arg-type]
            )
        else:
            last_result = run(chunk)
        _set_magnetization_continuation_from_result(last_result)

        step_count = len(getattr(last_result, "steps", ()) or ())
        total_solver_steps += max(1, int(step_count))
        if step_count > 0:
            dt_used = _safe_step_value(_latest_step(), "dt", 0.0)
            if math.isfinite(dt_used) and dt_used > 0.0:
                total_time += float(step_count) * dt_used
            else:
                total_time += float(chunk)
        else:
            total_time += float(chunk)
        needs_warmup = False

        if getattr(last_result, "status", "completed") != "completed":
            break

    if last_result is not None:
        return last_result
    if _state._last_result is not None:
        return _state._last_result
    raise RuntimeError("run_while executed zero chunks and no prior result exists.")


def RunWhile(
    condition: QuantityCondition | Callable[[], bool] | bool,
    *,
    chunk_time: float,
    max_time: float | None = None,
    max_steps: int | None = None,
    relax: bool = False,
    **kwargs: object,
) -> Any:
    return run_while(
        condition,
        chunk_time=chunk_time,
        max_time=max_time,
        max_steps=max_steps,
        relax=relax,
        **kwargs,
    )


def relax(
    *,
    tol: float = 1e-6,
    max_steps: int = 50_000,
    algorithm: str = "llg_overdamped",
    energy_tolerance: float | None = None,
    relax_alpha: float | None = 1.0,
) -> Any:
    """Build the problem and run a relaxation study.

    Parameters
    ----------
    tol : float
        Torque convergence tolerance (max |m × H_eff|).
    max_steps : int
        Maximum number of relaxation steps.
    algorithm : str
        Relaxation algorithm: ``"llg_overdamped"``, ``"projected_gradient_bb"``,
        ``"nonlinear_cg"``, or ``"tangent_plane_implicit"``.
    energy_tolerance : float, optional
        Energy convergence tolerance (|ΔE| between steps).
    relax_alpha : float or None
        Gilbert damping override used *only* during relaxation.
        Default ``1.0`` gives optimal convergence for overdamped LLG.
        Set to ``None`` to keep each magnet's own material α.
        The original material α is automatically restored after relaxation.
    """
    from fullmag.runtime import Simulation
    problem = _build_problem(
        study_kind="relaxation",
        relax_algorithm=algorithm,
        relax_torque_tolerance=tol,
        relax_energy_tolerance=energy_tolerance,
        relax_max_steps=max_steps,
    )

    # Override damping for relaxation (does not affect subsequent fm.run()
    # calls because _build_problem() constructs a fresh Problem each time).
    if relax_alpha is not None:
        import dataclasses
        new_magnets = [
            dataclasses.replace(
                magnet,
                material=dataclasses.replace(magnet.material, alpha=relax_alpha),
            )
            for magnet in problem.magnets
        ]
        problem = dataclasses.replace(problem, magnets=new_magnets)

    if _capture_enabled:
        _captured_stages.append(
            CapturedStage(
                problem=problem,
                entrypoint_kind="flat_relax",
                default_until_seconds=None,
            )
        )
        return problem

    if isinstance(problem.study, Relaxation):
        fixed_timestep = problem.study.dynamics.fixed_timestep
        adaptive_timestep = problem.study.dynamics.adaptive_timestep
        initial_timestep = fixed_timestep
        if initial_timestep is None and adaptive_timestep is not None:
            initial_timestep = adaptive_timestep.dt_initial
        until_seconds = (initial_timestep or 1e-13) * max_steps
    else:
        until_seconds = 1e-13 * max_steps
    result = Simulation(problem).run(until=until_seconds)
    _record_result(result)
    return result


def eigenmodes(
    *,
    count: int = 10,
    target: str = "lowest",
    target_frequency: float | None = None,
    include_demag: bool = True,
    equilibrium_source: str = "relax",
    equilibrium_artifact: str | None = None,
    normalization: str = "unit_l2",
    damping_policy: str = "ignore",
    k_vector: tuple[float, float, float] | None = None,
    bc: str | dict[str, object] = "free",
) -> Any:
    """Build the problem and queue/run an eigenmodes analysis.

    Parameters
    ----------
    count : int
        Number of eigenfrequencies/modes to compute.
    target : str
        ``"lowest"`` or ``"nearest"`` target selection strategy.
    target_frequency : float, optional
        Target frequency in Hz when ``target="nearest"``.
    include_demag : bool
        Include demagnetization in the linearized operator.
    equilibrium_source : str
        ``"relax"`` — use preceding relaxation result,
        ``"provided"`` — use initial magnetization as-is,
        ``"artifact"`` — load from file.
    equilibrium_artifact : str, optional
        Path to equilibrium artifact when ``equilibrium_source="artifact"``.
    normalization : str
        ``"unit_l2"`` or ``"unit_max_amplitude"``.
    damping_policy : str
        ``"ignore"`` or ``"include"``.
    k_vector : tuple, optional
        Bloch k-vector for dispersion sampling.
    """
    from fullmag.runtime import Simulation
    problem = _build_problem(
        study_kind="eigenmodes",
        eigen_count=count,
        eigen_target=target,
        eigen_target_frequency=target_frequency,
        eigen_include_demag=include_demag,
        eigen_equilibrium_source=equilibrium_source,
        eigen_equilibrium_artifact=equilibrium_artifact,
        eigen_normalization=normalization,
        eigen_damping_policy=damping_policy,
        eigen_k_vector=k_vector,
        eigen_spin_wave_bc=bc,
    )

    if _capture_enabled:
        _captured_stages.append(
            CapturedStage(
                problem=problem,
                entrypoint_kind="flat_eigenmodes",
                default_until_seconds=None,
            )
        )
        return problem

    result = Simulation(problem).run()
    _record_result(result)
    return result
