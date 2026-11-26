"""Driver-library helper arguments against current source; no Docker operations."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_build_control as control_module
import docker_group_ledger_bootstrap_host as bootstrap_host

SOURCE = Path(bootstrap_host.__file__).with_name('docker_group_ledger_relocation.py')
spec = importlib.util.spec_from_file_location('current_relocation_driver_helper', SOURCE)
relocation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relocation)


class HelperDriverLibraryTests(unittest.TestCase):
    def exercise(self, cuda):
        control = object.__new__(control_module.BuildControl)
        control.project = 'fullmag-worktree-test'
        control.volume = 'own-control'
        control.image = 'sha256:' + 'a' * 64
        control.labels = {'org.fullmag.build.role': 'control'}
        control.namespace = ''
        control.identity = {'project_name': control.project, 'project_id': 'project-test',
            'worktree_id': 'worktree-test', 'checkout_kind': 'worktree'}
        program = {'image_id': 'sha256:' + 'b' * 64, 'package_volume': 'packages', 'package_subpath': 'groups/' + 'c' * 64}
        request = {'native_program': program, 'source_volume': 'legacy-ledger', 'target_subpath': 'private/ledger'}
        image = {'Id': program['image_id'], 'Config': {'Env': ['PATH=/usr/bin'] + (['NVIDIA_REQUIRE_CUDA=cuda>=12.0'] if cuda else [])}}
        with patch.object(control_module, 'docker_argv', side_effect=lambda command: ['docker', command]), \
                patch.object(relocation, 'docker_capture', return_value=SimpleNamespace(stdout=json.dumps([image]).encode())) as inspect:
            command = relocation._helper(control, request, 'read-only-native-probe', target=True, name='own-probe')
        inspect.assert_called_once_with('image', 'inspect', program['image_id'])
        self.assertEqual(command[command.index('--runtime') + 1], 'nvidia' if cuda else 'runc')
        environments = [command[i + 1] for i, value in enumerate(command) if value == '--env']
        self.assertIn('NVIDIA_VISIBLE_DEVICES=' + ('none' if cuda else 'void'), environments)
        self.assertEqual('NVIDIA_DRIVER_CAPABILITIES=compute' in environments, cuda)
        self.assertNotIn('--gpus', command)
        self.assertNotIn('--privileged', command)
        self.assertNotIn('--pid', command)
        self.assertIn('--read-only', command)
        self.assertEqual(command[command.index('--network') + 1], 'none')
        self.assertEqual(command[command.index('--cap-drop') + 1], 'ALL')
        self.assertEqual(command[command.index('--security-opt') + 1], 'no-new-privileges:true')
        self.assertEqual(command[command.index('--user') + 1], '65532:65532')
        self.assertEqual(command[command.index('--memory') + 1], '64m')
        self.assertEqual(command[command.index('--cpus') + 1], '0.25')
        self.assertEqual(command[command.index('--pids-limit') + 1], '32')
        self.assertEqual(command[command.index('--entrypoint') + 2], program['image_id'])
        mounts = [command[i + 1] for i, value in enumerate(command) if value == '--mount']
        self.assertIn('type=volume,src=packages,dst=/opt/fullmag/package,readonly,volume-nocopy,volume-subpath=' + program['package_subpath'], mounts)
        self.assertIn('type=volume,src=own-control,dst=/host-ledger,readonly,volume-nocopy,volume-subpath=private/ledger', mounts)
        self.assertEqual(len(mounts), 3)

    def test_cuda_image_receives_compute_driver_libraries_without_gpu_devices(self):
        self.exercise(True)

    def test_cpu_image_keeps_runc_and_void_without_driver_capability_grant(self):
        self.exercise(False)


if __name__ == '__main__':
    unittest.main()
