from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


SCRIPT_ROOT = Path(__file__).resolve().parents[2]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from local_runner import container_main  # noqa: E402
from local_runner.service import ServicePaths, read_stop_request  # noqa: E402


class FakeQueue:
    def __init__(self, active=None, queued=None):
        self.active_jobs = list(active or [])
        self.queued = queued
        self.submitted = []

    def active(self):
        return list(self.active_jobs)

    def next_queued(self, owner):
        return self.queued

    def submit(self, **payload):
        self.submitted.append(payload)
        return {"job_id": "job-1", "state": "queued"}

    def list(self, owner=None):
        return []


class LiveThread:
    def is_alive(self):
        return True


class ContainerMainTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

    def app(self, queue=None):
        app = container_main.Application.__new__(container_main.Application)
        app.storage = self.root
        app.owner = "alice"
        app.paths = ServicePaths.from_storage(self.root)
        app.queue = queue or FakeQueue()
        app._lifecycle_lock = threading.RLock()
        app._worker_thread = None
        app._worker_state = "starting"
        app._worker_error = None
        app._worker_result = None
        app._worker_started_at = None
        app._worker_finished_at = None
        return app

    def test_live_worker_accepts_a_build_submission_while_callback_blocks(self):
        queue = FakeQueue()
        app = self.app(queue)
        release = threading.Event()
        app.run = lambda: (release.wait(2), {"state": "stopped"})[1]
        app.start_worker()
        try:
            (self.root / "index").mkdir()
            (self.root / "index" / "wt.json").write_text(
                json.dumps({"worktree_id": "wt", "repo_root": "C:/repo"}), encoding="utf-8"
            )
            payload = {
                "worktree_id": "wt",
                "source_digest": "a" * 64,
                "profile": "fem-cpu-release",
                "operation": "build",
                "request_key": "request-1",
                "payload": {
                    "source_mode": "snapshot",
                    "capsule_relative": "runs/wt/" + "b" * 32 + "/source",
                    "origin_repo": "C:/repo",
                    "capture_id": "b" * 32,
                    "native_source_identity": {},
                },
            }
            manifest = {"source_mode": "snapshot", "repo_root": "C:/repo"}
            with patch.object(container_main, "capsule_path", return_value=self.root), \
                    patch.object(container_main, "submission_manifest", return_value=manifest), \
                    patch.object(container_main, "bind_identity", return_value={}):
                result = app.submit(payload)
            self.assertEqual("queued", result["state"])
            self.assertEqual(1, len(queue.submitted))
            self.assertTrue(app.health()["accepting_jobs"])
        finally:
            release.set()
            app._worker_thread.join(timeout=2)

    def test_submission_reads_metadata_without_hashing_tree(self):
        import hashlib
        manifest = {'schema_version': container_main.SCHEMA, 'source_mode': 'snapshot',
                    'resolved_commit': 'a' * 40, 'files': [], 'deleted': [],
                    'included_untracked': [], 'excluded': []}
        digest = hashlib.sha256(container_main.canonical(manifest)).hexdigest()
        manifest['source_digest'] = digest
        (self.root / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        self.assertEqual(manifest, container_main.submission_manifest(self.root, digest))
        with self.assertRaises(ValueError):
            container_main.submission_manifest(self.root, 'b' * 64)

    def test_paused_worker_is_healthy_but_submission_is_rejected_until_resume(self):
        app = self.app()
        app._worker_state = "paused"
        app.stop()
        health = app.health()
        self.assertTrue(health["ok"])
        self.assertFalse(health["accepting_jobs"])
        with self.assertRaises(container_main.APIUnavailable):
            app.submit({})
        app.run = lambda: {"state": "stopped"}
        result = app.resume()
        self.assertTrue(result["resumed"])
        self.assertFalse(read_stop_request(app.paths))
        app._worker_thread.join(timeout=2)

    def test_legacy_active_operation_fails_closed_in_health(self):
        app = self.app(FakeQueue(active=[{"job_id": "old", "operation": "verify-source"}]))
        app._worker_state = "running"
        app._worker_thread = LiveThread()
        health = app.health()
        self.assertFalse(health["ok"])
        self.assertFalse(health["accepting_jobs"])
        self.assertEqual(["old"], [job["job_id"] for job in health["legacy_jobs"]])
        self.assertIn("manual recovery", health["worker_error"])


if __name__ == "__main__":
    unittest.main()
