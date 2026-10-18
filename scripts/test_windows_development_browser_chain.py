from __future__ import annotations

import copy
import unittest

from windows.development_browser_chain import (
    DevelopmentBrowserChainError,
    DevelopmentBrowserChainLedger,
)


NONCE = "9abcdef0-1234-4abc-8def-1234567890ab"
GENERATION = "a" * 32
API_A = "a11a1111-1111-4111-8111-111111111111"
API_B = "b2222222-2222-4222-8222-222222222222"
API_C = "c3333333-3333-4333-8333-333333333333"
REQUEST_1 = "d4444444-4444-4444-8444-444444444444"
REQUEST_2 = "e5555555-5555-4555-8555-555555555555"


def build(marker: str) -> dict[str, str]:
    return {"build_id": marker * 64, "source_sha256": str(int(marker, 16) + 3) * 64}


BUILD_A = build("1")
BUILD_B = build("2")
BUILD_C = build("3")


def owner(api_pin: str, session_id: str, session_epoch: int, started: int) -> dict[str, object]:
    return {
        "api_instance_id": api_pin,
        "session_id": session_id,
        "session_epoch": session_epoch,
        "session_resource_epoch": f"{session_id}@{started}",
        "request_scope_epoch": f"{api_pin}:{session_epoch}",
    }


OWNER_A = owner(API_A, "session-opaque-A", 1, 100)
OWNER_B = owner(API_B, "session-opaque-B", 1, 200)
OWNER_C = owner(API_C, "session-opaque-C", 1, 300)


def evidence(cycle: int, phase: str, *, nonce: str = NONCE) -> dict[str, object]:
    source_owner, source_build, target_owner, target_build, request_id = {
        1: (OWNER_A, BUILD_A, OWNER_B, BUILD_B, REQUEST_1),
        2: (OWNER_B, BUILD_B, OWNER_C, BUILD_C, REQUEST_2),
    }[cycle]
    if phase == "before":
        return {
            "cycle": cycle,
            "nonce": nonce,
            "generation_id": GENERATION,
            "request_id": request_id,
            "source_build": copy.deepcopy(source_build),
            "target_build": copy.deepcopy(target_build),
            "source_owner": copy.deepcopy(source_owner),
            "snapshot": {"scene_sha256": "d" * 64, "camera_sha256": "e" * 64, "phase": phase},
        }
    if phase == "restored":
        return {
            "cycle": cycle,
            "nonce": nonce,
            "generation_id": GENERATION,
            "request_id": request_id,
            "api_response_pin": target_owner["api_instance_id"],
            "target_build": copy.deepcopy(target_build),
            "owner": copy.deepcopy(target_owner),
            "snapshot": {"scene_sha256": "f" * 64, "camera_sha256": "e" * 64, "phase": phase},
        }
    if phase == "after":
        return {
            "cycle": cycle,
            "nonce": nonce,
            "generation_id": GENERATION,
            "request_id": request_id,
            "owner": copy.deepcopy(target_owner),
            "snapshot": {"scene_sha256": "f" * 64, "camera_sha256": "e" * 64, "phase": phase},
            "source_api_instance_id": source_owner["api_instance_id"],
            "source_api_waited": True,
            # A stopped source API may report 1; wait, not exit code zero, is the invariant.
            "source_api_exit_code": 1,
        }
    raise AssertionError(phase)


def complete_cycle(ledger: DevelopmentBrowserChainLedger, cycle: int) -> None:
    ledger.record_before(evidence(cycle, "before"))
    ledger.record_restored(evidence(cycle, "restored"))
    ledger.record_after(evidence(cycle, "after"))


class DevelopmentBrowserChainLedgerTests(unittest.TestCase):
    def test_legal_single_cycle_finishes_after_terminal_after_phase(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION, expected_cycles=1)
        ledger.record_before(evidence(1, "before"))
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.finish(NONCE, GENERATION)
        ledger.record_restored(evidence(1, "restored"))
        ledger.record_after(evidence(1, "after"))

        result = ledger.finish(NONCE, GENERATION)

        self.assertTrue(result["finished"])
        self.assertEqual(result["expected_cycles"], 1)
        self.assertEqual(result["cycles"][0]["after"]["source_api_exit_code"], 1)

    def test_legal_two_cycle_chain_uses_confirmed_middle_owner_and_build(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION, expected_cycles=2)
        complete_cycle(ledger, 1)
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.finish(NONCE, GENERATION)
        complete_cycle(ledger, 2)

        result = ledger.finish(NONCE, GENERATION)

        self.assertEqual([cycle["cycle"] for cycle in result["cycles"]], [1, 2])
        self.assertEqual(result["cycles"][1]["before"]["owner"], OWNER_B)
        self.assertEqual(result["cycles"][1]["source_build"], BUILD_B)

    def test_source_epoch_zero_is_preserved_without_relabeling(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
        before = evidence(1, "before")
        before["source_owner"] = owner(API_A, "session-opaque-A", 0, 100)
        ledger.record_before(before)
        ledger.record_restored(evidence(1, "restored"))
        ledger.record_after(evidence(1, "after"))
        result = ledger.finish(NONCE, GENERATION)
        self.assertEqual(result["cycles"][0]["before"]["owner"]["session_epoch"], 0)
        self.assertEqual(result["cycles"][0]["before"]["owner"]["request_scope_epoch"], f"{API_A}:0")

    def test_owner_epoch_negative_or_boolean_is_rejected(self) -> None:
        for epoch in (-1, True):
            with self.subTest(epoch=epoch):
                ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
                before = evidence(1, "before")
                before["source_owner"] = owner(API_A, "session-opaque-A", epoch, 100)
                with self.assertRaises(DevelopmentBrowserChainError):
                    ledger.record_before(before)
                self.assertEqual(ledger.snapshot()["cycles"], [])

    def test_rejects_noncanonical_nonce_generation_uuid_hash_and_cycle(self) -> None:
        invalid_ledgers = (
            ("99999999999949998999999999999999", GENERATION, 1),
            (NONCE.upper(), GENERATION, 1),
            (NONCE, GENERATION.upper(), 1),
            (NONCE, "0" * 32, 1),
            (NONCE, GENERATION, True),
            (NONCE, GENERATION, 3),
        )
        for nonce, generation, count in invalid_ledgers:
            with self.subTest(nonce=nonce, generation=generation, count=count):
                with self.assertRaises(DevelopmentBrowserChainError):
                    DevelopmentBrowserChainLedger(nonce, generation, count)

        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
        invalid = evidence(1, "before", nonce="88888888-8888-4888-8888-888888888888")
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(invalid)
        invalid = evidence(1, "before")
        invalid["cycle"] = True
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(invalid)
        invalid = evidence(1, "before")
        invalid["request_id"] = "44444444444444448444444444444444"
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(invalid)
        invalid = evidence(1, "before")
        invalid["source_owner"]["api_instance_id"] = API_A.upper()
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(invalid)
        invalid = evidence(1, "before")
        invalid["source_build"]["build_id"] = "A" * 64
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(invalid)
        self.assertEqual(ledger.snapshot()["cycles"], [])

    def test_rejects_terminal_wait_for_restored_api_instead_of_source_api(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
        ledger.record_before(evidence(1, "before"))
        ledger.record_restored(evidence(1, "restored"))

        wrong_source = evidence(1, "after")
        wrong_source["source_api_instance_id"] = API_B
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_after(wrong_source)
        self.assertIsNone(ledger.snapshot()["cycles"][0]["after"])

        ledger.record_after(evidence(1, "after"))
        self.assertEqual(
            ledger.snapshot()["cycles"][0]["after"]["source_api_instance_id"],
            API_A,
        )

    def test_rejects_empty_phase_snapshots_without_advancing_phase(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
        before = evidence(1, "before")
        before["snapshot"] = {}
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(before)
        self.assertEqual(ledger.snapshot()["cycles"], [])

        ledger.record_before(evidence(1, "before"))
        restored = evidence(1, "restored")
        restored["snapshot"] = {}
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_restored(restored)
        self.assertIsNone(ledger.snapshot()["cycles"][0]["restored"])

        ledger.record_restored(evidence(1, "restored"))
        after = evidence(1, "after")
        after["snapshot"] = {}
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_after(after)
        self.assertIsNone(ledger.snapshot()["cycles"][0]["after"])

    def test_recursive_snapshot_is_rejected_with_ledger_error(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
        before = evidence(1, "before")
        recursive: dict[str, object] = {}
        recursive["self"] = recursive
        before["snapshot"] = recursive

        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(before)
        self.assertEqual(ledger.snapshot()["cycles"], [])

    def test_rejects_reused_pin_or_request_id(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
        before = evidence(1, "before")
        before["target_build"] = copy.deepcopy(BUILD_B)
        ledger.record_before(before)
        restored = evidence(1, "restored")
        restored["api_response_pin"] = API_A
        restored["owner"]["api_instance_id"] = API_A
        restored["owner"]["request_scope_epoch"] = f"{API_A}:1"
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_restored(restored)
        ledger.record_restored(evidence(1, "restored"))
        ledger.record_after(evidence(1, "after"))

        ledger_two = DevelopmentBrowserChainLedger(NONCE, GENERATION, expected_cycles=2)
        complete_cycle(ledger_two, 1)
        repeated = evidence(2, "before")
        repeated["request_id"] = REQUEST_1
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger_two.record_before(repeated)

    def test_rejects_before_overwrite_missing_hydrate_and_premature_finish(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION, expected_cycles=2)
        ledger.record_before(evidence(1, "before"))
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_before(evidence(1, "before"))
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.record_after(evidence(1, "after"))
        with self.assertRaises(DevelopmentBrowserChainError):
            ledger.finish(NONCE, GENERATION)

    def test_second_cycle_rejects_old_a_or_mismatched_b_continuation(self) -> None:
        def completed_first() -> DevelopmentBrowserChainLedger:
            ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION, expected_cycles=2)
            complete_cycle(ledger, 1)
            return ledger

        old_a = completed_first()
        before = evidence(2, "before")
        before["source_owner"] = copy.deepcopy(OWNER_A)
        before["source_build"] = copy.deepcopy(BUILD_A)
        with self.assertRaises(DevelopmentBrowserChainError):
            old_a.record_before(before)

        wrong_build = completed_first()
        before = evidence(2, "before")
        before["source_build"] = copy.deepcopy(BUILD_A)
        with self.assertRaises(DevelopmentBrowserChainError):
            wrong_build.record_before(before)

        wrong_scope = completed_first()
        before = evidence(2, "before")
        changed_b = copy.deepcopy(OWNER_B)
        changed_b["session_resource_epoch"] = "session-opaque-B@201"
        before["source_owner"] = changed_b
        with self.assertRaises(DevelopmentBrowserChainError):
            wrong_scope.record_before(before)

    def test_deep_copies_input_and_output_snapshots(self) -> None:
        ledger = DevelopmentBrowserChainLedger(NONCE, GENERATION)
        before = evidence(1, "before")
        original_scene_hash = before["snapshot"]["scene_sha256"]
        ledger.record_before(before)
        before["snapshot"]["scene_sha256"] = "0" * 64
        ledger.record_restored(evidence(1, "restored"))
        ledger.record_after(evidence(1, "after"))

        exposed = ledger.snapshot()
        exposed["cycles"][0]["before"]["snapshot"]["scene_sha256"] = "1" * 64
        exposed["cycles"][0]["restored"]["snapshot"]["phase"] = "mutated"
        self.assertEqual(ledger.snapshot()["cycles"][0]["before"]["snapshot"]["scene_sha256"], original_scene_hash)
        self.assertEqual(ledger.snapshot()["cycles"][0]["restored"]["snapshot"]["phase"], "restored")


if __name__ == "__main__":
    unittest.main()
