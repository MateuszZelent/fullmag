"""Interpreted straight-stub input checks; no solver, field qualification or native build."""
from __future__ import annotations

import argparse
from dataclasses import replace
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np


class LeadPreparationChecks(unittest.TestCase):
    storage_root: Path
    with_gmsh = False

    @staticmethod
    def box_mesh(*, taper=1.0, second=False):
        from fullmag.meshing._gmsh_types import MeshData
        nodes = np.array([[0., 0., 0.], [0., 1., 0.], [0., 1., 1.], [0., 0., 1.],
                          [1., 0., 0.], [1., taper, 0.], [1., taper, 1.], [1., 0., 1.]]) * 1e-6
        cells = np.array([[0, 1, 2, 6], [0, 1, 5, 6], [0, 4, 5, 6],
                          [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 6, 7]])
        if second:
            nodes = np.concatenate((nodes, nodes + [0., 3e-6, 0.]))
            cells = np.concatenate((cells, cells + 8))
        for cell in cells:
            if np.linalg.det(nodes[cell[1:]] - nodes[cell[0]]) < 0:
                cell[1], cell[2] = cell[2], cell[1]
        faces = {}
        for cell in cells:
            for omit in range(4):
                face = tuple(sorted(int(v) for i, v in enumerate(cell) if i != omit))
                faces[face] = faces.get(face, 0) + 1
        exterior = sorted(face for face, count in faces.items() if count == 1)
        left, right = {(0, 1, 2), (0, 2, 3)}, {(4, 5, 6), (4, 6, 7)}
        markers = []
        for face in exterior:
            offset = 8 if face[0] >= 8 else 0
            local = tuple(v - offset for v in face)
            markers.append((21 if offset else 11) if local in left else
                           (22 if offset else 12) if local in right else (23 if offset else 13))
        # Non-ordinal and deliberately not sorted: lineage must use this exact order.
        ids = [107, 3, 900001, 45, 991, 19, 111, 900003]
        if second:
            ids += [v + 2_000_000 for v in ids]
        return MeshData.from_legacy_tet4(nodes=nodes, elements=cells, element_markers=[1] * len(cells),
            boundary_faces=exterior, boundary_markers=markers,
            vertex_identity={"schema_version": "mesh_vertex_identity.v1", "issuer": "gmsh_node_tags.v1", "vertex_ids": ids})

    @staticmethod
    def extensions(*, second=False, rotation=None):
        from fullmag.meshing._antenna_external_lead_preparation import TerminalLeadExtension
        direction = np.array([1., 0., 0.]) if rotation is None else rotation @ [1., 0., 0.]
        extensions = [TerminalLeadExtension("left", "observe-left", "device", (11,), 0.4e-6, tuple(-direction), 5.8e7),
                      TerminalLeadExtension("right", "observe-right", "device", (12,), 0.6e-6, tuple(direction), 4.1e7, 3)]
        if second:
            extensions += [replace(extensions[0], id="left-2", observation_id="observe-left-2", boundary_markers=(21,)),
                           replace(extensions[1], id="right-2", observation_id="observe-right-2", boundary_markers=(22,))]
        return extensions

    @staticmethod
    def drives(*, second=False):
        from fullmag.model.current_transport import CurrentSourceDrive
        currents = {"left": -0.003, "right": 0.003}
        if second:
            currents.update({"left-2": -0.008, "right-2": 0.008})
        return [CurrentSourceDrive("explicit-drive", "authored-port", currents)]

    def prepare(self, mesh=None, extensions=None, drives=None):
        from fullmag.meshing._antenna_external_lead_preparation import prepare_antenna_external_lead_source
        return prepare_antenna_external_lead_source(device_mesh=mesh or self.box_mesh(),
            extensions=extensions or self.extensions(), drives=drives or self.drives(), revision="fixture-input-r1")

    def test_positive_staircase_exact_lineage_and_authored_currents(self):
        mesh = self.box_mesh()
        before = mesh.nodes.copy()
        prepared = self.prepare(mesh)
        source, lead = prepared.source, prepared.lead_mesh
        self.assertEqual(source.device_stable_vertex_ids, mesh.vertex_identity["vertex_ids"])
        self.assertTrue(set(source.lead_stable_vertex_ids).isdisjoint(source.device_stable_vertex_ids))
        self.assertEqual(min(source.lead_stable_vertex_ids), max(source.device_stable_vertex_ids) + 1)
        self.assertEqual(lead.n_elements, 2 * 3 * 2 + 2 * 3 * 3)
        self.assertEqual(lead.n_nodes, 4 * 3 + 4 * 4)
        self.assertIsNone(lead.vertex_identity)
        volumes = np.linalg.det(lead.nodes[lead.elements[:, 1:]] - lead.nodes[lead.elements[:, 0]][:, None, :]) / 6
        self.assertTrue(np.all(volumes > 0))
        self.assertAlmostEqual(float(volumes.sum()) / 1e-18, 1.0, places=12)
        actual = dict(zip(source.device_stable_vertex_ids, mesh.nodes, strict=True))
        generated = dict(zip(source.lead_stable_vertex_ids, lead.nodes, strict=True))
        for pair in source.interface_pairs:
            for device_id, lead_id in pair.vertex_pairs:
                np.testing.assert_array_equal(actual[device_id], generated[lead_id])
        self.assertEqual(dict(source.drives[0].outer_terminal_currents_a), {"left": -0.003, "right": 0.003})
        np.testing.assert_array_equal(mesh.nodes, before)
        self.assertEqual(prepared.receipt["status"], "input_prepared_not_solved")
        self.assertEqual(prepared.receipt["field_scope"], "external_electrode_truncation")
        self.assertFalse(any(prepared.receipt["capabilities"].values()))
        self.assertNotIn("solved_digest", prepared.receipt)
        with self.assertRaises(TypeError):
            prepared.receipt["policy"] = "changed"
        with self.assertRaises(ValueError):
            lead.nodes[0] = [0., 0., 0.]

    def test_taper_device_retained_and_rigid_transform_supported(self):
        mesh = self.box_mesh(taper=0.6)
        angle = 0.2
        rotation = np.array([[math.cos(angle), -math.sin(angle), 0.],
                             [math.sin(angle), math.cos(angle), 0.], [0., 0., 1.]])
        rotated = replace(mesh, nodes=mesh.nodes @ rotation.T + [8e-6, -3e-6, 2e-6])
        prepared = self.prepare(rotated, self.extensions(rotation=rotation))
        np.testing.assert_array_equal(prepared.receipt["device_mesh"]["nodes"], rotated.nodes)
        self.assertEqual(prepared.source.device_stable_vertex_ids, mesh.vertex_identity["vertex_ids"])
        self.assertEqual(prepared.lead_mesh.n_elements, 30)

    def test_source_and_mesh_round_trip_are_exact(self):
        from fullmag.meshing._gmsh_types import MeshData
        from fullmag.model.current_transport import (CurrentSourceDrive, CurrentSourceInterfacePair,
            CurrentSourceOuterTerminal, CurrentSourceTerminalObservation, ExternalLeadCurrentSource)
        prepared = self.prepare()
        raw = json.loads(json.dumps(prepared.source.to_ir()))
        round_trip = ExternalLeadCurrentSource(revision=raw["revision"], device_stable_vertex_ids=raw["device_stable_vertex_ids"],
            lead_mesh=raw["lead_mesh"], lead_stable_vertex_ids=raw["lead_stable_vertex_ids"],
            lead_conductivity_spm_per_element=raw["lead_conductivity_spm_per_element"],
            interface_pairs=[CurrentSourceInterfacePair(**value) for value in raw["interface_pairs"]],
            outer_terminals=[CurrentSourceOuterTerminal(**value) for value in raw["outer_terminals"]],
            terminal_observations=[CurrentSourceTerminalObservation(**value) for value in raw["terminal_observations"]],
            drives=[CurrentSourceDrive(**value) for value in raw["drives"]])
        self.assertEqual(round_trip.to_ir(), prepared.source.to_ir())
        with tempfile.TemporaryDirectory(prefix="antenna-lead-preparation-", dir=self.storage_root) as temporary:
            for extension in ("json", "npz"):
                path = Path(temporary) / f"lead.{extension}"
                prepared.lead_mesh.save(path)
                loaded = MeshData.load(path)
                self.assertIsNone(loaded.vertex_identity)
                np.testing.assert_array_equal(loaded.nodes, prepared.lead_mesh.nodes)
                np.testing.assert_array_equal(loaded.elements, prepared.lead_mesh.elements)

    def test_vertex_cell_facet_permutations_keep_exact_source_lineage(self):
        mesh = self.box_mesh()
        original = self.prepare(mesh).source.to_ir()
        order = np.array([5, 0, 7, 2, 1, 4, 6, 3])
        inverse = np.argsort(order)
        cell_order = np.array([5, 1, 3, 0, 4, 2])
        facet_order = np.arange(mesh.n_boundary_faces)[::-1]
        identity = dict(mesh.vertex_identity)
        identity["vertex_ids"] = tuple(mesh.vertex_identity["vertex_ids"][int(i)] for i in order)
        permuted = replace(mesh, nodes=mesh.nodes[order], vertex_identity=identity,
            cell_nodes=inverse[mesh.elements[cell_order]].reshape(-1), element_markers=mesh.element_markers[cell_order],
            cell_global_ordinals=mesh.cell_global_ordinals[cell_order],
            facet_nodes=inverse[mesh.boundary_faces[facet_order]].reshape(-1),
            boundary_markers=mesh.boundary_markers[facet_order], facet_global_ordinals=mesh.facet_global_ordinals[facet_order])
        actual = self.prepare(permuted, list(reversed(self.extensions()))).source.to_ir()
        self.assertEqual(actual["device_stable_vertex_ids"], list(identity["vertex_ids"]))
        original.pop("device_stable_vertex_ids")
        actual.pop("device_stable_vertex_ids")
        self.assertEqual(actual, original)

    def test_current_reversal_scaling_and_zero_never_change_geometry(self):
        from fullmag.model.current_transport import CurrentSourceDrive
        reference = self.prepare().source.to_ir()
        for factor in (-1.0, 7.25, 0.0):
            with self.subTest(factor=factor):
                currents = {key: factor * value for key, value in self.drives()[0].outer_terminal_currents_a.items()}
                actual = self.prepare(drives=[CurrentSourceDrive("scaled", "explicit-port", currents)]).source.to_ir()
                self.assertEqual(actual["drives"], [{"id": "scaled", "port_mode_ref": "explicit-port", "outer_terminal_currents_a": currents}])
                self.assertEqual({k: v for k, v in actual.items() if k != "drives"},
                                 {k: v for k, v in reference.items() if k != "drives"})

    def test_star_cap_with_locally_consistent_turns_is_not_convex_disk(self):
        from fullmag.meshing._gmsh_types import MeshData
        # A topological fan with winding two has positive local triangles but
        # overlapping geometric sectors. Local incidence alone cannot accept it.
        polygon = [[math.cos(2 * math.pi * i / 5), math.sin(2 * math.pi * i / 5)] for i in (0, 2, 4, 1, 3)]
        section = np.array([[0., 0.], *polygon]) * 1e-6
        nodes = np.concatenate((np.column_stack((np.zeros(6), section)),
                                np.column_stack((np.full(6, 1e-6), section))))
        triangles = [(0, i + 1, (i + 1) % 5 + 1) for i in range(5)]
        cells, incidence = [], {}
        for triangle in triangles:
            a, b, c = sorted(triangle)
            for cell in ([a, b, c, c + 6], [a, b, b + 6, c + 6], [a, a + 6, b + 6, c + 6]):
                if np.linalg.det(nodes[cell[1:]] - nodes[cell[0]]) < 0:
                    cell[1], cell[2] = cell[2], cell[1]
                cells.append(cell)
                for omit in range(4):
                    face = tuple(sorted(v for i, v in enumerate(cell) if i != omit))
                    incidence[face] = incidence.get(face, 0) + 1
        faces = sorted(face for face, count in incidence.items() if count == 1)
        markers = [11 if all(v < 6 for v in face) else 12 if all(v >= 6 for v in face) else 13 for face in faces]
        mesh = MeshData.from_legacy_tet4(nodes=nodes, elements=cells, element_markers=[1] * len(cells),
            boundary_faces=faces, boundary_markers=markers,
            vertex_identity={"schema_version": "mesh_vertex_identity.v1", "issuer": "gmsh_node_tags.v1", "vertex_ids": [10 + i * 17 for i in range(12)]})
        with self.assertRaisesRegex(ValueError, "winding one"):
            self.prepare(mesh)

    def test_explicit_component_balance_not_global_cancellation(self):
        from fullmag.model.current_transport import CurrentSourceDrive
        mesh = self.box_mesh(second=True)
        extensions = self.extensions(second=True)
        prepared = self.prepare(mesh, extensions, self.drives(second=True))
        self.assertEqual(len(prepared.source.outer_terminals), 4)
        bad = CurrentSourceDrive("wrong", "port", {"left": 1., "right": 0., "left-2": -1., "right-2": 0.})
        with self.assertRaisesRegex(ValueError, "imbalance in an electrical component"):
            self.prepare(mesh, extensions, [bad])
        missing = CurrentSourceDrive("wrong", "port", {"left": -1., "right": 1.})
        with self.assertRaisesRegex(ValueError, "exactly all outer terminals"):
            self.prepare(mesh, extensions, [missing])
        with self.assertRaisesRegex(ValueError, "every device component"):
            self.prepare(mesh, self.extensions(), self.drives())
        zero = CurrentSourceDrive("zero", "port", {e.id: 0. for e in extensions})
        self.assertTrue(all(value == 0. for value in self.prepare(mesh, extensions, [zero]).source.drives[0].outer_terminal_currents_a.values()))

    def test_fail_closed_markers_directions_caps_bounds_and_identity(self):
        from fullmag.meshing._antenna_external_lead_preparation import TerminalLeadExtension
        mesh = self.box_mesh()
        cases = [(replace(self.extensions()[0], boundary_markers=(999,)), "does not exist"),
                 (replace(self.extensions()[0], outward_direction_xyz=(1., 0., 0.)), "separate"),
                 (replace(self.extensions()[0], boundary_markers=(13,)), "planar"),
                 (replace(self.extensions()[0], layers=1 << 20), "before allocation")]
        for bad, error in cases:
            with self.subTest(error=error), self.assertRaisesRegex(ValueError, error):
                self.prepare(mesh, [bad, self.extensions()[1]])
        for parameter, value in (("layers", True), ("layers", 2.0), ("length_m", float("nan")),
                                 ("conductivity_spm", 0.), ("outward_direction_xyz", (2., 0., 0.)),
                                 ("boundary_markers", (11, 11))):
            arguments = {name: getattr(self.extensions()[0], name) for name in TerminalLeadExtension.__dataclass_fields__}
            arguments[parameter] = value
            with self.subTest(parameter=parameter), self.assertRaises(ValueError):
                TerminalLeadExtension(**arguments)
        with self.assertRaisesRegex(ValueError, "requires retained"):
            self.prepare(replace(mesh, vertex_identity=None))
        identity = dict(mesh.vertex_identity)
        identity["vertex_ids"] = tuple([ (1 << 64) - 1] + list(mesh.vertex_identity["vertex_ids"])[1:])
        with self.assertRaisesRegex(ValueError, "overflow u64 before allocation"):
            self.prepare(replace(mesh, vertex_identity=identity))
        markers = mesh.boundary_markers.copy()
        markers[np.flatnonzero(markers == 11)[0]] = 14
        with self.assertRaisesRegex(ValueError, "complete terminal cap"):
            self.prepare(replace(mesh, boundary_markers=markers))
        with self.assertRaisesRegex(ValueError, "reaction DOF"):
            self.prepare(mesh, [self.extensions()[0], replace(self.extensions()[0], id="right", observation_id="another")])

    def test_wrong_topology_is_rejected_before_solver(self):
        mesh = self.box_mesh()
        malformed = replace(mesh, facet_nodes=mesh.facet_nodes.copy())
        malformed.facet_nodes[:3] = malformed.facet_nodes[3:6]
        with self.assertRaisesRegex(ValueError, "exactly the actual"):
            self.prepare(malformed)
        inverted = replace(mesh, cell_nodes=mesh.cell_nodes.copy())
        inverted.cell_nodes[0], inverted.cell_nodes[1] = inverted.cell_nodes[1], inverted.cell_nodes[0]
        with self.assertRaisesRegex(ValueError, "positive orientation"):
            self.prepare(inverted)
        from fullmag.meshing._gmsh_types import MeshData
        # A second tetrahedron shares only vertex 0 with the first, a P1-only short.
        nodes = [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.],
                 [-1., 0., 0.], [0., -1., 0.], [0., 0., -1.]]
        cells = [[0, 1, 2, 3], [0, 4, 6, 5]]
        faces = [tuple(v for i, v in enumerate(cell) if i != omit) for cell in cells for omit in range(4)]
        short = MeshData.from_legacy_tet4(nodes=nodes, elements=cells, element_markers=[1, 1], boundary_faces=faces,
            boundary_markers=[11] * 4 + [12] * 4,
            vertex_identity={"schema_version": "mesh_vertex_identity.v1", "issuer": "gmsh_node_tags.v1", "vertex_ids": [101 + 7 * i for i in range(7)]})
        with self.assertRaisesRegex(ValueError, "vertex/edge-only"):
            self.prepare(short)

    def test_strict_aabb_proof_is_not_replaced_by_collision_guess(self):
        mesh = self.box_mesh()
        angle = math.pi / 4
        rotation = np.array([[math.cos(angle), -math.sin(angle), 0.], [math.sin(angle), math.cos(angle), 0.], [0., 0., 1.]])
        wide_nodes = mesh.nodes.copy()
        wide_nodes[:, 1] *= 1.5
        rotated = replace(mesh, nodes=wide_nodes @ rotation.T)
        # This rotated cuboid has overlapping AABBs, although the stubs do not overlap.
        with self.assertRaisesRegex(ValueError, "strict stub separation certification is unsupported"):
            self.prepare(rotated, self.extensions(rotation=rotation))

    def test_optional_real_gmsh_microstrip_and_taper(self):
        if not self.with_gmsh:
            self.skipTest("real Gmsh meshing is opt-in; use --with-gmsh")
        from fullmag.model.geometry import MicrostripAntennaLayout, MicrostripWidthStation
        from fullmag.meshing._gmsh_generators import _generate_csg_mesh
        from fullmag.meshing._gmsh_waveguides import antenna_terminal_marker
        from fullmag.meshing._antenna_external_lead_preparation import TerminalLeadExtension
        from fullmag.model.current_transport import CurrentSourceDrive
        for taper in (1.0, 0.7):
            with self.subTest(taper=taper):
                owner = "real-microstrip"
                layout = MicrostripAntennaLayout(name="presentation-name-is-not-owner", length_m=4e-6, thickness_m=0.5e-6,
                    conductivity_s_per_m=4e7, stations=[MicrostripWidthStation(0., 1e-6), MicrostripWidthStation(1., taper * 1e-6)],
                    return_width_m=2e-6, return_offset_m=0.5e-6)
                mesh = _generate_csg_mesh(layout, hmax=0.5e-6, object_id=owner)
                extensions = []
                for part in ("signal", "return"):
                    for selector, direction in (("local_u_min", (-1., 0., 0.)), ("local_u_max", (1., 0., 0.))):
                        terminal = f"{part}:{selector}"
                        extensions.append(TerminalLeadExtension(terminal, f"observe:{terminal}", owner,
                            (antenna_terminal_marker(owner, part, selector),), 1e-6, direction, 4e7))
                currents = {e.id: (-0.001 if e.id.endswith("local_u_min") else 0.001) for e in extensions}
                prepared = self.prepare(mesh, extensions, [CurrentSourceDrive("real-explicit", "real-port", currents)])
                self.assertEqual(prepared.source.device_stable_vertex_ids, mesh.vertex_identity["vertex_ids"])
                self.assertEqual(len(prepared.source.outer_terminals), 4)
                self.assertEqual(dict(prepared.source.drives[0].outer_terminal_currents_a), currents)
                self.assertTrue(np.all(np.isfinite(prepared.lead_mesh.nodes)))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--storage-root", type=Path, required=True)
    parser.add_argument("--with-gmsh", action="store_true")
    args = parser.parse_args()
    if not args.storage_root.is_absolute() or not args.storage_root.is_dir():
        parser.error("--storage-root must be an existing absolute configured storage directory")
    sys.path.insert(0, str(args.repo_root / "packages/fullmag-py/src"))
    LeadPreparationChecks.storage_root = args.storage_root.resolve(strict=True)
    LeadPreparationChecks.with_gmsh = args.with_gmsh
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(LeadPreparationChecks))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
