from __future__ import annotations

from dataclasses import dataclass, field
from numbers import Integral, Real
from typing import Any, Literal, Sequence

from fullmag._validation import as_vector3, require_finite, require_positive


# ---------------------------------------------------------------------------
# FDM per-magnet native grid override
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class FDMGrid:
    """Per-magnet native FDM grid specification.

    Example::

        fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9))
    """

    cell: tuple[float, float, float]

    def __init__(self, cell: Sequence[float]) -> None:
        vector = as_vector3(cell, "cell")
        for index, component in enumerate(vector):
            require_positive(component, f"cell[{index}]")
        object.__setattr__(self, "cell", vector)

    def to_ir(self) -> dict[str, object]:
        return {"cell": list(self.cell)}


# ---------------------------------------------------------------------------
# FDM demagnetization solver policy
# ---------------------------------------------------------------------------
_DEMAG_STRATEGIES = ("auto", "single_grid", "multilayer_convolution")
_DEMAG_MODES = ("auto", "two_d_stack", "three_d")
_FEM_LINEAR_SOLVERS = ("CG", "GMRES")
_FEM_PRECONDITIONERS = ("AMG", "JACOBI", "NONE")


@dataclass(frozen=True, slots=True)
class FDMDemag:
    """FDM demagnetization solver policy.

    Controls how demagnetizing fields are computed when multiple
    ferromagnets participate in the same problem.

    Attributes:
        strategy: ``"auto"`` lets the planner choose;
            ``"single_grid"`` forces one shared grid;
            ``"multilayer_convolution"`` forces the multi-layer path.
        mode: ``"two_d_stack"`` for thin-film stacks (common cells in xy),
            ``"three_d"`` for full 3-D stacks.
        common_cells: Explicit 3-D common convolution grid size.
        common_cells_xy: Explicit 2-D common grid (for ``two_d_stack``).
        explain: Print a human-readable plan summary before running.

    Example::

        fm.FDMDemag(
            strategy="multilayer_convolution",
            mode="two_d_stack",
            common_cells_xy=(512, 512),
        )
    """

    strategy: Literal["auto", "single_grid", "multilayer_convolution"] = "auto"
    mode: Literal["auto", "two_d_stack", "three_d"] = "auto"
    common_cells: tuple[int, int, int] | None = None
    common_cells_xy: tuple[int, int] | None = None
    common_cell_size: tuple[float, float, float] | None = None
    # Compatibility-only input. It is never lowered because silent fallback
    # is not a public execution contract.
    allow_single_grid_fallback: bool | None = field(default=None, repr=False)
    explain: bool = True

    def __post_init__(self) -> None:
        if self.allow_single_grid_fallback is not None:
            raise ValueError(
                "allow_single_grid_fallback has been removed; choose "
                "strategy='single_grid' or 'multilayer_convolution' explicitly"
            )
        if self.strategy not in _DEMAG_STRATEGIES:
            raise ValueError(
                f"strategy must be one of {_DEMAG_STRATEGIES!r}, "
                f"got {self.strategy!r}"
            )
        if self.mode not in _DEMAG_MODES:
            raise ValueError(
                f"mode must be one of {_DEMAG_MODES!r}, got {self.mode!r}"
            )
        if self.common_cells is not None and self.common_cells_xy is not None:
            raise ValueError("cannot specify both 'common_cells' and 'common_cells_xy'")
        if self.common_cell_size is not None:
            if self.common_cells is not None or self.common_cells_xy is not None:
                raise ValueError(
                    "common_cell_size cannot be combined with common_cells or common_cells_xy"
                )
            vector = as_vector3(self.common_cell_size, "common_cell_size")
            for index, component in enumerate(vector):
                require_positive(component, f"common_cell_size[{index}]")
            object.__setattr__(self, "common_cell_size", vector)
        if self.common_cells is not None:
            if len(self.common_cells) != 3:
                raise ValueError("common_cells must have exactly 3 elements")
            for v in self.common_cells:
                if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
                    raise ValueError("common_cells values must be positive ints")
            if self.mode == "two_d_stack":
                raise ValueError(
                    "common_cells is incompatible with mode='two_d_stack'; "
                    "use mode='three_d' or mode='auto'"
                )
        if self.common_cells_xy is not None:
            if len(self.common_cells_xy) != 2:
                raise ValueError("common_cells_xy must have exactly 2 elements")
            for v in self.common_cells_xy:
                if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
                    raise ValueError("common_cells_xy values must be positive ints")
            if self.mode not in ("auto", "two_d_stack"):
                raise ValueError(
                    "common_cells_xy is only valid with mode='auto' or 'two_d_stack'"
                )

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "strategy": self.strategy,
            "mode": self.mode,
        }
        if self.common_cells is not None:
            ir["common_cells"] = list(self.common_cells)
        if self.common_cells_xy is not None:
            ir["common_cells_xy"] = list(self.common_cells_xy)
        if self.common_cell_size is not None:
            ir["common_cell_size"] = list(self.common_cell_size)
        return ir


# ---------------------------------------------------------------------------
# FEM linear-solver policy
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class FemLinearSolverPolicy:
    """Native FEM demag/Poisson linear-solver policy.

    This is an advanced FEM backend hint. It does not change the physical
    problem; it changes how the native FEM backend solves the Poisson system.
    """

    solver: Literal["CG", "GMRES"] = "CG"
    preconditioner: Literal["AMG", "JACOBI", "NONE"] = "AMG"
    rtol: float = 1e-8
    atol: float | None = None
    max_iterations: int = 500
    print_level: int = 0

    def __post_init__(self) -> None:
        if self.solver not in _FEM_LINEAR_SOLVERS:
            raise ValueError(
                f"solver must be one of {_FEM_LINEAR_SOLVERS!r}, got {self.solver!r}"
            )
        if self.preconditioner not in _FEM_PRECONDITIONERS:
            raise ValueError(
                "preconditioner must be one of "
                f"{_FEM_PRECONDITIONERS!r}, got {self.preconditioner!r}"
            )
        require_positive(self.rtol, "rtol")
        if self.atol is not None:
            require_positive(self.atol, "atol")
        if self.max_iterations < 1:
            raise ValueError("max_iterations must be >= 1")
        if self.print_level < 0:
            raise ValueError("print_level must be >= 0")

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "solver": self.solver,
            "preconditioner": self.preconditioner,
            "rtol": self.rtol,
            "max_iterations": self.max_iterations,
            "print_level": self.print_level,
        }
        if self.atol is not None:
            payload["atol"] = self.atol
        return payload


# ---------------------------------------------------------------------------
# FDM discretization hints (top-level)
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class FDM:
    """FDM discretization hints with per-magnet native grid support.

    Backward compatible: ``FDM(cell=(dx, dy, dz))`` still works and is
    equivalent to ``FDM(default_cell=(dx, dy, dz))``.

    For multilayer problems specify per-magnet grids and a demag policy::

        fm.FDM(
            default_cell=(4e-9, 4e-9, 1e-9),
            per_magnet={
                "free": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
                "ref":  fm.FDMGrid(cell=(4e-9, 4e-9, 1e-9)),
            },
            demag=fm.FDMDemag(
                strategy="multilayer_convolution",
                mode="two_d_stack",
                common_cells_xy=(512, 512),
            ),
        )
    """

    default_cell: tuple[float, float, float] | None = None
    per_magnet: dict[str, FDMGrid] | None = None
    demag: FDMDemag | None = None
    boundary_correction: str | None = None  # "none" | "volume" (T0) | "full" (T1)
    boundary_phi_floor: float | None = None  # min volume fraction for stability (default 0.05)
    boundary_delta_min: float | None = None  # min δ for T1 ECB stencil stability [m] (default 0.1*min(dx,dy,dz))

    # --- backward compatibility: FDM(cell=(...)) --------------------------
    def __init__(
        self,
        *,
        cell: Sequence[float] | None = None,
        default_cell: Sequence[float] | None = None,
        per_magnet: dict[str, FDMGrid] | None = None,
        demag: FDMDemag | None = None,
        boundary_correction: str | None = None,
        boundary_phi_floor: float | None = None,
        boundary_delta_min: float | None = None,
    ) -> None:
        # Resolve old-style `cell=` to `default_cell=`
        if cell is not None and default_cell is not None:
            raise ValueError("cannot specify both 'cell' and 'default_cell'")
        raw_cell = cell if cell is not None else default_cell

        if raw_cell is not None:
            vector = as_vector3(raw_cell, "default_cell")
            for index, component in enumerate(vector):
                require_positive(component, f"default_cell[{index}]")
            object.__setattr__(self, "default_cell", vector)
        else:
            object.__setattr__(self, "default_cell", None)

        if per_magnet is not None:
            for name, grid in per_magnet.items():
                if not isinstance(name, str) or not name.strip():
                    raise ValueError("per_magnet keys must be non-empty strings")
                if not isinstance(grid, FDMGrid):
                    raise TypeError("per_magnet values must be FDMGrid instances")
        object.__setattr__(self, "per_magnet", per_magnet)
        object.__setattr__(self, "demag", demag)

        # Validate boundary correction
        _BOUNDARY_CORRECTIONS = ("none", "volume", "full")
        if boundary_correction is not None:
            if boundary_correction not in _BOUNDARY_CORRECTIONS:
                raise ValueError(
                    f"boundary_correction must be one of {_BOUNDARY_CORRECTIONS!r}, "
                    f"got {boundary_correction!r}"
                )
        object.__setattr__(self, "boundary_correction", boundary_correction)

        if boundary_phi_floor is not None:
            if not (0.0 < boundary_phi_floor < 1.0):
                raise ValueError(
                    f"boundary_phi_floor must be in (0, 1), got {boundary_phi_floor!r}"
                )
        object.__setattr__(self, "boundary_phi_floor", boundary_phi_floor)

        if boundary_delta_min is not None:
            if boundary_delta_min < 0.0:
                raise ValueError(
                    f"boundary_delta_min must be >= 0, got {boundary_delta_min!r}"
                )
        object.__setattr__(self, "boundary_delta_min", boundary_delta_min)

        # Must have at least one cell specification
        if self.default_cell is None and not self.per_magnet:
            raise ValueError(
                "FDM requires at least 'default_cell' (or legacy 'cell') "
                "or 'per_magnet' grid specifications"
            )

    # Legacy alias
    @property
    def cell(self) -> tuple[float, float, float] | None:
        """Backward-compatible alias for ``default_cell``."""
        return self.default_cell

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {}
        if self.default_cell is not None:
            # Keep backward-compatible 'cell' key for old planner code
            ir["cell"] = list(self.default_cell)
            ir["default_cell"] = list(self.default_cell)
        if self.per_magnet:
            ir["per_magnet"] = {
                name: grid.to_ir() for name, grid in self.per_magnet.items()
            }
        if self.demag is not None:
            ir["demag"] = self.demag.to_ir()
        if self.boundary_correction is not None:
            ir["boundary_correction"] = self.boundary_correction
        if self.boundary_phi_floor is not None:
            ir["boundary_phi_floor"] = self.boundary_phi_floor
        if self.boundary_delta_min is not None:
            ir["boundary_delta_min"] = self.boundary_delta_min
        return ir


# ---------------------------------------------------------------------------
# Swept (through-thickness) mesh controls
# ---------------------------------------------------------------------------
_SWEEP_KINDS = ("uniform", "arithmetic", "geometric")
_SWEEP_DIRECTIONS = ("auto", "x", "y", "z")
_SWEEP_ELEMENT_FAMILIES = ("prism", "hex")
_SWEEP_TRANSITION_POLICIES = ("pyramid_to_tetrahedra", "reject")


@dataclass(frozen=True, slots=True)
class SweepDistribution:
    """Distribution of element layers through the sweep direction.

    Attributes:
        kind: ``"uniform"`` (equal layers), ``"arithmetic"`` (linear growth),
            or ``"geometric"`` (exponential growth).
        num_layers: Number of element layers.
        growth_rate: Growth factor for arithmetic/geometric distributions.
            Ignored for ``"uniform"``.

    Example::

        fm.SweepDistribution(kind="geometric", num_layers=4, growth_rate=1.5)
    """

    kind: Literal["uniform", "arithmetic", "geometric"] = "uniform"
    num_layers: int = 1
    growth_rate: float = 1.0

    def __post_init__(self) -> None:
        if self.kind not in _SWEEP_KINDS:
            raise ValueError(
                f"kind must be one of {_SWEEP_KINDS!r}, got {self.kind!r}"
            )
        if isinstance(self.num_layers, bool) or not isinstance(self.num_layers, int):
            raise TypeError("num_layers must be an integer element-layer count")
        if self.num_layers < 1:
            raise ValueError(f"num_layers must be >= 1, got {self.num_layers}")
        if self.kind != "uniform" and self.growth_rate <= 0.0:
            raise ValueError(
                f"growth_rate must be > 0 for {self.kind!r} distribution, "
                f"got {self.growth_rate}"
            )

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "kind": self.kind,
            "num_layers": self.num_layers,
        }
        if self.kind != "uniform":
            ir["growth_rate"] = self.growth_rate
        return ir


@dataclass(frozen=True, slots=True)
class SweptMeshControls:
    """Controls for swept (through-thickness) meshing of thin-film geometries.

    Swept meshing extrudes a 2-D triangulation through a specified direction,
    producing structured prismatic layers.  This is typically superior to
    full tetrahedral meshing for thin films where in-plane extent greatly
    exceeds thickness.

    Attributes:
        distribution: Layer distribution through the sweep direction.
        sweep_direction: ``"auto"`` resolves from the geometry bounding box
            (shortest axis); ``"x"``, ``"y"``, ``"z"`` force a specific axis.

    Example::

        fm.SweptMeshControls(
            distribution=fm.SweepDistribution(
                kind="geometric", num_layers=4, growth_rate=1.5
            ),
            sweep_direction="z",
        )
    """

    distribution: SweepDistribution = field(default_factory=SweepDistribution)
    sweep_direction: Literal["auto", "x", "y", "z"] = "auto"
    element_family: Literal["prism", "hex"] = "prism"
    transition_policy: Literal["pyramid_to_tetrahedra", "reject"] = "reject"
    exact_layer_count: bool = False

    def __post_init__(self) -> None:
        if self.sweep_direction not in _SWEEP_DIRECTIONS:
            raise ValueError(
                f"sweep_direction must be one of {_SWEEP_DIRECTIONS!r}, "
                f"got {self.sweep_direction!r}"
            )
        if not isinstance(self.distribution, SweepDistribution):
            raise TypeError(
                f"distribution must be a SweepDistribution, "
                f"got {type(self.distribution).__name__}"
            )
        if self.element_family not in _SWEEP_ELEMENT_FAMILIES:
            raise ValueError(
                f"element_family must be one of {_SWEEP_ELEMENT_FAMILIES!r}, "
                f"got {self.element_family!r}"
            )
        if self.transition_policy not in _SWEEP_TRANSITION_POLICIES:
            raise ValueError(
                f"transition_policy must be one of {_SWEEP_TRANSITION_POLICIES!r}, "
                f"got {self.transition_policy!r}"
            )
        if not isinstance(self.exact_layer_count, bool):
            raise TypeError("exact_layer_count must be bool")
        if self.element_family == "hex" and self.transition_policy == "pyramid_to_tetrahedra":
            raise ValueError("hex element_family contradicts pyramid_to_tetrahedra transition")
        if self.exact_layer_count and self.distribution.kind != "uniform":
            raise ValueError("exact_layer_count requires a uniform distribution")

    def to_ir(self) -> dict[str, object]:
        return {
            "sweep_direction": self.sweep_direction,
            "distribution": self.distribution.to_ir(),
            "element_family": self.element_family,
            "transition_policy": self.transition_policy,
            "exact_layer_count": self.exact_layer_count,
        }


# ---------------------------------------------------------------------------
# FEM discretization hints
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True, init=False)
class FEM:
    order: int
    maximum_element_size: float
    mesh: str | None = None
    demag_solver_policy: FemLinearSolverPolicy | None = None

    def __init__(
        self,
        order: int,
        maximum_element_size: float | None = None,
        *,
        hmax: float | None = None,
        mesh: str | None = None,
        demag_solver_policy: FemLinearSolverPolicy | None = None,
    ) -> None:
        resolved_maximum_element_size = (
            maximum_element_size if maximum_element_size is not None else hmax
        )
        if resolved_maximum_element_size is None:
            raise TypeError("FEM requires maximum_element_size")
        if isinstance(maximum_element_size, bool) or isinstance(hmax, bool):
            raise TypeError("maximum_element_size must be a real number, not bool")
        if hmax is not None and maximum_element_size is not None:
            if float(hmax) != float(maximum_element_size):
                raise ValueError("hmax must match maximum_element_size when both are provided")
        object.__setattr__(self, "order", order)
        object.__setattr__(
            self, "maximum_element_size", float(resolved_maximum_element_size)
        )
        object.__setattr__(self, "mesh", mesh)
        object.__setattr__(self, "demag_solver_policy", demag_solver_policy)
        self.__post_init__()

    @property
    def hmax(self) -> float:
        return self.maximum_element_size

    def __post_init__(self) -> None:
        if isinstance(self.order, bool) or not isinstance(self.order, Integral) or self.order < 1:
            raise ValueError("order must be an integer >= 1")
        object.__setattr__(self, "order", int(self.order))
        require_positive(self.maximum_element_size, "maximum_element_size")
        if self.mesh is not None and not self.mesh.strip():
            raise ValueError("mesh must not be empty when provided")

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "order": self.order,
            "hmax": self.maximum_element_size,
            "mesh": self.mesh,
        }
        if self.demag_solver_policy is not None:
            ir["demag_solver_policy"] = self.demag_solver_policy.to_ir()
        return ir


# ---------------------------------------------------------------------------
# Hybrid discretization hints
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Hybrid:
    demag: str

    def __post_init__(self) -> None:
        if not self.demag.strip():
            raise ValueError("demag must not be empty")

    def to_ir(self) -> dict[str, object]:
        return {"demag": self.demag}


# ---------------------------------------------------------------------------
# Composite discretization hints container
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class DiscretizationHints:
    fdm: FDM | None = None
    fem: FEM | None = None
    hybrid: Hybrid | None = None

    def to_ir(self) -> dict[str, object]:
        return {
            "fdm": self.fdm.to_ir() if self.fdm else None,
            "fem": self.fem.to_ir() if self.fem else None,
            "hybrid": self.hybrid.to_ir() if self.hybrid else None,
        }


# ---------------------------------------------------------------------------
# Per-object mesh recipe — fine-grained control per ferromagnet
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class MeshOperation:
    """A single named operation in an object's mesh sequence.

    Mirrors COMSOL 'meshing sequence' operations.  Only ``kind`` is
    required; ``params`` is forwarded verbatim to the mesher backend.

    Supported kinds:
        ``"free_tetrahedral"`` – unstructured tetrahedral fill (default)
        ``"boundary_layers"``  – prismatic boundary-layer extrusion
        ``"refine"``           – uniform h-refinement pass
        ``"adapt"``            – AFEM adaptive refinement
        ``"swept"``            – structured sweep along a path
        ``"size_field"``       – inject an extra Gmsh size field
    """

    kind: Literal[
        "free_tetrahedral",
        "boundary_layers",
        "refine",
        "adapt",
        "swept",
        "size_field",
    ]
    params: dict[str, Any] = field(default_factory=dict)
    enabled: bool = True

    def to_ir(self) -> dict[str, Any]:
        return {"kind": self.kind, "params": dict(self.params), "enabled": self.enabled}


@dataclass(frozen=True, slots=True)
class MeshSizeControls:
    calibrate_for: str | None = None
    size_preset: str | None = None
    maximum_element_size: float | None = None
    minimum_element_size: float | None = None
    maximum_element_growth_rate: float | None = None
    curvature_factor: float | None = None
    narrow_region_resolution: float | None = None

    def to_ir(self) -> dict[str, Any]:
        return {
            "calibrate_for": self.calibrate_for,
            "size_preset": self.size_preset,
            "maximum_element_size": self.maximum_element_size,
            "minimum_element_size": self.minimum_element_size,
            "maximum_element_growth_rate": self.maximum_element_growth_rate,
            "curvature_factor": self.curvature_factor,
            "narrow_region_resolution": self.narrow_region_resolution,
        }


_MESH_SIZE_CALIBRATIONS = (
    "general_physics",
    "micromagnetics_static",
    "micromagnetics_relaxation",
    "micromagnetics_frequency_domain",
    "magnetostatics_dominated",
    "imported_surface_cleanup",
)
_MESH_SIZE_PRESETS = (
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
_MESH_SIZE_PRESET_ALIASES = {
    "extra fine": "extra_fine",
    "extra_fine": "extra_fine",
    "extremely fine": "extremely_fine",
    "extremely_fine": "extremely_fine",
    "extrafine": "extra_fine",
    "extremelyfine": "extremely_fine",
    "very fine": "extra_fine",
    "very_fine": "extra_fine",
    "coarser_mesh": "coarser",
    "extra coarse": "extra_coarse",
    "extra_coarse": "extra_coarse",
    "extremely coarse": "extremely_coarse",
    "extremely_coarse": "extremely_coarse",
    "extracoarse": "extra_coarse",
    "extremelycoarse": "extremely_coarse",
}


def _normalize_mesh_recipe_vocabulary(
    field_name: str,
    value: str | None,
    supported: tuple[str, ...],
    aliases: dict[str, str] | None = None,
) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string or None")
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    if not normalized:
        return None
    if aliases is not None:
        normalized = aliases.get(normalized, normalized)
    if normalized not in supported:
        raise ValueError(f"{field_name} must be one of {supported!r}, got {value!r}")
    return normalized


@dataclass(frozen=True, slots=True)
class PerObjectMeshRecipe:
    """Full mesh recipe for a single ferromagnetic object.

    All fields default to ``None`` which means *inherit from the global*
    :class:`~fullmag.model.discretization.FEM` defaults.  Only non-``None``
    values override the study-level settings.

    Example::

        recipe = fm.PerObjectMeshRecipe(
            maximum_element_size=4e-9,
            size_from_curvature=20,
            boundary_layer_count=3,
            boundary_layer_thickness=2e-9,
            boundary_layer_stretching=1.4,
            optimize="Netgen",
            compute_quality=True,
        )
    """

    # ── element size ──
    maximum_element_size: float | None = None
    minimum_element_size: float | None = None
    hmax: float | None = None
    hmin: float | None = None

    # ── element order / source ──
    order: int | None = None
    source: str | None = None          # path to a pre-built mesh file
    calibrate_for: str | None = None
    size_preset: str | None = None

    # ── algorithms ──
    algorithm_2d: int | None = None
    algorithm_3d: int | None = None

    # ── size controls ──
    size_factor: float | None = None
    size_from_curvature: int | None = None
    curvature_factor: float | None = None
    growth_rate: float | None = None

    # ── topology controls ──
    narrow_regions: int | None = None
    narrow_region_resolution: float | None = None
    smoothing_steps: int | None = None

    # ── optimisation ──
    optimize: str | None = None
    optimize_iters: int | None = None

    # ── boundary layers ──
    boundary_layer_count: int | None = None
    boundary_layer_thickness: float | None = None   # SI metres
    boundary_layer_stretching: float | None = None  # growth ratio (1.0–2.0)

    # ── swept mesh / through-thickness control ──
    mesh_strategy: str | None = None  # "auto" | "free_tetrahedral" | "swept_prism" | "swept_hex"
    through_thickness_elements: int | None = None
    through_thickness_distribution: str | None = None  # "fixed" | "linear" | "exponential"
    through_thickness_element_ratio: float | None = None
    through_thickness_symmetric: bool = False
    sweep_face_meshing: str | None = None  # "triangular" | "quadrilateral"
    topology: str | None = None
    sweep_direction: str | None = None
    element_family: str | None = None
    transition_policy: str | None = None
    exact_layer_count: bool | None = None

    # ── quality assessment ──
    compute_quality: bool | None = None
    per_element_quality: bool | None = None

    # ── extra size fields (appended to global list) ──
    size_fields: list[dict[str, Any]] = field(default_factory=list)

    # ── operation sequence (COMSOL-like) ──
    operations: list[MeshOperation] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.source is not None:
            raise ValueError(
                "per-object mesh source is unavailable; use FEM(mesh=...) for "
                "the supported study-level imported mesh route"
            )

        object.__setattr__(
            self,
            "calibrate_for",
            _normalize_mesh_recipe_vocabulary(
                "calibrate_for", self.calibrate_for, _MESH_SIZE_CALIBRATIONS
            ),
        )
        object.__setattr__(
            self,
            "size_preset",
            _normalize_mesh_recipe_vocabulary(
                "size_preset",
                self.size_preset,
                _MESH_SIZE_PRESETS,
                _MESH_SIZE_PRESET_ALIASES,
            ),
        )

        if self.order is not None:
            if isinstance(self.order, bool) or not isinstance(self.order, Integral):
                raise TypeError("order must be an integer")
            object.__setattr__(self, "order", int(self.order))

        for field_name in ("algorithm_2d", "algorithm_3d"):
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, Integral):
                raise TypeError(f"{field_name} must be an integer")
            object.__setattr__(self, field_name, int(value))

        if not isinstance(self.through_thickness_symmetric, bool):
            raise TypeError("through_thickness_symmetric must be a boolean")

        for field_name in (
            "maximum_element_size",
            "minimum_element_size",
            "hmax",
            "hmin",
        ):
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, Real):
                raise TypeError(f"{field_name} must be a positive number")
            require_positive(value, field_name)

        effective_maximum = (
            self.maximum_element_size
            if self.maximum_element_size is not None
            else self.hmax
        )
        effective_minimum = (
            self.minimum_element_size
            if self.minimum_element_size is not None
            else self.hmin
        )
        if (
            effective_minimum is not None
            and effective_maximum is not None
            and effective_minimum > effective_maximum
        ):
            raise ValueError(
                "minimum_element_size/hmin must not exceed maximum_element_size/hmax"
            )

        for field_name in (
            "size_factor",
            "curvature_factor",
            "growth_rate",
            "narrow_region_resolution",
            "boundary_layer_thickness",
            "boundary_layer_stretching",
            "through_thickness_element_ratio",
        ):
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, Real):
                raise TypeError(f"{field_name} must be a positive number")
            require_positive(value, field_name)

        for field_name in ("size_from_curvature", "narrow_regions"):
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, Integral):
                raise TypeError(f"{field_name} must be an integer")
            if value < 0:
                raise ValueError(f"{field_name} must be >= 0")
            object.__setattr__(self, field_name, int(value))

        for field_name in ("optimize_iters", "boundary_layer_count"):
            value = getattr(self, field_name)
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, Integral):
                raise TypeError(f"{field_name} must be an integer")
            if value < 1:
                raise ValueError(f"{field_name} must be >= 1")
            object.__setattr__(self, field_name, int(value))
            object.__setattr__(self, field_name, int(value))

        if self.smoothing_steps is not None:
            if isinstance(self.smoothing_steps, bool) or not isinstance(
                self.smoothing_steps, Integral
            ):
                raise TypeError("smoothing_steps must be an integer")
            if self.smoothing_steps < 0:
                raise ValueError("smoothing_steps must be >= 0")
            object.__setattr__(self, "smoothing_steps", int(self.smoothing_steps))
            object.__setattr__(self, "smoothing_steps", int(self.smoothing_steps))

        if self.through_thickness_elements is not None:
            if (
                isinstance(self.through_thickness_elements, bool)
                or not isinstance(self.through_thickness_elements, int)
            ):
                raise TypeError("through_thickness_elements must be an integer")
            if self.through_thickness_elements < 1:
                raise ValueError("through_thickness_elements must be >= 1")
        if self.mesh_strategy not in {
            None,
            "auto",
            "free_tetrahedral",
            "thin_film_tetrahedral",
            "swept_prism",
            "swept_hex",
        }:
            raise ValueError("mesh_strategy is not a supported mesh recipe")
        if self.through_thickness_distribution not in {
            None,
            "fixed",
            "linear",
            "exponential",
        }:
            raise ValueError("through_thickness_distribution is invalid")
        if self.sweep_face_meshing not in {None, "triangular", "quadrilateral"}:
            raise ValueError("sweep_face_meshing must be 'triangular' or 'quadrilateral'")
        if self.topology not in {None, "tetrahedral", "prismatic"}:
            raise ValueError("topology must be 'tetrahedral' or 'prismatic'")
        if self.sweep_direction not in {None, "auto", "x", "y", "z"}:
            raise ValueError("sweep_direction must be 'auto', 'x', 'y', or 'z'")
        if self.element_family not in {None, "prism", "hex"}:
            raise ValueError("element_family must be 'prism' or 'hex'")
        if self.transition_policy not in {None, "pyramid_to_tetrahedra", "reject"}:
            raise ValueError(
                "transition_policy must be 'pyramid_to_tetrahedra' or 'reject'"
            )
        if self.exact_layer_count is not None and not isinstance(
            self.exact_layer_count, bool
        ):
            raise TypeError("exact_layer_count must be bool")
        for field_name in ("compute_quality", "per_element_quality"):
            value = getattr(self, field_name)
            if value is not None and not isinstance(value, bool):
                raise TypeError(f"{field_name} must be bool")

        if self.topology == "tetrahedral" and any(
            value is not None
            for value in (
                self.sweep_direction,
                self.element_family,
                self.transition_policy,
                self.exact_layer_count,
            )
        ):
            raise ValueError("tetrahedral topology contradicts swept element intent")
        if self.element_family == "prism" or self.topology == "prismatic":
            if self.order not in {None, 1}:
                raise ValueError("prismatic mesh supports order=1 only")
            if self.mesh_strategy != "swept_prism":
                raise ValueError("prismatic mesh requires mesh_strategy='swept_prism'")
            if self.sweep_face_meshing != "triangular":
                raise ValueError("prismatic mesh requires triangular source faces")
            if self.exact_layer_count is False:
                raise ValueError("strict prismatic mesh requires exact_layer_count=True")
        if self.topology == "prismatic" and self.transition_policy != "pyramid_to_tetrahedra":
            raise ValueError(
                "prismatic thin-film topology requires pyramid_to_tetrahedra transition"
            )
        if self.element_family == "hex":
            if self.mesh_strategy != "swept_hex":
                raise ValueError("hex mesh requires mesh_strategy='swept_hex'")
            if self.sweep_face_meshing != "quadrilateral":
                raise ValueError("hex mesh requires quadrilateral source faces")
            if self.transition_policy == "pyramid_to_tetrahedra":
                raise ValueError("hex mesh contradicts pyramid_to_tetrahedra transition")

        layered_requested = self.mesh_strategy in {"swept_prism", "swept_hex"} or any(
            value is not None
            for value in (
                self.topology,
                self.sweep_direction,
                self.element_family,
                self.transition_policy,
                self.exact_layer_count,
            )
        )
        if layered_requested:
            required = {
                "through_thickness_elements": self.through_thickness_elements,
                "through_thickness_distribution": self.through_thickness_distribution,
                "sweep_face_meshing": self.sweep_face_meshing,
                "sweep_direction": self.sweep_direction,
                "element_family": self.element_family,
                "transition_policy": self.transition_policy,
                "exact_layer_count": self.exact_layer_count,
            }
            missing = [name for name, value in required.items() if value is None]
            if missing:
                raise ValueError(
                    "layered mesh recipe is incomplete: " + ", ".join(missing)
                )

    def to_ir(self) -> dict[str, Any]:
        resolved_maximum_element_size = (
            self.maximum_element_size if self.maximum_element_size is not None else self.hmax
        )
        resolved_minimum_element_size = (
            self.minimum_element_size if self.minimum_element_size is not None else self.hmin
        )
        return {
            "hmax": resolved_maximum_element_size,
            "hmin": resolved_minimum_element_size,
            "maximum_element_size": resolved_maximum_element_size,
            "minimum_element_size": resolved_minimum_element_size,
            "order": self.order,
            "source": self.source,
            "calibrate_for": self.calibrate_for,
            "size_preset": self.size_preset,
            "algorithm_2d": self.algorithm_2d,
            "algorithm_3d": self.algorithm_3d,
            "size_factor": self.size_factor,
            "size_from_curvature": self.size_from_curvature,
            "curvature_factor": self.curvature_factor,
            "growth_rate": self.growth_rate,
            "narrow_regions": self.narrow_regions,
            "narrow_region_resolution": self.narrow_region_resolution,
            "smoothing_steps": self.smoothing_steps,
            "optimize": self.optimize,
            "optimize_iters": self.optimize_iters,
            "boundary_layer_count": self.boundary_layer_count,
            "boundary_layer_thickness": self.boundary_layer_thickness,
            "boundary_layer_stretching": self.boundary_layer_stretching,
            "mesh_strategy": self.mesh_strategy,
            "through_thickness_elements": self.through_thickness_elements,
            "through_thickness_distribution": self.through_thickness_distribution,
            "through_thickness_element_ratio": self.through_thickness_element_ratio,
            "through_thickness_symmetric": self.through_thickness_symmetric,
            "sweep_face_meshing": self.sweep_face_meshing,
            "topology": self.topology,
            "sweep_direction": self.sweep_direction,
            "element_family": self.element_family,
            "transition_policy": self.transition_policy,
            "exact_layer_count": self.exact_layer_count,
            "compute_quality": self.compute_quality,
            "per_element_quality": self.per_element_quality,
            "size_fields": list(self.size_fields),
            "operations": [op.to_ir() for op in self.operations],
        }


# ---------------------------------------------------------------------------
# Shared-domain mesh assembly policy
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class SharedMeshAssemblyPolicy:
    """Preserved compatibility record for shared-domain assembly policy.

    The current shared-domain builder accepts this object for API compatibility
    but does not consume its fields. Use explicit object, interface, and airbox
    targets for effective sizing.

    Attributes:
        interface_hmax_factor: Validated, preserved compatibility value.
        enforce_conforming: Preserved compatibility value.
        airbox_hmax_factor: Validated, preserved compatibility value.
    """

    interface_hmax_factor: float = 0.5
    enforce_conforming: bool = True
    airbox_hmax_factor: float = 3.0

    def __post_init__(self) -> None:
        for field_name in ("interface_hmax_factor", "airbox_hmax_factor"):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, Real):
                raise TypeError(f"{field_name} must be a real number")
            require_finite(value, field_name)
        if not isinstance(self.enforce_conforming, bool):
            raise TypeError("enforce_conforming must be a boolean")
        if not 0.0 < self.interface_hmax_factor <= 1.0:
            raise ValueError("interface_hmax_factor must be in (0, 1]")
        require_positive(self.airbox_hmax_factor, "airbox_hmax_factor")

    def to_ir(self) -> dict[str, object]:
        return {
            "interface_hmax_factor": self.interface_hmax_factor,
            "enforce_conforming": self.enforce_conforming,
            "airbox_hmax_factor": self.airbox_hmax_factor,
        }
