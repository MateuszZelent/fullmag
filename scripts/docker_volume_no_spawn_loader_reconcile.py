"""Finalize only the historical pre-main libcuda loader refusal.

The original request and unknown receipt remain unchanged. Only a technical
terminal is published by exec in the authenticated original control helper;
that helper alone drops its active marker and operation lock. No native
operator, task transition, retry, or Docker lifecycle action is issued here.
"""
from __future__ import annotations

from contextlib import contextmanager
import inspect
import json
from pathlib import Path
import queue
import re
import shlex
import subprocess
import threading
import time

from docker_build_control import docker_capture, canonical
from docker_volume_linux_supervision_stop import sha

PHASE = 'cancel-failed-no-spawn'
CONTROLLER_SHA256 = 'fb2ec6859577b06663677f654c72fd0dab727a90c5461f17a8647636810ecfca'
LOADER_ERROR = ('Native cancellation outcome requires receipt inspection; do not retry: Traceback (most recent call last):\n'
                '  File "<string>", line 32, in <module>\n'
                'RuntimeError: native cancellation did not complete: /opt/fullmag/package/bin/fullmag-runtime-service: '
                'error while loading shared libraries: libcuda.so.1: cannot open shared object file: No such file or directory')
SCHEMA = 'fullmag.docker-no-spawn-loader-reconciliation.v1'


def require(value, message):
    if not value:
        raise ValueError('No-spawn loader reconciliation: ' + message)


def obj(raw):
    from docker_volume_linux_supervision_stop import decode
    require(isinstance(raw, bytes) and len(raw) <= 16 * 1024 * 1024, 'record exceeds bound')
    return decode(raw)


def validate_receipt(control, raw, *, attempt, receipt_sha256, request_raw, selected, backend_id, image_id):
    require(isinstance(attempt, str) and re.fullmatch('[0-9a-f]{32}', attempt), 'invalid attempt')
    require(sha(raw) == receipt_sha256, 'original receipt CAS differs')
    receipt = obj(raw)
    require(receipt.get('schema') == 'fullmag.docker-build-operation.v1' and receipt.get('phase') == PHASE
            and receipt.get('state') == 'outcome-unknown-resources-retained' and receipt.get('attempt') == attempt,
            'original receipt is not this unknown phase')
    require(receipt.get('compose_project') == control.project and receipt.get('control_volume') == control.volume,
            'original receipt belongs to another project/volume')
    require(receipt.get('control_namespace', '') == control.namespace
            and receipt.get('namespace_registry_sha256') == control.namespace_registry_sha256, 'namespace differs')
    require(receipt.get('helper_container') == 'fullmag-control-' + attempt, 'helper name differs')
    require(receipt.get('error') == LOADER_ERROR, 'only the exact historical loader refusal is supported')
    inputs = receipt.get('inputs', {})
    expected = {'source_root': str(selected), 'request_sha256': sha(request_raw),
                'backend_container_id': backend_id, 'image_id': image_id}
    require(all(inputs.get(k) == v for k, v in expected.items()), 'original request/backend/source/image differs')
    executor = inputs.get('executor', {})
    require(executor.get('controller_sha256') == CONTROLLER_SHA256
            and executor.get('source_root') == str(selected)
            and isinstance(executor.get('commit'), str) and re.fullmatch('[0-9a-f]{40}', executor['commit']),
            'original controller executor is not the supported version')
    return receipt


def inventory_snapshot(store, ledger, owner_root, request, before, *, proc_root=None):
    """Caller holds existing OWNER, ledger WRITER and store WRITER locks.

    Pin every target-run file, including its catalogue and full coordinator
    journal. A loader refusal can never create an execution or Stop record.
    """
    # These names also exist in the self-contained readonly guest script.
    from pathlib import Path
    store, ledger, owner_root = Path(store), Path(ledger), Path(owner_root)
    identity = request['identity']
    run = store / 'runs' / identity['run_id']
    inventory = tree(run)
    forbidden = ('worker-attempts/', 'worker_process_exit_receipts/', 'task_cancellation_intents/',
                 'task_cancellations/', 'worker_execution_started', 'worker_prelaunch_failed')
    require(not any(any(marker in path for marker in forbidden) for path in inventory['files']),
            'native execution/cancellation side effects exist')
    require(not any(path.split('/')[0] in {'worker-attempts', 'worker_process_exit_receipts',
                'task_cancellation_intents', 'task_cancellations'} for path in inventory['directories']),
            'native execution/cancellation side effect directory exists')
    owner_raw = read(owner_root / 'OWNER.json')
    owner = decode(owner_raw)
    require(owner == request['expected_owner'] and sha(owner_raw) == request['owner_sha256'] == before['owner_sha256']
            and owner.get('state') == 'failed', 'Failed owner changed')
    if proc_root is not None:
        pids = [owner.get('pid'), *[child.get('pid') for child in owner.get('children', [])]]
        require(len(pids) == 3 and all(type(pid) is int and pid > 0 for pid in pids)
                and not any((Path(proc_root) / str(pid)).exists() for pid in pids), 'native consumer remains live')
    config = decode(read(owner_root.parent / 'runtime-service/docker-all.json'))
    require(sha(canonical(config)) == request['config_sha256'] == before['config_sha256']
            and config.get('store_root') == str(store), 'native config changed')
    process_raw = read(owner_root.parent / 'runtime-service/process-tree.json')
    process = decode(process_raw)
    require(sha(process_raw) == before['process_receipt_sha256']
            and process.get('state') == 'failed_outcome_retained' and process.get('api_diagnostic_only') is True
            and process.get('accepted_store') == str(store)
            and process.get('error') == ERROR,
            'diagnostic process receipt changed')
    lease = decode(read(run / 'resource_leases' / identity['resource_id'] / (identity['lease_token'] + '.json')))
    require(lease == before['lease'] and lease.get('state') == 'active'
            and sha(canonical(lease)) == request['lease_sha256'], 'original active lease changed')
    document = decode(read(ledger / 'HOST_RESOURCE_LEDGER.json'))
    rows = [row for row in document.get('reservations', []) if row.get('identity') == identity]
    require(len(rows) == 1 and rows[0] == before['reservation'] and rows[0].get('state') == 'committed'
            and rows[0].get('worker_launch_gate') == {'state': 'pending'}
            and sha(canonical(rows[0])) == request['reservation_sha256'], 'original pending host reservation changed')
    require(not [row for row in document.get('reservations', []) if row.get('state') != 'released'
                 and row.get('identity') != identity], 'another active reservation appeared')
    catalog = decode(read(run / 'run_catalog.json'))
    tasks = [task for task in catalog.get('tasks', []) if task.get('task_id') == identity['task_id']]
    require(len(tasks) == 1 and tasks[0] == before['task'] and tasks[0].get('lifecycle') == 'preparing',
            'target task is no longer the original preparing claim')
    claims = []
    command_files = [p for p in inventory['files'] if p.startswith('coordinator_journal/command/')]
    require(len(command_files) == 2, 'original claim must retain exactly Prepare and Start')
    kinds = []
    for relative in command_files:
        entry = decode(read(run / relative))
        require(entry.get('task_id') == identity['task_id'] and entry.get('attempt_id') == identity['owner']['attempt_id']
                and entry.get('terminal') is False, 'coordinator journal no longer belongs to original claim')
        transition = entry.get('payload', {})
        kinds.append(transition.get('message', {}).get('envelope', {}).get('command', {}).get('kind'))
        claim = transition.get('checkpoint', {}).get('claim')
        if claim not in claims:
            claims.append(claim)
    require(sorted(kinds) == ['prepare', 'start'] and claims == [before['claim']]
            and sha(canonical(claims[0])) == request['claim_sha256'], 'original Prepare/Start claim changed or Stop appeared')
    event_files = [p for p in inventory['files'] if p.startswith('coordinator_journal/event/')]
    require(len(event_files) == 1, 'original claim has additional or missing worker events')
    event = decode(read(run / event_files[0]))
    require(event.get('task_id') == identity['task_id'] and event.get('attempt_id') == identity['owner']['attempt_id']
            and event.get('payload', {}).get('message', {}).get('envelope', {}).get('event', {}).get('kind') == 'prepared',
            'original Prepared event changed or worker execution event appeared')
    return {'run_inventory': inventory, 'owner_sha256': sha(owner_raw),
            'config_sha256': sha(canonical(config)), 'process_receipt_sha256': sha(process_raw),
            'lease_sha256': sha(canonical(lease)), 'reservation_sha256': sha(canonical(rows[0])),
            'catalog_sha256': sha(read(run / 'run_catalog.json'))}


# Import only the readonly stdlib primitives used by inventory_snapshot. The
# same implementation is exercised against real temporary files in tests.
from docker_volume_linux_supervision_stop import tree, read, decode, ERROR


def guest_script(request, before, *, hold):
    import docker_volume_linux_supervision_stop as linux
    source = Path(linux.__file__).read_text() + '\n' + inspect.getsource(inventory_snapshot)
    source += '\n' + r'''
import fcntl,sys
sys.path.insert(0,'/opt/fullmag');import runtime_service
paths=runtime_service.canonical_paths();owners=runtime_service.runtime_services_root(paths)
fds=[]
try:
 for path in (owners/'STARTUP-GATE.lock',owners/'LAUNCH.lock',owners/'OWNER.lock',Path('/host-ledger/ledger/WRITER.lock'),paths.store/'WRITER.lock'):
  fd=open_existing(path,os.O_RDONLY);fds.append((path,fd))
  if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink!=1:raise RuntimeError('invalid protected lock')
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 snapshot=inventory_snapshot(paths.store,Path('/host-ledger/ledger'),owners,INPUT['request'],INPUT['before'],proc_root='/proc')
 if binary_sha(paths.package/'bin/fullmag-runtime-service')!=INPUT['before']['native_binary_sha256']:raise RuntimeError('native binary changed under inventory guard')
 print(json.dumps(snapshot,sort_keys=True,separators=(',',':')),flush=True)
 if INPUT['hold']:
  if sys.stdin.buffer.read(1)!=b'R':raise RuntimeError('guard release was not acknowledged')
 for path,fd in fds:
  a=os.fstat(fd);b=os.stat(path,follow_symlinks=False)
  if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino):raise RuntimeError('protected lock inode changed')
finally:
 for _,fd in reversed(fds):os.close(fd)
'''
    payload = {'request': request, 'before': before, 'hold': hold}
    require('from __future__ import annotations' in source, 'readonly guest source has no expected module header')
    return source.replace('from __future__ import annotations',
                          'from __future__ import annotations\nINPUT=' + repr(payload), 1)


def capture_inventory(backend_id, request, before):
    result = docker_capture('exec', backend_id, '/usr/local/bin/python3', '-B', '-c', guest_script(request, before, hold=False), timeout=90)
    require(result.returncode == 0, 'protected inventory observation failed')
    return obj(result.stdout)


@contextmanager
def inventory_guard(backend_id, request, before, expected):
    """Keep the same native locks through original-helper publication."""
    from docker_dev_host import docker_argv
    command = docker_argv('exec', '-i', backend_id, '/usr/local/bin/python3', '-B', '-c', guest_script(request, before, hold=True))
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    messages = queue.Queue(maxsize=1)
    def receive():
        messages.put(process.stdout.readline(16 * 1024 * 1024 + 1))
    threading.Thread(target=receive, daemon=True).start()
    try:
        try:
            raw = messages.get(timeout=90)
        except queue.Empty as error:
            raise ValueError('Protected inventory guard did not acknowledge its locks') from error
        require(obj(raw) == expected, 'protected run inventory changed before final publication')
        yield
    finally:
        # EOF releases a readonly guard after an error; it never publishes data.
        if process.poll() is None:
            try:
                process.stdin.write(b'R')
                process.stdin.flush()
            except (BrokenPipeError, OSError):
                pass
        process.stdin.close()
        try:
            code = process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            # Do not terminate an ambiguous exec; all writes remain forbidden.
            raise ValueError('Readonly inventory guard release is unconfirmed; preserve resources')
        require(code == 0, 'readonly inventory guard failed: ' + process.stderr.read(4096).decode('utf-8', 'replace'))


def authenticate_helper(control, receipt, *, expected=None):
    from docker_volume_activation_reconcile import _validate_helper_logged
    helper_id = control._inspect_operation_helper({'receipt': receipt}, expected_id=expected)
    _validate_helper_logged(helper_id)
    images = json.loads(docker_capture('image', 'inspect', control.image).stdout)
    helpers = json.loads(docker_capture('inspect', helper_id).stdout)
    require(len(images) == len(helpers) == 1 and helpers[0].get('Image') == images[0].get('Id')
            and re.fullmatch('sha256:[0-9a-f]{64}', images[0].get('Id', '')), 'original helper image ID differs')
    pin = {'id': helper_id, 'image_id': images[0]['Id'], 'started_at': helpers[0]['State']['StartedAt']}
    return pin


def commit_script(control, root, attempt, receipt_sha256, request_sha256, result_sha256):
    # Executed only inside the authenticated original helper that already owns
    # operation.lock. It must never acquire a new operation or delete active.
    prefix = control.path(root)
    script = r'''umask 027
check_file() {
 test ! -L "$1"; test -f "$1"; test "$(stat -c %h "$1")" = 1
 test "$(readlink -f "$1")" = "$1"
 test "$(sha256sum "$1" | cut -d' ' -f1)" = "$2"
}
check_file PREFIX/receipt.json RECEIPT_SHA
check_file PREFIX/request.json REQUEST_SHA
check_file /control/active ACTIVE_SHA
test ! -e PREFIX/terminal.json; test ! -L PREFIX/terminal.json
test ! -e PREFIX/native-result.json; test ! -L PREFIX/native-result.json
test "$(readlink -f PREFIX)" = PREFIX
t=$(mktemp PREFIX/.loader-terminal.XXXXXXXX)
trap 'rm -f -- "$t"' EXIT
cat > "$t"
check_file "$t" RESULT_SHA
sync "$t"
# Recheck every source CAS after staging and immediately before create-only publication.
check_file PREFIX/receipt.json RECEIPT_SHA
check_file PREFIX/request.json REQUEST_SHA
check_file /control/active ACTIVE_SHA
test ! -e PREFIX/native-result.json; test ! -L PREFIX/native-result.json
test ! -e PREFIX/terminal.json; test ! -L PREFIX/terminal.json
mv -T --no-clobber -- "$t" PREFIX/terminal.json
test ! -e "$t"
check_file PREFIX/terminal.json RESULT_SHA
sync PREFIX
'''
    values = {'PREFIX': shlex.quote(prefix), 'RECEIPT_SHA': shlex.quote(receipt_sha256),
              'REQUEST_SHA': shlex.quote(request_sha256), 'RESULT_SHA': shlex.quote(result_sha256),
              'ACTIVE_SHA': shlex.quote(sha((attempt + '\n').encode()))}
    for key, value in values.items():
        script = script.replace(key, value)
    return control._namespace_guard(script)


def confirm_release(control, helper_pin, attempt):
    from docker_build_control import bounded_capture
    from docker_volume_activation_reconcile import _probe_helper_absence
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        active = control.read_bytes('active', optional=True)
        require(active in (None, (attempt + '\n').encode()), 'active helper owner changed during release')
        result = docker_capture('inspect', helper_pin['id'], allow_failure=True, timeout=30)
        if result.returncode:
            lines = [line.strip() for line in (result.stdout + result.stderr).decode('utf-8', 'replace').splitlines() if line.strip()]
            missing = re.compile(r'(?i:(?:Error(?:: response from daemon| response from daemon)?: )?No such (?:object|container): )'
                                 + re.escape(helper_pin['id']))
            require(result.returncode == 1 and lines and missing.fullmatch(lines[-1]), 'helper absence is not confirmed')
            require(_probe_helper_absence('fullmag-control-' + attempt) is not None, 'original helper name is still occupied')
            if active is None:
                lock = control.helper_args('test ! -e /control/active; test ! -L /control/active; '
                    'test -f /control/operation.lock; test ! -L /control/operation.lock; '
                    'exec 9</control/operation.lock; flock -n 9')
                probe = bounded_capture(lock, data=b'', timeout=30)
                require(probe.returncode == 0, 'original operation lock release is not confirmed')
                return
        else:
            rows = json.loads(result.stdout)
            require(len(rows) == 1 and rows[0].get('Id') == helper_pin['id']
                    and rows[0].get('Image') == helper_pin['image_id']
                    and rows[0].get('State', {}).get('StartedAt') == helper_pin['started_at'], 'helper incarnation changed')
            if not rows[0]['State'].get('Running') and active is None:
                require(rows[0]['State'].get('ExitCode') == 0, 'helper exit failed')
                probe = bounded_capture(control.helper_args('test ! -e /control/active; test ! -L /control/active; '
                    'exec 9</control/operation.lock; flock -n 9'), data=b'', timeout=30)
                require(probe.returncode == 0, 'operation lock remains held')
                return
        time.sleep(.25)
    raise ValueError('Technical terminal published; original helper release remains unconfirmed')


def reconcile(control, *, attempt, receipt_sha256, request_raw, selected, backend_id, image_id,
              before, observe, apply):
    from docker_build_control import bounded_capture
    root = PHASE + '/attempts/' + attempt
    original = control.read_bytes(root + '/receipt.json')
    receipt = validate_receipt(control, original, attempt=attempt, receipt_sha256=receipt_sha256,
        request_raw=request_raw, selected=selected, backend_id=backend_id, image_id=image_id)
    request = obj(request_raw)
    existing = control.read_bytes(root + '/terminal.json', optional=True)
    if existing is not None:
        terminal = obj(existing)
        proof = terminal.get('reconciliation', {})
        require({k: v for k, v in terminal.items() if k not in {'state', 'finished_at', 'reconciliation'}} ==
                {k: v for k, v in receipt.items() if k not in {'state', 'finished_at', 'reconciliation'}}
                and terminal.get('state') == 'failed-confirmed'
                and set(proof) == {'schema', 'reason', 'original_receipt_sha256', 'request_sha256',
                    'original_helper', 'protected_target_run', 'native_effects', 'native_exit_status'}
                and proof.get('schema') == SCHEMA and proof.get('reason') == 'exact-loader-refusal-before-native-main'
                and proof.get('original_receipt_sha256') == receipt_sha256
                and proof.get('request_sha256') == sha(request_raw)
                and proof.get('native_exit_status') == 'not-recorded'
                and proof.get('native_effects') == 'none-observed; original claim and Active/Committed/Pending retained',
                'existing technical terminal is not this exact loader reconciliation')
        require(control.read_bytes(root + '/request.json') == request_raw
                and control.read_bytes(root + '/native-result.json', optional=True) is None
                and observe() == before
                and capture_inventory(backend_id, request, before) == proof['protected_target_run'],
                'native/request/inventory changed after technical terminal publication')
        helper = proof['original_helper']
        require(isinstance(helper, dict) and set(helper) == {'id', 'image_id', 'started_at'}
                and re.fullmatch('[0-9a-f]{64}', helper.get('id', ''))
                and re.fullmatch('sha256:[0-9a-f]{64}', helper.get('image_id', ''))
                and isinstance(helper.get('started_at'), str), 'existing original-helper pin is malformed')
        images = json.loads(docker_capture('image', 'inspect', control.image).stdout)
        require(len(images) == 1 and images[0].get('Id') == helper['image_id'], 'existing helper image pin differs')
        active = control.read_bytes('active', optional=True)
        require(active in (None, (attempt + '\n').encode()), 'active owner changed after technical terminal')
        if active is not None:
            require(authenticate_helper(control, receipt, expected=helper['id']) == helper,
                    'original helper changed after terminal publication')
        if apply:
            confirm_release(control, helper, attempt)
        return {'state': 'failed-confirmed' if apply else 'preview-loader-terminal-replay', 'attempt': attempt,
                'terminal_path': root + '/terminal.json', 'terminal_sha256': sha(existing),
                'original_receipt_sha256': receipt_sha256, 'native_invoked': False,
                'original_request_preserved': True, 'original_helper_released': bool(apply), 'replay': True}
    def check():
        require(control.read_bytes(root + '/receipt.json') == original
                and control.read_bytes(root + '/request.json') == request_raw
                and control.read_bytes('active') == (attempt + '\n').encode(), 'original receipt/request/active CAS changed')
        require(control.read_bytes(root + '/terminal.json', optional=True) is None
                and control.read_bytes(root + '/native-result.json', optional=True) is None,
                'terminal or native result already exists; do not repeat')
        require(observe() == before, 'native state changed since the pinned pre-main loader refusal')
    check()
    helper = authenticate_helper(control, receipt)
    inventory = capture_inventory(backend_id, request, before)
    terminal = {**receipt, 'state': 'failed-confirmed', 'reconciliation': {
        'schema': SCHEMA, 'reason': 'exact-loader-refusal-before-native-main',
        'original_receipt_sha256': receipt_sha256, 'request_sha256': sha(request_raw),
        'original_helper': helper, 'protected_target_run': inventory,
        'native_effects': 'none-observed; original claim and Active/Committed/Pending retained',
        'native_exit_status': 'not-recorded'}, 'finished_at': time.time()}
    terminal_raw = canonical(terminal) + b'\n'
    if not apply:
        return {'state': 'preview-loader-failure-no-mutation', 'attempt': attempt,
                'terminal_sha256': sha(terminal_raw), 'protected_inventory_sha256': sha(canonical(inventory)),
                'original_receipt_sha256': receipt_sha256, 'native_invoked': False}
    # The readonly backend guard serializes target-store changes until the
    # original helper atomically publishes the technical terminal.
    check()
    require(authenticate_helper(control, receipt, expected=helper['id']) == helper, 'original helper changed before publication')
    with inventory_guard(backend_id, request, before, inventory):
        require(control.read_bytes(root + '/receipt.json') == original
                and control.read_bytes(root + '/request.json') == request_raw, 'control CAS changed while guard acquired locks')
        require(authenticate_helper(control, receipt, expected=helper['id']) == helper, 'original helper changed under guard')
        script = commit_script(control, root, attempt, receipt_sha256, sha(request_raw), sha(terminal_raw))
        from docker_dev_host import docker_argv
        result = bounded_capture([*docker_argv('exec', '-i', '--user', '65532:65532', helper['id']),
                                  '/bin/bash', '-euo', 'pipefail', '-c', script], data=terminal_raw, timeout=90)
        require(result.returncode == 0, 'technical terminal publication outcome unknown; preserve all resources')
    require(control.read_bytes(root + '/terminal.json') == terminal_raw
            and control.read_bytes(root + '/receipt.json') == original
            and control.read_bytes(root + '/request.json') == request_raw
            and control.read_bytes(root + '/native-result.json', optional=True) is None, 'published terminal or retained originals differ')
    confirm_release(control, helper, attempt)
    require(observe() == before and capture_inventory(backend_id, request, before) == inventory,
            'native state changed during technical finalization')
    return {'state': 'failed-confirmed', 'attempt': attempt, 'terminal_path': root + '/terminal.json',
            'terminal_sha256': sha(terminal_raw), 'original_receipt_sha256': receipt_sha256,
            'native_invoked': False, 'original_request_preserved': True, 'original_helper_released': True}
