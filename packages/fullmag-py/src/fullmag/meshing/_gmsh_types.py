from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass, field, fields, replace
import hashlib
import itertools
import json
import math
import operator
from pathlib import Path
import struct
from types import MappingProxyType
from typing import Any, Iterator, Mapping
from weakref import WeakSet
import numpy as np
from numpy.typing import NDArray

from fullmag._validation import parse_bool, parse_finite_float, parse_integer
from fullmag.model.discretization import _MESH_SIZE_PRESET_ALIASES


FEM_TOPOLOGY_VOLUME_EPS = 1.0e-30 / 6.0
FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS = 64.0 * np.finfo(np.float64).eps
FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M = 1.0e-15
FEM_EXACT_LAYER_PLANE_REL_TOLERANCE = 1.0e-8
MIXED_SHARED_GMSH_VERSION = "4.15.2"
MIXED_SHARED_GEO_STRATEGY = "shared_geo_extrusion_partitioned_pyramid_tet.v2"
MIXED_INTERFACE_MARKER = 10
MIXED_QUALITY_METRIC = "mixed_topology_scaled_jacobian.v1"
MIXED_SCALED_JACOBIAN_P05_MIN = 0.1
MIXED_PYRAMID_APEX_SCALE_STEP = 0.001
MIXED_PYRAMID_APEX_SCALE_MAX = 1.25

FEM_CELL_ARITIES = {"tet4": 4, "prism6": 6, "pyramid5": 5, "hex8": 8}
FEM_FACET_ARITIES = {"tri3": 3, "quad4": 4}
FEM_FACET_ROLES = {"exterior", "material_interface", "periodic_seam"}
VTK_CELL_TYPES = {"tet4": 10, "hex8": 12, "prism6": 13, "pyramid5": 14}


class MeshValidationError(RuntimeError):
    """Fail-closed rejection of an invalid realized mesh."""


class MixedPeriodicTopologyError(ValueError):
    """Typed early rejection for a mixed/non-tetrahedral periodic request."""

    code = "mixed_periodic_topology_unsupported"
    pointer = "/mesh_options/periodic_pair_ids"

    def __init__(self, *, strategy: str | None, context: str) -> None:
        self.strategy = strategy
        self.context = context
        rendered = strategy if strategy is not None else "auto"
        super().__init__(
            f"{self.code} at {self.pointer}: {context} requests "
            f"mesh_strategy={rendered!r} with periodic pairs, but the mixed/non-tet "
            "periodic certificate is not implemented; use free_tetrahedral or "
            "remove periodic_pair_ids"
        )


def validate_periodic_mesh_options(options: "MeshOptions", *, context: str) -> None:
    """Reject periodic requests before a swept mixed mesh reaches Gmsh.

    The native and typed validators intentionally support periodic topology
    only for tet4/tri3.  Swept prism/hex routes (including ``auto`` with an
    explicit layer count) produce a non-tet topology, so accepting the request
    and failing only during extraction would leave the DSL/UI contract split
    from the generator contract.
    """
    if not options.periodic_pair_ids:
        return
    strategy = options.mesh_strategy
    swept = strategy in {"swept_prism", "swept_hex"} or (
        strategy in {None, "auto"}
        and options.through_thickness_elements is not None
        and options.through_thickness_elements > 0
    )
    if swept:
        raise MixedPeriodicTopologyError(strategy=strategy, context=context)


def _mixed_deterministic_inputs() -> dict[str, object]:
    """Return the frozen deterministic policy for the historical v1 route."""
    return {
        "algorithm_2d": 6,
        "algorithm_3d": 1,
        "element_order": 1,
        "gmsh_version": MIXED_SHARED_GMSH_VERSION,
        "random_factor": 0.0,
        "thread_count": 1,
        "transition_partition": "cartesian_3x3x3_minus_magnetic_center",
        "transition_volume_count": 26,
        "pyramid_apex_optimizer": "bounded_per_apex_outward_scale_line_search",
        "pyramid_apex_scale_step": MIXED_PYRAMID_APEX_SCALE_STEP,
        "pyramid_apex_scale_max": MIXED_PYRAMID_APEX_SCALE_MAX,
        "scaled_jacobian_p05_min": MIXED_SCALED_JACOBIAN_P05_MIN,
    }


def _mixed_v2_deterministic_inputs(
    *,
    requested_algorithm_3d: int = 1,
    transition_algorithm_3d: int = 1,
    tetrahedral_algorithm_3d: int = 1,
    optimizer: str | None = None,
    optimizer_iterations: int = 0,
) -> dict[str, object]:
    """Return the complete deterministic policy for a mixed v2 realization.

    The historical v2 route used Delaunay (1) for every volume.  The hybrid
    route keeps that algorithm for the structured Box/transition stage while
    using the authored HXT policy for the annulus and far-air tetrahedra.  The
    explicit fields prevent consumers from inferring a single algorithm from
    the legacy ``algorithm_3d`` key.
    """
    return {
        "algorithm_2d": 6,
        "algorithm_3d": int(requested_algorithm_3d),
        "requested_algorithm_3d": int(requested_algorithm_3d),
        "transition_algorithm_3d": int(transition_algorithm_3d),
        "tetrahedral_algorithm_3d": int(tetrahedral_algorithm_3d),
        "optimizer": optimizer,
        "optimizer_iterations": int(optimizer_iterations),
        "element_order": 1,
        "gmsh_version": MIXED_SHARED_GMSH_VERSION,
        "random_factor": 0.0,
        "thread_count": 1,
        "transition_partition": "cartesian_3x3x3_minus_magnetic_center",
        "transition_volume_count": 26,
        "pyramid_apex_optimizer": "bounded_per_apex_outward_scale_line_search",
        "pyramid_apex_scale_step": MIXED_PYRAMID_APEX_SCALE_STEP,
        "pyramid_apex_scale_max": MIXED_PYRAMID_APEX_SCALE_MAX,
        "scaled_jacobian_p05_min": MIXED_SCALED_JACOBIAN_P05_MIN,
    }


def _strict_bounds_vector(value: object, name: str) -> tuple[float, float, float]:
    if not isinstance(value, tuple) or len(value) != 3 or any(
        not isinstance(item, float) or not math.isfinite(item) for item in value
    ):
        raise TypeError(
            f"mixed layer topology certificate {name} must be a tuple of three finite floats"
        )
    return value

# Keep this dispatch table keyed by Gmsh's exact linear element IDs instead of
# accepting a compatible-looking prefix of higher-order connectivity.
SUPPORTED_VOLUME_ELEMENTS: dict[int, tuple[str, int]] = {
    4: ("tet4", 4),
    5: ("hex8", 8),
    6: ("prism6", 6),
    7: ("pyramid5", 5),
}
SUPPORTED_BOUNDARY_ELEMENTS: dict[int, tuple[str, int]] = {
    2: ("tri3", 3),
    3: ("quad4", 4),
}


@dataclass(frozen=True, slots=True)
class MeshQualityReport:
    """Per-element quality metrics extracted from Gmsh.

    Attributes:
        n_elements: Total element count.
        sicn_min: Minimum Signed Inverse Condition Number (ideal → 1).
        sicn_max: Maximum SICN.
        sicn_mean: Mean SICN across all elements.
        sicn_p5: 5th-percentile SICN (worst-case tail).
        sicn_histogram: 20 bins across [-1, 1].
        gamma_min: Minimum inscribed/circumscribed ratio (ideal → 1).
        gamma_mean: Mean gamma.
        gamma_histogram: 20 bins across [0, 1].
        volume_min: Smallest element volume.
        volume_max: Largest element volume.
        volume_mean: Mean element volume.
        volume_std: Standard deviation of volumes.
        avg_quality: Global ``Mesh.AvgQuality`` (ICN) from Gmsh.
        element_sicn: Per-element SICN values (None if not requested).
        element_gamma: Per-element gamma values (None if not requested).
        element_volume: Per-element volume values aligned to mesh elements.
        element_tags: Gmsh element tags aligned to per-element quality arrays.
        quality_source: Source of the reported quality metrics.
        gamma_element_count: Number of elements for which Gmsh defines gamma.
        quality_by_family: Bounded Gmsh quality summaries keyed by cell family.
    """

    n_elements: int
    sicn_min: float
    sicn_max: float
    sicn_mean: float
    sicn_p5: float
    sicn_histogram: list[int]
    gamma_min: float
    gamma_mean: float
    gamma_histogram: list[int]
    volume_min: float
    volume_max: float
    volume_mean: float
    volume_std: float
    avg_quality: float
    element_sicn: list[float] | None = None
    element_gamma: list[float] | None = None
    element_volume: list[float] | None = None
    element_tags: list[int] | None = None
    quality_source: str = "gmsh"
    gamma_element_count: int | None = None
    quality_by_family: dict[str, dict[str, object]] | None = None


@dataclass(frozen=True, slots=True)
class MeshStatisticsScope:
    """COMSOL-like statistics for one mesh scope."""

    id: str
    kind: str
    label: str
    role: str
    marker: int | None
    node_count: int
    element_count: int
    boundary_face_count: int
    volume_min: float
    volume_max: float
    volume_mean: float
    volume_std: float
    volume_ratio: float | None
    volume_total: float
    characteristic_size_min: float
    characteristic_size_max: float
    characteristic_size_mean: float
    characteristic_size_std: float
    characteristic_size_ratio: float | None
    characteristic_size_histogram: list[dict[str, object]]
    edge_length_min: float
    edge_length_max: float
    edge_length_mean: float
    edge_length_std: float
    inverted_count: int
    degenerate_count: int
    sicn: dict[str, object] | None = None
    gamma: dict[str, object] | None = None
    quality_by_family: dict[str, dict[str, object]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    volume_histogram: list[dict[str, object]] = field(default_factory=list)
    edge_length_histogram: list[dict[str, object]] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class MeshStatisticsReport:
    """Additive mesh statistics contract serialized next to quality summaries."""

    mesh_name: str
    quality_source: str
    global_scope: MeshStatisticsScope
    scopes: list[MeshStatisticsScope]
    worst_elements: list[dict[str, object]] = field(default_factory=list)
    worst_elements_by_metric: dict[str, list[dict[str, object]]] = field(
        default_factory=dict
    )


# ---------------------------------------------------------------------------
# Mesh generation options
# ---------------------------------------------------------------------------
# 2D algorithm constants
ALGO_2D_MESHADAPT = 1
ALGO_2D_AUTOMATIC = 2
ALGO_2D_DELAUNAY = 5
ALGO_2D_FRONTAL_DELAUNAY = 6
ALGO_2D_BAMG = 7
ALGO_2D_FRONTAL_QUADS = 8

# 3D algorithm constants
ALGO_3D_DELAUNAY = 1
ALGO_3D_FRONTAL = 4
ALGO_3D_MMG3D = 7
ALGO_3D_HXT = 10

MESH_SIZE_CALIBRATIONS = (
    "general_physics",
    "micromagnetics_static",
    "micromagnetics_relaxation",
    "micromagnetics_frequency_domain",
    "magnetostatics_dominated",
    "imported_surface_cleanup",
)
MESH_SIZE_PRESETS = (
    "extremely_fine",
    "extra_fine",
    "finer",
    "fine",
    "normal",
    "coarse",
    "coarser",
    "extra_coarse",
    "extremely_coarse",
)

GAMMA_MIN_QUALITY_THRESHOLD = 0.08
SICN_P05_QUALITY_THRESHOLD = 0.1

_MESH_SIZE_PRESET_DEFAULTS: dict[str, dict[str, float]] = {
    "extremely_fine": {"growth_rate": 1.2, "curvature_factor": 0.20, "narrow_region_resolution": 1.0},
    "extra_fine": {"growth_rate": 1.3, "curvature_factor": 0.25, "narrow_region_resolution": 0.85},
    "finer": {"growth_rate": 1.4, "curvature_factor": 0.4, "narrow_region_resolution": 0.7},
    "fine": {"growth_rate": 1.5, "curvature_factor": 0.5, "narrow_region_resolution": 0.6},
    "normal": {"growth_rate": 1.6, "curvature_factor": 0.6, "narrow_region_resolution": 0.5},
    "coarse": {"growth_rate": 1.8, "curvature_factor": 0.8, "narrow_region_resolution": 0.3},
    "coarser": {"growth_rate": 2.0, "curvature_factor": 1.0, "narrow_region_resolution": 0.2},
    "extra_coarse": {"growth_rate": 2.2, "curvature_factor": 1.2, "narrow_region_resolution": 0.15},
    "extremely_coarse": {"growth_rate": 2.4, "curvature_factor": 1.5, "narrow_region_resolution": 0.1},
}

@dataclass(frozen=True, slots=True)
class MeshOptions:
    """Advanced mesh generation options passed through to Gmsh.

    All fields have safe defaults that match Gmsh 4.x behaviour.
    """

    algorithm_2d: int = ALGO_2D_FRONTAL_DELAUNAY
    algorithm_3d: int = ALGO_3D_DELAUNAY
    hmin: float | None = None
    calibrate_for: str | None = None
    size_preset: str | None = None
    size_factor: float = 1.0
    size_from_curvature: int = 0
    curvature_factor: float | None = None
    growth_rate: float | None = None
    narrow_regions: int = 0
    narrow_region_resolution: float | None = None
    smoothing_steps: int = 1
    optimize: str | None = None
    optimize_iters: int = 1
    size_fields: list[dict[str, Any]] = field(default_factory=list)
    # Scoped minimum-size floors have different eligibility from upper targets
    # and are composed through the lower-bound branch of the Gmsh field stack.
    lower_bound_fields: list[dict[str, Any]] = field(default_factory=list)
    compute_quality: bool = True
    per_element_quality: bool = True
    # Boundary-layer extrusion settings (None = disabled)
    boundary_layer_count: int | None = None
    boundary_layer_thickness: float | None = None   # target first-layer thickness (SI)
    boundary_layer_stretching: float | None = None  # layer growth ratio (e.g. 1.2–1.5)
    boundary_layer_target_surface_tags: list[int] | None = None
    boundary_layer_target_curve_tags: list[int] | None = None
    boundary_layer_target_surface_selectors: list[dict[str, Any]] | None = None
    boundary_layer_target_curve_selectors: list[dict[str, Any]] | None = None

    # ── Swept mesh / through-thickness control ──
    mesh_strategy: str | None = None  # "auto" | "free_tetrahedral" | "swept_prism" | "swept_hex" | "thin_film_tetrahedral"
    through_thickness_elements: int | None = None   # explicit layer count for swept extrusion
    through_thickness_distribution: str | None = None  # "fixed" | "linear" | "exponential"
    through_thickness_element_ratio: float | None = None  # grading ratio for non-uniform distribution
    through_thickness_symmetric: bool = False  # mirror distribution about mid-plane
    sweep_face_meshing: str | None = None  # "triangular" → prisms, "quadrilateral" → hexes
    # Requested extrusion axis. ``auto`` is resolved from the geometry by the
    # swept generator; an explicit axis is carried through the typed options
    # boundary instead of being silently reconstructed from dimensions.
    sweep_direction: str | None = None  # "auto" | "x" | "y" | "z"
    sweep_source: str | None = None  # "auto" | face selector hint
    sweep_destination: str | None = None  # "auto" | face selector hint
    periodic_pair_ids: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        # ``MeshOptions`` is the typed boundary between authoring metadata and
        # Gmsh.  Normalize only values accepted by the contract; in
        # particular, do not let ``int(3.9)`` or ``bool`` silently select a
        # different mesh recipe.
        object.__setattr__(
            self,
            "algorithm_2d",
            int(parse_integer(self.algorithm_2d, "/mesh_options/algorithm_2d", minimum=1)),
        )
        object.__setattr__(
            self,
            "algorithm_3d",
            int(parse_integer(self.algorithm_3d, "/mesh_options/algorithm_3d", minimum=1)),
        )

        def optional_positive(name: str, value: object) -> float | None:
            return parse_finite_float(
                value,
                f"/mesh_options/{name}",
                positive=True,
                allow_none=True,
            )

        def optional_integer(name: str, value: object, minimum: int) -> int | None:
            return parse_integer(
                value,
                f"/mesh_options/{name}",
                minimum=minimum,
                allow_none=True,
            )

        def required_positive(name: str, value: object) -> float:
            parsed = parse_finite_float(
                value,
                f"/mesh_options/{name}",
                positive=True,
            )
            return float(parsed)

        object.__setattr__(self, "hmin", optional_positive("hmin", self.hmin))
        object.__setattr__(self, "size_factor", required_positive("size_factor", self.size_factor))
        object.__setattr__(
            self,
            "size_from_curvature",
            int(parse_integer(self.size_from_curvature, "/mesh_options/size_from_curvature", minimum=0)),
        )
        object.__setattr__(
            self,
            "curvature_factor",
            optional_positive("curvature_factor", self.curvature_factor),
        )
        normalized_growth_rate = optional_positive("growth_rate", self.growth_rate)
        if normalized_growth_rate is not None and normalized_growth_rate <= 1.0:
            raise TypedValidationError(
                code="numeric_range_error",
                pointer="/mesh_options/growth_rate",
                message="growth_rate must be greater than 1.0; use null to disable grading",
                value=normalized_growth_rate,
            )
        object.__setattr__(self, "growth_rate", normalized_growth_rate)
        object.__setattr__(
            self,
            "narrow_regions",
            int(parse_integer(self.narrow_regions, "/mesh_options/narrow_regions", minimum=0)),
        )
        object.__setattr__(
            self,
            "narrow_region_resolution",
            optional_positive("narrow_region_resolution", self.narrow_region_resolution),
        )
        object.__setattr__(
            self,
            "smoothing_steps",
            int(parse_integer(self.smoothing_steps, "/mesh_options/smoothing_steps", minimum=0)),
        )
        object.__setattr__(
            self,
            "optimize_iters",
            int(parse_integer(self.optimize_iters, "/mesh_options/optimize_iters", minimum=1)),
        )
        for name in (
            "boundary_layer_count",
            "through_thickness_elements",
        ):
            object.__setattr__(
                self,
                name,
                optional_integer(name, getattr(self, name), 1),
            )
        for name in (
            "boundary_layer_thickness",
            "boundary_layer_stretching",
            "through_thickness_element_ratio",
        ):
            object.__setattr__(self, name, optional_positive(name, getattr(self, name)))
        object.__setattr__(
            self,
            "through_thickness_symmetric",
            bool(parse_bool(
                self.through_thickness_symmetric,
                "/mesh_options/through_thickness_symmetric",
            )),
        )
        for name in ("compute_quality", "per_element_quality"):
            object.__setattr__(
                self,
                name,
                bool(parse_bool(getattr(self, name), f"/mesh_options/{name}")),
            )

        for name in (
            "boundary_layer_target_surface_tags",
            "boundary_layer_target_curve_tags",
        ):
            raw_tags = getattr(self, name)
            if raw_tags is None:
                continue
            if not isinstance(raw_tags, (list, tuple)):
                raise TypeError(f"/mesh_options/{name} must be a list of integers")
            object.__setattr__(
                self,
                name,
                [
                    int(parse_integer(tag, f"/mesh_options/{name}/{index}", minimum=1))
                    for index, tag in enumerate(raw_tags)
                ],
            )
        for name in (
            "boundary_layer_target_surface_selectors",
            "boundary_layer_target_curve_selectors",
        ):
            raw_selectors = getattr(self, name)
            if raw_selectors is None:
                continue
            if not isinstance(raw_selectors, (list, tuple)):
                raise TypeError(f"/mesh_options/{name} must be a list of mappings")
            if not all(isinstance(item, Mapping) for item in raw_selectors):
                raise TypeError(f"/mesh_options/{name} entries must be mappings")
            object.__setattr__(self, name, [dict(item) for item in raw_selectors])

        if self.optimize is not None:
            if not isinstance(self.optimize, str) or not self.optimize.strip():
                raise ValueError("/mesh_options/optimize must be a non-empty string or None")
            object.__setattr__(self, "optimize", self.optimize.strip())
        for name, choices in (
            (
                "mesh_strategy",
                {None, "auto", "free_tetrahedral", "thin_film_tetrahedral", "swept_prism", "swept_hex"},
            ),
            ("through_thickness_distribution", {None, "fixed", "linear", "exponential"}),
            ("sweep_face_meshing", {None, "triangular", "quadrilateral"}),
            ("sweep_direction", {None, "auto", "x", "y", "z"}),
        ):
            value = getattr(self, name)
            if value is not None and (not isinstance(value, str) or value not in choices):
                raise ValueError(f"/mesh_options/{name} has unsupported value {value!r}")
        for name in ("sweep_source", "sweep_destination"):
            value = getattr(self, name)
            if value is not None:
                if not isinstance(value, str) or not value.strip():
                    raise ValueError(f"/mesh_options/{name} must be a non-empty string or None")
                object.__setattr__(self, name, value.strip())
        if not isinstance(self.periodic_pair_ids, (list, tuple)):
            raise TypeError("/mesh_options/periodic_pair_ids must be a list of strings")

        calibration = _normalize_mesh_size_calibration(self.calibrate_for)
        preset = _normalize_mesh_size_preset(self.size_preset)
        if self.calibrate_for is not None:
            object.__setattr__(self, "calibrate_for", calibration)
        if self.size_preset is not None:
            object.__setattr__(self, "size_preset", preset)
        normalized_pair_ids: list[str] = []
        for pair_id in self.periodic_pair_ids:
            if not isinstance(pair_id, str) or not pair_id.strip():
                raise ValueError("periodic_pair_ids entries must be non-empty strings")
            normalized_pair_ids.append(pair_id.strip())
        object.__setattr__(self, "periodic_pair_ids", normalized_pair_ids)


@dataclass(frozen=True, slots=True)
class MeshSizeControls:
    calibrate_for: str | None = None
    size_preset: str | None = None
    maximum_element_size: float | None = None
    minimum_element_size: float | None = None
    maximum_element_growth_rate: float | None = None
    curvature_factor: float | None = None
    narrow_region_resolution: float | None = None
    legacy_size_from_curvature: int = 0
    legacy_narrow_regions: int = 0


@dataclass(frozen=True, slots=True)
class ResolvedMeshSizeControls:
    maximum_element_size: float | None
    minimum_element_size: float | None
    maximum_element_growth_rate: float | None
    curvature_factor: float | None
    narrow_region_resolution: float | None
    resolved_size_from_curvature: int
    resolved_narrow_regions: int
    resolved_growth_rate: float | None
    calibrate_for: str
    size_preset: str | None

    def as_dict(self) -> dict[str, object]:
        return {
            "calibrate_for": self.calibrate_for,
            "size_preset": self.size_preset,
            "maximum_element_size": self.maximum_element_size,
            "minimum_element_size": self.minimum_element_size,
            "maximum_element_growth_rate": self.maximum_element_growth_rate,
            "curvature_factor": self.curvature_factor,
            "narrow_region_resolution": self.narrow_region_resolution,
            "resolved_size_from_curvature": self.resolved_size_from_curvature,
            "resolved_narrow_regions": self.resolved_narrow_regions,
            "resolved_growth_rate": self.resolved_growth_rate,
        }


def _normalize_mesh_size_calibration(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"calibrate_for must be a string or None, got {value!r}")
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return None
    if normalized not in MESH_SIZE_CALIBRATIONS:
        raise ValueError(
            f"unsupported mesh calibration {value!r}; expected one of {MESH_SIZE_CALIBRATIONS!r}"
        )
    return normalized


def _normalize_mesh_size_preset(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"size_preset must be a string or None, got {value!r}")
    normalized = value.strip().lower().replace("-", "_")
    if not normalized:
        return None
    normalized = _MESH_SIZE_PRESET_ALIASES.get(normalized, normalized)
    if normalized not in MESH_SIZE_PRESETS:
        raise ValueError(
            f"unsupported mesh preset {value!r}; expected one of {MESH_SIZE_PRESETS!r}"
        )
    return normalized


def _mesh_size_controls_from_options(opts: MeshOptions) -> MeshSizeControls:
    return MeshSizeControls(
        calibrate_for=opts.calibrate_for,
        size_preset=opts.size_preset,
        minimum_element_size=opts.hmin,
        maximum_element_growth_rate=opts.growth_rate,
        curvature_factor=opts.curvature_factor,
        narrow_region_resolution=opts.narrow_region_resolution,
        legacy_size_from_curvature=opts.size_from_curvature,
        legacy_narrow_regions=opts.narrow_regions,
    )


def _resolve_curvature_points(
    size_from_curvature: int,
    curvature_factor: float | None,
) -> int:
    if size_from_curvature > 0:
        return size_from_curvature
    if curvature_factor is None:
        return 0
    # COMSOL-style curvature factors are usually fractional, where smaller
    # values imply stronger refinement. Gmsh expects an integer density
    # control, so convert the factor into a stable points-per-2π heuristic.
    clamped = min(max(float(curvature_factor), 0.05), 2.0)
    return max(6, min(64, int(round(8.0 / clamped))))


def _resolve_narrow_region_count(
    narrow_regions: int,
    narrow_region_resolution: float | None,
) -> int:
    if narrow_regions > 0:
        return narrow_regions
    if narrow_region_resolution is None:
        return 0
    clamped = min(max(float(narrow_region_resolution), 0.1), 2.0)
    return max(1, min(12, int(round(1.0 + 6.0 * clamped))))


def resolve_user_mesh_size_controls(
    controls: MeshSizeControls,
) -> ResolvedMeshSizeControls:
    calibration = _normalize_mesh_size_calibration(controls.calibrate_for) or "general_physics"
    preset = _normalize_mesh_size_preset(controls.size_preset)
    preset_defaults = _MESH_SIZE_PRESET_DEFAULTS.get(preset or "", {})
    curvature_factor = controls.curvature_factor
    if curvature_factor is None and "curvature_factor" in preset_defaults:
        curvature_factor = float(preset_defaults["curvature_factor"])
    narrow_region_resolution = controls.narrow_region_resolution
    if narrow_region_resolution is None and "narrow_region_resolution" in preset_defaults:
        narrow_region_resolution = float(preset_defaults["narrow_region_resolution"])
    growth_rate = controls.maximum_element_growth_rate
    if growth_rate is None and "growth_rate" in preset_defaults:
        growth_rate = float(preset_defaults["growth_rate"])
    return ResolvedMeshSizeControls(
        calibrate_for=calibration,
        size_preset=preset,
        maximum_element_size=controls.maximum_element_size,
        minimum_element_size=controls.minimum_element_size,
        maximum_element_growth_rate=growth_rate,
        curvature_factor=curvature_factor,
        narrow_region_resolution=narrow_region_resolution,
        resolved_size_from_curvature=_resolve_curvature_points(
            controls.legacy_size_from_curvature,
            curvature_factor,
        ),
        resolved_narrow_regions=_resolve_narrow_region_count(
            controls.legacy_narrow_regions,
            narrow_region_resolution,
        ),
        resolved_growth_rate=growth_rate,
    )


def resolve_mesh_size_controls(opts: MeshOptions) -> dict[str, object]:
    controls = _mesh_size_controls_from_options(opts)
    return resolve_user_mesh_size_controls(controls).as_dict()


@dataclass(frozen=True, slots=True)
class AirboxOptions:
    """Configuration for automatic airbox (open-boundary domain) generation.

    Attributes:
        padding_factor: Domain scale relative to magnetic body bbox
                        (e.g. 3.0 means air domain is 3× the body in each axis).
        shape: Outer shell geometry: ``"bbox"`` or ``"sphere"``.
        grading_ratio: Element growth ratio from interface toward outer boundary.
                       For geometric grading (default), this is the layer-to-layer
                       size ratio (h_{n+1}/h_n). Typical values: 1.2–1.5.
                       For linear grading (legacy), this controls dist_max.
        grading_mode: Mesh grading algorithm: ``"geometric"`` (default, COMSOL-like
                      exponential growth) or ``"linear"`` (legacy linear interpolation).
        boundary_marker: Gmsh physical group tag for the outer boundary Γ_out.
        maximum_element_size: Maximum element size for the airbox mesh (far field).
        minimum_element_size: Minimum element size for the airbox mesh (at interface).
    """

    padding_factor: float = 3.0
    shape: str = "bbox"
    grading_ratio: float = 1.3
    grading_mode: str = "geometric"
    boundary_marker: int = 99
    size: tuple[float, float, float] | None = None
    center: tuple[float, float, float] | None = None
    maximum_element_size: float | None = None
    minimum_element_size: float | None = None

    def __post_init__(self) -> None:
        # ``grading_ratio`` is a multiplicative layer-to-layer growth law for
        # the typed FEM airbox.  Values at or below one used to be accepted and
        # then silently disabled the field in the Gmsh builder, producing a
        # result different from the requested policy.
        ratio = parse_finite_float(
            self.grading_ratio,
            "/study_universe/airbox_growth_rate",
            positive=True,
            allow_numeric_string=True,
        )
        if ratio <= 1.0:
            raise ValueError(
                "study_universe.airbox_growth_rate must be greater than 1.0; "
                "use the default or provide a larger ratio"
            )
        object.__setattr__(self, "grading_ratio", float(ratio))


@dataclass(frozen=True, slots=True)
class SizeFieldData:
    """Nodal target element sizes for adaptive remeshing.

    Attributes:
        node_coords: (N, 3) array of node coordinates from the previous mesh.
        h_values: (N,) array of target element sizes at each node.
    """

    node_coords: NDArray[np.float64]
    h_values: NDArray[np.float64]

    def __post_init__(self) -> None:
        coords = np.asarray(self.node_coords, dtype=np.float64)
        h = np.asarray(self.h_values, dtype=np.float64)
        object.__setattr__(self, "node_coords", coords)
        object.__setattr__(self, "h_values", h)
        if coords.ndim != 2 or coords.shape[1] != 3:
            raise ValueError("node_coords must have shape (N, 3)")
        if h.ndim != 1 or h.shape[0] != coords.shape[0]:
            raise ValueError("h_values must have shape (N,)")
        if np.any(h <= 0):
            raise ValueError("h_values must be strictly positive")



@dataclass(frozen=True, slots=True)
class MeshCellBlockView:
    """One typed cell block with stable source ordinals and markers."""

    cell_type: str
    nodes: NDArray[np.int32]
    markers: NDArray[np.int32]
    global_ordinals: NDArray[np.int64]


@dataclass(frozen=True, slots=True)
class MeshFacetBlockView:
    """One typed/role facet block with stable source ordinals and markers."""

    facet_type: str
    role: str
    nodes: NDArray[np.int32]
    markers: NDArray[np.int32]
    global_ordinals: NDArray[np.int64]


@dataclass(frozen=True, slots=True)
class MeshRealizationReport:
    """Durable requested/resolved provenance for one mesh realization."""

    requested_topology: str
    resolved_topology: str
    requested_layers: int
    resolved_layers: int
    requested_axis: str
    resolved_axis: str
    requested_order: int
    resolved_order: int
    fallbacks_triggered: tuple[str, ...] = ()
    # ``requested_axis`` is retained as the concrete axis used by historical
    # consumers.  This optional field preserves the authored intent when the
    # caller requested classifier-driven ``auto`` resolution.
    requested_direction: str | None = None
    schema_version: str = "mesh_realization_report.v1"

    def __post_init__(self) -> None:
        if self.schema_version != "mesh_realization_report.v1":
            raise ValueError(
                "mesh realization report must use schema mesh_realization_report.v1"
            )
        if self.requested_topology not in FEM_CELL_ARITIES:
            raise ValueError("mesh realization report has unknown requested topology")
        if self.resolved_topology not in FEM_CELL_ARITIES:
            raise ValueError("mesh realization report has unknown resolved topology")
        for name, value in (
            ("requested_layers", self.requested_layers),
            ("resolved_layers", self.resolved_layers),
            ("requested_order", self.requested_order),
            ("resolved_order", self.resolved_order),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"mesh realization report {name} must be a positive integer")
        if self.requested_axis not in {"x", "y", "z"}:
            raise ValueError("mesh realization report has invalid requested axis")
        if self.resolved_axis not in {"x", "y", "z"}:
            raise ValueError("mesh realization report has invalid resolved axis")
        requested_direction = self.requested_direction or self.requested_axis
        if requested_direction not in {"auto", "x", "y", "z"}:
            raise ValueError("mesh realization report has invalid requested direction")
        object.__setattr__(self, "requested_direction", requested_direction)
        normalized_fallbacks: list[str] = []
        for item in self.fallbacks_triggered:
            if not isinstance(item, str) or not item.strip():
                raise ValueError("mesh realization report fallback markers must be non-empty strings")
            normalized_fallbacks.append(item)
        object.__setattr__(self, "fallbacks_triggered", tuple(normalized_fallbacks))
        requested = (
            self.requested_topology,
            self.requested_layers,
            self.requested_axis,
            self.requested_order,
        )
        resolved = (
            self.resolved_topology,
            self.resolved_layers,
            self.resolved_axis,
            self.resolved_order,
        )
        if (
            not normalized_fallbacks
            and requested_direction != "auto"
            and requested != resolved
        ):
            raise ValueError(
                "mesh realization report requested/resolved fields must match "
                "when no fallback was triggered"
            )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "requested_topology": self.requested_topology,
            "resolved_topology": self.resolved_topology,
            "requested_layers": self.requested_layers,
            "resolved_layers": self.resolved_layers,
            "requested_axis": self.requested_axis,
            "resolved_axis": self.resolved_axis,
            "requested_order": self.requested_order,
            "resolved_order": self.resolved_order,
            "requested_direction": self.requested_direction,
            "fallbacks_triggered": list(self.fallbacks_triggered),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> "MeshRealizationReport":
        raw_fallbacks = payload.get("fallbacks_triggered", [])
        if not isinstance(raw_fallbacks, (list, tuple)):
            raise TypeError("mesh realization report fallbacks_triggered must be an array")
        return cls(
            schema_version=str(payload.get("schema_version", "")),
            requested_topology=str(payload.get("requested_topology", "")),
            resolved_topology=str(payload.get("resolved_topology", "")),
            requested_layers=payload.get("requested_layers", 0),  # type: ignore[arg-type]
            resolved_layers=payload.get("resolved_layers", 0),  # type: ignore[arg-type]
            requested_axis=str(payload.get("requested_axis", "")),
            resolved_axis=str(payload.get("resolved_axis", "")),
            requested_order=payload.get("requested_order", 0),  # type: ignore[arg-type]
            resolved_order=payload.get("resolved_order", 0),  # type: ignore[arg-type]
            fallbacks_triggered=tuple(raw_fallbacks),  # type: ignore[arg-type]
            requested_direction=(
                str(payload["requested_direction"])
                if payload.get("requested_direction") is not None
                else None
            ),
        )


@dataclass(frozen=True, slots=True)
class MixedLayerTopologyCertificate:
    """Accepted shared-domain prism/pyramid/tet topology evidence."""

    certificate_status: str
    requested_sweep_direction: str
    resolved_sweep_direction: str
    requested_layer_count: int
    realized_layer_count: int
    magnetic_plane_coordinates_m: tuple[float, ...]
    plane_tolerance_m: float
    transition_shell_thickness_m: float
    transition_shell_interface_tri3_count: int
    interface_marker: int
    outer_boundary_marker: int
    magnetic_bounds_min_m: tuple[float, float, float]
    magnetic_bounds_max_m: tuple[float, float, float]
    airbox_bounds_min_m: tuple[float, float, float]
    airbox_bounds_max_m: tuple[float, float, float]
    magnetic_bounds_relative_error: float
    airbox_bounds_relative_error: float
    cell_family_counts_by_marker: dict[str, dict[str, int]]
    cell_family_counts_by_part: dict[str, dict[str, int]]
    facet_family_counts_by_role_marker: dict[str, dict[str, int]]
    jacobian_minima_m3_by_family: dict[str, float]
    quality_metric: str
    scaled_jacobian_minima_by_family: dict[str, float]
    scaled_jacobian_p05_by_family: dict[str, float]
    magnetic_volume_m3: float
    expected_magnetic_volume_m3: float
    magnetic_relative_volume_error: float
    air_volume_m3: float
    shared_domain_volume_m3: float
    expected_shared_domain_volume_m3: float
    shared_domain_relative_volume_error: float
    marker_coverage_complete: bool
    nonconforming_face_count: int
    orphan_face_count: int
    nonmanifold_face_count: int
    coincident_interface_face_count: int
    topology_fingerprint_version: str
    topology_fingerprint: str
    gmsh_version: str
    strategy: str
    effective_gmsh_thread_count: int
    deterministic_inputs: dict[str, object]
    fallbacks_triggered: tuple[str, ...] = ()
    schema_version: str = "mixed_layer_topology_certificate.v1"

    def __post_init__(self) -> None:
        if self.schema_version != "mixed_layer_topology_certificate.v1":
            raise ValueError(
                "mixed layer topology certificate must use schema "
                "mixed_layer_topology_certificate.v1"
            )
        if self.certificate_status != "accepted":
            raise ValueError("mixed layer topology certificate must be accepted")
        if self.requested_sweep_direction not in {"auto", "x", "y", "z"} or (
            self.resolved_sweep_direction not in {"x", "y", "z"}
        ):
            raise ValueError("mixed layer topology certificate has an invalid sweep direction")
        if self.requested_sweep_direction != "auto" and (
            self.requested_sweep_direction != self.resolved_sweep_direction
        ):
            raise ValueError("strict mixed layer topology cannot change sweep direction")
        for name, value in (
            ("requested_layer_count", self.requested_layer_count),
            ("realized_layer_count", self.realized_layer_count),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"mixed layer topology certificate {name} must be positive")
        if self.requested_layer_count != self.realized_layer_count:
            raise ValueError("strict mixed layer topology cannot change layer count")
        planes = tuple(float(value) for value in self.magnetic_plane_coordinates_m)
        if len(planes) != self.realized_layer_count + 1 or any(
            not math.isfinite(value) for value in planes
        ):
            raise ValueError("mixed layer topology certificate has invalid magnetic planes")
        if any(right <= left for left, right in zip(planes, planes[1:], strict=False)):
            raise ValueError("mixed layer topology certificate magnetic planes must increase")
        object.__setattr__(self, "magnetic_plane_coordinates_m", planes)
        if not math.isfinite(self.plane_tolerance_m) or self.plane_tolerance_m <= 0.0:
            raise ValueError("mixed layer topology certificate plane tolerance must be positive")
        if (
            not math.isfinite(self.transition_shell_thickness_m)
            or self.transition_shell_thickness_m <= 0.0
        ):
            raise ValueError(
                "mixed layer topology certificate transition shell thickness must be positive"
            )
        if self.transition_shell_interface_tri3_count < 1:
            raise ValueError(
                "mixed layer topology certificate transition shell interface must contain tri3"
            )
        for name in ("interface_marker", "outer_boundary_marker", "effective_gmsh_thread_count"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"mixed layer topology certificate {name} must be positive")
        if self.interface_marker == self.outer_boundary_marker:
            raise ValueError("mixed layer topology certificate markers must be distinct")
        for prefix in ("magnetic", "airbox"):
            minimum = _strict_bounds_vector(
                getattr(self, f"{prefix}_bounds_min_m"),
                f"{prefix}_bounds_min_m",
            )
            maximum = _strict_bounds_vector(
                getattr(self, f"{prefix}_bounds_max_m"),
                f"{prefix}_bounds_max_m",
            )
            if any(right <= left for left, right in zip(minimum, maximum, strict=True)):
                raise ValueError(
                    f"mixed layer topology certificate {prefix} authored bounds must increase"
                )
            object.__setattr__(self, f"{prefix}_bounds_min_m", minimum)
            object.__setattr__(self, f"{prefix}_bounds_max_m", maximum)
        for name in (
            "magnetic_volume_m3",
            "expected_magnetic_volume_m3",
            "air_volume_m3",
            "shared_domain_volume_m3",
            "expected_shared_domain_volume_m3",
        ):
            value = float(getattr(self, name))
            if not math.isfinite(value) or value <= 0.0:
                raise ValueError(f"mixed layer topology certificate {name} must be positive")
        for name in (
            "magnetic_relative_volume_error",
            "shared_domain_relative_volume_error",
            "magnetic_bounds_relative_error",
            "airbox_bounds_relative_error",
        ):
            value = float(getattr(self, name))
            if not math.isfinite(value) or value < 0.0 or value > 1.0e-8:
                raise ValueError(
                    f"mixed layer topology certificate {name} exceeds 1e-8"
                )
        if not self.marker_coverage_complete:
            raise ValueError("mixed layer topology certificate marker coverage is incomplete")
        for name in (
            "nonconforming_face_count",
            "orphan_face_count",
            "nonmanifold_face_count",
            "coincident_interface_face_count",
        ):
            if getattr(self, name) != 0:
                raise ValueError(f"mixed layer topology certificate {name} must be zero")
        if self.topology_fingerprint_version not in {"v2", "v3"}:
            raise ValueError(
                "mixed layer topology certificate requires topology fingerprint v2 or v3"
            )
        if (
            not self.topology_fingerprint.startswith("sha256:")
            or len(self.topology_fingerprint) != len("sha256:") + 64
        ):
            raise ValueError("mixed layer topology certificate has an invalid fingerprint")
        if self.gmsh_version != MIXED_SHARED_GMSH_VERSION:
            raise ValueError("mixed layer topology certificate has unqualified Gmsh version")
        if self.strategy != MIXED_SHARED_GEO_STRATEGY:
            raise ValueError("mixed layer topology certificate has unqualified strategy")
        if self.effective_gmsh_thread_count != 1:
            raise ValueError("mixed layer topology certificate requires one effective Gmsh thread")
        if not isinstance(self.deterministic_inputs, dict):
            raise TypeError("mixed layer topology certificate deterministic_inputs must be an object")
        expected_inputs = _mixed_deterministic_inputs()
        if self.deterministic_inputs != expected_inputs or any(
            key not in self.deterministic_inputs
            or type(self.deterministic_inputs[key]) is not type(value)
            for key, value in expected_inputs.items()
        ):
            raise ValueError("mixed layer topology certificate deterministic_inputs are stale")
        if self.fallbacks_triggered:
            raise ValueError("strict mixed layer topology certificate requires no fallbacks")
        for name, mapping in (
            ("cell_family_counts_by_marker", self.cell_family_counts_by_marker),
            ("cell_family_counts_by_part", self.cell_family_counts_by_part),
            ("facet_family_counts_by_role_marker", self.facet_family_counts_by_role_marker),
        ):
            normalized = _normalize_nested_counts(mapping, name)
            object.__setattr__(self, name, normalized)
        for name, mapping in (
            ("jacobian_minima_m3_by_family", self.jacobian_minima_m3_by_family),
            ("scaled_jacobian_minima_by_family", self.scaled_jacobian_minima_by_family),
            ("scaled_jacobian_p05_by_family", self.scaled_jacobian_p05_by_family),
        ):
            if not isinstance(mapping, dict) or any(
                not isinstance(key, str)
                or isinstance(value, bool)
                or not isinstance(value, float)
                for key, value in mapping.items()
            ):
                raise TypeError(
                    f"mixed layer topology certificate {name} must map strings to floats"
                )
            normalized = dict(mapping)
            if not normalized or any(
                not math.isfinite(value) or value <= 0.0
                for value in normalized.values()
            ):
                raise ValueError(f"mixed layer topology certificate {name} must be positive")
            object.__setattr__(self, name, normalized)
        if self.quality_metric != MIXED_QUALITY_METRIC:
            raise ValueError(
                "mixed layer topology certificate quality_metric must be "
                f"{MIXED_QUALITY_METRIC}"
            )
        if any(
            value < MIXED_SCALED_JACOBIAN_P05_MIN
            for value in self.scaled_jacobian_p05_by_family.values()
        ):
            raise ValueError(
                "mixed layer topology certificate scaled_jacobian_p05_by_family "
                f"must be >= {MIXED_SCALED_JACOBIAN_P05_MIN}"
            )

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "certificate_status": self.certificate_status,
            "requested_sweep_direction": self.requested_sweep_direction,
            "resolved_sweep_direction": self.resolved_sweep_direction,
            "requested_layer_count": self.requested_layer_count,
            "realized_layer_count": self.realized_layer_count,
            "magnetic_plane_coordinates_m": list(self.magnetic_plane_coordinates_m),
            "plane_tolerance_m": self.plane_tolerance_m,
            "transition_shell_thickness_m": self.transition_shell_thickness_m,
            "transition_shell_interface_tri3_count": (
                self.transition_shell_interface_tri3_count
            ),
            "interface_marker": self.interface_marker,
            "outer_boundary_marker": self.outer_boundary_marker,
            "magnetic_bounds_min_m": list(self.magnetic_bounds_min_m),
            "magnetic_bounds_max_m": list(self.magnetic_bounds_max_m),
            "airbox_bounds_min_m": list(self.airbox_bounds_min_m),
            "airbox_bounds_max_m": list(self.airbox_bounds_max_m),
            "magnetic_bounds_relative_error": self.magnetic_bounds_relative_error,
            "airbox_bounds_relative_error": self.airbox_bounds_relative_error,
            "cell_family_counts_by_marker": self.cell_family_counts_by_marker,
            "cell_family_counts_by_part": self.cell_family_counts_by_part,
            "facet_family_counts_by_role_marker": self.facet_family_counts_by_role_marker,
            "jacobian_minima_m3_by_family": self.jacobian_minima_m3_by_family,
            "quality_metric": self.quality_metric,
            "scaled_jacobian_minima_by_family": self.scaled_jacobian_minima_by_family,
            "scaled_jacobian_p05_by_family": self.scaled_jacobian_p05_by_family,
            "magnetic_volume_m3": self.magnetic_volume_m3,
            "expected_magnetic_volume_m3": self.expected_magnetic_volume_m3,
            "magnetic_relative_volume_error": self.magnetic_relative_volume_error,
            "air_volume_m3": self.air_volume_m3,
            "shared_domain_volume_m3": self.shared_domain_volume_m3,
            "expected_shared_domain_volume_m3": self.expected_shared_domain_volume_m3,
            "shared_domain_relative_volume_error": self.shared_domain_relative_volume_error,
            "marker_coverage_complete": self.marker_coverage_complete,
            "nonconforming_face_count": self.nonconforming_face_count,
            "orphan_face_count": self.orphan_face_count,
            "nonmanifold_face_count": self.nonmanifold_face_count,
            "coincident_interface_face_count": self.coincident_interface_face_count,
            "topology_fingerprint_version": self.topology_fingerprint_version,
            "topology_fingerprint": self.topology_fingerprint,
            "gmsh_version": self.gmsh_version,
            "strategy": self.strategy,
            "effective_gmsh_thread_count": self.effective_gmsh_thread_count,
            "deterministic_inputs": self.deterministic_inputs,
            "fallbacks_triggered": list(self.fallbacks_triggered),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> "MixedLayerTopologyCertificate":
        def require(name: str, kind: type) -> object:
            value = payload.get(name)
            if kind is int:
                if isinstance(value, bool) or not isinstance(value, int):
                    raise TypeError(f"mixed layer topology certificate {name} must be an integer")
            elif kind is float:
                if not isinstance(value, float):
                    raise TypeError(f"mixed layer topology certificate {name} must be a float")
            elif not isinstance(value, kind):
                raise TypeError(f"mixed layer topology certificate {name} must be a {kind.__name__}")
            return value

        raw_planes = require("magnetic_plane_coordinates_m", list)
        assert isinstance(raw_planes, list)
        if any(not isinstance(value, float) for value in raw_planes):
            raise TypeError(
                "mixed layer topology certificate magnetic_plane_coordinates_m must contain floats"
            )
        def require_bounds(name: str) -> tuple[float, float, float]:
            raw = require(name, list)
            assert isinstance(raw, list)
            if len(raw) != 3 or any(not isinstance(value, float) for value in raw):
                raise TypeError(
                    f"mixed layer topology certificate {name} must contain three floats"
                )
            return tuple(raw)  # type: ignore[return-value]

        def require_nested_counts(name: str) -> dict[str, dict[str, int]]:
            raw = require(name, dict)
            return _normalize_nested_counts(raw, name)

        return cls(
            schema_version=require("schema_version", str),  # type: ignore[arg-type]
            certificate_status=require("certificate_status", str),  # type: ignore[arg-type]
            requested_sweep_direction=require("requested_sweep_direction", str),  # type: ignore[arg-type]
            resolved_sweep_direction=require("resolved_sweep_direction", str),  # type: ignore[arg-type]
            requested_layer_count=require("requested_layer_count", int),  # type: ignore[arg-type]
            realized_layer_count=require("realized_layer_count", int),  # type: ignore[arg-type]
            magnetic_plane_coordinates_m=tuple(raw_planes),
            plane_tolerance_m=float(require("plane_tolerance_m", float)),
            transition_shell_thickness_m=float(require("transition_shell_thickness_m", float)),
            transition_shell_interface_tri3_count=require("transition_shell_interface_tri3_count", int),  # type: ignore[arg-type]
            interface_marker=require("interface_marker", int),  # type: ignore[arg-type]
            outer_boundary_marker=require("outer_boundary_marker", int),  # type: ignore[arg-type]
            magnetic_bounds_min_m=require_bounds("magnetic_bounds_min_m"),
            magnetic_bounds_max_m=require_bounds("magnetic_bounds_max_m"),
            airbox_bounds_min_m=require_bounds("airbox_bounds_min_m"),
            airbox_bounds_max_m=require_bounds("airbox_bounds_max_m"),
            magnetic_bounds_relative_error=float(require("magnetic_bounds_relative_error", float)),
            airbox_bounds_relative_error=float(require("airbox_bounds_relative_error", float)),
            cell_family_counts_by_marker=require_nested_counts("cell_family_counts_by_marker"),
            cell_family_counts_by_part=require_nested_counts("cell_family_counts_by_part"),
            facet_family_counts_by_role_marker=require_nested_counts("facet_family_counts_by_role_marker"),
            jacobian_minima_m3_by_family=dict(require("jacobian_minima_m3_by_family", dict)),
            quality_metric=require("quality_metric", str),  # type: ignore[arg-type]
            scaled_jacobian_minima_by_family=dict(require("scaled_jacobian_minima_by_family", dict)),
            scaled_jacobian_p05_by_family=dict(require("scaled_jacobian_p05_by_family", dict)),
            magnetic_volume_m3=float(require("magnetic_volume_m3", float)),
            expected_magnetic_volume_m3=float(require("expected_magnetic_volume_m3", float)),
            magnetic_relative_volume_error=float(require("magnetic_relative_volume_error", float)),
            air_volume_m3=float(require("air_volume_m3", float)),
            shared_domain_volume_m3=float(require("shared_domain_volume_m3", float)),
            expected_shared_domain_volume_m3=float(require("expected_shared_domain_volume_m3", float)),
            shared_domain_relative_volume_error=float(require("shared_domain_relative_volume_error", float)),
            marker_coverage_complete=require("marker_coverage_complete", bool),  # type: ignore[arg-type]
            nonconforming_face_count=require("nonconforming_face_count", int),  # type: ignore[arg-type]
            orphan_face_count=require("orphan_face_count", int),  # type: ignore[arg-type]
            nonmanifold_face_count=require("nonmanifold_face_count", int),  # type: ignore[arg-type]
            coincident_interface_face_count=require("coincident_interface_face_count", int),  # type: ignore[arg-type]
            topology_fingerprint_version=require("topology_fingerprint_version", str),  # type: ignore[arg-type]
            topology_fingerprint=require("topology_fingerprint", str),  # type: ignore[arg-type]
            gmsh_version=require("gmsh_version", str),  # type: ignore[arg-type]
            strategy=require("strategy", str),  # type: ignore[arg-type]
            effective_gmsh_thread_count=require("effective_gmsh_thread_count", int),  # type: ignore[arg-type]
            deterministic_inputs=dict(require("deterministic_inputs", dict)),
            fallbacks_triggered=tuple(require("fallbacks_triggered", list)),  # type: ignore[arg-type]
        )


@dataclass(frozen=True, slots=True)
class ExactSweepEvidenceV2:
    sweep_direction_requested: str
    sweep_direction_resolved: str
    requested_layer_count: int
    realized_layer_count: int
    magnetic_plane_coordinates_m: tuple[float, ...]
    plane_tolerance_m: float
    topology_fingerprint_version: str
    topology_fingerprint: str
    node_order_digest: str

    def __post_init__(self) -> None:
        if self.sweep_direction_requested not in {"auto", "x", "y", "z"}:
            raise ValueError("mixed v2 exact sweep requested direction must be auto, x, y, or z")
        if self.sweep_direction_resolved not in {"x", "y", "z"}:
            raise ValueError("mixed v2 exact sweep resolved direction must be x, y, or z")
        if (
            isinstance(self.requested_layer_count, bool)
            or not isinstance(self.requested_layer_count, int)
            or self.requested_layer_count not in {1, 2, 3}
            or self.realized_layer_count != self.requested_layer_count
            or len(self.magnetic_plane_coordinates_m) != self.realized_layer_count + 1
            or any(not isinstance(value, float) or not math.isfinite(value) for value in self.magnetic_plane_coordinates_m)
            or any(right <= left for left, right in zip(self.magnetic_plane_coordinates_m, self.magnetic_plane_coordinates_m[1:], strict=False))
            or not math.isfinite(self.plane_tolerance_m)
            or self.plane_tolerance_m <= 0.0
            or self.topology_fingerprint_version not in {"v2", "v3"}
            or not _is_sha256_digest(self.topology_fingerprint)
            or not _is_sha256_digest(self.node_order_digest)
        ):
            raise ValueError("mixed v2 exact sweep evidence is invalid")

    def to_dict(self) -> dict[str, object]:
        return {
            "sweep_direction_requested": self.sweep_direction_requested,
            "sweep_direction_resolved": self.sweep_direction_resolved,
            "requested_layer_count": self.requested_layer_count,
            "realized_layer_count": self.realized_layer_count,
            "magnetic_plane_coordinates_m": list(self.magnetic_plane_coordinates_m),
            "plane_tolerance_m": self.plane_tolerance_m,
            "topology_fingerprint_version": self.topology_fingerprint_version,
            "topology_fingerprint": self.topology_fingerprint,
            "node_order_digest": self.node_order_digest,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "ExactSweepEvidenceV2":
        required = (
            "sweep_direction_requested",
            "sweep_direction_resolved",
            "requested_layer_count",
            "realized_layer_count",
            "magnetic_plane_coordinates_m",
            "plane_tolerance_m",
            "topology_fingerprint_version",
            "topology_fingerprint",
            "node_order_digest",
        )
        if set(payload) != set(required):
            raise ValueError("mixed v2 exact sweep evidence has an unexpected field set")
        planes = payload["magnetic_plane_coordinates_m"]
        if not isinstance(planes, list) or any(type(value) is not float for value in planes):
            raise TypeError("mixed v2 exact sweep magnetic_plane_coordinates_m must contain floats")
        if (
            not isinstance(payload["sweep_direction_requested"], str)
            or not isinstance(payload["sweep_direction_resolved"], str)
            or type(payload["requested_layer_count"]) is not int
            or type(payload["realized_layer_count"]) is not int
            or type(payload["plane_tolerance_m"]) is not float
            or not isinstance(payload["topology_fingerprint_version"], str)
            or not isinstance(payload["topology_fingerprint"], str)
            or not isinstance(payload["node_order_digest"], str)
        ):
            raise TypeError("mixed v2 exact sweep evidence has invalid field types")
        return cls(
            sweep_direction_requested=payload["sweep_direction_requested"],
            sweep_direction_resolved=payload["sweep_direction_resolved"],
            requested_layer_count=payload["requested_layer_count"],
            realized_layer_count=payload["realized_layer_count"],
            magnetic_plane_coordinates_m=tuple(planes),
            plane_tolerance_m=payload["plane_tolerance_m"],
            topology_fingerprint_version=payload["topology_fingerprint_version"],
            topology_fingerprint=payload["topology_fingerprint"],
            node_order_digest=payload["node_order_digest"],
        )


@dataclass(frozen=True, slots=True)
class MagneticRegionV2:
    object_id: str
    body_marker: int
    material_marker: int
    cell_family_counts: dict[str, int]
    exact_sweep: ExactSweepEvidenceV2 | None = None

    def to_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "object_id": self.object_id,
            "body_marker": self.body_marker,
            "material_marker": self.material_marker,
            "cell_family_counts": dict(self.cell_family_counts),
        }
        # Match MagneticRegionV2IR's canonical omission of absent evidence.
        # The complete serialized payload is bound by the native certificate hash.
        if self.exact_sweep is not None:
            payload["exact_sweep"] = self.exact_sweep.to_dict()
        return payload

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "MagneticRegionV2":
        if set(payload) - {"exact_sweep"} != {"object_id", "body_marker", "material_marker", "cell_family_counts"}:
            raise ValueError("mixed v2 magnetic region has an unexpected field set")
        counts = payload["cell_family_counts"]
        if not isinstance(counts, dict) or any(type(key) is not str or type(value) is not int or value <= 0 for key, value in counts.items()):
            raise TypeError("mixed v2 magnetic region cell_family_counts is invalid")
        sweep = payload.get("exact_sweep")
        if sweep is not None and not isinstance(sweep, dict):
            raise TypeError("mixed v2 magnetic region exact_sweep must be an object or null")
        if not isinstance(payload["object_id"], str) or type(payload["body_marker"]) is not int or type(payload["material_marker"]) is not int:
            raise TypeError("mixed v2 magnetic region has invalid scalar fields")
        return cls(
            object_id=payload["object_id"],
            body_marker=payload["body_marker"],
            material_marker=payload["material_marker"],
            cell_family_counts=dict(counts),
            exact_sweep=ExactSweepEvidenceV2.from_dict(sweep) if sweep is not None else None,
        )


@dataclass(frozen=True, slots=True)
class BodySeparationPairV2:
    body_a: str
    body_b: str
    min_gap_m: float
    contact_state: str

    def to_dict(self) -> dict[str, object]:
        return {
            "body_a": self.body_a,
            "body_b": self.body_b,
            "min_gap_m": self.min_gap_m,
            "contact_state": self.contact_state,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "BodySeparationPairV2":
        if set(payload) != {"body_a", "body_b", "min_gap_m", "contact_state"}:
            raise ValueError("mixed v2 separation pair has an unexpected field set")
        if any(not isinstance(payload[name], str) for name in ("body_a", "body_b", "contact_state")) or type(payload["min_gap_m"]) is not float:
            raise TypeError("mixed v2 separation pair has invalid field types")
        return cls(
            body_a=payload["body_a"],
            body_b=payload["body_b"],
            min_gap_m=payload["min_gap_m"],
            contact_state=payload["contact_state"],
        )


@dataclass(frozen=True, slots=True)
class BodyMaterialFieldV2:
    object_id: str
    field_basis: str
    coefficient_domains: tuple[str, ...]
    air_interpolation_policy: str
    cross_body_interpolation_policy: str
    node_order_digest: str
    field_digest: str
    values: dict[str, object]

    def to_dict(self) -> dict[str, object]:
        return {
            "object_id": self.object_id,
            "field_basis": self.field_basis,
            "coefficient_domains": list(self.coefficient_domains),
            "air_interpolation_policy": self.air_interpolation_policy,
            "cross_body_interpolation_policy": self.cross_body_interpolation_policy,
            "node_order_digest": self.node_order_digest,
            "field_digest": self.field_digest,
            "values": dict(self.values),
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "BodyMaterialFieldV2":
        expected = {"object_id", "field_basis", "coefficient_domains", "air_interpolation_policy", "cross_body_interpolation_policy", "node_order_digest", "field_digest", "values"}
        if set(payload) != expected:
            raise ValueError("mixed v2 body material field has an unexpected field set")
        domains = payload["coefficient_domains"]
        values = payload["values"]
        if not isinstance(domains, list) or any(not isinstance(value, str) for value in domains) or not isinstance(values, dict):
            raise TypeError("mixed v2 body material field has invalid domains or values")
        if any(not isinstance(payload[name], str) for name in ("object_id", "field_basis", "air_interpolation_policy", "cross_body_interpolation_policy", "node_order_digest", "field_digest")):
            raise TypeError("mixed v2 body material field has invalid scalar fields")
        return cls(
            object_id=payload["object_id"],
            field_basis=payload["field_basis"],
            coefficient_domains=tuple(domains),
            air_interpolation_policy=payload["air_interpolation_policy"],
            cross_body_interpolation_policy=payload["cross_body_interpolation_policy"],
            node_order_digest=payload["node_order_digest"],
            field_digest=payload["field_digest"],
            values=dict(values),
        )


@dataclass(frozen=True, slots=True)
class MixedLayerTopologyCertificateV2:
    """Disconnected-body mixed-P1 evidence; v1 remains single-body/prism-only."""

    certificate_status: str
    magnetic_regions: tuple[MagneticRegionV2, ...]
    body_separation_pairs: tuple[BodySeparationPairV2, ...]
    body_material_fields: tuple[BodyMaterialFieldV2, ...]
    # A mixed shared-domain mesh may need two 3D algorithms: Gmsh HXT cannot
    # consume the quad faces required by the exact swept Box/transition stage,
    # while the annulus and far-air tetrahedral stage can retain the authored
    # HXT policy.  Keep all stages explicit in the certificate rather than
    # collapsing them to one misleading effective value.
    requested_algorithm_3d: int
    transition_algorithm_3d: int
    tetrahedral_algorithm_3d: int
    optimizer: str | None
    optimizer_iterations: int
    # The v2 extension is additive.  These fields deliberately retain the
    # complete v1 shared-domain proof at the top level so existing consumers
    # can read quality, volume, marker and deterministic-input evidence
    # without inventing a second interpretation for multi-body meshes.
    requested_sweep_direction: str
    resolved_sweep_direction: str
    requested_layer_count: int
    realized_layer_count: int
    magnetic_plane_coordinates_m: tuple[float, ...]
    plane_tolerance_m: float
    transition_shell_thickness_m: float
    transition_shell_interface_tri3_count: int
    interface_marker: int
    outer_boundary_marker: int
    magnetic_bounds_min_m: tuple[float, float, float]
    magnetic_bounds_max_m: tuple[float, float, float]
    airbox_bounds_min_m: tuple[float, float, float]
    airbox_bounds_max_m: tuple[float, float, float]
    magnetic_bounds_relative_error: float
    airbox_bounds_relative_error: float
    jacobian_minima_m3_by_family: dict[str, float]
    quality_metric: str
    scaled_jacobian_minima_by_family: dict[str, float]
    scaled_jacobian_p05_by_family: dict[str, float]
    magnetic_volume_m3: float
    expected_magnetic_volume_m3: float
    magnetic_relative_volume_error: float
    air_volume_m3: float
    shared_domain_volume_m3: float
    expected_shared_domain_volume_m3: float
    shared_domain_relative_volume_error: float
    marker_coverage_complete: bool
    nonconforming_face_count: int
    orphan_face_count: int
    nonmanifold_face_count: int
    coincident_interface_face_count: int
    deterministic_inputs: dict[str, object]
    topology_fingerprint_version: str
    topology_fingerprint: str
    gmsh_version: str
    strategy: str
    effective_gmsh_thread_count: int
    fallbacks_triggered: tuple[str, ...] = ()
    cell_family_counts_by_marker: dict[str, dict[str, int]] = field(default_factory=dict)
    cell_family_counts_by_part: dict[str, dict[str, int]] = field(default_factory=dict)
    facet_family_counts_by_role_marker: dict[str, dict[str, int]] = field(default_factory=dict)
    schema_version: str = "mixed_layer_topology_certificate.v2"

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        if self.schema_version != "mixed_layer_topology_certificate.v2":
            raise ValueError("mixed v2 certificate schema_version is invalid")
        if self.certificate_status != "accepted":
            raise ValueError("mixed v2 certificate must be accepted")
        if not self.magnetic_regions:
            raise ValueError("mixed v2 certificate requires magnetic_regions")
        object_ids = [region.object_id for region in self.magnetic_regions]
        if any(not object_id.strip() for object_id in object_ids) or len(set(object_ids)) != len(object_ids):
            raise ValueError("mixed v2 certificate magnetic region object IDs are invalid")
        if len({region.body_marker for region in self.magnetic_regions}) != len(self.magnetic_regions) or any(region.body_marker <= 0 for region in self.magnetic_regions):
            raise ValueError("mixed v2 certificate body markers are invalid")
        if len({region.material_marker for region in self.magnetic_regions}) != len(self.magnetic_regions) or any(region.material_marker <= 0 for region in self.magnetic_regions):
            raise ValueError("mixed v2 certificate material markers are invalid")
        for region in self.magnetic_regions:
            if not region.cell_family_counts or any(family not in {"prism6", "tet4"} or count <= 0 for family, count in region.cell_family_counts.items()):
                raise ValueError(f"mixed v2 certificate region {region.object_id!r} has invalid cell families")
        expected_pairs = len(object_ids) * (len(object_ids) - 1) // 2
        if len(self.body_separation_pairs) != expected_pairs:
            raise ValueError("mixed v2 certificate separation pair coverage is incomplete")
        pairs: set[tuple[str, str]] = set()
        for pair in self.body_separation_pairs:
            if pair.body_a >= pair.body_b or (pair.body_a, pair.body_b) in pairs or pair.body_a not in object_ids or pair.body_b not in object_ids or pair.contact_state != "separated" or not math.isfinite(pair.min_gap_m) or pair.min_gap_m <= 0.0:
                raise ValueError("mixed v2 certificate separation pair is invalid")
            pairs.add((pair.body_a, pair.body_b))
        required_domains = ("Ms", "Aex", "alpha", "Ku1", "anisotropy_axis")
        required_domain_set = set(required_domains)
        material_objects: set[str] = set()
        for material in self.body_material_fields:
            if (
                material.object_id not in object_ids
                or material.object_id in material_objects
                or material.field_basis != "body_owned_p1"
                or material.coefficient_domains != required_domains
                or set(material.values) != required_domain_set
                or material.air_interpolation_policy != "forbidden"
                or material.cross_body_interpolation_policy != "forbidden"
                or not _is_sha256_digest(material.node_order_digest)
                or not _is_sha256_digest(material.field_digest)
            ):
                raise ValueError(f"mixed v2 certificate material fields for {material.object_id!r} are invalid")
            material_objects.add(material.object_id)
        if material_objects != set(object_ids):
            raise ValueError("mixed v2 certificate material field coverage is incomplete")
        if self.fallbacks_triggered:
            raise ValueError("mixed v2 certificate must not contain fallbacks")
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value not in {1, 10}
            for value in (
                self.requested_algorithm_3d,
                self.transition_algorithm_3d,
                self.tetrahedral_algorithm_3d,
            )
        ):
            raise ValueError("mixed v2 certificate has invalid 3D meshing algorithms")
        if self.requested_algorithm_3d == 10:
            if self.transition_algorithm_3d != 1 or self.tetrahedral_algorithm_3d != 10:
                raise ValueError(
                    "mixed v2 HXT realization must use algorithm 1 for the "
                    "structured transition stage and algorithm 10 for tetrahedra"
                )
        elif (
            self.transition_algorithm_3d != 1
            or self.tetrahedral_algorithm_3d != 1
        ):
            raise ValueError(
                "mixed v2 Delaunay realization must use algorithm 1 for all stages"
            )
        if self.optimizer is not None and (
            not isinstance(self.optimizer, str) or self.optimizer != "Gmsh"
        ):
            raise ValueError("mixed v2 certificate optimizer must be None or 'Gmsh'")
        if (
            isinstance(self.optimizer_iterations, bool)
            or not isinstance(self.optimizer_iterations, int)
            or self.optimizer_iterations < 0
            or (self.optimizer is None and self.optimizer_iterations != 0)
            or (self.optimizer == "Gmsh" and self.optimizer_iterations < 1)
        ):
            raise ValueError("mixed v2 certificate optimizer iteration policy is invalid")
        if self.requested_sweep_direction not in {"auto", "x", "y", "z"} or self.resolved_sweep_direction not in {"x", "y", "z"}:
            raise ValueError("mixed v2 certificate has invalid shared sweep direction")
        if self.requested_sweep_direction != "auto" and self.requested_sweep_direction != self.resolved_sweep_direction:
            raise ValueError("mixed v2 certificate cannot change requested sweep direction")
        if (
            isinstance(self.requested_layer_count, bool)
            or not isinstance(self.requested_layer_count, int)
            or self.requested_layer_count not in {1, 2, 3}
            or self.realized_layer_count != self.requested_layer_count
            or len(self.magnetic_plane_coordinates_m) != self.realized_layer_count + 1
            or any(not isinstance(value, float) or not math.isfinite(value) for value in self.magnetic_plane_coordinates_m)
            or any(right <= left for left, right in zip(self.magnetic_plane_coordinates_m, self.magnetic_plane_coordinates_m[1:], strict=False))
            or not math.isfinite(self.plane_tolerance_m)
            or self.plane_tolerance_m <= 0.0
        ):
            raise ValueError("mixed v2 certificate has invalid shared exact-layer evidence")
        if not math.isfinite(self.transition_shell_thickness_m) or self.transition_shell_thickness_m <= 0.0:
            raise ValueError("mixed v2 certificate transition shell thickness must be positive")
        if self.transition_shell_interface_tri3_count < 1:
            raise ValueError("mixed v2 certificate transition shell must contain tri3 facets")
        for name in ("interface_marker", "outer_boundary_marker"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"mixed v2 certificate {name} must be positive")
        if self.interface_marker == self.outer_boundary_marker:
            raise ValueError("mixed v2 certificate interface and boundary markers must differ")
        for prefix in ("magnetic", "airbox"):
            minimum = _strict_bounds_vector(getattr(self, f"{prefix}_bounds_min_m"), f"{prefix}_bounds_min_m")
            maximum = _strict_bounds_vector(getattr(self, f"{prefix}_bounds_max_m"), f"{prefix}_bounds_max_m")
            if any(right <= left for left, right in zip(minimum, maximum, strict=True)):
                raise ValueError(f"mixed v2 certificate {prefix} bounds must increase")
            object.__setattr__(self, f"{prefix}_bounds_min_m", minimum)
            object.__setattr__(self, f"{prefix}_bounds_max_m", maximum)
        for name in ("magnetic_volume_m3", "expected_magnetic_volume_m3", "air_volume_m3", "shared_domain_volume_m3", "expected_shared_domain_volume_m3"):
            value = float(getattr(self, name))
            if not math.isfinite(value) or value <= 0.0:
                raise ValueError(f"mixed v2 certificate {name} must be positive")
        for name in ("magnetic_relative_volume_error", "shared_domain_relative_volume_error", "magnetic_bounds_relative_error", "airbox_bounds_relative_error"):
            value = float(getattr(self, name))
            if not math.isfinite(value) or value < 0.0 or value > 1.0e-8:
                raise ValueError(f"mixed v2 certificate {name} exceeds 1e-8")
        if not self.marker_coverage_complete:
            raise ValueError("mixed v2 certificate marker coverage is incomplete")
        if any(getattr(self, name) != 0 for name in ("nonconforming_face_count", "orphan_face_count", "nonmanifold_face_count", "coincident_interface_face_count")):
            raise ValueError("mixed v2 certificate interface proof contains invalid faces")
        for name, mapping in (("jacobian_minima_m3_by_family", self.jacobian_minima_m3_by_family), ("scaled_jacobian_minima_by_family", self.scaled_jacobian_minima_by_family), ("scaled_jacobian_p05_by_family", self.scaled_jacobian_p05_by_family)):
            if not isinstance(mapping, dict) or not mapping or any(not isinstance(key, str) or type(value) is not float or not math.isfinite(value) or value <= 0.0 for key, value in mapping.items()):
                raise ValueError(f"mixed v2 certificate {name} must map families to positive floats")
        if self.quality_metric != MIXED_QUALITY_METRIC:
            raise ValueError(f"mixed v2 certificate quality_metric must be {MIXED_QUALITY_METRIC}")
        if any(value < MIXED_SCALED_JACOBIAN_P05_MIN for value in self.scaled_jacobian_p05_by_family.values()):
            raise ValueError("mixed v2 certificate scaled Jacobian p05 is below the qualified minimum")
        if not isinstance(self.deterministic_inputs, dict) or self.deterministic_inputs != _mixed_v2_deterministic_inputs(
            requested_algorithm_3d=self.requested_algorithm_3d,
            transition_algorithm_3d=self.transition_algorithm_3d,
            tetrahedral_algorithm_3d=self.tetrahedral_algorithm_3d,
            optimizer=self.optimizer,
            optimizer_iterations=self.optimizer_iterations,
        ):
            raise ValueError("mixed v2 certificate deterministic_inputs are stale")
        if self.topology_fingerprint_version not in {"v2", "v3"}:
            raise ValueError("mixed v2 certificate topology fingerprint version is invalid")
        if not _is_sha256_digest(self.topology_fingerprint):
            raise ValueError("mixed v2 certificate topology fingerprint is invalid")
        if self.gmsh_version != MIXED_SHARED_GMSH_VERSION or self.strategy != MIXED_SHARED_GEO_STRATEGY or self.effective_gmsh_thread_count != 1:
            raise ValueError("mixed v2 certificate has unqualified Gmsh realization")

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "certificate_status": self.certificate_status,
            "magnetic_regions": [region.to_dict() for region in self.magnetic_regions],
            "body_separation_pairs": [pair.to_dict() for pair in self.body_separation_pairs],
            "body_material_fields": [field.to_dict() for field in self.body_material_fields],
            "requested_algorithm_3d": self.requested_algorithm_3d,
            "transition_algorithm_3d": self.transition_algorithm_3d,
            "tetrahedral_algorithm_3d": self.tetrahedral_algorithm_3d,
            "optimizer": self.optimizer,
            "optimizer_iterations": self.optimizer_iterations,
            "requested_sweep_direction": self.requested_sweep_direction,
            "resolved_sweep_direction": self.resolved_sweep_direction,
            "requested_layer_count": self.requested_layer_count,
            "realized_layer_count": self.realized_layer_count,
            "magnetic_plane_coordinates_m": list(self.magnetic_plane_coordinates_m),
            "plane_tolerance_m": self.plane_tolerance_m,
            "transition_shell_thickness_m": self.transition_shell_thickness_m,
            "transition_shell_interface_tri3_count": self.transition_shell_interface_tri3_count,
            "interface_marker": self.interface_marker,
            "outer_boundary_marker": self.outer_boundary_marker,
            "magnetic_bounds_min_m": list(self.magnetic_bounds_min_m),
            "magnetic_bounds_max_m": list(self.magnetic_bounds_max_m),
            "airbox_bounds_min_m": list(self.airbox_bounds_min_m),
            "airbox_bounds_max_m": list(self.airbox_bounds_max_m),
            "magnetic_bounds_relative_error": self.magnetic_bounds_relative_error,
            "airbox_bounds_relative_error": self.airbox_bounds_relative_error,
            "jacobian_minima_m3_by_family": self.jacobian_minima_m3_by_family,
            "quality_metric": self.quality_metric,
            "scaled_jacobian_minima_by_family": self.scaled_jacobian_minima_by_family,
            "scaled_jacobian_p05_by_family": self.scaled_jacobian_p05_by_family,
            "magnetic_volume_m3": self.magnetic_volume_m3,
            "expected_magnetic_volume_m3": self.expected_magnetic_volume_m3,
            "magnetic_relative_volume_error": self.magnetic_relative_volume_error,
            "air_volume_m3": self.air_volume_m3,
            "shared_domain_volume_m3": self.shared_domain_volume_m3,
            "expected_shared_domain_volume_m3": self.expected_shared_domain_volume_m3,
            "shared_domain_relative_volume_error": self.shared_domain_relative_volume_error,
            "marker_coverage_complete": self.marker_coverage_complete,
            "nonconforming_face_count": self.nonconforming_face_count,
            "orphan_face_count": self.orphan_face_count,
            "nonmanifold_face_count": self.nonmanifold_face_count,
            "coincident_interface_face_count": self.coincident_interface_face_count,
            "deterministic_inputs": self.deterministic_inputs,
            "fallbacks_triggered": list(self.fallbacks_triggered),
            "topology_fingerprint_version": self.topology_fingerprint_version,
            "topology_fingerprint": self.topology_fingerprint,
            "gmsh_version": self.gmsh_version,
            "strategy": self.strategy,
            "effective_gmsh_thread_count": self.effective_gmsh_thread_count,
            "cell_family_counts_by_marker": self.cell_family_counts_by_marker,
            "cell_family_counts_by_part": self.cell_family_counts_by_part,
            "facet_family_counts_by_role_marker": self.facet_family_counts_by_role_marker,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> "MixedLayerTopologyCertificateV2":
        policy_fields = {
            "requested_algorithm_3d",
            "transition_algorithm_3d",
            "tetrahedral_algorithm_3d",
            "optimizer",
            "optimizer_iterations",
        }
        expected = {"schema_version", "certificate_status", "magnetic_regions", "body_separation_pairs", "body_material_fields", *policy_fields, "requested_sweep_direction", "resolved_sweep_direction", "requested_layer_count", "realized_layer_count", "magnetic_plane_coordinates_m", "plane_tolerance_m", "transition_shell_thickness_m", "transition_shell_interface_tri3_count", "interface_marker", "outer_boundary_marker", "magnetic_bounds_min_m", "magnetic_bounds_max_m", "airbox_bounds_min_m", "airbox_bounds_max_m", "magnetic_bounds_relative_error", "airbox_bounds_relative_error", "jacobian_minima_m3_by_family", "quality_metric", "scaled_jacobian_minima_by_family", "scaled_jacobian_p05_by_family", "magnetic_volume_m3", "expected_magnetic_volume_m3", "magnetic_relative_volume_error", "air_volume_m3", "shared_domain_volume_m3", "expected_shared_domain_volume_m3", "shared_domain_relative_volume_error", "marker_coverage_complete", "nonconforming_face_count", "orphan_face_count", "nonmanifold_face_count", "coincident_interface_face_count", "topology_fingerprint_version", "topology_fingerprint", "gmsh_version", "strategy", "effective_gmsh_thread_count", "deterministic_inputs", "fallbacks_triggered", "cell_family_counts_by_marker", "cell_family_counts_by_part", "facet_family_counts_by_role_marker"}
        required = expected - policy_fields
        if not required.issubset(payload) or set(payload) - expected:
            raise ValueError("mixed v2 certificate has an unexpected field set")
        legacy_policy = not policy_fields.intersection(payload)
        requested_algorithm_3d = int(payload.get("requested_algorithm_3d", 1))
        transition_algorithm_3d = int(payload.get("transition_algorithm_3d", 1))
        tetrahedral_algorithm_3d = int(payload.get("tetrahedral_algorithm_3d", 1))
        optimizer = payload.get("optimizer")
        optimizer_iterations = int(payload.get("optimizer_iterations", 0))
        deterministic_inputs = dict(payload["deterministic_inputs"])
        if legacy_policy and deterministic_inputs == _mixed_deterministic_inputs():
            # Rust's V2 wire type keeps defaults for readers of pre-hybrid V2
            # artifacts.  Normalize that old all-Delaunay evidence to the
            # explicit policy before constructing the strict Python object.
            deterministic_inputs = _mixed_v2_deterministic_inputs(
                requested_algorithm_3d=1,
                transition_algorithm_3d=1,
                tetrahedral_algorithm_3d=1,
                optimizer=None,
                optimizer_iterations=0,
            )
        regions = payload["magnetic_regions"]
        pairs = payload["body_separation_pairs"]
        materials = payload["body_material_fields"]
        if not isinstance(regions, list) or not isinstance(pairs, list) or not isinstance(materials, list) or not isinstance(payload["fallbacks_triggered"], list):
            raise TypeError("mixed v2 certificate array fields are invalid")
        mappings = ("cell_family_counts_by_marker", "cell_family_counts_by_part", "facet_family_counts_by_role_marker")
        if any(not isinstance(payload[name], dict) for name in mappings):
            raise TypeError("mixed v2 certificate count fields are invalid")
        def counts(value: object) -> dict[str, dict[str, int]]:
            assert isinstance(value, dict)
            result: dict[str, dict[str, int]] = {}
            for outer, inner in value.items():
                if not isinstance(outer, str) or not isinstance(inner, dict) or any(not isinstance(key, str) or type(count) is not int or count < 0 for key, count in inner.items()):
                    raise TypeError("mixed v2 certificate nested counts are invalid")
                result[outer] = dict(inner)
            return result
        scalar_required = ("topology_fingerprint_version", "topology_fingerprint", "gmsh_version", "strategy")
        if any(not isinstance(payload[name], str) for name in scalar_required) or type(payload["effective_gmsh_thread_count"]) is not int:
            raise TypeError("mixed v2 certificate realization fields are invalid")
        if any(
            type(payload[name]) is not int
            for name in (
                "requested_algorithm_3d",
                "transition_algorithm_3d",
                "tetrahedral_algorithm_3d",
                "optimizer_iterations",
            )
            if name in payload
        ) or (
            optimizer is not None
            and (not isinstance(optimizer, str) or optimizer != "Gmsh")
        ):
            raise TypeError("mixed v2 certificate algorithm/optimizer fields are invalid")
        def vector(name: str) -> tuple[float, float, float]:
            value = payload[name]
            if not isinstance(value, list) or len(value) != 3 or any(type(item) is not float for item in value):
                raise TypeError(f"mixed v2 certificate {name} must contain three floats")
            return tuple(value)  # type: ignore[return-value]
        planes = payload["magnetic_plane_coordinates_m"]
        if not isinstance(planes, list) or any(type(item) is not float for item in planes):
            raise TypeError("mixed v2 certificate magnetic planes must contain floats")
        if any(not isinstance(value, dict) for value in (*regions, *pairs, *materials)):
            raise TypeError("mixed v2 certificate nested records must be objects")
        if any(type(value) is not str for value in payload["fallbacks_triggered"]):
            raise TypeError("mixed v2 certificate fallbacks_triggered must contain strings")
        return cls(
            schema_version=payload["schema_version"],
            certificate_status=payload["certificate_status"],
            magnetic_regions=tuple(MagneticRegionV2.from_dict(value) for value in regions),  # type: ignore[arg-type]
            body_separation_pairs=tuple(BodySeparationPairV2.from_dict(value) for value in pairs),  # type: ignore[arg-type]
            body_material_fields=tuple(BodyMaterialFieldV2.from_dict(value) for value in materials),  # type: ignore[arg-type]
            requested_algorithm_3d=requested_algorithm_3d,
            transition_algorithm_3d=transition_algorithm_3d,
            tetrahedral_algorithm_3d=tetrahedral_algorithm_3d,
            optimizer=optimizer,
            optimizer_iterations=optimizer_iterations,
            requested_sweep_direction=payload["requested_sweep_direction"],
            resolved_sweep_direction=payload["resolved_sweep_direction"],
            requested_layer_count=payload["requested_layer_count"],
            realized_layer_count=payload["realized_layer_count"],
            magnetic_plane_coordinates_m=tuple(planes),  # type: ignore[arg-type]
            plane_tolerance_m=payload["plane_tolerance_m"],
            transition_shell_thickness_m=payload["transition_shell_thickness_m"],
            transition_shell_interface_tri3_count=payload["transition_shell_interface_tri3_count"],
            interface_marker=payload["interface_marker"],
            outer_boundary_marker=payload["outer_boundary_marker"],
            magnetic_bounds_min_m=vector("magnetic_bounds_min_m"),
            magnetic_bounds_max_m=vector("magnetic_bounds_max_m"),
            airbox_bounds_min_m=vector("airbox_bounds_min_m"),
            airbox_bounds_max_m=vector("airbox_bounds_max_m"),
            magnetic_bounds_relative_error=payload["magnetic_bounds_relative_error"],
            airbox_bounds_relative_error=payload["airbox_bounds_relative_error"],
            jacobian_minima_m3_by_family=dict(payload["jacobian_minima_m3_by_family"]),  # type: ignore[arg-type]
            quality_metric=payload["quality_metric"],
            scaled_jacobian_minima_by_family=dict(payload["scaled_jacobian_minima_by_family"]),  # type: ignore[arg-type]
            scaled_jacobian_p05_by_family=dict(payload["scaled_jacobian_p05_by_family"]),  # type: ignore[arg-type]
            magnetic_volume_m3=payload["magnetic_volume_m3"],
            expected_magnetic_volume_m3=payload["expected_magnetic_volume_m3"],
            magnetic_relative_volume_error=payload["magnetic_relative_volume_error"],
            air_volume_m3=payload["air_volume_m3"],
            shared_domain_volume_m3=payload["shared_domain_volume_m3"],
            expected_shared_domain_volume_m3=payload["expected_shared_domain_volume_m3"],
            shared_domain_relative_volume_error=payload["shared_domain_relative_volume_error"],
            marker_coverage_complete=payload["marker_coverage_complete"],
            nonconforming_face_count=payload["nonconforming_face_count"],
            orphan_face_count=payload["orphan_face_count"],
            nonmanifold_face_count=payload["nonmanifold_face_count"],
            coincident_interface_face_count=payload["coincident_interface_face_count"],
            deterministic_inputs=deterministic_inputs,  # type: ignore[arg-type]
            fallbacks_triggered=tuple(payload["fallbacks_triggered"]),  # type: ignore[arg-type]
            topology_fingerprint_version=payload["topology_fingerprint_version"],
            topology_fingerprint=payload["topology_fingerprint"],
            gmsh_version=payload["gmsh_version"],
            strategy=payload["strategy"],
            effective_gmsh_thread_count=payload["effective_gmsh_thread_count"],
            cell_family_counts_by_marker=counts(payload["cell_family_counts_by_marker"]),
            cell_family_counts_by_part=counts(payload["cell_family_counts_by_part"]),
            facet_family_counts_by_role_marker=counts(payload["facet_family_counts_by_role_marker"]),
        )


MixedLayerTopologyCertificateLike = MixedLayerTopologyCertificate | MixedLayerTopologyCertificateV2


def _is_sha256_digest(value: object) -> bool:
    return isinstance(value, str) and value.startswith("sha256:") and len(value) == len("sha256:") + 64 and all(
        character in "0123456789abcdef" for character in value[len("sha256:") :]
    )


def _mixed_v2_node_order_digest(node_ids: object) -> str:
    """Hash the sorted local node ownership using the native v2 encoding."""
    ordered = np.asarray(node_ids, dtype=np.int64).reshape(-1)
    if ordered.size and np.any(ordered[1:] < ordered[:-1]):
        ordered = np.sort(ordered)
    payload = b"fullmag:fem-body-node-order:v1" + struct.pack(
        "<I", int(ordered.size)
    )
    payload += b"".join(struct.pack("<Q", int(node)) for node in ordered.tolist())
    return f"sha256:{hashlib.sha256(payload).hexdigest()}"


def _mixed_v2_material_values_are_valid(values: Mapping[str, object]) -> bool:
    def finite_scalar(value: object) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))

    axis = values.get("anisotropy_axis")
    return all(finite_scalar(values.get(name)) for name in ("Ms", "Aex", "alpha", "Ku1")) and (
        isinstance(axis, (list, tuple))
        and len(axis) == 3
        and all(finite_scalar(value) for value in axis)
    )


def _body_material_field_digest(
    field_value: BodyMaterialFieldV2,
    *,
    topology_fingerprint_version: str,
    topology_fingerprint: str,
    body_marker: int,
    material_marker: int,
    component_units: Mapping[str, str] | None = None,
) -> str:
    # The native v2 contract deliberately does not hash JSON serialization.
    # Keep a deterministic, typed length-delimited representation here until
    # the Rust bridge supplies the same preimage for non-constant nodal arrays.
    # Values are still canonicalized by key and type, so a language serializer
    # cannot alter the digest accidentally.
    def encode(value: object) -> bytes:
        if value is None:
            return b"n"
        if isinstance(value, bool):
            return b"b1" if value else b"b0"
        if isinstance(value, int) and not isinstance(value, bool):
            return b"i" + struct.pack("<q", value)
        if isinstance(value, float):
            if not math.isfinite(value):
                raise ValueError("mixed v2 material field values must be finite")
            return b"f" + struct.pack("<d", value)
        if isinstance(value, str):
            encoded_value = value.encode("utf-8")
            return b"s" + struct.pack("<I", len(encoded_value)) + encoded_value
        if isinstance(value, (list, tuple)):
            return b"a" + struct.pack("<I", len(value)) + b"".join(encode(item) for item in value)
        if isinstance(value, Mapping):
            items = sorted((str(key), item) for key, item in value.items())
            encoded_items = []
            for key, item in items:
                encoded_key = key.encode("utf-8")
                encoded_items.append(struct.pack("<I", len(encoded_key)) + encoded_key + encode(item))
            return b"m" + struct.pack("<I", len(encoded_items)) + b"".join(encoded_items)
        raise TypeError(f"unsupported mixed v2 material field value {type(value).__name__}")

    fields = {
        "object_id": field_value.object_id,
        "field_basis": field_value.field_basis,
        "coefficient_domains": list(field_value.coefficient_domains),
        "air_interpolation_policy": field_value.air_interpolation_policy,
        "cross_body_interpolation_policy": field_value.cross_body_interpolation_policy,
        "node_order_digest": field_value.node_order_digest,
        "topology_fingerprint_version": topology_fingerprint_version,
        "topology_fingerprint": topology_fingerprint,
        "body_marker": body_marker,
        "material_marker": material_marker,
        "component_units": dict(component_units or {}),
        "values": field_value.values,
    }
    encoded = b"fullmag:fem-body-material-field:v1"
    for key in sorted(fields):
        key_bytes = key.encode("utf-8")
        encoded += struct.pack("<I", len(key_bytes)) + key_bytes + encode(fields[key])
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _certificate_payload_sha256(
    certificate: MixedLayerTopologyCertificateLike,
) -> str:
    encoded = json.dumps(
        certificate.to_dict(),
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


@dataclass(frozen=True)
class _PrevalidatedMixedCertificate:
    certificate: MixedLayerTopologyCertificate
    topology_fingerprint_v3: str
    certificate_payload_sha256: str
    canonical_evidence: "_CanonicalMixedCertificateEvidence"
    _validation_token: object = field(repr=False, compare=False)


_PREVALIDATED_MIXED_CERTIFICATE_TOKEN = object()


@dataclass(frozen=True, eq=False)
class _TrustedTopologyFingerprintV3Context:
    mesh_without_certificate: "MeshData" = field(repr=False, compare=False)
    topology_fingerprint_v3: str
    _capability: object = field(repr=False, compare=False)
    # The ordinary test/public private path binds this to ``None`` and keeps
    # its historical Python fingerprint re-check.  The native fast path
    # stores a compact content guard so the constructor can detect mutation
    # without hashing the full canonical topology byte stream twice.
    mesh_mutation_guard_sha256: str | None = None


@dataclass(frozen=True, eq=False)
class _TrustedNativePreflightReceiptProof:
    mesh_without_certificate: "MeshData" = field(repr=False, compare=False)
    certificate: MixedLayerTopologyCertificate
    topology_context: _TrustedTopologyFingerprintV3Context
    certificate_payload_sha256: str
    counts: Mapping[str, int]
    _capability: object = field(repr=False, compare=False)


_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY = object()
_MINTED_TRUSTED_TOPOLOGY_FINGERPRINT_CONTEXTS: WeakSet[
    _TrustedTopologyFingerprintV3Context
] = WeakSet()
_MINTED_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_PROOFS: WeakSet[
    _TrustedNativePreflightReceiptProof
] = WeakSet()


def _trusted_mesh_mutation_guard_sha256(mesh: "MeshData") -> str:
    """Hash the exact native-wire arrays for a cheap post-preflight guard.

    This is not the semantic topology fingerprint.  It only closes the small
    in-process window between native preflight and trusted construction.  The
    native preflight remains authoritative for structural validation and the
    canonical v3 fingerprint; this guard avoids repeating the much slower
    Python field-by-field v3 encoder on the same arrays.
    """
    digest = hashlib.sha256(b"fullmag:trusted-mesh-mutation-guard:v1")
    fields_to_guard = (
        ("nodes", mesh.nodes),
        ("cell_types", mesh.cell_types),
        ("cell_offsets", mesh.cell_offsets),
        ("cell_nodes", mesh.cell_nodes),
        ("element_markers", mesh.element_markers),
        ("facet_types", mesh.facet_types),
        ("facet_roles", mesh.facet_roles),
        ("facet_offsets", mesh.facet_offsets),
        ("facet_nodes", mesh.facet_nodes),
        ("boundary_markers", mesh.boundary_markers),
        ("cell_global_ordinals", mesh.cell_global_ordinals),
        ("facet_global_ordinals", mesh.facet_global_ordinals),
        ("cell_mesh_parts", mesh.cell_mesh_parts),
    )
    for name, value in fields_to_guard:
        array = np.ascontiguousarray(np.asarray(value))
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(array.dtype.str.encode("ascii"))
        digest.update(b"\0")
        digest.update(
            np.asarray(array.shape, dtype="<u8").tobytes(order="C")
        )
        digest.update(memoryview(array).cast("B"))
    metadata = {
        "periodic_boundary_pairs": list(mesh.periodic_boundary_pairs),
        "periodic_node_pairs": list(mesh.periodic_node_pairs),
        "periodic_mesh_certificate": mesh.periodic_mesh_certificate,
        "realization_report": (
            mesh.realization_report.to_dict()
            if mesh.realization_report is not None
            else None
        ),
    }
    digest.update(
        json.dumps(
            metadata,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    )
    return digest.hexdigest()


def _owned_vertex_identity(value: object, node_count: int) -> Mapping[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping) or set(value) != {"schema_version", "issuer", "vertex_ids"}:
        raise ValueError("vertex_identity requires exactly schema_version, issuer and vertex_ids")
    if value["schema_version"] != "mesh_vertex_identity.v1" or value["issuer"] != "gmsh_node_tags.v1":
        raise ValueError("unsupported mesh vertex identity schema or issuer")
    raw = value["vertex_ids"]
    if not isinstance(raw, (tuple, list, np.ndarray)) or (isinstance(raw, np.ndarray) and raw.ndim != 1):
        raise ValueError("vertex_identity.vertex_ids must be an ordered integer sequence")
    if len(raw) != node_count:
        raise ValueError("vertex_identity vertex count must match mesh nodes")
    ids: list[int] = []
    for item in raw:
        if isinstance(item, (bool, np.bool_)) or not isinstance(item, (int, np.integer)):
            raise ValueError("vertex_identity IDs must be exact integers, not bool or coerced values")
        identity = operator.index(item)
        if not 0 < identity <= (1 << 64) - 1:
            raise ValueError("vertex_identity IDs must be positive u64 integers")
        ids.append(identity)
    if len(set(ids)) != len(ids):
        raise ValueError("vertex_identity IDs must be unique")
    return MappingProxyType({
        "schema_version": "mesh_vertex_identity.v1",
        "issuer": "gmsh_node_tags.v1",
        "vertex_ids": tuple(ids),
    })


def _vertex_identity_to_dict(value: Mapping[str, object] | None) -> dict[str, object] | None:
    if value is None:
        return None
    return {
        "schema_version": value["schema_version"],
        "issuer": value["issuer"],
        "vertex_ids": list(value["vertex_ids"]),
    }


@dataclass(frozen=True, slots=True)
class MeshData:
    """Canonical typed variable-arity FEM topology in CSR layout."""

    nodes: NDArray[np.float64]
    cell_types: NDArray[np.str_]
    cell_offsets: NDArray[np.int64]
    cell_nodes: NDArray[np.int32]
    element_markers: NDArray[np.int32]
    facet_types: NDArray[np.str_]
    facet_roles: NDArray[np.str_]
    facet_offsets: NDArray[np.int64]
    facet_nodes: NDArray[np.int32]
    boundary_markers: NDArray[np.int32]
    cell_global_ordinals: NDArray[np.int64]
    facet_global_ordinals: NDArray[np.int64]
    cell_mesh_parts: NDArray[np.str_] = field(
        default_factory=lambda: np.asarray([], dtype=np.str_)
    )
    periodic_boundary_pairs: list[dict[str, object]] = field(default_factory=list)
    periodic_node_pairs: list[dict[str, object]] = field(default_factory=list)
    periodic_mesh_certificate: dict[str, object] | None = None
    quality: MeshQualityReport | None = None
    per_domain_quality: dict[int, MeshQualityReport] | None = None
    realization_report: MeshRealizationReport | None = None
    mixed_layer_topology_certificate: MixedLayerTopologyCertificateLike | None = None
    # Retained mesh-owner labels, not authentication or a solved-field certificate.
    vertex_identity: Mapping[str, object] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "nodes", np.asarray(self.nodes, dtype=np.float64))
        object.__setattr__(
            self, "vertex_identity", _owned_vertex_identity(self.vertex_identity, len(self.nodes))
        )
        object.__setattr__(self, "cell_types", np.asarray(self.cell_types, dtype=np.str_))
        object.__setattr__(self, "cell_offsets", np.asarray(self.cell_offsets, dtype=np.int64))
        object.__setattr__(self, "cell_nodes", np.asarray(self.cell_nodes, dtype=np.int32))
        object.__setattr__(self, "element_markers", np.asarray(self.element_markers, dtype=np.int32))
        object.__setattr__(self, "facet_types", np.asarray(self.facet_types, dtype=np.str_))
        object.__setattr__(self, "facet_roles", np.asarray(self.facet_roles, dtype=np.str_))
        object.__setattr__(self, "facet_offsets", np.asarray(self.facet_offsets, dtype=np.int64))
        object.__setattr__(self, "facet_nodes", np.asarray(self.facet_nodes, dtype=np.int32))
        object.__setattr__(self, "boundary_markers", np.asarray(self.boundary_markers, dtype=np.int32))
        object.__setattr__(self, "cell_global_ordinals", np.asarray(self.cell_global_ordinals, dtype=np.int64))
        object.__setattr__(self, "facet_global_ordinals", np.asarray(self.facet_global_ordinals, dtype=np.int64))
        object.__setattr__(self, "cell_mesh_parts", np.asarray(self.cell_mesh_parts, dtype=np.str_))
        object.__setattr__(
            self,
            "periodic_boundary_pairs",
            [dict(pair) for pair in self.periodic_boundary_pairs],
        )
        object.__setattr__(
            self,
            "periodic_node_pairs",
            [dict(pair) for pair in self.periodic_node_pairs],
        )
        if self.periodic_mesh_certificate is not None:
            certificate = dict(self.periodic_mesh_certificate)
            if certificate.get("schema_version") != "periodic_mesh_certificate.v6":
                raise ValueError("periodic_mesh_certificate must use schema periodic_mesh_certificate.v6")
            if certificate.get("certificate_status") != "accepted":
                raise ValueError("periodic_mesh_certificate must be accepted")
            object.__setattr__(self, "periodic_mesh_certificate", certificate)
        if self.realization_report is not None and not isinstance(
            self.realization_report,
            MeshRealizationReport,
        ):
            raise TypeError("realization_report must be a MeshRealizationReport")
        if self.mixed_layer_topology_certificate is not None and not isinstance(
            self.mixed_layer_topology_certificate,
            (MixedLayerTopologyCertificate, MixedLayerTopologyCertificateV2),
        ):
            raise TypeError(
                "mixed_layer_topology_certificate must be a supported mixed certificate"
            )

        # A native mixed certificate is emitted only after the Rust bridge has
        # parsed and validated the complete typed CSR mesh (including node
        # references, arities, ordinals, mesh parts, facet roles, orientation,
        # degeneracy, conformity, and the certificate evidence).  Repeating
        # the Python per-cell/per-facet validation here is therefore redundant
        # for the accepted production path and costs several seconds for the
        # large SP4 mesh.  Keep the ordinary Python validation as the
        # fail-closed fallback when the optional extension is unavailable or
        # rejects the certificate.
        if (
            self.mixed_layer_topology_certificate is not None
            and self._native_mixed_certificate_valid()
        ):
            self._validate_realization_report()
            return
        self.validate()
        self._validate_realization_report()
        self._validate_mixed_layer_topology_certificate()

    def _validate_realization_report(self) -> None:
        report = self.realization_report
        if report is None:
            return
        actual_families = sorted(set(self.cell_types.tolist()))
        if actual_families != [report.resolved_topology]:
            actual = ",".join(actual_families) if actual_families else "empty"
            raise ValueError(
                f"mesh realization report resolved topology {report.resolved_topology} "
                f"does not match actual cell family {actual}"
            )
        if report.resolved_order != 1:
            raise ValueError(
                f"mesh realization report resolved order {report.resolved_order} "
                "does not match actual linear topology order 1"
            )
        axis = {"x": 0, "y": 1, "z": 2}[report.resolved_axis]
        actual_layers = _count_exact_layer_planes(self.nodes, axis) - 1
        if actual_layers != report.resolved_layers:
            raise ValueError(
                f"mesh realization report resolved layers {report.resolved_layers} "
                f"does not match actual layer count {actual_layers}"
            )

    @classmethod
    def _from_prevalidated_mixed_certificate(
        cls,
        *,
        mesh_without_certificate: "MeshData",
        validation: _PrevalidatedMixedCertificate,
        token: object,
    ) -> "MeshData":
        if token is not _PREVALIDATED_MIXED_CERTIFICATE_TOKEN:
            raise ValueError("prevalidated mixed certificate token is invalid")
        if mesh_without_certificate.mixed_layer_topology_certificate is not None:
            raise ValueError("prevalidated mixed certificate requires an unsigned mesh")
        if not isinstance(validation, _PrevalidatedMixedCertificate):
            raise TypeError("prevalidated mixed certificate has invalid validation evidence")
        if validation._validation_token is not _PREVALIDATED_MIXED_CERTIFICATE_TOKEN:
            raise ValueError("prevalidated mixed certificate proof is not validated")
        certificate = validation.certificate
        carrier = validation.canonical_evidence
        if (
            not isinstance(carrier, _CanonicalMixedCertificateEvidence)
            or carrier not in _MINTED_CANONICAL_MIXED_EVIDENCE
            or carrier._capability is not _CANONICAL_MIXED_EVIDENCE_CAPABILITY
        ):
            raise ValueError("prevalidated mixed certificate evidence is not canonical")
        context = _require_mixed_topology_workspace(
            mesh_without_certificate,
            carrier.context.workspace,
            sweep_axis={"x": 0, "y": 1, "z": 2}[
                certificate.resolved_sweep_direction
            ],
            interface_marker=certificate.interface_marker,
            _bound_context=carrier.context,
        )
        # The prevalidated carrier is minted only after the native (or
        # reference) topology fingerprint has been bound to this exact mesh.
        # Re-running the Python byte-by-byte hash here duplicates a linear
        # pass over the large SP4 CSR arrays and provides no additional
        # protection over that identity-bound carrier.
        actual_fingerprint = validation.topology_fingerprint_v3
        if (
            context.actual_topology_fingerprint_v3 != actual_fingerprint
            or context.workspace.topology_fingerprint_v3 != actual_fingerprint
            or validation.topology_fingerprint_v3 != actual_fingerprint
        ):
            raise ValueError(
                "prevalidated mixed certificate topology fingerprint does not match mesh"
            )
        if (
            certificate.topology_fingerprint_version != "v3"
            or certificate.topology_fingerprint != actual_fingerprint
        ):
            raise ValueError(
                "prevalidated mixed certificate topology fingerprint is stale"
            )
        if (
            _certificate_payload_sha256(certificate)
            != validation.certificate_payload_sha256
        ):
            raise ValueError("prevalidated mixed certificate payload digest is stale")
        mesh_without_certificate._validate_mixed_layer_topology_certificate_evidence(
            certificate,
            carrier.evidence,
            workspace=context.workspace,
            _bound_context=context,
        )

        result = object.__new__(cls)
        for descriptor in fields(cls):
            value = (
                certificate
                if descriptor.name == "mixed_layer_topology_certificate"
                else getattr(mesh_without_certificate, descriptor.name)
            )
            object.__setattr__(result, descriptor.name, value)
        return result

    @classmethod
    def _from_trusted_native_preflight_receipt(
        cls,
        *,
        mesh_without_certificate: "MeshData",
        certificate: MixedLayerTopologyCertificate,
        proof: _TrustedNativePreflightReceiptProof,
    ) -> "MeshData":
        if mesh_without_certificate.mixed_layer_topology_certificate is not None:
            raise ValueError("trusted receipt construction requires an unsigned mesh")
        if not isinstance(certificate, MixedLayerTopologyCertificate):
            raise TypeError("trusted receipt certificate has an invalid type")
        if not isinstance(proof, _TrustedNativePreflightReceiptProof):
            raise TypeError("trusted native preflight proof has an invalid type")
        if proof not in _MINTED_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_PROOFS:
            raise ValueError("trusted native preflight proof is not owner-minted")
        if proof._capability is not _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY:
            raise ValueError("trusted native preflight proof capability is invalid")
        if (
            proof.mesh_without_certificate is not mesh_without_certificate
            or proof.certificate is not certificate
        ):
            raise ValueError("trusted native preflight proof identity is stale")
        context = proof.topology_context
        if (
            not isinstance(context, _TrustedTopologyFingerprintV3Context)
            or context not in _MINTED_TRUSTED_TOPOLOGY_FINGERPRINT_CONTEXTS
            or context._capability
            is not _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY
            or context.mesh_without_certificate is not mesh_without_certificate
        ):
            raise ValueError("trusted topology fingerprint context is invalid")
        current_counts = {
            "nodes": mesh_without_certificate.n_nodes,
            "cells": mesh_without_certificate.n_elements,
            "facets": mesh_without_certificate.n_boundary_faces,
        }
        if dict(proof.counts) != current_counts:
            raise ValueError("trusted native preflight proof counts are stale")
        if context.mesh_mutation_guard_sha256 is None:
            current_topology_fingerprint_v3 = (
                mesh_without_certificate.topology_fingerprint_v3()
            )
        else:
            current_guard = _trusted_mesh_mutation_guard_sha256(
                mesh_without_certificate
            )
            if current_guard != context.mesh_mutation_guard_sha256:
                raise ValueError("trusted native preflight proof topology is stale")
            # The native preflight bound this identity and the mutation guard
            # above confirms that the Python object still carries the exact
            # arrays that were preflighted.
            current_topology_fingerprint_v3 = context.topology_fingerprint_v3
        if (
            context.topology_fingerprint_v3 != current_topology_fingerprint_v3
            or certificate.topology_fingerprint_version != "v3"
            or certificate.topology_fingerprint
            != current_topology_fingerprint_v3
        ):
            raise ValueError("trusted native preflight proof topology is stale")
        if proof.certificate_payload_sha256 != _certificate_payload_sha256(certificate):
            raise ValueError("trusted native preflight proof certificate is stale")

        result = object.__new__(cls)
        for descriptor in fields(cls):
            value = (
                certificate
                if descriptor.name == "mixed_layer_topology_certificate"
                else getattr(mesh_without_certificate, descriptor.name)
            )
            object.__setattr__(result, descriptor.name, value)
        return result

    def _validate_mixed_layer_topology_certificate(self) -> None:
        certificate = self.mixed_layer_topology_certificate
        if certificate is None:
            return
        if isinstance(certificate, MixedLayerTopologyCertificateV2):
            self._validate_mixed_layer_topology_certificate_v2(certificate)
            return

        # The production certificate is minted by the native mixed-mesh
        # certifier when the managed runtime ships the optional extension.  A
        # Python re-computation of every cell Jacobian is both redundant and
        # prohibitively expensive for the large SP4 mesh (hundreds of
        # thousands of cells).  Let the same native engine validate the
        # complete certificate before falling back to the legacy Python audit
        # used by source-only/development runtimes.
        from fullmag import _core

        native = _core.certify_mixed_mesh_arrays(
            mesh=self,
            metadata={},
            certificate=certificate.to_dict(),
            require_native=False,
        )
        if native is not None and native.validated_claimed_certificate:
            if native.topology_fingerprint_v3 != certificate.topology_fingerprint:
                raise ValueError(
                    "native mixed layer topology certificate fingerprint is stale"
                )
            expected_payload = _certificate_payload_sha256(certificate)
            if native.certificate_payload_sha256 != expected_payload:
                raise ValueError(
                    "native mixed layer topology certificate payload is stale"
                )
            return

        # Keep the legacy Python audit as the diagnostic fallback for a
        # rejected certificate.  Besides supporting source-only runtimes,
        # this preserves the field-specific validation errors used by callers
        # and tests.  The slow path is only entered for invalid/tampered
        # certificates; valid production meshes return above.

        axis = {"x": 0, "y": 1, "z": 2}[certificate.resolved_sweep_direction]
        actual_topology_fingerprint_v3 = (
            self._validate_mixed_layer_topology_certificate_topology(certificate)
        )
        workspace = _build_mixed_topology_workspace(
            self,
            sweep_axis=axis,
            interface_marker=certificate.interface_marker,
            _topology_fingerprint_v3=actual_topology_fingerprint_v3,
        )
        context = _require_mixed_topology_workspace(
            self,
            workspace,
            sweep_axis=axis,
            interface_marker=certificate.interface_marker,
            _actual_topology_fingerprint_v3=actual_topology_fingerprint_v3,
        )
        self._validate_mixed_layer_topology_certificate_binding(
            certificate,
            workspace=workspace,
            validate_topology=False,
            _bound_context=context,
        )
        evidence = _recompute_mixed_certificate_evidence(
            self,
            sweep_axis=axis,
            interface_marker=certificate.interface_marker,
            outer_boundary_marker=certificate.outer_boundary_marker,
            magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
            magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
            airbox_bounds_min_m=certificate.airbox_bounds_min_m,
            airbox_bounds_max_m=certificate.airbox_bounds_max_m,
            workspace=workspace,
            _bound_context=context,
        )
        self._validate_mixed_layer_topology_certificate_evidence(
            certificate,
            evidence,
            workspace=workspace,
            _bound_context=context,
        )

    def _validate_mixed_layer_topology_certificate_v2(
        self,
        certificate: MixedLayerTopologyCertificateV2,
    ) -> None:
        """Validate the schema-native v2 mixed-body proof fail-closed.

        The native bridge is the authoritative expensive geometry proof when
        available.  The Python path deliberately checks the same ownership,
        exact-layer, material-field and separation bindings so a source-only
        environment cannot accidentally accept a v2 claim by routing it
        through the legacy single-body certifier.
        """
        certificate.validate()
        actual = (
            self.topology_fingerprint_v2()
            if certificate.topology_fingerprint_version == "v2"
            else self.topology_fingerprint_v3()
        )
        if certificate.topology_fingerprint != actual:
            raise ValueError(
                "mixed v2 certificate topology fingerprint is stale: "
                f"certificate={certificate.topology_fingerprint}, actual={actual}"
            )

        # Prefer the schema-native Rust proof.  A present native extension that
        # rejects the claim must not be downgraded to the permissive Python
        # path; only an unavailable v2 entrypoint permits the source fallback.
        from fullmag import _core

        native = _core.certify_mixed_mesh_arrays_v2(
            mesh=self,
            metadata={},
            certificate=certificate.to_dict(),
            require_native=False,
        )
        if native is not None:
            expected_payload = _certificate_payload_sha256(certificate)
            if (
                not native.validated_claimed_certificate
                or native.topology_fingerprint_version
                != certificate.topology_fingerprint_version
                or native.topology_fingerprint != actual
                or native.certificate_payload_sha256 != expected_payload
            ):
                raise ValueError("native mixed v2 certificate result does not match certificate")
            return

        marker_counts: dict[str, dict[str, int]] = {}
        part_counts: dict[str, dict[str, int]] = {}
        for family, marker, part in zip(
            self.cell_types.tolist(),
            self.element_markers.tolist(),
            self.cell_mesh_parts.tolist(),
            strict=True,
        ):
            marker_counts.setdefault(str(int(marker)), {})[str(family)] = (
                marker_counts.setdefault(str(int(marker)), {}).get(str(family), 0) + 1
            )
            part_counts.setdefault(str(part), {})[str(family)] = (
                part_counts.setdefault(str(part), {}).get(str(family), 0) + 1
            )
        if marker_counts != certificate.cell_family_counts_by_marker:
            raise ValueError("mixed v2 certificate cell_family_counts_by_marker does not match mesh")
        if part_counts != certificate.cell_family_counts_by_part:
            raise ValueError("mixed v2 certificate cell_family_counts_by_part does not match mesh")
        facet_counts = _facet_counts_by_role_marker(self)
        if facet_counts != certificate.facet_family_counts_by_role_marker:
            raise ValueError(
                "mixed v2 certificate facet_family_counts_by_role_marker does not match mesh"
            )
        region_by_marker = {region.body_marker: region for region in certificate.magnetic_regions}
        body_nodes: dict[int, np.ndarray] = {}
        for marker, region in region_by_marker.items():
            realized = marker_counts.get(str(marker), {})
            if realized != region.cell_family_counts:
                raise ValueError(
                    f"mixed v2 certificate magnetic region {region.object_id!r} cell counts do not match mesh"
                )
            ordinals = np.flatnonzero(self.element_markers == marker)
            if not len(ordinals):
                raise ValueError(f"mixed v2 certificate body marker {marker} has no cells")
            body_nodes[marker] = np.unique(
                np.concatenate([self.cell_node_ids(int(index)) for index in ordinals])
            ).astype(np.int64, copy=False)
        magnetic_markers = set(region_by_marker)
        if not magnetic_markers or any(
            marker in magnetic_markers and part != "magnetic"
            for marker, part in zip(self.element_markers.tolist(), self.cell_mesh_parts.tolist(), strict=True)
        ):
            raise ValueError("mixed v2 certificate magnetic marker ownership is invalid")

        # A P1 body field owns precisely the realized magnetic nodes.  This
        # check also catches a stale digest after pack_mesh_by_analysis remaps
        # topology, which a top-level fingerprint alone cannot establish.
        fields_by_object = {
            field.object_id: field for field in certificate.body_material_fields
        }
        regions_by_object = {
            region.object_id: region for region in certificate.magnetic_regions
        }
        for object_id, field in fields_by_object.items():
            region = regions_by_object[object_id]
            nodes = body_nodes[region.body_marker]
            expected_nodes = _mixed_v2_node_order_digest(nodes)
            if field.node_order_digest != expected_nodes:
                raise ValueError(f"mixed v2 body material node order for {object_id!r} is stale")
            if not _mixed_v2_material_values_are_valid(field.values):
                raise ValueError(f"mixed v2 body material values for {object_id!r} are invalid")
            expected_field_digest = _body_material_field_digest(
                field,
                topology_fingerprint_version=certificate.topology_fingerprint_version,
                topology_fingerprint=actual,
                body_marker=region.body_marker,
                material_marker=region.material_marker,
            )
            if field.field_digest != expected_field_digest:
                raise ValueError(f"mixed v2 body material digest for {object_id!r} is stale")

        # Exactly one body carries the authored exact sweep.  Its regional
        # evidence must be derived from that body's actual node coordinates and
        # agree with the shared top-level proof.
        exact_regions = [
            region for region in certificate.magnetic_regions if region.exact_sweep is not None
        ]
        if len(exact_regions) != 1:
            raise ValueError("mixed v2 certificate requires one exact swept region")
        for region in exact_regions:
            sweep = region.exact_sweep
            assert sweep is not None
            axis = {"x": 0, "y": 1, "z": 2}[sweep.sweep_direction_resolved]
            coordinates = sorted(float(self.nodes[int(node), axis]) for node in body_nodes[region.body_marker])
            planes: list[float] = []
            for coordinate in coordinates:
                if not planes or coordinate - planes[-1] > sweep.plane_tolerance_m:
                    planes.append(coordinate)
            if (
                tuple(planes) != sweep.magnetic_plane_coordinates_m
                or sweep.requested_layer_count != sweep.realized_layer_count
                or len(planes) != sweep.realized_layer_count + 1
                or sweep.sweep_direction_requested != certificate.requested_sweep_direction
                or sweep.sweep_direction_resolved != certificate.resolved_sweep_direction
                or sweep.realized_layer_count != certificate.realized_layer_count
                or sweep.magnetic_plane_coordinates_m != certificate.magnetic_plane_coordinates_m
                or not math.isclose(
                    sweep.plane_tolerance_m,
                    certificate.plane_tolerance_m,
                    rel_tol=1.0e-12,
                    abs_tol=1.0e-30,
                )
                or sweep.topology_fingerprint_version != certificate.topology_fingerprint_version
                or sweep.topology_fingerprint != actual
                or sweep.node_order_digest != _mixed_v2_node_order_digest(body_nodes[region.body_marker])
            ):
                raise ValueError(f"mixed v2 exact sweep evidence for {region.object_id!r} is stale")

        # Native admission uses the realized mesh body AABB distance.  Keep
        # Python fallback semantics identical so a claimed CAD gap cannot be
        # substituted for the actual discretized geometry.
        bounds: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        for region in certificate.magnetic_regions:
            points = self.nodes[body_nodes[region.body_marker]]
            bounds[region.object_id] = (np.min(points, axis=0), np.max(points, axis=0))
            if len({tuple(float(value) for value in point) for point in points}) != len(points):
                raise ValueError(f"mixed v2 body {region.object_id!r} has duplicate coordinates")
        for pair in certificate.body_separation_pairs:
            left_min, left_max = bounds[pair.body_a]
            right_min, right_max = bounds[pair.body_b]
            separation = np.maximum(
                np.maximum(left_min - right_max, right_min - left_max), 0.0
            )
            gap = float(np.linalg.norm(separation))
            if not math.isfinite(gap) or gap <= 0.0 or not math.isclose(
                pair.min_gap_m, gap, rel_tol=1.0e-12, abs_tol=1.0e-30
            ):
                raise ValueError(
                    f"mixed v2 body separation pair {pair.body_a!r}/{pair.body_b!r} disagrees with mesh"
                )

        # Distinct magnetic bodies must not alias a P1 node unless an explicit
        # interface operator exists; this certificate has no such operator.
        owners: dict[int, set[int]] = {}
        for marker, nodes in body_nodes.items():
            for node in nodes.tolist():
                owners.setdefault(int(node), set()).add(marker)
        if any(len(markers) > 1 for markers in owners.values()):
            raise ValueError("mixed v2 magnetic bodies share a mesh node without an interface operator")

    def _validate_mixed_layer_topology_certificate_binding(
        self,
        certificate: MixedLayerTopologyCertificate,
        *,
        workspace: "_MixedTopologyWorkspace | None" = None,
        validate_topology: bool = True,
        _bound_context: "_BoundMixedTopologyContext | None" = None,
    ) -> None:
        if validate_topology:
            self._validate_mixed_layer_topology_certificate_topology(certificate)
        context = _bound_context
        if workspace is not None:
            context = _require_mixed_topology_workspace(
                self,
                workspace,
                sweep_axis={"x": 0, "y": 1, "z": 2}[
                    certificate.resolved_sweep_direction
                ],
                interface_marker=certificate.interface_marker,
                _bound_context=_bound_context,
            )
        _validate_mixed_pyramid_bases(
            self,
            interface_marker=certificate.interface_marker,
            workspace=workspace,
            _bound_context=context,
        )

    def _validate_mixed_layer_topology_certificate_topology(
        self,
        certificate: MixedLayerTopologyCertificate,
        *,
        topology_fingerprint_v3: str | None = None,
    ) -> str:
        if certificate.topology_fingerprint_version == "v2":
            expected = self.topology_fingerprint_v2()
        elif certificate.topology_fingerprint_version == "v3":
            expected = topology_fingerprint_v3 or self.topology_fingerprint_v3()
        else:
            raise ValueError(
                "mixed layer topology certificate has an unsupported topology fingerprint version"
            )
        if certificate.topology_fingerprint != expected:
            raise ValueError(
                "mixed layer topology certificate topology fingerprint is stale: "
                f"certificate={certificate.topology_fingerprint}, actual={expected}"
            )
        if certificate.topology_fingerprint_version == "v3":
            return expected
        return topology_fingerprint_v3 or self.topology_fingerprint_v3()

    def _validate_mixed_layer_topology_certificate_evidence(
        self,
        certificate: MixedLayerTopologyCertificate,
        evidence: Mapping[str, object],
        *,
        workspace: "_MixedTopologyWorkspace | None" = None,
        _bound_context: "_BoundMixedTopologyContext | None" = None,
    ) -> None:
        if workspace is not None:
            _require_mixed_topology_workspace(
                self,
                workspace,
                sweep_axis={"x": 0, "y": 1, "z": 2}[
                    certificate.resolved_sweep_direction
                ],
                interface_marker=certificate.interface_marker,
                _bound_context=_bound_context,
            )
        for name, actual in evidence.items():
            claimed = getattr(certificate, name)
            # Match the cross-language binary64 contract in physics note 0106.
            # Only these dimensionless fields get an epsilon-scale floor;
            # dimensional determinants keep their SI-scale absolute tolerance.
            absolute_tolerance = (
                16 * np.finfo(np.float64).eps
                if name in {
                    "scaled_jacobian_minima_by_family",
                    "scaled_jacobian_p05_by_family",
                    "magnetic_relative_volume_error",
                    "shared_domain_relative_volume_error",
                }
                else 1.0e-30
            )
            if isinstance(actual, Mapping):
                if name in {
                    "jacobian_minima_m3_by_family",
                    "scaled_jacobian_minima_by_family",
                    "scaled_jacobian_p05_by_family",
                }:
                    matches = set(claimed) == set(actual) and all(
                        math.isfinite(float(claimed[key]))
                        and math.isfinite(float(value))
                        and math.isclose(
                            float(claimed[key]), float(value),
                            rel_tol=1.0e-12, abs_tol=absolute_tolerance,
                        )
                        for key, value in actual.items()
                    )
                else:
                    matches = claimed == actual
            elif isinstance(actual, tuple):
                matches = len(claimed) == len(actual) and np.allclose(
                    claimed, actual, rtol=0.0, atol=max(
                        certificate.plane_tolerance_m, float(evidence["plane_tolerance_m"])
                    )
                )
            elif isinstance(actual, (bool, int)):
                matches = claimed == actual
            else:
                matches = math.isclose(
                    float(claimed), float(actual), rel_tol=1.0e-12,
                    abs_tol=absolute_tolerance,
                )
            if not matches:
                raise ValueError(f"mixed layer topology certificate {name} is stale")
        if workspace is None:
            axis = {"x": 0, "y": 1, "z": 2}[
                certificate.resolved_sweep_direction
            ]
            magnetic_ordinals = np.flatnonzero(self.element_markers == 1)
            if not len(magnetic_ordinals):
                raise ValueError(
                    "mixed layer topology certificate requires magnetic marker 1"
                )
            magnetic_nodes = np.unique(
                np.concatenate([
                    self.cell_node_ids(int(index)) for index in magnetic_ordinals
                ])
            )
            planes, tolerance = _cluster_coordinate_planes(
                self.nodes[magnetic_nodes], axis
            )
        else:
            planes = workspace.magnetic_layer_coordinates
            tolerance = workspace.magnetic_layer_tolerance
        if len(planes) != certificate.realized_layer_count + 1 or not np.allclose(
            planes,
            certificate.magnetic_plane_coordinates_m,
            rtol=0.0,
            atol=max(tolerance, certificate.plane_tolerance_m),
        ):
            raise ValueError("mixed layer topology certificate magnetic planes are stale")
        native_compact_workspace = (
            workspace is not None
            and not workspace.cell_nodes_per_ordinal
            and not workspace.canonical_faces_per_cell
        )
        if (
            not native_compact_workspace
            and _cell_counts_by_marker(self)
            != certificate.cell_family_counts_by_marker
        ):
            raise ValueError("mixed layer topology certificate cell marker counts are stale")
        parts = certificate.cell_family_counts_by_part
        if set(parts) != {"magnetic", "transition_air", "far_air"}:
            raise ValueError("mixed layer topology certificate mesh parts are incomplete")
        marker_counts = certificate.cell_family_counts_by_marker
        if parts["magnetic"] != marker_counts.get("1", {}):
            raise ValueError("mixed layer topology certificate magnetic part counts are stale")
        air_totals: dict[str, int] = {}
        for part in ("transition_air", "far_air"):
            for family, count in parts[part].items():
                air_totals[family] = air_totals.get(family, 0) + int(count)
        if dict(sorted(air_totals.items())) != marker_counts.get("0", {}):
            raise ValueError("mixed layer topology certificate air part counts are stale")
        if parts["transition_air"].get("pyramid5", 0) < 1 or any(
            family != "tet4" for family in parts["far_air"]
        ):
            raise ValueError("mixed layer topology certificate transition partition is stale")
        if (
            not native_compact_workspace
            and _facet_counts_by_role_marker(self)
            != certificate.facet_family_counts_by_role_marker
        ):
            raise ValueError("mixed layer topology certificate facet counts are stale")

    def topology_fingerprint_v2(self) -> str:
        payload = {
            "nodes": self.nodes.tolist(),
            "cells": {
                "types": self.cell_types.tolist(),
                "offsets": self.cell_offsets.tolist(),
                "nodes": self.cell_nodes.tolist(),
                "global_ordinals": self.cell_global_ordinals.tolist(),
                "mesh_parts": self.cell_mesh_parts.tolist(),
            },
            "element_markers": self.element_markers.tolist(),
            "facets": {
                "types": self.facet_types.tolist(),
                "roles": self.facet_roles.tolist(),
                "offsets": self.facet_offsets.tolist(),
                "nodes": self.facet_nodes.tolist(),
                "global_ordinals": self.facet_global_ordinals.tolist(),
            },
            "boundary_markers": self.boundary_markers.tolist(),
            "periodic_boundary_pairs": self.periodic_boundary_pairs,
            "periodic_node_pairs": self.periodic_node_pairs,
        }
        encoded = json.dumps(
            payload,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
        digest = hashlib.sha256(
            b"fullmag:fem-mesh-topology-fingerprint:v2" + encoded
        ).hexdigest()
        return f"sha256:{digest}"

    def topology_fingerprint_v3(self) -> str:
        encoded = bytearray(b"fullmag:fem-mesh-topology-fingerprint:v3")

        def u8(value: int) -> None:
            encoded.extend(struct.pack("<B", value))

        def u32(value: object) -> None:
            try:
                integer = operator.index(value)  # type: ignore[arg-type]
            except TypeError as error:
                raise TypeError("topology fingerprint v3 u32 field must be an integer") from error
            if isinstance(value, bool) or integer < 0 or integer > 0xFFFF_FFFF:
                raise ValueError("topology fingerprint v3 u32 value is out of range")
            encoded.extend(struct.pack("<I", integer))

        def u64(value: object) -> None:
            try:
                integer = operator.index(value)  # type: ignore[arg-type]
            except TypeError as error:
                raise TypeError("topology fingerprint v3 u64 field must be an integer") from error
            if isinstance(value, bool) or integer < 0 or integer > 0xFFFF_FFFF_FFFF_FFFF:
                raise ValueError("topology fingerprint v3 u64 value is out of range")
            encoded.extend(struct.pack("<Q", integer))

        def f64(value: object) -> None:
            number = float(value)
            if not math.isfinite(number):
                raise ValueError("topology fingerprint v3 requires finite f64 values")
            bits = struct.unpack("<Q", struct.pack("<d", number))[0]
            u64(bits)

        def string(value: object) -> None:
            if not isinstance(value, str):
                raise TypeError("topology fingerprint v3 string field must be a string")
            data = value.encode("utf-8")
            u64(len(data))
            encoded.extend(data)

        def sequence(values: object, write_item: Any, payload: bytes | None = None) -> None:
            # ``payload`` is the already validated little-endian encoding of
            # every item; ``None`` keeps the per-item writer and its errors.
            if payload is not None:
                u64(len(values))  # type: ignore[arg-type]
                encoded.extend(payload)
                return
            items = list(values)  # type: ignore[arg-type]
            u64(len(items))
            for item in items:
                write_item(item)

        def optional(value: object, write_value: Any) -> None:
            if value is None:
                u8(0)
            else:
                u8(1)
                write_value(value)

        def f64x3(values: object) -> None:
            items = list(values)  # type: ignore[arg-type]
            if len(items) != 3:
                raise ValueError("topology fingerprint v3 vector must have three components")
            for item in items:
                f64(item)

        def enum(mapping: dict[str, int], value: object) -> None:
            if not isinstance(value, str):
                raise TypeError("topology fingerprint v3 enum field must be a string")
            try:
                tag = mapping[value]
            except KeyError as error:
                raise ValueError(
                    f"topology fingerprint v3 has unsupported enum value {value!r}"
                ) from error
            u8(tag)

        def enum_sequence(values: object, mapping: dict[str, int]) -> None:
            sequence(
                values,
                lambda value: enum(mapping, value),
                _fingerprint_enum_payload(values, mapping),
            )

        sequence(self.nodes, f64x3, _fingerprint_f64x3_payload(self.nodes))
        enum_sequence(self.cell_types, {"tet4": 1, "prism6": 2, "pyramid5": 3, "hex8": 4})
        sequence(self.cell_offsets, u32, _fingerprint_uint_payload(self.cell_offsets, 32))
        sequence(self.cell_nodes, u32, _fingerprint_uint_payload(self.cell_nodes, 32))
        sequence(self.cell_global_ordinals, u64, _fingerprint_uint_payload(self.cell_global_ordinals, 64))
        enum_sequence(self.cell_mesh_parts, {"magnetic": 1, "transition_air": 2, "far_air": 3})
        sequence(self.element_markers, u32, _fingerprint_uint_payload(self.element_markers, 32))
        enum_sequence(self.facet_types, {"tri3": 1, "quad4": 2})
        enum_sequence(
            self.facet_roles,
            {"exterior": 1, "material_interface": 2, "periodic_seam": 3},
        )
        sequence(self.facet_offsets, u32, _fingerprint_uint_payload(self.facet_offsets, 32))
        sequence(self.facet_nodes, u32, _fingerprint_uint_payload(self.facet_nodes, 32))
        sequence(self.facet_global_ordinals, u64, _fingerprint_uint_payload(self.facet_global_ordinals, 64))
        sequence(self.boundary_markers, u32, _fingerprint_uint_payload(self.boundary_markers, 32))

        def periodic_boundary_pair(pair: object) -> None:
            if not isinstance(pair, dict):
                raise TypeError("topology fingerprint v3 periodic boundary pair must be an object")
            string(pair.get("pair_id"))
            optional(pair.get("source_marker"), string)
            optional(pair.get("destination_marker"), string)
            u32(pair.get("marker_a", 0))
            u32(pair.get("marker_b", 0))
            translation = pair.get("translation")
            optional(translation, f64x3)
            tolerance = pair.get("tolerance")
            if tolerance is None:
                tolerance = pair.get("tolerance_m")
            optional(tolerance, f64)
            optional(pair.get("axis_hint"), string)
            optional(pair.get("orientation"), string)
            optional(pair.get("pairing_policy"), string)

        sequence(self.periodic_boundary_pairs, periodic_boundary_pair)

        def periodic_node_pair(pair: object) -> None:
            if not isinstance(pair, dict):
                raise TypeError("topology fingerprint v3 periodic node pair must be an object")
            string(pair.get("pair_id"))
            u32(pair.get("node_a"))
            u32(pair.get("node_b"))

        sequence(self.periodic_node_pairs, periodic_node_pair)
        return f"sha256:{hashlib.sha256(encoded).hexdigest()}"

    @classmethod
    def from_legacy_tet4(
        cls,
        *,
        nodes: NDArray[np.float64] | list[list[float]],
        elements: NDArray[np.int32] | list[list[int]],
        element_markers: NDArray[np.int32] | list[int],
        boundary_faces: NDArray[np.int32] | list[list[int]],
        boundary_markers: NDArray[np.int32] | list[int],
        periodic_boundary_pairs: list[dict[str, object]] | None = None,
        periodic_node_pairs: list[dict[str, object]] | None = None,
        periodic_mesh_certificate: dict[str, object] | None = None,
        quality: MeshQualityReport | None = None,
        per_domain_quality: dict[int, MeshQualityReport] | None = None,
        realization_report: MeshRealizationReport | None = None,
        mixed_layer_topology_certificate: MixedLayerTopologyCertificateLike | None = None,
        vertex_identity: Mapping[str, object] | None = None,
    ) -> "MeshData":
        """Normalize the explicit legacy tet4/tri3 boundary into canonical CSR."""
        tet = np.asarray(elements, dtype=np.int32)
        tri = np.asarray(boundary_faces, dtype=np.int32)
        if tet.size == 0:
            tet = np.zeros((0, 4), dtype=np.int32)
        if tri.size == 0:
            tri = np.zeros((0, 3), dtype=np.int32)
        if tet.ndim != 2 or tet.shape[1] != 4:
            raise ValueError("legacy elements must have shape (M, 4)")
        if tri.ndim != 2 or tri.shape[1] != 3:
            raise ValueError("legacy boundary_faces must have shape (F, 3)")
        return cls(
            nodes=nodes,
            cell_types=["tet4"] * len(tet),
            cell_offsets=np.arange(0, 4 * len(tet) + 1, 4, dtype=np.int64),
            cell_nodes=tet.reshape(-1),
            element_markers=element_markers,
            facet_types=["tri3"] * len(tri),
            facet_roles=["exterior"] * len(tri),
            facet_offsets=np.arange(0, 3 * len(tri) + 1, 3, dtype=np.int64),
            facet_nodes=tri.reshape(-1),
            boundary_markers=boundary_markers,
            cell_global_ordinals=np.arange(len(tet), dtype=np.int64),
            facet_global_ordinals=np.arange(len(tri), dtype=np.int64),
            periodic_boundary_pairs=periodic_boundary_pairs or [],
            periodic_node_pairs=periodic_node_pairs or [],
            periodic_mesh_certificate=periodic_mesh_certificate,
            quality=quality,
            per_domain_quality=per_domain_quality,
            realization_report=realization_report,
            mixed_layer_topology_certificate=mixed_layer_topology_certificate,
            vertex_identity=vertex_identity,
            cell_mesh_parts=np.asarray([], dtype=np.str_),
        )

    @property
    def n_nodes(self) -> int:
        return int(self.nodes.shape[0])

    @property
    def n_elements(self) -> int:
        return int(self.cell_types.shape[0])

    @property
    def n_boundary_faces(self) -> int:
        return int(self.facet_types.shape[0])

    @property
    def elements(self) -> NDArray[np.int32]:
        """Derived tet4 compatibility matrix; mixed topology fails explicitly."""
        if np.any(self.cell_types != "tet4"):
            raise ValueError("elements is a tet4-only compatibility view")
        return self.cell_nodes.reshape((-1, 4))

    @property
    def boundary_faces(self) -> NDArray[np.int32]:
        """Derived tri3 compatibility matrix; mixed facets fail explicitly."""
        if np.any(self.facet_types != "tri3"):
            raise ValueError("boundary_faces is a tri3-only compatibility view")
        return self.facet_nodes.reshape((-1, 3))

    def cell_node_ids(self, index: int) -> NDArray[np.int32]:
        return self.cell_nodes[self.cell_offsets[index] : self.cell_offsets[index + 1]]

    def facet_node_ids(self, index: int) -> NDArray[np.int32]:
        return self.facet_nodes[self.facet_offsets[index] : self.facet_offsets[index + 1]]

    def cell_blocks(self) -> list[MeshCellBlockView]:
        blocks: list[MeshCellBlockView] = []
        for cell_type in FEM_CELL_ARITIES:
            ordinals = np.flatnonzero(self.cell_types == cell_type).astype(np.int64)
            if not len(ordinals):
                continue
            blocks.append(
                MeshCellBlockView(
                    cell_type=cell_type,
                    nodes=np.stack([self.cell_node_ids(int(i)) for i in ordinals]).astype(np.int32),
                    markers=self.element_markers[ordinals],
                    global_ordinals=self.cell_global_ordinals[ordinals],
                )
            )
        return blocks

    def facet_blocks(self) -> list[MeshFacetBlockView]:
        blocks: list[MeshFacetBlockView] = []
        for facet_type in FEM_FACET_ARITIES:
            for role in ("exterior", "material_interface", "periodic_seam"):
                ordinals = np.flatnonzero(
                    (self.facet_types == facet_type) & (self.facet_roles == role)
                ).astype(np.int64)
                if not len(ordinals):
                    continue
                blocks.append(
                    MeshFacetBlockView(
                        facet_type=facet_type,
                        role=role,
                        nodes=np.stack([self.facet_node_ids(int(i)) for i in ordinals]).astype(np.int32),
                        markers=self.boundary_markers[ordinals],
                        global_ordinals=self.facet_global_ordinals[ordinals],
                    )
                )
        return blocks

    def validate(self) -> None:
        if self.nodes.ndim != 2 or self.nodes.shape[1] != 3:
            raise ValueError("nodes must have shape (N, 3)")
        _validate_typed_csr(
            types=self.cell_types,
            offsets=self.cell_offsets,
            nodes=self.cell_nodes,
            arities=FEM_CELL_ARITIES,
            kind="cell",
            node_count=self.n_nodes,
        )
        if self.element_markers.shape != (self.n_elements,):
            raise ValueError("element_markers must have shape (cell count,)")
        if self.cell_mesh_parts.shape not in {(0,), (self.n_elements,)}:
            raise ValueError("cell_mesh_parts must be empty or have shape (cell count,)")
        if self.cell_mesh_parts.size:
            unknown_parts = sorted(
                set(self.cell_mesh_parts.tolist())
                - {"magnetic", "transition_air", "far_air"}
            )
            if unknown_parts:
                raise ValueError(f"unknown cell mesh part: {unknown_parts[0]}")
        _validate_global_ordinals(self.cell_global_ordinals, self.n_elements, "cell")
        _validate_typed_csr(
            types=self.facet_types,
            offsets=self.facet_offsets,
            nodes=self.facet_nodes,
            arities=FEM_FACET_ARITIES,
            kind="facet",
            node_count=self.n_nodes,
        )
        if self.facet_roles.shape != (self.n_boundary_faces,):
            raise ValueError("facet_roles must have shape (facet count,)")
        unknown_roles = sorted(set(self.facet_roles.tolist()) - FEM_FACET_ROLES)
        if unknown_roles:
            raise ValueError(f"unknown facet role: {unknown_roles[0]}")
        if self.boundary_markers.shape != (self.n_boundary_faces,):
            raise ValueError("boundary_markers must have shape (facet count,)")
        _validate_global_ordinals(self.facet_global_ordinals, self.n_boundary_faces, "facet")
        mixed_cells = np.any(self.cell_types != "tet4")
        if mixed_cells and (
            self.periodic_boundary_pairs
            or self.periodic_node_pairs
            or self.periodic_mesh_certificate is not None
            or np.any(self.facet_roles == "periodic_seam")
        ):
            raise ValueError(
                "mixed topology with periodic pairs/certificate is not qualified; "
                "use tet4 or remove periodic topology"
            )
        for index, pair in enumerate(self.periodic_boundary_pairs):
            if not isinstance(pair.get("pair_id"), str) or not str(pair.get("pair_id")).strip():
                raise ValueError(f"periodic_boundary_pairs[{index}] must define a non-empty pair_id")
        for index, pair in enumerate(self.periodic_node_pairs):
            pair_id = pair.get("pair_id")
            if not isinstance(pair_id, str) or not pair_id.strip():
                raise ValueError(f"periodic_node_pairs[{index}] must define a non-empty pair_id")
            node_a = int(pair.get("node_a", -1))
            node_b = int(pair.get("node_b", -1))
            if node_a < 0 or node_a >= self.n_nodes or node_b < 0 or node_b >= self.n_nodes:
                raise ValueError(f"periodic_node_pairs[{index}] contain invalid node indices")
            if node_a == node_b:
                raise ValueError(f"periodic_node_pairs[{index}] must connect distinct nodes")

    def validate_strict(
        self,
        *,
        require_positive_orientation: bool = True,
        eps_volume: float | None = None,
        _evidence_coordinate_scale_to_m: float | None = None,
    ) -> None:
        # Certified mixed meshes already carry native per-cell Jacobian
        # evidence.  Re-running this check in a Python loop is prohibitively
        # expensive for the production SP4 mesh, while the native certifier
        # performs the same geometry/degeneracy/orientation checks in Rayon.
        # Keep the historical loop as a strict fallback for source-only
        # runtimes, custom epsilon policies, and uncertified meshes.
        if (
            require_positive_orientation
            and eps_volume is None
            and self._native_mixed_certificate_valid()
        ):
            return
        self.validate()
        if not np.all(np.isfinite(self.nodes)):
            raise ValueError("mesh nodes must be finite")
        if self.n_elements == 0:
            raise ValueError("mesh must contain at least one FEM cell")
        if self.element_markers.shape != (self.n_elements,):
            raise ValueError("element_markers must cover every FEM cell")

        # A batched screen finds every candidate failure; the scalar check
        # below stays the authority for the verdict, its order and its
        # message.  The screen widens the epsilon by a relative margin far
        # above the rounding difference of its vectorized ``L**3``.
        candidates: list[NDArray[np.int64]] = []
        for cell_type, ordinals, coordinates in _iter_cell_family_batches(self):
            determinants = _cell_jacobian_determinants_batch(cell_type, coordinates)
            if eps_volume is not None:
                screen_eps = np.full(ordinals.size, float(eps_volume) * 6.0)
            else:
                characteristic_length = np.max(
                    np.linalg.norm(
                        coordinates[:, :, np.newaxis, :] - coordinates[:, np.newaxis, :, :],
                        axis=3,
                    ),
                    axis=(1, 2),
                )
                screen_eps = np.maximum(
                    np.finfo(np.float64).tiny,
                    FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS * characteristic_length**3,
                )
            flagged = ~(np.min(np.abs(determinants), axis=1) > screen_eps * (1.0 + 1.0e-9))
            if require_positive_orientation:
                flagged |= np.any(determinants < 0.0, axis=1)
            candidates.append(ordinals[flagged])
        candidate_ordinals = (
            np.sort(np.concatenate(candidates)) if candidates else np.zeros(0, dtype=np.int64)
        )
        for index in candidate_ordinals.tolist():
            cell_type = str(self.cell_types[index])
            coordinates = self.nodes[self.cell_node_ids(index)]
            determinants = _cell_jacobian_determinants(cell_type, coordinates)
            characteristic_length = float(np.max(np.linalg.norm(
                coordinates[:, np.newaxis, :] - coordinates[np.newaxis, :, :],
                axis=2,
            )))
            resolved_eps = (
                float(eps_volume) * 6.0
                if eps_volume is not None
                else max(
                    np.finfo(np.float64).tiny,
                    FEM_TOPOLOGY_RELATIVE_DETERMINANT_EPS
                    * characteristic_length**3,
                )
            )
            minimum_abs = float(np.min(np.abs(determinants)))
            if minimum_abs <= resolved_eps:
                volume_context = (
                    " (degenerate tetra volume)" if cell_type == "tet4" else ""
                )
                evidence = (
                    self._tet4_strict_failure_evidence(
                        index,
                        coordinates,
                        float(determinants[0]),
                        resolved_eps,
                        coordinate_scale_to_m=_evidence_coordinate_scale_to_m,
                    )
                    if cell_type == "tet4"
                    else ""
                )
                raise ValueError(
                    f"mesh CSR cell {index} global ordinal {int(self.cell_global_ordinals[index])} "
                    f"has degenerate {cell_type} Jacobian{volume_context} "
                    f"{minimum_abs:.6e} <= eps {resolved_eps:.6e}{evidence}"
                )
            if require_positive_orientation and np.any(determinants < 0.0):
                minimum_determinant = float(np.min(determinants))
                evidence = (
                    self._tet4_strict_failure_evidence(
                        index,
                        coordinates,
                        minimum_determinant,
                        resolved_eps,
                        coordinate_scale_to_m=_evidence_coordinate_scale_to_m,
                    )
                    if cell_type == "tet4"
                    else ""
                )
                raise ValueError(
                    f"mesh CSR cell {index} global ordinal {int(self.cell_global_ordinals[index])} "
                    f"has negative {cell_type} Jacobian "
                    f"{minimum_determinant:.6e}{evidence}"
                )

    def _tet4_strict_failure_evidence(
        self,
        index: int,
        coordinates: NDArray[np.float64],
        determinant: float,
        epsilon: float,
        *,
        coordinate_scale_to_m: float | None,
    ) -> str:
        """Format bounded evidence for one rejected tet without guessing its owner."""
        node_indices = [int(node) for node in self.cell_node_ids(index)]
        scale_to_m: float | None = None
        scale_cubed = 1.0
        if coordinate_scale_to_m is not None:
            try:
                candidate_scale = float(coordinate_scale_to_m)
                candidate_scale_cubed = candidate_scale**3
            except (OverflowError, TypeError, ValueError):
                candidate_scale = float("nan")
                candidate_scale_cubed = float("nan")
            if (
                np.isfinite(candidate_scale)
                and candidate_scale > 0.0
                and np.isfinite(candidate_scale_cubed)
            ):
                scale_to_m = candidate_scale
                scale_cubed = candidate_scale_cubed

        raw_coordinates = np.asarray(coordinates, dtype=np.float64)
        raw_edge_lengths = np.linalg.norm(
            raw_coordinates[:, np.newaxis, :] - raw_coordinates[np.newaxis, :, :],
            axis=2,
        )[np.triu_indices(4, k=1)]
        if scale_to_m is not None:
            scaled_coordinates = raw_coordinates * scale_to_m
            scaled_edges = raw_edge_lengths * scale_to_m
            scaled_determinant = determinant * scale_cubed
            scaled_epsilon = epsilon * scale_cubed
            if (
                np.all(np.isfinite(scaled_coordinates))
                and np.all(np.isfinite(scaled_edges))
                and np.isfinite(scaled_determinant)
                and np.isfinite(scaled_epsilon)
            ):
                evidence_coordinates = scaled_coordinates
                edge_lengths = scaled_edges
                determinant = scaled_determinant
                epsilon = scaled_epsilon
                coordinate_label = "coordinates_m"
                determinant_label = "determinant_m3"
                epsilon_label = "epsilon_m3"
                edge_min_label = "edge_min_m"
                edge_max_label = "edge_max_m"
                diameter_label = "diameter_m"
            else:
                scale_to_m = None
        if scale_to_m is None:
            evidence_coordinates = raw_coordinates
            edge_lengths = raw_edge_lengths
            coordinate_label = "coordinates_mesh_units"
            determinant_label = "determinant_mesh_units3"
            epsilon_label = "epsilon_mesh_units3"
            edge_min_label = "edge_min_mesh_units"
            edge_max_label = "edge_max_mesh_units"
            diameter_label = "diameter_mesh_units"

        coordinates_text = "[" + ", ".join(
            "[" + ", ".join(f"{float(value):.9e}" for value in row) + "]"
            for row in evidence_coordinates
        ) + "]"
        marker = int(self.element_markers[index])
        return (
            "; tet4 evidence: "
            f"node_indices={node_indices}; "
            f"{coordinate_label}={coordinates_text}; "
            f"{determinant_label}={determinant:.9e}; "
            f"{epsilon_label}={epsilon:.9e}; "
            f"{edge_min_label}={float(np.min(edge_lengths)):.9e}; "
            f"{edge_max_label}={float(np.max(edge_lengths)):.9e}; "
            f"{diameter_label}={float(np.max(edge_lengths)):.9e}; "
            f"element_marker={marker}"
        )

    def _native_mixed_certificate_valid(self) -> bool:
        """Return whether the native certifier accepted this exact mesh.

        ``False`` deliberately means "use the reference Python path" rather
        than treating an unavailable extension as an error.  Certificate
        construction and ``MeshData`` initialization retain their existing
        fail-closed behavior; this helper only avoids duplicating an already
        accepted geometry pass in performance-sensitive serialization paths.
        """
        certificate = self.mixed_layer_topology_certificate
        if certificate is None:
            return False
        try:
            from fullmag import _core

            if isinstance(certificate, MixedLayerTopologyCertificateV2):
                native = _core.certify_mixed_mesh_arrays_v2(
                    mesh=self,
                    metadata={},
                    certificate=certificate.to_dict(),
                    require_native=False,
                )
                if native is None or not native.validated_claimed_certificate:
                    return False
                expected_fingerprint = (
                    self.topology_fingerprint_v2()
                    if certificate.topology_fingerprint_version == "v2"
                    else self.topology_fingerprint_v3()
                )
                return (
                    native.topology_fingerprint_version
                    == certificate.topology_fingerprint_version
                    and native.topology_fingerprint == expected_fingerprint
                    and native.certificate_payload_sha256
                    == _certificate_payload_sha256(certificate)
                )
            native = _core.certify_mixed_mesh_arrays(
                mesh=self,
                metadata={},
                certificate=certificate.to_dict(),
                require_native=False,
            )
        except (ImportError, RuntimeError, TypeError, ValueError):
            return False
        if native is None or not native.validated_claimed_certificate:
            return False
        return (
            native.topology_fingerprint_v3 == certificate.topology_fingerprint
            and native.certificate_payload_sha256
            == _certificate_payload_sha256(certificate)
        )

    def oriented_copy(self) -> "MeshData":
        if self.n_elements == 0:
            return self
        cell_nodes = np.array(self.cell_nodes, copy=True)
        reverse = {
            "tet4": [0, 1, 3, 2],
            "prism6": [0, 2, 1, 3, 5, 4],
            "pyramid5": [0, 3, 2, 1, 4],
            "hex8": [1, 0, 3, 2, 5, 4, 7, 6],
        }
        changed = False
        for cell_type, ordinals, coordinates in _iter_cell_family_batches(self):
            determinants = _cell_jacobian_determinants_batch(cell_type, coordinates)
            flipped = ordinals[np.all(determinants < 0.0, axis=1)]
            if flipped.size:
                starts = self.cell_offsets[flipped][:, np.newaxis]
                cell_nodes[starts + np.arange(len(reverse[cell_type]))] = self.cell_nodes[
                    starts + np.asarray(reverse[cell_type], dtype=np.int64)
                ]
                changed = True
        if not changed:
            return self
        return MeshData(
            nodes=np.array(self.nodes, copy=True),
            cell_types=np.array(self.cell_types, copy=True),
            cell_offsets=np.array(self.cell_offsets, copy=True),
            cell_nodes=cell_nodes,
            element_markers=np.array(self.element_markers, copy=True),
            facet_types=np.array(self.facet_types, copy=True),
            facet_roles=np.array(self.facet_roles, copy=True),
            facet_offsets=np.array(self.facet_offsets, copy=True),
            facet_nodes=np.array(self.facet_nodes, copy=True),
            boundary_markers=np.array(self.boundary_markers, copy=True),
            cell_global_ordinals=np.array(self.cell_global_ordinals, copy=True),
            facet_global_ordinals=np.array(self.facet_global_ordinals, copy=True),
            cell_mesh_parts=np.array(self.cell_mesh_parts, copy=True),
            periodic_boundary_pairs=[dict(pair) for pair in self.periodic_boundary_pairs],
            periodic_node_pairs=[dict(pair) for pair in self.periodic_node_pairs],
            periodic_mesh_certificate=(
                dict(self.periodic_mesh_certificate)
                if self.periodic_mesh_certificate is not None
                else None
            ),
            # SICN is signed and the mixed topology fingerprint includes
            # ordered cell connectivity. A real reorientation invalidates the
            # extracted quality summaries and topology certificate; callers
            # must recompute them from the oriented mesh before publishing.
            quality=None,
            per_domain_quality=None,
            realization_report=self.realization_report,
            mixed_layer_topology_certificate=None,
            vertex_identity=self.vertex_identity,
        )

    def save(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.suffix.lower() == ".json":
            target.write_text(
                json.dumps(
                    {
                        "mesh_name": target.stem,
                        "vertex_identity": _vertex_identity_to_dict(self.vertex_identity),
                        "nodes": self.nodes.tolist(),
                        "cell_types": self.cell_types.tolist(),
                        "cell_offsets": self.cell_offsets.tolist(),
                        "cell_nodes": self.cell_nodes.tolist(),
                        "element_markers": self.element_markers.tolist(),
                        "facet_types": self.facet_types.tolist(),
                        "facet_roles": self.facet_roles.tolist(),
                        "facet_offsets": self.facet_offsets.tolist(),
                        "facet_nodes": self.facet_nodes.tolist(),
                        "boundary_markers": self.boundary_markers.tolist(),
                        "cell_global_ordinals": self.cell_global_ordinals.tolist(),
                        "facet_global_ordinals": self.facet_global_ordinals.tolist(),
                        "cell_mesh_parts": self.cell_mesh_parts.tolist(),
                        "periodic_boundary_pairs": self.periodic_boundary_pairs,
                        "periodic_node_pairs": self.periodic_node_pairs,
                        "periodic_mesh_certificate": self.periodic_mesh_certificate,
                        "quality": asdict(self.quality) if self.quality is not None else None,
                        "per_domain_quality": {
                            str(marker): asdict(report)
                            for marker, report in (self.per_domain_quality or {}).items()
                        },
                        "realization_report": (
                            self.realization_report.to_dict()
                            if self.realization_report is not None
                            else None
                        ),
                        "mixed_layer_topology_certificate": (
                            self.mixed_layer_topology_certificate.to_dict()
                            if self.mixed_layer_topology_certificate is not None
                            else None
                        ),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            return
        np.savez_compressed(
            target,
            nodes=self.nodes,
            vertex_identity_json=np.asarray(json.dumps(_vertex_identity_to_dict(self.vertex_identity))),
            cell_types=self.cell_types,
            cell_offsets=self.cell_offsets,
            cell_nodes=self.cell_nodes,
            element_markers=self.element_markers,
            facet_types=self.facet_types,
            facet_roles=self.facet_roles,
            facet_offsets=self.facet_offsets,
            facet_nodes=self.facet_nodes,
            boundary_markers=self.boundary_markers,
            cell_global_ordinals=self.cell_global_ordinals,
            facet_global_ordinals=self.facet_global_ordinals,
            cell_mesh_parts=self.cell_mesh_parts,
            periodic_boundary_pairs_json=np.asarray(
                json.dumps(self.periodic_boundary_pairs),
            ),
            periodic_node_pairs_json=np.asarray(
                json.dumps(self.periodic_node_pairs),
            ),
            periodic_mesh_certificate_json=np.asarray(
                json.dumps(self.periodic_mesh_certificate),
            ),
            quality_json=np.asarray(
                json.dumps(asdict(self.quality) if self.quality is not None else None),
            ),
            per_domain_quality_json=np.asarray(
                json.dumps(
                    {
                        str(marker): asdict(report)
                        for marker, report in (self.per_domain_quality or {}).items()
                    }
                ),
            ),
            realization_report_json=np.asarray(
                json.dumps(
                    self.realization_report.to_dict()
                    if self.realization_report is not None
                    else None
                ),
            ),
            mixed_layer_topology_certificate_json=np.asarray(
                json.dumps(
                    self.mixed_layer_topology_certificate.to_dict()
                    if self.mixed_layer_topology_certificate is not None
                    else None
                ),
            ),
        )

    def export_stl(self, path: str | Path) -> Path:
        """Export boundary surface as binary STL (zero dependencies)."""
        import struct
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        triangles: list[NDArray[np.int32]] = []
        for index, facet_type in enumerate(self.facet_types.tolist()):
            facet = self.facet_node_ids(index)
            if facet_type == "tri3":
                triangles.append(facet)
            else:
                triangles.extend((facet[[0, 1, 2]], facet[[0, 2, 3]]))
        n_faces = len(triangles)
        with open(target, "wb") as fp:
            fp.write(b"\0" * 80)  # header
            fp.write(struct.pack("<I", n_faces))
            for triangle in triangles:
                v0, v1, v2 = self.nodes[triangle]
                e1 = v1 - v0
                e2 = v2 - v0
                normal = np.cross(e1, e2)
                norm_len = np.linalg.norm(normal)
                if norm_len > 0:
                    normal /= norm_len
                fp.write(struct.pack("<3f", *normal.astype(np.float32)))
                fp.write(struct.pack("<3f", *v0.astype(np.float32)))
                fp.write(struct.pack("<3f", *v1.astype(np.float32)))
                fp.write(struct.pack("<3f", *v2.astype(np.float32)))
                fp.write(struct.pack("<H", 0))  # attribute byte count
        return target

    def export_vtk(
        self,
        path: str | Path,
        fields: dict[str, NDArray] | None = None,
    ) -> Path:
        """Export typed FEM cells as VTK legacy or VTU XML.

        Args:
            path: Destination file path.
            fields: Optional dict of per-node field data to include.
                    Keys are field names (e.g. "m", "H_ex").
                    Values are arrays of shape (n_nodes, 3) for vectors
                    or (n_nodes,) for scalars.
        """
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.suffix.lower() == ".vtu":
            return self._export_vtu(target, fields)
        n = self.n_nodes
        m = self.n_elements
        with open(target, "w", encoding="utf-8") as fp:
            fp.write("# vtk DataFile Version 3.0\n")
            fp.write("fullmag typed FEM mesh\n")
            fp.write("ASCII\n")
            fp.write("DATASET UNSTRUCTURED_GRID\n")
            fp.write(f"POINTS {n} double\n")
            for node in self.nodes:
                fp.write(f"{node[0]:.15e} {node[1]:.15e} {node[2]:.15e}\n")
            total = int(len(self.cell_nodes) + m)
            fp.write(f"\nCELLS {m} {total}\n")
            for index in range(m):
                cell = self.cell_node_ids(index)
                fp.write(f"{len(cell)} {' '.join(str(int(node)) for node in cell)}\n")
            fp.write(f"\nCELL_TYPES {m}\n")
            for cell_type in self.cell_types.tolist():
                fp.write(f"{VTK_CELL_TYPES[cell_type]}\n")
            fp.write(f"\nCELL_DATA {m}\n")
            fp.write("SCALARS region int 1\n")
            fp.write("LOOKUP_TABLE default\n")
            for marker in self.element_markers:
                fp.write(f"{marker}\n")
            # Per-node field data
            if fields:
                fp.write(f"\nPOINT_DATA {n}\n")
                for name, data in fields.items():
                    arr = np.asarray(data)
                    if arr.ndim == 2 and arr.shape[1] == 3:
                        fp.write(f"VECTORS {name} double\n")
                        for vec in arr:
                            fp.write(f"{vec[0]:.15e} {vec[1]:.15e} {vec[2]:.15e}\n")
                    elif arr.ndim == 1:
                        fp.write(f"SCALARS {name} double 1\n")
                        fp.write("LOOKUP_TABLE default\n")
                        for val in arr:
                            fp.write(f"{val:.15e}\n")
        return target

    def _export_vtu(
        self,
        target: Path,
        fields: dict[str, NDArray] | None,
    ) -> Path:
        point_values = " ".join(
            f"{value:.15e}" for node in self.nodes for value in node
        )
        connectivity = " ".join(str(int(node)) for node in self.cell_nodes)
        offsets = " ".join(str(int(offset)) for offset in self.cell_offsets[1:])
        types = " ".join(str(VTK_CELL_TYPES[kind]) for kind in self.cell_types.tolist())
        markers = " ".join(str(int(marker)) for marker in self.element_markers)
        point_data = ""
        if fields:
            arrays: list[str] = []
            for name, data in fields.items():
                values = np.asarray(data)
                components = 3 if values.ndim == 2 else 1
                flattened = " ".join(f"{float(value):.15e}" for value in values.reshape(-1))
                arrays.append(
                    f'<DataArray type="Float64" Name="{name}" NumberOfComponents="{components}" '
                    f'format="ascii">{flattened}</DataArray>'
                )
            point_data = f"<PointData>{''.join(arrays)}</PointData>"
        target.write_text(
            '<?xml version="1.0"?>\n'
            '<VTKFile type="UnstructuredGrid" version="0.1" byte_order="LittleEndian">\n'
            f'<UnstructuredGrid><Piece NumberOfPoints="{self.n_nodes}" NumberOfCells="{self.n_elements}">\n'
            f'{point_data}<CellData Scalars="region"><DataArray type="Int32" Name="region" format="ascii">{markers}</DataArray></CellData>\n'
            f'<Points><DataArray type="Float64" NumberOfComponents="3" format="ascii">{point_values}</DataArray></Points>\n'
            '<Cells>'
            f'<DataArray type="Int32" Name="connectivity" format="ascii">{connectivity}</DataArray>'
            f'<DataArray type="Int64" Name="offsets" format="ascii">{offsets}</DataArray>'
            f'<DataArray type="UInt8" Name="types" format="ascii">{types}</DataArray>'
            '</Cells></Piece></UnstructuredGrid></VTKFile>\n',
            encoding="utf-8",
        )
        return target

    @classmethod
    def load(cls, path: str | Path) -> "MeshData":
        source = Path(path)
        if source.suffix.lower() == ".json":
            payload = json.loads(source.read_text(encoding="utf-8"))
            return cls._from_serialized_mapping(payload)

        data = np.load(source)
        periodic_boundary_pairs: list[dict[str, object]] = []
        periodic_node_pairs: list[dict[str, object]] = []
        if "periodic_boundary_pairs_json" in data.files:
            periodic_boundary_pairs = [
                dict(pair)
                for pair in json.loads(str(data["periodic_boundary_pairs_json"]))
            ]
        if "periodic_node_pairs_json" in data.files:
            periodic_node_pairs = [
                dict(pair)
                for pair in json.loads(str(data["periodic_node_pairs_json"]))
            ]
        periodic_mesh_certificate = None
        if "periodic_mesh_certificate_json" in data.files:
            periodic_mesh_certificate = json.loads(str(data["periodic_mesh_certificate_json"]))
        quality = None
        if "quality_json" in data.files:
            quality = _mesh_quality_report_from_serialized(
                json.loads(str(data["quality_json"]))
            )
        per_domain_quality = None
        if "per_domain_quality_json" in data.files:
            raw_per_domain_quality = json.loads(str(data["per_domain_quality_json"]))
            per_domain_quality = {
                int(marker): _mesh_quality_report_from_serialized(report)
                for marker, report in raw_per_domain_quality.items()
            }
        realization_report = None
        if "realization_report_json" in data.files:
            raw_report = json.loads(str(data["realization_report_json"]))
            if raw_report is not None:
                realization_report = MeshRealizationReport.from_dict(dict(raw_report))
        mixed_layer_topology_certificate = None
        if "mixed_layer_topology_certificate_json" in data.files:
            raw_certificate = json.loads(
                str(data["mixed_layer_topology_certificate_json"])
            )
            if raw_certificate is not None:
                if not isinstance(raw_certificate, dict):
                    raise TypeError(
                        "serialized mixed_layer_topology_certificate must be "
                        "an object or null"
                    )
                mixed_layer_topology_certificate = _mixed_layer_topology_certificate_from_serialized(
                    raw_certificate
                )
        payload = {name: data[name] for name in data.files if not name.endswith("_json")}
        payload.update(
            vertex_identity=(
                json.loads(str(data["vertex_identity_json"]))
                if "vertex_identity_json" in data.files else None
            ),
            periodic_boundary_pairs=periodic_boundary_pairs,
            periodic_node_pairs=periodic_node_pairs,
            periodic_mesh_certificate=periodic_mesh_certificate,
            quality=quality,
            per_domain_quality=per_domain_quality,
            realization_report=realization_report,
            mixed_layer_topology_certificate=mixed_layer_topology_certificate,
        )
        return cls._from_serialized_mapping(payload)

    @classmethod
    def _from_serialized_mapping(cls, payload: dict[str, object]) -> "MeshData":
        legacy = "elements" in payload or "boundary_faces" in payload
        v2_names = {
            "cell_types", "cell_offsets", "cell_nodes",
            "facet_types", "facet_roles", "facet_offsets", "facet_nodes",
        }
        v2 = any(name in payload for name in v2_names)
        if legacy and v2:
            raise ValueError("mesh payload contains both legacy and v2 topology")
        common = dict(
            nodes=payload["nodes"],
            vertex_identity=payload.get("vertex_identity"),
            element_markers=payload["element_markers"],
            boundary_markers=payload["boundary_markers"],
            periodic_boundary_pairs=[dict(pair) for pair in payload.get("periodic_boundary_pairs", [])],
            periodic_node_pairs=[dict(pair) for pair in payload.get("periodic_node_pairs", [])],
            periodic_mesh_certificate=payload.get("periodic_mesh_certificate"),
            quality=_mesh_quality_report_from_serialized(payload.get("quality")),
            per_domain_quality={
                int(marker): _mesh_quality_report_from_serialized(report)
                for marker, report in dict(payload.get("per_domain_quality") or {}).items()
            } or None,
            realization_report=_mesh_realization_report_from_serialized(
                payload.get("realization_report")
            ),
            mixed_layer_topology_certificate=(
                _mixed_layer_topology_certificate_from_serialized(
                    payload.get("mixed_layer_topology_certificate")
                )
            ),
        )
        if legacy:
            if "elements" not in payload or "boundary_faces" not in payload:
                raise ValueError("legacy mesh payload requires elements and boundary_faces")
            return cls.from_legacy_tet4(
                **common,
                elements=payload["elements"],
                boundary_faces=payload["boundary_faces"],
            )
        missing = sorted(v2_names - payload.keys())
        if missing:
            raise ValueError(f"v2 mesh payload missing topology fields: {missing}")
        return cls(
            **common,
            cell_types=payload["cell_types"],
            cell_offsets=payload["cell_offsets"],
            cell_nodes=payload["cell_nodes"],
            facet_types=payload["facet_types"],
            facet_roles=payload["facet_roles"],
            facet_offsets=payload["facet_offsets"],
            facet_nodes=payload["facet_nodes"],
            cell_global_ordinals=payload.get("cell_global_ordinals", np.arange(len(payload["cell_types"]), dtype=np.int64)),
            facet_global_ordinals=payload.get("facet_global_ordinals", np.arange(len(payload["facet_types"]), dtype=np.int64)),
            cell_mesh_parts=payload.get("cell_mesh_parts", np.asarray([], dtype=np.str_)),
        )

    def statistics_ir(self, mesh_name: str) -> dict[str, object] | None:
        if not set(str(value) for value in self.cell_types.tolist()).issubset(
            FEM_CELL_ARITIES
        ) or not set(str(value) for value in self.facet_types.tolist()).issubset(
            FEM_FACET_ARITIES
        ):
            return None
        return _mesh_statistics_report_to_ir(
            _build_mesh_statistics_report(self, mesh_name)
        )

    def to_ir(self, mesh_name: str) -> dict[str, object]:
        # Native mixed certification proves positive orientation, so avoid a
        # second Python pass over every cell merely to discover that no
        # reorientation is needed.  Uncertified/source-only meshes retain the
        # legacy orientation and strict-validation behavior.
        native_mixed_valid = self._native_mixed_certificate_valid()
        mesh = self if native_mixed_valid else self.oriented_copy()
        if not native_mixed_valid:
            mesh.validate_strict(require_positive_orientation=True)
        ir: dict[str, object] = {
            "mesh_name": mesh_name,
            "nodes": mesh.nodes.tolist(),
            "cells": {
                "types": mesh.cell_types.tolist(),
                "offsets": mesh.cell_offsets.tolist(),
                "nodes": mesh.cell_nodes.tolist(),
                "global_ordinals": mesh.cell_global_ordinals.tolist(),
                "mesh_parts": mesh.cell_mesh_parts.tolist(),
            },
            "element_markers": mesh.element_markers.tolist(),
            "facets": {
                "types": mesh.facet_types.tolist(),
                "roles": mesh.facet_roles.tolist(),
                "offsets": mesh.facet_offsets.tolist(),
                "nodes": mesh.facet_nodes.tolist(),
                "global_ordinals": mesh.facet_global_ordinals.tolist(),
            },
            "boundary_markers": mesh.boundary_markers.tolist(),
        }
        periodic_boundary_pairs = mesh.periodic_boundary_pairs
        periodic_node_pairs = mesh.periodic_node_pairs
        if periodic_boundary_pairs:
            ir["periodic_boundary_pairs"] = periodic_boundary_pairs
        if periodic_node_pairs:
            ir["periodic_node_pairs"] = periodic_node_pairs
        if mesh.periodic_mesh_certificate is not None:
            ir["periodic_mesh_certificate"] = dict(mesh.periodic_mesh_certificate)
        if mesh.realization_report is not None:
            ir["mesh_realization_report"] = mesh.realization_report.to_dict()
        if mesh.mixed_layer_topology_certificate is not None:
            ir["mixed_layer_topology_certificate"] = (
                mesh.mixed_layer_topology_certificate.to_dict()
            )
        if _legacy_per_domain_quality_is_complete(mesh):
            assert mesh.per_domain_quality is not None
            ir["per_domain_quality"] = {
                str(marker): {
                    "n_elements": q.n_elements,
                    "sicn_min": q.sicn_min,
                    "sicn_max": q.sicn_max,
                    "sicn_mean": q.sicn_mean,
                    "sicn_p5": q.sicn_p5,
                    "sicn_histogram": q.sicn_histogram,
                    "gamma_min": q.gamma_min,
                    "gamma_mean": q.gamma_mean,
                    "gamma_histogram": q.gamma_histogram,
                    "volume_min": q.volume_min,
                    "volume_max": q.volume_max,
                    "volume_mean": q.volume_mean,
                    "volume_std": q.volume_std,
                    "avg_quality": q.avg_quality,
                }
                for marker, q in mesh.per_domain_quality.items()
            }
        mesh_statistics = mesh.statistics_ir(mesh_name)
        if mesh_statistics is not None:
            ir["mesh_statistics"] = mesh_statistics
        return ir


def _legacy_per_domain_quality_is_complete(mesh: MeshData) -> bool:
    """Whether the legacy gamma-bearing carrier covers every eligible marker."""
    reports = mesh.per_domain_quality
    if not reports:
        return False

    marker_ids, marker_counts = np.unique(mesh.element_markers, return_counts=True)
    canonical_counts = {
        int(marker): int(count)
        for marker, count in zip(marker_ids, marker_counts, strict=True)
    }
    if set(reports) != set(canonical_counts):
        return False

    gamma_supported = np.isin(mesh.cell_types, ("tet4", "prism6"))
    unsupported_markers = set(
        int(marker)
        for marker in np.unique(mesh.element_markers[~gamma_supported])
    )
    for marker, expected_count in canonical_counts.items():
        report = reports[marker]
        if (
            report.n_elements != expected_count
            or report.quality_source != "gmsh"
            or marker in unsupported_markers
            or (
                report.gamma_element_count is not None
                and report.gamma_element_count != expected_count
            )
        ):
            return False
    return True


def _mesh_quality_report_from_serialized(value: object) -> MeshQualityReport | None:
    if value is None:
        return None
    if isinstance(value, MeshQualityReport):
        return value
    if not isinstance(value, dict):
        raise TypeError("serialized mesh quality report must be an object or null")
    return MeshQualityReport(**value)


def _mesh_realization_report_from_serialized(
    value: object,
) -> MeshRealizationReport | None:
    if value is None:
        return None
    if isinstance(value, MeshRealizationReport):
        return value
    if isinstance(value, dict):
        return MeshRealizationReport.from_dict(value)
    raise TypeError("serialized realization_report must be an object or null")


def _mixed_layer_topology_certificate_from_serialized(
    value: object,
) -> MixedLayerTopologyCertificateLike | None:
    if value is None:
        return None
    if isinstance(value, (MixedLayerTopologyCertificate, MixedLayerTopologyCertificateV2)):
        return value
    if isinstance(value, dict):
        schema_version = value.get("schema_version")
        if schema_version == "mixed_layer_topology_certificate.v1":
            return MixedLayerTopologyCertificate.from_dict(value)
        if schema_version == "mixed_layer_topology_certificate.v2":
            return MixedLayerTopologyCertificateV2.from_dict(value)
        raise ValueError(
            "serialized mixed_layer_topology_certificate has an unsupported schema_version"
        )
    raise TypeError(
        "serialized mixed_layer_topology_certificate must be an object or null"
    )


def _normalize_nested_counts(
    value: object,
    name: str,
) -> dict[str, dict[str, int]]:
    if not isinstance(value, dict):
        raise TypeError(f"mixed layer topology certificate {name} must be an object")
    normalized: dict[str, dict[str, int]] = {}
    for outer_key, raw_counts in value.items():
        if not isinstance(outer_key, str):
            raise TypeError(
                f"mixed layer topology certificate {name} outer keys must be strings"
            )
        if not isinstance(raw_counts, dict):
            raise TypeError(
                f"mixed layer topology certificate {name}[{outer_key!r}] must be an object"
            )
        counts: dict[str, int] = {}
        for family, raw_count in raw_counts.items():
            if not isinstance(family, str):
                raise TypeError(
                    f"mixed layer topology certificate {name} inner keys must be strings"
                )
            if isinstance(raw_count, bool) or not isinstance(raw_count, int) or raw_count < 0:
                raise TypeError(
                    f"mixed layer topology certificate {name} counts must be non-negative integers"
                )
            if raw_count:
                counts[family] = raw_count
        normalized[outer_key] = counts
    return normalized


def _cluster_coordinate_planes(
    nodes: NDArray[np.float64] | object,
    axis: int,
) -> tuple[tuple[float, ...], float]:
    coordinates = np.asarray(nodes, dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[1] != 3 or len(coordinates) == 0:
        raise ValueError("plane clustering requires non-empty nodes with shape (N, 3)")
    values = sorted(float(value) for value in coordinates[:, axis])
    thickness = values[-1] - values[0]
    tolerance = max(
        FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M,
        FEM_EXACT_LAYER_PLANE_REL_TOLERANCE * thickness,
    )
    planes: list[float] = []
    for value in values:
        if not planes or abs(value - planes[-1]) > tolerance:
            planes.append(value)
    return tuple(planes), tolerance


def _cell_counts_by_marker(mesh: MeshData) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for family, marker in zip(
        mesh.cell_types.tolist(), mesh.element_markers.tolist(), strict=True
    ):
        by_family = counts.setdefault(str(int(marker)), {})
        by_family[str(family)] = by_family.get(str(family), 0) + 1
    return {key: dict(sorted(value.items())) for key, value in sorted(counts.items())}


def _cell_counts_by_part(mesh: MeshData) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {
        "magnetic": {},
        "transition_air": {},
        "far_air": {},
    }
    if mesh.cell_mesh_parts.shape != (mesh.n_elements,):
        return {}
    for family, part in zip(
        mesh.cell_types.tolist(), mesh.cell_mesh_parts.tolist(), strict=True
    ):
        counts[part][str(family)] = counts[part].get(str(family), 0) + 1
    return {
        key: dict(sorted(value.items()))
        for key, value in sorted(counts.items())
        if value
    }


def _facet_counts_by_role_marker(mesh: MeshData) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for family, role, marker in zip(
        mesh.facet_types.tolist(),
        mesh.facet_roles.tolist(),
        mesh.boundary_markers.tolist(),
        strict=True,
    ):
        key = f"{role}:{int(marker)}"
        by_family = counts.setdefault(key, {})
        by_family[str(family)] = by_family.get(str(family), 0) + 1
    return {key: dict(sorted(value.items())) for key, value in sorted(counts.items())}


_MIXED_CELL_LOCAL_FACETS: dict[str, tuple[tuple[int, ...], ...]] = {
    "tet4": ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)),
    "prism6": (
        (0, 1, 2),
        (3, 5, 4),
        (0, 3, 4, 1),
        (1, 4, 5, 2),
        (2, 5, 3, 0),
    ),
    "pyramid5": (
        (0, 3, 2, 1),
        (0, 1, 4),
        (1, 2, 4),
        (2, 3, 4),
        (3, 0, 4),
    ),
    "hex8": (
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ),
}

# Canonical physical edges derived from the oriented local faces.  Do not use
# all node pairs for prism/pyramid/hex quality: diagonals are not mesh edges
# and would inflate ``cell.max_edge`` and aspect-ratio diagnostics.
_MIXED_CELL_LOCAL_EDGES: dict[str, tuple[tuple[int, int], ...]] = {
    family: tuple(
        sorted(
            {
                tuple(sorted((face[index], face[(index + 1) % len(face)])))
                for face in facets
                for index in range(len(face))
            }
        )
    )
    for family, facets in _MIXED_CELL_LOCAL_FACETS.items()
}


@dataclass(frozen=True)
class _MixedTopologyWorkspace:
    topology_fingerprint_v3: str
    sweep_axis: int
    interface_marker: int
    cell_nodes_per_ordinal: tuple[NDArray[np.int32], ...]
    canonical_faces_per_cell: tuple[tuple[tuple[int, ...], ...], ...]
    face_owners: Mapping[tuple[int, ...], tuple[int, ...]]
    cell_family_ordinals: Mapping[str, tuple[int, ...]]
    cell_signed_volumes: NDArray[np.float64]
    cell_absolute_volumes: NDArray[np.float64]
    pyramid_base_classification: Mapping[tuple[int, ...], bool]
    magnetic_layer_coordinates: tuple[float, ...]
    magnetic_layer_tolerance: float


@dataclass(frozen=True, eq=False)
class _BoundMixedTopologyContext:
    mesh: MeshData = field(repr=False, compare=False)
    workspace: _MixedTopologyWorkspace
    actual_topology_fingerprint_v3: str
    sweep_axis: int
    interface_marker: int
    _capability: object = field(repr=False, compare=False)


_BOUND_MIXED_TOPOLOGY_CAPABILITY = object()
_MINTED_BOUND_MIXED_TOPOLOGY_CONTEXTS: WeakSet[_BoundMixedTopologyContext] = (
    WeakSet()
)


@dataclass(frozen=True, eq=False)
class _CanonicalMixedCertificateEvidence:
    evidence: Mapping[str, object]
    context: _BoundMixedTopologyContext
    _capability: object = field(repr=False, compare=False)


_CANONICAL_MIXED_EVIDENCE_CAPABILITY = object()
_MINTED_CANONICAL_MIXED_EVIDENCE: WeakSet[
    _CanonicalMixedCertificateEvidence
] = WeakSet()


def _build_mixed_topology_workspace(
    mesh: MeshData,
    *,
    sweep_axis: int,
    interface_marker: int,
    _topology_fingerprint_v3: str | None = None,
) -> _MixedTopologyWorkspace:
    cell_nodes_per_ordinal_list: list[NDArray[np.int32]] = []
    for ordinal in range(mesh.n_elements):
        cell = mesh.cell_node_ids(ordinal)
        cell.setflags(write=False)
        cell_nodes_per_ordinal_list.append(cell)
    cell_nodes_per_ordinal = tuple(cell_nodes_per_ordinal_list)
    canonical_faces_per_cell = tuple(
        tuple(
            tuple(sorted(int(cell[index]) for index in local_face))
            for local_face in _MIXED_CELL_LOCAL_FACETS[str(family)]
        )
        for family, cell in zip(
            mesh.cell_types.tolist(), cell_nodes_per_ordinal, strict=True
        )
    )
    face_owners = {
        face: tuple(owners)
        for face, owners in _mixed_face_adjacency(
            mesh,
            canonical_faces_per_cell=canonical_faces_per_cell,
        ).items()
    }
    family_ordinals: dict[str, list[int]] = {}
    signed_volumes = np.zeros(mesh.n_elements, dtype=np.float64)
    absolute_volumes = np.zeros(mesh.n_elements, dtype=np.float64)
    for ordinal, (family, cell) in enumerate(zip(
        mesh.cell_types.tolist(), cell_nodes_per_ordinal, strict=True
    )):
        family_ordinals.setdefault(str(family), []).append(ordinal)
        coordinates = mesh.nodes[cell]
        signed, absolute = _mixed_cell_signed_and_absolute_volume(
            str(family), coordinates
        )
        signed_volumes[ordinal] = signed
        absolute_volumes[ordinal] = absolute

    interface_quads = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(ordinal)))
        for ordinal, (family, role, marker) in enumerate(zip(
            mesh.facet_types.tolist(),
            mesh.facet_roles.tolist(),
            mesh.boundary_markers.tolist(),
            strict=True,
        ))
        if family == "quad4"
        and role == "material_interface"
        and int(marker) == interface_marker
    }
    pyramid_bases = {
        tuple(sorted(int(cell[index]) for index in (0, 1, 2, 3)))
        for ordinal in family_ordinals.get("pyramid5", [])
        for cell in (cell_nodes_per_ordinal[ordinal],)
    }
    magnetic_ordinals = np.flatnonzero(mesh.element_markers == 1)
    if len(magnetic_ordinals):
        magnetic_nodes = np.unique(np.concatenate([
            cell_nodes_per_ordinal[int(ordinal)] for ordinal in magnetic_ordinals
        ]))
        magnetic_planes, magnetic_tolerance = _cluster_coordinate_planes(
            mesh.nodes[magnetic_nodes], sweep_axis
        )
    else:
        magnetic_planes = ()
        magnetic_tolerance = FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M
    signed_volumes.setflags(write=False)
    absolute_volumes.setflags(write=False)
    return _MixedTopologyWorkspace(
        topology_fingerprint_v3=(
            _topology_fingerprint_v3 or mesh.topology_fingerprint_v3()
        ),
        sweep_axis=sweep_axis,
        interface_marker=interface_marker,
        cell_nodes_per_ordinal=cell_nodes_per_ordinal,
        canonical_faces_per_cell=canonical_faces_per_cell,
        face_owners=MappingProxyType(face_owners),
        cell_family_ordinals=MappingProxyType({
            family: tuple(ordinals)
            for family, ordinals in sorted(family_ordinals.items())
        }),
        cell_signed_volumes=signed_volumes,
        cell_absolute_volumes=absolute_volumes,
        pyramid_base_classification=MappingProxyType({
            face: face in interface_quads for face in sorted(pyramid_bases)
        }),
        magnetic_layer_coordinates=magnetic_planes,
        magnetic_layer_tolerance=magnetic_tolerance,
    )


def _build_mixed_topology_workspace_from_native(
    mesh: MeshData,
    *,
    sweep_axis: int,
    interface_marker: int,
    topology_fingerprint_v3: str,
    magnetic_layer_coordinates: tuple[float, ...],
    magnetic_layer_tolerance: float,
) -> _MixedTopologyWorkspace:
    """Create the small binding workspace after native certification.

    The native certifier already owns the expensive per-cell geometry and face
    audit.  Python only needs an identity-bound carrier for certificate
    construction; retaining millions of Python face/volume objects here would
    turn a linear Rust pass back into the historical multi-minute bottleneck.
    The full workspace builder remains the fail-closed fallback when the
    optional extension is unavailable.
    """
    if not isinstance(topology_fingerprint_v3, str) or not topology_fingerprint_v3:
        raise ValueError("native mixed topology fingerprint must be non-empty")
    if sweep_axis not in (0, 1, 2):
        raise ValueError("mixed topology workspace sweep axis must be 0, 1, or 2")
    if not math.isfinite(float(magnetic_layer_tolerance)) or magnetic_layer_tolerance <= 0.0:
        raise ValueError("native mixed topology plane tolerance must be positive")

    # Pyramid base classification is the only topology detail consumed by the
    # binding checks.  It is bounded by the transition shell, unlike the full
    # cell/face adjacency workspace.
    interface_quads = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(ordinal)))
        for ordinal, (family, role, marker) in enumerate(zip(
            mesh.facet_types.tolist(),
            mesh.facet_roles.tolist(),
            mesh.boundary_markers.tolist(),
            strict=True,
        ))
        if family == "quad4"
        and role == "material_interface"
        and int(marker) == interface_marker
    }
    pyramid_bases: dict[tuple[int, ...], bool] = {}
    for ordinal in np.flatnonzero(mesh.cell_types == "pyramid5"):
        cell = mesh.cell_node_ids(int(ordinal))
        base = tuple(sorted(int(cell[index]) for index in (0, 1, 2, 3)))
        pyramid_bases[base] = base in interface_quads

    empty_f64 = np.zeros(0, dtype=np.float64)
    empty_f64.setflags(write=False)
    return _MixedTopologyWorkspace(
        topology_fingerprint_v3=topology_fingerprint_v3,
        sweep_axis=sweep_axis,
        interface_marker=interface_marker,
        cell_nodes_per_ordinal=(),
        canonical_faces_per_cell=(),
        face_owners=MappingProxyType({}),
        cell_family_ordinals=MappingProxyType({}),
        cell_signed_volumes=empty_f64,
        cell_absolute_volumes=empty_f64,
        pyramid_base_classification=MappingProxyType(pyramid_bases),
        magnetic_layer_coordinates=tuple(float(value) for value in magnetic_layer_coordinates),
        magnetic_layer_tolerance=float(magnetic_layer_tolerance),
    )


def _require_mixed_topology_workspace(
    mesh: MeshData,
    workspace: _MixedTopologyWorkspace,
    *,
    sweep_axis: int | None = None,
    interface_marker: int | None = None,
    _bound_context: _BoundMixedTopologyContext | None = None,
    _actual_topology_fingerprint_v3: str | None = None,
) -> _BoundMixedTopologyContext:
    if not isinstance(workspace, _MixedTopologyWorkspace):
        raise TypeError("mixed topology workspace has an invalid type")
    if _bound_context is not None:
        if (
            not isinstance(_bound_context, _BoundMixedTopologyContext)
            or _bound_context not in _MINTED_BOUND_MIXED_TOPOLOGY_CONTEXTS
        ):
            raise ValueError("mixed topology bound context is not owner-minted")
        if (
            _bound_context._capability is not _BOUND_MIXED_TOPOLOGY_CAPABILITY
            or _bound_context.mesh is not mesh
            or _bound_context.workspace is not workspace
        ):
            raise ValueError("mixed topology bound context is invalid")
        if sweep_axis is not None and _bound_context.sweep_axis != sweep_axis:
            raise ValueError("mixed topology workspace sweep axis does not match")
        if (
            interface_marker is not None
            and _bound_context.interface_marker != interface_marker
        ):
            raise ValueError("mixed topology workspace interface marker does not match")
        return _bound_context
    actual_fingerprint = (
        _actual_topology_fingerprint_v3 or mesh.topology_fingerprint_v3()
    )
    if workspace.topology_fingerprint_v3 != actual_fingerprint:
        raise ValueError("mixed topology workspace topology fingerprint is stale")
    if sweep_axis is not None and workspace.sweep_axis != sweep_axis:
        raise ValueError("mixed topology workspace sweep axis does not match")
    if interface_marker is not None and workspace.interface_marker != interface_marker:
        raise ValueError("mixed topology workspace interface marker does not match")
    context = _BoundMixedTopologyContext(
        mesh=mesh,
        workspace=workspace,
        actual_topology_fingerprint_v3=actual_fingerprint,
        sweep_axis=workspace.sweep_axis,
        interface_marker=workspace.interface_marker,
        _capability=_BOUND_MIXED_TOPOLOGY_CAPABILITY,
    )
    _MINTED_BOUND_MIXED_TOPOLOGY_CONTEXTS.add(context)
    return context


def _immutable_mixed_certificate_evidence(value: object) -> object:
    if isinstance(value, Mapping):
        return MappingProxyType({
            str(key): _immutable_mixed_certificate_evidence(item)
            for key, item in value.items()
        })
    if isinstance(value, list):
        return tuple(_immutable_mixed_certificate_evidence(item) for item in value)
    if isinstance(value, tuple):
        return tuple(_immutable_mixed_certificate_evidence(item) for item in value)
    return value


def _mixed_certificate_evidence_payload(
    evidence: Mapping[str, object],
) -> dict[str, object]:
    def mutable(value: object) -> object:
        if isinstance(value, Mapping):
            return {str(key): mutable(item) for key, item in value.items()}
        if isinstance(value, tuple):
            return tuple(mutable(item) for item in value)
        return value

    return {str(key): mutable(value) for key, value in evidence.items()}


def _validate_and_create_prevalidated_mixed_certificate(
    mesh_without_certificate: MeshData,
    *,
    certificate: MixedLayerTopologyCertificate,
    canonical_evidence: _CanonicalMixedCertificateEvidence,
) -> _PrevalidatedMixedCertificate:
    if mesh_without_certificate.mixed_layer_topology_certificate is not None:
        raise ValueError("prevalidated mixed certificate requires an unsigned mesh")
    if not isinstance(canonical_evidence, _CanonicalMixedCertificateEvidence):
        raise TypeError("mixed certificate evidence requires a canonical carrier")
    if canonical_evidence not in _MINTED_CANONICAL_MIXED_EVIDENCE:
        raise ValueError("mixed certificate evidence carrier is not owner-minted")
    if canonical_evidence._capability is not _CANONICAL_MIXED_EVIDENCE_CAPABILITY:
        raise ValueError("mixed certificate evidence carrier is not canonical")
    context = canonical_evidence.context
    workspace = context.workspace
    mesh_without_certificate._validate_mixed_layer_topology_certificate_binding(
        certificate,
        workspace=workspace,
        validate_topology=False,
        _bound_context=context,
    )
    mesh_without_certificate._validate_mixed_layer_topology_certificate_topology(
        certificate,
        topology_fingerprint_v3=workspace.topology_fingerprint_v3,
    )
    mesh_without_certificate._validate_mixed_layer_topology_certificate_evidence(
        certificate,
        canonical_evidence.evidence,
        workspace=workspace,
        _bound_context=context,
    )
    return _PrevalidatedMixedCertificate(
        certificate=certificate,
        topology_fingerprint_v3=workspace.topology_fingerprint_v3,
        certificate_payload_sha256=_certificate_payload_sha256(certificate),
        canonical_evidence=canonical_evidence,
        _validation_token=_PREVALIDATED_MIXED_CERTIFICATE_TOKEN,
    )


def _bind_trusted_topology_fingerprint_v3(
    *,
    mesh_without_certificate: MeshData,
    _receipt_capability: object,
) -> _TrustedTopologyFingerprintV3Context:
    """Compute one identity-bound Python topology fingerprint for trusted load."""
    if _receipt_capability is not _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY:
        raise ValueError("trusted receipt capability is invalid")
    if mesh_without_certificate.mixed_layer_topology_certificate is not None:
        raise ValueError("trusted topology context requires an unsigned mesh")
    context = _TrustedTopologyFingerprintV3Context(
        mesh_without_certificate=mesh_without_certificate,
        topology_fingerprint_v3=mesh_without_certificate.topology_fingerprint_v3(),
        _capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
    )
    _MINTED_TRUSTED_TOPOLOGY_FINGERPRINT_CONTEXTS.add(context)
    return context


def _bind_trusted_topology_fingerprint_v3_from_native(
    *,
    mesh_without_certificate: MeshData,
    native_preflight: object,
    _receipt_capability: object,
) -> _TrustedTopologyFingerprintV3Context:
    """Bind a trusted topology context to an already completed native proof.

    ``preflight_mixed_mesh_arrays`` computes the canonical v3 fingerprint in
    Rust while validating the complete typed CSR payload.  The trusted loader
    can therefore carry that identity forward instead of recomputing the
    Python byte stream.  A compact content guard is retained for the narrow
    in-process interval between preflight and signed ``MeshData`` creation;
    it detects mutation without weakening the native structural proof.
    """
    from fullmag._core import NativeMixedPreflightResult

    if _receipt_capability is not _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY:
        raise ValueError("trusted receipt capability is invalid")
    if mesh_without_certificate.mixed_layer_topology_certificate is not None:
        raise ValueError("trusted topology context requires an unsigned mesh")
    if not isinstance(native_preflight, NativeMixedPreflightResult):
        raise TypeError("native preflight result has an invalid type")
    actual_counts = {
        "nodes": mesh_without_certificate.n_nodes,
        "cells": mesh_without_certificate.n_elements,
        "facets": mesh_without_certificate.n_boundary_faces,
    }
    if native_preflight.counts != actual_counts:
        raise ValueError("native preflight mesh counts do not match the mesh")
    fingerprint = native_preflight.topology_fingerprint_v3
    if (
        not isinstance(fingerprint, str)
        or not fingerprint.startswith("sha256:")
        or len(fingerprint) != len("sha256:") + 64
        or any(character not in "0123456789abcdef" for character in fingerprint[7:])
    ):
        raise ValueError("native preflight topology fingerprint is invalid")
    context = _TrustedTopologyFingerprintV3Context(
        mesh_without_certificate=mesh_without_certificate,
        topology_fingerprint_v3=fingerprint,
        _capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
        mesh_mutation_guard_sha256=_trusted_mesh_mutation_guard_sha256(
            mesh_without_certificate
        ),
    )
    _MINTED_TRUSTED_TOPOLOGY_FINGERPRINT_CONTEXTS.add(context)
    return context


def _mint_trusted_native_preflight_receipt_proof(
    *,
    mesh_without_certificate: MeshData,
    certificate: MixedLayerTopologyCertificate,
    native_preflight: object,
    topology_context: _TrustedTopologyFingerprintV3Context,
    expected_topology_fingerprint_v3: str,
    expected_certificate_payload_sha256: str,
    expected_counts: Mapping[str, int],
    _receipt_capability: object,
) -> _TrustedNativePreflightReceiptProof:
    """Mint the narrow proof consumed only after trusted-cache receipt checks."""
    from fullmag._core import NativeMixedPreflightResult

    if _receipt_capability is not _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY:
        raise ValueError("trusted receipt capability is invalid")
    if mesh_without_certificate.mixed_layer_topology_certificate is not None:
        raise ValueError("trusted native preflight proof requires an unsigned mesh")
    if not isinstance(certificate, MixedLayerTopologyCertificate):
        raise TypeError("trusted receipt certificate has an invalid type")
    if not isinstance(native_preflight, NativeMixedPreflightResult):
        raise TypeError("native preflight result has an invalid type")
    if (
        not isinstance(topology_context, _TrustedTopologyFingerprintV3Context)
        or topology_context not in _MINTED_TRUSTED_TOPOLOGY_FINGERPRINT_CONTEXTS
        or topology_context._capability
        is not _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY
        or topology_context.mesh_without_certificate is not mesh_without_certificate
    ):
        raise ValueError("trusted topology fingerprint context is invalid")

    actual_counts = {
        "nodes": mesh_without_certificate.n_nodes,
        "cells": mesh_without_certificate.n_elements,
        "facets": mesh_without_certificate.n_boundary_faces,
    }
    normalized_expected_counts = {
        str(name): int(value) for name, value in expected_counts.items()
    }
    if normalized_expected_counts != actual_counts:
        raise ValueError("trusted receipt mesh counts do not match the mesh")
    if native_preflight.counts != actual_counts:
        raise ValueError("native preflight mesh counts do not match the mesh")

    actual_fingerprint = topology_context.topology_fingerprint_v3
    expected_fingerprint = (
        expected_topology_fingerprint_v3
        if expected_topology_fingerprint_v3.startswith("sha256:")
        else f"sha256:{expected_topology_fingerprint_v3}"
    )
    native_fingerprint = (
        native_preflight.topology_fingerprint_v3
        if native_preflight.topology_fingerprint_v3.startswith("sha256:")
        else f"sha256:{native_preflight.topology_fingerprint_v3}"
    )
    if actual_fingerprint != expected_fingerprint:
        raise ValueError("trusted receipt topology fingerprint does not match the mesh")
    if native_fingerprint != expected_fingerprint:
        raise ValueError("native preflight topology fingerprint does not match receipt")
    if certificate.topology_fingerprint_version != "v3" or (
        certificate.topology_fingerprint != actual_fingerprint
    ):
        raise ValueError("trusted receipt certificate topology fingerprint is stale")

    actual_payload_sha256 = _certificate_payload_sha256(certificate)
    expected_payload_sha256 = (
        expected_certificate_payload_sha256
        if expected_certificate_payload_sha256.startswith("sha256:")
        else f"sha256:{expected_certificate_payload_sha256}"
    )
    if actual_payload_sha256 != expected_payload_sha256:
        raise ValueError("trusted receipt certificate payload digest is stale")

    proof = _TrustedNativePreflightReceiptProof(
        mesh_without_certificate=mesh_without_certificate,
        certificate=certificate,
        topology_context=topology_context,
        certificate_payload_sha256=actual_payload_sha256,
        counts=MappingProxyType(actual_counts),
        _capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
    )
    _MINTED_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_PROOFS.add(proof)
    return proof


def _mixed_face_frequencies(
    faces: list[tuple[int, ...]],
) -> Counter[tuple[int, ...]]:
    """Count explicit face identities in one linear pass."""
    return Counter(faces)


def _mixed_mesh_conformity_counts(
    mesh: MeshData,
    *,
    tolerance: float,
    interface_marker: int = MIXED_INTERFACE_MARKER,
    outer_boundary_marker: int | None = None,
    workspace: _MixedTopologyWorkspace | None = None,
    _bound_context: _BoundMixedTopologyContext | None = None,
) -> dict[str, int]:
    workspace_was_built = workspace is None
    resolved_workspace = workspace or _build_mixed_topology_workspace(
        mesh,
        sweep_axis=0,
        interface_marker=interface_marker,
    )
    context = _require_mixed_topology_workspace(
        mesh,
        resolved_workspace,
        interface_marker=interface_marker,
        _bound_context=_bound_context,
        _actual_topology_fingerprint_v3=(
            resolved_workspace.topology_fingerprint_v3
            if workspace_was_built
            else None
        ),
    )
    adjacency = resolved_workspace.face_owners

    explicit: dict[tuple[int, ...], list[int]] = {}
    exterior: list[tuple[int, ...]] = []
    interfaces: list[tuple[int, ...]] = []
    orphan = 0
    nonconforming = 0
    for ordinal, role in enumerate(mesh.facet_roles.tolist()):
        key = tuple(sorted(int(node) for node in mesh.facet_node_ids(ordinal)))
        explicit.setdefault(key, []).append(ordinal)
        owners = adjacency.get(key, [])
        if not owners:
            orphan += 1
            continue
        if role == "exterior":
            exterior.append(key)
            if len(owners) != 1 or (
                outer_boundary_marker is not None
                and int(mesh.boundary_markers[ordinal]) != outer_boundary_marker
            ):
                nonconforming += 1
        elif role == "material_interface":
            interfaces.append(key)
            if (
                len(owners) != 2
                or {int(mesh.element_markers[owner]) for owner in owners} != {0, 1}
                or int(mesh.boundary_markers[ordinal]) != interface_marker
            ):
                nonconforming += 1

    nonmanifold = sum(1 for owners in adjacency.values() if len(owners) > 2)
    same_side_two_owner_faces = _mixed_same_side_two_owner_face_count(
        mesh,
        tolerance=tolerance,
        workspace=resolved_workspace,
        _bound_context=context,
    )
    exterior_frequencies = _mixed_face_frequencies(exterior)
    interface_frequencies = _mixed_face_frequencies(interfaces)
    nonconforming += same_side_two_owner_faces
    nonconforming += sum(
        1
        for key, owners in adjacency.items()
        if len(owners) == 1 and exterior_frequencies[key] != 1
    )
    nonconforming += sum(
        1
        for key, owners in adjacency.items()
        if len(owners) == 2
        and int(mesh.element_markers[owners[0]])
        != int(mesh.element_markers[owners[1]])
        and interface_frequencies[key] != 1
    )
    nonconforming += sum(
        max(0, count - 1) for count in exterior_frequencies.values()
    )
    duplicate_interface_faces = sum(
        max(0, len(explicit.get(key, [])) - 1) for key in interface_frequencies
    )

    interface_nodes = sorted({node for face in interfaces for node in face})
    coordinate_keys: dict[tuple[int, int, int], int] = {}
    duplicate_interface_nodes = 0
    scale = max(float(tolerance), np.finfo(np.float64).eps)
    for node in interface_nodes:
        key = tuple(int(round(float(value) / scale)) for value in mesh.nodes[node])
        if key in coordinate_keys and coordinate_keys[key] != node:
            duplicate_interface_nodes += 1
        else:
            coordinate_keys[key] = node
    return {
        "nonconforming_face_count": int(nonconforming),
        "orphan_face_count": int(orphan),
        "nonmanifold_face_count": int(nonmanifold),
        "coincident_interface_face_count": int(
            duplicate_interface_faces + duplicate_interface_nodes
        ),
    }


def _mixed_same_side_two_owner_face_count(
    mesh: MeshData,
    *,
    tolerance: float,
    workspace: _MixedTopologyWorkspace | None = None,
    _bound_context: _BoundMixedTopologyContext | None = None,
) -> int:
    """Count shared faces whose two owner interiors lie on the same plane side."""
    if workspace is not None:
        context = _require_mixed_topology_workspace(
            mesh,
            workspace,
            _bound_context=_bound_context,
        )
    else:
        context = None
    return len(_mixed_same_side_two_owner_face_details(
        mesh,
        tolerance=tolerance,
        workspace=workspace,
        _bound_context=context,
    ))


def _mixed_same_side_two_owner_face_details(
    mesh: MeshData,
    *,
    tolerance: float,
    workspace: _MixedTopologyWorkspace | None = None,
    _bound_context: _BoundMixedTopologyContext | None = None,
) -> list[tuple[tuple[int, ...], list[int], list[float]]]:
    if workspace is not None:
        _require_mixed_topology_workspace(
            mesh,
            workspace,
            _bound_context=_bound_context,
        )
    adjacency = (
        workspace.face_owners
        if workspace is not None
        else _mixed_face_adjacency(mesh)
    )

    issues: list[tuple[tuple[int, ...], list[int], list[float]]] = []
    for face, owners in adjacency.items():
        if len(owners) != 2:
            continue
        face_coordinates = mesh.nodes[list(face)]
        normal: NDArray[np.float64] | None = None
        for first, second in itertools.combinations(range(1, len(face)), 2):
            candidate = np.cross(
                face_coordinates[first] - face_coordinates[0],
                face_coordinates[second] - face_coordinates[0],
            )
            candidate_norm = float(np.linalg.norm(candidate))
            if candidate_norm > 0.0:
                normal = candidate / candidate_norm
                break
        if normal is None:
            issues.append((face, list(owners), [0.0, 0.0]))
            continue
        face_scale = max(
            float(np.linalg.norm(right - left))
            for left, right in itertools.combinations(face_coordinates, 2)
        )
        side_tolerance = max(
            float(tolerance),
            np.finfo(np.float64).eps * max(face_scale, 1.0e-30) * 64.0,
        )
        distances: list[float] = []
        for owner in owners:
            owner_nodes = (
                workspace.cell_nodes_per_ordinal[owner]
                if workspace is not None
                else mesh.cell_node_ids(owner)
            )
            opposite_nodes = [int(node) for node in owner_nodes if int(node) not in face]
            if not opposite_nodes:
                distances.append(0.0)
                continue
            owner_interior = np.mean(mesh.nodes[opposite_nodes], axis=0)
            distances.append(
                float(np.dot(owner_interior - face_coordinates[0], normal))
            )
        if (
            abs(distances[0]) > side_tolerance
            and abs(distances[1]) > side_tolerance
            and distances[0] * distances[1] > 0.0
        ):
            issues.append((face, list(owners), distances))
    return issues


def _mixed_mesh_conformity_diagnostics(
    mesh: MeshData,
    *,
    tolerance: float,
    interface_marker: int = MIXED_INTERFACE_MARKER,
    outer_boundary_marker: int | None = None,
    limit: int = 8,
) -> list[dict[str, object]]:
    """Return bounded, JSON-compatible evidence for strict conformity failures."""
    if limit < 1:
        return []

    adjacency: dict[tuple[int, ...], list[int]] = {}
    for ordinal, family in enumerate(mesh.cell_types.tolist()):
        cell = mesh.cell_node_ids(ordinal)
        for local_face in _MIXED_CELL_LOCAL_FACETS[str(family)]:
            key = tuple(sorted(int(cell[index]) for index in local_face))
            adjacency.setdefault(key, []).append(ordinal)

    explicit: dict[tuple[int, ...], list[int]] = {}
    for ordinal in range(mesh.n_boundary_faces):
        key = tuple(sorted(int(node) for node in mesh.facet_node_ids(ordinal)))
        explicit.setdefault(key, []).append(ordinal)

    def interface_name(
        face: tuple[int, ...], owners: list[int]
    ) -> str:
        roles = {str(mesh.facet_roles[index]) for index in explicit.get(face, [])}
        if "periodic_seam" in roles:
            return "periodic_boundary"
        owner_families = sorted(str(mesh.cell_types[index]) for index in owners)
        families = set(owner_families)
        if families == {"prism6", "pyramid5"}:
            return "prism6_pyramid5"
        if families == {"pyramid5", "tet4"}:
            return "pyramid5_tet4"
        if len(owners) == 1 or "exterior" in roles:
            return "exterior_boundary"
        return "_".join(owner_families) or "unowned"

    def evidence(
        issue: str,
        face: tuple[int, ...],
        owners: list[int],
        *,
        owner_signed_distances: list[float] | None = None,
    ) -> dict[str, object]:
        owner_rows = []
        for owner in owners:
            mesh_part = (
                str(mesh.cell_mesh_parts[owner])
                if mesh.cell_mesh_parts.shape == (mesh.n_elements,)
                else ""
            )
            owner_rows.append(
                {
                    "cell": int(owner),
                    "global_ordinal": int(mesh.cell_global_ordinals[owner]),
                    "family": str(mesh.cell_types[owner]),
                    "marker": int(mesh.element_markers[owner]),
                    "mesh_part": mesh_part,
                }
            )
        explicit_rows = [
            {
                "facet": int(ordinal),
                "global_ordinal": int(mesh.facet_global_ordinals[ordinal]),
                "family": str(mesh.facet_types[ordinal]),
                "role": str(mesh.facet_roles[ordinal]),
                "marker": int(mesh.boundary_markers[ordinal]),
            }
            for ordinal in explicit.get(face, [])
        ]
        row: dict[str, object] = {
            "issue": issue,
            "interface": interface_name(face, owners),
            "node_ids": [int(node) for node in face],
            "coordinates_m": [
                [float(value) for value in mesh.nodes[node]] for node in face
            ],
            "owners": owner_rows,
            "explicit_facets": explicit_rows,
        }
        if owner_signed_distances is not None:
            row["owner_signed_distances_m"] = [
                float(value) for value in owner_signed_distances
            ]
        return row

    diagnostics: list[dict[str, object]] = []
    for face, owners, distances in _mixed_same_side_two_owner_face_details(
        mesh, tolerance=tolerance
    ):
        diagnostics.append(
            evidence(
                "same_side_two_owner_face",
                face,
                owners,
                owner_signed_distances=distances,
            )
        )
        if len(diagnostics) >= limit:
            return diagnostics

    for face in sorted(adjacency):
        owners = adjacency[face]
        explicit_ordinals = explicit.get(face, [])
        roles = [str(mesh.facet_roles[index]) for index in explicit_ordinals]
        issue: str | None = None
        if len(owners) > 2:
            issue = "nonmanifold_face"
        elif len(owners) == 1 and roles.count("exterior") != 1:
            issue = "missing_or_duplicate_exterior_facet"
        elif (
            len(owners) == 2
            and {int(mesh.element_markers[index]) for index in owners} == {0, 1}
            and roles.count("material_interface") != 1
        ):
            issue = "missing_or_duplicate_material_interface_facet"
        if issue is not None:
            diagnostics.append(evidence(issue, face, owners))
            if len(diagnostics) >= limit:
                return diagnostics

    for face in sorted(explicit):
        owners = adjacency.get(face, [])
        for ordinal in explicit[face]:
            role = str(mesh.facet_roles[ordinal])
            marker = int(mesh.boundary_markers[ordinal])
            issue = None
            if not owners:
                issue = "orphan_explicit_facet"
            elif role == "exterior" and (
                len(owners) != 1
                or (
                    outer_boundary_marker is not None
                    and marker != outer_boundary_marker
                )
            ):
                issue = "invalid_exterior_facet"
            elif role == "material_interface" and (
                len(owners) != 2
                or {int(mesh.element_markers[index]) for index in owners} != {0, 1}
                or marker != interface_marker
            ):
                issue = "invalid_material_interface_facet"
            if issue is not None:
                diagnostics.append(evidence(issue, face, owners))
                if len(diagnostics) >= limit:
                    return diagnostics
    return diagnostics


_MIXED_CELL_TETRA_DECOMPOSITIONS = {
    "tet4": ((0, 1, 2, 3),),
    "prism6": ((0, 1, 2, 3), (1, 2, 3, 4), (2, 3, 4, 5)),
    "pyramid5": ((0, 1, 2, 4), (0, 2, 3, 4)),
    "hex8": (
        (0, 1, 3, 4),
        (1, 2, 3, 6),
        (1, 3, 4, 6),
        (1, 4, 5, 6),
        (3, 4, 6, 7),
    ),
}


def _mixed_cell_signed_and_absolute_volume(
    family: str,
    coordinates: NDArray[np.float64],
) -> tuple[float, float]:
    try:
        decompositions = _MIXED_CELL_TETRA_DECOMPOSITIONS[family]
    except KeyError as error:
        raise ValueError(
            f"mixed shared-domain certificate does not support {family}"
        ) from error
    signed_tetra_volumes = tuple(
        float(np.linalg.det(np.stack(
            [
                coordinates[indices[1]] - coordinates[indices[0]],
                coordinates[indices[2]] - coordinates[indices[0]],
                coordinates[indices[3]] - coordinates[indices[0]],
            ],
            axis=1,
        ))) / 6.0
        for indices in decompositions
    )
    return sum(signed_tetra_volumes), sum(abs(value) for value in signed_tetra_volumes)


def _fingerprint_f64x3_payload(values: object) -> bytes | None:
    """Encode finite ``(N, 3)`` float rows exactly like the per-item f64 writer."""
    if (
        not isinstance(values, np.ndarray)
        or values.ndim != 2
        or values.shape[1] != 3
        or values.dtype.kind != "f"
        or not np.all(np.isfinite(values))
    ):
        return None
    return values.astype("<f8").tobytes()


def _fingerprint_uint_payload(values: object, bits: int) -> bytes | None:
    """Encode an in-range integer vector exactly like the per-item u32/u64 writer."""
    if not isinstance(values, np.ndarray) or values.ndim != 1 or values.dtype.kind not in "iu":
        return None
    if values.size and (int(values.min()) < 0 or int(values.max()) > (1 << bits) - 1):
        return None
    return values.astype(f"<u{bits // 8}").tobytes()


def _fingerprint_enum_payload(values: object, mapping: Mapping[str, int]) -> bytes | None:
    """Encode a string vector of known enum values as u8 tags."""
    if not isinstance(values, np.ndarray) or values.ndim != 1 or values.dtype.kind != "U":
        return None
    tags = np.zeros(values.shape[0], dtype=np.uint8)
    for value, tag in mapping.items():
        tags[values == value] = tag
    if np.any(tags == 0):
        return None
    return tags.tobytes()


def _mixed_reference_derivative_samples(family: str) -> NDArray[np.float64]:
    """Return the fixed order-2 reference derivatives for one cell family."""
    q = 1.0 / math.sqrt(3.0)
    if family == "tet4":
        return np.asarray(
            [[[-1.0, -1.0, -1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]],
            dtype=np.float64,
        )
    if family == "prism6":
        triangle_points = (
            (1.0 / 6.0, 1.0 / 6.0),
            (2.0 / 3.0, 1.0 / 6.0),
            (1.0 / 6.0, 2.0 / 3.0),
        )
        return np.asarray(
            [
                [
                    [-(1 - t) / 2, -(1 - t) / 2, -(1 - r - s) / 2],
                    [(1 - t) / 2, 0.0, -r / 2],
                    [0.0, (1 - t) / 2, -s / 2],
                    [-(1 + t) / 2, -(1 + t) / 2, (1 - r - s) / 2],
                    [(1 + t) / 2, 0.0, r / 2],
                    [0.0, (1 + t) / 2, s / 2],
                ]
                for t in (-q, q)
                for r, s in triangle_points
            ],
            dtype=np.float64,
        )
    if family == "pyramid5":
        qt = math.sqrt(10.0) / 15.0
        return np.asarray(
            [
                [
                    [-(1 - s) * (1 - t) / 4, -(1 - r) * (1 - t) / 4, -(1 - r) * (1 - s) / 4],
                    [(1 - s) * (1 - t) / 4, -(1 + r) * (1 - t) / 4, -(1 + r) * (1 - s) / 4],
                    [(1 + s) * (1 - t) / 4, (1 + r) * (1 - t) / 4, -(1 + r) * (1 + s) / 4],
                    [-(1 + s) * (1 - t) / 4, (1 - r) * (1 - t) / 4, -(1 - r) * (1 + s) / 4],
                    [0.0, 0.0, 1.0],
                ]
                for t in (1.0 / 3.0 - qt, 1.0 / 3.0 + qt)
                for r in (-q, q)
                for s in (-q, q)
            ],
            dtype=np.float64,
        )
    if family == "hex8":
        signs = np.asarray(
            [
                [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
                [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
            ],
            dtype=np.float64,
        )
        return np.asarray(
            [
                np.column_stack(
                    (
                        signs[:, 0] * (1 + signs[:, 1] * s) * (1 + signs[:, 2] * t) / 8,
                        signs[:, 1] * (1 + signs[:, 0] * r) * (1 + signs[:, 2] * t) / 8,
                        signs[:, 2] * (1 + signs[:, 0] * r) * (1 + signs[:, 1] * s) / 8,
                    )
                )
                for r in (-q, q)
                for s in (-q, q)
                for t in (-q, q)
            ],
            dtype=np.float64,
        )
    raise ValueError(f"mixed quality metric does not support {family}")


def _mixed_cell_scaled_jacobians(
    family: str, coordinates: NDArray[np.float64]
) -> NDArray[np.float64]:
    """Evaluate the normalized mapped Jacobian in the native topology."""
    values: list[float] = []
    for derivatives in _mixed_reference_derivative_samples(family):
        matrix = coordinates.T @ derivatives
        denominator = float(np.prod(np.linalg.norm(matrix, axis=0)))
        values.append(abs(float(np.linalg.det(matrix))) / denominator if denominator else 0.0)
    return np.asarray(values, dtype=np.float64)


def _mixed_cell_scaled_jacobians_batch(
    family: str, coordinates: NDArray[np.float64]
) -> NDArray[np.float64]:
    """Evaluate ``_mixed_cell_scaled_jacobians`` for ``(M, k, 3)`` cells.

    Every per-cell operation keeps the scalar operand layout and reduction
    order, so row ``m`` is bit-identical to the scalar result for cell ``m``.
    """
    transposed = coordinates.transpose(0, 2, 1)
    samples = _mixed_reference_derivative_samples(family)
    values = np.empty((coordinates.shape[0], samples.shape[0]), dtype=np.float64)
    for sample, derivatives in enumerate(samples):
        matrix = np.matmul(transposed, derivatives)
        denominator = np.prod(np.linalg.norm(matrix, axis=1), axis=1)
        determinant = np.abs(np.linalg.det(matrix))
        with np.errstate(divide="ignore", invalid="ignore"):
            values[:, sample] = np.where(denominator != 0.0, determinant / denominator, 0.0)
    return values


def _mixed_face_adjacency(
    mesh: MeshData,
    *,
    canonical_faces_per_cell: tuple[tuple[tuple[int, ...], ...], ...] | None = None,
) -> dict[tuple[int, ...], list[int]]:
    adjacency: dict[tuple[int, ...], list[int]] = {}
    if canonical_faces_per_cell is None:
        canonical_faces_per_cell = tuple(
            tuple(
                tuple(sorted(int(cell[index]) for index in local_face))
                for local_face in _MIXED_CELL_LOCAL_FACETS[str(family)]
            )
            for ordinal, family in enumerate(mesh.cell_types.tolist())
            for cell in (mesh.cell_node_ids(ordinal),)
        )
    for ordinal, faces in enumerate(canonical_faces_per_cell):
        for key in faces:
            adjacency.setdefault(key, []).append(ordinal)
    return adjacency


def _validate_mixed_pyramid_bases(
    mesh: MeshData,
    *,
    interface_marker: int,
    workspace: _MixedTopologyWorkspace | None = None,
    _bound_context: _BoundMixedTopologyContext | None = None,
) -> None:
    if workspace is not None:
        _require_mixed_topology_workspace(
            mesh,
            workspace,
            interface_marker=interface_marker,
            _bound_context=_bound_context,
        )
        classification = workspace.pyramid_base_classification
        if not classification or not all(classification.values()):
            raise ValueError(
                "mixed layer topology certificate pyramid bases must be exact quad4 "
                f"material-interface facets with marker {interface_marker}"
            )
        return
    interface_quads = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(ordinal)))
        for ordinal, (family, role, marker) in enumerate(zip(
            mesh.facet_types.tolist(),
            mesh.facet_roles.tolist(),
            mesh.boundary_markers.tolist(),
            strict=True,
        ))
        if family == "quad4"
        and role == "material_interface"
        and int(marker) == interface_marker
    }
    pyramid_bases = {
        tuple(sorted(int(mesh.cell_node_ids(ordinal)[index]) for index in (0, 1, 2, 3)))
        for ordinal, family in enumerate(mesh.cell_types.tolist())
        if family == "pyramid5"
    }
    if not pyramid_bases or not pyramid_bases.issubset(interface_quads):
        raise ValueError(
            "mixed layer topology certificate pyramid bases must be exact quad4 "
            f"material-interface facets with marker {interface_marker}"
        )


def _bounds_relative_error(
    realized_min: NDArray[np.float64],
    realized_max: NDArray[np.float64],
    authored_min: tuple[float, float, float],
    authored_max: tuple[float, float, float],
) -> float:
    expected_min = np.asarray(authored_min, dtype=np.float64)
    expected_max = np.asarray(authored_max, dtype=np.float64)
    scale = float(np.max(expected_max - expected_min))
    return float(max(
        np.max(np.abs(realized_min - expected_min)),
        np.max(np.abs(realized_max - expected_max)),
    ) / scale)


def _recompute_mixed_certificate_evidence(
    mesh: MeshData,
    *,
    sweep_axis: int,
    interface_marker: int,
    outer_boundary_marker: int,
    magnetic_bounds_min_m: tuple[float, float, float],
    magnetic_bounds_max_m: tuple[float, float, float],
    airbox_bounds_min_m: tuple[float, float, float],
    airbox_bounds_max_m: tuple[float, float, float],
    workspace: _MixedTopologyWorkspace | None = None,
    _bound_context: _BoundMixedTopologyContext | None = None,
) -> dict[str, object]:
    if mesh.cell_mesh_parts.shape != (mesh.n_elements,):
        raise ValueError("mixed layer topology certificate requires per-cell mesh parts")
    allowed = {
        "magnetic": ({"prism6"}, 1),
        "transition_air": ({"pyramid5", "tet4"}, 0),
        "far_air": ({"tet4"}, 0),
    }
    for ordinal, (family, marker, part) in enumerate(zip(
        mesh.cell_types.tolist(), mesh.element_markers.tolist(), mesh.cell_mesh_parts.tolist(), strict=True
    )):
        families, expected_marker = allowed[part]
        if family not in families or int(marker) != expected_marker:
            raise ValueError(
                f"mixed layer topology certificate cell {ordinal} has invalid mesh part/family/marker"
            )
    part_counts = _cell_counts_by_part(mesh)
    if set(part_counts) != set(allowed) or not all(part_counts[part] for part in allowed):
        raise ValueError("mixed layer topology certificate mesh parts are incomplete")

    workspace_was_built = workspace is None
    resolved_workspace = workspace or _build_mixed_topology_workspace(
        mesh,
        sweep_axis=sweep_axis,
        interface_marker=interface_marker,
    )
    context = _require_mixed_topology_workspace(
        mesh,
        resolved_workspace,
        sweep_axis=sweep_axis,
        interface_marker=interface_marker,
        _bound_context=_bound_context,
        _actual_topology_fingerprint_v3=(
            resolved_workspace.topology_fingerprint_v3
            if workspace_was_built
            else None
        ),
    )
    volumes = resolved_workspace.cell_absolute_volumes
    jacobians: dict[str, list[float]] = {}
    scaled: dict[str, list[float]] = {}
    for ordinal, family in enumerate(mesh.cell_types.tolist()):
        coordinates = mesh.nodes[resolved_workspace.cell_nodes_per_ordinal[ordinal]]
        jacobians.setdefault(family, []).extend(
            _cell_jacobian_determinants(family, coordinates).tolist()
        )
        scaled.setdefault(family, []).extend(
            _mixed_cell_scaled_jacobians(family, coordinates).tolist()
        )
    jacobian_minima = {key: float(np.min(value)) for key, value in sorted(jacobians.items())}
    scaled_minima = {key: float(np.min(value)) for key, value in sorted(scaled.items())}
    scaled_p05 = {key: float(np.percentile(value, 5.0)) for key, value in sorted(scaled.items())}

    magnetic = mesh.cell_mesh_parts == "magnetic"
    transition = mesh.cell_mesh_parts == "transition_air"
    magnetic_nodes = np.unique(np.concatenate([
        resolved_workspace.cell_nodes_per_ordinal[int(index)]
        for index in np.flatnonzero(magnetic)
    ]))
    transition_nodes = np.unique(np.concatenate([
        resolved_workspace.cell_nodes_per_ordinal[int(index)]
        for index in np.flatnonzero(transition)
    ]))
    magnetic_bounds = (np.min(mesh.nodes[magnetic_nodes], axis=0), np.max(mesh.nodes[magnetic_nodes], axis=0))
    transition_bounds = (np.min(mesh.nodes[transition_nodes], axis=0), np.max(mesh.nodes[transition_nodes], axis=0))
    outer_bounds = (np.min(mesh.nodes, axis=0), np.max(mesh.nodes, axis=0))
    magnetic_bounds_error = _bounds_relative_error(
        magnetic_bounds[0], magnetic_bounds[1], magnetic_bounds_min_m, magnetic_bounds_max_m
    )
    airbox_bounds_error = _bounds_relative_error(
        outer_bounds[0], outer_bounds[1], airbox_bounds_min_m, airbox_bounds_max_m
    )
    if magnetic_bounds_error > 1.0e-8 or airbox_bounds_error > 1.0e-8:
        raise ValueError(
            "mixed layer topology certificate realized bounds do not match authored CAD bounds"
        )
    shell_offsets = np.concatenate([
        magnetic_bounds[0] - transition_bounds[0],
        transition_bounds[1] - magnetic_bounds[1],
    ])
    shell_thickness = float(np.mean(shell_offsets))
    if np.any(shell_offsets <= 0.0) or not np.allclose(
        shell_offsets, shell_thickness, rtol=1.0e-10, atol=1.0e-15
    ):
        raise ValueError("mixed layer topology certificate transition shell thickness is not uniform")

    adjacency = resolved_workspace.face_owners
    shell_faces = [
        key for key, owners in adjacency.items()
        if len(owners) == 2
        and {mesh.cell_mesh_parts[index] for index in owners} == {"transition_air", "far_air"}
    ]
    if not shell_faces or any(len(face) != 3 for face in shell_faces):
        raise ValueError("mixed layer topology certificate transition shell interface is not tri3")
    planes = resolved_workspace.magnetic_layer_coordinates
    plane_tolerance = resolved_workspace.magnetic_layer_tolerance
    magnetic_volume = float(np.sum(volumes[magnetic]))
    shared_volume = float(np.sum(volumes))
    expected_magnetic = float(np.prod(
        np.asarray(magnetic_bounds_max_m) - np.asarray(magnetic_bounds_min_m)
    ))
    expected_shared = float(np.prod(
        np.asarray(airbox_bounds_max_m) - np.asarray(airbox_bounds_min_m)
    ))
    conformity = _mixed_mesh_conformity_counts(
        mesh,
        tolerance=plane_tolerance,
        interface_marker=interface_marker,
        outer_boundary_marker=outer_boundary_marker,
        workspace=resolved_workspace,
        _bound_context=context,
    )
    return {
        "magnetic_plane_coordinates_m": planes,
        "plane_tolerance_m": plane_tolerance,
        "transition_shell_thickness_m": shell_thickness,
        "transition_shell_interface_tri3_count": len(shell_faces),
        "cell_family_counts_by_marker": _cell_counts_by_marker(mesh),
        "cell_family_counts_by_part": part_counts,
        "facet_family_counts_by_role_marker": _facet_counts_by_role_marker(mesh),
        "jacobian_minima_m3_by_family": jacobian_minima,
        "scaled_jacobian_minima_by_family": scaled_minima,
        "scaled_jacobian_p05_by_family": scaled_p05,
        "magnetic_volume_m3": magnetic_volume,
        "expected_magnetic_volume_m3": expected_magnetic,
        "magnetic_relative_volume_error": abs(magnetic_volume - expected_magnetic) / expected_magnetic,
        "magnetic_bounds_relative_error": magnetic_bounds_error,
        "air_volume_m3": shared_volume - magnetic_volume,
        "shared_domain_volume_m3": shared_volume,
        "expected_shared_domain_volume_m3": expected_shared,
        "shared_domain_relative_volume_error": abs(shared_volume - expected_shared) / expected_shared,
        "airbox_bounds_relative_error": airbox_bounds_error,
        "marker_coverage_complete": True,
        **conformity,
    }


def _recompute_and_bind_mixed_certificate_evidence(
    mesh: MeshData,
    *,
    sweep_axis: int,
    interface_marker: int,
    outer_boundary_marker: int,
    magnetic_bounds_min_m: tuple[float, float, float],
    magnetic_bounds_max_m: tuple[float, float, float],
    airbox_bounds_min_m: tuple[float, float, float],
    airbox_bounds_max_m: tuple[float, float, float],
    workspace: _MixedTopologyWorkspace | None = None,
    _bound_context: _BoundMixedTopologyContext | None = None,
) -> _CanonicalMixedCertificateEvidence:
    if workspace is None:
        workspace = _build_mixed_topology_workspace(
            mesh,
            sweep_axis=sweep_axis,
            interface_marker=interface_marker,
        )
        context = _require_mixed_topology_workspace(
            mesh,
            workspace,
            sweep_axis=sweep_axis,
            interface_marker=interface_marker,
            _actual_topology_fingerprint_v3=workspace.topology_fingerprint_v3,
        )
    else:
        context = _require_mixed_topology_workspace(
            mesh,
            workspace,
            sweep_axis=sweep_axis,
            interface_marker=interface_marker,
            _bound_context=_bound_context,
        )
    evidence = _recompute_mixed_certificate_evidence(
        mesh,
        sweep_axis=sweep_axis,
        interface_marker=interface_marker,
        outer_boundary_marker=outer_boundary_marker,
        magnetic_bounds_min_m=magnetic_bounds_min_m,
        magnetic_bounds_max_m=magnetic_bounds_max_m,
        airbox_bounds_min_m=airbox_bounds_min_m,
        airbox_bounds_max_m=airbox_bounds_max_m,
        workspace=workspace,
        _bound_context=context,
    )
    immutable_evidence = _immutable_mixed_certificate_evidence(evidence)
    if not isinstance(immutable_evidence, Mapping):
        raise TypeError("mixed certificate evidence must be a mapping")
    carrier = _CanonicalMixedCertificateEvidence(
        evidence=immutable_evidence,
        context=context,
        _capability=_CANONICAL_MIXED_EVIDENCE_CAPABILITY,
    )
    _MINTED_CANONICAL_MIXED_EVIDENCE.add(carrier)
    return carrier


def _bind_mixed_certificate_evidence(
    mesh: MeshData,
    evidence: Mapping[str, object],
    *,
    workspace: _MixedTopologyWorkspace,
    _bound_context: _BoundMixedTopologyContext,
) -> _CanonicalMixedCertificateEvidence:
    """Bind evidence produced by an independently validated native engine."""
    context = _require_mixed_topology_workspace(
        mesh,
        workspace,
        sweep_axis=workspace.sweep_axis,
        interface_marker=workspace.interface_marker,
        _bound_context=_bound_context,
    )
    immutable_evidence = _immutable_mixed_certificate_evidence(evidence)
    if not isinstance(immutable_evidence, Mapping):
        raise TypeError("mixed certificate evidence must be a mapping")
    carrier = _CanonicalMixedCertificateEvidence(
        evidence=immutable_evidence,
        context=context,
        _capability=_CANONICAL_MIXED_EVIDENCE_CAPABILITY,
    )
    _MINTED_CANONICAL_MIXED_EVIDENCE.add(carrier)
    return carrier


def _rebuild_mixed_layer_topology_certificate(
    mesh: MeshData,
    template: MixedLayerTopologyCertificate,
    *,
    authored_scale: float = 1.0,
) -> MeshData:
    def scaled(values: tuple[float, float, float]) -> tuple[float, float, float]:
        return tuple(float(value * authored_scale) for value in values)  # type: ignore[return-value]

    magnetic_bounds_min_m = scaled(template.magnetic_bounds_min_m)
    magnetic_bounds_max_m = scaled(template.magnetic_bounds_max_m)
    airbox_bounds_min_m = scaled(template.airbox_bounds_min_m)
    airbox_bounds_max_m = scaled(template.airbox_bounds_max_m)
    evidence = _recompute_mixed_certificate_evidence(
        mesh,
        sweep_axis={"x": 0, "y": 1, "z": 2}[template.resolved_sweep_direction],
        interface_marker=template.interface_marker,
        outer_boundary_marker=template.outer_boundary_marker,
        magnetic_bounds_min_m=magnetic_bounds_min_m,
        magnetic_bounds_max_m=magnetic_bounds_max_m,
        airbox_bounds_min_m=airbox_bounds_min_m,
        airbox_bounds_max_m=airbox_bounds_max_m,
    )
    certificate = replace(
        template,
        realized_layer_count=len(evidence["magnetic_plane_coordinates_m"]) - 1,
        topology_fingerprint_version="v3",
        topology_fingerprint=mesh.topology_fingerprint_v3(),
        magnetic_bounds_min_m=magnetic_bounds_min_m,
        magnetic_bounds_max_m=magnetic_bounds_max_m,
        airbox_bounds_min_m=airbox_bounds_min_m,
        airbox_bounds_max_m=airbox_bounds_max_m,
        **evidence,
    )
    return replace(mesh, mixed_layer_topology_certificate=certificate)


def _rebuild_mixed_layer_topology_certificate_v2(
    mesh: MeshData,
    template: MixedLayerTopologyCertificateV2,
    *,
    authored_scale: float = 1.0,
) -> MeshData:
    """Rebind a v2 certificate after a qualified isotropic coordinate scale.

    Imported meshes may be authored in a source unit and converted to SI after
    extraction.  The topology and body node ownership remain identical under
    an isotropic scale, but every metric carrying a length or volume and the
    topology fingerprint/material-field digests must be rebound.  Keep this
    operation explicit so a v2 certificate is never accidentally sent through
    the single-body v1 rebuild path.
    """
    scale = float(authored_scale)
    if not math.isfinite(scale) or scale <= 0.0:
        raise ValueError("mixed v2 certificate scale must be finite and positive")
    volume_scale = scale**3

    def scale_vector(values: tuple[float, float, float]) -> tuple[float, float, float]:
        return tuple(float(value * scale) for value in values)  # type: ignore[return-value]

    topology_fingerprint_version = template.topology_fingerprint_version
    topology_fingerprint = (
        mesh.topology_fingerprint_v2()
        if topology_fingerprint_version == "v2"
        else mesh.topology_fingerprint_v3()
    )
    regions: list[MagneticRegionV2] = []
    for region in template.magnetic_regions:
        sweep = region.exact_sweep
        if sweep is not None:
            sweep = replace(
                sweep,
                magnetic_plane_coordinates_m=tuple(
                    float(value * scale)
                    for value in sweep.magnetic_plane_coordinates_m
                ),
                plane_tolerance_m=float(sweep.plane_tolerance_m * scale),
                topology_fingerprint_version=topology_fingerprint_version,
                topology_fingerprint=topology_fingerprint,
            )
        regions.append(replace(region, exact_sweep=sweep))

    pairs = tuple(
        replace(pair, min_gap_m=float(pair.min_gap_m * scale))
        for pair in template.body_separation_pairs
    )
    material_fields: list[BodyMaterialFieldV2] = []
    region_by_object_id = {
        region.object_id: region for region in template.magnetic_regions
    }
    for field in template.body_material_fields:
        region = region_by_object_id[field.object_id]
        material_fields.append(
            replace(
                field,
                field_digest=_body_material_field_digest(
                    field,
                    topology_fingerprint_version=topology_fingerprint_version,
                    topology_fingerprint=topology_fingerprint,
                    body_marker=region.body_marker,
                    material_marker=region.material_marker,
                ),
            )
        )

    certificate = replace(
        template,
        magnetic_regions=tuple(regions),
        body_separation_pairs=pairs,
        body_material_fields=tuple(material_fields),
        magnetic_plane_coordinates_m=tuple(
            float(value * scale) for value in template.magnetic_plane_coordinates_m
        ),
        plane_tolerance_m=float(template.plane_tolerance_m * scale),
        transition_shell_thickness_m=float(template.transition_shell_thickness_m * scale),
        magnetic_bounds_min_m=scale_vector(template.magnetic_bounds_min_m),
        magnetic_bounds_max_m=scale_vector(template.magnetic_bounds_max_m),
        airbox_bounds_min_m=scale_vector(template.airbox_bounds_min_m),
        airbox_bounds_max_m=scale_vector(template.airbox_bounds_max_m),
        jacobian_minima_m3_by_family={
            family: float(value * volume_scale)
            for family, value in template.jacobian_minima_m3_by_family.items()
        },
        magnetic_volume_m3=float(template.magnetic_volume_m3 * volume_scale),
        expected_magnetic_volume_m3=float(
            template.expected_magnetic_volume_m3 * volume_scale
        ),
        air_volume_m3=float(template.air_volume_m3 * volume_scale),
        shared_domain_volume_m3=float(template.shared_domain_volume_m3 * volume_scale),
        expected_shared_domain_volume_m3=float(
            template.expected_shared_domain_volume_m3 * volume_scale
        ),
        topology_fingerprint_version=topology_fingerprint_version,
        topology_fingerprint=topology_fingerprint,
    )
    return replace(mesh, mixed_layer_topology_certificate=certificate)


def _validate_typed_csr(
    *,
    types: NDArray[np.str_],
    offsets: NDArray[np.int64],
    nodes: NDArray[np.int32],
    arities: dict[str, int],
    kind: str,
    node_count: int,
) -> None:
    if types.ndim != 1:
        raise ValueError(f"{kind}_types must be one-dimensional")
    if offsets.ndim != 1 or len(offsets) != len(types) + 1:
        raise ValueError(f"{kind}_offsets length must equal {kind} count plus one")
    if nodes.ndim != 1:
        raise ValueError(f"{kind}_nodes must be one-dimensional")
    if not len(offsets) or int(offsets[0]) != 0:
        raise ValueError(f"{kind}_offsets must start at zero")
    if np.any(np.diff(offsets) < 0):
        raise ValueError(f"{kind}_offsets must be monotone")
    if int(offsets[-1]) != len(nodes):
        raise ValueError(f"{kind}_offsets final value must match {kind}_nodes length")

    # This validation runs for every MeshData construction, including the
    # 800k-cell SP4 artifact load path.  Keep the same fail-closed checks and
    # diagnostics, but operate on contiguous NumPy blocks instead of a Python
    # loop over every cell/facet.
    expected_arities = np.zeros(types.shape, dtype=np.int64)
    recognized = np.zeros(types.shape, dtype=np.bool_)
    for item_type, arity in arities.items():
        selected = types == item_type
        expected_arities[selected] = int(arity)
        recognized |= selected
    unknown = np.flatnonzero(~recognized)
    if unknown.size:
        index = int(unknown[0])
        raise ValueError(f"unknown {kind} type: {types[index]}")

    lengths = np.diff(offsets)
    wrong_arity = np.flatnonzero(lengths != expected_arities)
    if wrong_arity.size:
        index = int(wrong_arity[0])
        raise ValueError(
            f"{kind} {index} type {types[index]} has wrong arity "
            f"{int(lengths[index])}; expected {int(expected_arities[index])}"
        )

    invalid_nodes = np.flatnonzero((nodes < 0) | (nodes >= node_count))
    if invalid_nodes.size:
        index = int(np.searchsorted(offsets[1:], int(invalid_nodes[0]), side="right"))
        raise ValueError(f"{kind} {index} contains invalid node index")

    for arity in np.unique(expected_arities):
        item_indices = np.flatnonzero(expected_arities == arity)
        if not item_indices.size:
            continue
        width = int(arity)
        starts = offsets[item_indices]
        block = nodes[starts[:, np.newaxis] + np.arange(width, dtype=np.int64)]
        sorted_block = np.sort(block, axis=1)
        duplicate_rows = np.flatnonzero(np.any(np.diff(sorted_block, axis=1) == 0, axis=1))
        if duplicate_rows.size:
            index = int(item_indices[int(duplicate_rows[0])])
            raise ValueError(f"{kind} {index} contains duplicate node indices")


def _validate_global_ordinals(
    ordinals: NDArray[np.int64],
    item_count: int,
    kind: str,
) -> None:
    if ordinals.shape != (item_count,):
        raise ValueError(f"{kind}_global_ordinals must have shape ({kind} count,)")
    if np.any(ordinals < 0):
        raise ValueError(f"{kind}_global_ordinals must be non-negative")
    if np.unique(ordinals).size != item_count:
        raise ValueError(f"{kind}_global_ordinals must be unique")


def _count_exact_layer_planes(
    nodes: NDArray[np.float64] | object,
    axis: int,
) -> int:
    """Count coordinate planes using the canonical exact-layer tolerance."""
    coordinates = np.asarray(nodes, dtype=np.float64)
    if coordinates.ndim != 2 or coordinates.shape[1] != 3 or len(coordinates) == 0:
        raise ValueError("exact-layer plane count requires non-empty nodes with shape (N, 3)")
    if axis not in (0, 1, 2):
        raise ValueError("exact-layer plane count axis must be 0, 1, or 2")
    values = sorted(float(value) for value in coordinates[:, axis])
    thickness = values[-1] - values[0]
    tolerance = max(
        FEM_EXACT_LAYER_PLANE_ABS_TOLERANCE_M,
        FEM_EXACT_LAYER_PLANE_REL_TOLERANCE * thickness,
    )
    planes: list[float] = []
    for value in values:
        if not planes or abs(value - planes[-1]) > tolerance:
            planes.append(value)
    return len(planes)


def _cell_jacobian_determinants(
    cell_type: str,
    coordinates: NDArray[np.float64],
) -> NDArray[np.float64]:
    q = 1.0 / math.sqrt(3.0)
    if cell_type == "tet4":
        matrix = np.stack(
            [coordinates[1] - coordinates[0], coordinates[2] - coordinates[0], coordinates[3] - coordinates[0]],
            axis=1,
        )
        return np.asarray([np.linalg.det(matrix)], dtype=np.float64)
    if cell_type == "prism6":
        triangle_points = ((1.0 / 6.0, 1.0 / 6.0), (2.0 / 3.0, 1.0 / 6.0), (1.0 / 6.0, 2.0 / 3.0))
        points = tuple((r, s, t) for t in (-q, q) for r, s in triangle_points)
        rows: list[float] = []
        for r, s, t in points:
            derivatives = np.asarray(
                [
                    [-(1 - t) / 2, -(1 - t) / 2, -(1 - r - s) / 2],
                    [(1 - t) / 2, 0.0, -r / 2],
                    [0.0, (1 - t) / 2, -s / 2],
                    [-(1 + t) / 2, -(1 + t) / 2, (1 - r - s) / 2],
                    [(1 + t) / 2, 0.0, r / 2],
                    [0.0, (1 + t) / 2, s / 2],
                ]
            )
            rows.append(float(np.linalg.det(coordinates.T @ derivatives)))
        return np.asarray(rows)
    if cell_type == "pyramid5":
        rows = []
        qt = math.sqrt(10.0) / 15.0
        for t in (1.0 / 3.0 - qt, 1.0 / 3.0 + qt):
            for r in (-q, q):
                for s in (-q, q):
                    derivatives = np.asarray(
                [
                    [-(1 - s) * (1 - t) / 4, -(1 - r) * (1 - t) / 4, -(1 - r) * (1 - s) / 4],
                    [(1 - s) * (1 - t) / 4, -(1 + r) * (1 - t) / 4, -(1 + r) * (1 - s) / 4],
                    [(1 + s) * (1 - t) / 4, (1 + r) * (1 - t) / 4, -(1 + r) * (1 + s) / 4],
                    [-(1 + s) * (1 - t) / 4, (1 - r) * (1 - t) / 4, -(1 - r) * (1 + s) / 4],
                    [0.0, 0.0, 1.0],
                ]
            )
                    rows.append(float(np.linalg.det(coordinates.T @ derivatives)))
        return np.asarray(rows)
    if cell_type == "hex8":
        signs = np.asarray(
            [
                [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
                [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
            ],
            dtype=np.float64,
        )
        rows = []
        for r in (-q, q):
            for s in (-q, q):
                for t in (-q, q):
                    derivatives = np.empty((8, 3), dtype=np.float64)
                    derivatives[:, 0] = signs[:, 0] * (1 + signs[:, 1] * s) * (1 + signs[:, 2] * t) / 8
                    derivatives[:, 1] = signs[:, 1] * (1 + signs[:, 0] * r) * (1 + signs[:, 2] * t) / 8
                    derivatives[:, 2] = signs[:, 2] * (1 + signs[:, 0] * r) * (1 + signs[:, 1] * s) / 8
                    rows.append(float(np.linalg.det(coordinates.T @ derivatives)))
        return np.asarray(rows)
    raise ValueError(f"unknown cell type: {cell_type}")


_CELL_JACOBIAN_BATCH_SIZE = 1 << 17


def _cell_jacobian_determinants_batch(
    cell_type: str,
    coordinates: NDArray[np.float64],
) -> NDArray[np.float64]:
    """Evaluate ``_cell_jacobian_determinants`` for ``(M, k, 3)`` cells.

    Row ``m`` is bit-identical to the scalar result for cell ``m``: the batch
    uses the same reference derivatives, the same per-cell matrix layout and
    the same LAPACK determinant.  ``hex8`` keeps the scalar evaluation.
    """
    count = coordinates.shape[0]
    if cell_type == "tet4":
        matrix = np.stack(
            [coordinates[:, 1] - coordinates[:, 0], coordinates[:, 2] - coordinates[:, 0], coordinates[:, 3] - coordinates[:, 0]],
            axis=2,
        )
        return np.linalg.det(matrix).reshape(count, 1)
    if cell_type in ("prism6", "pyramid5"):
        transposed = coordinates.transpose(0, 2, 1)
        samples = _mixed_reference_derivative_samples(cell_type)
        result = np.empty((count, samples.shape[0]), dtype=np.float64)
        for sample, derivatives in enumerate(samples):
            result[:, sample] = np.linalg.det(np.matmul(transposed, derivatives))
        return result
    if cell_type == "hex8":
        if count == 0:
            return np.empty((0, 8), dtype=np.float64)
        return np.stack([_cell_jacobian_determinants(cell_type, cell) for cell in coordinates])
    raise ValueError(f"unknown cell type: {cell_type}")


def _iter_cell_family_batches(
    mesh: "MeshData",
) -> Iterator[tuple[str, NDArray[np.int64], NDArray[np.float64]]]:
    """Yield ``(family, cell ordinals, (M, k, 3) coordinates)`` blocks.

    Blocks follow cell-ordinal order within each family and are bounded so
    that a production mesh does not materialize every Jacobian at once.
    """
    families = np.asarray(mesh.cell_types)
    for family in dict.fromkeys(families.tolist()):
        arity = FEM_CELL_ARITIES[str(family)]
        ordinals = np.flatnonzero(families == family).astype(np.int64)
        for start in range(0, ordinals.size, _CELL_JACOBIAN_BATCH_SIZE):
            block = ordinals[start : start + _CELL_JACOBIAN_BATCH_SIZE]
            node_index = mesh.cell_offsets[block][:, np.newaxis] + np.arange(arity, dtype=np.int64)
            yield str(family), block, mesh.nodes[mesh.cell_nodes[node_index]]


def _tetra_signed_volumes(mesh: MeshData) -> NDArray[np.float64]:
    if mesh.elements.size == 0:
        return np.zeros(0, dtype=np.float64)
    p0 = mesh.nodes[mesh.elements[:, 0]]
    p1 = mesh.nodes[mesh.elements[:, 1]]
    p2 = mesh.nodes[mesh.elements[:, 2]]
    p3 = mesh.nodes[mesh.elements[:, 3]]
    return np.linalg.det(np.stack([p1 - p0, p2 - p0, p3 - p0], axis=2)) / 6.0


def _mesh_cell_connectivity(
    mesh: MeshData,
    cell_indices: NDArray[np.int64],
    family: str,
) -> NDArray[np.int32]:
    arity = FEM_CELL_ARITIES[family]
    starts = mesh.cell_offsets[cell_indices]
    return mesh.cell_nodes[starts[:, np.newaxis] + np.arange(arity, dtype=np.int64)]


def _cell_volume_pieces(
    family: str,
    coordinates: NDArray[np.float64],
) -> NDArray[np.float64]:
    pieces: list[NDArray[np.float64]] = []
    for local_tet in _MIXED_CELL_TETRA_DECOMPOSITIONS[family]:
        tetra = coordinates[:, local_tet, :]
        first = tetra[:, 1] - tetra[:, 0]
        second = tetra[:, 2] - tetra[:, 0]
        third = tetra[:, 3] - tetra[:, 0]
        pieces.append(
            np.einsum("ni,ni->n", first, np.cross(second, third)) / 6.0
        )
    return np.stack(pieces, axis=1)


def _mesh_cell_geometry(
    mesh: MeshData,
) -> tuple[
    NDArray[np.float64],
    NDArray[np.float64],
    NDArray[np.bool_],
    NDArray[np.bool_],
]:
    """Compute signed/physical cell volumes and sampled validity by family.

    Volumes use the same canonical tetrahedral decomposition as the mixed
    topology certificate. Orientation and exact-zero diagnostics use the
    topology-specific Jacobian samples already defined by the mesh contract.
    Work is vectorized by family and chunked to bound temporary memory.
    """
    signed = np.zeros(mesh.n_elements, dtype=np.float64)
    absolute = np.zeros(mesh.n_elements, dtype=np.float64)
    inverted = np.zeros(mesh.n_elements, dtype=np.bool_)
    degenerate = np.zeros(mesh.n_elements, dtype=np.bool_)
    for family in sorted(set(str(value) for value in mesh.cell_types.tolist())):
        ordinals = np.flatnonzero(mesh.cell_types == family).astype(np.int64)
        derivative_samples = (
            None
            if family == "tet4"
            else _mixed_reference_derivative_samples(family)
        )
        for chunk_start in range(0, len(ordinals), 16_384):
            chunk_stop = min(chunk_start + 16_384, len(ordinals))
            local_ordinals = ordinals[chunk_start:chunk_stop]
            connectivity = _mesh_cell_connectivity(
                mesh, local_ordinals, family
            )
            coordinates = mesh.nodes[connectivity]
            pieces = _cell_volume_pieces(family, coordinates)
            signed[local_ordinals] = np.sum(pieces, axis=1)
            absolute[local_ordinals] = np.sum(np.abs(pieces), axis=1)
            if derivative_samples is None:
                determinants = pieces[:, 0]
                inverted[local_ordinals] = determinants <= 0.0
                degenerate[local_ordinals] = determinants == 0.0
            else:
                jacobians = np.einsum(
                    "nai,qaj->nqij", coordinates, derivative_samples, optimize=True
                )
                determinants = np.linalg.det(jacobians)
                inverted[local_ordinals] = np.any(determinants <= 0.0, axis=1)
                degenerate[local_ordinals] = np.any(determinants == 0.0, axis=1)
    return signed, absolute, inverted, degenerate


_TET_FACE_NODE_INDICES = ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3))


def _face_key(face: NDArray[np.integer] | list[int] | tuple[int, int, int]) -> tuple[int, int, int]:
    return tuple(sorted(int(node) for node in face))  # type: ignore[return-value]


def _tetra_face_marker_sets(mesh: MeshData) -> dict[tuple[int, int, int], set[int]]:
    face_markers: dict[tuple[int, int, int], set[int]] = {}
    for element_index, element in enumerate(mesh.elements):
        marker = int(mesh.element_markers[element_index])
        for face_indices in _TET_FACE_NODE_INDICES:
            key = _face_key([int(element[index]) for index in face_indices])
            face_markers.setdefault(key, set()).add(marker)
    return face_markers


def _boundary_face_counts_by_marker(mesh: MeshData) -> dict[int, int]:
    face_markers = _tetra_face_marker_sets(mesh)
    counts: dict[int, int] = {}
    for face in mesh.boundary_faces:
        for marker in face_markers.get(_face_key(face), set()):
            counts[marker] = counts.get(marker, 0) + 1
    return counts


def _interface_face_count_by_marker_pair(
    face_markers: dict[tuple[int, int, int], set[int]],
) -> dict[tuple[int, int], int]:
    counts: dict[tuple[int, int], int] = {}
    for markers in face_markers.values():
        if len(markers) < 2:
            continue
        ordered = sorted(int(marker) for marker in markers)
        for left, right in zip(ordered[:-1], ordered[1:], strict=False):
            key = (left, right)
            counts[key] = counts.get(key, 0) + 1
    return counts


_MESH_FACE_KEY_DTYPE = np.dtype(
    [("arity", np.int64), ("n0", np.int64), ("n1", np.int64), ("n2", np.int64), ("n3", np.int64)]
)


def _canonical_face_keys(nodes: NDArray[np.int32]) -> NDArray[Any]:
    ordered = np.sort(np.asarray(nodes, dtype=np.int32), axis=1)
    keys = np.empty(len(ordered), dtype=_MESH_FACE_KEY_DTYPE)
    keys["arity"] = ordered.shape[1]
    for index in range(4):
        keys[f"n{index}"] = ordered[:, index] if index < ordered.shape[1] else -1
    return keys


def _mixed_marker_face_statistics(
    mesh: MeshData,
) -> tuple[dict[int, int], int, int]:
    """Match explicit mixed facets to their owner markers with bounded arrays."""
    if mesh.n_boundary_faces == 0 or mesh.n_elements == 0:
        return {}, 0, 0

    explicit_keys: list[NDArray[Any]] = []
    explicit_ordinals: list[NDArray[np.int64]] = []
    for family, arity in FEM_FACET_ARITIES.items():
        facet_indices = np.flatnonzero(mesh.facet_types == family).astype(np.int64)
        if not facet_indices.size:
            continue
        starts = mesh.facet_offsets[facet_indices]
        connectivity = mesh.facet_nodes[
            starts[:, np.newaxis] + np.arange(arity, dtype=np.int64)
        ]
        explicit_keys.append(_canonical_face_keys(connectivity))
        explicit_ordinals.append(facet_indices)
    if not explicit_keys:
        return {}, 0, 0
    all_keys = np.concatenate(explicit_keys)
    facet_order = np.concatenate(explicit_ordinals)
    order = np.argsort(all_keys, kind="stable")
    sorted_keys = all_keys[order]
    owners_by_facet: dict[int, set[int]] = {}

    for family in sorted(set(str(value) for value in mesh.cell_types.tolist())):
        cell_indices = np.flatnonzero(mesh.cell_types == family).astype(np.int64)
        for chunk_start in range(0, len(cell_indices), 16_384):
            chunk_stop = min(chunk_start + 16_384, len(cell_indices))
            chunk_indices = cell_indices[chunk_start:chunk_stop]
            connectivity = _mesh_cell_connectivity(mesh, chunk_indices, family)
            markers = mesh.element_markers[chunk_indices]
            for local_face in _MIXED_CELL_LOCAL_FACETS[family]:
                face_nodes = connectivity[:, local_face]
                face_keys = _canonical_face_keys(face_nodes)
                positions = np.searchsorted(sorted_keys, face_keys)
                in_bounds = positions < sorted_keys.size
                if not np.any(in_bounds):
                    continue
                candidate_positions = positions[in_bounds]
                candidate_keys = face_keys[in_bounds]
                matches = sorted_keys[candidate_positions] == candidate_keys
                if not np.any(matches):
                    continue
                matched_cells = np.flatnonzero(in_bounds)[matches]
                matched_facets = facet_order[order[candidate_positions[matches]]]
                for facet_index, cell_index in zip(matched_facets, matched_cells, strict=True):
                    owners_by_facet.setdefault(int(facet_index), set()).add(
                        int(markers[int(cell_index)])
                    )

    boundary_counts: dict[int, int] = {}
    interface_count = 0
    for owner_markers in owners_by_facet.values():
        for marker in owner_markers:
            boundary_counts[marker] = boundary_counts.get(marker, 0) + 1
        if len(owner_markers) > 1:
            interface_count += 1
    exterior_count = int(np.count_nonzero(mesh.facet_roles == "exterior"))
    return boundary_counts, interface_count, exterior_count


def _quality_histogram_bins(counts: list[int], lo: float, hi: float) -> list[dict[str, object]]:
    if not counts:
        return []
    width = (hi - lo) / len(counts)
    return [
        {
            "lo": lo + width * index,
            "hi": lo + width * (index + 1),
            "count": int(count),
        }
        for index, count in enumerate(counts)
    ]


def _size_histogram_bins(
    values: NDArray[np.float64],
    *,
    bin_count: int = 30,
) -> list[dict[str, object]]:
    finite_values = values[np.isfinite(values)]
    if finite_values.size == 0:
        return []
    min_value = float(np.min(finite_values))
    max_value = float(np.max(finite_values))
    edges = _size_histogram_edges(min_value, max_value, bin_count=bin_count)
    if edges is None:
        return [{"lo": min_value, "hi": max_value, "count": int(finite_values.size)}]

    counts, edges = np.histogram(finite_values, bins=edges)
    return [
        {"lo": float(edges[index]), "hi": float(edges[index + 1]), "count": int(count)}
        for index, count in enumerate(counts)
    ]


def _size_histogram_edges(
    min_value: float,
    max_value: float,
    *,
    bin_count: int,
) -> NDArray[np.float64] | None:
    if math.isclose(min_value, max_value):
        return None
    if min_value > 0.0:
        edges = np.geomspace(min_value, max_value, num=bin_count + 1)
    else:
        edges = np.linspace(min_value, max_value, num=bin_count + 1)
    if not np.all(np.diff(edges) > 0.0):
        return None
    return edges


def _quality_below_threshold(
    values: list[float] | None,
    threshold: float,
) -> tuple[int | None, float | None]:
    if values is None:
        return None, None
    quality_values = np.asarray(values, dtype=np.float64)
    finite_values = quality_values[np.isfinite(quality_values)]
    if finite_values.size == 0:
        return None, None
    count = int(np.count_nonzero(finite_values < threshold))
    return count, count / float(finite_values.size)


def _quality_metric_from_report(
    report: MeshQualityReport | None,
    metric: str,
) -> dict[str, object] | None:
    if report is None:
        return None
    if metric == "sicn":
        if report.quality_source != "gmsh":
            return None
        below_threshold_count, below_threshold_fraction = _quality_below_threshold(
            report.element_sicn,
            SICN_P05_QUALITY_THRESHOLD,
        )
        return {
            "min": report.sicn_min,
            "p05": report.sicn_p5,
            "mean": report.sicn_mean,
            "max": report.sicn_max,
            "threshold": SICN_P05_QUALITY_THRESHOLD,
            "below_threshold_count": below_threshold_count,
            "below_threshold_fraction": below_threshold_fraction,
            "histogram": _quality_histogram_bins(report.sicn_histogram, -1.0, 1.0),
        }
    if metric == "gamma":
        if (
            report.gamma_element_count is not None
            and report.gamma_element_count != report.n_elements
        ):
            return None
        below_threshold_count, below_threshold_fraction = _quality_below_threshold(
            report.element_gamma,
            GAMMA_MIN_QUALITY_THRESHOLD,
        )
        return {
            "min": report.gamma_min,
            "p05": None,
            "mean": report.gamma_mean,
            "max": None,
            "threshold": GAMMA_MIN_QUALITY_THRESHOLD,
            "below_threshold_count": below_threshold_count,
            "below_threshold_fraction": below_threshold_fraction,
            "histogram": _quality_histogram_bins(report.gamma_histogram, 0.0, 1.0),
        }
    return None


def _unavailable_metric(reason: str) -> dict[str, object]:
    return {"status": "unavailable", "reason": reason}


def _quality_family_summary_from_arrays(
    *,
    family: str,
    cell_count: int,
    quality: MeshQualityReport | None,
    selected: NDArray[np.bool_],
    source: str,
) -> dict[str, object]:
    """Return exact, bounded per-family summaries when aligned arrays exist."""
    summary: dict[str, object] = {
        "cell_count": cell_count,
        "source": source,
        "sicn": _unavailable_metric("Gmsh SICN was not requested or retained."),
        "gamma": _unavailable_metric("Gmsh gamma was not requested or retained."),
    }
    if quality is None or quality.quality_source != "gmsh":
        return summary

    def metric_payload(values: NDArray[np.float64], metric: str) -> dict[str, object]:
        if metric == "sicn":
            lower, upper = -1.0, 1.0
            threshold = SICN_P05_QUALITY_THRESHOLD
            p05 = float(np.percentile(values, 5.0))
        else:
            lower, upper = 0.0, 1.0
            threshold = GAMMA_MIN_QUALITY_THRESHOLD
            p05 = float(np.percentile(values, 5.0))
        histogram, _ = np.histogram(values, bins=20, range=(lower, upper))
        below = int(np.count_nonzero(values < threshold))
        return {
            "status": "available",
            "source": "gmsh",
            "min": float(np.min(values)),
            "p05": p05,
            "mean": float(np.mean(values)),
            "max": float(np.max(values)),
            "threshold": threshold,
            "below_threshold_count": below,
            "below_threshold_fraction": below / float(values.size),
            "histogram": _quality_histogram_bins(histogram.tolist(), lower, upper),
        }

    if quality.element_sicn is not None:
        values = np.asarray(quality.element_sicn, dtype=np.float64)
        if values.size == selected.size:
            family_values = values[selected]
            if family_values.size:
                summary["sicn"] = metric_payload(family_values, "sicn")
    if family in {"tet4", "prism6"} and quality.element_gamma is not None:
        values = np.asarray(quality.element_gamma, dtype=np.float64)
        if values.size == selected.size:
            family_values = values[selected]
            if family_values.size and np.all(np.isfinite(family_values)):
                summary["gamma"] = metric_payload(family_values, "gamma")
    elif family not in {"tet4", "prism6"}:
        summary["gamma"] = _unavailable_metric(
            f"Gmsh gamma is not defined for {family}."
        )
    return summary


def _certificate_scaled_jacobian_for_scope(
    mesh: MeshData,
    family: str,
    marker: int | None,
) -> dict[str, object]:
    certificate = mesh.mixed_layer_topology_certificate
    if certificate is None:
        return _unavailable_metric(
            "No accepted mixed topology quality certificate is attached."
        )
    minimums = certificate.scaled_jacobian_minima_by_family
    percentiles = certificate.scaled_jacobian_p05_by_family
    if family not in minimums or family not in percentiles:
        return _unavailable_metric(
            f"{certificate.quality_metric} has no published summary for {family}."
        )
    counts_by_marker = certificate.cell_family_counts_by_marker
    mesh_family_count = int(np.count_nonzero(mesh.cell_types == family))
    certificate_family_count = sum(
        int(counts.get(family, 0)) for counts in counts_by_marker.values()
    )
    if certificate_family_count != mesh_family_count:
        return _unavailable_metric(
            "The certificate family counts do not cover the current mesh scope."
        )
    if marker is not None:
        marker_family_count = int(
            np.count_nonzero(
                (mesh.cell_types == family) & (mesh.element_markers == marker)
            )
        )
        certified_marker_count = int(
            counts_by_marker.get(marker, {}).get(family, 0)
        )
        if marker_family_count != mesh_family_count:
            return _unavailable_metric(
                f"The certificate publishes a mesh-wide {family} summary only; "
                f"{family} spans multiple markers, so its min and p05 are not "
                f"available for marker {marker}."
            )
        if certified_marker_count != marker_family_count:
            return _unavailable_metric(
                "The certificate does not publish the complete family for this marker scope."
            )
    return {
        "status": "available",
        "metric": certificate.quality_metric,
        "source": certificate.schema_version,
        "min": float(minimums[family]),
        "p05": float(percentiles[family]),
        "certificate_fingerprint": certificate.topology_fingerprint,
    }


def _quality_by_family_for_scope(
    mesh: MeshData,
    *,
    element_mask: NDArray[np.bool_],
    quality: MeshQualityReport | None,
    marker: int | None,
) -> dict[str, dict[str, object]]:
    selected = np.asarray(element_mask, dtype=np.bool_)
    selected_types = mesh.cell_types[selected]
    if selected_types.size == 0:
        return {}
    result: dict[str, dict[str, object]] = {}
    report_families = quality.quality_by_family if quality is not None else None
    for family in sorted(str(value) for value in np.unique(selected_types)):
        family_mask = selected & (mesh.cell_types == family)
        family_count = int(np.count_nonzero(family_mask))
        report_row = (
            report_families.get(family)
            if report_families is not None
            else None
        )
        if report_row is None:
            row = _quality_family_summary_from_arrays(
                family=family,
                cell_count=family_count,
                quality=quality,
                selected=family_mask,
                source="gmsh" if quality is not None else "topology",
            )
        else:
            reported_count_value = report_row.get("cell_count")
            reported_count = (
                int(reported_count_value)
                if isinstance(reported_count_value, (int, np.integer))
                and not isinstance(reported_count_value, (bool, np.bool_))
                else None
            )
            if reported_count == family_count:
                row = dict(report_row)
            else:
                row = _quality_family_summary_from_arrays(
                    family=family,
                    cell_count=family_count,
                    quality=quality,
                    selected=family_mask,
                    source="gmsh" if quality is not None else "topology",
                )
                reported_count_label = (
                    "missing or invalid"
                    if reported_count is None
                    else str(reported_count)
                )
                for metric in ("sicn", "gamma"):
                    metric_summary = row.get(metric)
                    if (
                        not isinstance(metric_summary, dict)
                        or metric_summary.get("status") != "available"
                    ):
                        row[metric] = _unavailable_metric(
                            f"The preaggregated {family} {metric.upper()} summary "
                            f"reports {reported_count_label} cells, while this "
                            f"scope contains {family_count}; no aligned per-element "
                            f"{metric.upper()} data is available for recomputation."
                        )
        row["cell_count"] = family_count
        if "sicn" not in row:
            row["sicn"] = _unavailable_metric(
                "Gmsh SICN was not requested or retained."
            )
        if "gamma" not in row:
            row["gamma"] = _unavailable_metric(
                "Gmsh gamma was not requested or retained."
            )
        row["mixed_topology_scaled_jacobian"] = (
            _certificate_scaled_jacobian_for_scope(mesh, family, marker)
        )
        result[family] = row
    return result


def _mesh_scope_node_count(
    mesh: MeshData,
    element_mask: NDArray[np.bool_],
) -> int:
    selected = np.asarray(element_mask, dtype=np.bool_)
    if not np.any(selected):
        return 0
    if np.all(selected):
        return int(np.unique(mesh.cell_nodes).size)
    connectivity_blocks: list[NDArray[np.int32]] = []
    for family in FEM_CELL_ARITIES:
        ordinals = np.flatnonzero(selected & (mesh.cell_types == family)).astype(np.int64)
        if ordinals.size:
            connectivity_blocks.append(
                _mesh_cell_connectivity(mesh, ordinals, family).reshape(-1)
            )
    if not connectivity_blocks:
        return 0
    return int(np.unique(np.concatenate(connectivity_blocks)).size)


def _mesh_edge_length_chunks(
    mesh: MeshData,
    element_mask: NDArray[np.bool_],
) -> Iterator[NDArray[np.float64]]:
    selected = np.asarray(element_mask, dtype=np.bool_)
    for family, local_edges in _MIXED_CELL_LOCAL_EDGES.items():
        ordinals = np.flatnonzero(selected & (mesh.cell_types == family)).astype(np.int64)
        if not ordinals.size:
            continue
        edge_pairs = np.asarray(local_edges, dtype=np.int64)
        for chunk_start in range(0, len(ordinals), 16_384):
            chunk_ordinals = ordinals[chunk_start : chunk_start + 16_384]
            connectivity = _mesh_cell_connectivity(mesh, chunk_ordinals, family)
            coordinates = mesh.nodes[connectivity]
            lengths = np.linalg.norm(
                coordinates[:, edge_pairs[:, 0], :]
                - coordinates[:, edge_pairs[:, 1], :],
                axis=2,
            ).reshape(-1)
            if lengths.size:
                yield lengths


def _mesh_edge_statistics(
    mesh: MeshData,
    element_mask: NDArray[np.bool_],
) -> tuple[float, float, float, float]:
    count = 0
    mean = 0.0
    m2 = 0.0
    minimum = math.inf
    maximum = -math.inf
    for lengths in _mesh_edge_length_chunks(mesh, element_mask):
        chunk_count = int(lengths.size)
        chunk_mean = float(np.mean(lengths))
        chunk_m2 = float(np.sum((lengths - chunk_mean) ** 2))
        delta = chunk_mean - mean
        combined_count = count + chunk_count
        m2 += chunk_m2 + delta * delta * count * chunk_count / combined_count
        mean += delta * chunk_count / combined_count
        count = combined_count
        minimum = min(minimum, float(np.min(lengths)))
        maximum = max(maximum, float(np.max(lengths)))
    if count == 0:
        return 0.0, 0.0, 0.0, 0.0
    return minimum, maximum, mean, math.sqrt(max(0.0, m2 / count))


def _mesh_edge_histogram_bins(
    mesh: MeshData,
    element_mask: NDArray[np.bool_],
    *,
    min_value: float,
    max_value: float,
    bin_count: int = 30,
) -> list[dict[str, object]]:
    if not np.any(element_mask) or not math.isfinite(min_value) or not math.isfinite(max_value):
        return []
    edges = _size_histogram_edges(min_value, max_value, bin_count=bin_count)
    if edges is None:
        finite_count = sum(
            int(np.count_nonzero(np.isfinite(lengths)))
            for lengths in _mesh_edge_length_chunks(mesh, element_mask)
        )
        if finite_count == 0:
            return []
        return [{"lo": min_value, "hi": max_value, "count": finite_count}]

    counts = np.zeros(edges.size - 1, dtype=np.int64)
    for lengths in _mesh_edge_length_chunks(mesh, element_mask):
        finite_lengths = lengths[np.isfinite(lengths)]
        if finite_lengths.size:
            chunk_counts, _ = np.histogram(finite_lengths, bins=edges)
            counts += chunk_counts
    if not np.any(counts):
        return []
    return [
        {"lo": float(edges[index]), "hi": float(edges[index + 1]), "count": int(count)}
        for index, count in enumerate(counts)
    ]


def _mesh_scope_statistics(
    mesh: MeshData,
    *,
    scope_id: str,
    kind: str,
    label: str,
    role: str,
    marker: int | None,
    element_mask: NDArray[np.bool_],
    absolute_volumes: NDArray[np.float64],
    inverted_mask: NDArray[np.bool_],
    degenerate_mask: NDArray[np.bool_],
    quality: MeshQualityReport | None,
    boundary_face_count: int,
    mixed_topology: bool,
) -> MeshStatisticsScope:
    selected = np.asarray(element_mask, dtype=np.bool_)
    abs_volumes = absolute_volumes[selected]
    element_count = int(np.count_nonzero(selected))
    node_count = _mesh_scope_node_count(mesh, selected)
    volume_min = float(np.min(abs_volumes)) if abs_volumes.size else 0.0
    volume_max = float(np.max(abs_volumes)) if abs_volumes.size else 0.0
    volume_mean = float(np.mean(abs_volumes)) if abs_volumes.size else 0.0
    volume_std = float(np.std(abs_volumes)) if abs_volumes.size else 0.0
    volume_total = float(np.sum(abs_volumes)) if abs_volumes.size else 0.0
    volume_ratio = volume_max / volume_min if volume_min > 0.0 else None
    characteristic_sizes = np.cbrt(abs_volumes * 6.0 * math.sqrt(2.0))
    characteristic_size_min = (
        float(np.min(characteristic_sizes)) if characteristic_sizes.size else 0.0
    )
    characteristic_size_max = (
        float(np.max(characteristic_sizes)) if characteristic_sizes.size else 0.0
    )
    characteristic_size_mean = (
        float(np.mean(characteristic_sizes)) if characteristic_sizes.size else 0.0
    )
    characteristic_size_std = (
        float(np.std(characteristic_sizes)) if characteristic_sizes.size else 0.0
    )
    characteristic_size_ratio = (
        characteristic_size_max / characteristic_size_min
        if characteristic_size_min > 0.0
        else None
    )
    characteristic_size_histogram = _size_histogram_bins(characteristic_sizes)
    volume_histogram = _size_histogram_bins(abs_volumes)
    (
        edge_length_min,
        edge_length_max,
        edge_length_mean,
        edge_length_std,
    ) = _mesh_edge_statistics(mesh, selected)
    edge_length_histogram = _mesh_edge_histogram_bins(
        mesh,
        selected,
        min_value=edge_length_min,
        max_value=edge_length_max,
    )
    inverted_count = int(np.count_nonzero(inverted_mask[selected]))
    degenerate_count = int(np.count_nonzero(degenerate_mask[selected]))
    selected_families = set(str(value) for value in mesh.cell_types[selected].tolist())
    quality_by_family = (
        _quality_by_family_for_scope(
            mesh,
            element_mask=selected,
            quality=quality,
            marker=marker,
        )
        if mixed_topology
        else {}
    )
    warnings: list[str] = []
    if inverted_count:
        cell_label = "tetrahedra" if selected_families == {"tet4"} else "cells"
        warnings.append(f"{inverted_count} inverted {cell_label}")
    if degenerate_count:
        cell_label = "tetrahedra" if selected_families == {"tet4"} else "cells"
        warnings.append(f"{degenerate_count} degenerate {cell_label}")
    if volume_ratio is not None and volume_ratio > 1.0e5:
        warnings.append("extreme element volume ratio")
    if (
        quality is not None
        and quality.quality_source == "gmsh"
        and quality.sicn_p5 < 0.1
    ):
        warnings.append("worst 5% SICN below quality target")
    scope_gamma = (
        _quality_metric_from_report(quality, "gamma")
        if selected_families.issubset({"tet4", "prism6"})
        else None
    )
    if quality is not None and scope_gamma is not None and quality.gamma_min < 0.08:
        warnings.append("minimum gamma below quality target")
    unavailable_gamma_families = sorted(
        selected_families - {"tet4", "prism6"}
    )
    if unavailable_gamma_families:
        families = ", ".join(unavailable_gamma_families)
        warnings.append(f"Gmsh gamma is undefined for {families}; omitted for this scope")
    return MeshStatisticsScope(
        id=scope_id,
        kind=kind,
        label=label,
        role=role,
        marker=marker,
        node_count=node_count,
        element_count=element_count,
        boundary_face_count=boundary_face_count,
        volume_min=volume_min,
        volume_max=volume_max,
        volume_mean=volume_mean,
        volume_std=volume_std,
        volume_ratio=volume_ratio,
        volume_total=volume_total,
        characteristic_size_min=characteristic_size_min,
        characteristic_size_max=characteristic_size_max,
        characteristic_size_mean=characteristic_size_mean,
        characteristic_size_std=characteristic_size_std,
        characteristic_size_ratio=characteristic_size_ratio,
        characteristic_size_histogram=characteristic_size_histogram,
        edge_length_min=edge_length_min,
        edge_length_max=edge_length_max,
        edge_length_mean=edge_length_mean,
        edge_length_std=edge_length_std,
        inverted_count=inverted_count,
        degenerate_count=degenerate_count,
        sicn=_quality_metric_from_report(quality, "sicn"),
        gamma=scope_gamma,
        quality_by_family=quality_by_family,
        warnings=warnings,
        volume_histogram=volume_histogram,
        edge_length_histogram=edge_length_histogram,
    )


def _build_mesh_statistics_report(mesh: MeshData, mesh_name: str) -> MeshStatisticsReport:
    mixed_topology = bool(np.any(mesh.cell_types != "tet4"))
    if mixed_topology:
        (
            signed_volumes,
            absolute_volumes,
            inverted_mask,
            degenerate_mask,
        ) = _mesh_cell_geometry(mesh)
        boundary_face_counts, interface_count, exterior_face_count = (
            _mixed_marker_face_statistics(mesh)
        )
    else:
        signed_volumes = _tetra_signed_volumes(mesh)
        absolute_volumes = np.abs(signed_volumes)
        inverted_mask = signed_volumes <= 0.0
        degenerate_mask = absolute_volumes <= 0.0
        boundary_face_counts = _boundary_face_counts_by_marker(mesh)
        face_markers = _tetra_face_marker_sets(mesh)
        interface_counts = _interface_face_count_by_marker_pair(face_markers)
        interface_count = int(sum(interface_counts.values()))
        exterior_face_count = mesh.n_boundary_faces
    all_mask = np.ones(mesh.n_elements, dtype=np.bool_)
    global_scope = _mesh_scope_statistics(
        mesh,
        scope_id="global",
        kind="global",
        label="Complete mesh",
        role="global",
        marker=None,
        element_mask=all_mask,
        absolute_volumes=absolute_volumes,
        inverted_mask=inverted_mask,
        degenerate_mask=degenerate_mask,
        quality=mesh.quality,
        boundary_face_count=exterior_face_count,
        mixed_topology=mixed_topology,
    )
    scopes: list[MeshStatisticsScope] = []
    for marker in sorted(int(value) for value in np.unique(mesh.element_markers)):
        marker_mask = mesh.element_markers == marker
        quality = mesh.per_domain_quality.get(marker) if mesh.per_domain_quality else None
        role = "air" if marker == 0 else "domain"
        label = "Airbox" if marker == 0 else f"Domain {marker}"
        scopes.append(
            _mesh_scope_statistics(
                mesh,
                scope_id=f"marker:{marker}",
                kind="airbox" if marker == 0 else "domain",
                label=label,
                role=role,
                marker=marker,
                element_mask=marker_mask,
                absolute_volumes=absolute_volumes,
                inverted_mask=inverted_mask,
                degenerate_mask=degenerate_mask,
                quality=quality,
                boundary_face_count=boundary_face_counts.get(marker, 0),
                mixed_topology=mixed_topology,
            )
        )
    empty_mask = np.zeros(mesh.n_elements, dtype=np.bool_)
    if exterior_face_count:
        scopes.append(
            _mesh_scope_statistics(
                mesh,
                scope_id="boundary:gamma_out",
                kind="boundary",
                label="Gamma_out",
                role="boundary",
                marker=None,
                element_mask=empty_mask,
                absolute_volumes=absolute_volumes,
                inverted_mask=inverted_mask,
                degenerate_mask=degenerate_mask,
                quality=None,
                boundary_face_count=exterior_face_count,
                mixed_topology=mixed_topology,
            )
        )
    if interface_count:
        scopes.append(
            _mesh_scope_statistics(
                mesh,
                scope_id="boundary:mag_air_interface",
                kind="interface",
                label="Magnetic-air interface",
                role="boundary",
                marker=None,
                element_mask=empty_mask,
                absolute_volumes=absolute_volumes,
                inverted_mask=inverted_mask,
                degenerate_mask=degenerate_mask,
                quality=None,
                boundary_face_count=interface_count,
                mixed_topology=mixed_topology,
            )
        )
    scope_label_by_marker = {
        int(scope.marker): scope.label
        for scope in scopes
        if scope.marker is not None
    }
    worst_elements_by_metric: dict[str, list[dict[str, object]]] = {}
    if mesh.quality is not None:
        if mesh.quality.element_gamma is not None:
            worst_elements_by_metric["gamma"] = _ranked_worst_elements(
                mesh,
                absolute_volumes=absolute_volumes,
                scope_label_by_marker=scope_label_by_marker,
                metric="gamma",
                values=mesh.quality.element_gamma,
            )
        if mesh.quality.element_sicn is not None:
            worst_elements_by_metric["sicn"] = _ranked_worst_elements(
                mesh,
                absolute_volumes=absolute_volumes,
                scope_label_by_marker=scope_label_by_marker,
                metric="sicn",
                values=mesh.quality.element_sicn,
            )
    worst_elements = worst_elements_by_metric.get(
        "gamma", worst_elements_by_metric.get("sicn", [])
    )
    quality_source = (
        mesh.quality.quality_source
        if mesh.quality is not None
        else (
            "mixed_topology_certificate"
            if mixed_topology and mesh.mixed_layer_topology_certificate is not None
            else "topology"
        )
    )
    return MeshStatisticsReport(
        mesh_name=mesh_name,
        quality_source=quality_source,
        global_scope=global_scope,
        scopes=scopes,
        worst_elements=worst_elements,
        worst_elements_by_metric=worst_elements_by_metric,
    )


def _ranked_worst_elements(
    mesh: MeshData,
    *,
    absolute_volumes: NDArray[np.float64],
    scope_label_by_marker: dict[int, str],
    metric: str,
    values: list[float],
) -> list[dict[str, object]]:
    quality_values = np.asarray(values, dtype=np.float64)
    if quality_values.size != mesh.n_elements or quality_values.size == 0:
        return []
    valid = np.isfinite(quality_values)
    if metric == "gamma":
        valid &= np.isin(mesh.cell_types, ("tet4", "prism6"))
    candidate_indices = np.flatnonzero(valid)
    if candidate_indices.size == 0:
        return []
    gamma = (
        np.asarray(mesh.quality.element_gamma, dtype=np.float64)
        if mesh.quality is not None and mesh.quality.element_gamma is not None
        else None
    )
    sicn = (
        np.asarray(mesh.quality.element_sicn, dtype=np.float64)
        if mesh.quality is not None and mesh.quality.element_sicn is not None
        else None
    )
    count = min(10, candidate_indices.size)
    ranked: list[dict[str, object]] = []
    for candidate_index in np.argsort(quality_values[candidate_indices])[:count]:
        element_index = candidate_indices[candidate_index]
        elem = int(element_index)
        marker = int(mesh.element_markers[elem])
        family = str(mesh.cell_types[elem])
        connectivity = _mesh_cell_connectivity(
            mesh, np.asarray([elem], dtype=np.int64), family
        )[0]
        ranked.append(
            {
                "element_index": elem,
                "rank_metric": metric,
                "marker": marker,
                "scope_label": scope_label_by_marker.get(marker, f"Domain {marker}"),
                "gamma": (
                    float(gamma[elem])
                    if gamma is not None
                    and elem < gamma.size
                    and family in {"tet4", "prism6"}
                    else None
                ),
                "sicn": (
                    float(sicn[elem])
                    if sicn is not None and elem < sicn.size
                    else None
                ),
                "volume": float(absolute_volumes[elem]),
                "centroid": np.mean(mesh.nodes[connectivity], axis=0).tolist(),
            }
        )
    return ranked


def _tetra_edge_lengths(mesh: MeshData, element_mask: NDArray[np.bool_]) -> NDArray[np.float64]:
    selected_elements = mesh.elements[np.asarray(element_mask, dtype=np.bool_)]
    if selected_elements.size == 0:
        return np.zeros(0, dtype=np.float64)
    nodes = mesh.nodes
    edge_pairs = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))
    lengths = [
        np.linalg.norm(
            nodes[selected_elements[:, start]] - nodes[selected_elements[:, end]],
            axis=1,
        )
        for start, end in edge_pairs
    ]
    return np.concatenate(lengths).astype(np.float64, copy=False)


def _mesh_statistics_public_scope_id(scope: MeshStatisticsScope) -> str:
    if scope.marker == 0:
        return "part:airbox"
    if scope.marker is not None:
        return f"part:marker:{scope.marker}"
    return scope.id


def _mesh_statistics_scope_to_ir(scope: MeshStatisticsScope) -> dict[str, object]:
    result: dict[str, object] = {
        "id": scope.id,
        "scope_id": _mesh_statistics_public_scope_id(scope),
        "kind": scope.kind,
        "label": scope.label,
        "role": scope.role,
        "marker": scope.marker,
        "node_count": scope.node_count,
        "element_count": scope.element_count,
        "boundary_face_count": scope.boundary_face_count,
        "volume": {
            "definition": "absolute_canonical_tetrahedral_decomposition",
            "unit": "m^3",
            "min": scope.volume_min,
            "max": scope.volume_max,
            "mean": scope.volume_mean,
            "std": scope.volume_std,
            "ratio": scope.volume_ratio,
            "total": scope.volume_total,
            "histogram": scope.volume_histogram,
        },
        "characteristic_size": {
            "definition": "volume_equivalent_regular_tetrahedron",
            "unit": "m",
            "min": scope.characteristic_size_min,
            "max": scope.characteristic_size_max,
            "mean": scope.characteristic_size_mean,
            "std": scope.characteristic_size_std,
            "ratio": scope.characteristic_size_ratio,
            "histogram": scope.characteristic_size_histogram,
        },
        "edge_length": {
            "definition": "canonical_edges_per_cell",
            "unit": "m",
            "min": scope.edge_length_min,
            "max": scope.edge_length_max,
            "mean": scope.edge_length_mean,
            "std": scope.edge_length_std,
            "histogram": scope.edge_length_histogram,
        },
        "inverted_count": scope.inverted_count,
        "degenerate_count": scope.degenerate_count,
        "sicn": scope.sicn,
        "gamma": scope.gamma,
        "warnings": scope.warnings,
    }
    if scope.quality_by_family:
        result["quality_by_family"] = scope.quality_by_family
    return result


def _mesh_statistics_report_to_ir(report: MeshStatisticsReport) -> dict[str, object]:
    return {
        "mesh_name": report.mesh_name,
        "quality_source": report.quality_source,
        "global": _mesh_statistics_scope_to_ir(report.global_scope),
        "scopes": [_mesh_statistics_scope_to_ir(scope) for scope in report.scopes],
        "worst_elements": report.worst_elements,
        "worst_elements_by_metric": report.worst_elements_by_metric,
    }


def _infer_axis_aligned_periodic_pairs(
    mesh: MeshData,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    if mesh.boundary_faces.size == 0 or mesh.nodes.size == 0:
        return [], []

    boundary_node_indices = np.unique(mesh.boundary_faces.reshape(-1))
    boundary_nodes = mesh.nodes[boundary_node_indices]
    if boundary_nodes.size == 0:
        return [], []

    bounds_min = boundary_nodes.min(axis=0)
    bounds_max = boundary_nodes.max(axis=0)
    span = bounds_max - bounds_min
    tol = max(float(np.max(span)) * 1e-6, 1e-12)

    periodic_boundary_pairs: list[dict[str, object]] = []
    periodic_node_pairs: list[dict[str, object]] = []
    axis_labels = ("x", "y", "z")

    face_marker_map: dict[tuple[int, ...], int] = {}
    for face, marker in zip(mesh.boundary_faces, mesh.boundary_markers, strict=False):
        face_marker_map[tuple(sorted(int(node) for node in face.tolist()))] = int(marker)

    for axis, axis_label in enumerate(axis_labels):
        if not np.isfinite(span[axis]) or span[axis] <= tol:
            continue

        min_mask = np.abs(boundary_nodes[:, axis] - bounds_min[axis]) <= tol
        max_mask = np.abs(boundary_nodes[:, axis] - bounds_max[axis]) <= tol
        if not np.any(min_mask) or not np.any(max_mask):
            continue

        min_nodes = boundary_node_indices[min_mask]
        max_nodes = boundary_node_indices[max_mask]
        if len(min_nodes) != len(max_nodes):
            continue

        other_axes = [candidate for candidate in range(3) if candidate != axis]
        min_map: dict[tuple[int, int], int] = {}
        max_map: dict[tuple[int, int], int] = {}
        key_tol_0 = max(float(span[other_axes[0]]) * 1e-6, tol)
        key_tol_1 = max(float(span[other_axes[1]]) * 1e-6, tol)

        for node in min_nodes:
            coord = mesh.nodes[int(node)]
            key = (
                int(round(coord[other_axes[0]] / key_tol_0)),
                int(round(coord[other_axes[1]] / key_tol_1)),
            )
            min_map[key] = int(node)
        for node in max_nodes:
            coord = mesh.nodes[int(node)]
            key = (
                int(round(coord[other_axes[0]] / key_tol_0)),
                int(round(coord[other_axes[1]] / key_tol_1)),
            )
            max_map[key] = int(node)

        shared_keys = sorted(set(min_map).intersection(max_map))
        if len(shared_keys) != len(min_nodes) or len(shared_keys) != len(max_nodes):
            continue

        min_marker_values = {
            face_marker_map[tuple(sorted(int(node) for node in face.tolist()))]
            for face in mesh.boundary_faces
            if np.all(np.abs(mesh.nodes[face, axis] - bounds_min[axis]) <= tol)
            and tuple(sorted(int(node) for node in face.tolist())) in face_marker_map
        }
        max_marker_values = {
            face_marker_map[tuple(sorted(int(node) for node in face.tolist()))]
            for face in mesh.boundary_faces
            if np.all(np.abs(mesh.nodes[face, axis] - bounds_max[axis]) <= tol)
            and tuple(sorted(int(node) for node in face.tolist())) in face_marker_map
        }
        marker_a = min(min_marker_values) if min_marker_values else int(mesh.boundary_markers.min())
        marker_b = min(max_marker_values) if max_marker_values else int(mesh.boundary_markers.max())

        pair_id = f"{axis_label}_faces"
        translation = [0.0, 0.0, 0.0]
        translation[axis] = float(span[axis])
        periodic_boundary_pairs.append(
            {
                "pair_id": pair_id,
                "marker_a": marker_a,
                "marker_b": marker_b,
                "axis_hint": axis_label,
                "translation": translation,
                "tolerance_m": tol,
            }
        )
        for key in shared_keys:
            periodic_node_pairs.append(
                {
                    "pair_id": pair_id,
                    "node_a": min_map[key],
                    "node_b": max_map[key],
                }
            )

    return periodic_boundary_pairs, periodic_node_pairs



@dataclass(frozen=True, slots=True)
class ComponentDescriptor:
    """Description of a single geometry component for shared-domain meshing."""

    geometry_name: str
    stl_path: Path
    bounds_min: tuple[float, float, float]
    bounds_max: tuple[float, float, float]


@dataclass(frozen=True, slots=True)
class SharedDomainMeshResult:
    """Result of component-aware shared-domain mesh generation.

    Carries the final ``MeshData`` along with stable mappings from each
    geometry component to Gmsh volume/surface tags established *before*
    tetrahedralization, eliminating the need for post-hoc bbox heuristics.
    """

    mesh: MeshData
    component_marker_tags: dict[str, int]
    component_volume_tags: dict[str, list[int]]
    component_surface_tags: dict[str, list[int]]
    interface_surface_tags: list[int]
    outer_boundary_surface_tags: list[int]
    object_region_marker_tags: dict[str, int] = field(default_factory=dict)
    selector_resolution: list[dict[str, object]] = field(default_factory=list)
    boundary_layer_result: dict[str, object] | None = None
    orphan_entities: list[dict[str, object]] = field(default_factory=list)
    # Truth from the final Gmsh application, including fallbacks caused by
    # fields installed before ``MeshOptions`` is applied.
    algorithm_3d_requested: int | None = None
    algorithm_3d_effective: int | None = None
    algorithm_3d_fallback_reason: str | None = None
