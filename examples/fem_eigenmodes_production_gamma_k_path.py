"""FEM production CPU gamma k-path modal adapter smoke.

This intentionally repeats gamma-equivalent k-points through a KPath so the
multi-k modal orchestrator must use the production CPU selected-spectrum
entrypoint for every legal sample. It is not a nonzero-k Floquet/Bloch
dispersion example.

Usage:
    FULLMAG_FEM_EXECUTION=cpu fullmag examples/fem_eigenmodes_production_gamma_k_path.py --headless
"""

import fullmag as fm


N_MODES = 2
FREQUENCY_MIN_HZ = 100e6
FREQUENCY_MAX_HZ = 5e9


study = fm.study("fem_eigenmodes_production_gamma_k_path")
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
study.b_ext(0.05, 0.0, 0.0)

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=(0,))

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
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("G0", (0.0, 0.0, 0.0)),
            fm.KPoint("G2", (0.0, 0.0, 0.0)),
        ],
        samples_per_segment=[2],
    ),
    bc="free",
)
