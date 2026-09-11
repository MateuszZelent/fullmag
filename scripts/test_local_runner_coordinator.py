import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from local_runner import coordinator
from local_runner.queue import JobQueue


IMAGE = 'sha256:' + 'a' * 64
CONTAINER = 'b' * 64


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.storage = Path(temporary.name).resolve()
        (self.storage / 'locks').mkdir()
        capsule = self.storage / 'runs' / 'wt' / ('d' * 32) / 'source'
        capsule.mkdir(parents=True)
        self.layout = dict(storage_root=str(self.storage), repo_root=str(self.storage / 'origin'), worktree_id='wt')
        self.queue = JobQueue(self.storage / 'index' / 'runner-jobs.sqlite')
        self.job = self.queue.submit(owner='alice', worktree_id='wt', source_digest='c' * 64,
            profile='source-verification-v1', operation='verify-source', request_key='req',
            payload={'origin_repo': self.layout['repo_root'], 'capture_id': 'd' * 32,
                     'capsule_relative': capsule.relative_to(self.storage).as_posix()})
        self.calls = []
        self.running = False
        self.bad_owner = False
        self.receipt = True
        self.create_error = False
        self.cancel_on_start = False
        self.logs_error = False
        self.manifest_origin = self.layout['repo_root']
        self.name_exists = False

    def docker(self, arguments):
        self.calls.append(arguments)
        if arguments[:2] == ['image', 'inspect']:
            return json.dumps([{'Id': IMAGE}])
        if arguments[0] == 'create':
            if self.create_error:
                raise coordinator.CoordinatorError('Ambiguous create timeout')
            return CONTAINER
        if arguments[0] == 'ps':
            return CONTAINER if self.name_exists else ''
        if arguments[0] == 'inspect':
            return json.dumps([{'Id': CONTAINER, 'Image': IMAGE, 'Config': {'Labels': {
                'owner': 'foreign' if self.bad_owner else 'fullmag-local-runner', 'job': self.job['job_id']}},
                'State': {'Status': 'running' if self.running else 'exited', 'Running': self.running, 'ExitCode': 0}}])
        if arguments[0] == 'start':
            if self.receipt:
                path = self.storage / 'runs' / 'wt' / self.job['job_id'] / 'artifacts' / 'source-verification.json'
                path.write_text(json.dumps({'schema': 'fullmag.local-runner.source-check.v1',
                    'job_id': self.job['job_id'], 'source_digest': self.job['source_digest'],
                    'operation': 'verify-source', 'state': 'succeeded', 'qualification': 'not_assessed'}), encoding='utf-8')
            if self.cancel_on_start:
                self.queue.cancel(self.job['job_id'], 'alice')
            return CONTAINER
        if arguments[0] == 'stop':
            self.running = False
            return CONTAINER
        if arguments[0] == 'logs':
            if self.logs_error:
                raise coordinator.CoordinatorError('logs unavailable')
            return 'diagnostic only\n'
        self.fail(f'Unexpected Docker operation: {arguments}')

    def execute(self, **kwargs):
        with patch.object(coordinator, 'initialize'), \
             patch.object(coordinator, 'resolve_layout', return_value=self.layout), \
             patch.object(coordinator, 'verify_source', return_value={'repo_root': self.manifest_origin}):
            return coordinator.execute_once(self.layout, owner='alice', image_digest=IMAGE,
                call=self.docker, sleep=lambda _: None, **kwargs)

    def test_success_requires_receipt_and_retains_container(self):
        result = self.execute()
        self.assertEqual('succeeded', result['state'])
        self.assertFalse(any(command[0] == 'rm' for command in self.calls))
        self.assertEqual([], self.queue.active())

    def test_missing_receipt_is_failure_even_with_exit_zero(self):
        self.receipt = False
        self.assertEqual('failed', self.execute()['state'])

    def test_ambiguous_create_keeps_lease(self):
        self.create_error = True
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute()
        self.assertEqual('running', self.queue.get(self.job['job_id'])['state'])
        self.assertIsNone(self.queue.claim('second'))

    def test_observation_timeout_never_kills_or_reclaims(self):
        self.running = True
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute(timeout_seconds=0)
        self.assertFalse(any(command[0] == 'stop' for command in self.calls))
        self.assertEqual('running', self.queue.get(self.job['job_id'])['state'])

    def test_foreign_container_never_started(self):
        self.bad_owner = True
        with self.assertRaises(ValueError):
            self.execute()
        self.assertFalse(any(command[0] == 'start' for command in self.calls))
        self.assertEqual('running', self.queue.get(self.job['job_id'])['state'])

    def test_owner_cancel_stops_exact_container_then_releases(self):
        self.running = True
        self.cancel_on_start = True
        self.assertEqual('cancelled', self.execute()['state'])
        self.assertIn(['stop', '--time', '10', CONTAINER], self.calls)

    def test_existing_lease_rejects_second_executor_before_docker(self):
        self.queue.claim('first')
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute()
        self.assertEqual([], self.calls)

    def test_log_failure_does_not_leave_running_lease(self):
        self.logs_error = True
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute()
        self.assertEqual('succeeded', self.queue.get(self.job['job_id'])['state'])
        self.logs_error = False
        result = coordinator.reconcile(self.layout, self.job['job_id'], owner='alice', call=self.docker)
        self.assertEqual('succeeded', result['state'])
        self.assertEqual('diagnostic only\n', (self.storage / 'runs' / 'wt' / self.job['job_id'] / 'worker.log').read_text())

    def test_precreate_lock_failure_releases_slot(self):
        with patch.object(coordinator, 'build_lock', side_effect=coordinator.StorageError('busy')):
            with self.assertRaises(coordinator.CoordinatorError):
                self.execute()
        self.assertEqual('blocked', self.queue.get(self.job['job_id'])['state'])
        self.assertFalse(any(command[0] == 'create' for command in self.calls))

    def test_terminal_container_can_be_reconciled_after_timeout(self):
        self.running = True
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute(timeout_seconds=0)
        self.running = False
        with patch.object(coordinator, 'verify_source'):
            result = coordinator.reconcile(self.layout, self.job['job_id'], owner='alice', call=self.docker)
        self.assertEqual('succeeded', result['state'])
        self.assertEqual([], self.queue.active())

    def test_storage_probe_recovery_never_manufactures_success(self):
        self.running = True
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute(timeout_seconds=0)
        with self.queue.connection() as db:
            db.execute("UPDATE jobs SET operation='storage-probe' WHERE job_id=?", (self.job['job_id'],))
        self.running = False
        result = coordinator.reconcile(self.layout, self.job['job_id'], owner='alice', call=self.docker)
        self.assertEqual('interrupted', result['state'])
        self.assertEqual([], self.queue.active())

    def test_capsule_from_another_worktree_is_rejected(self):
        self.manifest_origin = str(self.storage / 'other-worktree')
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute()
        self.assertEqual('blocked', self.queue.get(self.job['job_id'])['state'])
        self.assertFalse(any(command[0] == 'create' for command in self.calls))

    def test_reconciliation_can_acknowledge_owner_cancel_after_crash(self):
        self.running = True
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute(timeout_seconds=0)
        self.queue.cancel(self.job['job_id'], 'alice')
        result = coordinator.reconcile(self.layout, self.job['job_id'], owner='alice', call=self.docker)
        self.assertEqual('cancelled', result['state'])
        self.assertIn(['stop', '--time', '10', CONTAINER], self.calls)

    def test_uncreated_recovery_requires_no_matching_container(self):
        self.create_error = True
        with self.assertRaises(coordinator.CoordinatorError):
            self.execute()
        self.name_exists = True
        with self.assertRaises(coordinator.CoordinatorError):
            coordinator.acknowledge_uncreated(self.layout, self.job['job_id'], owner='alice',
                reason='Operator observed CLI rejection before daemon contact', call=self.docker)
        self.assertEqual('running', self.queue.get(self.job['job_id'])['state'])
        self.name_exists = False
        result = coordinator.acknowledge_uncreated(self.layout, self.job['job_id'], owner='alice',
            reason='Operator observed CLI rejection before daemon contact', call=self.docker)
        self.assertEqual('blocked', result['state'])

    def test_missing_journal_can_be_explicitly_recovered(self):
        self.queue.claim('crashed')
        self.name_exists = True
        with self.assertRaises(coordinator.CoordinatorError):
            coordinator.acknowledge_uncreated(self.layout, self.job['job_id'], owner='alice',
                reason='Operator confirmed submitting process ended before create', call=self.docker)
        self.name_exists = False
        result = coordinator.acknowledge_uncreated(self.layout, self.job['job_id'], owner='alice',
            reason='Operator confirmed submitting process ended before create', call=self.docker)
        self.assertEqual('blocked', result['state'])
        self.assertNotIn('lease_token', result)

    def test_prepared_recovery_remains_retryable_after_database_failure(self):
        job = self.queue.claim('crashed')
        path = self.storage / 'runs' / 'wt' / self.job['job_id'] / 'coordinator.json'
        path.parent.mkdir()
        path.write_text(json.dumps(dict(job_id=job['job_id'], owner='alice',
            phase='prepared', container_id=None, lease_token=job['lease_token'])))
        with patch.object(JobQueue, 'finish', side_effect=OSError('database unavailable')):
            with self.assertRaises(OSError):
                coordinator.acknowledge_uncreated(self.layout, job['job_id'], owner='alice',
                    reason='Operator confirmed submitting process ended before create', call=self.docker)
        self.assertEqual('prepared', json.loads(path.read_text())['phase'])
        result = coordinator.acknowledge_uncreated(self.layout, job['job_id'], owner='alice',
            reason='Operator confirmed submitting process ended before create', call=self.docker)
        self.assertEqual('blocked', result['state'])


if __name__ == '__main__':
    unittest.main()
