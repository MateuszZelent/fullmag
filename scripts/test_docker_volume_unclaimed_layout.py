"""Cancellation preserves the pinned private group layout before allocation."""
import ast
import copy
from contextlib import ExitStack, contextmanager
from unittest.mock import Mock
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_volume_unclaimed_cancellation as cancellation
import docker_volume_dev as volume_dev
from docker_build_control import BuildControlError


class CancellationLayoutTests(unittest.TestCase):
    def test_group_layout_is_inherited_and_written(self):
        operation={'root':'development/attempts/test','receipt':{}}
        control=SimpleNamespace(write=lambda *args: None)
        cancellation._pin_cancellation_layout(control,operation,{'private_group_storage':'group-volume-v1'})
        self.assertEqual(operation['receipt']['private_group_storage'],'group-volume-v1')

    def test_unknown_layout_or_legacy_fallback_is_refused(self):
        control=SimpleNamespace(write=lambda *args: None,read=lambda *args,**kw:
            {'schema':'fullmag.docker-group-storage-owner.v1'})
        for previous in ({'private_group_storage':'unknown'},{}):
            with self.subTest(previous=previous),self.assertRaises(BuildControlError):
                cancellation._pin_cancellation_layout(control,{'root':'test','receipt':{}},previous)

    def test_all_three_maintenance_paths_pin_before_start(self):
        tree=ast.parse(Path(cancellation.__file__).read_text())
        for name in ('cancel_unclaimed','_resume_cancel_unclaimed','_resume_native_cancellation_failure'):
            function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
            calls=[n for n in ast.walk(function) if isinstance(n,ast.Call)]
            pins=[n.lineno for n in calls if isinstance(n.func,ast.Name) and n.func.id=='_pin_cancellation_layout']
            starts=[n.lineno for n in calls if isinstance(n.func,ast.Attribute) and n.func.attr=='start']
            self.assertEqual(len(pins),1,name)
            self.assertLess(pins[0],min(starts),name)



class PreparedPathResumeTests(unittest.TestCase):
    """The new path-error boundary must never become a generic retry route."""

    def setUp(self):
        self.args = SimpleNamespace(
            resume_maintenance_attempt='b' * 32, attempt='a' * 32,
            request_id='12345678-1234-4234-8234-123456789abc',
            config_sha256='c' * 64, prepared_quarantine_sha256='d' * 64,
            run_id='run_1', task_id='task_1',
        )
        self.control = SimpleNamespace(project='project', volume='volume', namespace='',
                                       operation=Mock(), write=Mock(), write_bytes=Mock())
        witness = {
            'schema': 'fullmag.docker-prepared-unclaimed-quarantine.v1',
            'quarantine_sha256': 'd' * 64, 'stop_journal_sha256': 'e' * 64,
            'target': {'run_id': 'run_1', 'task_id': 'task_1'},
            'retained_native_contracts': ['fem-demag-poisson'],
        }
        self.before = {
            'schema': 'fullmag.docker-volume-unclaimed-cancellation-before.v1',
            'request_id': self.args.request_id, 'request_sha256': 'f' * 64,
            'prior_attempt': self.args.attempt, 'prior_compose_sha256': self.args.config_sha256,
            'prepared_unclaimed_quarantine': witness,
        }
        self.failed = {
            'schema': 'fullmag.docker-build-operation.v1', 'phase': 'development',
            'state': 'failed-confirmed', 'attempt': self.args.resume_maintenance_attempt,
            'compose_project': 'project', 'control_volume': 'volume',
            'helper_container': 'fullmag-control-' + self.args.resume_maintenance_attempt,
            'error': 'Invalid control-volume relative path',
            'inputs': {'prepared_unclaimed_quarantine': copy.deepcopy(witness),
                       'unclaimed_cancellation': {
                           'request_id': self.args.request_id, 'request_sha256': 'f' * 64,
                           'request_path': cancellation._request_path(self.args.request_id)}},
        }
        self.checkpoints = {'stopped': b'{}\n', 'removed': b'{}\n'}

    def invoke(self, *, current_matches=True):
        self.failed['unclaimed_cancellation_preflight'] = self.before
        terminal = cancellation.canonical(self.failed) + b'\n'
        before_raw = cancellation.canonical(self.before) + b'\n'

        def read(_control, path, **kwargs):
            if path == 'development/current.json' and not current_matches:
                return b'changed terminal'
            if path == 'development/attempts/' + self.args.attempt + '/terminal.json':
                raise RuntimeError('reached original terminal gate')
            if path.endswith('/unclaimed-cancellation-before.json'):
                return before_raw
            for kind in ('stopped', 'removed'):
                if path.endswith('/unclaimed-cancellation-' + kind + '.json'):
                    return self.checkpoints[kind]
            return terminal

        try:
            with patch.object(cancellation, '_control_raw', side_effect=read), \
                    patch.object(cancellation, 'docker_capture') as docker:
                try:
                    cancellation._resume_cancel_unclaimed(
                        self.args, Path('/checkout'), {}, {}, 'image', self.control)
                finally:
                    docker.assert_not_called()
        finally:
            self.control.operation.assert_not_called()
            self.control.write.assert_not_called()
            self.control.write_bytes.assert_not_called()

    def test_exact_prepared_path_error_reaches_existing_original_terminal_gate(self):
        with self.assertRaisesRegex(RuntimeError, '^reached original terminal gate$'):
            self.invoke()

    def test_prepared_path_error_requires_exact_current_terminal(self):
        with self.assertRaisesRegex(BuildControlError, 'exact current terminal receipt'):
            self.invoke(current_matches=False)

    def full_resume(self, corrupt=None):
        """Exercise durable proof copying through the real resume orchestration."""
        self.args.port = 3197
        image = 'sha256:' + '1' * 64
        ids = {'backend': '2' * 64, 'frontend': '3' * 64}
        document = {'name': self.control.project, 'services': {
            'backend': {'environment': {'FULLMAG_DOCKER_DEVICE_ACCESS': 'cpu'}},
            'frontend': {'ports': [{'host_ip': '127.0.0.1', 'target': 8080,
                                   'protocol': 'tcp', 'published': '3197'}]},
        }}
        self.args.config_sha256 = cancellation._sha256(cancellation.canonical(document))
        identity = {'project_id': 'project-id', 'worktree_id': 'worktree-id',
                    'checkout_kind': 'worktree'}
        previous = {'state': 'succeeded', 'attempt': self.args.attempt,
                    'compose_project': self.control.project, 'state_root': '/state',
                    'private_group_storage': 'group-volume-v1',
                    'backend_container': ids['backend'], 'frontend_container': ids['frontend'],
                    'inputs': {'source_root': '/checkout', 'source_project_id': 'project-id',
                               'source_worktree_id': 'worktree-id', 'source_checkout_kind': 'worktree',
                               'image_id': image, 'gpu_access_requested': 'disabled', 'device_access': 'cpu'}}
        previous_raw = cancellation.canonical(previous) + b'\n'
        config_raw, owner_raw, catalog_raw = b'config', b'owner', b'catalog'
        process_raw = cancellation.canonical({'schema': 'fullmag.docker-process-tree.v1',
                                               'state': 'shutdown_unknown'}) + b'\n'
        request_raw = b'original immutable request'
        request_sha = cancellation._sha256(request_raw)
        maintenance = self.failed['inputs']['unclaimed_cancellation']
        maintenance['request_sha256'] = request_sha
        self.failed['inputs'].update(source_root='/checkout', image_id=image,
                                     gpu_access_requested='disabled', device_access='cpu')
        self.before.update(
            request_sha256=request_sha, prior_compose_sha256=self.args.config_sha256,
            prior_terminal_sha256=cancellation._sha256(previous_raw),
            prior_runtime_config_sha256=cancellation._sha256(config_raw),
            prior_owner_sha256=cancellation._sha256(owner_raw),
            prior_process_receipt_sha256=cancellation._sha256(process_raw),
            prior_catalog_sha256=cancellation._sha256(catalog_raw),
            container_pins=[{'service': service, 'compose_project': self.control.project,
                             'image_id': image, 'container_id': ids[service],
                             'private_pid_namespace': True, 'host_pid': False,
                             'config_sha256': '4' * 64, 'device_requests_sha256': '5' * 64}
                            for service in ('backend', 'frontend')])
        observations = {}
        for service in ('backend', 'frontend'):
            observations[service] = {'service': service, 'project': self.control.project,
                                     'image_id': image, 'container_id': ids[service],
                                     'running': False, 'pid': 0, 'finished_at': '2026-11-05T10:00:00Z'}
            self.before[service] = observations[service]
        before_raw = cancellation.canonical(self.before) + b'\n'
        stopped = {'schema': 'fullmag.docker-volume-unclaimed-cancellation-stopped.v1',
                   'request_id': self.args.request_id, 'request_sha256': request_sha,
                   'preflight_sha256': cancellation._sha256(before_raw), 'container_ids': ids,
                   'containers': observations,
                   'docker_log_sha256': {service: cancellation._sha256(service.encode())
                                         for service in ('backend', 'frontend')}}
        stopped_raw = cancellation.canonical(stopped) + b'\n'
        removed = {'schema': 'fullmag.docker-volume-unclaimed-cancellation-removed.v1',
                   'request_id': self.args.request_id, 'request_sha256': request_sha,
                   'preflight_sha256': cancellation._sha256(before_raw), 'container_ids': ids,
                   'stopped_sha256': cancellation._sha256(stopped_raw)}
        if corrupt == 'stop-hash': stopped['preflight_sha256'] = '0' * 64
        if corrupt == 'removal-hash': removed['stopped_sha256'] = '0' * 64
        stopped_raw = cancellation.canonical(stopped) + b'\n'
        self.failed.update(unclaimed_cancellation_preflight=self.before,
                           unclaimed_cancellation_stopped=stopped,
                           unclaimed_cancellation_removed=removed)
        terminal_raw = cancellation.canonical(self.failed) + b'\n'
        failed_root = 'development/attempts/' + self.args.resume_maintenance_attempt
        prior_root = 'development/attempts/' + self.args.attempt
        files = {
            failed_root + '/terminal.json': terminal_raw,
            failed_root + '/receipt.json': terminal_raw, 'development/current.json': terminal_raw,
            failed_root + '/unclaimed-cancellation-before.json': before_raw,
            failed_root + '/unclaimed-cancellation-stopped.json': stopped_raw,
            failed_root + '/unclaimed-cancellation-removed.json': cancellation.canonical(removed) + b'\n',
            prior_root + '/terminal.json': previous_raw,
            prior_root + '/compose.json': cancellation.canonical(document) + b'\n',
            'runtime-control/runtime-service/docker-all.json': config_raw,
            'runtime-control/runtime-services/OWNER.json': owner_raw,
            'runtime-control/runtime-service/process-tree.json': process_raw,
            failed_root + '/prior-runtime-config.json': config_raw,
            failed_root + '/prior-runtime-owner.json': owner_raw,
            failed_root + '/prior-process-tree.json': process_raw,
            failed_root + '/backend-docker-logs.txt': b'backend',
            failed_root + '/frontend-docker-logs.txt': b'frontend',
            cancellation.REQUEST_ROOT + '/' + self.args.request_id + '.json': request_raw,
        }
        original = dict(files)
        operation = {'root': 'development/attempts/' + '6' * 32, 'receipt': {}}

        @contextmanager
        def leased_operation(_phase, inputs):
            operation['receipt']['inputs'] = inputs
            yield operation

        self.control.operation = Mock(side_effect=leased_operation)
        self.control.write = Mock(side_effect=lambda path, value: files.__setitem__(
            path, cancellation.canonical(value) + b'\n'))
        self.control.write_bytes = Mock(side_effect=lambda path, raw: files.__setitem__(path, raw))
        request = {'run_id': self.args.run_id, 'task_id': self.args.task_id,
                   'expected_catalog_sha256': cancellation._sha256(catalog_raw)}

        def start(*_args, **kwargs):
            kwargs['operation']['receipt']['unclaimed_cancellation_result'] = {
                'state': 'cancelled', 'native_result': {
                    'disposition': 'cancelled', 'request_id': self.args.request_id}}

        with ExitStack() as stack:
            def mock(obj, name, **kwargs):
                return stack.enter_context(patch.object(obj, name, **kwargs))
            mock(cancellation, '_control_raw', side_effect=lambda _control, path, **kw: files.get(path))
            mock(cancellation.storage, 'validate_path', return_value=Path('/state'))
            mock(cancellation, '_request_inputs', return_value=(request, request_raw, catalog_raw))
            mock(cancellation, '_assert_no_request_receipt')
            mock(cancellation, '_assert_removed')
            mock(cancellation, '_project_container_ids', side_effect=[{'foreign'} if corrupt == 'consumer' else set(), {'helper'}])
            mock(cancellation, '_volume_consumer_ids', side_effect=[set(), {'helper'}])
            mock(cancellation, '_operation_helper_id', return_value='helper')
            mock(cancellation, '_reuse_prepared_images', return_value={'images': {'backend': {'image_id': image}}})
            import docker_dev
            mock(docker_dev, '_resolve_gpu_access', return_value='disabled')
            mock(docker_dev, '_verify_docker_gpu_access', return_value='cpu')
            mock(volume_dev, '_certificate_path', return_value=Path('/certificate'))
            mock(volume_dev, '_retained_certificate', return_value={'image_id': image})
            mock(volume_dev, '_operator_probe_record_from_retained', return_value={})
            mock(volume_dev, 'include_untracked_from_compose', return_value=[])
            mock(volume_dev, '_session_host', return_value=SimpleNamespace(OWNER_NAME='OWNER'))
            mock(volume_dev, 'start', side_effect=start)
            mock(cancellation, 'docker_capture', side_effect=AssertionError('unexpected Docker call'))
            stack.enter_context(patch('builtins.print'))
            try:
                cancellation._resume_cancel_unclaimed(self.args, Path('/checkout'),
                    {'runtime_root': '/runtime'}, identity, 'helper-image', self.control)
            finally:
                for path, raw in original.items():
                    self.assertEqual(files[path], raw, path)
        return files, original, operation, before_raw

    def test_resume_persists_original_before_bytes_with_historical_link(self):
        files, original, operation, before_raw = self.full_resume()
        path = operation['root'] + '/unclaimed-cancellation-before.json'
        self.control.write_bytes.assert_called_once_with(path, before_raw)
        self.assertEqual(files[path], before_raw)
        self.assertEqual(operation['receipt']['unclaimed_cancellation_preflight'], self.before)
        link = operation['receipt']['unclaimed_cancellation_resume']
        self.assertEqual(link['failed_attempt'], self.args.resume_maintenance_attempt)
        self.assertEqual(link['preflight_sha256'], cancellation._sha256(before_raw))
        failed_raw = original['development/attempts/' + self.args.resume_maintenance_attempt + '/terminal.json']
        self.assertEqual(link['failed_terminal_sha256'], cancellation._sha256(failed_raw))

    def test_prepared_resume_still_rejects_broken_checkpoint_hash_chain(self):
        for corruption in ('stop-hash', 'removal-hash', 'consumer'):
            with self.subTest(corruption=corruption):
                self.setUp()
                message = 'has consumers' if corruption == 'consumer' else 'Persisted stop/removal checkpoints'
                with self.assertRaisesRegex(BuildControlError, message):
                    self.full_resume(corruption)
                self.control.operation.assert_not_called()
                self.control.write.assert_not_called()
                self.control.write_bytes.assert_not_called()

    def test_prepared_path_error_rejects_missing_or_mismatched_evidence(self):
        cases = ('no-witness', 'different-witness', 'no-stop', 'no-removal', 'no-checkpoints',
                 'cli-mismatch', 'bad-quarantine-hash', 'bad-journal-hash', 'no-target',
                 'bad-run', 'bad-task', 'different-run', 'different-task', 'backend-start',
                 'admission', 'result', 'generic-error', 'unknown-error')
        for case in cases:
            with self.subTest(case=case):
                self.setUp()
                witness = self.before['prepared_unclaimed_quarantine']
                if case == 'no-witness':
                    del self.before['prepared_unclaimed_quarantine']
                elif case == 'different-witness':
                    self.failed['inputs']['prepared_unclaimed_quarantine']['quarantine_sha256'] = '0' * 64
                elif case in ('no-stop', 'no-removal', 'no-checkpoints'):
                    for kind in ('stopped', 'removed'):
                        if case == 'no-checkpoints' or case == {'stopped': 'no-stop', 'removed': 'no-removal'}[kind]:
                            self.checkpoints[kind] = None
                elif case == 'cli-mismatch':
                    self.args.prepared_quarantine_sha256 = '0' * 64
                elif case in ('bad-quarantine-hash', 'bad-journal-hash', 'no-target', 'bad-run', 'bad-task'):
                    if case == 'bad-quarantine-hash': witness['quarantine_sha256'] = 'bad'
                    if case == 'bad-journal-hash': witness['stop_journal_sha256'] = 'bad'
                    if case == 'no-target': witness['target'] = {}
                    if case == 'bad-run': witness['target']['run_id'] = ''
                    if case == 'bad-task': witness['target']['task_id'] = '../task'
                    self.failed['inputs']['prepared_unclaimed_quarantine'] = copy.deepcopy(witness)
                elif case in ('different-run', 'different-task'):
                    setattr(self.args, case.removeprefix('different-') + '_id', 'other')
                elif case in ('backend-start', 'admission', 'result'):
                    key = {'backend-start': 'backend_started_at', 'admission': 'unclaimed_cancellation_admission',
                           'result': 'unclaimed_cancellation_result'}[case]
                    self.failed[key] = None
                else:
                    self.failed['error'] = 'Invalid control-volume relative path: anything' if case == 'generic-error' else 'unknown'
                with self.assertRaises(BuildControlError):
                    self.invoke()

if __name__=='__main__':
    unittest.main()
