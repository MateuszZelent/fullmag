from __future__ import annotations

import unittest

from scripts.finalize_frozen_spins_fem_gpu_evidence import EvidenceError, finalize


def native_payload(*, dirty: bool = True) -> dict[str, object]:
    return {
        "schema_version": "fullmag.frozen_spins.fem.cuda.runtime.evidence.v1",
        "status": "PASS",
        "qualification_status": (
            "RUNTIME_CONFIRMED_DIRTY_SOURCE" if dirty else "RUNTIME_CONFIRMED"
        ),
        "source_identity": {
            "source_snapshot_sha256": "a" * 64,
            "source_snapshot_dirty": dirty,
        },
        "device": {"name": "test CUDA device"},
        "fallback_used": False,
        "fallback_trail": [],
    }


class FinalizeFrozenSpinsFemGpuEvidenceTests(unittest.TestCase):
    def test_finalized_receipt_records_fem_hot_rebuild_and_quantity(self) -> None:
        receipt = finalize(native_payload())

        self.assertEqual(receipt["implementation_status"], "RUNTIME_CONFIRMED")
        self.assertEqual(receipt["runtime_source_status"], "RUNTIME_CONFIRMED_DIRTY_SOURCE")
        self.assertEqual(receipt["qualification_status"], "UNQUALIFIED")
        self.assertEqual(receipt["qualification_blocker"], "dirty_source_snapshot")
        self.assertEqual(
            receipt["managed_recipe_gates"]["interactive_hot_rebuild"], "PASS"
        )
        self.assertTrue(
            receipt["interactive_hot_rebuild_contract"][
                "continuation_magnetization_preserved"
            ]
        )
        self.assertTrue(
            receipt["interactive_hot_rebuild_contract"][
                "frozen_spins_quantity_verified"
            ]
        )
        self.assertTrue(
            receipt["interactive_hot_rebuild_contract"][
                "quantity_active_mask_verified"
            ]
        )

    def test_clean_runtime_source_still_requires_cross_layer_qualification(self) -> None:
        receipt = finalize(native_payload(dirty=False))

        self.assertEqual(receipt["runtime_source_status"], "RUNTIME_CONFIRMED")
        self.assertEqual(receipt["qualification_status"], "UNQUALIFIED")
        self.assertEqual(
            receipt["qualification_blocker"],
            "full_cross_layer_qualification_not_complete",
        )

    def test_finalizer_rejects_failed_fallback_or_unbound_source(self) -> None:
        failed = native_payload()
        failed["status"] = "FAIL"
        with self.assertRaises(EvidenceError):
            finalize(failed)

        fallback = native_payload()
        fallback["fallback_used"] = True
        fallback["fallback_trail"] = ["cpu"]
        with self.assertRaises(EvidenceError):
            finalize(fallback)

        unbound = native_payload()
        unbound["source_identity"] = {}
        with self.assertRaises(EvidenceError):
            finalize(unbound)


if __name__ == "__main__":
    unittest.main()
