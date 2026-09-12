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
from local_runner.queue import JobQueue, QueueError  # noqa: E402
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

    def list(self, owner=None, limit=100):
        return []


class LiveThread:
    def is_alive(self):
        return True


class ContainerMainTests(unittest.TestCase):
    def test_run_preserves_service_terminal_result(self):
        app = self.app()
        app.layout = {}
        with patch.object(container_main, 'RunnerService') as service:
            service.return_value.run.return_value = {'state': 'stopped'}
            self.assertEqual({'state': 'stopped'}, app.run())

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

    def test_resume_during_blocked_callback_preserves_drain(self):
        app = self.app()
        callback_started = threading.Event()
        release_callback = threading.Event()

        def blocked_run():
            callback_started.set()
            self.assertTrue(release_callback.wait(2))
            return {'state': 'stopped'}

        app.run = blocked_run
        app.start_worker()
        try:
            self.assertTrue(callback_started.wait(2))
            app.stop()
            self.assertFalse(app.health()['accepting_jobs'])

            resumed = app.resume()

            self.assertFalse(resumed['resumed'])
            self.assertFalse(resumed['worker_started'])
            self.assertEqual('stopping', resumed['worker_state'])
            self.assertTrue(resumed['worker_alive'])
            self.assertFalse(app.health()['accepting_jobs'])
            self.assertTrue(read_stop_request(app.paths))
        finally:
            release_callback.set()
            app._worker_thread.join(timeout=2)

    def test_resume_after_stop_decision_refuses_then_restarts_once(self):
        app = self.app()
        callback_started = threading.Event()
        stop_requested = threading.Event()
        stop_decided = threading.Event()
        release_old_worker = threading.Event()
        replacement_started = threading.Event()
        release_replacement = threading.Event()
        counters_lock = threading.Lock()
        run_count = 0
        active_count = 0
        max_active_count = 0

        def run():
            nonlocal run_count, active_count, max_active_count
            with counters_lock:
                run_count += 1
                active_count += 1
                max_active_count = max(max_active_count, active_count)
                current_run = run_count
            try:
                if current_run == 1:
                    callback_started.set()
                    stop_requested.wait(2)
                    # The service has decided to stop but the worker entry has
                    # not yet consumed the terminal result.
                    app.paths.state_path.parent.mkdir(parents=True, exist_ok=True)
                    app.paths.state_path.write_text(json.dumps({'state': 'stopped'}), encoding='utf-8')
                    stop_decided.set()
                    release_old_worker.wait(2)
                else:
                    replacement_started.set()
                    release_replacement.wait(2)
                return {'state': 'stopped'}
            finally:
                with counters_lock:
                    active_count -= 1

        app.run = run
        app.start_worker()
        old_thread = None
        try:
            self.assertTrue(callback_started.wait(2))
            app.stop()
            stop_requested.set()
            self.assertTrue(stop_decided.wait(2))
            old_thread = app._worker_thread

            resumed = app.resume()

            self.assertFalse(resumed['worker_started'])
            self.assertFalse(resumed['resumed'])
            self.assertEqual('stopping', resumed['worker_state'])
            self.assertTrue(resumed['worker_alive'])
            self.assertTrue(resumed['stop_requested'])
            self.assertTrue(read_stop_request(app.paths))
            release_old_worker.set()
            old_thread.join(timeout=2)
            self.assertFalse(old_thread.is_alive())
            self.assertEqual('paused', app._worker_state)

            resumed_after_stop = app.resume()

            self.assertTrue(resumed_after_stop['resumed'])
            self.assertTrue(resumed_after_stop['worker_started'])
            self.assertTrue(replacement_started.wait(2))
            self.assertIsNot(old_thread, app._worker_thread)
            with counters_lock:
                self.assertEqual(2, run_count)
                self.assertEqual(1, max_active_count)
            self.assertTrue(app.health()['accepting_jobs'])

            second_resume = app.resume()
            self.assertFalse(second_resume['worker_started'])
            with counters_lock:
                self.assertEqual(2, run_count)
        finally:
            release_old_worker.set()
            release_replacement.set()
            if old_thread is not None:
                old_thread.join(timeout=2)
            if app._worker_thread is not old_thread and app._worker_thread is not None:
                app._worker_thread.join(timeout=2)

    def test_submit_idempotency_identity_includes_native_source_identity(self):
        queue = JobQueue(self.root / 'runner-jobs.sqlite')
        app = self.app(queue)
        app._worker_state = 'running'
        app._worker_thread = LiveThread()
        (self.root / 'index').mkdir()
        (self.root / 'index' / 'wt.json').write_text(
            json.dumps({'worktree_id': 'wt', 'repo_root': 'C:/repo'}), encoding='utf-8'
        )
        native_identity = {
            'schema': 'fullmag.source-snapshot.v2',
            'source_snapshot_sha256': '1' * 64,
        }
        payload = {
            'worktree_id': 'wt',
            'source_digest': 'a' * 64,
            'profile': 'fem-cpu-release',
            'operation': 'build',
            'request_key': 'request-identity',
            'payload': {
                'source_mode': 'snapshot',
                'capsule_relative': 'runs/wt/' + 'b' * 32 + '/source',
                'origin_repo': 'C:/repo',
                'capture_id': 'b' * 32,
                'native_source_identity': native_identity,
            },
        }
        manifest = {'source_mode': 'snapshot', 'repo_root': 'C:/repo'}
        with patch.object(container_main, 'capsule_path', return_value=self.root), \
                patch.object(container_main, 'submission_manifest', return_value=manifest), \
                patch.object(container_main, 'bind_identity', return_value=native_identity):
            first = app.submit(payload)
            changed = dict(payload)
            changed['payload'] = dict(payload['payload'])
            changed['payload']['native_source_identity'] = {
                **native_identity,
                'source_snapshot_sha256': '2' * 64,
            }
            with self.assertRaises(QueueError):
                app.submit(changed)

        self.assertEqual('queued', first['state'])

    def test_retention_reports_bounded_queue_inventory(self):
        class BoundedQueue(FakeQueue):
            def list(self, owner=None, limit=100):
                self.requested_limit = limit
                return [{'job_id': f'job-{index}', 'state': 'succeeded'} for index in range(limit)]

        queue = BoundedQueue()
        app = self.app(queue)
        with patch.object(container_main, 'retention_plan', return_value={
            'schema': 'retention', 'candidates': [], 'retained': [],
        }):
            result = app.retention()

        self.assertEqual(1000, queue.requested_limit)
        self.assertEqual({'limit': 1000, 'truncated': True}, result['queue_inventory'])

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
