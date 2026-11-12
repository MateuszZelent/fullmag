"""Selected-checkout and lock boundaries; never invoke root or real WSL."""
from contextlib import contextmanager
import copy
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts import docker_data_volume_linux as bridge
from scripts.test_fullmag_data_volume_linux_request import valid_request


class LinuxVolumeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name)
        scripts = self.source/'scripts'; scripts.mkdir()
        for name in ('linux_data_volume_provision.py', 'linux_data_volume_format.py'):
            (scripts/name).write_text('# private fixture\n')
        self.layout = {'storage_root': '/srv/fullmag/storage',
                       'runtime_root': '/srv/fullmag/storage/runtimes/fixture'}
        self.identity = {'project_id': 'fixture-project', 'worktree_id': 'fixture',
                         'project_name': 'fullmag-worktree-fixture'}
        self.request = valid_request()
        self.request['source_roots']['user_data']['canonical_root'] = (
            self.layout['storage_root']+'/user-data/'+self.identity['project_name'])
        self.request['controller_sha256'] = hashlib.sha256(
            (scripts/'linux_data_volume_provision.py').read_bytes()).hexdigest()
        self.formatter_sha = hashlib.sha256(
            (scripts/'linux_data_volume_format.py').read_bytes()).hexdigest()
        self.path = Path(self.layout['storage_root'])/'migrations/data-volumes'/self.request['volume_id']/'linux-provision-request.json'
        self.plan = {'source_root': str(self.source), **self.identity,
                     'compose_project': self.identity['project_name'],
                     'provision_request': {'wsl_distro': 'Ubuntu2'},
                     'observation': {'datasets': copy.deepcopy(self.request['source_roots'])}}

    def command(self, stage='format-mount', **changes):
        params = {'request_path': self.path, 'request_sha256': '1'*64,
                  'formatter_sha256': self.formatter_sha if stage == 'format-mount' else None}
        params.update(changes)
        with mock.patch.object(bridge, '_read', side_effect=[(b'request', self.request), (b'plan', self.plan)]), \
                mock.patch.object(bridge, '_wsl_executable', return_value='/mnt/c/Windows/System32/wsl.exe'):
            return bridge.command_for_stage(self.source, self.layout, self.identity,
                                            stage, 'Ubuntu2', **params)

    def test_mutation_targets_only_pinned_script_and_explicit_host_distro(self):
        argv = self.command()
        self.assertEqual(argv[:8], ['/mnt/c/Windows/System32/wsl.exe', '--distribution',
            'Ubuntu2', '--user', 'root', '--exec', '/usr/bin/python3', '-B'])
        self.assertEqual(argv[8:10], [str(self.source/'scripts/linux_data_volume_format.py'), 'format-mount'])
        self.assertEqual(argv[10:], ['--request', str(self.path), '--request-sha256', '1'*64,
                                   '--formatter-sha256', self.formatter_sha])
        self.assertFalse(any('/dev/' in item for item in argv))

    def test_missing_request_path_is_refused_before_read(self):
        with mock.patch.object(bridge, '_read') as read, \
                self.assertRaisesRegex(ValueError, 'request path'):
            bridge.command_for_stage(self.source, self.layout, self.identity,
                'preflight', 'Ubuntu2', request_sha256='1'*64)
        read.assert_not_called()

    def test_other_checkout_distro_or_group_is_refused(self):
        for key, value in [('source_root', '/other/checkout'), ('compose_project', 'foreign'),
                           ('worktree_id', 'foreign'), ('project_id', 'foreign')]:
            original = self.plan[key]; self.plan[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'another checkout'):
                self.command()
            self.plan[key] = original
        self.plan['provision_request']['wsl_distro'] = 'OtherDistro'
        with self.assertRaisesRegex(ValueError, 'another checkout'):
            self.command()

    def test_dataset_drift_or_cross_group_state_refuses(self):
        self.plan['observation']['datasets']['state']['inode'] += 1
        with self.assertRaisesRegex(ValueError, 'Original datasets'):
            self.command()
        self.plan['observation']['datasets'] = copy.deepcopy(self.request['source_roots'])
        self.request['source_roots']['state']['canonical_root'] = '/srv/fullmag/storage/runtimes/foreign/state'
        self.plan['observation']['datasets'] = copy.deepcopy(self.request['source_roots'])
        with self.assertRaisesRegex(ValueError, 'Original datasets'):
            self.command()

    def test_source_drift_and_bad_formatter_pin_refuse(self):
        with self.assertRaisesRegex(ValueError, 'formatter source SHA'):
            self.command(formatter_sha256='2'*64)
        (self.source/'scripts/linux_data_volume_provision.py').write_text('# changed\n')
        with self.assertRaisesRegex(ValueError, 'qualifier source changed'):
            self.command()

    def test_read_only_stages_do_not_accept_format_authority(self):
        with self.assertRaisesRegex(ValueError, 'Preflight cannot'):
            self.command('preflight', formatter_sha256=self.formatter_sha)
        with self.assertRaisesRegex(ValueError, 'Probe does not'):
            self.command('probe')

    def test_system32_path_is_required_for_wsl_interop(self):
        with mock.patch.dict('os.environ', {'PATH': '/tmp/shadow/Windows/System32'}), \
                mock.patch('shutil.which', return_value='/tmp/shadow/Windows/System32/wsl.exe'), \
                mock.patch.object(Path, 'is_file', return_value=True), \
                mock.patch.object(Path, 'is_symlink', return_value=False):
            self.assertEqual(bridge._wsl_executable(), '/mnt/c/Windows/System32/wsl.exe')

    def test_system_interop_path_cannot_traverse_a_symlink(self):
        with mock.patch.object(Path, 'is_file', return_value=True), \
                mock.patch.object(Path, 'is_symlink', side_effect=lambda: True), \
                self.assertRaisesRegex(ValueError, 'symlink'):
            bridge._wsl_executable()

    def test_only_format_holds_group_lock_across_the_attached_subprocess(self):
        for stage in ('probe', 'preflight', 'format-mount'):
            events = []

            @contextmanager
            def lock(_layout):
                events.append('lock')
                try:
                    yield
                finally:
                    events.append('unlock')

            def run(command, **kwargs):
                self.assertEqual(command, ['pinned-root-stage'])
                self.assertEqual(kwargs, {'check': False})
                events.append('run')
                return subprocess.CompletedProcess(command, 7)

            with self.subTest(stage=stage), \
                    mock.patch.object(bridge, 'select_checkout', return_value=self.source), \
                    mock.patch.object(bridge, 'validate_host_path'), \
                    mock.patch.object(bridge.storage, 'resolve_layout', return_value=self.layout), \
                    mock.patch.object(bridge, 'compose_project_identity', return_value=self.identity), \
                    mock.patch.object(bridge.storage, 'build_lock', side_effect=lock), \
                    mock.patch.object(bridge, 'command_for_stage', return_value=['pinned-root-stage']), \
                    mock.patch.object(bridge.subprocess, 'run', side_effect=run):
                self.assertEqual(bridge.run_stage(self.source, stage, 'Ubuntu2'), 7)
            self.assertEqual(events, ['lock', 'run', 'unlock'] if stage == 'format-mount' else ['run'])


if __name__ == '__main__':
    unittest.main()
