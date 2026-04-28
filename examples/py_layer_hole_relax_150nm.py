"""Permalloy thin-film relaxation with a central 150 nm hole.

Canonical FEM study entrypoint for interactive and packaging smoke runs.
    fullmag examples/py_layer_hole_relax_150nm.py
"""

import fullmag as fm

study = fm.study("py_layer_hole_relax_150nm")

# ── Engine ──────────────────────────────────────────────────
study.engine("fem")
study.device("auto", precision="double")
study.universe(
    mode="auto",
    size=(1.5e-6, 1.5e-6, 3e-7),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=40e-9)

# ── Geometry & Material ─────────────────────────────────────
layer = study.geometry(
    fm.Box(1000e-9, 1000e-9, 10e-9) - fm.Cylinder(radius=75e-9, height=10e-9),
    name="layer",
)
layer.Ms = 800e3       # saturation magnetisation [A/m]
layer.Aex = 13e-12     # exchange stiffness [J/m]
layer.alpha = 0.5      # Gilbert damping
layer.m = fm.uniform(1, 0, 0)
layer.mesh(hmax=10e-9, order=1)
study.build_domain_mesh()

# ── Demag / Solver ──────────────────────────────────────────
study.demag(realization="poisson_robin")
study.solver(dt=1e-13)

# ── Outputs ─────────────────────────────────────────────────
# study.save("m",       every=50e-12)
# study.save("H_demag", every=50e-12)
# study.save("H_eff",   every=50e-12)
# study.save("E_ex",    every=10e-12)
# study.save("E_demag", every=10e-12)
# study.save("E_total", every=10e-12)

# ── Run ─────────────────────────────────────────────────────
study.relax()
study.run(5e-10)
