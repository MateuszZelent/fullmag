"""Read-only device-qualification regressions; never format or mount a disk."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts import linux_data_volume_provision as linux
from scripts import fullmag_data_volume_journal as journal
from scripts.test_fullmag_data_volume_linux_request import valid_request


class LinuxProvisionLineageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.request = valid_request()
        self.op = Path(self.temp.name)/self.request['volume_id']; self.op.mkdir()
        self.rebuild()

    def write(self, name, data):
        raw = (json.dumps(data, sort_keys=True)+'\n').encode()
        (self.op/name).write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def rebuild(self, *, baseline_uid=0, bad_terminal=False, drift=None):
        r = self.request
        plan = {'volume_id': r['volume_id'], 'storage_root': r['storage_root'],
                'mount_root': r['mount_root'], 'observation': {'datasets': r['source_roots']}}
        p = {'schema': 'fullmag.wsl-data-volume-provision.v1', 'volume_id': r['volume_id'],
             'storage_root_wsl': r['storage_root'], 'capacity_bytes': r['capacity_bytes'],
             'backing_file_windows': r'E:\fixture\new.vhdx'}
        plan['provision_request'] = dict(p)
        plan_sha = self.write('plan.json', plan)
        if drift == 'path':
            p['backing_file_windows'] = r'E:\fixture\another.vhdx'
        if drift == 'capacity':
            p['capacity_bytes'] = 256*1024**3
            r['capacity_bytes'] = p['capacity_bytes']
        r['provision_request_sha256'] = self.write('provision-request.json', p)
        image = {'path': p['backing_file_windows'], 'disk_identifier': '123e4567-e89b-12d3-a456-426614174000',
                 'capacity_bytes': r['capacity_bytes'], 'creation_utc_ticks': 1234}
        common = {'schema': 'fullmag.wsl-data-volume-platform-result.v1',
                  'volume_id': r['volume_id'], 'request_sha256': r['provision_request_sha256'],
                  'image': image}
        r['created_receipt_sha256'] = self.write('created.json', dict(common, state='created'))
        r['attached_receipt_sha256'] = self.write('attached.json', dict(common,
            state='attached-not-formatted', create_receipt_sha256=r['created_receipt_sha256']))
        baseline = {'schema': 'fullmag.linux-block-inventory.v1', 'uid': baseline_uid,
                    'boot_id': r['boot_id'], 'mount_namespace': 'host',
                    'pid1_mount_namespace': 'host', 'devices': []}
        r['baseline_sha256'] = self.write('baseline-devices.json', baseline)
        inputs = {k: r[k] for k in ('provision_request_sha256', 'created_receipt_sha256',
                                    'baseline_sha256', 'boot_id')}
        r['attach_inputs_sha256'] = self.write('attach-inputs.json', inputs)
        state = journal.new_journal(r['volume_id'], plan_sha)
        state = journal.append_started(state, 'image-created', '1'*64)
        state = journal.append_terminal(state, 'succeeded', r['created_receipt_sha256'])
        state = journal.append_started(state, 'image-attached', r['attach_inputs_sha256'])
        state = journal.append_terminal(state, 'succeeded', '2'*64 if bad_terminal else r['attached_receipt_sha256'])
        self.write('journal.json', state)

    def test_lineage_requires_its_exact_successful_attach_receipt(self):
        self.rebuild(bad_terminal=True)
        with self.assertRaisesRegex(ValueError, 'terminal receipt'):
            linux.load_lineage(self.request, self.op)

    def test_platform_path_must_match_the_pinned_plan(self):
        self.rebuild(drift='path')
        with self.assertRaisesRegex(ValueError, 'planned Windows request'):
            linux.load_lineage(self.request, self.op)

    def test_platform_capacity_must_match_the_pinned_plan(self):
        self.rebuild(drift='capacity')
        with self.assertRaisesRegex(ValueError, 'planned Windows request'):
            linux.load_lineage(self.request, self.op)

    def test_baseline_uid_cannot_be_a_boolean(self):
        self.rebuild(baseline_uid=False)
        with self.assertRaisesRegex(ValueError, 'host-root inventory'):
            linux.load_lineage(self.request, self.op)

    def test_valid_prefix_reaches_exact_ext4_phase_without_writes(self):
        before = {p.name: p.read_bytes() for p in self.op.iterdir()}
        baseline, path, state = linux.load_lineage(self.request, self.op)
        self.assertEqual(path, self.op/'journal.json')
        self.assertEqual(journal.next_phase(state), 'ext4-mounted')
        self.assertEqual(baseline['boot_id'], self.request['boot_id'])
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.op.iterdir()})

    def recovery(self, *, version=2):
        child_relative = 'recovery/'+'5'*32+'/journal.json'
        child_path = self.op/child_relative; child_path.parent.mkdir(parents=True)
        child_path.write_bytes((self.op/'journal.json').read_bytes())
        for name in ('baseline-devices.json', 'attach-inputs.json'):
            (child_path.parent/name).write_bytes((self.op/name).read_bytes())
        parent_relative = 'journal.json' if version == 1 else 'recovery/'+'4'*32+'/journal.json'
        parent_path = self.op/parent_relative; parent_path.parent.mkdir(parents=True, exist_ok=True)
        parent = json.loads(child_path.read_text())
        parent['events'][-1]['state'] = 'failed-confirmed'
        parent['events'][-1]['receipt_sha256'] = '7'*64
        parent_sha = self.write(parent_relative, parent)
        reference = {'schema': 'fullmag.data-volume-active-recovery.v'+str(version),
                     'volume_id': self.request['volume_id'], 'attempt': '5'*32,
                     'journal_relative': child_relative, 'parent_journal_sha256': parent_sha,
                     'state': 'started'}
        if version == 2:
            reference['parent_journal_relative'] = parent_relative
        self.write('active-attempt.json', reference)
        return child_path, parent_path, reference

    def test_recovery_keeps_failed_history_and_accepts_verified_successor(self):
        child, parent, reference = self.recovery(version=1)
        before = parent.read_bytes()
        _, path, _ = linux.load_lineage(self.request, self.op)
        self.assertEqual(path, child)
        self.assertEqual(parent.read_bytes(), before)

    def test_second_recovery_accepts_prior_failed_attempt_without_recreating_image(self):
        child, parent, reference = self.recovery(version=2)
        before = parent.read_bytes()
        _, path, _ = linux.load_lineage(self.request, self.op)
        self.assertEqual(path, child)
        self.assertEqual(parent.read_bytes(), before)

    def test_recovery_predecessor_cannot_escape_operation(self):
        _, _, reference = self.recovery(version=2)
        reference['parent_journal_relative'] = '../../other/journal.json'
        self.write('active-attempt.json', reference)
        with self.assertRaisesRegex(ValueError, 'predecessor path'):
            linux.load_lineage(self.request, self.op)

    def test_recovery_cannot_rebind_the_migration_request(self):
        _, parent, reference = self.recovery(version=2)
        changed = json.loads(parent.read_text()); changed['request_sha256'] = '8'*64
        reference['parent_journal_sha256'] = self.write(reference['parent_journal_relative'], changed)
        self.write('active-attempt.json', reference)
        with self.assertRaisesRegex(ValueError, 'immutable migration request'):
            linux.load_lineage(self.request, self.op)

    def reject_null_parent_sha(self, version):
        _, _, reference = self.recovery(version=version)
        reference['parent_journal_sha256'] = None
        self.write('active-attempt.json', reference)
        with self.assertRaisesRegex(ValueError, 'parent journal SHA'):
            linux.load_lineage(self.request, self.op)

    def test_legacy_recovery_never_accepts_null_parent_hash(self):
        self.reject_null_parent_sha(1)

    def test_second_recovery_never_accepts_null_parent_hash(self):
        self.reject_null_parent_sha(2)


class LinuxDevicePreflightTests(unittest.TestCase):
    def setUp(self):
        self.request = valid_request()
        self.request['controller_sha256'] = hashlib.sha256(Path(linux.__file__).read_bytes()).hexdigest()
        self.path = Path(self.request['storage_root'])/'migrations/data-volumes'/self.request['volume_id']/'linux-provision-request.json'
        self.old = {'path': '/dev/sda', 'type': 'disk', 'size': 999, 'uuid': None,
                    'children': [{'path': '/dev/sda1', 'type': 'part', 'uuid': 'prior'}]}
        self.new = {'path': '/dev/sdb', 'type': 'disk', 'size': self.request['capacity_bytes'],
                    'fstype': None, 'uuid': None, 'ro': False, 'mountpoints': [None]}
        self.current = {'boot_id': self.request['boot_id'], 'mount_namespace': 'host',
                        'devices': [self.old, self.new]}
        self.baseline = {'mount_namespace': 'host', 'devices': [self.old]}

    def preflight(self, *, capture=None, opener=None):
        with mock.patch.object(linux.os, 'geteuid', return_value=0), \
                mock.patch.object(linux, '_read', return_value=(b'fixture', self.request)), \
                mock.patch.object(linux, 'load_lineage', return_value=(self.baseline, Path('/srv/journal'), {})), \
                mock.patch.object(linux, 'probe_host', return_value=self.current), \
                mock.patch.object(linux, '_source_identities'), \
                mock.patch.object(linux.os.path, 'lexists', return_value=False), \
                mock.patch.object(linux, '_open_device', side_effect=opener or (lambda *_: os.open(os.devnull, os.O_RDONLY))), \
                mock.patch.object(linux, '_empty_device'), \
                mock.patch.object(linux, '_capture', capture or mock.Mock(side_effect=AssertionError('unexpected command'))):
            return linux.preflight(self.path, '1'*64)

    def test_uuid_conflict_in_a_partition_refuses_before_open(self):
        self.old['children'][0]['uuid'] = self.request['filesystem_uuid']
        opener = mock.Mock(side_effect=AssertionError('opened despite UUID collision'))
        with self.assertRaisesRegex(ValueError, 'UUID already exists'):
            self.preflight(opener=opener)
        opener.assert_not_called()

    def test_multiple_new_disks_refuse_before_open(self):
        self.current['devices'].append(dict(self.new, path='/dev/sdc'))
        opener = mock.Mock(side_effect=AssertionError('opened ambiguous disk'))
        with self.assertRaises(ValueError):
            self.preflight(opener=opener)
        opener.assert_not_called()

    def test_changed_boot_refuses_before_open(self):
        self.current['boot_id'] = 'different'
        with self.assertRaisesRegex(ValueError, 'boot'):
            self.preflight(opener=mock.Mock(side_effect=AssertionError('opened after reboot')))

    def test_successful_preflight_is_not_format_or_mount(self):
        result = self.preflight()
        self.assertEqual(result['state'], 'verified-read-only')
        self.assertFalse(result['formatted']); self.assertFalse(result['mounted'])
        self.assertFalse(result['mutated'])
        self.assertEqual(result['device']['path'], '/dev/sdb')

    def test_probe_keeps_partition_tree_and_explicit_columns(self):
        capture = mock.Mock(return_value=subprocess.CompletedProcess([], 0,
            json.dumps({'blockdevices': [self.old]}).encode(), b''))
        with mock.patch.object(linux.os, 'geteuid', return_value=0), \
                mock.patch.object(linux.os, 'readlink', return_value='host'), \
                mock.patch.object(Path, 'read_text', return_value=self.request['boot_id']), \
                mock.patch.object(Path, 'exists', return_value=False), \
                mock.patch.object(linux, '_capture', capture):
            result = linux.probe_host()
        self.assertIn('--tree', capture.call_args.args[0])
        self.assertIn('NAME', capture.call_args.args[0][-1].split(','))
        self.assertEqual(result['devices'][0]['children'][0]['path'], '/dev/sda1')

    def test_known_signature_is_never_considered_empty(self):
        capture = mock.Mock(return_value=subprocess.CompletedProcess([], 0,
            b'{"signatures":[{"type":"ext4"}]}', b''))
        with mock.patch.object(linux, '_capture', capture), self.assertRaisesRegex(ValueError, 'signatures'):
            linux._empty_device(17)
        self.assertEqual(capture.call_args.args[0],
                         ['wipefs', '--no-act', '--json', '/proc/self/fd/17'])

    def test_null_request_hash_is_rejected_before_reading(self):
        with mock.patch.object(linux.os, 'geteuid', return_value=0), \
                mock.patch.object(linux, '_read', return_value=(b'fixture', self.request)) as read, \
                mock.patch.object(linux, 'load_lineage', side_effect=AssertionError('unpinned request')):
            with self.assertRaisesRegex(ValueError, 'request SHA'):
                with linux.prepared_device(self.path, None):
                    pass
        read.assert_not_called()


if __name__ == '__main__':
    unittest.main()
