"""FEM/BEM demag validation on a body-only sphere mesh.

Analytical reference
--------------------
For a uniformly magnetized sphere, the demagnetizing factor is

    N = 1/3

and the demag energy is

    E_demag = 0.5 * mu0 * N * Ms^2 * V.

This script validates the Fredkin-Koehler FEM/BEM path on a magnetic body mesh
without an airbox.  The `fullmag --headless` script loader imports this module
in capture mode; in that path the module declares one representative body-only
stage.  The direct Python entrypoint runs the CSV acceptance sweep and requires
a PyO3 core built with the MFEM/libCEED CPU stack.

Usage
-----
    python tests/fem_demag_validation/fem_bem_body_validation.py

Output
------
    tests/fem_demag_validation/results/fem_bem_body_sphere.csv
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
    analytical_demag_energy_sphere,
    effective_demag_factor_from_energy,
    extract_demag_from_result,
    require_finite_metrics,
    require_grouped_error_improvement,
    require_relative_error_below,
    sphere_demag_factor,
    write_csv,
)


RADIUS = 30e-9
MS = 800e3
AEX = 13e-12
ALPHA = 0.1
M_DIR = (0.0, 0.0, 1.0)
DT = 1e-13
HMAX_VALUES = [24e-9, 18e-9, 12e-9]
N_RELATIVE_ERROR_THRESHOLD = 0.25

VOLUME = (4.0 / 3.0) * math.pi * RADIUS ** 3
REFERENCE_N = sphere_demag_factor()
REFERENCE_E_DEMAG = analytical_demag_energy_sphere(MS, RADIUS)


def _is_script_capture() -> bool:
    return bool(getattr(fm_world, "_capture_enabled", False))


def _relative_error(measured: float, reference: float) -> float:
    if reference == 0.0 or not math.isfinite(reference):
        return float("nan")
    return abs(float(measured) - float(reference)) / abs(float(reference))


def build_fem_bem_sphere_study(*, label: str, hmax: float):
    """Create a body-only FEM sphere study with Fredkin-Koehler demag."""
    fm.reset()
    study = fm.study(label)
    study.engine("fem")
    study.device("cpu", precision="double")

    body = study.geometry(
        fm.Sphere(radius=RADIUS, name="fem_bem_sphere"),
        name="fem_bem_sphere",
    )
    body.Ms = MS
    body.Aex = AEX
    body.alpha = ALPHA
    body.m = fm.texture.uniform(M_DIR)
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

    study.build_mesh()
    study.exchange(enabled=False)
    study.demag(model="fredkin_koehler")
    study.solver(max_error=1e-8, integrator="rk45")
    study.save("E_demag", every=1.0)
    return study, body


def declare_capture_stage() -> None:
    """Expose one representative body-only FEM/BEM run to `fullmag --headless`."""
    hmax = min(HMAX_VALUES)
    label = f"fem_bem_body_sphere_h{hmax * 1e9:.0f}nm"
    study, _body = build_fem_bem_sphere_study(label=label, hmax=hmax)
    study.run(until=DT)


def run_sweep() -> list[dict]:
    """Run the body-only mesh refinement sweep and return CSV rows."""
    rows: list[dict] = []
    for hmax in HMAX_VALUES:
        label = f"fem_bem_body_sphere_h{hmax * 1e9:.0f}nm"
        print(f"[{label}] building and running...", flush=True)
        try:
            study, _body = build_fem_bem_sphere_study(label=label, hmax=hmax)
            result = study.run(until=DT)
            if not getattr(result, "steps", None):
                raise ValidationFailure("run produced no step stats")
            metrics = extract_demag_from_result(result)
            e_demag = metrics["e_demag_J"]
            n_effective = effective_demag_factor_from_energy(
                e_demag=e_demag,
                ms=MS,
                volume=VOLUME,
            )
            e_error = _relative_error(e_demag, REFERENCE_E_DEMAG)
            n_error = _relative_error(n_effective, REFERENCE_N)
            row = {
                "case": label,
                "hmax_m": hmax,
                "hmax_nm": hmax * 1e9,
                "radius_m": RADIUS,
                "volume_m3": VOLUME,
                "demag_model": "fredkin_koehler",
                "domain_mesh_mode": "body_only",
                "e_demag_J": e_demag,
                "e_demag_reference_J": REFERENCE_E_DEMAG,
                "e_demag_rel_error": e_error,
                "n_effective": n_effective,
                "n_reference": REFERENCE_N,
                "n_rel_error": n_error,
                "max_h_demag_Apm": metrics["max_h_demag_Apm"],
                "demag_wall_time_ns": metrics["demag_wall_time_ns"],
            }
            rows.append(row)
            print(
                f"  N_eff={n_effective:.6f} ref={REFERENCE_N:.6f} "
                f"err={n_error * 100:.2f}% E_demag={e_demag:.6e} J"
            )
        except Exception as exc:
            print(f"  ERROR: {exc}", file=sys.stderr)
            rows.append({
                "case": label,
                "hmax_m": hmax,
                "hmax_nm": hmax * 1e9,
                "radius_m": RADIUS,
                "volume_m3": VOLUME,
                "demag_model": "fredkin_koehler",
                "domain_mesh_mode": "body_only",
                "e_demag_J": float("nan"),
                "e_demag_reference_J": REFERENCE_E_DEMAG,
                "e_demag_rel_error": float("nan"),
                "n_effective": float("nan"),
                "n_reference": REFERENCE_N,
                "n_rel_error": float("nan"),
                "max_h_demag_Apm": float("nan"),
                "demag_wall_time_ns": float("nan"),
            })
    return rows


def main() -> int:
    print("FEM/BEM demag validation: body-only sphere")
    print(f"  radius={RADIUS * 1e9:.1f} nm")
    print(f"  reference N={REFERENCE_N:.6f}")
    print(f"  reference E_demag={REFERENCE_E_DEMAG:.6e} J")
    rows = run_sweep()

    csv_path = RESULTS_DIR / "fem_bem_body_sphere.csv"
    write_csv(csv_path, rows)

    try:
        require_finite_metrics(
            rows,
            [
                "e_demag_J",
                "e_demag_reference_J",
                "e_demag_rel_error",
                "n_effective",
                "n_reference",
                "n_rel_error",
                "max_h_demag_Apm",
            ],
            label_key="case",
        )
        require_grouped_error_improvement(
            rows,
            group_key="demag_model",
            order_key="hmax_m",
            error_key="n_rel_error",
        )
        finest = min(rows, key=lambda row: float(row["hmax_m"]))
        require_relative_error_below(
            finest,
            error_key="n_rel_error",
            threshold=N_RELATIVE_ERROR_THRESHOLD,
            label=str(finest["case"]),
        )
    except ValidationFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print(
        "PASS: finest body-only FEM/BEM demag factor relative error below "
        f"{N_RELATIVE_ERROR_THRESHOLD * 100:.1f}%"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

if _is_script_capture():
    declare_capture_stage()
