"""Small FEM nonzero-k Floquet no-demag frequency-response smoke.

This exercises only the current narrow production CPU/GPU development slice:
explicit device intent, magnetic-domain mesh, complete x-periodic pair metadata,
nonzero-k Floquet drive phase projection, exchange/local terms, no DMI, and no
demag. It must not be used as evidence for periodic demag or full Bloch-reduced
operator production support. The default remains GPU; set
``FULLMAG_FMR_DEVICE=cpu`` for the CPU runtime gate.
"""

import os
from pathlib import Path

import fullmag as fm

MESH_PATH = Path(__file__).with_name("assets").joinpath("box_40x20x10_xperiodic.mesh.json")
DEVICE = os.environ.get("FULLMAG_FMR_DEVICE", "gpu").strip().lower()
KX_RAD_PER_M = float(os.environ.get("FULLMAG_FMR_FLOQUET_KX_RAD_PER_M", "1.0e6"))


def build() -> fm.Problem:
    if DEVICE not in {"cpu", "gpu"}:
        raise ValueError("FULLMAG_FMR_DEVICE must be 'cpu' or 'gpu'")

    body = fm.Box(size=(40e-9, 20e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=fm.init.UniformMagnetization((1.0, 0.0, 0.0)),
    )

    return fm.Problem(
        name="fem_frequency_response_gpu_floquet_no_demag_smoke",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.FrequencyResponse(
            outputs=[fm.SaveResponse("susceptibility_tensor")],
            frequencies_hz=[1.0e9, 2.0e9],
            excitation_field_au_per_m=(0.0, 0.0, 1.0),
            include_demag=False,
            equilibrium_source="provided",
            damping_policy="include",
            spin_wave_bc=fm.FloquetBC(["x_faces"]),
            k_vector=(KX_RAD_PER_M, 0.0, 0.0),
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, maximum_element_size=20e-9, mesh=str(MESH_PATH)),
        ),
        runtime=fm.RuntimeSelection(
            backend_target="fem",
            device_target=DEVICE,
            gpu_count=1 if DEVICE == "gpu" else 0,
            execution_precision="double",
        ),
    )


if __name__ == "__main__":
    fm.Simulation(build(), backend="fem").run()
