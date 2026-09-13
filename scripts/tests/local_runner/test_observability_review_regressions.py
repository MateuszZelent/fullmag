"""Regression checks using the actual worker receipt contract."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from local_runner.observability import ObservabilityHub, build_job_timeline, _probe_docker_root


class StorageReviewTests(unittest.TestCase):
    def test_unknown_docker_backing_does_not_substitute_host_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch('local_runner.coordinator.docker', side_effect=OSError('unavailable')):
                path, _, filesystem = _probe_docker_root(root)
            self.assertEqual(str(root), path)
            self.assertIsNone(filesystem)

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
