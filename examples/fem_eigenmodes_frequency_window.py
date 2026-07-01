"""FEM frequency-window eigenmodes example with demag airbox.

This mirrors ``fem_eigenmodes.py`` but requests an explicit frequency window
so managed runtime and benchmark gates exercise the interval-target artifact
path.

Usage:
    fullmag examples/fem_eigenmodes_frequency_window.py --headless

or with explicit CPU execution:
    FULLMAG_FEM_EXECUTION=cpu fullmag examples/fem_eigenmodes_frequency_window.py --headless
"""

import fullmag as fm

N_MODES = 10
APPLIED_B_T = (0.05, 0.0, 0.0)
FREQUENCY_MIN_HZ = 100e6
FREQUENCY_MAX_HZ = 5e9


study = fm.study("fem_eigenmodes_frequency_window")
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
    target="frequency_window",
    frequency_min=FREQUENCY_MIN_HZ,
    frequency_max=FREQUENCY_MAX_HZ,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
)
