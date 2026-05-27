"""Diagnose actual Gmsh field values at cylinder boundary."""
import numpy as np
import fullmag as fm
from fullmag.meshing.asset_pipeline import realize_fem_domain_mesh_asset_from_components_with_report
from fullmag.model.discretization import PerObjectMeshRecipe
import fullmag.meshing._gmsh_occ as occ_module

# Monkey-patch to see what's going on
_orig = occ_module.generate_shared_domain_mesh_via_occ.__wrapped__ if hasattr(occ_module.generate_shared_domain_mesh_via_occ, '__wrapped__') else None

import gmsh as gmsh_module

# We'll hook into the OCC mesh builder to inspect fields before mesh generation
original_generate = gmsh_module.model.mesh.generate

def patched_generate(dim):
    """Print field diagnostics before generating mesh."""
    # List all fields
    try:
        fields = gmsh_module.model.mesh.field.list()
        print(f"\n=== Gmsh fields before mesh.generate({dim}) ===")
        print(f"  Total fields: {len(fields)}")
        for fid in fields:
            kind = gmsh_module.model.mesh.field.getType(fid)
            print(f"  Field {fid}: {kind}")
    except Exception as e:
        print(f"  Error listing fields: {e}")
    
    # Check background mesh
    try:
        bg = gmsh_module.option.getNumber("Mesh.MeshSizeFromPoints")
        print(f"  MeshSizeFromPoints = {bg}")
        bg2 = gmsh_module.option.getNumber("Mesh.MeshSizeExtendFromBoundary")
        print(f"  MeshSizeExtendFromBoundary = {bg2}")
        clmax = gmsh_module.option.getNumber("Mesh.CharacteristicLengthMax")
        print(f"  CharacteristicLengthMax = {clmax}")
        clmin = gmsh_module.option.getNumber("Mesh.CharacteristicLengthMin")
        print(f"  CharacteristicLengthMin = {clmin}")
    except Exception as e:
        print(f"  Error reading options: {e}")
    print()
    
    return original_generate(dim)

gmsh_module.model.mesh.generate = patched_generate

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
        "airbox_hmax": 160e-9,
        "airbox_hmin": 40e-9,
    },
    per_object_recipes={
        "cube": PerObjectMeshRecipe(hmax=8e-9, hmin=3e-9),
        "cylinder": PerObjectMeshRecipe(hmax=28e-9, hmin=8e-9),
    },
)
