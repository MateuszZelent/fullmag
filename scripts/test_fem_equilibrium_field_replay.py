"""Focused interpreted regression for the independent FEM field replay."""

from __future__ import annotations

import copy
from pathlib import Path
import sys
import json
import unittest


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from fem_equilibrium_field_replay import (  # noqa: E402
    CERTIFICATE_DIGEST_STATUS_UNVERIFIED,
    ValidationError,
    certified_field_content_sha256,
    calculate_field_differences,
    replay_accepted_recomputed_fields,
    validate_certified_equilibrium_fields,
)


def _field_fixture(version: str) -> dict[str, object]:
    fields: dict[str, object] = {
        "schema_version": f"CertifiedFemEquilibriumFields.{version}",
        "h_ex_a_per_m": [[1.0, 0.0, 0.0]],
        "h_demag_a_per_m": [[2.0, 0.0, 0.0]],
        "h_ext_a_per_m": [[8.0, 0.0, 0.0]],
        "h_eff_a_per_m": [[11.0, 0.0, 0.0]],
        "phi_a": [0.0],
    }
    if version == "v2":
        fields["h_anisotropy_a_per_m"] = [[4.0, 0.0, 0.0]]
        fields["h_eff_a_per_m"] = [[15.0, 0.0, 0.0]]
    # The module owns the digest implementation; this fixture's expected
    # values are frozen independently against crates/fullmag-runner/src/types.rs.
    fields["content_sha256"] = "sha256:" + "0" * 64
    fields["content_sha256"] = certified_field_content_sha256(fields, 1, "fixture")
    return fields


def _certificate_fixture(
    accepted: dict[str, object], recomputed: dict[str, object]
) -> dict[str, object]:
    import fem_equilibrium_field_replay as replay

    differences = calculate_field_differences(accepted, recomputed, 1)
    is_v2 = accepted["schema_version"] == "CertifiedFemEquilibriumFields.v2"
    certificate: dict[str, object] = {
        "schema_version": "RecomputedFemLinearizationCertificate.v2" if is_v2 else "RecomputedFemLinearizationCertificate.v1",
        "status": "matched",
        "recompute_provider": "native_fem_final_state_refresh.v2" if is_v2 else "native_fem_final_state_refresh.v1",
        "node_count": 1,
        "equilibrium_content_sha256": "sha256:" + "a" * 64,
        "mesh_topology_sha256": "sha256:" + "b" * 64,
        "equilibrium_material_signature": "sha256:" + "c" * 64,
        "equilibrium_static_physics_signature": "sha256:" + "d" * 64,
        "equilibrium_boundary_signature": "sha256:" + "e" * 64,
        "accepted_fields_content_sha256": accepted["content_sha256"],
        "recomputed_fields_content_sha256": recomputed["content_sha256"],
        "max_h_ex_difference_a_per_m": differences["max_h_ex_difference_a_per_m"],
        "max_h_demag_difference_a_per_m": differences["max_h_demag_difference_a_per_m"],
        "max_h_ext_difference_a_per_m": differences["max_h_ext_difference_a_per_m"],
        "max_h_eff_difference_a_per_m": differences["max_h_eff_difference_a_per_m"],
        "max_phi_difference_a": differences["max_phi_difference_a"],
        "field_absolute_tolerance_a_per_m": replay.FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
        "field_relative_tolerance": replay.FIELD_RELATIVE_TOLERANCE,
        "phi_absolute_tolerance_a": replay.PHI_ABSOLUTE_TOLERANCE_A,
        "content_sha256": "sha256:" + "f" * 64,
    }
    if is_v2:
        certificate["max_h_anisotropy_difference_a_per_m"] = differences[
            "max_h_anisotropy_difference_a_per_m"
        ]
    return certificate


class FemEquilibriumFieldReplayTests(unittest.TestCase):
    def test_frozen_v1_and_v2_binary_field_digests_match_rust(self) -> None:
        v1 = _field_fixture("v1")
        v2 = _field_fixture("v2")
        self.assertEqual(
            v1["content_sha256"],
            "sha256:534a654a6ca21daff11b59fc99026f02ab3f02f3f341bec6c8ead73df73fe730",
        )
        self.assertEqual(
            v2["content_sha256"],
            "sha256:3b4b095aa8a9ed90102425a27ed8cceab494f88816dbd4f5101d14883d278a54",
        )
        validate_certified_equilibrium_fields(v1, 1)
        validate_certified_equilibrium_fields(v2, 1)

    def test_replay_v1_reports_unverified_certificate_json_digest(self) -> None:
        accepted = _field_fixture("v1")
        recomputed = copy.deepcopy(accepted)
        certificate = _certificate_fixture(accepted, recomputed)
        result = replay_accepted_recomputed_fields(
            accepted, recomputed, certificate, node_count=1
        )
        self.assertTrue(result.field_replay_verified)
        self.assertTrue(result.field_content_digests_verified)
        self.assertEqual(
            result.certificate_content_digest_status,
            CERTIFICATE_DIGEST_STATUS_UNVERIFIED,
        )
        self.assertTrue(any("exact Rust serde_json preimage" in item for item in result.limitations))

    def test_replay_v2_compares_anisotropy_and_recorded_difference(self) -> None:
        accepted = _field_fixture("v2")
        recomputed = copy.deepcopy(accepted)
        recomputed["h_anisotropy_a_per_m"] = [[4.0 + 1.0e-10, 0.0, 0.0]]
        recomputed["h_eff_a_per_m"] = [[15.0 + 1.0e-10, 0.0, 0.0]]
        import fem_equilibrium_field_replay as replay

        recomputed["content_sha256"] = certified_field_content_sha256(recomputed, 1, "fixture")
        certificate = _certificate_fixture(accepted, recomputed)
        result = replay_accepted_recomputed_fields(
            accepted, recomputed, certificate, node_count=1
        )
        self.assertIn("max_h_anisotropy_difference_a_per_m", result.differences)
        self.assertGreater(result.differences["max_h_anisotropy_difference_a_per_m"], 0.0)

    def test_rejects_strict_field_mutations(self) -> None:
        baseline = _field_fixture("v2")
        mutations = {
            "unknown": lambda value: value.update({"unexpected": 1}),
            "missing_anisotropy": lambda value: value.pop("h_anisotropy_a_per_m"),
            "explicit_null": lambda value: value.__setitem__("h_anisotropy_a_per_m", None),
            "boolean_component": lambda value: value["h_anisotropy_a_per_m"][0].__setitem__(0, True),
            "forged_decomposition": lambda value: value["h_eff_a_per_m"][0].__setitem__(0, 16.0),
            "wrong_digest": lambda value: value.__setitem__("content_sha256", "sha256:" + "0" * 64),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                candidate = copy.deepcopy(baseline)
                mutate(candidate)
                with self.assertRaises(ValidationError):
                    validate_certified_equilibrium_fields(candidate, 1)

    def test_rejects_certificate_difference_or_tolerance_mutation(self) -> None:
        accepted = _field_fixture("v1")
        recomputed = copy.deepcopy(accepted)
        certificate = _certificate_fixture(accepted, recomputed)
        for name, mutate in (
            ("recorded_difference", lambda value: value.__setitem__("max_h_eff_difference_a_per_m", 1.0)),
            ("field_tolerance", lambda value: value.__setitem__("field_relative_tolerance", 1.0)),
            ("certificate_digest_link", lambda value: value.__setitem__("accepted_fields_content_sha256", "sha256:" + "0" * 64)),
        ):
            with self.subTest(name=name):
                candidate = copy.deepcopy(certificate)
                mutate(candidate)
                with self.assertRaises(ValidationError):
                    replay_accepted_recomputed_fields(
                        accepted, recomputed, candidate, node_count=1
                    )

    def test_exact_certificate_preimage_can_close_json_digest_gate(self) -> None:
        accepted = _field_fixture("v1")
        recomputed = copy.deepcopy(accepted)
        certificate = _certificate_fixture(accepted, recomputed)
        certificate_without_digest = copy.deepcopy(certificate)
        certificate_without_digest["content_sha256"] = ""
        # This is synthetic exact-preimage evidence passed directly to the
        # API; it does not claim Python JSON formatting is Rust serde output.
        preimage = json.dumps(certificate_without_digest, separators=(",", ":")).encode(
            "utf-8"
        )
        import fem_equilibrium_field_replay as replay

        certificate["content_sha256"] = replay.certificate_sha256_from_exact_preimage(
            "RecomputedFemLinearizationCertificate.v1", preimage
        )
        result = replay_accepted_recomputed_fields(
            accepted,
            recomputed,
            certificate,
            node_count=1,
            certificate_preimage=preimage,
        )
        self.assertEqual(result.certificate_content_digest_status, "verified_exact_preimage")
        self.assertFalse(any("serde_json preimage" in item for item in result.limitations))

        mutated_certificate = copy.deepcopy(certificate)
        mutated_certificate["mesh_topology_sha256"] = "sha256:" + "0" * 64
        with self.assertRaises(ValidationError):
            replay_accepted_recomputed_fields(
                accepted,
                recomputed,
                mutated_certificate,
                node_count=1,
                certificate_preimage=preimage,
            )

    def test_exact_preimage_rejects_rust_incompatible_numeric_types(self) -> None:
        accepted = _field_fixture("v1")
        recomputed = copy.deepcopy(accepted)
        certificate = _certificate_fixture(accepted, recomputed)
        certificate_without_digest = copy.deepcopy(certificate)
        certificate_without_digest["content_sha256"] = ""
        import fem_equilibrium_field_replay as replay

        for name, mutate in (
            ("node_count_bool", lambda value: value.__setitem__("node_count", True)),
            ("node_count_float", lambda value: value.__setitem__("node_count", 1.0)),
            ("text_bool", lambda value: value.__setitem__("status", True)),
            (
                "max_difference_bool",
                lambda value: value.__setitem__("max_h_eff_difference_a_per_m", False),
            ),
            (
                "tolerance_bool",
                lambda value: value.__setitem__("field_relative_tolerance", False),
            ),
        ):
            with self.subTest(name=name):
                malformed_preimage_value = copy.deepcopy(certificate_without_digest)
                mutate(malformed_preimage_value)
                preimage = json.dumps(
                    malformed_preimage_value, separators=(",", ":")
                ).encode("utf-8")
                candidate = copy.deepcopy(certificate)
                candidate["content_sha256"] = replay.certificate_sha256_from_exact_preimage(
                    "RecomputedFemLinearizationCertificate.v1", preimage
                )
                with self.assertRaises(ValidationError):
                    replay_accepted_recomputed_fields(
                        accepted,
                        recomputed,
                        candidate,
                        node_count=1,
                        certificate_preimage=preimage,
                    )

    def test_exact_preimage_rejects_duplicate_json_keys(self) -> None:
        accepted = _field_fixture("v1")
        recomputed = copy.deepcopy(accepted)
        certificate = _certificate_fixture(accepted, recomputed)
        certificate_without_digest = copy.deepcopy(certificate)
        certificate_without_digest["content_sha256"] = ""
        valid_preimage = json.dumps(
            certificate_without_digest, separators=(",", ":")
        )
        duplicate_preimage = valid_preimage.replace(
            '"status":"matched"', '"status":"matched","status":"matched"', 1
        ).encode("utf-8")
        import fem_equilibrium_field_replay as replay

        candidate = copy.deepcopy(certificate)
        candidate["content_sha256"] = replay.certificate_sha256_from_exact_preimage(
            "RecomputedFemLinearizationCertificate.v1", duplicate_preimage
        )
        with self.assertRaisesRegex(ValidationError, "duplicate key"):
            replay_accepted_recomputed_fields(
                accepted,
                recomputed,
                candidate,
                node_count=1,
                certificate_preimage=duplicate_preimage,
            )


if __name__ == "__main__":
    unittest.main()
