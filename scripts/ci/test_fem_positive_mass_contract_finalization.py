"""Regression tests for hosted contract owner finalization."""

from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_fem_positive_mass_contract as contract


class FemContractOwnerFinalizationTests(unittest.TestCase):
    def test_main_checkout_pass_is_receipt_only_and_does_not_retire(self):
        plan = contract._owner_finish_plan(
            checkout_kind="main-checkout",
            passed=True,
        )

        self.assertEqual(plan["state"], "review")
        self.assertEqual(plan["mode"], "main_checkout_receipt_only")
        self.assertEqual(plan["cleanup_state"], "not_applicable_main_checkout")
        self.assertIn("without attempting", plan["reason"])

    def test_managed_worktree_pass_keeps_retirement_contract(self):
        plan = contract._owner_finish_plan(
            checkout_kind="worktree",
            passed=True,
        )

        self.assertEqual(plan["state"], "completed")
        self.assertEqual(plan["mode"], "worktree_retirement")
        self.assertEqual(plan["cleanup_state"], "completed")

    def test_failed_contract_never_claims_cleanup(self):
        for checkout_kind in ("main-checkout", "worktree"):
            with self.subTest(checkout_kind=checkout_kind):
                plan = contract._owner_finish_plan(
                    checkout_kind=checkout_kind,
                    passed=False,
                )

                self.assertEqual(plan["state"], "review")
                self.assertEqual(plan["cleanup_state"], "review_required")

    def test_unknown_checkout_kind_fails_closed(self):
        with self.assertRaises(contract.ContractRunError):
            contract._owner_finish_plan(checkout_kind="unknown", passed=True)


if __name__ == "__main__":
    unittest.main()
