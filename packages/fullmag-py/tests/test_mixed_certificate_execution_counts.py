from __future__ import annotations

from dataclasses import replace
from unittest import TestCase
from unittest.mock import Mock, patch

import numpy as np

import fullmag as fm
import fullmag.meshing._gmsh_airbox as gmsh_airbox
import fullmag.meshing._gmsh_types as gmsh_types
from fullmag.meshing._gmsh_swept import (
    SWEEP_STRATEGY_PRISM,
    generate_swept_box_mesh,
)
from fullmag.meshing.persistence import _deserialize_mesh, _serialize_mesh


class MixedCertificateExecutionCountTests(TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        body_size = (4.0e-6, 2.0e-6, 0.2e-6)
        airbox_size = tuple(value + 4.0e-6 for value in body_size)
        airbox = fm.meshing.AirboxOptions(
            shape="bbox",
            size=airbox_size,
            center=(0.0, 0.0, 0.0),
            boundary_marker=99,
            minimum_element_size=0.4e-6,
            maximum_element_size=1.2e-6,
            grading_ratio=1.3,
            grading_mode="geometric",
        )
        mesh = generate_swept_box_mesh(
            body_size,
            hmax=0.8e-6,
            n_layers=1,
            thin_axis=2,
            order=1,
            distribution="fixed",
            airbox=airbox,
            options=gmsh_types.MeshOptions(mesh_strategy=SWEEP_STRATEGY_PRISM),
        )
        cls.body_size = body_size
        cls.airbox_bounds_min = tuple(-0.5 * value for value in airbox_size)
        cls.airbox_bounds_max = tuple(0.5 * value for value in airbox_size)
        cls.mesh = mesh
        cls.mesh_without_certificate = replace(
            mesh,
            mixed_layer_topology_certificate=None,
        )

    def _prevalidated_certificate(
        self,
    ) -> gmsh_types._PrevalidatedMixedCertificate:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        return gmsh_types._validate_and_create_prevalidated_mixed_certificate(
            self.mesh_without_certificate,
            certificate=certificate,
            canonical_evidence=self._carrier(),
        )

    def _evidence(self) -> dict[str, object]:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        return gmsh_types._recompute_mixed_certificate_evidence(
            self.mesh_without_certificate,
            sweep_axis=2,
            interface_marker=certificate.interface_marker,
            outer_boundary_marker=certificate.outer_boundary_marker,
            magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
            magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
            airbox_bounds_min_m=certificate.airbox_bounds_min_m,
            airbox_bounds_max_m=certificate.airbox_bounds_max_m,
        )

    def _workspace(self) -> gmsh_types._MixedTopologyWorkspace:
        return gmsh_types._build_mixed_topology_workspace(
            self.mesh_without_certificate,
            sweep_axis=2,
            interface_marker=10,
        )

    def _carrier(self) -> gmsh_types._CanonicalMixedCertificateEvidence:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        workspace = self._workspace()
        return gmsh_types._recompute_and_bind_mixed_certificate_evidence(
            self.mesh_without_certificate,
            sweep_axis=2,
            interface_marker=certificate.interface_marker,
            outer_boundary_marker=certificate.outer_boundary_marker,
            magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
            magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
            airbox_bounds_min_m=certificate.airbox_bounds_min_m,
            airbox_bounds_max_m=certificate.airbox_bounds_max_m,
            workspace=workspace,
        )

    def test_certificate_producer_recomputes_evidence_once(self) -> None:
        original = gmsh_types._recompute_mixed_certificate_evidence
        recompute = Mock(wraps=original)

        with patch.object(
            gmsh_types,
            "_recompute_mixed_certificate_evidence",
            recompute,
        ):
            gmsh_airbox._attach_mixed_layer_topology_certificate(
                self.mesh_without_certificate,
                body_size_m=self.body_size,
                airbox_bounds_min_m=self.airbox_bounds_min,
                airbox_bounds_max_m=self.airbox_bounds_max,
                requested_axis=2,
                requested_layers=1,
                gmsh_version="4.15.2",
                cell_mesh_parts=self.mesh_without_certificate.cell_mesh_parts,
                outer_boundary_marker=99,
                effective_gmsh_thread_count=1,
            )

        self.assertEqual(recompute.call_count, 1)

    def test_public_meshdata_constructor_recomputes_certificate(self) -> None:
        original = gmsh_types._recompute_mixed_certificate_evidence
        recompute = Mock(wraps=original)

        with patch.object(
            gmsh_types,
            "_recompute_mixed_certificate_evidence",
            recompute,
        ):
            replace(self.mesh)

        self.assertEqual(recompute.call_count, 1)

    def test_artifact_deserialize_recomputes_certificate_in_full_audit_mode(
        self,
    ) -> None:
        payload = _serialize_mesh(self.mesh)
        original = gmsh_types._recompute_mixed_certificate_evidence
        recompute = Mock(wraps=original)

        with patch.object(
            gmsh_types,
            "_recompute_mixed_certificate_evidence",
            recompute,
        ):
            _deserialize_mesh(payload)

        self.assertEqual(recompute.call_count, 1)

    def test_prevalidated_attach_rejects_different_topology_fingerprint(self) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        validation = replace(
            self._prevalidated_certificate(),
            topology_fingerprint_v3="sha256:" + "0" * 64,
        )

        with self.assertRaisesRegex(ValueError, "topology fingerprint"):
            gmsh_types.MeshData._from_prevalidated_mixed_certificate(
                mesh_without_certificate=self.mesh_without_certificate,
                validation=validation,
                token=gmsh_types._PREVALIDATED_MIXED_CERTIFICATE_TOKEN,
            )

    def test_prevalidated_attach_rejects_mutated_certificate_payload(self) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        validation = self._prevalidated_certificate()
        mutated = replace(
            certificate,
            transition_shell_thickness_m=(
                certificate.transition_shell_thickness_m * 1.01
            ),
        )
        forged = replace(validation, certificate=mutated)

        with self.assertRaisesRegex(ValueError, "certificate payload"):
            gmsh_types.MeshData._from_prevalidated_mixed_certificate(
                mesh_without_certificate=self.mesh_without_certificate,
                validation=forged,
                token=gmsh_types._PREVALIDATED_MIXED_CERTIFICATE_TOKEN,
            )

    def test_prevalidated_attach_rejects_resigned_claim_without_validated_evidence(
        self,
    ) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        proof = gmsh_types._validate_and_create_prevalidated_mixed_certificate(
            self.mesh_without_certificate,
            certificate=certificate,
            canonical_evidence=self._carrier(),
        )
        mutated = replace(
            certificate,
            transition_shell_thickness_m=(
                certificate.transition_shell_thickness_m * 1.01
            ),
        )
        forged = replace(
            proof,
            certificate=mutated,
            certificate_payload_sha256=gmsh_types._certificate_payload_sha256(
                mutated
            ),
        )

        with self.assertRaisesRegex(ValueError, "transition_shell_thickness_m"):
            gmsh_types.MeshData._from_prevalidated_mixed_certificate(
                mesh_without_certificate=self.mesh_without_certificate,
                validation=forged,
                token=gmsh_types._PREVALIDATED_MIXED_CERTIFICATE_TOKEN,
            )

    def test_workspace_rejects_different_mesh_and_sweep_axis(self) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        workspace = self._workspace()
        changed_nodes = np.array(self.mesh_without_certificate.nodes, copy=True)
        changed_nodes[0, 0] += 1.0e-15
        changed_mesh = replace(
            self.mesh_without_certificate,
            nodes=changed_nodes,
        )
        kwargs = dict(
            interface_marker=certificate.interface_marker,
            outer_boundary_marker=certificate.outer_boundary_marker,
            magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
            magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
            airbox_bounds_min_m=certificate.airbox_bounds_min_m,
            airbox_bounds_max_m=certificate.airbox_bounds_max_m,
            workspace=workspace,
        )

        with self.assertRaisesRegex(ValueError, "workspace topology fingerprint"):
            gmsh_types._recompute_mixed_certificate_evidence(
                changed_mesh,
                sweep_axis=2,
                **kwargs,
            )
        with self.assertRaisesRegex(ValueError, "workspace sweep axis"):
            gmsh_types._recompute_mixed_certificate_evidence(
                self.mesh_without_certificate,
                sweep_axis=0,
                **kwargs,
            )
        with self.assertRaisesRegex(ValueError, "workspace interface marker"):
            gmsh_types._recompute_mixed_certificate_evidence(
                self.mesh_without_certificate,
                sweep_axis=2,
                **{**kwargs, "interface_marker": 11},
            )

    def test_workspace_mappings_and_arrays_are_immutable(self) -> None:
        workspace = self._workspace()
        first_face = next(iter(workspace.face_owners))

        with self.assertRaises(TypeError):
            workspace.face_owners[first_face] = ()  # type: ignore[index]
        with self.assertRaises(ValueError):
            workspace.cell_absolute_volumes[0] = 0.0
        with self.assertRaises(ValueError):
            workspace.cell_nodes_per_ordinal[0][0] = 0

    def test_evidence_builds_one_workspace_and_one_face_adjacency_with_parity(
        self,
    ) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        kwargs = dict(
            sweep_axis=2,
            interface_marker=certificate.interface_marker,
            outer_boundary_marker=certificate.outer_boundary_marker,
            magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
            magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
            airbox_bounds_min_m=certificate.airbox_bounds_min_m,
            airbox_bounds_max_m=certificate.airbox_bounds_max_m,
        )
        original_build = gmsh_types._build_mixed_topology_workspace
        original_adjacency = gmsh_types._mixed_face_adjacency
        original_volume = gmsh_types._mixed_cell_signed_and_absolute_volume
        build = Mock(wraps=original_build)
        adjacency = Mock(wraps=original_adjacency)
        volume = Mock(wraps=original_volume)
        with (
            patch.object(gmsh_types, "_build_mixed_topology_workspace", build),
            patch.object(gmsh_types, "_mixed_face_adjacency", adjacency),
            patch.object(
                gmsh_types,
                "_mixed_cell_signed_and_absolute_volume",
                volume,
            ),
        ):
            implicit = gmsh_types._recompute_mixed_certificate_evidence(
                self.mesh_without_certificate,
                **kwargs,
            )

        self.assertEqual(build.call_count, 1)
        self.assertEqual(adjacency.call_count, 1)
        self.assertEqual(volume.call_count, self.mesh_without_certificate.n_elements)
        workspace = original_build(
            self.mesh_without_certificate,
            sweep_axis=2,
            interface_marker=certificate.interface_marker,
        )
        with (
            patch.object(
                gmsh_types,
                "_build_mixed_topology_workspace",
                side_effect=AssertionError("workspace rebuilt"),
            ),
            patch.object(
                gmsh_types,
                "_mixed_face_adjacency",
                side_effect=AssertionError("adjacency rebuilt"),
            ),
        ):
            explicit = gmsh_types._recompute_mixed_certificate_evidence(
                self.mesh_without_certificate,
                workspace=workspace,
                **kwargs,
            )

        self.assertEqual(explicit, implicit)

    def test_public_audit_rejects_stale_fingerprint_before_workspace_build(
        self,
    ) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        stale = replace(
            certificate,
            topology_fingerprint="sha256:" + "0" * 64,
        )

        with patch.object(
            gmsh_types,
            "_build_mixed_topology_workspace",
            side_effect=AssertionError("workspace built before fingerprint gate"),
        ) as build:
            with self.assertRaisesRegex(ValueError, "topology fingerprint is stale"):
                replace(
                    self.mesh_without_certificate,
                    mixed_layer_topology_certificate=stale,
                )

        build.assert_not_called()

    def test_proof_factory_rejects_partial_and_forged_plain_evidence(self) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        full_evidence = self._evidence()
        forged_matching = {
            name: getattr(certificate, name) for name in full_evidence
        }

        for plain_evidence in (
            {},
            {"plane_tolerance_m": full_evidence["plane_tolerance_m"]},
            forged_matching,
        ):
            with self.subTest(keys=sorted(plain_evidence)):
                with self.assertRaises(TypeError):
                    gmsh_types._validate_and_create_prevalidated_mixed_certificate(
                        self.mesh_without_certificate,
                        certificate=certificate,
                        canonical_evidence=plain_evidence,
                    )

    def test_canonical_evidence_carrier_recomputes_exactly_once(self) -> None:
        original = gmsh_types._recompute_mixed_certificate_evidence
        recompute = Mock(wraps=original)

        with patch.object(
            gmsh_types,
            "_recompute_mixed_certificate_evidence",
            recompute,
        ):
            carrier = self._carrier()

        self.assertEqual(recompute.call_count, 1)
        self.assertEqual(dict(carrier.evidence), self._evidence())

    def test_accepted_producer_hashes_topology_once(self) -> None:
        original = gmsh_types.MeshData.topology_fingerprint_v3
        calls = 0

        def counted(mesh: gmsh_types.MeshData) -> str:
            nonlocal calls
            calls += 1
            return original(mesh)

        with patch.object(
            gmsh_types.MeshData,
            "topology_fingerprint_v3",
            counted,
        ):
            gmsh_airbox._attach_mixed_layer_topology_certificate(
                self.mesh_without_certificate,
                body_size_m=self.body_size,
                airbox_bounds_min_m=self.airbox_bounds_min,
                airbox_bounds_max_m=self.airbox_bounds_max,
                requested_axis=2,
                requested_layers=1,
                gmsh_version="4.15.2",
                cell_mesh_parts=self.mesh_without_certificate.cell_mesh_parts,
                outer_boundary_marker=99,
                effective_gmsh_thread_count=1,
            )

        self.assertEqual(calls, 1)

    def test_public_certificate_audit_hashes_topology_once(self) -> None:
        original = gmsh_types.MeshData.topology_fingerprint_v3
        calls = 0

        def counted(mesh: gmsh_types.MeshData) -> str:
            nonlocal calls
            calls += 1
            return original(mesh)

        with patch.object(
            gmsh_types.MeshData,
            "topology_fingerprint_v3",
            counted,
        ):
            replace(self.mesh)

        self.assertEqual(calls, 1)

    def test_standalone_workspace_wrapper_hashes_topology_once(self) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        workspace = self._workspace()
        original = gmsh_types.MeshData.topology_fingerprint_v3
        calls = 0

        def counted(mesh: gmsh_types.MeshData) -> str:
            nonlocal calls
            calls += 1
            return original(mesh)

        with patch.object(
            gmsh_types.MeshData,
            "topology_fingerprint_v3",
            counted,
        ):
            gmsh_types._recompute_mixed_certificate_evidence(
                self.mesh_without_certificate,
                sweep_axis=2,
                interface_marker=certificate.interface_marker,
                outer_boundary_marker=certificate.outer_boundary_marker,
                magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
                magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
                airbox_bounds_min_m=certificate.airbox_bounds_min_m,
                airbox_bounds_max_m=certificate.airbox_bounds_max_m,
                workspace=workspace,
            )

        self.assertEqual(calls, 1)

    def test_standalone_recompute_without_workspace_hashes_topology_once(self) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        original = gmsh_types.MeshData.topology_fingerprint_v3
        calls = 0

        def counted(mesh: gmsh_types.MeshData) -> str:
            nonlocal calls
            calls += 1
            return original(mesh)

        with patch.object(
            gmsh_types.MeshData,
            "topology_fingerprint_v3",
            counted,
        ):
            gmsh_types._recompute_mixed_certificate_evidence(
                self.mesh_without_certificate,
                sweep_axis=2,
                interface_marker=certificate.interface_marker,
                outer_boundary_marker=certificate.outer_boundary_marker,
                magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
                magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
                airbox_bounds_min_m=certificate.airbox_bounds_min_m,
                airbox_bounds_max_m=certificate.airbox_bounds_max_m,
            )

        self.assertEqual(calls, 1)

    def test_replaced_carrier_is_rejected_even_with_matching_forged_claims(
        self,
    ) -> None:
        certificate = self.mesh.mixed_layer_topology_certificate
        assert certificate is not None
        carrier = self._carrier()
        mutated = replace(
            certificate,
            transition_shell_thickness_m=(
                certificate.transition_shell_thickness_m * 1.01
            ),
        )
        forged_evidence = dict(carrier.evidence)
        forged_evidence["transition_shell_thickness_m"] = (
            mutated.transition_shell_thickness_m
        )
        forged_carrier = replace(carrier, evidence=forged_evidence)

        with self.assertRaisesRegex(ValueError, "owner-minted"):
            gmsh_types._validate_and_create_prevalidated_mixed_certificate(
                self.mesh_without_certificate,
                certificate=mutated,
                canonical_evidence=forged_carrier,
            )

    def test_replaced_bound_context_is_rejected_despite_copied_capability(
        self,
    ) -> None:
        context = self._carrier().context
        replacements = (
            {"sweep_axis": 0},
            {"interface_marker": 11},
            {"actual_topology_fingerprint_v3": "sha256:" + "0" * 64},
        )

        for changes in replacements:
            with self.subTest(changes=changes):
                forged = replace(context, **changes)
                with self.assertRaisesRegex(ValueError, "owner-minted"):
                    gmsh_types._require_mixed_topology_workspace(
                        self.mesh_without_certificate,
                        forged.workspace,
                        sweep_axis=forged.sweep_axis,
                        interface_marker=forged.interface_marker,
                        _bound_context=forged,
                    )
