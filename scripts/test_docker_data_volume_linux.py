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
        for stage in ('probe', 'preflight', 'format-mount', 'recover-mounted'):
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
            self.assertEqual(events, ['lock', 'run', 'unlock'] if stage in
                             ('format-mount', 'recover-mounted') else ['run'])

    def recovery_command(self, *, change=None):
        from scripts import linux_data_volume_recover as recovery
        token = '6'*32
        components = {}
        for name in recovery.COMPONENTS:
            path = self.source/'scripts'/name
            if not path.exists():
                path.write_text('# private root fixture\n')
            components[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        request = {'schema': recovery.SCHEMA, 'volume_id': self.request['volume_id'],
            'storage_root': self.layout['storage_root'], 'token': token,
            'failed_journal_relative': 'recovery/'+'5'*32+'/journal.json',
            **{key: 'a'*64 for key in recovery.DIGEST_KEYS}, 'components': components}
        if change:
            change(request)
        path = self.path.parent/'recovery'/token/'mounted-recovery-request.json'
        with mock.patch.object(bridge, '_read', side_effect=[(b'recovery', request), (b'linux', self.request)]), \
                mock.patch.object(bridge, 'load_plan', return_value=(b'plan', self.plan, None)), \
                mock.patch.object(bridge, '_wsl_executable', return_value='/mnt/c/Windows/System32/wsl.exe'):
            return bridge.command_for_stage(self.source, self.layout, self.identity, 'recover-mounted',
                                            'Ubuntu2', path, 'b'*64)

    def test_recovery_uses_isolated_closed_bootstrap_and_never_format_argv(self):
        from scripts import docker_data_volume_root_bootstrap as bootstrap
        argv = self.recovery_command()
        self.assertEqual(argv[6:11], ['/usr/bin/python3', '-I', '-B', '-c', bootstrap.bootstrap('recover-mounted')])
        self.assertEqual(argv[11], str(self.source))
        self.assertNotIn('format-mount', argv)
        self.assertEqual(len(argv), 15)

    def test_recovery_refuses_source_component_or_group_drift(self):
        with self.assertRaisesRegex(ValueError, 'component source changed'):
            self.recovery_command(change=lambda request: request['components'].update(
                {'fullmag_data_volume_guard.py': '0'*64}))
        self.plan['compose_project'] = 'foreign'
        with self.assertRaisesRegex(ValueError, 'another checkout'):
            self.recovery_command()


if __name__ == '__main__':
    unittest.main()
