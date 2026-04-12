"""Canonical Fullmag script generated from the model builder.

STNO (Spin-Torque Nano-Oscillator) vortex MTJ workflow example.

Demonstrates:
  1. Problem authoring: geometry, material, initial magnetization.
  2. Spin-transfer torque (Slonczewski STT for CPP/MTJ).
  3. Oersted field from current-carrying pillar.
  4. Thermal fluctuations (optional).
  5. Spectral analysis: PSD, peak frequency, linewidth.
  6. Vortex core tracking: orbit radius, phase, metrics.

Source: stno_vortex_mtj_workflow.py
Entrypoint: flat_workspace
"""

from pathlib import Path
import os

import fullmag as fm

SCRIPT_DIR = Path(__file__).resolve().parent
RELAXED_STATE_ZARR = SCRIPT_DIR / "stno_vortex_relaxed_m.zarr.zip"
RELAXED_STATE_H5 = SCRIPT_DIR / "stno_vortex_relaxed_m.h5"
USE_SAVED_RELAXED_STATE = RELAXED_STATE_ZARR.exists()
USE_SAVED_RELAXED_STATE = USE_SAVED_RELAXED_STATE and os.getenv("FULLMAG_USE_SAVED_STATE") == "1"

study = fm.study("stno_vortex_mtj_workflow")

# ── 1. Engine / runtime ──────────────────────────────────
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(150e-9, 150e-9, 20e-9),
    center=(0, 0, 0),
    padding=(0, 0, 0),
    airbox_hmax=20e-9,
)
study.interactive(True)

# ── 2. Geometry & Material (CoFeB/NiFe free layer) ───────
free = study.geometry(
    # NOTE:
    # Wrap cylinder in a no-op Translate to force the generic OCC CSG meshing
    # path (with internal geometric scaling), which is more robust for very
    # thin nanoscale cylinders than the direct cylinder mesher path.
    fm.Translate(
        fm.Cylinder(radius=50e-9, height=10e-9, name="free_disk"),
        (0.0, 0.0, 0.0),
    ),
    name="free",
)
free.Ms = 700e3
free.Aex = 1.2e-11
free.alpha = 0.01
free.m = fm.uniform(1, 0, 0)


# ── 3. Mesh ──────────────────────────────────────────────
study.object_mesh_defaults(
    algorithm_2d=6,
    algorithm_3d=1,
    size_factor=1,
    size_from_curvature=1,
    smoothing_steps=1,
    optimize_iterations=1,
    narrow_regions=1,
    compute_quality=True,
    per_element_quality=True,
)
free.mesh(
    hmax=6e-9,
    order=1,
    algorithm_2d=1,
    algorithm_3d=1,
    size_factor=1,
    size_from_curvature=1,
    smoothing_steps=1,
    optimize_iterations=1,
    narrow_regions=1,
    compute_quality=True,
    per_element_quality=True,
)
study.build_domain_mesh()

# ── 4. Energy terms ──────────────────────────────────────
study.demag(realization="poisson_robin")

# Optional weak DC bias field (along +z)
study.b_ext(0.02, theta=90, phi=0)

# ── 5. Spin-transfer torque (Slonczewski, CPP/MTJ) ──────
# Drive the vortex into gyration using a DC spin-polarized current.
# J = 5e10 A/m² along +z, polarization = +z (fixed layer), P = 0.4
# stt = fm.SlonczewskiSTT(
#     current_density=(0.0, 0.0, 5e10),
#     spin_polarization=(0.0, 0.0, 1.0),
#     degree=0.4,
#     lambda_asymmetry=1.0,
#     epsilon_prime=0.0,
# )

# ── 6. Oersted field from the STNO pillar ────────────────
# oersted = fm.OerstedCylinder(
#     current=5e-3,        # 5 mA DC current
#     radius=100e-9,        # same as free layer
#     center=(0.0, 0.0, 0.0),
#     axis=(0.0, 0.0, 1.0),
#     # Use sinusoidal modulation for AC drive (optional):
#     # time_dependence=fm.Sinusoidal(frequency_hz=500e6, phase_rad=0.0),
# )

# ── 7. Temperature (optional thermal broadening) ─────────
TEMPERATURE_K = 0.0  # Set to e.g. 300.0 for thermal fluctuations

# ── 8. Solver ────────────────────────────────────────────
study.solver(max_error=1e-6, integrator="rk45", g=2.115)

# ── 9. Outputs ───────────────────────────────────────────
study.tableautosave(10e-12)

# ── Stage authoring (uncomment to declare pipeline) ──────
# if not USE_SAVED_RELAXED_STATE:
#     study.stages.add_relax(
#         tol=4e3,
#         max_steps=1000,
#         algorithm="llg_overdamped",
#     )

# Time evolution (100 ns STNO gyration)
# study.stages.add_run(100e-9)

# Eigenmodes (optional diagnostics)
# study.stages.add_eigenmodes(
#     count=20,
#     target="lowest",
#     include_demag=True,
#     equilibrium_source="relax",
# )
