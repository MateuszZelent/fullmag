"""Small private-fixture checks for moving data without losing original bytes."""
import os
from pathlib import Path
import shutil
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import fullmag_data_volume_fs as volume_fs
from scripts import fullmag_data_volume_manifest as manifests


@unittest.skipUnless(os.name == 'posix' and shutil.which('tar'), 'Unix archive tooling')
class DataVolumeArchiveTests(unittest.TestCase):
    def setUp(self):
        # Real small-file tar/ACL fixtures must not need 25 GiB of disk space.
        # Only the capacity observation is mocked; all archive I/O remains real.
        capacity = mock.patch.object(volume_fs.os, 'fstatvfs',
            return_value=SimpleNamespace(f_bavail=128*1024**3, f_frsize=1))
        capacity.start(); self.addCleanup(capacity.stop)

    def test_copy_never_consumes_the_reserved_campaign_headroom(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base/'source'; target = base/'target'
            source.mkdir(); target.mkdir()
            user = source/'user'; state = source/'state'; user.mkdir(); state.mkdir()
            content = b'full retained scientific chunk'
            (user/'m.zarr').write_bytes(content)
            # Enough for both representations, but one byte below the approved
            # 25 GiB reserve. The former 16 MiB gate accepted this observation.
            available = 2*len(content)+25*1024**3-1
            with mock.patch.object(volume_fs.os, 'fstatvfs',
                    return_value=SimpleNamespace(f_bavail=available, f_frsize=1)), \
                    mock.patch.object(volume_fs, '_run_to_file',
                        side_effect=AssertionError('archive started below the approved reserve')) as archive, \
                    self.assertRaisesRegex(ValueError, '25 GiB'):
                volume_fs.archive_and_extract(source, {'user_data':user, 'state':state},
                    target/'original.tar', target/'payload')
            archive.assert_not_called()
            self.assertEqual(list(target.iterdir()), [])
            self.assertEqual((user/'m.zarr').read_bytes(), content)

    def test_payload_replacement_before_open_does_not_write_existing_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base / 'source'; target = base / 'target'
            source.mkdir(); target.mkdir()
            user = source / 'user'; state = source / 'state'; user.mkdir(); state.mkdir()
            (user / 'chunk').write_bytes(b'result')
            existing = target / 'other-tree'; existing.mkdir(mode=0o700)
            (existing / 'keep').write_bytes(b'unrelated')
            original = os.open
            def replace_payload(path, *args, **kwargs):
                if path == 'payload':
                    (target / 'payload').rename(target / 'created-payload')
                    existing.rename(target / 'payload')
                return original(path, *args, **kwargs)
            with mock.patch.object(volume_fs.os, 'open', side_effect=replace_payload):
                with self.assertRaisesRegex(ValueError, 'replaced'):
                    volume_fs.archive_and_extract(source, {'user_data': user, 'state': state},
                                                  target / 'original.tar', target / 'payload')
            self.assertEqual(list((target / 'payload').iterdir()), [target / 'payload/keep'])
            self.assertEqual((target / 'payload/keep').read_bytes(), b'unrelated')

    def test_parent_replacement_never_redirects_archive_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base / 'source'; target = base / 'target'
            outside = base / 'unrelated'; source.mkdir(); target.mkdir(); outside.mkdir()
            user = source / 'user'; state = source / 'state'; user.mkdir(); state.mkdir()
            (user / 'chunk').write_bytes(b'result')
            original = os.open
            def replace_parent(path, *args, **kwargs):
                if str(path).endswith('.create.stderr'):
                    target.rename(base / 'pinned-target')
                    target.symlink_to(outside, target_is_directory=True)
                return original(path, *args, **kwargs)
            with mock.patch.object(volume_fs.os, 'open', side_effect=replace_parent):
                with self.assertRaises(ValueError):
                    volume_fs.archive_and_extract(source, {'user_data': user, 'state': state},
                                                  target / 'original.tar', target / 'payload')
            self.assertEqual(list(outside.iterdir()), [])

    def test_payload_replacement_never_redirects_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base / 'source'; target = base / 'target'
            outside = base / 'unrelated'; source.mkdir(); target.mkdir(); outside.mkdir()
            user = source / 'user'; state = source / 'state'; user.mkdir(); state.mkdir()
            (user / 'chunk').write_bytes(b'result')
            original = volume_fs._run_to_file
            def replace_payload(argv, *args, **kwargs):
                if '-x' in argv:
                    (target / 'payload').rename(target / 'pinned-payload')
                    (target / 'payload').symlink_to(outside, target_is_directory=True)
                return original(argv, *args, **kwargs)
            with mock.patch.object(volume_fs, '_run_to_file', side_effect=replace_payload):
                with self.assertRaises(ValueError):
                    volume_fs.archive_and_extract(source, {'user_data': user, 'state': state},
                                                  target / 'original.tar', target / 'payload')
            self.assertEqual(list(outside.iterdir()), [])

    def test_archive_extract_preserves_metadata_and_hardlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base / 'source'; target = base / 'target'
            source.mkdir(); target.mkdir()
            user = source / 'user-data' / 'group'; state = source / 'runtimes' / 'group'
            user.mkdir(parents=True); state.mkdir(parents=True)
            value = user / 'm.zarr'; value.write_bytes(b'complete scientific chunk')
            os.link(value, state / 'retained-link')
            os.setxattr(value, 'user.fullmag_fixture', b'preserve me')
            value.chmod(0o640)
            os.utime(value, ns=(1712345678123456789, 1712345678123456789))
            roots = {'user_data': user, 'state': state}
            before = manifests.inventory_datasets(roots)
            report = volume_fs.archive_and_extract(
                source, roots, target / 'original.tar', target / 'payload',
            )
            copied = {role: target / 'payload' / path.relative_to(source) for role, path in roots.items()}
            manifests.require_matching_data(before, manifests.inventory_datasets(copied))
            self.assertEqual(report['state'], 'copied-and-verified')
            self.assertEqual(report['data_sha256'], before['data_sha256'])
            self.assertTrue((target / 'original.tar').is_file())
            self.assertEqual(value.read_bytes(), b'complete scientific chunk')
            self.assertEqual(os.stat(copied['user_data'] / 'm.zarr').st_ino,
                             os.stat(copied['state'] / 'retained-link').st_ino)

    def test_archive_extract_preserves_extended_default_acl(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base / 'source'; target = base / 'target'
            source.mkdir(); target.mkdir()
            user = source / 'user'; state = source / 'state'
            user.mkdir(); state.mkdir()
            undefined = 0xffffffff
            entries = [(1, 7, undefined), (2, 5, os.getuid() + 1),
                       (4, 0, undefined), (16, 5, undefined), (32, 0, undefined)]
            acl = struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *v) for v in entries)
            for name in ['system.posix_acl_access', 'system.posix_acl_default']:
                os.setxattr(user, name, acl)
            (user / 'data').write_bytes(b'ACL protected result')
            roots = {'user_data': user, 'state': state}
            before = manifests.inventory_datasets(roots)
            volume_fs.archive_and_extract(source, roots, target / 'original.tar', target / 'payload')
            copied = {'user_data': target / 'payload/user', 'state': target / 'payload/state'}
            manifests.require_matching_data(before, manifests.inventory_datasets(copied))
            for name in ['system.posix_acl_access', 'system.posix_acl_default']:
                self.assertEqual(os.getxattr(copied['user_data'], name), os.getxattr(user, name))

    def test_existing_archive_or_destination_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base / 'source'; source.mkdir()
            user = source / 'user'; state = source / 'state'; user.mkdir(); state.mkdir()
            roots = {'user_data': user, 'state': state}
            archive = base / 'keep.tar'; archive.write_bytes(b'original')
            with self.assertRaises(ValueError):
                volume_fs.archive_and_extract(source, roots, archive, base / 'new-payload')
            self.assertEqual(archive.read_bytes(), b'original')
            occupied = base / 'payload'; occupied.mkdir(); (occupied / 'keep').write_bytes(b'other')
            with self.assertRaises(ValueError):
                volume_fs.archive_and_extract(source, roots, base / 'new.tar', occupied)
            self.assertEqual((occupied / 'keep').read_bytes(), b'other')
            self.assertFalse((base / 'new.tar').exists())

    def test_archive_does_not_inherit_tar_options_or_a_path_lookalike(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); source = base/'source'; target = base/'target'
            source.mkdir(); target.mkdir()
            user = source/'user'; state = source/'state'; user.mkdir(); state.mkdir()
            (user/'chunk').write_bytes(b'complete saved result')
            binaries = base/'bin'; binaries.mkdir()
            fake = binaries/'tar'
            fake.write_text('#!/bin/sh\nexit 89\n'); fake.chmod(0o700)
            # Previously the inherited PATH selected this unrelated executable;
            # TAR_OPTIONS could also silently exclude every scientific chunk.
            with mock.patch.dict(os.environ, {'PATH':str(binaries)+':'+os.environ.get('PATH',''),
                                             'TAR_OPTIONS':'--exclude=*'}):
                report = volume_fs.archive_and_extract(source, {'user_data':user,'state':state},
                    target/'original.tar',target/'payload')
            self.assertEqual(report['state'],'copied-and-verified')
            self.assertEqual((target/'payload/user/chunk').read_bytes(),b'complete saved result')

    def test_new_device_selection_refuses_prior_or_ambiguous_devices(self):
        old = [{'path': '/dev/sda', 'type': 'disk', 'size': 100, 'fstype': 'ext4',
                'uuid': 'source', 'mountpoints': ['/'], 'children': [], 'ro': False}]
        fresh = {'path': '/dev/sdb', 'type': 'disk', 'size': 137438953472,
                 'fstype': None, 'uuid': None, 'mountpoints': [None], 'children': [], 'ro': False}
        self.assertEqual(volume_fs.select_new_empty_device(old, old + [fresh], 137438953472), fresh)
        for observed in [old, old + [fresh, dict(fresh, path='/dev/sdc')],
                         old + [dict(fresh, fstype='ntfs')], old + [dict(fresh, mountpoints=['/data'])],
                         old + [dict(fresh, children=[{'path': '/dev/sdb1'}])],
                         old + [dict(fresh, fstype='ext4'), dict(fresh, path='/dev/sdc')],
                         old + [dict(fresh, size=999), dict(fresh, path='/dev/sdc')]]:
            with self.subTest(observed=observed), self.assertRaises(ValueError):
                volume_fs.select_new_empty_device(old, observed, 137438953472)


if __name__ == '__main__':
    unittest.main()
