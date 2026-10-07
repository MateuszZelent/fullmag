"""Mutation regressions for the source-bound FEM producer adapter."""

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

from comsol_mesh_identity import mesh_topology_fingerprint_v3  # noqa: E402
from fem_accepted_recomputed_replay import (  # noqa: E402
    V1_FIELDS_SCHEMA,
    recomputed_fem_equilibrium_content_sha256,
)
from fem_equilibrium_field_replay import (  # noqa: E402
    FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
    FIELD_RELATIVE_TOLERANCE,
    PHI_ABSOLUTE_TOLERANCE_A,
    calculate_field_differences,
    certificate_sha256_from_exact_preimage,
    certified_field_content_sha256,
)
from fem_linearization_identity_replay import IDENTITY_FIELDS  # noqa: E402
from fem_producer_provenance_replay import (  # noqa: E402
    ProducerArtifactPaths,
    ProducerProvenanceReplayError,
    SOURCE_REPLAY_QUALIFIED,
    replay_producer_provenance,
)
import verify_fem_frequency_domain_eigen_artifacts as verifier  # noqa: E402


NODE_COUNT = 4
# Raw build snapshot recorded by managed runtime job #195.
SOURCE_SNAPSHOT = "b6511df906eb213ffe5f820985c202cfc6cc5364c68becd569611de8bad506a5"
MATERIAL_SIGNATURE = "sha256:5acf82b569d679296e01d7724e5a2a83fc60ce37d3d711afd535143c4bdad5af"
STATIC_SIGNATURE = "sha256:9f6f99073b14cc461ca1a7c9199282867bc2ce34789b38cd2f61a52124b63b48"
BOUNDARY_SIGNATURE = "sha256:9b1e80acd4476df1caf3c63f83ea40e504993f67dbc6dbbbb74b29eaddf6aa3e"
RAW_MATERIAL_SIGNATURE = "sha256:dafbb79c4680dc3ad87b8adc6ddad189cbd6f2d04925fc4fcc404e24ace145fe"
PRODUCER_BUILD_IDENTITY = {
    "built_at_utc": "2026-10-01T00:00:00Z",
    "git_commit": "b" * 40,
    "worktree_state": "clean",
    "source_snapshot_sha256": SOURCE_SNAPSHOT,
}
CONSUMER_BUILD_IDENTITY = {
    "built_at_utc": "2026-10-01T01:00:00Z",
    "git_commit": "c" * 40,
    "worktree_state": "clean",
    "source_snapshot_sha256": SOURCE_SNAPSHOT,
}

MATERIAL_PREIMAGE = (
    '{"schema_version":"EquilibriumMaterialSignaturePreimage.v1",'
    '"saturation_magnetisation_a_per_m":800000.0,'
    '"exchange_stiffness_j_per_m":1.3e-11,'
    '"saturation_magnetisation_field_a_per_m":null,'
    '"exchange_stiffness_field_j_per_m":null}'
)
STATIC_PREIMAGE = (
    '{"schema_version":"EquilibriumStaticPhysicsSignaturePreimage.v1",'
    '"enable_exchange":true,"enable_demag":true,'
    '"external_field_a_per_m":[0.0,0.0,0.0]}'
)
BOUNDARY_PREIMAGE = (
    '{"schema_version":"EquilibriumBoundarySignaturePreimage.v1",'
    '"exchange_bc":"neumann","demag_realization":"poisson_robin",'
    '"air_box_config":null,"periodic_node_pairs":[],"periodic_boundary_pairs":[]}'
)
RAW_MATERIAL_PREIMAGE = (
    '{"name":"fixture","saturation_magnetisation":800000.0,'
    '"exchange_stiffness":1.3e-11,"damping":0.5,'
    '"uniaxial_anisotropy":null,"anisotropy_axis":null}'
)


def _vectors(value: list[float]) -> list[list[float]]:
    return [list(value) for _ in range(NODE_COUNT)]


def _mesh(element_markers: list[int] | None = None) -> dict[str, object]:
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
        "element_markers": [1] if element_markers is None else element_markers,
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


def _material() -> dict[str, object]:
    return {
        "name": "fixture",
        "saturation_magnetisation": 800000.0,
        "exchange_stiffness": 1.3e-11,
        "damping": 0.5,
        "uniaxial_anisotropy": None,
        "anisotropy_axis": None,
    }


def _plan(mesh: dict[str, object]) -> dict[str, object]:
    return {
        "mesh": mesh,
        "material": _material(),
        "initial_magnetization": _vectors([0.0, 0.0, 1.0]),
        "enable_exchange": True,
        "enable_demag": True,
        "external_field": [0.0, 0.0, 0.0],
        "exchange_bc": "neumann",
        "demag_realization": "poisson_robin",
        "air_box_config": None,
        "has_oersted_cylinder": False,
    }


def _fields(delta: float = 0.0) -> tuple[dict[str, object], dict[str, object]]:
    accepted: dict[str, object] = {
        "schema_version": V1_FIELDS_SCHEMA,
        "h_ex_a_per_m": _vectors([1.0, 0.0, 0.0]),
        "h_demag_a_per_m": _vectors([2.0, 0.0, 0.0]),
        "h_ext_a_per_m": _vectors([8.0, 0.0, 0.0]),
        "h_eff_a_per_m": _vectors([11.0, 0.0, 0.0]),
        "phi_a": [0.0] * NODE_COUNT,
        "content_sha256": "sha256:" + "0" * 64,
    }
    accepted["content_sha256"] = certified_field_content_sha256(
        accepted, NODE_COUNT, "accepted fixture"
    )
    recomputed = copy.deepcopy(accepted)
    recomputed["h_ext_a_per_m"] = _vectors([8.0 + delta, 0.0, 0.0])
    recomputed["h_eff_a_per_m"] = _vectors([11.0 + delta, 0.0, 0.0])
    recomputed["content_sha256"] = certified_field_content_sha256(
        recomputed, NODE_COUNT, "recomputed fixture"
    )
    return accepted, recomputed


def _certificate(
    accepted: dict[str, object],
    recomputed: dict[str, object],
    mesh_digest: str,
    m0_digest: str,
) -> tuple[dict[str, object], bytes]:
    differences = calculate_field_differences(accepted, recomputed, NODE_COUNT)
    certificate: dict[str, object] = {
        "schema_version": "RecomputedFemLinearizationCertificate.v1",
        "status": "matched",
        "recompute_provider": "native_fem_final_state_refresh.v1",
        "node_count": NODE_COUNT,
        "equilibrium_content_sha256": m0_digest,
        "mesh_topology_sha256": mesh_digest,
        "equilibrium_material_signature": MATERIAL_SIGNATURE,
        "equilibrium_static_physics_signature": STATIC_SIGNATURE,
        "equilibrium_boundary_signature": BOUNDARY_SIGNATURE,
        "accepted_fields_content_sha256": accepted["content_sha256"],
        "recomputed_fields_content_sha256": recomputed["content_sha256"],
        "max_h_ex_difference_a_per_m": differences["max_h_ex_difference_a_per_m"],
        "max_h_demag_difference_a_per_m": differences["max_h_demag_difference_a_per_m"],
        "max_h_ext_difference_a_per_m": differences["max_h_ext_difference_a_per_m"],
        "max_h_eff_difference_a_per_m": differences["max_h_eff_difference_a_per_m"],
        "max_phi_difference_a": differences["max_phi_difference_a"],
        "field_absolute_tolerance_a_per_m": FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
        "field_relative_tolerance": FIELD_RELATIVE_TOLERANCE,
        "phi_absolute_tolerance_a": PHI_ABSOLUTE_TOLERANCE_A,
        "content_sha256": "",
    }
    preimage = json.dumps(certificate, separators=(",", ":")).encode("utf-8")
    certificate["content_sha256"] = certificate_sha256_from_exact_preimage(
        certificate["schema_version"], preimage
    )
    return certificate, preimage


def _full_identity(
    *,
    plan_framed: str,
    mesh_digest: str,
    m0_digest: str,
    certificate: dict[str, object],
    certificate_preimage: bytes,
    accepted_fields_raw: bytes,
    certified_fields_raw: bytes,
    recomputed_certificate_raw: bytes,
) -> tuple[bytes, bytes]:
    identity: dict[str, object] = {
            "schema_version": "linearization_identity.v2",
            "sample_index": 0,
            "equilibrium_artifact_schema": "equilibrium_artifact.v7",
            "linearization_state_schema": "LinearizationState.v6",
            "accepted_fields_schema": V1_FIELDS_SCHEMA,
            "certified_fields_schema": V1_FIELDS_SCHEMA,
            "recomputed_certificate_schema": "RecomputedFemLinearizationCertificate.v1",
            "handoff_schema_version": "AcceptedFemRelaxStageHandoff.v2",
            "handoff_content_sha256": "sha256:" + "d" * 64,
            "node_count": NODE_COUNT,
            "source_run_id": "run-1",
            "source_stage_id": "relaxation-1",
            "source_stage_kind": "relaxation",
            "producer_build_identity": copy.deepcopy(PRODUCER_BUILD_IDENTITY),
            "consumer_build_identity": copy.deepcopy(CONSUMER_BUILD_IDENTITY),
            "producer_plan_snapshot_sha256": plan_framed,
            "consumer_plan_snapshot_sha256": plan_framed,
            "producer_source_snapshot_sha256": SOURCE_SNAPSHOT,
            "consumer_source_snapshot_sha256": SOURCE_SNAPSHOT,
            "cross_build_policy": "same_source_snapshot_required",
            "source_mesh_topology_sha256": mesh_digest,
            "modal_mesh_topology_fingerprint_v3": mesh_digest,
            "equilibrium_content_sha256": m0_digest,
            "equilibrium_artifact_path": "eigen/metadata/sample_0000/equilibrium_artifact.v7.json",
            "equilibrium_artifact_sha256": "sha256:" + "e" * 64,
            "linearization_state_path": "eigen/metadata/sample_0000/linearization_state.v6.json",
            "linearization_state_sha256": "sha256:" + "f" * 64,
            "equilibrium_material_signature": MATERIAL_SIGNATURE,
            "equilibrium_static_physics_signature": STATIC_SIGNATURE,
            "equilibrium_boundary_signature": BOUNDARY_SIGNATURE,
            "material_signature": RAW_MATERIAL_SIGNATURE,
            "material_identity_kind": "raw_material.v1",
            "material_provenance_signature": RAW_MATERIAL_SIGNATURE,
            "material_provenance_scope": "materialization_plan",
            "producer_material_provenance_signature": RAW_MATERIAL_SIGNATURE,
            "equilibrium_material_preimage_json": MATERIAL_PREIMAGE,
            "equilibrium_static_physics_preimage_json": STATIC_PREIMAGE,
            "equilibrium_boundary_preimage_json": BOUNDARY_PREIMAGE,
            "producer_material_provenance_preimage_json": RAW_MATERIAL_PREIMAGE,
            "material_provenance_preimage_json": RAW_MATERIAL_PREIMAGE,
            "accepted_fields_content_sha256": certificate["accepted_fields_content_sha256"],
            "accepted_fields_path": "eigen/metadata/sample_0000/accepted_fem_equilibrium_fields.v1.json",
            "certified_fields_content_sha256": certificate["recomputed_fields_content_sha256"],
            "certified_fields_path": "eigen/metadata/sample_0000/certified_fem_equilibrium_fields.v1.json",
            "recomputed_certificate_content_sha256": certificate["content_sha256"],
            "recomputed_certificate_path": "eigen/metadata/sample_0000/recomputed_fem_linearization_certificate.v1.json",
            "accepted_fields_bytes_sha256": "sha256:" + hashlib.sha256(accepted_fields_raw).hexdigest(),
            "certified_fields_bytes_sha256": "sha256:" + hashlib.sha256(certified_fields_raw).hexdigest(),
            "recomputed_certificate_bytes_sha256": "sha256:" + hashlib.sha256(recomputed_certificate_raw).hexdigest(),
            "recomputed_certificate_preimage_json": certificate_preimage.decode("utf-8"),
            "recomputed_certificate_preimage_sha256": "sha256:" + hashlib.sha256(certificate_preimage).hexdigest(),
            "content_sha256": "",
    }
    if frozenset(identity) != IDENTITY_FIELDS:
        raise AssertionError("producer-shaped identity fixture must cover every v2 field")
    identity_preimage = json.dumps(identity, separators=(",", ":")).encode("utf-8")
    identity["content_sha256"] = "sha256:" + hashlib.sha256(
        b"linearization_identity.v2\0"
        + len(identity_preimage).to_bytes(8, "little")
        + identity_preimage
    ).hexdigest()
    identity_raw = json.dumps(identity, separators=(",", ":")).encode("utf-8")
    sidecar = {
        "schema_version": "linearization_identity_preimage.v1",
        "identity_schema": "linearization_identity.v2",
        "identity_preimage_json": identity_preimage.decode("utf-8"),
        "identity_preimage_sha256": "sha256:" + hashlib.sha256(identity_preimage).hexdigest(),
        "identity_content_sha256": identity["content_sha256"],
    }
    return identity_raw, json.dumps(sidecar, separators=(",", ":")).encode("utf-8")


def _rewrite_identity_field(paths: ProducerArtifactPaths, field: str, value: object) -> None:
    """Mutate one identity field while recomputing its own exact digest."""

    identity = json.loads(paths.identity_path.read_text(encoding="utf-8"))
    sidecar = json.loads(paths.identity_preimage_path.read_text(encoding="utf-8"))
    identity[field] = value
    preimage = copy.deepcopy(identity)
    preimage["content_sha256"] = ""
    preimage_raw = json.dumps(preimage, separators=(",", ":")).encode("utf-8")
    identity["content_sha256"] = "sha256:" + hashlib.sha256(
        b"linearization_identity.v2\0"
        + len(preimage_raw).to_bytes(8, "little")
        + preimage_raw
    ).hexdigest()
    identity_raw = json.dumps(identity, separators=(",", ":")).encode("utf-8")
    sidecar["identity_preimage_json"] = preimage_raw.decode("utf-8")
    sidecar["identity_preimage_sha256"] = "sha256:" + hashlib.sha256(preimage_raw).hexdigest()
    sidecar["identity_content_sha256"] = identity["content_sha256"]
    paths.identity_path.write_bytes(identity_raw)
    paths.identity_preimage_path.write_text(
        json.dumps(sidecar, separators=(",", ":")), encoding="utf-8"
    )


class ProducerProvenanceReplayTests(unittest.TestCase):
    def _bundle(
        self, *, element_markers: list[int] | None = None
    ) -> tuple[tempfile.TemporaryDirectory[str], ProducerArtifactPaths]:
        temp = tempfile.TemporaryDirectory()
        root = Path(temp.name)
        mesh = _mesh(element_markers)
        plan = _plan(mesh)
        plan_raw = json.dumps(plan, separators=(",", ":")).encode("utf-8")
        plan_framed = "sha256:" + hashlib.sha256(
            b"fem_relaxation.producer_plan.v1\0"
            + len(plan_raw).to_bytes(8, "little")
            + plan_raw
        ).hexdigest()
        fingerprint_mesh = copy.deepcopy(mesh)
        if fingerprint_mesh["element_markers"] == [0]:
            fingerprint_mesh["element_markers"] = [1]
        mesh_digest = mesh_topology_fingerprint_v3(fingerprint_mesh)
        m0 = {"observable": "m", "unit": "1", "values": _vectors([0.0, 0.0, 1.0])}
        m0_values = m0["values"]
        m0_digest = recomputed_fem_equilibrium_content_sha256(m0_values)
        accepted, recomputed = _fields(delta=2.5e-9)
        certificate, certificate_preimage = _certificate(
            accepted, recomputed, mesh_digest, m0_digest
        )
        payload_dir = root / "equilibrium"
        payload_dir.mkdir()
        payloads = {
            "accepted_fem_equilibrium_fields.v1.json": accepted,
            "certified_fem_equilibrium_fields.v1.json": recomputed,
            "recomputed_fem_linearization_certificate.v1.json": certificate,
        }
        payload_raws = {
            name: json.dumps(value, separators=(",", ":")).encode("utf-8")
            for name, value in payloads.items()
        }
        for name, raw in payload_raws.items():
            (payload_dir / name).write_bytes(raw)
        identity_raw, identity_preimage_raw = _full_identity(
            plan_framed=plan_framed,
            mesh_digest=mesh_digest,
            m0_digest=m0_digest,
            certificate=certificate,
            certificate_preimage=certificate_preimage,
            accepted_fields_raw=payload_raws["accepted_fem_equilibrium_fields.v1.json"],
            certified_fields_raw=payload_raws["certified_fem_equilibrium_fields.v1.json"],
            recomputed_certificate_raw=payload_raws["recomputed_fem_linearization_certificate.v1.json"],
        )
        identity_path = root / "linearization_identity.v2.json"
        identity_preimage_path = root / "linearization_identity_preimage.v1.json"
        identity_path.write_bytes(identity_raw)
        identity_preimage_path.write_bytes(identity_preimage_raw)
        plan_path = root / "producer_plan.json"
        plan_path.write_bytes(plan_raw)
        m0_path = root / "m_final.json"
        m0_path.write_bytes(json.dumps(m0, separators=(",", ":")).encode("utf-8"))
        provenance = {
            "schema_version": "fem_relaxation_producer_provenance.v1",
            "source_run_id": "run-1",
            "source_stage_id": "relaxation-1",
            "source_stage_kind": "relaxation",
            "producer_build_identity": {
                "built_at_utc": "2026-10-01T00:00:00Z",
                "git_commit": "b" * 40,
                "worktree_state": "clean",
                "source_snapshot_sha256": SOURCE_SNAPSHOT,
            },
            "producer_plan_snapshot": {
                "namespace": "fem_relaxation.producer_plan.v1",
                "encoding": "utf-8-json-bytes",
                "preimage_json": plan_raw.decode("utf-8"),
                "raw_sha256": "sha256:" + hashlib.sha256(plan_raw).hexdigest(),
                "framed_sha256": plan_framed,
            },
            "source_mesh_topology_sha256": mesh_digest,
            "equilibrium_content_sha256": m0_digest,
            "equilibrium_material_signature": MATERIAL_SIGNATURE,
            "equilibrium_static_physics_signature": STATIC_SIGNATURE,
            "equilibrium_boundary_signature": BOUNDARY_SIGNATURE,
            "payloads": {
                "accepted_fields": {
                    "path": "equilibrium/accepted_fem_equilibrium_fields.v1.json",
                    "schema_version": V1_FIELDS_SCHEMA,
                    "raw_bytes_sha256": "sha256:" + hashlib.sha256(payload_raws["accepted_fem_equilibrium_fields.v1.json"]).hexdigest(),
                    "content_sha256": accepted["content_sha256"],
                },
                "certified_fields": {
                    "path": "equilibrium/certified_fem_equilibrium_fields.v1.json",
                    "schema_version": V1_FIELDS_SCHEMA,
                    "raw_bytes_sha256": "sha256:" + hashlib.sha256(payload_raws["certified_fem_equilibrium_fields.v1.json"]).hexdigest(),
                    "content_sha256": recomputed["content_sha256"],
                },
                "recomputed_certificate": {
                    "path": "equilibrium/recomputed_fem_linearization_certificate.v1.json",
                    "schema_version": "RecomputedFemLinearizationCertificate.v1",
                    "raw_bytes_sha256": "sha256:" + hashlib.sha256(payload_raws["recomputed_fem_linearization_certificate.v1.json"]).hexdigest(),
                    "content_sha256": certificate["content_sha256"],
                },
            },
            "cross_build_policy": "same_source_snapshot_required",
        }
        provenance_path = root / "equilibrium" / "producer_provenance.v1.json"
        provenance_path.write_bytes(json.dumps(provenance, indent=2).encode("utf-8"))
        source_mesh_path = root / "source_mesh.json"
        source_mesh_path.write_bytes(json.dumps(mesh, separators=(",", ":")).encode("utf-8"))
        return temp, ProducerArtifactPaths(
            producer_root=root,
            provenance_path=provenance_path,
            producer_plan_path=plan_path,
            equilibrium_magnetization_path=m0_path,
            identity_path=identity_path,
            identity_preimage_path=identity_preimage_path,
            source_mesh_path=source_mesh_path,
        )

    def _shared_routing_bundle(
        self,
    ) -> tuple[tempfile.TemporaryDirectory[str], ProducerArtifactPaths, dict[str, object]]:
        """Publish one real producer fixture through the sample_NNNN routing contract."""

        temp, source_paths = self._bundle()
        root = source_paths.producer_root
        sample = root / "eigen" / "metadata" / "sample_0000"
        sample.mkdir(parents=True)

        producer_path = sample / "producer_provenance.v1.json"
        producer_path.write_bytes(source_paths.provenance_path.read_bytes())
        identity_path = sample / "linearization_identity.v2.json"
        identity_preimage_path = sample / "linearization_identity_preimage.v1.json"
        identity_path.write_bytes(source_paths.identity_path.read_bytes())
        identity_preimage_path.write_bytes(source_paths.identity_preimage_path.read_bytes())

        payload_paths: dict[str, Path] = {}
        for name, filename in (
            ("accepted_fields", "accepted_fem_equilibrium_fields.v1.json"),
            ("certified_fields", "certified_fem_equilibrium_fields.v1.json"),
            ("recomputed_certificate", "recomputed_fem_linearization_certificate.v1.json"),
        ):
            destination = sample / filename
            destination.write_bytes((root / "equilibrium" / filename).read_bytes())
            payload_paths[name] = destination

        equilibrium = {
            "schema_version": "equilibrium_artifact.v7",
            "accepted_for_linearization": True,
            "m0": _vectors([0.0, 0.0, 1.0]),
            "acceptance_certificate": {
                "criterion": "energy",
                "status": "completed",
                "converged": True,
            },
        }
        equilibrium["content_sha256"] = verifier.equilibrium_artifact_v7_digest(equilibrium)
        equilibrium_path = sample / "equilibrium_artifact.v7.json"
        equilibrium_path.write_bytes(json.dumps(equilibrium, separators=(",", ":")).encode("utf-8"))

        state = {
            "schema_version": "LinearizationState.v6",
            "content_sha256": "sha256:" + "7" * 64,
        }
        state_path = sample / "linearization_state.v6.json"
        state_path.write_bytes(json.dumps(state, separators=(",", ":")).encode("utf-8"))

        # This is the exact consumer-plan transport fixture.  It is deliberately
        # kept separate from the producer FemPlan snapshot: this interpreted
        # gate proves bytes and identity binding, not native FemEigenPlanIR
        # deserialization or operator assembly.
        consumer_plan_raw = (
            b'{"schema_version":"FemEigenPlanIR.snapshot.v1",'
            b'"sample_index":0,"wave_vector_rad_per_m":[0.0,0.0,0.0],'
            b'"requested_device":"cpu"}'
        )
        consumer_plan_path = sample / "consumer_plan_snapshot.v1.json"
        consumer_plan_path.write_bytes(consumer_plan_raw)

        routing_paths = ProducerArtifactPaths(
            producer_root=root,
            provenance_path=producer_path,
            equilibrium_magnetization_path=equilibrium_path,
            identity_path=identity_path,
            identity_preimage_path=identity_preimage_path,
            payload_paths=payload_paths,
        )
        # The identity already contains the canonical sample_0000 paths. Only
        # the source artifact/state content bindings change in this routed copy.
        _rewrite_identity_field(routing_paths, "equilibrium_artifact_sha256", equilibrium["content_sha256"])
        _rewrite_identity_field(routing_paths, "linearization_state_sha256", state["content_sha256"])
        _rewrite_identity_field(
            routing_paths,
            "consumer_plan_snapshot_sha256",
            "sha256:" + hashlib.sha256(consumer_plan_raw).hexdigest(),
        )

        relative = "eigen/metadata/sample_0000/"
        manifest = {
            "artifacts": {
                "producer_provenance_v1_paths": [relative + "producer_provenance.v1.json"],
                verifier.R4_IDENTITY_SIDECAR_KEY: [relative + "linearization_identity.v2.json"],
                verifier.R4_IDENTITY_PREIMAGE_KEY: [relative + "linearization_identity_preimage.v1.json"],
                "consumer_plan_snapshot_v1_paths": [relative + "consumer_plan_snapshot.v1.json"],
                "equilibrium_artifact_v7_paths": [relative + "equilibrium_artifact.v7.json"],
                "linearization_state_v6_paths": [relative + "linearization_state.v6.json"],
            }
        }
        return temp, routing_paths, manifest

    def test_valid_bundle_returns_source_context_only_after_all_bindings(self) -> None:
        temp, paths = self._bundle()
        try:
            source_mesh = _mesh()
            paths.source_mesh_path.write_bytes(json.dumps(source_mesh, separators=(",", ":")).encode("utf-8"))
            report = replay_producer_provenance(
                paths,
                expected_source_run_id="run-1",
                expected_source_stage_id="relaxation-1",
                expected_source_stage_kind="relaxation",
                expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
            )
            self.assertEqual(report.status, SOURCE_REPLAY_QUALIFIED)
            self.assertEqual(report.source_context.node_count, NODE_COUNT)
            self.assertEqual(report.source_context.mesh_topology_sha256, mesh_topology_fingerprint_v3(source_mesh))
            self.assertEqual(report.payload_report.scientific_qualification, "NOT_VERIFIED")
            self.assertEqual(report.payload_report.identity_scope, "caller_validated_source_signatures")
        finally:
            temp.cleanup()

    def test_main_shared_routing_replays_real_producer_bundle(self) -> None:
        temp, _, manifest = self._shared_routing_bundle()
        try:
            report = verifier.validate_producer_payload_replay(
                Path(temp.name), manifest
            )
            self.assertEqual(report["status"], "source_payloads_replayed")
            self.assertEqual(set(report["samples"]), {"0"})
            self.assertEqual(report["operator_replay_status"], "NOT_VERIFIED")
            self.assertEqual(
                report["samples"]["0"]["scientific_qualification"],
                "NOT_VERIFIED",
            )
            consumer = verifier.validate_consumer_plan_exact_replay(
                Path(temp.name), manifest["artifacts"], {0}
            )
            self.assertEqual(consumer["status"], "consumer_plan_exact_bytes_replayed")
            self.assertEqual(consumer["raw_sha256_by_sample"].keys(), {"0"})
            self.assertEqual(consumer["plan_semantics_status"], "NOT_VERIFIED")
            self.assertEqual(consumer["operator_replay_status"], "NOT_VERIFIED")
        finally:
            temp.cleanup()

    def test_consumer_plan_foreign_bytes_without_identity_update_are_rejected(self) -> None:
        temp, paths, manifest = self._shared_routing_bundle()
        try:
            plan_path = paths.producer_root / "eigen" / "metadata" / "sample_0000" / "consumer_plan_snapshot.v1.json"
            plan_path.write_bytes(b'{"foreign":true}')
            with self.assertRaisesRegex(SystemExit, "raw digest"):
                verifier.validate_consumer_plan_exact_replay(
                    paths.producer_root, manifest["artifacts"], {0}
                )
        finally:
            temp.cleanup()

    def test_self_consistent_foreign_consumer_plan_remains_semantically_unverified(self) -> None:
        temp, paths, manifest = self._shared_routing_bundle()
        try:
            plan_path = paths.producer_root / "eigen" / "metadata" / "sample_0000" / "consumer_plan_snapshot.v1.json"
            foreign_raw = b'{"foreign":true,"sample_index":0}'
            plan_path.write_bytes(foreign_raw)
            _rewrite_identity_field(
                paths,
                "consumer_plan_snapshot_sha256",
                "sha256:" + hashlib.sha256(foreign_raw).hexdigest(),
            )
            report = verifier.validate_consumer_plan_exact_replay(
                paths.producer_root, manifest["artifacts"], {0}
            )
            self.assertEqual(report["status"], "consumer_plan_exact_bytes_replayed")
            self.assertEqual(report["plan_semantics_status"], "NOT_VERIFIED")
            self.assertEqual(report["operator_replay_status"], "NOT_VERIFIED")
        finally:
            temp.cleanup()

    def test_foreign_consumer_source_snapshot_is_rejected_by_source_replay(self) -> None:
        temp, paths, manifest = self._shared_routing_bundle()
        try:
            _rewrite_identity_field(
                paths,
                "consumer_source_snapshot_sha256",
                "9" * 64,
            )
            consumer = verifier.validate_consumer_plan_exact_replay(
                paths.producer_root, manifest["artifacts"], {0}
            )
            self.assertEqual(consumer["status"], "consumer_plan_exact_bytes_replayed")
            self.assertEqual(consumer["plan_semantics_status"], "NOT_VERIFIED")
            with self.assertRaisesRegex(SystemExit, "source snapshot"):
                verifier.validate_producer_payload_replay(
                    paths.producer_root, manifest
                )
        finally:
            temp.cleanup()

    def test_main_shared_routing_rejects_foreign_artifact_path_and_hash(self) -> None:
        mutations = ("artifact", "path", "hash")
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                temp, paths, manifest = self._shared_routing_bundle()
                try:
                    root = paths.producer_root
                    equilibrium_path = root / "eigen" / "metadata" / "sample_0000" / "equilibrium_artifact.v7.json"
                    if mutation == "artifact":
                        equilibrium = json.loads(equilibrium_path.read_text(encoding="utf-8"))
                        equilibrium["m0"][0][0] = 0.25
                        equilibrium["content_sha256"] = verifier.equilibrium_artifact_v7_digest(equilibrium)
                        equilibrium_path.write_text(
                            json.dumps(equilibrium, separators=(",", ":")), encoding="utf-8"
                        )
                        _rewrite_identity_field(paths, "equilibrium_artifact_sha256", equilibrium["content_sha256"])
                    elif mutation == "path":
                        _rewrite_identity_field(
                            paths,
                            "equilibrium_artifact_path",
                            "eigen/metadata/sample_0001/equilibrium_artifact.v7.json",
                        )
                    else:
                        _rewrite_identity_field(
                            paths,
                            "equilibrium_artifact_sha256",
                            "sha256:" + "8" * 64,
                        )
                    with self.assertRaises(SystemExit):
                        verifier.validate_producer_payload_replay(
                            root, manifest
                        )
                finally:
                    temp.cleanup()

    def test_modal_bundle_can_use_inline_plan_and_copied_payloads_with_certified_m0(self) -> None:
        temp, paths = self._bundle()
        try:
            root = paths.producer_root
            artifact = {
                "schema_version": "equilibrium_artifact.v7",
                "accepted_for_linearization": True,
                "m0": _vectors([0.0, 0.0, 1.0]),
            }
            artifact_path = root / "equilibrium_artifact.v7.json"
            artifact_path.write_bytes(json.dumps(artifact, separators=(",", ":")).encode("utf-8"))
            copied = {
                name: root / "equilibrium" / filename
                for name, filename in (
                    ("accepted_fields", "accepted_fem_equilibrium_fields.v1.json"),
                    ("certified_fields", "certified_fem_equilibrium_fields.v1.json"),
                    ("recomputed_certificate", "recomputed_fem_linearization_certificate.v1.json"),
                )
            }
            modal_paths = ProducerArtifactPaths(
                producer_root=root / "modal-sample-0000",
                provenance_path=paths.provenance_path,
                producer_plan_path=None,
                equilibrium_magnetization_path=artifact_path,
                identity_path=paths.identity_path,
                identity_preimage_path=paths.identity_preimage_path,
                source_mesh_path=None,
                payload_paths=copied,
            )
            report = replay_producer_provenance(
                modal_paths,
                expected_source_run_id="run-1",
                expected_source_stage_id="relaxation-1",
                expected_source_stage_kind="relaxation",
                expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
            )
            self.assertEqual(report.status, SOURCE_REPLAY_QUALIFIED)
            self.assertTrue(report.source_paths["producer_plan"].startswith("inline:"))
            self.assertEqual(report.source_paths["payload_accepted_fields"], str(copied["accepted_fields"]))
        finally:
            temp.cleanup()

    def test_marker_normalization_matches_rust_producer_fingerprint(self) -> None:
        temp, paths = self._bundle(element_markers=[0])
        try:
            report = replay_producer_provenance(
                paths,
                expected_source_run_id="run-1",
                expected_source_stage_id="relaxation-1",
                expected_source_stage_kind="relaxation",
                expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
            )
            self.assertEqual(
                report.source_context.mesh_topology_sha256,
                mesh_topology_fingerprint_v3({**_mesh([1])}),
            )
        finally:
            temp.cleanup()

    def test_plan_bytes_mutation_is_rejected_before_payload_replay(self) -> None:
        temp, paths = self._bundle()
        try:
            paths.producer_plan_path.write_bytes(paths.producer_plan_path.read_bytes() + b" ")
            with self.assertRaisesRegex(ProducerProvenanceReplayError, "plan file bytes"):
                replay_producer_provenance(
                    paths,
                    expected_source_run_id="run-1",
                    expected_source_stage_id="relaxation-1",
                    expected_source_stage_kind="relaxation",
                    expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
                )
        finally:
            temp.cleanup()

    def test_foreign_source_snapshot_is_rejected(self) -> None:
        temp, paths = self._bundle()
        try:
            with self.assertRaisesRegex(ProducerProvenanceReplayError, "source snapshot"):
                replay_producer_provenance(
                    paths,
                    expected_source_run_id="run-1",
                    expected_source_stage_id="relaxation-1",
                    expected_source_stage_kind="relaxation",
                    expected_source_snapshot_sha256="c" * 64,
                )
        finally:
            temp.cleanup()

    def test_source_snapshot_requires_raw_lowercase_hex(self) -> None:
        for mutation in ("prefixed", "uppercase", "missing"):
            with self.subTest(mutation=mutation):
                temp, paths = self._bundle()
                try:
                    provenance = json.loads(paths.provenance_path.read_text())
                    build = provenance["producer_build_identity"]
                    if mutation == "prefixed":
                        build["source_snapshot_sha256"] = "sha256:" + SOURCE_SNAPSHOT
                    elif mutation == "uppercase":
                        build["source_snapshot_sha256"] = SOURCE_SNAPSHOT.upper()
                    else:
                        build.pop("source_snapshot_sha256")
                    paths.provenance_path.write_text(json.dumps(provenance))
                    with self.assertRaisesRegex(
                        ProducerProvenanceReplayError, "source_snapshot_sha256"
                    ):
                        replay_producer_provenance(
                            paths,
                            expected_source_run_id="run-1",
                            expected_source_stage_id="relaxation-1",
                            expected_source_stage_kind="relaxation",
                            expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
                        )
                finally:
                    temp.cleanup()

    def test_expected_source_snapshot_rejects_prefixed_or_missing_form(self) -> None:
        temp, paths = self._bundle()
        try:
            for expected in ("sha256:" + SOURCE_SNAPSHOT, None):
                with self.subTest(expected=expected):
                    with self.assertRaisesRegex(
                        ProducerProvenanceReplayError, "expected_source_snapshot_sha256"
                    ):
                        replay_producer_provenance(
                            paths,
                            expected_source_run_id="run-1",
                            expected_source_stage_id="relaxation-1",
                            expected_source_stage_kind="relaxation",
                            expected_source_snapshot_sha256=expected,
                        )
        finally:
            temp.cleanup()

    def test_self_consistent_foreign_identity_fields_are_rejected(self) -> None:
        mutations = (
            ("source_run_id", "foreign-run", "source_run_id"),
            ("source_mesh_topology_sha256", "sha256:" + "c" * 64, "source_mesh_topology_sha256"),
            ("node_count", NODE_COUNT + 1, "node_count"),
            ("producer_plan_snapshot_sha256", "sha256:" + "d" * 64, "producer_plan_snapshot_sha256"),
            ("consumer_plan_snapshot_sha256", "not-a-digest", "consumer_plan_snapshot_sha256"),
            ("accepted_fields_content_sha256", "sha256:" + "e" * 64, "accepted_fields_content_sha256"),
        )
        for field, value, reason in mutations:
            temp, paths = self._bundle()
            try:
                _rewrite_identity_field(paths, field, value)
                with self.assertRaisesRegex(ProducerProvenanceReplayError, reason):
                    replay_producer_provenance(
                        paths,
                        expected_source_run_id="run-1",
                        expected_source_stage_id="relaxation-1",
                        expected_source_stage_kind="relaxation",
                        expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
                    )
            finally:
                temp.cleanup()

    def test_payload_raw_mutation_is_rejected(self) -> None:
        temp, paths = self._bundle()
        try:
            payload = paths.producer_root / "equilibrium" / "accepted_fem_equilibrium_fields.v1.json"
            payload.write_bytes(payload.read_bytes() + b"\n")
            with self.assertRaisesRegex(ProducerProvenanceReplayError, "raw bytes"):
                replay_producer_provenance(
                    paths,
                    expected_source_run_id="run-1",
                    expected_source_stage_id="relaxation-1",
                    expected_source_stage_kind="relaxation",
                    expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
                )
        finally:
            temp.cleanup()

    def test_m0_mutation_is_rejected_even_when_payloads_remain_unchanged(self) -> None:
        temp, paths = self._bundle()
        try:
            m0 = json.loads(paths.equilibrium_magnetization_path.read_text())
            m0["values"][0][0] = 0.25
            paths.equilibrium_magnetization_path.write_text(json.dumps(m0, separators=(",", ":")))
            with self.assertRaisesRegex(ProducerProvenanceReplayError, "equilibrium_content_sha256"):
                replay_producer_provenance(
                    paths,
                    expected_source_run_id="run-1",
                    expected_source_stage_id="relaxation-1",
                    expected_source_stage_kind="relaxation",
                    expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
                )
        finally:
            temp.cleanup()

    def test_payload_path_traversal_is_rejected(self) -> None:
        temp, paths = self._bundle()
        try:
            provenance = json.loads(paths.provenance_path.read_text())
            provenance["payloads"]["accepted_fields"]["path"] = "../accepted.json"
            paths.provenance_path.write_text(json.dumps(provenance))
            with self.assertRaisesRegex(ProducerProvenanceReplayError, "expected"):
                replay_producer_provenance(
                    paths,
                    expected_source_run_id="run-1",
                    expected_source_stage_id="relaxation-1",
                    expected_source_stage_kind="relaxation",
                    expected_source_snapshot_sha256=SOURCE_SNAPSHOT,
                )
        finally:
            temp.cleanup()


if __name__ == "__main__":
    unittest.main()
