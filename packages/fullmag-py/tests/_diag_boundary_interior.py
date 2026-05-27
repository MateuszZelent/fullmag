"""Check: are the long edges on the boundary or interior?"""
import numpy as np
import fullmag as fm
from fullmag.meshing.asset_pipeline import realize_fem_domain_mesh_asset_from_components_with_report
from fullmag.model.discretization import PerObjectMeshRecipe

cube = fm.Box((80e-9, 80e-9, 40e-9), name="cube")
cylinder = fm.Translate(
    fm.Cylinder(radius=40e-9, height=40e-9, name="cylinder_base"),
    (150e-9, 0.0, 0.0),
    name="cylinder",
)

m, rm, rp = realize_fem_domain_mesh_asset_from_components_with_report(
    geometries=[cube, cylinder],
    hints=fm.FEM(order=1, hmax=80e-9),
    study_universe={
        "mode": "manual",
        "size": [360e-9, 240e-9, 160e-9],
        "center": [60e-9, 0, 0],
        "airbox_hmax": 80e-9,
        "airbox_hmin": 20e-9,
    },
    per_object_recipes={
        "cube": PerObjectMeshRecipe(hmax=8e-9, hmin=3e-9),
        "cylinder": PerObjectMeshRecipe(hmax=28e-9, hmin=8e-9),
    },
)
mk = {str(e["geometry_name"]): int(e["marker"]) for e in rm}
cyl_marker = mk["cylinder"]

# Get cylinder elements
cyl_mask = np.asarray(m.element_markers) == cyl_marker
cyl_elems = m.elements[cyl_mask]

# Get cylinder boundary faces 
cyl_boundary_nodes = set()
for face in m.boundary_faces:
    cyl_boundary_nodes.update(face.tolist())

# Classify edges as boundary (both nodes on boundary) or interior
edge_pairs = np.asarray([[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]], dtype=np.int64)
all_edges = cyl_elems[:, edge_pairs].reshape(-1, 2)
all_edges.sort(axis=1)
all_edges = np.unique(all_edges, axis=0)
lengths = np.linalg.norm(m.nodes[all_edges[:,0]] - m.nodes[all_edges[:,1]], axis=1)

# Get all nodes in cylinder elements
cyl_nodes = set(cyl_elems.flatten().tolist())
# Get boundary nodes of cylinder (nodes shared with other domains)
# A boundary node is one that appears in elements of OTHER markers too
other_mask = ~cyl_mask & (np.asarray(m.element_markers) > 0)
other_nodes = set(m.elements[other_mask].flatten().tolist()) if np.any(other_mask) else set()
air_mask = np.asarray(m.element_markers) == 0
air_nodes = set(m.elements[air_mask].flatten().tolist()) if np.any(air_mask) else set()
interface_nodes = cyl_nodes & (other_nodes | air_nodes)

# Edges where at least one node is on the interface
is_interface = np.array([
    (int(e[0]) in interface_nodes or int(e[1]) in interface_nodes)
    for e in all_edges
])
is_interior = ~is_interface

print(f"Cylinder edges: {len(all_edges)} total")
print(f"  Interface edges: {np.sum(is_interface)}")
print(f"  Interior edges: {np.sum(is_interior)}")

if np.any(is_interface):
    iface_lengths = lengths[is_interface]
    print(f"\n  Interface: median={np.median(iface_lengths)*1e9:.2f} p95={np.percentile(iface_lengths,95)*1e9:.2f} max={np.max(iface_lengths)*1e9:.2f}")
if np.any(is_interior):
    int_lengths = lengths[is_interior]
    print(f"  Interior:  median={np.median(int_lengths)*1e9:.2f} p95={np.percentile(int_lengths,95)*1e9:.2f} max={np.max(int_lengths)*1e9:.2f}")

# Check: what fraction of edges > 35nm
long_edges = lengths > 35e-9
print(f"\n  Edges > 35nm: {np.sum(long_edges)} ({100*np.mean(long_edges):.1f}%)")
long_on_iface = np.sum(long_edges & is_interface)
long_interior = np.sum(long_edges & is_interior)
print(f"    on interface: {long_on_iface}")
print(f"    interior: {long_interior}")
