import unittest

from build_frozen_spins_fem_gpu_evidence import (
    REQUIRED_PASS_LINES,
    build_receipt,
    parse_nvidia_smi_row,
)


def valid_log() -> str:
    return "\n".join(
        [
            *REQUIRED_PASS_LINES,
            "FROZEN_SPINS_FEM_GPU_DEVICE driver_version=13010 runtime_version=12040 compute_capability=8.9 node_count=4 device_bytes=3697",
            "FROZEN_SPINS_FEM_GPU_TRANSFER hot_loop_h2d_bytes=0 hot_loop_compute_h2d_bytes=0 hot_loop_compute_d2h_bytes=0 hot_loop_exchange_h2d_bytes=0 hot_loop_exchange_d2h_bytes=0",
            "FROZEN_SPINS_FEM_GPU_BUILD mfem_version=4.8.0 hypre_version=2.31.0",
        ]
    )


class FrozenSpinsFemGpuEvidenceTests(unittest.TestCase):
    def test_receipt_is_pass_but_dirty_source_is_not_promoted_to_qualified(self):
        receipt = build_receipt(
            log=valid_log(),
            source_identity={
                "schema": "fullmag.source-snapshot.v2",
                "head_commit_full": "a" * 40,
                "source_snapshot_sha256": "b" * 64,
                "source_snapshot_dirty": True,
                "dirty_content_sha256": "c" * 64,
            },
            gpu_identity=parse_nvidia_smi_row(
                "GPU-fcb9, NVIDIA GeForce RTX 4080 SUPER, 00000000:01:00.0, 591.86, 8.9"
            ),
            timestamp_utc="2026-08-29T00:00:00Z",
        )
        self.assertEqual(receipt["status"], "PASS")
        self.assertEqual(
            receipt["qualification_status"], "RUNTIME_CONFIRMED_DIRTY_SOURCE"
        )
        self.assertFalse(receipt["fallback_used"])
        self.assertEqual(receipt["state"]["true_dof_count"], 12)

    def test_nonzero_hot_loop_transfer_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "transfer gate failed"):
            build_receipt(
                log=valid_log().replace(
                    "hot_loop_compute_h2d_bytes=0",
                    "hot_loop_compute_h2d_bytes=1",
                ),
                source_identity={"source_snapshot_dirty": False},
                gpu_identity=parse_nvidia_smi_row(
                    "GPU-fcb9, GPU, 00000000:01:00.0, 591.86, 8.9"
                ),
                timestamp_utc="2026-08-29T00:00:00Z",
            )

    def test_missing_pass_line_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "missing PASS gates"):
            build_receipt(
                log=valid_log().replace(REQUIRED_PASS_LINES[-1], ""),
                source_identity={"source_snapshot_dirty": False},
                gpu_identity=parse_nvidia_smi_row(
                    "GPU-fcb9, GPU, 00000000:01:00.0, 591.86, 8.9"
                ),
                timestamp_utc="2026-08-29T00:00:00Z",
            )


if __name__ == "__main__":
    unittest.main()
