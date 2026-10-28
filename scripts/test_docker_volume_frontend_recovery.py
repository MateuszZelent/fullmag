"""Regressions for restoring one exact OOM-stopped DEV frontend."""
import copy
from contextlib import contextmanager, nullcontext, redirect_stdout
import io
import json
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from docker_build_control import ControlOutcomeUnknown
import docker_dev_codegen as codegen
import docker_volume_dev as dev
import docker_volume_reconcile as reconcile
import docker_build_control as build_control
import docker_development_inputs as frontend_inputs
import fullmag_storage
import windows_folder_host


class FrontendRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.actual = {
            'backend': {'Id': 'backend-id', 'State': {'Running': True, 'StartedAt': 'backend-start',
                        'Health': {'Status': 'healthy'}}},
            'frontend': {'Id': 'frontend-id', 'State': {'Running': False, 'StartedAt': 'old-start',
                         'FinishedAt': 'oom-finish', 'OOMKilled': True, 'ExitCode': 1}},
        }
        self.live = copy.deepcopy(self.actual)
        self.ids = {name: value['Id'] for name, value in self.actual.items()}
        self.operation = {'receipt': {}, 'daemon_pending': False}
        self.control = mock.Mock(project='selected-group')

        @contextmanager
        def operation(*args, **kwargs):
            yield self.operation
        self.control.operation.side_effect = operation
        self.args = SimpleNamespace(port=3202, attempt='a' * 32, config_sha256='b' * 64)
        self.document = {'services': {'frontend': {'environment': {'FULLMAG_FRONTEND_HOST_PORT': '3202'}}}}
        self.package = ({'receipt': True}, {'provenance': True}, 'c' * 64, 'binary-proof')
        self.start_count = 0

        def start(*args, **kwargs):
            self.assertEqual(args, ('start', 'frontend-id'))
            self.assertTrue(self.operation['daemon_pending'])
            self.start_count += 1
            self.live['frontend']['State'].update(Running=True, StartedAt='recovered-start',
                                                  OOMKilled=False, Health={'Status': 'healthy'})
        self.start = mock.patch.object(dev, 'docker_capture', side_effect=start).start()
        self.inspect = mock.patch.object(dev, 'docker_text', side_effect=lambda cmd, identifier:
            json.dumps([self.live['backend' if identifier == 'backend-id' else 'frontend']])).start()
        mock.patch.object(reconcile, 'fingerprint', side_effect=lambda doc: doc['Id']).start()
        mock.patch.object(dev, '_assert_private_restart_network').start()
        self.documents = mock.patch.object(codegen, '_backend_documents', return_value=self.package).start()
        mock.patch.object(codegen, '_validate_backend', return_value=({'commit': 'old-source'}, '', '')).start()
        mock.patch.object(codegen, '_exec', return_value=(b'[{"pid":10,"start_ticks":"100","executable":"fullmag-api"}]', b'')).start()
        self.seed = mock.patch.object(dev, '_frontend').start()
        self.finish = mock.patch.object(dev, '_finish').start()
        self.addCleanup(mock.patch.stopall)

    def run_recovery(self):
        dev._resume_oom_frontend(self.control, self.args, self.document, self.actual, self.ids, Path('/selected'))

    def test_starts_only_retained_frontend_without_seeding_or_native_success(self):
        self.run_recovery()
        self.assertEqual(self.start_count, 1)
        self.seed.assert_not_called()
        self.finish.assert_not_called()
        receipt = self.operation['receipt']
        self.assertEqual(receipt['state'], 'succeeded')
        self.assertEqual(receipt['selected_source_qualification'], 'NOT VERIFIED')
        self.assertFalse(receipt['native_build_executed'])
        self.assertFalse(receipt['frontend_generation_changed'])
        self.assertEqual(receipt['backend_started_at'], 'backend-start')
        self.assertEqual(receipt['frontend_started_at'], 'recovered-start')
        self.assertFalse(self.operation['daemon_pending'])

    def test_refuses_non_oom_or_active_or_unhealthy_services_before_start(self):
        for name, field, value in (
            ('frontend', 'Running', True), ('frontend', 'OOMKilled', False),
            ('frontend', 'ExitCode', 0), ('frontend', 'FinishedAt', ''),
            ('backend', 'Health', {'Status': 'unhealthy'}),
        ):
            with self.subTest(field=field):
                before = copy.deepcopy(self.actual)
                self.actual[name]['State'][field] = value
                with self.assertRaises(dev.BuildControlError):
                    self.run_recovery()
                self.actual = before
        self.start.assert_not_called()

    def test_refuses_frontend_restarted_before_admission(self):
        self.live['frontend']['State'].update(Running=True, StartedAt='foreign-restart')
        with self.assertRaisesRegex(dev.BuildControlError, 'incarnation changed'):
            self.run_recovery()
        self.start.assert_not_called()

    def test_start_observation_timeout_retains_unknown_and_never_retries(self):
        self.start.side_effect = ControlOutcomeUnknown('timeout')
        with self.assertRaises(ControlOutcomeUnknown):
            self.run_recovery()
        self.assertEqual(self.start.call_count, 1)
        self.assertTrue(self.operation['daemon_pending'])
        self.assertNotEqual(self.operation['receipt'].get('state'), 'succeeded')

    def test_backend_restart_during_start_refuses_success(self):
        original = self.start.side_effect
        def start(*args, **kwargs):
            original(*args, **kwargs)
            self.live['backend']['State']['StartedAt'] = 'other-backend'
        self.start.side_effect = start
        with self.assertRaisesRegex(dev.BuildControlError, 'Backend processes changed'):
            self.run_recovery()
        self.assertNotEqual(self.operation['receipt'].get('state'), 'succeeded')

    def test_frontend_dies_during_final_package_read_refuses_success(self):
        calls = 0
        def package(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.live['frontend']['State'].update(Running=False, Health={'Status': 'unhealthy'})
            return self.package
        self.documents.side_effect = package
        with self.assertRaisesRegex(dev.BuildControlError, 'no longer'):
            self.run_recovery()
        self.assertTrue(self.operation['daemon_pending'])
        self.assertNotEqual(self.operation['receipt'].get('state'), 'succeeded')


class LegacyFrontendRecoveryTests(unittest.TestCase):
    def run_legacy(self, fault=None):
        control = mock.Mock(spec=build_control.BuildControl)
        control.project, control.volume, control.namespace = 'own', 'control', ''
        control.operation = build_control.BuildControl.operation.__get__(control)
        control.path.side_effect = lambda path: '/control/' + path
        control.space.return_value = {'available_bytes': 64 * 1024**3}
        control._line.side_effect = ['READY', 'LOGGED']
        logger = mock.Mock()
        logger.wait.return_value = 0
        logger.stdin.closed = False
        logger.stdin.close.side_effect = lambda: setattr(logger.stdin, 'closed', True)
        writes = {}
        control.write.side_effect = lambda path, value: writes.__setitem__(path, copy.deepcopy(value))
        control.read.return_value = {'retained': 'same'}
        backend_image, frontend_image = 'sha256:' + '1'*64, 'sha256:' + '2'*64
        backend = {'Id': 'b'*64, 'Image': backend_image,
                   'State': {'StartedAt': 'backend-start', 'Running': True, 'Health': {'Status': 'healthy'}}}
        old_frontend = {'Id': 'o'*64, 'Image': backend_image,
                        'State': {'StartedAt': 'old-start', 'FinishedAt': 'oom-finish',
                                  'Running': False, 'OOMKilled': fault != 'not-oom', 'ExitCode': 1}}
        new_frontend = {'Id': 'f'*64, 'Image': frontend_image,
                        'HostConfig': {'Memory': 8 * 1024**3 + (1 if fault == 'memory-drift' else 0)},
                        'State': {'StartedAt': 'new-start', 'Running': True, 'Health': {'Status': 'healthy'}}}
        observed = {'backend': backend, 'frontend': old_frontend}
        document = {'services': {'backend': {'image': backend_image, 'same': 'declaration'},
                                'frontend': {'image': backend_image, 'mem_limit': str(6 * 1024**3),
                                             'environment': {'FULLMAG_FRONTEND_HOST_PORT': '3202'},
                                             'tmpfs': ['/tmp:rw,size=512m']}},
                    'volumes': {'frontend-build': {'name': 'old-volume'}, 'backend-cache': {'name': 'same'}}}
        before = copy.deepcopy(document)
        args = SimpleNamespace(port=3202, attempt='a'*32, config_sha256='c'*64)
        previous = {'inputs': {'image_id': backend_image}, 'state_root': '/state',
                    'backend_volumes': {'same': 'cache'}, 'frontend_volume': 'old-volume'}
        source = {'commit': 'old-commit', 'source_digest': 'old-digest', 'snapshot': 'old-snapshot'}
        seed = {'files': [], 'source_commit': 'new-commit'}
        witness = {'attested': 'same'}
        package = ({'package': 'same'}, {'provenance': 'same'}, 'receipt-sha', 'binary-proof')
        counts = {'package': 0, 'image': 0}
        recreated = []

        def text(*argv):
            if argv[:2] == ('image', 'inspect'):
                self.assertEqual(argv[2], frontend_image)
                return json.dumps([{'Config': {'new': 'helper'}}])
            self.assertEqual(argv[0], 'inspect')
            return json.dumps([backend if argv[1] == backend['Id'] else
                               old_frontend if argv[1] == old_frontend['Id'] else new_frontend])

        def documents(*args):
            counts['package'] += 1
            if ((fault == 'package-before-recreate' and counts['package'] == 2)
                    or (fault == 'package-after-recreate' and counts['package'] == 3)):
                return (package[0], package[1], 'changed', package[3])
            return package

        def verified_image(*args):
            counts['image'] += 1
            return frontend_image, {'attested': 'changed' if fault == 'image-drift' and counts['image'] > 1 else 'same'}

        def observation(*args):
            return {'processes': ['changed' if fault == 'backend-pid-drift' and recreated else 'same'],
                    'api_instance_id': 'same', 'session': 'same', 'scene_revision': 1, 'active_session': True}

        def seeded(*args):
            self.assertEqual(args[-1], frontend_image)
            if fault == 'old-restarted':
                old_frontend['State'].update(Running=True, StartedAt='foreign')
            return seed, 'new-volume'

        def compose(doc, *argv, **kwargs):
            if argv[0] == 'ps':
                return new_frontend['Id'].encode()
            self.assertEqual(argv, ('up', '--detach', '--no-build', '--pull', 'never',
                                   '--no-deps', '--force-recreate', 'frontend'))
            self.assertEqual(doc['services']['backend'], before['services']['backend'])
            self.assertEqual(doc['services']['frontend']['image'], frontend_image)
            self.assertEqual(doc['services']['frontend']['mem_limit'], str(8 * 1024**3))
            self.assertIn(dev._FRONTEND_OWNER_TMPFS + ':rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700',
                          doc['services']['frontend']['tmpfs'])
            recreated.append(copy.deepcopy(doc))
            if fault == 'unknown-recreate':
                raise ControlOutcomeUnknown('daemon outcome unknown')
            return b''

        def view(*args, **kwargs):
            if fault == 'new-restarted':
                new_frontend['State']['StartedAt'] = 'foreign-new-start'
            if fault == 'new-exited':
                new_frontend['State']['Running'] = False
            return {'files': []}

        with mock.patch.object(build_control.subprocess, 'Popen', return_value=logger), \
             mock.patch.object(fullmag_storage, 'validate_path', return_value=Path('/state')), \
             mock.patch.object(dev, '_session_host', return_value=windows_folder_host), \
             mock.patch.object(windows_folder_host, 'read_owned_regular', return_value=b'{"owner":"same"}'), \
             mock.patch.object(dev, '_retained_startup_enabled', return_value=False), \
             mock.patch.object(dev, 'docker_text', side_effect=text), \
             mock.patch.object(dev, 'docker_capture') as stopped, \
             mock.patch.object(dev, '_assert_private_restart_network'), \
             mock.patch.object(reconcile, 'fingerprint', side_effect=lambda doc: doc['Id']), \
             mock.patch.object(dev, '_verified_frontend_recovery_image', side_effect=verified_image), \
             mock.patch.object(dev, '_frontend_recovery_backend_observation', side_effect=observation), \
             mock.patch.object(codegen, '_backend_documents', side_effect=documents), \
             mock.patch.object(codegen, '_validate_backend', return_value=(source, 'p', 'b')), \
             mock.patch.object(codegen, '_probe_source', side_effect=AssertionError('native source qualification forbidden')), \
             mock.patch.object(frontend_inputs, 'describe', return_value=seed), \
             mock.patch.object(frontend_inputs, 'frontend_view', side_effect=view), \
             mock.patch.object(dev, '_frontend', side_effect=seeded), \
             mock.patch.object(dev, 'compose_capture', side_effect=compose), \
             mock.patch.object(dev, '_validate_retained_service'):
            try:
                dev._refresh_frontend_services(control, args, 'development/attempts/old', previous,
                    document, Path('/selected'), {'runtime_root': '/runtime'}, observed,
                    {'backend': backend['Id'], 'frontend': old_frontend['Id']}, backend_image, {}, recover_oom=True)
            except (dev.BuildControlError, codegen.CodegenError):
                if fault is None:
                    raise
            stopped.assert_not_called()
        self.assertEqual(document, before)
        return writes, recreated, logger

    def test_legacy_recreation_uses_new_frontend_image_and_preserves_old_backend_and_active_scene(self):
        writes, recreated, logger = self.run_legacy()
        terminal = next(v for k, v in writes.items() if k.endswith('/terminal.json'))
        self.assertEqual(terminal['state'], 'succeeded')
        self.assertEqual(terminal['inputs']['image_id'], 'sha256:' + '1'*64)
        self.assertEqual(terminal['frontend_image_id'], 'sha256:' + '2'*64)
        self.assertEqual(terminal['backend_container'], 'b'*64)
        self.assertEqual(terminal['selected_source_qualification'], 'NOT VERIFIED')
        self.assertFalse(terminal['native_build_executed'])
        self.assertEqual(terminal['backend_observation']['session'], 'same')
        self.assertEqual(len(recreated), 1)
        self.assertTrue(any(k.endswith('/rollback-compose.json') for k in writes))
        logger.wait.assert_called_once()

    def test_non_oom_is_refused_without_seeding_or_lifecycle(self):
        writes, recreated, logger = self.run_legacy('not-oom')
        self.assertEqual(writes, {})
        self.assertEqual(recreated, [])

    def test_oom_cas_image_or_backend_package_drift_refuses_before_recreation(self):
        for fault in ('old-restarted', 'image-drift', 'package-before-recreate'):
            with self.subTest(fault=fault):
                writes, recreated, logger = self.run_legacy(fault)
                self.assertEqual(recreated, [])
                self.assertFalse(any(k.endswith('/terminal.json') for k in writes))
                logger.wait.assert_not_called()

    def test_unknown_or_post_recreation_drift_retains_real_control_lease(self):
        for fault in ('unknown-recreate', 'backend-pid-drift', 'package-after-recreate', 'new-restarted', 'new-exited', 'memory-drift'):
            with self.subTest(fault=fault):
                writes, recreated, logger = self.run_legacy(fault)
                self.assertEqual(len(recreated), 1)
                self.assertFalse(any(k.endswith('/terminal.json') for k in writes))
                receipt = next(v for k, v in writes.items() if k.endswith('/receipt.json'))
                self.assertEqual(receipt['state'], 'outcome-unknown-resources-retained')
                logger.wait.assert_not_called()


class FrontendRecoveryImageTests(unittest.TestCase):
    def fixture(self):
        import hashlib
        from docker_dev import BASE_CONTEXT_FILES, RUNTIME_IMAGE_CONTEXT_FILES
        control = mock.Mock(project='own', volume='control', identity={})
        manifests = {}
        records = {}
        images = {}
        parent, layers = None, []
        for n, (kind, inventory) in enumerate((('toolchain', None), ('image-dev', BASE_CONTEXT_FILES),
                                               ('image-backend', RUNTIME_IMAGE_CONTEXT_FILES))):
            image = 'sha256:' + str(n+1)*64
            if inventory is None:
                inputs = {'source_inputs': [{'path': 'dependency', 'sha256': hashlib.sha256(b'dependency').hexdigest()}],
                          'build_args': {'BASE': 'pinned'}, 'target': 'fem-gpu-dev'}
            else:
                names = sorted({relative for _, relative in inventory}
                    | {'docker/all-in-one/Dockerfile.' + kind.removeprefix('image-') + '.dockerignore'})
                inputs = {'parent_image_id': parent, 'files': [
                    {'path': name, 'sha256': hashlib.sha256(name.encode()).hexdigest()} for name in names]}
            digest = hashlib.sha256(build_control.canonical(inputs)).hexdigest()
            manifests[kind + '/verified.json'] = {'schema': 'fullmag.docker-build-operation.v1',
                'phase': kind, 'state': 'succeeded', 'compose_project': 'own', 'control_volume': 'control',
                'image_id': image, 'inputs': inputs, 'source_digest': digest}
            layers = layers + [str(n)]
            records[image] = {'Id': image, 'RootFS': {'Layers': layers}, 'Config': {'Labels': {
                'org.fullmag.compose.project': 'own', 'org.fullmag.build.input-digest': digest,
                'org.fullmag.toolchain.image-id': 'sha256:' + '1'*64}}}
            images[kind] = image
            parent = image
        control.read.side_effect = lambda path: manifests[path]
        return control, manifests, records, images

    def run_attestation(self, control, records, *, changed_input=False):
        import bootstrap_docker_toolchain as bootstrap
        with mock.patch.object(build_control, 'toolchain_configuration', return_value={
                    'services': {'fem-gpu-toolchain': {'build': {'args': {'BASE': 'pinned'}, 'target': 'fem-gpu-dev'}}}}), \
             mock.patch.object(bootstrap, 'tracked_input_files', return_value=[Path('dependency')]), \
             mock.patch.object(bootstrap, 'read_input', side_effect=lambda root, name:
                    b'changed' if changed_input else str(name).encode()), \
             mock.patch.object(dev, 'docker_text', side_effect=lambda *argv: json.dumps([records[argv[2]]])):
            return dev._verified_frontend_recovery_image(control, Path('/selected'))

    def test_exact_recipe_manifest_labels_and_layer_chain_are_accepted(self):
        control, manifests, records, images = self.fixture()
        image, witness = self.run_attestation(control, records)
        self.assertEqual(image, images['image-backend'])
        self.assertEqual(set(witness), {'toolchain', 'image-dev', 'image-backend'})

    def test_context_changes_and_wrong_receipt_or_label_or_parent_fail_closed(self):
        for fault in ('context', 'receipt-parent', 'labels', 'layers', 'mutable-image'):
            with self.subTest(fault=fault):
                control, manifests, records, images = self.fixture()
                backend = records[images['image-backend']]
                if fault == 'receipt-parent':
                    manifests['image-backend/verified.json']['inputs']['parent_image_id'] = 'other'
                elif fault == 'labels':
                    backend['Config']['Labels']['org.fullmag.build.input-digest'] = 'wrong'
                elif fault == 'layers':
                    backend['RootFS']['Layers'] = ['foreign', '2']
                elif fault == 'mutable-image':
                    manifests['image-backend/verified.json']['image_id'] = 'mutable:latest'
                with self.assertRaises(dev.BuildControlError):
                    self.run_attestation(control, records, changed_input=fault == 'context')


class FrontendRecoveryDispatchTests(unittest.TestCase):
    def run_dispatch(self, *, legacy=True, wrong_frontend_image=False):
        import hashlib
        import docker_dev
        backend_image, frontend_image = 'sha256:' + '1'*64, 'sha256:' + ('1' if legacy else '2')*64
        source = Path('/selected')
        document = {'name': 'own', 'services': {
            'backend': {'image': backend_image},
            'frontend': {'image': frontend_image, 'tmpfs': [] if legacy else [
                dev._FRONTEND_OWNER_TMPFS + ':rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700']}}}
        previous = {'state': 'succeeded', 'compose_project': 'own',
                    'backend_container': 'b'*64, 'frontend_container': 'f'*64,
                    'inputs': {'source_root': str(source), 'image_id': backend_image}}
        control = mock.Mock(project='own')
        control.read.side_effect = lambda path: document if path.endswith('/compose.json') else previous
        args = SimpleNamespace(repo_root=str(Path(__file__).resolve().parent.parent), source_root=str(source),
                               attempt='a'*32, config_sha256=hashlib.sha256(build_control.canonical(document)).hexdigest(),
                               port=3202)
        def text(*argv):
            if argv[:2] == ('image', 'inspect'):
                return json.dumps([{'Id': argv[2], 'Config': {'image_marker': argv[2]}}])
            service = 'backend' if argv[1] == 'b'*64 else 'frontend'
            image = document['services'][service]['image']
            if service == 'frontend' and wrong_frontend_image:
                image = backend_image if image != backend_image else 'sha256:' + '3'*64
            return json.dumps([{'Id': argv[1], 'Image': image, 'Config': {'Labels': {
                'com.docker.compose.project': 'own', 'com.docker.compose.service': service,
                'org.fullmag.source.worktree-id': 'worktree'}}}])
        with mock.patch.object(dev, 'require_host'), \
             mock.patch.object(docker_dev, '_select_source', return_value=(source, {})), \
             mock.patch.object(docker_dev, '_compose_identity', return_value={'worktree_id': 'worktree'}), \
             mock.patch.object(build_control, 'toolchain_configuration', return_value={
                 'services': {'fem-gpu-toolchain': {'build': {'args': {'FULLMAG_CUDA_BASE_IMAGE': 'helper'}}}}}), \
             mock.patch.object(dev, 'BuildControl', return_value=control), \
             mock.patch.object(dev, '_operator_probe_record_from_retained', return_value={}), \
             mock.patch.object(dev, 'compose_capture', side_effect=lambda doc, *argv: (
                 'b'*64 if argv[-1] == 'backend' else 'f'*64).encode()), \
             mock.patch.object(dev, 'docker_text', side_effect=text), \
             mock.patch.object(dev, '_validate_retained_service') as validate, \
             mock.patch.object(dev, '_refresh_frontend_services') as refresh, \
             mock.patch.object(dev, '_resume_oom_frontend') as resume:
            if wrong_frontend_image:
                with self.assertRaisesRegex(dev.BuildControlError, 'ownership differs'):
                    dev._retained_operation(args, recreate_services=False)
            else:
                dev._retained_operation(args, recreate_services=False)
            return validate, refresh, resume, backend_image, frontend_image

    def test_legacy_resume_is_only_dispatched_to_controlled_recreation(self):
        validate, refresh, resume, _, _ = self.run_dispatch()
        self.assertTrue(validate.call_args_list[-1].kwargs['allow_legacy_frontend'])
        self.assertTrue(refresh.call_args.kwargs['recover_oom'])
        resume.assert_not_called()

    def test_mixed_image_handoff_validates_each_service_against_its_image_config(self):
        validate, refresh, resume, backend_image, frontend_image = self.run_dispatch(legacy=False)
        self.assertEqual([call.args[3]['image_marker'] for call in validate.call_args_list],
                         [backend_image, frontend_image])
        self.assertFalse(validate.call_args_list[-1].kwargs['allow_legacy_frontend'])
        refresh.assert_not_called()
        resume.assert_called_once()

    def test_foreign_frontend_image_is_refused_before_any_recovery(self):
        validate, refresh, resume, _, _ = self.run_dispatch(legacy=False, wrong_frontend_image=True)
        refresh.assert_not_called()
        resume.assert_not_called()


class FrontendRecoveryObservationTests(unittest.TestCase):
    def run_observation(self, status, *, active=True):
        import urllib.request
        health = {'status': 'ok', 'active_session': active}
        def response(body):
            return nullcontext(SimpleNamespace(status=200, headers={'x-fullmag-api-instance': 'api'},
                                               read=lambda: json.dumps(body).encode()))
        def execute(container, arguments, **kwargs):
            output = io.StringIO()
            with redirect_stdout(output):
                exec(arguments[-1], {'__name__': '__main__'})
            return output.getvalue().encode(), b''
        stat_fields = '10 (fullmag-api) ' + ' '.join(['S'] + ['0']*18 + ['100'])
        with mock.patch.object(codegen, '_exec', side_effect=execute), \
             mock.patch.object(Path, 'iterdir', return_value=[Path('/proc/10')]), \
             mock.patch.object(Path, 'read_text', return_value=stat_fields), \
             mock.patch('os.readlink', return_value='/usr/bin/fullmag-api'), \
             mock.patch.object(urllib.request, 'urlopen', side_effect=[response(health), response(status)]):
            return dev._frontend_recovery_backend_observation('backend')

    def test_actual_probe_pins_retained_session_scene_and_process(self):
        status = {'session': {'session_id': 'session', 'session_epoch': 'session@1', 'request_scope_epoch': 'api:1'},
                  'resources': {'scene_revision': 1}, 'run': {'run_id': 'cancelled-run'}}
        result = self.run_observation(status)
        self.assertEqual(result['scene_revision'], 1)
        self.assertEqual(result['run_id'], 'cancelled-run')
        self.assertEqual(result['processes'][0]['start_ticks'], '100')
        status['run'] = None
        self.assertIsNone(self.run_observation(status)['run_id'])

    def test_actual_probe_refuses_missing_or_malformed_scene_run_and_session(self):
        original = {'session': {'session_id': 'session', 'session_epoch': 'session@1', 'request_scope_epoch': 'api:1'},
                    'resources': {'scene_revision': 1}, 'run': {'run_id': 'cancelled-run'}}
        for field, value in [('resources', {}), ('resources', {'scene_revision': True}),
                             ('resources', {'scene_revision': -1}), ('run', {}), ('run', []),
                             ('run', {'run_id': 1}), ('session', {})]:
            with self.subTest(field=field, value=value):
                status = copy.deepcopy(original)
                status[field] = value
                with self.assertRaises(RuntimeError):
                    self.run_observation(status)
        with self.assertRaises(RuntimeError):
            self.run_observation(original, active=False)


if __name__ == '__main__':
    unittest.main()
