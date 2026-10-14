"""Interpreted heartbeat failure propagation; no files, builds, or runtimes."""
from contextlib import nullcontext
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from windows import watch_backend
from windows.development_status import DevelopmentStatusError, DevelopmentStatusPublisher, StatusHeartbeat


GENERATION = "1" * 32
SOURCE = "a" * 64
WORKTREE = "heartbeat-fixture"


class FailedHeartbeatTests(unittest.TestCase):
    def test_failed_writer_is_reported_before_another_fingerprint_or_build(self):
        root = Path(__file__).resolve().parent
        layout = {"storage_root": str(root), "build_root": str(root), "runtime_root": str(root),
                  "repo_root": str(root), "worktree_id": WORKTREE, "profile": "windows-native-fdm-cpu-dev"}
        frames = []
        failure = PermissionError("controlled heartbeat writer failure")

        def write_json(_path, frame):
            if frames:
                raise failure
            frames.append(dict(frame))

        publisher = DevelopmentStatusPublisher(root / "not-written.json", GENERATION, WORKTREE,
                                               write_json=write_json)

        class DeterministicFailedHeartbeat(StatusHeartbeat):
            def __init__(self, value):
                super().__init__(value, interval_seconds=0.001)

            def start(self):
                super().start()
                self._thread.join(timeout=2)
                if self._thread.is_alive():
                    self.stop()
                    raise AssertionError("Controlled heartbeat did not terminate")
                return self

        with patch.object(watch_backend, "resolve_layout", return_value=layout), \
             patch.object(watch_backend, "validate_path", side_effect=lambda path, *_: path), \
             patch.object(watch_backend, "file_lock", return_value=nullcontext()), \
             patch.object(watch_backend.Path, "mkdir"), \
             patch.object(watch_backend, "make_publisher", return_value=publisher), \
             patch.object(watch_backend, "StatusHeartbeat", DeterministicFailedHeartbeat), \
             patch.object(watch_backend.sys, "platform", "win32"), \
             patch.object(watch_backend, "fingerprint", return_value={"sha256": SOURCE}) as fingerprint, \
             patch.object(watch_backend.subprocess, "run") as build:
            with self.assertRaises(DevelopmentStatusError) as raised:
                watch_backend.main(["--repo-root", str(root), "--baseline-digest", SOURCE,
                                    "--generation-id", GENERATION, "--once"])
            fingerprint.assert_not_called()
            build.assert_not_called()

        causes = []
        cause = raised.exception
        while cause is not None:
            causes.append(cause)
            cause = cause.__cause__
        self.assertIn(failure, causes)
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["generation_id"], GENERATION)
        self.assertEqual(frames[0]["worktree_id"], WORKTREE)
        self.assertEqual(frames[0]["revision"], 1)


if __name__ == "__main__":
    unittest.main()
