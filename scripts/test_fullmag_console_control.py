"""Console identity propagation and cancellation before managed mutation."""
from contextlib import redirect_stdout
import io
import os
import unittest
from unittest.mock import Mock, patch

import docker_build_control as subject

TOKEN = 'a' * 32


def control():
    value = subject.BuildControl.__new__(subject.BuildControl)
    value.project = 'fullmag-test'
    value.volume = 'fullmag-control-test'
    value.namespace = ''
    value._active_operation = None
    value.space = Mock(return_value={'available_bytes': 64 * 1024**3})
    value.helper_args = Mock(return_value=['managed-control-helper'])
    value.write = Mock()
    value._line = Mock(side_effect=['READY', 'LOGGED'])
    value._pin_operation_helper = Mock(return_value='b' * 64)
    return value


class ConsoleControlTests(unittest.TestCase):
    def test_cancellation_is_rejected_before_admission_or_daemon_mutation(self):
        value = control()
        with patch.dict(os.environ, FULLMAG_CONSOLE_SESSION_ID=TOKEN, FULLMAG_CONSOLE_CANCEL_REQUESTED=TOKEN), \
             patch.object(subject.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(subject.BuildControlError, 'cancelled before'):
                with value.operation('development', {'source_root': '/source'}):
                    self.fail('cancelled operation was admitted')
        value.space.assert_not_called()
        spawn.assert_not_called()

    def test_invalid_or_conflicting_owner_cannot_admit_an_operation(self):
        for owner, inputs in [('bad', {}), (TOKEN, {'console_session_id': 'c' * 32})]:
            with self.subTest(owner=owner, inputs=inputs):
                value = control()
                with patch.dict(os.environ, FULLMAG_CONSOLE_SESSION_ID=owner, FULLMAG_CONSOLE_CANCEL_REQUESTED=''), \
                     patch.object(subject.subprocess, 'Popen') as spawn:
                    with self.assertRaises(subject.BuildControlError):
                        with value.operation('development', inputs):
                            self.fail('invalid owner was admitted')
                value.space.assert_not_called()
                spawn.assert_not_called()

    def test_durable_receipts_bind_console_without_mutating_caller_inputs(self):
        value = control()
        logger = Mock()
        logger.stdin.closed = True
        logger.wait.return_value = 0
        inputs = {'source_root': '/source'}
        with patch.dict(os.environ, FULLMAG_CONSOLE_SESSION_ID=TOKEN, FULLMAG_CONSOLE_CANCEL_REQUESTED=''), \
             patch.object(subject.subprocess, 'Popen', return_value=logger), redirect_stdout(io.StringIO()):
            with value.operation('development', inputs) as operation:
                self.assertEqual(operation['receipt']['inputs']['console_session_id'], TOKEN)
                operation['receipt']['state'] = 'succeeded'
        self.assertEqual(inputs, {'source_root': '/source'})
        terminals = [call.args[1] for call in value.write.call_args_list if call.args[0].endswith('/terminal.json')]
        self.assertEqual(len(terminals), 1)
        self.assertEqual(terminals[0]['inputs']['console_session_id'], TOKEN)


class SemanticBuildInputsTests(unittest.TestCase):
    def test_only_exact_valid_operational_token_is_projected_without_mutation(self):
        semantic={'source_inputs':[{'path':'Dockerfile','sha256':'b'*64}],'target':'fem-gpu-dev'}
        expected=subject.canonical(semantic)
        for token in ('9c4bc6be2de043d1b87c56648fa2f189','d'*32):
            inputs={**semantic,'console_session_id':token}
            self.assertEqual(subject.canonical(subject.semantic_build_inputs(inputs)),expected)
            self.assertEqual(subject.build_input_digest(inputs),subject.build_input_digest(semantic))
            self.assertEqual(inputs['console_session_id'],token)
        self.assertNotEqual(subject.build_input_digest({**semantic,'console_session_id_extra':TOKEN}),subject.build_input_digest(semantic))
    def test_malformed_operational_token_is_never_silently_removed(self):
        for token in (None,'','bad','A'*32,True,123,[]):
            with self.subTest(token=token),self.assertRaises(subject.BuildControlError):
                subject.build_input_digest({'target':'fem-gpu-dev','console_session_id':token})
    def test_managed_operation_keeps_console_ownership_for_build_phases(self):
        for phase in ('toolchain','image-dev','image-backend'):
            value=control();logger=Mock();logger.stdin.closed=True;logger.wait.return_value=0
            semantic={'source_inputs':[],'target':'fem-gpu-dev'}
            with patch.dict(os.environ,FULLMAG_CONSOLE_SESSION_ID=TOKEN,FULLMAG_CONSOLE_CANCEL_REQUESTED=''), \
                 patch.object(subject.subprocess,'Popen',return_value=logger),redirect_stdout(io.StringIO()):
                with value.operation(phase,semantic) as operation:
                    self.assertEqual(operation['receipt']['inputs']['console_session_id'],TOKEN)
                    self.assertEqual(subject.build_input_digest(operation['receipt']['inputs']),subject.build_input_digest(semantic))
                    operation['receipt']['state']='succeeded'
            self.assertNotIn('console_session_id',semantic)


if __name__ == '__main__':
    unittest.main()
