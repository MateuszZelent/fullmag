#!/usr/bin/env python3
"""Focused regression tests for validate_de_physical_potential.py."""

from __future__ import annotations

import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path

from validate_de_physical_potential import (
    ValidationError,
    validate_physical_potential,
)


class PhysicalPotentialFixture:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.mode_dir = root / "eigen" / "mode_fields" / "sample_0000" / "mode_0000"
        self.mode_dir.mkdir(parents=True)
        self.manifest_path = self.mode_dir / "physical_potential.v1.json"
        self.metadata_path = root / "metadata.json"
        self.nodes = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        self.elements = [[0, 1, 2, 3]]
        # phi(x,y,z) = c0 + cx*x + cy*y + cz*z.
        self.phi = [
            complex(1.0, 2.0),
            complex(3.0, 1.0),
            complex(-2.0, 2.5),
            complex(1.25, 6.0),
        ]
        self.field = [complex(-2.0, 1.0), complex(3.0, -0.5), complex(-0.25, -4.0)]
        self._write_metadata()
        self.write_artifacts()

    def _write_metadata(self) -> None:
        self.metadata_path.write_text(
            json.dumps(
                {
                    "execution_plan": {
                        "backend_plan": {
                            "kind": "fem_eigen",
                            "mesh": {
                                "nodes": self.nodes,
                                "cells": {
                                    "types": ["tet4"] * len(self.elements),
                                    "offsets": [index * 4 for index in range(len(self.elements) + 1)],
                                    "nodes": [node for element in self.elements for node in element],
                                },
                            },
                        }
                    }
                },
                indent=2,
            ),
            encoding="utf-8",
        )

    def _write_complex(self, path: Path, values: list[complex]) -> None:
        path.write_bytes(b"".join(struct.pack("<dd", value.real, value.imag) for value in values))

    def write_artifacts(self) -> None:
        self.potential_path = self.mode_dir / "potential_full.bin"
        self.field_path = self.mode_dir / "demag_element_full.bin"
        self._write_complex(self.potential_path, self.phi)
        self._write_complex(self.field_path, self.field)
        self.manifest_path.write_text(json.dumps(self._manifest(), indent=2), encoding="utf-8")

    def _manifest(self) -> dict[str, object]:
        def digest(path: Path) -> str:
            return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()

        return {
            "schema_version": "fem_modal_physical_potential.v1",
            "representation": "full_physical_phasor",
            "phasor_convention": "exp(+i*omega*t)",
            "potential": {
                "path": "eigen/mode_fields/sample_0000/mode_0000/potential_full.bin",
                "dtype": "float64",
                "byte_order": "little",
                "layout": "node_major_real_imag",
                "association": "source_mesh_nodes",
                "count": len(self.nodes),
                "unit": "A",
                "sha256": digest(self.potential_path),
            },
            "demag_field": {
                "path": "eigen/mode_fields/sample_0000/mode_0000/demag_element_full.bin",
                "dtype": "float64",
                "byte_order": "little",
                "layout": "element_major_xyz_real_imag",
                "association": "source_mesh_tet4_elements",
                "count": len(self.elements),
                "unit": "A/m",
                "reconstruction": "-grad(phi_full)",
                "recovery": "none",
                "sha256": digest(self.field_path),
            },
        }

    def validate(self) -> dict[str, object]:
        return validate_physical_potential(self.manifest_path, self.metadata_path)

    def set_linear_field(
        self,
        nodes: list[list[float]],
        constant: complex,
        coefficients: tuple[complex, complex, complex],
    ) -> None:
        self.nodes = nodes
        self.phi = [
            constant
            + coefficients[0] * node[0]
            + coefficients[1] * node[1]
            + coefficients[2] * node[2]
            for node in nodes
        ]
        self.field = [-coefficient for coefficient in coefficients]
        self._write_metadata()
        self.write_artifacts()


class PhysicalPotentialValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.fixture = PhysicalPotentialFixture(Path(self.tempdir.name))

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def bound_fixture(self):
        manifest = json.loads(self.fixture.manifest_path.read_text())
        identities = {key: "sha256:" + char * 64 for key, char in (
            ("source_mesh_topology_sha256", "a"),
            ("operator_input_signature_sha256", "b"),
            ("phase_constraint_sha256", "c"))}
        manifest.update(sample_index=0, mode_index=0, **identities)
        self.fixture.manifest_path.write_text(json.dumps(manifest))
        mode_path = self.fixture.root / "eigen/modes/sample_0000/mode_0000.json"
        mode_path.parent.mkdir(parents=True, exist_ok=True)
        mode_path.write_text(json.dumps({"sample_index": 0, "raw_mode_index": 0, **identities}))
        return mode_path

    def topology_bound_fixture(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/fullmag-py/src"))
        from fullmag.meshing._gmsh_types import MeshData
        mesh = MeshData.from_legacy_tet4(
            nodes=self.fixture.nodes, elements=self.fixture.elements,
            element_markers=[1], boundary_faces=[], boundary_markers=[])
        metadata = json.loads(self.fixture.metadata_path.read_text())
        metadata["execution_plan"]["backend_plan"]["mesh"] = mesh.to_ir("fixture")
        self.fixture.metadata_path.write_text(json.dumps(metadata))
        manifest = json.loads(self.fixture.manifest_path.read_text())
        manifest["source_mesh_topology_sha256"] = mesh.topology_fingerprint_v3()
        self.fixture.manifest_path.write_text(json.dumps(manifest))

    def test_source_mesh_fingerprint_is_recomputed(self):
        self.topology_bound_fixture()
        result = validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                             verify_source_mesh=True)
        self.assertEqual(result["source_mesh_binding"]["status"], "consistent")
        self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_correct_gradient_on_different_mesh_cannot_pass_topology_binding(self):
        self.topology_bound_fixture()
        metadata = json.loads(self.fixture.metadata_path.read_text())
        metadata["execution_plan"]["backend_plan"]["mesh"]["element_markers"] = [2]
        self.fixture.metadata_path.write_text(json.dumps(metadata))
        # The gradient does not observe material markers; topology identity must.
        self.assertTrue(self.fixture.validate()["reconstruction_agreement"])
        with self.assertRaisesRegex(ValidationError, "source mesh topology"):
            validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                        verify_source_mesh=True)

    def test_recomputed_topology_rejects_missing_facets_and_boolean_indices(self):
        for corrupt in ("facets", "boolean_index"):
            self.topology_bound_fixture()
            metadata = json.loads(self.fixture.metadata_path.read_text())
            mesh = metadata["execution_plan"]["backend_plan"]["mesh"]
            if corrupt == "facets": del mesh["facets"]
            else: mesh["cells"]["global_ordinals"] = [True]
            self.fixture.metadata_path.write_text(json.dumps(metadata))
            with self.subTest(corrupt=corrupt), self.assertRaises(ValidationError):
                validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                            verify_source_mesh=True)

    def test_declared_mode_binding_is_verified_separately(self):
        mode = self.bound_fixture()
        result = validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                             mode_metadata_path=mode)
        self.assertEqual(result["identity_binding"]["status"], "consistent")
        self.assertEqual(result["qualification"], "NOT VERIFIED")

    def test_wrong_mode_provenance_cannot_pass_gradient_check(self):
        for key in ("sample_index", "raw_mode_index", "source_mesh_topology_sha256",
                    "operator_input_signature_sha256", "phase_constraint_sha256"):
            with self.subTest(key=key):
                mode = self.bound_fixture()
                data = json.loads(mode.read_text())
                data[key] = 1 if key in ("sample_index", "raw_mode_index") else "sha256:" + "f" * 64
                mode.write_text(json.dumps(data))
                with self.assertRaises(ValidationError):
                    validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                                 mode_metadata_path=mode)

    def test_corrupt_or_missing_declared_identity_is_rejected(self):
        for value in (None, True, -1, "0"):
            mode = self.bound_fixture()
            manifest = json.loads(self.fixture.manifest_path.read_text())
            manifest["sample_index"] = value
            self.fixture.manifest_path.write_text(json.dumps(manifest))
            with self.assertRaises(ValidationError):
                validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                             mode_metadata_path=mode)

    def test_bound_sidecars_cannot_reference_another_mode(self):
        mode = self.bound_fixture()
        alternate = self.fixture.mode_dir / "other_potential.bin"
        alternate.write_bytes(self.fixture.potential_path.read_bytes())
        manifest = json.loads(self.fixture.manifest_path.read_text())
        manifest["potential"]["path"] = alternate.relative_to(self.fixture.root).as_posix()
        self.fixture.manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValidationError, "sidecar path"):
            validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                         mode_metadata_path=mode)

    def test_bound_mode_cannot_be_relocated_to_another_directory(self):
        mode = self.bound_fixture()
        alternate = self.fixture.root / "relocated-mode.json"
        alternate.write_bytes(mode.read_bytes())
        with self.assertRaisesRegex(ValidationError, "mode metadata path"):
            validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                         mode_metadata_path=alternate)

    def test_duplicate_json_identity_is_rejected(self):
        mode = self.bound_fixture()
        text = mode.read_text()
        mode.write_text('{"sample_index":1,' + text[1:])
        with self.assertRaisesRegex(ValidationError, "duplicate"):
            validate_physical_potential(self.fixture.manifest_path, self.fixture.metadata_path,
                                         mode_metadata_path=mode)

    def test_independent_linear_complex_potential_agrees(self) -> None:
        report = self.fixture.validate()
        self.assertEqual(report["status"], "consistent")
        self.assertTrue(report["reconstruction_agreement"])
        self.assertEqual(report["qualification"], "NOT VERIFIED")
        self.assertEqual(report["comparison"]["mismatch_count"], 0)

    def test_changed_field_sign_is_reported_as_mismatch(self) -> None:
        self.fixture._write_complex(self.fixture.field_path, [-value for value in self.fixture.field])
        self.fixture.manifest_path.write_text(json.dumps(self.fixture._manifest(), indent=2), encoding="utf-8")
        report = self.fixture.validate()
        self.assertEqual(report["status"], "mismatch")
        self.assertFalse(report["reconstruction_agreement"])
        self.assertGreater(report["comparison"]["mismatch_count"], 0)
        self.assertEqual(report["qualification"], "NOT VERIFIED")

    def test_binary_size_mismatch_is_rejected(self) -> None:
        self.fixture.potential_path.write_bytes(self.fixture.potential_path.read_bytes()[:-1])
        self.fixture.manifest_path.write_text(json.dumps(self.fixture._manifest(), indent=2), encoding="utf-8")
        with self.assertRaises(ValidationError):
            self.fixture.validate()

    def test_non_finite_potential_is_rejected(self) -> None:
        values = list(self.fixture.phi)
        values[2] = complex(float("nan"), values[2].imag)
        self.fixture._write_complex(self.fixture.potential_path, values)
        self.fixture.manifest_path.write_text(json.dumps(self.fixture._manifest(), indent=2), encoding="utf-8")
        with self.assertRaises(ValidationError):
            self.fixture.validate()

    def test_degenerate_tet4_is_rejected(self) -> None:
        self.fixture.nodes[3] = [0.0, 1.0, 0.0]
        self.fixture._write_metadata()
        with self.assertRaises(ValidationError):
            self.fixture.validate()

    def test_skew_tet_in_nanometres_preserves_gradient_scale_and_orientation(self) -> None:
        self.fixture.set_linear_field(
            [
                [0.0, 0.0, 0.0],
                [2.0e-9, 1.0e-9, 0.0],
                [0.5e-9, 3.0e-9, 0.4e-9],
                [0.2e-9, 0.8e-9, 4.0e-9],
            ],
            complex(0.7, -0.2),
            (complex(1.2e8, -0.5e8), complex(-2.4e8, 0.75e8), complex(0.6e8, 1.8e8)),
        )
        report = self.fixture.validate()
        self.assertEqual(report["status"], "consistent")
        self.assertLessEqual(report["comparison"]["max_normalized_error"], 1.0e-12)

    def test_constant_nonzero_potential_has_zero_field(self) -> None:
        self.fixture.set_linear_field(
            self.fixture.nodes,
            complex(5.0, -3.0),
            (0j, 0j, 0j),
        )
        report = self.fixture.validate()
        self.assertEqual(report["status"], "consistent")
        self.assertEqual(report["comparison"]["max_absolute_error"], 0.0)

    def test_near_zero_p1_component_uses_forward_roundoff_bound(self) -> None:
        # The tangential gradient of this airbox-face Tet4 is obtained by
        # cancelling shape-gradient terms of order 1e8.  A separately
        # evaluated producer can therefore differ by a few ulps even when
        # the stored field is the exact gradient of an affine potential.
        self.fixture.nodes = [
            [7.487890384e-09, 7.25477277e-09, 1.976634752e-06],
            [7.487890384e-09, 7.25477277e-09, 2.005e-06],
            [8.660254038e-09, 2.5e-09, 2.005e-06],
            [1.1698254483e-08, 4.957476082e-09, 2.005e-06],
        ]
        self.fixture.elements = [[0, 1, 2, 3]]
        constant = complex(-3.177689136536224, -1.6442226039687564)
        coefficients = (0j, 0j, complex(1.2e8, -6.0e7))
        self.fixture.phi = [
            constant + sum(coefficient * coordinate for coefficient, coordinate in zip(coefficients, node))
            for node in self.fixture.nodes
        ]
        # For phi = c0 + cx*x + cy*y + cz*z, the exact Tet4 field is -c.
        self.fixture.field = [-coefficient for coefficient in coefficients]
        self.fixture._write_metadata()
        self.fixture.write_artifacts()

        report = self.fixture.validate()
        self.assertEqual(report["status"], "consistent")
        self.assertEqual(report["comparison"]["mismatch_count"], 0)
        self.assertGreater(report["comparison"]["max_forward_error_bound"], 0.0)
        self.assertLessEqual(
            report["comparison"]["max_absolute_error"],
            report["comparison"]["max_forward_error_bound"] + 1.0e-10,
        )

        # A 1e-2 A/m perturbation is far outside the local roundoff envelope
        # while remaining tiny compared with the physical z component.
        self.fixture.field[0] += complex(1.0e-2, 0.0)
        self.fixture.write_artifacts()
        report = self.fixture.validate()
        self.assertEqual(report["status"], "mismatch")
        self.assertGreater(report["comparison"]["mismatch_count"], 0)
        first = report["comparison"]["first_mismatch"]
        self.assertGreater(first["absolute_error"], first["forward_error_bound"] + 1.0e-10)

    def test_manifest_path_traversal_is_rejected(self) -> None:
        manifest = self.fixture._manifest()
        manifest["potential"]["path"] = "../potential_full.bin"
        self.fixture.manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        with self.assertRaises(ValidationError):
            self.fixture.validate()

    def test_artifacts_from_a_different_run_root_are_rejected(self) -> None:
        wrong_root = Path(self.tempdir.name) / "other-run"
        wrong_root.mkdir()
        wrong_metadata = wrong_root / "metadata.json"
        wrong_metadata.write_text(self.fixture.metadata_path.read_text(encoding="utf-8"), encoding="utf-8")
        with self.assertRaises(ValidationError):
            validate_physical_potential(self.fixture.manifest_path, wrong_metadata)

    def test_unsupported_cell_type_is_rejected(self) -> None:
        metadata = {
            "execution_plan": {
                "backend_plan": {
                    "kind": "fem_eigen",
                    "mesh": {
                        "nodes": self.fixture.nodes,
                        "cells": {"types": ["prism6"], "offsets": [0, 6], "nodes": [0, 1, 2, 3, 0, 1]},
                    }
                }
            }
        }
        self.fixture.metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        with self.assertRaises(ValidationError):
            self.fixture.validate()


if __name__ == "__main__":
    unittest.main()
