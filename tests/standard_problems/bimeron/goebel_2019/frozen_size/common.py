"""Shared configuration and geometry helpers for the frozen-spin sweep.

The texture is the same Göbel-style bimeron used by the rDMI standard
problem.  ``target_radius_nm`` is the requested zero-crossing radius of the
initial texture.  The public preset parameter is derived from that target so
that the measured radius, rather than the preset argument, remains the
quantity reported by the analysis.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import math
import os
from typing import Any

from tests.standard_problems.bimeron.goebel_2019.common import (
    AEX,
    ALPHA,
    BIMERON_WALL_WIDTH,
    CELL,
    D_ROTATED,
    HOLD_SAMPLE_PERIOD,
    HOLD_TIME,
    KU_X,
    LLG_DT,
    MS,
    RELAX_FIELD_EVERY_STEPS,
    RELAX_MAX_STEPS,
    RELAX_TIME,
    TRACK_SIZE,
)

TEMPERATURE = 0.0
DEFAULT_CELL_NM = CELL[0] * 1e9
DEFAULT_WALL_WIDTH_NM = BIMERON_WALL_WIDTH * 1e9
DEFAULT_PIN_RADIUS_NM = 0.5
DEFAULT_RING_WIDTH_NM = 0.5
DEFAULT_RELAX_TIME_S = RELAX_TIME
DEFAULT_HOLD_TIME_S = HOLD_TIME
DEFAULT_RELEASE_TIME_S = 2e-11
DEFAULT_DT_S = LLG_DT
DEFAULT_RELAX_TOL_T = 1e-5
DEFAULT_RELAX_MAX_STEPS = RELAX_MAX_STEPS
DEFAULT_RELEASE_MAX_STEPS = 8000
DEFAULT_FIELD_EVERY_STEPS = RELAX_FIELD_EVERY_STEPS
DEFAULT_HOLD_SAMPLE_PERIOD_S = HOLD_SAMPLE_PERIOD


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return float(default)
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return value


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return int(default)
    value = int(raw)
    return value


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be boolean")


def contour_minimum_radius_m(wall_width_m: float) -> float:
    """Smallest contour radius represented by the bimeron profile.

    For ``theta(rho)=pi/2`` the analytic relation is
    ``R = w*asinh(cosh(rho/w))``.  At ``rho=0`` this is ``w*asinh(1)``.
    """

    return wall_width_m * math.asinh(1.0)


def preset_radius_for_contour(target_radius_m: float, wall_width_m: float) -> float:
    """Invert the source bimeron profile to obtain its ``radius`` parameter."""

    if target_radius_m <= 0.0 or wall_width_m <= 0.0:
        raise ValueError("target_radius_m and wall_width_m must be positive")
    minimum = contour_minimum_radius_m(wall_width_m)
    if target_radius_m < minimum * (1.0 - 1e-12):
        raise ValueError(
            "target radius is below the analytic contour minimum for this wall width: "
            f"target={target_radius_m * 1e9:.6g} nm, minimum={minimum * 1e9:.6g} nm"
        )
    # acosh(sinh(x)) is monotone for x >= asinh(1).  Clamp the argument only
    # against roundoff at the lower endpoint; a requested invalid target has
    # already been rejected above.
    argument = max(1.0, math.sinh(target_radius_m / wall_width_m))
    return wall_width_m * math.acosh(argument)


def contour_radius_from_preset(preset_radius_m: float, wall_width_m: float) -> float:
    if preset_radius_m < 0.0 or wall_width_m <= 0.0:
        raise ValueError("preset_radius_m must be non-negative and wall_width_m positive")
    return wall_width_m * math.asinh(math.cosh(preset_radius_m / wall_width_m))


def nominal_core_centres_m(preset_radius_m: float, wall_width_m: float) -> tuple[tuple[float, float], tuple[float, float]]:
    """Return the analytic ±m_z extrema positions used for static pin masks.

    The source texture has its two opposite out-of-plane extrema on the x
    axis at the same radial coordinate as the ``m_x=0`` contour.  The runtime
    analysis measures the discrete extrema independently and records any
    grid-phase displacement.
    """

    rho = contour_radius_from_preset(preset_radius_m, wall_width_m)
    return ((-rho, 0.0), (rho, 0.0))


def _bimeron_mz(
    x_m: float,
    y_m: float,
    preset_radius_m: float,
    wall_width_m: float,
    *,
    helicity_rad: float,
    vorticity: int,
    background_sign: int,
) -> float:
    """Evaluate the public bimeron preset's out-of-plane component.

    The selector is authored before the solver has a sampled field.  Reusing
    the preset equation here makes the pin centres deterministic while still
    selecting actual cell centres on the requested grid.
    """

    radius = math.hypot(x_m, y_m)
    theta = math.asin(math.tanh((radius - preset_radius_m) / wall_width_m)) + math.asin(
        math.tanh((radius + preset_radius_m) / wall_width_m)
    )
    phase = vorticity * math.atan2(y_m, x_m) + helicity_rad
    return -background_sign * math.sin(theta) * math.cos(phase)


def _discrete_core_extrema_m(
    preset_radius_m: float,
    wall_width_m: float,
    cell_m: float,
    *,
    helicity_rad: float,
    vorticity: int,
    background_sign: int,
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    if preset_radius_m <= 0.0 or wall_width_m <= 0.0 or cell_m <= 0.0:
        raise ValueError("preset_radius_m, wall_width_m, and cell_m must be positive")
    if not math.isfinite(helicity_rad):
        raise ValueError("helicity_rad must be finite")
    if vorticity not in {-1, 1}:
        raise ValueError("vorticity must be -1 or 1")
    if background_sign not in {-1, 1}:
        raise ValueError("background_sign must be -1 or 1")

    length_x, length_y, _length_z = TRACK_SIZE
    nx = round(length_x / cell_m)
    ny = round(length_y / cell_m)
    if nx <= 0 or ny <= 0:
        raise ValueError("cell_m does not resolve the bimeron track")
    target_radius_m = contour_radius_from_preset(preset_radius_m, wall_width_m)
    search_radius_m = max(target_radius_m + 4.0 * wall_width_m, 4.0 * cell_m)
    half_x = min(0.5 * length_x - 0.5 * cell_m, search_radius_m)
    half_y = min(0.5 * length_y - 0.5 * cell_m, search_radius_m)
    samples: list[tuple[float, float, float]] = []
    for iy in range(ny):
        y_m = (iy + 0.5) * cell_m - 0.5 * length_y
        if abs(y_m) > half_y + 1e-15:
            continue
        for ix in range(nx):
            x_m = (ix + 0.5) * cell_m - 0.5 * length_x
            if abs(x_m) > half_x + 1e-15:
                continue
            samples.append(
                (
                    x_m,
                    y_m,
                    _bimeron_mz(
                        x_m,
                        y_m,
                        preset_radius_m,
                        wall_width_m,
                        helicity_rad=helicity_rad,
                        vorticity=vorticity,
                        background_sign=background_sign,
                    ),
                )
            )
    if not samples:
        raise ValueError("no cell centres available for discrete bimeron extrema")
    minimum = min(samples, key=lambda item: (item[2], abs(item[0]) + abs(item[1]), item[0], item[1]))
    maximum = max(samples, key=lambda item: (item[2], -(abs(item[0]) + abs(item[1])), -item[0], -item[1]))
    if minimum[:2] == maximum[:2]:
        raise ValueError("discrete bimeron extrema collapsed to one cell")
    return tuple(sorted((minimum, maximum), key=lambda item: (item[0], item[1])))  # type: ignore[return-value]


def discrete_core_centres_m(
    preset_radius_m: float,
    wall_width_m: float,
    cell_m: float,
    *,
    helicity_rad: float = 0.0,
    vorticity: int = 1,
    background_sign: int = 1,
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Return cell-centre pin locations at the sampled ``m_z`` extrema.

    The extrema are evaluated on the same cell-centre lattice as the FDM
    selector.  This removes a hidden sub-cell phase choice from P2/P3 while
    retaining the physical pin radius.
    """

    extrema = _discrete_core_extrema_m(
        preset_radius_m,
        wall_width_m,
        cell_m,
        helicity_rad=helicity_rad,
        vorticity=vorticity,
        background_sign=background_sign,
    )
    return tuple((x_m, y_m) for x_m, y_m, _mz in extrema)  # type: ignore[return-value]


@dataclass(frozen=True)
class FrozenCase:
    target_radius_nm: float
    preset_radius_nm: float
    wall_width_nm: float
    cell_nm: float
    pin_radius_nm: float
    ring_width_nm: float
    protocol: str
    helicity_rad: float
    vorticity: int
    background_sign: int
    include_release: bool
    relax_time_s: float
    hold_time_s: float
    release_time_s: float
    dt_s: float
    relax_tol_T: float
    relax_max_steps: int
    release_max_steps: int
    field_every_steps: int
    hold_sample_period_s: float
    pin_centres_nm: tuple[tuple[float, float], tuple[float, float]] | None = None

    @property
    def cell_m(self) -> tuple[float, float, float]:
        cell = self.cell_nm * 1e-9
        return (cell, cell, cell)

    @property
    def target_radius_m(self) -> float:
        return self.target_radius_nm * 1e-9

    @property
    def preset_radius_m(self) -> float:
        return self.preset_radius_nm * 1e-9

    @property
    def wall_width_m(self) -> float:
        return self.wall_width_nm * 1e-9

    @property
    def pin_radius_m(self) -> float:
        return self.pin_radius_nm * 1e-9

    @property
    def ring_width_m(self) -> float:
        return self.ring_width_nm * 1e-9

    @property
    def core_centres_m(self) -> tuple[tuple[float, float], tuple[float, float]]:
        """Return the static core-pin centres for this case."""

        if self.pin_centres_nm is not None:
            return tuple(
                (x_nm * 1e-9, y_nm * 1e-9)
                for x_nm, y_nm in self.pin_centres_nm
            )  # type: ignore[return-value]
        return discrete_core_centres_m(
            self.preset_radius_m,
            self.wall_width_m,
            self.cell_m[0],
            helicity_rad=self.helicity_rad,
            vorticity=self.vorticity,
            background_sign=self.background_sign,
        )

    @property
    def case_id(self) -> str:
        return (
            f"R{self.target_radius_nm:g}nm-w{self.wall_width_nm:g}nm-"
            f"h{self.cell_nm:g}nm-{self.protocol}-a{self.pin_radius_nm:g}nm"
        ).replace(".", "p")

    def metadata(self) -> dict[str, Any]:
        value = asdict(self)
        centres = self.core_centres_m
        value.update(
            {
                "case_id": self.case_id,
                "target_radius_m": self.target_radius_m,
                "preset_radius_m": self.preset_radius_m,
                "wall_width_m": self.wall_width_m,
                "pin_radius_m": self.pin_radius_m,
                "ring_width_m": self.ring_width_m,
                "analytic_contour_radius_nm": contour_radius_from_preset(
                    self.preset_radius_m, self.wall_width_m
                )
                * 1e9,
                "nominal_core_centres_nm": [
                    [x * 1e9, y * 1e9]
                    for x, y in nominal_core_centres_m(
                        self.preset_radius_m, self.wall_width_m
                    )
                ],
                "discrete_core_centres_nm": [
                    [x * 1e9, y * 1e9]
                    for x, y in centres
                ],
                "core_centres_source": (
                    "baseline_measured_mz_extrema.v1"
                    if self.pin_centres_nm is not None
                    else "discrete_initial_mz_extrema_on_cell_centres.v1"
                ),
            }
        )
        value["pin_centres_nm"] = (
            [[float(x), float(y)] for x, y in self.pin_centres_nm]
            if self.pin_centres_nm is not None
            else None
        )
        return value


def case_from_environment() -> FrozenCase:
    target_radius_nm = _env_float("FULLMAG_BIMERON_TARGET_R_NM", 5.0)
    wall_width_nm = _env_float(
        "FULLMAG_BIMERON_WALL_WIDTH_NM", DEFAULT_WALL_WIDTH_NM
    )
    target_radius_m = target_radius_nm * 1e-9
    wall_width_m = wall_width_nm * 1e-9
    preset_radius_nm = preset_radius_for_contour(target_radius_m, wall_width_m) * 1e9
    cell_nm = _env_float("FULLMAG_BIMERON_CELL_NM", DEFAULT_CELL_NM)
    pin_radius_nm = _env_float(
        "FULLMAG_BIMERON_PIN_RADIUS_NM", DEFAULT_PIN_RADIUS_NM
    )
    if cell_nm <= 0.0 or pin_radius_nm <= 0.0:
        raise ValueError("cell and pin radii must be positive")
    if pin_radius_nm * 1e-9 < cell_nm * 1e-9 / math.sqrt(2.0):
        raise ValueError(
            "pin radius is smaller than one-cell diagonal coverage; choose "
            "FULLMAG_BIMERON_PIN_RADIUS_NM >= cell_nm/sqrt(2)"
        )
    protocol = os.environ.get("FULLMAG_BIMERON_PROTOCOL", "p3").strip().lower()
    aliases = {"none": "p0", "two_pins": "p2", "three_pins": "p3", "annulus": "ring"}
    protocol = aliases.get(protocol, protocol)
    if protocol not in {"p0", "p2", "p3", "ring"}:
        raise ValueError("FULLMAG_BIMERON_PROTOCOL must be p0, p2, p3, or ring")
    vorticity = _env_int("FULLMAG_BIMERON_VORTICITY", -1)
    background_sign = _env_int("FULLMAG_BIMERON_BACKGROUND_SIGN", 1)
    if vorticity not in {-1, 1}:
        raise ValueError("FULLMAG_BIMERON_VORTICITY must be -1 or 1")
    if background_sign not in {-1, 1}:
        raise ValueError("FULLMAG_BIMERON_BACKGROUND_SIGN must be -1 or 1")
    ring_width_nm = _env_float(
        "FULLMAG_BIMERON_RING_WIDTH_NM", DEFAULT_RING_WIDTH_NM
    )
    helicity_rad = _env_float("FULLMAG_BIMERON_HELICITY_RAD", 0.0)
    include_release = _env_bool("FULLMAG_BIMERON_RELEASE", False)
    relax_time_s = _env_float("FULLMAG_BIMERON_RELAX_TIME_S", DEFAULT_RELAX_TIME_S)
    hold_time_s = _env_float("FULLMAG_BIMERON_HOLD_TIME_S", DEFAULT_HOLD_TIME_S)
    release_time_s = _env_float(
        "FULLMAG_BIMERON_RELEASE_TIME_S", DEFAULT_RELEASE_TIME_S
    )
    dt_s = _env_float("FULLMAG_BIMERON_DT_S", DEFAULT_DT_S)
    relax_tol_T = _env_float("FULLMAG_BIMERON_TOL_T", DEFAULT_RELAX_TOL_T)
    relax_max_steps = _env_int(
        "FULLMAG_BIMERON_RELAX_MAX_STEPS", DEFAULT_RELAX_MAX_STEPS
    )
    release_max_steps = _env_int(
        "FULLMAG_BIMERON_RELEASE_MAX_STEPS", DEFAULT_RELEASE_MAX_STEPS
    )
    field_every_steps = _env_int(
        "FULLMAG_BIMERON_FIELD_EVERY_STEPS", DEFAULT_FIELD_EVERY_STEPS
    )
    hold_sample_period_s = _env_float(
        "FULLMAG_BIMERON_HOLD_SAMPLE_PERIOD_S", DEFAULT_HOLD_SAMPLE_PERIOD_S
    )
    pin_centres_nm: tuple[tuple[float, float], tuple[float, float]] | None = None
    raw_pin_centres = os.environ.get("FULLMAG_BIMERON_PIN_CENTRES_NM", "").strip()
    if raw_pin_centres:
        try:
            decoded = json.loads(raw_pin_centres)
        except json.JSONDecodeError as error:
            raise ValueError(
                "FULLMAG_BIMERON_PIN_CENTRES_NM must be JSON [[x,y],[x,y]]"
            ) from error
        if (
            not isinstance(decoded, list)
            or len(decoded) != 2
            or any(
                not isinstance(pair, list)
                or len(pair) != 2
                or any(
                    isinstance(item, bool) or not isinstance(item, (int, float))
                    for item in pair
                )
                for pair in decoded
            )
        ):
            raise ValueError(
                "FULLMAG_BIMERON_PIN_CENTRES_NM must be JSON [[x,y],[x,y]]"
            )
        parsed = tuple((float(pair[0]), float(pair[1])) for pair in decoded)
        if any(not math.isfinite(value) for pair in parsed for value in pair):
            raise ValueError("FULLMAG_BIMERON_PIN_CENTRES_NM values must be finite")
        pin_centres_nm = parsed  # type: ignore[assignment]
    if ring_width_nm <= 0.0:
        raise ValueError("FULLMAG_BIMERON_RING_WIDTH_NM must be positive")
    if protocol == "ring" and ring_width_nm >= 2.0 * target_radius_nm:
        raise ValueError("ring width must be smaller than twice target radius")
    if any(value <= 0.0 for value in (relax_time_s, hold_time_s, release_time_s, dt_s, hold_sample_period_s, relax_tol_T)):
        raise ValueError("relax, hold, release, dt, sample periods, and relax_tol_T must be positive")
    if any(value <= 0 for value in (relax_max_steps, release_max_steps, field_every_steps)):
        raise ValueError("step and field intervals must be positive")
    return FrozenCase(
        target_radius_nm=target_radius_nm,
        preset_radius_nm=preset_radius_nm,
        wall_width_nm=wall_width_nm,
        cell_nm=cell_nm,
        pin_radius_nm=pin_radius_nm,
        ring_width_nm=ring_width_nm,
        protocol=protocol,
        helicity_rad=helicity_rad,
        vorticity=vorticity,
        background_sign=background_sign,
        include_release=include_release,
        relax_time_s=relax_time_s,
        hold_time_s=hold_time_s,
        release_time_s=release_time_s,
        dt_s=dt_s,
        relax_tol_T=relax_tol_T,
        relax_max_steps=relax_max_steps,
        release_max_steps=release_max_steps,
        field_every_steps=field_every_steps,
        hold_sample_period_s=hold_sample_period_s,
        pin_centres_nm=pin_centres_nm,
    )
