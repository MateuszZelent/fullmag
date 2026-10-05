import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from local_runner.observability import ObservabilityHub
from local_runner.retention_service import RetentionService


class Queue:
    def active(self):
        return []

    def list(self, **kwargs):
        return []


class RetentionServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'locks').mkdir()
        self.hub = ObservabilityHub(self.root)
        self.queue = Queue()
        self.service = RetentionService(self.hub, self.queue, {'storage_root': str(self.root)},
                                        owner='operator', call=lambda _: '')

    def finish(self):
        self.service.thread.join(timeout=5)
        self.assertFalse(self.service.busy)

    def test_preview_is_async_and_durable_and_apply_is_idempotent(self):
        entered = threading.Event()
        release = threading.Event()
        original = self.hub.generate_retention_plan
        def inventory(**kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return original(**kwargs)
        with patch.object(self.hub, 'generate_retention_plan', side_effect=inventory):
            accepted = self.service.preview()
            self.assertEqual('planning', accepted['status'])
            self.assertTrue(entered.wait(2))
            self.assertEqual('planning', self.service.get(accepted['plan_id'])['status'])
            self.assertNotIn('raw_engine_plan', self.service.get(accepted['plan_id']))
            release.set()
            self.finish()
        pid = accepted['plan_id']
        self.assertEqual('preview', self.service.get(pid)['status'])
        self.assertEqual('accepted', self.service.apply(pid)['status'])
        self.finish()
        result = self.service.get(pid)
        self.assertEqual('succeeded', result['status'])
        self.assertTrue(result['applied'])
        self.assertEqual(result, self.service.apply(pid))
        restored = RetentionService(self.hub, self.queue, {'storage_root': str(self.root)},
                                    owner='operator', call=lambda _: self.fail('Replay must not touch Docker'))
        self.assertEqual(result, restored.get(pid))

    def test_restart_does_not_turn_unknown_outcome_into_success_or_retry(self):
        pid = 'plan-01234567'
        self.service._save({'plan_id': pid, 'status': 'running'}, operation=True)
        result = self.service.apply(pid)
        self.assertEqual('interrupted_unknown', result['status'])
        self.assertFalse(result['applied'])

    def test_automatic_requires_opt_in_and_respects_drain(self):
        self.service.tick(force=True)
        self.assertIsNone(self.service.thread)
        policy = self.hub.set_retention_policy({'mode': 'automatic'})
        self.assertTrue(policy['automatic_mode_available'])
        self.assertEqual('automatic', policy['mode'])
        self.service.drain()
        self.service.tick(force=True)
        self.assertIsNone(self.service.thread)
        self.service.resume()
        self.service.tick(force=True)
        self.finish()
        self.assertTrue(self.service.get(self.service.active_id)['applied'])

    def test_active_lease_prevents_automatic_inventory(self):
        self.hub.set_retention_policy({'mode': 'automatic'})
        self.queue.active = lambda: [{'job_id': 'live'}]
        self.service.tick(force=True)
        self.assertIsNone(self.service.thread)

    def test_slow_inventory_does_not_hold_telemetry_mutex(self):
        entered, release = threading.Event(), threading.Event()
        def inventory(*args, **kwargs):
            entered.set()
            release.wait(5)
            return {'candidates': [], 'retained': []}
        self.queue.list = lambda **kwargs: [{'job_id': 'terminal'}]
        with patch('local_runner.observability.retention_plan', side_effect=inventory):
            self.service.preview()
            self.assertTrue(entered.wait(2))
            acquired = self.hub._lock.acquire(timeout=1)
            if acquired:
                self.hub._lock.release()
            release.set()
            self.finish()
        self.assertTrue(acquired)

    def test_traversal_id_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Invalid retention plan ID'):
            self.service.get('../receipt')

    def test_failed_inventory_is_not_a_successful_empty_cleanup(self):
        for origin in ('queue', 'filesystem'):
            with self.subTest(origin=origin):
                self.queue.list = lambda **kwargs: [{'job_id': 'terminal'}]
                target = (patch.object(self.queue, 'list', side_effect=PermissionError('queue inaccessible'))
                          if origin == 'queue' else
                          patch('local_runner.observability.retention_plan', side_effect=PermissionError('tree inaccessible')))
                with target:
                    accepted = self.service.preview()
                    self.finish()
                result = self.service.get(accepted['plan_id'])
                self.assertEqual('failed', result['status'])
                self.assertIn('inventory unavailable', result['error'])
                self.assertFalse(self.service.apply(accepted['plan_id'])['applied'])

    def test_build_admission_excludes_cleanup_without_blocking_api_mutex(self):
        accepted = self.service.preview()
        self.finish()
        with self.service.build_slot() as admitted:
            self.assertTrue(admitted)
            self.assertEqual('build_in_progress', self.service.apply(accepted['plan_id'])['error'])
            self.assertEqual('build_in_progress', self.service.preview()['error'])
            self.hub.set_retention_policy({'mode': 'automatic'})
            old = self.service.thread
            self.service.tick(force=True)
            self.assertIs(old, self.service.thread)
        self.assertFalse(self.service.build_running)

    def test_pin_cannot_change_during_cleanup(self):
        from fullmag_storage import file_lock, StorageError
        with file_lock(self.root / 'locks' / 'retention.lock', 'active cleanup'):
            with self.assertRaises(StorageError):
                self.hub.set_pinned('job', True)
        self.assertEqual({}, self.hub.get_pinned())

    def test_busy_preview_cannot_acknowledge_another_scope_or_selection(self):
        entered, release = threading.Event(), threading.Event()
        def inventory(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return {'scope': 'runtime', 'status': 'preview', 'candidates': [], 'retained': []}
        with patch('local_runner.runtime_retention.plan_runtime_cleanup', side_effect=inventory):
            original = self.service.preview(scope='runtime', job_ids=['a' * 32])
            self.assertTrue(entered.wait(2))
            for scope in ('runtime', 'sources', 'execution'):
                result = self.service.preview(scope=scope, job_ids=['b' * 32])
                self.assertEqual('blocked', result['status'])
                self.assertEqual(scope, result['scope'])
                self.assertNotIn('plan_id', result)
                self.assertEqual(original['plan_id'], result['active_plan_id'])
            release.set()
            self.finish()

    def test_source_scope_routes_preview_and_apply_without_execution_fallback(self):
        selected = ['a' * 32]
        with patch('local_runner.storage_maintenance.plan_source_compaction',
                   return_value={'scope': 'sources', 'status': 'preview', 'candidates': [], 'retained': []}) as preview:
            response = self.service.preview(scope='sources', job_ids=selected)
            self.finish()
        preview.assert_called_once_with(self.service.layout, self.queue, owner='operator', job_ids=selected)
        with patch('local_runner.storage_maintenance.apply_source_compaction',
                   return_value={'plan_id': response['plan_id'], 'scope': 'sources', 'status': 'succeeded', 'applied': True}) as apply, \
                patch('local_runner.retention_service.apply_execution_plan') as execution:
            self.service.apply(response['plan_id'])
            self.finish()
        apply.assert_called_once()
        execution.assert_not_called()

    def test_execution_scope_filters_before_scan_and_persists_real_progress(self):
        selected = ['a' * 32]
        entered, release = threading.Event(), threading.Event()
        def inventory(*, queue, job_ids, progress):
            self.assertEqual(selected, job_ids)
            progress({'processed_jobs': 0, 'total_jobs': 1, 'current_job_id': selected[0]})
            entered.set()
            self.assertTrue(release.wait(5))
            return {'status': 'preview', 'candidates_count': 0, 'candidates': [], 'retained': []}
        with patch.object(self.hub, 'generate_retention_plan', side_effect=inventory):
            accepted = self.service.preview(job_ids=selected)
            self.assertTrue(entered.wait(2))
            observed = self.service.get(accepted['plan_id'])
            self.assertEqual(0, observed['processed_jobs'])
            self.assertEqual(1, observed['total_jobs'])
            self.assertTrue(observed['created_at'])
            release.set()
            self.finish()
        self.assertEqual(observed['created_at'], self.service.get(accepted['plan_id'])['created_at'])

    def test_scope_and_selection_validation_precedes_background_work(self):
        for kwargs in ({'scope': 'all'}, {'scope': 'sources', 'job_ids': []},
                       {'job_ids': ['../job']}, {'job_ids': ['a' * 32] * 257}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.service.preview(**kwargs)
        self.assertIsNone(self.service.thread)

    def test_runtime_automatic_is_separate_opt_in_and_alternates_with_execution(self):
        self.hub.set_retention_policy({'mode': 'automatic'})
        with patch.object(self.service, 'preview') as preview:
            self.service.tick(force=True)
            self.assertEqual('execution', preview.call_args.kwargs['scope'])
            self.hub.set_retention_policy({'runtime_retention_enabled': True})
            self.service.last_automatic = 0
            self.service.tick()
            self.assertEqual('runtime', preview.call_args.kwargs['scope'])
            self.service.last_automatic = 0
            self.service.tick()
            self.assertEqual('execution', preview.call_args.kwargs['scope'])

    def test_disabling_runtime_during_inventory_cancels_automatic_mutation(self):
        self.hub.set_retention_policy({'mode': 'automatic', 'runtime_retention_enabled': True})
        entered, release = threading.Event(), threading.Event()
        def inventory(*args, **kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return {'scope': 'runtime', 'status': 'preview', 'candidates': [], 'retained': []}
        with patch('local_runner.runtime_retention.plan_runtime_cleanup', side_effect=inventory), \
                patch('local_runner.runtime_retention.apply_runtime_cleanup') as apply:
            accepted = self.service.preview(scope='runtime', automatic=True)
            self.assertTrue(entered.wait(2))
            self.hub.set_retention_policy({'runtime_retention_enabled': False})
            release.set()
            self.finish()
        apply.assert_not_called()
        self.assertEqual('preview', self.service.get(accepted['plan_id'])['status'])


if __name__ == '__main__':
    unittest.main()
