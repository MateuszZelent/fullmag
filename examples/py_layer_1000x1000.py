"""Py layer 1000×1000×10 nm with 100nm diameter hole — in-plane magnetized, FDM.

A thin Permalloy film with a cylindrical hole in the center.
Uses CSG Difference: Box minus Cylinder.

Usage:
    fullmag examples/py_layer_1000x1000.py
"""

import fullmag as fm


DEFAULT_UNTIL = 1e-15


def build() -> fm.Problem:
    # ── Geometry: Box with cylindrical hole ──────────
    layer = fm.Box(size=(1000e-9, 1000e-9, 10e-9), name="layer")
    hole = fm.Cylinder(radius=50e-9, height=10e-9, name="hole")
    body = fm.Difference(base=layer, tool=hole, name="py_layer_with_hole")

    # ── Material: Permalloy ──────────────────────────
    py = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)

    # ── Ferromagnet: in-plane magnetization (along +x) ──
    magnet = fm.Ferromagnet(
        name="py_layer_with_hole",
        geometry=body,
        material=py,
        m0=fm.texture.uniform((1.0, 0.0, 0.0)),
    )

    return fm.Problem(
        name="py_layer_with_hole",
        magnets=[magnet],
        energy=[
            fm.Exchange(),
            fm.Demag(),
        ],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(),
            outputs=[
                fm.SaveField("m", every=1e-12),
                fm.SaveScalar("E_ex", every=1e-13),
                fm.SaveScalar("E_demag", every=1e-13),
                fm.SaveScalar("E_total", every=1e-13),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(5e-9, 5e-9, 10e-9)),
        ),
    )


if __name__ == "__main__":
    problem = build()

    # ── Demonstrate mesh generation + STL export ─────
    body = problem.magnets[0].geometry
    mesh = fm.generate_mesh(body, hmax=20e-9)
    print(f"Mesh: {mesh.n_nodes} nodes, {mesh.n_elements} tetrahedra")
    mesh.save("py_layer_with_hole.mesh.json")
    fm.export_stl(body, "py_layer_with_hole.stl")
    print("Exported: py_layer_with_hole.stl, py_layer_with_hole.mesh.json")

    # ── Run simulation ───────────────────────────────
    result = fm.Simulation(problem, backend="fdm").run(until=DEFAULT_UNTIL)
    print(f"Status: {result.status}")
else:
    problem = build()
