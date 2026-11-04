"""Lifecycle of the one Docker DEV group owned by a foreground console."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_dev_host import docker_argv
from fullmag_console import CONSOLE_SESSION_ENV


# A build cancellation pins and freezes the exact startup supervisor before
# signalling it. Runtime processes make this path ineligible.
STOP_BUILD = r'''
import json, os, pathlib, signal, time
root = pathlib.Path('/proc')
startup = []
for entry in root.iterdir():
    if not entry.name.isdigit():
        continue
    try:
        arguments = (entry / 'cmdline').read_bytes().split(b'\0')
        executable = os.readlink(entry / 'exe')
        if executable.startswith('/opt/fullmag/package/') and '/bin/fullmag' in executable:
            print(json.dumps({'state': 'runtime'})); raise SystemExit(0)
        if len(arguments) >= 3 and arguments[1:3] == [b'/opt/fullmag/backend_dev.py', b'start']:
            startup.append(int(entry.name))
    except (FileNotFoundError, ProcessLookupError):
        continue
if len(startup) != 1:
    print(json.dumps({'state': 'unavailable'})); raise SystemExit(0)
pid = startup[0]
process = root / str(pid)
stat_before = (process / 'stat').read_text()
token = stat_before[stat_before.rfind(')')+2:].split()[19]
fd = os.pidfd_open(pid)
frozen = False
try:
    signal.pidfd_send_signal(fd, signal.SIGSTOP, None, 0)
    frozen = True
    deadline = time.monotonic() + 2
    while True:
        current = (process / 'stat').read_text()
        if current[current.rfind(')')+2:].split()[0] == 'T':
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('startup supervisor did not pause')
        time.sleep(.01)
    # Children may have appeared since the first scan. A paused Python
    # supervisor cannot exec or spawn the runtime after this second check.
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            executable = os.readlink(entry / 'exe')
        except (FileNotFoundError, ProcessLookupError):
            continue
        if executable.startswith('/opt/fullmag/package/') and '/bin/fullmag' in executable:
            print(json.dumps({'state': 'runtime'})); raise SystemExit(0)
    arguments = (process / 'cmdline').read_bytes().split(b'\0')
    if current[current.rfind(')')+2:].split()[19] != token or arguments[1:3] != [b'/opt/fullmag/backend_dev.py', b'start']:
        raise RuntimeError('startup identity changed before cancellation')
    signal.pidfd_send_signal(fd, signal.SIGTERM, None, 0)
    signal.pidfd_send_signal(fd, signal.SIGCONT, None, 0)
    frozen = False
    print(json.dumps({'state': 'signalled', 'pid': pid, 'start_token': token}))
finally:
    if frozen:
        signal.pidfd_send_signal(fd, signal.SIGCONT, None, 0)
    os.close(fd)
'''


class ConsoleRuntime:
    def __init__(self, args, request, source: Path, token: str):
        self.args = args
        self.request = request
        self.source = source
        self.token = token
        self.stopping = False
        self.child = None
        self.log_process = None
        self.log_container = None
        self.group = None
        self.run_result = None
        self.closed = False
        self.observing_run = False
        self.run_cancel_requested = False
        self.control = None
        self.identity = None

    @staticmethod
    def output(message):
        print(message, file=sys.stderr, flush=True)

    def _arguments(self):
        from docker_dev_defaults import resolve_defaults
        defaults = resolve_defaults(self.args.repo_root, source_root=self.source, port=self.args.port)
        return argparse.Namespace(repo_root=self.args.repo_root, source_root=self.source,
                                  port=defaults.port, port_explicit=self.args.port is not None,
                                  headless=self.request.mode == 'headless', gpu_access=self.args.gpu_access,
                                  script=None)

    def start(self):
        from docker_dev_up import _discover_group, _selected_context
        selected = self._arguments()
        previous = _discover_group(selected)
        if previous is not None and (previous.backend_running or previous.frontend_running):
            raise BuildControlError('The selected group is already running. Close its owning console before starting another one.')
        _, _, _, self.identity, self.control = _selected_context(selected)
        command = [sys.executable, '-B', str(Path(__file__).with_name('fullmag_console.py')),
                   '--repo-root', str(self.args.repo_root), '--mode-or-source', self.request.mode,
                   '--source-or-script', str(self.source), '--script', self.request.script,
                   '--port', str(selected.port), '--gpu-access', self.args.gpu_access, '--startup-worker']
        environment = {**os.environ, CONSOLE_SESSION_ENV: self.token}
        environment.pop('FULLMAG_CONSOLE_CANCEL_REQUESTED', None)
        options = {'start_new_session': True} if os.name == 'posix' else {
            'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP}
        self.output('Source ' + str(self.source) + ' | mode ' + self.request.mode)
        self.child = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL, **options)
        while self.child.poll() is None:
            self._follow_build_log()
            time.sleep(0.25)
        self._follow_build_log()
        if self.child.returncode != 0:
            raise BuildControlError('Managed startup failed (exit ' + str(self.child.returncode) + '). See the build/runtime log above.')
        self.group = _discover_group(selected)
        if self.group is None:
            raise BuildControlError('The started group is unavailable; its operation evidence was retained')
        owned = self._owned_services()
        if owned is None or owned['backend']['Id'] != self.group.backend_id:
            raise BuildControlError('The console cannot authenticate ownership of the started backend')
        if not selected.headless:
            self.output('UI http://localhost:' + str(self.group.port) + '/workspace')

    def _operation_candidates(self):
        from docker_control_namespace import _raw
        from docker_dev_up import _control_volume_exists
        if self.control is None or not _control_volume_exists(self.control):
            return []
        active_raw = _raw(self.control, 'active', optional=True)
        active = active_raw.decode().strip() if active_raw else None
        candidates = []
        for phase in ('development', 'resume', 'iteration'):
            if active and re.fullmatch(r'[0-9a-f]{32}', active):
                relative = phase + '/attempts/' + active + '/receipt.json'
                value = self.control.read(relative, optional=True)
                if value:
                    candidates.append((phase, active, value))
            value = self.control.read(phase + '/current.json', optional=True)
            if value:
                candidates.append((phase, value.get('attempt'), value))
        return candidates

    def _owned_services(self):
        from docker_compose_identity import validate_source_labels
        from docker_volume_dev import _validate_retained_service
        for phase, token, receipt in self._operation_candidates():
            inputs = receipt.get('inputs', {})
            if (inputs.get('console_session_id') != self.token
                    or inputs.get('source_root') != str(self.source)):
                continue
            backend_id, frontend_id = receipt.get('backend_container'), receipt.get('frontend_container')
            if not all(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value)
                       for value in (backend_id, frontend_id)):
                continue
            development = token if phase == 'development' else inputs.get('attempt')
            if not isinstance(development, str) or not re.fullmatch(r'[0-9a-f]{32}', development):
                continue
            document = self.control.read('development/attempts/' + development + '/compose.json')
            rows = json.loads(docker_capture('inspect', backend_id, frontend_id).stdout)
            by_id = {row['Id']: row for row in rows}
            if set(by_id) != {backend_id, frontend_id}:
                raise BuildControlError('Console service identities changed')
            services = {'backend': by_id[backend_id], 'frontend': by_id[frontend_id]}
            for name, actual in services.items():
                validate_source_labels(actual, self.identity)
                image = document['services'][name]['image']
                images = json.loads(docker_capture('image', 'inspect', image).stdout)
                if len(images) != 1 or images[0]['Id'] != image:
                    raise BuildControlError('Console service image identity is ambiguous')
                _validate_retained_service(document, actual, name, images[0]['Config'])
                pinned_start = receipt.get(name + '_started_at')
                if pinned_start is None or actual['State']['StartedAt'] != pinned_start:
                    raise BuildControlError('Console service incarnation changed')
            return {**services, 'receipt': receipt, 'document': document,
                    'attempt': development, 'config_sha256': hashlib.sha256(canonical(document)).hexdigest()}
        return None

    def _follow_build_log(self):
        if self.log_container is not None:
            return
        if self.identity is None:
            return
        try:
            # Receipt reads create short-lived control helpers in this group.
            # Before permanent services exist those helpers collide with the
            # startup worker's strict empty-group admission. Docker ps itself
            # creates no helper; wait for a running backend before reading any
            # receipt, then retain the existing console ownership checks.
            identifiers = docker_capture('ps', '--quiet', '--no-trunc',
                '--filter', 'label=com.docker.compose.project=' + self.identity['project_name'],
                '--filter', 'label=com.docker.compose.service=backend',
                '--filter', 'status=running').stdout.decode().splitlines()
            if len(identifiers) != 1 or not re.fullmatch(r'[0-9a-f]{64}', identifiers[0]):
                return
            owned = self._owned_services()
        except (BuildControlError, OSError, ValueError):
            return
        if owned is None or owned['backend']['Id'] != identifiers[0]:
            return
        backend = owned['backend']
        if not backend['State']['Running']:
            return
        if backend['Id'] == self.log_container:
            return
        self.close_observers()
        self.log_container = backend['Id']
        self.log_process = subprocess.Popen(docker_argv('logs', '--follow', '--since',
            backend['State']['StartedAt'], backend['Id']), stdin=subprocess.DEVNULL,
            start_new_session=os.name == 'posix')

    def request_interrupt(self):
        if not self.observing_run:
            return False
        if not self.run_cancel_requested:
            self.output('Stop requested. Waiting for the accepted-run identity before cancellation...')
        self.run_cancel_requested = True
        return True

    def run(self):
        from docker_dev_run_script import run_script
        self.observing_run = True
        try:
            self.run_result = run_script(self.args.repo_root, self.request.script,
                source_root=self.source, port=self.group.port, request_id='console-' + self.token,
                attempt=self.group.attempt, config_sha256=self.group.config_sha256,
                headless=self.request.mode == 'headless', output=self.output,
                cancel_requested=lambda: self.run_cancel_requested)
            return self.run_result
        finally:
            self.observing_run = False

    def begin_shutdown(self):
        if self.stopping:
            return
        self.stopping = True
        self.output('Closing this console session...')

    def shutdown(self, result=None):
        if self.closed:
            return
        self.begin_shutdown()
        if result and result.get('state') == 'unknown':
            raise BuildControlError('Run cancellation is unconfirmed; services and recovery evidence were retained')
        from docker_dev_up import _discover_group
        from docker_volume_dev import stop_idle
        current = _discover_group(self._arguments())
        if (current is None or self.group is None or current.backend_id != self.group.backend_id
                or current.frontend_id != self.group.frontend_id
                or current.backend['State']['StartedAt'] != self.group.backend['State']['StartedAt']):
            raise BuildControlError('The group changed during the console session; shutdown was withheld')
        if result and result.get('session_id') and result.get('run_id'):
            from docker_dev_run_script import _probe_with_retry
            observed = _probe_with_retry(current.backend_id, 'run', **{
                key: result[key] for key in ('api_instance_id', 'session_id', 'run_id',
                                            'session_epoch', 'request_scope_epoch') if result.get(key) is not None})
            if observed.get('run_status') not in {'completed', 'failed', 'cancelled'}:
                raise BuildControlError('The owned run is not terminal; shutdown was withheld')
        stop_idle(argparse.Namespace(repo_root=self.args.repo_root, source_root=self.source,
            attempt=current.attempt, config_sha256=current.config_sha256, port=current.port,
            headless=self.request.mode == 'headless', allow_prepared_session=True))
        self.closed = True
        self.output('Backend and frontend stopped. Results and Docker volumes retained.')

    def cancel_start(self):
        self.begin_shutdown()
        if self.child is None:
            return
        if self.child.poll() is None:
            if os.name == 'posix':
                self.child.send_signal(signal.SIGINT)
            else:
                self.child.send_signal(signal.CTRL_BREAK_EVENT)
        build_signalled = False
        message_shown = False
        while self.child.poll() is None:
            try:
                self._follow_build_log()
                owned = self._owned_services()
            except (BuildControlError, OSError, ValueError, subprocess.SubprocessError) as error:
                if not message_shown:
                    self.output('Waiting for authenticated startup observation: ' + str(error))
                    message_shown = True
                time.sleep(0.5)
                continue
            if owned is not None and owned['backend']['State']['Running'] and not build_signalled:
                intent = {'schema': 'fullmag.console-start-stop.v1', 'console_session_id': self.token,
                          'backend_container_id': owned['backend']['Id'],
                          'backend_started_at': owned['backend']['State']['StartedAt'],
                          'development_attempt': owned['attempt'], 'config_sha256': owned['config_sha256']}
                try:
                    self.control.write('console/attempts/' + self.token + '/startup-stop-intent.json', intent)
                except (BuildControlError, OSError, ValueError, subprocess.SubprocessError) as error:
                    if not message_shown:
                        self.output('Build stop withheld until its intent is durable: ' + str(error))
                        message_shown = True
                    time.sleep(0.5)
                    continue
                # The daemon may execute the signal even if its response is
                # lost. Never repeat an unobserved cancellation command.
                build_signalled = True
                try:
                    probe = docker_capture('exec', owned['backend']['Id'], '/usr/local/bin/python3',
                                           '-I', '-B', '-c', STOP_BUILD, allow_failure=True, timeout=20)
                    if not probe.returncode:
                        proof = json.loads(probe.stdout)
                        self.control.write('console/attempts/' + self.token + '/startup-stop-proof.json', proof)
                        if proof.get('state') == 'unavailable':
                            build_signalled = False  # No matching process was signalled.
                except (BuildControlError, OSError, ValueError, subprocess.SubprocessError) as error:
                    self.output('Build-stop response unavailable; waiting without another signal: ' + str(error))
            if not message_shown:
                self.output('Stop requested. Waiting for the managed startup operation to close safely...')
                message_shown = True
            time.sleep(0.5)
        # A cold helper or transient inspect failure must not abandon the
        # detached startup worker. It has exited before this bounded recheck.
        for observation in range(5):
            try:
                owned = self._owned_services()
                break
            except (BuildControlError, OSError, ValueError, subprocess.SubprocessError):
                if observation == 4:
                    raise
                time.sleep(0.5)
        if owned is None:
            from docker_dev_up import _discover_group
            current = _discover_group(self._arguments())
            if current is not None and (current.backend_running or current.frontend_running):
                raise BuildControlError('Startup services remain live without authenticated console ownership; recovery required')
            self.closed = True
            return
        if owned['backend']['State']['Running']:
            from docker_dev_up import _discover_group
            self.group = _discover_group(self._arguments())
            self.shutdown()
            return
        self._stop_remaining_frontend(owned)
        self.closed = True

    def _stop_remaining_frontend(self, owned):
        from docker_volume_reconcile import fingerprint
        with self.control.operation('console-shutdown', {
                'console_session_id': self.token, 'source_root': str(self.source),
                'backend_container_id': owned['backend']['Id'],
                'frontend_container_id': owned['frontend']['Id']}) as operation:
            current = self._owned_services()
            if (current is None or current['backend']['State']['Running']
                    or current['backend']['State'].get('Pid') != 0):
                raise BuildControlError('Console backend stop is unconfirmed')
            frontend = current['frontend']
            expected = (frontend['Id'], frontend['State']['StartedAt'], fingerprint(frontend))
            operation['daemon_pending'] = True
            if frontend['State']['Running']:
                docker_capture('stop', '--signal', 'SIGTERM', '--time', '-1', frontend['Id'], timeout=90)
            after = json.loads(docker_capture('inspect', frontend['Id']).stdout)[0]
            if ((after['Id'], after['State']['StartedAt'], fingerprint(after)) != expected
                    or after['State']['Running'] or after['State']['Pid'] != 0):
                raise BuildControlError('Console frontend stop is unconfirmed')
            operation['daemon_pending'] = False
            operation['receipt'].update(state='succeeded', retained_results=True, retained_volumes=True)

    def close_observers(self):
        if self.log_process is not None:
            if self.log_process.poll() is None:
                self.log_process.terminate()
            try:
                self.log_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.log_process.kill()
                self.log_process.wait(timeout=5)
            self.log_process = None
