import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import docker_foreign_bind_identity as module
from docker_build_control import BuildControlError, canonical


class ForeignBindIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name).resolve()
        self.state = self.source / 'state'
        self.state.mkdir()
        self.alias = module.WSL_ALIAS + 'Ubuntu2/aliasB'
        self.identity = {'project_name': 'fullmag-worktree-foreign', 'project_id': 'p',
                         'worktree_id': 'w', 'checkout_kind': 'worktree'}
        self.container = {'Id': 'a' * 64, 'Image': 'sha256:' + 'b' * 64,
                          'Config': {'Labels': {
                              'com.docker.compose.service': 'backend',
                              'com.docker.compose.project.working_dir': str(self.source),
                              'com.docker.compose.project': self.identity['project_name'],
                              'org.fullmag.compose.project': self.identity['project_name'],
                              'org.fullmag.source.project-id': 'p',
                              'org.fullmag.source.worktree-id': 'w',
                              'org.fullmag.source.checkout-kind': 'worktree'}},
                          'State': {'StartedAt': 'exact-incarnation'},
                          'Mounts': [{'Type': 'bind', 'Destination': '/state', 'Source': self.alias}]}
        self.compose = {'name': self.identity['project_name'], 'services': {'backend': {
            'volumes': [{'type': 'bind', 'target': '/state', 'source': str(self.state)}],
            'x-fullmag-daemon-binds': {'/state': self.alias}}}}
        self.current = {'attempt': 'c' * 32, 'state': 'succeeded', 'phase': 'development',
                        'compose_project': self.identity['project_name'], 'control_volume': 'foreign-control',
                        'backend_container': self.container['Id'], 'backend_started_at': 'exact-incarnation',
                        'config_sha256': hashlib.sha256(canonical(self.compose)).hexdigest(),
                        'inputs': {'source_root': str(self.source), 'source_project_id': 'p',
                                   'source_worktree_id': 'w', 'source_checkout_kind': 'worktree',
                                   'image_id': self.container['Image']}}
        self.control = unittest.mock.Mock(volume='foreign-control')
        self.control.read_bytes.side_effect = lambda relative: canonical(self.current if relative == 'development/current.json' else self.compose)
        for name, value in [('select_checkout', self.source), ('compose_project_identity', self.identity),
                            ('toolchain_configuration', {'services': {'fem-gpu-toolchain': {'build': {'args': {'FULLMAG_CUDA_BASE_IMAGE': 'sha256:' + 'd' * 64}}}}}),
                            ('BuildControl', self.control)]:
            patch.object(module, name, return_value=value).start()
        patch.object(module.storage, 'resolve_layout', return_value={}).start()
        patch.object(module, 'docker_capture', return_value=unittest.mock.Mock(stdout=canonical([{'Id': self.container['Image'], 'Config': {}}]))).start()
        self.mount_validator = patch('docker_volume_dev._validate_retained_service').start()
        self.addCleanup(patch.stopall)

    def qualify(self):
        return module.canonical_bind_sources(self.container, repo_root=self.source)

    def test_registered_exact_incarnation_qualifies_alias_without_preparing_foreign_control(self):
        self.assertEqual(self.qualify(), {self.alias: str(self.state)})
        self.mount_validator.assert_called_once()
        self.control.prepare.assert_not_called()
        self.control.write_bytes.assert_not_called()

    def test_copied_labels_cannot_authenticate_a_different_container(self):
        self.current['backend_container'] = 'f' * 64
        with self.assertRaisesRegex(BuildControlError, 'exact DEV incarnation'):
            self.qualify()

    def test_image_and_source_pins_cannot_drift(self):
        self.current['inputs']['image_id'] = 'sha256:' + '0' * 64
        with self.assertRaisesRegex(BuildControlError, 'exact DEV incarnation'):
            self.qualify()

    def test_compose_digest_and_daemon_alias_are_both_required(self):
        self.current['config_sha256'] = '0' * 64
        with self.assertRaisesRegex(BuildControlError, 'Compose'):
            self.qualify()
        self.current['config_sha256'] = hashlib.sha256(canonical(self.compose)).hexdigest()
        self.compose['services']['backend']['x-fullmag-daemon-binds']['/state'] = module.WSL_ALIAS + 'Ubuntu2/aliasA'
        self.current['config_sha256'] = hashlib.sha256(canonical(self.compose)).hexdigest()
        with self.assertRaisesRegex(BuildControlError, 'historical daemon bind pin'):
            self.qualify()

    def test_foreign_recreation_during_qualification_fails_closed(self):
        current = canonical(self.current)
        changed = canonical({**self.current, 'attempt': 'e' * 32})
        calls = 0
        def read(relative):
            nonlocal calls
            if relative == 'development/current.json':
                calls += 1
                return current if calls == 1 else changed
            return canonical(self.compose)
        self.control.read_bytes.side_effect = read
        with self.assertRaisesRegex(BuildControlError, 'changed during'):
            self.qualify()

    def test_unknown_app_labels_are_not_evidence(self):
        self.container['Config']['Labels'] = {'com.docker.compose.service': 'backend'}
        with self.assertRaisesRegex(BuildControlError, 'registered Linux DEV source'):
            self.qualify()


class ConsumerMappingTests(unittest.TestCase):
    def test_qualified_aliases_are_compared_by_canonical_overlap(self):
        import docker_volume_container_recovery as recovery
        backend = {'Id': 'a' * 64, 'Mounts': [{'Type': 'bind', 'Source': module.WSL_ALIAS + 'Ubuntu2/own', 'Destination': '/state'}]}
        frontend = {'Id': 'b' * 64, 'Mounts': []}
        foreign = {'Id': 'c' * 64, 'Mounts': [{'Type': 'bind', 'Source': module.WSL_ALIAS + 'Ubuntu2/foreign', 'Destination': '/other'}]}
        compose = {'services': {'backend': {'volumes': [{'type': 'bind', 'source': '/canonical/master/state', 'target': '/state'}]}}}
        control = type('Control', (), {'_active_operation': None})()
        def capture(*args, **kwargs):
            if args[0] == 'ps':
                return unittest.mock.Mock(stdout=('a' * 64 + '\n' + 'b' * 64 + '\n' + 'c' * 64).encode())
            return unittest.mock.Mock(stdout=canonical([foreign]))
        with patch.object(recovery, 'docker_capture', side_effect=capture):
            for source in ['/canonical/master/state', '/canonical/master', '/canonical/master/state/nested']:
                with self.subTest(source=source), patch.object(module, 'canonical_bind_sources', return_value={foreign['Mounts'][0]['Source']: source}):
                    with self.assertRaisesRegex(BuildControlError, 'foreign Docker container references'):
                        recovery._assert_no_foreign_storage_consumers(control, backend, frontend, compose)
            with patch.object(module, 'canonical_bind_sources', return_value={foreign['Mounts'][0]['Source']: '/canonical/other/state'}):
                recovery._assert_no_foreign_storage_consumers(control, backend, frontend, compose)


if __name__ == '__main__':
    unittest.main()
