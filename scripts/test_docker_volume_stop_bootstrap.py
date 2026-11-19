"""Direct development failures retain their real producer evidence."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_volume_stop_bootstrap as stop
from docker_build_control import BuildControlError


class DirectFailureTests(unittest.TestCase):
    def setUp(self):
        self.control = SimpleNamespace(project='project', volume='volume', namespace='')
        self.process = {'error': stop.TARGET_BUILD_ERROR_PREFIX + ' build\n' + stop.TARGET_BUILD_ERROR_SUFFIX}
        self.process_raw = json.dumps(self.process).encode()
        self.previous = {
            'schema': 'fullmag.docker-build-operation.v1', 'phase': 'development',
            'state': 'failed-confirmed', 'attempt': 'a'*32,
            'compose_project': 'project', 'control_volume': 'volume',
            'config_sha256': 'c'*64, 'backend_container': 'b'*64,
            'frontend_container': 'f'*64, 'backend_started_at': 'started',
            'inputs': {'source_root': '/source', 'image_id': 'sha256:'+'1'*64},
            'worker_cgroup': {'schema': 'fullmag.worker-cgroup-ready.v1',
                             'state': 'ready', 'compose_project': 'project',
                             'container_id': 'b'*64, 'image_id': 'sha256:'+'1'*64},
        }
        self.args = SimpleNamespace(attempt='a'*32, config_sha256='c'*64,
            resume_attempt=None, development_terminal_sha256=None,
            process_receipt_sha256=stop._sha256(self.process_raw), stop_frontend=False)

    def validate(self, change=None, *, sidecar=None, readiness_change=None):
        previous = copy.deepcopy(self.previous)
        previous['error'] = 'Runtime admission failed; services retained: '+self.process['error'][:4096]
        if change:
            previous.update(change)
        raw = json.dumps(previous).encode()
        self.args.development_terminal_sha256 = stop._sha256(raw)
        readiness = {'error': previous['error'], 'backend_container_id': 'b'*64,
                     'backend_started_at': 'started'}
        readiness.update(readiness_change or {})
        def read(control, relative, **kwargs):
            if relative.endswith('/process-failure.json'):
                return self.process_raw if sidecar is None else sidecar
            if relative.endswith('/readiness-failure.json'):
                return json.dumps(readiness).encode()
            raise AssertionError(relative)
        with patch.object(stop, '_read_raw', side_effect=read):
            return stop._validate_development_failure(self.args, self.control, Path('/source'),
                previous, previous['inputs'], raw, self.process_raw)

    def test_actual_admission_envelope_accepts_real_sidecars(self):
        result = self.validate()
        self.assertEqual(result['backend_container'], 'b'*64)
        self.assertEqual(result['phase'], 'development')
        self.assertEqual(result['process_sha256'], stop._sha256(self.process_raw))

    def test_truncated_message_uses_full_process_for_failure_identity(self):
        self.process['error'] = stop.TARGET_BUILD_ERROR_PREFIX+'x'*5000+'\n'+stop.TARGET_BUILD_ERROR_SUFFIX
        self.process_raw = json.dumps(self.process).encode()
        self.args.process_receipt_sha256 = stop._sha256(self.process_raw)
        self.validate()

    def test_load_pins_preserves_resume_receipt_fields_and_direct_origin(self):
        compose = {'name':'project'}
        raw_compose = json.dumps(compose).encode()
        self.args.config_sha256 = stop._sha256(stop.canonical(compose))
        self.args.port = 3345
        self.previous['config_sha256'] = self.args.config_sha256
        self.previous['error'] = 'Runtime admission failed; services retained: '+self.process['error']
        terminal_raw = json.dumps(self.previous).encode()
        self.args.development_terminal_sha256 = stop._sha256(terminal_raw)
        origin = self.validate()
        readiness = json.dumps({'error':self.previous['error'],
            'backend_container_id':'b'*64, 'backend_started_at':'started'}).encode()
        for kind in ('development', 'resume'):
            with self.subTest(kind=kind):
                self.args.resume_attempt = 'd'*32 if kind=='resume' else None
                self.args.development_terminal_sha256 = None if kind=='resume' else stop._sha256(terminal_raw)
                self.args.process_receipt_sha256 = None if kind=='resume' else stop._sha256(self.process_raw)
                def read(control, relative, **kwargs):
                    if relative.endswith('/compose.json'): return raw_compose
                    if relative.endswith('/terminal.json'): return terminal_raw
                    if relative.endswith('/readiness-failure.json'): return readiness
                    return self.process_raw
                with patch.object(stop, '_read_raw', side_effect=read), \
                     patch.object(stop, '_validate_resume', return_value={**origin,'phase':'resume','attempt':'d'*32}), \
                     patch('docker_volume_stop_diagnostic._port_matches'), \
                     patch('docker_volume_dev._operator_probe_record_from_retained'):
                    pins = stop._load_pins(self.args, self.control, Path('/source'))
                self.assertEqual(pins['failure_process_raw'], self.process_raw)
                fields = stop._origin_fields(pins)
                if kind=='resume':
                    self.assertEqual(fields['resume_attempt'], 'd'*32)
                    self.assertNotIn('failure_origin', fields)
                else:
                    self.assertEqual(fields['failure_origin']['phase'], 'development')
                    self.assertFalse(any('resume' in key for key in fields))

    def test_wrong_terminal_and_producer_pins_are_rejected(self):
        for change in ({'state':'succeeded'}, {'phase':'resume'}, {'attempt':'d'*32},
                       {'compose_project':'foreign'}, {'control_volume':'foreign'},
                       {'backend_container':'d'*64}, {'config_sha256':'d'*64},
                       {'worker_cgroup':{}}, {'inputs':{'source_root':'/foreign'}},
                       {'control_namespace':'foreign'}, {'error':'unrelated'}):
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                self.validate(change)
        with self.assertRaises(BuildControlError):
            self.validate(sidecar=b'{}')
        for change in ({'backend_started_at':'changed'}, {'backend_container_id':'d'*64},
                       {'error':'other'}):
            with self.subTest(readiness=change), self.assertRaises(BuildControlError):
                self.validate(readiness_change=change)
        self.args.process_receipt_sha256 = '0'*64
        with self.assertRaises(BuildControlError): self.validate()

    def test_origin_arguments_are_exclusive_and_frontend_stop_is_direct_only(self):
        self.args.development_terminal_sha256='c'*64
        self.assertEqual(stop._validate_failure_origin(self.args), 'development')
        self.args.resume_attempt='d'*32
        with self.assertRaises(BuildControlError): stop._validate_failure_origin(self.args)

        self.args.development_terminal_sha256=None
        self.args.process_receipt_sha256=None
        self.assertEqual(stop._validate_failure_origin(self.args), 'resume')
        self.args.stop_frontend=True
        with self.assertRaises(BuildControlError): stop._validate_failure_origin(self.args)
        self.args.resume_attempt=None
        with self.assertRaises(BuildControlError): stop._validate_failure_origin(self.args)

    def test_frontend_stop_rejects_changed_incarnation_before_signal(self):
        frontend = {'Id':'f'*64, 'Image':'sha256:'+'1'*64,
                    'State':{'StartedAt':'started', 'Running':True, 'Status':'running'}}
        stopped = copy.deepcopy(frontend)
        stopped['State'].update(Running=False, Status='exited')
        pins = {'compose':{}, 'image_id':frontend['Image']}
        ids = {'backend':'b'*64, 'frontend':'f'*64}
        for rows, accepted in (([frontend, stopped], True),
                ([{**frontend, 'State':{'StartedAt':'other','Running':True}}], False),
                ([frontend, frontend], False)):
            with self.subTest(accepted=accepted), \
                 patch.object(stop, '_assert_group_consumers', return_value='helper'), \
                 patch.object(stop, 'docker_capture', side_effect=[SimpleNamespace(stdout=json.dumps([r])) for r in rows]), \
                 patch.object(stop, 'compose_capture') as signal:
                if accepted:
                    stop._stop_pinned_frontend(self.control, {}, pins, ids,
                                               {'frontend':frontend}, 'helper')
                    self.assertEqual(signal.call_count, 1)
                else:
                    with self.assertRaises(BuildControlError):
                        stop._stop_pinned_frontend(self.control, {}, pins, ids,
                                                   {'frontend':frontend}, 'helper')
                    if len(rows)==1: signal.assert_not_called()


if __name__ == '__main__':
    unittest.main()
