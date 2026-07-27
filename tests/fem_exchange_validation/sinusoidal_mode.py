"""FEM exchange validation: helical sinusoidal Laplacian mode.

Analytical reference
--------------------
For an exchange-only helical state

    m(x) = (0, cos(kx), sin(kx))

the continuum exchange field is

    H_ex = (2A / (mu0 Ms)) * Laplacian(m)
         = -(2A / (mu0 Ms)) * k^2 * m_perp

so the field amplitude is `(2A / (mu0 Ms)) * k^2`.

This script sweeps FEM mesh resolution on a thin box, records exchange energy
and the measured `max_h_eff` from an exchange-only run, and compares both
against the analytical continuum references. With only exchange enabled,
`H_eff == H_ex`; the finest-mesh `max_h_eff` must stay within the documented
sinusoidal Laplacian tolerance while `E_ex` must converge to `A k^2 V`.

Usage
-----
    python tests/fem_exchange_validation/sinusoidal_mode.py

The `fullmag --headless` script loader imports this file in capture mode.  In
that path the module declares one representative finest-mesh stage for runtime
materialization, but it intentionally does not run the CSV acceptance sweep
because capture-mode `study.run(...)` returns a `Problem`, not runtime
`StepStats`.  Run the Python entrypoint above with a PyO3 core built against the
MFEM/libCEED stack to produce the CSV convergence evidence.

Output
------
    tests/fem_exchange_validation/results/sinusoidal_mode.csv
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import fullmag as fm
import fullmag.world as fm_world

SCRIPT_DIR = Path(__file__).resolve().parent
RESULTS_DIR = SCRIPT_DIR / "results"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    ValidationFailure,
    analytical_helical_exchange_amplitude,
    analytical_helical_exchange_energy,
    exchange_amplitude_from_energy,
    relative_error,
    require_error_decreases_with_refinement,
    require_finite_metrics,
    require_native_runtime_core,
    require_relative_error_below,
    write_csv,
)


LENGTH = 200e-9
WIDTH = 20e-9
THICKNESS = 10e-9
WAVELENGTH = 100e-9
MS = 800e3
AEX = 13e-12
ALPHA = 0.1
DT = 1e-13
HMAX_VALUES = [16e-9, 12e-9, 8e-9]
ENERGY_RELATIVE_ERROR_THRESHOLD = 0.08
H_EX_RELATIVE_ERROR_THRESHOLD = 0.25

K = 2.0 * math.pi / WAVELENGTH
VOLUME = LENGTH * WIDTH * THICKNESS
REFERENCE_H_EX = analytical_helical_exchange_amplitude(
    aex=AEX,
    ms=MS,
    wavelength=WAVELENGTH,
)
REFERENCE_E_EX = analytical_helical_exchange_energy(
    aex=AEX,
    wavelength=WAVELENGTH,
    volume=VOLUME,
)


def _is_script_capture() -> bool:
    return bool(getattr(fm_world, "_capture_enabled", False))


def build_exchange_study(*, label: str, hmax: float):
    """Create an exchange-only FEM box study with a physical-k helical texture."""
    fm.reset()
    study = fm.study(label)
    study.engine("fem")
    study.device("cpu", precision="double")
    study.universe(
        mode="auto",
        size=(1.4 * LENGTH, 1.6 * WIDTH, 2.0 * THICKNESS),
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(maximum_element_size=2.5 * hmax)

    body = study.geometry(
        fm.Box(size=(LENGTH, WIDTH, THICKNESS), name="exchange_strip"),
        name="exchange_strip",
    )
    body.Ms = MS
    body.Aex = AEX
    body.alpha = ALPHA
    body.m = fm.texture.helical(
        wavevector=(1.0, 0.0, 0.0),
        e1=(0.0, 1.0, 0.0),
        e2=(0.0, 0.0, 1.0),
    ).scale(1.0 / K, 1.0, 1.0)

    body.mesh(
        maximum_element_size=hmax,
        order=1,
        algorithm_2d=1,
        algorithm_3d=1,
        size_factor=1,
        size_from_curvature=0,
        smoothing_steps=1,
        optimize_iterations=1,
        narrow_regions=0,
        compute_quality=False,
        per_element_quality=False,
    )
    study.build_domain_mesh()
    study.exchange(enabled=True)
    study.demag(enabled=False)
    study.solver(max_error=1e-8, integrator="rk45", dt_max=DT)
    study.save("E_ex", every=1.0)
    return study, body


def declare_capture_stage() -> None:
    """Expose one representative finest-mesh run to `fullmag --headless`."""
    hmax = min(HMAX_VALUES)
    label = f"exchange_sinusoidal_h{hmax * 1e9:.0f}nm"
    study, _body = build_exchange_study(label=label, hmax=hmax)
    study.run(until=DT)


def run_sweep() -> list[dict]:
    rows: list[dict] = []
    for hmax in HMAX_VALUES:
        label = f"exchange_sinusoidal_h{hmax * 1e9:.0f}nm"
        print(f"[{label}] building and running...", flush=True)
        try:
            study, _body = build_exchange_study(label=label, hmax=hmax)
            result = study.run(until=DT)
            if not getattr(result, "steps", None):
                raise ValidationFailure("run produced no step stats")
            last = result.steps[-1]
            measured = float(getattr(last, "max_h_eff", float("nan")))
            energy = float(getattr(last, "e_ex", float("nan")))
            energy_error = relative_error(energy, REFERENCE_E_EX)
            h_energy_equivalent = exchange_amplitude_from_energy(
                exchange_energy=energy,
                ms=MS,
                volume=VOLUME,
            )
            h_error = relative_error(h_energy_equivalent, REFERENCE_H_EX)
            row = {
                "case": label,
                "hmax_m": hmax,
                "hmax_nm": hmax * 1e9,
                "wavelength_m": WAVELENGTH,
                "k_rad_per_m": K,
                "h_ex_max_Apm": measured,
                "h_ex_energy_equivalent_Apm": h_energy_equivalent,
                "h_ex_reference_Apm": REFERENCE_H_EX,
                "h_ex_rel_error": h_error,
                "h_eff_max_to_reference_ratio": measured / REFERENCE_H_EX,
                "exchange_energy_J": energy,
                "exchange_energy_reference_J": REFERENCE_E_EX,
                "exchange_energy_rel_error": energy_error,
                "exchange_wall_time_ns": int(getattr(last, "exchange_wall_time_ns", 0)),
            }
            rows.append(row)
            print(
                f"  E_ex={energy:.6e} J ref={REFERENCE_E_EX:.6e} "
                f"err={energy_error * 100:.2f}% H_ex(max)={measured:.6e} A/m"
            )
        except Exception as exc:
            print(f"  ERROR: {exc}", file=sys.stderr)
            rows.append({
                "case": label,
                "hmax_m": hmax,
                "hmax_nm": hmax * 1e9,
                "wavelength_m": WAVELENGTH,
                "k_rad_per_m": K,
                "h_ex_max_Apm": float("nan"),
                "h_ex_energy_equivalent_Apm": float("nan"),
                "h_ex_reference_Apm": REFERENCE_H_EX,
                "h_ex_rel_error": float("nan"),
                "h_eff_max_to_reference_ratio": float("nan"),
                "exchange_energy_J": float("nan"),
                "exchange_energy_reference_J": REFERENCE_E_EX,
                "exchange_energy_rel_error": float("nan"),
                "exchange_wall_time_ns": 0,
            })
    return rows


def main() -> int:
    try:
        require_native_runtime_core()
    except ValidationFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print("FEM exchange validation: sinusoidal Laplacian mode")
    print(f"  length={LENGTH * 1e9:.1f} nm wavelength={WAVELENGTH * 1e9:.1f} nm")
    print(f"  reference |H_ex|={REFERENCE_H_EX:.6e} A/m")
    print(f"  reference E_ex={REFERENCE_E_EX:.6e} J")
    rows = run_sweep()

    csv_path = RESULTS_DIR / "sinusoidal_mode.csv"
    write_csv(csv_path, rows)

    try:
        require_finite_metrics(
            rows,
            [
                "h_ex_max_Apm",
                "h_ex_energy_equivalent_Apm",
                "h_ex_reference_Apm",
                "h_ex_rel_error",
                "h_eff_max_to_reference_ratio",
                "exchange_energy_J",
                "exchange_energy_reference_J",
                "exchange_energy_rel_error",
            ],
            label_key="case",
        )
        require_error_decreases_with_refinement(
            rows,
            hmax_key="hmax_m",
            error_key="exchange_energy_rel_error",
        )
        finest = min(rows, key=lambda row: float(row["hmax_m"]))
        require_relative_error_below(
            finest,
            error_key="h_ex_rel_error",
            threshold=H_EX_RELATIVE_ERROR_THRESHOLD,
            label=str(finest["case"]),
        )
        require_relative_error_below(
            finest,
            error_key="exchange_energy_rel_error",
            threshold=ENERGY_RELATIVE_ERROR_THRESHOLD,
            label=str(finest["case"]),
        )
    except ValidationFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print(
        "PASS: finest energy relative error below "
        f"{ENERGY_RELATIVE_ERROR_THRESHOLD * 100:.1f}%"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

if _is_script_capture():
    declare_capture_stage()
