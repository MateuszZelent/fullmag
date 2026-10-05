import json
from pathlib import Path
import tempfile
import unittest

from fullmag_storage import StorageError
from local_runner.runtime_use import register_runtime_reference_root, retention_mutation_guard, runtime_package_use


class RuntimeAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.layout = {'storage_root': str(self.root)}

    def test_consumer_registration_preserves_unverified_legacy_inventory(self):
        (self.root / 'runs').mkdir()
        output = self.root / 'runs' / 'new-output'
        with runtime_package_use(self.layout):
            register_runtime_reference_root(self.layout, output)
        config = json.loads((self.root / 'index/runtime-reference-roots.json').read_text())
        self.assertEqual(['runs/new-output'], config['relative_roots'])
        self.assertFalse(config['legacy_inventory_complete'])
        config['legacy_inventory_complete'] = True
        (self.root / 'index/runtime-reference-roots.json').write_text(json.dumps(config))
        register_runtime_reference_root(self.layout, output)
        self.assertTrue(json.loads((self.root / 'index/runtime-reference-roots.json').read_text())['legacy_inventory_complete'])
        (self.root / 'cache').mkdir()
        register_runtime_reference_root(self.layout, self.root / 'cache' / 'unsupported-output')
        self.assertFalse(json.loads((self.root / 'index/runtime-reference-roots.json').read_text())['legacy_inventory_complete'])

    def test_parallel_readers_protect_until_both_exit(self):
        with runtime_package_use(self.layout):
            with runtime_package_use(self.layout):
                self.assertEqual(2, len(list((self.root / 'locks/runtime-users').iterdir())))
                with self.assertRaisesRegex(StorageError, 'active or unknown'):
                    with retention_mutation_guard(self.layout):
                        self.fail('cleanup entered with readers')
            with self.assertRaises(StorageError):
                with retention_mutation_guard(self.layout):
                    self.fail('cleanup entered before the last reader finished')
        with retention_mutation_guard(self.layout):
            self.assertEqual([], list((self.root / 'locks/runtime-users').iterdir()))

    def test_writer_excludes_new_reader_before_it_touches_package(self):
        with retention_mutation_guard(self.layout):
            with self.assertRaisesRegex(StorageError, 'admission is busy'):
                with runtime_package_use(self.layout):
                    self.fail('reader entered during deletion')
        with runtime_package_use(self.layout):
            pass

    def test_unknown_reader_survives_and_blocks_cleanup(self):
        unknown = self.root / 'locks/runtime-users/unknown'
        unknown.mkdir(parents=True)
        (unknown / 'owner.json').write_text('malformed', encoding='utf-8')
        with self.assertRaisesRegex(StorageError, 'active or unknown'):
            with retention_mutation_guard(self.layout):
                pass
        self.assertEqual('malformed', (unknown / 'owner.json').read_text())

    def test_dangling_users_namespace_is_not_an_empty_inventory(self):
        (self.root / 'locks').mkdir()
        users = self.root / 'locks/runtime-users'
        try:
            users.symlink_to(self.root / 'missing', target_is_directory=True)
        except OSError:
            self.skipTest('host cannot create symlinks')
        with self.assertRaisesRegex(StorageError, 'Unsafe storage admission'):
            with retention_mutation_guard(self.layout):
                self.fail('dangling namespace admitted deletion')
        with self.assertRaisesRegex(StorageError, 'Unsafe storage admission'):
            with runtime_package_use(self.layout):
                self.fail('dangling namespace admitted runtime')
        self.assertTrue(users.is_symlink())

    def test_linked_lock_parent_is_rejected_without_writing_target(self):
        outside = self.root / 'outside'
        outside.mkdir()
        try:
            (self.root / 'locks').symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest('host cannot create symlinks')
        with self.assertRaisesRegex(StorageError, 'Unsafe storage admission'):
            with runtime_package_use(self.layout):
                pass
        self.assertEqual([], list(outside.iterdir()))

    def test_interrupted_gate_is_never_deleted_by_age(self):
        gate = self.root / 'locks/retention-admission'
        gate.mkdir(parents=True)
        with self.assertRaisesRegex(StorageError, 'needs recovery'):
            with retention_mutation_guard(self.layout):
                pass
        self.assertTrue(gate.exists())

    def test_reader_exception_releases_own_ticket(self):
        with self.assertRaisesRegex(RuntimeError, 'fixture'):
            with runtime_package_use(self.layout):
                raise RuntimeError('fixture')
        with retention_mutation_guard(self.layout):
            pass

    def test_replaced_ticket_remains_protective(self):
        with self.assertRaisesRegex(StorageError, 'ownership changed'):
            with runtime_package_use(self.layout):
                ticket = next((self.root / 'locks/runtime-users').iterdir())
                record = json.loads((ticket / 'owner.json').read_text())
                record['token'] = 'foreign'
                (ticket / 'owner.json').write_text(json.dumps(record))
        self.assertTrue(ticket.exists())
        with self.assertRaises(StorageError):
            with retention_mutation_guard(self.layout):
                pass


if __name__ == '__main__':
    unittest.main()
