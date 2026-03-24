"""Bootstrap executable FEM example: Exchange + Demag + Zeeman on a coarse box mesh.

This example exercises the first narrow FEM demagnetization path:
- backend='fem'
- prebuilt tetrahedral mesh asset
- Exchange + bootstrap FEM Demag + Zeeman
- LLG with Heun integrator

The current FEM demag implementation is a Robin-truncated scalar-potential
reference solve. It is intentionally a small-mesh CPU reference path, not the
final MFEM/libCEED/hypre backend.

Usage:
    fullmag examples/fem_exchange_demag_zeeman.py --until 5e-12 --backend fem --headless
"""

from pathlib import Path

import fullmag as fm


MESH_PATH = Path(__file__).with_name("assets").joinpath("box_40x20x10_coarse.mesh.json")


def build() -> fm.Problem:
    body = fm.Box(size=(40e-9, 20e-9, 10e-9), name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="body",
        geometry=body,
        material=material,
        m0=fm.init.uniform((0.0, 0.0, 1.0)),
    )

    return fm.Problem(
        name="fem_exchange_demag_zeeman",
        magnets=[magnet],
        energy=[
            fm.Exchange(),
            fm.Demag(),
            fm.Zeeman(B=(0.0, 0.0, 0.01)),
        ],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(fixed_timestep=1e-13),
            outputs=[
                fm.SaveField("m", every=1e-12),
                fm.SaveField("H_ex", every=1e-12),
                fm.SaveField("H_demag", every=1e-12),
                fm.SaveField("H_ext", every=1e-12),
                fm.SaveField("H_eff", every=1e-12),
                fm.SaveScalar("E_ex", every=1e-13),
                fm.SaveScalar("E_demag", every=1e-13),
                fm.SaveScalar("E_ext", every=1e-13),
                fm.SaveScalar("E_total", every=1e-13),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fem=fm.FEM(order=1, hmax=5e-9, mesh=str(MESH_PATH)),
        ),
    )


if __name__ == "__main__":
    problem = build()
    result = fm.Simulation(problem, backend="fem").run(until=5e-12)

    print(f"Status: {result.status}")
    if result.steps:
        final = result.steps[-1]
        print(f"Total steps: {len(result.steps)}")
        print(f"Final E_ex: {final.e_ex:.6e} J")
        print(f"Final E_demag: {final.e_demag:.6e} J")
        print(f"Final E_ext: {final.e_ext:.6e} J")
        print(f"Final E_total: {final.e_total:.6e} J")
        print(f"Final time: {final.time:.6e} s")
    if result.output_dir:
        print(f"Artifacts written to: {result.output_dir}")
else:
    problem = build()
