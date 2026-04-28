"""Canonical Fullmag script generated from the model builder.

Source: nanoflower_fem.py
Entrypoint: flat_workspace
"""

from pathlib import Path

import fullmag as fm

SCRIPT_DIR = Path(__file__).resolve().parent
RELAXED_STATE_ZARR = SCRIPT_DIR / "nanoflower_relaxed_m.zarr.zip"
RELAXED_STATE_H5 = SCRIPT_DIR / "nanoflower_relaxed_m.h5"
USE_SAVED_RELAXED_STATE = RELAXED_STATE_ZARR.exists()

study = fm.study("nanoflower_fem")

# Engine
study.engine("fem")
study.device("cuda:0", precision="double")
study.universe(mode="auto", size=(4e-07, 4e-07, 4e-07), center=(0, 0, 0), padding=(0, 0, 0))
study.universe.mesh(maximum_element_size=8e-08)
study.interactive(True)

# Geometry & Material
body = study.geometry(fm.ImportedGeometry(source="nanoflower.stl", name="nanoflower_left", scale=1e-09), name="nanoflower_left")
body.Ms = 752000
body.Aex = 1.55e-11
body.alpha = 0.1
body.m = (
    fm.load_magnetization(RELAXED_STATE_ZARR, format="zarr")
    if USE_SAVED_RELAXED_STATE
    else fm.random(seed=1)
)

# Mesh
study.objects.mesh.defaults(algorithm_2d=6, algorithm_3d=1, size_factor=1, size_from_curvature=0, smoothing_steps=1, optimize_iterations=1, narrow_regions=0, compute_quality=False, per_element_quality=False)
body.mesh(hmax=20e-09, order=1, algorithm_2d=1, algorithm_3d=1, size_factor=1, size_from_curvature=1, smoothing_steps=1, optimize_iterations=1, narrow_regions=1, compute_quality=True, per_element_quality=True)
study.build_domain_mesh()


# study.b_ext(0.001, theta=0, phi=0)  # 0.1 T along +z
# ── Solver ──────────────────────────────────────────────────
# study.solver(dt=1e-15, g=2.115)
study.solver(max_error=1e-6, integrator="rk23", g=2.115)

# ── Outputs ─────────────────────────────────────────────────
# study.save("m", every=1e-13)
# study.save("H_demag", every=1e-13)
study.tableautosave(1e-13)

# ── Run ─────────────────────────────────────────────────────
if not USE_SAVED_RELAXED_STATE:
    relax_result = study.relax(
        tol=1e-6,                       # torque tolerance (max_dm_dt)
        max_steps=100_000,              # limit kroków
        algorithm="projected_gradient_bb",     # algorytm relaksacji
    )
    # Direct Python execution returns a runtime Result; the interactive CLI
    # capture path returns a staged Problem and performs relax -> run
    # continuation internally, so the export step is skipped there.
    if hasattr(relax_result, "save_state"):
        relax_result.save_state(RELAXED_STATE_ZARR, format="zarr")
        relax_result.save_state(RELAXED_STATE_H5, format="h5")
        body.m = fm.load_magnetization(RELAXED_STATE_ZARR, format="zarr")

# ── Eigenmode analysis ──────────────────────────────────────
