from __future__ import annotations

import hashlib
import inspect
import json
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

import numpy as np

from fullmag import _core
from fullmag.meshing._gmsh_types import (
    MeshData,
    MixedLayerTopologyCertificate,
    _certificate_payload_sha256,
)


ROOT = Path(__file__).resolve().parents[3]
GOLDEN = (
    ROOT
    / "crates/fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
)


def _fixture() -> tuple[MeshData, dict[str, object], dict[str, object]]:
    payload = json.loads(GOLDEN.read_text(encoding="utf-8"))
    raw = payload["mesh"]
    cells = raw["cells"]
    facets = raw["facets"]
    mesh = MeshData(
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
    certificate = dict(payload["certificate"])
    for key in (
        "magnetic_plane_coordinates_m",
        "magnetic_bounds_min_m",
        "magnetic_bounds_max_m",
        "airbox_bounds_min_m",
        "airbox_bounds_max_m",
    ):
        certificate[key] = [float(value) for value in certificate[key]]
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
        certificate[key] = float(certificate[key])
    for key in (
        "jacobian_minima_m3_by_family",
        "scaled_jacobian_minima_by_family",
        "scaled_jacobian_p05_by_family",
    ):
        certificate[key] = {
            family: float(value) for family, value in certificate[key].items()
        }
    certificate = MixedLayerTopologyCertificate.from_dict(certificate).to_dict()
    certificate["topology_fingerprint_version"] = "v3"
    certificate["topology_fingerprint"] = mesh.topology_fingerprint_v3()
    return mesh, certificate, payload["expected_evidence"]


def _scaled_fixture(scale: float) -> tuple[MeshData, dict[str, object]]:
    mesh, certificate, _ = _fixture()
    mesh = replace(mesh, nodes=mesh.nodes * scale)
    for key in (
        "magnetic_plane_coordinates_m",
        "magnetic_bounds_min_m",
        "magnetic_bounds_max_m",
        "airbox_bounds_min_m",
        "airbox_bounds_max_m",
    ):
        certificate[key] = [value * scale for value in certificate[key]]
    for key in ("plane_tolerance_m", "transition_shell_thickness_m"):
        certificate[key] *= scale
    for key in (
        "magnetic_volume_m3",
        "expected_magnetic_volume_m3",
        "air_volume_m3",
        "shared_domain_volume_m3",
        "expected_shared_domain_volume_m3",
    ):
        certificate[key] *= scale**3
    certificate["jacobian_minima_m3_by_family"] = {
        family: value * scale**3
        for family, value in certificate["jacobian_minima_m3_by_family"].items()
    }
    certificate["topology_fingerprint"] = mesh.topology_fingerprint_v3()
    return mesh, certificate


def _native_available() -> bool:
    return _core._native_core is not None and hasattr(
        _core._native_core, "certify_mixed_mesh_arrays"
    )


def _assert_evidence_close(
    case: unittest.TestCase,
    actual: object,
    expected: object,
) -> None:
    if isinstance(expected, dict):
        case.assertIsInstance(actual, dict)
        case.assertEqual(set(expected), set(actual))
        for key in expected:
            _assert_evidence_close(case, actual[key], expected[key])
    elif isinstance(expected, list):
        case.assertIsInstance(actual, list)
        case.assertEqual(len(expected), len(actual))
        for actual_item, expected_item in zip(actual, expected, strict=True):
            _assert_evidence_close(case, actual_item, expected_item)
    elif isinstance(expected, float):
        case.assertAlmostEqual(actual, expected, delta=max(2e-15, 1e-12 * abs(expected)))
    else:
        case.assertEqual(actual, expected)


class NativeMixedCertificateTests(unittest.TestCase):
    def test_python_adapter_signatures_are_exact_and_mandatory(self) -> None:
        certificate = inspect.signature(_core.certify_mixed_mesh_arrays).parameters
        self.assertEqual(
            ["mesh", "metadata", "certificate", "require_native"],
            list(certificate),
        )
        self.assertIn("MeshData", str(certificate["mesh"].annotation))
        for parameter in certificate.values():
            self.assertEqual(inspect.Parameter.KEYWORD_ONLY, parameter.kind)
            self.assertIs(inspect.Parameter.empty, parameter.default)

        preflight = inspect.signature(_core.preflight_mixed_mesh_arrays).parameters
        self.assertEqual(["mesh", "expected", "require_native"], list(preflight))
        self.assertIn("MeshData", str(preflight["mesh"].annotation))
        for parameter in preflight.values():
            self.assertEqual(inspect.Parameter.KEYWORD_ONLY, parameter.kind)
            self.assertIs(inspect.Parameter.empty, parameter.default)

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_certificate_matches_python_reference(self) -> None:
        mesh, certificate, expected_evidence = _fixture()
        result = _core.certify_mixed_mesh_arrays(
            mesh=mesh,
            metadata={"mesh_name": "python-golden"},
            certificate=certificate,
            require_native=True,
        )

        self.assertIsNotNone(result)
        _assert_evidence_close(self, result.evidence, expected_evidence)
        self.assertEqual(certificate["topology_fingerprint"], result.topology_fingerprint_v3)
        encoded = json.dumps(
            certificate, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
        self.assertEqual(
            f"sha256:{hashlib.sha256(encoded).hexdigest()}",
            result.certificate_payload_sha256,
        )
        self.assertTrue(result.validated_claimed_certificate)

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_certificate_validity_does_not_rehash_in_python(self) -> None:
        mesh, certificate, _ = _fixture()
        signed = replace(
            mesh,
            mixed_layer_topology_certificate=MixedLayerTopologyCertificate.from_dict(
                certificate
            ),
        )

        with mock.patch.object(
            MeshData,
            "topology_fingerprint_v3",
            side_effect=AssertionError("native certificate validity must not rehash in Python"),
        ):
            self.assertTrue(signed._native_mixed_certificate_valid())

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_certified_construction_skips_duplicate_python_csr_walk(self) -> None:
        mesh, certificate, _ = _fixture()
        with mock.patch.object(
            MeshData,
            "validate",
            side_effect=AssertionError(
                "accepted native mixed certificates must not repeat Python CSR validation"
            ),
        ):
            signed = replace(
                mesh,
                mixed_layer_topology_certificate=MixedLayerTopologyCertificate.from_dict(
                    certificate
                ),
            )
        self.assertIsNotNone(signed.mixed_layer_topology_certificate)

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_certificate_digest_is_canonical_across_json_formatting(self) -> None:
        mesh, certificate, _ = _fixture()
        wire = _core._build_native_mixed_mesh_wire(mesh, {"mesh_name": "python-golden"})
        reordered = dict(reversed(tuple(certificate.items())))
        payloads = (
            json.dumps(certificate, sort_keys=True, separators=(",", ":")),
            json.dumps(certificate, indent=2),
            json.dumps(reordered, separators=(", ", ": ")),
        )
        expected = f"sha256:{hashlib.sha256(payloads[0].encode()).hexdigest()}"
        digests = []
        for payload in payloads:
            result = json.loads(
                _core._native_core.certify_mixed_mesh_arrays(
                    *wire.array_arguments(), wire.metadata_json, payload
                )
            )
            digests.append(result["certificate_payload_sha256"])
        self.assertEqual([expected, expected, expected], digests)

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_certificate_digest_uses_python_float_semantics(self) -> None:
        cases = []
        for scale in (1e-5, 1e20):
            mesh, candidate = _scaled_fixture(scale)
            cases.append((scale, mesh, candidate))
        mesh, certificate, _ = _fixture()
        certificate["magnetic_bounds_relative_error"] = -0.0
        cases.append((-0.0, mesh, certificate))

        for value, mesh, candidate in cases:
            with self.subTest(value=value):
                wire = _core._build_native_mixed_mesh_wire(
                    mesh, {"mesh_name": "python-golden"}
                )
                reordered = dict(reversed(tuple(candidate.items())))
                payloads = (
                    json.dumps(candidate, sort_keys=True, separators=(",", ":")),
                    json.dumps(candidate, indent=2),
                    json.dumps(reordered, separators=(", ", ": ")),
                )

                expected = _certificate_payload_sha256(
                    MixedLayerTopologyCertificate.from_dict(candidate)
                )
                for payload in payloads:
                    result = json.loads(
                        _core._native_core.certify_mixed_mesh_arrays(
                            *wire.array_arguments(), wire.metadata_json, payload
                        )
                    )
                    self.assertEqual(expected, result["certificate_payload_sha256"])

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_certificate_json_size_limit_accepts_boundary_and_rejects_one_byte_over(
        self,
    ) -> None:
        mesh, certificate, _ = _fixture()
        wire = _core._build_native_mixed_mesh_wire(mesh, {"mesh_name": "python-golden"})
        compact = json.dumps(certificate, separators=(",", ":"))
        limit = 1024 * 1024
        at_limit = compact + " " * (limit - len(compact.encode("utf-8")))
        self.assertEqual(limit, len(at_limit.encode("utf-8")))

        result = json.loads(
            _core._native_core.certify_mixed_mesh_arrays(
                *wire.array_arguments(), wire.metadata_json, at_limit
            )
        )
        self.assertTrue(result["validated_claimed_certificate"])

        with self.assertRaisesRegex(
            ValueError,
            r"^mixed certificate JSON exceeds 1048576-byte limit$",
        ):
            _core._native_core.certify_mixed_mesh_arrays(
                *wire.array_arguments(), wire.metadata_json, at_limit + " "
            )

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_certificate_json_rejects_unknown_fields(self) -> None:
        mesh, certificate, _ = _fixture()
        wire = _core._build_native_mixed_mesh_wire(mesh, {"mesh_name": "python-golden"})
        certificate["unexpected_certificate_field"] = {"padding": "x" * 4096}

        with self.assertRaisesRegex(
            ValueError,
            r"unknown field `unexpected_certificate_field`",
        ):
            _core._native_core.certify_mixed_mesh_arrays(
                *wire.array_arguments(), wire.metadata_json, json.dumps(certificate)
            )

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_certificate_digest_rejects_nan(self) -> None:
        mesh, certificate, _ = _fixture()
        wire = _core._build_native_mixed_mesh_wire(mesh, {"mesh_name": "python-golden"})
        certificate["magnetic_bounds_relative_error"] = float("nan")
        with self.assertRaisesRegex(ValueError, "Out of range float values"):
            _core._native_core.certify_mixed_mesh_arrays(
                *wire.array_arguments(),
                wire.metadata_json,
                json.dumps(certificate),
            )

    def test_python_adapter_rejects_non_mapping_certificate(self) -> None:
        mesh, _, _ = _fixture()

        class CertificateLike:
            def to_dict(self) -> dict[str, object]:
                return {}

        with mock.patch.object(_core, "_native_core", None):
            with self.assertRaisesRegex(TypeError, "certificate must be a mapping or None"):
                _core.certify_mixed_mesh_arrays(
                    mesh=mesh,
                    metadata={"mesh_name": "python-golden"},
                    certificate=CertificateLike(),
                    require_native=False,
                )

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_certificate_rejects_non_contiguous_or_wrong_dtype_input(self) -> None:
        mesh, certificate, _ = _fixture()
        wire = _core._build_native_mixed_mesh_wire(mesh, {"mesh_name": "python-golden"})
        arguments = list(wire.array_arguments())

        wrong_dtype = list(arguments)
        wrong_dtype[0] = wrong_dtype[0].astype(np.int32)
        with self.assertRaises((TypeError, ValueError)):
            _core._native_core.certify_mixed_mesh_arrays(
                *wrong_dtype, wire.metadata_json, json.dumps(certificate)
            )

        non_contiguous = list(arguments)
        non_contiguous[1] = np.asfortranarray(non_contiguous[1])
        self.assertFalse(non_contiguous[1].flags.c_contiguous)
        with self.assertRaises((TypeError, ValueError)):
            _core._native_core.certify_mixed_mesh_arrays(
                *non_contiguous, wire.metadata_json, json.dumps(certificate)
            )

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_certificate_rejects_unknown_topology_code(self) -> None:
        mesh, certificate, _ = _fixture()
        wire = _core._build_native_mixed_mesh_wire(mesh, {"mesh_name": "python-golden"})
        arguments = list(wire.array_arguments())
        arguments[3] = arguments[3].copy()
        arguments[3][0] = np.uint8(255)
        with self.assertRaisesRegex(ValueError, "unknown cell topology code 255"):
            _core._native_core.certify_mixed_mesh_arrays(
                *arguments, wire.metadata_json, json.dumps(certificate)
            )

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_certificate_rejects_out_of_range_csr_offsets(self) -> None:
        mesh, certificate, _ = _fixture()
        wire = _core._build_native_mixed_mesh_wire(mesh, {"mesh_name": "python-golden"})
        arguments = list(wire.array_arguments())
        arguments[5] = arguments[5].copy()
        arguments[5][-1] += 1
        with self.assertRaisesRegex(ValueError, "cell CSR terminal offset"):
            _core._native_core.certify_mixed_mesh_arrays(
                *arguments, wire.metadata_json, json.dumps(certificate)
            )

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_certificate_requires_canonical_v3_fingerprint(self) -> None:
        mesh, certificate, _ = _fixture()
        legacy = dict(certificate)
        legacy["topology_fingerprint_version"] = "v2"
        legacy["topology_fingerprint"] = mesh.topology_fingerprint_v2()
        with self.assertRaisesRegex(ValueError, "requires topology fingerprint v3"):
            _core.certify_mixed_mesh_arrays(
                mesh=mesh,
                metadata={"mesh_name": "python-golden"},
                certificate=legacy,
                require_native=True,
            )

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_preflight_matches_counts_and_fingerprint(self) -> None:
        mesh, certificate, _ = _fixture()
        result = _core.preflight_mixed_mesh_arrays(
            mesh=mesh,
            expected={
                "counts": {
                    "nodes": len(mesh.nodes),
                    "cells": len(mesh.cell_types),
                    "facets": len(mesh.facet_types),
                },
                "topology_fingerprint_v3": certificate["topology_fingerprint"],
            },
            require_native=True,
        )
        self.assertIsNotNone(result)
        self.assertEqual(certificate["topology_fingerprint"], result.topology_fingerprint_v3)

    @unittest.skipUnless(_native_available(), "real _fullmag_core extension is unavailable")
    def test_native_preflight_expected_cannot_override_mesh_metadata(self) -> None:
        mesh, certificate, _ = _fixture()
        counts = {
            "nodes": len(mesh.nodes),
            "cells": len(mesh.cell_types),
            "facets": len(mesh.facet_types),
        }
        attacks = {
            "cell_regions": [],
            "facet_roles_by_marker": {},
            "periodic_boundary_pairs": [{"pair_id": "forged"}],
            "periodic_node_pairs": [
                {"pair_id": "forged", "node_a": 0, "node_b": 1}
            ],
        }
        for field, value in attacks.items():
            with self.subTest(field=field):
                expected = {
                    "counts": counts,
                    "topology_fingerprint_v3": certificate["topology_fingerprint"],
                    field: value,
                }
                with self.assertRaisesRegex(ValueError, f"unknown field.*{field}"):
                    _core.preflight_mixed_mesh_arrays(
                        mesh=mesh,
                        expected=expected,
                        require_native=True,
                    )

    def test_strict_production_mode_rejects_missing_native_extension(self) -> None:
        mesh, certificate, _ = _fixture()
        with mock.patch.object(_core, "_native_core", None):
            with self.assertRaisesRegex(
                RuntimeError, "^native mixed mesh certifier is required$"
            ):
                _core.certify_mixed_mesh_arrays(
                    mesh=mesh,
                    metadata={"mesh_name": "python-golden"},
                    certificate=certificate,
                    require_native=True,
                )

    def test_explicit_non_strict_mode_returns_none_without_native_extension(self) -> None:
        mesh, certificate, _ = _fixture()
        with mock.patch.object(_core, "_native_core", None):
            result = _core.certify_mixed_mesh_arrays(
                mesh=mesh,
                metadata={"mesh_name": "python-golden"},
                certificate=certificate,
                require_native=False,
            )
        self.assertIsNone(result)

    def test_fast_preflight_does_not_build_face_adjacency(self) -> None:
        mesh, _, _ = _fixture()
        calls = {"certificate": 0, "preflight": 0}
        counts = {
            "nodes": len(mesh.nodes),
            "cells": len(mesh.cell_types),
            "facets": len(mesh.facet_types),
        }

        class FakeNative:
            def mixed_mesh_topology_codes_json(self) -> str:
                return json.dumps(
                    {
                        "cells": {"tet4": 1, "prism6": 2, "pyramid5": 3, "hex8": 4},
                        "facets": {"tri3": 11, "quad4": 12},
                    }
                )

            def certify_mixed_mesh_arrays(self, *args: object) -> str:
                calls["certificate"] += 1
                raise AssertionError("preflight must not call the certificate engine")

            def preflight_mixed_mesh_arrays(self, *args: object) -> str:
                calls["preflight"] += 1
                return json.dumps(
                    {
                        "schema_version": "fullmag.mixed-preflight-native-result.v1",
                        "counts": counts,
                        "topology_fingerprint_v3": "sha256:" + "0" * 64,
                        "elapsed_ns": 1,
                    }
                )

        with mock.patch.object(_core, "_native_core", FakeNative()):
            result = _core.preflight_mixed_mesh_arrays(
                mesh=mesh,
                expected={
                    "counts": counts,
                    "topology_fingerprint_v3": "sha256:" + "0" * 64,
                },
                require_native=True,
            )
        self.assertIsNotNone(result)
        self.assertEqual(0, calls["certificate"])
        self.assertEqual(1, calls["preflight"])


if __name__ == "__main__":
    unittest.main()
