"""Permalloy thin-film relaxation with a central 150 nm hole.

Flat scripting API — inspired by mumax3.
    fullmag examples/py_layer_hole_relax_150nm.py
"""

import fullmag as fm

# ── Engine ──────────────────────────────────────────────────
fm.engine("fem")
fm.device("cuda:0",precision="single")
# fm.cell(5e-9, 5e-9, 10e-9)

# ── Geometry & Material ─────────────────────────────────────
layer = fm.geometry(fm.Box(1000e-9, 1000e-9, 10e-9) - fm.Cylinder(radius=75e-9, height=10e-9))
layer.Ms    = 800e3       # saturation magnetisation [A/m]
layer.Aex   = 13e-12      # exchange stiffness [J/m]
layer.alpha = 0.5         # Gilbert damping
layer.m     = fm.uniform(1, 0, 0)

# ── Solver ──────────────────────────────────────────────────
fm.solver(dt=1e-13)

# ── Outputs ─────────────────────────────────────────────────
# fm.save("m",       every=50e-12)
# fm.save("H_demag", every=50e-12)
# fm.save("H_eff",   every=50e-12)
# fm.save("E_ex",    every=10e-12)
# fm.save("E_demag", every=10e-12)
# fm.save("E_total", every=10e-12)

# ── Run ─────────────────────────────────────────────────────
fm.relax()
fm.run(5e-10)
