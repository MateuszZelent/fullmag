from copy import deepcopy
import json
import ast
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import sys
import hashlib

import docker_claimed_interruption_namespace as namespace
import docker_orphan_recovery as recovery
import test_docker_claimed_worker_interruption as request_fixtures


class NamespaceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = request_fixtures.ClaimedWorkerInterruptionTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.target = deepcopy(self.fixture.after)
        self.project = 'fullmag-master'
        self.target['Config']['Labels']['com.docker.compose.project'] = self.project
        self.target['Config']['Env'] = ['FULLMAG_DOCKER_ROLE=backend', 'FULLMAG_SESSION_STORAGE_PROFILE=linux-native-v1',
                                        'FULLMAG_COMPOSE_PROJECT='+self.project,
                                        'FULLMAG_TOOLCHAIN_IMAGE_ID=sha256:'+'f'*64,
                                        'FULLMAG_BACKEND_CARGO_PROFILE=backend-dev',
                                        'FULLMAG_HOST_LEDGER_ROOT=/host-ledger/ledger',
                                        'NVIDIA_VISIBLE_DEVICES=all', 'CUDA_VISIBLE_DEVICES=0',
                                        'LD_PRELOAD=/evil', 'LD_LIBRARY_PATH=/evil']
        self.target['Mounts'] = []
        typed = []
        for index, destination in enumerate([*namespace.MOUNTS, namespace.CONTROL]):
            source = 'group-private' if destination != '/opt/fullmag/package' else 'shared-packages'
            subpath = 'namespace-'+str(index)
            readonly = destination == '/run/fullmag/linux-native-host.json'
            self.target['Mounts'].append({'Type': 'volume', 'Name': source,
                                         'Destination': destination, 'RW': not readonly, 'Driver': 'local'})
            typed.append({'Type': 'volume', 'Source': source, 'Target': destination,
                          'ReadOnly': readonly, 'VolumeOptions': {'Subpath': subpath, 'NoCopy': True}})
        self.target['HostConfig']['Mounts'] = typed
        self.inner = deepcopy(self.fixture.request)
        self.inner['container']['compose_project'] = self.project
        self.inner['container']['config_sha256'] = recovery.canonical_json_sha256(self.target['Config'])
        self.inner['pins']['config_sha256'] = self.inner['container']['config_sha256']
        self.native = {'interruption': self.inner}
        self.directory = namespace.CONTROL+'/verification/claimed-interruption/'+'a'*32
        self.kwargs = dict(project=self.project, request_path=self.directory+'/request.json',
                           config_path=namespace.CONFIG, attestation_path=self.directory+'/attestation.json',
                           request_sha256='a'*64, attestation_sha256='b'*64, stub_sha256='c'*64,
                           candidate_basename='.backend-package-candidate-test', verify_only=False)

    def spec(self):
        return namespace.maintenance_spec(self.target, self.native, **self.kwargs)

    def repin_config(self):
        self.inner['container']['config_sha256'] = recovery.canonical_json_sha256(self.target['Config'])
        self.inner['pins']['config_sha256'] = self.inner['container']['config_sha256']

    def test_preserves_subpaths_minimum_scope_and_noncompute_command(self):
        spec = self.spec()
        args = namespace.create_args(spec, name='claimed-recovery')
        mounts = [args[i+1] for i, value in enumerate(args) if value == '--mount']
        self.assertEqual(len(mounts), 8)
        self.assertIn('type=volume,src=group-private,dst=/opt/fullmag/control/backend,volume-nocopy,volume-subpath=namespace-6/backend,readonly', mounts)
        self.assertFalse(any(',dst=/opt/fullmag/control,' in mount for mount in mounts))
        self.assertFalse(any('volume-subpath=private/backend' in mount for mount in mounts))
        self.assertIn('type=volume,src=group-private,dst=/host-ledger,volume-nocopy,volume-subpath=namespace-3', mounts)
        self.assertIn('type=volume,src=group-private,dst='+self.directory+',volume-nocopy,volume-subpath=namespace-6/verification/claimed-interruption/'+'a'*32+',readonly', mounts)
        self.assertNotIn('--gpus', args)
        self.assertNotIn('--device', args)
        self.assertNotIn('--privileged', args)
        self.assertNotIn('LD_PRELOAD', spec['environment'])
        self.assertNotIn('LD_LIBRARY_PATH', spec['environment'])
        self.assertEqual(spec['environment']['NVIDIA_VISIBLE_DEVICES'], 'void')
        self.assertEqual(spec['environment']['CUDA_VISIBLE_DEVICES'], '')
        self.assertEqual(json.loads(args[-1]), spec['context'])
        tree = ast.parse(namespace.EXECUTOR)
        compile(tree, '<claimed-executor>', 'exec')
        # The argv must expose exactly one complete action even when no caller
        # supplies verify_only; ordinary runtime options have no input channel.
        assignments = [node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                       and any(isinstance(t, ast.Name) and t.id == 'arguments' for t in node.targets)]
        self.assertEqual(len(assignments), 1)
        self.assertEqual(assignments[0].value.elts[1].value, '--complete-claimed-interruption')

    def test_wrong_stopped_incarnation_and_running_target_refused(self):
        for key, value in [('Id', 'e'*64), ('Image', 'sha256:'+'e'*64)]:
            with self.subTest(key=key):
                original = self.target[key]
                self.target[key] = value
                with self.assertRaises((ValueError, recovery.OrphanRecoveryError)):
                    self.spec()
                self.target[key] = original
        for field, value in [('StartedAt', '2026-11-06T00:00:00Z'), ('Running', True),
                             ('Pid', 123), ('Status', 'running')]:
            with self.subTest(field=field):
                old = self.target['State'][field]
                self.target['State'][field] = value
                with self.assertRaises(Exception):
                    self.spec()
                self.target['State'][field] = old

    def test_missing_duplicate_ambiguous_mounts_refused(self):
        original = deepcopy(self.target)
        mutations = [lambda t: t['HostConfig']['Mounts'].pop(0),
                     lambda t: t['HostConfig']['Mounts'].append(deepcopy(t['HostConfig']['Mounts'][0])),
                     lambda t: t['Mounts'].append(deepcopy(t['Mounts'][0])),
                     lambda t: t['HostConfig']['Mounts'][0]['VolumeOptions'].pop('Subpath'),
                     lambda t: t['HostConfig']['Mounts'][0]['VolumeOptions'].update(Subpath=''),
                     lambda t: t['HostConfig']['Mounts'][0]['VolumeOptions'].update(Subpath='../other'),
                     lambda t: t['HostConfig']['Mounts'][0]['VolumeOptions'].update(Subpath='private/./state'),
                     lambda t: t['HostConfig']['Mounts'][0]['VolumeOptions'].update(Subpath='/'),
                     lambda t: t['HostConfig']['Mounts'][0].update(Source='foreign'),
                     lambda t: t['Mounts'][0].update(RW=False)]
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index):
                self.target = deepcopy(original)
                mutation(self.target)
                with self.assertRaises(ValueError):
                    self.spec()

    def test_exact_engine_owned_wsl_bind_without_host_path_is_preserved(self):
        source = namespace.ENGINE_BIND_PARENT+'Ubuntu2/'+'d'*64
        self.target['HostConfig']['Mounts'][0] = {'Type': 'bind', 'Source': source, 'Target': '/state'}
        self.target['Mounts'][0] = {'Type': 'bind', 'Source': source, 'Destination': '/state', 'RW': True}
        args = namespace.create_args(self.spec(), name='claimed-recovery')
        self.assertIn('type=bind,src='+source+',dst=/state', args)
        # A valid-looking handle cannot replace the observed source declaration.
        self.target['Mounts'][0]['Source'] = namespace.ENGINE_BIND_PARENT+'Ubuntu2/'+'e'*64
        with self.assertRaises(ValueError):
            self.spec()

    def test_engine_owned_bind_malformed_handle_and_missing_host_proof_refused(self):
        parent = namespace.ENGINE_BIND_PARENT
        invalid = [parent+'Ubuntu2/'+'d'*63, parent+'Ubuntu2/'+'D'*64,
                   parent+'Ubuntu2/'+'g'*64, parent+'Ubuntu2/'+'d'*64+'/child',
                   parent+'Ubuntu2/'+'d'*64+'/../'+'e'*64,
                   parent+'OtherDistro/'+'d'*64, parent+'Ubuntu2//'+ 'd'*64,
                   parent.replace('docker-desktop-bind-mounts', 'foreign-mounts')+'Ubuntu2/'+'d'*64,
                   '/unavailable-untrusted-bind-root/'+'d'*64]
        for source in invalid:
            with self.subTest(source=source):
                self.target['HostConfig']['Mounts'][0] = {'Type': 'bind', 'Source': source, 'Target': '/state'}
                self.target['Mounts'][0] = {'Type': 'bind', 'Source': source, 'Destination': '/state', 'RW': True}
                with self.assertRaises(ValueError):
                    self.spec()

    def test_bind_symlink_and_traversal_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real = root/'real'
            real.mkdir()
            alias = root/'alias'
            alias.symlink_to(real)
            for source in [str(alias), str(root)+'/real/../real']:
                self.target['HostConfig']['Mounts'][0] = {'Type': 'bind', 'Source': source, 'Target': '/state'}
                self.target['Mounts'][0] = {'Type': 'bind', 'Source': source, 'Destination': '/state', 'RW': True}
                with self.assertRaises(ValueError):
                    self.spec()

    def test_arbitrary_flags_gpu_devices_and_mount_expansion_refused(self):
        original = self.spec()
        for change in [lambda s: s.update(DeviceRequests=[{'Count': -1}]),
                       lambda s: s.update(devices=['/dev/nvidia0']),
                       lambda s: s['context'].update(native_flags=['--ensure']),
                       lambda s: s['context'].update(candidate_basename='/tmp/evil'),
                       lambda s: s['context'].update(request_path='/tmp/request.json'),
                       lambda s: s['environment'].update(NVIDIA_VISIBLE_DEVICES='all'),
                       lambda s: s['mounts'][0].update(target='/source'),
                       lambda s: s['mounts'][0].update(subpath='')]:
            spec = deepcopy(original)
            change(spec)
            with self.assertRaises(ValueError):
                namespace.create_args(spec, name='claimed-recovery')

    def test_installed_package_requires_explicit_role_and_context_agreement(self):
        self.kwargs['use_installed_package'] = True
        spec = self.spec()
        self.assertEqual(spec['package_role'], 'installed')
        self.assertTrue(json.loads(namespace.create_args(spec, name='claimed-recovery')[-1])['use_installed_package'])
        spec['context']['use_installed_package'] = False
        with self.assertRaises(ValueError):
            namespace.create_args(spec, name='claimed-recovery')
        self.kwargs['use_installed_package'] = 'true'
        with self.assertRaises(ValueError):
            self.spec()

    def test_installed_executor_refuses_wrong_current_receipt_without_candidate_fallback(self):
        self.kwargs['use_installed_package'] = True
        context = self.spec()['context']
        native = deepcopy(self.native)
        request_raw = json.dumps(native).encode()
        context['request_sha256'] = hashlib.sha256(request_raw).hexdigest()
        records = {context['request_path']: request_raw,
                   context['config_path']: b'config', context['attestation_path']: b'attestation',
                   '/opt/fullmag/package/backend-build-receipt.json': b'wrong-current-receipt'}
        native['interruption']['pins']['config_sha256'] = hashlib.sha256(b'config').hexdigest()
        records[context['request_path']] = json.dumps(native).encode()
        context['request_sha256'] = hashlib.sha256(records[context['request_path']]).hexdigest()
        context['attestation_sha256'] = hashlib.sha256(b'attestation').hexdigest()
        read_paths = []
        def read_regular(path, maximum):
            path = str(path)
            read_paths.append(path)
            return records[path]
        previous_path = list(sys.path)
        try:
            with patch.dict(sys.modules, {'linux_native_probe': SimpleNamespace(read_regular=read_regular)}), \
                 patch.object(sys, 'argv', ['executor', json.dumps(context)]), \
                 patch('pathlib.Path.glob', return_value=[]), patch('pathlib.Path.exists', return_value=False):
                with self.assertRaisesRegex(RuntimeError, 'Pinned bytes differ: /opt/fullmag/package/backend-build-receipt.json'):
                    exec(namespace.EXECUTOR, {})
        finally:
            sys.path[:] = previous_path
        self.assertEqual(read_paths[-1], '/opt/fullmag/package/backend-build-receipt.json')
        self.assertFalse(any('/.development/' in value for value in read_paths))

    def test_installed_executor_rejects_current_provenance_for_another_receipt(self):
        self.kwargs['use_installed_package'] = True
        spec = self.spec()
        context = spec['context']
        native = deepcopy(self.native)
        native['build_commit'] = 'a'*40
        pins = native['interruption']['pins']
        executable = b'pinned administrative binary'
        pins['config_sha256'] = hashlib.sha256(b'config').hexdigest()
        pins['executable_sha256'] = hashlib.sha256(executable).hexdigest()
        receipt = dict(schema='fullmag.direct-compose.backend-build-receipt.v1', state='succeeded',
                       source=dict(resolved_commit=native['build_commit'], source_snapshot_sha256=pins['source_snapshot_sha256']),
                       artifacts=[dict(path='bin/fullmag-runtime-service', sha256=pins['executable_sha256'], size=len(executable))],
                       toolchain=dict(image_id='sha256:'+'f'*64), build=dict(cargo_profile='backend-dev'))
        receipt_raw = json.dumps(receipt).encode()
        pins['package_receipt_sha256'] = hashlib.sha256(receipt_raw).hexdigest()
        provenance = dict(schema='fullmag.docker-all-image.v1', state='succeeded', source_mode='live-shadow-v1',
                          commit=native['build_commit'], source_snapshot_sha256=pins['source_snapshot_sha256'],
                          build_receipt_sha256='0'*64, package_root='/opt/fullmag/package',
                          backend_build_receipt='/opt/fullmag/package/backend-build-receipt.json',
                          cargo_profile='backend-dev', toolchain_image_id='sha256:'+'f'*64)
        records = {context['request_path']: json.dumps(native).encode(), context['config_path']: b'config',
                   context['attestation_path']: b'attestation', '/opt/fullmag/package/backend-build-receipt.json': receipt_raw,
                   '/opt/fullmag/package/bin/fullmag-runtime-service': executable,
                   '/opt/fullmag/control/backend/runtime-provenance.json': json.dumps(provenance).encode()}
        context['request_sha256'] = hashlib.sha256(records[context['request_path']]).hexdigest()
        context['attestation_sha256'] = hashlib.sha256(b'attestation').hexdigest()
        previous_path = list(sys.path)
        try:
            with patch.dict(sys.modules, {'linux_native_probe': SimpleNamespace(read_regular=lambda path, maximum: records[str(path)])}), \
                 patch.object(sys, 'argv', ['executor', json.dumps(context)]), \
                 patch.dict('os.environ', spec['environment']), \
                 patch('pathlib.Path.glob', return_value=[]), patch('pathlib.Path.exists', return_value=False):
                with self.assertRaisesRegex(RuntimeError, 'Canonical runtime provenance/development identity differs'):
                    exec(namespace.EXECUTOR, {})
        finally:
            sys.path[:] = previous_path

    def test_development_environment_requires_exact_toolchain_and_profile(self):
        original = deepcopy(self.target['Config']['Env'])
        for entries in [[e for e in original if not e.startswith('FULLMAG_TOOLCHAIN_IMAGE_ID=')],
                        [e.replace('FULLMAG_BACKEND_CARGO_PROFILE=backend-dev', 'FULLMAG_BACKEND_CARGO_PROFILE=release') for e in original],
                        [e.replace('FULLMAG_TOOLCHAIN_IMAGE_ID=sha256:', 'FULLMAG_TOOLCHAIN_IMAGE_ID=tag:') for e in original]]:
            self.target['Config']['Env'] = entries
            self.repin_config()
            with self.assertRaises(ValueError):
                self.spec()

    def test_request_directory_and_candidate_scope_refused(self):
        for key, value in [('request_path', namespace.CONTROL+'/request.json'),
                           ('attestation_path', '/tmp/attestation.json'),
                           ('config_path', '/tmp/config.json'),
                           ('candidate_basename', '../current'),
                           ('verify_only', '--ensure')]:
            with self.subTest(key=key):
                old = self.kwargs[key]
                self.kwargs[key] = value
                with self.assertRaises(ValueError):
                    self.spec()
                self.kwargs[key] = old


if __name__ == '__main__':
    unittest.main()
