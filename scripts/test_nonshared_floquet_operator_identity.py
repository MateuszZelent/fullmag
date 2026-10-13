#!/usr/bin/env python3
"""Source-only regression for the non-shared Floquet identity wiring.

This check deliberately does not recreate Rust's digest in Python.  The Rust
implementation uses the repository's framed ``shared_domain_content_digest``
contract, so a local ``json.dumps`` mirror would be a false cross-language
proof.  The test only verifies that the source retains the exact preimage,
binds the same identity to input and artifact diagnostics, and fails closed
when the producer mesh payload is absent.  Native/runtime compatibility stays
NOT VERIFIED until the prepared Rust regression and managed runtime execute.
"""

from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
DOMAIN = ROOT / "crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs"
WINDOW = ROOT / "crates/fullmag-runner/src/fem/eigen_native_window.rs"
ARTIFACTS = ROOT / "crates/fullmag-runner/src/fem/eigen_native_artifacts.rs"
OUTPUT = ROOT / "crates/fullmag-runner/src/fem/eigen_output.rs"
NOTE = ROOT / "docs/physics/r4-nonshared-floquet-operator-provenance.md"
SOURCE_MAP = ROOT / "docs/physics/r4-nonshared-floquet-operator-provenance.source-map.json"


class NonSharedFloquetOperatorIdentitySourceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.domain = DOMAIN.read_text(encoding="utf-8")
        cls.window = WINDOW.read_text(encoding="utf-8")
        cls.artifacts = ARTIFACTS.read_text(encoding="utf-8")
        cls.output = OUTPUT.read_text(encoding="utf-8")
        cls.note = NOTE.read_text(encoding="utf-8")
        cls.source_map = SOURCE_MAP.read_text(encoding="utf-8")

    def test_rust_uses_framed_digest_and_keeps_exact_preimage(self) -> None:
        self.assertIn(
            'shared_domain_content_digest("nonshared_floquet_operator_input"',
            self.domain,
        )
        self.assertIn("operator_identity_preimage_json", self.domain)
        self.assertIn("raw_sha256(&self.operator_identity_preimage_json)", self.domain)
        self.assertNotIn("json.dumps", self.domain)

    def test_same_identity_digest_is_wired_to_input_and_artifact_boundaries(self) -> None:
        self.assertIn('"nonshared_floquet_operator_identity_sha256": self.operator_identity_sha256', self.domain)
        self.assertIn("provenance.native_input_diagnostics()", self.window)
        self.assertIn("provenance.artifact_diagnostics()", self.window)
        self.assertIn("nonshared_floquet_operator_identity_sha256", self.artifacts)

    def test_complex_embedding_keeps_field_units_and_native_gyrotropic_block(self) -> None:
        self.assertIn("let stiffness = payload.stiffness;", self.window)
        self.assertIn('"stiffness_omega_units": "rad_s_inv"', self.window)
        self.assertIn("&payload.gyrotropic_row_major", self.window)
        self.assertIn('"complex_bloch_real_embedding"', self.domain)
        self.assertNotIn("let stiffness = payload.stiffness * plan.gyromagnetic_ratio;", self.window)

    def test_missing_source_mesh_is_explicitly_not_verified(self) -> None:
        self.assertIn('"consumer_plan_mesh_only"', self.domain)
        self.assertIn('"NOT_VERIFIED_producer_payload_not_published"', self.domain)
        self.assertIn('"source_mesh_payload_status"', self.domain)
        self.assertIn("source_field_lengths_verified", self.domain)
        self.assertIn("source_field_origins_verified", self.domain)
        self.assertIn("producer_mesh_node_count", self.domain)
        self.assertIn("source_replay_qualified = source_replay_available", self.domain)
        self.assertIn('"source_replay_status": source_replay_status', self.domain)
        self.assertIn('"source_mesh_payload_status": source_replay_status', self.domain)
        self.assertIn('"NOT_VERIFIED_source_field_length"', self.domain)

    def test_full_replay_publishes_exact_operator_and_source_preimages(self) -> None:
        self.assertIn("NONSHARED_FLOQUET_EXACT_REPLAY_REFS_SCHEMA", self.domain)
        self.assertIn("exact_replay_refs", self.domain)
        self.assertIn("exact_replay_sidecars", self.domain)
        self.assertIn("nonshared_floquet_source_state_preimage.v1.json", self.domain)
        self.assertIn("nonshared_floquet_operator_input_preimage.v1.json", self.domain)
        self.assertIn("nonshared_floquet_matrix_pencil_preimage.v1.json", self.domain)
        for name in (
            "equilibrium_material_preimage.v1.json",
            "equilibrium_static_physics_preimage.v1.json",
            "equilibrium_boundary_preimage.v1.json",
            "material_provenance_preimage.v1.json",
        ):
            self.assertIn(name, self.domain)
        self.assertIn("exact_json_preimage_bytes", self.domain)
        self.assertIn("exact_preimage_ref", self.domain)
        self.assertIn("exact_preimage_ref_with_namespace", self.domain)
        self.assertIn('"semantic_namespace"', self.domain)
        for namespace in (
            "EquilibriumMaterialSignaturePreimage.v1",
            "EquilibriumStaticPhysicsSignaturePreimage.v1",
            "EquilibriumBoundarySignaturePreimage.v1",
            '"material_signature".to_string()',
        ):
            self.assertIn(namespace, self.domain)
        self.assertIn("operator_input_digest_preimage_mismatch", self.domain)
        self.assertIn("matrix_pencil_digest_preimage_mismatch", self.domain)
        self.assertIn(".chain(self.exact_replay_sidecars.clone())", self.domain)
        self.assertIn("for sidecar in &provenance.sidecars", self.artifacts)

    def test_physical_preimages_are_taken_only_from_verified_replay(self) -> None:
        self.assertIn(
            "source_relax_handoff.and_then(|handoff| handoff.verified_replay())",
            self.domain,
        )
        self.assertIn("let physical_source_preimages = if let Some(replay)", self.domain)
        self.assertIn("replay.equilibrium_material_preimage_json", self.domain)
        self.assertIn("replay.equilibrium_static_physics_preimage_json", self.domain)
        self.assertIn("replay.equilibrium_boundary_preimage_json", self.domain)
        self.assertIn("replay.material_provenance_preimage_json", self.domain)
        self.assertIn("Value::Null", self.domain)

    def test_verified_producer_plan_snapshot_is_the_mesh_source(self) -> None:
        self.assertIn("producer_provenance.producer_plan_snapshot", self.domain)
        self.assertIn("producer_plan_snapshot_decode_failed", self.domain)
        self.assertIn("FemMeshPayload::from(&source_plan)", self.domain)
        self.assertIn("producer_plan_snapshot.v1.json", self.domain)
        self.assertIn("source_mesh.json", self.domain)
        self.assertIn("snapshot.raw_sha256", self.domain)
        self.assertIn("snapshot.framed_sha256", self.domain)

    def test_execution_migration_has_explicit_provenance_variant(self) -> None:
        self.assertIn(
            "runner_operator\n        .filter(|_|",
            self.window,
        )
        self.assertIn(
            "fullmag_ir::SpinWaveBoundaryKindIR::Floquet",
            self.window,
        )
        self.assertIn(
            "nonshared_floquet_provenance_requires_floquet_boundary",
            self.window,
        )
        self.assertIn(
            "nonshared_floquet_provenance_requires_floquet_boundary",
            self.domain,
        )
        self.assertIn("build_nonshared_floquet_provenance_from_complex", self.window)
        self.assertIn(
            "execute_native_cpu_modal_window_from_bloch_floquet_complex_with_provenance",
            self.window,
        )
        self.assertIn("Option<NonSharedFloquetProvenance>", self.window)

    def test_non_floquet_runner_lanes_do_not_publish_floquet_identity(self) -> None:
        self.assertIn(
            "real non-Floquet lanes",
            self.window,
        )
        self.assertIn(
            "their solver path remains valid",
            self.window,
        )
        self.assertIn(
            "nie otrzymują etykiety ani sidecarów Floqueta",
            self.note,
        )

    def test_native_digest_boundary_is_fail_closed_and_keeps_two_digests(self) -> None:
        self.assertIn("native_solver_diagnostics_json_with_expected_digest", self.window)
        self.assertIn("validate_native_magnetic_pencil_digests", self.window)
        self.assertIn("required_native_sha256_field", self.window)
        self.assertIn("is_native_sha256_hex", self.window)
        self.assertIn('"linearized_dynamic_pencil_dependency_digest"', self.window)
        self.assertIn('"linearized_dynamic_pencil_digest"', self.window)
        self.assertIn("native magnetic pencil result digest is missing result_json", self.window)
        self.assertIn("diagnostics_pencil != result_pencil", self.window)

    def test_units_and_gyrotropic_block_contract_are_explicit(self) -> None:
        self.assertIn('"stiffness_field_units": "A_per_m_mass_weighted"', self.window)
        self.assertIn('"native_stiffness_input_units": "rad_s_inv"', self.window)
        self.assertIn('"stiffness_units": "rad_s_inv"', self.window)
        self.assertIn("nonzero cross-component block", self.window)
        self.assertIn("diagonal blocks differ", self.window)
        self.assertIn("mass_abs_max", self.window)
        self.assertIn("gyrotropic_matrix_row_major_from_tangent_mass", self.window)

    def test_csv_uses_the_actual_sample_index_for_fields_and_rows(self) -> None:
        self.assertIn("pub(super) fn dispersion_v2_csv(\n    sample_index: usize,", self.output)
        self.assertIn("mode_field_id(sample_index, raw_mode_index)", self.output)
        self.assertIn("mode_field_resource_key(sample_index, raw_mode_index)", self.output)
        self.assertIn('format!("sample-{sample_index:04}/mode-{raw_mode_index:04}")', self.output)
        self.assertIn('"{sample_index},{},', self.output)
        self.assertIn("dispersion_v2_csv(\n                sample_index,", self.artifacts)

    def test_documentation_states_representation_units_and_runtime_boundary(self) -> None:
        for phrase in (
            "G = [[0,M],[-M,0]]",
            "G = [[0,-M_R],[M_R,0]]",
            "R(iG) = [[0,-G],[G,0]]",
            "K_field",
            "K_omega",
            "linearized_dynamic_pencil_dependency_digest",
            "NOT_VERIFIED",
        ):
            self.assertIn(phrase, self.note)
        self.assertIn("eigen_native_window.rs", self.source_map)
        self.assertIn("indeksu próbki CSV", self.source_map)


if __name__ == "__main__":
    unittest.main()
