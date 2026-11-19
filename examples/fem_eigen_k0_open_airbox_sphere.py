"""Open-airbox k=0 FEM modal check on a sphere (Kittel oracle).

An isolated sphere in a Robin airbox has equal demagnetizing factors, so the
uniform mode frequency is f = |gamma| mu0 H_b / (2 pi), independent of Ms.
A solver that drops the dynamic potential coupling would instead give
f = |gamma| mu0 (H_b - Ms/3) / (2 pi). See note 0830, "Otwarte pudełko
powietrza bez periodyczności".

Usage (headless, CPU):
    fullmag examples/fem_eigen_k0_open_airbox_sphere.py --headless
"""

# %% Parameters (SI)
import math
import os

import fullmag as fm

MU0 = 4.0e-7 * math.pi
GAMMA_HZ_PER_T = 28.0249514242e9  # |gamma| / (2 pi) for g = 2.0023
RADIUS_M = float(os.environ.get("FULLMAG_OPEN_SPHERE_RADIUS_NM", "20.0")) * 1e-9
MAG_HMAX_M = float(os.environ.get("FULLMAG_OPEN_SPHERE_MAG_HMAX_NM", "4.0")) * 1e-9
AIR_HMAX_M = float(os.environ.get("FULLMAG_OPEN_SPHERE_AIR_HMAX_NM", "25.0")) * 1e-9
BOX_FACTOR = float(os.environ.get("FULLMAG_OPEN_SPHERE_BOX_FACTOR", "8.0"))
BIAS_T = float(os.environ.get("FULLMAG_OPEN_SPHERE_BIAS_T", "0.1"))
MS = 800e3
EXPECTED_HZ = GAMMA_HZ_PER_T * BIAS_T
STATIC_ONLY_HZ = GAMMA_HZ_PER_T * (BIAS_T - MU0 * MS / 3.0)
print(f"open_airbox_sphere oracle: f_kittel={EXPECTED_HZ:.6e} Hz, "
      f"static_demag_only={STATIC_ONLY_HZ:.6e} Hz")

# %% Study: strict, double precision, CPU modal lane
study = fm.study("fem_eigen_k0_open_airbox_sphere")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Isolated sphere inside a cubic Robin airbox
box = BOX_FACTOR * 2.0 * RADIUS_M
study.universe(mode="manual", size=(box, box, box), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(
    minimum_element_size=MAG_HMAX_M,
    maximum_element_size=AIR_HMAX_M,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)
body = study.geometry(fm.Sphere(RADIUS_M, name="sphere"), name="sphere")
body.Ms = MS
body.Aex = 13e-12
body.alpha = 0.0
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=MAG_HMAX_M, order=1)

study.b_ext(BIAS_T, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-12, max_iterations=1000)
study.build_domain_mesh()

study.save("spectrum")
study.save("mode", indices=(0,))

# %% Relax, then the open-airbox k=0 modal stage
# A faceted sphere is not exactly uniform at equilibrium; the eigen stage
# requires an accepted (converged) relaxation handoff.
study.stages.add_relax(algorithm="projected_gradient_bb", max_steps=20_000, tolT=1e-6)
study.stages.add_eigenmodes(
    count=1,
    target="nearest",
    target_frequency=EXPECTED_HZ,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc="free",
    magnetostatic_bc="open_airbox_k0",
)
