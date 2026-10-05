"""Interpreted checks for early ownership evidence in the native pump driver."""
import unittest

from windows import verify_consumer_pump as pump


class PreparationProgressChecks(unittest.TestCase):
    def frame(self):
        return {"schema": pump.PREPARATION_PROGRESS_SCHEMA, "event": "started",
                "helper_pid": 1234,
                "api_instance_id": "12345678-1234-4234-8234-123456789abc",
                "ready_build_id": "a" * 64, "ready_source_sha256": "b" * 64}

    def collect(self, frames):
        return pump._preparation_starts(frames, "a" * 64, "b" * 64)

    def test_started_helper_is_retained_without_a_terminal_result(self):
        frame = self.frame()
        result = self.collect([{"schema": "other"}, frame])
        self.assertEqual(result, {1234: frame})
        frame["helper_pid"] = 9999
        self.assertEqual(result[1234]["helper_pid"], 1234)

    def test_invalid_or_unscoped_progress_is_rejected(self):
        for key, value in (("helper_pid", True), ("helper_pid", 0),
                           ("event", "terminal"), ("ready_build_id", "c" * 64),
                           ("ready_source_sha256", "c" * 64),
                           ("api_instance_id", "00000000-0000-0000-0000-000000000000"),
                           ("api_instance_id", "12345678-1234-4234-8234-123456789ABC"),
                           ("api_instance_id", "not-an-instance")):
            with self.subTest(key=key, value=value):
                frame = self.frame()
                frame[key] = value
                with self.assertRaises(pump.storage.StorageError):
                    self.collect([frame])
        frame = self.frame()
        frame["extra"] = "untrusted"
        with self.assertRaises(pump.storage.StorageError):
            self.collect([frame])

    def test_duplicate_helper_start_is_rejected(self):
        with self.assertRaises(pump.storage.StorageError):
            self.collect([self.frame(), self.frame()])

    def test_two_distinct_preparations_keep_the_same_owner_scope(self):
        first = self.frame()
        canceled = self.frame()
        canceled["helper_pid"] = 1235
        self.assertEqual(set(self.collect([first, canceled])), {1234, 1235})

    def test_valid_early_pid_survives_a_later_invalid_frame(self):
        retained = []
        invalid = self.frame()
        invalid["helper_pid"] = True
        with self.assertRaises(pump.storage.StorageError):
            pump._preparation_starts([self.frame(), invalid], "a" * 64, "b" * 64,
                                     retained.append)
        self.assertEqual(retained, [1234])


class TerminalHelperChecks(unittest.TestCase):
    def test_only_second_observed_preparation_can_be_canceled(self):
        starts = {1234: {}, 1235: {}}
        self.assertEqual(pump._canceled_preparation_pid({"canceled_helper_pid": 1235}, starts), 1235)
        for pid in (1234, 1236, True, None):
            with self.subTest(pid=pid):
                with self.assertRaises(pump.storage.StorageError):
                    pump._canceled_preparation_pid({"canceled_helper_pid": pid}, starts)
        with self.assertRaises(pump.storage.StorageError):
            pump._canceled_preparation_pid({"canceled_helper_pid": 1235}, {1235: {}})

    def test_nonzero_exit_is_legal_only_for_the_exact_canceled_helper(self):
        record = {"pid": 1235, "waited": True, "exit_code": 1}
        self.assertEqual(pump._terminal_helper(record, 1235), record)
        with self.assertRaises(pump.storage.StorageError):
            pump._terminal_helper(record, 1234)
        for code in (0, 7, -1):
            with self.subTest(code=code):
                pump._terminal_helper({**record, "exit_code": code}, 1235)

    def test_unknown_or_boolean_process_evidence_cannot_pass(self):
        record = {"pid": 1235, "waited": True, "exit_code": 0}
        for key, value in (("pid", True), ("pid", 0), ("waited", False),
                           ("waited", 1), ("exit_code", None),
                           ("exit_code", False), ("exit_code", "0")):
            with self.subTest(key=key, value=value):
                with self.assertRaises(pump.storage.StorageError):
                    pump._terminal_helper({**record, key: value}, 1235)
        with self.assertRaises(pump.storage.StorageError):
            pump._terminal_helper({**record, "outcome": "terminal"}, 1235)

    def test_terminal_record_is_copied_without_changing_actual_exit(self):
        record = {"pid": 1235, "waited": True, "exit_code": 1}
        captured = pump._terminal_helper(record, 1235)
        record["exit_code"] = 0
        self.assertEqual(captured["exit_code"], 1)


if __name__ == "__main__":
    unittest.main()
