"""Ownership and interruption regressions for console-managed Docker services."""
from contextlib import ExitStack
import copy
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, MagicMock, patch

from docker_build_control import BuildControlError
from fullmag_console import Invocation
import fullmag_console_runtime as subject


BACKEND = 'b' * 64
FRONTEND = 'f' * 64
TOKEN = 'a' * 32
IMAGE = 'sha256:' + 'c' * 64
SOURCE = Path('/selected/source')


def runtime():
    value = subject.ConsoleRuntime(SimpleNamespace(repo_root=SOURCE, port=3342, gpu_access='required'),
                                   Invocation('gui', str(SOURCE), 'case.py'), SOURCE, TOKEN)
    value.output = Mock()
    value.identity = {'project_name': 'fullmag-fixture'}
    value.control = Mock()
    return value


def services():
    return {'backend': {'Id': BACKEND, 'Image': IMAGE,
                        'State': {'StartedAt': 'backend-start', 'Running': True, 'Pid': 1}},
            'frontend': {'Id': FRONTEND, 'Image': IMAGE,
                         'State': {'StartedAt': 'frontend-start', 'Running': True, 'Pid': 2}}}


class OwnershipTests(unittest.TestCase):
    def test_only_a_receipt_bound_to_this_console_can_own_services(self):
        value = runtime()
        receipt = {'inputs': {'source_root': str(SOURCE), 'console_session_id': 'd' * 32},
                   'backend_container': BACKEND, 'frontend_container': FRONTEND}
        with patch.object(value, '_operation_candidates', return_value=[('development', 'e' * 32, receipt)]), \
             patch.object(subject, 'docker_capture') as docker:
            self.assertIsNone(value._owned_services())
            docker.assert_not_called()

    def test_exact_receipt_images_and_service_incarnations_are_required(self):
        value = runtime()
        receipt = {'inputs': {'source_root': str(SOURCE), 'console_session_id': TOKEN},
                   'backend_container': BACKEND, 'frontend_container': FRONTEND,
                   'backend_started_at': 'backend-start', 'frontend_started_at': 'frontend-start'}
        document = {'services': {'backend': {'image': IMAGE}, 'frontend': {'image': IMAGE}}}
        value.control.read.return_value = document
        pair = services()
        def docker(*args, **kwargs):
            if args[:2] == ('image', 'inspect'):
                return SimpleNamespace(stdout=json.dumps([{'Id': IMAGE, 'Config': {}}]).encode())
            return SimpleNamespace(stdout=json.dumps(list(pair.values())).encode())
        with patch.object(value, '_operation_candidates', return_value=[('development', 'e' * 32, receipt)]), \
             patch.object(subject, 'docker_capture', side_effect=docker), \
             patch('docker_compose_identity.validate_source_labels'), \
             patch('docker_volume_dev._validate_retained_service'):
            owned = value._owned_services()
            self.assertEqual(owned['backend']['Id'], BACKEND)
            pair['backend']['State']['StartedAt'] = 'replacement'
            with self.assertRaisesRegex(BuildControlError, 'incarnation changed'):
                value._owned_services()

    def test_changed_backend_identity_prevents_group_shutdown(self):
        value = runtime()
        value.group = SimpleNamespace(backend_id=BACKEND, frontend_id=FRONTEND,
                                      backend={'State': {'StartedAt': 'backend-start'}})
        replacement = SimpleNamespace(backend_id='d' * 64, frontend_id=FRONTEND)
        with patch.object(value, '_arguments', return_value=SimpleNamespace()), \
             patch('docker_dev_up._discover_group', return_value=replacement), \
             patch('docker_volume_dev.stop_idle') as stop:
            with self.assertRaisesRegex(BuildControlError, 'group changed'):
                value.shutdown({'state': 'terminal'})
            stop.assert_not_called()

    def test_unknown_cancellation_never_calls_idle_stop(self):
        value = runtime()
        with patch('docker_volume_dev.stop_idle') as stop:
            with self.assertRaisesRegex(BuildControlError, 'unconfirmed'):
                value.shutdown({'state': 'unknown'})
            stop.assert_not_called()

    def test_terminal_run_is_reobserved_before_pinned_group_stop(self):
        value = runtime()
        group = SimpleNamespace(backend_id=BACKEND, frontend_id=FRONTEND, attempt='e' * 32,
                                config_sha256='d' * 64, port=3342,
                                backend={'State': {'StartedAt': 'backend-start'}})
        value.group = group
        result = {'state': 'terminal', 'api_instance_id': 'api', 'session_id': 'session',
                  'run_id': 'run', 'session_epoch': 'epoch', 'request_scope_epoch': 'scope'}
        with patch.object(value, '_arguments', return_value=SimpleNamespace()), \
             patch('docker_dev_up._discover_group', return_value=group), \
             patch('docker_dev_run_script._probe_with_retry', return_value={'run_status': 'completed'}) as observe, \
             patch('docker_volume_dev.stop_idle') as stop:
            value.shutdown(result)
            self.assertEqual(observe.call_args.args, (BACKEND, 'run'))
            self.assertEqual(observe.call_args.kwargs['run_id'], 'run')
            self.assertEqual(stop.call_args.args[0].attempt, group.attempt)
            self.assertEqual(stop.call_args.args[0].config_sha256, group.config_sha256)
            self.assertTrue(value.closed)


class StartupInterruptionTests(unittest.TestCase):
    def test_dependency_operation_reaches_its_boundary_after_one_interrupt(self):
        value = runtime()
        child = Mock()
        child.poll.side_effect = [None, None, 0]
        value.child = child
        with patch.object(value, '_owned_services', return_value=None), \
             patch.object(value, '_follow_build_log'), patch.object(subject.time, 'sleep'), \
             patch.object(value, '_arguments'), patch('docker_dev_up._discover_group', return_value=None):
            value.cancel_start()
        child.send_signal.assert_called_once()
        child.kill.assert_not_called()
        self.assertTrue(value.stopping)

    def test_owned_build_is_signalled_after_durable_intent_and_frontend_closes_after_child_exit(self):
        value = runtime()
        child = Mock()
        child.poll.side_effect = [None, None, 0]
        value.child = child
        pair = services()
        pair.update(attempt='e' * 32, config_sha256='d' * 64)
        stopped = copy.deepcopy(pair)
        stopped['backend']['State'].update(Running=False, Pid=0)
        events = []
        value.control.write.side_effect = lambda path, document: events.append(path.rsplit('/', 1)[-1])
        def signal_build(*args, **kwargs):
            self.assertIn('startup-stop-intent.json', events)
            self.assertEqual(args[1], BACKEND)
            return SimpleNamespace(returncode=0, stdout=b'{"state":"signalled","pid":42,"start_token":"123"}')
        with patch.object(value, '_owned_services', side_effect=[pair, stopped]), \
             patch.object(value, '_follow_build_log'), patch.object(subject.time, 'sleep'), \
             patch.object(subject, 'docker_capture', side_effect=signal_build), \
             patch.object(value, '_stop_remaining_frontend') as stop_frontend:
            value.cancel_start()
        self.assertEqual(events, ['startup-stop-intent.json', 'startup-stop-proof.json'])
        stop_frontend.assert_called_once_with(stopped)
        self.assertTrue(value.closed)

    def test_transient_metadata_failure_waits_for_child_and_then_stops_owned_services(self):
        value = runtime()
        child = Mock()
        child.poll.side_effect = [None, None, 0]
        value.child = child
        pair = services()
        pair['backend']['State'].update(Running=False, Pid=0)
        with patch.object(value, '_owned_services', side_effect=[BuildControlError('temporary read'), pair]), \
             patch.object(value, '_follow_build_log'), patch.object(subject.time, 'sleep'), \
             patch.object(value, '_stop_remaining_frontend') as stop:
            value.cancel_start()
        child.send_signal.assert_called_once()
        stop.assert_called_once_with(pair)
        self.assertTrue(value.closed)

    def test_log_observer_failure_does_not_abandon_detached_startup(self):
        value = runtime()
        value.child = Mock()
        value.child.poll.side_effect = [None, None, 0]
        pair = services()
        pair['backend']['State'].update(Running=False, Pid=0)
        with patch.object(value, '_follow_build_log', side_effect=OSError('log client unavailable')), \
             patch.object(value, '_owned_services', return_value=pair), patch.object(subject.time, 'sleep'), \
             patch.object(value, '_stop_remaining_frontend') as stop:
            value.cancel_start()
        stop.assert_called_once_with(pair)
        self.assertTrue(value.closed)

    def test_intent_write_failure_never_signals_and_still_waits_for_worker_exit(self):
        value = runtime()
        value.child = Mock()
        value.child.poll.side_effect = [None, None, 0]
        pair = services()
        stopped = copy.deepcopy(pair)
        pair.update(attempt='e' * 32, config_sha256='d' * 64)
        stopped['backend']['State'].update(Running=False, Pid=0)
        value.control.write.side_effect = BuildControlError('write unavailable')
        with patch.object(value, '_owned_services', side_effect=[pair, stopped]), \
             patch.object(value, '_follow_build_log'), patch.object(subject.time, 'sleep'), \
             patch.object(value, '_stop_remaining_frontend') as stop, patch.object(subject, 'docker_capture') as docker:
            value.cancel_start()
        docker.assert_not_called()
        stop.assert_called_once_with(stopped)
        self.assertTrue(value.closed)

    def test_unowned_live_services_are_reported_instead_of_claimed_stopped(self):
        value = runtime()
        value.child = Mock()
        value.child.poll.return_value = 0
        with patch.object(value, '_owned_services', return_value=None), \
             patch.object(value, '_arguments'), patch('docker_dev_up._discover_group', return_value=SimpleNamespace(
                 backend_running=True, frontend_running=False)), patch.object(subject, 'docker_capture') as docker:
            with self.assertRaisesRegex(BuildControlError, 'without authenticated console ownership'):
                value.cancel_start()
        docker.assert_not_called()
        self.assertFalse(value.closed)

    def test_runtime_appearing_during_freeze_is_not_terminated(self):
        startup, native = MagicMock(), MagicMock()
        startup.name, native.name = '42', '43'
        root = MagicMock()
        root.iterdir.side_effect = [[startup], [native]]
        process = MagicMock()
        root.__truediv__.return_value = process
        process.__truediv__.side_effect = lambda name: SimpleNamespace(
            read_bytes=lambda: b'python\0/opt/fullmag/backend_dev.py\0start\0',
            read_text=lambda: '42 (python) T ' + '0 ' * 18 + '123')
        startup.__truediv__.return_value = SimpleNamespace(
            read_bytes=lambda: b'python\0/opt/fullmag/backend_dev.py\0start\0')
        with patch('pathlib.Path', return_value=root), \
             patch('os.readlink', side_effect=['/usr/local/bin/python3', '/opt/fullmag/package/bin/fullmag-runtime-service']), \
             patch('os.pidfd_open', return_value=5), patch('os.close'), \
             patch('signal.pidfd_send_signal') as send, patch('sys.stdout', new_callable=io.StringIO) as output:
            with self.assertRaises(SystemExit):
                exec(subject.STOP_BUILD, {})
        self.assertEqual(json.loads(output.getvalue()), {'state': 'runtime'})
        self.assertEqual([call.args[1] for call in send.call_args_list], [subject.signal.SIGSTOP, subject.signal.SIGCONT])

    def test_native_runtime_prevents_the_build_cancellation_signal(self):
        import ast
        ast.parse(subject.STOP_BUILD)
        process = Mock()
        process.name = '42'
        process.__truediv__ = Mock(return_value=SimpleNamespace(read_bytes=lambda: b'fullmag-runtime-service\0'))
        fake_root = Mock()
        fake_root.iterdir.return_value = [process]
        with patch('pathlib.Path', return_value=fake_root), \
             patch('os.readlink', return_value='/opt/fullmag/package/bin/fullmag-runtime-service'), \
             patch('os.pidfd_open') as open_pid, patch('signal.pidfd_send_signal') as signal_pid, \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            with self.assertRaises(SystemExit) as exit_code:
                exec(subject.STOP_BUILD, {})
            self.assertEqual(exit_code.exception.code, 0)
            self.assertEqual(json.loads(output.getvalue()), {'state': 'runtime'})
            open_pid.assert_not_called()
            signal_pid.assert_not_called()


if __name__ == '__main__':
    unittest.main()
