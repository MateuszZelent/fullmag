"""Interpreted full-volume seam regressions, without native solver claims."""
import copy
import importlib.util
import itertools
import unittest

import numpy as np
import fullmag as fm
from fullmag.meshing._antenna_coincident_cut import split_coincident_sourcecut, _faces
from fullmag.meshing._gmsh_types import MeshData
from fullmag.runtime.scene_document import _decode_structured_current_closure


def loop_geometry(**overrides):
    kwargs = dict(name="loop", length_m=2e-6, thickness_m=0.2e-6,
        conductivity_s_per_m=5.8e7, stations=[fm.MicrostripWidthStation(0, 0.3e-6),
        fm.MicrostripWidthStation(0.5, 0.1e-6), fm.MicrostripWidthStation(1, 0.3e-6)],
        return_width_m=1e-6, return_offset_m=0.4e-6, closed_loop=True)
    for side in ("inlet", "outlet"):
        kwargs.update({side+"_connection_length_m": 0.2e-6,
            side+"_connection_width_m": 0.4e-6, side+"_connection_offset_v_m": 0.0,
            side+"_connection_part_id": side, side+"_connection_conductivity_s_per_m": 3e7})
    kwargs.update(overrides)
    return fm.MicrostripAntennaLayout(**kwargs)


def closure():
    return fm.StructuredCurrentClosure("loop", [fm.StructuredCurrentSourceCut("cut", "circuit",
        fm.RegionRef("object", "inlet"), fm.StructuredCutPlane("z", -0.3e-6,
        coordinate_frame="object"), fm.ImpressedPotentialJump("drive", 0.25))],
        schema_version="structured_current_closure.v2")


def full_loop_mesh():
    # Connected square annulus extruded in y, six conforming tetrahedra per voxel.
    zs = [0., 1., 1.5, 2., 3.]
    points = {}
    nodes, cells = [], []
    def vertex(x, y, z):
        key = (float(x), float(y), float(z))
        if key not in points:
            points[key] = len(nodes)
            nodes.append(key)
        return points[key]
    for x in range(3):
        for k, (z0, z1) in enumerate(zip(zs, zs[1:])):
            if x == 1 and z0 >= 1 and z1 <= 2:
                continue
            corners = {(a,b,c):vertex(x+a,b,z0 if c==0 else z1)
                       for a,b,c in itertools.product((0,1),repeat=3)}
            for perm in itertools.permutations(range(3)):
                v = [0,0,0]
                local = [corners[tuple(v)]]
                for axis in perm:
                    v[axis] = 1
                    local.append(corners[tuple(v)])
                xyz = np.asarray(nodes)[local]
                if np.linalg.det(xyz[1:] - xyz[0]) < 0:
                    local[1],local[2] = local[2],local[1]
                cells.append(local)
    nodes = np.asarray(nodes);cells=np.asarray(cells)
    topology = _faces(cells)
    boundary = [owners[0][1] for owners in topology.values() if len(owners)==1]
    seam = [key for key,owners in topology.items() if len(owners)==2
            and np.all(nodes[list(key),2]==1.5) and np.all(nodes[list(key),0]<=1)]
    mesh=MeshData.from_legacy_tet4(nodes=nodes,elements=cells,
        element_markers=np.ones(len(cells),dtype=np.int32),boundary_faces=np.asarray(boundary),
        boundary_markers=np.ones(len(boundary),dtype=np.int32))
    return mesh,seam,tuple(range(1,len(nodes)+1))


class CoincidentCutTests(unittest.TestCase):
    def test_loop_geometry_roundtrip_preserves_full_plate_taper_transform_and_bridges(self):
        geometry=loop_geometry(transform=fm.RigidTransform(rotation_matrix=((0,-1,0),(1,0,0),(0,0,1)),
                                                          translation_m=(1e-6,-2e-6,3e-6)))
        payload=geometry.to_ir()
        restored=fm.MicrostripAntennaLayout.from_ir(payload)
        self.assertEqual(restored.to_ir(),payload)
        self.assertEqual(len(geometry.solid_segments()),4)
        self.assertEqual(geometry.return_width_m,1e-6)
        self.assertEqual([s.signal_width_m for s in geometry.stations],[0.3e-6,0.1e-6,0.3e-6])
        lower,upper=geometry.world_bounds()
        for sections in geometry.connection_sections().values():
            for section in sections:
                for point in section["vertices"]:
                    self.assertTrue(all(lower[i]<=point[i]<=upper[i] for i in range(3)))

    def test_invalid_missing_bridge_clearance_and_contact_rejected(self):
        for overrides in ({"inlet_connection_length_m":None},{"return_offset_m":0},
                          {"outlet_connection_offset_v_m":2e-6},{"outlet_connection_part_id":"signal"}):
            with self.subTest(overrides=overrides),self.assertRaises(ValueError):loop_geometry(**overrides)

    def test_authored_v2_roundtrip_and_v1_frame_gate(self):
        value=closure()
        self.assertEqual(_decode_structured_current_closure(value.to_ir()).to_ir(),value.to_ir())
        with self.assertRaises(ValueError):
            fm.StructuredCurrentClosure("legacy",value.source_cuts)
        with self.assertRaises(ValueError):
            fm.StructuredCurrentClosure("two",value.source_cuts*2,schema_version="structured_current_closure.v2")

    def test_exported_geometry_and_transport_execute_to_same_canonical_intent(self):
        from fullmag.runtime.script_builder import _render_antenna_layout_expr, _render_current_transport_payload
        from fullmag.runtime.scene_document import _decode_current_transport
        geometry=loop_geometry()
        expression=_render_antenna_layout_expr("microstrip",geometry.to_ir(),name="loop")
        restored=eval(expression,{"fm":fm})
        self.assertEqual(restored.to_ir(),geometry.to_ir())
        transport=fm.CurrentTransport(name="current",model="ohmic_poisson",domain=[fm.RegionRef("object")],
            materials=[fm.ChargeTransportMaterialAssignment(fm.RegionRef("object"),fm.ChargeTransportMaterial(5.8e7))],
            gauge=fm.ChargePotentialGauge("zero_mean"), solver=fm.ChargeSolverPolicy(
                operator_version="fem_charge_conforming_h1_p1.transparent.v1"), structured_current_closure=closure())
        self.assertEqual(_decode_current_transport(transport.to_ir()).to_ir(),transport.to_ir())
        expression=_render_current_transport_payload(transport.to_ir(),surface="study")
        class Surface:
            def current_transport(self,**kwargs):return fm.CurrentTransport(**kwargs)
        restored=eval(expression,{"fm":fm,"study":Surface()})
        self.assertEqual(restored.to_ir(),transport.to_ir())

    def test_unknown_plane_frame_and_loop_enable_type_rejected(self):
        with self.assertRaises(ValueError):fm.StructuredCutPlane("z",0,coordinate_frame="local_guess")
        geometry=loop_geometry().to_ir()
        geometry["loop"]["enabled"]="true"
        with self.assertRaises(TypeError):fm.MicrostripAntennaLayout.from_ir(geometry)
        geometry["loop"]["enabled"]=True
        geometry["loop"]["unknown_parameter"]=1
        with self.assertRaises(ValueError):fm.MicrostripAntennaLayout.from_ir(geometry)
        structured=closure().to_ir()
        structured["source_cuts"][0]["plane"].pop("coordinate_frame")
        with self.assertRaises(ValueError):_decode_structured_current_closure(structured)

    def test_zero_translation_is_explicit_v2_only(self):
        pair=fm.ConservativeCurrentSourceCutFacePair([1,2,3],[4,5,6])
        with self.assertRaises(ValueError):fm.ConservativeCurrentSourceCut("cut",(0,0,0),1,[pair])
        cut=fm.ConservativeCurrentSourceCut("cut",(0,0,0),1,[pair],closure_operator_version="fem_closed_current_geometry.v2")
        with self.assertRaises(ValueError):fm.ConservativeCurrentClosedGeometry("fem_closed_current_geometry.v1","r","d",[cut])
        self.assertEqual(fm.ConservativeCurrentClosedGeometry("fem_closed_current_geometry.v2","r","d",[cut]).to_ir()["source_cuts"][0]["translation_m"],[0,0,0])

    def test_actual_conforming_loop_split_preserves_every_cell_coordinate_byte(self):
        mesh,seam,ids=full_loop_mesh()
        old_nodes=mesh.nodes.copy();old_cells=mesh.elements.copy()
        prepared,new_ids,cut=split_coincident_sourcecut(mesh,seam_faces=seam,stable_vertex_ids=ids,
            normal_world=(0,0,1),source_cut_id="cut",potential_jump_v=0.25)
        self.assertEqual(prepared.n_elements,mesh.n_elements)
        self.assertEqual(prepared.nodes[prepared.elements].tobytes(),mesh.nodes[mesh.elements].tobytes())
        np.testing.assert_array_equal(mesh.nodes,old_nodes);np.testing.assert_array_equal(mesh.elements,old_cells)
        self.assertEqual(len(new_ids),prepared.n_nodes)
        coordinates=dict(zip(new_ids,prepared.nodes))
        for pair in cut.face_pairs:
            minus={coordinates[i].tobytes() for i in pair.minus_face_vertex_ids}
            plus={coordinates[i].tobytes() for i in pair.plus_face_vertex_ids}
            self.assertEqual(minus,plus)
            self.assertFalse(set(pair.minus_face_vertex_ids)&set(pair.plus_face_vertex_ids))
        self.assertEqual(len(cut.face_pairs),len(seam))
        self.assertEqual(int(np.sum(prepared.boundary_markers==2)),2*len(seam))

    def test_reversed_normal_preserves_geometry_and_reverses_source_trace_assignment(self):
        mesh,seam,ids=full_loop_mesh()
        first,_,_=split_coincident_sourcecut(mesh,seam_faces=seam,stable_vertex_ids=ids,
            normal_world=(0,0,1),source_cut_id="cut",potential_jump_v=1)
        second,_,_=split_coincident_sourcecut(mesh,seam_faces=seam,stable_vertex_ids=ids,
            normal_world=(0,0,-1),source_cut_id="cut",potential_jump_v=-1)
        self.assertNotEqual(first.elements.tobytes(),second.elements.tobytes())
        self.assertEqual(first.nodes[first.elements].tobytes(),second.nodes[second.elements].tobytes())

    def test_nonconforming_exterior_cut_and_degenerate_cell_rejected(self):
        mesh,seam,ids=full_loop_mesh()
        with self.assertRaises(ValueError):split_coincident_sourcecut(mesh,seam_faces=[mesh.boundary_faces[0]],
            stable_vertex_ids=ids,normal_world=(0,0,1),source_cut_id="cut",potential_jump_v=1)
        with self.assertRaises(ValueError):split_coincident_sourcecut(mesh,seam_faces=seam[:1],
            stable_vertex_ids=ids,normal_world=(0,0,1),source_cut_id="cut",potential_jump_v=1)
        with self.assertRaises(ValueError):closure().prepare(geometry=loop_geometry(),object_id="other",hmax_m=0.2e-6)
        malformed=copy.deepcopy(mesh)
        malformed.nodes[malformed.elements[0,1]]=malformed.nodes[malformed.elements[0,0]]
        with self.assertRaises(ValueError):split_coincident_sourcecut(malformed,seam_faces=seam,
            stable_vertex_ids=ids,normal_world=(0,0,1),source_cut_id="cut",potential_jump_v=1)

    def test_terminal_observations_rotate_minimum_id_without_changing_outward_normals(self):
        from types import SimpleNamespace
        from fullmag.meshing._antenna_coincident_cut import coincident_terminal_observations
        from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker
        nodes, cells, markers, vertex_map = [], [], [], {}
        def vertex(point):
            if point not in vertex_map:
                vertex_map[point] = len(nodes)
                nodes.append(point)
            return vertex_map[point]
        for x in (-1, 0, 1):
            for z in range(3):
                if x == 0 and z == 1:
                    continue
                marker = 3 if x == -1 else 4 if x == 1 else 1 if z == 0 else 2
                corners = {bits: vertex((x + bits[0], bits[1], z + bits[2]))
                           for bits in itertools.product((0, 1), repeat=3)}
                for permutation in itertools.permutations(range(3)):
                    bits = [0, 0, 0]
                    local = [corners[tuple(bits)]]
                    for axis in permutation:
                        bits[axis] = 1
                        local.append(corners[tuple(bits)])
                    xyz = np.asarray(nodes)[local]
                    if np.linalg.det(xyz[1:] - xyz[0]) < 0:
                        local[1], local[2] = local[2], local[1]
                    cells.append(local)
                    markers.append(marker)
        nodes, cells, markers = np.asarray(nodes, dtype=float), np.asarray(cells), np.asarray(markers)
        topology = _faces(cells)
        contacts, contact_markers = [], []
        target_face = None
        for owners in topology.values():
            if len(owners) != 2:
                continue
            for part_cell, face in owners:
                part = int(markers[part_cell])
                other = next(cell for cell, _ in owners if cell != part_cell)
                bridge = int(markers[other])
                if part not in (1, 2) or bridge not in (3, 4):
                    continue
                branch = "signal" if part == 1 else "return"
                selector = "local_u_min" if bridge == 3 else "local_u_max"
                contacts.append(face)
                contact_markers.append(antenna_terminal_marker("object", branch, selector))
                if target_face is None:
                    target_face = face
        self.assertIsNotNone(target_face)
        geometry = SimpleNamespace(signal_part_id="signal", conductor_part_ids=("signal", "return"),
            length_m=1., thickness_m=1., transform=SimpleNamespace(rotation_matrix=np.eye(3), translation_m=(0., 0., 0.)))
        port = SimpleNamespace(branches=[SimpleNamespace(id=part, signed_weight=weight,
            inlet_terminal_ref=part+"-in", outlet_terminal_ref=part+"-out") for part, weight in (("signal", 1.), ("return", -1.))])
        original_normal = np.cross(nodes[target_face[1]] - nodes[target_face[0]],
                                   nodes[target_face[2]] - nodes[target_face[0]])
        for minimum_position in range(3):
            with self.subTest(minimum_position=minimum_position):
                ids = list(range(100, 100 + len(nodes)))
                triple = [10, 20, 30]
                triple = triple[-minimum_position:] + triple[:-minimum_position] if minimum_position else triple
                for node, identity in zip(target_face, triple):
                    ids[node] = identity
                mesh = SimpleNamespace(nodes=nodes, elements=cells, element_markers=markers)
                raw = SimpleNamespace(vertex_identity={"vertex_ids": ids}, boundary_faces=np.asarray(contacts),
                                      boundary_markers=np.asarray(contact_markers))
                observed = coincident_terminal_observations(raw, SimpleNamespace(mesh=mesh, stable_vertex_ids=ids),
                    geometry=geometry, object_id="object", port=port)
                self.assertEqual(len(observed), 4)
                self.assertEqual([item["id"] for item in observed], sorted(item["id"] for item in observed))
                reversed_port = SimpleNamespace(branches=list(reversed(port.branches)))
                repeated = coincident_terminal_observations(raw, SimpleNamespace(mesh=mesh, stable_vertex_ids=ids),
                    geometry=geometry, object_id="object", port=reversed_port)
                self.assertEqual(repeated, observed)
                for item in observed:
                    keys = [(tuple(face["face_vertex_ids"]), face["part_cell_ordinal"], face["bridge_cell_ordinal"])
                            for face in item["faces"]]
                    self.assertEqual(keys, sorted(keys))
                id_nodes = {identity: node for node, identity in enumerate(ids)}
                matched = False
                for observation in observed:
                    for record in observation["faces"]:
                        actual = record["face_vertex_ids"]
                        self.assertEqual(actual[0], min(actual))
                        positions = nodes[[id_nodes[value] for value in actual]]
                        normal = np.cross(positions[1] - positions[0], positions[2] - positions[0])
                        expected = -1. if observation["selector"] == "local_u_min" else 1.
                        np.testing.assert_allclose(normal / np.linalg.norm(normal), (expected, 0., 0.))
                        if set(actual) == set(triple):
                            first = triple.index(min(triple))
                            self.assertEqual(actual, triple[first:] + triple[:first])
                            np.testing.assert_array_equal(normal, original_normal)
                            matched = True
                self.assertTrue(matched)

    def test_split_pair_order_is_canonical_for_reversed_stable_ids_and_seam_input(self):
        mesh, seam, ids = full_loop_mesh()
        ids = tuple(reversed(ids))
        first, first_ids, first_cut = split_coincident_sourcecut(mesh, seam_faces=seam,
            stable_vertex_ids=ids, normal_world=(0, 0, 1), source_cut_id="cut", potential_jump_v=1.)
        repeated, repeated_ids, repeated_cut = split_coincident_sourcecut(mesh, seam_faces=list(reversed(seam)),
            stable_vertex_ids=ids, normal_world=(0, 0, 1), source_cut_id="cut", potential_jump_v=1.)
        keys = [(tuple(pair.minus_face_vertex_ids), tuple(pair.plus_face_vertex_ids)) for pair in first_cut.face_pairs]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(first_cut.to_ir(), repeated_cut.to_ir())
        self.assertEqual(first_ids, repeated_ids)
        self.assertEqual(first.nodes[first.elements].tobytes(), repeated.nodes[repeated.elements].tobytes())

    def test_material_parts_are_sorted_before_bound_digest_without_reordering_assignments(self):
        from types import SimpleNamespace
        from fullmag.runtime.antenna_coincident_materialization import _material_binding, _exact_identity_preimage
        from fullmag.runtime.transport_identity import tagged_json_digest
        geometry = loop_geometry()
        assignments = [fm.ChargeTransportMaterialAssignment(fm.RegionRef("object", part),
            fm.ChargeTransportMaterial(sigma)) for part, sigma in (
                (geometry.signal_part_id, geometry.conductivity_s_per_m),
                (geometry.return_part_id, geometry.conductivity_s_per_m),
                (geometry.inlet_connection_part_id, geometry.inlet_connection_conductivity_s_per_m),
                (geometry.outlet_connection_part_id, geometry.outlet_connection_conductivity_s_per_m))]
        original = [item.to_ir() for item in assignments]
        mesh = SimpleNamespace(element_markers=np.asarray([1, 2, 3, 4]), n_elements=4,
                               cell_global_ordinals=np.arange(4))
        records, digest = _material_binding(SimpleNamespace(materials=assignments), geometry, mesh, "object")
        self.assertEqual([item["part_id"] for item in records], sorted(item["part_id"] for item in records))
        self.assertEqual([item.to_ir() for item in assignments], original)
        self.assertEqual({item["part_id"]: item["material_assignment_index"] for item in records},
                         {assignment.region.region_id: index for index, assignment in enumerate(assignments)})
        sigma = [assignments[index].material.sigma_Spm for index in range(4)]
        self.assertEqual(digest, tagged_json_digest({"schema": "antenna_coincident_material_binding.v2",
            "assignments": original, "material_parts": _exact_identity_preimage(records),
            "resolved_conductivity_spm_per_element": sigma}))

    @unittest.skipUnless(importlib.util.find_spec("gmsh"),"Gmsh Python runtime unavailable")
    def test_real_gmsh_conforming_loop_materialization(self):
        prepared=closure().prepare(geometry=loop_geometry(),object_id="object",hmax_m=0.15e-6)
        self.assertEqual(prepared.closure.operator_version,"fem_closed_current_geometry.v2")
        self.assertGreater(len(prepared.closure.source_cuts[0].face_pairs),0)
        self.assertEqual(len(prepared.conductivity_s_per_m_per_element),prepared.mesh.n_elements)
        self.assertFalse(prepared.receipt["basis_qualified"])

    def _quality_loop(self):
        from fullmag.meshing._antenna_coincident_cut import realize_antenna_coincident_loop_mesh
        from fullmag.meshing._gmsh_types import MeshOptions
        return realize_antenna_coincident_loop_mesh(closure(), geometry=loop_geometry(),
            object_id="object", hmax_m=0.15e-6,
            mesh_options=MeshOptions(compute_quality=True, per_element_quality=True))

    def _assert_si_quality(self, mesh):
        xyz = mesh.nodes[mesh.elements]
        volumes = np.abs(np.linalg.det(xyz[:, 1:] - xyz[:, :1])) / 6
        self.assertIsNotNone(mesh.quality)
        self.assertTrue(mesh.per_domain_quality)
        np.testing.assert_allclose(mesh.quality.element_volume, volumes, rtol=1e-8, atol=0)
        reports = [(mesh.quality, volumes)] + [(report, volumes[mesh.element_markers == marker])
            for marker, report in mesh.per_domain_quality.items()]
        for report, values in reports:
            np.testing.assert_allclose(
                [report.volume_min, report.volume_max, report.volume_mean, report.volume_std],
                [values.min(), values.max(), values.mean(), values.std()], rtol=1e-8, atol=0)

    @unittest.skipUnless(importlib.util.find_spec("gmsh"),"Gmsh Python runtime unavailable")
    def test_real_loop_quality_uses_si_volumes(self):
        self._assert_si_quality(self._quality_loop())

    @unittest.skipUnless(importlib.util.find_spec("gmsh"),"Gmsh Python runtime unavailable")
    def test_sourcecut_preserves_quality_and_element_order(self):
        raw = self._quality_loop()
        before = copy.deepcopy(raw.to_ir("loop"))
        from fullmag.meshing._antenna_coincident_cut import prepare_antenna_coincident_loop
        prepared = prepare_antenna_coincident_loop(closure(), geometry=loop_geometry(),
            object_id="object", hmax_m=0.15e-6, raw_mesh=raw).mesh
        self.assertIsNotNone(prepared.quality)
        self.assertEqual(prepared.quality, raw.quality)
        self.assertEqual(prepared.per_domain_quality, raw.per_domain_quality)
        self.assertEqual(prepared.nodes[prepared.elements].tobytes(), raw.nodes[raw.elements].tobytes())
        np.testing.assert_array_equal(prepared.element_markers, raw.element_markers)
        np.testing.assert_array_equal(prepared.cell_global_ordinals, raw.cell_global_ordinals)
        self.assertEqual(raw.to_ir("loop"), before)
        self._assert_si_quality(prepared)


if __name__=="__main__":unittest.main()
