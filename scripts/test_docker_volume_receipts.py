"""Interpreted regressions for Docker-managed receipt boundaries; no native build."""
from pathlib import Path
import tempfile
import unittest
import sys
import importlib.util
import subprocess
from unittest import mock

import docker_backend_volume_cache as cache
from test_docker_backend_volume_cache import _profile, _maintenance_receipt, DockerVolumeFixture
from docker_build_control import BuildControl, BuildControlError, ControlOutcomeUnknown, bounded_capture


class VolumeReceiptTests(unittest.TestCase):
    def test_recreation_preserves_gpu_intent_before_observing_services(self):
        import hashlib
        from types import SimpleNamespace
        import docker_volume_dev as dev
        import docker_dev
        import docker_build_control
        document = {"name": "fullmag-master"}
        digest = hashlib.sha256(dev.canonical(document)).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory).resolve()
            for policy in ("auto", "required", "disabled", None, "unknown"):
                with self.subTest(policy=policy):
                    args = SimpleNamespace(repo_root=source, source_root=source,
                                           attempt="a" * 32, config_sha256=digest)
                    previous = {"state": "failed-confirmed", "compose_project": document["name"],
                                "inputs": {"source_root": str(source), "gpu_access_requested": policy,
                                           "image_id": "sha256:" + "b" * 64}}
                    control = mock.Mock(project=document["name"])
                    control.read.side_effect = [previous, document]
                    configuration = {"services": {"fem-gpu-toolchain": {"build": {"args": {
                        "FULLMAG_CUDA_BASE_IMAGE": "unused"}}}}}
                    with mock.patch.object(docker_dev, "_select_source", return_value=(source, {})), \
                         mock.patch.object(docker_dev, "_compose_identity", return_value={}), \
                         mock.patch.object(docker_build_control, "toolchain_configuration", return_value=configuration), \
                         mock.patch.object(dev, "BuildControl", return_value=control), \
                         mock.patch.object(dev, "_operator_probe_record_from_retained", return_value={}), \
                         mock.patch.object(dev, "compose_capture", side_effect=RuntimeError("observing services")) as capture:
                        if policy in {"auto", "required", "disabled"}:
                            with self.assertRaisesRegex(RuntimeError, "observing services"):
                                dev._retained_operation(args, recreate_services=True)
                            self.assertEqual(args.gpu_access, policy)
                        else:
                            with self.assertRaisesRegex(BuildControlError, "retained GPU access intent"):
                                dev._retained_operation(args, recreate_services=True)
                            capture.assert_not_called()

    def test_runtime_supervisor_accepts_only_fixed_provenance_locations(self):
        path = Path(__file__).resolve().parents[1] / 'docker/all-in-one/runtime_service.py'
        spec = importlib.util.spec_from_file_location('volume_runtime_paths_test', path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        self.assertEqual(module.canonical_paths({}).provenance, Path('/opt/fullmag/provenance.json'))
        self.assertEqual(module.canonical_paths({'FULLMAG_PACKAGE_PROVENANCE':'/build/provenance.json'}).provenance,
                         Path('/build/provenance.json'))
        control_provenance = '/opt/fullmag/control/backend/runtime-provenance.json'
        self.assertEqual(module.canonical_paths({'FULLMAG_PACKAGE_PROVENANCE': control_provenance}).provenance,
                         Path(control_provenance))
        with self.assertRaises(module.RuntimeServiceError):
            module.canonical_paths({'FULLMAG_PACKAGE_PROVENANCE':'/state/user-data.json'})

    def test_successful_ledger_probe_is_archived_and_retired_before_backend_observation(self):
        import json
        import os
        import docker_volume_dev as dev
        import docker_host_ledger as ledger
        import fullmag_docker_runtime as runtime
        from subprocess import CompletedProcess
        control = mock.Mock(project='fullmag-master', volume='fullmag-control-test')
        operation = {'root': 'resume/attempts/check', 'receipt': {'attempt': 'a' * 32}}
        written = {}
        events = []
        control.write.side_effect = lambda path, value: written.__setitem__(path, value)
        image = 'sha256:' + 'b' * 64
        probe_id = 'c' * 64
        probe_name = 'fullmag-ledger-verify-' + 'a' * 32
        def text(*arguments, **kwargs):
            if arguments == ('inspect', probe_name):
                return json.dumps([{'Id': probe_id, 'Image': image,
                    'State': {'Running': False, 'ExitCode': 0},
                    'Config': {'Labels': {'com.docker.compose.project': control.project}}}])
            if arguments == ('logs', probe_name):
                return 'successful verify log'
            if arguments == ('inspect', 'backend-id'):
                return json.dumps([{'Id': 'backend-id'}])
            raise AssertionError(arguments)
        def retire(*arguments, **kwargs):
            self.assertEqual(arguments, ('rm', probe_id))
            self.assertIn(operation['root'] + '/ledger-verify-log.json', written)
            self.assertIn(operation['root'] + '/ledger-verify-receipt.json', written)
            events.append('retired')
            return CompletedProcess([], 0, b'', b'')
        def failed_backend(*arguments):
            events.append('backend-observation')
            raise BuildControlError('backend exited')
        with mock.patch.object(dev, '_operator_probe_record_from_retained', return_value={}), \
             mock.patch.object(dev, '_wait_for_publication', return_value=({}, {})), \
             mock.patch.object(dev, 'compose_capture', return_value=b''), \
             mock.patch.object(dev, 'docker_text', side_effect=text), \
             mock.patch.object(dev, 'docker_capture', side_effect=retire), \
             mock.patch.object(runtime, '_assembly_from_backend_start', return_value={}), \
             mock.patch.object(runtime, '_complete_backend_storage_preflight'), \
             mock.patch.object(dev, '_session_host'), \
             mock.patch.object(ledger, '_parse_json_lines', return_value={'schema': 'verified'}), \
             mock.patch.object(ledger, '_validate_host_receipt'), \
             mock.patch.object(ledger, 'validate_container', side_effect=failed_backend):
            with self.assertRaisesRegex(BuildControlError, 'backend exited'):
                dev._finish(control, operation,
                    {'services': {'backend': {'environment': {'FULLMAG_DOCKER_DEVICE_ACCESS': 'gpu'}}}},
                    'backend-id', 'frontend-id', Path('/source'), Path('/state'), Path('/certificate'),
                    {'restart_verified': True, 'storage_profile':
                     'windows-folder-v1' if os.name == 'nt' else 'linux-native-v1'},
                    {}, {'image_id': image}, image, Path('/git'),
                    {'maintenance_document': {}, 'project_id': 'project',
                     'mount_root': '/ledger', 'backing_image': '/ledger.ext4'}, 3197)
        self.assertEqual(events, ['retired', 'backend-observation'])

    def test_invalid_compose_stops_before_daemon_mutation_boundary(self):
        import docker_volume_dev as dev
        operation = {'receipt': {}, 'daemon_pending': False}
        control = mock.Mock(project='fullmag-master')
        with mock.patch.object(dev, 'compose_capture', side_effect=BuildControlError('undefined volume')) as capture:
            with self.assertRaisesRegex(BuildControlError, 'undefined volume'):
                dev._start_compose_services(control, operation, {'name': control.project})
        self.assertFalse(operation['daemon_pending'])
        self.assertEqual(capture.call_args.args[1:], ('config', '--format', 'json'))

    def test_toolchain_config_binds_context_before_compose_interpolation(self):
        import json
        import os
        from subprocess import CompletedProcess
        import docker_build_control as control
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory).resolve()
            with mock.patch.dict(os.environ, {'FULLMAG_TOOLCHAIN_CONTEXT': '/wrong/checkout'}), \
                 mock.patch.object(control, 'docker_capture', return_value=CompletedProcess([], 0, b'{}', b'')) as capture:
                self.assertEqual(control.toolchain_configuration(repo, {'project_name': 'fullmag-master'}), {})
            environment = capture.call_args.kwargs['env']
            self.assertEqual(environment['FULLMAG_TOOLCHAIN_CONTEXT'], str(repo))
            self.assertEqual(environment['FULLMAG_COMPOSE_PROJECT'], 'fullmag-master')
            self.assertTrue(environment['FULLMAG_BUILD_CONTROL_VOLUME'])

    def test_retained_operator_controls_ignore_host_changes_and_reject_overlay_drift(self):
        import copy
        import os
        import docker_volume_dev as dev
        values = {'FULLMAG_MIXED_P1_DEVICE': 'cpu', 'FULLMAG_ARTIFACT_FIELD_STORAGE': 'zarr'}
        record = dev._operator_probe_record(values)
        document = {'services': {
            'backend': {'environment': {'FULLMAG_MIXED_P1_DEVICE': 'gpu',
                                        'FULLMAG_ARTIFACT_FIELD_STORAGE': 'json'}},
            'frontend': {'environment': {}, 'volumes': [{
                'source': 'build-control', 'target': '/opt/fullmag/control',
                'read_only': True, 'volume': {'subpath': 'frontend'}}]},
        }}
        dev._reassert_operator_probe_environment(document, record)
        with mock.patch.dict(os.environ, {'FULLMAG_MIXED_P1_DEVICE': 'gpu'}):
            self.assertEqual(dev._operator_probe_record_from_retained(record, document), record)
        changed = copy.deepcopy(document)
        changed['services']['backend']['environment']['FULLMAG_MIXED_P1_DEVICE'] = 'gpu'
        with self.assertRaisesRegex(BuildControlError, 'differs from its receipt'):
            dev._operator_probe_record_from_retained(record, changed)
        changed = copy.deepcopy(document)
        changed['services']['frontend']['volumes'][0]['volume'].pop('subpath')
        with self.assertRaisesRegex(BuildControlError, 'restricted control-volume subpath'):
            dev._operator_probe_record_from_retained(record, changed)
        with self.assertRaisesRegex(BuildControlError, 'digest'):
            dev._operator_probe_record_from_fields({**record, 'operator_probe_environment_sha256': '0'*64}, label='test')

    def test_previous_package_is_ignored_until_current_start_handoff(self):
        import json
        import subprocess
        import docker_volume_dev as dev
        operation = {'receipt': {}, 'root': 'test'}
        control = mock.Mock()
        started = json.dumps([{'State': {'Running': True, 'StartedAt': 'current'}}])
        observations = iter([started, 'building', started, 'phase=start state=cache-hit phase=start state=handoff'])
        documents = {'receipt': {'value': {'state': 'succeeded'}, 'sha256': 'digest'},
                     'provenance': {'value': {'state': 'succeeded', 'build_receipt_sha256': 'digest'}}}
        with mock.patch.object(dev, 'docker_text', side_effect=lambda *a, **k: next(observations)), \
             mock.patch.object(dev, 'docker_capture', return_value=subprocess.CompletedProcess([], 0, json.dumps(documents).encode(), b'')) as capture, \
             mock.patch.object(dev.time, 'sleep', side_effect=lambda *_: self.assertEqual(capture.call_count, 0)):
            receipt, provenance = dev._wait_for_publication(control, operation, 'backend')
        self.assertEqual(capture.call_count, 1)
        self.assertTrue(operation['receipt']['backend_package_cache_hit'])
        self.assertEqual(provenance['build_receipt_sha256'], 'digest')

    def test_publication_refuses_a_changed_backend_incarnation(self):
        import json
        import docker_volume_dev as dev
        observations = iter([json.dumps([{'State': {'Running': True, 'StartedAt': 'first'}}]), 'building',
                             json.dumps([{'State': {'Running': True, 'StartedAt': 'second'}}])])
        with mock.patch.object(dev, 'docker_text', side_effect=lambda *a, **k: next(observations)), \
             mock.patch.object(dev, 'docker_capture') as capture, mock.patch.object(dev.time, 'sleep'):
            with self.assertRaisesRegex(BuildControlError, 'incarnation changed'):
                dev._wait_for_publication(mock.Mock(), {'receipt': {}, 'root': 'test'}, 'backend')
        capture.assert_not_called()

    def test_retained_service_rejects_volume_or_command_drift_before_mutation(self):
        import copy
        import docker_volume_dev as dev
        expected = {'environment': {'SOURCE': 'selected'}, 'labels': {'owner': 'task'},
                    'volumes': [{'type': 'volume', 'source': 'build', 'target': '/build'}]}
        document = {'services': {'backend': expected}, 'volumes': {'build': {'name': 'owned-build'}}}
        image = {'Entrypoint': ['trusted-helper'], 'Cmd': ['serve']}
        actual = {'Config': {'Env': ['SOURCE=selected'], 'Labels': {'owner': 'task'}, **image},
                  'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'Tmpfs': {}},
                  'Mounts': [{'Destination': '/build', 'Type': 'volume', 'RW': True, 'Name': 'owned-build'}]}
        actual['State'] = {'StartedAt': 'first-start'}
        dev._validate_retained_service(document, actual, 'backend', image, expected_started_at='first-start')
        changed = copy.deepcopy(actual)
        changed['State']['StartedAt'] = 'replacement-start'
        with self.assertRaisesRegex(BuildControlError, 'incarnation changed'):
            dev._validate_retained_service(document, changed, 'backend', image, expected_started_at='first-start')
        changed = copy.deepcopy(actual)
        changed['Mounts'][0]['Name'] = 'foreign-build'
        with self.assertRaisesRegex(BuildControlError, 'named-volume identity'):
            dev._validate_retained_service(document, changed, 'backend', image)
        changed = copy.deepcopy(actual)
        changed['Config']['Entrypoint'] = ['foreign-command']
        with self.assertRaisesRegex(BuildControlError, 'image command'):
            dev._validate_retained_service(document, changed, 'backend', image)

    def test_restart_refuses_public_backend_or_foreign_bridge_consumers(self):
        import json
        import docker_volume_dev as dev
        ids = {'backend': 'backend-id', 'frontend': 'frontend-id'}
        actual = {'backend': {'HostConfig': {'PortBindings': {}},
                             'NetworkSettings': {'Networks': {'private': {}}}}}
        network = [{'Driver': 'bridge', 'Labels': {'com.docker.compose.project': 'owned'},
                    'Containers': {'backend-id': {}, 'frontend-id': {}}}]
        with mock.patch.object(dev, 'docker_text', return_value=json.dumps(network)):
            dev._assert_private_restart_network(actual, ids, 'owned')
        network[0]['Containers']['foreign-id'] = {}
        with mock.patch.object(dev, 'docker_text', return_value=json.dumps(network)):
            with self.assertRaisesRegex(BuildControlError, 'unknown consumers'):
                dev._assert_private_restart_network(actual, ids, 'owned')
        actual['backend']['HostConfig']['PortBindings'] = {'8081/tcp': [{}]}
        with mock.patch.object(dev, 'docker_text') as inspect:
            with self.assertRaisesRegex(BuildControlError, 'unpublished private backend'):
                dev._assert_private_restart_network(actual, ids, 'owned')
        inspect.assert_not_called()

    def test_frontend_volume_keeps_its_existing_ownership_labels(self):
        import json
        from subprocess import CompletedProcess
        import docker_volume_dev as dev
        control = BuildControl({'project_name': 'fullmag-master', 'worktree_id': 'owned', 'project_id': 'test-project', 'checkout_kind': 'master'}, 'sha256:' + 'a' * 64)
        key = 'b' * 64
        name = 'fullmag-dev-frontend-v1-' + key[:24]
        labels = {k: v for k, v in control.labels.items() if k.startswith('org.fullmag.')}
        labels.update({'org.fullmag.build.role': 'frontend', 'org.fullmag.build.cache-key': key})
        volume = {'Name': name, 'Driver': 'local', 'Options': None, 'Labels': labels}
        with mock.patch.object(dev, 'docker_capture', return_value=CompletedProcess([], 0, json.dumps([volume]).encode(), b'')) as docker, \
             mock.patch.object(dev, 'consumers', return_value=[]), \
             mock.patch.object(dev, 'bounded_capture', return_value=CompletedProcess([], 0, b'', b'')):
            self.assertEqual(dev._owned_volume(control, 'frontend', key), name)
            docker.assert_called_once_with('volume', 'inspect', name, allow_failure=True)

    def test_build_control_accepts_canonical_bootstrap_labels_and_rejects_foreign_project(self):
        identity = {'project_name': 'fullmag-master', 'worktree_id': 'test-worktree', 'project_id': 'test-project', 'checkout_kind': 'master'}
        control = BuildControl(identity, 'sha256:' + 'a' * 64)
        volume = {'Name': control.volume, 'Driver': 'local', 'Options': None,
                  'Labels': dict(control.shared_labels)}
        import json
        from subprocess import CompletedProcess
        with mock.patch('docker_build_control.docker_capture', return_value=CompletedProcess([], 0, json.dumps([volume]).encode(), b'')), \
             mock.patch('docker_build_control.bounded_capture', return_value=CompletedProcess([], 0, b'', b'')), \
             mock.patch.object(control, 'space', return_value={'available_bytes': 100 * 1024**3}):
            self.assertEqual(control.prepare(), volume)
            volume['Labels']['com.fullmag.compose.project'] = 'fullmag-other'
        with mock.patch('docker_build_control.docker_capture', return_value=CompletedProcess([], 0, json.dumps([volume]).encode(), b'')):
            with self.assertRaisesRegex(BuildControlError, 'ownership'):
                control.prepare()

    def test_control_output_and_input_are_bounded_without_host_files(self):
        result = bounded_capture([sys.executable, '-B', '-c', 'import sys;sys.stdout.buffer.write(sys.stdin.buffer.read())'], data=b'expected', maximum=128)
        self.assertEqual(result.stdout, b'expected')
        with self.assertRaises(ControlOutcomeUnknown):
            bounded_capture([sys.executable, '-B', '-c', 'print("x"*1024)'], maximum=128)
        with self.assertRaises(ControlOutcomeUnknown):
            bounded_capture([sys.executable, '-B', '-c', 'import time;time.sleep(10)'], timeout=0.05)

    def test_admitted_volume_receipt_never_uses_a_host_writer(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile, layout, source, repo, runroot = _profile(temporary)
            profile = cache.prepare(layout, repo, profile['runtime_image_id'], runroot,
                source_root=source, toolchain_image=profile['toolchain_image_id'],
                control_volume_name=profile['volume_names'][cache.CONTROL_VOLUME_ROLE])
            volumes = DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES)
            before = sorted(Path(temporary).rglob('*'))
            with mock.patch.object(Path, 'write_text', side_effect=AssertionError('host receipt write')), \
                 mock.patch.object(Path, 'write_bytes', side_effect=AssertionError('host receipt write')):
                ready = cache.validate(profile, volumes.documents, _maintenance_receipt(profile))
            self.assertEqual(ready['state'], 'ready')
            self.assertEqual(ready['receipt_path'], cache.RECEIPT_TARGET)
            self.assertEqual(ready['receipt']['receipt_path'], cache.RECEIPT_TARGET)
            self.assertEqual(ready['receipt']['receipt_storage'], 'docker-named-volume')
            self.assertIsNone(ready['receipt']['host_receipt_path'])
            self.assertEqual(sorted(Path(temporary).rglob('*')), before)
            self.assertFalse((Path(runroot)/cache.RECEIPT_NAME).exists())

    def test_volume_receipt_cannot_escape_or_redirect_its_declared_location(self):
        with tempfile.TemporaryDirectory() as temporary:
            profile, *_ = _profile(temporary)
            volumes = DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES)
            for location in ('docker-volume://owned/../../other/cache.json', 'C:/host/receipt.json',
                             '/opt/fullmag/control/backend/../other.json',
                             '/opt/fullmag/control/other.json'):
                with self.subTest(location=location):
                    with self.assertRaises(cache.BackendVolumeCacheError):
                        cache.validate(profile, volumes.documents, _maintenance_receipt(profile),
                                       receipt_path=location)

    def test_just_guard_admits_device_policy_without_shell_tail(self):
        from test_just_orphan_recovery_shell import DockerDevelopmentShellBoundaryTests
        guard = DockerDevelopmentShellBoundaryTests()
        base = 'python "D:/repo/scripts/docker_dev.py" --repo-root "D:/repo" '
        for action in ('build', "up --port '3202'"):
            for policy in ('auto', 'required', 'disabled'):
                recipe = base + action + " --gpu-access '" + policy + "' --source-root 'D:/owned/worktree' "
                for suffix, expected in (('', 0), ('; echo injected', 2)):
                    with self.subTest(action=action, policy=policy, suffix=suffix):
                        result = guard.dispatch(recipe + suffix)
                        self.assertEqual(result.returncode, expected, result.stderr)
                        self.assertNotIn('injected', result.stdout)

    def test_control_paths_cannot_address_host_or_parent_files(self):
        for path in ('../active', '/control/active', '/opt/fullmag/control/active', 'a/../../active', 'C:/host/data', "a'; touch /bad"):
            with self.assertRaises(BuildControlError):
                BuildControl.path(path)


if __name__ == '__main__':
    unittest.main()
