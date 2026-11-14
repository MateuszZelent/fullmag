"""Copied-inode admission preparation preserves the narrow reboot contract."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import linux_native_host as host
from scripts import test_linux_native_readmission as fixtures
import linux_native_data_volume_migration as migration


class DataVolumeStateMigrationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LinuxNativeReadmissionTests(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.state = self.fixture.state
        self.original = dict(self.fixture.certificate, host_inode=self.fixture.inode + 100)
        self.fixture._write_json(self.fixture.certificate_path, self.original, indent=2)
        self.fixture._write_json(self.fixture.owner_path, self.original, indent=None)
        probe = json.loads(self.fixture.probe_path.read_bytes())
        probe['root_inode'] = self.original['host_inode']
        probe['host_attestation_sha256'] = hashlib.sha256(self.fixture.certificate_path.read_bytes()).hexdigest()
        self.fixture._write_json(self.fixture.probe_path, probe, indent=2)
        self.volume = self.state.parent / 'volume'
        self.volume.mkdir()
        self.pins = {
            'state_root': str(self.state), 'mount_root': str(self.volume),
            'volume_id': '1' * 32, 'filesystem_uuid': self.fixture.filesystem_uuid,
            'engine_id': self.fixture.engine, 'owner_token': self.fixture.owner_token,
            'image_id': self.fixture.image_id,
            'source_binding_sha256': host.readmission_source_binding_sha256(self.original),
            'source_device': self.fixture.old_device,
            'source_inode': self.original['host_inode'],
            'observed_device': self.fixture.new_device, 'observed_inode': self.fixture.inode,
            'source_data_sha256': '2' * 64, 'copied_data_sha256': '2' * 64,
            'drained_witness_sha256': '3' * 64,
            'files': {name: hashlib.sha256((self.state / name).read_bytes()).hexdigest()
                      for name in host.READMISSION_FILES},
        }

    def patches(self):
        return patch.multiple(migration, local_volume=lambda path: self.fixture.volume,
                              filesystem_uuid=lambda path: self.fixture.filesystem_uuid)

    def prepare(self, pins=None):
        with self.patches():
            return migration.prepare_state_migration(self.state, pins or self.pins)

    def archive(self, prepared):
        path = self.volume / 'migration' / self.pins['volume_id'] / 'state-admission.json'
        path.parent.mkdir(parents=True)
        raw = (json.dumps(prepared, sort_keys=True, separators=(',', ':')) + '\n').encode()
        path.write_bytes(raw)
        return path, hashlib.sha256(raw).hexdigest()

    def test_prepare_changes_only_device_inode_and_readiness_without_admission(self):
        before = {n: (self.state / n).read_bytes() for n in host.READMISSION_FILES}
        prepared = self.prepare()
        expected = dict(self.original, host_device=self.fixture.new_device,
                        host_inode=self.fixture.inode, restart_verified=False)
        self.assertEqual(prepared['candidate'], expected)
        self.assertFalse(prepared['namespace_admitted'])
        self.assertEqual({n: (self.state / n).read_bytes() for n in before}, before)
        json.dumps(prepared, allow_nan=False)

    def test_copy_or_drain_identity_drift_rejected_without_writes(self):
        for key, value in [('copied_data_sha256', '4' * 64),
                           ('drained_witness_sha256', ''), ('owner_token', '5' * 32),
                           ('source_inode', self.original['host_inode'] + 1),
                           ('observed_inode', self.fixture.inode + 1),
                           ('filesystem_uuid', '01234567-89ab-4def-8123-456789abcdee')]:
            pins = copy.deepcopy(self.pins); pins[key] = value
            before = self.fixture.certificate_path.read_bytes()
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.prepare(pins)
            self.assertEqual(self.fixture.certificate_path.read_bytes(), before)

    def test_apply_requires_exact_archived_preparation_on_new_volume(self):
        prepared = self.prepare()
        path, digest = self.archive(prepared)
        with self.patches():
            result = migration.apply_state_migration(self.state, prepared, path, digest)
        self.assertEqual(result['state'], 'prepared-not-admitted')
        self.assertFalse(result['namespace_admitted'])
        self.assertEqual(json.loads(self.fixture.certificate_path.read_bytes()), prepared['candidate'])
        self.assertEqual(json.loads(self.fixture.owner_path.read_bytes()), prepared['candidate'])
        for name in host.READMISSION_FILES[2:]:
            raw = base64.b64decode(prepared['original_files'][name]['base64'], validate=True)
            self.assertEqual((self.state / name).read_bytes(), raw)

    def test_apply_rejects_foreign_archive_and_torn_certificate(self):
        prepared = self.prepare(); path, digest = self.archive(prepared)
        before = self.fixture.certificate_path.read_bytes()
        with self.patches(), self.assertRaises(ValueError):
            migration.apply_state_migration(self.state, prepared, path, '0' * 64)
        self.assertEqual(self.fixture.certificate_path.read_bytes(), before)
        self.fixture.owner_path.write_bytes(b'{"foreign":true}')
        with self.patches(), self.assertRaises(ValueError):
            migration.apply_state_migration(self.state, prepared, path, digest)
        self.assertEqual(self.fixture.certificate_path.read_bytes(), before)

    def test_resume_marker_published_is_idempotent_without_new_owner(self):
        prepared = self.prepare(); path, digest = self.archive(prepared)
        self.fixture.owner_path.write_bytes(base64.b64decode(prepared['candidate_raw_base64']))
        with self.patches():
            result = migration.apply_state_migration(self.state, prepared, path, digest)
            again = migration.apply_state_migration(self.state, prepared, path, digest)
        self.assertEqual(result['previous_phase'], 'marker-published')
        self.assertEqual(again['previous_phase'], 'prepared')
        self.assertEqual(prepared['candidate']['owner_token'], self.original['owner_token'])


if __name__ == '__main__':
    unittest.main()
