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


if __name__ == "__main__":
    unittest.main()
