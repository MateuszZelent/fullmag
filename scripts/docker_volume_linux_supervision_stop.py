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


def binary_sha(path):
    """Hash an installed ELF without loading it into a 64 MiB helper."""
    fd = open_existing(path, os.O_RDONLY)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode)
                and 0 < before.st_size <= 512 * 1024 * 1024, 'native binary is unbounded/nonregular')
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


def tree(root):
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


def observe_store(store, ledger, store_id):
    """Caller holds OWNER, ledger writer and store writer locks."""
    store, ledger = Path(store), Path(ledger)
    for name in ('temp', 'recovery'):
        fd = open_existing(store / name, os.O_RDONLY | os.O_DIRECTORY)
        try:
            require(not os.listdir(fd), 'pending transactions exist')
        finally:
            os.close(fd)
    inventory = tree(store / 'runs')
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
            raw = read(store / 'objects/sha256' / digest)
            require(sha(raw) == digest, 'immutable run CAS object differs')
            cas[digest] = sha(raw)
        require(all(isinstance(t, dict) for t in tasks), 'invalid task record')
        catalogs[run_id] = tasks
        terminal_task = lambda t: t.get('lifecycle') in {'succeeded', 'failed', 'cancelled', 'interrupted'}
        if all(terminal_task(t) for t in tasks):
            terminal.append(run_id)
        else:
            policy = intent.get('specification', {}).get('parameters', {}).get('fullmag.accepted_run_start')
            require(policy == {'schema_version': 'accepted_run_start_policy.v1', 'mode': 'manual'}
                    and not os.path.lexists(root / 'start_release.json'), 'nonterminal run is not held manual')
            for task in tasks:
                require(task.get('lifecycle') in {'accepted', 'queued'}
                        and all(task.get(k) is None for k in ('attempt_id', 'ownership_epoch', 'resource_id',
                            'coordinator_watermark', 'coordinator_genesis', 'resolved_input_fingerprint'))
                        and not task.get('artifact_ids'), 'held manual run acquired a claim')
            held.append(run_id)
            require(not any(relative.startswith(run_id + '/' + name + '/')
                            for relative in inventory['files'] for name in
                            ('worker-attempts', 'worker_process_exit_receipts', 'worker_inbox', 'coordinator_journal')),
                    'held manual run has worker execution evidence')
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
    return {'inventory': inventory, 'ledger_sha256': sha(ledger_raw), 'release_proofs': proofs,
            'terminal_runs': terminal, 'held_manual_runs': held, 'store_id': store_id,
            'reservations': rows, 'catalogs': catalogs, 'leases': leases, 'immutable_objects': cas}


def observe(state, control_root, ledger, image_id, *, stopped=False, proc_root='/proc',
            binary='/opt/fullmag/package/bin/fullmag-runtime-service'):
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
        store_proof = observe_store(store, ledger, 'sha256:' + sha(canonical(identity)))
        for path, fd in descriptors:
            require((os.fstat(fd).st_dev, os.fstat(fd).st_ino) ==
                    (path.stat().st_dev, path.stat().st_ino), 'lock inode changed')
        config_raw = read(control_root / 'runtime-service/docker-all.json')
        config = decode(config_raw)
        require(config.get('store_root') == str(store), 'native config selects another store')
        return {'schema': SCHEMA, 'process_receipt_sha256': sha(receipt_raw), 'owner_sha256': sha(owner_raw),
                'config_sha256': sha(canonical(config)), 'config_raw_sha256': sha(config_raw),
                'certificate_sha256': sha(cert_raw),
                'api_failure_fence_sha256': sha(fence_raw), 'ready_pin_sha256': sha(canonical(pin)),
                'api_pid': api_pid, 'store': store_proof, 'native_binary_sha256': binary_sha(binary)}


def _script(image_id, stopped):
    # This module is stdlib-only until the orchestration functions are called.
    source = Path(__file__).read_text()
    return source + '\nprint(json.dumps(observe("/state", "/opt/fullmag/runtime-control", "/host-ledger/ledger", ' + repr(image_id) + ', stopped=' + repr(stopped) + ')))\n'


def _probe(control, actual, image_id, *, stopped=False):
    from docker_build_control import docker_capture, bounded_capture
    if not stopped:
        result = docker_capture('exec', actual['Id'], '/usr/local/bin/python3', '-B', '-c', _script(image_id, False), timeout=90)
    else:
        import copy
        require(actual.get('Image') == image_id and re.fullmatch('sha256:[0-9a-f]{64}', image_id),
                'readonly probe requires the exact immutable backend image')
        script = '/usr/local/bin/python3 -B -c ' + shlex.quote(_script(image_id, True))
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
