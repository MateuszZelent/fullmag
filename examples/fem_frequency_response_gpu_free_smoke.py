"""Small FEM GPU gamma/free frequency-response smoke.

This exercises the native FEM production GPU driven-response slice supported by
the current capability matrix: P1, double precision, free boundary, no demag,
no DMI, gamma point, and artifact-backed response fields.
"""

import fullmag as fm


study = fm.study("fem_frequency_response_gpu_free_smoke")
study.engine("fem")
study.device("gpu", precision="double")

body = study.geometry(fm.Box(size=(30e-9, 30e-9, 10e-9), name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=30e-9, order=1)

study.b_ext(0.01, 0.0, 0.0)
study.demag(enabled=False)
study.solver(dt=1e-13, g=2.115)
study.save_response("susceptibility_tensor")

study.stages.add_frequency_response(
    frequencies_hz=[1.0e9],
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=False,
    equilibrium_source="provided",
    damping_policy="include",
    bc="free",
)
