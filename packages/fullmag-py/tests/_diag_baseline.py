import numpy as np
import fullmag as fm
from fullmag.meshing.gmsh_bridge import generate_mesh

# Standalone cylinder mesh without any airbox
cylinder = fm.Cylinder(radius=40e-9, height=40e-9, name="cylinder")
mesh = generate_mesh(cylinder, hmax=28e-9, order=1)

edge_pairs = np.asarray([[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]], dtype=np.int64)
edges = mesh.elements[:, edge_pairs].reshape(-1, 2)
edges.sort(axis=1)
edges = np.unique(edges, axis=0)
lengths = np.linalg.norm(mesh.nodes[edges[:,0]] - mesh.nodes[edges[:,1]], axis=1)

print(f"Standalone cylinder (hmax=28nm, no airbox):")
print(f"  elements={mesh.n_elements}, nodes={mesh.n_nodes}")
print(f"  median={np.median(lengths)*1e9:.2f} nm")
print(f"  p95={np.percentile(lengths, 95)*1e9:.2f} nm")
print(f"  max={np.max(lengths)*1e9:.2f} nm")
