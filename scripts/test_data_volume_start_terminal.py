"""Exact terminal capture from one completed DEV start; no runtime is started."""
import hashlib
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_volume_dev as volume


class StartTerminalTests(unittest.TestCase):
    def test_capture_refuses_invalid_or_caller_owned_mode_before_host_actions(self):
        for kwargs in ({'capture_terminal': None}, {'capture_terminal': 1},
                       {'capture_terminal': True, 'operation': {}},
                       {'capture_terminal': True, 'control': object()}):
            with self.subTest(kwargs=kwargs), mock.patch.object(volume, 'require_host') as host:
                with self.assertRaises(volume.BuildControlError):
                    volume.start(SimpleNamespace(), **kwargs)
                host.assert_not_called()

    def scenario(self):
        receipt = {'phase': 'development', 'state': 'succeeded', 'attempt': 'a'*32,
                   'compose_project': 'group-fixture', 'control_volume': 'volume-fixture',
                   'backend_container': 'b'*64, 'frontend_container': 'c'*64}
        operation = {'root': 'development/attempts/'+'a'*32, 'receipt': receipt,
                     'daemon_pending': False}
        raw = volume.canonical(receipt) + b'\n'
        control = SimpleNamespace(_active_operation=None, project='group-fixture',
            volume='volume-fixture', read_bytes=mock.Mock(return_value=raw))
        return control, operation, raw

    def test_captures_only_its_exact_terminal_after_the_operation_closed(self):
        control, operation, raw = self.scenario()
        value = volume._captured_start_terminal(control, operation)
        self.assertEqual(value['relative'], operation['root']+'/terminal.json')
        self.assertEqual(value['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(value['receipt'], operation['receipt'])
        value['receipt']['state'] = 'changed'
        self.assertEqual(operation['receipt']['state'], 'succeeded')
        control.read_bytes.assert_called_once_with(operation['root']+'/terminal.json')

    def test_refuses_active_pending_failed_foreign_or_wrong_attempt_before_read(self):
        changes = ('active', 'pending', 'failed', 'project', 'volume', 'root', 'backend')
        for change in changes:
            with self.subTest(change=change):
                control, operation, _raw = self.scenario()
                if change == 'active': control._active_operation = operation
                elif change == 'pending': operation['daemon_pending'] = True
                elif change == 'failed': operation['receipt']['state'] = 'failed-confirmed'
                elif change == 'project': operation['receipt']['compose_project'] = 'foreign'
                elif change == 'volume': operation['receipt']['control_volume'] = 'foreign'
                elif change == 'root': operation['root'] = 'development/attempts/'+'d'*32
                else: operation['receipt']['backend_container'] = 'short'
                with self.assertRaises(volume.BuildControlError):
                    volume._captured_start_terminal(control, operation)
                control.read_bytes.assert_not_called()

    def test_refuses_missing_changed_or_other_terminal_instead_of_using_current(self):
        for raw in (None, b'', b'{}\n', b'foreign terminal\n'):
            with self.subTest(raw=raw):
                control, operation, _ = self.scenario()
                control.read_bytes.return_value = raw
                with self.assertRaises(volume.BuildControlError):
                    volume._captured_start_terminal(control, operation)
                control.read_bytes.assert_called_once_with(operation['root']+'/terminal.json')


if __name__ == '__main__':
    unittest.main()
