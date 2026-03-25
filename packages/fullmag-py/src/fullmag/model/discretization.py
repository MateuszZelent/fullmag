from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

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

    # --- backward compatibility: FDM(cell=(...)) --------------------------
    def __init__(
        self,
        *,
        cell: Sequence[float] | None = None,
        default_cell: Sequence[float] | None = None,
        per_magnet: dict[str, FDMGrid] | None = None,
        demag: FDMDemag | None = None,
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
        return ir


# ---------------------------------------------------------------------------
# FEM discretization hints
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class FEM:
    order: int
    hmax: float
    mesh: str | None = None

    def __post_init__(self) -> None:
        if self.order < 1:
            raise ValueError("order must be >= 1")
        require_positive(self.hmax, "hmax")
        if self.mesh is not None and not self.mesh.strip():
            raise ValueError("mesh must not be empty when provided")

    def to_ir(self) -> dict[str, object]:
        return {
            "order": self.order,
            "hmax": self.hmax,
            "mesh": self.mesh,
        }


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
