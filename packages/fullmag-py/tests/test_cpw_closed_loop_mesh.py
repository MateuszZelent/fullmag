"""Actual OCC/Tet4 geometry checks; no current or field solve."""
import unittest
from types import SimpleNamespace

import gmsh
import numpy as np
import fullmag as fm
from fullmag.meshing._gmsh_waveguides import (
    add_antenna_layout_parts_to_occ, add_antenna_layout_terminal_physical_groups,
)
from fullmag.meshing._antenna_coincident_cut import split_coincident_sourcecut, coincident_terminal_observations, _faces
from fullmag.meshing._gmsh_types import MeshData
from test_cpw_closed_loop_layout import layout_options


class ClosedGsgMeshTests(unittest.TestCase):
    def setUp(self):
        gmsh.initialize()
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("closed_gsg")

    def tearDown(self):
        gmsh.finalize()

    def test_five_parts_six_contacts_and_central_source_cut(self):
        layout = fm.CPWAntennaLayout(**{**layout_options(), "length_m": 2e-6,
            "inlet_connection_length_m": 500e-9, "inlet_crossbar_length_m": 100e-9,
            "outlet_connection_length_m": 700e-9, "outlet_crossbar_length_m": 200e-9})
        parts = add_antenna_layout_parts_to_occ(gmsh, layout, scale=1e6,
                                               source_cut_offset_m=-200e-9)
        gmsh.model.occ.synchronize()
        self.assertEqual(set(parts), {"signal", "ground_left", "ground_right", "feed", "closure"})
        expected_volumes = {"signal": .2 * 2 * .09, "ground_left": .2 * 2 * .09,
            "ground_right": .2 * 2 * .09, "feed": (.6 * .4 + 1.1 * .1) * .09,
            "closure": (.6 * .5 + 1.1 * .2) * .09}
        for part, expected in expected_volumes.items():
            self.assertAlmostEqual(sum(gmsh.model.occ.getMass(dim, tag) for dim, tag in parts[part]),
                                   expected, delta=1e-10)
        markers = add_antenna_layout_terminal_physical_groups(gmsh, layout, parts, scale=1e6,
                                                              object_id="immutable_antenna")
        self.assertEqual(len(markers), 6)
        for marker in markers.values():
            tags = gmsh.model.getEntitiesForPhysicalGroup(2, marker)
            self.assertAlmostEqual(sum(gmsh.model.occ.getMass(2, int(tag)) for tag in tags),
                                   .2 * .09, delta=1e-10)
        cut = []
        for _, tag in gmsh.model.getEntities(2):
            points = [gmsh.model.getValue(0, abs(t), []) for dim, t in
                      gmsh.model.getBoundary([(2, tag)], recursive=True) if dim == 0]
            if points and all(abs(point[0] + .2) < 1e-10 for point in points):
                cut.append(tag)
        self.assertEqual(len(cut), 1)
        self.assertAlmostEqual(gmsh.model.occ.getMass(2, cut[0]), .2 * .09, delta=1e-10)
        gmsh.option.setNumber("Mesh.MeshSizeMin", .09)
        gmsh.option.setNumber("Mesh.MeshSizeMax", .15)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.model.mesh.generate(3)
        nodes, coordinates, _ = gmsh.model.mesh.getNodes()
        xyz = {int(n): p for n, p in zip(nodes, np.asarray(coordinates).reshape(-1, 3))}
        cells, connectivity = gmsh.model.mesh.getElementsByType(4)
        self.assertGreater(len(cells), 0)
        tetra = np.asarray([[xyz[int(n)] for n in cell]
                            for cell in np.asarray(connectivity).reshape(-1, 4)])
        determinant = np.linalg.det(tetra[:, 1:] - tetra[:, :1])
        self.assertTrue(np.all(determinant > 0), float(determinant.min()))
        for marker in range(1, 6):
            self.assertGreater(len(gmsh.model.getEntitiesForPhysicalGroup(3, marker)), 0)

        # The source cut must open only the center feed, preserving both return paths.
        node_index = {int(node): index for index, node in enumerate(nodes)}
        elements = np.asarray([[node_index[int(node)] for node in cell]
                               for cell in np.asarray(connectivity).reshape(-1, 4)])
        points = np.asarray(coordinates).reshape(-1, 3) / 1e6
        topology = _faces(elements)
        exterior = [owners[0][1] for owners in topology.values() if len(owners) == 1]
        _, triangles = gmsh.model.mesh.getElementsByType(2, cut[0])
        seam = np.asarray([[node_index[int(node)] for node in face]
                           for face in np.asarray(triangles).reshape(-1, 3)])
        cell_index = {int(cell): i for i, cell in enumerate(cells)}
        cell_markers = np.zeros(len(cells), dtype=np.int32)
        for marker in range(1, 6):
            for volume in gmsh.model.getEntitiesForPhysicalGroup(3, marker):
                part_cells, _ = gmsh.model.mesh.getElementsByType(4, int(volume))
                for cell in part_cells:
                    cell_markers[cell_index[int(cell)]] = marker
        boundaries = list(exterior)
        boundary_markers = [1] * len(exterior)
        for marker in markers.values():
            for surface in gmsh.model.getEntitiesForPhysicalGroup(2, marker):
                _, contact = gmsh.model.mesh.getElementsByType(2, int(surface))
                contacts = [[node_index[int(node)] for node in face]
                            for face in np.asarray(contact).reshape(-1, 3)]
                boundaries.extend(contacts)
                boundary_markers.extend([marker] * len(contacts))
        mesh = MeshData.from_legacy_tet4(nodes=points, elements=elements,
            element_markers=cell_markers, boundary_faces=np.asarray(boundaries),
            boundary_markers=np.asarray(boundary_markers, dtype=np.int32))
        from fullmag.runtime.antenna_coincident_materialization import _material_binding
        parts_in_order = (*layout.conductor_part_ids, layout.inlet_connection_part_id,
                          layout.outlet_connection_part_id)
        conductivities = (layout.conductivity_s_per_m,) * 3 + (
            layout.inlet_connection_conductivity_s_per_m,
            layout.outlet_connection_conductivity_s_per_m)
        assignments = [fm.ChargeTransportMaterialAssignment(
            fm.RegionRef("immutable_antenna", part), fm.ChargeTransportMaterial(sigma))
            for part, sigma in zip(parts_in_order, conductivities)]
        transport = SimpleNamespace(materials=assignments)
        records, digest = _material_binding(transport, layout, mesh, "immutable_antenna")
        self.assertEqual(len(records), 5)
        self.assertEqual(sorted(cell for record in records for cell in record["element_ordinals"]),
                         list(range(mesh.n_elements)))
        for record in records:
            marker = parts_in_order.index(record["part_id"]) + 1
            self.assertTrue(np.all(mesh.element_markers[record["element_ordinals"]] == marker))
        self.assertRegex(digest, r"^sha256:[0-9a-f]{64}$")
        for invalid in (assignments[:-1], assignments + [assignments[0]],
                        [fm.ChargeTransportMaterialAssignment(fm.RegionRef("other", parts_in_order[0]),
                         assignments[0].material)] + assignments[1:]):
            with self.assertRaises(ValueError):
                _material_binding(SimpleNamespace(materials=invalid), layout, mesh, "immutable_antenna")
        split, identities, source = split_coincident_sourcecut(mesh, seam_faces=seam,
            stable_vertex_ids=tuple(int(node) for node in nodes), normal_world=(1., 0., 0.),
            source_cut_id="central_feed_cut", potential_jump_v=.25)
        self.assertEqual(len(source.face_pairs), len(seam))
        self.assertEqual(split.n_elements, mesh.n_elements)
        self.assertEqual(len(identities), len(set(identities)))
        self.assertEqual(split.n_nodes - mesh.n_nodes, len(np.unique(seam)))
        self.assertEqual(sum(len(owners) == 1 for owners in _faces(split.elements).values()),
                         len(exterior) + 2 * len(seam))
        faces = points[seam]
        area = np.linalg.norm(np.cross(faces[:, 1] - faces[:, 0],
                                      faces[:, 2] - faces[:, 0]), axis=1).sum() / 2
        self.assertAlmostEqual(area, .2e-6 * .09e-6, delta=1e-25)
        port = SimpleNamespace(branches=[SimpleNamespace(id=part, signed_weight=weight,
            inlet_terminal_ref=part + "_in", outlet_terminal_ref=part + "_out")
            for part, weight in zip(layout.conductor_part_ids, (1., -.5, -.5))])
        prepared = SimpleNamespace(mesh=split, stable_vertex_ids=identities)
        mesh = SimpleNamespace(vertex_identity={"vertex_ids": tuple(int(node) for node in nodes)},
            boundary_faces=mesh.boundary_faces, boundary_markers=mesh.boundary_markers)
        observations = coincident_terminal_observations(mesh, prepared, geometry=layout,
            object_id="immutable_antenna", port=port)
        self.assertEqual(len(observations), 6)
        self.assertEqual({item["part_id"] for item in observations}, set(layout.conductor_part_ids))
        for item in observations:
            self.assertTrue(item["faces"])
        port.branches[2].inlet_terminal_ref = port.branches[0].inlet_terminal_ref
        with self.assertRaisesRegex(ValueError, "unique"):
            coincident_terminal_observations(mesh, prepared, geometry=layout,
                object_id="immutable_antenna", port=port)


    def test_source_on_crossbar_is_rejected(self):
        layout = fm.CPWAntennaLayout(**layout_options())
        with self.assertRaisesRegex(ValueError, "central inlet neck"):
            add_antenna_layout_parts_to_occ(gmsh, layout, scale=1e6, source_cut_offset_m=-1.8e-6)


class ClosedGsgPreparationTests(unittest.TestCase):
    def geometry(self, **overrides):
        return fm.CPWAntennaLayout(**{**layout_options(), "length_m": 2e-6,
            "inlet_connection_length_m": 500e-9, "inlet_crossbar_length_m": 100e-9,
            "outlet_connection_length_m": 700e-9, "outlet_crossbar_length_m": 200e-9, **overrides})

    def closure(self, axis="x", offset=-200e-9, normal="positive_axis"):
        return fm.StructuredCurrentClosure("gsg_loop", [fm.StructuredCurrentSourceCut(
            "central_cut", "circuit", fm.RegionRef("immutable_antenna", "feed"),
            fm.StructuredCutPlane(axis, offset, coordinate_frame="object", normal=normal),
            fm.ImpressedPotentialJump("drive", .25))],
            schema_version="structured_current_closure.v2")

    def test_public_prepare_real_gsg_source_and_reversed_normal(self):
        from fullmag.meshing._antenna_coincident_cut import (
            realize_antenna_coincident_loop_mesh, prepare_antenna_coincident_loop)
        geometry = self.geometry()
        closure = self.closure()
        raw = realize_antenna_coincident_loop_mesh(closure, geometry=geometry,
            object_id="immutable_antenna", hmax_m=150e-9)
        forward = prepare_antenna_coincident_loop(closure, geometry=geometry,
            object_id="immutable_antenna", hmax_m=150e-9, raw_mesh=raw)
        reverse = prepare_antenna_coincident_loop(self.closure(normal="negative_axis"),
            geometry=geometry, object_id="immutable_antenna", hmax_m=150e-9, raw_mesh=raw)
        self.assertEqual(set(forward.mesh.element_markers), {1, 2, 3, 4, 5})
        self.assertEqual(forward.mesh.n_elements, raw.n_elements)
        self.assertGreater(forward.receipt["source_face_pair_count"], 0)
        self.assertEqual(forward.receipt["source_face_pair_count"], reverse.receipt["source_face_pair_count"])
        self.assertFalse(forward.receipt["basis_qualified"])
        self.assertFalse(forward.receipt["current_certificate"])
        self.assertNotEqual(forward.receipt["input_digest"], reverse.receipt["input_digest"])
        for marker, sigma in [(1, geometry.conductivity_s_per_m),
                (4, geometry.inlet_connection_conductivity_s_per_m),
                (5, geometry.outlet_connection_conductivity_s_per_m)]:
            values = np.asarray(forward.conductivity_s_per_m_per_element)
            self.assertTrue(np.all(values[forward.mesh.element_markers == marker] == sigma))

    def test_public_execution_lowering_preserves_authored_gsg(self):
        import os
        import tempfile
        from unittest.mock import patch
        from fullmag.model.problem import BackendTarget, DeviceTarget
        geometry = self.geometry()
        parts = (*geometry.conductor_part_ids, geometry.inlet_connection_part_id,
                 geometry.outlet_connection_part_id)
        sigma = (geometry.conductivity_s_per_m,) * 3 + (
            geometry.inlet_connection_conductivity_s_per_m,
            geometry.outlet_connection_conductivity_s_per_m)
        transport = fm.CurrentTransport(name="charge", model="ohmic_poisson",
            domain=[fm.RegionRef("immutable_antenna")], boundaries=[],
            materials=[fm.ChargeTransportMaterialAssignment(fm.RegionRef("immutable_antenna", part),
                fm.ChargeTransportMaterial(value)) for part, value in zip(parts, sigma)],
            gauge=fm.ChargePotentialGauge("zero_mean"),
            solver=fm.ChargeSolverPolicy(relative_tolerance=1e-12,
                operator_version="fem_charge_conforming_h1_p1.transparent.v1"),
            structured_current_closure=self.closure())
        port = fm.AntennaPortMode(id="port", source_object_id="immutable_antenna",
            current_transport_id="charge", schema_version="antenna_port_mode.v3",
            normalization=fm.AntennaSourceCutRt0("central_cut"),
            branches=[fm.AntennaPortBranch(part, part+"_in", part+"_out", 0.)
                      for part in geometry.conductor_part_ids])
        problem = fm.Problem(name="gsg_public", magnets=[], energy=[], study=fm.FieldOnly(),
            auxiliary_geometries=[geometry], auxiliary_geometry_roles={geometry.geometry_name:"antenna"},
            auxiliary_geometry_object_ids={geometry.geometry_name:"immutable_antenna"},
            current_modules=[transport], antenna_port_modes=[port],
            antenna_field_solve_stages=[fm.AntennaFieldSolveStage(id="inspect_gsg",
                source_object_id="immutable_antenna", current_transport_id="charge", port_mode_ids=["port"],
                field_sampling_domain=fm.FieldTarget.object("immutable_antenna"),
                target_refs=[fm.FieldTarget.object("immutable_antenna")],
                outputs=[fm.AntennaNamedOutput("inspection", "H_ant_basis")])],
            discretization=fm.DiscretizationHints(fem=fm.FEM(maximum_element_size=150e-9, order=1)),
            runtime=fm.RuntimeSelection(backend_target=BackendTarget.FEM, device_target=DeviceTarget.CPU),
            runtime_metadata={"script_api_surface":"study", "visualization_hint": {"geometry_hints": {
                geometry.geometry_name: {"role":"antenna", "display":"shaded_frame"}}}})
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,
                {"FULLMAG_FEM_MESH_CACHE_DIR": directory}):
            authored = problem.to_ir(include_geometry_assets=False)
            execution = problem.to_ir(include_geometry_assets=True)
            source = execution["current_modules"][0]["conservative_current_source"]
            self.assertEqual(len(source["material_parts"]), 5)
            self.assertEqual(len(source["terminal_observations"]), 6)
            self.assertEqual(source["revision"], source["authored_input_digest"])
            self.assertEqual(problem.to_ir(include_geometry_assets=False), authored)
            self.assertNotIn("structured_current_closure", execution["current_modules"][0])
            self.assertEqual(execution["physics_graph"]["modules"][0]["family_payload"],
                             execution["current_modules"][0])
            receipt = execution["problem_meta"]["runtime_metadata"]["antenna_coincident_preparations"][0]["preparation"]
            self.assertEqual(receipt["status"], "materialized_not_solved")
            self.assertFalse(receipt["basis_qualified"])
            with patch("fullmag.meshing._antenna_coincident_cut.realize_antenna_coincident_loop_mesh",
                       side_effect=AssertionError("cache missed")):
                repeated = problem.to_ir(include_geometry_assets=True)
            self.assertEqual(repeated["current_modules"], execution["current_modules"])
            from pathlib import Path
            from fullmag.runtime.loader import LoadedProblem, load_problem_from_script
            from fullmag.runtime.script_builder import (
                export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script)
            from fullmag.runtime.scene_document import build_scene_document_from_builder
            source_path = Path(directory) / "gsg.py"
            loaded = LoadedProblem(problem=problem, source_path=source_path, script_source="",
                                   entrypoint_kind="flat_workspace")
            draft = export_builder_draft(loaded)
            scene = build_scene_document_from_builder(draft)
            for script in (render_loaded_problem_as_script(loaded), render_scene_document_as_script(scene)):
                restored = load_problem_from_script(source_path, source_bytes=script.encode(), lightweight_assets=True)
                restored_draft = export_builder_draft(restored)
                for key in ("current_modules", "antenna_port_modes", "geometries", "antenna_field_solve_stages"):
                    self.assertEqual(restored_draft[key], draft[key], key)


    def test_rotated_source_contacts_and_stale_plane_rejection(self):
        from fullmag.meshing._antenna_coincident_cut import (
            realize_antenna_coincident_loop_mesh, prepare_antenna_coincident_loop)
        transform = fm.RigidTransform(rotation_matrix=((0., 0., 1.), (1., 0., 0.), (0., 1., 0.)),
                                      translation_m=(1e-6, -2e-6, 3e-6))
        geometry = self.geometry(transform=transform)
        closure = self.closure()
        raw = realize_antenna_coincident_loop_mesh(closure, geometry=geometry,
            object_id="immutable_antenna", hmax_m=150e-9)
        prepared = prepare_antenna_coincident_loop(closure, geometry=geometry,
            object_id="immutable_antenna", hmax_m=150e-9, raw_mesh=raw)
        port = fm.AntennaPortMode(id="port", source_object_id="immutable_antenna",
            current_transport_id="charge", schema_version="antenna_port_mode.v3",
            normalization=fm.AntennaSourceCutRt0("central_cut"),
            branches=[fm.AntennaPortBranch(part, part+"_in", part+"_out", 0.)
                      for part in geometry.conductor_part_ids])
        observations = coincident_terminal_observations(raw, prepared,
            geometry=geometry, object_id="immutable_antenna", port=port)
        self.assertEqual(len(observations), 6)
        source = prepared.closure.to_ir()["source_cuts"][0]
        xyz = dict(zip(prepared.stable_vertex_ids, prepared.mesh.nodes))
        for pair in source["face_pairs"]:
            minus = np.asarray([xyz[node] for node in pair["minus_face_vertex_ids"]])
            plus = np.asarray([xyz[node] for node in pair["plus_face_vertex_ids"]])
            self.assertEqual({point.tobytes() for point in minus}, {point.tobytes() for point in plus})
            self.assertTrue(np.all(np.abs(minus[:, 1] - (-2e-6 - 200e-9)) < 1e-18))
        with self.assertRaisesRegex(ValueError, "cached sourcecut"):
            prepare_antenna_coincident_loop(self.closure(offset=-100e-9), geometry=geometry,
                object_id="immutable_antenna", hmax_m=150e-9, raw_mesh=raw)

    def test_wrong_axis_crossbar_and_wrong_object_rejected(self):
        geometry = self.geometry()
        for closure in [self.closure(axis="z"), self.closure(offset=-400e-9),
                        self.closure(offset=0.)]:
            with self.assertRaises(ValueError):
                closure.prepare(geometry=geometry, object_id="immutable_antenna", hmax_m=150e-9)
        with self.assertRaises(ValueError):
            self.closure().prepare(geometry=geometry, object_id="other", hmax_m=150e-9)


if __name__ == "__main__":
    unittest.main()
