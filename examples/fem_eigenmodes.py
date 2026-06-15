"""FEM eigenmodes example with demag airbox.

Computes the normal-mode spectrum of a small Permalloy box from a uniform
equilibrium under a 50 mT applied field along x using the CPU FEM eigen
baseline solver. Demag is enabled through a shared-domain Poisson-Robin airbox
mesh, which is required by the FEM demag contract.

Usage:
    fullmag examples/fem_eigenmodes.py --headless

or with explicit CPU execution:
    FULLMAG_FEM_EXECUTION=cpu fullmag examples/fem_eigenmodes.py --headless
"""

import fullmag as fm

N_MODES = 10
APPLIED_B_T = (0.05, 0.0, 0.0)


study = fm.study("fem_eigenmodes")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(180e-9, 120e-9, 80e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=120e-9)

body = study.geometry(fm.Box(size=(80e-9, 40e-9, 10e-9), name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=40e-9, order=1)

study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.b_ext(*APPLIED_B_T)

study.save("spectrum")
study.save("mode", indices=tuple(range(N_MODES)))

study.stages.add_eigenmodes(
    count=N_MODES,
    target="lowest",
    include_demag=True,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
)
