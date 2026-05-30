"""FEM demag validation: ellipsoid demagnetizing factors.

For a uniformly magnetized ellipsoid with semi-axes (a, b, c), the internal
demagnetizing field along axis i is H_i = -N_i · M_i, where N_i are the
Osborn demagnetizing factors satisfying Na + Nb + Nc = 1.

This script:
1. Computes analytical Osborn factors for several ellipsoid shapes.
2. Runs FEM relaxation with uniform m along each principal axis.
3. Extracts effective N from E_demag and compares to analytics.

Test geometries:
- Sphere (control): 50nm × 50nm × 50nm  → N = (1/3, 1/3, 1/3)
- Prolate: 50nm × 25nm × 25nm           → Nz < Nx = Ny
- Oblate:  25nm × 50nm × 50nm           → Nz > Nx = Ny
- General: 30nm × 50nm × 80nm           → all different

Usage
-----
    python3 tests/fem_demag_validation/ellipsoid_validation.py

Requires PyO3 `_fullmag_core` built with the MFEM/libCEED runtime stack. The
managed `fullmag --headless` loader is only a capture-stage smoke path and does
not execute this CSV sweep.

Output
------
    tests/fem_demag_validation/results/ellipsoid_factors.csv
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
    build_fem_ellipsoid_study,
    ellipsoid_demag_factors,
    extract_demag_from_result,
    require_finite_metrics,
    require_grouped_sum_close,
    require_native_runtime_core,
    require_relative_error_below,
    write_csv,
)

# ── Parameters ──────────────────────────────────────────────────────────

MS = 800e3
AEX = 13e-12
ALPHA = 0.5
HMAX = 6e-9
BC = "poisson_robin"
UNIVERSE_SCALE = 4.0

RELAX_TOL = 1e-5
RELAX_MAX_STEPS = 5
RELAX_ALGORITHM = "projected_gradient_bb"
MAX_AXIS_REL_ERROR = 0.10
MAX_SHAPE_SUM_ERROR = 0.15

# Test shapes: (name, rx, ry, rz) in metres
SHAPES = [
    ("sphere",  50e-9, 50e-9, 50e-9),
    ("prolate", 25e-9, 25e-9, 50e-9),
    ("oblate",  50e-9, 50e-9, 25e-9),
    ("general", 30e-9, 50e-9, 80e-9),
]

# Axes to magnetize along for each shape
AXES = [
    ("x", (1.0, 0.0, 0.0)),
    ("y", (0.0, 1.0, 0.0)),
    ("z", (0.0, 0.0, 1.0)),
]

try:
    require_native_runtime_core()
except ValidationFailure as exc:
    print(f"FAIL: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc

print("╔═══════════════════════════════════════════════════════════════╗")
print("║  FEM Demag Validation: Ellipsoid Demagnetizing Factors      ║")
print("╠═══════════════════════════════════════════════════════════════╣")
print(f"║  Ms    = {MS:.0f} A/m")
print(f"║  hmax  = {HMAX * 1e9:.0f} nm")
print(f"║  BC    = {BC}")
print(f"║  Scale = {UNIVERSE_SCALE}×")
print("╠═══════════════════════════════════════════════════════════════╣")

for name, rx, ry, rz in SHAPES:
    na, nb, nc = ellipsoid_demag_factors(rx, ry, rz)
    print(f"║  {name:>8}: ({rx*1e9:.0f}, {ry*1e9:.0f}, {rz*1e9:.0f}) nm  "
          f"→ N = ({na:.4f}, {nb:.4f}, {nc:.4f})  Σ={na+nb+nc:.4f}")

print("╚═══════════════════════════════════════════════════════════════╝")
print()

# ── Sweep ───────────────────────────────────────────────────────────────

rows: list[dict] = []

for shape_name, rx, ry, rz in SHAPES:
    volume = (4.0 / 3.0) * math.pi * rx * ry * rz
    na_ref, nb_ref, nc_ref = ellipsoid_demag_factors(rx, ry, rz)
    # Map to axis order (x, y, z) based on sorted semi-axes
    axes_sorted = sorted([(rx, "x"), (ry, "y"), (rz, "z")], reverse=True)
    n_ref_map = {}
    n_sorted = [na_ref, nb_ref, nc_ref]  # sorted descending by semi-axis
    for i, (_, axis_label) in enumerate(axes_sorted):
        n_ref_map[axis_label] = n_sorted[i]

    for axis_name, m_dir in AXES:
        label = f"ellipsoid_{shape_name}_{axis_name}"
        n_ref = n_ref_map.get(axis_name, float("nan"))

        print(f"  [{label}] N_ref={n_ref:.4f} ...", end=" ", flush=True)

        try:
            study, body = build_fem_ellipsoid_study(
                problem_name=label,
                rx=rx, ry=ry, rz=rz,
                hmax=HMAX,
                ms=MS,
                aex=AEX,
                alpha=ALPHA,
                demag_realization=BC,
                universe_scale=UNIVERSE_SCALE,
                airbox_hmax_factor=4.0,
                m_direction=m_dir,
            )

            result = study.relax(
                tol=RELAX_TOL,
                max_steps=RELAX_MAX_STEPS,
                algorithm=RELAX_ALGORITHM,
                relax_alpha=1.0,
            )

            metrics = extract_demag_from_result(result)
            e_demag = metrics["e_demag_J"]

            # N_eff from energy: E = (μ₀/2) N Ms² V
            n_eff = 2.0 * e_demag / (MU0 * MS * MS * volume) if e_demag != 0 else float("nan")
            n_error = abs(n_eff - n_ref) / n_ref if n_ref > 0 else float("nan")

            row = {
                "shape": shape_name,
                "rx_nm": rx * 1e9,
                "ry_nm": ry * 1e9,
                "rz_nm": rz * 1e9,
                "m_axis": axis_name,
                "n_ref": n_ref,
                "n_effective": n_eff,
                "n_rel_error": n_error,
                "e_demag_J": e_demag,
                "volume_m3": volume,
                "hmax_nm": HMAX * 1e9,
                "max_h_demag_Apm": metrics["max_h_demag_Apm"],
                "demag_wall_time_ns": metrics["demag_wall_time_ns"],
            }
            rows.append(row)

            status = "PASS" if n_error < 0.05 else ("WARN" if n_error < 0.10 else "FAIL")
            print(f"N_eff={n_eff:.4f} err={n_error*100:.2f}% [{status}]")

        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            rows.append({
                "shape": shape_name,
                "rx_nm": rx * 1e9,
                "ry_nm": ry * 1e9,
                "rz_nm": rz * 1e9,
                "m_axis": axis_name,
                "n_ref": n_ref,
                "n_effective": float("nan"),
                "n_rel_error": float("nan"),
                "e_demag_J": float("nan"),
                "volume_m3": volume,
                "hmax_nm": HMAX * 1e9,
                "max_h_demag_Apm": float("nan"),
                "demag_wall_time_ns": float("nan"),
            })

# ── Output ──────────────────────────────────────────────────────────────

RESULTS_DIR.mkdir(parents=True, exist_ok=True)
csv_path = RESULTS_DIR / "ellipsoid_factors.csv"
write_csv(csv_path, rows)

# ── Summary table ───────────────────────────────────────────────────────

print()
print("═══════════════════════════════════════════════════════════════")
print("  Ellipsoid Demagnetizing Factors Summary")
print("═══════════════════════════════════════════════════════════════")
print(f"  {'Shape':>8} {'Axis':>4} {'N_ref':>8} {'N_eff':>8} {'Error%':>8}")
print(f"  {'─'*8} {'─'*4} {'─'*8} {'─'*8} {'─'*8}")
for r in rows:
    n_eff = r["n_effective"]
    n_err = r["n_rel_error"] * 100 if not math.isnan(r["n_rel_error"]) else float("nan")
    print(f"  {r['shape']:>8} {r['m_axis']:>4} {r['n_ref']:>8.4f} {n_eff:>8.4f} {n_err:>7.2f}%")

# N-factor sum check per shape
print()
for shape_name, _, _, _ in SHAPES:
    shape_rows = [r for r in rows if r["shape"] == shape_name and not math.isnan(r["n_effective"])]
    if len(shape_rows) == 3:
        n_sum = sum(r["n_effective"] for r in shape_rows)
        check = "✓" if abs(n_sum - 1.0) < 0.15 else "✗"
        print(f"  {check} {shape_name}: ΣN = {n_sum:.4f} (should be ~1.0)")

print(f"\n  Results: {csv_path}")

try:
    require_finite_metrics(
        rows,
        ["n_ref", "n_effective", "n_rel_error", "e_demag_J", "max_h_demag_Apm"],
        label_key="shape",
    )
    for row in rows:
        require_relative_error_below(
            row,
            error_key="n_rel_error",
            threshold=MAX_AXIS_REL_ERROR,
            label=f"{row['shape']} {row['m_axis']}",
        )
    require_grouped_sum_close(
        rows,
        group_key="shape",
        value_key="n_effective",
        expected_sum=1.0,
        tolerance=MAX_SHAPE_SUM_ERROR,
        required_axis_key="m_axis",
        required_axes=("x", "y", "z"),
    )
except ValidationFailure as exc:
    print(f"\n  VALIDATION FAILURE: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc
