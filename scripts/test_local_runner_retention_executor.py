import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fullmag_storage import file_lock, StorageError
from local_runner.retention import plan
from local_runner.retention_executor import apply_execution_plan, CleanupBlocked
from local_runner.worker_entrypoint import canonical, SCHEMA


class Queue:
    def __init__(self, job):
        self.job = job
        self.active_jobs = []

    def get(self, jid):
        assert jid == self.job['job_id']
        return dict(self.job)

    def active(self):
        return self.active_jobs


class ExecutionCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'locks').mkdir()
        (self.root / 'index').mkdir()
        self.now = 2_000_000.0
        self.policy = {'ttl_success_hours': 24, 'ttl_failure_hours': 168}
        capture_id = 'c' * 32
        source_rel = f'runs/wt/{capture_id}/source'
        self.source = self.root / source_rel
        (self.source / 'tree').mkdir(parents=True)
        content = b'versioned input'
        (self.source / 'tree' / 'model.py').write_bytes(content)
        core = {'schema_version': SCHEMA, 'source_mode': 'commit', 'resolved_commit': 'a' * 40,
                'files': [{'path': 'model.py', 'type': 'file', 'mode': '100644',
                           'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}],
                'deleted': [], 'included_untracked': [], 'excluded': []}
        digest = hashlib.sha256(canonical(core)).hexdigest()
        (self.source / 'manifest.json').write_text(json.dumps({**core, 'source_digest': digest}))
        self.job = {'job_id': 'job', 'worktree_id': 'wt', 'owner': 'operator', 'operation': 'build',
                    'source_digest': digest, 'state': 'failed', 'updated_at': self.now - 200 * 3600,
                    'payload': {'capture_id': capture_id, 'capsule_relative': source_rel}}
        self.queue = Queue(self.job)
        self.run = self.root / 'runs' / 'wt' / 'job'
        self.execution = self.run / 'execution'
        self.execution.mkdir(parents=True)
        (self.execution / 'scratch').write_bytes(b'12345')
        self.journal = {'schema': 'fullmag.local-runner.coordinator.v1', 'job_id': 'job',
                        'owner': 'operator', 'source_digest': digest, 'container_id': 'd' * 64,
                        'state': 'failed', 'exit_code': 1, 'phase': 'terminal',
                        'finished_at': self.job['updated_at']}
        for name in ('coordinator.json', 'receipt.json'):
            (self.run / name).write_text(json.dumps(self.journal))
        (self.run / 'worker.log').write_text('preserved compiler log')
        (self.run / 'artifacts').mkdir()
        (self.run / 'artifacts' / 'evidence').write_bytes(b'preserve')
        (self.run / 'results').mkdir()
        (self.run / 'results' / 'frequency.csv').write_text('10,11.2')
        self.calls = []
        self.layout = {'storage_root': str(self.root)}
        self.make_plan()

    def make_plan(self):
        raw = plan(self.root, [self.job], self.now)
        self.plan = {'plan_id': 'plan-1234abcd', 'raw_engine_plan': raw,
                     'candidates': [{'job_id': item['job_id']} for item in raw['candidates']]}

    def docker(self, argv):
        self.calls.append(argv)
        if argv[0] == 'ps':
            return ''
        raise AssertionError(argv)

    def apply(self, **kwargs):
        return apply_execution_plan(self.layout, self.plan, self.queue, owner='operator',
                                    call=kwargs.get('call', self.docker), policy=self.policy, now=self.now)

    def assert_retained(self, reason):
        result = self.apply()
        self.assertFalse(result['applied'])
        self.assertIn(reason, result['items'][0]['reason'])
        self.assertTrue(self.execution.is_dir())
        return result

    def prepare_historical_archive(self):
        from test_local_runner_archive_receipt import ArchiveReceiptTests
        fixture = ArchiveReceiptTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.job.update(state='succeeded', profile=fixture.job['profile'])
        self.job['payload']['native_source_identity'] = fixture.job['payload']['native_source_identity']
        self.journal.update(state='succeeded', exit_code=0, image_digest=fixture.journal['image_digest'])
        for name in ('coordinator.json', 'receipt.json'):
            (self.run / name).write_text(json.dumps(self.journal))
        fixture.receipt.update(job_id=self.job['job_id'], source_digest=self.job['source_digest'])
        fixture.save()
        import shutil
        shutil.copytree(fixture.root, self.run / 'artifacts', dirs_exist_ok=True)
        before = (self.run / 'artifacts/build-receipt.json').read_bytes()
        self.make_plan()
        return before

    def test_succeeded_historical_build_removes_execution_preserves_archive(self):
        before = self.prepare_historical_archive()
        result = self.apply()
        self.assertTrue(result['applied'], result)
        self.assertFalse(self.execution.exists())
        self.assertEqual((self.run / 'artifacts/build-receipt.json').read_bytes(), before)
        self.assertTrue((self.run / 'results/frequency.csv').is_file())
        self.assertTrue((self.source / 'manifest.json').is_file())

    def test_corrupt_successful_archive_preserves_execution(self):
        self.prepare_historical_archive()
        (self.run / 'artifacts/outputs/result.bin').write_bytes(b'corruption')
        self.assert_retained('Archive artifact size/hash mismatch')

    def test_removes_only_private_tree_and_replays_receipt(self):
        result = self.apply()
        self.assertTrue(result['applied'])
        self.assertFalse(self.execution.exists())
        self.assertEqual(5, result['removed_logical_bytes'])
        self.assertIsNone(result['reclaimed_bytes'])
        self.assertEqual(result['disk_free_after_bytes'] - result['disk_free_before_bytes'],
                         result['disk_free_change_bytes'])
        self.assertEqual(b'preserve', (self.run / 'artifacts' / 'evidence').read_bytes())
        self.assertTrue((self.source / 'tree' / 'model.py').exists())
        self.assertEqual('10,11.2', (self.run / 'results' / 'frequency.csv').read_text())
        self.assertTrue((self.run / 'worker.log').exists())
        self.execution.mkdir()
        (self.execution / 'new-data').write_text('must survive old operation')
        self.assertEqual(result, self.apply())
        self.assertTrue((self.execution / 'new-data').exists())

    def test_link_target_outside_execution_survives(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('keep')
        try:
            (self.execution / 'link').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('host cannot create symlinks')
        self.make_plan()
        self.assertTrue(self.apply()['applied'])
        self.assertEqual('keep', (outside / 'keep').read_text())

    def test_active_lease_blocks_before_mutation(self):
        self.queue.active_jobs = [{'job_id': 'other'}]
        with self.assertRaisesRegex(CleanupBlocked, 'active_queue_lease'):
            self.apply()
        self.assertTrue(self.execution.exists())

    def test_live_worktree_lock_blocks(self):
        with file_lock(self.root / 'locks' / 'wt.lock', 'test'):
            self.assert_retained('Storage is busy')

    def test_active_owner_record_blocks(self):
        (self.root / 'locks' / 'wt.native-runtime.owner.json').write_text('{"state":"active"}')
        self.assert_retained('active_or_unknown_storage_owner')

    def test_new_pin_is_revalidated(self):
        (self.root / 'index' / 'pinned-resources.json').write_text('{"job":{"pinned":true}}')
        self.assert_retained('pinned')

    def test_corrupt_pin_index_is_not_empty_inventory(self):
        (self.root / 'index' / 'pinned-resources.json').write_text('not json')
        self.assert_retained('invalid_metadata')

    def test_changed_contents_require_new_plan(self):
        (self.execution / 'scratch').write_bytes(b'changed content')
        self.assert_retained('plan_stale:tree_identity')

    def test_source_corruption_preserves_execution(self):
        (self.source / 'tree' / 'model.py').write_text('corrupt')
        self.assert_retained('Capsule bytes changed')

    def test_missing_log_preserves_execution(self):
        (self.run / 'worker.log').unlink()
        self.assert_retained('missing_run_path')

    def test_terminal_receipt_mismatch_preserves_execution(self):
        (self.run / 'receipt.json').write_text('{"job_id":"wrong"}')
        self.assert_retained('terminal_receipt_mismatch')

    def test_changed_queue_state_preserves_execution(self):
        self.job['state'] = 'running'
        self.assert_retained('active')

    def test_docker_failure_is_retention_not_success(self):
        def unavailable(_):
            raise OSError('Docker unavailable')
        result = self.apply(call=unavailable)
        self.assertFalse(result['applied'])
        self.assertTrue(self.execution.exists())
        self.assertIn('Docker unavailable', result['items'][0]['reason'])

    def test_other_container_parent_mount_blocks(self):
        identifier = 'e' * 64
        def docker(argv):
            if argv[0] == 'ps':
                return identifier
            return json.dumps([{'Id': identifier, 'Mounts': [
                {'Type': 'bind', 'Source': str(self.run)}]}])
        result = self.apply(call=docker)
        self.assertIn('container_references_execution', result['items'][0]['reason'])
        self.assertTrue(self.execution.exists())

    def test_failed_inventory_is_rejected(self):
        self.plan['raw_engine_plan']['error'] = 'inaccessible'
        with self.assertRaisesRegex(CleanupBlocked, 'failed_execution_inventory'):
            self.apply()
        self.assertTrue(self.execution.exists())

    def test_complete_available_log_is_durable_before_own_worker_removal(self):
        identifier = self.journal['container_id']
        self.journal.update(image_digest='image', mounts=[])
        for name in ('coordinator.json', 'receipt.json'):
            (self.run / name).write_text(json.dumps(self.journal))
        self.make_plan()
        inspected = {'Id': identifier, 'Image': 'image', 'Mounts': [],
            'State': {'Status': 'exited', 'Running': False, 'ExitCode': 1},
            'Config': {'User': '65532:65532'},
            'HostConfig': {'Privileged': False, 'ReadonlyRootfs': True,
                          'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'], 'NetworkMode': 'bridge'}}
        full_log = ''.join(f'line {i}\n' for i in range(4001))
        removed = False
        def docker(argv):
            nonlocal removed
            if argv[0] == 'ps':
                return '' if removed else identifier
            if argv[0] == 'inspect':
                return json.dumps([inspected])
            if argv[0] == 'logs':
                self.assertEqual(['logs', identifier], argv)
                return full_log
            if argv[0] == 'rm':
                self.assertEqual(full_log, (self.run / 'worker-full.log').read_text())
                metadata = json.loads((self.run / 'worker-full-log.json').read_text())
                self.assertEqual(hashlib.sha256(full_log.encode()).hexdigest(), metadata['sha256'])
                self.assertEqual(['rm', identifier], argv)
                removed = True
                return identifier
            self.fail(str(argv))
        self.assertTrue(self.apply(call=docker)['applied'])
        self.assertTrue(removed)
        self.assertEqual(4001, len((self.run / 'worker-full.log').read_text().splitlines()))

    def test_partial_delete_is_recorded_and_not_claimed_as_reclaim(self):
        def fail_after_file(target):
            (target / 'scratch').unlink()
            raise PermissionError('locked remainder')
        with patch('local_runner.retention_executor.shutil.rmtree', side_effect=fail_after_file):
            result = self.apply()
        self.assertFalse(result['applied'])
        self.assertEqual('partial_error', result['items'][0]['status'])
        self.assertEqual(0, result['removed_logical_bytes'])
        self.assertIsNone(result['reclaimed_bytes'])
        self.assertEqual(result, self.apply())


if __name__ == '__main__':
    unittest.main()
