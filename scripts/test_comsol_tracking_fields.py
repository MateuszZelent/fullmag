"""Synthetic wire artifacts, not solver or scientific evidence."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from comsol_mesh_identity import mesh_topology_fingerprint_v3
from comsol_tracking_fields import load_tracking_fields
from comsol_modal_field_certificate import validate_modal_field_certificate


def write_tracking_fixture(root):
    nodes = [[0., 0, 0], [1., 0, 0], [0., 1., 0], [0., 0, 1.]]
    mesh = {"nodes": nodes,
            "cells": {"types": ["tet4"], "offsets": [0, 4], "nodes": [0, 1, 2, 3]},
            "facets": {"types": [], "roles": [], "offsets": [0], "nodes": []},
            "periodic_node_pairs": [{"pair_id": "x", "node_a": 0, "node_b": 1}],
            "periodic_boundary_pairs": [{"pair_id": "x", "translation": [1., 0, 0]}]}
    fingerprint = mesh_topology_fingerprint_v3(mesh)
    plan = {"mesh": mesh, "spin_wave_bc": {"kind": "floquet", "pair_ids": ["x"]},
            "k_sampling": {"kind": "single", "vector_rad_per_m": [2., 0, 0]},
            "mesh_parts": [{"id": "film", "role": "magnetic_object",
                            "element_selector": {"kind": "element_range", "start": 0, "count": 1}}]}
    (root / "metadata.json").write_text(json.dumps({"execution_plan": {"backend_plan": plan}}))
    vector_path = root / "eigen/mode_fields/sample_0000/mode_0007/vector.bin"
    mode_path = root / "eigen/modes/sample_0000/mode_0007.json"
    vector_path.parent.mkdir(parents=True)
    mode_path.parent.mkdir(parents=True)
    envelope = np.tile([0, 1, 1j], (4, 1)).astype(complex)
    field = envelope * np.exp(-1j * (np.array(nodes) @ [2., 0, 0]))[:, None]
    pairs = np.stack([field.real, field.imag], axis=-1).astype("<f8")
    data = pairs.tobytes()
    vector_path.write_bytes(data)
    mode = {"schema_version": "eigen_mode.v2", "sample_index": 0, "raw_mode_index": 7,
            "k_vector": [2., 0, 0], "source_mesh_topology_sha256": fingerprint,
            "frequency_real_hz": 1e10, "frequency_imag_hz": 0,
            "source_mesh_identity": {"indexing": "full_domain_node_order", "node_count": 4},
            "mode_field_sample_count": 4, "complex_pair_count": 12, "payload_value_count": 24,
            "payload_sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
            "payload_encoding": "f64_interleaved_real_imag_xyz",
            "binary_layout": "complex_f64_pairs_little_endian", "component_basis": "global_xyz",
            "compatibility_binary_payload_path": vector_path.relative_to(root).as_posix(),
            "tracking_consistent_p1_metric": {
                "schema": "fullmag.tracking_consistent_p1_metric.v1",
                "definition_id": "consistent_p1_tet4_cartesian_nodal_envelope.v1",
                "source_mesh_topology_sha256": fingerprint,
                "physical_node_indices": [0, 1, 2, 3], "tetra": [[0, 1, 2, 3]],
                "volumes_m3": [1/6]}}
    mode_path.write_text(json.dumps(mode))
    return mode_path, envelope


class TrackingFieldTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.mode_path, self.envelope = write_tracking_fixture(self.root)

    def test_actual_certificate_and_geometry(self):
        result = load_tracking_fields(self.root, [(0, 7)])
        np.testing.assert_allclose(result["modes"][(0, 7)]["envelope"], self.envelope, atol=1e-14)
        self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_coherent_declared_mesh_digest_cannot_replace_geometry(self):
        mode = json.loads(self.mode_path.read_text())
        mode["source_mesh_topology_sha256"] = "sha256:" + "0" * 64
        mode["tracking_consistent_p1_metric"]["source_mesh_topology_sha256"] = mode["source_mesh_topology_sha256"]
        self.mode_path.write_text(json.dumps(mode))
        with self.assertRaisesRegex(ValueError, "actual geometry"):
            load_tracking_fields(self.root, [(0, 7)])

    def test_wrong_volume_and_diagonal_mass_rejected(self):
        original = json.loads(self.mode_path.read_text())
        for change in ("volume", "diagonal"):
            mode = json.loads(json.dumps(original))
            if change == "volume":
                mode["tracking_consistent_p1_metric"]["volumes_m3"] = [1/3]
            else:
                mode["node_mass_weights"] = [1, 1, 1, 1]
            self.mode_path.write_text(json.dumps(mode))
            with self.subTest(change=change), self.assertRaises(ValueError):
                load_tracking_fields(self.root, [(0, 7)])

    def test_bytes_changed_after_certificate_rejected(self):
        certificate = validate_modal_field_certificate(self.root, mode_selections=[(0, 7)])
        self.assertEqual(certificate["status"], "pass")
        with patch("comsol_tracking_fields.validate_modal_field_certificate", return_value=certificate):
            self.mode_path.write_text(self.mode_path.read_text() + " ")
            with self.assertRaisesRegex(ValueError, "changed after"):
                load_tracking_fields(self.root, [(0, 7)])

    def test_missing_explicit_support_or_metric_rejected(self):
        metadata_path = self.root / "metadata.json"
        metadata = json.loads(metadata_path.read_text())
        del metadata["execution_plan"]["backend_plan"]["mesh_parts"]
        metadata_path.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, "explicit mesh_parts"):
            load_tracking_fields(self.root, [(0, 7)])
        # Restore the fixture with its explicit partition; remove only mass.
        mode = json.loads(self.mode_path.read_text())
        metadata["execution_plan"]["backend_plan"]["mesh_parts"] = [
            {"id": "film", "role": "magnetic_object", "element_selector": {
                "kind": "element_range", "start": 0, "count": 1}}]
        metadata_path.write_text(json.dumps(metadata))
        del mode["tracking_consistent_p1_metric"]
        self.mode_path.write_text(json.dumps(mode))
        with self.assertRaisesRegex(ValueError, "persisted tracking metric"):
            load_tracking_fields(self.root, [(0, 7)])

    def test_payload_tampering_rejected_before_algebra(self):
        mode = json.loads(self.mode_path.read_text())
        path = self.root / mode["compatibility_binary_payload_path"]
        data = bytearray(path.read_bytes())
        data[8] ^= 1
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "phase certificate failed"):
            load_tracking_fields(self.root, [(0, 7)])


if __name__ == "__main__":
    unittest.main()
