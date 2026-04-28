"""Permalloy thin-film relaxation with a central 150 nm hole — boundary correction test.

Compares three FDM boundary correction modes:
  1. none   — standard binary mask (default, staircase)
  2. volume — T0: φ-weighted exchange + demag (sub-cell volume fraction)
  3. full   — T1: ECB boundary stencil + sparse demag correction (García-Cervera)

Run each variant and compare relaxed energies to assess staircase artefact reduction.
Usage:
    fullmag examples/py_layer_hole_relax_150nm_boundary_test.py
"""

import fullmag as fm

# ── Engine ──────────────────────────────────────────────────
fm.engine("fdm")
fm.device("cuda:0", precision="double")
fm.cell(5e-9, 5e-9, 10e-9)

# ── Boundary correction ────────────────────────────────────
# Choose one of: "none", "volume", "full"
# "none"   — standard binary mask (staircase artefacts at curved boundaries)
# "volume" — T0: volume-fraction weighted exchange and φ-weighted demag packing
# "full"   — T1: ECB/García boundary stencil + sparse ΔN demag correction
fm.boundary_correction("volume")

# ── Geometry & Material ─────────────────────────────────────
layer = fm.geometry(fm.Box(1000e-9, 1000e-9, 10e-9) - fm.Cylinder(radius=75e-9, height=10e-9))
layer.Ms    = 800e3       # saturation magnetisation [A/m]
layer.Aex   = 13e-12      # exchange stiffness [J/m]
layer.alpha = 0.5         # Gilbert damping
layer.m     = fm.texture.uniform(1, 0, 0)

# ── Solver ──────────────────────────────────────────────────
fm.solver(dt=1e-13)

# ── Run ─────────────────────────────────────────────────────
fm.relax()
