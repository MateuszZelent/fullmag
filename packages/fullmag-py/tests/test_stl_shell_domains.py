"""Generic FEM import contract for nested and separate STL shells."""

from __future__ import annotations

from collections import defaultdict
from itertools import combinations
import math
import tempfile
import unittest
from pathlib import Path

import numpy as np

import fullmag as fm
from fullmag.meshing.asset_pipeline import (
    realize_fem_domain_mesh_asset_from_components_with_report,
)

try:
    import gmsh as _gmsh  # noqa: F401
except ImportError:
    _HAS_GMSH = False
else:
    _HAS_GMSH = True

try:
    import trimesh as _trimesh  # noqa: F401
except ImportError:
    _HAS_TRIMESH = False
else:
    _HAS_TRIMESH = True


_SOURCE_TO_METERS = 1.0e-6
_MESH_HMAX_M = 0.8e-6
_VOLUME_REL_TOL = 2.0e-3


def _cube_triangles(
    lower: tuple[float, float, float],
    upper: tuple[float, float, float],
    *,
    reverse_winding: bool = False,
    omit_face: int | None = None,
) -> list[np.ndarray]:
    """Return twelve outward-oriented triangles for a cube, optionally opened."""
    x0, y0, z0 = lower
    x1, y1, z1 = upper
    vertices = np.asarray(
        [
            (x0, y0, z0),
            (x1, y0, z0),
            (x1, y1, z0),
            (x0, y1, z0),
            (x0, y0, z1),
            (x1, y0, z1),
            (x1, y1, z1),
            (x0, y1, z1),
        ],
        dtype=np.float64,
    )
    oriented_faces = (
        ((0, 2, 1), (0, 3, 2)),  # -z
        ((4, 5, 6), (4, 6, 7)),  # +z
        ((0, 1, 5), (0, 5, 4)),  # -y
        ((3, 7, 6), (3, 6, 2)),  # +y
        ((0, 4, 7), (0, 7, 3)),  # -x
        ((1, 2, 6), (1, 6, 5)),  # +x
    )
    triangles: list[np.ndarray] = []
    for face_index, face_triangles in enumerate(oriented_faces):
        if face_index == omit_face:
            continue
        for face in face_triangles:
            triangle = vertices[np.asarray(face, dtype=np.int64)]
            if reverse_winding:
                triangle = triangle[[0, 2, 1]]
            triangles.append(triangle)
    return triangles


def _hollow_triangles(*, reverse_whole_file: bool = False) -> list[np.ndarray]:
    triangles = _cube_triangles((0.0, 0.0, 0.0), (2.0, 2.0, 2.0))
    triangles.extend(
        _cube_triangles(
            (0.5, 0.5, 0.5),
            (1.5, 1.5, 1.5),
            reverse_winding=True,
        )
    )
    if reverse_whole_file:
        triangles = [triangle[[0, 2, 1]] for triangle in triangles]
    return triangles


def _write_ascii_stl(path: Path, triangles: list[np.ndarray]) -> Path:
    lines = ["solid test_shells"]
    for triangle in triangles:
        normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
        normal /= np.linalg.norm(normal)
        lines.append(
            "  facet normal " + " ".join(f"{value:.9g}" for value in normal)
        )
        lines.append("    outer loop")
        for vertex in triangle:
            lines.append("      vertex " + " ".join(f"{value:.9g}" for value in vertex))
        lines.extend(("    endloop", "  endfacet"))
    lines.append("endsolid test_shells")
    path.write_text("\n".join(lines) + "\n", encoding="ascii")
    return path


def _signed_tet_data(mesh: object) -> tuple[np.ndarray, np.ndarray, list[np.ndarray]]:
    volumes: list[float] = []
    centroids: list[np.ndarray] = []
    cell_nodes: list[np.ndarray] = []
    for index, cell_type in enumerate(mesh.cell_types):
        if str(cell_type) != "tet4":
            raise AssertionError(f"expected only Tet4 cells, got {cell_type!r}")
        nodes = np.asarray(mesh.cell_node_ids(index), dtype=np.int64)
        points = np.asarray(mesh.nodes[nodes], dtype=np.float64)
        volumes.append(float(np.linalg.det(points[1:] - points[:1]) / 6.0))
        centroids.append(points.mean(axis=0))
        cell_nodes.append(nodes)
    return (
        np.asarray(volumes, dtype=np.float64),
        np.asarray(centroids, dtype=np.float64),
        cell_nodes,
    )


def _volume_for_marker(volumes: np.ndarray, markers: np.ndarray, marker: int) -> float:
    return float(volumes[markers == marker].sum())


def _on_cube_boundary(
    point: np.ndarray,
    lower: tuple[float, float, float],
    upper: tuple[float, float, float],
    *,
    tolerance: float,
) -> bool:
    for axis in range(3):
        other_axes = [candidate for candidate in range(3) if candidate != axis]
        if not all(
            lower[candidate] - tolerance
            <= point[candidate]
            <= upper[candidate] + tolerance
            for candidate in other_axes
        ):
            continue
        if (
            abs(float(point[axis]) - lower[axis]) <= tolerance
            or abs(float(point[axis]) - upper[axis]) <= tolerance
        ):
            return True
    return False


def _mesh_face_owners(cell_nodes: list[np.ndarray]) -> dict[tuple[int, int, int], list[int]]:
    face_owners: dict[tuple[int, int, int], list[int]] = defaultdict(list)
    for cell_index, nodes in enumerate(cell_nodes):
        for local_face in combinations(range(4), 3):
            face = tuple(sorted(int(nodes[index]) for index in local_face))
            face_owners[face].append(cell_index)
    return face_owners


@unittest.skipUnless(
    _HAS_GMSH and _HAS_TRIMESH,
    "real STL domain regressions require Gmsh and trimesh",
)
class ImportedStlShellDomainTests(unittest.TestCase):
    def _realize_domain(
        self,
        geometries: list[fm.ImportedGeometry],
        *,
        size_um: tuple[float, float, float],
        center_um: tuple[float, float, float],
    ):
        return realize_fem_domain_mesh_asset_from_components_with_report(
            geometries,
            fm.FEM(order=1, hmax=_MESH_HMAX_M),
            study_universe={
                "mode": "manual",
                "size": [value * _SOURCE_TO_METERS for value in size_um],
                "center": [value * _SOURCE_TO_METERS for value in center_um],
                "airbox_hmax": 1.6e-6,
            },
        )

    def _assert_hollow_domain(
        self,
        mesh: object,
        region_markers: list[dict[str, object]],
    ) -> None:
        markers_by_name = {
            str(entry["geometry_name"]): int(entry["marker"])
            for entry in region_markers
        }
        self.assertEqual(markers_by_name, {"hollow": 1})
        magnetic_marker = markers_by_name["hollow"]
        markers = np.asarray(mesh.element_markers, dtype=np.int64)
        self.assertEqual(set(np.unique(markers).tolist()), {0, magnetic_marker})

        volumes, centroids, cell_nodes = _signed_tet_data(mesh)
        self.assertGreater(len(volumes), 0)
        self.assertTrue(np.all(volumes > 0.0), "all imported-domain Tet4 cells must be positive")
        total_volume = float(volumes.sum())
        magnetic_volume = _volume_for_marker(volumes, markers, magnetic_marker)
        air_volume = _volume_for_marker(volumes, markers, 0)
        self.assertTrue(
            math.isclose(magnetic_volume, 7.0e-18, rel_tol=_VOLUME_REL_TOL, abs_tol=1e-24),
            f"magnetic shell volume was {magnetic_volume:.17g} m^3",
        )
        self.assertTrue(
            math.isclose(air_volume, 57.0e-18, rel_tol=_VOLUME_REL_TOL, abs_tol=1e-24),
            f"combined cavity and exterior air volume was {air_volume:.17g} m^3",
        )
        self.assertTrue(
            math.isclose(total_volume, 64.0e-18, rel_tol=_VOLUME_REL_TOL, abs_tol=1e-24),
            f"meshed domain partition volume was {total_volume:.17g} m^3",
        )

        cavity_min = np.full(3, 0.5e-6, dtype=np.float64)
        cavity_max = np.full(3, 1.5e-6, dtype=np.float64)
        in_cavity = np.all(centroids > cavity_min, axis=1) & np.all(
            centroids < cavity_max, axis=1
        )
        self.assertTrue(np.any(in_cavity), "the cavity must contain tetrahedron centroids")
        self.assertFalse(
            np.any(in_cavity & (markers == magnetic_marker)),
            "cavity tetrahedra must not receive the magnetic geometry marker",
        )
        cavity_volume = float(volumes[in_cavity & (markers == 0)].sum())
        self.assertTrue(
            math.isclose(cavity_volume, 1.0e-18, rel_tol=_VOLUME_REL_TOL, abs_tol=1e-24),
            f"cavity air volume was {cavity_volume:.17g} m^3",
        )

        face_owners = _mesh_face_owners(cell_nodes)
        self.assertTrue(all(len(owners) <= 2 for owners in face_owners.values()))
        outer_interface_faces = 0
        cavity_interface_faces = 0
        unmatched_faces = 0
        universe_min = np.full(3, -1.0e-6, dtype=np.float64)
        universe_max = np.full(3, 3.0e-6, dtype=np.float64)
        outer_min = np.zeros(3, dtype=np.float64)
        outer_max = np.full(3, 2.0e-6, dtype=np.float64)
        tolerance = 1.0e-12
        for face, owners in face_owners.items():
            face_center = np.asarray(mesh.nodes[np.asarray(face)].mean(axis=0), dtype=np.float64)
            if len(owners) == 1:
                unmatched_faces += 1
                self.assertTrue(
                    _on_cube_boundary(face_center, tuple(universe_min), tuple(universe_max), tolerance=tolerance),
                    "only the declared universe boundary may be an unmatched tetrahedron face",
                )
                continue
            if set(markers[owners].tolist()) != {0, magnetic_marker}:
                continue
            self.assertTrue(
                _on_cube_boundary(face_center, tuple(outer_min), tuple(outer_max), tolerance=tolerance)
                or _on_cube_boundary(face_center, tuple(cavity_min), tuple(cavity_max), tolerance=tolerance),
                "every magnetic/air shared face must lie on an imported STL shell",
            )
            if _on_cube_boundary(
                face_center, tuple(outer_min), tuple(outer_max), tolerance=tolerance
            ):
                outer_interface_faces += 1
            if _on_cube_boundary(
                face_center, tuple(cavity_min), tuple(cavity_max), tolerance=tolerance
            ):
                cavity_interface_faces += 1
        self.assertGreater(unmatched_faces, 0, "the universe must retain its exterior boundary")
        self.assertGreater(outer_interface_faces, 0, "outer magnetic-air interface is missing")
        self.assertGreater(cavity_interface_faces, 0, "cavity magnetic-air interface is missing")

    def test_nested_oppositely_wound_shells_create_magnetic_and_air_domains(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stl-hollow-domain-") as tmp_dir:
            source = _write_ascii_stl(Path(tmp_dir) / "hollow.stl", _hollow_triangles())
            geometry = fm.ImportedGeometry(
                source=str(source), scale=_SOURCE_TO_METERS, name="hollow"
            )
            mesh, region_markers, _report = self._realize_domain(
                [geometry], size_um=(4.0, 4.0, 4.0), center_um=(1.0, 1.0, 1.0)
            )

        self._assert_hollow_domain(mesh, region_markers)

    def test_reversing_the_entire_stl_preserves_shell_and_cavity_semantics(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stl-reversed-hollow-") as tmp_dir:
            source = _write_ascii_stl(
                Path(tmp_dir) / "reversed_hollow.stl",
                _hollow_triangles(reverse_whole_file=True),
            )
            geometry = fm.ImportedGeometry(
                source=str(source), scale=_SOURCE_TO_METERS, name="hollow"
            )
            mesh, region_markers, _report = self._realize_domain(
                [geometry], size_um=(4.0, 4.0, 4.0), center_um=(1.0, 1.0, 1.0)
            )

        self._assert_hollow_domain(mesh, region_markers)

    def test_separate_imported_cube_keeps_its_own_geometry_marker(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stl-component-identity-") as tmp_dir:
            root = Path(tmp_dir)
            hollow_source = _write_ascii_stl(root / "hollow.stl", _hollow_triangles())
            witness_source = _write_ascii_stl(
                root / "witness.stl",
                _cube_triangles((4.0, 0.0, 0.0), (5.0, 1.0, 1.0)),
            )
            geometries = [
                fm.ImportedGeometry(
                    source=str(hollow_source), scale=_SOURCE_TO_METERS, name="hollow"
                ),
                fm.ImportedGeometry(
                    source=str(witness_source), scale=_SOURCE_TO_METERS, name="witness"
                ),
            ]
            mesh, region_markers, _report = self._realize_domain(
                geometries, size_um=(7.0, 4.0, 4.0), center_um=(2.5, 1.0, 1.0)
            )

        markers_by_name = {
            str(entry["geometry_name"]): int(entry["marker"])
            for entry in region_markers
        }
        self.assertEqual(set(markers_by_name), {"hollow", "witness"})
        self.assertNotEqual(markers_by_name["hollow"], markers_by_name["witness"])
        self.assertTrue(all(marker > 0 for marker in markers_by_name.values()))
        markers = np.asarray(mesh.element_markers, dtype=np.int64)
        self.assertEqual(
            set(np.unique(markers).tolist()),
            {0, markers_by_name["hollow"], markers_by_name["witness"]},
        )
        volumes, centroids, _cell_nodes = _signed_tet_data(mesh)
        self.assertTrue(np.all(volumes > 0.0))
        self.assertTrue(
            math.isclose(
                _volume_for_marker(volumes, markers, markers_by_name["hollow"]),
                7.0e-18,
                rel_tol=_VOLUME_REL_TOL,
                abs_tol=1e-24,
            )
        )
        self.assertTrue(
            math.isclose(
                _volume_for_marker(volumes, markers, markers_by_name["witness"]),
                1.0e-18,
                rel_tol=_VOLUME_REL_TOL,
                abs_tol=1e-24,
            )
        )
        self.assertTrue(
            math.isclose(
                _volume_for_marker(volumes, markers, 0),
                104.0e-18,
                rel_tol=_VOLUME_REL_TOL,
                abs_tol=1e-24,
            )
        )
        self.assertTrue(
            math.isclose(float(volumes.sum()), 112.0e-18, rel_tol=_VOLUME_REL_TOL, abs_tol=1e-24)
        )
        in_cavity = np.all(centroids > 0.5e-6, axis=1) & np.all(centroids < 1.5e-6, axis=1)
        self.assertTrue(np.any(in_cavity))
        self.assertFalse(np.any(in_cavity & (markers == markers_by_name["hollow"])))

    def test_open_stl_shell_fails_instead_of_becoming_a_solver_volume(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-stl-open-shell-") as tmp_dir:
            source = _write_ascii_stl(
                Path(tmp_dir) / "open.stl",
                _cube_triangles(
                    (0.0, 0.0, 0.0),
                    (2.0, 2.0, 2.0),
                    omit_face=0,
                ),
            )
            geometry = fm.ImportedGeometry(
                source=str(source), scale=_SOURCE_TO_METERS, name="open_shell"
            )
            with self.assertRaisesRegex(
                (ValueError, RuntimeError),
                "(?i)(open|closed|watertight|manifold|shell|topology)",
            ):
                self._realize_domain(
                    [geometry], size_um=(4.0, 4.0, 4.0), center_um=(1.0, 1.0, 1.0)
                )



class ImportedStlShellConstructionTests(unittest.TestCase):
    """Pure source-contract checks; these do not qualify a Gmsh runtime."""

    def test_material_and_cavity_loops_keep_source_component_identity(self):
        from types import SimpleNamespace
        from fullmag.meshing._gmsh_generators import _build_stl_volume_models_for_components
        from fullmag.meshing._gmsh_types import ComponentDescriptor

        blocks = [
            np.asarray(_cube_triangles((0,0,0),(2,2,2))),
            np.asarray(_cube_triangles((.5,.5,.5),(1.5,1.5,1.5), reverse_winding=True)),
            np.asarray(_cube_triangles((.75,.75,.75),(1.25,1.25,1.25))),
        ]
        active = []
        loops, volumes = [], []

        def get_elements(dim, tag=-1):
            self.assertEqual(dim, 2)
            selected = active if tag == -1 else [tag-1]
            tags = [np.arange(index*12+1,index*12+13) for index in selected]
            nodes = [np.arange(index*36+1,index*36+37) for index in selected]
            return [2]*len(selected), tags, nodes

        def get_nodes():
            coordinates = np.concatenate(blocks).reshape(-1,3)
            return np.arange(1,len(coordinates)+1), coordinates.reshape(-1), []

        def merge(path):
            active.extend([0,1] if path == 'hollow.stl' else [2])

        def add_loop(tags):
            loops.append(list(tags))
            return len(loops)

        def add_volume(tags):
            volumes.append(list(tags))
            return len(volumes)

        gmsh = SimpleNamespace(
            merge=merge,
            model=SimpleNamespace(
                mesh=SimpleNamespace(getElements=get_elements,getNodes=get_nodes,
                                     classifySurfaces=lambda *args,**kwargs:None,
                                     createGeometry=lambda:None),
                geo=SimpleNamespace(addSurfaceLoop=add_loop,addVolume=add_volume,
                                    synchronize=lambda:None),
                getEntities=lambda dim:[(2,index+1) for index in active],
                getBoundary=lambda *args,**kwargs:[],
            ),
        )
        # Deliberately identical (wrong) descriptor bounds: source element
        # identities, rather than spatial overlap, must choose every owner.
        components = [ComponentDescriptor(name,Path(name+'.stl'),(0,0,0),(2,2,2))
                      for name in ('hollow','island')]
        volume_tags,surface_tags,topology = _build_stl_volume_models_for_components(
            gmsh,components,return_topology=True)
        self.assertEqual(topology.depths,(0,1,2))
        self.assertEqual(volume_tags,{'hollow':[1],'island':[2]})
        self.assertEqual(surface_tags,{'hollow':[1,2],'island':[3]})
        self.assertEqual(loops,[[1],[-2],[3]])
        self.assertEqual(volumes,[[1,2],[3]])

    def test_airbox_aggregates_exterior_and_cavity_air_with_shared_walls(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from fullmag.meshing._gmsh_airbox import _add_airbox_geo
        from fullmag.meshing._gmsh_types import AirboxOptions
        from fullmag.meshing._stl_shells import ShellInput, classify_closed_shells

        topology = classify_closed_shells([
            ShellInput('hollow',(31,),np.asarray(_cube_triangles((0,0,0),(2,2,2)))),
            ShellInput('hollow',(32,),np.asarray(_cube_triangles((.5,.5,.5),(1.5,1.5,1.5),reverse_winding=True))),
        ])
        loops,volumes,physical = [],[],{}
        counter = iter(range(100,1000))
        def add_loop(tags):
            loops.append(list(tags))
            return len(loops)
        def add_volume(tags):
            volumes.append(list(tags))
            return len(volumes)+10
        geo = SimpleNamespace(
            addPoint=lambda *args:next(counter),addLine=lambda *args:next(counter),
            addCurveLoop=lambda *args:next(counter),addPlaneSurface=lambda *args:next(counter),
            addSurfaceLoop=add_loop,addVolume=add_volume,synchronize=lambda:None)
        gmsh = SimpleNamespace(model=SimpleNamespace(
            geo=geo,getBoundingBox=lambda *args:(0,0,0,2,2,2),
            addPhysicalGroup=lambda dim,tags,tag:physical.update({(dim,tag):list(tags)}),
            setPhysicalName=lambda *args:None))
        with patch('fullmag.meshing._gmsh_airbox._add_airbox_geo_grading_field',return_value=None), patch(
            'fullmag.meshing._gmsh_airbox.add_airbox_feature_fields',return_value=[]) as features:
            _add_airbox_geo(gmsh,[9],[31,32],AirboxOptions(size=(4,4,4),center=(1,1,1)),.2,
                component_volume_groups={'hollow':[9]},component_surface_groups={'hollow':[31,32]},
                shell_topology=topology)
        self.assertEqual(loops[1:],[[31],[-32]])
        self.assertEqual(volumes,[[1,2],[3]])
        self.assertEqual(physical[(3,1)],[9])
        self.assertEqual(physical[(3,2)],[11,12])
        self.assertEqual(physical[(2,10)],[31,32])
        self.assertEqual(features.call_args.kwargs['air_volume_tags'],[11,12])

    def test_prevalidation_gmsh_failure_cannot_enter_geometry_fallback(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from fullmag.meshing._gmsh_stl_shells import (
            StlTopologyError, classify_owned_stl_shells, merge_owned_stl)
        for operation in ('merge','classify'):
            with self.subTest(operation=operation):
                cause = RuntimeError('unrecoverable source topology')
                gmsh = SimpleNamespace(
                    merge=Mock(side_effect=cause),
                    model=SimpleNamespace(mesh=SimpleNamespace(
                        getElements=lambda dim:([],[],[]),
                        classifySurfaces=Mock(side_effect=cause))))
                with self.assertRaises(StlTopologyError) as raised:
                    if operation == 'merge':
                        merge_owned_stl(gmsh,'broken.stl','body',{})
                    else:
                        classify_owned_stl_shells(gmsh,{1:'body'})
                self.assertIs(raised.exception.__cause__,cause)

    def test_shared_import_without_airbox_retains_component_markers(self):
        from contextlib import nullcontext
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        from fullmag.meshing import _gmsh_generators as generators
        from fullmag.meshing._gmsh_types import ComponentDescriptor, MeshOptions
        from fullmag.meshing._stl_shells import ShellTopology

        groups = {'first':[21],'second':[22]}
        surfaces = {'first':[31],'second':[32]}
        model = SimpleNamespace(
            add=Mock(),addPhysicalGroup=Mock(),setPhysicalName=Mock(),
            mesh=SimpleNamespace(generate=Mock()))
        gmsh = SimpleNamespace(initialize=Mock(),finalize=Mock(),
                               option=SimpleNamespace(setNumber=Mock()),model=model)
        mesh = SimpleNamespace(n_nodes=8,n_elements=2,n_boundary_faces=8)
        report = SimpleNamespace(
            selector_resolution=None,boundary_layer_result=None,
            algorithm_3d_requested=1,algorithm_3d_effective=1,
            algorithm_3d_fallback_reason=None)
        components = [ComponentDescriptor(name,Path(name+'.stl'),(0,0,0),(1,1,1))
                      for name in groups]
        with patch.object(generators,'_import_gmsh',return_value=gmsh), patch.object(
            generators,'_build_stl_volume_models_for_components',
            return_value=(groups,surfaces,ShellTopology((),(),(),()))), patch.object(
            generators,'_configure_gmsh_threads'), patch.object(
            generators,'_apply_mesh_options',return_value=report), patch.object(
            generators,'collect_orphan_entity_diagnostics',return_value=[]), patch.object(
            generators,'_GmshProgressLogger',return_value=nullcontext()), patch.object(
            generators,'_apply_post_mesh_options'), patch.object(
            generators,'_extract_mesh_data',return_value=mesh) as extract:
            result = generators.generate_shared_domain_mesh_from_components(
                components,hmax=.2,options=MeshOptions(compute_quality=False))
        self.assertEqual(result.component_marker_tags,{'first':1,'second':2})
        model.addPhysicalGroup.assert_any_call(3,[21],tag=1)
        model.addPhysicalGroup.assert_any_call(3,[22],tag=2)
        self.assertEqual(model.addPhysicalGroup.call_count,2)
        self.assertTrue(extract.call_args.kwargs['has_physical_groups'])
        gmsh.finalize.assert_called_once()

    def test_anonymous_fallback_rejects_imported_component_identity_loss(self):
        from fullmag.meshing.asset_pipeline import _reject_anonymous_import_fallback
        from fullmag.meshing._gmsh_stl_shells import StlTopologyError
        imported = fm.ImportedGeometry(source='imported.stl',name='imported')
        analytic = fm.Box(size=(1e-6,1e-6,1e-6),name='box')
        error = RuntimeError('original Gmsh failure')
        with self.assertRaisesRegex(StlTopologyError,'source-component ownership') as raised:
            _reject_anonymous_import_fallback([imported,analytic],error)
        self.assertIs(raised.exception.__cause__,error)
        _reject_anonymous_import_fallback([imported],error)
        _reject_anonymous_import_fallback([analytic,analytic],error)


if __name__ == "__main__":
    unittest.main()
