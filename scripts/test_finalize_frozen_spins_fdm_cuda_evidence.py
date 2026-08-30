from __future__ import annotations

import unittest

from scripts.finalize_frozen_spins_fdm_cuda_evidence import EvidenceError, finalize


def native_payload() -> dict[str, object]:
    return {
        "schema_version": "fullmag.frozen_spins.cuda.runtime.evidence.v1",
        "status": "PASS",
        "device": {"name": "test CUDA device"},
        "fallback_trail": [],
    }


class FinalizeFrozenSpinsFdmCudaEvidenceTests(unittest.TestCase):
    def test_finalized_receipt_records_hot_rebuild_and_unqualified_source(self) -> None:
        receipt = finalize(native_payload())

        self.assertEqual(receipt["implementation_status"], "RUNTIME_CONFIRMED")
        self.assertEqual(receipt["qualification_status"], "UNQUALIFIED")
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

    def test_finalizer_rejects_failed_or_fallback_native_evidence(self) -> None:
        failed = native_payload()
        failed["status"] = "FAIL"
        with self.assertRaises(EvidenceError):
            finalize(failed)

        fallback = native_payload()
        fallback["fallback_trail"] = ["cpu"]
        with self.assertRaises(EvidenceError):
            finalize(fallback)


if __name__ == "__main__":
    unittest.main()
