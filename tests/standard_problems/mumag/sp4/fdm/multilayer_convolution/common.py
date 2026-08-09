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
)
