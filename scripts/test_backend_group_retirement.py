"""Regression checks for exact group retirement and interrupted cleanup."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'docker/all-in-one'))
import backend_group_retirement as retirement
import backend_shared_store as shared


class GroupRetirementTests(unittest.TestCase):
    def fixture(self, root, key='a'*64):
        store = root / 'store'
        store.mkdir(exist_ok=True)
        shared.Store(store)
        archive = root / 'archive'
        archive.mkdir(exist_ok=True)
        group = store / 'groups' / key
        marker = group / retirement.MARKER
        marker.parent.mkdir(parents=True)
        marker.write_text(json.dumps(dict(schema='fullmag.backend-build-cache-owner.v2', state='owned',
            unit_key=key, owner_id=key, role='package', volume_name='packages', uid=65532, gid=65532)))
        (group / 'payload').write_bytes(b'disposable build')
        return store, archive, group, key

    def test_removes_only_selected_group_and_preserves_shared_hardlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store, archive, group, key = self.fixture(root)
            other = store / 'groups' / ('b'*64)
            other.mkdir()
            os.link(group / 'payload', other / 'current')
            result = retirement.retire(store, [key], 'packages', archive)
            self.assertEqual(result['state'], 'succeeded')
            self.assertFalse(group.exists())
            self.assertEqual((other / 'current').read_bytes(), b'disposable build')
            self.assertTrue((archive / (key+'.json')).exists())
            self.assertEqual(retirement.retire(store, [key], 'packages', archive)['groups'][0]['state'], 'absent')

    def test_foreign_marker_and_symlink_refuse_before_unlink(self):
        for corruption in ('marker', 'symlink', 'pending'):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as tmp:
                store, archive, group, key = self.fixture(Path(tmp))
                if corruption == 'marker':
                    (group / retirement.MARKER).write_text('{}')
                elif corruption == 'symlink':
                    (group / 'escape').symlink_to(archive, target_is_directory=True)
                else:
                    (group / '.development/rotation.pending.json').write_text('{}')
                with self.assertRaises(shared.StoreError):
                    retirement.retire(store, [key], 'packages', archive)
                self.assertTrue((group / 'payload').exists())

    def test_interrupted_unlink_can_resume_from_durable_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, archive, group, key = self.fixture(Path(tmp))
            (group / 'second').write_bytes(b'next')
            unlink = Path.unlink
            def interrupted(path, *args, **kwargs):
                if path.name == 'second':
                    raise OSError('interrupted after first unlink')
                return unlink(path, *args, **kwargs)
            with patch.object(Path, 'unlink', interrupted):
                with self.assertRaises(OSError):
                    retirement.retire(store, [key], 'packages', archive)
            self.assertTrue((group / retirement.MARKER).exists())
            retirement.retire(store, [key], 'packages', archive)
            self.assertFalse(group.exists())

    def test_crash_before_intent_publish_does_not_block_next_attempt(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, archive, group, key = self.fixture(Path(tmp))
            with patch.object(retirement.os, 'replace', side_effect=OSError('crash before rename')):
                with self.assertRaises(OSError):
                    retirement.retire(store, [key], 'packages', archive)
            self.assertTrue((group / 'payload').exists())
            self.assertTrue(list(archive.glob('*.tmp')))
            retirement.retire(store, [key], 'packages', archive)
            self.assertFalse(group.exists())

    def test_retry_after_marker_unlink_and_incomplete_directory_removal(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, archive, group, key = self.fixture(Path(tmp))
            rmdir = Path.rmdir
            def interrupted(path, *args, **kwargs):
                if path == group / retirement.MARKER.parent:
                    raise OSError('crash after owner marker unlink')
                return rmdir(path, *args, **kwargs)
            with patch.object(Path, 'rmdir', interrupted):
                with self.assertRaises(OSError):
                    retirement.retire(store, [key], 'packages', archive)
            self.assertFalse((group / retirement.MARKER).exists())
            retirement.retire(store, [key], 'packages', archive)
            self.assertFalse(group.exists())

    def test_changed_group_inode_is_not_adopted_from_old_intent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store, archive, group, key = self.fixture(root)
            with patch.object(Path, 'unlink', side_effect=OSError('crash before deletion')):
                with self.assertRaises(OSError):
                    retirement.retire(store, [key], 'packages', archive)
            group.rename(root / 'preserved-old-group')
            self.fixture(root, key)
            with self.assertRaises(shared.StoreError):
                retirement.retire(store, [key], 'packages', archive)
            self.assertTrue((group / 'payload').exists())

    def test_retirement_does_not_need_global_exclusive_gc_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, archive, group, key = self.fixture(Path(tmp))
            with shared.Store(store).claim({'another-group': True}):
                retirement.retire(store, [key], 'packages', archive)
            self.assertFalse(group.exists())


if __name__ == '__main__':
    unittest.main()
