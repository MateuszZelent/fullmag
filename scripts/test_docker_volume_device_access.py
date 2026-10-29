"""Retained DEV profiles cannot silently gain or lose GPU access."""
import copy
import subprocess
import unittest
from unittest import mock

import docker_dev
import docker_volume_dev as dev
from docker_build_control import BuildControlError


class RetainedDeviceAccessTests(unittest.TestCase):
    def retained(self, policy='auto', access='gpu'):
        previous = {'inputs': {'gpu_access_requested': policy, 'device_access': access,
                    'gpu_preflight': 'PASS' if access == 'gpu' else 'NOT_REQUIRED'}}
        backend = {'environment': {'FULLMAG_DOCKER_DEVICE_ACCESS': access}}
        if access == 'gpu':
            backend['gpus'] = [{'count': 'all'}]
        return previous, {'services': {'backend': backend}}

    def test_requested_auto_is_preserved_separately_from_resolved_access(self):
        for policy, access in [('auto', 'gpu'), ('auto', 'cpu'), ('required', 'gpu'), ('disabled', 'cpu')]:
            with self.subTest(policy=policy, access=access):
                previous, document = self.retained(policy, access)
                original = copy.deepcopy((previous, document))
                self.assertEqual(dev._retained_device_access(previous, document), access)
                self.assertEqual((previous, document), original)

    def test_inconsistent_receipt_or_compose_is_rejected(self):
        previous, document = self.retained()
        variants = []
        for key, value in [('gpu_access_requested', 'disabled'), ('device_access', 'cpu'),
                           ('device_access', None), ('gpu_preflight', 'NOT_REQUIRED')]:
            p = copy.deepcopy(previous)
            p['inputs'][key] = value
            variants.append((p, document))
        for key, value in [('FULLMAG_DOCKER_DEVICE_ACCESS', 'cpu'), ('FULLMAG_DOCKER_DEVICE_ACCESS', 'auto')]:
            d = copy.deepcopy(document)
            d['services']['backend']['environment'][key] = value
            variants.append((previous, d))
        d = copy.deepcopy(document)
        d['services']['backend'].pop('gpus')
        variants.extend([(previous, d), ({}, document), (previous, {})])
        for p, d in variants:
            with self.subTest(previous=p, document=d), self.assertRaises(BuildControlError):
                dev._retained_device_access(p, d)

    def test_retained_gpu_requires_host_and_docker_proof(self):
        with mock.patch.object(docker_dev, '_resolve_gpu_access', return_value='gpu') as host, \
             mock.patch.object(docker_dev, '_verify_docker_gpu_access', return_value='gpu') as docker:
            self.assertEqual(dev._probe_retained_device_access('gpu', 'image', 'project'), 'gpu')
        host.assert_called_once_with('required')
        docker.assert_called_once_with('gpu', 'required', 'image', 'project')

    def test_host_failure_never_calls_docker_or_falls_back(self):
        for failure in [docker_dev.DirectDockerError('host GPU unavailable'),
                        subprocess.TimeoutExpired('nvidia-smi', 5)]:
            with self.subTest(failure=failure), \
                 mock.patch.object(docker_dev, '_resolve_gpu_access', side_effect=failure), \
                 mock.patch.object(docker_dev, '_verify_docker_gpu_access') as docker:
                with self.assertRaises(type(failure)):
                    dev._probe_retained_device_access('gpu', 'image', 'project')
                docker.assert_not_called()

    def test_docker_error_and_unknown_outcome_are_not_cpu_fallback(self):
        for failure in [docker_dev.DirectDockerError('device unavailable'),
                        docker_dev.DirectDockerOutcomeUnknown('daemon outcome unknown')]:
            with self.subTest(failure=failure), \
                 mock.patch.object(docker_dev, '_resolve_gpu_access', return_value='gpu'), \
                 mock.patch.object(docker_dev, '_verify_docker_gpu_access', side_effect=failure):
                with self.assertRaises(type(failure)):
                    dev._probe_retained_device_access('gpu', 'image', 'project')

    def test_unexpected_probe_downgrade_is_rejected(self):
        with mock.patch.object(docker_dev, '_resolve_gpu_access', return_value='gpu'), \
             mock.patch.object(docker_dev, '_verify_docker_gpu_access', return_value='cpu'):
            with self.assertRaisesRegex(BuildControlError, 'differs from the retained'):
                dev._probe_retained_device_access('gpu', 'image', 'project')

    def test_retained_cpu_does_not_gain_gpu_from_current_host(self):
        with mock.patch.object(docker_dev, '_resolve_gpu_access') as host, \
             mock.patch.object(docker_dev, '_verify_docker_gpu_access') as docker:
            self.assertEqual(dev._probe_retained_device_access('cpu', 'image', 'project'), 'cpu')
        host.assert_not_called()
        docker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
