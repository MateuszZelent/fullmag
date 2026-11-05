"""Exact retained Linux supervision stop after native no-spawn cancellation.

This proof never repairs an owner, changes a task, or releases a lease. The
native cancellation receipt is authority for the already completed operation;
our independent locked inventory is authority only to stop/recreate this group.
"""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import uuid

KIND = 'native-runtime-supervision-linux-retained'
SCHEMA = 'fullmag.docker-linux-supervision-stop-proof.v1'
PREPARED_SCHEMA = 'fullmag.docker-linux-prepared-unclaimed-stop-proof.v1'
PREPARED_KIND = 'native-runtime-supervision-linux-prepared-unclaimed'
ERROR = 'runtime service owner observation failed during supervision: runtime service owner is not ready'
MAX_BYTES = 16 * 1024 * 1024
MAX_FILES = 8192


def require(value, message):
    if not value:
        raise ValueError('Linux supervision stop: ' + message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique,
                       parse_constant=lambda _: require(False, 'nonfinite JSON'))
    require(isinstance(value, dict), 'JSON record is not an object')
    return value


def open_existing(path, flags):
    """Walk every ancestor with descriptor-relative NOFOLLOW; never create."""
    path = Path(path)
    require(path.is_absolute() and '..' not in path.parts, 'noncanonical evidence path')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return os.open(path.name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
    finally:
        os.close(descriptor)


def read(path):
    fd = open_existing(path, os.O_RDONLY)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= MAX_BYTES,
                'unbounded/nonregular evidence')
        raw = stream.read(MAX_BYTES + 1)
        after = os.fstat(stream.fileno())
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(len(raw) == before.st_size and identity(before) == identity(after)
                and identity(after) == identity(os.stat(path, follow_symlinks=False)), 'evidence changed during read')
        return raw


def binary_sha(path, *, single_link=False):
    """Hash a bounded binary without loading it into a 64 MiB helper."""
    fd = open_existing(path, os.O_RDONLY)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode)
                and (not single_link or before.st_nlink == 1)
                and 0 < before.st_size <= 512 * 1024 * 1024, 'binary evidence is unbounded/nonregular')
        digest = hashlib.sha256()
        count = 0
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            count += len(chunk)
            require(count <= before.st_size, 'native binary grew during observation')
        after = os.fstat(stream.fileno())
        pin = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(count == before.st_size and pin(before) == pin(after)
                and pin(after) == pin(os.stat(path, follow_symlinks=False)), 'native binary changed')
        return digest.hexdigest()


def tree(root, *, terminal_only=False, retained_run=None):
    """Pin the complete bounded record tree; reject links/devices/aliases."""
    root = Path(root)
    records, directories = {}, []
    total = 0
    def walk(path):
        nonlocal total
        fd = open_existing(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            before = os.fstat(fd)
            names = sorted(os.listdir(fd))
            directories.append(str(path.relative_to(root)))
            require(len(records) + len(directories) + len(names) <= MAX_FILES, 'store inventory too large')
            for name in names:
                child = path / name
                metadata = os.stat(name, dir_fd=fd, follow_symlinks=False)
                relative = child.relative_to(root)
                if terminal_only and len(relative.parts) == 2 and relative.parts[0] != retained_run:
                    require(stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode),
                            'nonregular run entry')
                    if name not in {'run_intent.json', 'run_catalog.json',
                                    'resource_leases', 'preparation_resource_leases'}:
                        continue
                if stat.S_ISDIR(metadata.st_mode):
                    walk(child)
                else:
                    raw = read(child)
                    total += len(raw)
                    require(total <= 128 * 1024 * 1024, 'store evidence byte budget exceeded')
                    records[str(child.relative_to(root))] = sha(raw)
            after = os.fstat(fd)
            require((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns)
                    == (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns), 'directory changed during scan')
        finally:
            os.close(fd)
    walk(root)
    return {'directories': directories, 'files': records}


def observe_store(store, ledger, store_id, *, terminal_only=False, prepared_target=None):
    """Pin admission evidence under the ledger and store writer locks."""
    store, ledger = Path(store), Path(ledger)
    for name in ('temp', 'recovery'):
        fd = open_existing(store / name, os.O_RDONLY | os.O_DIRECTORY)
        try:
            require(not os.listdir(fd), 'pending transactions exist')
        finally:
            os.close(fd)
    if prepared_target is not None:
        require(not terminal_only and isinstance(prepared_target, dict), 'conflicting prepared observation modes')
        require(all(isinstance(prepared_target.get(k), str)
                    and re.fullmatch('[A-Za-z0-9_.:-]+', prepared_target[k])
                    for k in ('run_id', 'task_id', 'request_id', 'api_instance_id', 'session_id'))
                and re.fullmatch('[0-9a-f]{64}', prepared_target.get('source_sha256', ''))
                and type(prepared_target.get('session_epoch')) is int
                and prepared_target['session_epoch'] > 0, 'prepared target pins are incomplete')
    inventory = tree(store / 'runs', terminal_only=terminal_only or prepared_target is not None,
                     retained_run=prepared_target['run_id'] if prepared_target else None)
    require(all('/' in key for key in inventory['files']), 'unknown file at runs root')
    terminal, held, catalogs, leases, cas = [], [], {}, [], {}
    run_ids = sorted(name for name in inventory['directories'] if '/' not in name and name != '.')
    for run_id in run_ids:
        root = store / 'runs' / run_id
        intent = decode(read(root / 'run_intent.json'))
        catalog = decode(read(root / 'run_catalog.json'))
        tasks = catalog.get('tasks')
        require(intent.get('run_id') == run_id and catalog.get('run_id') == run_id
                and isinstance(tasks, list) and tasks, 'run/catalog identity differs')
        specification = intent.get('specification', {})
        references = [specification.get('snapshot', {}).get('definition_sha256'),
                      specification.get('study', {}).get('plan_sha256'), specification.get('study_catalog_sha256')]
        for digest in references:
            require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'immutable run CAS pin missing')
            if digest not in cas:
                path = store / 'objects/sha256' / digest
                actual = binary_sha(path, single_link=True) if terminal_only else sha(read(path))
                require(actual == digest, 'immutable run CAS object differs')
                cas[digest] = actual
        require(all(isinstance(t, dict) for t in tasks), 'invalid task record')
        catalogs[run_id] = tasks
        terminal_task = lambda t: t.get('lifecycle') in {'succeeded', 'failed', 'cancelled', 'interrupted'}
        if all(terminal_task(t) for t in tasks):
            terminal.append(run_id)
        else:
            require(not terminal_only, 'nonterminal run in terminal-only observation')
            if prepared_target is not None:
                require(run_id == prepared_target['run_id'], 'another nonterminal run remains')
                _prepared_run(store, run_id, intent, tasks, inventory, prepared_target)
            else:
                _held_manual_run(root, intent, tasks, inventory, run_id)
                held.append(run_id)
        for relative in inventory['files']:
            if relative.startswith(run_id + '/') and any('/' + kind + '/' in '/' + relative for kind in
                    ('resource_leases', 'preparation_resource_leases')):
                lease = decode(read(store / 'runs' / relative))
                require(lease.get('state') == 'released', 'active lease remains')
                leases.append({'path': relative, 'record': lease})
    ledger_raw = read(ledger / 'HOST_RESOURCE_LEDGER.json')
    document = decode(ledger_raw)
    rows = document.get('reservations')
    require(isinstance(rows, list) and len(rows) <= MAX_FILES, 'ledger reservations unavailable')
    proofs = {}
    for row in rows:
        require(row.get('state') == 'released', 'active host reservation remains')
        digest = row.get('release_proof_sha256', '')
        require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'missing release proof')
        raw = read(ledger / 'proofs' / (digest + '.json'))
        proof = decode(raw)
        require(sha(raw) == digest and proof.get('schema_version') in
                {'host_resource_release_proof.v1', 'host_resource_release_proof.v2'}
                and proof.get('host_id') == document.get('policy', {}).get('host_id')
                and proof.get('store_id') == row.get('identity', {}).get('store_id')
                and proof.get('request_sha256') == row.get('request_sha256'), 'release proof differs')
        require(row.get('identity', {}).get('store_id') == store_id, 'foreign store reservation in private ledger')
        proofs[digest] = sha(raw)
    result = {'inventory': inventory, 'ledger_sha256': sha(ledger_raw), 'release_proofs': proofs,
            'terminal_runs': terminal, 'held_manual_runs': held, 'store_id': store_id,
            'reservations': rows, 'catalogs': catalogs, 'leases': leases, 'immutable_objects': cas}
    if prepared_target is not None:
        require(prepared_target['run_id'] in catalogs
                and prepared_target['run_id'] not in terminal, 'selected prepared run is not unclaimed')
        result['prepared_unclaimed'] = _prepared_release(store, ledger, rows, store_id, prepared_target)
    return result


def _held_manual_run(root, intent, tasks, inventory, run_id):
    policy = intent.get('specification', {}).get('parameters', {}).get('fullmag.accepted_run_start')
    require(policy == {'schema_version': 'accepted_run_start_policy.v1', 'mode': 'manual'}
            and not os.path.lexists(root / 'start_release.json'), 'nonterminal run is not held manual')
    for task in tasks:
        require(task.get('lifecycle') in {'accepted', 'queued'}
                and all(task.get(k) is None for k in ('attempt_id', 'ownership_epoch', 'resource_id',
                    'coordinator_watermark', 'coordinator_genesis', 'resolved_input_fingerprint'))
                and not task.get('artifact_ids'), 'held manual run acquired a claim')
    require(not any(relative.startswith(run_id + '/' + name + '/')
                    for relative in inventory['files'] for name in
                    ('worker-attempts', 'worker_process_exit_receipts', 'worker_inbox', 'coordinator_journal')),
            'held manual run has worker execution evidence')


def _prepared_run(store, run_id, intent, tasks, inventory, target):
    """An original startup script may have a manual native start policy.

    Pin both facts; neither that policy nor the absence of a solver lease is
    evidence that preparation failed or that the task was cancelled.
    """
    parameters = intent.get('specification', {}).get('parameters', {})
    workspace = parameters.get('live_workspace', {})
    command = workspace.get('command', {})
    require(command.get('kind') == 'startup_script'
            and all(workspace.get(k) == target[k] for k in ('api_instance_id', 'session_id', 'session_epoch'))
            and command.get('request_id') == workspace.get('command_id') == workspace.get('request_idempotency_key') == target['request_id']
            and command.get('source_sha256') == workspace.get('startup_source_sha256') == target['source_sha256'],
            'prepared startup request/API/session/source identity differs')
    policy = parameters.get('fullmag.accepted_run_start')
    require(isinstance(policy, dict) and policy.get('schema_version') == 'accepted_run_start_policy.v1'
            and policy.get('mode') in {'manual', 'automatic'}, 'unknown original start policy')
    require(len(tasks) == 1 and tasks[0].get('task_id') == target['task_id']
            and tasks[0].get('lifecycle') in {'accepted', 'queued'}
            and all(tasks[0].get(k) is None for k in ('attempt_id', 'ownership_epoch', 'resource_id',
                'coordinator_watermark', 'coordinator_genesis', 'resolved_input_fingerprint'))
            and not tasks[0].get('artifact_ids'), 'prepared task acquired a claim')
    allowed = {'run_intent.json', 'run_catalog.json', 'preparation_resource_leases',
               'preparation_process_exit_receipts', 'preparation_process_launches',
               'task_preparation_receipts', 'task_prepared_observations'}
    for relative in inventory['files']:
        if relative.startswith(run_id + '/'):
            require(relative.split('/')[1] in allowed, 'prepared run has Start/solver/unknown execution evidence')
    for relative in inventory['directories']:
        if relative.startswith(run_id + '/'):
            require(relative.split('/')[1] in allowed, 'prepared run has an unknown actor directory')
    require(not os.path.lexists(store / 'runs' / run_id / 'start_release.json'), 'prepared run has Start release')


def _prepared_release(store, ledger, rows, store_id, target):
    root = store / 'runs' / target['run_id']
    selected_paths = set()
    def single(directory):
        paths = sorted((root / directory).rglob('*.json'))
        require(len(paths) == 1, 'prepared chain is missing or ambiguous: ' + directory)
        selected_paths.add(str(paths[0].relative_to(root)))
        return decode(read(paths[0]))
    lease = single('preparation_resource_leases')
    launch = single('preparation_process_launches')
    exited = single('preparation_process_exit_receipts')
    receipt = single('task_preparation_receipts')
    published = single('task_prepared_observations')
    expected_paths = selected_paths | {'run_intent.json', 'run_catalog.json'}
    expected_directories = {str(parent) for relative in expected_paths for parent in Path(relative).parents}
    chain_inventory = tree(root)
    require(set(chain_inventory['files']) == expected_paths
            and set(chain_inventory['directories']) == expected_directories,
            'prepared chain contains an unknown execution record or actor directory')
    for record, schema in ((lease, 'preparation_resource_lease.v1'), (launch, 'preparation_process_launch.v1'),
                           (exited, 'preparation_process_exit_receipt.v1'), (receipt, 'task_preparation_receipt.v1'),
                           (published, 'task_prepared_observation.v1')):
        require(record.get('schema_version') == schema
                and all(record.get(k) == target[k] for k in ('run_id', 'task_id')), 'prepared chain identity differs')
    require(lease.get('state') == 'released' and exited.get('status_success') is True
            and type(exited.get('exit_code')) is int and exited['exit_code'] == 0
            and exited.get('timed_out') is False
            and type(lease.get('heartbeat_sequence')) is int
            and exited.get('lease_heartbeat_sequence') == lease['heartbeat_sequence'], 'preparation is not authentic exit0/Released')
    for key in ('resource_id', 'lease_token', 'preparation_attempt_id'):
        require(isinstance(lease.get(key), str) and lease[key]
                and lease[key] == launch.get(key) == exited.get(key), 'preparation lease/launch/exit binding differs')
    require(exited.get('receipt_id') == 'prep-exit-' + launch.get('launch_id', '')
            and type(exited.get('process_id')) is int and exited['process_id'] > 0
            and re.fullmatch('linux-starttime-[0-9]+', exited.get('process_start_token', '')),
            'preparation exit process identity differs')
    require(receipt.get('payload', {}).get('plan', {}).get('requested_backend') == 'fem'
            and receipt['payload']['plan'].get('resolved_backend') == 'fem'
            and published.get('requested_lane') in {'fem_cpu', 'fem_gpu'}
            and published.get('evaluation_lane') == published['requested_lane']
            and published.get('outcome', {}).get('state') == 'published'
            and all(receipt.get(k) is not None and receipt[k] == published.get(k)
                    for k in ('step_id', 'preparation_id', 'plan_fingerprint')), 'successful FEM preparation publication differs')
    objects = published['outcome'].get('object_refs')
    require(isinstance(objects, list), 'prepared object references unavailable')
    bundle = published['outcome'].get('bundle_object_ref')
    require(isinstance(bundle, str) and re.fullmatch('[0-9a-f]{64}', bundle), 'prepared bundle CAS reference unavailable')
    prepared_cas = {}
    for digest in [bundle, *objects]:
        require(isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest)
                and binary_sha(store / 'objects/sha256' / digest, single_link=True) == digest,
                'prepared CAS object differs')
        prepared_cas[digest] = digest
    matches = [row for row in rows if row.get('identity', {}).get('run_id') == target['run_id']]
    identity = dict(store_id=store_id, run_id=target['run_id'], task_id=target['task_id'],
                    resource_id=lease['resource_id'], lease_token=lease['lease_token'],
                    owner={'kind': 'preparation', 'preparation_attempt_id': lease['preparation_attempt_id']})
    require(len(matches) == 1 and matches[0].get('identity') == identity
            and matches[0].get('state') == 'released', 'prepared host reservation is not exactly Released')
    row = matches[0]
    proof = decode(read(ledger / 'proofs' / (row['release_proof_sha256'] + '.json')))
    owner = row.get('preparation_launch_owner', {})
    require(proof.get('kind') == 'preparation' and proof.get('preparation_receipt') == exited
            and proof.get('released_preparation_lease') == lease
            and proof.get('preparation_launch_owner') == owner
            and owner.get('launch_id') == launch.get('launch_id')
            and owner.get('launch_sha256') == sha(canonical(launch))
            and all(owner.get(k) == launch.get(k) for k in ('supervisor_process_id', 'supervisor_start_token'))
            and row.get('preparation_launch_gate', {}).get('state') == 'consumed', 'host preparation release chain differs')
    parameters = decode(read(root / 'run_intent.json'))['specification']['parameters']
    return {'target': target, 'start_policy': parameters['fullmag.accepted_run_start'],
            'command_kind': parameters['live_workspace']['command']['kind'],
            'preparation_pid': exited['process_id'], 'preparation_start_token': exited['process_start_token'],
            'prepared_objects': prepared_cas,
            'host_release_proof_sha256': row['release_proof_sha256']}


def observe(state, control_root, ledger, image_id, *, stopped=False, proc_root='/proc',
            binary='/opt/fullmag/package/bin/fullmag-runtime-service', prepared_target=None):
    """Image-owned read-only observation; all locks are existing and scoped."""
    import fcntl
    state, control_root, ledger = Path(state), Path(control_root), Path(ledger)
    store = state / 'runs/docker-all/session-store'
    owners = control_root / 'runtime-services'
    with ExitStack() as stack:
        descriptors = []
        for path in (owners / 'STARTUP-GATE.lock', owners / 'LAUNCH.lock', owners / 'OWNER.lock',
                     ledger / 'WRITER.lock', store / 'WRITER.lock'):
            fd = open_existing(path, os.O_RDONLY)
            stack.callback(os.close, fd)
            require(stat.S_ISREG(os.fstat(fd).st_mode) and os.fstat(fd).st_nlink == 1, 'invalid lock inode')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            descriptors.append((path, fd))
        receipt_raw = read(control_root / 'runtime-service/process-tree.json')
        receipt = decode(receipt_raw)
        owner_raw = read(owners / 'OWNER.json')
        owner = decode(owner_raw)
        pin = receipt.get('service_owner')
        require(receipt.get('schema') == 'fullmag.docker-process-tree.v1'
                and receipt.get('error') == ERROR and receipt.get('accepted_store') == str(store)
                and receipt.get('state') == ('shutdown_unknown' if stopped else 'failed_outcome_retained')
                and 'terminal_service_owner' not in receipt and receipt.get('runtime_pid') is None,
                'process is not the exact retained supervision failure')
        require(isinstance(pin, dict) and pin.get('state') == 'ready' and owner.get('state') == 'failed'
                and owner.get('schema_version') == 'runtime_service_owner.v1'
                and owner.get('protocol') == 'stdin-v1' and owner.get('target_id') == 'docker-all', 'native owner is not terminal Failed')
        children = owner.get('children')
        require(isinstance(children, list) and len(children) == 2
                and {c.get('role') for c in children} == {'compute', 'preparation'}
                and all(c.get('status') in {'exited_success', 'exited_failure'} for c in children)
                and any(c.get('status') == 'exited_failure' for c in children), 'native children are not terminal')
        expected = dict(pin, state='failed', heartbeat_at=owner.get('heartbeat_at'), children=children)
        require(owner == expected and [(c.get('role'), c.get('pid')) for c in children]
                == [(c.get('role'), c.get('pid')) for c in pin.get('children', [])], 'Failed owner differs from exact Ready pin')
        token = pin.get('owner_token', '')
        require(str(uuid.UUID(token)) == token, 'owner token is invalid')
        require(decode(read(owners / ('docker-client-' + token + '.json'))) == pin, 'immutable Ready pin differs')
        pids = [owner.get('pid'), *[c.get('pid') for c in children]]
        require(all(type(pid) is int and pid > 0 for pid in pids) and len(set(pids)) == 3
                and not any((Path(proc_root) / str(pid)).exists() for pid in pids), 'native consumer is live or ambiguous')
        api_pid = receipt.get('api_pid')
        require(type(api_pid) is int and api_pid > 0 and api_pid not in pids, 'API identity unavailable')
        fence_path = Path(receipt.get('api_failure_fence', ''))
        require(fence_path.parent == control_root / 'runtime-service'
                and re.fullmatch('api-failure-[0-9a-f]{32}.json', fence_path.name), 'diagnostic fence escapes runtime control')
        fence_raw = read(fence_path)
        fence = decode(fence_raw)
        require(receipt.get('api_diagnostic_only') is True
                and fence.get('schema') == 'fullmag.api-runtime-failure-fence.v1'
                and fence.get('stage') == 'runtime_supervision' and fence.get('reason') == ERROR
                and fence.get('api_pid') == api_pid and isinstance(fence.get('api_instance_id'), str), 'API is not explicitly fenced diagnostics')
        if prepared_target is not None:
            require(fence['api_instance_id'] == prepared_target.get('api_instance_id'), 'prepared API fence identity differs')
        if stopped:
            require(not (Path(proc_root) / str(api_pid)).exists()
                    and type(receipt.get('api_exit_code')) is int
                    and receipt.get('shutdown_error') == 'runtime service owner is not ready', 'API stop is not confirmed')
        else:
            require((Path(proc_root) / str(api_pid)).exists(), 'diagnostic API incarnation disappeared')
            environment = (Path(proc_root) / str(api_pid) / 'environ').read_bytes().split(b'\0')
            require(('FULLMAG_API_RUNTIME_FAILURE_FENCE=' + str(fence_path)).encode() in environment,
                    'live API does not reference the diagnostic fence')
        for entry in Path(proc_root).iterdir():
            if not entry.name.isdigit():
                continue
            try:
                executable = os.readlink(entry / 'exe')
            except FileNotFoundError:
                continue
            if executable.startswith(str(Path(binary).parent) + '/') and Path(executable).name.startswith('fullmag'):
                require(not stopped and int(entry.name) == api_pid and Path(executable).name == 'fullmag-api',
                        'unexpected native consumer remains live')
        cert_raw = read(state / 'linux-native-host.json')
        cert = decode(cert_raw)
        require(cert == decode(read(state / '.fullmag-linux-native-owner.json'))
                and cert.get('schema') == 'fullmag.linux-native-host.v1' and cert.get('storage_profile') == 'linux-native-v1'
                and cert.get('role') == 'session' and cert.get('owner_scope') == 'docker-linux'
                and cert.get('restart_verified') is True and cert.get('image_id') == image_id
                and cert.get('host_inode') == state.stat().st_ino and cert.get('host_device') == state.stat().st_dev,
                'Linux storage admission differs')
        owner_token, engine = cert.get('owner_token'), cert.get('engine_id')
        require(isinstance(owner_token, str) and re.fullmatch('[0-9a-f]{32}', owner_token)
                and isinstance(engine, str) and engine, 'Linux stable store identity is incomplete')
        sentinel = (owner_token + ':' + image_id).encode()
        require(read(state / '.linux-native-sentinel') == sentinel and read(state / '.linux-native-restart') == sentinel
                and cert.get('restart_expected_sha256') == sha(sentinel), 'Linux restart sentinel differs')
        identity = {'schema': 'fullmag.linux-native-store-identity.v1', 'engine_id': engine,
                    'owner_token': owner_token, 'relative_state_path': 'runs/docker-all/session-store'}
        store_proof = observe_store(store, ledger, 'sha256:' + sha(canonical(identity)), prepared_target=prepared_target)
        if prepared_target is not None:
            prep_pid = store_proof['prepared_unclaimed']['preparation_pid']
            require(prep_pid not in [api_pid, *pids] and not (Path(proc_root) / str(prep_pid)).exists(),
                    'preparation process is live or ambiguous')
        for path, fd in descriptors:
            require((os.fstat(fd).st_dev, os.fstat(fd).st_ino) ==
                    (path.stat().st_dev, path.stat().st_ino), 'lock inode changed')
        config_raw = read(control_root / 'runtime-service/docker-all.json')
        config = decode(config_raw)
        require(config.get('store_root') == str(store), 'native config selects another store')
        return {'schema': PREPARED_SCHEMA if prepared_target is not None else SCHEMA,
                **({'application_build_commit': owner.get('build_commit'),
                    'application_build_snapshot': owner.get('build_snapshot')} if prepared_target is not None else {}),
                'process_receipt_sha256': sha(receipt_raw), 'owner_sha256': sha(owner_raw),
                'config_sha256': sha(canonical(config)), 'config_raw_sha256': sha(config_raw),
                'certificate_sha256': sha(cert_raw),
                'api_failure_fence_sha256': sha(fence_raw), 'ready_pin_sha256': sha(canonical(pin)),
                'api_pid': api_pid, 'store': store_proof, 'native_binary_sha256': binary_sha(binary)}


def _script(image_id, stopped, prepared_target=None):
    # This module is stdlib-only until the orchestration functions are called.
    source = Path(__file__).read_text()
    return source + '\nprint(json.dumps(observe("/state", "/opt/fullmag/runtime-control", "/host-ledger/ledger", ' + repr(image_id) + ', stopped=' + repr(stopped) + ', prepared_target=' + repr(prepared_target) + ')))\n'


def _probe(control, actual, image_id, *, stopped=False, prepared_target=None):
    from docker_build_control import docker_capture, bounded_capture
    if not stopped:
        result = docker_capture('exec', actual['Id'], '/usr/local/bin/python3', '-B', '-c', _script(image_id, False, prepared_target), timeout=90)
    else:
        import copy
        require(actual.get('Image') == image_id and re.fullmatch('sha256:[0-9a-f]{64}', image_id),
                'readonly probe requires the exact immutable backend image')
        script = '/usr/local/bin/python3 -B -c ' + shlex.quote(_script(image_id, True, prepared_target))
        # The CUDA base used by generic control reads need not contain Python.
        # This exact image already ran the pre-stop Python observation above.
        probe_control = copy.copy(control)
        probe_control.image = image_id
        args = probe_control.helper_args(script)
        at = args.index('--entrypoint')
        mounts = []
        for target in ('/state', '/host-ledger', '/opt/fullmag/runtime-control', '/opt/fullmag/package'):
            mounts += ['--mount', readonly_mount(actual, target)]
        args[at:at] = mounts
        result = bounded_capture(args, data=b'', timeout=90, maximum=MAX_BYTES)
    require(result.returncode == 0, 'locked observation failed: ' + result.stderr.decode('utf-8', 'replace')[-2048:])
    return decode(result.stdout)


def readonly_mount(actual, target):
    """Retain Docker's authoritative volume subpath, including shared packages."""
    from docker_volume_capture_failure_reconcile import _mount_arg
    mount = _mount_arg(actual, target)
    rows = [m for m in actual.get('HostConfig', {}).get('Mounts', []) if m.get('Target') == target]
    require(len(rows) == 1, 'mount request is missing/ambiguous: ' + target)
    row = rows[0]
    if row.get('Type') == 'volume':
        observed = [m for m in actual['Mounts'] if m.get('Destination') == target]
        require(row.get('Source') == observed[0].get('Name'), 'volume request identity differs')
        subpath = row.get('VolumeOptions', {}).get('Subpath', '')
        if subpath:
            path = Path(subpath)
            require(isinstance(subpath, str) and not path.is_absolute() and '..' not in path.parts
                    and re.fullmatch('[A-Za-z0-9_./-]+', subpath), 'invalid retained mount subpath')
            mount += ',volume-subpath=' + subpath
    return mount


def cancellation(control, scope, observation, *, original_process_sha256=None):
    pointer_raw = control.read_bytes('no-spawn-cancellation/current.json')
    pointer = decode(pointer_raw)
    path = pointer.get('path', '')
    require(pointer.get('schema') == 'fullmag.docker-no-spawn-cancellation-reference.v1'
            and re.fullmatch('verification/no-spawn-cancellation-[0-9a-f-]{36}.json', path), 'no-spawn reference differs')
    token = path[len('verification/no-spawn-cancellation-'):-5]
    require(str(uuid.UUID(token)) == token and uuid.UUID(token).int != 0, 'no-spawn request UUID invalid')
    raw = control.read_bytes(path)
    record = decode(raw)
    require(sha(raw) == pointer.get('sha256') and record.get('schema') == 'fullmag.docker-no-spawn-cancellation.v1'
            and record.get('state') == 'cancelled-no-spawn', 'no-spawn receipt CAS/state differs')
    for key, value in scope.items():
        require(record.get(key) == value, 'no-spawn scope differs: ' + key)
    require(record.get('control_namespace') == control.namespace
            and record.get('namespace_registry_sha256') == control.namespace_registry_sha256, 'no-spawn namespace differs')
    for key in ('owner_sha256', 'config_sha256'):
        require(record.get(key) == observation[key], 'no-spawn native evidence differs: ' + key)
    require(record.get('process_receipt_sha256') == (original_process_sha256 or observation['process_receipt_sha256']),
            'no-spawn process evidence differs')
    require(record.get('native_binary_sha256') == observation['native_binary_sha256'], 'native cancellation binary differs')
    request, result = record.get('request', {}), record.get('result', {})
    root = record.get('operation_root', '')
    require(isinstance(root, str) and re.fullmatch('cancel-failed-no-spawn/attempts/[0-9a-f]{32}', root),
            'managed cancellation operation is missing')
    request_raw = control.read_bytes(root + '/request.json')
    require(sha(request_raw) == record.get('request_sha256') and decode(request_raw) == request,
            'native request archive differs')
    require(record.get('native_result_path') == root + '/native-result.json'
            and decode(control.read_bytes(root + '/native-result.json')) == result, 'native stdout archive differs')
    terminal_raw = control.read_bytes(root + '/terminal.json')
    terminal = decode(terminal_raw)
    require(control.read_bytes(root + '/receipt.json') == terminal_raw
            and terminal.get('phase') == 'cancel-failed-no-spawn' and terminal.get('state') == 'succeeded'
            and terminal.get('attempt') == root.rsplit('/', 1)[1]
            and terminal.get('compose_project') == control.project and terminal.get('control_volume') == control.volume
            and terminal.get('result') == {'path': path, 'sha256': sha(raw)}, 'cancellation operation is not completed')
    for key in ('source_root', 'backend_container_id', 'image_id'):
        require(terminal.get('inputs', {}).get(key) == record.get(key), 'cancellation operation scope differs')
    require(terminal.get('inputs', {}).get('request_sha256') == sha(request_raw), 'cancellation operation request differs')
    require(request.get('schema_version') == 'runtime_service_failed_no_spawn_cancellation.v1'
            and result.get('schema_version') == request['schema_version'] and request.get('request_id') == token
            and result.get('request_id') == token and result.get('status') == 'cancelled_no_spawn', 'native cancellation result differs')
    identity = request.get('identity', {})
    run_id, task_id = result.get('run_id'), result.get('task_id')
    require(run_id == identity.get('run_id') and task_id == identity.get('task_id')
            and identity.get('store_id') == observation['store']['store_id'], 'cancelled task identity differs')
    matches = [row for row in observation['store']['reservations'] if row.get('identity') == identity]
    require(len(matches) == 1 and matches[0].get('state') == 'released'
            and matches[0].get('worker_launch_gate', {}).get('state') == 'closed'
            and matches[0].get('release_proof_sha256') == result.get('release_proof_sha256'), 'cancelled reservation is not Released/Closed')
    prefix = run_id + '/'
    catalog_key = prefix + 'run_catalog.json'
    require(catalog_key in observation['store']['inventory']['files'] and run_id in observation['store']['terminal_runs'],
            'cancelled run is not terminal')
    tasks = [task for task in observation['store']['catalogs'][run_id] if task.get('task_id') == task_id]
    require(len(tasks) == 1 and tasks[0].get('lifecycle') == 'cancelled', 'native cancellation is not canonical Cancelled')
    owner = identity.get('owner', {})
    leases = [item['record'] for item in observation['store']['leases'] if
              item['record'].get('run_id') == run_id and item['record'].get('task_id') == task_id
              and item['record'].get('attempt_id') == owner.get('attempt_id')
              and item['record'].get('ownership_epoch') == owner.get('ownership_epoch')
              and item['record'].get('lease_token') == identity.get('lease_token')]
    require(len(leases) == 1 and leases[0].get('state') == 'released', 'native cancellation local lease is not Released')
    return {'path': path, 'sha256': sha(raw), 'pointer_sha256': sha(pointer_raw)}


class LinuxSupervisionContext(dict):
    """Typed witness of independently revalidated Linux stop evidence."""


def stop(args, selected, identity, actual):
    from docker_build_control import BuildControl, toolchain_configuration, docker_capture
    from docker_volume_dev import _validate_retained_service, _assert_private_restart_network, _retained_certificate
    from docker_volume_reconcile import fingerprint
    config = toolchain_configuration(selected, identity)
    control = BuildControl(identity, config['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    previous = control.read('development/current.json')
    attempt = previous.get('attempt', '')
    require(re.fullmatch('[0-9a-f]{32}', attempt) and previous.get('state') == 'succeeded'
            and previous.get('compose_project') == control.project and previous.get('backend_container') == args.container_id
            and previous.get('inputs', {}).get('source_root') == str(selected), 'development authority differs')
    base = 'development/attempts/' + attempt
    document = control.read(base + '/compose.json')
    config_sha = sha(canonical(document))
    require(control.read(base + '/terminal.json') == previous and control.read('development/verified.json') == previous
            and previous.get('config_sha256') == config_sha and document.get('name') == control.project, 'terminal/verified/Compose CAS differs')
    ids = {'backend': args.container_id, 'frontend': previous.get('frontend_container')}
    initial = {}
    def services():
        result = {}
        for name, identifier in ids.items():
            value = json.loads(docker_capture('inspect', identifier).stdout)[0]
            service_image = document['services'][name]['image']
            image = json.loads(docker_capture('image', 'inspect', service_image).stdout)[0]
            require(value.get('Id') == identifier and value.get('Image') == service_image, 'service ownership differs')
            _validate_retained_service(document, value, name, image['Config'])
            if initial:
                require((value['State']['StartedAt'], fingerprint(value)) == initial[name], 'service incarnation changed')
            result[name] = value
        return result
    current = services()
    require(current['backend']['Image'] == args.image_id and current['backend']['State']['Running'] is True
            and actual['State']['StartedAt'] == current['backend']['State']['StartedAt']
            and fingerprint(actual) == fingerprint(current['backend']), 'backend observation differs')
    require('FULLMAG_SESSION_STORAGE_PROFILE=linux-native-v1' in actual['Config']['Env'], 'only Linux admitted storage supported')
    _assert_private_restart_network(current, ids, control.project)
    _retained_certificate(Path(previous['state_root']), document)
    initial.update({k: (v['State']['StartedAt'], fingerprint(v)) for k, v in current.items()})
    scope = {'compose_project': control.project, 'control_volume': control.volume, 'source_root': str(selected),
             'development_attempt': attempt, 'compose_config_sha256': config_sha, 'backend_container_id': args.container_id,
             'image_id': args.image_id, 'started_at': actual['State']['StartedAt'], 'backend_fingerprint': fingerprint(actual)}
    path = 'verification/stop-failed-' + args.container_id + '.json'
    with control.operation('stop-failed-runtime', {'source_root': str(selected), 'attempt': attempt,
            'container_id': args.container_id, 'image_id': args.image_id, 'config_sha256': config_sha}) as operation:
        require(control.read(path, optional=True) is None, 'stop journal already exists')
        def recheck():
            require(control.read('development/current.json') == previous and control.read(base + '/terminal.json') == previous
                    and control.read('development/verified.json') == previous and control.read(base + '/compose.json') == document,
                    'development authority changed')
            pair = services()
            _assert_private_restart_network(pair, ids, control.project)
            _retained_certificate(Path(previous['state_root']), document)
            obs = _probe(control, pair['backend'], args.image_id)
            require(obs['process_receipt_sha256'] == args.process_receipt_sha256, 'pinned process receipt differs')
            return obs, cancellation(control, scope, obs)
        before, cancelled = recheck()
        # Quiesce this exact private frontend before the last API/store observation.
        if current['frontend']['State']['Running']:
            operation['daemon_pending'] = True
            docker_capture('stop', '--time', '60', ids['frontend'], timeout=90)
            operation['daemon_pending'] = False
        require(recheck() == (before, cancelled), 'store/evidence changed during frontend quiescence')
        journal = {'schema': 'fullmag.stop-failed-admission.v1', 'state': 'stopping-confirmed-linux-supervision',
                   'failure_kind': KIND, 'container_id': args.container_id, 'image_id': args.image_id,
                   'source_root': str(selected), 'development_attempt': attempt, 'compose_config_sha256': config_sha,
                   'supervision_probe': before, 'scope': scope, 'cancellation': cancelled,
                   'previous_config_sha256': before['config_raw_sha256'], 'service_pins': initial,
                   'operation_attempt': operation['receipt']['attempt']}
        control.write(path, journal)
        require(recheck() == (before, cancelled), 'final stop evidence changed')
        operation['daemon_pending'] = True
        docker_capture('stop', '--time', '60', args.container_id, timeout=90)
        pair = services()
        for name, value in pair.items():
            require(value['State'].get('Running') is False and value['State'].get('Pid') == 0
                    and value['State'].get('OOMKilled') is False and type(value['State'].get('ExitCode')) is int,
                    'service namespace stop is unconfirmed: ' + name)
        after = _probe(control, pair['backend'], args.image_id, stopped=True)
        _same_retained(before, after)
        require(cancellation(control, scope, after, original_process_sha256=before['process_receipt_sha256']) == cancelled,
                'cancellation proof changed after stop')
        journal.update(state='stopped-confirmed', terminal_process_receipt_sha256=after['process_receipt_sha256'],
                       namespace_processes_absent=True, exit_code=pair['backend']['State']['ExitCode'],
                       stopped_started_at=pair['backend']['State']['StartedAt'])
        control.write(path, journal)
        operation['daemon_pending'] = False
        operation['receipt'].update(state='succeeded', failure_kind=KIND)
    return journal


def _same_retained(before, after):
    require({k: v for k, v in before.items() if k != 'process_receipt_sha256'} ==
            {k: v for k, v in after.items() if k != 'process_receipt_sha256'}, 'retained evidence/store changed across stop')


PREPARED_JOURNAL_SCHEMA = 'fullmag.stop-failed-unclaimed-prepared.v1'
PREPARED_QUARANTINE_SCHEMA = 'fullmag.docker-prepared-unclaimed-quarantine.v1'
PREPARED_QUARANTINE = 'prepared-unclaimed/current.json'


def _prepared_sources():
    """Pin the recovery producer separately from the installed application."""
    names = ('docker_volume_linux_supervision_stop.py', 'docker_volume_activation_reconcile.py',
             'docker_volume_stop_failed.py')
    return {name: sha(read(Path(__file__).resolve().parent / name)) for name in names}


def _prepared_plan(scope, observation, receipt_raw, helper_id, service_pins):
    require(observation.get('schema') == PREPARED_SCHEMA, 'legacy observation cannot authorize prepared stop')
    plan = {'schema': 'fullmag.docker-prepared-unclaimed-stop-plan.v1', 'scope': scope,
            'observation': observation, 'activation_receipt_sha256': sha(receipt_raw),
            'helper_id': helper_id, 'service_pins': service_pins, 'helper_sources': _prepared_sources(),
            'signal_policy': 'one-SIGTERM-per-service-no-escalation',
            'next_state': 'shutdown_unknown/cancellation-required'}
    return dict(plan, plan_sha256=sha(canonical(plan)))


def _validate_prepared_journal(journal):
    require(journal.get('schema') == PREPARED_JOURNAL_SCHEMA and journal.get('failure_kind') == PREPARED_KIND,
            'not a prepared-unclaimed journal')
    plan = journal.get('plan', {})
    require(plan.get('schema') == 'fullmag.docker-prepared-unclaimed-stop-plan.v1'
            and plan.get('plan_sha256') == sha(canonical({k: v for k, v in plan.items() if k != 'plan_sha256'})),
            'prepared plan CAS differs')
    initial = {'schema': PREPARED_JOURNAL_SCHEMA, 'failure_kind': PREPARED_KIND, 'plan': plan, 'state': 'prepared'}
    require(journal.get('intent_sha256') == sha(canonical(initial)), 'prepared durable intent CAS differs')


def _prepared_signal_once(control, path, journal, raw, barrier):
    from docker_build_control import docker_capture, ControlOutcomeUnknown
    from docker_volume_cancelled_activation import _publish_cas
    require(journal.get('state') == 'prepared', 'signal intent already exists; resume only observes')
    barrier()
    issued = dict(journal, state='signal-intent')
    issued_raw = _publish_cas(control, path, issued, expected_raw=raw)
    # Persist intent before the first signal. A lost acknowledgement can never
    # cause a second signal, including when the first command did not execute.
    for service in ('backend', 'frontend'):
        result = docker_capture('kill', '--signal=TERM', journal['plan']['scope'][service + '_container_id'],
                                timeout=30, allow_failure=True)
        if result.returncode:
            raise ControlOutcomeUnknown('Prepared stop signal outcome is unknown; retained intent forbids replay')
    return issued, issued_raw


def _prepared_finish_readback(control, journal, journal_raw):
    from docker_volume_activate import _wait_retirement_lease_release
    from docker_build_control import ControlOutcomeUnknown
    scope = journal['plan']['scope']
    quarantine = control.read(PREPARED_QUARANTINE)
    require(quarantine.get('schema') == PREPARED_QUARANTINE_SCHEMA
            and quarantine.get('state') == 'cancellation-required'
            and quarantine.get('stop_journal_sha256') == sha(journal_raw)
            and quarantine.get('scope') == scope, 'prepared quarantine readback differs')
    terminal = control.read('activation/attempts/' + scope['activation_attempt'] + '/terminal.json')
    require(terminal.get('prepared_unclaimed_quarantine_sha256') == sha(canonical(quarantine) + b'\n')
            and terminal.get('activation_state') == 'failed-unclaimed-prepared-quarantined'
            and terminal.get('restart_policy') == 'cancellation-required'
            and terminal.get('state') == 'failed-confirmed', 'original technical terminal differs')
    if not _wait_retirement_lease_release(control, operation_id=scope['activation_attempt']):
        raise ControlOutcomeUnknown('Technical terminal exists but original activation helper has not released its lease')
    require(control.read('activation/current.json') == terminal, 'original activation current differs')
    return {'schema': PREPARED_JOURNAL_SCHEMA, 'state': 'stopped-quarantined',
            'journal_sha256': sha(journal_raw), 'quarantine_sha256': sha(canonical(quarantine) + b'\n'),
            'activation_lease_released': True, 'restart_policy': 'cancellation-required',
            'native_task_cancelled': False, 'healthy_drain': False}


def stop_prepared(args, selected, identity, actual):
    """Explicit diagnostic stop; the original activation helper releases itself.

    This operation grants no native cancellation, native lease release, API
    restart or fresh-state permission. Those require their own typed proofs.
    """
    import time
    from docker_build_control import BuildControl, toolchain_configuration, docker_capture, ControlOutcomeUnknown
    from docker_volume_dev import _validate_retained_service, _assert_private_restart_network, _retained_certificate
    from docker_volume_reconcile import fingerprint
    from docker_volume_activation_reconcile import (_validate_activation_receipt, _validate_helper, _validate_helper_logged,
                                                   retained_activation_observer)
    from docker_volume_cancelled_activation import _publish_cas
    require(re.fullmatch('[0-9a-f]{32}', args.activation_attempt or ''), 'original activation attempt is required')
    target_raw = read(Path(args.prepared_target).resolve(strict=True))
    require(sha(target_raw) == args.prepared_target_sha256, 'explicit prepared target CAS differs')
    target = decode(target_raw)
    config = toolchain_configuration(selected, identity)
    control = BuildControl(identity, config['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    previous = control.read('development/current.json')
    attempt = previous.get('attempt', '')
    require(re.fullmatch('[0-9a-f]{32}', attempt) and previous.get('state') == 'succeeded'
            and previous.get('compose_project') == control.project
            and previous.get('backend_container') == args.container_id
            and previous.get('inputs', {}).get('source_root') == str(selected), 'development authority differs')
    base = 'development/attempts/' + attempt
    document = control.read(base + '/compose.json')
    config_sha = sha(canonical(document))
    require(control.read(base + '/terminal.json') == previous and control.read('development/verified.json') == previous
            and previous.get('config_sha256') == config_sha and document.get('name') == control.project,
            'development terminal/verified/Compose differs')
    scope = {'compose_project': control.project, 'control_volume': control.volume,
             'control_namespace': control.namespace, 'namespace_registry_sha256': control.namespace_registry_sha256,
             'source_root': str(selected), 'development_attempt': attempt, 'compose_config_sha256': config_sha,
             'state_root': previous['state_root'],
             'backend_container_id': args.container_id, 'frontend_container_id': previous.get('frontend_container'),
             'image_id': args.image_id, 'activation_attempt': args.activation_attempt,
             'prepared_target_sha256': sha(target_raw)}
    path = 'verification/stop-failed-' + args.container_id + '.json'
    saved_raw = control.read_bytes(path, optional=True)
    saved = decode(saved_raw) if saved_raw else None
    if saved is not None:
        _validate_prepared_journal(saved)
        require(saved.get('schema') == PREPARED_JOURNAL_SCHEMA and saved.get('plan', {}).get('scope') == scope,
                'prepared stop journal scope differs')
        require(args.apply and args.expected_plan_sha256 == saved['plan']['plan_sha256']
                and args.continue_intent_sha256 == saved['intent_sha256'], 'resume requires exact plan and intent digests')
        require(saved['plan']['helper_sources'] == _prepared_sources(), 'recovery helper sources changed during resume')
        require(args.process_receipt_sha256 == saved['plan']['observation']['process_receipt_sha256'],
                'continuation changed the original process receipt pin')
        if saved.get('state') == 'stopped-quarantined' and control.read(
                'activation/attempts/' + args.activation_attempt + '/terminal.json', optional=True) is not None:
            return _prepared_finish_readback(control, saved, saved_raw)
    else:
        require(not args.continue_intent_sha256, 'continuation intent has no journal')
    receipt_raw = control.read_bytes('activation/attempts/' + args.activation_attempt + '/receipt.json')
    receipt, _, inputs = _validate_activation_receipt(
        control, activation_attempt=args.activation_attempt, development_attempt=attempt,
        config_sha256=config_sha, source_root=str(selected), image_id=args.image_id,
        backend_id=args.container_id, receipt_raw=receipt_raw)
    require(inputs['request_id'] == target.get('request_id') and inputs['source_sha256'] == target.get('source_sha256'),
            'original activation does not own the selected startup request')
    _, helper_id = _validate_helper(control, receipt['helper_container'], args.activation_attempt)
    _validate_helper_logged(helper_id)
    require(control.read_bytes('active').strip() == args.activation_attempt.encode()
            and control.read_bytes('activation/attempts/' + args.activation_attempt + '/terminal.json', optional=True) is None,
            'original activation helper no longer owns the exact unterminated lease')
    initial = saved['plan']['service_pins'] if saved else {}
    def services(require_stopped=False):
        pair = {}
        for name in ('backend', 'frontend'):
            identifier = scope[name + '_container_id']
            rows = json.loads(docker_capture('inspect', identifier, timeout=60).stdout)
            require(isinstance(rows, list) and len(rows) == 1, 'service inspection is ambiguous')
            row = rows[0]
            image = json.loads(docker_capture('image', 'inspect', document['services'][name]['image'], timeout=60).stdout)[0]
            require(row.get('Id') == identifier and row.get('Image') == document['services'][name]['image'], 'service image/ID differs')
            _validate_retained_service(document, row, name, image['Config'])
            pin = [row['State']['StartedAt'], fingerprint(row)]
            if initial:
                require(list(initial[name]) == pin, 'service incarnation changed')
            if require_stopped:
                require(row['State'].get('Running') is False and row['State'].get('Pid') == 0
                        and row['State'].get('OOMKilled') is False and type(row['State'].get('ExitCode')) is int,
                        'service is not authoritatively stopped')
            pair[name] = row
        _assert_private_restart_network(pair, {k: v['Id'] for k, v in pair.items()}, control.project)
        _retained_certificate(Path(previous['state_root']), document)
        from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
        allowed = {row['Id'] for row in pair.values()} | {helper_id}
        require(_project_container_ids(control.project) == allowed
                and _volume_consumer_ids(control.volume) == allowed,
                'prepared group/control volume has a foreign or unknown consumer')
        return pair
    def collect():
        require(control.read('development/current.json') == previous
                and control.read('development/verified.json') == previous
                and control.read(base + '/terminal.json') == previous
                and control.read(base + '/compose.json') == document, 'development authority changed')
        pair = services()
        require(pair['backend']['State']['StartedAt'] == actual['State']['StartedAt']
                and fingerprint(pair['backend']) == fingerprint(actual), 'initial backend incarnation changed')
        require(all(row['State'].get('Running') is True for row in pair.values()), 'prepared preview requires exact running pair')
        require(pair['backend']['Image'] == args.image_id, 'backend image differs')
        observation = _probe(control, pair['backend'], args.image_id, prepared_target=target)
        require(observation['process_receipt_sha256'] == args.process_receipt_sha256, 'pinned process receipt differs')
        pins = {k: [v['State']['StartedAt'], fingerprint(v)] for k, v in pair.items()}
        return _prepared_plan(scope, observation, receipt_raw, helper_id, pins)
    if saved is None:
        plan = collect()
        if not args.apply:
            return plan
        require(args.expected_plan_sha256 == plan['plan_sha256'], 'reviewed prepared stop plan changed')
        initial = plan['service_pins']
    else:
        plan = saved['plan']
        require(helper_id == plan['helper_id'] and sha(receipt_raw) == plan['activation_receipt_sha256'],
                'original activation helper/receipt changed')
    with retained_activation_observer(control, args.activation_attempt, receipt_raw) as (retained, owned_helper, check):
        require(owned_helper == plan['helper_id'], 'observer has another original helper incarnation')
        if saved is None:
            intent = {'schema': PREPARED_JOURNAL_SCHEMA, 'failure_kind': PREPARED_KIND,
                      'plan': plan, 'state': 'prepared'}
            intent['intent_sha256'] = sha(canonical(intent))
            journal = intent
            raw = _publish_cas(retained, path, journal, expected_raw=None)
        else:
            journal, raw = saved, saved_raw
        if journal['state'] == 'prepared':
            # Preserve the exact unknown receipt; never rewrite its outcome.
            _publish_cas(retained, 'prepared-unclaimed/' + args.activation_attempt + '/original-receipt.json',
                         receipt, expected_raw=None)
            import base64
            originals = {'activation-receipt': receipt_raw}
            for name, relative in (
                    ('process', 'runtime-control/runtime-service/process-tree.json'),
                    ('owner', 'runtime-control/runtime-services/OWNER.json'),
                    ('config', 'runtime-control/runtime-service/docker-all.json')):
                originals[name] = retained.read_bytes(relative)
            observation = plan['observation']
            require(sha(originals['process']) == observation['process_receipt_sha256']
                    and sha(originals['owner']) == observation['owner_sha256']
                    and sha(originals['config']) == observation['config_raw_sha256'],
                    'raw native sidecars differ from the reviewed observation')
            sidecars = {name: {'sha256': sha(value), 'raw_b64': base64.b64encode(value).decode('ascii')}
                        for name, value in originals.items()}
            _publish_cas(retained, 'prepared-unclaimed/' + args.activation_attempt + '/original-records.json',
                         {'schema': 'fullmag.docker-prepared-unclaimed-original-records.v1', 'records': sidecars},
                         expected_raw=None)
        if journal['state'] == 'prepared':
            def barrier():
                check()
                require(collect() == plan, 'final prepared stop barrier changed')
            journal, raw = _prepared_signal_once(retained, path, journal, raw, barrier)
        require(journal['state'] in {'signal-intent', 'stopped-quarantined'}, 'unknown prepared stop phase')
        if journal['state'] == 'signal-intent':
            deadline = time.monotonic() + 120
            while True:
                check()
                pair = services()
                if all(row['State'].get('Running') is False for row in pair.values()):
                    break
                if time.monotonic() >= deadline:
                    raise ControlOutcomeUnknown('Prepared stop is unconfirmed; intent retained without signal replay')
                time.sleep(0.5)
            pair = services(require_stopped=True)
            after = _probe(control, pair['backend'], args.image_id, stopped=True, prepared_target=target)
            _same_retained(plan['observation'], after)
            journal = dict(journal, state='stopped-quarantined', terminal_observation=after,
                           namespace_processes_absent=True, restart_policy='cancellation-required')
            raw = _publish_cas(retained, path, journal, expected_raw=raw)
        check()
        quarantine = {'schema': PREPARED_QUARANTINE_SCHEMA, 'state': 'cancellation-required', 'scope': scope,
                      'stop_journal_path': path, 'stop_journal_sha256': sha(raw),
                      'intent_sha256': journal['intent_sha256'], 'target': target}
        quarantine_raw = _publish_cas(retained, PREPARED_QUARANTINE, quarantine, expected_raw=None)
        terminal = dict(receipt, state='failed-confirmed', activation_state='failed-unclaimed-prepared-quarantined',
                        execution_state='not-started', restart_policy='cancellation-required', healthy_drain=False,
                        prepared_unclaimed_quarantine_sha256=sha(quarantine_raw))
        current_raw = retained.read_bytes('activation/current.json', optional=True)
        technical_raw = canonical(terminal) + b'\n'
        if current_raw is not None and current_raw != technical_raw:
            current = decode(current_raw)
            require(current.get('phase') == 'activation' and current.get('state') in {'succeeded', 'failed-confirmed'}
                    and retained.read_bytes('activation/attempts/' + current['attempt'] + '/terminal.json') == current_raw,
                    'activation current predecessor is not an immutable terminal')
            _publish_cas(retained, 'prepared-unclaimed/' + args.activation_attempt + '/previous-current.json', current, expected_raw=None)
        _publish_cas(retained, 'activation/current.json', terminal, expected_raw=current_raw)
        check()
        # Terminal is published last. Only the original helper sees it and
        # releases its own operation.lock/active; this producer never does so.
        _publish_cas(retained, 'activation/attempts/' + args.activation_attempt + '/terminal.json', terminal, expected_raw=None)
    return _prepared_finish_readback(control, journal, raw)


def prepared_quarantine_context(control, previous, document, actual, *, expected_sha256, allowed_active=None):
    """Authenticate the stopped exception only for native cancellation maintenance."""
    raw = control.read_bytes(PREPARED_QUARANTINE, optional=True)
    if raw is None:
        require(not expected_sha256, 'requested prepared quarantine is absent')
        return None
    record = decode(raw)
    require(record.get('schema') == PREPARED_QUARANTINE_SCHEMA
            and record.get('state') == 'cancellation-required' and sha(raw) == expected_sha256,
            'exact cancellation-required quarantine digest must be explicitly selected')
    scope = record.get('scope', {})
    require(scope.get('compose_project') == control.project and scope.get('control_volume') == control.volume
            and scope.get('control_namespace') == control.namespace
            and scope.get('namespace_registry_sha256') == control.namespace_registry_sha256
            and scope.get('development_attempt') == previous.get('attempt')
            and scope.get('source_root') == previous.get('inputs', {}).get('source_root')
            and scope.get('image_id') == previous.get('inputs', {}).get('image_id')
            and scope.get('compose_config_sha256') == sha(canonical(document)), 'prepared quarantine scope differs')
    journal_raw = control.read_bytes(record['stop_journal_path'])
    journal = decode(journal_raw)
    _validate_prepared_journal(journal)
    require(sha(journal_raw) == record.get('stop_journal_sha256')
            and journal.get('state') == 'stopped-quarantined' and journal['plan']['scope'] == scope
            and journal.get('intent_sha256') == record.get('intent_sha256')
            and journal.get('namespace_processes_absent') is True, 'prepared stopped journal differs')
    receipt_raw = control.read_bytes('activation/attempts/' + scope['activation_attempt'] + '/receipt.json')
    terminal = control.read('activation/attempts/' + scope['activation_attempt'] + '/terminal.json')
    require(sha(receipt_raw) == journal['plan']['activation_receipt_sha256']
            and terminal.get('prepared_unclaimed_quarantine_sha256') == sha(raw)
            and terminal.get('activation_state') == 'failed-unclaimed-prepared-quarantined'
            and terminal.get('state') == 'failed-confirmed' and terminal.get('restart_policy') == 'cancellation-required',
            'original helper has no exact technical terminal')
    active = control.read_bytes('active', optional=True)
    require(active is None or (allowed_active is not None and active.strip() == allowed_active.encode()),
            'original activation lease is not released or another operation is active')
    from docker_volume_reconcile import fingerprint
    for service in ('backend', 'frontend'):
        row = actual[service]
        require(row.get('Id') == scope[service + '_container_id']
                and [row['State']['StartedAt'], fingerprint(row)] == list(journal['plan']['service_pins'][service])
                and row['State'].get('Running') is False and row['State'].get('Pid') == 0
                and row['State'].get('OOMKilled') is False, 'prepared stopped service incarnation differs')
    after = _probe(control, actual['backend'], scope['image_id'], stopped=True, prepared_target=record['target'])
    require(after == journal['terminal_observation'], 'prepared terminal store/native evidence changed')
    return {'schema': PREPARED_QUARANTINE_SCHEMA, 'quarantine_sha256': sha(raw),
            'stop_journal_sha256': sha(journal_raw), 'target': record['target'],
            'backend_budget': {key: actual['backend']['HostConfig'].get(key) for key in ('Memory', 'NanoCpus', 'MemorySwap')},
            'retained_native_contracts': list(__import__('docker_volume_dev')._retained_native_contracts(previous, document)),
            'retained_include_untracked': __import__('docker_volume_dev').include_untracked_from_compose(document)}


def assert_prepared_start_allowed(control, request_id=None, *, reuse_state=None):
    record = control.read(PREPARED_QUARANTINE, optional=True)
    if record is None:
        return
    require(record.get('schema') == PREPARED_QUARANTINE_SCHEMA, 'unknown prepared quarantine version')
    require(request_id is None or request_id != record.get('target', {}).get('request_id'),
            'original prepared startup request is permanently retired and cannot be replayed')
    if reuse_state is not None:
        old_state = record.get('scope', {}).get('state_root')
        require(isinstance(old_state, str) and str(Path(reuse_state.get('state', '')).resolve()) != str(Path(old_state).resolve()),
                'original prepared state is permanently retired and cannot be resumed')
    archive = record.get('fresh_archive', {})
    require(record.get('state') == 'archived' and isinstance(archive.get('path'), str)
            and re.fullmatch('recreate-services/attempts/[0-9a-f]{32}/runtime-control-archive-terminal.json', archive['path']),
            'prepared quarantine requires genuine cancellation and qualified fresh archive before API/start')
    raw = control.read_bytes(archive['path'])
    terminal = decode(raw)
    require(sha(raw) == archive.get('sha256') and terminal.get('state') == 'succeeded'
            and terminal.get('compose_project') == control.project,
            'prepared quarantine has no authentic completed fresh archive')


def assert_prepared_maintenance_allowed(control, operation, maintenance):
    raw = control.read_bytes(PREPARED_QUARANTINE, optional=True)
    if raw is None:
        return
    record = decode(raw)
    witness = (operation or {}).get('receipt', {}).get('inputs', {}).get('prepared_unclaimed_quarantine', {})
    require(record.get('schema') == PREPARED_QUARANTINE_SCHEMA and record.get('state') == 'cancellation-required'
            and witness.get('quarantine_sha256') == sha(raw) and witness.get('target') == record.get('target'),
            'maintenance has no exact qualified prepared quarantine admission')
    request_raw = control.read_bytes(maintenance['request_path'])
    request = decode(request_raw)
    require(sha(request_raw) == maintenance.get('request_sha256')
            and request.get('run_id') == record['target']['run_id']
            and request.get('task_id') == record['target']['task_id'], 'maintenance request differs from prepared quarantine task')


def require_prepared_fresh_archive(control, args, previous, document, actual=None, *, recreate_services):
    """Admit the existing fresh archive only after a genuine native Cancelled result."""
    raw = control.read_bytes(PREPARED_QUARANTINE, optional=True)
    if raw is None:
        return None
    record = decode(raw)
    if record.get('state') == 'archived':
        assert_prepared_start_allowed(control)
        return None
    require(record.get('schema') == PREPARED_QUARANTINE_SCHEMA and record.get('state') == 'cancellation-required'
            and getattr(args, 'prepared_quarantine_sha256', None) == sha(raw), 'fresh archive requires explicit prepared quarantine digest')
    require(recreate_services and getattr(args, 'fresh_state', False) is True
            and getattr(args, 'script', None) is None, 'prepared quarantine permits only explicit fresh archive after cancellation')
    import docker_volume_cancelled_recovery as recovery
    attempt = previous.get('attempt')
    terminal_raw = control.read_bytes('development/attempts/' + attempt + '/terminal.json')
    require(decode(terminal_raw) == previous, 'current cancellation terminal differs')
    (result, _, _, request, _, before, _, compose, _) = recovery._validate_operation(
        control, attempt, terminal_raw, previous, sha(terminal_raw), Path(args.source_root).resolve(strict=True))
    witness = before.get('prepared_unclaimed_quarantine')
    require(isinstance(witness, dict) and witness.get('quarantine_sha256') == sha(raw)
            and witness.get('target') == record.get('target')
            and request.get('run_id') == record['target']['run_id']
            and request.get('task_id') == record['target']['task_id'], 'native cancellation does not consume this prepared quarantine')
    state = Path(previous['state_root'])
    pins = recovery._retained_run_pins(state, request, result['native_result'])
    if actual is None:
        from docker_build_control import docker_capture
        actual = {name: json.loads(docker_capture('inspect', previous[name + '_container'], timeout=60).stdout)[0]
                  for name in ('backend', 'frontend')}
    require(all(row['State'].get('Running') is False and row['State'].get('Pid') == 0 for row in actual.values()),
            'fresh archive requires the stopped maintenance pair')
    import docker_volume_container_recovery as native_recovery
    snapshot = native_recovery._ledger_and_store_snapshot(
        control, actual['backend'], compose=compose, retained_terminal_runs=pins)
    require(snapshot.get('run_records') == pins, 'fresh archive retained store snapshot differs')
    return {'schema': 'fullmag.docker-prepared-cancelled-fresh-admission.v1',
            'quarantine_sha256': sha(raw), 'cancellation_terminal_sha256': sha(terminal_raw),
            'store_snapshot_sha256': sha(canonical(snapshot)), 'constraints': witness}


def validate_prepared_render(document, constraints):
    """Reject resource or native/source gate drift before Compose starts."""
    if constraints is None:
        return
    from decimal import Decimal
    from docker_volume_dev import _native_contracts, include_untracked_from_compose
    backend = document['services']['backend']
    budget = constraints['backend_budget']
    require(str(backend.get('mem_limit')) == str(budget['Memory'])
            and Decimal(str(backend.get('cpus'))) * 10**9 == budget['NanoCpus']
            and str(backend.get('memswap_limit', 0)) == str(budget['MemorySwap']), 'prepared recovery changed backend resource budget')
    command = backend.get('command', [])
    contracts = [command[i + 1] for i, part in enumerate(command) if part == '--native-contract' and i + 1 < len(command)]
    require(list(_native_contracts(contracts)) == constraints['retained_native_contracts'], 'prepared recovery changed native contract gates')
    require(include_untracked_from_compose(document) == constraints['retained_include_untracked'], 'prepared recovery changed untracked source allowlist')


def pin_prepared_fresh_archive(control, operation, witness):
    if witness is None:
        return
    from docker_volume_cancelled_activation import _publish_cas
    raw = control.read_bytes(PREPARED_QUARANTINE)
    record = decode(raw)
    path = operation['root'] + '/runtime-control-archive-terminal.json'
    archive_raw = control.read_bytes(path)
    archive = decode(archive_raw)
    require(archive.get('state') == 'succeeded' and archive.get('compose_project') == control.project
            and archive.get('operation_attempt') == operation['receipt']['attempt'], 'qualified fresh archive is incomplete')
    if record.get('state') == 'archived':
        require(record.get('cancellation_admission') == witness
                and record.get('fresh_archive') == {'path': path, 'sha256': sha(archive_raw)},
                'prepared archive continuation belongs to another completed generation')
        assert_prepared_start_allowed(control)
        return
    require(sha(raw) == witness['quarantine_sha256'], 'prepared quarantine changed before archive publication')
    updated = dict(record, state='archived', fresh_archive={'path': path, 'sha256': sha(archive_raw)},
                   cancellation_admission=witness)
    _publish_cas(control, PREPARED_QUARANTINE, updated, expected_raw=raw)


def retained_context(control, previous, journal, journal_raw, backend_id, fresh_state, *, removed_container_proof=None):
    from docker_build_control import docker_capture
    from docker_volume_reconcile import fingerprint
    from docker_volume_dev import _assert_private_restart_network, _retained_certificate
    require(not fresh_state and removed_container_proof is None, 'requires exact stopped retained namespace')
    require(journal.get('failure_kind') == KIND and journal.get('state') == 'stopped-confirmed'
            and journal.get('schema') == 'fullmag.stop-failed-admission.v1' and journal.get('container_id') == backend_id
            and journal.get('image_id') == previous.get('inputs', {}).get('image_id')
            and journal.get('source_root') == previous.get('inputs', {}).get('source_root')
            and journal.get('development_attempt') == previous.get('attempt')
            and journal.get('compose_config_sha256') == previous.get('config_sha256')
            and journal.get('namespace_processes_absent') is True, 'stopped Linux supervision scope differs')
    require(control.read('development/current.json') == previous and control.read('development/verified.json') == previous,
            'retained development authority changed')
    services = {}
    for service, identifier in (('backend', backend_id), ('frontend', previous.get('frontend_container'))):
        observed = json.loads(docker_capture('inspect', identifier).stdout)[0]
        pin = journal['service_pins'][service]
        require(observed.get('Id') == identifier and observed['State'].get('Running') is False
                and observed['State'].get('Pid') == 0 and observed['State'].get('OOMKilled') is False
                and [observed['State']['StartedAt'], fingerprint(observed)] == list(pin), 'stopped service pin changed')
        services[service] = observed
        if service == 'backend':
            actual = observed
    base = 'development/attempts/' + previous['attempt']
    document = control.read(base + '/compose.json')
    require(control.read(base + '/terminal.json') == previous
            and sha(canonical(document)) == previous.get('config_sha256'), 'retained terminal/Compose changed')
    _assert_private_restart_network(services, {name: item['Id'] for name, item in services.items()}, control.project)
    _retained_certificate(Path(previous['state_root']), document)
    after = _probe(control, actual, journal['image_id'], stopped=True)
    _same_retained(journal['supervision_probe'], after)
    require(after['process_receipt_sha256'] == journal['terminal_process_receipt_sha256']
            and after['config_raw_sha256'] == journal['previous_config_sha256'], 'terminal process/config evidence changed')
    require(cancellation(control, journal['scope'], after,
                         original_process_sha256=journal['supervision_probe']['process_receipt_sha256']) == journal['cancellation'],
            'retained cancellation proof changed')
    return LinuxSupervisionContext(previous_config_sha256=after['config_raw_sha256'], native_restart_metadata={
        'schema': 'fullmag.docker-native-failed-stop-recreate.v1', 'failure_kind': KIND,
        'journal_sha256': sha(journal_raw), 'container_id': backend_id, 'image_id': journal['image_id'],
        'terminal_failed_owner_sha256': after['owner_sha256'], 'terminal_process_receipt_sha256': after['process_receipt_sha256'],
        'previous_config_sha256': after['config_raw_sha256'], 'claim_pending': False})
