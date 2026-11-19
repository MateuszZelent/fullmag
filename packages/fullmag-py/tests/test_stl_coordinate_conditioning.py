"""SI preservation across internal STL coordinate conditioning."""
from unittest.mock import Mock

import numpy as np

from fullmag.meshing import _gmsh_generators as generators
from fullmag.meshing._gmsh_types import MeshData, MeshOptions, MeshQualityReport


def test_known_component_size_fields_can_use_micrometre_work_coordinates():
    options = MeshOptions(size_fields=[{
        "kind": "ComponentVolumeConstant", "params": {"GeometryName": "body", "VIn": 32e-9}
    }])
    assert generators._stl_work_coordinate_scale(options) == 1e6
    assert options.size_fields[0]["params"]["VIn"] == 32e-9


def test_uninterpreted_field_expressions_keep_their_existing_coordinate_frame():
    for field in ({"kind": "MathEval", "params": {"F": "x+1e-6"}},
                  {"kind": "ComponentRestrictedMathEval", "params": {"GeometryName": "body", "F": "x+1e-6"}},
                  {"kind": "UnknownField", "params": {}}):
        assert generators._stl_work_coordinate_scale(MeshOptions(size_fields=[field])) == 1.0



def test_optional_selectors_and_feature_controls_keep_their_si_frame():
    options = [
        MeshOptions(size_from_curvature=12),
        MeshOptions(curvature_factor=.2),
        MeshOptions(narrow_regions=3),
        MeshOptions(narrow_region_resolution=.5),
        MeshOptions(size_preset="normal"),
        MeshOptions(boundary_layer_target_surface_selectors=[{
            "kind":"nearest_surface_to_point", "point":[1e-6,0.,0.],
        }]),
        MeshOptions(boundary_layer_target_curve_selectors=[{
            "kind":"nearest_curve_to_point", "point":[1e-6,0.,0.],
        }]),
    ]
    for option in options:
        assert generators._stl_work_coordinate_scale(option) == 1.


def test_coordinate_conditioning_transforms_every_source_node_once():
    gmsh = Mock()
    generators._scale_stl_source_nodes(gmsh, 1e6)
    gmsh.model.mesh.affineTransform.assert_called_once_with(
        [1e6,0.,0.,0., 0.,1e6,0.,0., 0.,0.,1e6,0.])
    gmsh.reset_mock()
    generators._scale_stl_source_nodes(gmsh, 1.)
    gmsh.model.mesh.affineTransform.assert_not_called()


def test_work_mesh_returns_si_nodes_and_global_and_domain_volume_statistics():
    quality = MeshQualityReport(n_elements=2, sicn_min=1., sicn_max=1., sicn_mean=1.,
        sicn_p5=1., sicn_histogram=[], gamma_min=1., gamma_mean=1.,
        gamma_histogram=[], avg_quality=1., volume_min=1., volume_max=2., volume_mean=1.5,
        volume_std=.5, element_volume=[1.,2.])
    nodes = np.array([
        [0.,0.,0.], [1.,0.,0.], [0.,2.,0.], [0.,0.,3.],
        [3.,0.,0.], [5.,0.,0.], [3.,2.,0.], [3.,0.,3.],
    ])
    mesh = MeshData.from_legacy_tet4(
        nodes=nodes, elements=[[0,1,2,3],[4,5,6,7]], element_markers=[1,1],
        boundary_faces=[], boundary_markers=[], quality=quality,
        per_domain_quality={1:quality},
    )
    converted = generators._stl_mesh_in_si(mesh, 1e6)
    np.testing.assert_allclose(converted.nodes, nodes / 1e6, rtol=1e-14, atol=0.)
    vertices = converted.nodes[converted.cell_nodes.reshape(-1,4)]
    volumes = np.linalg.det(np.stack([
        vertices[:,1]-vertices[:,0], vertices[:,2]-vertices[:,0],
        vertices[:,3]-vertices[:,0],
    ], axis=1)) / 6
    for report in (converted.quality, converted.per_domain_quality[1]):
        assert np.isclose(report.volume_mean,1.5e-18,rtol=1e-14,atol=0.)
        np.testing.assert_allclose(report.element_volume,volumes,rtol=1e-14,atol=0.)
    np.testing.assert_array_equal(mesh.nodes,nodes)
    np.testing.assert_array_equal(converted.cell_nodes,mesh.cell_nodes)
    np.testing.assert_array_equal(converted.element_markers,mesh.element_markers)
