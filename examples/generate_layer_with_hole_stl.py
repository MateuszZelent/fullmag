"""Generate mesh of Permalloy layer 1000×1000×10 nm with 150nm radius hole.

Usage:
    python examples/generate_layer_with_hole_stl.py
"""

import numpy as np
import fullmag as fm

# ── Geometry: Box with cylindrical hole ──────────
layer = fm.Box(size=(1000e-9, 1000e-9, 10e-9), name="layer")
hole = fm.Cylinder(radius=150e-9, height=10e-9, name="hole")
body = fm.Difference(base=layer, tool=hole, name="py_layer_with_hole")

# ── Generate FEM tetrahedral mesh via Gmsh ───────
mesh = fm.generate_mesh(body, hmax=20e-9)
print(f"Mesh: {mesh.n_nodes} nodes, {mesh.n_elements} tetrahedra, {mesh.n_boundary_faces} boundary faces")

# ── Create synthetic initial magnetization (uniform +x) ──
m0 = np.tile([1.0, 0.0, 0.0], (mesh.n_nodes, 1))

# ── Export ────────────────────────────────────────
mesh.save("py_layer_with_hole.mesh.json")
mesh.export_stl("py_layer_with_hole.stl")
mesh.export_vtk("py_layer_with_hole.vtk", fields={"m": m0})
print("Saved: py_layer_with_hole.mesh.json")
print("Saved: py_layer_with_hole.stl")
print("Saved: py_layer_with_hole.vtk  (with m field — f3d py_layer_with_hole.vtk)")
