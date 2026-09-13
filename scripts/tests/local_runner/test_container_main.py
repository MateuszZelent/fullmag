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
    def __init__(self, active=None, queued=None, jobs=None):
        self.active_jobs = list(active or [])
        self.queued = queued
        self.submitted = []
        self.jobs = list(jobs or [])

    def active(self):
        return list(self.active_jobs)

    def next_queued(self, owner):
        return self.queued

    def submit(self, **payload):
        self.submitted.append(payload)
        return {"job_id": "job-1", "state": "queued"}

    def list(self, owner=None, limit=100):
        return list(self.jobs)

    def get(self, job_id):
        for j in self.jobs + self.active_jobs:
            if j.get("job_id") == job_id:
                return j
        return None


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
        from local_runner.observability import ObservabilityHub
        app.hub = ObservabilityHub(self.root, owner=app.owner)
        app._lifecycle_lock = threading.RLock()
        app._worker_thread = None
        app._worker_state = "starting"
        app._worker_error = None
        app._worker_result = None
        app._worker_started_at = None
        app._worker_finished_at = None
        app._worker_samples_by_job = {}
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

    def test_paginated_jobs_and_job_detail_with_pinned_state(self):
        sample_jobs = [
            {"job_id": "job-1", "worktree_id": "wt-alpha", "state": "succeeded", "profile": "fem-cpu-release", "created_at": 100, "started_at": 105, "updated_at": 130},
            {"job_id": "job-2", "worktree_id": "wt-beta", "state": "failed", "profile": "fem-gpu-release", "created_at": 200, "started_at": 205, "updated_at": 210},
            {"job_id": "job-3", "worktree_id": "wt-alpha", "state": "running", "profile": "fem-cpu-release", "created_at": 300, "started_at": 305, "updated_at": 310},
        ]
        app = self.app(FakeQueue(jobs=sample_jobs))
        from local_runner.observability import ObservabilityHub
        app.hub = ObservabilityHub(self.root)

        # 1. Query with status='history' returns only terminal jobs (job-1, job-2)
        res = app.paginated_jobs({"status": "history"})
        self.assertEqual(2, res["total"])
        self.assertEqual(["job-2", "job-1"], [j["job_id"] for j in res["items"]])
        self.assertEqual(["wt-alpha", "wt-beta"], res["worktrees"])

        # 2. Sort by oldest
        res_oldest = app.paginated_jobs({"sort": "oldest"})
        self.assertEqual("job-1", res_oldest["items"][0]["job_id"])

        # 3. Sort by duration
        res_dur = app.paginated_jobs({"sort": "duration"})
        self.assertEqual("job-1", res_dur["items"][0]["job_id"])  # 25s vs 5s

        # 4. Filter by worktree
        res_wt = app.paginated_jobs({"worktree": "wt-beta"})
        self.assertEqual(1, res_wt["total"])
        self.assertEqual("job-2", res_wt["items"][0]["job_id"])

        # 5. job_detail checks pinned status
        app.get = lambda jid: dict(sample_jobs[0])
        detail_unpinned = app.job_detail("job-1")
        self.assertFalse(detail_unpinned["is_pinned"])

        # Pin the resource
        app.hub.set_pinned("exec-wt-alpha-job-1", True, "Test pin")
        detail_pinned = app.job_detail("job-1")
        self.assertTrue(detail_pinned["is_pinned"])
        self.assertEqual("Test pin", detail_pinned["pin_reason"])

    def test_main_port_resolution_default_and_env(self):
        import os
        from unittest.mock import patch

        with patch("local_runner.container_main.Path") as mock_path, \
             patch("local_runner.container_main.Application") as mock_app_cls, \
             patch("local_runner.container_api.serve") as mock_serve:
            mock_path.return_value.read_text.return_value = json.dumps({"storage_root": "/storage"})
            mock_app = mock_app_cls.return_value
            mock_app.start_worker.return_value = None

            with patch.dict(os.environ, {}, clear=True):
                container_main.main()
                self.assertEqual(48765, mock_serve.call_args[1]["port"])

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": "59999"}):
                container_main.main()
                self.assertEqual(59999, mock_serve.call_args[1]["port"])

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": ""}):
                container_main.main()
                self.assertEqual(48765, mock_serve.call_args[1]["port"])

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": "invalid"}):
                container_main.main()
                self.assertEqual(48765, mock_serve.call_args[1]["port"])

    def test_overview_and_processes_real_metrics(self):
        import os
        app = self.app(FakeQueue(jobs=[]))
        app.health = lambda: {
            "ok": True,
            "worker_alive": True,
            "worker_state": "running",
            "worker_error": None,
            "accepting_jobs": True,
            "service_status": {"started_at": "2026-09-13T12:00:00Z"},
            "storage_free_bytes": 100 * 1024**3,
        }

        # 1. Idle worker overview: worker metrics are None, never mock 340.0 / 8192 / 2.5
        ov = app.overview()
        self.assertIsNone(ov["worker"]["memory_mb"])
        self.assertIsNone(ov["worker"]["limit_mb"])
        self.assertIsNone(ov["worker"]["cpu_percent"])

        # 2. Idle worker processes: coordinator PID is real int, worker is idle with '—'
        procs = app.processes()
        self.assertEqual(2, len(procs))
        coord_proc = procs[0]
        worker_proc = procs[1]

        self.assertEqual(f"coord-pid-{os.getpid()}", coord_proc["id"])
        self.assertNotEqual("coord-pid-1", coord_proc["id"])
        self.assertEqual("running", coord_proc["status"])
        self.assertIn("MiB", coord_proc["ram"]) if "MiB" in coord_proc["ram"] else self.assertEqual("niedostępne", coord_proc["ram"])

        self.assertEqual("worker-idle", worker_proc["id"])
        self.assertEqual("idle", worker_proc["status"])
        self.assertEqual("—", worker_proc["cpu"])
        self.assertEqual("—", worker_proc["ram"])
        self.assertEqual("—", worker_proc["io"])
        self.assertEqual("brak aktywnego kontenera", worker_proc["cmd"])

    def test_job_events_historical_journal_and_memory_merging(self):
        job = {
            "job_id": "job-abc-123",
            "owner": "alice",
            "profile": "fem-cpu-release",
            "worktree_id": "wt-test",
            "created_at": 1773000000.0,
            "started_at": 1773000010.0,
            "finished_at": 1773000030.0,
            "state": "succeeded",
        }
        app = self.app(FakeQueue(jobs=[job]))
        run_dir = self.root / "runs" / "wt-test" / "job-abc-123"
        run_dir.mkdir(parents=True, exist_ok=True)
        journal = {
            "job_id": "job-abc-123",
            "started_at": 1773000010.0,
            "finished_at": 1773000030.0,
            "state": "succeeded",
        }
        (run_dir / "coordinator.json").write_text(json.dumps(journal), encoding="utf-8")

        events = app.job_events("job-abc-123")
        self.assertEqual(3, len(events))
        self.assertEqual("job_queued", events[0]["event"])
        self.assertEqual("job_claimed", events[1]["event"])
        self.assertEqual("job_terminal", events[2]["event"])
        self.assertEqual(20.0, events[2]["duration_seconds"])

    def test_alerts_none_tolerance(self):
        app = self.app(FakeQueue(jobs=[]))
        app.health = lambda: {"worker_error": None, "legacy_jobs": []}
        app.hub.get_storage_volumes = lambda: [{"free_bytes": None, "critical_threshold_bytes": None}]
        alerts = app.alerts()
        self.assertEqual([], alerts)

    def test_job_metrics_honest_scoping(self):
        job = {
            "job_id": "job-inactive-999",
            "owner": "alice",
            "profile": "fem-cpu-release",
            "worktree_id": "wt-test",
            "state": "succeeded",
        }
        app = self.app(FakeQueue(jobs=[job]))
        # Inactive/completed job MUST return empty list, never coordinator process trends!
        metrics = app.job_metrics("job-inactive-999")
        self.assertEqual([], metrics)

        # Active job with worker metrics
        active_job = {
            "job_id": "job-active-123",
            "owner": "alice",
            "profile": "fem-cpu-release",
            "worktree_id": "wt-test",
            "state": "running",
        }
        app_active = self.app(FakeQueue(active=[active_job]))
        app_active._inspect_worker_metrics = lambda current_job: {
            "container_id": "cid-123",
            "memory_mb": 512.0,
            "limit_mb": 8192,
            "cpu_percent": 45.0,
            "io_mb_s": None,
        }
        active_metrics = app_active.job_metrics("job-active-123")
        self.assertEqual(1, len(active_metrics))
        self.assertEqual("worker", active_metrics[0]["scope"])
        self.assertEqual("job-active-123", active_metrics[0]["job_id"])
        self.assertEqual(512.0, active_metrics[0]["ram_mb"])
        self.assertEqual(45.0, active_metrics[0]["cpu_percent"])

        # Second sample with changing values accumulates
        app_active._inspect_worker_metrics = lambda current_job: {
            "container_id": "cid-123",
            "memory_mb": 600.0,
            "limit_mb": 8192,
            "cpu_percent": 55.0,
            "io_mb_s": None,
        }
        active_metrics2 = app_active.job_metrics("job-active-123")
        self.assertEqual(2, len(active_metrics2))
        self.assertEqual(600.0, active_metrics2[1]["ram_mb"])
        self.assertEqual(55.0, active_metrics2[1]["cpu_percent"])

    def test_job_detail_enriches_timestamps_from_journal_and_receipt(self):
        job = {
            "job_id": "job-time-test",
            "owner": "alice",
            "profile": "fem-cpu-release",
            "worktree_id": "wt-time",
            "state": "succeeded",
            "created_at": 1773000000.0,
            # Note: started_at and finished_at are missing from queue record
        }
        app = self.app(FakeQueue(jobs=[job]))
        run_dir = self.root / "runs" / "wt-time" / "job-time-test"
        run_dir.mkdir(parents=True, exist_ok=True)
        journal = {
            "job_id": "job-time-test",
            "started_at": 1773000010.0,
            "finished_at": 1773000050.0,
            "state": "succeeded",
        }
        (run_dir / "coordinator.json").write_text(json.dumps(journal), encoding="utf-8")

        detail = app.job_detail("job-time-test")
        self.assertEqual(1773000010.0, detail["started_at"])
        self.assertEqual(1773000050.0, detail["finished_at"])

    def test_overview_last_cleanup_honest_zero_reclaimed_when_not_applied(self):
        app = self.app(FakeQueue(jobs=[]))
        app.health = lambda: {
            "ok": True,
            "worker_alive": False,
            "worker_state": "idle",
            "worker_error": None,
            "accepting_jobs": True,
            "service_status": {"started_at": "2026-09-13T12:00:00Z"},
            "storage_free_bytes": 100 * 1024**3,
        }
        app.hub._plans["plan-test"] = {
            "plan_id": "plan-test",
            "created_at": "2026-09-13T12:00:00Z",
            "status": "preview",
            "candidates_count": 1,
            "estimated_reclaimed_bytes": 4096,
            "applied": False,
        }
        ov = app.overview()
        self.assertEqual(4096, ov["last_cleanup"]["estimated_reclaimed_bytes"])
        self.assertEqual(0, ov["last_cleanup"]["reclaimed_bytes"])

    def test_paginated_jobs_sqlite_full_pagination_over_1000_items(self):
        db_path = self.root / "index" / "queue.db"
        jq = JobQueue(db_path)
        with jq.connection() as db:
            records = [
                (f"job-{i:04d}", "alice", f"req-{i}", "h" * 64, f"wt-{i % 5}", "a" * 64, "fem-cpu-release", "build", "{}", "succeeded", 1000.0 + i, 1005.0 + i)
                for i in range(1050)
            ]
            db.executemany(
                "INSERT INTO jobs (job_id, owner, request_key, request_hash, worktree_id, source_digest, profile, operation, payload, state, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                records,
            )

        app = self.app(jq)
        res_page1 = app.paginated_jobs({"page": 1, "limit": 50})
        self.assertEqual(1050, res_page1["total"])
        self.assertEqual(50, len(res_page1["items"]))
        self.assertFalse(res_page1["is_truncated"])
        self.assertEqual(21, res_page1["pages"])

        res_page21 = app.paginated_jobs({"page": 21, "limit": 50})
        self.assertEqual(50, len(res_page21["items"]))


if __name__ == "__main__":
    unittest.main()
