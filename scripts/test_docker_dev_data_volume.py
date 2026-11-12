"""Refusal and no-mutation checks for the operational data-move plan."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import docker_dev_data_volume as controller


class MigrationBindRoutingTests(unittest.TestCase):
    def setUp(self):
        self.state = {'Status':'exited', 'Running':False, 'Paused':False,
                      'Restarting':False, 'OOMKilled':False, 'Dead':False, 'Pid':0}

    def test_exited_windows_reference_requires_its_own_physical_proof(self):
        proof = {'schema':'fixture-physical-proof'}
        with mock.patch.object(controller.stopped_windows, 'qualify_stopped_windows_bind', return_value=proof) as qualifier, \
                mock.patch.object(controller, 'live_bind_path') as live:
            self.assertEqual(controller._migration_bind_identity('C:/deleted/foreign', self.state), (None, proof))
        qualifier.assert_called_once_with('C:/deleted/foreign', self.state)
        live.assert_not_called()

    def test_active_windows_missing_path_still_uses_strict_live_proof(self):
        self.state.update(Status='running', Running=True, Pid=123)
        with mock.patch.object(controller.stopped_windows, 'qualify_stopped_windows_bind') as qualifier, \
                mock.patch.object(controller, 'live_bind_path', side_effect=ValueError('unproven')) as live, \
                self.assertRaisesRegex(ValueError, 'unproven'):
            controller._migration_bind_identity('C:/deleted/foreign', self.state)
        qualifier.assert_not_called()
        live.assert_called_once()

    def test_linux_reference_never_uses_windows_missing_leaf_proof(self):
        source = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/alias'
        with mock.patch.object(controller.stopped_windows, 'qualify_stopped_windows_bind') as qualifier, \
                mock.patch.object(controller, 'live_bind_path', return_value=Path('/actual/foreign')):
            self.assertEqual(controller._migration_bind_identity(source, self.state), (Path('/actual/foreign'), None))
        qualifier.assert_not_called()

    def test_failed_windows_proof_cannot_fall_back_to_an_unrelated_route(self):
        with mock.patch.object(controller.stopped_windows, 'qualify_stopped_windows_bind', side_effect=ValueError('reparse')) as qualifier, \
                mock.patch.object(controller, 'live_bind_path') as live, \
                self.assertRaisesRegex(ValueError, 'reparse'):
            controller._migration_bind_identity('C:/deleted/foreign', self.state)
        live.assert_not_called()


class DataVolumePlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name)
        self.layout = {'storage_root': '/srv/fullmag/storage',
                       'runtime_root': '/srv/fullmag/storage/runtimes/fullmag-fixture',
                       'worktree_id': 'fullmag-fixture',
                       'env': {'FULLMAG_PROJECT_ID': 'fullmag-0123456789abcdef'}}
        self.identity = {'project_name': 'fullmag-worktree-fullmag-fixture',
                         'project_id': 'fullmag-0123456789abcdef',
                         'worktree_id': self.layout['worktree_id']}
        for name in controller.CONTROLLERS:
            path = self.source / 'scripts' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('# private fixture\n')
        self.pins = {'attempt': 'a'*32, 'config_sha256': 'b'*64,
                     'state_root': self.layout['runtime_root']+'/docker-volume-dev/'+'c'*32,
                     'backend': 'd'*64, 'frontend': 'e'*64, 'image_id': 'sha256:'+'f'*64,
                     'runtime_witness_path': 'iteration/attempts/'+'1'*32+'/terminal.json',
                     'runtime_witness_sha256': '2'*64}

    def plan(self, **changes):
        params = {'backing_file': r'E:\git\storage\fixture-new.vhdx',
                  'mount_root': '/mnt/fullmag-fixture-volume', 'distro': 'Ubuntu2',
                  'volume_id': '3'*32}
        params.update(changes)
        with mock.patch.object(controller, 'select_checkout', return_value=self.source), \
                mock.patch.object(controller, 'validate_host_path'), \
                mock.patch.object(controller.storage, 'resolve_layout', return_value=self.layout), \
                mock.patch.object(controller, 'compose_project_identity', return_value=self.identity), \
                mock.patch('fullmag_data_volume_guard.verify_registered_volume', return_value=None), \
                mock.patch.object(controller, 'BuildControl'), \
                mock.patch.object(controller, '_require_existing_control') as existing_control, \
                mock.patch.object(controller, '_observe_runtime', return_value={'consumers': []}), \
                mock.patch.object(controller.storage, 'git', return_value='4'*40), \
                mock.patch.object(controller.os.path, 'lexists', return_value=False), \
                mock.patch.object(Path, 'mkdir', side_effect=AssertionError('plan wrote a directory')):
            result = controller.plan_data_volume(self.source, self.pins, **params)
            existing_control.assert_called_once()
            return result

    def test_missing_control_volume_refuses_before_any_read_helper(self):
        control = mock.Mock(volume='existing-control-volume')
        with mock.patch.object(controller, 'docker_capture',
                               side_effect=RuntimeError('No such volume')) as daemon:
            with self.assertRaisesRegex(RuntimeError, 'No such volume'):
                controller._require_existing_control(control, self.pins)
        control.read_bytes.assert_not_called()
        self.assertEqual(daemon.call_args.args, ('volume', 'inspect', control.volume))

    def test_plan_is_read_only_and_provision_results_stay_in_wsl(self):
        result = self.plan()
        self.assertFalse(result['mutated'])
        self.assertEqual(result['state'], 'planned-not-applied')
        self.assertEqual(result['provision_request']['backing_file_wsl'],
                         '/mnt/e/git/storage/fixture-new.vhdx')
        self.assertEqual(result['provision_request']['result_directory_windows'],
                         r'\\wsl.localhost\Ubuntu2\srv\fullmag\storage\migrations\data-volumes'+'\\'+'3'*32)
        self.assertIn('new-complete-zarr', result['pending_gates'])
        self.assertNotIn('registration', result)

    def test_mount_must_not_overlap_original_storage_or_checkout(self):
        for path in ['/srv/fullmag/storage/inside', '/srv/fullmag', str(self.source/'new-mount')]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.plan(mount_root=path)

    def test_invalid_capacity_identity_and_paths_refuse_without_mutation(self):
        for changes in [{'capacity_bytes': True}, {'capacity_bytes': 0},
                        {'volume_id': '0'*32}, {'distro': 'Ubuntu2;Remove-Item'},
                        {'backing_file': r'E:\git\storage\..\old.vhdx'},
                        {'mount_root': '/tmp/unreliable'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.plan(**changes)

    def test_runtime_pins_refuse_path_traversal_and_identical_services(self):
        for key, value in [('runtime_witness_path', '../terminal.json'),
                           ('attempt', 'a'*31), ('backend', self.pins['frontend'])]:
            with self.subTest(key=key):
                candidate = dict(self.pins, **{key: value})
                with self.assertRaises(ValueError):
                    controller._runtime_pins(candidate)

    def test_wrong_witness_refuses_before_daemon_inventory(self):
        control = mock.Mock(project=self.identity['project_name'], volume='fixture-volume')
        compose = {'name': control.project, 'services': {}}
        raw = json.dumps({'phase': 'iteration', 'state': 'succeeded'}).encode()
        pins = dict(self.pins, config_sha256=hashlib.sha256(controller.canonical(compose)).hexdigest(),
                    runtime_witness_sha256=hashlib.sha256(raw).hexdigest())
        control.read_bytes.side_effect = [json.dumps(compose).encode(), raw]
        with mock.patch.object(controller, 'docker_capture') as daemon:
            with self.assertRaisesRegex(ValueError, 'exact service pair'):
                controller._observe_runtime(self.source, self.layout, control, pins)
        daemon.assert_not_called()


if __name__ == '__main__':
    unittest.main()
