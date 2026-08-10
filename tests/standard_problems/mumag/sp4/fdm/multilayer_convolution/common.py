"""Immutable constants for the non-canonical SP4-derived multilayer study."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[6]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from tests.standard_problems.mumag.sp4.common.contract import CONTRACT


QUALIFICATION_SCOPE = "SP4-derived, not canonical SP4 qualification"
FILM_CELLS = (128, 32, 1)
FILM_CELL_M = (3.90625e-9, 3.90625e-9, 3e-9)
GRID_ALIGNED_GAPS_M = (3e-9, 6e-9, 12e-9, 24e-9)
OFF_GRID_GAP_LABEL = "push_pull_off_grid_only"
AIRBOX_PADDING_CELLS = (3, 6, 12)
AIRBOX_SAMPLE_OFFSETS_CELLS = (1, 2, 4)
AIRBOX_SAMPLE_LOCATIONS = ("center", "long_edge", "short_edge")
AIRBOX_H_EFF_REASON = "fdm_multilayer_airbox_h_eff_unavailable.v1"
AIRBOX_COORDINATE_SYSTEM = "cartesian_si"
AIRBOX_ORIGIN_RULE = (
    "x/y origin equals the lower support bounds; z origin equals the lower "
    "support bound minus selected symmetric padding"
)
AIRBOX_CELL_CENTER_RULE = "center(i,j,k) = origin + (i+0.5,j+0.5,k+0.5)*spacing"
AIRBOX_PADDING_RULE = "selected N cells are reserved on both +z and -z sides of every support"
AIRBOX_SAMPLE_RULE = (
    "sample at the centre, long-edge, and short-edge support normals at "
    "1, 2, and 4 cell-center offsets; no sample lies on a cell boundary"
)


@dataclass(frozen=True)
class CanonicalSp4Frozen:
    """Material, dynamics, and applied fields frozen from the canonical contract."""

    dimensions_m: tuple[float, float, float]
    ms_a_per_m: float
    aex_j_per_m: float
    alpha: float
    gamma_mu0_m_per_as: float
    initial_m: tuple[float, float, float]
    cases: tuple[tuple[str, tuple[float, float, float]], ...]
    sample_period_s: float
    minimum_duration_s: float
    equilibrium_window_s: float
    maximum_duration_s: float
    meshes: tuple[tuple[str, float], ...]
    airboxes: tuple[tuple[str, tuple[float, float, float], float], ...]


@dataclass(frozen=True)
class BilayerScenario:
    film_dimensions_m: tuple[float, float, float]
    cells: tuple[int, int, int]
    cell_m: tuple[float, float, float]
    center_separation_m: float
    vacuum_gap_m: float
    inter_object_exchange: str
    provenance: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class AirboxObservationScenario:
    cells_xy: tuple[int, int]
    spacing_z_m: float
    padding_cells_above_below: tuple[int, ...]
    sample_offsets_cells: tuple[int, ...]
    sample_locations: tuple[str, ...]
    scope_kind: str
    published_quantities: tuple[str, ...]
    unavailable_quantities: tuple[tuple[str, str], ...]
    coordinate_system: str
    origin_rule: str
    cell_center_rule: str
    padding_rule: str
    sample_rule: str
    sample_anchor_indices: tuple[tuple[str, tuple[int, int]], ...]
    sample_anchor_rule: str
    target_only: bool


CANONICAL_SP4 = CanonicalSp4Frozen(
    dimensions_m=(500e-9, 125e-9, 3e-9),
    ms_a_per_m=8e5,
    aex_j_per_m=1.3e-11,
    alpha=0.02,
    gamma_mu0_m_per_as=2.211e5,
    initial_m=(0.9950371902099893, 0.09950371902099893, 0.0),
    cases=(
        ("case-a", (-24.6e-3, 4.3e-3, 0.0)),
        ("case-b", (-35.5e-3, -6.3e-3, 0.0)),
    ),
    sample_period_s=1e-12,
    minimum_duration_s=1e-9,
    equilibrium_window_s=50e-12,
    maximum_duration_s=5e-9,
    meshes=(
        ("coarse", 3e-9),
        ("medium", 2e-9),
        ("fine", 1.5e-9),
    ),
    airboxes=(
        ("baseline", (700e-9, 250e-9, 250e-9), 20e-9),
        ("expanded", (1000e-9, 500e-9, 500e-9), 20e-9),
    ),
)


BILAYER = BilayerScenario(
    film_dimensions_m=CONTRACT.dimensions_m,
    cells=FILM_CELLS,
    cell_m=FILM_CELL_M,
    center_separation_m=9e-9,
    vacuum_gap_m=6e-9,
    inter_object_exchange="disabled",
    provenance=(
        ("inter_object_exchange", "disabled"),
        ("exchange_topology", "disconnected_films"),
    ),
)

AIRBOX_OBSERVATION = AirboxObservationScenario(
    cells_xy=(128, 32),
    spacing_z_m=3e-9,
    padding_cells_above_below=AIRBOX_PADDING_CELLS,
    sample_offsets_cells=AIRBOX_SAMPLE_OFFSETS_CELLS,
    sample_locations=AIRBOX_SAMPLE_LOCATIONS,
    scope_kind="airbox",
    published_quantities=("H_demag",),
    unavailable_quantities=(("H_eff", AIRBOX_H_EFF_REASON),),
    coordinate_system=AIRBOX_COORDINATE_SYSTEM,
    origin_rule=AIRBOX_ORIGIN_RULE,
    cell_center_rule=AIRBOX_CELL_CENTER_RULE,
    padding_rule=AIRBOX_PADDING_RULE,
    sample_rule=AIRBOX_SAMPLE_RULE,
    sample_anchor_indices=(
        ("center", (64, 16)),
        ("long_edge", (64, 31)),
        ("short_edge", (127, 16)),
    ),
    sample_anchor_rule=(
        "zero-based XY anchor cells: center=(64,16), long-edge=(64,31) "
        "on the y-normal edge, short-edge=(127,16) on the x-normal edge"
    ),
    target_only=True,
)
