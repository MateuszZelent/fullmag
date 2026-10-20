"""A retained activation fence must preserve its cause without retrying POST."""
import subprocess
import unittest
from unittest.mock import patch

import docker_volume_activate as activate
from docker_build_control import ControlOutcomeUnknown


class ActivationDiagnosticTests(unittest.TestCase):
    def call(self):
        return activate._run_fixed_activation(
            'backend-id', script_path='/opt/fullmag/source/example.py',
            provenance_path='/opt/fullmag/control/authorization.json',
            provenance_sha256='a' * 64, helper_sha256='b' * 64,
            activation_timeout_seconds=30,
            activation_receipt_path='/opt/fullmag/control/activation.json',
            activation_receipt_key='c' * 64,
        )

    def test_fatal_wrapper_error_after_marker_retains_bounded_original_cause(self):
        outputs = [subprocess.CompletedProcess([], 1, b'', b'x' * 5000 + b'original failure'),
                   subprocess.CompletedProcess([], 0, b'', b'')]
        with patch.object(activate, 'docker_capture', side_effect=outputs) as capture:
            with self.assertRaises(ControlOutcomeUnknown) as caught:
                self.call()
        self.assertIn('original failure', str(caught.exception))
        self.assertLess(len(str(caught.exception)), 4300)
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(capture.call_args_list[1].args, ('exec', 'backend-id', 'test', '-f', '/opt/fullmag/control/activation.json'))

    def test_transport_unknown_preserves_api_diagnostic_without_second_exec(self):
        output = subprocess.CompletedProcess([], 75,
            b'{"state":"unknown","error":"HTTP 503: temporary writer contention"}\n', b'')
        with patch.object(activate, 'docker_capture', return_value=output) as capture:
            with self.assertRaisesRegex(ControlOutcomeUnknown, 'HTTP 503: temporary writer contention'):
                self.call()
        capture.assert_called_once()


if __name__ == '__main__':
    unittest.main()
