"""Behavioral tests for durable local runner scheduling."""
import concurrent.futures
import tempfile
import unittest
from pathlib import Path

from local_runner.queue import JobQueue, QueueError


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'jobs.sqlite'
        self.queue = JobQueue(self.path)

    def submit(self, key, worktree='wt-a'):
        return self.queue.submit(owner='agent-a', worktree_id=worktree,
            source_digest='a' * 64, profile='fem-gpu-release', operation='build',
            request_key=key, payload={'source_mode': 'snapshot'})

    def test_idempotent_submission_and_conflicting_reuse(self):
        first = self.submit('request-a')
        self.assertEqual(first['job_id'], self.submit('request-a')['job_id'])
        with self.assertRaises(QueueError):
            self.submit('request-a', 'wt-other')

    def test_readonly_observer_never_initializes_or_writes_database(self):
        job = self.submit('readonly')
        observer = JobQueue(self.path, readonly=True)
        self.assertEqual(job['job_id'], observer.get(job['job_id'])['job_id'])
        self.assertEqual(1, len(observer.list()))
        with self.assertRaises(QueueError):
            JobQueue(self.path.parent / 'missing.sqlite', readonly=True)
        self.assertFalse((self.path.parent / 'missing.sqlite').exists())

    def test_single_global_heavy_slot_across_worktrees(self):
        first = self.submit('a')
        second = self.submit('b', 'wt-b')
        running = self.queue.claim('coordinator')
        self.assertEqual(first['job_id'], running['job_id'])
        self.assertIsNone(self.queue.claim('other'))
        self.queue.finish(first['job_id'], running['lease_token'], 'succeeded', 0)
        self.assertEqual(second['job_id'], self.queue.claim('other')['job_id'])

    def test_cancel_does_not_release_running_slot_before_terminal_ack(self):
        job = self.submit('a')
        running = self.queue.claim('coordinator')
        self.queue.cancel(job['job_id'], 'agent-a')
        self.assertEqual('cancel_requested', self.queue.get(job['job_id'])['state'])
        self.assertIsNone(self.queue.claim('other'))
        with self.assertRaises(QueueError):
            self.queue.finish(job['job_id'], 'wrong-token', 'cancelled', None)
        self.queue.finish(job['job_id'], running['lease_token'], 'cancelled', None)

    def test_restart_never_reclaims_a_running_job_just_for_age(self):
        self.submit('a')
        job = self.queue.claim('coordinator')
        restarted = JobQueue(self.path)
        self.assertIsNone(restarted.claim('replacement'))
        self.assertEqual(job['job_id'], restarted.get(job['job_id'])['job_id'])

    def test_concurrent_claims_have_one_winner(self):
        for i in range(6):
            self.submit(str(i), f'wt-{i}')
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda i: JobQueue(self.path).claim(f'worker-{i}'), range(6)))
        self.assertEqual(1, sum(result is not None for result in results))

    def test_owner_cannot_cancel_another_agents_job(self):
        job = self.submit('a')
        with self.assertRaises(QueueError):
            self.queue.cancel(job['job_id'], 'agent-b')
        self.assertEqual('queued', self.queue.get(job['job_id'])['state'])

    def test_cancel_queued_job_is_terminal(self):
        job = self.submit('a')
        self.queue.cancel(job['job_id'], 'agent-a')
        self.assertEqual('cancelled', self.queue.get(job['job_id'])['state'])
        self.assertIsNone(self.queue.claim('coordinator'))

    def test_nonzero_exit_cannot_be_success(self):
        self.submit('a')
        job = self.queue.claim('coordinator')
        with self.assertRaises(QueueError):
            self.queue.finish(job['job_id'], job['lease_token'], 'succeeded', 7)


if __name__ == '__main__':
    unittest.main()
