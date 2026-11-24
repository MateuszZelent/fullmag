"""Execution provenance stays separate from authored sizing and numerical mesh."""
import copy
from dataclasses import replace
import json
from itertools import permutations
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import numpy as np
from fullmag.meshing._gmsh_types import MeshData, MeshOptions
from fullmag.meshing._antenna_coincident_cut import realize_antenna_coincident_loop_mesh
from fullmag.runtime.transport_identity import tagged_json_digest

REPORT = {"schema_version": "mesh_size_field_realization.v1", "fields": [
    {"id": "sf1", "role": "upper_target", "kind": "Ball", "target": None,
     "status": "applied", "source": "scene_config", "reason": None,
     "gmsh_field_id": 1, "params": {"VIn": 50e-9}}
]}

def tetra(**kwargs):
    return MeshData.from_legacy_tet4(
        nodes=[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
        elements=[[0, 1, 2, 3]], element_markers=[1],
        boundary_faces=[[1, 2, 3], [0, 3, 2], [0, 1, 3], [0, 2, 1]],
        boundary_markers=[1, 1, 1, 1], **kwargs)

def closed_ring():
    from fullmag.meshing._antenna_coincident_cut import _TET_FACES
    nodes = np.array([(x, y, z) for x in range(4) for y in range(4)
                      for z in range(2)], dtype=float)
    index = {tuple(point): i for i, point in enumerate(nodes)}
    cells = []
    for x in range(3):
        for y in range(3):
            if (x, y) == (1, 1):
                continue
            for order in permutations(range(3)):
                point = np.array([x, y, 0])
                vertices = [index[tuple(point)]]
                for axis in order:
                    point = point.copy()
                    point[axis] += 1
                    vertices.append(index[tuple(point)])
                xyz = nodes[vertices]
                if np.linalg.det((xyz[1:] - xyz[0]).T) < 0:
                    vertices[1], vertices[2] = vertices[2], vertices[1]
                cells.append(vertices)
    owners = defaultdict(list)
    for cell in cells:
        for local in _TET_FACES:
            face = tuple(cell[i] for i in local)
            owners[tuple(sorted(face))].append(face)
    boundary = [faces[0] for faces in owners.values() if len(faces) == 1]
    seam = [list(face) for face, faces in owners.items() if len(faces) == 2
            and np.all(nodes[list(face), 0] == 1)
            and np.all(nodes[list(face), 1] <= 1)]
    mesh = MeshData.from_legacy_tet4(
        nodes=nodes, elements=cells, element_markers=[1] * len(cells),
        boundary_faces=boundary, boundary_markers=[1] * len(boundary),
        size_field_realization={"schema_version": "mesh_size_field_realization.v1", "fields": []})
    return mesh, seam

class SizeFieldProvenanceTests(unittest.TestCase):
    def test_report_roundtrips_npz_and_json_without_changing_topology(self):
        mesh = tetra(size_field_realization=REPORT)
        with tempfile.TemporaryDirectory() as folder:
            for suffix in (".npz", ".json"):
                with self.subTest(suffix=suffix):
                    path = Path(folder) / ("mesh" + suffix)
                    mesh.save(path)
                    restored = MeshData.load(path)
                    self.assertEqual(restored.size_field_realization, REPORT)
                    self.assertEqual(restored.topology_fingerprint_v3(), mesh.topology_fingerprint_v3())
                    np.testing.assert_array_equal(restored.nodes, mesh.nodes)

    def test_original_report_cannot_mutate_retained_evidence(self):
        report = copy.deepcopy(REPORT)
        mesh = tetra(size_field_realization=report)
        report["fields"][0]["params"]["VIn"] = 99.
        self.assertEqual(mesh.size_field_realization, REPORT)

    def test_old_cache_does_not_invent_applied_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "legacy.npz"
            tetra().save(path)
            with np.load(path, allow_pickle=False) as saved:
                arrays = {key: saved[key] for key in saved.files
                          if key != "size_field_realization_json"}
            np.savez_compressed(path, **arrays)
            self.assertIsNone(MeshData.load(path).size_field_realization)

    def test_old_json_without_report_remains_readable(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "mesh.json"
            tetra().save(path)
            value = json.loads(path.read_text())
            value.pop("size_field_realization", None)
            path.write_text(json.dumps(value))
            self.assertIsNone(MeshData.load(path).size_field_realization)

    def test_unknown_or_malformed_report_is_rejected(self):
        for report in [
            {"schema_version": "other.v1", "fields": []},
            {"schema_version": "mesh_size_field_realization.v1", "fields": {}},
            {"schema_version": "mesh_size_field_realization.v1", "fields": [None]},
            {**REPORT, "unknown": True},
        ]:
            with self.subTest(report=report), self.assertRaises(ValueError):
                tetra(size_field_realization=report)

    def test_malformed_field_entry_is_rejected(self):
        for field in [{}, {**REPORT["fields"][0], "params": []},
                      {**REPORT["fields"][0], "gmsh_field_id": True},
                      {**REPORT["fields"][0], "role": "unbound"}]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                tetra(size_field_realization={**REPORT, "fields": [field]})

    def test_sourcecut_keeps_report_and_every_cell_coordinate(self):
        from fullmag.meshing._antenna_coincident_cut import split_coincident_sourcecut
        raw, seam = closed_ring()
        self.assertEqual(len(seam), 2)
        prepared, _, _ = split_coincident_sourcecut(
            raw, seam_faces=seam, stable_vertex_ids=list(range(1, len(raw.nodes) + 1)),
            normal_world=np.array([1., 0., 0.]), source_cut_id="fixture_cut",
            potential_jump_v=0.001)
        self.assertEqual(prepared.size_field_realization, raw.size_field_realization)
        np.testing.assert_array_equal(prepared.nodes[prepared.elements], raw.nodes[raw.elements])

    def test_orientation_repair_retains_realization_report(self):
        mesh = tetra(size_field_realization=REPORT)
        inverted = replace(mesh, cell_nodes=np.array([0, 1, 3, 2], dtype=np.int64))
        repaired = inverted.oriented_copy()
        self.assertIsNot(repaired, inverted)
        self.assertEqual(repaired.size_field_realization, REPORT)
        xyz = repaired.nodes[repaired.elements[0]]
        self.assertGreater(np.linalg.det((xyz[1:] - xyz[0]).T), 0)

    def test_nonfinite_report_is_rejected(self):
        report = copy.deepcopy(REPORT)
        report["fields"][0]["params"]["VIn"] = float("nan")
        with self.assertRaises(ValueError):
            tetra(size_field_realization=report)

    def test_report_does_not_change_numerical_mesh_or_topology_identity(self):
        plain = tetra()
        recorded = replace(plain, size_field_realization=REPORT)
        self.assertEqual(plain.to_ir("mesh"), recorded.to_ir("mesh"))
        self.assertEqual(plain.topology_fingerprint_v3(), recorded.topology_fingerprint_v3())

    def test_cold_execution_does_not_mutate_authored_workflow_or_lose_applied_report(self):
        field = {"kind": "Ball", "params": {"VIn": 50e-9, "VOut": 75e-9}}
        workflow = {"mesh_options": {"size_fields": [field]}}
        original = copy.deepcopy(workflow)
        before_digest = tagged_json_digest(workflow)
        options = MeshOptions(size_fields=workflow["mesh_options"]["size_fields"], compute_quality=False)
        cut = SimpleNamespace(plane=SimpleNamespace(offset_m=0., axis="x"),
                              region=SimpleNamespace(object_id="antenna"))
        geometry = SimpleNamespace(inlet_connection_part_id="inlet",
            transform=SimpleNamespace(rotation_matrix=np.eye(3), apply=lambda p: p))
        gmsh = MagicMock()
        gmsh.model.getBoundary.return_value = [(2, 11), (2, 11)]
        gmsh.model.occ.getCenterOfMass.return_value = (0., 0., 0.)
        def apply(_gmsh, _hmax, _order, execution, **_kwargs):
            execution.size_fields[0]["_gmsh_status"] = "applied"
            execution.size_fields[0]["_gmsh_field_id"] = 7
        with patch("fullmag.meshing._antenna_coincident_cut._validate_loop_request", return_value=cut), \
             patch("fullmag.meshing._gmsh_infra._import_gmsh", return_value=gmsh), \
             patch("fullmag.meshing._gmsh_infra._configure_gmsh_threads"), \
             patch("fullmag.meshing._gmsh_waveguides.add_antenna_layout_parts_to_occ", return_value={"inlet": [(3, 1)]}), \
             patch("fullmag.meshing._gmsh_waveguides.add_antenna_layout_terminal_physical_groups"), \
             patch("fullmag.meshing._gmsh_fields._apply_mesh_options", side_effect=apply), \
             patch("fullmag.meshing._gmsh_fields._apply_post_mesh_options"), \
             patch("fullmag.meshing._gmsh_extraction._extract_mesh_data", return_value=tetra()):
            mesh = realize_antenna_coincident_loop_mesh(None, geometry=geometry,
                object_id="antenna", hmax_m=75e-9, mesh_options=options)
        self.assertEqual(workflow, original)
        self.assertEqual(tagged_json_digest(workflow), before_digest)
        self.assertEqual(mesh.size_field_realization["fields"][0]["status"], "applied")
        self.assertEqual(mesh.size_field_realization["fields"][0]["gmsh_field_id"], 7)

if __name__ == "__main__":
    unittest.main()
