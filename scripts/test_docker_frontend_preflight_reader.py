"""A refused initial frontend preflight must preserve the live DEV authority."""
from copy import deepcopy
import hashlib
from pathlib import Path
import unittest
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_dev_browser_qa as qa


class FrontendPreflightReaderTests(unittest.TestCase):
    def fixture(self):
        source = Path('/source/task')
        parent, attempt = 'a' * 32, 'b' * 32
        document = {'name': 'group'}
        config = hashlib.sha256(qa.canonical(document)).hexdigest()
        image = 'sha256:' + 'c' * 64
        verified = {
            'attempt': parent, 'state': 'succeeded', 'phase': 'development',
            'compose_project': 'group', 'control_volume': 'volume',
            'inputs': {'source_root': str(source), 'image_id': image},
            'config_sha256': config, 'backend_volumes': {'control': 'volume'},
            'frontend_volume': 'volume', 'state_root': '/state/task',
            'backend_container': '1' * 64, 'frontend_container': '2' * 64,
        }
        failed = {
            'schema': 'fullmag.docker-build-operation.v1', 'attempt': attempt,
            'state': 'failed-confirmed', 'phase': 'development',
            'compose_project': 'group', 'control_volume': 'volume',
            'inputs': {**verified['inputs'], 'frontend_refresh_from_attempt': parent,
                       'frontend_refresh_from_config_sha256': config,
                       'native_build_requested': False},
            'backend_volumes': verified['backend_volumes'],
            'previous_frontend_volume': 'volume', 'state_root': '/state/task',
            'error': 'Traceback\nRuntimeError: Frontend refresh requires an empty healthy API',
        }
        records = {
            'development/verified.json': deepcopy(verified),
            'development/attempts/' + parent + '/terminal.json': deepcopy(verified),
            'development/attempts/' + parent + '/compose.json': document,
            'development/attempts/' + attempt + '/terminal.json': deepcopy(failed),
        }
        class Control:
            project, volume = 'group', 'volume'
            def read(self, path, *, optional=False):
                if optional:
                    return deepcopy(records.get(path))
                return deepcopy(records[path])
        return source, failed, verified, records, Control()

    def test_reads_verified_live_group_without_rewriting_failed_authority(self):
        source, failed, verified, records, control = self.fixture()
        before = deepcopy(records)
        with patch('docker_volume_activate._validate_running_group',
                   return_value=(verified['backend_container'], verified['frontend_container'])) as validate:
            result = qa._read_recovered_development(control, failed, source, {})
        self.assertEqual(result['attempt'], verified['attempt'])
        self.assertEqual(result['preflight_failure_attempt'], failed['attempt'])
        self.assertEqual(result['development_terminal_state'], 'failed-confirmed')
        self.assertEqual(records, before)
        validate.assert_called_once()

    def test_refuses_later_health_failures_and_drifted_receipts(self):
        for reason in ('rollback-compose.json', 'rollback-development-inputs.json', 'compose.json',
                       'terminal', 'verified-config', 'source', 'image', 'native-build', 'live-ids'):
            with self.subTest(reason=reason):
                source, failed, verified, records, control = self.fixture()
                root = 'development/attempts/' + failed['attempt'] + '/'
                if reason.endswith('.json'):
                    records[root + reason] = {'side_effect_boundary': 'crossed'}
                elif reason == 'terminal':
                    records[root + 'terminal.json']['error'] = 'different failure'
                elif reason == 'verified-config':
                    records['development/verified.json']['config_sha256'] = '0' * 64
                elif reason in ('source', 'image'):
                    key = 'source_root' if reason == 'source' else 'image_id'
                    failed['inputs'][key] = 'different'
                    records[root + 'terminal.json'] = deepcopy(failed)
                elif reason == 'native-build':
                    failed['inputs']['native_build_requested'] = True
                    records[root + 'terminal.json'] = deepcopy(failed)
                with patch('docker_volume_activate._validate_running_group',
                           return_value=('changed-backend', verified['frontend_container'])):
                    with self.assertRaises(qa.BuildControlError):
                        qa._read_recovered_development(control, failed, source, {})


if __name__ == '__main__':
    unittest.main()
