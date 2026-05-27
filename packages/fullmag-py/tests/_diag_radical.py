"""Radykalny test: shared domain z ręcznym polem Min(Constant_cube, Constant_cyl)
bez żadnego airbox Threshold — czy cylinder p95 nadal jest 40nm?"""
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
edge_pairs = np.asarray([[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]], dtype=np.int64)

def edges(mesh, marker):
    elems = mesh.elements[np.asarray(mesh.element_markers) == marker]
    e = elems[:, edge_pairs].reshape(-1, 2)
    e.sort(axis=1)
    e = np.unique(e, axis=0)
    return np.linalg.norm(mesh.nodes[e[:,0]] - mesh.nodes[e[:,1]], axis=1)

# Test 1: normal (with per-object recipes)
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
ce = edges(m, mk["cube"])
cye = edges(m, mk["cylinder"])
print(f"WITH recipes  : cube med={np.median(ce)*1e9:.2f} p95={np.percentile(ce,95)*1e9:.2f} | cyl med={np.median(cye)*1e9:.2f} p95={np.percentile(cye,95)*1e9:.2f} max={np.max(cye)*1e9:.2f}")

# Test 2: NO per-object recipes — just FEM hmax=28nm for everything
m2, rm2, rp2 = realize_fem_domain_mesh_asset_from_components_with_report(
    geometries=[cube, cylinder],
    hints=fm.FEM(order=1, hmax=28e-9),
    study_universe={
        "mode": "manual",
        "size": [360e-9, 240e-9, 160e-9],
        "center": [60e-9, 0, 0],
        "airbox_hmax": 80e-9,
        "airbox_hmin": 20e-9,
    },
)
mk2 = {str(e["geometry_name"]): int(e["marker"]) for e in rm2}
ce2 = edges(m2, mk2["cube"])
cye2 = edges(m2, mk2["cylinder"])
print(f"NO recipes h28: cube med={np.median(ce2)*1e9:.2f} p95={np.percentile(ce2,95)*1e9:.2f} | cyl med={np.median(cye2)*1e9:.2f} p95={np.percentile(cye2,95)*1e9:.2f} max={np.max(cye2)*1e9:.2f}")
