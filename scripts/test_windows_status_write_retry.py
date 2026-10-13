"""Interpreted, in-memory checks for bounded Windows status publication retries."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from windows import development_status as status


GENERATION = "1" * 32
WORKTREE = "fullmag-0123456789abcdef"
SOURCE = "a" * 64
DELAYS = (0.025, 0.05, 0.1, 0.2, 0.4)


def permission_error(code):
    error = PermissionError("controlled Windows replacement failure")
    error.winerror = code
    return error


class StatusWriteRetryTests(unittest.TestCase):
    def test_windows_transients_recover_with_the_same_heartbeat_document(self):
        for code in (5, 32, 33):
            with self.subTest(code=code), patch.object(status.os, "name", "nt"), \
                    patch.object(status, "atomic_json") as writer, \
                    patch.object(status.time, "sleep") as sleep:
                publisher = status.DevelopmentStatusPublisher(
                    Path("backend-watch-status.json"), GENERATION, WORKTREE, clock_ms=lambda: 1000,
                )
                initial = publisher.publish({"state": "waiting", "source_sha256": SOURCE})
                writer.reset_mock()
                writer.side_effect = [permission_error(code), permission_error(code), None]
                heartbeat = publisher.heartbeat()
                frames = [call.args[1] for call in writer.call_args_list]
                self.assertEqual(len(frames), 3)
                self.assertTrue(all(frame is frames[0] for frame in frames))
                self.assertEqual(frames[0], heartbeat)
                self.assertEqual(heartbeat["generation_id"], GENERATION)
                self.assertEqual(heartbeat["worktree_id"], WORKTREE)
                self.assertEqual(heartbeat["revision"], initial["revision"])
                self.assertEqual(heartbeat["updated_unix_ms"], initial["updated_unix_ms"] + 1)
                self.assertEqual([call.args[0] for call in sleep.call_args_list], list(DELAYS[:2]))
                self.assertIsNone(publisher._failure)

    def test_persistent_windows_failure_remains_fail_closed_with_original_exception(self):
        error = permission_error(5)
        with patch.object(status.os, "name", "nt"), patch.object(status, "atomic_json") as writer, \
                patch.object(status.time, "sleep") as sleep:
            publisher = status.DevelopmentStatusPublisher(
                Path("backend-watch-status.json"), GENERATION, WORKTREE, clock_ms=lambda: 1000,
            )
            initial = publisher.publish({"state": "waiting", "source_sha256": SOURCE})
            writer.reset_mock()
            writer.side_effect = error
            with self.assertRaises(PermissionError) as caught:
                publisher.heartbeat()
            self.assertIs(caught.exception, error)
            self.assertEqual(writer.call_count, 6)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], list(DELAYS))
            self.assertAlmostEqual(sum(DELAYS), 0.775)
            self.assertEqual(publisher._document, initial)
            with self.assertRaises(status.DevelopmentStatusError) as terminal:
                publisher.heartbeat()
            self.assertIs(terminal.exception.__cause__, error)
            self.assertEqual(writer.call_count, 6)

    def test_non_windows_and_unrelated_errors_never_retry(self):
        for platform, error in (("posix", permission_error(5)), ("nt", permission_error(13)),
                                ("nt", PermissionError("no Windows code")),
                                ("nt", OSError("unrelated failure"))):
            with self.subTest(platform=platform, error=error), patch.object(status.os, "name", platform), \
                    patch.object(status, "atomic_json", side_effect=error) as writer, \
                    patch.object(status.time, "sleep") as sleep:
                with self.assertRaises(type(error)) as caught:
                    status._write_status_json("backend-watch-status.json", {"state": "waiting"})
                self.assertIs(caught.exception, error)
                writer.assert_called_once()
                sleep.assert_not_called()

    def test_success_calls_only_the_existing_atomic_writer_without_sleep(self):
        document = {"generation_id": GENERATION, "revision": 7}
        with patch.object(status, "atomic_json") as writer, patch.object(status.time, "sleep") as sleep:
            status._write_status_json("backend-watch-status.json", document)
            writer.assert_called_once_with("backend-watch-status.json", document)
            sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
