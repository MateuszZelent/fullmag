"""FEM demag validation: Dirichlet vs Robin BC comparison.

This script runs the same geometry (uniformly magnetized sphere) with both
Dirichlet and Robin boundary conditions across multiple airbox sizes and
mesh resolutions, then compares:

1. At what airbox scale do both BCs converge to the same result?
2. How much faster does Robin converge than Dirichlet?
3. Does Robin maintain accuracy at small airbox sizes where Dirichlet fails?

This is the key test for the Robin BC advantage claim.

Usage
-----
    python3 tests/fem_demag_validation/dirichlet_vs_robin.py

Requires PyO3 `_fullmag_core` built with the MFEM/libCEED runtime stack. The
managed `fullmag --headless` loader is only a capture-stage smoke path and does
not execute this CSV sweep.

Output
------
    tests/fem_demag_validation/results/dirichlet_vs_robin.csv
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
    require_native_runtime_core,
    write_csv,
)

# ── Parameters ──────────────────────────────────────────────────────────

RADIUS = 50e-9
MS = 800e3
AEX = 13e-12
ALPHA = 0.5
M_DIR = (0.0, 0.0, 1.0)

# Two mesh levels
HMAX_VALUES = [8e-9, 5e-9]

# Airbox scale sweep — focus on small-to-moderate where differences matter
AIRBOX_SCALES = [1.2, 1.5, 2.0, 3.0, 5.0, 8.0]

BC_VARIANTS = ["poisson_dirichlet", "poisson_robin"]

RELAX_TOL = 1e-5
RELAX_MAX_STEPS = 5
RELAX_ALGORITHM = "projected_gradient_bb"

# ── Analytical ──────────────────────────────────────────────────────────

try:
    require_native_runtime_core()
except ValidationFailure as exc:
    print(f"FAIL: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc

VOLUME = (4.0 / 3.0) * math.pi * RADIUS ** 3
E_DEMAG_ANALYTICAL = analytical_demag_energy_sphere(MS, RADIUS)
N_ANALYTICAL = 1.0 / 3.0

print("╔═══════════════════════════════════════════════════════════════╗")
print("║  FEM Demag Validation: Dirichlet vs Robin BC Comparison     ║")
print("╠═══════════════════════════════════════════════════════════════╣")
print(f"║  Sphere radius     = {RADIUS * 1e9:.0f} nm")
print(f"║  Ms                = {MS:.0f} A/m")
print(f"║  Mesh resolutions  = {[f'{h*1e9:.0f}nm' for h in HMAX_VALUES]}")
print(f"║  Airbox scales     = {AIRBOX_SCALES}")
print(f"║  E_demag (anal.)   = {E_DEMAG_ANALYTICAL:.6e} J")
print("╚═══════════════════════════════════════════════════════════════╝")
print()

# ── Sweep ───────────────────────────────────────────────────────────────

rows: list[dict] = []

for hmax in HMAX_VALUES:
    for scale in AIRBOX_SCALES:
        for bc in BC_VARIANTS:
            label = f"dvr_h{hmax*1e9:.0f}_s{scale:.1f}_{bc.split('_')[-1]}"
            print(f"  [{label}] ...", end=" ", flush=True)

            try:
                study, body = build_fem_sphere_study(
                    problem_name=label,
                    radius=RADIUS,
                    hmax=hmax,
                    ms=MS,
                    aex=AEX,
                    alpha=ALPHA,
                    demag_realization=bc,
                    universe_scale=scale,
                    airbox_hmax_factor=4.0,
                    m_direction=M_DIR,
                )

                result = study.relax(
                    tol=RELAX_TOL,
                    max_steps=RELAX_MAX_STEPS,
                    algorithm=RELAX_ALGORITHM,
                    relax_alpha=1.0,
                )

                metrics = extract_demag_from_result(result)
                e_demag = metrics["e_demag_J"]
                n_eff = 2.0 * e_demag / (MU0 * MS * MS * VOLUME) if e_demag != 0 else float("nan")
                n_error = abs(n_eff - N_ANALYTICAL) / N_ANALYTICAL

                row = {
                    "bc": bc,
                    "bc_short": bc.split("_")[-1],
                    "hmax_nm": hmax * 1e9,
                    "airbox_scale": scale,
                    "e_demag_J": e_demag,
                    "n_effective": n_eff,
                    "n_rel_error": n_error,
                    "max_h_demag_Apm": metrics["max_h_demag_Apm"],
                    "demag_wall_time_ns": metrics["demag_wall_time_ns"],
                }
                rows.append(row)

                status = "✓" if n_error < 0.05 else ("~" if n_error < 0.10 else "✗")
                print(f"N={n_eff:.5f} err={n_error*100:.2f}% {status}")

            except Exception as exc:
                print(f"ERROR: {exc}", file=sys.stderr)
                rows.append({
                    "bc": bc,
                    "bc_short": bc.split("_")[-1],
                    "hmax_nm": hmax * 1e9,
                    "airbox_scale": scale,
                    "e_demag_J": float("nan"),
                    "n_effective": float("nan"),
                    "n_rel_error": float("nan"),
                    "max_h_demag_Apm": float("nan"),
                    "demag_wall_time_ns": float("nan"),
                })

# ── Output ──────────────────────────────────────────────────────────────

RESULTS_DIR.mkdir(parents=True, exist_ok=True)
csv_path = RESULTS_DIR / "dirichlet_vs_robin.csv"
write_csv(csv_path, rows)

# ── Comparative summary ─────────────────────────────────────────────────

print()
print("═══════════════════════════════════════════════════════════════")
print("  Dirichlet vs Robin — Side-by-Side")
print("═══════════════════════════════════════════════════════════════")

for hmax in HMAX_VALUES:
    print(f"\n  hmax = {hmax*1e9:.0f} nm:")
    print(f"  {'Scale':>6} {'Dirichlet':>12} {'Robin':>12} {'Advantage':>12}")
    print(f"  {'─'*6} {'─'*12} {'─'*12} {'─'*12}")

    for scale in AIRBOX_SCALES:
        d_rows = [r for r in rows if r["bc_short"] == "dirichlet"
                  and r["hmax_nm"] == hmax * 1e9 and r["airbox_scale"] == scale]
        r_rows = [r for r in rows if r["bc_short"] == "robin"
                  and r["hmax_nm"] == hmax * 1e9 and r["airbox_scale"] == scale]

        d_err = d_rows[0]["n_rel_error"] * 100 if d_rows and not math.isnan(d_rows[0]["n_rel_error"]) else float("nan")
        r_err = r_rows[0]["n_rel_error"] * 100 if r_rows and not math.isnan(r_rows[0]["n_rel_error"]) else float("nan")

        if not math.isnan(d_err) and not math.isnan(r_err) and d_err > 0:
            advantage = f"{d_err / r_err:.1f}×" if r_err > 0 else "∞"
        else:
            advantage = "—"

        print(f"  {scale:>5.1f}× {d_err:>10.2f}% {r_err:>10.2f}% {advantage:>12}")

# ── Conclusion ──────────────────────────────────────────────────────────

print()
# Find the smallest airbox scale where Robin < 5% error
robin_ok = [r for r in rows if r["bc_short"] == "robin"
            and not math.isnan(r["n_rel_error"]) and r["n_rel_error"] < 0.05]
dirichlet_ok = [r for r in rows if r["bc_short"] == "dirichlet"
                and not math.isnan(r["n_rel_error"]) and r["n_rel_error"] < 0.05]

if robin_ok:
    min_robin = min(robin_ok, key=lambda r: r["airbox_scale"])
    print(f"  Robin reaches <5% error at airbox scale = {min_robin['airbox_scale']:.1f}×")
if dirichlet_ok:
    min_dir = min(dirichlet_ok, key=lambda r: r["airbox_scale"])
    print(f"  Dirichlet reaches <5% error at airbox scale = {min_dir['airbox_scale']:.1f}×")

print(f"\n  Results: {csv_path}")
