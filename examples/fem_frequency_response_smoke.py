"""Small FEM relax-then-driven-frequency-response smoke.

This exercises the native FEM/MFEM lane for the production workflow expected by
the UI: relax the equilibrium state first, then compute the driven harmonic
response from that relaxed state at explicitly requested probe frequencies.

This is not the modal FMR discovery workflow. If the resonance frequencies are
unknown, run a relax-then-eigenmodes example first, such as
``examples/fem_fmr_free_demag_airbox_smoke.py`` or
``examples/permalloy_box_relax_300x1000x10nm.py``. The driven response stage is
for a known frequency list, for example a sweep window chosen after modal
eigensolve or from an experimental range.
"""

from pathlib import Path

import fullmag as fm

MESH_PATH = Path(__file__).with_name("assets").joinpath("box_40x20x10_coarse.mesh.json")
PROBE_FREQUENCIES_HZ = [1.0e9, 2.0e9, 3.0e9, 4.0e9]


study = fm.study("fem_frequency_response_smoke")
study.engine("fem")
study.device("cpu", precision="double")

study.objects.mesh.defaults(
    maximum_element_size=5e-9,
    order=1,
    source=str(MESH_PATH),
)

body = study.geometry(fm.Box(size=(200e-9, 100e-9, 10e-9), name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((0.98, 0.12, 0.04))

study.demag(realization="fredkin_koehler")
study.b_ext(0.05, 0.0, 0.0)
study.solver(dt=1e-13, g=2.115)
study.tableautosave(1e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])

study.save("m", every=10e-12)
study.save_response("susceptibility_tensor")

study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=1000,
    tol=1e-5,
)
study.stages.add_frequency_response(
    frequencies_hz=PROBE_FREQUENCIES_HZ,
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    include_demag=False,
    equilibrium_source="relax",
    damping_policy="include",
)


if __name__ == "__main__":
    study.run()
