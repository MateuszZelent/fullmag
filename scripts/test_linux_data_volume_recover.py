"""Mounted-filesystem recovery contracts; no block device or mount mutations."""
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import linux_data_volume_recover as recovery
from scripts import fullmag_data_volume_journal as journal
from scripts import docker_data_volume_root_bootstrap as bootstrap
from scripts.test_fullmag_data_volume_linux_request import valid_request
from scripts import test_linux_data_volume_provision as lineage_fixtures


def pins():
    return {name: hashlib.sha256((Path(recovery.__file__).parent/name).read_bytes()).hexdigest()
            for name in recovery.COMPONENTS}


class RecoveryLineageTests(unittest.TestCase):
    def setUp(self):
        self.fixture = lineage_fixtures.LinuxProvisionLineageTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.linux = self.fixture.request
        self.op = Path(self.linux['storage_root'])/'migrations/data-volumes'/self.linux['volume_id']
        self.token = '6'*32
        self.old_relative = 'recovery/'+'5'*32+'/journal.json'
        self.attempt = self.fixture.op/'recovery'/self.token
        self.attempt.mkdir(parents=True)
        old = self.fixture.op/self.old_relative
        old.parent.mkdir(parents=True)
        prefix = json.loads((self.fixture.op/'journal.json').read_bytes())
        self.write('recovery/'+self.token+'/journal.json', prefix)
        for name in ('baseline-devices.json', 'attach-inputs.json'):
            (self.attempt/name).write_bytes((self.fixture.op/name).read_bytes())
        self.inputs = {'linux_request_sha256': self.write('linux-provision-request.json', self.linux),
                       'formatter_sha256': 'a'*64}
        input_sha = self.write('linux-format-inputs.json', self.inputs)
        failure = dict(self.inputs, schema='fullmag.data-volume-linux-provision-failure.v1',
            state='failed-confirmed', volume_id=self.linux['volume_id'], error_type='ValueError',
            image_and_partial_filesystem_retained=True)
        failure_sha = self.write('linux-provision-failed.json', failure)
        failed = journal.append_started(prefix, 'ext4-mounted', input_sha)
        failed = journal.append_terminal(failed, 'failed-confirmed', failure_sha)
        failed_sha = self.write(self.old_relative, failed)
        started_sha = self.write('linux-format-started.json', dict(self.inputs, device={'path': '/dev/sdb'}))
        selector = {'schema': 'fullmag.data-volume-active-recovery.v2', 'volume_id': self.linux['volume_id'],
            'attempt': self.token, 'journal_relative': 'recovery/'+self.token+'/journal.json',
            'parent_journal_relative': self.old_relative, 'parent_journal_sha256': failed_sha, 'state': 'started'}
        selector_sha = self.write('active-attempt.json', selector)
        self.request = {'schema': recovery.SCHEMA, 'volume_id': self.linux['volume_id'],
            'storage_root': self.linux['storage_root'], 'token': self.token,
            'failed_journal_relative': self.old_relative, 'failed_journal_sha256': failed_sha,
            'linux_request_sha256': self.inputs['linux_request_sha256'], 'format_inputs_sha256': input_sha,
            'format_started_sha256': started_sha, 'format_failure_sha256': failure_sha,
            'selector_sha256': selector_sha, 'recovery_journal_sha256': self.sha(self.attempt/'journal.json'),
            'components': pins()}
        self.linux['controller_sha256'] = self.request['components']['linux_data_volume_provision.py']
        self.inputs['linux_request_sha256'] = self.write('linux-provision-request.json', self.linux)
        self.request['linux_request_sha256'] = self.inputs['linux_request_sha256']
        # Rebuild the authenticated failed branch with the actual Linux digest.
        self.request['format_inputs_sha256'] = self.write('linux-format-inputs.json', self.inputs)
        self.request['format_started_sha256'] = self.write('linux-format-started.json', dict(self.inputs, device={'path': '/dev/sdb'}))
        failure.update(self.inputs)
        self.request['format_failure_sha256'] = self.write('linux-provision-failed.json', failure)
        failed = journal.append_started(prefix, 'ext4-mounted', self.request['format_inputs_sha256'])
        failed = journal.append_terminal(failed, 'failed-confirmed', self.request['format_failure_sha256'])
        self.request['failed_journal_sha256'] = self.write(self.old_relative, failed)
        selector['parent_journal_sha256'] = self.request['failed_journal_sha256']
        self.request['selector_sha256'] = self.write('active-attempt.json', selector)
        self.path = self.op/'recovery'/self.token/'mounted-recovery-request.json'
        self.publish_request()

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def write(self, relative, value):
        return self.fixture.write(relative, value)

    def publish_request(self):
        self.request_sha = self.write('recovery/'+self.token+'/mounted-recovery-request.json', self.request)

    def load(self):
        original_read = recovery.qualification._read
        original_lineage = recovery.qualification.load_lineage

        def read(path, expected=None):
            path = Path(path)
            if path.is_relative_to(self.op):
                path = self.fixture.op/path.relative_to(self.op)
            return original_read(path, expected)

        def lineage(linux, op):
            self.assertEqual(op, self.op)
            baseline, path, state = original_lineage(linux, self.fixture.op)
            return baseline, self.op/path.relative_to(self.fixture.op), state

        with mock.patch.object(recovery.qualification, '_read', side_effect=read), \
                mock.patch.object(recovery.qualification, 'load_lineage', side_effect=lineage):
            return recovery.load_context(self.path, self.request_sha)

    def test_valid_recovery_authenticates_both_branches_without_changing_them(self):
        before = {str(p): p.read_bytes() for p in self.fixture.op.rglob('*') if p.is_file()}
        context = self.load()
        self.assertEqual(context['original_formatter_sha256'], 'a'*64)
        self.assertEqual(journal.next_phase(context['journal']), 'ext4-mounted')
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.fixture.op.rglob('*') if p.is_file()})

    def test_unknown_request_key_path_escape_and_missing_component_refuse(self):
        for change in ({'unexpected': True}, {'failed_journal_relative': '../journal.json'},
                       {'components': {}}):
            value = dict(self.request, **change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                recovery.validate_request(value)

    def test_source_hash_drift_refuses_before_original_lineage(self):
        self.request['components']['fullmag_data_volume_guard.py'] = '0'*64
        self.publish_request()
        with self.assertRaisesRegex(ValueError, 'component source changed'):
            self.load()

    def test_unknown_previous_outcome_is_not_recoverable(self):
        old = json.loads((self.fixture.op/self.old_relative).read_text())
        old['events'][-1]['state'] = 'outcome-unknown-resources-retained'
        self.request['failed_journal_sha256'] = self.write(self.old_relative, old)
        selector = json.loads((self.fixture.op/'active-attempt.json').read_text())
        selector['parent_journal_sha256'] = self.request['failed_journal_sha256']
        self.request['selector_sha256'] = self.write('active-attempt.json', selector)
        self.publish_request()
        with self.assertRaisesRegex(ValueError, 'Failed journal'):
            self.load()

    def test_changed_original_artifact_refuses(self):
        self.write('linux-format-started.json', dict(self.inputs, device={'path': '/dev/sda'}))
        with self.assertRaisesRegex(ValueError, 'SHA changed'):
            self.load()

    def test_other_predecessor_or_journal_prefix_refuses(self):
        prefix_path = self.attempt/'journal.json'
        prefix = json.loads(prefix_path.read_text())
        prefix['events'][0]['inputs_sha256'] = prefix['events'][1]['inputs_sha256'] = 'c'*64
        self.request['recovery_journal_sha256'] = self.write('recovery/'+self.token+'/journal.json', prefix)
        self.publish_request()
        with self.assertRaisesRegex(ValueError, 'successful Create/Attach prefix'):
            self.load()


class RecoveryDeviceTests(unittest.TestCase):
    def setUp(self):
        self.linux = valid_request()
        self.selected = {'path': '/dev/sdb', 'type': 'disk', 'size': self.linux['capacity_bytes'],
                         'maj:min': '8:16', 'serial': 'new-scsi-identity', 'ro': False}
        self.observed = dict(self.selected, fstype='ext4', uuid=self.linux['filesystem_uuid'])
        self.current = {'boot_id': self.linux['boot_id'], 'mount_namespace': 'persistent',
                        'devices': [self.observed]}
        self.context = {'linux': self.linux, 'device': self.selected,
                        'baseline': {'mount_namespace': 'persistent', 'devices': []}}

    def prepare(self):
        descriptor = os.open(os.devnull, os.O_RDONLY)
        self.addCleanup(lambda: os.close(descriptor) if self.is_open(descriptor) else None)
        observed = subprocess.CompletedProcess([], 0, ('TYPE=ext4\nUUID='+self.linux['filesystem_uuid']+'\n').encode())
        with mock.patch.object(recovery.qualification, 'probe_host', return_value=self.current), \
                mock.patch.object(recovery.qualification, '_source_identities') as identities, \
                mock.patch.object(recovery.qualification, '_open_device', return_value=descriptor) as opening, \
                mock.patch.object(recovery.qualification, '_capture', return_value=observed), \
                mock.patch.object(recovery, '_empty_mounted_root') as empty, \
                mock.patch.object(recovery.formatting, '_run') as mutate:
            with recovery.prepared_recovery(self.context) as ready:
                self.assertEqual(ready['request'], self.linux)
                identities.assert_called_once_with(self.linux)
                self.assertEqual(empty.call_args.args[0],
                    {key: ready[key] for key in ('request', 'device', 'descriptor')})
                mutate.assert_not_called()
            return opening

    @staticmethod
    def is_open(fd):
        try:
            os.fstat(fd)
            return True
        except OSError:
            return False

    def test_exact_existing_device_is_only_read(self):
        opening = self.prepare()
        opening.assert_called_once_with(self.selected, self.linux)

    def test_device_boot_namespace_uuid_serial_size_and_duplicate_uuid_drift_refuse(self):
        for change in ({'serial': 'foreign'}, {'size': 1}, {'uuid': 'foreign'}, {'ro': True},
                       {'maj:min': '8:0'}, {'children': [{'path': '/dev/sdb1'}]}):
            old = dict(self.observed)
            self.observed.update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.prepare()
            self.observed.clear(); self.observed.update(old)
        for key in ('boot_id', 'mount_namespace'):
            old = self.current[key]; self.current[key] = 'foreign'
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'Host boot'):
                self.prepare()
            self.current[key] = old
        self.current['devices'].append(dict(self.observed, path='/dev/sdc'))
        with self.assertRaises(ValueError):
            self.prepare()

    def test_device_already_present_before_attach_refuses(self):
        self.context['baseline']['devices'] = [dict(self.selected)]
        with self.assertRaisesRegex(ValueError, 'Attach baseline'):
            self.prepare()


class RecoveryMountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name)/'new-ext4'; self.target.mkdir()
        (self.target/'lost+found').mkdir(mode=0o700)
        self.linux = valid_request(); self.linux['mount_root'] = str(self.target)
        self.block = os.open(os.devnull, os.O_RDONLY); self.addCleanup(os.close, self.block)
        self.ready = {'request': self.linux, 'device': {'maj:min': '8:16'}, 'descriptor': self.block}
        self.row = {'target': str(self.target), 'fsroot': '/', 'fstype': 'ext4', 'uuid': None,
                    'maj:min': '8:16', 'options': 'rw,nosuid,nodev,relatime', 'propagation': 'private'}
        self.kernel_uuid = self.linux['filesystem_uuid']

    @contextmanager
    def qualify(self):
        fstat = os.fstat
        root_inode = self.target.stat().st_ino

        def descriptor_stat(fd):
            metadata = fstat(fd)
            return SimpleNamespace(st_dev=metadata.st_dev, st_ino=2 if metadata.st_ino == root_inode else metadata.st_ino,
                st_uid=0, st_mode=metadata.st_mode, st_rdev=self.target.stat().st_dev)

        result = subprocess.CompletedProcess([], 0, json.dumps({'filesystems': [self.row]}).encode())
        with mock.patch.object(recovery.qualification, '_capture', return_value=result), \
                mock.patch.object(recovery.os, 'fstat', side_effect=descriptor_stat), \
                mock.patch.object(recovery, 'filesystem_uuid_from_fd', return_value=self.kernel_uuid):
            with recovery._empty_mounted_root(self.ready) as fd:
                yield fd

    def test_directory_fd_remains_open_until_recovery_leaves_scope(self):
        with self.qualify() as fd:
            self.assertEqual(os.fstat(fd).st_ino, 2)
            recovery._check_pinned_root(dict(self.ready, root_descriptor=fd))
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_existing_data_marker_or_populated_lost_found_refuses(self):
        for relative in ('prior.zarr', '.fullmag-user-data-volume.json', 'lost+found/orphan'):
            extra = self.target/relative; extra.touch()
            try:
                with self.subTest(relative=relative), self.assertRaises(ValueError):
                    with self.qualify():
                        self.fail('existing data accepted')
            finally:
                extra.unlink()

    def test_mount_or_kernel_uuid_drift_refuses(self):
        for key, value in (('uuid', 'foreign'), ('options', 'ro,nodev,nosuid'), ('propagation', 'shared'),
                           ('fsroot', '/nested'), ('maj:min', '8:0')):
            old = self.row[key]; self.row[key] = value
            try:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    with self.qualify():
                        self.fail('changed mount accepted')
            finally:
                self.row[key] = old
        self.kernel_uuid = 'different-kernel-uuid'
        with self.assertRaisesRegex(ValueError, 'exact new filesystem'):
            with self.qualify():
                self.fail('wrong kernel UUID accepted')


class RecoveryOrchestrationTests(unittest.TestCase):
    def test_success_never_calls_format_mount_or_blank_device_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            op = Path(directory); attempt = op/'attempt'; attempt.mkdir()
            linux = valid_request()
            state = journal.new_journal(linux['volume_id'], '1'*64)
            for phase in ('image-created', 'image-attached'):
                state = journal.append_terminal(journal.append_started(state, phase, '2'*64), 'succeeded', '3'*64)
            path = attempt/'journal.json'; path.write_text(json.dumps(state))
            req = {'schema': recovery.SCHEMA, 'volume_id': linux['volume_id'], 'storage_root': linux['storage_root'],
                   'token': '5'*32, 'failed_journal_relative': 'recovery/'+'4'*32+'/journal.json',
                   **{key: '4'*64 for key in recovery.DIGEST_KEYS}, 'components': pins()}
            context = {'request': req, 'linux': linux, 'operation_root': op, 'attempt_root': attempt,
                       'journal': state, 'journal_path': path, 'device': {'path': '/dev/sdb'},
                       'original_formatter_sha256': 'a'*64}

            @contextmanager
            def prepared(_context):
                yield {'request': linux, 'descriptor': 10}

            document = recovery.formatting._document

            def write_document(parent, name, value):
                if parent == Path(req['storage_root'])/'migrations/data-volumes'/req['volume_id']:
                    parent = op
                return document(parent, name, value)

            with mock.patch.object(recovery.os, 'geteuid', return_value=0), \
                    mock.patch.object(recovery.qualification, '_read', return_value=(b'fixture', req)), \
                    mock.patch.object(recovery, 'load_context', return_value=context), \
                    mock.patch.object(recovery, 'prepared_recovery', side_effect=prepared), \
                    mock.patch.object(recovery.formatting, '_operation_lock', side_effect=lambda _: prepared(None)), \
                    mock.patch.object(recovery.formatting, '_publish_journal') as publish, \
                    mock.patch.object(recovery, '_check_pinned_root'), \
                    mock.patch.object(recovery.formatting, '_document', side_effect=write_document), \
                    mock.patch.object(recovery.formatting, '_qualify_mounted_volume', return_value={'actual': True}), \
                    mock.patch.object(recovery.formatting, '_run') as mutate, \
                    mock.patch.object(recovery.formatting, '_mount_verified') as mount, \
                    mock.patch.object(recovery.qualification, 'prepared_device') as blank, \
                    mock.patch('builtins.print'):
                result = recovery.recover_mounted('/fixture/request', '5'*64)
            mutate.assert_not_called(); mount.assert_not_called(); blank.assert_not_called()
            self.assertEqual(result['completion_mode'], 'recovered-existing-filesystem')
            self.assertEqual(result['original_formatter_sha256'], 'a'*64)
            self.assertFalse(result['namespace_admitted'])
            self.assertEqual(publish.call_args.args[2]['events'][-1]['state'], 'succeeded')
            self.assertEqual(json.loads((op/'linux-provision-result.json').read_text()), result)

    def test_bootstrap_graph_is_closed_and_stage_has_no_caller_command(self):
        self.assertEqual(set(bootstrap.RECOVERY_COMPONENTS), set(recovery.COMPONENTS))
        program = bootstrap.bootstrap('recover-mounted')
        self.assertIn('recover_mounted(request_path, request_sha256)', program)
        self.assertEqual(set(bootstrap._STAGES['recover-mounted']['keys']), recovery.REQUEST_KEYS)
        compile(program, '<recovery-root-bootstrap>', 'exec')


if __name__ == '__main__':
    unittest.main()
