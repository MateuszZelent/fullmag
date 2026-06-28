"""Small FEM k=0 static-periodic frequency-response smoke.

This exercises the native FEM/MFEM production static-periodic slice for
``StudyIR::FrequencyResponse``. It intentionally keeps demag disabled and uses
zero-phase periodic boundary conditions; nonzero-k Floquet/Bloch response
remains a separate gated feature. By default this script requests CPU; the
GPU-specific wrapper uses the same problem with explicit GPU runtime intent.
"""

from pathlib import Path

import fullmag as fm

MESH_PATH = Path(__file__).with_name("assets").joinpath("box_40x20x10_xperiodic.mesh.json")


def build(*, device: str = "cpu") -> fm.Problem:
    device_target = device.strip().lower()
    if device_target not in {"cpu", "gpu"}:
        raise ValueError("device must be 'cpu' or 'gpu'")

    body = fm.Box(size=(40e-9, 20e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=fm.init.UniformMagnetization((1.0, 0.0, 0.0)),
    )

    return fm.Problem(
        name="fem_frequency_response_static_periodic_smoke",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.FrequencyResponse(
            outputs=[fm.SaveResponse("susceptibility_tensor")],
            frequencies_hz=[1.0e9, 2.0e9],
            excitation_field_au_per_m=(0.0, 0.0, 1.0),
            include_demag=False,
            equilibrium_source="provided",
            damping_policy="include",
            spin_wave_bc=fm.PeriodicBC(["x_faces"]),
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, maximum_element_size=20e-9, mesh=str(MESH_PATH)),
        ),
        runtime=fm.RuntimeSelection(
            backend_target="fem",
            device_target=device_target,
            gpu_count=1 if device_target == "gpu" else 0,
            execution_precision="double",
        ),
    )


if __name__ == "__main__":
    fm.Simulation(build(), backend="fem").run()
