"""Hold native writer guards until the managed caller confirms copy terminal.

Run only as a scoped technical helper in the immutable stopped backend image.
This service does not copy data, start a solver, publish admission or unlock
anything on parent EOF. Unknown IPC outcomes retain the guards for recovery.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time


COMPONENTS = ('data_volume_copy_fence_service.py', 'data_volume_copy_fences.py',
              'data_volume_released_state.py', 'docker_volume_linux_supervision_stop.py')
MAX_LINE = 65536


def require(value, message):
    if not value:
        raise ValueError(message)


def _hex(value, length):
    return type(value) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}', value) is not None


def _decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate fence command key')
            result[key] = value
        return result
    def invalid(_value):
        raise ValueError('Nonfinite fence command')
    require(type(raw) is bytes and 0 < len(raw) <= MAX_LINE, 'Bounded fence command required')
    value = json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)
    require(type(value) is dict, 'Fence command must be an object')
    return value


def validate_request(value):
    require(type(value) is dict and set(value) == {
        'schema','token','volume_id','process_receipt_sha256','source_roots','components'},
        'Closed fence request required')
    require(value['schema'] == 'fullmag.data-copy-fence-request.v1', 'Fence request schema differs')
    for key in ('token','volume_id'):
        require(_hex(value[key],32) and value[key] != '0'*32, 'Nonzero fence identity required')
    require(_hex(value['process_receipt_sha256'],64), 'Exact terminal process SHA required')
    roots = value['source_roots']
    require(type(roots) is dict and set(roots) == {'state','user_data'}, 'Both source identities required')
    for pin in roots.values():
        require(type(pin) is dict and set(pin) == {'device','inode'} and
                all(type(n) is int and n > 0 for n in pin.values()), 'Exact source device/inode required')
    require(type(value['components']) is dict and set(value['components']) == set(COMPONENTS) and
            all(_hex(v,64) for v in value['components'].values()), 'Exact fence component SHAs required')
    return value


def _emit(output, value):
    try:
        output.write(json.dumps(value, sort_keys=True, allow_nan=False)+'\n')
        output.flush()
        return True
    except OSError:
        return False


def _retain(output, token, reason):
    _emit(output, {'schema':'fullmag.data-copy-fence-event.v1', 'token':token,
                   'state':'outcome-unknown-resources-retained', 'reason':reason})
    while True:
        time.sleep(1)


def wait_for_release(reader, output, token):
    """Only a scoped terminal-copy acknowledgement may end the held context."""
    try:
        raw = reader.readline(MAX_LINE+1)
    except OSError:
        return _retain(output, token, 'parent-channel-failed')
    if not raw:
        return _retain(output, token, 'parent-eof')
    try:
        value = _decode(raw)
        require(set(value) == {'schema','token','action','copy_result_sha256'} and
                value['schema'] == 'fullmag.data-copy-fence-command.v1' and
                value['token'] == token and value['action'] == 'release' and
                _hex(value['copy_result_sha256'],64), 'Invalid terminal-copy acknowledgement')
    except (ValueError, TypeError, RecursionError, UnicodeError):
        return _retain(output, token, 'invalid-parent-command')
    return value['copy_result_sha256']


def _verify_components(request):
    directory = Path(__file__).resolve().parent
    require(directory == Path('/opt/fullmag/source/scripts'), 'Exact readonly source mount required')
    for name in COMPONENTS:
        path = directory/name
        require(not path.is_symlink() and path.is_file() and path.stat().st_size <= 4*1024**2,
                'Fence component is not a bounded source file')
        require(hashlib.sha256(path.read_bytes()).hexdigest() == request['components'][name],
                'Fence component source changed: '+name)


def _serve_context(guards, request, reader, output):
    with guards as held:
        if not _emit(output, {'schema':'fullmag.data-copy-fence-event.v1','state':'held',
                              'token':request['token'],'volume_id':request['volume_id'],
                              'observation':held}):
            _retain(output, request['token'], 'ready-channel-failed')
        result_sha = wait_for_release(reader, output, request['token'])
    _emit(output, {'schema':'fullmag.data-copy-fence-event.v1','state':'released',
                   'token':request['token'],'copy_result_sha256':result_sha})


def serve(request, reader, output):
    request = validate_request(request)
    _verify_components(request)
    # Import native authentication from the immutable image before the selected
    # checkout's helper modules. The explicit check excludes a source lookalike.
    sys.path.insert(0, '/opt/fullmag')
    import runtime_service
    require(Path(runtime_service.__file__).resolve() == Path('/opt/fullmag/runtime_service.py'),
            'Native authentication must come from the backend image')
    # The already imported native module remains image-owned. Migration helpers
    # must use the verified checkout even if a later image bundles older copies.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from data_volume_copy_fences import hold_copy_fences
    from data_volume_released_state import collect_released_state
    from docker_volume_linux_supervision_stop import read
    paths = runtime_service.canonical_paths()
    previous = None

    def authenticate():
        nonlocal previous
        runtime_service._read_authenticated_terminal_drain(paths)
        process = read(runtime_service.process_receipt_path(paths))
        require(len(process) <= 8*1024**2 and
                hashlib.sha256(process).hexdigest() == request['process_receipt_sha256'],
                'Terminal process receipt changed')
        for role, root in [('state','/state'), ('user_data','/user-data')]:
            metadata = os.stat(root, follow_symlinks=False)
            require({'device':metadata.st_dev,'inode':metadata.st_ino} == request['source_roots'][role],
                    'Source mount identity differs: '+role)
        result = {'process_receipt_sha256':request['process_receipt_sha256'],
                  'released':collect_released_state('/state/runs/docker-all/session-store','/host-ledger/ledger')}
        if previous is not None:
            require(result == previous, 'Released/native state changed under the copy guards')
        previous = result
        return result

    _serve_context(hold_copy_fences('/state', '/opt/fullmag/runtime-control', '/host-ledger/ledger',
                                   authenticate=authenticate), request, reader, output)


def main():
    serve(_decode(sys.stdin.buffer.readline(MAX_LINE+1)), sys.stdin.buffer, sys.stdout)


if __name__ == '__main__':
    main()
