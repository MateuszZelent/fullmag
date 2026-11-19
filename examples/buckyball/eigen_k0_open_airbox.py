"""Buckyball k=0 spectrum and modes: GPU relaxation, then CPU open-airbox eigen.

The isolated shell sits in a cubic Robin airbox, so the modal stage uses
``magnetostatic_bc="open_airbox_k0"`` (note 0830, "Otwarte pudełko powietrza
bez periodyczności"): dynamic Poisson demag with a Robin condition on the whole
outer boundary and no periodic seams. The GPU modal lane needs a periodic
certificate, so the eigen stage switches to CPU explicitly.

Material and size come from params.txt: Ms=400 kA/m, A=8 pJ/m, outer size 5 um.
The default 64 nm magnetic sizing exceeds the exchange length (~8.9 nm); the
spectrum is a preliminary run, not a converged FMR result.

Usage (headless, inside the backend):
    fullmag examples/buckyball/eigen_k0_open_airbox.py --headless
Environment overrides: FULLMAG_BUCKY_MAG_HMAX_NM, FULLMAG_BUCKY_MODES,
FULLMAG_BUCKY_TARGET_GHZ, FULLMAG_BUCKY_BIAS_T, FULLMAG_BUCKY_RELAX_DEVICE.
"""

# %% Parameters (SI)
import os
from pathlib import Path

import fullmag as fm

SCRIPT_DIR = Path(__file__).resolve().parent
STL_PATH = SCRIPT_DIR / "buckyball.stl"
OUTER_SIZE_M = 5e-6
STL_MAX_EXTENT = 5.361742973327637
STL_SCALE = OUTER_SIZE_M / STL_MAX_EXTENT
MS_A_PER_M = 400e3
AEX_J_PER_M = 8e-12
MAGNETIC_MESH_M = float(os.environ.get("FULLMAG_BUCKY_MAG_HMAX_NM", "64")) * 1e-9
AIR_MIN_MESH_M = 2.0 * MAGNETIC_MESH_M
AIR_MESH_M = 500e-9
MODE_COUNT = int(os.environ.get("FULLMAG_BUCKY_MODES", "10"))
TARGET_HZ = float(os.environ.get("FULLMAG_BUCKY_TARGET_GHZ", "3.0")) * 1e9
BIAS_T = float(os.environ.get("FULLMAG_BUCKY_BIAS_T", "0.0"))
RELAX_DEVICE = os.environ.get("FULLMAG_BUCKY_RELAX_DEVICE", "gpu")

if not STL_PATH.is_file():
    raise FileNotFoundError(f"Missing buckyball geometry: {STL_PATH}")

# %% Study: strict double precision; relaxation on GPU by default
study = fm.study("buckyball_k0_open_airbox_modes")
study.engine("fem")
study.device(RELAX_DEVICE, precision="double")
study.mode("strict")

# %% Exterior Robin airbox for open-boundary demagnetization
study.universe(mode="manual", size=(3 * OUTER_SIZE_M,) * 3, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(
    minimum_element_size=AIR_MIN_MESH_M,
    maximum_element_size=AIR_MESH_M,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# %% Magnetic shell: exchange and demag, no crystalline anisotropy
body = study.geometry(
    fm.ImportedGeometry(source=str(STL_PATH), scale=STL_SCALE, name="buckyball"),
    name="buckyball",
)
body.Ms = MS_A_PER_M
body.Aex = AEX_J_PER_M
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=MAGNETIC_MESH_M, order=1)

study.exchange()
study.demag(realization="poisson_robin")
study.b_ext(BIAS_T, 0.0, 0.0)
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-12, max_iterations=1000)

study.save("spectrum")
study.save("mode", indices=tuple(range(MODE_COUNT)))

# %% Relax to an accepted equilibrium (torque criterion)
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=100_000,
    tolT=1e-6,
)

# %% k=0 modes on CPU with dynamic open-airbox demag
study.stages.change_device("cpu")
study.stages.add_eigenmodes(
    count=MODE_COUNT,
    target="nearest",
    target_frequency=TARGET_HZ,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="free",
    magnetostatic_bc="open_airbox_k0",
)
