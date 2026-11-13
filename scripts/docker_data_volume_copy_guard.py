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


_COPY_FENCE_SOURCE_ROOT = '/opt/fullmag/source/scripts'


def _copy_fence_bootstrap(component_pins):
    pins_json = json.dumps(component_pins, sort_keys=True, separators=(',', ':'))
    root_path_literal = repr(_COPY_FENCE_SOURCE_ROOT)
    pins_literal = repr(pins_json)
    return r'''import hashlib, importlib.abc, importlib.util, json, os, stat, sys
root_path = ''' + root_path_literal + r'''
pins = json.loads(''' + pins_literal + r''')
expected_names = {
    'data_volume_copy_fence_service.py', 'data_volume_copy_fences.py',
    'data_volume_released_state.py', 'docker_volume_linux_supervision_stop.py',
}

def need(value, message):
    if not value:
        raise SystemExit(message)

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK

def open_directory(path):
    need(type(path) is str and path.startswith('/') and not path.startswith('//') and
         os.path.normpath(path) == path, 'noncanonical copy-fence source root')
    descriptor = os.open('/', directory_flags)
    try:
        for component in path.split('/')[1:]:
            need(component not in ('', '.', '..'), 'unsafe copy-fence root component')
            child = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

def read_regular(descriptor):
    before = os.fstat(descriptor)
    need(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= 4 * 1024 * 1024,
         'unsafe copy-fence component')
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, min(1024 * 1024, 4 * 1024 * 1024 + 1 - total))
        if not chunk:
            break
        total += len(chunk)
        need(total <= 4 * 1024 * 1024, 'oversized copy-fence component')
        chunks.append(chunk)
    after = os.fstat(descriptor)
    need((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
         (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
         'copy-fence component changed while reading')
    return b''.join(chunks)

need(type(pins) is dict and set(pins) == expected_names,
     'closed copy-fence component pins required')
need(all(type(value) is str and len(value) == 64 and
         all(character in '0123456789abcdef' for character in value) for value in pins.values()),
     'invalid copy-fence component pin')
root_fd = open_directory(root_path)
verified_sources = {}
try:
    for name in sorted(expected_names):
        descriptor = os.open(name, file_flags, dir_fd=root_fd)
        try:
            raw = read_regular(descriptor)
        finally:
            os.close(descriptor)
        need(hashlib.sha256(raw).hexdigest() == pins[name], 'copy-fence source changed: ' + name)
        verified_sources[name[:-3]] = (root_path + '/' + name, raw)
finally:
    os.close(root_fd)

need(not (set(verified_sources) & set(sys.modules)), 'pinned copy-fence module was already imported')

class VerifiedLoader(importlib.abc.Loader):
    def __init__(self, fullname, path, raw):
        self.fullname = fullname
        self.path = path
        self.raw = raw
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        module.__file__ = self.path
        module.__cached__ = None
        code = compile(self.raw, self.path, 'exec', dont_inherit=True)
        exec(code, module.__dict__)

class VerifiedFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        pinned = verified_sources.get(fullname)
        if pinned is None:
            return None
        if fullname in sys.modules:
            raise ImportError('pinned copy-fence module was already imported: ' + fullname)
        module_path, raw = pinned
        loader = VerifiedLoader(fullname, module_path, raw)
        return importlib.util.spec_from_loader(fullname, loader, origin=module_path)

sys.meta_path.insert(0, VerifiedFinder())
import importlib
service = importlib.import_module('data_volume_copy_fence_service')
service.main()
'''


def _relocated_fence_mounts(relocated, source, request, actual):
    if relocated is None:
        return None
    import docker_data_volume_relocated as relocated_view
    mounts = relocated_view.fence_mounts(relocated, source, request, actual)
    targets = {'/state', '/user-data'}
    require(type(mounts) is dict and set(mounts) == targets,
            'Exact authenticated relocated dataset mounts required')
    result = {}
    for target, path in mounts.items():
        require(isinstance(path, Path) and path.is_absolute() and str(path) == os.path.normpath(str(path)),
                'Canonical relocated dataset path required')
        source_path = str(path)
        require(',' not in source_path and '\0' not in source_path,
                'Relocated bind source cannot contain mount separators')
        result[target] = path
    return result


def _relocated_mount_pin(mounts):
    return None if mounts is None else tuple(sorted((target,str(path)) for target,path in mounts.items()))


def _copy_fence_arguments(control, actual, source, request, relocated_mounts):
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
        if relocated_mounts is not None and target in relocated_mounts:
            source_path = str(relocated_mounts[target])
            mount = 'type=bind,src='+source_path+',dst='+target+',readonly'
        else:
            mount = readonly_mount(actual,target)
        additions += ['--mount',mount]
    position = args.index('--user'); args[position:position] = additions
    args[args.index('--memory')+1] = '256m'
    args = [v.replace('com.docker.compose.service=host-runtime-maintenance',
                      'com.docker.compose.service=data-volume-copy-fence') for v in args]
    # Pin all checkout helpers before import; runtime_service stays image-owned.
    bootstrap = _copy_fence_bootstrap(request['components'])
    args[-1] = bootstrap
    return args


def copy_fence_arguments(control, actual, source, request, *, relocated=None):
    """Construct an image-pinned technical helper using only readonly mounts."""
    validate_request(request)
    mounts = _relocated_fence_mounts(relocated,source,request,actual)
    return _copy_fence_arguments(control,actual,source,request,mounts)


class CopyFence:
    """Explicit terminal acknowledgement; a bare context exit retains guards.

    The caller holds storage.build_lock and BuildControl.operation, validates
    the terminal stop/source proofs, and awaits the root process's actual
    terminal receipt before finish(). Unknown outcomes never signal release.
    """

    def __init__(self, control, actual, source, request, *, relocated=None):
        self.control, self.request = control, validate_request(request)
        self.actual = actual
        self.source = source
        self.relocated = relocated
        relocated_mounts = _relocated_fence_mounts(relocated,source,self.request,actual)
        self._relocated_mount_pins = _relocated_mount_pin(relocated_mounts)
        self.args = _copy_fence_arguments(control,actual,source,self.request,relocated_mounts)
        self.operation = None; self.process = None; self.released = False

    def _check_relocated(self):
        current = _relocated_fence_mounts(self.relocated, self.source, self.request, self.actual)
        require(_relocated_mount_pin(current) == self._relocated_mount_pins,
                'Relocated dataset mount scope changed after helper preparation')

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
        self._check_relocated()
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
        self._check_relocated()
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
