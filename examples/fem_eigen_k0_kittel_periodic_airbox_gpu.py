"""Production GPU FEM k=0 periodic-airbox dynamic-demag fixture.

The request is deliberately a single Gamma sample so it enters the shared
physical-domain modal lane.  GPU execution is strict: an unavailable device
or an unaccepted mesh/equilibrium certificate is an explicit failure and
cannot become a CPU result.

Usage:
    FULLMAG_FEM_EXECUTION=gpu fullmag examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py --headless
"""

import math

import fullmag as fm


MU0 = 4.0e-7 * math.pi
MS = 800e3
BIAS_T = 0.05

study = fm.study("fem_eigen_k0_kittel_periodic_airbox_gpu")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(40e-9, 20e-9, 50e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10e-9,
    maximum_element_size=40e-9,
    growth_rate=1.5,
    grading="linear",
)
study.objects.mesh.defaults(periodic_pair_ids=["x_faces"])

body = study.geometry(fm.Box(size=(40e-9, 20e-9, 10e-9), name="body"), name="body")
body.Ms = MS
body.Aex = 13e-12
body.alpha = 0.0
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=20e-9, order=1)

study.pbc(x=True, demag="periodic_airbox_k0")
study.b_ext(BIAS_T, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()

study.save("spectrum")
study.save("mode", indices=(0,))
study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-15,
    max_steps=32,
    tolA=1e-3,
    relax_alpha=1.0,
)
study.stages.add_eigenmodes(
    count=1,
    target="frequency_window",
    frequency_min=1e3,
    frequency_max=5.0e9,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
    bc=fm.PeriodicBC(["x_faces"]),
)
