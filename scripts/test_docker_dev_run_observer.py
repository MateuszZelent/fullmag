"""Exercise the image-side observer against a local HTTP API, without Docker."""
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest

import docker_dev_run_script as runner

API = '12345678-1234-1234-1234-123456789abc'
SCOPE = API + ':1'


class ObserverTests(unittest.TestCase):
    def observe(self, mode, *, changed=False, stop_status=200, logs_status=200, log_count=1, log_offset=0, stop_accepted=True):
        requests = []
        stopped = threading.Event()
        status = {'session': {'session_id': 'own-session', 'session_epoch': 'epoch',
                              'request_scope_epoch': SCOPE},
                  'run': {'run_id': 'own-run', 'solver_steps': 12, 'solver_time': 0.5,
                          'stage_label': 'relax'}}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                requests.append(('GET', self.path, dict(self.headers), None))
                if self.path.endswith('/status'):
                    value = status
                    if changed:
                        value = {**status, 'run': {'run_id': 'another-run'}}
                elif '/simulation/runs/' in self.path:
                    value = {'session_id': 'own-session', 'run_id': 'own-run',
                             'status': 'cancelled' if stopped.is_set() else 'running', 'status_reason': None}
                elif self.path.endswith('/engine-log'):
                    if logs_status != 200:
                        self.send_response(logs_status)
                        self.end_headers()
                        return
                    value = {'entries': [{'timestamp_unix_ms': 1, 'level': 'info',
                                           'message': 'solver running' if i == 0 else f'entry {i}',
                                           'source': 'solver', 'phase_id': 'relax', 'command_id': 'solve-1'} for i in range(log_count)]}
                else:
                    value = {'status': 'ok'}
                self.send_response(200)
                self.send_header('x-fullmag-api-instance', API)
                self.end_headers()
                self.wfile.write(json.dumps(value).encode())
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(('POST', self.path, dict(self.headers), body))
                if stop_status == 200:
                    stopped.set()
                self.send_response(stop_status)
                self.send_header('x-fullmag-api-instance', API)
                self.end_headers()
                self.wfile.write(json.dumps({'command_id': 'stop-1', 'accepted': stop_accepted}).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            script = runner.API_OBSERVER_SCRIPT.replace('http://127.0.0.1:8081',
                                                        f'http://127.0.0.1:{server.server_port}')
            env = {**os.environ, 'FULLMAG_RUN_OBSERVER_MODE': mode,
                   'FULLMAG_RUN_OBSERVER_LOG_OFFSET': str(log_offset),
                   'FULLMAG_RUN_OBSERVER_API_INSTANCE_ID': API,
                   'FULLMAG_RUN_OBSERVER_SESSION_ID': 'own-session',
                   'FULLMAG_RUN_OBSERVER_RUN_ID': 'own-run',
                   'FULLMAG_RUN_OBSERVER_SESSION_EPOCH': 'epoch',
                   'FULLMAG_RUN_OBSERVER_REQUEST_SCOPE_EPOCH': SCOPE}
            if mode == 'foreground':
                driver = r'''
import json, os, subprocess, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import docker_dev_defaults as d
import docker_dev_run_script as r
import docker_volume_activate as a
api = "12345678-1234-1234-1234-123456789abc"
d.resolve_defaults = lambda *args, **kw: d.ScriptDefaults(Path.cwd(), 3197)
d._discover_pins = lambda *args, **kw: d.ScriptPins("a"*32, "b"*64, Path.cwd(), 3197, "c"*64, "d"*64)
a.activate = lambda args: {"state":"activated", "request_id":"sigint-test", "source_sha256":"e"*64,
    "response":{"request_id":"sigint-test", "source_sha256":"e"*64, "session_id":"own-session", "run_id":"own-run",
                "runtime_metadata":{"interactive":True, "wait_for_solve":False}}}
program = r.API_OBSERVER_SCRIPT.replace("http://127.0.0.1:8081", sys.argv[2])
def probe(container, mode, **identity):
    env = {**os.environ, "FULLMAG_RUN_OBSERVER_MODE":mode}
    for key, value in identity.items():
        if value is not None:
            env["FULLMAG_RUN_OBSERVER_" + key.upper()] = str(value)
    result = subprocess.run([sys.executable, "-I", "-B", "-c", program], env=env,
                            capture_output=True, text=True, check=True, timeout=5)
    return json.loads(result.stdout)
r._container_probe = probe
result = r.run_script(Path.cwd(), "demo.py")
print(json.dumps(result), flush=True)
sys.exit(result["exit_code"])
'''
                process = subprocess.Popen([sys.executable, '-B', '-c', driver,
                                            str(Path(runner.__file__).parent),
                                            f'http://127.0.0.1:{server.server_port}'],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                timer = threading.Timer(10, process.kill)
                timer.start()
                try:
                    lines = []
                    for line in process.stderr:
                        lines.append(line)
                        if ': running' in line:
                            process.send_signal(signal.SIGINT)
                            break
                    stdout, stderr = process.communicate(timeout=10)
                    self.assertEqual(process.returncode, 130, ''.join(lines) + stderr)
                    return json.loads(stdout), requests
                finally:
                    timer.cancel()
                    if process.poll() is None:
                        process.kill()
                        process.communicate()
            result = subprocess.run([sys.executable, '-I', '-B', '-c', script], env=env,
                                    capture_output=True, text=True, timeout=10, check=True)
            return json.loads(result.stdout), requests
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    @unittest.skipUnless(os.name == 'posix', 'POSIX SIGINT delivery')
    def test_os_sigint_stops_exact_run_and_waits_for_http_acknowledgement(self):
        value, requests = self.observe('foreground')
        self.assertEqual(value['state'], 'terminal')
        self.assertEqual(value['status'], 'cancelled')
        self.assertEqual(value['exit_code'], 130)
        posts = [item for item in requests if item[0] == 'POST']
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][3]['target']['run_id'], 'own-run')

    def test_run_returns_logs_and_progress_from_fenced_session(self):
        value, requests = self.observe('run')
        self.assertEqual(value['state'], 'observed')
        self.assertEqual(value['progress']['solver_steps'], 12)
        self.assertEqual(value['logs'][0]['message'], 'solver running')
        self.assertEqual(value['logs'][0].get('source'), 'solver')
        self.assertTrue(all(method == 'GET' for method, *_ in requests))

    def test_log_backlog_is_paged_without_dropping_entries(self):
        first, _ = self.observe('run', log_count=70)
        self.assertEqual(first['logs'][0]['message'], 'solver running')
        self.assertEqual(first['logs_next_offset'], 50)
        second, _ = self.observe('run', log_count=70, log_offset=50)
        self.assertEqual(second['logs'][0]['message'], 'entry 50')
        self.assertEqual(second['logs_next_offset'], 70)

    def test_cancel_posts_once_with_exact_run_and_scope(self):
        value, requests = self.observe('cancel')
        self.assertEqual(value['state'], 'observed')
        posts = [item for item in requests if item[0] == 'POST']
        self.assertEqual(len(posts), 1)
        _, path, headers, body = posts[0]
        self.assertEqual(path, '/v2/sessions/current/simulation/commands')
        self.assertEqual(body['kind'], 'stop')
        self.assertEqual(body['target'], {'kind': 'run', 'run_id': 'own-run'})
        self.assertEqual({key.lower(): value for key, value in headers.items()}['x-fullmag-api-instance'], API)
        self.assertIn('own-session', {key.lower(): value for key, value in headers.items()}['x-fullmag-session-scope'])
        self.assertTrue(value['cancellation_submitted'])

    def test_cancel_refuses_changed_run_without_post(self):
        value, requests = self.observe('cancel', changed=True)
        self.assertEqual(value['state'], 'unknown')
        self.assertEqual(value['reason'], 'request_scope_changed')
        self.assertFalse(any(item[0] == 'POST' for item in requests))

    def test_cancel_rejected_with_http_200_is_reported_unknown(self):
        value, requests = self.observe('cancel', stop_accepted=False)
        self.assertEqual(value['state'], 'unknown')
        self.assertEqual(value['reason'], 'stop_rejected')
        self.assertEqual(sum(item[0] == 'POST' for item in requests), 1)

    def test_cancel_http_failure_is_unknown_and_never_retried(self):
        value, requests = self.observe('cancel', stop_status=409)
        self.assertEqual(value['state'], 'unknown')
        self.assertEqual(sum(item[0] == 'POST' for item in requests), 1)

    def test_log_failure_does_not_hide_run_status(self):
        value, _ = self.observe('run', logs_status=500)
        self.assertEqual(value['state'], 'observed')
        self.assertEqual(value['run_status'], 'running')
        self.assertEqual(value['logs'], [])
        self.assertTrue(value['logs_unavailable'])


if __name__ == '__main__':
    unittest.main()
