import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import local_runner_cli
from local_runner.queue import JobQueue


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.layout = {'storage_root': str(self.root), 'repo_root': str(self.root / 'repo'), 'worktree_id': 'test-wt'}

    def run_client(self, *args):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(local_runner_cli, 'resolve_layout', return_value=self.layout), \
             patch.object(local_runner_cli.getpass, 'getuser', return_value='alice'), \
             contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = local_runner_cli.main(list(args))
        return code, output.getvalue(), errors.getvalue()

    def test_list_does_not_create_empty_queue(self):
        code, output, _ = self.run_client('list')
        self.assertEqual(0, code)
        self.assertEqual([], json.loads(output))
        self.assertFalse((self.root / 'index').exists())

    def test_status_never_exposes_lease(self):
        queue = JobQueue(self.root / 'index' / 'runner-jobs.sqlite')
        job = queue.submit(owner='alice', worktree_id='wt', source_digest='a' * 64,
                           profile='p', operation='verify-source', request_key='a', payload={})
        queue.claim('coordinator')
        code, output, _ = self.run_client('status', job['job_id'])
        self.assertEqual(0, code)
        self.assertNotIn('lease_token', json.loads(output))

    def test_other_owner_job_is_not_exposed(self):
        queue = JobQueue(self.root / 'index' / 'runner-jobs.sqlite')
        job = queue.submit(owner='bob', worktree_id='wt', source_digest='a' * 64,
                           profile='p', operation='verify-source', request_key='a', payload={})
        code, output, errors = self.run_client('status', job['job_id'])
        self.assertEqual(2, code)
        self.assertEqual('', output)
        self.assertIn('owner mismatch', errors)

    def test_wait_timeout_does_not_cancel_job(self):
        queue = JobQueue(self.root / 'index' / 'runner-jobs.sqlite')
        job = queue.submit(owner='alice', worktree_id='wt', source_digest='a' * 64,
                           profile='p', operation='verify-source', request_key='a', payload={})
        code, output, _ = self.run_client('wait', job['job_id'], '--timeout-seconds', '0')
        self.assertEqual(124, code)
        self.assertEqual('queued', json.loads(output)['state'])
        self.assertEqual('queued', queue.get(job['job_id'])['state'])

    def test_logs_are_owner_scoped_and_bounded(self):
        queue = JobQueue(self.root / 'index' / 'runner-jobs.sqlite')
        job = queue.submit(owner='alice', worktree_id='wt', source_digest='a' * 64,
                           profile='p', operation='verify-source', request_key='a', payload={})
        path = self.root / 'runs' / 'wt' / job['job_id'] / 'worker.log'
        path.parent.mkdir(parents=True)
        path.write_bytes(b'a' * 70000)
        code, output, _ = self.run_client('logs', job['job_id'])
        self.assertEqual(0, code)
        self.assertEqual(65536, len(json.loads(output)['tail']))

    def test_commit_without_ref_fails_before_capture(self):
        code, _, errors = self.run_client('submit', '--source', 'commit')
        self.assertEqual(2, code)
        self.assertIn('requires --ref', errors)
        self.assertFalse((self.root / 'index').exists())

    def test_same_source_retry_returns_same_job_despite_new_capture_id(self):
        with patch('local_runner.source.capture_source', return_value={'source_digest': 'c' * 64}), \
             patch.object(local_runner_cli, 'initialize'), \
             patch.object(local_runner_cli, 'build_lock', return_value=contextlib.nullcontext()):
            first = self.run_client('submit', '--source', 'commit', '--ref', 'HEAD', '--request-key', 'retry')
            second = self.run_client('submit', '--source', 'commit', '--ref', 'HEAD', '--request-key', 'retry')
        self.assertEqual(0, first[0], first[2])
        self.assertEqual(0, second[0], second[2])
        self.assertEqual(json.loads(first[1])['job_id'], json.loads(second[1])['job_id'])


if __name__ == '__main__':
    unittest.main()
