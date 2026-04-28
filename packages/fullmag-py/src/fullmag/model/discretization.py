from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Sequence

from fullmag._validation import as_vector3, require_positive


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
        allow_single_grid_fallback: If ``True`` the planner may silently
            fall back to ``single_grid`` when multilayer is ineligible.
            Default ``False`` — an error is raised instead.
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
    allow_single_grid_fallback: bool = False
    explain: bool = True

    def __post_init__(self) -> None:
        if self.strategy not in _DEMAG_STRATEGIES:
            raise ValueError(
                f"strategy must be one of {_DEMAG_STRATEGIES!r}, "
                f"got {self.strategy!r}"
            )
        if self.mode not in _DEMAG_MODES:
            raise ValueError(
                f"mode must be one of {_DEMAG_MODES!r}, got {self.mode!r}"
            )
        if self.common_cells is not None:
            if len(self.common_cells) != 3:
                raise ValueError("common_cells must have exactly 3 elements")
            for v in self.common_cells:
                if not isinstance(v, int) or v <= 0:
                    raise ValueError("common_cells values must be positive ints")
        if self.common_cells_xy is not None:
            if len(self.common_cells_xy) != 2:
                raise ValueError("common_cells_xy must have exactly 2 elements")
            for v in self.common_cells_xy:
                if not isinstance(v, int) or v <= 0:
                    raise ValueError("common_cells_xy values must be positive ints")

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "strategy": self.strategy,
            "mode": self.mode,
            "allow_single_grid_fallback": self.allow_single_grid_fallback,
        }
        if self.common_cells is not None:
            ir["common_cells"] = list(self.common_cells)
        if self.common_cells_xy is not None:
            ir["common_cells_xy"] = list(self.common_cells_xy)
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

    def to_ir(self) -> dict[str, object]:
        return {
            "sweep_direction": self.sweep_direction,
            "distribution": self.distribution.to_ir(),
        }


# ---------------------------------------------------------------------------
# FEM discretization hints
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class FEM:
    order: int
    hmax: float
    mesh: str | None = None
    demag_solver_policy: FemLinearSolverPolicy | None = None

    def __post_init__(self) -> None:
        if self.order < 1:
            raise ValueError("order must be >= 1")
        require_positive(self.hmax, "hmax")
        if self.mesh is not None and not self.mesh.strip():
            raise ValueError("mesh must not be empty when provided")

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "order": self.order,
            "hmax": self.hmax,
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


@dataclass(frozen=True, slots=True)
class PerObjectMeshRecipe:
    """Full mesh recipe for a single ferromagnetic object.

    All fields default to ``None`` which means *inherit from the global*
    :class:`~fullmag.model.discretization.FEM` defaults.  Only non-``None``
    values override the study-level settings.

    Example::

        recipe = fm.PerObjectMeshRecipe(
            hmax=4e-9,
            size_from_curvature=20,
            boundary_layer_count=3,
            boundary_layer_thickness=2e-9,
            boundary_layer_stretching=1.4,
            optimize="Netgen",
            compute_quality=True,
        )
    """

    # ── element size ──
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

    # ── quality assessment ──
    compute_quality: bool = False
    per_element_quality: bool = False

    # ── extra size fields (appended to global list) ──
    size_fields: list[dict[str, Any]] = field(default_factory=list)

    # ── operation sequence (COMSOL-like) ──
    operations: list[MeshOperation] = field(default_factory=list)

    def to_ir(self) -> dict[str, Any]:
        return {
            "hmax": self.hmax,
            "hmin": self.hmin,
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
    """Controls how per-object recipes are assembled into one shared-domain mesh.

    Attributes:
        interface_hmax_factor: Size factor at domain interfaces relative to
            the local object hmax (< 1 = finer at boundaries).
        enforce_conforming: Require a conforming mesh (shared vertices at
            domain boundaries) via OCC ``fragment``.
        airbox_hmax_factor: Element size in the airbox as a multiple of the
            global hmax.  Larger = coarser airbox.
    """

    interface_hmax_factor: float = 0.5
    enforce_conforming: bool = True
    airbox_hmax_factor: float = 3.0

    def __post_init__(self) -> None:
        if not 0.0 < self.interface_hmax_factor <= 1.0:
            raise ValueError("interface_hmax_factor must be in (0, 1]")
        if self.airbox_hmax_factor <= 0.0:
            raise ValueError("airbox_hmax_factor must be positive")

    def to_ir(self) -> dict[str, object]:
        return {
            "interface_hmax_factor": self.interface_hmax_factor,
            "enforce_conforming": self.enforce_conforming,
            "airbox_hmax_factor": self.airbox_hmax_factor,
        }
