import json
from contextlib import closing
import os
import shutil
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

from fullmag_storage import StorageError
from local_runner.queue import JobQueue
from local_runner.retention_executor import CleanupBlocked
from local_runner.runtime_retention import apply_runtime_cleanup, plan_runtime_cleanup
from local_runner.runtime_use import register_runtime_reference_root, runtime_package_use
from test_export_runner_openapi import Fixture, JOB_ID, WORKTREE


class RuntimeCleanupTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.addCleanup(self.fixture.close)
        self.root = self.fixture.storage
        (self.root / 'locks').mkdir()
        self.layout = self.fixture.layout
        with closing(sqlite3.connect(self.root / 'index/runner-jobs.sqlite', isolation_level=None)) as database:
            database.execute('PRAGMA user_version=1')
            newer_id = 'a' * 32
            newer_root = self.fixture.run_root.parent / newer_id
            shutil.copytree(self.fixture.run_root, newer_root)
            receipt_path = newer_root / 'artifacts/build-receipt.json'
            receipt = json.loads(receipt_path.read_text())
            receipt['job_id'] = newer_id
            receipt_path.write_text(json.dumps(receipt))
            database.execute('INSERT INTO jobs (job_id,owner,request_key,request_hash,worktree_id,source_digest,'
                             'profile,operation,payload,state,created_at,updated_at,exit_code) '
                             'SELECT ?,owner,?,request_hash,worktree_id,source_digest,profile,operation,payload,'
                             'state,2,2,exit_code FROM jobs WHERE job_id=?', (newer_id, 'newer-request', JOB_ID))
        self.queue = JobQueue(self.root / 'index/runner-jobs.sqlite', readonly=True)
        journal = {**self.fixture.journal, 'container_id': 'd' * 64, 'finished_at': 1}
        for name in ('receipt.json', 'coordinator.json'):
            (self.fixture.run_root / name).write_text(json.dumps(journal))
        (self.fixture.run_root / 'worker.log').write_text('preserved compiler log')
        self.result = self.fixture.run_root / 'scientific-data/frequency.csv'
        self.result.parent.mkdir()
        self.result.write_text('10,9.8\n')
        (self.root / 'index/runtime-reference-roots.json').write_text(json.dumps({
            'schema': 'fullmag.runtime-reference-roots.v1', 'relative_roots': [], 'legacy_inventory_complete': True}))
        self.policy = {'min_artifacts_to_keep': 1}
        self.plan = self.preview()
        self.plan['plan_id'] = 'plan-1234abcd'

    def docker(self, argv):
        if argv[0] == 'ps':
            return ''
        self.fail('unexpected Docker mutation: ' + str(argv))

    def preview(self, call=None):
        return plan_runtime_cleanup(self.layout, self.queue, owner='fixture', call=call or self.docker,
                                    policy=self.policy)

    def apply(self, call=None):
        return apply_runtime_cleanup(self.layout, self.plan, self.queue, owner='fixture',
                                     call=call or self.docker, policy=self.policy)

    def test_removes_exact_package_preserving_source_results_and_receipts(self):
        self.assertEqual(1, self.plan['candidates_count'])
        source_manifest = (self.fixture.capsule / 'manifest.json').read_bytes()
        result = self.apply()
        self.assertTrue(result['applied'], result)
        self.assertFalse(self.fixture.package.exists())
        self.assertEqual(source_manifest, (self.fixture.capsule / 'manifest.json').read_bytes())
        self.assertEqual('10,9.8\n', self.result.read_text())
        for name in ('receipt.json', 'worker.log', 'coordinator.json', 'artifacts/build-receipt.json'):
            self.assertTrue((self.fixture.run_root / name).is_file())
        tombstone = json.loads((self.fixture.run_root / 'artifacts/runtime-package-retention.json').read_text())
        self.assertEqual('removed', tombstone['state'])
        self.assertEqual('deleted', tombstone['deletion_state'])
        self.assertEqual('deleted', result['items'][0]['deletion_state'])
        self.assertEqual(self.plan['candidates'][0]['package_tree'], tombstone['package_tree_identity'])
        self.assertEqual(self.plan['candidates'][0]['package_tree']['root_inode'],
                         tombstone['package_tree_identity']['root_inode'])
        self.assertFalse(Path(tombstone['quarantine_path']).exists())
        self.assertEqual(JOB_ID, tombstone['job_id'])
        self.assertEqual(result, self.apply())
        self.assertIsNone(result['reclaimed_bytes'])

    def test_source_replacement_before_move_preserves_original_and_replacement(self):
        original_package = self.fixture.run_root / 'approved-package-preserved'
        original_rename = os.rename

        def replace_before_move(source, destination):
            if Path(source) == self.fixture.package and Path(destination).name == 'package':
                original_rename(source, original_package)
                Path(source).mkdir()
                (Path(source) / 'unapproved').write_bytes(b'unapproved replacement')
            original_rename(source, destination)

        with patch('local_runner.runtime_retention.os.rename', side_effect=replace_before_move):
            result = self.apply()

        item = result['items'][0]
        moved = Path(item['moved_path'])
        self.assertFalse(result['applied'])
        self.assertEqual('identity_mismatch', item['deletion_state'])
        self.assertIn('runtime_package_identity_mismatch_after_quarantine', item['reason'])
        self.assertEqual(b'fixture-0\n', (original_package / self.fixture.outputs[0]).read_bytes())
        self.assertTrue(moved.is_dir())
        self.assertEqual(b'unapproved replacement', (moved / 'unapproved').read_bytes())
        self.assertEqual(0, result['removed_logical_bytes'])
        self.assertIsNone(result['reclaimed_bytes'])

    def test_source_replacement_after_move_preserves_both_paths(self):
        original_rename = os.rename

        def replace_after_move(source, destination):
            original_rename(source, destination)
            if Path(source) == self.fixture.package and Path(destination).name == 'package':
                Path(source).mkdir()
                (Path(source) / 'new-package').write_bytes(b'preserve source replacement')

        with patch('local_runner.runtime_retention.os.rename', side_effect=replace_after_move):
            result = self.apply()

        item = result['items'][0]
        moved = Path(item['moved_path'])
        self.assertFalse(result['applied'])
        self.assertEqual('source_path_reappeared', item['deletion_state'])
        self.assertIn('runtime_package_path_reappeared_after_quarantine', item['reason'])
        self.assertTrue(moved.is_dir())
        self.assertEqual(b'fixture-0\n', (moved / self.fixture.outputs[0]).read_bytes())
        self.assertEqual(b'preserve source replacement',
                         (self.fixture.package / 'new-package').read_bytes())
        self.assertEqual(0, result['removed_logical_bytes'])
        self.assertIsNone(result['reclaimed_bytes'])

    def test_postmove_identity_mismatch_preserves_quarantined_package(self):
        original_rename = os.rename

        def mutate_after_move(source, destination):
            original_rename(source, destination)
            if Path(source) == self.fixture.package and Path(destination).name == 'package':
                (Path(destination) / 'late-unreviewed-entry').write_bytes(b'preserve')

        with patch('local_runner.runtime_retention.os.rename', side_effect=mutate_after_move):
            result = self.apply()

        item = result['items'][0]
        moved = Path(item['moved_path'])
        self.assertFalse(result['applied'])
        self.assertEqual('identity_mismatch', item['deletion_state'])
        self.assertIn('runtime_package_identity_mismatch_after_quarantine', item['reason'])
        self.assertTrue(moved.is_dir())
        self.assertEqual(b'preserve', (moved / 'late-unreviewed-entry').read_bytes())
        self.assertEqual(0, result['removed_logical_bytes'])
        self.assertIsNone(result['reclaimed_bytes'])

    def test_interrupted_delete_reconciles_as_unknown_without_retrying(self):
        def interrupt_before_delete(_target):
            raise KeyboardInterrupt('simulated process interruption')

        with patch('local_runner.runtime_retention.shutil.rmtree', side_effect=interrupt_before_delete):
            with self.assertRaises(KeyboardInterrupt):
                self.apply()

        receipt_path = self.root / 'index/retention-operations' / (self.plan['plan_id'] + '.json')
        before_reconcile = json.loads(receipt_path.read_text())
        item = before_reconcile['items'][0]
        moved = Path(item['moved_path'])
        tombstone_path = self.fixture.run_root / 'artifacts/runtime-package-retention.json'
        self.assertEqual('running', before_reconcile['status'])
        self.assertEqual('removal_started', item['deletion_state'])
        self.assertTrue(moved.is_dir())

        reconciled = self.apply()
        tombstone = json.loads(tombstone_path.read_text())
        self.assertEqual('interrupted_unknown', reconciled['status'])
        self.assertFalse(reconciled['applied'])
        self.assertEqual('unknown_after_restart', reconciled['items'][0]['deletion_state'])
        self.assertEqual('partial_error', tombstone['state'])
        self.assertEqual('unknown_after_restart', tombstone['deletion_state'])
        self.assertEqual(0, reconciled['removed_logical_bytes'])
        self.assertIsNone(reconciled['reclaimed_bytes'])
        self.assertTrue(moved.is_dir())
        self.assertEqual(0, self.preview()['candidates_count'])

    def test_missing_authoritative_legacy_root_registry_protects_all_packages(self):
        (self.root / 'index/runtime-reference-roots.json').unlink()
        plan = self.preview()
        self.assertEqual(0, plan['candidates_count'])
        self.assertTrue(plan['raw_runtime_plan']['unknown_scope'])
        self.assertTrue(self.fixture.package.exists())

    def test_drive_qualified_registered_roots_reject_before_traversal_or_apply_mutation(self):
        registry = self.root / 'index/runtime-reference-roots.json'
        valid_registry = registry.read_bytes()
        package = self.fixture.package
        package_before = {
            path.relative_to(package).as_posix(): (
                'directory' if path.is_dir() else 'file',
                None if path.is_dir() else path.read_bytes(),
            )
            for path in package.rglob('*')
        }
        tombstone_path = self.fixture.run_root / 'artifacts/runtime-package-retention.json'

        for index, relative in enumerate((
            'C:/missing/consumer',
            'runs/absent/C:/outside',
        )):
            with self.subTest(relative=relative):
                registry.write_bytes(valid_registry)
                self.plan = self.preview()
                self.plan['plan_id'] = ('plan-11aa2233', 'plan-44bb5566')[index]
                self.assertEqual(1, self.plan['candidates_count'])
                quarantine_path = self.fixture.run_root / (
                    '.runtime-package-quarantine-' + self.plan['plan_id']
                )
                self.assertFalse(quarantine_path.exists())
                self.assertFalse(tombstone_path.exists())

                invalid_registry = json.dumps({
                    'schema': 'fullmag.runtime-reference-roots.v1',
                    'relative_roots': [relative],
                    'legacy_inventory_complete': True,
                }).encode('utf-8')
                registry.write_bytes(invalid_registry)

                with patch(
                    'local_runner.runtime_retention._registered_reference_root',
                    side_effect=AssertionError('invalid path reached component traversal'),
                ) as resolve_root:
                    with self.assertRaisesRegex(CleanupBlocked, 'invalid_runtime_reference_root'):
                        self.preview()
                    resolve_root.assert_not_called()

                result = self.apply()

                self.assertFalse(result['applied'])
                self.assertEqual(0, result['removed_logical_bytes'])
                self.assertIsNone(result['reclaimed_bytes'])
                self.assertEqual(
                    'CleanupBlocked: retention_operation_error: invalid_runtime_reference_root',
                    result['items'][0]['reason'],
                )
                self.assertTrue(package.is_dir())
                self.assertEqual(package_before, {
                    path.relative_to(package).as_posix(): (
                        'directory' if path.is_dir() else 'file',
                        None if path.is_dir() else path.read_bytes(),
                    )
                    for path in package.rglob('*')
                })
                self.assertEqual(invalid_registry, registry.read_bytes())
                self.assertFalse(tombstone_path.exists())
                self.assertFalse(quarantine_path.exists())

    def test_missing_registered_leaf_is_reported_stale_without_hiding_other_candidates(self):
        output_root = self.root / 'runs' / WORKTREE / 'failed-output'
        registry = self.root / 'index/runtime-reference-roots.json'
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        registry_before = registry.read_bytes()

        preview = self.preview()

        raw = preview['raw_runtime_plan']
        self.assertEqual(1, preview['candidates_count'])
        self.assertFalse(raw['unknown_scope'])
        self.assertFalse(raw['complete'])
        self.assertEqual('partial', raw['status'])
        self.assertEqual('partial', preview['reference_status'])
        self.assertTrue(any(
            error.get('scope') == 'registered_root'
            and error.get('code') == 'registered_reference_root_missing'
            and error.get('path') == str(output_root)
            for error in preview['reference_errors']
        ))
        self.assertEqual(registry_before, registry.read_bytes())
        self.assertFalse(output_root.exists())

    def test_active_runtime_ticket_still_blocks_apply_with_a_stale_root(self):
        output_root = self.root / 'runs' / WORKTREE / 'failed-output'
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
            self.plan = self.preview()
            self.plan['plan_id'] = 'plan-1234abcd'
            self.assertEqual(1, self.plan['candidates_count'])
            self.assertFalse(self.plan['raw_runtime_plan']['unknown_scope'])
            with self.assertRaisesRegex(StorageError, 'active or unknown runtime users'):
                self.apply()
        self.assertTrue(self.fixture.package.is_dir())

    def test_active_queue_job_still_blocks_apply_with_a_stale_root(self):
        output_root = self.root / 'runs' / WORKTREE / 'failed-output'
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        self.plan = self.preview()
        self.plan['plan_id'] = 'plan-1234abcd'

        with patch.object(self.queue, 'active', return_value=[{'job_id': JOB_ID, 'state': 'running'}]):
            with self.assertRaisesRegex(CleanupBlocked, 'active_queue_lease'):
                self.apply()
        self.assertTrue(self.fixture.package.is_dir())

    def test_stale_leaf_does_not_block_apply_of_unreferenced_package(self):
        output_root = self.root / 'runs' / WORKTREE / 'failed-output'
        registry = self.root / 'index/runtime-reference-roots.json'
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        registry_before = registry.read_bytes()
        self.plan = self.preview()
        self.plan['plan_id'] = 'plan-1234abcd'

        result = self.apply()

        self.assertTrue(result['applied'], result)
        self.assertFalse(self.fixture.package.exists())
        self.assertFalse(output_root.exists())
        self.assertEqual(registry_before, registry.read_bytes())
        tombstone = json.loads(
            (self.fixture.run_root / 'artifacts/runtime-package-retention.json').read_text(),
        )
        self.assertEqual('removed', tombstone['state'])

    def test_reappearing_registered_root_is_rechecked_before_apply_mutation(self):
        output_root = self.root / 'runs' / WORKTREE / 'failed-output-parent' / 'output'
        output_root.parent.mkdir()
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        shutil.rmtree(output_root.parent)
        self.plan = self.preview()
        self.plan['plan_id'] = 'plan-1234abcd'
        self.assertEqual(1, self.plan['candidates_count'])
        self.assertEqual('partial', self.plan['reference_status'])

        output_root.parent.mkdir()
        output_root.mkdir()
        (output_root / 'consumer.json').write_text(json.dumps({
            'artifact_root': str(self.fixture.package),
        }))
        result = self.apply()

        self.assertFalse(result['applied'])
        self.assertEqual(
            'CleanupBlocked: retention_operation_error: runtime_now_referenced_or_inventory_changed',
            result['items'][0]['reason'],
        )
        self.assertTrue(self.fixture.package.is_dir())
        self.assertFalse((self.fixture.run_root / '.runtime-package-quarantine-plan-1234abcd').exists())

    def test_missing_registered_subtree_is_reported_stale_without_hiding_candidates(self):
        output_root = self.root / 'runs' / WORKTREE / 'failed-parent' / 'output'
        output_root.parent.mkdir()
        registry = self.root / 'index/runtime-reference-roots.json'
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        registry_before = registry.read_bytes()
        shutil.rmtree(output_root.parent)

        preview = self.preview()

        self.assertEqual(1, preview['candidates_count'])
        self.assertFalse(preview['raw_runtime_plan']['unknown_scope'])
        self.assertFalse(preview['raw_runtime_plan']['complete'])
        self.assertEqual('partial', preview['reference_status'])
        self.assertTrue(any(
            error.get('code') == 'registered_reference_root_missing'
            and error.get('path') == str(output_root)
            for error in preview['reference_errors']
        ))
        self.assertEqual(registry_before, registry.read_bytes())
        self.assertFalse(output_root.parent.exists())
        self.assertTrue(self.fixture.package.is_dir())

    def test_reparse_existing_registered_prefix_remains_fail_closed(self):
        output_root = self.root / 'runs' / WORKTREE / 'replaced-prefix' / 'output'
        output_root.parent.mkdir()
        outside = self.root.parent / (self.root.name + '-prefix-outside')
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        shutil.rmtree(output_root.parent)
        try:
            output_root.parent.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'symlink fixture unavailable: {error}')

        with self.assertRaisesRegex(Exception, 'unsafe_reparse_path'):
            self.preview()
        self.assertTrue(self.fixture.package.is_dir())

    def test_regular_file_replacing_registered_prefix_remains_fail_closed(self):
        output_root = self.root / 'runs' / WORKTREE / 'replaced-prefix' / 'output'
        output_root.parent.mkdir()
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        shutil.rmtree(output_root.parent)
        output_root.parent.write_text('foreign prefix', encoding='utf-8')

        with self.assertRaisesRegex(Exception, 'invalid_run_path'):
            self.preview()
        self.assertTrue(self.fixture.package.is_dir())

    def test_unreadable_existing_registered_prefix_remains_fail_closed(self):
        output_root = self.root / 'runs' / WORKTREE / 'unreadable-prefix' / 'output'
        output_root.parent.mkdir()
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        real_lstat = os.lstat

        def deny_prefix(path, *args, **kwargs):
            if Path(path) == output_root.parent:
                raise PermissionError('fixture unreadable prefix')
            return real_lstat(path, *args, **kwargs)

        with patch('local_runner.runtime_retention.retention.os.lstat', side_effect=deny_prefix):
            with self.assertRaisesRegex(Exception, 'unreadable_run_path'):
                self.preview()
        self.assertTrue(self.fixture.package.is_dir())

    def test_reparse_registered_root_leaf_remains_fail_closed(self):
        output_root = self.root / 'runs' / WORKTREE / 'reparse-output'
        outside = self.root.parent / (self.root.name + '-outside')
        outside.mkdir()
        self.addCleanup(shutil.rmtree, outside, ignore_errors=True)
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        try:
            output_root.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            self.skipTest(f'symlink fixture unavailable: {error}')

        with self.assertRaisesRegex(Exception, 'unsafe_reparse_path'):
            self.preview()
        self.assertTrue(self.fixture.package.is_dir())

    def test_regular_file_replacing_registered_directory_leaf_remains_fail_closed(self):
        output_root = self.root / 'runs' / WORKTREE / 'file-output'
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output_root)
        output_root.write_text('{}', encoding='utf-8')

        with self.assertRaisesRegex(Exception, 'invalid_run_path'):
            self.preview()
        self.assertTrue(self.fixture.package.is_dir())

    def test_latest_minimum_keeps_available_package(self):
        self.policy['min_artifacts_to_keep'] = 2
        self.assertEqual(0, self.preview()['candidates_count'])
        result = self.apply()
        self.assertFalse(result['applied'])
        self.assertTrue(self.fixture.package.exists())

    def test_new_openapi_consumer_prevents_stale_delete(self):
        receipt = self.root / 'runs' / WORKTREE / 'openapi-export/consumer/receipt.json'
        receipt.parent.mkdir(parents=True)
        receipt.write_text(json.dumps({'schema': 'fullmag.managed-package-openapi.v1',
                                       'job_id': JOB_ID, 'state': 'succeeded'}))
        result = self.apply()
        self.assertFalse(result['applied'])
        self.assertIn('now_referenced', result['items'][0]['reason'])
        self.assertTrue(self.fixture.package.exists())

    def test_new_pin_and_corrupt_pin_index_are_protective(self):
        path = self.root / 'index/pinned-resources.json'
        for content in (json.dumps({f'art-{WORKTREE}-{JOB_ID}': {'pinned': True}}), 'invalid json'):
            path.write_text(content)
            plan = self.preview()
            self.assertEqual(0, plan['candidates_count'], plan)

    def test_new_stopped_container_mount_prevents_delete(self):
        identifier = 'e' * 64
        def call(argv):
            if argv[0] == 'ps':
                return identifier
            return json.dumps([{'Id': identifier, 'State': {'Running': False}, 'Config': {'Labels': {}},
                                'Mounts': [{'Type': 'bind', 'Source': str(self.fixture.package)}]}])
        result = self.apply(call=call)
        self.assertFalse(result['applied'])
        self.assertTrue(self.fixture.package.exists())

    def test_changed_package_or_receipt_requires_fresh_plan(self):
        binary = self.fixture.package / self.fixture.outputs[0]
        binary.write_bytes(b'tampered')
        result = self.apply()
        self.assertFalse(result['applied'])
        self.assertIn('runtime_plan_stale', result['items'][0]['reason'])
        self.assertTrue(self.fixture.package.exists())

    def test_partial_delete_is_durable_and_never_claims_reclaim(self):
        def interrupted(target):
            first = next(path for path in target.rglob('*') if path.is_file())
            first.unlink()
            raise OSError('fixture interrupted delete')
        with patch('local_runner.runtime_retention.shutil.rmtree', side_effect=interrupted):
            result = self.apply()
        self.assertEqual('partial', result['status'])
        self.assertEqual('partial_error', result['items'][0]['status'])
        self.assertEqual(0, result['removed_logical_bytes'])
        self.assertIsNone(result['reclaimed_bytes'])
        tombstone = json.loads((self.fixture.run_root / 'artifacts/runtime-package-retention.json').read_text())
        self.assertEqual('partial_error', tombstone['state'])
        self.assertEqual(0, self.preview()['candidates_count'])
        self.assertEqual('10,9.8\n', self.result.read_text())

    def test_unknown_reference_scope_refuses_apply_before_mutation(self):
        self.plan['raw_runtime_plan']['unknown_scope'] = True
        with self.assertRaisesRegex(CleanupBlocked, 'scope_unknown'):
            self.apply()
        self.assertTrue(self.fixture.package.exists())

    def test_unverified_journal_preserves_package(self):
        path = self.fixture.run_root / 'coordinator.json'
        data = json.loads(path.read_text())
        data['owner'] = 'foreign'
        path.write_text(json.dumps(data))
        result = self.apply()
        self.assertFalse(result['applied'])
        self.assertIn('unverified_runtime_journal', result['items'][0]['reason'])


if __name__ == '__main__':
    unittest.main()
