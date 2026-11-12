"""Scoped copy guard in the stopped backend image; never copy or drain here."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from data_volume_copy_fence_service import COMPONENTS, validate_request
from docker_build_control import BuildControl, ControlOutcomeUnknown, canonical, docker_capture
from docker_linux_native_readmission import live_bind_path
from docker_volume_linux_supervision_stop import readonly_mount
from docker_volume_reconcile import fingerprint
from docker_volume_stop_unadmitted import _runtime_control_validation_helper
from fullmag_data_volume_guard import _parse_object


def require(value, message):
    if not value:
        raise ValueError(message)


def copy_fence_arguments(control, actual, source, request):
    """Construct an image-pinned technical helper using only readonly mounts."""
    validate_request(request)
    state = actual.get('State', {})
    labels = actual.get('Config', {}).get('Labels') or {}
    require(actual.get('Image') == control.image and labels.get('com.docker.compose.project') == control.project and
            labels.get('com.docker.compose.service') == 'backend', 'Exact backend image and group required')
    require(state.get('Status') == 'exited' and state.get('Running') is False and
            type(state.get('Pid')) is int and state['Pid'] == 0 and
            all(state.get(k) is False for k in ('Dead','Paused','Restarting','OOMKilled')),
            'Backend must have a confirmed stopped incarnation')
    rows = [m for m in actual.get('Mounts', []) if m.get('Destination') == '/opt/fullmag/source']
    require(len(rows) == 1 and rows[0].get('Type') == 'bind' and rows[0].get('RW') is False,
            'Exact readonly source bind required')
    source_alias = rows[0].get('Source')
    require(type(source_alias) is str and ',' not in source_alias and live_bind_path(source_alias) == Path(source),
            'Source bind does not identify the selected checkout')
    for name in COMPONENTS:
        path = Path(source)/'scripts'/name
        require(not path.is_symlink() and path.is_file() and
                hashlib.sha256(path.read_bytes()).hexdigest() == request['components'][name],
                'Pinned copy-fence component changed: '+name)
    args = _runtime_control_validation_helper(actual, control)
    source_mount = 'type=bind,src='+source_alias+',dst=/opt/fullmag/source,readonly'
    additions = ['--sig-proxy=false','--name','fullmag-data-copy-fence-'+request['token'], '--mount',source_mount]
    for target in ('/state','/user-data','/host-ledger'):
        additions += ['--mount',readonly_mount(actual,target)]
    position = args.index('--user'); args[position:position] = additions
    args[args.index('--memory')+1] = '256m'
    args = [v.replace('com.docker.compose.service=host-runtime-maintenance',
                      'com.docker.compose.service=data-volume-copy-fence') for v in args]
    # Authenticate source bytes before importing even the entrypoint module.
    bootstrap = ("import pathlib,hashlib,sys\nroot=pathlib.Path('/opt/fullmag/source/scripts')\n"
                 + 'pins='+repr(request['components'])+'\n'
                 + "for name,sha in pins.items():\n p=root/name\n"
                 + " if p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest()!=sha: raise RuntimeError('copy fence source changed')\n"
                 + "sys.path.insert(0,str(root))\nimport data_volume_copy_fence_service\ndata_volume_copy_fence_service.main()\n")
    args[-1] = bootstrap
    return args


class CopyFence:
    """Explicit terminal acknowledgement; a bare context exit retains guards.

    The caller holds storage.build_lock and BuildControl.operation, validates
    the terminal stop/source proofs, and awaits the root process's actual
    terminal receipt before finish(). Unknown outcomes never signal release.
    """

    def __init__(self, control, actual, source, request):
        self.control, self.request = control, validate_request(request)
        self.args = copy_fence_arguments(control, actual, source, request)
        self.operation = None; self.process = None; self.released = False

    def _event(self):
        raw = BuildControl._line(self.process, timeout=90)
        require(len(raw.encode()) <= 2*1024**2, 'Fence event exceeds the record budget')
        value = _parse_object(raw.encode(), 'copy-fence event')
        require(type(value) is dict and value.get('schema') == 'fullmag.data-copy-fence-event.v1' and
                value.get('token') == self.request['token'], 'Fence event identity differs')
        return value

    def __enter__(self):
        require(os.name == 'posix', 'Copy-fence lifecycle requires the Linux host adapter')
        operation = self.control._active_operation
        require(operation is not None and operation['receipt'].get('phase') == 'data-volume-migration' and
                operation['receipt'].get('attempt') == self.request['token'],
                'An exact managed migration operation is required')
        self.control._assert_live_operation_helper(operation)
        require(operation.get('daemon_pending') is False, 'Another daemon operation is pending')
        self.operation = operation
        operation['daemon_pending'] = True
        self.process = subprocess.Popen(self.args, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        start_new_session=True)
        # Keep the client reachable by the retained operation on every failure.
        operation['data_copy_fence_process'] = self.process
        self.process.stdin.write(canonical(self.request)+b'\n'); self.process.stdin.flush()
        ready = self._event()
        require(set(ready) == {'schema','state','token','volume_id','observation'} and
                ready.get('state') == 'held' and ready.get('volume_id') == self.request['volume_id'] and
                ready.get('observation',{}).get('authentication',{}).get('process_receipt_sha256') == self.request['process_receipt_sha256'] and
                ready.get('observation',{}).get('authentication',{}).get('released',{}).get('active_count') == 0,
                'Copy fence did not acknowledge held guards')
        actuals = json.loads(docker_capture('inspect','fullmag-data-copy-fence-'+self.request['token']).stdout)
        require(type(actuals) is list and len(actuals) == 1, 'Ambiguous copy-fence container')
        helper = actuals[0]
        require(re.fullmatch('[0-9a-f]{64}', helper.get('Id','')) and helper.get('Image') == self.control.image and
                helper.get('State',{}).get('Running') is True and
                type(helper.get('State',{}).get('Pid')) is int and helper['State']['Pid'] > 0 and
                type(helper.get('State',{}).get('StartedAt')) is str and helper['State']['StartedAt'] and
                helper.get('Config',{}).get('Labels',{}).get('com.docker.compose.project') == self.control.project and
                helper.get('Config',{}).get('Labels',{}).get('com.docker.compose.service') == 'data-volume-copy-fence' and
                helper.get('Config',{}).get('Cmd') == self.args[-3:] and
                helper.get('Config',{}).get('Entrypoint') == ['/usr/local/bin/python3'] and
                helper.get('Config',{}).get('User') == '65532:65532' and
                helper.get('HostConfig',{}).get('ReadonlyRootfs') is True and
                helper.get('HostConfig',{}).get('NetworkMode') == 'none' and
                {m.get('Destination') for m in helper.get('Mounts',[])} == {
                    '/state','/user-data','/host-ledger','/opt/fullmag/source','/opt/fullmag/runtime-control'} and
                all(m.get('RW') is False for m in helper.get('Mounts', [])),
                'Copy-fence incarnation differs')
        self.identifier = helper['Id']; self.helper_fingerprint = fingerprint(helper)
        self.helper_started_at = helper['State']['StartedAt']; self.helper_pid = helper['State']['Pid']
        self.ready = ready
        operation['receipt']['data_copy_fence'] = {'id':self.identifier,'fingerprint':self.helper_fingerprint,
            'ready_sha256':hashlib.sha256(canonical(ready)).hexdigest(),'state':'held',
            'started_at':self.helper_started_at,'pid':self.helper_pid}
        self.control.write(operation['root']+'/data-copy-fence.json',operation['receipt']['data_copy_fence'])
        return self

    def check(self):
        self.control._assert_live_operation_helper(self.operation)
        if self.process.poll() is not None:
            raise ControlOutcomeUnknown('Copy fence exited unexpectedly; retain all migration data')
        actuals = json.loads(docker_capture('inspect',self.identifier).stdout)
        if (len(actuals) != 1 or actuals[0].get('Id') != self.identifier or
                actuals[0].get('State',{}).get('Running') is not True or
                actuals[0].get('State',{}).get('StartedAt') != self.helper_started_at or
                actuals[0].get('State',{}).get('Pid') != self.helper_pid or
                fingerprint(actuals[0]) != self.helper_fingerprint):
            raise ControlOutcomeUnknown('Copy fence is no longer the pinned live incarnation')

    def finish(self, terminal_copy_receipt_sha256):
        require(not self.released and type(terminal_copy_receipt_sha256) is str and
                re.fullmatch('[0-9a-f]{64}',terminal_copy_receipt_sha256),
                'An exact confirmed terminal copy receipt SHA is required')
        self.check()
        command = {'schema':'fullmag.data-copy-fence-command.v1','token':self.request['token'],
                   'action':'release','copy_result_sha256':terminal_copy_receipt_sha256}
        self.process.stdin.write(canonical(command)+b'\n'); self.process.stdin.flush()
        event = self._event()
        require(event.get('state') == 'released' and event.get('copy_result_sha256') == terminal_copy_receipt_sha256,
                'Copy fence did not confirm the terminal acknowledgement')
        if self.process.wait(timeout=30) != 0:
            raise ControlOutcomeUnknown('Copy-fence client outcome is not successful')
        self.released = True
        self.operation['daemon_pending'] = False
        self.operation['receipt']['data_copy_fence'].update(state='released',
            terminal_copy_receipt_sha256=terminal_copy_receipt_sha256)

    def __exit__(self, error_type, error, traceback):
        if not self.released:
            # Never close/kill/restart the helper on an unconfirmed root copy.
            self.operation['daemon_pending'] = True
            if error is None:
                raise ControlOutcomeUnknown('Copy ended without a terminal acknowledgement; guards retained')
        return False
