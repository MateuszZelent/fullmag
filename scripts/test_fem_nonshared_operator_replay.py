"""Interpreted regressions for the non-shared Floquet sidecar replay."""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))

from fem_nonshared_operator_replay import (  # noqa: E402
    NonSharedReplayError,
    _validate_build_identity,
    raw_sha256,
    replay_nonshared_operator,
)


# These are deliberately frozen Rust-shaped bytes.  The expected raw digests
# were recorded independently of the fixture builder and keep this regression
# from becoming a Python json.dumps self-check.
MESH_RAW = (
    b'{"nodes":[[0,0,0],[1,0,0]],"cells":{},"periodic_node_pairs":'
    b'[{"pair_id":"p0","node_a":0,"node_b":1}],"periodic_boundary_pairs":'
    b'[{"pair_id":"p0","translation":[1.0,0.0,0.0]}]}'
)
MESH_SHA = "sha256:f3b03d874ebbb5308ec33c321f3f8273fe8154d70633b4a6ce98ffcff43b75af"
MATRIX_PENCIL_RAW = (
    b'{"schema_version":"nonshared_floquet_matrix_pencil.v1","row_major":true,'
    b'"dimension":2,"active_node_count":1,"tangent_dof_count":2,'
    b'"embedding":"direct_real_tangent","stiffness_field_a_per_m":[2.0,0.0,0.0,3.0],'
    b'"stiffness_omega_rad_s":[4.0,0.0,0.0,6.0],"gyrotropic":[0.0,1.0,-1.0,0.0],'
    b'"tangent_mass":[1.0,0.0,0.0,1.0]}'
)
MATRIX_PENCIL_SHA = "sha256:c50d6f32ef954c8ebfa98ca9fd805c6ad3a01346276e39ba7e1e8fd64abaaaa7"
OPERATOR_INPUT_RAW = (
    b'{"schema_version":"nonshared_floquet_operator_input.v1","assembly_kind":"runner_full_2x2_bloch_floquet",'
    b'"matrix_equation":"K_omega(k) q = lambda B(k) q","source_equilibrium_sha256":"sha256:'
    b'1111111111111111111111111111111111111111111111111111111111111111",'
    b'"source_m0_sha256":"sha256:2222222222222222222222222222222222222222222222222222222222222222",'
    b'"source_m0_origin":"verified_relax_handoff_m0","mesh_topology_sha256":"sha256:'
    b'3333333333333333333333333333333333333333333333333333333333333333","mesh_topology_v6":"sha256:'
    b'4444444444444444444444444444444444444444444444444444444444444444","source_mesh_topology_sha256":"sha256:'
    b'5555555555555555555555555555555555555555555555555555555555555555","mesh_payload_kind":"producer_plan_snapshot_mesh",'
    b'"mesh_payload_sha256":"sha256:f3b03d874ebbb5308ec33c321f3f8273fe8154d70633b4a6ce98ffcff43b75af",'
    b'"mesh_payload_path":"eigen/metadata/sample_0003/nonshared_source/source_mesh.json",'
    b'"producer_plan_snapshot":null,"material_signature":"sha256:6666666666666666666666666666666666666666666666666666666666666666",'
    b'"physics_signature":"sha256:7777777777777777777777777777777777777777777777777777777777777777",'
    b'"boundary_signature":"sha256:8888888888888888888888888888888888888888888888888888888888888888",'
    b'"source_equilibrium_material_signature":null,"source_equilibrium_static_physics_signature":null,'
    b'"source_equilibrium_boundary_signature":null,"source_material_provenance_signature":null,'
    b'"source_replay_status":"NOT_VERIFIED_producer_payload_not_published","damping_policy":"ignore",'
    b'"alpha":0.0,"k_vector_rad_m":[2.0,0.0,0.0],"spin_wave_bc_kind":"floquet",'
    b'"phase_convention":"ExpMinusIKDotTranslation","floquet_pairs":[{"pair_id":"p0","node_a":0,"node_b":1,'
    b'"translation_m":[1.0,0.0,0.0],"phase_rad":-2.0,"phase_convention":"ExpMinusIKDotTranslation"}],'
    b'"matrix_pencil_sha256":"sha256:c50d6f32ef954c8ebfa98ca9fd805c6ad3a01346276e39ba7e1e8fd64abaaaa7",'
    b'"matrix_pencil_shape":{"rows":2,"columns":2,"ordering":"row_major"},"operator_diagnostics_sha256":"sha256:'
    b'9999999999999999999999999999999999999999999999999999999999999999","operator_diagnostics_schema":"frequency_domain_operator_diagnostics.v1",'
    b'"active_node_count":1,"tangent_dof_count":2,"equilibrium_source_kind":"provided","include_exchange":true,"include_demag":false}'
)
OPERATOR_INPUT_SHA = "sha256:80c36708388ecda5dad3e86e69fba1d302ff79ce0d9b8cf11751354a5d2dd0f6"
SOURCE_SNAPSHOT = "b6511df906eb213ffe5f820985c202cfc6cc5364c68becd569611de8bad506a5"


def _digest(char: str) -> str:
    return "sha256:" + char * 64


def _raw(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _write(root: Path, relative: str, data: bytes) -> None:
    path = root / Path(relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _ref(schema: str, path: str, data: bytes) -> dict[str, object]:
    digest = raw_sha256(data)
    return {
        "schema_version": schema,
        "path": path,
        "encoding": "utf-8-json-bytes",
        "byte_length": len(data),
        "raw_sha256": digest,
        "semantic_signature": digest,
    }


def _mesh_ref(path: str, data: bytes, sample_index: int) -> dict[str, object]:
    ref = _ref("nonshared_floquet_mesh_payload.v1", path, data)
    ref["sample_index"] = sample_index
    return ref


def _bundle(root: Path, matrix_raw: bytes = MATRIX_PENCIL_RAW, phase: float = -2.0) -> None:
    sample = "eigen/metadata/sample_0003"
    source = f"{sample}/nonshared_source"
    matrix = json.loads(matrix_raw)
    operator = json.loads(OPERATOR_INPUT_RAW)
    matrix_digest = raw_sha256(matrix_raw)
    operator["matrix_pencil_sha256"] = matrix_digest
    operator["floquet_pairs"][0]["phase_rad"] = phase
    operator_raw = _raw(operator) if matrix_digest == MATRIX_PENCIL_SHA else _raw(operator)
    # The standard fixture uses the frozen Rust-shaped operator bytes.  For a
    # mutation test the rewritten operator carries the updated matrix digest.
    if matrix_digest == MATRIX_PENCIL_SHA and phase == -2.0:
        operator_raw = OPERATOR_INPUT_RAW
    operator_digest = raw_sha256(operator_raw)
    matrix_ref = _ref("nonshared_floquet_matrix_pencil_preimage.v1", f"{source}/nonshared_floquet_matrix_pencil_preimage.v1.json", matrix_raw)
    operator_ref = _ref("nonshared_floquet_operator_input_preimage.v1", f"{source}/nonshared_floquet_operator_input_preimage.v1.json", operator_raw)
    refs = {
        "schema_version": "nonshared_floquet_exact_replay_refs.v1",
        "operator_input": operator_ref,
        "matrix_pencil": matrix_ref,
        "mesh_payload": _mesh_ref(f"{source}/source_mesh.json", MESH_RAW, 3),
        "physical_source": None,
    }
    source_state = {
        "schema_version": "nonshared_floquet_source_state.v1",
        "content_sha256": "",
        "variant": "nonshared_floquet",
        "sample_index": 3,
        "source_replay_available": False,
        "source_replay_qualified": False,
        "source_replay_status": "NOT_VERIFIED_producer_payload_not_published",
        "source_field_origins_verified": False,
        "source_field_lengths_verified": False,
        "source_mesh_node_count": None,
        "exact_replay_refs": refs,
        "source_artifact": None,
        "source_relax_handoff_sha256": None,
        "source_relax_handoff": None,
        "producer_provenance": None,
        "producer_plan_snapshot": None,
        "producer_build_identity": None,
        "consumer_build_identity": {"source_snapshot_sha256": SOURCE_SNAPSHOT},
        "mesh": {
            "topology_fingerprint_v3": _digest("3"),
            "topology_fingerprint_v6": _digest("4"),
            "source_mesh_topology_sha256": _digest("5"),
            "node_count": 2,
            "source_node_count": 2,
            "producer_mesh_node_count": None,
            "source_field_origins_verified": False,
            "source_field_lengths_verified": False,
            "payload_kind": "producer_plan_snapshot_mesh",
            "payload_sha256": MESH_SHA,
            "payload_path": f"{source}/source_mesh.json",
            "source_mesh_payload_status": "NOT_VERIFIED_producer_payload_not_published",
        },
        "equilibrium": {
            "m0": [[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]],
            "m0_origin": "verified_relax_handoff_m0",
            "m0_sha256": _digest("2"),
            "runtime_equilibrium_sha256": _digest("1"),
            "h_eff0_a_per_m": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
            "h_eff0_origin": "verified_relax_handoff_h_eff0",
            "h_eff0_sha256": _digest("b"),
            "h_demag0_a_per_m": [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0]],
            "h_demag0_origin": "verified_relax_handoff_h_demag0",
            "h_demag0_sha256": _digest("c"),
            "phi0_a": [0.0, 0.0],
            "phi0_origin": "verified_relax_handoff_phi0",
            "phi0_sha256": _digest("d"),
        },
        "material": {"plan": {"damping": 0.0}, "signature": _digest("6"), "identity_status": "NOT_VERIFIED"},
        "static_physics": {
            "signature": _digest("7"),
            "plan": {
                "enable_exchange": True,
                "enable_demag": False,
                "external_field_a_per_m": [0.0, 0.0, 0.0],
                "gyromagnetic_ratio": 2.0,
                "operator": {"include_demag": False},
                "demag_realization": None,
            },
        },
        "boundary": {
            "signature": _digest("8"),
            "plan": {
                "spin_wave_bc": "floquet",
                "periodic_node_pairs": [{"pair_id": "p0", "node_a": 0, "node_b": 1}],
                "periodic_boundary_pairs": [{"pair_id": "p0", "translation": [1.0, 0.0, 0.0]}],
            },
        },
        "damping": {"policy": "ignore", "alpha": 0.0, "unit": "1"},
        "k_sampling": {"Single": {"k_vector": [2.0, 0.0, 0.0]}},
        "operator": {
            "input_signature_sha256": operator_digest,
            "matrix_pencil_sha256": matrix_digest,
            "matrix_pencil_shape": {"rows": 2, "columns": 2, "ordering": "row_major"},
        },
        "status": "NOT_VERIFIED",
    }
    source_preimage = _raw(source_state)
    source_digest = raw_sha256(source_preimage)
    source_state["content_sha256"] = source_digest
    source_ref = _ref("nonshared_floquet_source_state_preimage.v1", f"{source}/nonshared_floquet_source_state_preimage.v1.json", source_preimage)
    source_ref["semantic_signature"] = source_digest
    final_refs = copy.deepcopy(refs)
    final_refs["source_state"] = source_ref
    identity = {
        "schema_version": "nonshared_floquet_operator_identity.v1",
        "content_sha256": "",
        "sample_index": 3,
        "variant": "nonshared_floquet",
        "source_replay_qualified": False,
        "source_replay_available": False,
        "source_replay_status": "NOT_VERIFIED_producer_payload_not_published",
        "source_field_origins_verified": False,
        "source_field_lengths_verified": False,
        "source_mesh_node_count": None,
        "exact_replay_refs": final_refs,
        "source_state_sha256": source_digest,
        "operator_input_signature_sha256": operator_digest,
        "matrix_pencil_sha256": matrix_digest,
        "mesh_topology_sha256": _digest("3"),
        "source_mesh_topology_sha256": _digest("5"),
        "mesh_payload_kind": "producer_plan_snapshot_mesh",
        "mesh_payload_sha256": MESH_SHA,
        "mesh_payload_path": f"{source}/source_mesh.json",
        "producer_plan_snapshot": None,
        "material_signature": _digest("6"),
        "physics_signature": _digest("7"),
        "boundary_signature": _digest("8"),
        "damping_policy": "ignore",
        "alpha": 0.0,
        "k_vector_rad_m": [2.0, 0.0, 0.0],
        "phase_convention": "ExpMinusIKDotTranslation",
        "floquet_pairs": operator["floquet_pairs"],
        "consumer_build_identity": {"source_snapshot_sha256": SOURCE_SNAPSHOT},
        "producer_build_identity": None,
        "source_handoff_sha256": None,
        "status": "NOT_VERIFIED",
    }
    identity_preimage = _raw(identity)
    identity_digest = raw_sha256(identity_preimage)
    identity["content_sha256"] = identity_digest
    identity_sidecar = {
        "schema_version": "nonshared_floquet_operator_identity_preimage.v1",
        "identity_schema": "nonshared_floquet_operator_identity.v1",
        "identity_preimage_json": identity_preimage.decode("utf-8"),
        "identity_preimage_sha256": identity_digest,
        "identity_content_sha256": identity_digest,
    }
    _write(root, f"{sample}/nonshared_floquet_operator_identity.v1.json", _raw(identity))
    _write(root, f"{sample}/nonshared_floquet_operator_identity_preimage.v1.json", _raw(identity_sidecar))
    _write(root, f"{sample}/nonshared_floquet_source_state.v1.json", _raw(source_state))
    _write(root, source_ref["path"], source_preimage)
    _write(root, operator_ref["path"], operator_raw)
    _write(root, matrix_ref["path"], matrix_raw)
    _write(root, f"{source}/source_mesh.json", MESH_RAW)


def _rewrite_identity(root: Path, mutate: object) -> None:
    identity_path = root / "eigen/metadata/sample_0003/nonshared_floquet_operator_identity.v1.json"
    sidecar_path = root / "eigen/metadata/sample_0003/nonshared_floquet_operator_identity_preimage.v1.json"
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    mutate(identity)
    preimage = dict(identity)
    preimage["content_sha256"] = ""
    preimage_raw = _raw(preimage)
    digest = raw_sha256(preimage_raw)
    identity["content_sha256"] = digest
    sidecar = {
        "schema_version": "nonshared_floquet_operator_identity_preimage.v1",
        "identity_schema": "nonshared_floquet_operator_identity.v1",
        "identity_preimage_json": preimage_raw.decode("utf-8"),
        "identity_preimage_sha256": digest,
        "identity_content_sha256": digest,
    }
    identity_path.write_bytes(_raw(identity))
    sidecar_path.write_bytes(_raw(sidecar))


def _rewrite_legacy_without_mesh_ref(root: Path) -> None:
    """Remove the additive mesh ref while keeping the old bundle self-consistent."""

    sample = root / "eigen/metadata/sample_0003"
    identity_path = sample / "nonshared_floquet_operator_identity.v1.json"
    identity_preimage_path = sample / "nonshared_floquet_operator_identity_preimage.v1.json"
    source_state_path = sample / "nonshared_floquet_source_state.v1.json"
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    source_state = json.loads(source_state_path.read_text(encoding="utf-8"))
    identity["exact_replay_refs"].pop("mesh_payload", None)
    source_state["exact_replay_refs"].pop("mesh_payload", None)

    source_preimage = dict(source_state)
    source_preimage["content_sha256"] = ""
    source_preimage_raw = _raw(source_preimage)
    source_digest = raw_sha256(source_preimage_raw)
    source_state["content_sha256"] = source_digest
    source_state_path.write_bytes(_raw(source_state))
    source_ref = identity["exact_replay_refs"]["source_state"]
    source_ref["byte_length"] = len(source_preimage_raw)
    source_ref["raw_sha256"] = source_digest
    source_ref["semantic_signature"] = source_digest
    (root / Path(source_ref["path"])).write_bytes(source_preimage_raw)
    identity["source_state_sha256"] = source_digest

    identity_preimage = dict(identity)
    identity_preimage["content_sha256"] = ""
    identity_preimage_raw = _raw(identity_preimage)
    identity_digest = raw_sha256(identity_preimage_raw)
    identity["content_sha256"] = identity_digest
    identity_path.write_bytes(_raw(identity))
    identity_preimage_path.write_bytes(
        _raw(
            {
                "schema_version": "nonshared_floquet_operator_identity_preimage.v1",
                "identity_schema": "nonshared_floquet_operator_identity.v1",
                "identity_preimage_json": identity_preimage_raw.decode("utf-8"),
                "identity_preimage_sha256": identity_digest,
                "identity_content_sha256": identity_digest,
            }
        )
    )


def _refresh_ref(ref: dict[str, object], raw: bytes) -> None:
    digest = raw_sha256(raw)
    ref["byte_length"] = len(raw)
    ref["raw_sha256"] = digest
    if "semantic_signature" in ref:
        ref["semantic_signature"] = digest


def _rewrite_payload_bundle(
    root: Path,
    *,
    mutate_matrix: object | None = None,
    mutate_operator: object | None = None,
    mutate_source: object | None = None,
) -> None:
    """Apply a malformed semantic value while refreshing every outer digest."""

    sample = root / "eigen/metadata/sample_0003"
    source = sample / "nonshared_source"
    identity_path = sample / "nonshared_floquet_operator_identity.v1.json"
    identity_preimage_path = sample / "nonshared_floquet_operator_identity_preimage.v1.json"
    source_state_path = sample / "nonshared_floquet_source_state.v1.json"
    operator_path = source / "nonshared_floquet_operator_input_preimage.v1.json"
    matrix_path = source / "nonshared_floquet_matrix_pencil_preimage.v1.json"

    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    source_state = json.loads(source_state_path.read_text(encoding="utf-8"))
    operator = json.loads(operator_path.read_text(encoding="utf-8"))
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))

    if mutate_matrix is not None:
        mutate_matrix(matrix)
        matrix_raw = _raw(matrix)
        matrix_path.write_bytes(matrix_raw)
        matrix_digest = raw_sha256(matrix_raw)
        operator["matrix_pencil_sha256"] = matrix_digest
        source_state["operator"]["matrix_pencil_sha256"] = matrix_digest
        identity["matrix_pencil_sha256"] = matrix_digest
        for refs in (
            identity["exact_replay_refs"],
            source_state["exact_replay_refs"],
        ):
            _refresh_ref(refs["matrix_pencil"], matrix_raw)

    if mutate_operator is not None:
        mutate_operator(operator)
    if mutate_matrix is not None or mutate_operator is not None:
        operator_raw = _raw(operator)
        operator_path.write_bytes(operator_raw)
        operator_digest = raw_sha256(operator_raw)
        source_state["operator"]["input_signature_sha256"] = operator_digest
        identity["operator_input_signature_sha256"] = operator_digest
        for refs in (
            identity["exact_replay_refs"],
            source_state["exact_replay_refs"],
        ):
            _refresh_ref(refs["operator_input"], operator_raw)

    if mutate_source is not None:
        mutate_source(source_state)

    source_preimage = dict(source_state)
    source_preimage["content_sha256"] = ""
    source_preimage_raw = _raw(source_preimage)
    source_digest = raw_sha256(source_preimage_raw)
    source_state["content_sha256"] = source_digest
    source_state_path.write_bytes(_raw(source_state))
    source_ref = identity["exact_replay_refs"]["source_state"]
    source_ref["byte_length"] = len(source_preimage_raw)
    source_ref["raw_sha256"] = source_digest
    source_ref["semantic_signature"] = source_digest
    source_ref_path = root / Path(source_ref["path"])
    source_ref_path.write_bytes(source_preimage_raw)
    identity["source_state_sha256"] = source_digest

    identity_preimage = dict(identity)
    identity_preimage["content_sha256"] = ""
    identity_preimage_raw = _raw(identity_preimage)
    identity_digest = raw_sha256(identity_preimage_raw)
    identity["content_sha256"] = identity_digest
    identity_path.write_bytes(_raw(identity))
    identity_preimage_path.write_bytes(
        _raw(
            {
                "schema_version": "nonshared_floquet_operator_identity_preimage.v1",
                "identity_schema": "nonshared_floquet_operator_identity.v1",
                "identity_preimage_json": identity_preimage_raw.decode("utf-8"),
                "identity_preimage_sha256": identity_digest,
                "identity_content_sha256": identity_digest,
            }
        )
    )


class NonSharedOperatorReplayTests(unittest.TestCase):
    def test_build_identity_uses_raw_lowercase_snapshot_hex(self) -> None:
        self.assertEqual(
            _validate_build_identity(
                {"source_snapshot_sha256": SOURCE_SNAPSHOT}, "consumer_build_identity"
            )["source_snapshot_sha256"],
            SOURCE_SNAPSHOT,
        )
        for value in (
            "sha256:" + SOURCE_SNAPSHOT,
            SOURCE_SNAPSHOT.upper(),
            "a" * 63,
            None,
        ):
            with self.subTest(value=value):
                with self.assertRaisesRegex(NonSharedReplayError, "source_snapshot_sha256"):
                    _validate_build_identity(
                        {"source_snapshot_sha256": value}, "consumer_build_identity"
                    )

    def test_frozen_literals_match_recorded_raw_sha(self) -> None:
        self.assertEqual(raw_sha256(MESH_RAW), MESH_SHA)
        self.assertEqual(raw_sha256(MATRIX_PENCIL_RAW), MATRIX_PENCIL_SHA)
        self.assertEqual(raw_sha256(OPERATOR_INPUT_RAW), OPERATOR_INPUT_SHA)

    def test_valid_exact_operator_replay_is_explicitly_not_scientific_qualification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            report = replay_nonshared_operator(root, sample_index=3)
            self.assertEqual(report.status, "operator_replayable")
            self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")
            self.assertEqual(report.dimension, 2)
            self.assertEqual(report.embedding, "direct_real_tangent")
            self.assertEqual(report.gamma0_rad_s_per_A_m, 2.0)
            self.assertEqual(report.floquet_pair_count, 1)
            self.assertEqual(report.relation_metrics["gamma_relation"], "verified")
            self.assertIn("native_actual_matrix_pencil_not_replayed", report.gaps)
            self.assertIn("source_replay_not_qualified", report.gaps)
            self.assertNotIn("mesh_payload_not_in_exact_replay_refs", report.gaps)
            self.assertEqual(
                report.exact_refs_verified,
                ("source_state", "operator_input", "matrix_pencil", "mesh_payload"),
            )
            self.assertNotIn("", report.as_dict()["exact_refs_verified"])

    def test_mesh_payload_ref_binds_exact_raw_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            mesh_path = root / "eigen/metadata/sample_0003/nonshared_source/source_mesh.json"
            mesh_path.write_bytes(MESH_RAW.replace(b"[1,0,0]", b"[2,0,0]"))
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("mesh_payload", str(context.exception))

    def test_mesh_payload_ref_binds_sample_and_declared_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_identity(
                root,
                lambda identity: identity["exact_replay_refs"]["mesh_payload"].update(
                    {"sample_index": 4}
                ),
            )
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("mesh_payload", str(context.exception))

    def test_legacy_mesh_payload_without_exact_ref_remains_explicit_gap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_legacy_without_mesh_ref(root)
            report = replay_nonshared_operator(root, sample_index=3)
            self.assertIn("mesh_payload_not_in_exact_replay_refs", report.gaps)
            self.assertNotIn("mesh_payload", report.exact_refs_verified)
            self.assertEqual(report.scientific_qualification, "NOT_VERIFIED")

    def test_malformed_embedding_with_consistent_rehash_stays_custom_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(root, mutate_matrix=lambda value: value.__setitem__("embedding", []))
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("unsupported embedding", str(context.exception))

    def test_malformed_operator_damping_policy_with_consistent_rehash_stays_custom_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(root, mutate_operator=lambda value: value.__setitem__("damping_policy", []))
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("unsupported damping_policy", str(context.exception))

    def test_huge_json_integer_stays_custom_finite_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(
                root,
                mutate_operator=lambda value: value.__setitem__("alpha", 10**400),
            )
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("operator input.alpha: expected finite number", str(context.exception))

    def test_malformed_source_damping_with_consistent_rehash_stays_custom_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(root, mutate_source=lambda value: value.__setitem__("damping", []))
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("source_state.damping: expected object", str(context.exception))

    def test_malformed_pair_id_with_consistent_rehash_stays_custom_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(
                root,
                mutate_operator=lambda value: value["floquet_pairs"][0].__setitem__("pair_id", []),
            )
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("pair_id: duplicate or invalid", str(context.exception))

    def test_malformed_mesh_record_with_consistent_rehash_stays_custom_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(root, mutate_source=lambda value: value.__setitem__("mesh", []))
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("source_state.mesh: expected object", str(context.exception))

    def test_malformed_operator_record_with_consistent_rehash_stays_custom_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_payload_bundle(root, mutate_source=lambda value: value.__setitem__("operator", []))
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("source_state.operator: expected object", str(context.exception))

    def test_mutated_matrix_bytes_fail_before_physics_claim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            path = root / "eigen/metadata/sample_0003/nonshared_source/nonshared_floquet_matrix_pencil_preimage.v1.json"
            path.write_bytes(MATRIX_PENCIL_RAW.replace(b"6.0", b"7.0"))
            with self.assertRaises(NonSharedReplayError):
                replay_nonshared_operator(root, sample_index=3)

    def test_consistent_bad_gamma_scaling_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            altered = MATRIX_PENCIL_RAW.replace(b'"stiffness_omega_rad_s":[4.0,0.0,0.0,6.0]', b'"stiffness_omega_rad_s":[5.0,0.0,0.0,7.0]')
            _bundle(root, altered)
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("K_omega", str(context.exception))

    def test_phase_tampering_is_rejected_even_when_json_is_valid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root, phase=-1.0)
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("phase", str(context.exception))

    def test_traversal_in_exact_ref_is_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            identity_path = root / "eigen/metadata/sample_0003/nonshared_floquet_operator_identity.v1.json"
            identity = json.loads(identity_path.read_text(encoding="utf-8"))
            identity["exact_replay_refs"]["matrix_pencil"]["path"] = "../outside.json"
            identity_path.write_text(json.dumps(identity, separators=(",", ":")), encoding="utf-8")
            with self.assertRaises(NonSharedReplayError):
                replay_nonshared_operator(root, sample_index=3)

    def test_missing_physical_ref_key_is_rejected_without_keyerror(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_identity(
                root,
                lambda identity: identity["exact_replay_refs"].update(
                    {"physical_source": {"equilibrium_material": {}}}
                ),
            )
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("physical_source", str(context.exception))

    def test_boolean_sample_index_is_not_a_valid_nonce(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _bundle(root)
            _rewrite_identity(root, lambda identity: identity.update({"sample_index": True}))
            with self.assertRaises(NonSharedReplayError) as context:
                replay_nonshared_operator(root, sample_index=3)
            self.assertIn("sample_index", str(context.exception))


if __name__ == "__main__":
    unittest.main()
