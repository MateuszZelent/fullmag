"""Permalloy thin-film relaxation with a central 150 nm hole.

Geometry:
- 1 µm × 1 µm × 10 nm Py layer
- central circular hole with 150 nm diameter
- Uses declarative CSG: Box - Cylinder

Works with both FDM and FEM backends:
    fullmag examples/py_layer_hole_relax_150nm.py --until 5e-10
    fullmag examples/py_layer_hole_relax_150nm.py --until 5e-10 --backend fem

Default script-owned runtime policy:
    runtime=fm.backend.engine("fdm")
CLI flags still act as explicit overrides.
"""

from __future__ import annotations

import fullmag as fm

LAYER_SIZE = (1_000e-9, 1_000e-9, 10e-9)
HOLE_DIAMETER = 150e-9
CELL = (5e-9, 5e-9, 10e-9)
DEFAULT_UNTIL = 5e-10


def build() -> fm.Problem:
    # Declarative CSG geometry: layer with a central hole
    layer = fm.Box(size=LAYER_SIZE, name="layer")
    hole = fm.Cylinder(radius=HOLE_DIAMETER / 2, height=LAYER_SIZE[2], name="hole")
    body = layer - hole  # CSG difference → works for both FDM and FEM

    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="film",
        geometry=body,
        material=material,
        m0=fm.uniform((1, 0, 0)),
    )

    return fm.Problem(
        name="py_layer_hole_relax_150nm",
        magnets=[magnet],
        energy=[
            fm.Exchange(),
            fm.Demag(),
        ],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(fixed_timestep=1e-13),
            outputs=[
                fm.SaveField("m", every=50e-12),
                fm.SaveField("H_demag", every=50e-12),
                fm.SaveField("H_eff", every=50e-12),
                fm.SaveScalar("E_ex", every=10e-12),
                fm.SaveScalar("E_demag", every=10e-12),
                fm.SaveScalar("E_total", every=10e-12),
                fm.SaveScalar("max_h_eff", every=10e-12),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=CELL),
            fem=fm.FEM(order=1, hmax=20e-9),
        ),
        runtime=fm.backend.engine("fdm"),
    )


if __name__ == "__main__":
    problem = build()
    result = fm.Simulation(problem).run(until=DEFAULT_UNTIL)

    print(f"Backend: {result.backend.value}")
    print(f"Status: {result.status}")
    if result.steps:
        final = result.steps[-1]
        print(f"Total steps: {len(result.steps)}")
        print(f"Final E_ex: {final.e_ex:.6e} J")
        print(f"Final E_demag: {final.e_demag:.6e} J")
        print(f"Final E_total: {final.e_total:.6e} J")
        print(f"Final time: {final.time:.6e} s")
    if result.output_dir:
        print(f"Artifacts written to: {result.output_dir}")
    for note in result.notes:
        print(f"  Note: {note}")
else:
    problem = build()
