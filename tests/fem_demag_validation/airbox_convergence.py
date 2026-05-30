"""FEM demag validation: airbox convergence sweep.

For a given geometry, the air-box truncation introduces a systematic error
in the Poisson solve.  As the air-box grows, the solution should converge
toward the full-space analytical result.

This script sweeps the air-box scale factor for a uniformly magnetized sphere
and records E_demag and effective N at each scale, for both Dirichlet and
Robin BCs.

Expected outcome
----------------
- Both BCs should converge to N = 1/3 for large air-box.
- Robin should converge faster (fewer elements needed for same accuracy).
- Dirichlet should show clear improvement with scale.

Usage
-----
    python3 tests/fem_demag_validation/airbox_convergence.py

Requires PyO3 `_fullmag_core` built with the MFEM/libCEED runtime stack. The
managed `fullmag --headless` loader is only a capture-stage smoke path and does
not execute this CSV sweep.

Output
------
    tests/fem_demag_validation/results/airbox_convergence.csv
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RESULTS_DIR = SCRIPT_DIR / "results"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from helpers import (  # noqa: E402
    MU0,
    ValidationFailure,
    analytical_demag_energy_sphere,
    build_fem_sphere_study,
    extract_demag_from_result,
    require_finite_metrics,
    require_grouped_error_improvement,
    require_native_runtime_core,
    write_csv,
)

# ── Parameters ──────────────────────────────────────────────────────────

RADIUS = 50e-9
MS = 800e3
AEX = 13e-12
ALPHA = 0.5
HMAX = 8e-9              # fixed mesh resolution
M_DIR = (0.0, 0.0, 1.0)

# Airbox scale sweep: ratio of universe half-span to sphere diameter
AIRBOX_SCALES = [1.2, 1.4, 1.8, 2.5, 4.0, 6.0]

BC_VARIANTS = ["poisson_robin", "poisson_dirichlet"]

RELAX_TOL = 1e-5
RELAX_MAX_STEPS = 5
RELAX_ALGORITHM = "projected_gradient_bb"

# ── Analytical reference ────────────────────────────────────────────────

try:
    require_native_runtime_core()
except ValidationFailure as exc:
    print(f"FAIL: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc

VOLUME = (4.0 / 3.0) * math.pi * RADIUS ** 3
E_DEMAG_ANALYTICAL = analytical_demag_energy_sphere(MS, RADIUS)

print("╔═══════════════════════════════════════════════════════════════╗")
print("║  FEM Demag Validation: Airbox Convergence Sweep             ║")
print("╠═══════════════════════════════════════════════════════════════╣")
print(f"║  Sphere radius   = {RADIUS * 1e9:.1f} nm")
print(f"║  Ms              = {MS:.0f} A/m")
print(f"║  hmax (fixed)    = {HMAX * 1e9:.0f} nm")
print(f"║  Airbox scales   = {AIRBOX_SCALES}")
print(f"║  BC variants     = {BC_VARIANTS}")
print(f"║  E_demag (anal.) = {E_DEMAG_ANALYTICAL:.6e} J")
print("╚═══════════════════════════════════════════════════════════════╝")
print()

# ── Sweep ───────────────────────────────────────────────────────────────

rows: list[dict] = []

for bc in BC_VARIANTS:
    for scale in AIRBOX_SCALES:
        label = f"airbox_s{scale:.1f}_{bc}"
        print(f"  [{label}] Building...", end=" ", flush=True)

        try:
            study, body = build_fem_sphere_study(
                problem_name=label,
                radius=RADIUS,
                hmax=HMAX,
                ms=MS,
                aex=AEX,
                alpha=ALPHA,
                demag_realization=bc,
                universe_scale=scale,
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
            e_rel_error = abs(e_demag - E_DEMAG_ANALYTICAL) / abs(E_DEMAG_ANALYTICAL)
            n_eff = 2.0 * e_demag / (MU0 * MS * MS * VOLUME) if e_demag != 0 else float("nan")
            n_error = abs(n_eff - 1.0 / 3.0) / (1.0 / 3.0)

            row = {
                "bc": bc,
                "airbox_scale": scale,
                "hmax_nm": HMAX * 1e9,
                "e_demag_J": e_demag,
                "e_demag_analytical_J": E_DEMAG_ANALYTICAL,
                "e_demag_rel_error": e_rel_error,
                "n_effective": n_eff,
                "n_analytical": 1.0 / 3.0,
                "n_rel_error": n_error,
                "max_h_demag_Apm": metrics["max_h_demag_Apm"],
                "demag_wall_time_ns": metrics["demag_wall_time_ns"],
            }
            rows.append(row)

            print(f"N_eff={n_eff:.4f} err={n_error*100:.2f}% E_err={e_rel_error*100:.2f}%")

        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            rows.append({
                "bc": bc,
                "airbox_scale": scale,
                "hmax_nm": HMAX * 1e9,
                "e_demag_J": float("nan"),
                "e_demag_analytical_J": E_DEMAG_ANALYTICAL,
                "e_demag_rel_error": float("nan"),
                "n_effective": float("nan"),
                "n_analytical": 1.0 / 3.0,
                "n_rel_error": float("nan"),
                "max_h_demag_Apm": float("nan"),
                "demag_wall_time_ns": float("nan"),
            })

# ── Output ──────────────────────────────────────────────────────────────

RESULTS_DIR.mkdir(parents=True, exist_ok=True)
csv_path = RESULTS_DIR / "airbox_convergence.csv"
write_csv(csv_path, rows)

# ── Summary table ───────────────────────────────────────────────────────

print()
print("═══════════════════════════════════════════════════════════════")
print("  Airbox Convergence Summary")
print("═══════════════════════════════════════════════════════════════")
print(f"  {'BC':<22} {'Scale':>6} {'N_eff':>8} {'N_err%':>8} {'E_err%':>8}")
print(f"  {'─'*22} {'─'*6} {'─'*8} {'─'*8} {'─'*8}")
for r in rows:
    n_eff = r["n_effective"]
    n_err = r["n_rel_error"] * 100 if not math.isnan(r["n_rel_error"]) else float("nan")
    e_err = r["e_demag_rel_error"] * 100 if not math.isnan(r["e_demag_rel_error"]) else float("nan")
    print(f"  {r['bc']:<22} {r['airbox_scale']:>5.1f}× {n_eff:>8.5f} {n_err:>7.2f}% {e_err:>7.2f}%")

# Check convergence: last entry for each BC should be closer than first.
validation_failed = False
for bc in BC_VARIANTS:
    bc_rows = [r for r in rows if r["bc"] == bc and not math.isnan(r["n_rel_error"])]
    if len(bc_rows) >= 2:
        first_err = bc_rows[0]["n_rel_error"]
        last_err = bc_rows[-1]["n_rel_error"]
        if last_err < first_err:
            print(f"\n  ✓ {bc}: convergent (error {first_err*100:.2f}% → {last_err*100:.2f}%)")
        else:
            print(f"\n  ✗ {bc}: NOT convergent (error {first_err*100:.2f}% → {last_err*100:.2f}%)")
            validation_failed = True
    else:
        print(f"\n  ✗ {bc}: NOT convergent (not enough finite rows)")
        validation_failed = True

print(f"\n  Results: {csv_path}")

try:
    require_finite_metrics(
        rows,
        ["e_demag_J", "e_demag_rel_error", "n_effective", "n_rel_error"],
        label_key="bc",
    )
    require_grouped_error_improvement(
        rows,
        group_key="bc",
        order_key="airbox_scale",
        error_key="n_rel_error",
    )
    if validation_failed:
        raise ValidationFailure("airbox convergence summary reported failure")
except ValidationFailure as exc:
    print(f"  ✗ FAIL: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc
else:
    print("  ✓ PASS: all airbox convergence groups improved")
