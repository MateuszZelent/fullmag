#!/usr/bin/env python3
"""Write the demagnetizing Kalinikos--Slavin n=0 reference for COMSOL C1.

The generated CSV is a deterministic comparison oracle for the homogeneous
full-film control (C1).  It contains separate backward-volume (BV) and
Damon--Eshbach (DE) branches, with the dynamic thin-film demagnetizing factor
``P00(k*t)`` recorded for every point.  It deliberately does not claim to be
the finite-airbox FEM solution or the antidot (A1) solution.
"""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path
import sys
from typing import Iterable, Mapping, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
PYTHON_PACKAGE = REPO_ROOT / "packages" / "fullmag-py" / "src"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(PYTHON_PACKAGE) not in sys.path:
    sys.path.insert(0, str(PYTHON_PACKAGE))

from verify_fem_frequency_domain_eigen_artifacts import (  # noqa: E402
    kalinikos_slab_n0_frequency_hz,
    p00_demag_factor,
)
from tests.standard_problems.mumag.comsol_nonzero_k_dispersion.config import (  # noqa: E402
    AEX_J_PER_M,
    A_LAT_M,
    BIAS_FIELD_A_PER_M,
    FILM_THICKNESS_M,
    GAMMA_M_PER_A_S,
    MS_A_PER_M,
    MU0_H_PER_M,
)


ANALYTIC_MODEL = "kalinikos_slab_n0"
DEMAG_MODEL = "dynamic_thin_film_P00"
GEOMETRIES = ("backward_volume", "damon_eshbach")
K_X_RAD_PER_M = math.pi / A_LAT_M
DEFAULT_OUTPUT = (
    REPO_ROOT
    / "docs"
    / "guides"
    / "comsol-dispersion-benchmark"
    / "kalinikos_slab_n0_reference.csv"
)
CSV_COLUMNS = (
    "sample_index",
    "geometry",
    "k_rad_per_m",
    "frequency_hz",
    "p00",
    "exchange_field_A_per_m",
    "bias_field_A_per_m",
    "film_thickness_m",
    "Ms_A_per_m",
    "Aex_J_per_m",
    "mu0_H_per_m",
    "gamma0_rad_s_per_A_m",
    "analytic_model",
    "demag_model",
    "demag_enabled",
)


def _require_finite_nonnegative(value: float, name: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0.0:
        raise ValueError(f"{name} must be finite and non-negative")
    return parsed


def _require_positive(value: float, name: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0.0:
        raise ValueError(f"{name} must be finite and positive")
    return parsed


def exchange_field_A_per_m(k_norm: float) -> float:
    """Return H_ex(k)=2*Aex*k^2/(mu0*Ms) in A/m."""

    k_norm = _require_finite_nonnegative(k_norm, "k_norm")
    return 2.0 * AEX_J_PER_M * k_norm * k_norm / (MU0_H_PER_M * MS_A_PER_M)


def frequency_hz(k_norm: float, geometry: str) -> float:
    """Return the C1 thin-film n=0 frequency including dynamic demag."""

    if geometry not in GEOMETRIES:
        raise ValueError(f"geometry must be one of {GEOMETRIES!r}")
    k_norm = _require_finite_nonnegative(k_norm, "k_norm")
    return kalinikos_slab_n0_frequency_hz(
        k_norm=k_norm,
        geometry=geometry,
        bias_field_a_per_m=BIAS_FIELD_A_PER_M,
        film_thickness_m=FILM_THICKNESS_M,
        exchange_stiffness_j_per_m=AEX_J_PER_M,
        saturation_magnetisation_a_per_m=MS_A_PER_M,
        gamma0_rad_s_per_a_m=GAMMA_M_PER_A_S,
    )


def reference_rows(
    *,
    max_k_rad_per_m: float = K_X_RAD_PER_M,
    samples: int = 61,
    geometries: Sequence[str] = GEOMETRIES,
) -> list[dict[str, object]]:
    """Return evenly sampled BV/DE reference rows from Gamma to ``max_k``."""

    max_k_rad_per_m = _require_positive(max_k_rad_per_m, "max_k_rad_per_m")
    if not isinstance(samples, int) or samples < 2:
        raise ValueError("samples must be an integer >= 2")
    selected_geometries = tuple(geometries)
    if not selected_geometries or any(geometry not in GEOMETRIES for geometry in selected_geometries):
        raise ValueError(f"geometries must be selected from {GEOMETRIES!r}")

    rows: list[dict[str, object]] = []
    for sample_index in range(samples):
        k_norm = max_k_rad_per_m * sample_index / (samples - 1)
        p00 = p00_demag_factor(k_norm, FILM_THICKNESS_M)
        exchange_field = exchange_field_A_per_m(k_norm)
        for geometry in selected_geometries:
            rows.append(
                {
                    "sample_index": sample_index,
                    "geometry": geometry,
                    "k_rad_per_m": k_norm,
                    "frequency_hz": frequency_hz(k_norm, geometry),
                    "p00": p00,
                    "exchange_field_A_per_m": exchange_field,
                    "bias_field_A_per_m": BIAS_FIELD_A_PER_M,
                    "film_thickness_m": FILM_THICKNESS_M,
                    "Ms_A_per_m": MS_A_PER_M,
                    "Aex_J_per_m": AEX_J_PER_M,
                    "mu0_H_per_m": MU0_H_PER_M,
                    "gamma0_rad_s_per_A_m": GAMMA_M_PER_A_S,
                    "analytic_model": ANALYTIC_MODEL,
                    "demag_model": DEMAG_MODEL,
                    "demag_enabled": True,
                }
            )
    return rows


def write_reference_csv(path: Path, rows: Iterable[Mapping[str, object]]) -> None:
    """Write rows with stable field order and full-precision float rendering."""

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=CSV_COLUMNS, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    key: (
                        f"{value:.16e}"
                        if isinstance(value, float)
                        else value
                    )
                    for key, value in row.items()
                }
            )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"output CSV (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--max-k",
        type=float,
        default=K_X_RAD_PER_M,
        dest="max_k_rad_per_m",
        help="maximum |k| in rad/m (default: pi/a_lat, the C1 X point)",
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=61,
        help="number of points per geometry, including Gamma and max-k",
    )
    args = parser.parse_args(argv)
    rows = reference_rows(
        max_k_rad_per_m=args.max_k_rad_per_m,
        samples=args.samples,
    )
    write_reference_csv(args.output, rows)
    print(
        f"wrote {len(rows)} Kalinikos n=0 demag-reference rows to {args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
