"""Formatting orchestration on fake devices; no filesystem is created here."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import linux_data_volume_format as formatting
from scripts import fullmag_data_volume_journal as journal
from scripts.test_fullmag_data_volume_linux_request import valid_request


class LinuxFormatOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.op = Path(self.temp.name)
        self.request = valid_request()
        self.formatter_sha = hashlib.sha256(Path(formatting.__file__).read_bytes()).hexdigest()
        self.state = journal.new_journal(self.request['volume_id'], '1'*64)
        for phase in ('image-created', 'image-attached'):
            self.state = journal.append_started(self.state, phase, '2'*64)
            self.state = journal.append_terminal(self.state, 'succeeded', '3'*64)
        self.journal_path = self.op/'journal.json'
        self.journal_path.write_text(json.dumps(self.state))

    @contextmanager
    def ready(self, *_):
        descriptor = os.open(os.devnull, os.O_RDONLY)
        try:
            self.device = {'path': '/dev/sdb', 'maj:min': '8:16'}
            yield {'request': self.request, 'operation_root': self.op,
                   'journal': self.state, 'journal_path': self.journal_path,
                   'device': self.device, 'descriptor': descriptor}
        finally:
            os.close(descriptor)

    @contextmanager
    def parent(self, *_):
        descriptor = os.open(self.op, os.O_RDONLY | os.O_DIRECTORY)
        try:
            yield descriptor
        finally:
            os.close(descriptor)

    def execute(self, *, run=None, mount=None, ready=None, parent=None):
        probe = subprocess.CompletedProcess([], 0,
            ('TYPE=ext4\nUUID='+self.request['filesystem_uuid']+'\n').encode(), b'')
        with mock.patch.object(formatting, '_entry_request', return_value=(self.request, self.op)), \
                mock.patch.object(formatting.qualification, 'prepared_device', side_effect=ready or self.ready), \
                mock.patch.object(formatting, '_run', run or mock.Mock()), \
                mock.patch.object(formatting, '_mount_verified', mount or mock.Mock(return_value={'fixture': True})), \
                mock.patch.object(formatting, '_mount_parent', side_effect=parent or self.parent, create=True), \
                mock.patch.object(formatting.qualification, '_capture', return_value=probe):
            return formatting.format_mount('/srv/fixture/request.json', '4'*64, self.formatter_sha)

    def test_formatter_never_forces_or_changes_reserved_block_policy(self):
        run = mock.Mock()
        result = self.execute(run=run)
        argv = run.call_args.args[2]
        self.assertEqual(argv[0], '/usr/sbin/mkfs.ext4')
        self.assertIn(self.request['filesystem_uuid'], argv)
        self.assertTrue(argv[-1].startswith('/proc/self/fd/'))
        self.assertNotIn('-F', argv); self.assertNotIn('-m', argv)
        self.assertNotIn('/dev/sda', argv)
        self.assertEqual(result['state'], 'mounted-not-data-migrated')
        self.assertFalse(result['namespace_admitted'])
        current = json.loads(self.journal_path.read_text())
        self.assertEqual(journal.next_phase(current), 'group-drained')

    def test_failed_preflight_never_starts_formatting(self):
        run = mock.Mock()
        with self.assertRaisesRegex(ValueError, 'unqualified'):
            self.execute(run=run, ready=mock.Mock(side_effect=ValueError('unqualified')))
        run.assert_not_called()
        self.assertEqual(json.loads(self.journal_path.read_text()), self.state)
        self.assertFalse((self.op/'linux-format-started.json').exists())

    def test_invalid_mount_parent_refuses_before_format(self):
        run = mock.Mock()
        with self.assertRaisesRegex(ValueError, 'unsafe parent'):
            self.execute(run=run, parent=mock.Mock(side_effect=ValueError('unsafe parent')))
        run.assert_not_called()
        self.assertEqual(json.loads(self.journal_path.read_text()), self.state)
        self.assertFalse((self.op/'linux-format-started.json').exists())

    def test_mount_failure_preserves_started_artifacts_and_blocks_reformat(self):
        run = mock.Mock()
        with self.assertRaisesRegex(ValueError, 'mount failed'):
            self.execute(run=run, mount=mock.Mock(side_effect=ValueError('mount failed')))
        current = json.loads(self.journal_path.read_text())
        self.assertEqual(current['events'][-1]['state'], 'failed-confirmed')
        self.assertTrue((self.op/'linux-format-started.json').exists())
        self.assertTrue((self.op/'linux-provision-failed.json').exists())
        with self.assertRaisesRegex(ValueError, 'never replay'):
            self.execute(run=run)
        self.assertEqual(run.call_count, 1)

    def test_interruption_retains_unknown_phase(self):
        with self.assertRaises(KeyboardInterrupt):
            self.execute(run=mock.Mock(side_effect=KeyboardInterrupt()))
        current = json.loads(self.journal_path.read_text())
        self.assertEqual(current['events'][-1]['state'], 'outcome-unknown-resources-retained')
        with self.assertRaises(ValueError):
            journal.next_phase(current)

    def test_wrong_formatter_source_stops_before_any_scope_or_device_access(self):
        with mock.patch.object(formatting, '_entry_request') as entry:
            with self.assertRaisesRegex(ValueError, 'Formatter source'):
                formatting.format_mount('/srv/fixture/request.json', '4'*64, '0'*64)
        entry.assert_not_called()

    def test_non_root_is_refused_before_request_access(self):
        with mock.patch.object(formatting.os, 'geteuid', return_value=1000), \
                mock.patch.object(formatting.qualification, '_read') as read:
            with self.assertRaisesRegex(ValueError, 'Host root'):
                formatting.format_mount('/srv/fixture/request.json', '4'*64, self.formatter_sha)
        read.assert_not_called()

    def test_null_request_hash_never_reads_an_unpinned_request(self):
        with mock.patch.object(formatting.os, 'geteuid', return_value=0), \
                mock.patch.object(formatting.qualification, '_read',
                                  return_value=(b'fixture', self.request)) as read:
            with self.assertRaisesRegex(ValueError, 'request SHA'):
                formatting._entry_request('/srv/fixture/request.json', None)
        read.assert_not_called()

    def test_only_fixed_mutating_tools_are_accepted(self):
        with self.assertRaisesRegex(ValueError, 'fixed new-volume'):
            formatting._run(self.op, 'fixture', ['/bin/rm', 'never'], ())
        self.assertEqual(list(self.op.iterdir()), [self.journal_path])

    def test_force_device_paths_and_bind_mounts_are_rejected_before_execution(self):
        for label, argv in [('mkfs', ['/usr/sbin/mkfs.ext4', '-F', '/dev/sda']),
                            ('mount', ['/usr/bin/mount', '--bind', '/srv/other', '/mnt/other'])]:
            with self.subTest(argv=argv), mock.patch.object(formatting.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    formatting._run(self.op, label, argv, ())
                run.assert_not_called()

    def test_generated_command_shapes_use_only_the_pinned_descriptors(self):
        first = os.open(os.devnull, os.O_RDONLY)
        second = os.open(self.op, os.O_RDONLY | os.O_DIRECTORY)
        try:
            ready = {'request': self.request, 'descriptor': first}
            argv = formatting._format_args(ready)
            with mock.patch.object(formatting.subprocess, 'run',
                                   return_value=subprocess.CompletedProcess([], 0)) as run, \
                    mock.patch('builtins.print'):
                formatting._run(self.op, 'mkfs', argv, (first,))
                self.assertEqual(run.call_args.kwargs['pass_fds'], (first,))
                self.assertEqual(run.call_args.kwargs['env'], formatting.ENV)
                argv = ['/usr/bin/mount', '--no-canonicalize', '--internal-only', '--types',
                        'ext4', '--options', 'nodev,nosuid',
                        '/proc/self/fd/'+str(first), '/proc/self/fd/'+str(second)]
                formatting._run(self.op, 'mount', argv, (first, second))
                self.assertEqual(run.call_args.kwargs['pass_fds'], (first, second))
                self.assertNotIn('LD_PRELOAD', run.call_args.kwargs['env'])
        finally:
            os.close(first); os.close(second)

    def test_unprotected_parent_is_rejected_without_creating_mountpoint(self):
        ready = {'request': {'mount_root': str(self.op/'new-mount')}}
        actual = self.op.stat()
        for uid, mode in [(12345, 0o40700), (0, 0o40777)]:
            metadata = SimpleNamespace(st_uid=uid, st_mode=mode, st_dev=actual.st_dev,
                                       st_ino=actual.st_ino)
            with self.subTest(uid=uid, mode=mode), \
                    mock.patch.object(formatting.os, 'fstat', return_value=metadata):
                with self.assertRaisesRegex(ValueError, 'root-owned and protected'):
                    with formatting._mount_parent(ready):
                        pass
        self.assertFalse((self.op/'new-mount').exists())


class MountedVolumeQualificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name)/'mount'
        self.target.mkdir()
        self.request = valid_request()
        self.request['mount_root'] = str(self.target)
        self.descriptor = os.open(os.devnull, os.O_RDONLY)
        self.addCleanup(os.close, self.descriptor)
        self.ready = {'request': self.request, 'descriptor': self.descriptor,
                      'device': {'maj:min': '8:16'}}
        self.row = {'target': str(self.target), 'fstype': 'ext4', 'uuid': None,
                    'maj:min': '8:16', 'options': 'rw,nodev,nosuid,relatime'}

    def qualify(self, *, resolved=None, error=None):
        observed = subprocess.CompletedProcess([], 0, json.dumps({'filesystems': [self.row]}).encode())
        real_fstat = os.fstat

        def stat_descriptor(fd):
            if fd == self.descriptor:
                return SimpleNamespace(st_rdev=self.target.stat().st_dev)
            return real_fstat(fd)

        with mock.patch.object(formatting.qualification, '_capture', return_value=observed), \
                mock.patch.object(formatting.os, 'fstat', side_effect=stat_descriptor), \
                mock.patch.object(formatting, 'resolve_mount_uuid',
                                  return_value=resolved or self.request['filesystem_uuid'],
                                  side_effect=error) as resolver, \
                mock.patch.object(formatting, '_run') as mutation:
            result = formatting._qualify_mounted_volume(self.ready)
            mutation.assert_not_called()
            return result, resolver

    def test_explicit_null_uses_kernel_uuid_and_never_mounts_or_formats(self):
        result, reader = self.qualify()
        reader.assert_called_once_with(self.target, None, major_minor='8:16')
        self.assertEqual(result['mount']['uuid'], self.request['filesystem_uuid'])
        self.assertEqual(result['device'], self.target.stat().st_dev)
        self.assertTrue((self.target/'.fullmag-user-data-volume.json').is_file())

    def test_kernel_uuid_mismatch_fails_before_marker_creation(self):
        with self.assertRaisesRegex(ValueError, 'UUID'):
            self.qualify(resolved='12345678-1234-1234-1234-123456789abc')
        self.assertFalse((self.target/'.fullmag-user-data-volume.json').exists())

    def test_unsupported_kernel_uuid_fails_before_marker_creation(self):
        with self.assertRaisesRegex(ValueError, 'unsupported'):
            self.qualify(error=ValueError('unsupported filesystem UUID ioctl'))
        self.assertFalse((self.target/'.fullmag-user-data-volume.json').exists())

    def test_missing_uuid_is_not_treated_as_explicit_null(self):
        del self.row['uuid']
        with mock.patch.object(formatting, 'resolve_mount_uuid') as reader:
            with self.assertRaises(ValueError):
                self.qualify()
            reader.assert_not_called()
        self.assertFalse((self.target/'.fullmag-user-data-volume.json').exists())

    def test_recovery_pinned_root_rejects_same_device_other_inode_before_writing(self):
        pinned_path = self.target.parent/'pinned-root'; pinned_path.mkdir()
        pinned = os.open(pinned_path, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, pinned)
        self.ready['root_descriptor'] = pinned
        with mock.patch.object(formatting, '_exclusive') as marker, \
                mock.patch.object(formatting.os, 'fchmod') as chmod:
            with self.assertRaisesRegex(ValueError, 'root path changed'):
                self.qualify()
        marker.assert_not_called(); chmod.assert_not_called()
        self.assertEqual(os.fstat(pinned).st_ino, pinned_path.stat().st_ino)

    def test_recovery_writes_through_pinned_fd_and_refuses_path_swap_after_marker(self):
        pinned = os.open(self.target, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, pinned)
        self.ready['root_descriptor'] = pinned
        saved = self.target.parent/'saved-original'
        replacement = self.target.parent/'replacement'; replacement.mkdir()
        exclusive = formatting._exclusive

        def marker(fd, name, raw):
            self.target.rename(saved)
            replacement.rename(self.target)
            exclusive(fd, name, raw)

        with mock.patch.object(formatting, '_exclusive', side_effect=marker):
            with self.assertRaisesRegex(ValueError, 'root path changed'):
                self.qualify()
        self.assertTrue((saved/'.fullmag-user-data-volume.json').is_file())
        self.assertFalse((self.target/'.fullmag-user-data-volume.json').exists())


if __name__ == '__main__':
    unittest.main()
