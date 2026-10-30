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


class IsolatedReceiptTests(unittest.TestCase):
    def setUp(self):
        # Namespace lookup is an external Docker boundary, tested separately.
        namespace = mock.patch('docker_control_namespace.resolve_namespace')
        namespace.start()
        self.addCleanup(namespace.stop)


class IncludeUntrackedPathTests(unittest.TestCase):
    def test_unicode_windows_device_names_are_rejected_in_any_component(self):
        from docker_volume_dev import normalize_include_untracked_paths
        for prefix in ('COM', 'lpt'):
            for digit in ('\u00b9', '\u00b2', '\u00b3'):
                for path in (prefix + digit + '.py', 'examples/' + prefix + digit + '/source.py'):
                    with self.subTest(path=path), self.assertRaisesRegex(BuildControlError, 'Windows device name'):
                        normalize_include_untracked_paths([path])

    def test_ordinary_unicode_and_nonreserved_numbered_names_remain_valid(self):
        from docker_volume_dev import normalize_include_untracked_paths
        paths = ['examples/COM\u0105.py', 'examples/LPT\u0142.py', 'examples/COM0.py', 'examples/LPT10.py']
        self.assertEqual(normalize_include_untracked_paths(paths), sorted(paths))


class VolumeReceiptTests(IsolatedReceiptTests):
    def test_recreation_preserves_gpu_intent_before_observing_services(self):
        import hashlib
        from types import SimpleNamespace
        import docker_volume_dev as dev
        import docker_volume_cancelled_activation_guard
        import docker_dev
        import docker_build_control
        project_name = "fullmag-master"
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory).resolve()
            for policy in ("auto", "required", "disabled", None, "unknown"):
                with self.subTest(policy=policy):
                    retained_policy = policy if policy in {"auto", "required", "disabled"} else "auto"
                    document = {
                        "name": project_name,
                        "services": {
                            "backend": {
                                "gpus": [] if retained_policy == "disabled" else [{"count": "all"}],
                                "environment": {
                                    "FULLMAG_DOCKER_DEVICE_ACCESS": "cpu" if retained_policy == "disabled" else "gpu",
                                    "FULLMAG_DEV_INCLUDE_UNTRACKED": "[]",
                                    "FULLMAG_RUNTIME_IMAGE_ID": "sha256:" + "b" * 64,
                                    "FULLMAG_TOOLCHAIN_IMAGE_ID": "sha256:" + "c" * 64,
                                    "FULLMAG_PACKAGE_PROVENANCE": "/opt/fullmag/control/backend/runtime-provenance.json",
                                    "FULLMAG_RUNTIME_PROVENANCE": "/opt/fullmag/control/backend/runtime-provenance.json",
                                    "FULLMAG_DEVELOPMENT_INPUTS_PATH": "/opt/fullmag/control/frontend/development-inputs.json",
                                },
                            },
                        },
                    }
                    digest = hashlib.sha256(dev.canonical(document)).hexdigest()
                    args = SimpleNamespace(repo_root=source, source_root=source,
                                           attempt="a" * 32, config_sha256=digest)
                    previous = {"state": "failed-confirmed", "compose_project": project_name,
                                "inputs": {"source_root": str(source), "gpu_access_requested": policy,
                                           "device_access": "cpu" if retained_policy == "disabled" else "gpu",
                                           "gpu_preflight": "NOT_REQUIRED" if retained_policy == "disabled" else "PASS",
                                           "image_id": "sha256:" + "b" * 64}}
                    control = mock.Mock(project=project_name)
                    # Retained receipt, its Compose document, then no aborted preparation.
                    control.read.side_effect = [previous, document, None]
                    configuration = {"services": {"fem-gpu-toolchain": {"build": {"args": {
                        "FULLMAG_CUDA_BASE_IMAGE": "unused"}}}}}
                    with mock.patch.object(docker_dev, "_select_source", return_value=(source, {})), \
                         mock.patch.object(docker_dev, "_compose_identity", return_value={}), \
                         mock.patch.object(docker_build_control, "toolchain_configuration", return_value=configuration), \
                         mock.patch.object(dev, "BuildControl", return_value=control), \
                         mock.patch.object(docker_volume_cancelled_activation_guard, "_read_control_bytes", return_value=None), \
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
        def storage_ready(*arguments, **kwargs):
            events.append('storage-ready')
        def delegate(*arguments):
            self.assertIn('storage-ready', events)
            events.append('cgroup-ready')
        def failed_backend(*arguments):
            events.append('backend-observation')
            raise BuildControlError('backend exited')
        with mock.patch.object(dev, '_operator_probe_record_from_retained', return_value={}), \
             mock.patch.object(dev, '_wait_for_publication', return_value=({}, {})), \
             mock.patch.object(dev, 'compose_capture', return_value=b''), \
             mock.patch.object(dev, 'docker_text', side_effect=text), \
             mock.patch.object(dev, 'docker_capture', side_effect=retire), \
             mock.patch.object(runtime, '_assembly_from_backend_start', return_value={}), \
             mock.patch.object(runtime, '_complete_backend_storage_preflight', side_effect=storage_ready), \
             mock.patch.object(dev, '_session_host', return_value=mock.Mock(complete_preflight=storage_ready)), \
             mock.patch('docker_worker_cgroup.ensure_delegation', side_effect=delegate), \
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
        self.assertEqual(events, ['storage-ready', 'cgroup-ready', 'retired', 'backend-observation'])

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
                 mock.patch('docker_dev_defaults._known_checkouts', return_value=(repo,)), \
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
        with mock.patch('docker_control_namespace.resolve_namespace', return_value=None):
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
        with mock.patch('docker_control_namespace.resolve_namespace', return_value=None):
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




class SavedAuthoringRestartTests(IsolatedReceiptTests):
    def fixture(self):
        import copy, hashlib, io, json, zipfile
        import docker_volume_dev as dev
        from docker_build_control import canonical
        scene = {'version': 'scene.v2', 'revision': 1, 'scene': {'scene_id': 'scene-one'}, 'objects': []}
        source = b'from fullmag import *\n'
        digest = hashlib.sha256(source).hexdigest()
        definition = {'schema': 'fullmag.project.v1', 'project_id': 'project-one', 'revision': 2, 'scene': scene}
        files = {'project/definition.json': canonical(definition), 'project/scene_document.json': canonical(scene),
                 'project/source/script.py': source, 'project/source/script.json': canonical({'sha256': digest}),
                 'project/provenance.json': canonical({'runs': []})}
        manifest = {'format': 'fullmag.project.archive.v1', 'project_schema': 'fullmag.project.v1',
            'scene_schema': 'scene.v2', 'definition': 'project/definition.json', 'scene': 'project/scene_document.json',
            'source': None, 'assets': [], 'opaque_documents': ['project/source/script.py',
                'project/source/script.json', 'project/provenance.json']}
        files['manifest/project.json'] = canonical(manifest)
        def pack(entries):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, 'w') as archive:
                for name, value in entries.items(): archive.writestr(name, value)
            return stream.getvalue()
        raw = pack(files)
        from docker_volume_reconcile import fingerprint
        actual = {}
        for n, name in enumerate(('backend', 'frontend')):
            actual[name] = {'Id': str(n + 1) * 64, 'Image': 'sha256:' + 'a' * 64,
                'Config': {'Labels': {'com.docker.compose.project': 'fullmag-test', 'com.docker.compose.service': name}},
                'HostConfig': {}, 'Mounts': [], 'State': {'Running': True, 'StartedAt': 'exact-start'}}
        owner = {'owner_token': 'owner', 'process_start_token': 'start', 'pid': 1, 'host': 'host', 'target_id': 'target',
            'control_address': 'address', 'build_commit': 'commit', 'build_snapshot': 'snapshot',
            'compute_pool_id': 'compute', 'preparation_pool_id': 'preparation',
            'compute_pool_generation': 'compute-gen', 'preparation_pool_generation': 'prep-gen',
            'children': [{'role': 'compute', 'pid': 2}, {'role': 'preparation', 'pid': 3}]}
        request = {'schema': 'fullmag.saved-authoring-restart.v1', 'compose_project': 'fullmag-test',
            'attempt': 'b' * 32, 'config_sha256': 'c' * 64, 'source_root': '/selected',
            'exclusive_operator_window': True, 'archive': {'path': 'D:/state/runs/projects/own.fms',
                'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'project_id': 'project-one',
                'project_revision': 2, 'scene_revision': 1, 'scene_sha256': hashlib.sha256(canonical(scene)).hexdigest(),
                'source_entry': 'project/source/script.py', 'source_sha256': digest},
            'session': {'api_instance_id': 'api-one', 'session_id': 'session-one', 'session_epoch': 'session-one@123',
                'request_scope_epoch': 'api-one:4', 'source_kind': 'ui_authoring'},
            'containers': {name: {'id': a['Id'], 'image': a['Image'], 'started_at': a['State']['StartedAt'],
                                 'fingerprint': fingerprint(a)} for name, a in actual.items()},
            'package': {'provenance_sha256': 'd' * 64, 'source_snapshot_sha256': 'e' * 64},
            'service_owner_sha256': hashlib.sha256(canonical(owner)).hexdigest()}
        current = {'current': True, 'session_id': 'session-one', 'status': 'awaiting_command', 'script': None, 'script_path': ''}
        status = {'session': request['session'].copy(), 'run': None, 'solver': {'state': 'idle'}, 'resources': {'scene_revision': 1}}
        rows = {}
        def row(name, body, status=200):
            rows[name] = {'status': status, 'body': copy.deepcopy(body), 'api_instance_id': 'api-one'}
        for suffix in ('before', 'after'):
            row('current_' + suffix, current);row('status_' + suffix, status);row('scene_' + suffix, scene)
        row('health', {'status': 'ok', 'active_session': True})
        row('queue', {'schema_version': 'compute_queue.v1', 'items': []})
        row('runtime', {'configured': True, 'state': 'ready', 'reason': {'code': 'service_ready'}})
        row('commands', {'commands': [], **{k: 0 for k in ('pending_count', 'accepted_count', 'dispatched_count',
            'running_count', 'completed_count', 'rejected_count', 'failed_count')}})
        for name in ('run', 'preparation', 'mesh', 'mesh_history'): row(name, {}, 404)
        row('mesh_manifest', None, 204)
        row('project_open', {'project_id': 'project-one', 'revision': 2, 'schema_version': 'fullmag.project.v1',
                            'mode': {'kind': 'read_write'}})
        proof = {'schema': 'fullmag.saved-authoring-restart-probe.v1', 'resources': rows,
            'run_directories': [], 'transient_files': [], 'reservation_states': [], 'accepted_store_id': 'sha256:' + 'a' * 64,
            'process_receipt': {'schema': 'fullmag.docker-process-tree.v1', 'state': 'ready', 'service_owner': owner},
            **request['package']}
        return dev, request, scene, raw, files, pack, actual, proof

    def empty_authoring_fixture(self):
        import copy, hashlib, json
        dev, pin, _, _, files, pack, actual, proof = self.fixture()
        from docker_build_control import canonical
        scene = {
            'version': 'scene.v2', 'revision': 1,
            'scene': {'id': 'scene-one', 'name': 'Empty UI authoring',
                      'source_of_truth': 'ui', 'authoring_schema': '0.3'},
            'objects': [],
        }
        files.pop('project/source/script.py')
        files.pop('project/source/script.json')
        files['project/scene_document.json'] = canonical(scene)
        files['project/definition.json'] = canonical({
            'schema': 'fullmag.project.v1', 'project_id': 'project-one',
            'revision': 2, 'scene': scene,
        })
        files['project/provenance.json'] = canonical({'authors': [], 'history': [], 'runs': []})
        manifest = json.loads(files['manifest/project.json'])
        manifest.update(source=None, assets=[], opaque_documents=['project/provenance.json'])
        files['manifest/project.json'] = canonical(manifest)
        raw = pack(files)
        pin['schema'] = 'fullmag.saved-empty-authoring-restart.v1'
        pin['archive'].update(
            bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
            scene_revision=scene['revision'],
            scene_sha256=hashlib.sha256(canonical(scene)).hexdigest(),
            source_entry=None, source_sha256=None,
        )
        for suffix in ('before', 'after'):
            proof['resources']['scene_' + suffix]['body'] = copy.deepcopy(scene)
            proof['resources']['status_' + suffix]['body']['resources']['scene_revision'] = scene['revision']
        return dev, pin, scene, raw, files, pack, actual, proof

    def test_accepts_exact_durable_authoring_archive_and_scope(self):
        dev, pin, scene, raw, _, _, actual, proof = self.fixture()
        dev._saved_authoring_validate_request(pin, project='fullmag-test', attempt='b' * 32,
                                              config_sha256='c' * 64, selected='/selected')
        self.assertEqual(dev._saved_authoring_validate_archive(raw, pin['archive']), scene)
        dev._saved_authoring_validate_services(pin, actual)
        actual['frontend']['State']['Running'] = False
        dev._saved_authoring_validate_services(pin, actual, quiesced=True)
        dev._saved_authoring_validate_probe(proof, pin, scene)

    def test_accepts_empty_ui_authoring_archive_and_existing_strict_probe(self):
        dev, pin, scene, raw, _, _, _, proof = self.empty_authoring_fixture()
        dev._saved_authoring_validate_request(pin, project='fullmag-test', attempt='b' * 32,
                                              config_sha256='c' * 64, selected='/selected')
        self.assertEqual(dev._saved_authoring_validate_archive(raw, pin['archive']), scene)
        dev._saved_authoring_validate_probe(proof, pin, scene)

    def test_empty_ui_authoring_rejects_populated_scene(self):
        import hashlib
        from docker_build_control import canonical
        dev, pin, scene, _, files, pack, _, _ = self.empty_authoring_fixture()
        populated = {**scene, 'objects': [{'object_id': 'object-one'}]}
        files['project/scene_document.json'] = canonical(populated)
        files['project/definition.json'] = canonical({
            'schema': 'fullmag.project.v1', 'project_id': pin['archive']['project_id'],
            'revision': pin['archive']['project_revision'], 'scene': populated,
        })
        raw = pack(files)
        pin['archive'].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                              scene_sha256=hashlib.sha256(canonical(populated)).hexdigest())
        with self.assertRaisesRegex(BuildControlError, 'empty UI authoring'):
            dev._saved_authoring_validate_archive(raw, pin['archive'])

    def test_empty_ui_authoring_rejects_script_metadata_and_history_entries(self):
        import hashlib, json
        from docker_build_control import canonical
        for path in ('project/source/script.py', 'project/source/script.json',
                     'project/source-history/' + 'f' * 64 + '.py'):
            with self.subTest(path=path):
                dev, pin, _, _, files, pack, _, _ = self.empty_authoring_fixture()
                manifest = json.loads(files['manifest/project.json'])
                manifest['opaque_documents'].append(path)
                files[path] = b'{}'
                files['manifest/project.json'] = canonical(manifest)
                raw = pack(files)
                pin['archive'].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
                with self.assertRaisesRegex(BuildControlError, 'source|history|metadata'):
                    dev._saved_authoring_validate_archive(raw, pin['archive'])

    def test_empty_ui_authoring_rejects_project_history(self):
        import hashlib, json
        from docker_build_control import canonical
        dev, pin, _, _, files, pack, _, _ = self.empty_authoring_fixture()
        provenance = json.loads(files['project/provenance.json'])
        provenance['history'] = [{'kind': 'import'}]
        files['project/provenance.json'] = canonical(provenance)
        raw = pack(files)
        pin['archive'].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        with self.assertRaisesRegex(BuildControlError, 'history'):
            dev._saved_authoring_validate_archive(raw, pin['archive'])

    def test_empty_ui_authoring_requires_both_source_pins_to_be_null(self):
        import copy
        dev, pin, _, _, _, _, _, _ = self.empty_authoring_fixture()
        for source_entry, source_sha256 in (
            ('project/source/script.py', None),
            (None, 'a' * 64),
            ('project/source/script.py', 'a' * 64),
        ):
            with self.subTest(source_entry=source_entry, source_sha256=source_sha256):
                candidate = copy.deepcopy(pin)
                candidate['archive']['source_entry'] = source_entry
                candidate['archive']['source_sha256'] = source_sha256
                with self.assertRaises(BuildControlError):
                    dev._saved_authoring_validate_request(candidate, project='fullmag-test', attempt='b' * 32,
                        config_sha256='c' * 64, selected='/selected')

    def test_empty_ui_authoring_rejects_inherited_restart_extensions(self):
        import copy
        dev, pin, _, _, _, _, _, _ = self.empty_authoring_fixture()
        for extension in ('cancelled_preclaim', 'historical_preclaim', 'retained_run_catalogs'):
            with self.subTest(extension=extension):
                candidate = copy.deepcopy(pin)
                candidate[extension] = {}
                with self.assertRaisesRegex(BuildControlError, 'empty authoring|checkpoint|preclaim|retained'):
                    dev._saved_authoring_validate_request(candidate, project='fullmag-test', attempt='b' * 32,
                        config_sha256='c' * 64, selected='/selected')

    def test_legacy_source_backed_schema_still_requires_source_pins(self):
        import copy
        dev, pin, _, _, _, _, _, _ = self.fixture()
        candidate = copy.deepcopy(pin)
        candidate['archive']['source_entry'] = None
        candidate['archive']['source_sha256'] = None
        with self.assertRaises(BuildControlError):
            dev._saved_authoring_validate_request(candidate, project='fullmag-test', attempt='b' * 32,
                config_sha256='c' * 64, selected='/selected')

    def test_accepts_public_authoring_source_without_rebinding_preserved_script(self):
        import hashlib, json
        from docker_build_control import canonical
        for source_path in ('project/source.py', 'project/source/script.py'):
            with self.subTest(source_path=source_path):
                dev, pin, scene, _, files, pack, _, _ = self.fixture()
                manifest = json.loads(files['manifest/project.json'])
                manifest['source'] = source_path
                if source_path == 'project/source.py':
                    files[source_path] = b'# Canonical source regenerated from the edited scene\n'
                files['manifest/project.json'] = canonical(manifest)
                raw = pack(files)
                pin['archive'].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
                self.assertEqual(dev._saved_authoring_validate_archive(raw, pin['archive']), scene)

    def test_refuses_missing_or_foreign_manifest_authoring_source(self):
        import hashlib, json
        from docker_build_control import canonical
        for source_path in ('project/source.py', 'project/foreign.py', [], {}):
            with self.subTest(source_path=source_path):
                dev, pin, _, _, files, pack, _, _ = self.fixture()
                manifest = json.loads(files['manifest/project.json'])
                manifest['source'] = source_path
                if source_path == 'project/foreign.py':
                    files[source_path] = b'# Unrecognized source path\n'
                files['manifest/project.json'] = canonical(manifest)
                raw = pack(files)
                pin['archive'].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
                with self.assertRaises(BuildControlError):
                    dev._saved_authoring_validate_archive(raw, pin['archive'])

    def test_refuses_changed_saved_bytes_and_runtime_or_duplicate_archive_entries(self):
        import hashlib, io, zipfile
        dev, pin, _, raw, files, pack, _, _ = self.fixture()
        with self.assertRaises(BuildControlError): dev._saved_authoring_validate_archive(raw + b'changed', pin['archive'])
        files['runs/run-one/manifest.json'] = b'{}'
        changed = pack(files)
        pin['archive'].update(bytes=len(changed), sha256=hashlib.sha256(changed).hexdigest())
        with self.assertRaises(BuildControlError): dev._saved_authoring_validate_archive(changed, pin['archive'])
        stream = io.BytesIO(raw)
        with zipfile.ZipFile(stream, 'a') as archive: archive.writestr('project/scene_document.json', b'{}')
        changed = stream.getvalue()
        pin['archive'].update(bytes=len(changed), sha256=hashlib.sha256(changed).hexdigest())
        with self.assertRaises(BuildControlError): dev._saved_authoring_validate_archive(changed, pin['archive'])

    def test_refuses_different_owner_epochs_run_preparation_queue_mesh_and_source(self):
        import copy
        dev, pin, scene, _, _, _, _, proof = self.fixture()
        mutations = [
            lambda p: p['resources']['status_after']['body']['session'].update(request_scope_epoch='api-one:5'),
            lambda p: p['resources']['status_before']['body'].update(run={'run_id': 'accepted'}),
            lambda p: p['resources']['preparation'].update(status=200),
            lambda p: p['resources']['queue']['body'].update(items=[{'state': 'queued'}]),
            lambda p: p['resources']['commands']['body'].update(accepted_count=1),
            lambda p: p['resources']['mesh'].update(status=200, body={'active_build': {}}),
            lambda p: p['resources']['scene_after']['body'].update(objects=[{'id': 'changed'}]),
            lambda p: p['resources']['current_after']['body'].update(script={'sha256': 'f' * 64}),
            lambda p: p['resources']['project_open']['body'].update(revision=3),
            lambda p: p['resources']['run'].update(api_instance_id='another-api'),
            lambda p: p.update(reservation_states=['active']),
            lambda p: p.update(run_directories=['accepted-run']),
            lambda p: p.update(source_snapshot_sha256='f' * 64),
            lambda p: p['process_receipt']['service_owner'].update(owner_token='foreign'),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(proof);mutate(candidate)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                dev._saved_authoring_validate_probe(candidate, pin, scene)

    def test_refuses_container_replacement_config_or_started_at_and_requires_window(self):
        import copy
        dev, pin, _, _, _, _, actual, _ = self.fixture()
        for key, value in [('Id', '9' * 64), ('Image', 'sha256:' + '9' * 64)]:
            changed = copy.deepcopy(actual);changed['backend'][key] = value
            with self.assertRaises(BuildControlError): dev._saved_authoring_validate_services(pin, changed)
        actual['backend']['State']['StartedAt'] = 'replacement-start'
        with self.assertRaises(BuildControlError): dev._saved_authoring_validate_services(pin, actual)
        pin['exclusive_operator_window'] = False
        with self.assertRaises(BuildControlError):
            dev._saved_authoring_validate_request(pin, project='fullmag-test', attempt='b' * 32,
                                                  config_sha256='c' * 64, selected='/selected')

    def test_unknown_preflight_keeps_frontend_quiesced_and_retains_lease(self):
        import docker_volume_dev as dev
        operation = {'receipt': {}, 'daemon_pending': False}
        with mock.patch.object(dev, 'docker_capture') as run:
            dev._idle_preflight_failed(ControlOutcomeUnknown('unknown'), {'pinned': True}, operation, 'own-frontend')
        run.assert_not_called()
        self.assertTrue(operation['daemon_pending'])
        self.assertEqual(operation['receipt']['saved_authoring_outcome'], 'outcome-unknown')
        with mock.patch.object(dev, 'docker_capture') as run:
            dev._idle_preflight_failed(BuildControlError('known rejection'), {'pinned': True}, operation, 'own-frontend')
        run.assert_called_once_with('start', 'own-frontend', timeout=90)
        self.assertFalse(operation['daemon_pending'])

    def test_same_native_owner_and_children_required_for_authenticated_drain(self):
        import copy
        dev, _, _, _, _, _, _, proof = self.fixture()
        owner = copy.deepcopy(proof['process_receipt']['service_owner'])
        drained = {'schema': 'fullmag.docker-process-tree.v1', 'state': 'drained',
                   'service_owner': owner, 'terminal_service_owner': copy.deepcopy(owner)}
        dev._saved_authoring_validate_drain(proof, drained)
        for name in ('service_owner', 'terminal_service_owner'):
            changed = copy.deepcopy(drained);changed[name]['children'][0]['pid'] = 88
            with self.assertRaises(BuildControlError): dev._saved_authoring_validate_drain(proof, changed)

    def test_fixed_probe_checks_real_store_and_ledger_without_backend_or_solver(self):
        import contextlib, copy, hashlib, io, json, os, types, urllib.request
        from docker_build_control import canonical
        dev, pin, scene, raw, _, _, _, proof = self.fixture()
        paths = {'/v2/sessions/current': 'current_before', '/v2/sessions/current/status': 'status_before',
            '/v2/sessions/current/model/scene': 'scene_before', '/v2/platform/health': 'health',
            '/v2/platform/compute/queue': 'queue', '/v2/platform/runtime-service': 'runtime',
            '/v2/sessions/current/simulation/commands': 'commands',
            '/v2/sessions/current/simulation/runs/current': 'run',
            '/v2/sessions/current/simulation/preparation': 'preparation',
            '/v2/sessions/current/meshing/builds/current': 'mesh',
            '/v2/sessions/current/meshing/builds': 'mesh_history',
            '/v2/sessions/current/meshing/meshes/shared-domain/manifest': 'mesh_manifest',
            '/v2/persistence/projects/open': 'project_open'}
        calls = []
        class Response(io.BytesIO):
            def __init__(self, row):
                super().__init__(b'' if row['status'] == 204 else canonical(row['body']));self.status = row['status']
                self.headers = {'x-fullmag-api-instance': row['api_instance_id']}
        def urlopen(request, timeout):
            path = request.full_url.removeprefix('http://127.0.0.1:8081')
            calls.append((path, request.get_method()))
            self.assertIn('request_scope_epoch=api-one%3A4', request.get_header('X-fullmag-session-scope'))
            self.assertEqual(request.get_method(), 'POST' if path.endswith('/projects/open') else 'GET')
            return Response(proof['resources'][paths[path]])
        with tempfile.TemporaryDirectory(prefix='saved-authoring-probe-') as directory:
            root = Path(directory);store = root/'runs'/'session-store';ledger = root/'ledger'
            for path in (store/'runs', store/'temp', store/'recovery', ledger): path.mkdir(parents=True, exist_ok=True)
            (store/'WRITER.lock').touch();(ledger/'WRITER.lock').touch()
            (ledger/'HOST_RESOURCE_LEDGER.json').write_text('{"reservations":[]}', encoding='utf8')
            provenance = canonical({'source_snapshot_sha256': pin['package']['source_snapshot_sha256']})
            pin['package']['provenance_sha256'] = hashlib.sha256(provenance).hexdigest()
            (root/'provenance.json').write_bytes(provenance)
            certificate = {'schema': 'fullmag.windows-folder-host.v1', 'storage_profile': 'windows-folder-v1',
                'restart_verified': True, 'host_root': 'D:\\state', 'host_volume_serial': 123,
                'owner_token': '123e4567-e89b-42d3-a456-426614174000', 'engine_id': 'engine-one'}
            host_raw = canonical(certificate)
            (root/'host.json').write_bytes(host_raw)
            (root/'.fullmag-windows-folder-owner.json').write_bytes(host_raw)
            (root/'.fullmag-windows-folder-grant.json').write_bytes(canonical({
                'schema': 'fullmag.windows-folder-session.v1', 'state': 'operational', 'container_root': '/state',
                'host_attestation_sha256': hashlib.sha256(host_raw).hexdigest(), 'owner_token': certificate['owner_token']}))
            ready = types.SimpleNamespace(canonical_paths=lambda: types.SimpleNamespace(
                state=root, store=store, host_certificate=root/'host.json'), process_receipt_path=lambda paths: 'unused',
                _bounded_regular=lambda *args: canonical(proof['process_receipt']), _validate_terminal_owner=mock.Mock())
            real_open = os.open
            def mapped_open(path, *args, **kwargs):
                if str(path) == '/opt/fullmag/control/backend/runtime-provenance.json': path = root/'provenance.json'
                return real_open(path, *args, **kwargs)
            def execute():
                payload = canonical({'checkpoint': pin, 'archive_base64': 'unused-in-mocked-open', 'host_certificate': certificate})
                output = io.StringIO()
                with mock.patch.dict(os.environ, {'FULLMAG_RUNS_ROOT': str(root/'runs'), 'FULLMAG_HOST_LEDGER_ROOT': str(ledger),
                        'FULLMAG_STARTUP_ENABLED': '0', 'FULLMAG_ACCEPTED_STORE_SCOPE': ''}), \
                     mock.patch.dict(sys.modules, {'runtime_service': ready}), \
                     mock.patch.object(sys, 'stdin', io.StringIO(payload.decode())), \
                     mock.patch.object(os, 'open', side_effect=mapped_open), \
                     mock.patch.object(urllib.request, 'urlopen', side_effect=urlopen), contextlib.redirect_stdout(output):
                    exec(compile(dev._SAVED_AUTHORING_PROBE_SCRIPT, '<fixed-saved-authoring-probe>', 'exec'), {})
                return json.loads(output.getvalue())
            observed = execute();dev._saved_authoring_validate_probe(observed, pin, scene)
            stable = {'schema': 'fullmag.docker-admitted-store-identity.v2', 'host_root': 'd:/state',
                'host_volume_serial': 123, 'engine_id': 'engine-one', 'owner_token': certificate['owner_token'],
                'relative_state_path': 'runs/session-store'}
            self.assertEqual(observed['accepted_store_id'], 'sha256:' + hashlib.sha256(canonical(stable)).hexdigest())
            self.assertEqual([c for c in calls if c[1] == 'POST'], [('/v2/persistence/projects/open', 'POST')])
            # Exercise native flock contention, not an unlocked mock ledger.
            import fcntl, threading, time
            held = os.open(ledger/'WRITER.lock', os.O_RDWR)
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            def release_writer():
                time.sleep(0.05)
                fcntl.flock(held, fcntl.LOCK_UN)
            release = threading.Thread(target=release_writer)
            release.start()
            try:
                self.assertEqual(execute()['accepted_store_id'], observed['accepted_store_id'])
            finally:
                release.join(timeout=2)
                os.close(held)
            held = os.open(ledger/'WRITER.lock', os.O_RDWR)
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                with mock.patch('time.monotonic', side_effect=[0.0, 6.0, 12.0]), \
                     self.assertRaisesRegex(RuntimeError, 'evidence lock busy after 5 seconds'):
                    execute()
            finally:
                fcntl.flock(held, fcntl.LOCK_UN)
                os.close(held)
            (store/'runs'/'accepted-run').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'accepted runs'): execute()
            (store/'runs'/'accepted-run').rmdir()
            foreign = {'identity': {'store_id': 'sha256:' + '9' * 64}, 'state': 'committed'}
            (ledger/'HOST_RESOURCE_LEDGER.json').write_bytes(canonical({'reservations': [foreign]}))
            self.assertEqual(execute()['foreign_reservations_observed'], 1)
            own = {'identity': {'store_id': observed['accepted_store_id']}, 'state': 'committed'}
            (ledger/'HOST_RESOURCE_LEDGER.json').write_bytes(canonical({'reservations': [foreign, own]}))
            with self.assertRaisesRegex(RuntimeError, 'affected host resource reservation active'): execute()
            (ledger/'HOST_RESOURCE_LEDGER.json').write_text('{"reservations":[{"state":"committed"}]}', encoding='utf8')
            with self.assertRaisesRegex(RuntimeError, 'store ownership is unknown'): execute()



    def test_ui_authoring_has_no_active_script_and_preserves_original_only_in_fms(self):
        import copy
        dev, pin, scene, raw, _, _, _, proof = self.fixture()
        self.assertNotIn('script_sha256', pin['session'])
        self.assertEqual(pin['session']['source_kind'], 'ui_authoring')
        dev._saved_authoring_validate_archive(raw, pin['archive'])
        dev._saved_authoring_validate_probe(proof, pin, scene)
        for change in ({'script_path': '/tmp/script.py'}, {'script': {'sha256': pin['archive']['source_sha256']}}):
            candidate = copy.deepcopy(proof);candidate['resources']['current_after']['body'].update(change)
            with self.assertRaises(BuildControlError): dev._saved_authoring_validate_probe(candidate, pin, scene)
        pin['session']['source_kind'] = 'managed_script'
        with self.assertRaises(BuildControlError):
            dev._saved_authoring_validate_request(pin, project='fullmag-test', attempt='b' * 32,
                config_sha256='c' * 64, selected='/selected')

    def test_revision_only_mesh_fallback_requires_no_manifest_or_real_build_owner(self):
        import copy
        dev, pin, scene, _, _, _, _, proof = self.fixture()
        proof['resources']['mesh'].update(status=200, body={'revision': 1, 'provenance': {'mesh_revision': 1},
            'published_resources': {'mesh_revision': 1, 'mesh_build_revision': 1,
                'manifest': '/v2/sessions/current/meshing/meshes/shared-domain/manifest',
                'quality': '/v2/sessions/current/meshing/meshes/shared-domain/quality',
                'realized_size_fields': '/v2/sessions/current/meshing/meshes/shared-domain/realized-size-fields'}})
        proof['resources']['mesh_history'].update(status=200, body={'revision': 1, 'history': []})
        dev._saved_authoring_validate_probe(proof, pin, scene)
        for mutate in (
            lambda p: p['resources']['mesh_manifest'].update(status=200, body={'mesh': 'real'}),
            lambda p: p['resources']['mesh']['body']['provenance'].update(command_id='accepted-command'),
            lambda p: p['resources']['mesh']['body']['published_resources'].update(manifest='/foreign/manifest'),
            lambda p: p['resources']['mesh']['body'].update(active_build={}),
        ):
            candidate = copy.deepcopy(proof);mutate(candidate)
            with self.assertRaises(BuildControlError): dev._saved_authoring_validate_probe(candidate, pin, scene)

    def run_completion_boundary(self, fault=None):
        import contextlib, copy, io, json
        import docker_volume_dev as dev
        import docker_build_control as build_control
        import docker_host_ledger as ledger
        import fullmag_docker_runtime as runtime
        from subprocess import CompletedProcess
        control = BuildControl({'project_name': 'fullmag-test', 'worktree_id': 'owned',
            'project_id': 'test-project', 'checkout_kind': 'worktree'}, 'sha256:' + 'a' * 64)
        logger = mock.Mock(stdin=io.BytesIO())
        logger.poll.return_value = None
        logger.wait.return_value = 0
        written = {};events = [];operation = None
        def write(path, value):
            if path.endswith('/saved-authoring-restart-result.json'):
                events.append('result-write')
                self.assertNotEqual(operation['receipt']['state'], 'succeeded')
                if fault == 'result-write': raise BuildControlError('result publication failed')
            written[path] = copy.deepcopy(value)
        def health(backend_id):
            events.append('health')
            self.assertTrue(operation['daemon_pending'])
            self.assertNotEqual(operation['receipt']['state'], 'succeeded')
            if fault == 'health': raise ControlOutcomeUnknown('health observation unknown')
            return {'status': 'ok', 'active_session': False}
        def archive(*args):
            events.append('archive')
            self.assertNotEqual(operation['receipt']['state'], 'succeeded')
            if fault == 'archive': raise BuildControlError('saved archive changed')
            return b'archive', {}
        image = 'sha256:' + 'a' * 64
        def text(*args, **kwargs):
            if args[:2] == ('image', 'inspect'): return json.dumps([{'Config': {}}])
            if args[0] == 'logs': return 'ledger log'
            if args[0] == 'exec': return '{"state":"ready"}'
            if args[0] == 'inspect':
                if len(args) == 2 and args[1].startswith('fullmag-ledger-verify-'):
                    return json.dumps([{'Image': image, 'Id': 'verify-owned', 'State': {'Running': False, 'ExitCode': 0},
                        'Config': {'Labels': {'com.docker.compose.project': 'fullmag-test'}}}])
                return json.dumps([{'Id': name, 'Image': image, 'State': {'Running': True, 'StartedAt': 'exact-start',
                                      'Health': {'Status': 'healthy'}}} for name in args[1:]])
            raise AssertionError(args)
        document = {'services': {'backend': {'image': image, 'environment': {'FULLMAG_DOCKER_DEVICE_ACCESS': 'cpu'}},
                                 'frontend': {'image': image}}}
        provenance = {'commit': 'commit', 'source_digest': 'source', 'source_snapshot_sha256': 'snapshot',
                      'build_receipt_sha256': 'receipt'}
        profile = {'maintenance_document': {'name': 'fullmag-test'}, 'project_id': 'project',
                   'mount_root': 'mount', 'backing_image': 'backing'}
        with contextlib.ExitStack() as stack:
            for target, name, options in [
                (control, 'space', {'return_value': {'available_bytes': 100 * 1024**3}}),
                (control, 'helper_args', {'return_value': ['mock-only-no-process']}),
                (control, '_line', {'side_effect': ['READY', 'LOGGED']}),
                (control, '_inspect_operation_helper', {'return_value': 'e' * 64}),
                (control, 'write', {'side_effect': write}),
                (build_control.subprocess, 'Popen', {'return_value': logger}),
                (dev, '_operator_probe_record_from_retained', {'return_value': {}}),
                (dev, '_wait_for_publication', {'return_value': ({}, provenance)}),
                (dev, 'compose_capture', {'return_value': b'{}'}),
                (dev, 'docker_text', {'side_effect': text}),
                (dev, 'docker_capture', {'return_value': CompletedProcess([], 0, b'', b'')}),
                (dev, '_validate_retained_service', {}),
                (runtime, '_assembly_from_backend_start', {'return_value': {}}),
                (dev, '_session_host', {'return_value': mock.Mock()}),
                (ledger, '_parse_json_lines', {'return_value': {}}),
                (ledger, '_validate_host_receipt', {}),
                (ledger, 'validate_container', {'return_value': {}}),
                (dev, '_saved_authoring_verify_post_restart', {'side_effect': health}),
                (dev, '_saved_authoring_read_archive', {'side_effect': archive}),
            ]:
                stack.enter_context(mock.patch.object(target, name, **options))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            try:
                with control.operation('iteration', {}) as operation:
                    operation['daemon_pending'] = True
                    operation['receipt']['state'] = 'restarting-idle-backend'
                    operation['receipt']['backend_started_at'] = 'exact-start'
                    # Exercise the REAL _finish and REAL context manager: only
                    # Docker/runtime effects and the selected failure are mocked.
                    dev._finish(control, operation, document, 'backend', 'frontend', Path('/selected'),
                        Path('/state'), Path('/state/certificate'), {'restart_verified': True, 'storage_profile': 'windows-folder-v1'}, {},
                        {'image_id': image}, image, Path('/git'), profile, 3202,
                        completion_gate=lambda: dev._saved_authoring_complete(control, operation,
                            'backend', {'archive': {'path': 'D:/saved.fms'}}, Path('/state'), 'c' * 64))
            except (BuildControlError, ControlOutcomeUnknown):
                if fault is None: raise
        return operation, written, logger, events

    def test_real_finish_and_operation_keep_unknown_postconditions_nonterminal(self):
        for fault in ('health', 'archive', 'result-write'):
            with self.subTest(fault=fault):
                operation, written, logger, events = self.run_completion_boundary(fault)
                self.assertTrue(operation['daemon_pending'])
                self.assertEqual(operation['receipt']['state'], 'outcome-unknown-resources-retained')
                self.assertFalse(any(path.endswith('/terminal.json') for path in written))
                self.assertNotIn('iteration/current.json', written)
                self.assertNotIn('iteration/verified.json', written)
                logger.wait.assert_not_called()
                self.assertIn('health', events)

    def test_real_finish_publishes_success_only_after_all_authoring_gates(self):
        operation, written, logger, events = self.run_completion_boundary()
        self.assertEqual(events, ['health', 'archive', 'result-write'])
        self.assertFalse(operation['daemon_pending'])
        self.assertEqual(operation['receipt']['state'], 'succeeded')
        self.assertIn(operation['root'] + '/terminal.json', written)
        self.assertIn('iteration/verified.json', written)
        logger.wait.assert_called_once_with(timeout=30)




class FrontendMetadataRefreshTests(IsolatedReceiptTests):
    def test_all_frozen_metadata_changes_generation_but_commit_alone_does_not(self):
        import copy
        from docker_development_inputs import metadata_cache_key
        value = {'dependency_seed_sha256':'d','toolpins_sha256':'t','source_commit':'old',
                 'files':[{'relative':'apps/control-room/next.config.test.ts','sha256':'a'}]}
        first = metadata_cache_key(value,'project')
        changed = copy.deepcopy(value); changed['source_commit']='new'
        self.assertEqual(first, metadata_cache_key(changed,'project'))
        changed['files'][0]['sha256']='b'
        self.assertNotEqual(first, metadata_cache_key(changed,'project'))
        self.assertNotEqual(first, metadata_cache_key(value,'other-project'))

    def test_refresh_document_retains_backend_and_caches(self):
        import copy
        from docker_volume_dev import _frontend_refresh_document
        original = {'services':{'backend':{'volumes':['state','build','package'],'environment':{'X':'same'}},
                                'frontend':{'environment':{'FULLMAG_SOURCE_COMMIT':'old'}}},
                    'volumes':{'frontend-build':{'name':'old'},'backend-build':{'name':'same'}}}
        before=copy.deepcopy(original)
        result = _frontend_refresh_document(original,'new',{'source_commit':'new'})
        self.assertEqual(original,before)
        self.assertEqual(result['services']['backend'],before['services']['backend'])
        self.assertEqual(result['volumes']['backend-build'],before['volumes']['backend-build'])
        self.assertEqual(result['volumes']['frontend-build']['name'],'new')

    def test_frontend_refresh_upgrades_only_legacy_memory_default(self):
        import copy
        from docker_volume_dev import _frontend_refresh_document
        for limit in ('6442450944', 6442450944, '6g', '12884901888'):
            original = {'services': {'backend': {'mem_limit': '8589934592'},
                        'frontend': {'environment': {}, 'mem_limit': limit, 'cpus': 2}},
                        'volumes': {'frontend-build': {'name': 'old'}}}
            before = copy.deepcopy(original)
            result = _frontend_refresh_document(original, 'new', {'source_commit': 'new'})
            expected = '12884901888' if limit == '12884901888' else '8589934592'
            self.assertEqual(result['services']['frontend']['mem_limit'], expected)
            self.assertEqual(result['services']['frontend']['cpus'], 2)
            self.assertEqual(result['services']['backend'], before['services']['backend'])
            self.assertEqual(original, before)

    def fixture_view(self, directory, *, generated=False):
        import hashlib,json
        from docker_development_inputs import FRONTEND_VIEW_SCRIPT,_next_generated_seed_variants
        from docker_build_control import canonical
        root=Path(directory); source=root/'source'; workspace=root/'development'/'workspace'
        rows=[]; allowed={}
        for relative, raw in [('apps/control-room/next.config.ts',b'proxyTimeout: 1920250'),
                              ('apps/control-room/next.config.test.ts',b'new timeout tests'),
                              ('apps/control-room/next-env.d.ts',b'import "./.next/types/routes.d.ts";\n')]:
            rows.append({'relative':relative,'sha256':hashlib.sha256(raw).hexdigest()})
            variants=_next_generated_seed_variants(relative,raw)
            allowed[relative]=[hashlib.sha256(value).hexdigest() for value in variants]
            for base in (source,workspace.parent/'frozen-inputs',workspace):
                path=base/relative;path.parent.mkdir(parents=True,exist_ok=True)
                path.write_bytes(next(value for value in variants if value!=raw)
                    if generated and base==workspace and len(variants)>1 else raw)
        manifest={'files':rows}
        freeze={'schema':'fullmag.docker-development-inputs-freeze.v1','manifest':manifest,'files':rows,
                'manifest_digest':hashlib.sha256((json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n').encode()).hexdigest(),
                'frozen_root':str(workspace.parent/'frozen-inputs')}
        (workspace.parent/'inputs-freeze.json').write_bytes(canonical(freeze))
        script=FRONTEND_VIEW_SCRIPT.replace("pathlib.Path('/state/development/workspace')",'pathlib.Path('+repr(str(workspace))+')').replace("pathlib.Path('/opt/fullmag/source')",'pathlib.Path('+repr(str(source))+')')
        def execute():
            return subprocess.run([sys.executable,'-B','-c',script],input=json.dumps({'files':rows,'allowed':allowed}).encode(),capture_output=True,timeout=15)
        return workspace,execute

    def test_actual_shadow_and_exact_generated_next_variant_are_accepted(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            workspace,execute=self.fixture_view(directory,generated=True)
            result=execute();self.assertEqual(result.returncode,0,result.stderr)
            rows=json.loads(result.stdout)['files']
            self.assertTrue(rows[-1]['generated_variant'])
            self.assertFalse(rows[0]['generated_variant'])

    def test_stale_shadow_config_and_root_test_refuse(self):
        for relative in ('next.config.ts','next.config.test.ts'):
            with self.subTest(relative=relative),tempfile.TemporaryDirectory() as directory:
                workspace,execute=self.fixture_view(directory)
                (workspace/'apps/control-room'/relative).write_text('stale')
                result=execute();self.assertNotEqual(result.returncode,0)
                self.assertIn(relative.encode(),result.stderr)

    def test_changed_frozen_original_or_link_refuse(self):
        for linked in (False,True):
            with self.subTest(linked=linked),tempfile.TemporaryDirectory() as directory:
                workspace,execute=self.fixture_view(directory)
                target=workspace/'apps/control-room/next.config.test.ts'
                if linked:
                    target.unlink();target.symlink_to(workspace.parent/'frozen-inputs/apps/control-room/next.config.test.ts')
                else:
                    (workspace.parent/'frozen-inputs/apps/control-room/next.config.test.ts').write_text('changed')
                self.assertNotEqual(execute().returncode,0)



    def run_refresh(self, fault=None, *, linux=False):
        import copy,json,types
        import docker_volume_dev as dev
        import docker_dev_codegen as codegen
        import docker_development_inputs as frontend_inputs
        import windows_folder_host,linux_native_host,fullmag_storage,docker_volume_reconcile,docker_build_control
        host = linux_native_host if linux else windows_folder_host
        certificate_name = Path(host.HOST_CERT_PATH).name
        control=mock.Mock(spec=BuildControl);control.project='own';control.volume='control';control.namespace=''
        control._active_operation=None
        control.operation=types.MethodType(BuildControl.operation,control)
        control._pin_operation_helper=types.MethodType(BuildControl._pin_operation_helper,control)
        control._inspect_operation_helper.return_value='e'*64
        control.path.side_effect=lambda value:'/control/'+value
        control.space.return_value={'available_bytes':64*1024**3}
        control._line.side_effect=['READY','LOGGED']
        logger=mock.Mock();logger.poll.return_value=None;logger.wait.return_value=0;logger.stdin.closed=False
        logger.stdin.close.side_effect=lambda:setattr(logger.stdin,'closed',True)
        writes={}
        def write(path,value):
            if fault=='last-proof' and path.endswith('/frontend-source-view.json'):raise OSError('proof write failed')
            writes[path]=copy.deepcopy(value)
        control.write.side_effect=write;control.read.return_value={'retained':'same'}
        backend={'Id':'b'*64,'State':{'StartedAt':'same','Running':True,'Health':{'Status':'healthy'}}}
        frontend={'Id':'f'*64,'Image':'image','State':{'StartedAt':'new','Running':True,'Health':{'Status':'healthy'}}}
        frontend['HostConfig']={'Memory':6*1024**3 if fault=='memory-drift' else 8*1024**3}
        document={'services':{'backend':{'same':'declaration'},'frontend':{'environment':{'FULLMAG_FRONTEND_HOST_PORT':'3202'},'mem_limit':'6442450944'}},
                  'volumes':{'frontend-build':{'name':'old'}}}
        old={'backend':backend,'frontend':{**frontend,'Id':'o'*64,'HostConfig':{'Memory':6*1024**3}}}
        args=types.SimpleNamespace(port=3202,attempt='a'*32,config_sha256='c'*64)
        previous={'inputs':{'attempt':'old','config_sha256':'old'},'state_root':'/state','backend_volumes':{'same':'cache'},'frontend_volume':'old'}
        seed={'files':[],'source_commit':'commit'}
        source={'commit':'commit','source_digest':'digest','snapshot':'snapshot'}
        stopped=[]
        def stop(*argv,**kwargs):
            stopped.append(argv)
            if fault=='unknown-stop':raise ControlOutcomeUnknown('stop observer lost')
            old['frontend']['State']=copy.deepcopy(old['frontend']['State'])
            old['frontend']['State']['Running']=False
        def text(*argv):
            if argv[:2]==('image','inspect'):return json.dumps([{'Config':{}}])
            if argv[0]=='inspect':return json.dumps([backend if argv[1]=='b'*64 else old['frontend'] if argv[1]=='o'*64 else frontend])
            if stopped and fault=='post-quiesce-health':raise BuildControlError('API accepted session before quiescence')
            return json.dumps({'status':'ok','active_session':False})
        def compose(doc,*argv,**kwargs):return b'f'*64 if argv[0]=='ps' else b''
        reads={}
        def read_owner(path):
            name=Path(path).name;self.assertIn(name,(certificate_name,host.OWNER_NAME));reads[name]=reads.get(name,0)+1
            raw=(b'{"owner":"same"}' if name==certificate_name
                 else b'{\n  "owner": "same"\n}\n')
            if reads[name]>1 and ((fault=='certificate-drift' and name==certificate_name)
                    or (fault=='owner-drift' and name==host.OWNER_NAME)):
                raw+=b' '
            return raw
        with mock.patch.object(docker_build_control.subprocess,'Popen',return_value=logger), \
             mock.patch.object(fullmag_storage,'validate_path',return_value=Path('/state')), \
             mock.patch.object(dev,'_session_host',return_value=host), \
             mock.patch.object(host,'read_owned_regular',side_effect=read_owner), \
             mock.patch.object(dev,'_retained_startup_enabled',return_value=False), \
             mock.patch.object(dev,'docker_text',side_effect=text), \
             mock.patch.object(dev,'docker_capture',side_effect=stop) as stopped_call, \
             mock.patch.object(dev,'_assert_private_restart_network'), \
             mock.patch.object(docker_volume_reconcile,'fingerprint',return_value='pin'), \
             mock.patch.object(codegen,'_backend_documents',return_value=({}, {}, 'receipt','binary')), \
             mock.patch.object(codegen,'_validate_backend',return_value=(source,'p','b')), \
             mock.patch.object(codegen,'_probe_source',side_effect=codegen.CodegenError('unknown',reconciliation_required=True)
                               if fault=='unknown-source' else None,return_value=({},'probe')), \
             mock.patch.object(codegen,'_source_matches',return_value=fault!='source-mismatch'), \
             mock.patch.object(frontend_inputs,'describe',return_value=seed), \
             mock.patch.object(frontend_inputs,'frontend_view',return_value={'files':[]}), \
             mock.patch.object(dev,'_frontend',return_value=(seed,'new-volume')) as seeded, \
             mock.patch.object(dev,'compose_capture',side_effect=compose) as composed, \
             mock.patch.object(dev,'_validate_retained_service'):
            try:
                dev._refresh_frontend_services(control,args,'development/attempts/old',previous,document,
                    Path('/selected'),{'runtime_root':'/runtime'},old,{'backend':'b'*64,'frontend':'o'*64},'image',{})
            except (BuildControlError,codegen.CodegenError,OSError):
                if fault is None:raise
        if fault=='source-mismatch' or fault=='unknown-source':stopped_call.assert_not_called()
        else:stopped_call.assert_called_once_with('stop','--time','60','o'*64,timeout=90)
        return writes,seeded,composed,logger

    def test_successful_handoff_recreates_only_frontend_and_retains_backend(self):
        writes,seeded,composed,logger=self.run_refresh()
        terminal=next(value for path,value in writes.items() if path.endswith('/terminal.json'))
        self.assertEqual(terminal['state'],'succeeded')
        self.assertEqual(terminal['backend_container'],'b'*64)
        self.assertEqual(terminal['frontend_container'],'f'*64)
        self.assertFalse(terminal['native_build_executed'])
        self.assertNotIn('config_sha256',terminal['inputs'])
        from docker_volume_activate import _linked_runtime_terminals
        self.assertEqual(_linked_runtime_terminals(mock.Mock(),terminal['attempt'],terminal,
            source_root='/selected',image='image',config_sha256=terminal['config_sha256']),[terminal])
        lifecycle=composed.call_args_list[0]
        self.assertEqual(lifecycle.args[1:],('up','--detach','--no-build','--pull','never','--no-deps','--force-recreate','frontend'))
        self.assertEqual(lifecycle.args[0]['services']['backend'],{'same':'declaration'})
        self.assertEqual(lifecycle.args[0]['services']['frontend']['mem_limit'],'8589934592')
        self.assertTrue(any(path.endswith('/rollback-compose.json') for path in writes))

    def test_linux_refresh_uses_native_certificate_and_preserves_backend(self):
        writes,seeded,composed,logger=self.run_refresh(linux=True)
        terminal=next(value for path,value in writes.items() if path.endswith('/terminal.json'))
        self.assertEqual(terminal['state'],'succeeded')
        self.assertEqual(terminal['backend_container'],'b'*64)
        self.assertFalse(terminal['native_build_executed'])

    def test_linux_refresh_retains_control_on_certificate_or_owner_byte_drift(self):
        for fault in ('certificate-drift','owner-drift'):
            with self.subTest(fault=fault):
                writes,seeded,composed,logger=self.run_refresh(fault,linux=True)
                self.assertFalse(any(path.endswith('/terminal.json') for path in writes))
                receipt=next(value for path,value in writes.items() if path.endswith('/receipt.json'))
                self.assertEqual(receipt['state'],'outcome-unknown-resources-retained')
                logger.wait.assert_not_called()

    def test_source_mismatch_refuses_before_seeding_or_lifecycle(self):
        writes,seeded,composed,logger=self.run_refresh('source-mismatch')
        seeded.assert_not_called();composed.assert_not_called()
        self.assertEqual(next(value for path,value in writes.items() if path.endswith('/terminal.json'))['state'],'failed-confirmed')

    def test_unknown_probe_or_late_proof_failure_retains_real_control_lease(self):
        for fault in ('unknown-source','unknown-stop','post-quiesce-health','last-proof','certificate-drift','owner-drift','memory-drift'):
            with self.subTest(fault=fault):
                writes,seeded,composed,logger=self.run_refresh(fault)
                self.assertFalse(any(path.endswith('/terminal.json') for path in writes))
                receipt=next(value for path,value in writes.items() if path.endswith('/receipt.json'))
                self.assertEqual(receipt['state'],'outcome-unknown-resources-retained')
                logger.wait.assert_not_called()


class WorkerCgroupNamespaceTests(unittest.TestCase):
    def exercise_delegation(self, cgroup_namespace="host", pid_namespace="host"):
        import json
        import docker_worker_cgroup as worker
        backend_id, image = "b" * 64, "sha256:" + "c" * 64
        control = mock.Mock(project="fullmag-master", volume="control-volume")
        operation = {"root": "attempts/test", "receipt": {"attempt": "a" * 32}}
        request = {"schema": "fullmag.worker-cgroup-request.v1",
                   "compose_project": control.project, "nonce": "d" * 32}
        proof = dict(request, schema="fullmag.worker-cgroup-ready.v1",
                     container_id=backend_id, image_id=image, state="ready")
        backend = {"Id": backend_id, "Image": image,
                   "Config": {"User": "65532:65532", "Labels": {
                       "com.docker.compose.project": control.project,
                       "com.docker.compose.service": "backend"}},
                   "HostConfig": {"Privileged": False, "CapAdd": []},
                   "State": {"Running": True, "Pid": 123}}
        helper = {"Id": "e" * 64, "Image": image,
                  "Config": {"Labels": {
                      "com.docker.compose.project": control.project,
                      "com.docker.compose.service": "worker-cgroup-maintenance"}},
                  "HostConfig": {"CgroupnsMode": cgroup_namespace, "PidMode": pid_namespace},
                  "State": {"Running": False, "ExitCode": 0}}
        document = {"services": {"backend": {"environment": {
            "FULLMAG_WORKER_CGROUP_PROFILE": worker.PROFILE}}}}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            helper_path = source / "scripts/lib/docker_worker_cgroup.py"
            helper_path.parent.mkdir(parents=True)
            helper_path.write_text("# fixture helper\n", encoding="utf-8")
            with mock.patch.object(worker, "docker_text", side_effect=[
                    json.dumps([backend]), json.dumps(request), "{}",
                    json.dumps([helper]), "helper log"]), \
                 mock.patch.object(worker, "compose_capture", return_value=json.dumps(proof).encode()) as compose, \
                 mock.patch.object(worker, "docker_capture") as docker:
                if cgroup_namespace != "host" or pid_namespace != "host":
                    with self.assertRaisesRegex(BuildControlError, "helper identity/outcome"):
                        worker.ensure_delegation(control, operation, document, backend_id, image, source)
                    self.assertNotIn("worker_cgroup", operation["receipt"])
                    docker.assert_not_called()
                else:
                    worker.ensure_delegation(control, operation, document, backend_id, image, source)
                    self.assertEqual(operation["receipt"]["worker_cgroup"], proof)
                    docker.assert_called_once_with("rm", helper["Id"])
                service = compose.call_args.args[0]["services"]["worker-cgroup-maintenance"]
                self.assertEqual(service["cgroup"], "host")
                self.assertEqual(service["pid"], "host")
                self.assertTrue(service["privileged"])
                self.assertTrue(service["read_only"])
                self.assertEqual(service["network_mode"], "none")

    def test_delegation_helper_can_reach_backend_cgroup(self):
        self.exercise_delegation()

    def test_private_cgroup_namespace_is_not_accepted_as_success(self):
        self.exercise_delegation(cgroup_namespace="private")

    def test_private_pid_namespace_is_not_accepted_as_success(self):
        self.exercise_delegation(pid_namespace="private")


if __name__ == '__main__':
    unittest.main()
