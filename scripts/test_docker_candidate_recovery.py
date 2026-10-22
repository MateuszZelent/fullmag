"""Recovery admission and isolation regressions; Docker calls are mocked."""
import copy
import hashlib
import importlib.util
import json
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import docker_candidate_recovery as recovery
from docker_build_control import BuildControl, BuildControlError
from docker_compose_identity import source_labels


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.identity = dict(project_name='fullmag-worktree-test', worktree_id='test',
                             project_id='project', checkout_kind='worktree')
        self.control = BuildControl.__new__(BuildControl)
        self.control.identity = self.identity
        self.control.project = self.identity['project_name']
        self.control.volume = 'control-test'
        self.control.namespace = ''
        self.control.image = 'sha256:' + 'b' * 64
        self.control.labels = {}
        self.selected = Path('/source')
        self.names = dict(build='build-test', package='package-test', control='control-test')
        self.document = dict(Id='a' * 64, Image=self.control.image,
            State=dict(Running=False, Restarting=False, Status='exited'),
            Config={'Labels': {**source_labels(self.identity),
                'com.docker.compose.project': self.control.project, 'com.docker.compose.service': 'backend',
                recovery.cache.LABEL_CACHE_KEY: 'key', recovery.cache.LABEL_WORKTREE: 'test'}},
            HostConfig={}, Mounts=[dict(Type='bind', Destination='/opt/fullmag/source', Source='/source', RW=False)] +
                [dict(Type='volume', Destination=target, Name=self.names[role], RW=True)
                 for role, target in [('build', '/build'), ('package', '/opt/fullmag/package'), ('control', '/opt/fullmag/control')]])

    def validate(self, document):
        with patch.object(recovery.cache, 'cache_key', return_value={'key': 'key'}), \
             patch.object(recovery.cache, '_validate_volume_documents') as volume_check, \
             patch.object(recovery, 'inspect_one', return_value={}):
            result = recovery.validate_backend(document, self.control, self.selected, 'a' * 64, self.control.image)
            volume_check.assert_called_once()
            return result

    def test_request_digest_matches_backend_canonical_bytes(self):
        path = Path(__file__).resolve().parents[1] / 'docker/all-in-one/backend_dev.py'
        spec = importlib.util.spec_from_file_location('candidate_digest_backend', path)
        backend = importlib.util.module_from_spec(spec)
        with patch.object(sys, 'path', [str(path.parent), *sys.path]):
            spec.loader.exec_module(backend)
        document = {'z': 'unicode-ą', 'a': 1}
        self.assertEqual(recovery.request_digest(document), hashlib.sha256(backend._canonical(document)).hexdigest())

    def test_exact_stopped_backend(self):
        self.assertEqual(self.validate(self.document), self.names)

    def test_changed_identity_or_running_backend_rejected(self):
        for field, value in [('Id', 'c' * 64), ('Image', 'sha256:' + 'd' * 64)]:
            document = copy.deepcopy(self.document)
            document[field] = value
            with self.assertRaises(BuildControlError):
                self.validate(document)
        for state in [dict(Running=True, Restarting=False, Status='running'), dict(Running=False, Restarting=True, Status='restarting')]:
            document = copy.deepcopy(self.document)
            document['State'] = state
            with self.assertRaises(BuildControlError):
                self.validate(document)

    def test_source_write_or_alias_rejected(self):
        for key, value in [('RW', True), ('Source', '/foreign'), ('Type', 'volume')]:
            document = copy.deepcopy(self.document)
            document['Mounts'][0][key] = value
            with self.assertRaises(BuildControlError):
                self.validate(document)
        document = copy.deepcopy(self.document)
        document['Mounts'][2]['Name'] = 'build-test'
        with self.assertRaises(BuildControlError):
            self.validate(document)

    def test_only_recovery_mount_subpaths_are_rejected(self):
        document = copy.deepcopy(self.document)
        document['HostConfig']['Mounts'] = [dict(Target='/opt/fullmag/runtime-control',
            VolumeOptions={'Subpath': 'runtime-control'})]
        self.assertEqual(self.validate(document), self.names)
        for target in ('/build', '/opt/fullmag/package', '/opt/fullmag/control'):
            document['HostConfig']['Mounts'] = [dict(Target=target, VolumeOptions={'Subpath': 'nested'})]
            with self.assertRaises(BuildControlError):
                self.validate(document)

    def test_mount_order_is_not_a_backend_change(self):
        reordered = copy.deepcopy(self.document)
        reordered['Mounts'].reverse()
        self.assertEqual(recovery.normalized_backend(self.document), recovery.normalized_backend(reordered))
        reordered['Mounts'][0]['RW'] = False
        self.assertNotEqual(recovery.normalized_backend(self.document), recovery.normalized_backend(reordered))

    def test_live_volume_consumer_rejected(self):
        with patch.object(recovery, 'docker_capture', side_effect=[
                SimpleNamespace(stdout=b'live'),
                SimpleNamespace(stdout=json.dumps([{'Mounts': [{'Name': 'package-test'}]}]).encode())]):
            with self.assertRaises(BuildControlError):
                recovery.reject_active_consumers(self.names)

    def test_empty_consumer_inventory(self):
        with patch.object(recovery, 'docker_capture', return_value=SimpleNamespace(stdout=b'')):
            recovery.reject_active_consumers(self.names)

    def test_helper_boundaries_and_explicit_apply(self):
        with patch('docker_build_control.docker_argv', return_value=['docker', 'run']):
            for apply in (False, True):
                arguments = recovery.helper_arguments(self.control, Path('/source with spaces'), self.names,
                    'verification/request.json', 'c' * 64, apply, 'candidate-test')
                self.assertNotIn('--rm', arguments)
                self.assertIn('--read-only', arguments)
                self.assertEqual(arguments[arguments.index('--network') + 1], 'none')
                self.assertIn('/source with spaces:/opt/fullmag/source:ro', arguments)
                package = next(value for value in arguments if 'dst=/opt/fullmag/package,' in value)
                self.assertEqual('readonly' in package, not apply)
                self.assertEqual('--apply' in arguments[-1], apply)
                self.assertNotIn('docker.sock', ' '.join(arguments))
                self.assertNotIn('--gpus', arguments)
                self.assertNotIn('/state', ' '.join(arguments))


if __name__ == '__main__':
    unittest.main()
