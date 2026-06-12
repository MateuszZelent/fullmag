"""Small FEM frequency-response validation smoke.

This exercises the dense FEM validation lane for ``StudyIR::FrequencyResponse``.
It is intentionally exchange-only and uses a precomputed one-tetrahedron mesh so
the managed runtime smoke verifies the response artifact contract without
depending on production demag or meshing.
"""

from pathlib import Path

import fullmag as fm

MESH_PATH = Path(__file__).with_name("assets").joinpath("box_40x20x10_coarse.mesh.json")


def build() -> fm.Problem:
    body = fm.Box(size=(40e-9, 20e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=fm.texture.uniform((1.0, 0.0, 0.0)),
    )

    return fm.Problem(
        name="fem_frequency_response_smoke",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.FrequencyResponse(
            outputs=[fm.SaveResponse("susceptibility_tensor")],
            frequencies_hz=[1.0e9, 2.0e9],
            excitation_field_au_per_m=(0.0, 0.0, 1.0),
            include_demag=False,
            equilibrium_source="provided",
            damping_policy="include",
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, maximum_element_size=20e-9, mesh=str(MESH_PATH)),
        ),
    )


if __name__ == "__main__":
    fm.Simulation(build(), backend="fem").run()
