"""Focused API source contracts; does not execute or compile the Rust handlers."""
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "crates/fullmag-api/src/router_v2/handlers/data/antenna.rs"


def function(source, name):
    start = source.index(f"fn {name}(")
    return source[start:source.index("\n}", start) + 2]


class AntennaQuadratureApiSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SOURCE.read_text(encoding="utf-8")

    def test_metadata_and_binary_paths_share_gate_before_response(self):
        for name in ("get_antenna_field_solution", "get_antenna_field_solution_payload"):
            body = function(self.source, name)
            self.assertIn("read_field_solution_manifest(", body)
            self.assertIn("serde_json::from_slice(&manifest_bytes)", body)
            self.assertIn("validate_field_solution_payloads(", body)
            self.assertIn("&manifest_bytes", body)
            self.assertLess(body.index("validate_field_solution_payloads("),
                            body.index("conditional_"))
            self.assertNotIn("serde_json::to_vec(&manifest)", body)

    def test_selected_payload_is_the_same_verified_bytes(self):
        body = function(self.source, "get_antenna_field_solution_payload")
        self.assertIn("let payloads = validate_field_solution_payloads(", body)
        self.assertIn("payloads.into_iter().find(", body)
        self.assertIn("payload.relative_path == reference.path", body)
        self.assertNotIn("std::fs::read", body)
        self.assertNotIn("try_resolve_artifact_path", body)

    def test_full_referenced_asset_includes_mixed_evidence_and_canonical_gate(self):
        body = function(self.source, "validate_field_solution_payloads")
        for token in ("&manifest.conductor_positions", "&manifest.sample_positions",
                      "&manifest.sample_topology", "&manifest.bases",
                      "&basis.electric_potential_per_ampere", "&basis.current_density_per_ampere",
                      "&basis.magnetic_field_per_ampere", "&basis.quadrature_evidence",
                      "reference.target_count.checked_mul(96)", "checked_add(288)",
                      "QUADRATURE_EVIDENCE_LIMIT", "read_bounded_field_solution_file(",
                      "verify_antenna_field_solution_referenced_data(manifest_bytes, &payloads)"):
            self.assertIn(token, body)
        self.assertLess(body.index("register_field_solution_payload("), body.index("for (path, length)"))
        self.assertNotIn("verify_antenna_binary_payload(", body)

    def test_bounded_reader_and_registration_refuse_aliases_sizes_and_duplicates(self):
        reader = function(self.source, "read_bounded_field_solution_file")
        for token in ("sanitize_artifact_relative_path", "canonicalize(artifact_dir)",
                      "symlink_metadata", "metadata.file_type().is_symlink()",
                      "std::fs::canonicalize(&resolved)? != resolved", "!resolved.starts_with(&root)",
                      "usize::try_from(metadata.len())", "length > limit",
                      "expected_length.is_some_and", "try_reserve_exact(length)",
                      "checked_add(1)", ".take(read_limit)", "bytes.len() != length",
                      "file.metadata()?.len() != length as u64"):
            self.assertIn(token, reader)
        start = self.source.index("fn register_field_solution_payload<'a>(")
        registration = self.source[start:self.source.index("\n}", start) + 2]
        for token in ("!path.starts_with(prefix)", "sanitize_artifact_relative_path(path)",
                      "lengths.insert(path, length).is_some()", "checked_add(length)",
                      "FIELD_SOLUTION_PAYLOAD_LIMIT"):
            self.assertIn(token, registration)
        self.assertLess(reader.index("length > limit"), reader.index("try_reserve_exact"))

    def test_resource_reference_is_thin(self):
        start = self.source.index("pub struct AntennaQuadratureEvidenceRefResource {")
        reference = self.source[start:self.source.index("\n}", start)]
        for token in ("schema_version: String", "path: String", "sha256: String",
                      "byte_length: usize", "target_count: usize"):
            self.assertIn(token, reference)
        self.assertNotIn("Vec", reference)
        self.assertIn("pub quadrature_evidence: Option<AntennaQuadratureEvidenceRefResource>", self.source)
        self.assertIn("pub oersted_operator_version: Option<String>", self.source)


if __name__ == "__main__":
    unittest.main()
