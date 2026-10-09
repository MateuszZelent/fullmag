import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from fullmag_storage import file_lock, StorageError
from local_runner import coordinator
from local_runner.retention import inspect_execution, plan
from local_runner import retention_executor
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
                                    call=kwargs.get('call', self.docker), policy=self.policy, now=self.now,
                                    stream_logs=kwargs.get('stream_logs'))

    def _prepare_attested_worker(self):
        identifier = self.journal['container_id']
        self.journal.update(image_digest='image', mounts=[])
        for name in ('coordinator.json', 'receipt.json'):
            (self.run / name).write_text(json.dumps(self.journal))
        self.make_plan()
        inspected = {
            'Id': identifier,
            'Image': 'image',
            'Mounts': [],
            'State': {'Status': 'exited', 'Running': False, 'ExitCode': 1},
            'Config': {'User': '65532:65532'},
            'HostConfig': {
                'Privileged': False,
                'ReadonlyRootfs': True,
                'CapDrop': ['ALL'],
                'SecurityOpt': ['no-new-privileges:true'],
                'NetworkMode': 'bridge',
            },
        }
        return identifier, inspected

    def _worker_docker(self, identifier, inspected):
        state = {'removed': False, 'calls': []}

        def docker(argv):
            state['calls'].append(argv)
            if argv[0] == 'ps':
                return '' if state['removed'] else identifier
            if argv[0] == 'inspect':
                return json.dumps([inspected])
            if argv[0] == 'rm':
                self.assertEqual(['rm', identifier], argv)
                state['removed'] = True
                return identifier
            self.fail(str(argv))

        return docker, state

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

    def prepare_runtime_retired_execution_plan(self):
        from test_export_runner_openapi import Fixture, JOB_ID, WORKTREE
        from local_runner.queue import JobQueue
        from local_runner.runtime_retention import apply_runtime_cleanup, plan_runtime_cleanup

        fixture = Fixture()
        self.addCleanup(fixture.close)
        storage = fixture.storage
        (storage / 'locks').mkdir()
        journal = {
            **fixture.journal,
            'container_id': 'd' * 64,
            'worktree_id': WORKTREE,
            'finished_at': 1,
        }
        for name in ('receipt.json', 'coordinator.json'):
            (fixture.run_root / name).write_text(json.dumps(journal))
        (fixture.run_root / 'worker.log').write_text('preserved worker log')
        execution = fixture.run_root / 'execution'
        execution.mkdir()
        (execution / 'scratch').write_bytes(b'execution bytes')

        newer_id = 'a' * 32
        newer_root = fixture.run_root.parent / newer_id
        shutil.copytree(fixture.run_root, newer_root)
        receipt_path = newer_root / 'artifacts' / 'build-receipt.json'
        receipt = json.loads(receipt_path.read_text())
        receipt['job_id'] = newer_id
        receipt_path.write_text(json.dumps(receipt))
        for name in ('receipt.json', 'coordinator.json'):
            path = newer_root / name
            record = json.loads(path.read_text())
            record['job_id'] = newer_id
            path.write_text(json.dumps(record))
        database = sqlite3.connect(storage / 'index' / 'runner-jobs.sqlite', isolation_level=None)
        try:
            database.execute(
                'INSERT INTO jobs (job_id,owner,request_key,request_hash,worktree_id,source_digest,'
                'profile,operation,payload,state,created_at,updated_at,exit_code) '
                'SELECT ?,owner,?,request_hash,worktree_id,source_digest,profile,operation,payload,'
                'state,2,2,exit_code FROM jobs WHERE job_id=?',
                (newer_id, 'runtime-retention-newer-request', JOB_ID),
            )
        finally:
            database.close()

        (storage / 'index' / 'runtime-reference-roots.json').write_text(json.dumps({
            'schema': 'fullmag.runtime-reference-roots.v1',
            'relative_roots': [],
            'legacy_inventory_complete': True,
        }))
        queue = JobQueue(storage / 'index' / 'runner-jobs.sqlite', readonly=True)

        def no_containers(argv):
            if argv[0] == 'ps':
                return ''
            raise AssertionError(argv)

        runtime_plan = plan_runtime_cleanup(
            fixture.layout,
            queue,
            owner='fixture',
            call=no_containers,
            policy={'min_artifacts_to_keep': 1},
        )
        self.assertEqual([JOB_ID], [item['job_id'] for item in runtime_plan['candidates']])
        runtime_plan['plan_id'] = 'plan-1234abcd'
        runtime_result = apply_runtime_cleanup(
            fixture.layout,
            runtime_plan,
            queue,
            owner='fixture',
            call=no_containers,
            policy={'min_artifacts_to_keep': 1},
        )
        self.assertTrue(runtime_result['applied'], runtime_result)
        self.assertFalse(fixture.package.exists())

        job = queue.get(JOB_ID)
        raw = plan(storage, [job], 2_000_000, success_hours=24, failed_hours=168)
        self.assertEqual(1, len(raw['candidates']))
        execution_plan = {
            'plan_id': 'plan-fedc5678',
            'raw_engine_plan': raw,
            'candidates': [{'job_id': JOB_ID}],
        }
        return fixture, queue, execution_plan, no_containers

    def test_runtime_removal_tombstone_allows_execution_cleanup_and_live_users_still_block(self):
        fixture, queue, execution_plan, no_containers = self.prepare_runtime_retired_execution_plan()
        from local_runner.runtime_use import runtime_package_use

        execution = fixture.run_root / 'execution'
        with runtime_package_use(fixture.layout):
            with self.assertRaisesRegex(StorageError, 'active or unknown runtime users'):
                apply_execution_plan(
                    fixture.layout,
                    execution_plan,
                    queue,
                    owner='fixture',
                    call=no_containers,
                    policy=self.policy,
                    now=2_000_000,
                )
            self.assertTrue(execution.is_dir())

        result = apply_execution_plan(
            fixture.layout,
            execution_plan,
            queue,
            owner='fixture',
            call=no_containers,
            policy=self.policy,
            now=2_000_000,
        )
        self.assertTrue(result['applied'], result)
        self.assertFalse(execution.exists())
        self.assertFalse(fixture.package.exists())
        tombstone = json.loads(
            (fixture.run_root / 'artifacts' / 'runtime-package-retention.json').read_text(),
        )
        self.assertEqual('removed', tombstone['state'])
        self.assertEqual('deleted', tombstone['deletion_state'])

    def test_runtime_removed_package_mount_blocks_execution_cleanup_with_absent_host_path(self):
        fixture, queue, execution_plan, _no_containers = self.prepare_runtime_retired_execution_plan()
        identifier = 'f' * 64

        def mounted_package(argv):
            if argv[0] == 'ps':
                return identifier
            if argv[0] == 'inspect':
                return json.dumps([{
                    'Id': identifier,
                    'State': {'Status': 'running', 'Running': True},
                    'Config': {'Labels': {}},
                    'Mounts': [{'Type': 'bind', 'Source': str(fixture.package)}],
                }])
            self.fail(str(argv))

        execution = fixture.run_root / 'execution'
        result = apply_execution_plan(
            fixture.layout,
            execution_plan,
            queue,
            owner='fixture',
            call=mounted_package,
            policy=self.policy,
            now=2_000_000,
        )

        self.assertFalse(result['applied'])
        self.assertIn('container_references_retired_runtime_package', result['items'][0]['reason'])
        self.assertTrue(execution.is_dir())
        self.assertFalse(fixture.package.exists())
        self.assertFalse((fixture.run_root / '.retention-quarantine-plan-fedc5678').exists())

    def test_runtime_package_reappearance_blocks_execution_cleanup(self):
        fixture, queue, execution_plan, no_containers = self.prepare_runtime_retired_execution_plan()
        fixture.package.mkdir(parents=True)
        (fixture.package / 'unreviewed.bin').write_bytes(b'preserve reappeared package')

        result = apply_execution_plan(
            fixture.layout,
            execution_plan,
            queue,
            owner='fixture',
            call=no_containers,
            policy=self.policy,
            now=2_000_000,
        )

        self.assertFalse(result['applied'])
        self.assertIn('Runtime package reappeared after removal', result['items'][0]['reason'])
        self.assertTrue((fixture.run_root / 'execution').is_dir())
        self.assertEqual(b'preserve reappeared package',
                         (fixture.package / 'unreviewed.bin').read_bytes())

    def test_changed_archive_receipt_during_container_inventory_blocks_execution_cleanup(self):
        fixture, queue, execution_plan, _no_containers = self.prepare_runtime_retired_execution_plan()
        receipt_path = fixture.run_root / 'artifacts' / 'build-receipt.json'

        def change_receipt_during_inventory(argv):
            if argv[0] == 'ps':
                receipt_path.write_bytes(receipt_path.read_bytes() + b' ')
                return ''
            self.fail(str(argv))

        result = apply_execution_plan(
            fixture.layout,
            execution_plan,
            queue,
            owner='fixture',
            call=change_receipt_during_inventory,
            policy=self.policy,
            now=2_000_000,
        )

        self.assertFalse(result['applied'])
        self.assertIn('Runtime package tombstone identity mismatch', result['items'][0]['reason'])
        self.assertTrue((fixture.run_root / 'execution').is_dir())
        self.assertFalse(fixture.package.exists())

    def _assert_archive_document_open_race_blocks_before_execution_quarantine(self, name):
        from local_runner import retention_persistence

        fixture, queue, execution_plan, no_containers = self.prepare_runtime_retired_execution_plan()
        execution = fixture.run_root / 'execution'
        document_path = fixture.run_root / 'artifacts' / name
        replacement = document_path.with_name(name + '.foreign')
        replacement.write_bytes(b'foreign archive document replacement')
        real_open = retention_persistence._open_nofollow_file
        state = {'swapped': False}

        def replace_before_open(candidate):
            if Path(candidate) == document_path and not state['swapped']:
                state['swapped'] = True
                document_path.unlink()
                os.replace(replacement, document_path)
            return real_open(candidate)

        with patch.object(
            retention_persistence, '_open_nofollow_file', side_effect=replace_before_open,
        ):
            result = apply_execution_plan(
                fixture.layout,
                execution_plan,
                queue,
                owner='fixture',
                call=no_containers,
                policy=self.policy,
                now=2_000_000,
            )

        self.assertTrue(state['swapped'])
        self.assertFalse(result['applied'])
        self.assertTrue(execution.is_dir())
        self.assertFalse((fixture.run_root / ('.retention-quarantine-' + execution_plan['plan_id'])).exists())
        self.assertEqual(b'foreign archive document replacement', document_path.read_bytes())

    def test_build_receipt_open_race_blocks_before_execution_quarantine(self):
        self._assert_archive_document_open_race_blocks_before_execution_quarantine(
            'build-receipt.json',
        )

    def test_runtime_tombstone_open_race_blocks_before_execution_quarantine(self):
        self._assert_archive_document_open_race_blocks_before_execution_quarantine(
            'runtime-package-retention.json',
        )

    def test_live_operation_reports_validation_before_expensive_source_check(self):
        from local_runner.worker_entrypoint import verify_source
        seen = []
        def observe(source, digest):
            operation = json.loads((self.root / 'index/retention-operations/plan-1234abcd.json').read_text())
            seen.append(operation['items'][0]['status'] if operation['items'] else 'not_reported')
            self.assertEqual('validating', seen[-1])
            self.assertTrue(self.execution.is_dir())
            return verify_source(source, digest)
        with patch('local_runner.worker_entrypoint.verify_source', side_effect=observe):
            result = self.apply()
        self.assertEqual(['validating'], seen)
        self.assertTrue(result['applied'], result)

    def test_removes_only_private_tree_and_replays_receipt(self):
        result = self.apply()
        self.assertTrue(result['applied'])
        self.assertFalse(self.execution.exists())
        item = result['items'][0]
        self.assertEqual('deleted', item['deletion_state'])
        self.assertTrue(item['moved_path'])
        self.assertFalse(Path(item['moved_path']).exists())
        self.assertFalse(Path(item['quarantine_path']).exists())
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

    def test_rename_time_replacement_preserves_both_unapproved_and_reviewed_trees(self):
        expected_identity = self.plan['raw_engine_plan']['candidates'][0]['tree_identity']
        approved_original = self.run / 'approved-original-preserved'
        original_rename = os.rename

        def replace_before_move(source, destination):
            if Path(source) == self.execution:
                original_rename(source, approved_original)
                Path(source).mkdir()
                (Path(source) / 'unapproved').write_bytes(b'unreviewed replacement')
            original_rename(source, destination)

        with patch(
            'local_runner.retention_executor.os.rename',
            side_effect=replace_before_move,
        ):
            result = self.apply()

        item = result['items'][0]
        moved_path = Path(item['moved_path'])
        self.assertFalse(result['applied'])
        self.assertEqual('partial_error', item['status'])
        self.assertEqual('identity_mismatch', item['deletion_state'])
        self.assertIn('execution_identity_mismatch_after_quarantine', item['reason'])
        self.assertTrue(approved_original.is_dir())
        self.assertEqual(b'12345', (approved_original / 'scratch').read_bytes())
        approved_identity = inspect_execution(approved_original)
        self.assertEqual(expected_identity['root_device'], approved_identity['root_device'])
        self.assertEqual(expected_identity['root_inode'], approved_identity['root_inode'])
        self.assertTrue(moved_path.is_dir())
        self.assertEqual(b'unreviewed replacement', (moved_path / 'unapproved').read_bytes())
        self.assertEqual(0, result['removed_logical_bytes'])

    def test_postmove_identity_mismatch_preserves_quarantined_tree(self):
        original_rename = os.rename

        def mutate_after_move(source, destination):
            original_rename(source, destination)
            (Path(destination) / 'late-unreviewed-entry').write_bytes(b'preserve')

        with patch(
            'local_runner.retention_executor.os.rename',
            side_effect=mutate_after_move,
        ):
            result = self.apply()

        item = result['items'][0]
        moved_path = Path(item['moved_path'])
        self.assertFalse(result['applied'])
        self.assertEqual('partial_error', item['status'])
        self.assertEqual('identity_mismatch', item['deletion_state'])
        self.assertIn('execution_identity_mismatch_after_quarantine', item['reason'])
        self.assertTrue(moved_path.is_dir())
        self.assertEqual(b'12345', (moved_path / 'scratch').read_bytes())
        self.assertEqual(
            b'preserve', (moved_path / 'late-unreviewed-entry').read_bytes(),
        )
        self.assertEqual(0, result['removed_logical_bytes'])

    def test_restart_records_unknown_moved_path_without_retrying_deletion(self):
        def interrupt_before_delete(_target):
            raise KeyboardInterrupt('simulated process interruption')

        with patch(
            'local_runner.retention_executor.shutil.rmtree',
            side_effect=interrupt_before_delete,
        ):
            with self.assertRaises(KeyboardInterrupt):
                self.apply()

        receipt_path = self.root / 'index' / 'retention-operations' / 'plan-1234abcd.json'
        before_reconcile = json.loads(receipt_path.read_text())
        moved_path = Path(before_reconcile['items'][0]['moved_path'])
        self.assertEqual('running', before_reconcile['status'])
        self.assertEqual('deleting', before_reconcile['items'][0]['status'])
        self.assertEqual('removal_started', before_reconcile['items'][0]['deletion_state'])
        self.assertTrue(moved_path.is_dir())
        self.assertEqual(b'12345', (moved_path / 'scratch').read_bytes())

        reconciled = self.apply()
        self.assertEqual('interrupted_unknown', reconciled['status'])
        self.assertFalse(reconciled['applied'])
        self.assertIsInstance(reconciled['finished_at'], (int, float))
        self.assertEqual('interrupted_unknown', reconciled['items'][0]['status'])
        self.assertEqual('unknown_after_restart', reconciled['items'][0]['deletion_state'])
        self.assertEqual(reconciled, json.loads(receipt_path.read_text()))
        self.assertTrue(moved_path.is_dir())
        self.assertEqual(b'12345', (moved_path / 'scratch').read_bytes())

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
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)
        stdout_log = b'a' * 8191 + '€\n'.encode('utf-8')
        stdout_log += ''.join(f'line {i}\n' for i in range(4001)).encode('utf-8')
        stderr_log = b'worker stderr\n'
        full_log = stdout_log + stderr_log

        def stream_logs(container_id, emit, *, spool_directory):
            self.assertEqual(identifier, container_id)
            self.assertTrue(Path(spool_directory).is_dir())
            emit('stdout', stdout_log[:8192])
            emit('stdout', stdout_log[8192:])
            emit('stderr', stderr_log)
            return 'stdout_then_stderr'

        def assert_archive_before_remove(argv):
            if argv[0] == 'rm':
                self.assertEqual(full_log, (self.run / 'worker-full.log').read_bytes())
                metadata = json.loads((self.run / 'worker-full-log.json').read_text())
                self.assertEqual(len(full_log), metadata['bytes'])
                self.assertEqual(hashlib.sha256(full_log).hexdigest(), metadata['sha256'])
                self.assertEqual('stdout_then_stderr', metadata['channel_order'])
                self.assertEqual(['rm', identifier], argv)

        original_docker = docker

        def observed_docker(argv):
            assert_archive_before_remove(argv)
            return original_docker(argv)

        result = self.apply(call=observed_docker, stream_logs=stream_logs)
        if retention_executor._directory_sync_capability() != 'supported':
            self.assertFalse(result['applied'])
            self.assertIn('worker_full_log_directory_sync_unavailable', result['items'][0]['reason'])
            self.assertEqual(full_log, (self.run / 'worker-full.log').read_bytes())
            metadata = json.loads((self.run / 'worker-full-log.json').read_text())
            self.assertEqual('unavailable', metadata['directory_sync_capability'])
            self.assertTrue(metadata['directory_sync_required_for_success'])
            self.assertIs(False, metadata['directory_entries_synced'])
            self.assertEqual('not_qualified', metadata['power_loss_qualification'])
            self.assertTrue(self.execution.is_dir())
            self.assertFalse(state['removed'])
            return
        self.assertTrue(result['applied'], result)
        self.assertTrue(state['removed'])
        self.assertNotIn(['logs', identifier], state['calls'])
        self.assertEqual(4003, (self.run / 'worker-full.log').read_bytes().count(b'\n'))

    def test_run_root_directory_barrier_follows_both_publications_and_precedes_rm(self):
        if retention_executor._directory_sync_capability() != 'supported':
            self.skipTest('host has no checked directory fsync capability')
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)
        events = []
        original_fsync = os.fsync
        original_publish = retention_executor._publish_exclusive_file
        root_stat = self.run.stat()

        def observe_fsync(descriptor):
            info = os.fstat(descriptor)
            if (stat.S_ISDIR(info.st_mode)
                    and (info.st_dev, info.st_ino) == (root_stat.st_dev, root_stat.st_ino)):
                events.append('run_root_directory_fsync')
            return original_fsync(descriptor)

        def observe_publish(source, destination):
            result = original_publish(source, destination)
            events.append(Path(destination).name)
            return result

        def docker_with_event(argv):
            if argv[0] == 'rm':
                self.assertEqual(
                    ['worker-full.log', 'worker-full-log.json', 'run_root_directory_fsync'],
                    events,
                )
            return docker(argv)

        def stream_logs(_container_id, emit, *, spool_directory):
            emit('stdout', b'complete logs')
            return 'stdout_then_stderr'

        with patch('local_runner.retention_executor.os.fsync', side_effect=observe_fsync), \
                patch('local_runner.retention_executor._publish_exclusive_file',
                      side_effect=observe_publish):
            result = self.apply(call=docker_with_event, stream_logs=stream_logs)

        self.assertTrue(result['applied'], result)
        cleanup = result['items'][0]['container_cleanup']
        self.assertEqual('supported', cleanup['directory_sync_capability'])
        self.assertTrue(cleanup['directory_sync_required_for_success'])
        self.assertIs(True, cleanup['directory_entries_synced'])
        self.assertEqual('not_qualified', cleanup['power_loss_qualification'])
        receipt = json.loads((self.run / 'worker-full-log.json').read_text())
        self.assertIsNone(receipt['directory_entries_synced'])

    def test_run_root_directory_fsync_failure_preserves_archive_worker_and_execution(self):
        if retention_executor._directory_sync_capability() != 'supported':
            self.skipTest('host has no checked directory fsync capability')
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)
        original_fsync = os.fsync
        root_stat = self.run.stat()

        def fail_directory_fsync(descriptor):
            info = os.fstat(descriptor)
            if (stat.S_ISDIR(info.st_mode)
                    and (info.st_dev, info.st_ino) == (root_stat.st_dev, root_stat.st_ino)):
                raise OSError('injected run-root fsync failure')
            return original_fsync(descriptor)

        def stream_logs(_container_id, emit, *, spool_directory):
            emit('stdout', b'complete logs')
            return 'stdout_then_stderr'

        with patch('local_runner.retention_executor.os.fsync', side_effect=fail_directory_fsync):
            result = self.apply(call=docker, stream_logs=stream_logs)

        self.assertFalse(result['applied'])
        self.assertIn('worker_full_log_directory_sync_failed', result['items'][0]['reason'])
        self.assertEqual(b'complete logs', (self.run / 'worker-full.log').read_bytes())
        receipt = json.loads((self.run / 'worker-full-log.json').read_text())
        self.assertEqual('supported', receipt['directory_sync_capability'])
        self.assertTrue(receipt['directory_sync_required_for_success'])
        self.assertIsNone(receipt['directory_entries_synced'])
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())

    def test_unavailable_directory_barrier_publishes_explicit_receipt_then_blocks_rm(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)

        def stream_logs(_container_id, emit, *, spool_directory):
            emit('stdout', b'complete logs')
            return 'stdout_then_stderr'

        with patch('local_runner.retention_executor._directory_sync_capability',
                   return_value='unavailable'):
            result = self.apply(call=docker, stream_logs=stream_logs)

        self.assertFalse(result['applied'])
        self.assertIn('worker_full_log_directory_sync_unavailable', result['items'][0]['reason'])
        self.assertEqual(b'complete logs', (self.run / 'worker-full.log').read_bytes())
        receipt = json.loads((self.run / 'worker-full-log.json').read_text())
        self.assertEqual('unavailable', receipt['directory_sync_capability'])
        self.assertTrue(receipt['directory_sync_required_for_success'])
        self.assertIs(False, receipt['directory_entries_synced'])
        self.assertEqual('not_qualified', receipt['power_loss_qualification'])
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())

    def test_actual_large_subprocess_log_and_receipt_precede_exact_worker_remove(self):
        identifier, inspected = self._prepare_attested_worker()
        stdout_size = 16 * 1024**2 + 321
        stderr_size = 128 * 1024 + 17
        chunk_size = coordinator._LOG_STREAM_CHUNK_BYTES
        child = (
            'import os\n'
            'stdout_size = ' + str(stdout_size) + '\n'
            'stderr_size = ' + str(stderr_size) + '\n'
            'def write_all(fd, value):\n'
            '    view = memoryview(value)\n'
            '    while view:\n'
            '        count = os.write(fd, view)\n'
            '        view = view[count:]\n'
            'stdout_remaining = stdout_size\n'
            'stderr_remaining = stderr_size\n'
            'while stdout_remaining or stderr_remaining:\n'
            '    if stdout_remaining:\n'
            '        amount = min(65536, stdout_remaining)\n'
            "        write_all(1, b'o' * amount)\n"
            '        stdout_remaining -= amount\n'
            '    if stderr_remaining:\n'
            '        amount = min(65536, stderr_remaining)\n'
            "        write_all(2, b'e' * amount)\n"
            '        stderr_remaining -= amount\n'
        )
        expected_hash = hashlib.sha256()
        for byte, total in ((b'o', stdout_size), (b'e', stderr_size)):
            remaining = total
            while remaining:
                amount = min(chunk_size, remaining)
                expected_hash.update(byte * amount)
                remaining -= amount

        state = {'removed': False, 'calls': []}

        def docker(argv):
            state['calls'].append(argv)
            if argv[0] == 'ps':
                return '' if state['removed'] else identifier
            if argv[0] == 'inspect':
                return json.dumps([inspected])
            if argv[0] == 'rm':
                self.assertEqual(['rm', identifier], argv)
                metadata = json.loads((self.run / 'worker-full-log.json').read_text())
                self.assertEqual(stdout_size + stderr_size, metadata['bytes'])
                self.assertEqual(expected_hash.hexdigest(), metadata['sha256'])
                self.assertEqual('stdout_then_stderr', metadata['channel_order'])
                observed_hash = hashlib.sha256()
                observed_bytes = 0
                with (self.run / 'worker-full.log').open('rb') as stream:
                    while True:
                        chunk = stream.read(chunk_size)
                        if not chunk:
                            break
                        observed_hash.update(chunk)
                        observed_bytes += len(chunk)
                self.assertEqual(stdout_size + stderr_size, observed_bytes)
                self.assertEqual(expected_hash.hexdigest(), observed_hash.hexdigest())
                state['removed'] = True
                return identifier
            self.fail(str(argv))

        def stream_logs(container_id, emit, *, spool_directory):
            self.assertEqual(identifier, container_id)
            return coordinator._stream_process_logs(
                [sys.executable, '-c', child],
                emit,
                spool_directory=spool_directory,
                timeout_seconds=120,
            )

        result = self.apply(call=docker, stream_logs=stream_logs)

        if retention_executor._directory_sync_capability() != 'supported':
            self.assertFalse(result['applied'])
            self.assertIn('worker_full_log_directory_sync_unavailable', result['items'][0]['reason'])
            metadata = json.loads((self.run / 'worker-full-log.json').read_text())
            self.assertEqual(stdout_size + stderr_size, metadata['bytes'])
            self.assertEqual(expected_hash.hexdigest(), metadata['sha256'])
            self.assertEqual('unavailable', metadata['directory_sync_capability'])
            self.assertNotIn(['rm', identifier], state['calls'])
            self.assertTrue(self.execution.is_dir())
            return
        self.assertTrue(result['applied'], result)
        self.assertTrue(state['removed'])
        self.assertNotIn(['logs', identifier], state['calls'])
        self.assertFalse(self.execution.exists())

    def test_missing_log_stream_capability_never_falls_back_to_buffered_logs(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)

        result = self.apply(call=docker)

        self.assertFalse(result['applied'])
        self.assertIn('complete_container_log_stream_unavailable', result['items'][0]['reason'])
        self.assertNotIn(['logs', identifier], state['calls'])
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())
        self.assertFalse((self.run / 'worker-full.log').exists())
        self.assertFalse((self.run / 'worker-full-log.json').exists())

    def test_invalid_utf8_stream_preserves_worker_and_execution(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)

        def invalid_stream(_container_id, emit, *, spool_directory):
            emit('stdout', b'valid prefix')
            emit('stderr', b'\xff')
            return 'stdout_then_stderr'

        result = self.apply(call=docker, stream_logs=invalid_stream)

        self.assertFalse(result['applied'])
        self.assertIn('worker_full_log_invalid_utf8', result['items'][0]['reason'])
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())
        self.assertFalse((self.run / 'worker-full.log').exists())
        self.assertFalse((self.run / 'worker-full-log.json').exists())

    def test_incomplete_utf8_suffix_preserves_worker_and_execution(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)

        def incomplete_stream(_container_id, emit, *, spool_directory):
            emit('stdout', b'valid prefix')
            emit('stderr', b'\xe2\x82')
            return 'stdout_then_stderr'

        result = self.apply(call=docker, stream_logs=incomplete_stream)

        self.assertFalse(result['applied'])
        self.assertIn('worker_full_log_invalid_utf8', result['items'][0]['reason'])
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())
        self.assertFalse((self.run / 'worker-full.log').exists())
        self.assertFalse((self.run / 'worker-full-log.json').exists())

    def test_stdout_stderr_boundary_cannot_complete_invalid_utf8_channel(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)

        def cross_channel_sequence(_container_id, emit, *, spool_directory):
            # The concatenation would decode as U+00A9, but each independent
            # Docker channel contains an incomplete UTF-8 sequence.
            emit('stdout', b'\xc2')
            emit('stderr', b'\xa9')
            return 'stdout_then_stderr'

        result = self.apply(call=docker, stream_logs=cross_channel_sequence)

        self.assertFalse(result['applied'])
        self.assertIn('worker_full_log_invalid_utf8', result['items'][0]['reason'])
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())
        self.assertFalse((self.run / 'worker-full.log').exists())
        self.assertFalse((self.run / 'worker-full-log.json').exists())

    def test_existing_archive_and_receipt_are_preserved_without_stream_or_remove(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)
        old_log = b'previous archive must remain byte exact'
        old_receipt = b'{"previous":true}\n'
        (self.run / 'worker-full.log').write_bytes(old_log)
        (self.run / 'worker-full-log.json').write_bytes(old_receipt)

        def unused_stream(*_args, **_kwargs):
            self.fail('a conflicting archive must reject before streaming')

        result = self.apply(call=docker, stream_logs=unused_stream)

        self.assertFalse(result['applied'])
        self.assertIn('worker_full_log_archive_conflict', result['items'][0]['reason'])
        self.assertEqual(old_log, (self.run / 'worker-full.log').read_bytes())
        self.assertEqual(old_receipt, (self.run / 'worker-full-log.json').read_bytes())
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())

    def test_receipt_publish_failure_keeps_log_container_and_execution(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)
        payload = b'complete stream before receipt failure\n'

        def stream_logs(_container_id, emit, *, spool_directory):
            emit('stdout', payload)
            return 'engine_frame_arrival'

        publish = retention_executor._publish_exclusive_file

        def fail_receipt_publish(source, destination):
            if Path(destination).name == 'worker-full-log.json':
                raise OSError('injected receipt publication failure')
            return publish(source, destination)

        with patch('local_runner.retention_executor._publish_exclusive_file',
                   side_effect=fail_receipt_publish):
            result = self.apply(call=docker, stream_logs=stream_logs)

        self.assertFalse(result['applied'])
        self.assertTrue((self.run / 'worker-full.log').is_file())
        self.assertEqual(payload, (self.run / 'worker-full.log').read_bytes())
        self.assertFalse((self.run / 'worker-full-log.json').exists())
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())

    def test_stream_failure_never_removes_worker_or_execution(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)

        def failed_stream(_container_id, emit, *, spool_directory):
            emit('stdout', b'partial logs')
            raise OSError('injected truncated stream')

        result = self.apply(call=docker, stream_logs=failed_stream)

        self.assertFalse(result['applied'])
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())
        self.assertFalse((self.run / 'worker-full.log').exists())
        self.assertFalse((self.run / 'worker-full-log.json').exists())

    def test_second_log_reader_start_failure_never_removes_worker_or_execution(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)
        child = (
            'import os\n'
            'for _ in range(256):\n'
            "    os.write(1, b'o' * 65536)\n"
            "    os.write(2, b'e' * 65536)\n"
        )
        processes = []
        opened_spools = []
        emitted = []
        starts = 0
        original_start = threading.Thread.start
        original_fdopen = os.fdopen

        def popen_factory(command, **kwargs):
            process = subprocess.Popen(command, **kwargs)
            processes.append(process)
            return process

        def tracked_fdopen(descriptor, mode):
            stream = original_fdopen(descriptor, mode)
            opened_spools.append(stream)
            return stream

        def fail_second_start(thread):
            nonlocal starts
            starts += 1
            if starts == 2:
                raise RuntimeError('injected second reader start failure')
            return original_start(thread)

        def stream_logs(container_id, emit, *, spool_directory):
            self.assertEqual(identifier, container_id)
            def observed_emit(channel, payload):
                emitted.append((channel, payload))
                emit(channel, payload)
            return coordinator._stream_process_logs(
                [sys.executable, '-c', child],
                observed_emit,
                spool_directory=spool_directory,
                timeout_seconds=30,
                popen_factory=popen_factory,
            )

        with patch('local_runner.coordinator.os.fdopen', side_effect=tracked_fdopen), \
                patch('local_runner.coordinator.threading.Thread.start', new=fail_second_start):
            result = self.apply(call=docker, stream_logs=stream_logs)

        self.assertFalse(result['applied'])
        self.assertIn('injected second reader start failure', result['items'][0]['reason'])
        self.assertEqual(2, starts)
        self.assertEqual(1, len(processes))
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)
        self.assertTrue(processes[0].stderr.closed)
        self.assertTrue(all(stream.closed for stream in opened_spools))
        self.assertEqual([], emitted)
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())
        self.assertFalse((self.run / 'worker-full.log').exists())
        self.assertFalse((self.run / 'worker-full-log.json').exists())

    def test_preserved_live_reader_spool_blocks_a_blind_capture_retry(self):
        identifier, inspected = self._prepare_attested_worker()
        docker, state = self._worker_docker(identifier, inspected)
        stream_calls = []

        def preserve_live_reader(_container_id, _emit, *, spool_directory):
            stream_calls.append(spool_directory)
            (Path(spool_directory) / 'live-reader.spool').write_bytes(b'unknown partial')
            raise coordinator._DockerLogSpoolsPreservedError(
                'test live reader remains active',
                spool_directory=spool_directory,
            )

        first = self.apply(call=docker, stream_logs=preserve_live_reader)
        self.assertFalse(first['applied'])
        self.assertEqual(1, len(stream_calls))
        preserved = Path(stream_calls[0])
        self.assertEqual(b'unknown partial', (preserved / 'live-reader.spool').read_bytes())
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())

        self.make_plan()
        self.plan['plan_id'] = 'plan-fedc5678'

        def must_not_retry(*_args, **_kwargs):
            self.fail('an unknown private spool requires reconciliation before retry')

        second = self.apply(call=docker, stream_logs=must_not_retry)
        self.assertFalse(second['applied'])
        self.assertIn('worker_full_log_spool_outcome_unknown', second['items'][0]['reason'])
        self.assertEqual(1, len(stream_calls))
        self.assertNotIn(['rm', identifier], state['calls'])
        self.assertTrue(self.execution.is_dir())

    def test_partial_delete_is_recorded_and_not_claimed_as_reclaim(self):
        def fail_after_file(target):
            (target / 'scratch').unlink()
            raise PermissionError('locked remainder')
        with patch('local_runner.retention_executor.shutil.rmtree', side_effect=fail_after_file):
            result = self.apply()
        self.assertFalse(result['applied'])
        self.assertEqual('partial_error', result['items'][0]['status'])
        self.assertEqual('removal_started', result['items'][0]['deletion_state'])
        moved_path = Path(result['items'][0]['moved_path'])
        self.assertTrue(moved_path.is_dir())
        self.assertFalse((moved_path / 'scratch').exists())
        receipt_path = self.root / 'index' / 'retention-operations' / 'plan-1234abcd.json'
        self.assertEqual(result, json.loads(receipt_path.read_text()))
        self.assertEqual(0, result['removed_logical_bytes'])
        self.assertIsNone(result['reclaimed_bytes'])
        self.assertEqual(result, self.apply())


if __name__ == '__main__':
    unittest.main()
