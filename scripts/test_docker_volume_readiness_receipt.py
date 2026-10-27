"""Exercise the guest receipt probe against the configured technical root."""
from pathlib import Path
import contextlib
import io
import json
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev

class ReadinessReceiptProbeTests(unittest.TestCase):
    def probe(self, raw=None):
        expected = Path('/technical-volume/runtime-service/process-tree.json')
        observed = []
        def read(path, label):
            observed.append(path)
            if raw is None:
                raise FileNotFoundError(path)
            return raw
        paths = object()
        runtime = SimpleNamespace(canonical_paths=lambda: paths,
            process_receipt_path=lambda value: expected if value is paths else None,
            _bounded_regular=read)
        output = io.StringIO()
        with patch.dict(sys.modules, runtime_service=runtime), contextlib.redirect_stdout(output), patch.object(sys, 'path', list(sys.path)):
            exec(docker_volume_dev._PROCESS_RECEIPT_PROBE, {})
        self.assertEqual(observed, [expected])
        return json.loads(output.getvalue())

    def test_failure_is_read_from_configured_root(self):
        receipt = {'schema': 'fullmag.docker-process-tree.v1',
                   'state': 'failed_outcome_retained', 'error': 'native startup failed'}
        self.assertEqual(self.probe(json.dumps(receipt).encode()), receipt)

    def test_missing_receipt_is_not_published(self):
        self.assertEqual(self.probe(), {'state': 'not-published'})


class EarlyStartupFailureTests(unittest.TestCase):
    def test_current_incarnation_fence_is_read_without_replacing_old_owner_receipt(self):
        path = '/opt/fullmag/runtime-control/runtime-service/api-failure-' + 'a' * 32 + '.json'
        logs = 'Runtime startup failed; starting diagnostic API only: timeout\n. Diagnostic: ' + path + '\n'
        fence = {'schema': 'fullmag.api-runtime-failure-fence.v1',
                 'stage': 'runtime_startup', 'reason': 'nvidia-smi timed out'}
        with patch.object(docker_volume_dev, 'docker_text', return_value=json.dumps(fence)) as read:
            observed = docker_volume_dev._early_startup_failure('exact-container', logs)
        self.assertEqual(observed, {'path': path, 'fence': fence})
        self.assertEqual(read.call_args.args[1], 'exact-container')
        self.assertEqual(read.call_args.args[-1], path)

    def test_no_fence_and_invalid_path_do_not_trigger_a_read(self):
        with patch.object(docker_volume_dev, 'docker_text') as read:
            self.assertIsNone(docker_volume_dev._early_startup_failure('id', 'normal build'))
            self.assertIsNone(docker_volume_dev._early_startup_failure('id',
                'Runtime startup failed; starting diagnostic API only: x. Diagnostic: /tmp/foreign.json'))
        read.assert_not_called()

    def test_malformed_fence_is_rejected(self):
        logs = ('Runtime startup failed; starting diagnostic API only: x. Diagnostic: '
                '/opt/fullmag/runtime-control/runtime-service/api-failure-' + 'b' * 32 + '.json')
        with patch.object(docker_volume_dev, 'docker_text', return_value='{}'):
            with self.assertRaises(docker_volume_dev.BuildControlError):
                docker_volume_dev._early_startup_failure('id', logs)

if __name__ == '__main__':
    unittest.main()
