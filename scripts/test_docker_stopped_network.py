from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from docker_build_control import BuildControlError
import docker_stopped_network as module


class StoppedNetworkTests(unittest.TestCase):
    def setUp(self):
        self.identifier = 'a' * 64
        self.project = 'fullmag-master'
        self.name = self.project + '_fullmag'
        self.backend = {'Id': 'b' * 64, 'HostConfig': {'PortBindings': None},
                        'NetworkSettings': {'Networks': {self.name: {'NetworkID': self.identifier}}}}
        self.frontend = {'Id': 'c' * 64, 'NetworkSettings': self.backend['NetworkSettings']}
        self.empty = SimpleNamespace(returncode=0, stdout=b'', stderr=b'')

    def missing(self, message=None):
        return SimpleNamespace(returncode=1, stdout=b'[]\n', stderr=(message or 'Error response from daemon: network ' + self.identifier + ' not found').encode())

    def test_actual_daemon_not_found_is_bound_to_full_id(self):
        self.assertTrue(module.authoritative_network_not_found(self.missing(), self.identifier))
        self.assertFalse(module.authoritative_network_not_found(self.missing(), 'd' * 64))
        for message in ['Cannot connect to Docker daemon', 'No such network', 'network not found',
                        'Error response from daemon: network ' + 'd' * 64 + ' not found']:
            self.assertFalse(module.authoritative_network_not_found(self.missing(message), self.identifier))

    def test_both_docker_not_found_variants_are_accepted(self):
        self.assertTrue(module.authoritative_network_not_found(self.missing('Error: No such network: ' + self.identifier), self.identifier))
        capture = Mock(side_effect=[self.empty, self.missing(), self.empty])
        result = module.observe_stopped_bridge(self.backend, self.frontend, self.project, capture=capture)
        self.assertEqual(result, {'name': self.name, 'network_id': self.identifier, 'state': 'absent'})
        self.assertEqual(capture.call_count, 3)

    def test_daemon_error_and_name_recreation_cannot_become_absence(self):
        capture = Mock(side_effect=[self.empty, self.missing('Cannot connect to Docker daemon')])
        with self.assertRaisesRegex(BuildControlError, 'not authoritative'):
            module.observe_stopped_bridge(self.backend, self.frontend, self.project, capture=capture)
        appeared = SimpleNamespace(returncode=0, stdout=('{"ID":"' + 'd' * 64 + '","Name":"' + self.name + '"}\n').encode(), stderr=b'')
        capture = Mock(side_effect=[self.empty, self.missing(), appeared])
        with self.assertRaisesRegex(BuildControlError, 'changed during'):
            module.observe_stopped_bridge(self.backend, self.frontend, self.project, capture=capture)

    def test_existing_bridge_requires_owned_private_bridge_validation(self):
        row = SimpleNamespace(returncode=0, stdout=('{"ID":"' + self.identifier + '","Name":"' + self.name + '"}\n').encode(), stderr=b'')
        validate = Mock()
        result = module.observe_stopped_bridge(self.backend, self.frontend, self.project,
                                               capture=Mock(side_effect=[row, SimpleNamespace(returncode=0, stdout=('[{\"Id\":\"' + self.identifier + '\",\"Name\":\"' + self.name + '\"}]').encode())]), validate_owned_bridge=validate)
        self.assertEqual(result['state'], 'owned-bridge')
        validate.assert_called_once()
        validate.side_effect = BuildControlError('foreign endpoint')
        with self.assertRaisesRegex(BuildControlError, 'foreign endpoint'):
            module.observe_stopped_bridge(self.backend, self.frontend, self.project,
                                          capture=Mock(return_value=row), validate_owned_bridge=validate)

    def test_bridge_name_reuse_during_legacy_validator_cannot_claim_old_id(self):
        row = SimpleNamespace(returncode=0, stdout=('{"ID":"' + self.identifier + '","Name":"' + self.name + '"}\n').encode(), stderr=b'')
        changed = SimpleNamespace(returncode=0, stdout=('[{"Id":"' + 'd' * 64 + '","Name":"' + self.name + '"}]').encode(), stderr=b'')
        with self.assertRaisesRegex(BuildControlError, 'immutable identity changed'):
            module.observe_stopped_bridge(self.backend, self.frontend, self.project,
                                          capture=Mock(side_effect=[row, changed]), validate_owned_bridge=Mock())

    def test_long_project_uses_canonical_hashed_network_name(self):
        project = 'fullmag-worktree-' + 'long-checkout-identity-' * 4
        name = module.compose_network_name(project)
        self.assertTrue(name.startswith('fullmag-net-'))
        backend = {'Id': self.backend['Id'], 'HostConfig': {'PortBindings': None},
                   'NetworkSettings': {'Networks': {name: {'NetworkID': self.identifier}}}}
        frontend = {'Id': self.frontend['Id'], 'NetworkSettings': backend['NetworkSettings']}
        capture = Mock(side_effect=[self.empty, self.missing(), self.empty])
        self.assertEqual(module.observe_stopped_bridge(backend, frontend, project, capture=capture)['name'], name)
        by_name = SimpleNamespace(returncode=1, stdout=b'[]\n', stderr=('Error response from daemon: network ' + name + ' not found').encode())
        self.assertTrue(module.authoritative_network_not_found(by_name, name))

    def test_foreign_project_name_and_mismatched_old_ids_are_rejected(self):
        with self.assertRaisesRegex(BuildControlError, 'selected project'):
            module.observe_stopped_bridge(self.backend, self.frontend, 'different-project', capture=Mock())
        frontend = {'Id': self.frontend['Id'], 'NetworkSettings': {'Networks': {self.name: {'NetworkID': 'e' * 64}}}}
        with self.assertRaisesRegex(BuildControlError, 'same old network'):
            module.observe_stopped_bridge(self.backend, frontend, self.project, capture=Mock())


if __name__ == '__main__':
    unittest.main()
