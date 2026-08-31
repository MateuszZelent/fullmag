#!/usr/bin/env python3
"""Focused structural/identity/tamper tests for the FMMQ v2 carrier."""
from __future__ import annotations

import tempfile
from types import SimpleNamespace
import unittest
from pathlib import Path

import numpy as np

from fullmag.meshing import MeshData
from fullmag.meshing.fmmq import (
    FmmqFormatError,
    build_fmmq_v2_spec,
    read_fmmq_v2_metric,
    verify_fmmq_v2,
    write_fmmq_v2,
)


def _mesh() -> MeshData:
    return MeshData.from_legacy_tet4(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        ),
        elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
        element_markers=np.asarray([1], dtype=np.int32),
        boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
        boundary_markers=np.asarray([1], dtype=np.int32),
    )


def _interleaved_mixed_mesh() -> MeshData:
    """Mixed cells with a non-contiguous prism family ordinal range."""
    # ordinals: tet4(0), prism6(1), tet4(2)
    return MeshData(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
                [3.0, 0.0, 0.0],
                [2.0, 1.0, 0.0],
                [2.0, 0.0, 1.0],
                [3.0, 0.0, 1.0],
                [2.0, 1.0, 1.0],
                [4.0, 0.0, 0.0],
                [5.0, 0.0, 0.0],
                [4.0, 1.0, 0.0],
                [4.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        ),
        cell_types=np.asarray(["tet4", "prism6", "tet4"]),
        cell_offsets=np.asarray([0, 4, 10, 14], dtype=np.int64),
        cell_nodes=np.asarray(
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
            dtype=np.int32,
        ),
        element_markers=np.asarray([1, 2, 1], dtype=np.int32),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0], dtype=np.int64),
        facet_nodes=np.asarray([], dtype=np.int32),
        boundary_markers=np.asarray([], dtype=np.int32),
        cell_global_ordinals=np.asarray([0, 1, 2], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
    )


class FmmqV2Tests(unittest.TestCase):
    def _payload(self) -> tuple[bytes, dict[str, object]]:
        mesh = _mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={
                "topology_fingerprint": mesh.topology_fingerprint_v3(),
                "policy_fingerprint": "sha256:policy",
                "mesh_revision": "42",
                "artifact_id": "sha256:artifact",
                "certifier_build": {"name": "test", "version": "1"},
                "identity_status": "bound",
            },
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "quality.fmmq"
            write_fmmq_v2(path, element_count=count, identity=identity, metrics=metrics)
            return path.read_bytes(), identity

    def test_round_trip_and_metric_decode(self) -> None:
        payload, identity = self._payload()
        verified = verify_fmmq_v2(
            payload,
            expected_identity={
                "topology_fingerprint": identity["topology_fingerprint"],
                "policy_fingerprint": "sha256:policy",
            },
            required_metrics={"cell.volume.v1", "signed_jacobian.tet4.v1"},
        )
        self.assertEqual(verified.element_count, 1)
        metric = read_fmmq_v2_metric(payload, "cell.volume.v1")
        self.assertEqual(metric.values.shape, (1,))
        self.assertEqual(metric.ordinals.tolist(), [0])
        self.assertAlmostEqual(float(metric.values[0]), 1.0 / 6.0)

    def test_tamper_digest_is_rejected(self) -> None:
        payload, _ = self._payload()
        mutated = bytearray(payload)
        mutated[-33] ^= 0x01
        with self.assertRaisesRegex(FmmqFormatError, "metric_checksum_error|payload_digest_error"):
            verify_fmmq_v2(bytes(mutated))

    def test_identity_mismatch_is_rejected_before_metric_access(self) -> None:
        payload, _ = self._payload()
        with self.assertRaisesRegex(FmmqFormatError, "identity_mismatch"):
            verify_fmmq_v2(payload, expected_identity={"mesh_revision": "stale"})

    def test_truncated_and_nonfinite_metric_are_rejected(self) -> None:
        payload, _ = self._payload()
        with self.assertRaisesRegex(FmmqFormatError, "truncated_header|digest_range_error|truncated_payload"):
            verify_fmmq_v2(payload[:-1])

        mesh = _mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={"topology_fingerprint": mesh.topology_fingerprint_v3()},
        )
        metrics["cell.volume.v1"] = {
            **metrics["cell.volume.v1"],
            "values": np.asarray([np.nan]),
        }
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(FmmqFormatError, "nonfinite_metric"):
                write_fmmq_v2(
                    Path(directory) / "bad.fmmq",
                    element_count=count,
                    identity=identity,
                    metrics=metrics,
                )

    def test_writer_rejects_unknown_metric_and_wrong_unit(self) -> None:
        mesh = _mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={"topology_fingerprint": mesh.topology_fingerprint_v3()},
        )
        with tempfile.TemporaryDirectory() as directory:
            unknown = dict(metrics)
            unknown["future.metric.v1"] = {
                "values": np.asarray([1.0]),
                "ordinals": np.asarray([0], dtype=np.uint64),
                "unit": "1",
            }
            with self.assertRaisesRegex(FmmqFormatError, "unknown_metric"):
                write_fmmq_v2(
                    Path(directory) / "unknown.fmmq",
                    element_count=count,
                    identity=identity,
                    metrics=unknown,
                )

            wrong_unit = dict(metrics)
            wrong_unit["cell.volume.v1"] = {
                **wrong_unit["cell.volume.v1"],
                "unit": "1",
            }
            with self.assertRaisesRegex(FmmqFormatError, "metric_unit_error"):
                write_fmmq_v2(
                    Path(directory) / "wrong-unit.fmmq",
                    element_count=count,
                    identity=identity,
                    metrics=wrong_unit,
                )

    def test_writer_rejects_family_identity_and_duplicate_ordinals(self) -> None:
        mesh = _mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={"topology_fingerprint": mesh.topology_fingerprint_v3()},
        )
        with tempfile.TemporaryDirectory() as directory:
            missing_family = dict(metrics)
            missing_family["signed_jacobian.tet4.v1"] = {
                "values": np.asarray([1.0]),
                "ordinals": np.asarray([0], dtype=np.uint64),
                "unit": "m^3",
            }
            with self.assertRaisesRegex(FmmqFormatError, "metric_family_error"):
                write_fmmq_v2(
                    Path(directory) / "missing-family.fmmq",
                    element_count=count,
                    identity=identity,
                    metrics=missing_family,
                )

            duplicate_ordinals = dict(metrics)
            duplicate_ordinals["cell.volume.v1"] = {
                **duplicate_ordinals["cell.volume.v1"],
                "ordinals": np.asarray([0, 0], dtype=np.uint64),
                "values": np.asarray([1.0, 2.0]),
            }
            with self.assertRaisesRegex(FmmqFormatError, "ordinal_order_error"):
                write_fmmq_v2(
                    Path(directory) / "duplicate-ordinals.fmmq",
                    element_count=2,
                    identity=identity,
                    metrics=duplicate_ordinals,
                )

            negative_ordinals = dict(metrics)
            negative_ordinals["cell.volume.v1"] = {
                **negative_ordinals["cell.volume.v1"],
                "ordinals": np.asarray([-1], dtype=np.int64),
            }
            with self.assertRaisesRegex(FmmqFormatError, "ordinal_value_error"):
                write_fmmq_v2(
                    Path(directory) / "negative-ordinals.fmmq",
                    element_count=count,
                    identity=identity,
                    metrics=negative_ordinals,
                )

    def test_writer_rejects_non_contiguous_family_identity(self) -> None:
        mesh = _mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={"topology_fingerprint": mesh.topology_fingerprint_v3()},
        )
        broken_identity = dict(identity)
        broken_identity["families"] = [
            {
                **identity["families"][0],
                "ordinal_min": 1,
                "ordinal_max": 1,
                "ordinal_ranges": [[1, 1]],
            }
        ]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(FmmqFormatError, "family_range_error"):
                write_fmmq_v2(
                    Path(directory) / "broken-family.fmmq",
                    element_count=count,
                    identity=broken_identity,
                    metrics=metrics,
                )

    def test_interleaved_family_ranges_round_trip(self) -> None:
        mesh = _interleaved_mixed_mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={
                "topology_fingerprint": mesh.topology_fingerprint_v3(),
                "policy_fingerprint": "sha256:policy",
                "mesh_revision": "interleaved",
            },
        )
        tet_row = next(row for row in identity["families"] if row["family"] == "tet4")
        self.assertEqual(tet_row["ordinal_ranges"], [[0, 0], [2, 2]])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "interleaved.fmmq"
            write_fmmq_v2(path, element_count=count, identity=identity, metrics=metrics)
            verified = verify_fmmq_v2(path.read_bytes())
        self.assertEqual(verified.element_count, 3)

    def test_fmmq_uses_full_adjacent_growth_channel_not_bounded_worst_pairs(self) -> None:
        mesh = _interleaved_mixed_mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={
                "topology_fingerprint": mesh.topology_fingerprint_v3(),
                "policy_fingerprint": "sha256:policy",
                "mesh_revision": "growth",
            },
            adjacent_growth_report=SimpleNamespace(
                evaluated_pair_count=2,
                # A diagnostic report may expose only a bounded worst list.
                worst_pairs=(SimpleNamespace(ratio=1.2),),
                # Deliberately ratio-sorted, not ordinal-sorted; the builder
                # must canonicalize the full channel before writing it.
                pair_ordinals=((0, 2), (0, 1)),
                pair_ratios=(1.2, 1.1),
            ),
        )
        channel = metrics["adjacent_size_growth.v1"]
        self.assertEqual(channel["values"].tolist(), [1.1, 1.2])
        self.assertEqual(channel["ordinals"].tolist(), [[0, 1], [0, 2]])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "growth.fmmq"
            write_fmmq_v2(path, element_count=count, identity=identity, metrics=metrics)
            verified = verify_fmmq_v2(
                path.read_bytes(), required_metrics={"adjacent_size_growth.v1"}
            )
        self.assertIn("adjacent_size_growth.v1", verified.metric_ids)

    def test_identity_float_encoding_matches_serde_json_number_shape(self) -> None:
        mesh = _mesh()
        count, identity, metrics = build_fmmq_v2_spec(
            mesh,
            identity={
                "topology_fingerprint": mesh.topology_fingerprint_v3(),
                "policy_fingerprint": "sha256:policy",
                "mesh_revision": "float-sidecar",
                "sidecar_identity": {
                    "tiny": 1.0e-7,
                    "large": -2.5e20,
                },
            },
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "float-sidecar.fmmq"
            write_fmmq_v2(path, element_count=count, identity=identity, metrics=metrics)
            payload = path.read_bytes()
        identity_offset = int.from_bytes(payload[28:36], "little")
        identity_length = int.from_bytes(payload[36:44], "little")
        identity_bytes = payload[identity_offset : identity_offset + identity_length]
        self.assertIn(b"-2.5e+20", identity_bytes)
        self.assertIn(b"1e-7", identity_bytes)
        self.assertNotIn(b"1e-07", identity_bytes)
        self.assertEqual(verify_fmmq_v2(payload).identity["sidecar_identity"]["tiny"], 1.0e-7)


if __name__ == "__main__":
    unittest.main(verbosity=2)
