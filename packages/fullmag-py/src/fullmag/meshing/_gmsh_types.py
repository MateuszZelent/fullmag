from __future__ import annotations

from dataclasses import dataclass, field
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray


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
    warnings: list[str] = field(default_factory=list)


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

_MESH_SIZE_PRESET_ALIASES = {
    "extra fine": "extra_fine",
    "extremely fine": "extremely_fine",
    "extrafine": "extra_fine",
    "extremelyfine": "extremely_fine",
    "very_fine": "extra_fine",
    "coarser_mesh": "coarser",
    "extra coarse": "extra_coarse",
    "extracoarse": "extra_coarse",
    "extremely coarse": "extremely_coarse",
    "extremelycoarse": "extremely_coarse",
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
    sweep_source: str | None = None  # "auto" | face selector hint
    sweep_destination: str | None = None  # "auto" | face selector hint

    def __post_init__(self) -> None:
        calibration = _normalize_mesh_size_calibration(self.calibrate_for)
        preset = _normalize_mesh_size_preset(self.size_preset)
        if self.calibrate_for is not None:
            object.__setattr__(self, "calibrate_for", calibration)
        if self.size_preset is not None:
            object.__setattr__(self, "size_preset", preset)
        if self.curvature_factor is not None:
            if not math.isfinite(self.curvature_factor) or self.curvature_factor <= 0.0:
                raise ValueError("curvature_factor must be a positive finite float")
        if self.narrow_region_resolution is not None:
            if (
                not math.isfinite(self.narrow_region_resolution)
                or self.narrow_region_resolution <= 0.0
            ):
                raise ValueError("narrow_region_resolution must be a positive finite float")


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
class MeshData:
    """Tetrahedral mesh data ready for FEM lowering."""

    nodes: NDArray[np.float64]
    elements: NDArray[np.int32]
    element_markers: NDArray[np.int32]
    boundary_faces: NDArray[np.int32]
    boundary_markers: NDArray[np.int32]
    periodic_boundary_pairs: list[dict[str, object]] = field(default_factory=list)
    periodic_node_pairs: list[dict[str, object]] = field(default_factory=list)
    quality: MeshQualityReport | None = None
    per_domain_quality: dict[int, MeshQualityReport] | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "nodes", np.asarray(self.nodes, dtype=np.float64))
        object.__setattr__(self, "elements", np.asarray(self.elements, dtype=np.int32))
        object.__setattr__(self, "element_markers", np.asarray(self.element_markers, dtype=np.int32))
        object.__setattr__(self, "boundary_faces", np.asarray(self.boundary_faces, dtype=np.int32))
        object.__setattr__(self, "boundary_markers", np.asarray(self.boundary_markers, dtype=np.int32))
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
        self.validate()

    @property
    def n_nodes(self) -> int:
        return int(self.nodes.shape[0])

    @property
    def n_elements(self) -> int:
        return int(self.elements.shape[0])

    @property
    def n_boundary_faces(self) -> int:
        return int(self.boundary_faces.shape[0])

    def validate(self) -> None:
        if self.nodes.ndim != 2 or self.nodes.shape[1] != 3:
            raise ValueError("nodes must have shape (N, 3)")
        if self.elements.ndim != 2 or self.elements.shape[1] != 4:
            raise ValueError("elements must have shape (M, 4)")
        if self.element_markers.shape != (self.n_elements,):
            raise ValueError("element_markers must have shape (M,)")
        if self.boundary_faces.ndim != 2 or (
            self.boundary_faces.size != 0 and self.boundary_faces.shape[1] != 3
        ):
            raise ValueError("boundary_faces must have shape (F, 3)")
        if self.boundary_markers.shape != (self.n_boundary_faces,):
            raise ValueError("boundary_markers must have shape (F,)")
        if self.elements.size and (self.elements.min() < 0 or self.elements.max() >= self.n_nodes):
            raise ValueError("elements contain invalid node indices")
        if self.boundary_faces.size and (
            self.boundary_faces.min() < 0 or self.boundary_faces.max() >= self.n_nodes
        ):
            raise ValueError("boundary_faces contain invalid node indices")
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
    ) -> None:
        self.validate()
        if not np.all(np.isfinite(self.nodes)):
            raise ValueError("mesh nodes must be finite")
        if self.elements.size == 0:
            raise ValueError("mesh must contain at least one tetrahedral element")
        if self.element_markers.shape != (self.n_elements,):
            raise ValueError("element_markers must cover every tetrahedral element")

        for index, element in enumerate(self.elements):
            if len({int(node) for node in element}) != 4:
                raise ValueError(f"mesh element {index} contains duplicate node indices")

        volumes = _tetra_signed_volumes(self)
        bbox = np.ptp(self.nodes, axis=0) if self.nodes.size else np.zeros(3, dtype=np.float64)
        scale = float(np.max(bbox))
        resolved_eps = (
            float(eps_volume)
            if eps_volume is not None
            else max(np.finfo(np.float64).tiny, (scale if scale > 0.0 else 1.0) ** 3 * 1e-18)
        )
        bad_volume = np.flatnonzero(np.abs(volumes) <= resolved_eps)
        if bad_volume.size:
            first = int(bad_volume[0])
            raise ValueError(
                f"mesh element {first} has degenerate tetra volume "
                f"{volumes[first]:.6e} <= eps {resolved_eps:.6e}"
            )
        if require_positive_orientation:
            inverted = np.flatnonzero(volumes < 0.0)
            if inverted.size:
                first = int(inverted[0])
                raise ValueError(
                    f"mesh element {first} has negative tetra orientation "
                    f"{volumes[first]:.6e}"
                )

    def oriented_copy(self) -> "MeshData":
        volumes = _tetra_signed_volumes(self)
        if volumes.size == 0 or not np.any(volumes < 0.0):
            return self
        elements = np.array(self.elements, copy=True)
        inverted = volumes < 0.0
        elements[inverted, 2], elements[inverted, 3] = (
            elements[inverted, 3].copy(),
            elements[inverted, 2].copy(),
        )
        return MeshData(
            nodes=np.array(self.nodes, copy=True),
            elements=elements,
            element_markers=np.array(self.element_markers, copy=True),
            boundary_faces=np.array(self.boundary_faces, copy=True),
            boundary_markers=np.array(self.boundary_markers, copy=True),
            periodic_boundary_pairs=[dict(pair) for pair in self.periodic_boundary_pairs],
            periodic_node_pairs=[dict(pair) for pair in self.periodic_node_pairs],
            quality=self.quality,
            per_domain_quality=self.per_domain_quality,
        )

    def save(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.suffix.lower() == ".json":
            target.write_text(
                json.dumps(
                    {
                        "mesh_name": target.stem,
                        "nodes": self.nodes.tolist(),
                        "elements": self.elements.tolist(),
                        "element_markers": self.element_markers.tolist(),
                        "boundary_faces": self.boundary_faces.tolist(),
                        "boundary_markers": self.boundary_markers.tolist(),
                        "periodic_boundary_pairs": self.periodic_boundary_pairs,
                        "periodic_node_pairs": self.periodic_node_pairs,
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            return
        np.savez_compressed(
            target,
            nodes=self.nodes,
            elements=self.elements,
            element_markers=self.element_markers,
            boundary_faces=self.boundary_faces,
            boundary_markers=self.boundary_markers,
        )

    def export_stl(self, path: str | Path) -> Path:
        """Export boundary surface as binary STL (zero dependencies)."""
        import struct
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        n_faces = self.n_boundary_faces
        with open(target, "wb") as fp:
            fp.write(b"\0" * 80)  # header
            fp.write(struct.pack("<I", n_faces))
            for fi in range(n_faces):
                v0, v1, v2 = self.nodes[self.boundary_faces[fi]]
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
        """Export full tetrahedral mesh as VTK legacy file.

        Args:
            path: Destination file path.
            fields: Optional dict of per-node field data to include.
                    Keys are field names (e.g. "m", "H_ex").
                    Values are arrays of shape (n_nodes, 3) for vectors
                    or (n_nodes,) for scalars.
        """
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        n = self.n_nodes
        m = self.n_elements
        with open(target, "w", encoding="utf-8") as fp:
            fp.write("# vtk DataFile Version 3.0\n")
            fp.write("fullmag tetrahedral mesh\n")
            fp.write("ASCII\n")
            fp.write("DATASET UNSTRUCTURED_GRID\n")
            fp.write(f"POINTS {n} double\n")
            for node in self.nodes:
                fp.write(f"{node[0]:.15e} {node[1]:.15e} {node[2]:.15e}\n")
            fp.write(f"\nCELLS {m} {m * 5}\n")
            for tet in self.elements:
                fp.write(f"4 {tet[0]} {tet[1]} {tet[2]} {tet[3]}\n")
            fp.write(f"\nCELL_TYPES {m}\n")
            for _ in range(m):
                fp.write("10\n")  # VTK_TETRA = 10
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

    @classmethod
    def load(cls, path: str | Path) -> "MeshData":
        source = Path(path)
        if source.suffix.lower() == ".json":
            payload = json.loads(source.read_text(encoding="utf-8"))
            return cls(
                nodes=np.asarray(payload["nodes"], dtype=np.float64),
                elements=np.asarray(payload["elements"], dtype=np.int32),
                element_markers=np.asarray(payload["element_markers"], dtype=np.int32),
                boundary_faces=np.asarray(payload["boundary_faces"], dtype=np.int32),
                boundary_markers=np.asarray(payload["boundary_markers"], dtype=np.int32),
                periodic_boundary_pairs=[dict(pair) for pair in payload.get("periodic_boundary_pairs", [])],
                periodic_node_pairs=[dict(pair) for pair in payload.get("periodic_node_pairs", [])],
            )

        data = np.load(source)
        return cls(
            nodes=data["nodes"],
            elements=data["elements"],
            element_markers=data["element_markers"],
            boundary_faces=data["boundary_faces"],
            boundary_markers=data["boundary_markers"],
        )

    def to_ir(self, mesh_name: str) -> dict[str, object]:
        mesh = self.oriented_copy()
        mesh.validate_strict(require_positive_orientation=True)
        ir: dict[str, object] = {
            "mesh_name": mesh_name,
            "nodes": mesh.nodes.tolist(),
            "elements": mesh.elements.tolist(),
            "element_markers": mesh.element_markers.tolist(),
            "boundary_faces": mesh.boundary_faces.tolist(),
            "boundary_markers": mesh.boundary_markers.tolist(),
        }
        periodic_boundary_pairs = mesh.periodic_boundary_pairs
        periodic_node_pairs = mesh.periodic_node_pairs
        if periodic_boundary_pairs:
            ir["periodic_boundary_pairs"] = periodic_boundary_pairs
        if periodic_node_pairs:
            ir["periodic_node_pairs"] = periodic_node_pairs
        if mesh.per_domain_quality is not None:
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
        ir["mesh_statistics"] = _mesh_statistics_report_to_ir(
            _build_mesh_statistics_report(mesh, mesh_name)
        )
        return ir


def _tetra_signed_volumes(mesh: MeshData) -> NDArray[np.float64]:
    if mesh.elements.size == 0:
        return np.zeros(0, dtype=np.float64)
    p0 = mesh.nodes[mesh.elements[:, 0]]
    p1 = mesh.nodes[mesh.elements[:, 1]]
    p2 = mesh.nodes[mesh.elements[:, 2]]
    p3 = mesh.nodes[mesh.elements[:, 3]]
    return np.linalg.det(np.stack([p1 - p0, p2 - p0, p3 - p0], axis=2)) / 6.0


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
    if math.isclose(min_value, max_value):
        return [{"lo": min_value, "hi": max_value, "count": int(finite_values.size)}]
    if min_value > 0.0:
        edges = np.geomspace(min_value, max_value, num=bin_count + 1)
    else:
        edges = np.linspace(min_value, max_value, num=bin_count + 1)
    if not np.all(np.diff(edges) > 0.0):
        return [{"lo": min_value, "hi": max_value, "count": int(finite_values.size)}]
    counts, edges = np.histogram(finite_values, bins=edges)
    return [
        {"lo": float(edges[index]), "hi": float(edges[index + 1]), "count": int(count)}
        for index, count in enumerate(counts)
    ]


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


def _mesh_scope_statistics(
    mesh: MeshData,
    *,
    scope_id: str,
    kind: str,
    label: str,
    role: str,
    marker: int | None,
    element_mask: NDArray[np.bool_],
    signed_volumes: NDArray[np.float64],
    quality: MeshQualityReport | None,
    boundary_face_count: int,
) -> MeshStatisticsScope:
    selected = np.asarray(element_mask, dtype=np.bool_)
    abs_volumes = np.abs(signed_volumes[selected])
    element_count = int(np.count_nonzero(selected))
    edge_lengths = _tetra_edge_lengths(mesh, selected)
    if element_count > 0:
        node_count = int(np.unique(mesh.elements[selected].reshape(-1)).size)
    else:
        node_count = 0
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
    edge_length_min = float(np.min(edge_lengths)) if edge_lengths.size else 0.0
    edge_length_max = float(np.max(edge_lengths)) if edge_lengths.size else 0.0
    edge_length_mean = float(np.mean(edge_lengths)) if edge_lengths.size else 0.0
    edge_length_std = float(np.std(edge_lengths)) if edge_lengths.size else 0.0
    inverted_count = int(np.count_nonzero(signed_volumes[selected] <= 0.0))
    degenerate_count = int(np.count_nonzero(abs_volumes <= 0.0))
    warnings: list[str] = []
    if inverted_count:
        warnings.append(f"{inverted_count} inverted tetrahedra")
    if degenerate_count:
        warnings.append(f"{degenerate_count} degenerate tetrahedra")
    if volume_ratio is not None and volume_ratio > 1.0e5:
        warnings.append("extreme element volume ratio")
    if (
        quality is not None
        and quality.quality_source == "gmsh"
        and quality.sicn_p5 < 0.1
    ):
        warnings.append("worst 5% SICN below quality target")
    if quality is not None and quality.gamma_min < 0.08:
        warnings.append("minimum gamma below quality target")
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
        gamma=_quality_metric_from_report(quality, "gamma"),
        warnings=warnings,
    )


def _build_mesh_statistics_report(mesh: MeshData, mesh_name: str) -> MeshStatisticsReport:
    signed_volumes = _tetra_signed_volumes(mesh)
    all_mask = np.ones(mesh.n_elements, dtype=np.bool_)
    boundary_face_counts = _boundary_face_counts_by_marker(mesh)
    face_markers = _tetra_face_marker_sets(mesh)
    interface_counts = _interface_face_count_by_marker_pair(face_markers)
    global_scope = _mesh_scope_statistics(
        mesh,
        scope_id="global",
        kind="global",
        label="Complete mesh",
        role="global",
        marker=None,
        element_mask=all_mask,
        signed_volumes=signed_volumes,
        quality=mesh.quality,
        boundary_face_count=mesh.n_boundary_faces,
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
                signed_volumes=signed_volumes,
                quality=quality,
                boundary_face_count=boundary_face_counts.get(marker, 0),
            )
        )
    empty_mask = np.zeros(mesh.n_elements, dtype=np.bool_)
    if mesh.n_boundary_faces:
        scopes.append(
            _mesh_scope_statistics(
                mesh,
                scope_id="boundary:gamma_out",
                kind="boundary",
                label="Gamma_out",
                role="boundary",
                marker=None,
                element_mask=empty_mask,
                signed_volumes=signed_volumes,
                quality=None,
                boundary_face_count=mesh.n_boundary_faces,
            )
        )
    interface_count = int(sum(interface_counts.values()))
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
                signed_volumes=signed_volumes,
                quality=None,
                boundary_face_count=interface_count,
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
                signed_volumes=signed_volumes,
                scope_label_by_marker=scope_label_by_marker,
                metric="gamma",
                values=mesh.quality.element_gamma,
            )
        if mesh.quality.element_sicn is not None:
            worst_elements_by_metric["sicn"] = _ranked_worst_elements(
                mesh,
                signed_volumes=signed_volumes,
                scope_label_by_marker=scope_label_by_marker,
                metric="sicn",
                values=mesh.quality.element_sicn,
            )
    worst_elements = worst_elements_by_metric.get("gamma", [])
    return MeshStatisticsReport(
        mesh_name=mesh_name,
        quality_source=mesh.quality.quality_source if mesh.quality is not None else "topology",
        global_scope=global_scope,
        scopes=scopes,
        worst_elements=worst_elements,
        worst_elements_by_metric=worst_elements_by_metric,
    )


def _ranked_worst_elements(
    mesh: MeshData,
    *,
    signed_volumes: NDArray[np.float64],
    scope_label_by_marker: dict[int, str],
    metric: str,
    values: list[float],
) -> list[dict[str, object]]:
    quality_values = np.asarray(values, dtype=np.float64)
    if quality_values.size != mesh.n_elements or quality_values.size == 0:
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
    count = min(10, quality_values.size)
    ranked: list[dict[str, object]] = []
    for element_index in np.argsort(quality_values)[:count]:
        elem = int(element_index)
        marker = int(mesh.element_markers[elem])
        ranked.append(
            {
                "element_index": elem,
                "rank_metric": metric,
                "marker": marker,
                "scope_label": scope_label_by_marker.get(marker, f"Domain {marker}"),
                "gamma": (
                    float(gamma[elem])
                    if gamma is not None and elem < gamma.size
                    else None
                ),
                "sicn": (
                    float(sicn[elem])
                    if sicn is not None and elem < sicn.size
                    else None
                ),
                "volume": float(abs(signed_volumes[elem])),
                "centroid": np.mean(mesh.nodes[mesh.elements[elem]], axis=0).tolist(),
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
    return {
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
            "min": scope.volume_min,
            "max": scope.volume_max,
            "mean": scope.volume_mean,
            "std": scope.volume_std,
            "ratio": scope.volume_ratio,
            "total": scope.volume_total,
        },
        "characteristic_size": {
            "min": scope.characteristic_size_min,
            "max": scope.characteristic_size_max,
            "mean": scope.characteristic_size_mean,
            "std": scope.characteristic_size_std,
            "ratio": scope.characteristic_size_ratio,
            "histogram": scope.characteristic_size_histogram,
        },
        "edge_length": {
            "min": scope.edge_length_min,
            "max": scope.edge_length_max,
            "mean": scope.edge_length_mean,
            "std": scope.edge_length_std,
        },
        "inverted_count": scope.inverted_count,
        "degenerate_count": scope.degenerate_count,
        "sicn": scope.sicn,
        "gamma": scope.gamma,
        "warnings": scope.warnings,
    }


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
        periodic_boundary_pairs.append(
            {
                "pair_id": pair_id,
                "marker_a": marker_a,
                "marker_b": marker_b,
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
    selector_resolution: list[dict[str, object]] = field(default_factory=list)
    boundary_layer_result: dict[str, object] | None = None
    orphan_entities: list[dict[str, object]] = field(default_factory=list)
