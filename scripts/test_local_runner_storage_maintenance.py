import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fullmag_storage import StorageError
from local_runner.queue import JobQueue
from local_runner.retention_executor import CleanupBlocked
from local_runner.runtime_use import runtime_package_use
from local_runner.storage_maintenance import apply_source_compaction, plan_source_compaction
from local_runner.worker_entrypoint import canonical, SCHEMA, verify_source


class SourceMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'locks').mkdir()
        (self.root / 'index').mkdir()
        self.layout = {'storage_root': str(self.root)}
        self.queue = JobQueue(self.root / 'index/runner-jobs.sqlite')
        self.source = self.root / 'runs/wt' / ('c' * 32) / 'source'
        (self.source / 'tree').mkdir(parents=True)
        content = b'preserved scientific input\n'
        (self.source / 'tree/model.py').write_bytes(content)
        core = {'schema_version': SCHEMA, 'source_mode': 'commit', 'resolved_commit': 'a' * 40,
                'files': [{'path': 'model.py', 'type': 'file', 'mode': '100644', 'size': len(content),
                           'sha256': hashlib.sha256(content).hexdigest()}],
                'deleted': [], 'included_untracked': [], 'excluded': []}
        self.digest = hashlib.sha256(canonical(core)).hexdigest()
        self.manifest = canonical({**core, 'source_digest': self.digest})
        (self.source / 'manifest.json').write_bytes(self.manifest)
        self.job = self.make_job('first')
        self.plan = self.preview()
        self.plan['plan_id'] = 'plan-01234567'

    def make_job(self, key, *, state='failed', owner='operator'):
        job = self.queue.submit(owner=owner, worktree_id='wt', source_digest=self.digest,
                                profile='fem-cpu-release', operation='build', request_key=key,
                                payload={'capture_id': 'c' * 32,
                                         'capsule_relative': self.source.relative_to(self.root).as_posix()})
        with self.queue.connection() as database:
            database.execute('UPDATE jobs SET state=? WHERE job_id=?', (state, job['job_id']))
        return self.queue.get(job['job_id'])

    def preview(self):
        return plan_source_compaction(self.layout, self.queue, owner='operator')

    def apply(self, call=lambda _: ''):
        return apply_source_compaction(self.layout, self.plan, self.queue, owner='operator', call=call)

    def test_real_compaction_preserves_manifest_and_replays_terminal_receipt(self):
        before = (self.source / 'tree/model.py').read_bytes()
        result = self.apply()
        self.assertTrue(result['applied'])
        self.assertEqual('compacted', result['items'][0]['status'])
        self.assertIsNone(result['reclaimed_bytes'])
        self.assertEqual(self.manifest, (self.source / 'manifest.json').read_bytes())
        self.assertEqual(before, (self.source / 'tree/model.py').read_bytes())
        verify_source(self.source, self.digest)
        self.assertEqual(result, self.apply(call=lambda _: self.fail('replay touched Docker')))

    def test_two_terminal_jobs_share_one_bounded_capsule_candidate(self):
        self.make_job('second')
        self.assertEqual(1, self.preview()['candidates_count'])

    def test_queued_reference_protects_shared_capsule(self):
        self.make_job('queued', state='queued')
        plan = self.preview()
        self.assertEqual(0, plan['candidates_count'])
        self.assertIn('nonterminal_job', plan['retained'][0]['why_retained'])

    def test_foreign_owner_reference_protects_shared_capsule(self):
        self.make_job('foreign', owner='other')
        self.assertIn('owner_mismatch', self.preview()['retained'][0]['why_retained'])

    def test_active_job_blocks_before_source_mutation(self):
        self.make_job('active', state='running')
        with self.assertRaisesRegex(CleanupBlocked, 'active_queue_lease'):
            self.apply()
        self.assertEqual(self.manifest, (self.source / 'manifest.json').read_bytes())

    def test_new_source_pin_is_revalidated(self):
        key = 'src-wt-' + 'c' * 32
        (self.root / 'index/pinned-resources.json').write_text(json.dumps({key: {'pinned': True}}))
        result = self.apply()
        self.assertFalse(result['applied'])
        self.assertIn('no_longer_eligible', result['items'][0]['reason'])

    def test_manifest_change_requires_fresh_plan(self):
        (self.source / 'manifest.json').write_bytes(self.manifest + b'\n')
        result = self.apply()
        self.assertFalse(result['applied'])
        self.assertIn('source_plan_stale:manifest_sha256', result['items'][0]['reason'])

    def test_stopped_container_mount_preserves_source(self):
        identifier = 'd' * 64
        def docker(argv):
            if argv[0] == 'ps':
                return identifier
            if argv[0] == 'inspect':
                return json.dumps([{'Id': identifier, 'State': {'Running': False},
                                    'Mounts': [{'Type': 'bind', 'Source': str(self.source)}]}])
            self.fail('source maintenance must not remove a container')
        result = self.apply(call=docker)
        self.assertIn('container_references_source', result['items'][0]['reason'])
        self.assertFalse(result['applied'])

    def test_runtime_ticket_blocks_compaction(self):
        with runtime_package_use(self.layout):
            with self.assertRaisesRegex(StorageError, 'active or unknown'):
                self.apply()

    def test_missing_complete_inventory_is_not_an_empty_success(self):
        with self.assertRaisesRegex(CleanupBlocked, 'complete_queue_inventory_unavailable'):
            plan_source_compaction(self.layout, object(), owner='operator')

    def test_compaction_failure_is_durable_partial_outcome(self):
        with patch('local_runner.source_compaction.compact_source_capsule', side_effect=OSError('fixture interruption')):
            result = self.apply()
        self.assertEqual('partial', result['status'])
        self.assertEqual('partial_error', result['items'][0]['status'])
        self.assertFalse(result['applied'])
        self.assertEqual(self.manifest, (self.source / 'manifest.json').read_bytes())
        receipt = self.root / 'index/retention-operations' / (self.plan['plan_id'] + '.json')
        self.assertEqual(result, json.loads(receipt.read_text()))


if __name__ == '__main__':
    unittest.main()
