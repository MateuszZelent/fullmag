from __future__ import annotations

from dataclasses import replace
from hashlib import sha256
from io import BytesIO
import inspect
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest import mock
import zipfile

import numpy as np

from fullmag import _core
from fullmag.meshing._certification_receipt import (
    CertificationReceiptBindingsV1,
    CertificationReceiptV2,
    ProducerBindingV1,
)
from fullmag.meshing._gmsh_types import (
    MeshData,
    MixedLayerTopologyCertificate,
    _TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
    _bind_trusted_topology_fingerprint_v3,
    _certificate_payload_sha256,
    _mint_trusted_native_preflight_receipt_proof,
)
from fullmag.meshing.persistence import (
    MeshArtifactCorruptionError,
    MeshArtifactVersionError,
    _load_mesh_artifact_forced_audit,
    _load_trusted_cached_mesh_artifact,
    load_mesh_artifact,
    save_mesh_artifact,
)


ROOT = Path(__file__).resolve().parents[3]
GOLDEN = (
    ROOT
    / "crates/fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
)
CERTIFIER_ALGORITHM = "fullmag.mixed-certificate.rust-rayon.v1"
REPAIR_ALGORITHM = "fullmag.mixed-tet-repair.v1"


def _native_available() -> bool:
    return _core._native_core is not None and hasattr(
        _core._native_core, "certify_mixed_mesh_arrays"
    )


def _certified_mesh() -> MeshData:
    payload = json.loads(GOLDEN.read_text(encoding="utf-8"))
    raw = payload["mesh"]
    cells = raw["cells"]
    facets = raw["facets"]
    unsigned = MeshData(
        nodes=np.asarray(raw["nodes"], dtype=np.float64),
        cell_types=np.asarray(cells["types"], dtype=np.str_),
        cell_offsets=np.asarray(cells["offsets"], dtype=np.int64),
        cell_nodes=np.asarray(cells["nodes"], dtype=np.int32),
        element_markers=np.asarray(raw["element_markers"], dtype=np.int32),
        cell_global_ordinals=np.asarray(cells["global_ordinals"], dtype=np.int64),
        cell_mesh_parts=np.asarray(cells["mesh_parts"], dtype=np.str_),
        facet_types=np.asarray(facets["types"], dtype=np.str_),
        facet_roles=np.asarray(facets["roles"], dtype=np.str_),
        facet_offsets=np.asarray(facets["offsets"], dtype=np.int64),
        facet_nodes=np.asarray(facets["nodes"], dtype=np.int32),
        boundary_markers=np.asarray(raw["boundary_markers"], dtype=np.int32),
        facet_global_ordinals=np.asarray(facets["global_ordinals"], dtype=np.int64),
        periodic_boundary_pairs=[],
        periodic_node_pairs=[],
    )
    raw_certificate = dict(payload["certificate"])
    for key in (
        "magnetic_plane_coordinates_m",
        "magnetic_bounds_min_m",
        "magnetic_bounds_max_m",
        "airbox_bounds_min_m",
        "airbox_bounds_max_m",
    ):
        raw_certificate[key] = [float(value) for value in raw_certificate[key]]
    for key in (
        "plane_tolerance_m",
        "transition_shell_thickness_m",
        "magnetic_bounds_relative_error",
        "airbox_bounds_relative_error",
        "magnetic_volume_m3",
        "expected_magnetic_volume_m3",
        "magnetic_relative_volume_error",
        "air_volume_m3",
        "shared_domain_volume_m3",
        "expected_shared_domain_volume_m3",
        "shared_domain_relative_volume_error",
    ):
        raw_certificate[key] = float(raw_certificate[key])
    for key in (
        "jacobian_minima_m3_by_family",
        "scaled_jacobian_minima_by_family",
        "scaled_jacobian_p05_by_family",
    ):
        raw_certificate[key] = {
            family: float(value) for family, value in raw_certificate[key].items()
        }
    certificate = MixedLayerTopologyCertificate.from_dict(raw_certificate)
    certificate = replace(
        certificate,
        topology_fingerprint_version="v3",
        topology_fingerprint=unsigned.topology_fingerprint_v3(),
    )
    return replace(unsigned, mixed_layer_topology_certificate=certificate)


def _bindings() -> CertificationReceiptBindingsV1:
    return CertificationReceiptBindingsV1(
        resolved_policy_sha256="a" * 64,
        source_snapshot_sha256="b" * 64,
        gmsh_version="4.15.2",
        repair_algorithm_id=REPAIR_ALGORITHM,
        repair_method="Relocate3D",
        repair_iterations=1,
        gmsh_threads=1,
        certifier_algorithm_id=CERTIFIER_ALGORITHM,
        certifier_backend="rust_rayon",
        certifier_threads=1,
    )


def _native_certificate_result(mesh: MeshData) -> _core.NativeMixedCertificateResult:
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    return _core.NativeMixedCertificateResult(
        evidence={},
        topology_fingerprint_v3=mesh.topology_fingerprint_v3(),
        certificate_payload_sha256=_certificate_payload_sha256(certificate),
        algorithm_id=CERTIFIER_ALGORITHM,
        rayon_threads=1,
        elapsed_ns=1,
        validated_claimed_certificate=True,
    )


def _native_preflight_result(mesh: MeshData) -> _core.NativeMixedPreflightResult:
    return _core.NativeMixedPreflightResult(
        counts={
            "nodes": mesh.n_nodes,
            "cells": mesh.n_elements,
            "facets": mesh.n_boundary_faces,
        },
        topology_fingerprint_v3=mesh.topology_fingerprint_v3(),
        elapsed_ns=1,
    )


def _read_members(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path, "r") as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def _write_members(path: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _rewrite_receipt(
    members: dict[str, bytes],
    mutate: object,
) -> None:
    receipt = json.loads(members["certification-receipt.json"])
    mutate(receipt)
    receipt_bytes = _canonical_json(receipt)
    members["certification-receipt.json"] = receipt_bytes
    manifest = json.loads(members["manifest.json"])
    manifest["members"]["certification-receipt.json"] = {
        "bytes": len(receipt_bytes),
        "sha256": sha256(receipt_bytes).hexdigest(),
    }
    members["manifest.json"] = _canonical_json(manifest)


def _rewrite_manifest(
    members: dict[str, bytes],
    mutate: object,
) -> None:
    manifest = json.loads(members["manifest.json"])
    mutate(manifest)
    members["manifest.json"] = _canonical_json(manifest)


class CertificationReceiptSchemaTests(unittest.TestCase):
    def test_receipt_is_frozen_deterministic_and_exact(self) -> None:
        payload = {
            "schema": "fullmag.mesh-certification-receipt.v2",
            "artifact_schema": "fullmag.mesh-artifact.v2",
            "topology_member": {
                "name": "topology.npz",
                "bytes": 7,
                "sha256": "1" * 64,
            },
            "build_report_member": {
                "name": "build-report.json",
                "bytes": 9,
                "sha256": "2" * 64,
            },
            "topology_fingerprint_v3": "3" * 64,
            "semantic_manifest_sha256": "8" * 64,
            "certificate": {
                "schema": "fullmag.mixed-layer-topology-certificate.v1",
                "payload_sha256": "4" * 64,
                "algorithm_id": CERTIFIER_ALGORITHM,
            },
            "authoring": {
                "document_sha256": "5" * 64,
                "resolved_policy_sha256": "6" * 64,
            },
            "producer": {
                "source_snapshot_sha256": "7" * 64,
                "gmsh_version": "4.15.2",
                "repair_algorithm_id": REPAIR_ALGORITHM,
                "repair_method": "Relocate3D",
                "repair_iterations": 1,
                "gmsh_threads": 1,
                "certifier_backend": "rust_rayon",
                "certifier_threads": 1,
            },
            "mesh_counts": {"nodes": 1, "cells": 2, "facets": 3},
        }
        receipt = CertificationReceiptV2.from_dict(payload)

        self.assertEqual(receipt.to_dict(), payload)
        self.assertEqual(receipt.to_json_bytes(), _canonical_json(payload))
        self.assertNotIn(b"timestamp", receipt.to_json_bytes())
        with self.assertRaises((AttributeError, TypeError)):
            receipt.topology_fingerprint_v3 = "8" * 64  # type: ignore[misc]

    def test_receipt_rejects_unknown_fields_future_schema_and_bad_values(self) -> None:
        base = CertificationReceiptV2.from_components(
            topology_bytes=b"topology",
            build_report_bytes=b"report",
            topology_fingerprint_v3="1" * 64,
            semantic_manifest_sha256="8" * 64,
            certificate_payload_sha256="2" * 64,
            authoring_document_sha256="3" * 64,
            bindings=_bindings(),
            mesh_counts={"nodes": 1, "cells": 1, "facets": 1},
        ).to_dict()
        attacks = {
            "unknown": lambda value: value.update({"unknown": True}),
            "future schema": lambda value: value.update(
                {"schema": "fullmag.mesh-certification-receipt.v3"}
            ),
            "upper digest": lambda value: value["authoring"].update(
                {"document_sha256": "A" * 64}
            ),
            "zero count": lambda value: value["mesh_counts"].update({"nodes": 0}),
            "wrong method": lambda value: value["producer"].update(
                {"repair_method": "Netgen"}
            ),
        }
        for name, attack in attacks.items():
            with self.subTest(name=name):
                candidate = json.loads(json.dumps(base))
                attack(candidate)
                with self.assertRaises(ValueError):
                    CertificationReceiptV2.from_dict(candidate)

    def test_producer_integer_fields_reject_bool_and_float_in_both_constructors(
        self,
    ) -> None:
        producer = CertificationReceiptV2.from_components(
            topology_bytes=b"topology",
            build_report_bytes=b"report",
            topology_fingerprint_v3="1" * 64,
            semantic_manifest_sha256="8" * 64,
            certificate_payload_sha256="2" * 64,
            authoring_document_sha256="3" * 64,
            bindings=_bindings(),
            mesh_counts={"nodes": 1, "cells": 1, "facets": 1},
        ).producer.to_dict()

        for field_name in ("repair_iterations", "gmsh_threads"):
            for invalid_value in (True, 1.0):
                with self.subTest(
                    constructor="direct",
                    field=field_name,
                    value=invalid_value,
                ):
                    direct = dict(producer)
                    direct[field_name] = invalid_value
                    with self.assertRaises(ValueError):
                        ProducerBindingV1(**direct)
                with self.subTest(
                    constructor="from_dict",
                    field=field_name,
                    value=invalid_value,
                ):
                    mapped = dict(producer)
                    mapped[field_name] = invalid_value
                    with self.assertRaises(ValueError):
                        ProducerBindingV1.from_dict(mapped)


class MeshArtifactTrustTests(unittest.TestCase):
    @unittest.skipUnless(
        _native_available(), "real _fullmag_core extension is unavailable"
    )
    def test_real_extension_v2_save_full_audit_and_trusted_preflight(self) -> None:
        mesh = _certified_mesh()
        certificate = mesh.mixed_layer_topology_certificate
        assert certificate is not None
        probe = _core.certify_mixed_mesh_arrays(
            mesh=mesh,
            metadata={"mesh_name": "mixed-domain"},
            certificate=certificate.to_dict(),
            require_native=True,
        )
        assert probe is not None
        bindings = replace(_bindings(), certifier_threads=probe.rayon_threads)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            save_mesh_artifact(
                path,
                mesh=mesh,
                mesh_name="mixed-domain",
                authoring_document={"mesh": {"topology": "prismatic"}},
                region_markers=[{"geometry_name": "magnet", "marker": 1}],
                boundary_map={"outer": 3, "material_interface": 2},
                build_report={"build_mode": "mixed", "fallbacks_triggered": []},
                provenance={"origin": "generated"},
                certification_bindings=bindings,
            )
            full = load_mesh_artifact(path)
            fast = self._trusted(path, mesh)

        self.assertEqual(full.provenance["artifact_trust"], "portable_full_audit")
        self.assertEqual(fast.provenance["artifact_trust"], "trusted_cache_fast")
        self.assertEqual(
            fast.mesh.topology_fingerprint_v3(), mesh.topology_fingerprint_v3()
        )

    def test_owner_minted_native_preflight_proof_rejects_forgery_without_recompute(
        self,
    ) -> None:
        signed = _certified_mesh()
        certificate = signed.mixed_layer_topology_certificate
        assert certificate is not None
        unsigned = replace(signed, mixed_layer_topology_certificate=None)
        preflight = _native_preflight_result(unsigned)
        digest = _certificate_payload_sha256(certificate)
        counts = preflight.counts
        topology_context = _bind_trusted_topology_fingerprint_v3(
            mesh_without_certificate=unsigned,
            _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
        )
        with mock.patch(
            "fullmag.meshing._gmsh_types._recompute_mixed_certificate_evidence",
            side_effect=AssertionError("trusted proof recomputed Python evidence"),
        ):
            proof = _mint_trusted_native_preflight_receipt_proof(
                mesh_without_certificate=unsigned,
                certificate=certificate,
                native_preflight=preflight,
                topology_context=topology_context,
                expected_topology_fingerprint_v3=preflight.topology_fingerprint_v3,
                expected_certificate_payload_sha256=digest,
                expected_counts=counts,
                _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
            )
            rebuilt = MeshData._from_trusted_native_preflight_receipt(
                mesh_without_certificate=unsigned,
                certificate=certificate,
                proof=proof,
            )
        self.assertIs(rebuilt.mixed_layer_topology_certificate, certificate)

        forged_proof = replace(proof)
        with self.assertRaisesRegex(ValueError, "owner-minted"):
            MeshData._from_trusted_native_preflight_receipt(
                mesh_without_certificate=unsigned,
                certificate=certificate,
                proof=forged_proof,
            )
        with self.assertRaises(TypeError):
            _mint_trusted_native_preflight_receipt_proof(
                mesh_without_certificate=unsigned,
                certificate=certificate,
                native_preflight={"counts": counts},
                topology_context=topology_context,
                expected_topology_fingerprint_v3=preflight.topology_fingerprint_v3,
                expected_certificate_payload_sha256=digest,
                expected_counts=counts,
                _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
            )
        altered = (
            replace(preflight, topology_fingerprint_v3="c" * 64),
            replace(preflight, counts={**counts, "cells": counts["cells"] + 1}),
        )
        for candidate in altered:
            with self.assertRaises(ValueError):
                _mint_trusted_native_preflight_receipt_proof(
                    mesh_without_certificate=unsigned,
                    certificate=certificate,
                    native_preflight=candidate,
                    topology_context=topology_context,
                    expected_topology_fingerprint_v3=preflight.topology_fingerprint_v3,
                    expected_certificate_payload_sha256=digest,
                    expected_counts=counts,
                    _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
                )
        with self.assertRaises(ValueError):
            _mint_trusted_native_preflight_receipt_proof(
                mesh_without_certificate=unsigned,
                certificate=certificate,
                native_preflight=preflight,
                topology_context=topology_context,
                expected_topology_fingerprint_v3=preflight.topology_fingerprint_v3,
                expected_certificate_payload_sha256="c" * 64,
                expected_counts=counts,
                _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
            )

    def test_trusted_receipt_attach_rejects_mesh_mutation_after_proof_minting(
        self,
    ) -> None:
        signed = _certified_mesh()
        certificate = signed.mixed_layer_topology_certificate
        assert certificate is not None

        for mutation in ("nodes", "cell_nodes", "element_markers"):
            with self.subTest(mutation=mutation):
                unsigned = replace(
                    signed,
                    nodes=np.array(signed.nodes, copy=True),
                    cell_nodes=np.array(signed.cell_nodes, copy=True),
                    element_markers=np.array(signed.element_markers, copy=True),
                    mixed_layer_topology_certificate=None,
                )
                topology_context = _bind_trusted_topology_fingerprint_v3(
                    mesh_without_certificate=unsigned,
                    _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
                )
                preflight = _native_preflight_result(unsigned)
                proof = _mint_trusted_native_preflight_receipt_proof(
                    mesh_without_certificate=unsigned,
                    certificate=certificate,
                    native_preflight=preflight,
                    topology_context=topology_context,
                    expected_topology_fingerprint_v3=preflight.topology_fingerprint_v3,
                    expected_certificate_payload_sha256=_certificate_payload_sha256(
                        certificate
                    ),
                    expected_counts=preflight.counts,
                    _receipt_capability=_TRUSTED_NATIVE_PREFLIGHT_RECEIPT_CAPABILITY,
                )

                if mutation == "nodes":
                    unsigned.nodes[0, 0] += 1.0e-15
                elif mutation == "cell_nodes":
                    unsigned.cell_nodes[:2] = unsigned.cell_nodes[1::-1]
                else:
                    unsigned.element_markers[0] = (
                        2 if unsigned.element_markers[0] == 1 else 1
                    )

                with self.assertRaisesRegex(ValueError, "topology"):
                    MeshData._from_trusted_native_preflight_receipt(
                        mesh_without_certificate=unsigned,
                        certificate=certificate,
                        proof=proof,
                    )

    def _save_v2(self, path: Path) -> MeshData:
        mesh = _certified_mesh()
        with mock.patch(
            "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
            return_value=_native_certificate_result(mesh),
        ) as certify:
            save_mesh_artifact(
                path,
                mesh=mesh,
                mesh_name="mixed-domain",
                authoring_document={"mesh": {"topology": "prismatic"}},
                region_markers=[{"geometry_name": "magnet", "marker": 1}],
                boundary_map={
                    "outer": 3,
                    "material_interface": 2,
                },
                build_report={"build_mode": "mixed", "fallbacks_triggered": []},
                provenance={"origin": "generated"},
                certification_bindings=_bindings(),
            )
        certify.assert_called_once()
        self.assertTrue(certify.call_args.kwargs["require_native"])
        return mesh

    def _trusted(self, path: Path, mesh: MeshData):
        return _load_trusted_cached_mesh_artifact(
            path,
            expected_authoring_sha256=sha256(
                _canonical_json({"mesh": {"topology": "prismatic"}})
            ).hexdigest(),
            expected_policy_sha256="a" * 64,
            expected_source_snapshot_sha256="b" * 64,
            expected_gmsh_version="4.15.2",
            expected_repair_algorithm_id=REPAIR_ALGORITHM,
            expected_certifier_algorithm_id=CERTIFIER_ALGORITHM,
        )

    def test_v2_manifest_has_acyclic_receipt_binding(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            mesh = self._save_v2(path)
            members = _read_members(path)
            manifest = json.loads(members["manifest.json"])
            receipt = json.loads(members["certification-receipt.json"])

        self.assertEqual(manifest["schema"], "fullmag.mesh-artifact.v2")
        self.assertEqual(
            set(manifest["members"]),
            {"topology.npz", "build-report.json", "certification-receipt.json"},
        )
        self.assertNotIn("manifest", receipt)
        self.assertEqual(
            receipt["topology_fingerprint_v3"],
            mesh.topology_fingerprint_v3().removeprefix("sha256:"),
        )
        self.assertNotIn("created_at", receipt)

    def test_generic_mesh_uses_legacy_v1_and_never_fast_path(self) -> None:
        mesh = _certified_mesh()
        unsigned = replace(mesh, mixed_layer_topology_certificate=None)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "generic.fullmag-mesh"
            save_mesh_artifact(
                path,
                mesh=unsigned,
                mesh_name="generic",
                authoring_document={},
                region_markers=[{"geometry_name": "magnet", "marker": 1}],
                boundary_map={"outer": 3, "material_interface": 2},
            )
            manifest = json.loads(_read_members(path)["manifest.json"])
            self.assertEqual(manifest["schema"], "fullmag.mesh-artifact.v1")
            with self.assertRaisesRegex(MeshArtifactVersionError, "v1.*trusted"):
                self._trusted(path, unsigned)

    def test_artifact_v2_with_legacy_receipt_v1_is_full_audit_only(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy-receipt.fullmag-mesh"
            mesh = self._save_v2(path)
            members = _read_members(path)
            _rewrite_receipt(
                members,
                lambda receipt: (
                    receipt.update({"schema": "fullmag.mesh-certification-receipt.v1"}),
                    receipt.pop("semantic_manifest_sha256"),
                ),
            )
            _write_members(path, members)
            with mock.patch(
                "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                return_value=_native_certificate_result(mesh),
            ):
                with self.subTest(mode="full"):
                    artifact = load_mesh_artifact(path)
                    self.assertEqual(
                        artifact.provenance["artifact_trust"],
                        "portable_full_audit",
                    )
                with self.subTest(mode="trusted"):
                    with self.assertRaisesRegex(
                        MeshArtifactVersionError,
                        "receipt v1.*trusted",
                    ):
                        self._trusted(path, mesh)

    def test_forced_audit_of_certified_v1_requires_native_certificate(self) -> None:
        mesh = _certified_mesh()
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy-mixed.fullmag-mesh"
            save_mesh_artifact(
                path,
                mesh=mesh,
                mesh_name="mixed-domain",
                authoring_document={"mesh": {"topology": "prismatic"}},
                region_markers=[{"geometry_name": "magnet", "marker": 1}],
                boundary_map={"outer": 3, "material_interface": 2},
            )
            with mock.patch(
                "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                return_value=_native_certificate_result(mesh),
            ) as certify:
                artifact = _load_mesh_artifact_forced_audit(path)

        certify.assert_called_once()
        self.assertTrue(certify.call_args.kwargs["require_native"])
        self.assertEqual(artifact.provenance["artifact_trust"], "legacy_v1_full_audit")

    def test_public_loader_has_no_trust_or_skip_flag(self) -> None:
        parameters = inspect.signature(load_mesh_artifact).parameters
        self.assertNotIn("trusted", parameters)
        self.assertNotIn("skip_validation", parameters)

    def test_public_full_audit_calls_native_certificate_and_records_backend(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            mesh = self._save_v2(path)
            with mock.patch(
                "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                return_value=_native_certificate_result(mesh),
            ) as certify:
                artifact = load_mesh_artifact(path)

        certify.assert_called_once()
        self.assertFalse(certify.call_args.kwargs["require_native"])
        self.assertEqual(artifact.provenance["certifier_backend"], "rust_rayon")
        self.assertTrue(artifact.provenance["production_qualified"])
        self.assertEqual(artifact.provenance["artifact_trust"], "portable_full_audit")

    def test_public_full_audit_python_fallback_is_explicitly_not_production(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            self._save_v2(path)
            with mock.patch(
                "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                return_value=None,
            ):
                artifact = load_mesh_artifact(path)

        self.assertEqual(artifact.provenance["certifier_backend"], "python_reference")
        self.assertFalse(artifact.provenance["production_qualified"])
        self.assertEqual(artifact.provenance["artifact_trust"], "portable_full_audit")

    def test_forced_audit_requires_native_certificate(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            self._save_v2(path)
            with mock.patch(
                "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                side_effect=RuntimeError("native mixed mesh certifier is required"),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "native mixed mesh certifier is required"
                ):
                    _load_mesh_artifact_forced_audit(path)

    def test_trusted_path_uses_native_preflight_without_full_certificate(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            mesh = self._save_v2(path)
            with (
                mock.patch(
                    "fullmag.meshing.persistence.preflight_mixed_mesh_arrays",
                    return_value=_native_preflight_result(mesh),
                ) as preflight,
                mock.patch(
                    "fullmag.meshing.persistence.certify_mixed_mesh_arrays"
                ) as certify,
                mock.patch(
                    "fullmag.meshing._gmsh_types._recompute_mixed_certificate_evidence",
                    side_effect=AssertionError(
                        "trusted path recomputed Python evidence"
                    ),
                ),
            ):
                artifact = self._trusted(path, mesh)

        preflight.assert_called_once()
        self.assertFalse(preflight.call_args.kwargs["require_native"])
        certify.assert_not_called()
        self.assertIsNotNone(artifact.mesh.mixed_layer_topology_certificate)
        self.assertEqual(artifact.provenance["artifact_trust"], "trusted_cache_fast")

    def test_trusted_path_computes_python_topology_fingerprint_twice(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            mesh = self._save_v2(path)
            native_preflight = _native_preflight_result(mesh)
            original = MeshData.topology_fingerprint_v3
            fingerprint_calls = 0

            def counted_fingerprint(subject: MeshData) -> str:
                nonlocal fingerprint_calls
                fingerprint_calls += 1
                return original(subject)

            with (
                mock.patch.object(
                    MeshData,
                    "topology_fingerprint_v3",
                    counted_fingerprint,
                ),
                mock.patch(
                    "fullmag.meshing.persistence.preflight_mixed_mesh_arrays",
                    return_value=native_preflight,
                ),
            ):
                self._trusted(path, mesh)

        self.assertEqual(fingerprint_calls, 2)

    def test_missing_native_preflight_bypasses_fast_and_runs_public_full_audit(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            mesh = self._save_v2(path)
            with (
                mock.patch(
                    "fullmag.meshing.persistence.preflight_mixed_mesh_arrays",
                    return_value=None,
                ),
                mock.patch(
                    "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                    return_value=_native_certificate_result(mesh),
                ) as certify,
            ):
                artifact = self._trusted(path, mesh)

        certify.assert_called_once()
        self.assertEqual(
            artifact.provenance["artifact_trust"],
            "bypassed_native_unavailable",
        )

    def test_unknown_future_artifact_schema_is_rejected(self) -> None:
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "mixed.fullmag-mesh"
            self._save_v2(path)
            members = _read_members(path)
            manifest = json.loads(members["manifest.json"])
            manifest["schema"] = "fullmag.mesh-artifact.v3"
            members["manifest.json"] = _canonical_json(manifest)
            _write_members(path, members)
            with self.assertRaises(MeshArtifactVersionError):
                load_mesh_artifact(path)
            with self.assertRaises(MeshArtifactVersionError):
                self._trusted(path, _certified_mesh())

    def test_tamper_matrix_fails_closed_in_fast_and_full_modes(self) -> None:
        attacks = {
            "raw topology byte": self._tamper_raw_topology,
            "connectivity with fresh zip crc": self._tamper_connectivity,
            "certificate payload": lambda members: self._tamper_certificate(members),
            "authoring document hash": lambda members: _rewrite_receipt(
                members,
                lambda receipt: receipt["authoring"].update(
                    {"document_sha256": "c" * 64}
                ),
            ),
            "resolved policy hash": lambda members: _rewrite_receipt(
                members,
                lambda receipt: receipt["authoring"].update(
                    {"resolved_policy_sha256": "c" * 64}
                ),
            ),
            "gmsh version": lambda members: _rewrite_receipt(
                members,
                lambda receipt: receipt["producer"].update({"gmsh_version": "4.14.1"}),
            ),
            "repair method": lambda members: _rewrite_receipt(
                members,
                lambda receipt: receipt["producer"].update({"repair_method": "Netgen"}),
            ),
            "certifier algorithm": lambda members: _rewrite_receipt(
                members,
                lambda receipt: receipt["certificate"].update(
                    {"algorithm_id": "fullmag.mixed-certificate.rust-rayon.v2"}
                ),
            ),
            "mesh counts": lambda members: _rewrite_receipt(
                members,
                lambda receipt: receipt["mesh_counts"].update(
                    {"cells": receipt["mesh_counts"]["cells"] + 1}
                ),
            ),
            "build report": self._tamper_build_report,
            "receipt digest": self._tamper_receipt_digest,
            "member length": self._tamper_member_length,
            "topology fingerprint": lambda members: _rewrite_receipt(
                members,
                lambda receipt: receipt.update({"topology_fingerprint_v3": "c" * 64}),
            ),
        }
        for name, attack in attacks.items():
            with self.subTest(name=name), TemporaryDirectory() as tmp:
                path = Path(tmp) / "mixed.fullmag-mesh"
                mesh = self._save_v2(path)
                members = _read_members(path)
                attack(members)
                _write_members(path, members)
                with (
                    mock.patch(
                        "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                        return_value=_native_certificate_result(mesh),
                    ),
                    mock.patch(
                        "fullmag.meshing.persistence.preflight_mixed_mesh_arrays",
                        return_value=_native_preflight_result(mesh),
                    ),
                ):
                    with self.assertRaises((MeshArtifactCorruptionError, ValueError)):
                        load_mesh_artifact(path)
                    with self.assertRaises((MeshArtifactCorruptionError, ValueError)):
                        self._trusted(path, mesh)

    def test_semantic_manifest_tamper_fails_closed_in_fast_and_full_modes(
        self,
    ) -> None:
        attacks = {
            "region geometry name": lambda members: _rewrite_manifest(
                members,
                lambda manifest: manifest["region_markers"][0].update(
                    {"geometry_name": "renamed-magnet"}
                ),
            ),
            "object region markers": lambda members: _rewrite_manifest(
                members,
                lambda manifest: manifest["object_region_markers"].append(
                    {"geometry_name": "forged-object", "marker": 1}
                ),
            ),
            "boundary meanings": lambda members: _rewrite_manifest(
                members,
                lambda manifest: manifest.update(
                    {
                        "boundary_map": {
                            "outer": manifest["boundary_map"]["material_interface"],
                            "material_interface": manifest["boundary_map"]["outer"],
                        }
                    }
                ),
            ),
        }
        for name, attack in attacks.items():
            with TemporaryDirectory() as tmp:
                path = Path(tmp) / "mixed.fullmag-mesh"
                mesh = self._save_v2(path)
                members = _read_members(path)
                attack(members)
                _write_members(path, members)
                with (
                    mock.patch(
                        "fullmag.meshing.persistence.certify_mixed_mesh_arrays",
                        return_value=_native_certificate_result(mesh),
                    ),
                    mock.patch(
                        "fullmag.meshing.persistence.preflight_mixed_mesh_arrays",
                        return_value=_native_preflight_result(mesh),
                    ),
                ):
                    for mode, loader in (
                        ("full", lambda: load_mesh_artifact(path)),
                        ("trusted", lambda: self._trusted(path, mesh)),
                    ):
                        with self.subTest(name=name, mode=mode):
                            with self.assertRaises(MeshArtifactCorruptionError):
                                loader()

    @staticmethod
    def _tamper_raw_topology(members: dict[str, bytes]) -> None:
        payload = bytearray(members["topology.npz"])
        payload[len(payload) // 2] ^= 1
        members["topology.npz"] = bytes(payload)

    @staticmethod
    def _tamper_connectivity(members: dict[str, bytes]) -> None:
        with np.load(BytesIO(members["topology.npz"]), allow_pickle=False) as data:
            arrays = {name: data[name] for name in data.files}
        nodes = np.array(arrays["cell_nodes"], copy=True)
        nodes[0], nodes[1] = nodes[1], nodes[0]
        arrays["cell_nodes"] = nodes
        stream = BytesIO()
        np.savez_compressed(stream, **arrays)
        topology = stream.getvalue()
        members["topology.npz"] = topology
        manifest = json.loads(members["manifest.json"])
        manifest["members"]["topology.npz"] = {
            "bytes": len(topology),
            "sha256": sha256(topology).hexdigest(),
        }
        members["manifest.json"] = _canonical_json(manifest)

    @staticmethod
    def _tamper_certificate(members: dict[str, bytes]) -> None:
        with np.load(BytesIO(members["topology.npz"]), allow_pickle=False) as data:
            arrays = {name: data[name] for name in data.files}
        metadata = json.loads(str(arrays["metadata_json"]))
        metadata["mixed_layer_topology_certificate"]["gmsh_version"] = "4.14.1"
        arrays["metadata_json"] = np.asarray(json.dumps(metadata, sort_keys=True))
        stream = BytesIO()
        np.savez_compressed(stream, **arrays)
        topology = stream.getvalue()
        members["topology.npz"] = topology
        receipt = json.loads(members["certification-receipt.json"])
        receipt["topology_member"] = {
            "name": "topology.npz",
            "bytes": len(topology),
            "sha256": sha256(topology).hexdigest(),
        }
        receipt_bytes = _canonical_json(receipt)
        members["certification-receipt.json"] = receipt_bytes
        manifest = json.loads(members["manifest.json"])
        manifest["members"]["topology.npz"] = dict(receipt["topology_member"])
        manifest["members"]["topology.npz"].pop("name")
        manifest["members"]["certification-receipt.json"] = {
            "bytes": len(receipt_bytes),
            "sha256": sha256(receipt_bytes).hexdigest(),
        }
        members["manifest.json"] = _canonical_json(manifest)

    @staticmethod
    def _tamper_build_report(members: dict[str, bytes]) -> None:
        report = json.loads(members["build-report.json"])
        report["build_mode"] = "tampered"
        report_bytes = _canonical_json(report)
        members["build-report.json"] = report_bytes
        manifest = json.loads(members["manifest.json"])
        manifest["members"]["build-report.json"] = {
            "bytes": len(report_bytes),
            "sha256": sha256(report_bytes).hexdigest(),
        }
        members["manifest.json"] = _canonical_json(manifest)

    @staticmethod
    def _tamper_receipt_digest(members: dict[str, bytes]) -> None:
        manifest = json.loads(members["manifest.json"])
        manifest["members"]["certification-receipt.json"]["sha256"] = "c" * 64
        members["manifest.json"] = _canonical_json(manifest)

    @staticmethod
    def _tamper_member_length(members: dict[str, bytes]) -> None:
        manifest = json.loads(members["manifest.json"])
        manifest["members"]["topology.npz"]["bytes"] += 1
        members["manifest.json"] = _canonical_json(manifest)


if __name__ == "__main__":
    unittest.main()
