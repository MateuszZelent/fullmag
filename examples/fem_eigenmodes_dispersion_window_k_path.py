"""FEM production CPU selected-spectrum no-demag k-path dispersion example.

Computes a small no-demag reciprocal low-k Floquet k-path with a
frequency-window target. This is a managed-runtime proof for the current
production CPU Bloch/Floquet selected-spectrum modal slice; dynamic demag-k,
Damon-Eshbach/backward-volume analytic acceptance, broader sparse/matrix-free
Floquet validation, and native GPU modal dispersion remain unsupported.

Usage:
    FULLMAG_FEM_EXECUTION=cpu fullmag examples/fem_eigenmodes_dispersion_window_k_path.py --headless
"""

import fullmag as fm


study = fm.study("fem_eigenmodes_dispersion_window_k_path")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(40e-9, 40e-9, 40e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=40e-9)

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
    frequency_min=1.0e9,
    frequency_max=3.0e9,
    operator="full_2x2",
    include_demag=False,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("G", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (2.0e6, 0.0, 0.0)),
            fm.KPoint("G", (0.0, 0.0, 0.0)),
            fm.KPoint("-X", (-2.0e6, 0.0, 0.0)),
        ],
        samples_per_segment=[1, 1, 1],
    ),
    bc=fm.FloquetBC(["x_faces"]),
)
