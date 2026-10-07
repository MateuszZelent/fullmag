"""Regression checks using the actual worker receipt contract."""
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from local_runner.observability import ObservabilityHub, build_job_timeline, _probe_docker_root
from local_runner.retention import PreviewCancelled


class StorageReviewTests(unittest.TestCase):
    def test_cancellable_hub_preview_propagates_orphan_scan_cancel_without_cache(self):
        from itertools import count

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            orphan = root / 'runs' / 'orphan-wt' / 'orphan-job' / 'execution'
            orphan.mkdir(parents=True)
            (orphan / 'result.bin').write_bytes(b'protected')
            hub = ObservabilityHub(root)

            cancellable = threading.Event()
            complete = hub.generate_retention_plan(cancelled=cancellable)
            self.assertEqual('preview', complete['status'])
            with hub._lock:
                self.assertNotIn(complete['plan_id'], hub._plans)

            cancelled = threading.Event()
            updates = []

            def progress(fields):
                updates.append(dict(fields))
                if fields.get('orphan_worktrees_enumerated') == 1:
                    cancelled.set()

            ticks = count()
            with patch('local_runner.observability.time.monotonic',
                       side_effect=lambda: float(next(ticks))):
                with self.assertRaises(PreviewCancelled):
                    hub.generate_retention_plan(cancelled=cancelled, progress=progress)

            self.assertTrue(cancelled.is_set())
            self.assertTrue(any(item.get('orphan_worktrees_enumerated') == 1 for item in updates))
            with hub._lock:
                self.assertEqual({}, hub._plans)

    def test_unknown_docker_backing_does_not_substitute_host_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('local_runner.coordinator.docker', side_effect=OSError('unavailable')):
                path, _, filesystem = _probe_docker_root(root)
            self.assertEqual(str(root), path)
            self.assertIsNone(filesystem)

    def test_selected_preview_never_reads_other_execution_trees(self):
        import time
        from local_runner.retention import inspect_execution
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hub = ObservabilityHub(root)
            jobs = []
            for identifier in ('a' * 32, 'b' * 32):
                job = {'job_id': identifier, 'owner': 'operator', 'worktree_id': 'wt',
                       'source_digest': 'c' * 64, 'state': 'succeeded', 'updated_at': time.time() - 172800}
                jobs.append(job)
                run = root / 'runs/wt' / identifier
                (run / 'execution').mkdir(parents=True)
                (run / 'execution/data.bin').write_bytes(b'123')
                (run / 'coordinator.json').write_text(json.dumps({
                    **job, 'schema': 'fullmag.local-runner.coordinator.v1',
                    'container_id': 'd' * 64, 'finished_at': job['updated_at']}))
            class Queue:
                def list(self, **kwargs): return jobs
            allowed = root / 'runs/wt' / jobs[0]['job_id'] / 'execution'
            def inspect(target):
                self.assertEqual(allowed, target)
                return inspect_execution(target)
            updates = []
            with patch('local_runner.retention.inspect_execution', side_effect=inspect):
                plan = hub.generate_retention_plan(queue=Queue(), job_ids=[jobs[0]['job_id']], progress=updates.append)
            self.assertEqual(1, plan['candidates_count'])
            self.assertEqual(3, plan['estimated_reclaimed_bytes'])
            other = next(row for row in plan['retained'] if row['job_id'] == jobs[1]['job_id'])
            self.assertIsNone(other['size_bytes'])
            self.assertEqual('outside_selected_scope', other['why_retained'])
            self.assertEqual(1, updates[-1]['processed_jobs'])
            self.assertEqual(1, updates[-1]['total_jobs'])

    def test_indexed_pin_prevents_execution_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            hub = ObservabilityHub(root)
            hub.set_pinned('exec-wt-' + 'a' * 32, True, 'Keep diagnostic execution')
            class Queue:
                def list(self, **kwargs):
                    return [{'job_id': 'a' * 32, 'owner': 'operator', 'worktree_id': 'wt', 'state': 'succeeded'}]
            with patch('local_runner.observability.retention_plan') as scan:
                result = hub.generate_retention_plan(queue=Queue(), job_ids=['a' * 32])
                scan.assert_not_called()
            self.assertEqual(0, result['candidates_count'])
            self.assertIsNone(result['retained'][0]['size_bytes'])
            self.assertIn('Keep diagnostic execution', result['retained'][0]['why_retained'])

    def test_foreign_or_unknown_selection_fails_before_tree_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            hub = ObservabilityHub(Path(directory))
            class Queue:
                def list(self, **kwargs):
                    return [{'job_id': 'a' * 32, 'owner': 'foreign', 'worktree_id': 'wt', 'state': 'succeeded'}]
            for ids in (['a' * 32], ['b' * 32]):
                with self.subTest(ids=ids), patch('local_runner.observability.retention_plan') as scan:
                    with self.assertRaises(ValueError): hub.generate_retention_plan(queue=Queue(), job_ids=ids)
                    scan.assert_not_called()

    def test_unavailable_disk_is_not_reported_as_zero_in_preview(self):
        with tempfile.TemporaryDirectory() as directory:
            hub = ObservabilityHub(Path(directory))
            with patch.object(hub, 'get_storage_volumes', return_value=[{'free_bytes': None}]):
                plan = hub.generate_retention_plan()
            self.assertIsNone(plan['disk_free_before_bytes'])
            self.assertIsNone(plan['disk_free_after_estimated_bytes'])

    def test_inventory_cache_also_applies_to_real_queue_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'cache' / 'cargo').mkdir(parents=True)
            hub = ObservabilityHub(root)
            queue = unittest.mock.Mock()
            queue.list.return_value = []
            queue.connection = None
            with patch('local_runner.observability._fast_dir_size', return_value=(0, 0, False)) as scan:
                first = hub.get_storage_resources(queue=queue)
                count = scan.call_count
                second = hub.get_storage_resources(queue=queue)
            self.assertEqual(first['measured_at'], second['measured_at'])
            self.assertEqual(count, scan.call_count)

    def test_legacy_automatic_policy_cannot_claim_automatic_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'index').mkdir()
            (root / 'index' / 'retention-policy.json').write_text(json.dumps({'mode': 'automatic'}))
            hub = ObservabilityHub(root)
            self.assertEqual('preview', hub.get_retention_policy()['mode'])


class TimelineReviewTests(unittest.TestCase):
    def test_worker_receipt_does_not_finish_a_running_queue_job(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / 'runs' / 'wt' / 'job' / 'artifacts'
            artifacts.mkdir(parents=True)
            receipt = {
                'schema': 'fullmag.local-runner.build-receipt.v1',
                'state': 'succeeded',
                'stages': [{'name': name, 'exit_code': 0, 'duration_ms': 1000}
                           for name in ('native-build', 'frontend-dependencies', 'frontend-build')],
            }
            (artifacts / 'build-receipt.json').write_text(json.dumps(receipt))
            stages = build_job_timeline({'job_id': 'job', 'worktree_id': 'wt', 'state': 'running'}, root)
            self.assertEqual('running', stages[5]['status'])
            self.assertEqual('pending', stages[6]['status'])
            self.assertNotIn('exit_code', stages[6])

    def test_failed_queue_does_not_report_receipt_verification_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            artifacts = root / 'runs' / 'wt' / 'job' / 'artifacts'
            artifacts.mkdir(parents=True)
            (artifacts / 'build-receipt.json').write_text(json.dumps({
                'state': 'succeeded', 'stages': [{'name': 'native-build', 'exit_code': 0}]}))
            stages = build_job_timeline({'job_id': 'job', 'worktree_id': 'wt', 'state': 'failed', 'exit_code': 1}, root)
            self.assertEqual('failed', stages[5]['status'])
            self.assertEqual('failed', stages[6]['status'])

    def test_negative_stage_exit_does_not_advance_to_next_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / 'runs' / 'wt' / 'job'
            run.mkdir(parents=True)
            (run / 'worker.log').write_text('[fullmag runner] stage native-build end exit_code=-9 duration_ms=1000\n')
            stages = build_job_timeline({'job_id': 'job', 'worktree_id': 'wt', 'state': 'running', 'started_at': 1}, root)
            self.assertEqual('failed', stages[2]['status'])
            self.assertEqual(-9, stages[2]['exit_code'])
            self.assertEqual('pending', stages[3]['status'])
