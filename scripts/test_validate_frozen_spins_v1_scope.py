from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "validate_frozen_spins_v1_scope.py"
SPEC = importlib.util.spec_from_file_location("validate_frozen_spins_v1_scope", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def scope_document() -> dict:
    return MODULE.load_scope(ROOT / "docs" / "validation" / "frozen-spins-v1-scope.yaml")


class FrozenSpinsV1ScopeTests(unittest.TestCase):
    def test_repository_scope_ledger_is_valid(self) -> None:
        self.assertEqual(MODULE.validate_scope_document(scope_document()), [])

    def test_out_of_scope_requires_typed_reason_code(self) -> None:
        document = scope_document()
        feature = next(
            item
            for item in document["features"]
            if item["scope_status"] == "OUT_OF_SCOPE"
        )
        feature.pop("reason_code")
        errors = MODULE.validate_scope_document(document)
        self.assertTrue(any("reason_code is required" in error for error in errors))

    def test_required_feature_cannot_carry_out_of_scope_reason(self) -> None:
        document = scope_document()
        feature = next(
            item for item in document["features"] if item["scope_status"] == "REQUIRED"
        )
        feature["reason_code"] = "must_not_be_here"
        errors = MODULE.validate_scope_document(document)
        self.assertTrue(any("reason_code must be absent" in error for error in errors))

    def test_duplicate_feature_and_test_ids_fail_closed(self) -> None:
        document = scope_document()
        duplicate = copy.deepcopy(document["features"][0])
        document["features"].append(duplicate)
        errors = MODULE.validate_scope_document(document)
        self.assertTrue(any("duplicate feature id" in error for error in errors))
        self.assertTrue(any("duplicate test case id" in error for error in errors))

    def test_p15_scientific_contract_is_normative_and_complete(self) -> None:
        document = scope_document()
        self.assertGreaterEqual(document["scope_revision"], 2)
        feature = next(
            item
            for item in document["features"]
            if item["id"] == "qualification.scientific"
        )
        self.assertEqual(feature["scope_status"], "REQUIRED")
        self.assertEqual(
            set(feature["required_test_case_ids"]),
            {
                "FS-P15-INVARIANT",
                "FS-P15-MOBILITY",
                "FS-P15-INFLUENCE",
                "FS-P15-NO-MASK-PARITY",
                "FS-P15-ENERGY-ACCOUNTING",
                "FS-P15-FREE-ONLY-STOPPING",
                "FS-P15-CHECKPOINT-CONTINUITY",
                "FS-P15-CPU-GPU-PARITY",
                "FS-P15-PREVIEW-SOLVER-PARITY",
                "FS-P15-INDEPENDENT-ORACLE",
                "FS-P15-MINIMIZER-ORACLE",
                "FS-P15-CROSS-DISCRETIZATION",
                "FS-P15-THERMAL",
            },
        )


if __name__ == "__main__":
    unittest.main()
