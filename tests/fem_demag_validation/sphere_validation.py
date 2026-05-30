"""FEM demag validation: uniformly magnetized sphere.

Analytical reference
--------------------
For a uniformly magnetized sphere, the internal demagnetizing field is
uniform and given by:

    H_demag = -N · Ms = -Ms/3    (N = 1/3 for a sphere)

The demag energy is:

    E_demag = (μ₀/2) · N · Ms² · V

This script:
1. Runs a single-step relaxation with uniform m on a FEM sphere.
2. Compares the computed E_demag and average |H_demag| against analytics.
3. Sweeps mesh refinement levels to show convergence.
4. Compares Dirichlet vs Robin BC.

Usage
-----
    python3 tests/fem_demag_validation/sphere_validation.py

Requires PyO3 `_fullmag_core` built with the MFEM/libCEED runtime stack. The
managed `fullmag --headless` loader is only a capture-stage smoke path and does
not execute this CSV sweep.

Output
------
    tests/fem_demag_validation/results/sphere_convergence.csv
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

# Ensure the tests directory is on the path for local helpers
SCRIPT_DIR = Path(__file__).resolve().parent
RESULTS_DIR = SCRIPT_DIR / "results"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    MU0,
    ValidationFailure,
    analytical_demag_energy_sphere,
    analytical_demag_field_sphere,
    build_fem_sphere_study,
    extract_demag_from_result,
    require_finite_metrics,
    require_native_runtime_core,
    require_relative_error_below,
    write_csv,
)

# ── Parameters ──────────────────────────────────────────────────────────

RADIUS = 50e-9           # 50 nm sphere
MS = 800e3               # A/m (Permalloy)
AEX = 13e-12             # J/m
ALPHA = 0.5              # high damping for fast relax
M_DIR = (0.0, 0.0, 1.0) # uniform along z

# Mesh refinement levels: hmax values in metres
HMAX_VALUES = [12e-9, 8e-9, 6e-9, 4e-9]

# Airbox scale (ratio of universe half-span to sphere diameter)
UNIVERSE_SCALE = 4.0

# BC variants to compare
BC_VARIANTS = ["poisson_robin", "poisson_dirichlet"]

# Relax config — just a few steps to let the solver compute the field
RELAX_TOL = 1e-5
RELAX_MAX_STEPS = 5
RELAX_ALGORITHM = "projected_gradient_bb"

# ── Analytical references ───────────────────────────────────────────────

try:
    require_native_runtime_core()
except ValidationFailure as exc:
    print(f"FAIL: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc

E_DEMAG_ANALYTICAL = analytical_demag_energy_sphere(MS, RADIUS)
H_DEMAG_ANALYTICAL = analytical_demag_field_sphere(MS)  # negative value

VOLUME = (4.0 / 3.0) * math.pi * RADIUS ** 3

print("╔═══════════════════════════════════════════════════════════════╗")
print("║  FEM Demag Validation: Uniformly Magnetized Sphere          ║")
print("╠═══════════════════════════════════════════════════════════════╣")
print(f"║  Radius          = {RADIUS * 1e9:.1f} nm")
print(f"║  Ms              = {MS:.0f} A/m")
print(f"║  Volume          = {VOLUME:.4e} m³")
print(f"║  N (analytical)  = 1/3 = {1.0/3.0:.6f}")
print(f"║  H_demag (anal.) = {H_DEMAG_ANALYTICAL:.2f} A/m")
print(f"║  E_demag (anal.) = {E_DEMAG_ANALYTICAL:.6e} J")
print(f"║  Universe scale  = {UNIVERSE_SCALE}×")
print(f"║  hmax values     = {[f'{h*1e9:.0f}nm' for h in HMAX_VALUES]}")
print(f"║  BC variants     = {BC_VARIANTS}")
print("╚═══════════════════════════════════════════════════════════════╝")
print()


# ── Sweep ───────────────────────────────────────────────────────────────

rows: list[dict] = []

for bc in BC_VARIANTS:
    for hmax in HMAX_VALUES:
        label = f"sphere_r{RADIUS*1e9:.0f}nm_h{hmax*1e9:.0f}nm_{bc}"
        print(f"  [{label}] Building study...", end=" ", flush=True)

        try:
            study, body = build_fem_sphere_study(
                problem_name=label,
                radius=RADIUS,
                hmax=hmax,
                ms=MS,
                aex=AEX,
                alpha=ALPHA,
                demag_realization=bc,
                universe_scale=UNIVERSE_SCALE,
                airbox_hmax_factor=4.0,
                m_direction=M_DIR,
            )

            print("relaxing...", end=" ", flush=True)
            result = study.relax(
                tol=RELAX_TOL,
                max_steps=RELAX_MAX_STEPS,
                algorithm=RELAX_ALGORITHM,
                relax_alpha=1.0,
            )

            metrics = extract_demag_from_result(result)
            e_demag = metrics["e_demag_J"]

            # Relative error vs analytical
            e_rel_error = abs(e_demag - E_DEMAG_ANALYTICAL) / abs(E_DEMAG_ANALYTICAL)

            # Effective N from computed energy: E = (μ₀/2) N Ms² V  →  N = 2E/(μ₀ Ms² V)
            n_effective = 2.0 * e_demag / (MU0 * MS * MS * VOLUME) if e_demag != 0 else float("nan")
            n_error = abs(n_effective - 1.0 / 3.0) / (1.0 / 3.0)

            row = {
                "bc": bc,
                "hmax_m": hmax,
                "hmax_nm": hmax * 1e9,
                "radius_m": RADIUS,
                "e_demag_J": e_demag,
                "e_demag_analytical_J": E_DEMAG_ANALYTICAL,
                "e_demag_rel_error": e_rel_error,
                "n_effective": n_effective,
                "n_analytical": 1.0 / 3.0,
                "n_rel_error": n_error,
                "max_h_demag_Apm": metrics["max_h_demag_Apm"],
                "h_demag_analytical_Apm": abs(H_DEMAG_ANALYTICAL),
                "demag_wall_time_ns": metrics["demag_wall_time_ns"],
                "universe_scale": UNIVERSE_SCALE,
            }
            rows.append(row)

            status = "PASS" if e_rel_error < 0.05 else ("WARN" if e_rel_error < 0.10 else "FAIL")
            print(
                f"N_eff={n_effective:.4f} (err={n_error*100:.2f}%) "
                f"E_demag={e_demag:.4e} J (err={e_rel_error*100:.2f}%) [{status}]"
            )

        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            rows.append({
                "bc": bc,
                "hmax_m": hmax,
                "hmax_nm": hmax * 1e9,
                "radius_m": RADIUS,
                "e_demag_J": float("nan"),
                "e_demag_analytical_J": E_DEMAG_ANALYTICAL,
                "e_demag_rel_error": float("nan"),
                "n_effective": float("nan"),
                "n_analytical": 1.0 / 3.0,
                "n_rel_error": float("nan"),
                "max_h_demag_Apm": float("nan"),
                "h_demag_analytical_Apm": abs(H_DEMAG_ANALYTICAL),
                "demag_wall_time_ns": float("nan"),
                "universe_scale": UNIVERSE_SCALE,
            })

# ── Output ──────────────────────────────────────────────────────────────

RESULTS_DIR.mkdir(parents=True, exist_ok=True)
csv_path = RESULTS_DIR / "sphere_convergence.csv"
write_csv(csv_path, rows)

# ── Summary ─────────────────────────────────────────────────────────────

print()
print("═══════════════════════════════════════════════════════════════")
print("  Summary: Sphere Demag Validation")
print("═══════════════════════════════════════════════════════════════")
print(f"  {'BC':<22} {'hmax':>6} {'N_eff':>8} {'N_err%':>8} {'E_err%':>8}")
print(f"  {'─'*22} {'─'*6} {'─'*8} {'─'*8} {'─'*8}")
for r in rows:
    bc = r["bc"]
    hmax = r["hmax_nm"]
    n_eff = r["n_effective"]
    n_err = r["n_rel_error"] * 100 if not math.isnan(r["n_rel_error"]) else float("nan")
    e_err = r["e_demag_rel_error"] * 100 if not math.isnan(r["e_demag_rel_error"]) else float("nan")
    print(f"  {bc:<22} {hmax:>5.0f}nm {n_eff:>8.5f} {n_err:>7.2f}% {e_err:>7.2f}%")

print()
print(f"  Analytical:  N = {1.0/3.0:.6f}   E_demag = {E_DEMAG_ANALYTICAL:.6e} J")
print(f"  Results:     {csv_path}")
print()

# Acceptance criterion: finest mesh, Robin BC, < 5% error
robin_finest = [r for r in rows if r["bc"] == "poisson_robin"]
try:
    require_finite_metrics(
        rows,
        ["e_demag_J", "e_demag_rel_error", "n_effective", "n_rel_error"],
        label_key="bc",
    )
    if not robin_finest:
        raise ValidationFailure("missing poisson_robin validation rows")
    best = min(robin_finest, key=lambda r: r["hmax_m"])
    require_relative_error_below(
        best,
        error_key="n_rel_error",
        threshold=0.05,
        label="Robin BC finest mesh",
    )
except ValidationFailure as exc:
    print(f"  ✗ FAIL: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc
else:
    print("  ✓ PASS: Robin BC finest mesh within 5% of analytical N=1/3")
