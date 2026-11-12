import copy
import unittest

from scripts import fullmag_data_volume_journal as journal


VOLUME_ID = "a" * 32
REQUEST_SHA256 = "b" * 64
INPUTS_SHA256 = "c" * 64
RECEIPT_SHA256 = "d" * 64


class DataVolumeJournalTests(unittest.TestCase):
    def test_copy_requires_drain_and_retirement_requires_published_registration(self):
        value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
        phases = ('image-created', 'image-attached', 'ext4-mounted', 'group-drained',
                  'copy-verified', 'binds-switched', 'admission-prepared',
                  'runtime-qualified', 'zarr-qualified', 'volume-registered', 'originals-retired')
        for phase in phases:
            if phase == 'group-drained':
                with self.assertRaises(ValueError):
                    journal.append_started(value, 'copy-verified', INPUTS_SHA256)
            if phase == 'volume-registered':
                with self.assertRaises(ValueError):
                    journal.append_started(value, 'originals-retired', INPUTS_SHA256)
            value = journal.append_started(value, phase, INPUTS_SHA256)
            value = journal.append_terminal(value, 'succeeded', RECEIPT_SHA256)
        self.assertIsNone(journal.next_phase(value))

    def test_new_journal_is_empty_and_points_to_first_phase(self):
        value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)

        self.assertEqual(
            value,
            {
                "schema": "fullmag.data-volume-journal.v1",
                "volume_id": VOLUME_ID,
                "request_sha256": REQUEST_SHA256,
                "events": [],
            },
        )
        self.assertEqual(journal.next_phase(value), "image-created")

    def test_successful_phases_advance_in_exact_order(self):
        value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)

        for phase in journal.PHASES:
            self.assertEqual(journal.next_phase(value), phase)
            value = journal.append_started(value, phase, INPUTS_SHA256)
            with self.assertRaises(ValueError):
                journal.next_phase(value)
            value = journal.append_terminal(value, "succeeded", RECEIPT_SHA256)

        self.assertIsNone(journal.next_phase(value))
        self.assertEqual([event["sequence"] for event in value["events"]], list(range(1, 23)))
        self.assertEqual(
            [event["phase"] for event in value["events"]],
            [phase for phase in journal.PHASES for _ in range(2)],
        )

    def test_pending_phase_blocks_next_phase_and_new_start(self):
        value = journal.append_started(
            journal.new_journal(VOLUME_ID, REQUEST_SHA256),
            "image-created",
            INPUTS_SHA256,
        )
        before = copy.deepcopy(value)

        with self.assertRaises(ValueError):
            journal.next_phase(value)
        with self.assertRaises(ValueError):
            journal.append_started(value, "image-attached", INPUTS_SHA256)

        self.assertEqual(value, before)

    def test_failed_and_unknown_terminal_states_never_replay_or_advance(self):
        for state in ("failed-confirmed", "outcome-unknown-resources-retained"):
            with self.subTest(state=state):
                value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
                value = journal.append_started(value, "image-created", INPUTS_SHA256)
                value = journal.append_terminal(value, state, RECEIPT_SHA256)
                before = copy.deepcopy(value)

                with self.assertRaises(ValueError):
                    journal.next_phase(value)
                with self.assertRaises(ValueError):
                    journal.append_started(value, "image-created", INPUTS_SHA256)
                with self.assertRaises(ValueError):
                    journal.append_terminal(value, "succeeded", RECEIPT_SHA256)

                self.assertEqual(value, before)

    def test_terminal_is_compare_and_set_for_one_started_event(self):
        value = journal.append_started(
            journal.new_journal(VOLUME_ID, REQUEST_SHA256),
            "image-created",
            INPUTS_SHA256,
        )
        before = copy.deepcopy(value)

        result = journal.append_terminal(value, "succeeded", RECEIPT_SHA256)

        self.assertEqual(value, before)
        self.assertEqual(result["events"][0]["state"], "started")
        self.assertEqual(result["events"][1]["state"], "succeeded")
        self.assertEqual(result["events"][0]["inputs_sha256"], INPUTS_SHA256)
        self.assertEqual(result["events"][1]["inputs_sha256"], INPUTS_SHA256)
        self.assertEqual(result["events"][1]["receipt_sha256"], RECEIPT_SHA256)
        with self.assertRaises(ValueError):
            journal.append_terminal(result, "succeeded", RECEIPT_SHA256)

    def test_append_started_returns_new_journal_without_mutating_fixture(self):
        value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
        before = copy.deepcopy(value)

        result = journal.append_started(value, "image-created", INPUTS_SHA256)

        self.assertEqual(value, before)
        self.assertIsNot(result, value)
        self.assertEqual(len(result["events"]), 1)

    def test_started_phase_may_be_the_last_incomplete_event(self):
        value = journal.append_started(
            journal.new_journal(VOLUME_ID, REQUEST_SHA256),
            "image-created",
            INPUTS_SHA256,
        )

        self.assertEqual(journal.validate_journal(value), value)
        with self.assertRaises(ValueError):
            journal.next_phase(value)

    def test_validator_returns_an_independent_copy(self):
        value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
        value = journal.append_started(value, "image-created", INPUTS_SHA256)
        before = copy.deepcopy(value)

        result = journal.validate_journal(value)

        self.assertEqual(result, before)
        self.assertEqual(value, before)
        self.assertIsNot(result, value)
        self.assertIsNot(result["events"], value["events"])
        self.assertIsNot(result["events"][0], value["events"][0])

    def test_append_rejects_changed_terminal_input_digest(self):
        value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
        value = journal.append_started(value, "image-created", INPUTS_SHA256)
        corrupted = copy.deepcopy(value)
        corrupted["events"][0]["inputs_sha256"] = "e" * 64
        corrupted["events"].append(
            {
                "sequence": 2,
                "phase": "image-created",
                "state": "succeeded",
                "inputs_sha256": INPUTS_SHA256,
                "receipt_sha256": RECEIPT_SHA256,
            }
        )

        with self.assertRaises(ValueError):
            journal.validate_journal(corrupted)

    def test_validator_rejects_bad_schema_ids_and_open_top_level(self):
        valid = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
        mutations = []
        wrong_schema = copy.deepcopy(valid)
        wrong_schema["schema"] = "fullmag.data-volume-journal.v2"
        mutations.append(wrong_schema)
        zero_volume = copy.deepcopy(valid)
        zero_volume["volume_id"] = "0" * 32
        mutations.append(zero_volume)
        bad_request = copy.deepcopy(valid)
        bad_request["request_sha256"] = "B" * 64
        mutations.append(bad_request)
        unknown = copy.deepcopy(valid)
        unknown["extra"] = True
        mutations.append(unknown)
        del_top_key = copy.deepcopy(valid)
        del del_top_key["events"]
        mutations.append(del_top_key)

        for value in mutations:
            with self.subTest(value=value), self.assertRaises(ValueError):
                journal.validate_journal(value)

    def test_validator_rejects_sequence_phase_terminal_and_event_shape_drift(self):
        good = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
        good = journal.append_started(good, "image-created", INPUTS_SHA256)
        good = journal.append_terminal(good, "succeeded", RECEIPT_SHA256)

        mutations = []
        wrong_sequence = copy.deepcopy(good)
        wrong_sequence["events"][1]["sequence"] = True
        mutations.append(wrong_sequence)
        wrong_order = copy.deepcopy(good)
        wrong_order["events"][0]["phase"] = "image-attached"
        mutations.append(wrong_order)
        terminal_without_start = copy.deepcopy(good)
        terminal_without_start["events"].pop(0)
        terminal_without_start["events"][0]["sequence"] = 1
        mutations.append(terminal_without_start)
        changed_inputs = copy.deepcopy(good)
        changed_inputs["events"][1]["inputs_sha256"] = "e" * 64
        mutations.append(changed_inputs)
        unknown_event_key = copy.deepcopy(good)
        unknown_event_key["events"][0]["receipt"] = "ignored"
        mutations.append(unknown_event_key)
        truncated_event = copy.deepcopy(good)
        del truncated_event["events"][0]["receipt_sha256"]
        mutations.append(truncated_event)
        bad_started_receipt = copy.deepcopy(good)
        bad_started_receipt["events"][0]["receipt_sha256"] = RECEIPT_SHA256
        mutations.append(bad_started_receipt)
        bad_terminal_receipt = copy.deepcopy(good)
        bad_terminal_receipt["events"][1]["receipt_sha256"] = None
        mutations.append(bad_terminal_receipt)
        duplicate_phase = copy.deepcopy(good)
        duplicate_phase["events"].extend(
            [
                {
                    "sequence": 3,
                    "phase": "image-created",
                    "state": "started",
                    "inputs_sha256": INPUTS_SHA256,
                    "receipt_sha256": None,
                }
            ]
        )
        mutations.append(duplicate_phase)

        for value in mutations:
            with self.subTest(value=value), self.assertRaises(ValueError):
                journal.validate_journal(value)

    def test_append_rejects_invalid_phase_state_and_hashes(self):
        value = journal.new_journal(VOLUME_ID, REQUEST_SHA256)
        invalid_calls = (
            lambda: journal.new_journal("0" * 32, REQUEST_SHA256),
            lambda: journal.new_journal(VOLUME_ID, "z" * 64),
            lambda: journal.append_started(value, "image-attached", INPUTS_SHA256),
            lambda: journal.append_started(value, "image-created", "z" * 64),
            lambda: journal.append_terminal(value, "succeeded", RECEIPT_SHA256),
            lambda: journal.append_terminal(
                journal.append_started(value, "image-created", INPUTS_SHA256),
                "started",
                RECEIPT_SHA256,
            ),
        )
        for call in invalid_calls:
            with self.assertRaises(ValueError):
                call()


if __name__ == "__main__":
    unittest.main()
