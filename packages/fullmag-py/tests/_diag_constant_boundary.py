"""Test: does Constant field with VolumesList + IncludeBoundary=1 
actually constrain surface mesh elements?"""
import numpy as np
import gmsh

gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)

gmsh.model.add("test_constant_boundary")

# Create a simple box 
box = gmsh.model.occ.addBox(-1, -1, -1, 2, 2, 2)
gmsh.model.occ.synchronize()

# Get volume and surface tags
volumes = [e[1] for e in gmsh.model.getEntities(3)]
surfaces = [e[1] for e in gmsh.model.getEntities(2)]
print(f"Volumes: {volumes}")
print(f"Surfaces: {surfaces}")

# --- Test 1: Just VolumesList, IncludeBoundary=1 ---
f1 = gmsh.model.mesh.field.add("Constant")
gmsh.model.mesh.field.setNumbers(f1, "VolumesList", volumes)
gmsh.model.mesh.field.setNumber(f1, "VIn", 0.1)
gmsh.model.mesh.field.setNumber(f1, "VOut", 10.0)
gmsh.model.mesh.field.setNumber(f1, "IncludeBoundary", 1)
gmsh.model.mesh.field.setAsBackgroundMesh(f1)

gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
gmsh.option.setNumber("Mesh.CharacteristicLengthMax", 10.0)

gmsh.model.mesh.generate(3)
nodes, coords, _ = gmsh.model.mesh.getNodes()
eltype, eltags, elnodes = gmsh.model.mesh.getElements(3)
tets = np.array(elnodes[0], dtype=np.int64).reshape(-1, 4) - 1
all_coords = np.zeros((int(max(nodes)), 3))
for i, nid in enumerate(nodes):
    all_coords[int(nid)-1] = coords[3*i:3*i+3]
    
edge_pairs = np.array([[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]])
edges = tets[:, edge_pairs].reshape(-1, 2)
lengths = np.linalg.norm(all_coords[edges[:,0]] - all_coords[edges[:,1]], axis=1)

print(f"\nTest 1: VolumesList + IncludeBoundary=1")
print(f"  VIn=0.1, elements={len(tets)}")
print(f"  edge median={np.median(lengths):.4f}, p95={np.percentile(lengths,95):.4f}, max={np.max(lengths):.4f}")

gmsh.clear()

# --- Test 2: VolumesList + SurfacesList ---
gmsh.model.add("test_constant_surfaces")
box = gmsh.model.occ.addBox(-1, -1, -1, 2, 2, 2)
gmsh.model.occ.synchronize()
volumes = [e[1] for e in gmsh.model.getEntities(3)]
surfaces = [e[1] for e in gmsh.model.getEntities(2)]

f2 = gmsh.model.mesh.field.add("Constant")
gmsh.model.mesh.field.setNumbers(f2, "VolumesList", volumes)
gmsh.model.mesh.field.setNumbers(f2, "SurfacesList", surfaces)
gmsh.model.mesh.field.setNumber(f2, "VIn", 0.1)
gmsh.model.mesh.field.setNumber(f2, "VOut", 10.0)
gmsh.model.mesh.field.setNumber(f2, "IncludeBoundary", 1)
gmsh.model.mesh.field.setAsBackgroundMesh(f2)

gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
gmsh.option.setNumber("Mesh.CharacteristicLengthMax", 10.0)

gmsh.model.mesh.generate(3)
nodes, coords, _ = gmsh.model.mesh.getNodes()
eltype, eltags, elnodes = gmsh.model.mesh.getElements(3)
tets = np.array(elnodes[0], dtype=np.int64).reshape(-1, 4) - 1
all_coords = np.zeros((int(max(nodes)), 3))
for i, nid in enumerate(nodes):
    all_coords[int(nid)-1] = coords[3*i:3*i+3]
    
edges = tets[:, edge_pairs].reshape(-1, 2)
lengths = np.linalg.norm(all_coords[edges[:,0]] - all_coords[edges[:,1]], axis=1)

print(f"\nTest 2: VolumesList + SurfacesList + IncludeBoundary=1")
print(f"  VIn=0.1, elements={len(tets)}")
print(f"  edge median={np.median(lengths):.4f}, p95={np.percentile(lengths,95):.4f}, max={np.max(lengths):.4f}")

gmsh.finalize()
