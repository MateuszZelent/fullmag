"""Permalloy thin film relaxation — 500×500×10 nm, 1×1×10 nm cells.

Visualization demo: large enough grid to see domain structure in 2D/3D preview.
Uses random initial magnetization to produce visible exchange-driven relaxation.

Usage:
    fullmag examples/py_layer_relax.py --until 5e-9
"""

import fullmag as fm


def build() -> fm.Problem:
    layer = fm.Box(size=(500e-9, 500e-9, 10e-9), name="py_layer")
    mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="py_layer",
        geometry=layer,
        material=mat,
        m0=fm.init.random(seed=7),
    )

    return fm.Problem(
        name="py_layer_relax",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(),
            outputs=[
                fm.SaveField("m", every=200e-12),
                fm.SaveField("H_ex", every=500e-12),
                fm.SaveScalar("E_ex", every=10e-12),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(1e-9, 1e-9, 10e-9)),
        ),
    )


if __name__ == "__main__":
    problem = build()
    result = fm.Simulation(problem, backend="fdm").run(until=5e-9)

    print(f"Status: {result.status}")
    if result.steps:
        print(f"Total steps: {len(result.steps)}")
        print(f"Final E_ex: {result.steps[-1].e_ex:.6e} J")
        print(f"Final time: {result.steps[-1].time:.6e} s")
    if result.output_dir:
        print(f"Artifacts written to: {result.output_dir}")
    for note in result.notes:
        print(f"  Note: {note}")
else:
    problem = build()
