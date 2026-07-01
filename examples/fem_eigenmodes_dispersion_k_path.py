"""FEM modal k-path dispersion example.

Computes a small no-demag Floquet eigenmode dispersion bundle on a three-point
Gamma-X path with an explicit frequency-window target. This is a managed-runtime
smoke for the modal artifact contract; it is not a dynamic-demag or GPU
production example.

Usage:
    FULLMAG_FEM_EXECUTION=cpu fullmag examples/fem_eigenmodes_dispersion_k_path.py --headless
"""

import fullmag as fm


FREQUENCY_MIN_HZ = 1.0
FREQUENCY_MAX_HZ = 1.0e13


study = fm.study("fem_eigenmodes_dispersion_k_path")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(80e-9, 40e-9, 40e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=80e-9)

body = study.geometry(fm.Box(size=(40e-9, 20e-9, 10e-9), name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=40e-9, order=1)

study.pbc(x=True)
study.build_domain_mesh()
study.b_ext(0.05, 0.0, 0.0)

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=(0,))

study.stages.add_eigenmodes(
    count=2,
    target="frequency_window",
    frequency_min=FREQUENCY_MIN_HZ,
    frequency_max=FREQUENCY_MAX_HZ,
    operator="full_2x2",
    include_demag=False,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("G", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (5.0e7, 0.0, 0.0)),
        ],
        samples_per_segment=[2],
    ),
    bc=fm.FloquetBC(["x_faces"]),
)
