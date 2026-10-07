"""Interpreted regression for source-bound FEM sidecar replay."""

from __future__ import annotations

import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from fem_accepted_recomputed_replay import (  # noqa: E402
    ArtifactPaths,
    ReplaySourceContext,
    V1_FIELDS_SCHEMA,
    V2_FIELDS_SCHEMA,
    certificate_preimage_from_identity,
    load_json_artifact,
    replay_accepted_recomputed_payloads,
    replay_artifact_paths,
)
from comsol_mesh_identity import mesh_topology_fingerprint_v3  # noqa: E402
from fem_equilibrium_field_replay import (  # noqa: E402
    FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
    FIELD_RELATIVE_TOLERANCE,
    PHI_ABSOLUTE_TOLERANCE_A,
    ValidationError,
    calculate_field_differences,
    certified_field_content_sha256,
    certificate_sha256_from_exact_preimage,
    recomputed_fem_equilibrium_content_sha256,
)


_NODE_COUNT = 4


def _vectors(value: list[float]) -> list[list[float]]:
    return [list(value) for _ in range(_NODE_COUNT)]


def _fields(version: str, *, delta: float = 0.0) -> dict[str, object]:
    is_v2 = version == "v2"
    anisotropy = _vectors([4.0 + delta, 0.0, 0.0]) if is_v2 else None
    h_eff = 15.0 + (delta if is_v2 else 0.0)
    value: dict[str, object] = {
        "schema_version": V2_FIELDS_SCHEMA if is_v2 else V1_FIELDS_SCHEMA,
        "h_ex_a_per_m": _vectors([1.0, 0.0, 0.0]),
        "h_demag_a_per_m": _vectors([2.0, 0.0, 0.0]),
        "h_ext_a_per_m": _vectors([8.0 + delta, 0.0, 0.0]),
        "h_anisotropy_a_per_m": anisotropy,
        "h_eff_a_per_m": _vectors([h_eff + delta, 0.0, 0.0]),
        "phi_a": [delta for _ in range(_NODE_COUNT)],
        "content_sha256": "sha256:" + "0" * 64,
    }
    if not is_v2:
        value["h_eff_a_per_m"] = _vectors([11.0 + delta, 0.0, 0.0])
        value.pop("h_anisotropy_a_per_m")
    value["content_sha256"] = certified_field_content_sha256(value, _NODE_COUNT, "fixture")
    return value


def _certificate(
    accepted: dict[str, object],
    certified: dict[str, object],
    *,
    mesh_digest: str | None = None,
) -> dict[str, object]:
    is_v2 = accepted["schema_version"] == V2_FIELDS_SCHEMA
    differences = calculate_field_differences(accepted, certified, _NODE_COUNT)
    value: dict[str, object] = {
        "schema_version": "RecomputedFemLinearizationCertificate.v2"
        if is_v2
        else "RecomputedFemLinearizationCertificate.v1",
        "status": "matched",
        "recompute_provider": "native_fem_final_state_refresh.v2"
        if is_v2
        else "native_fem_final_state_refresh.v1",
        "node_count": _NODE_COUNT,
        "equilibrium_content_sha256": recomputed_fem_equilibrium_content_sha256(
            _vectors([0.0, 0.0, 1.0])
        ),
        "mesh_topology_sha256": mesh_digest or _mesh_digest(_mesh()),
        "equilibrium_material_signature": "sha256:" + "c" * 64,
        "equilibrium_static_physics_signature": "sha256:" + "d" * 64,
        "equilibrium_boundary_signature": "sha256:" + "e" * 64,
        "accepted_fields_content_sha256": accepted["content_sha256"],
        "recomputed_fields_content_sha256": certified["content_sha256"],
        "max_h_ex_difference_a_per_m": differences["max_h_ex_difference_a_per_m"],
        "max_h_demag_difference_a_per_m": differences["max_h_demag_difference_a_per_m"],
        "max_h_ext_difference_a_per_m": differences["max_h_ext_difference_a_per_m"],
        "max_h_eff_difference_a_per_m": differences["max_h_eff_difference_a_per_m"],
        "max_phi_difference_a": differences["max_phi_difference_a"],
        "field_absolute_tolerance_a_per_m": FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
        "field_relative_tolerance": FIELD_RELATIVE_TOLERANCE,
        "phi_absolute_tolerance_a": PHI_ABSOLUTE_TOLERANCE_A,
        "content_sha256": "sha256:" + "f" * 64,
    }
    if is_v2:
        value["max_h_anisotropy_difference_a_per_m"] = differences[
            "max_h_anisotropy_difference_a_per_m"
        ]
    return value


def _mesh() -> dict[str, object]:
    return {
        "nodes": [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        "cells": {
            "types": ["tet4"],
            "offsets": [0, 4],
            "nodes": [0, 1, 2, 3],
            "global_ordinals": [0],
            "mesh_parts": ["magnetic"],
        },
        "element_markers": [1],
        "facets": {
            "types": ["tri3"],
            "roles": ["exterior"],
            "offsets": [0, 3],
            "nodes": [0, 2, 1],
            "global_ordinals": [0],
        },
        "boundary_markers": [1],
        "periodic_boundary_pairs": [],
        "periodic_node_pairs": [],
    }


def _mesh_digest(mesh: dict[str, object]) -> str:
    return mesh_topology_fingerprint_v3(mesh)


def _source(*, ku: object, mesh: dict[str, object] | bytes | None = None) -> ReplaySourceContext:
    digest = lambda letter: "sha256:" + letter * 64
    source_mesh = _mesh() if mesh is None else mesh
    source_mesh_digest = _mesh_digest(source_mesh) if isinstance(source_mesh, dict) else None
    return ReplaySourceContext(
        node_count=_NODE_COUNT,
        material={"name": "fixture", "uniaxial_anisotropy": ku},
        equilibrium_magnetization=_vectors([0.0, 0.0, 1.0]),
        mesh_topology_sha256=source_mesh_digest,
        equilibrium_material_signature=digest("c"),
        equilibrium_static_physics_signature=digest("d"),
        equilibrium_boundary_signature=digest("e"),
        mesh=source_mesh,
    )


def _with_exact_certificate_preimage(
    certificate: dict[str, object],
) -> tuple[dict[str, object], bytes]:
    preimage_value = copy.deepcopy(certificate)
    preimage_value["content_sha256"] = ""
    preimage = json.dumps(preimage_value, separators=(",", ":")).encode("utf-8")
    bound = copy.deepcopy(certificate)
    bound["content_sha256"] = certificate_sha256_from_exact_preimage(
        bound["schema_version"], preimage
    )
    return bound, preimage


class FemAcceptedRecomputedReplayTests(unittest.TestCase):
    def test_v1_binds_m0_mesh_and_three_identity_signatures_but_missing_preimage_is_pending(
        self,
    ) -> None:
        accepted = _fields("v1")
        certified = _fields("v1", delta=2.5e-9)
        report = replay_accepted_recomputed_payloads(
            accepted,
            certified,
            _certificate(accepted, certified),
            source=_source(ku=None),
        )

        self.assertEqual(report.expected_fields_schema, V1_FIELDS_SCHEMA)
        self.assertTrue(report.field_content_digests_verified)
        self.assertTrue(report.field_replay_verified)
        self.assertTrue(report.m0_binding_verified)
        self.assertTrue(report.mesh_binding_verified)
        self.assertTrue(report.material_binding_verified)
        self.assertTrue(report.static_physics_binding_verified)
        self.assertTrue(report.boundary_binding_verified)
        self.assertEqual(report.identity_scope, "caller_validated_source_signatures")
        self.assertFalse(report.payload_replay_qualified)
        self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")
        self.assertTrue(
            any("exact Rust serde_json preimage" in item for item in report.limitations)
        )

    def test_zero_ku_presence_selects_v2_and_identity_bytes_close_certificate_gate(self) -> None:
        accepted = _fields("v2")
        certified = _fields("v2", delta=2.5e-9)
        certificate, preimage = _with_exact_certificate_preimage(
            _certificate(accepted, certified)
        )
        identity = {
            "recomputed_certificate_preimage_json": preimage.decode("utf-8"),
            "recomputed_certificate_preimage_sha256": "sha256:"
            + hashlib.sha256(preimage).hexdigest(),
        }
        extracted = certificate_preimage_from_identity(identity)
        self.assertEqual(extracted, preimage)

        report = replay_accepted_recomputed_payloads(
            accepted,
            certified,
            certificate,
            source=_source(ku=0.0),
            certificate_preimage=extracted,
        )
        self.assertEqual(report.expected_fields_schema, V2_FIELDS_SCHEMA)
        self.assertIn("max_h_anisotropy_difference_a_per_m", report.differences)
        self.assertEqual(report.certificate_content_digest_status, "verified_exact_preimage")
        self.assertTrue(report.payload_replay_qualified)
        self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")
        self.assertTrue(
            any("caller-validated source digests" in item for item in report.limitations)
        )

    def test_source_family_and_binding_mutations_fail_closed(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        certificate = _certificate(accepted, certified)
        for name, source in (
            ("missing material field", ReplaySourceContext(
                node_count=_NODE_COUNT,
                material={"name": "fixture"},
                equilibrium_magnetization=_vectors([0.0, 0.0, 1.0]),
                mesh_topology_sha256=_mesh_digest(_mesh()),
                equilibrium_material_signature="sha256:" + "c" * 64,
                equilibrium_static_physics_signature="sha256:" + "d" * 64,
                equilibrium_boundary_signature="sha256:" + "e" * 64,
                mesh=_mesh(),
            )),
            ("wrong mesh", ReplaySourceContext(
                node_count=_NODE_COUNT,
                material={"name": "fixture", "uniaxial_anisotropy": None},
                equilibrium_magnetization=_vectors([0.0, 0.0, 1.0]),
                mesh_topology_sha256="sha256:" + "0" * 64,
                equilibrium_material_signature="sha256:" + "c" * 64,
                equilibrium_static_physics_signature="sha256:" + "d" * 64,
                equilibrium_boundary_signature="sha256:" + "e" * 64,
                mesh=_mesh(),
            )),
        ):
            with self.subTest(name=name):
                with self.assertRaises(ValidationError):
                    replay_accepted_recomputed_payloads(
                        accepted, certified, certificate, source=source
                    )

    def test_mesh_mutations_change_v3_fingerprint_and_break_certificate_binding(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        certificate = _certificate(accepted, certified)
        original = _mesh()
        mutations = {
            "node": lambda value: value["nodes"][0].__setitem__(0, 0.25),
            "cell_connectivity": lambda value: value["cells"]["nodes"].__setitem__(0, 1),
            "element_marker": lambda value: value["element_markers"].__setitem__(0, 2),
            "boundary_marker": lambda value: value["boundary_markers"].__setitem__(0, 2),
            "periodic_boundary": lambda value: value["periodic_boundary_pairs"].append(
                {"pair_id": "x", "marker_a": 1, "marker_b": 2}
            ),
            "periodic_node": lambda value: value["periodic_node_pairs"].append(
                {"pair_id": "x", "node_a": 0, "node_b": 1}
            ),
        }
        original_digest = _mesh_digest(original)
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                mutated = copy.deepcopy(original)
                mutate(mutated)
                mutated_digest = _mesh_digest(mutated)
                self.assertNotEqual(mutated_digest, original_digest)
                with self.assertRaises(ValidationError):
                    replay_accepted_recomputed_payloads(
                        accepted,
                        certified,
                        certificate,
                        source=_source(ku=None, mesh=mutated),
                    )

    def test_missing_source_mesh_never_becomes_payload_qualified(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        source = ReplaySourceContext(
            node_count=_NODE_COUNT,
            material={"name": "fixture", "uniaxial_anisotropy": None},
            equilibrium_magnetization=_vectors([0.0, 0.0, 1.0]),
            mesh_topology_sha256=None,
            equilibrium_material_signature="sha256:" + "c" * 64,
            equilibrium_static_physics_signature="sha256:" + "d" * 64,
            equilibrium_boundary_signature="sha256:" + "e" * 64,
        )
        report = replay_accepted_recomputed_payloads(
            accepted, certified, _certificate(accepted, certified), source=source
        )
        self.assertFalse(report.mesh_binding_verified)
        self.assertFalse(report.payload_replay_qualified)
        self.assertTrue(any("source.mesh" in item for item in report.limitations))

    def test_exact_mesh_json_bytes_are_replayed_with_the_same_fingerprint(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        mesh = _mesh()
        source = ReplaySourceContext(
            node_count=_NODE_COUNT,
            material={"name": "fixture", "uniaxial_anisotropy": None},
            equilibrium_magnetization=_vectors([0.0, 0.0, 1.0]),
            mesh_topology_sha256=_mesh_digest(mesh),
            equilibrium_material_signature="sha256:" + "c" * 64,
            equilibrium_static_physics_signature="sha256:" + "d" * 64,
            equilibrium_boundary_signature="sha256:" + "e" * 64,
            mesh=json.dumps(mesh, separators=(",", ":")).encode("utf-8"),
        )
        report = replay_accepted_recomputed_payloads(
            accepted, certified, _certificate(accepted, certified), source=source
        )
        self.assertTrue(report.mesh_binding_verified)

    def test_missing_optional_pbc_arrays_follow_rust_serde_defaults(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        mesh = _mesh()
        mesh.pop("periodic_boundary_pairs")
        mesh.pop("periodic_node_pairs")
        report = replay_accepted_recomputed_payloads(
            accepted,
            certified,
            _certificate(accepted, certified, mesh_digest=_mesh_digest(mesh)),
            source=_source(ku=None, mesh=mesh),
        )
        self.assertTrue(report.mesh_binding_verified)

        translated = _mesh()
        translated["periodic_boundary_pairs"] = [
            {"pair_id": "x", "marker_a": 1, "marker_b": 2, "translation": [1.0, 0.0, 0.0], "tolerance": None}
        ]
        translated["periodic_node_pairs"] = [{"pair_id": "x", "node_a": 0, "node_b": 1}]
        report = replay_accepted_recomputed_payloads(
            accepted,
            certified,
            _certificate(accepted, certified, mesh_digest=_mesh_digest(translated)),
            source=_source(ku=None, mesh=translated),
        )
        self.assertTrue(report.mesh_binding_verified)

    def test_mesh_structural_contract_rejects_count_and_connectivity_mismatches(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        certificate = _certificate(accepted, certified)
        malformed = _mesh()
        malformed["cells"]["offsets"] = [0, 3]
        with self.assertRaises(ValidationError):
            replay_accepted_recomputed_payloads(
                accepted, certified, certificate, source=_source(ku=None, mesh=malformed)
            )

        malformed = _mesh()
        malformed["cells"]["nodes"][-1] = 99
        with self.assertRaises(ValidationError):
            replay_accepted_recomputed_payloads(
                accepted, certified, certificate, source=_source(ku=None, mesh=malformed)
            )

        malformed = _mesh()
        malformed["nodes"][0] = [0.0, 0.0]
        with self.assertRaises(ValidationError):
            replay_accepted_recomputed_payloads(
                accepted,
                certified,
                certificate,
                source=replace(
                    _source(ku=None),
                    mesh=malformed,
                    mesh_topology_sha256="sha256:" + "0" * 64,
                ),
            )

        wrong_count = ReplaySourceContext(
            node_count=1,
            material={"name": "fixture", "uniaxial_anisotropy": None},
            equilibrium_magnetization=[[0.0, 0.0, 1.0]],
            mesh_topology_sha256=_mesh_digest(_mesh()),
            equilibrium_material_signature="sha256:" + "c" * 64,
            equilibrium_static_physics_signature="sha256:" + "d" * 64,
            equilibrium_boundary_signature="sha256:" + "e" * 64,
            mesh=_mesh(),
        )
        with self.assertRaises(ValidationError):
            replay_accepted_recomputed_payloads(
                accepted, certified, certificate, source=wrong_count
            )

    def test_missing_facet_roles_cannot_qualify_even_with_matching_mesh_digest(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        malformed = _mesh()
        malformed["facets"]["roles"] = []
        certificate, preimage = _with_exact_certificate_preimage(
            _certificate(accepted, certified, mesh_digest=_mesh_digest(malformed))
        )
        with self.assertRaisesRegex(ValidationError, "facets.roles length"):
            replay_accepted_recomputed_payloads(
                accepted,
                certified,
                certificate,
                source=_source(ku=None, mesh=malformed),
                certificate_preimage=preimage,
            )

    def test_duplicate_tolerance_alias_is_rejected_before_mesh_binding(self) -> None:
        malformed = _mesh()
        malformed["periodic_boundary_pairs"] = [
            {"pair_id": "x", "tolerance": 1e-9, "tolerance_m": 1e-9}
        ]
        accepted = _fields("v1")
        certified = _fields("v1")
        with self.assertRaisesRegex(ValidationError, "duplicates tolerance"):
            replay_accepted_recomputed_payloads(
                accepted,
                certified,
                _certificate(accepted, certified),
                source=replace(_source(ku=None), mesh=malformed),
            )

    def test_literal_rust_v1_certificate_preimage_matches_frozen_digest(self) -> None:
        # Literal copied from types.rs::legacy_refresh_certificate_bytes_and_digest_are_frozen.
        preimage = (
            b'{"schema_version":"RecomputedFemLinearizationCertificate.v1","status":"matched",'
            b'"recompute_provider":"native_fem_final_state_refresh.v1","node_count":1,'
            b'"equilibrium_content_sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"mesh_topology_sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"equilibrium_material_signature":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"equilibrium_static_physics_signature":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"equilibrium_boundary_signature":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"accepted_fields_content_sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"recomputed_fields_content_sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
            b'"max_h_ex_difference_a_per_m":0.0,"max_h_demag_difference_a_per_m":0.0,'
            b'"max_h_ext_difference_a_per_m":0.0,"max_h_eff_difference_a_per_m":0.0,'
            b'"max_phi_difference_a":0.0,"field_absolute_tolerance_a_per_m":0.0,'
            b'"field_relative_tolerance":0.0,"phi_absolute_tolerance_a":0.0,'
            b'"content_sha256":""}'
        )
        self.assertEqual(
            certificate_sha256_from_exact_preimage(
                "RecomputedFemLinearizationCertificate.v1", preimage
            ),
            "sha256:ed9805381c87f09d4b3f0a47b822b1ce8e0dbaa81c5511fccb205987e21fb2f9",
        )

    def test_artifact_loader_rejects_duplicate_keys_and_path_replay_preserves_preimage_bytes(self) -> None:
        accepted = _fields("v1")
        certified = _fields("v1")
        certificate, preimage = _with_exact_certificate_preimage(
            _certificate(accepted, certified)
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            accepted_path = root / "accepted.json"
            certified_path = root / "certified.json"
            certificate_path = root / "certificate.json"
            identity_path = root / "identity.json"
            accepted_path.write_text(json.dumps(accepted), encoding="utf-8")
            certified_path.write_text(json.dumps(certified), encoding="utf-8")
            certificate_path.write_text(json.dumps(certificate), encoding="utf-8")
            identity_path.write_text(
                json.dumps(
                    {
                        "recomputed_certificate_preimage_json": preimage.decode("utf-8"),
                        "recomputed_certificate_preimage_sha256": "sha256:"
                        + hashlib.sha256(preimage).hexdigest(),
                    }
                ),
                encoding="utf-8",
            )
            report = replay_artifact_paths(
                ArtifactPaths(accepted_path, certified_path, certificate_path),
                source=_source(ku=None),
                identity_path=identity_path,
            )
            self.assertTrue(report.payload_replay_qualified)
            self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")
            self.assertTrue(
                any("complete linearization_identity.v2 validation" in item for item in report.limitations)
            )

            duplicate = root / "duplicate.json"
            duplicate.write_bytes(b'{"x": 1, "x": 2}')
            with self.assertRaises(ValidationError):
                load_json_artifact(duplicate, "duplicate fixture")

            surrogate = root / "surrogate.json"
            surrogate.write_bytes(b'{"x": "\\ud800"}')
            with self.assertRaises(ValidationError):
                load_json_artifact(surrogate, "surrogate fixture")

            nonfinite = root / "nonfinite.json"
            nonfinite.write_bytes(b'{"x": 1e999}')
            with self.assertRaises(ValidationError):
                load_json_artifact(nonfinite, "nonfinite fixture")

            deep = root / "deep.json"
            deep.write_bytes(b'{"x":' + b"[" * 130 + b"0" + b"]" * 130 + b"}")
            with self.assertRaises(ValidationError):
                load_json_artifact(deep, "deep fixture")

        with self.assertRaises(ValidationError):
            certificate_preimage_from_identity(
                {
                    "recomputed_certificate_preimage_json": "\ud800",
                    "recomputed_certificate_preimage_sha256": "sha256:" + "0" * 64,
                }
            )


if __name__ == "__main__":
    unittest.main()
