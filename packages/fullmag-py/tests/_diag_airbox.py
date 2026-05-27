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

for ahmax, ahmin in [(80e-9, 20e-9), (160e-9, 40e-9), (160e-9, 80e-9)]:
    m, rm, rp = realize_fem_domain_mesh_asset_from_components_with_report(
        geometries=[cube, cylinder],
        hints=fm.FEM(order=1, hmax=80e-9),
        study_universe={
            "mode": "manual",
            "size": [360e-9, 240e-9, 160e-9],
            "center": [60e-9, 0, 0],
            "airbox_hmax": ahmax,
            "airbox_hmin": ahmin,
        },
        per_object_recipes={
            "cube": PerObjectMeshRecipe(hmax=8e-9, hmin=3e-9),
            "cylinder": PerObjectMeshRecipe(hmax=28e-9, hmin=8e-9),
        },
    )
    mk = {str(e["geometry_name"]): int(e["marker"]) for e in rm}
    ce = edges(m, mk["cube"])
    cye = edges(m, mk["cylinder"])
    print(
        f"air {ahmax*1e9:.0f}/{ahmin*1e9:.0f} | "
        f"cube med={np.median(ce)*1e9:.2f} p95={np.percentile(ce,95)*1e9:.2f} max={np.max(ce)*1e9:.2f} | "
        f"cyl med={np.median(cye)*1e9:.2f} p95={np.percentile(cye,95)*1e9:.2f} max={np.max(cye)*1e9:.2f} | "
        f"nodes={m.n_nodes}"
    )
