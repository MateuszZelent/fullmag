"""Stop a cold policy-refused API, then restore this group's stored budget.

This is deliberately separate from terminal-observation and resource-increase
recovery. It neither changes the ledger nor grants native recovery authority.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import shlex
import time
from collections.abc import Mapping

import docker_volume_preowner_drained as base
from docker_build_control import BuildControl, BuildControlError, canonical, bounded_capture, docker_capture

VARIANT = 'cold-memory-increase-restore-stored-budget'
import docker_volume_resumed_budget_proof as resumed
VARIANTS = (VARIANT, resumed.VARIANT)
SCHEMA = 'fullmag.cold-stored-budget-stop.v1'
INTENT_SCHEMA = 'fullmag.cold-stored-budget-intent.v1'
PHASE = 'cold-stored-budget-stop'
GIB = base.GIB


class ColdBudgetRestoreContext(dict):
    """Authenticated stop witness; carries no permission to replay a Solve."""


def restore_budget(requested, stored, document):
    """Accept exactly one policy delta: requested native memory is larger."""
    base._require(isinstance(requested, dict) and isinstance(stored, dict), 'missing complete policy')
    base._require(set(stored) == {'schema_version', 'host_id', 'topology_sha256', 'revision', 'owner_epoch',
                                  'total_budget', 'gpu_vram_bytes_by_uuid', 'allowed_cpu_ids'}
                  and stored.get('schema_version') in {'host_resource_ledger_policy.v2', 'host_resource_ledger_policy.v3'}
                  and all(type(stored.get(key)) is int and stored[key] > 0 for key in ('revision', 'owner_epoch'))
                  and all(isinstance(stored.get(key), str) and base.SHA.fullmatch(stored[key])
                          for key in ('host_id', 'topology_sha256'))
                  and isinstance(stored.get('allowed_cpu_ids'), list)
                  and stored['allowed_cpu_ids'] and all(type(cpu) is int and cpu >= 0 for cpu in stored['allowed_cpu_ids'])
                  and len(set(stored['allowed_cpu_ids'])) == len(stored['allowed_cpu_ids'])
                  and isinstance(stored.get('gpu_vram_bytes_by_uuid'), dict), 'complete stored policy identity is malformed')
    old = stored.get('total_budget', {})
    new = requested.get('total_budget', {})
    base._require(set(old) == set(new) == {'cpu_millis', 'memory_bytes', 'storage_bytes', 'gpu_memory_bytes'}
                  and all(type(row.get(key)) is int and row[key] >= 0 for row in (old, new) for key in old),
                  'native policy budget is malformed')
    expected = copy.deepcopy(stored)
    expected['total_budget']['memory_bytes'] = new['memory_bytes']
    base._require(requested == expected and new['memory_bytes'] > old['memory_bytes'],
                  'refusal is not an exact memory-only increase')
    cpu, memory = old['cpu_millis'], old['memory_bytes'] + GIB
    base._require(cpu >= 2000 and cpu % 1000 == 0 and memory >= 4 * GIB and memory % GIB == 0,
                  'stored budget cannot map to integral DEV CPU/GiB limits')
    service = document.get('services', {}).get('backend', {})
    env = service.get('environment', {})
    base._require(service.get('mem_limit') == new['memory_bytes'] + GIB
                  and service.get('cpus') == new['cpu_millis'] / 1000
                  and env.get('FULLMAG_DOCKER_CPU_MILLIS') == str(new['cpu_millis'])
                  and env.get('FULLMAG_DOCKER_MEMORY_BYTES') == str(new['memory_bytes'] + GIB),
                  'failed Compose limits differ from the probed requested policy')
    return {'cpus': cpu // 1000, 'memory_bytes': memory}


def overlay_budget(document, budget):
    cpu, memory = budget.get('cpus'), budget.get('memory_bytes')
    base._require(type(cpu) is int and cpu >= 2 and type(memory) is int
                  and memory >= 4 * GIB and memory % GIB == 0, 'restore budget is invalid')
    backend = document['services']['backend']
    backend.update(cpus=cpu, mem_limit=memory)
    # An explicit existing swap ceiling must still cover the restored memory.
    swap = backend.get('memswap_limit')
    base._require(swap is None or swap == -1 or type(swap) is int and swap >= memory,
                  'restore budget exceeds the explicit swap ceiling')
    env = backend.setdefault('environment', {})
    env.update(CARGO_BUILD_JOBS=str(min(cpu, 64)), FULLMAG_DOCKER_CPU_MILLIS=str(cpu * 1000),
               FULLMAG_DOCKER_MEMORY_BYTES=str(memory))


def _ledger(control, document, backend, *, resumed_startup=False):
    from docker_volume_linux_supervision_stop import readonly_mount
    import docker_group_ledger as ledger
    expected = ledger.retained_profile(document, backend['Image'])
    mounts = [m for m in backend.get('Mounts', []) if m.get('Destination') == '/host-ledger']
    base._require(len(mounts) == 1 and mounts[0].get('Name') == expected['volume_name']
                  and mounts[0].get('Type') == 'volume', 'group ledger mount identity differs')
    script = base._LEDGER_PROBE.replace("'/ledger/ledger'", "'/host-ledger/ledger'").replace(
        "'total_budget':budget}", "'total_budget':budget,'policy':policy}")
    if resumed_startup:
        script = resumed.ledger_probe()
    args = base._python_helper_args(control, 'python3 -I -B -c ' + shlex.quote(script), backend['Image'])
    index = args.index('--entrypoint')
    args[index:index] = ['--mount', readonly_mount(backend, '/host-ledger')]
    result = bounded_capture(args, data=b'', timeout=45, maximum=1024 * 1024)
    base._require(result.returncode == 0, 'full stored policy could not be observed')
    full = base._json(result.stdout, 'full stored policy', maximum=1024 * 1024)
    base._require(full.get('schema') == 'fullmag.preowner-ledger-policy.v1'
                  and isinstance(full.get('policy'), dict) and isinstance(full.get('ledger_sha256'), str)
                  and base.SHA.fullmatch(full['ledger_sha256'])
                  and full.get('total_budget') == full['policy'].get('total_budget'), 'invalid stored policy observation')
    return full


def _cold(backend_id, document, ledger, *, startup=None):
    result = docker_capture('exec', backend_id, 'python3', '-I', '-B', '-c', base._COLD_PROBE, timeout=35)
    base._require(result.returncode == 0, 'cold diagnostic namespace probe failed')
    guest = base._json(result.stdout, 'cold diagnostic probe', maximum=base.MAX_PROBE_BYTES)
    rows = guest.get('processes')
    base._require(guest.get('schema') == 'fullmag.preowner-cold-api-probe.v1'
                  and isinstance(rows, list) and len(rows) == 3
                  and all(isinstance(row, list) and len(row) == 4 and all(type(x) is int for x in row[:3])
                          and isinstance(row[3], str) for row in rows)
                  and rows == sorted(rows) and len({row[0] for row in rows}) == 3
                  and guest.get('processes_sha256') == base._sha(json.dumps(rows, separators=(',', ':')).encode())
                  and guest.get('probe_present') is True and guest.get('health_status') == 200
                  and guest.get('health_state') == 'degraded' and guest.get('active_session') is False
                  and guest.get('current_status') == 503 and guest.get('current_owner_pids_absent') is True,
                  'not the exact cold diagnostic-only API namespace')
    base._require(all(isinstance(guest.get(key), str) and base.SHA.fullmatch(guest[key]) for key in (
        'processes_sha256', 'api_instance_sha256', 'failure_fence_sha256', 'owner_sha256',
        'process_tree_sha256', 'native_config_sha256')), 'cold API digest is invalid')
    if startup is not None:
        guest['limits_witness'] = resumed.limits_observation(backend_id, startup)
        budget = resumed.projected_budget(guest, ledger, document)
    else:
        budget = restore_budget(guest.get('requested_policy'), ledger['policy'], document)
    return guest, budget


# Independent terminal catalog check: released leases alone do not prove that
# every task is terminal. RUN_PINS separately covers all metadata hashes.
CATALOG_PROBE = r'''import json,pathlib,hashlib,os,stat
root=pathlib.Path('/state/runs/docker-all/session-store/runs'); result={}
if root.is_symlink() or not root.is_dir(): raise RuntimeError('unsafe runs root')
for run in sorted(root.iterdir()):
 if len(result)>=8192 or run.is_symlink() or not run.is_dir(): raise RuntimeError('unsafe run inventory')
 p=run/'run_catalog.json'; fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  a=os.fstat(stream.fileno())
  if not stat.S_ISREG(a.st_mode) or a.st_nlink!=1 or a.st_size>8388608: raise RuntimeError('unsafe catalog')
  raw=stream.read(8388609); b=os.fstat(stream.fileno()); c=p.stat(follow_symlinks=False)
  identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
  if len(raw)!=a.st_size or identity(a)!=identity(b) or identity(a)!=identity(c): raise RuntimeError('catalog changed')
 catalog=json.loads(raw); tasks=catalog.get('tasks')
 if catalog.get('run_id')!=run.name or not isinstance(tasks,list) or not tasks or not all(isinstance(t,dict) and t.get('lifecycle') in {'succeeded','failed','cancelled','interrupted'} for t in tasks): raise RuntimeError('nonterminal or unknown catalog')
 result[run.name]=hashlib.sha256(raw).hexdigest()
print(json.dumps(result,sort_keys=True))
'''


def _run_pins(control, backend):
    from docker_volume_stop_preowner_policy import RUN_PINS
    return _state_probe(control, backend, RUN_PINS, 'run metadata pins')


def _state_probe(control, backend, script, label):
    from docker_volume_linux_supervision_stop import readonly_mount
    args = base._python_helper_args(control, 'python3 -I -B -c ' + shlex.quote(script), backend['Image'])
    index = args.index('--entrypoint'); args[index:index] = ['--mount', readonly_mount(backend, '/state')]
    result = bounded_capture(args, data=b'', timeout=60, maximum=1024 * 1024)
    base._require(result.returncode == 0, label + ' check failed')
    return base._json(result.stdout, label)


def _catalogs(control, backend):
    return _state_probe(control, backend, CATALOG_PROBE, 'terminal run catalogs')


def _history(control, previous, iteration, fence, *, recreate_attempt=None):
    base._require(isinstance(iteration, str) and base.ATTEMPT.fullmatch(iteration), 'invalid historical drain attempt')
    root = 'iteration/attempts/' + iteration
    hashes = {}
    def record(relative, canonical_record=True):
        raw, value, digest = base._record(control, relative, canonical_record=canonical_record)
        hashes[relative] = digest
        return raw, value
    terminal_raw, terminal = record(root + '/terminal.json')
    receipt_raw, _ = record(root + '/receipt.json')
    _, compose = record(root + '/compose.json')
    _, drain = record(root + '/backend-drain.json')
    if recreate_attempt is None:
        base._require(terminal_raw == receipt_raw and terminal.get('schema') == 'fullmag.docker-build-operation.v1'
                      and terminal.get('state') == 'succeeded' and terminal.get('phase') == 'iteration'
                      and terminal.get('attempt') == iteration and terminal.get('idle_backend_stopped') is True
                      and terminal.get('compose_project') == control.project and terminal.get('control_volume') == control.volume
                      and terminal.get('inputs', {}).get('source_root') == previous.get('inputs', {}).get('source_root')
                      and terminal.get('state_root') == previous.get('state_root')
                      and terminal.get('config_sha256') == base._sha(canonical(compose))
                      and compose.get('name') == control.project
                      and compose['services']['backend'].get('image') == terminal.get('inputs', {}).get('image_id'),
                      'historical iteration is not the exact successful idle drain')
    else:
        base._require(terminal_raw == receipt_raw, 'historical rebuild receipt is not terminal')
        resumed.load_bridge(control, previous, terminal, compose, iteration=iteration,
                            recreate_attempt=recreate_attempt, record=record)
    process_raw, process = record('runtime-control/runtime-service/process-tree.json')
    _, owner = record('runtime-control/runtime-services/OWNER.json', False)
    _, config = record('runtime-control/runtime-service/docker-all.json')
    base._require(drain.get('schema') == 'fullmag.docker-idle-restart-drain.v1'
                  and drain.get('backend_container_id') == terminal.get('backend_container')
                  and process.get('schema') == 'fullmag.docker-process-tree.v1' and process.get('state') == 'drained'
                  and drain.get('process_receipt') == process
                  and drain.get('process_receipt_sha256') == base._sha(process_raw),
                  'historical native process receipt differs from immutable drain')
    from docker_volume_drained_successor import _validate_native_owners
    ready = process.get('service_owner', {}); terminal_owner = process.get('terminal_service_owner', {})
    try:
        native = _validate_native_owners(ready, owner)
        native._validate_terminal_owner(terminal_owner, state='drained', name='cold restore terminal owner')
    except Exception as error:
        raise BuildControlError('Cold restore native Drained owner authentication failed') from error
    base._require(native._owner_identity(ready) == native._owner_identity(terminal_owner)
                  and native._owner_child_identity(ready) == native._owner_child_identity(terminal_owner)
                  and native._owner_fingerprint(owner) == native._owner_fingerprint(terminal_owner)
                  and {c.get('role') for c in terminal_owner.get('children', [])} == {'compute', 'preparation'}
                  and all(c.get('status') == 'exited_success' for c in terminal_owner['children']),
                  'current OWNER is not the exact successfully Drained owner')
    token = ready.get('owner_token')
    base._require(isinstance(token, str) and base.OWNER_TOKEN.fullmatch(token), 'invalid Ready pin token')
    _, pin = record('runtime-control/runtime-services/docker-client-' + token + '.json')
    base._require(pin.get('state') == 'ready' and native._owner_fingerprint(pin) == native._owner_fingerprint(ready),
                  'historical Ready owner pin differs')
    base._require(config.get('schema_version') == 'runtime_service_config.v2', 'native config schema differs')
    old_env = compose['services']['backend'].get('environment', {})
    policy = config.get('host_execution', {}).get('policy', {})
    # Older host config may hold the policy in the native explicit ledger
    # configuration; authenticate its complete identity at collection below.
    for key in ('FULLMAG_DOCKER_CPU_MILLIS', 'FULLMAG_DOCKER_MEMORY_BYTES'):
        base._require(isinstance(old_env.get(key), str) and old_env[key].isdigit(), 'historical Compose budget missing')
    path = fence['failure_fence_relative']
    base._require(isinstance(path, str) and __import__('re').fullmatch(
        r'runtime-control/runtime-service/api-failure-[0-9a-f]{32}\.json', path), 'invalid failure fence path')
    raw, failure = record(path)
    base._require(base._sha(raw) == fence['failure_fence_sha256'] and failure.get('stage') == 'runtime_startup'
                  and failure.get('schema') == 'fullmag.api-runtime-failure-fence.v1'
                  and failure.get('reason') == fence['failure_reason'], 'failure fence changed')
    result = {'control_hashes': hashes, 'iteration': iteration, 'historical_budget_environment': {
        key: old_env[key] for key in ('FULLMAG_DOCKER_CPU_MILLIS', 'FULLMAG_DOCKER_MEMORY_BYTES')},
        'native_policy': policy, 'native_config_sha256': hashes['runtime-control/runtime-service/docker-all.json']}
    if recreate_attempt is not None:
        result['recreate_attempt'] = recreate_attempt
    return result


def _containers(control, identity, previous, document, backend_id, image_id, *, running):
    if running:
        return base._containers(control, identity, previous, document, backend_id, image_id, running=True)
    from docker_dev_up import _compose_container_id
    from docker_compose_identity import validate_source_labels
    from docker_volume_dev import _validate_retained_service
    ids = {name: _compose_container_id(document, name) for name in ('backend', 'frontend')}
    base._require(ids['backend'] == backend_id == previous['worker_cgroup']['container_id']
                  and previous.get('backend_container') in (None, backend_id)
                  and previous.get('frontend_container') in (None, ids['frontend']), 'retained service identity differs')
    actual = {name: base._inspect('container', identifier) for name, identifier in ids.items()}
    for name, row in actual.items():
        state = row.get('State', {}); expected_running = name == 'frontend'
        image = image_id if name == 'backend' else document['services'][name]['image']
        base._require(row.get('Image') == image and state.get('Running') is expected_running
                      and state.get('OOMKilled') is False
                      and state.get('Status') == ('running' if expected_running else 'exited'),
                      'backend stop or retained running frontend differs: ' + name)
        _validate_retained_service(document, row, name, base._inspect('image', image).get('Config', {}),
                                   expected_started_at=previous.get(name + '_started_at'))
        validate_source_labels(row, identity)
    return ids, actual


def _group_inventory(control, ids, helper_id=None):
    if helper_id is None:
        return base._assert_group_inventory(control, ids['backend'], ids['frontend'])
    expected = {ids['backend'], ids['frontend'], helper_id}
    base._require(base._project_container_ids(control.project) == expected
                  and base._volume_consumer_ids(control.volume) == expected, 'cold group inventory differs')


def _wait_backend_stop(backend_id, pin, *, timeout=60):
    deadline = time.monotonic() + timeout
    while True:
        actual = base._inspect('container', backend_id)
        base._require(base._container_pin(actual) == pin, 'backend incarnation changed while observing stop')
        if actual.get('State', {}).get('Running') is False:
            base._stopped_state(actual, pin)
            return actual
        base._require(time.monotonic() < deadline, 'SIGTERM outcome remains unconfirmed; preserve intent and observe only')
        time.sleep(.25)


def _collect(control, identity, selected, previous, document, layout, iteration, *, running, cold=None, removed_actual=None, helper_id=None, recovery=None):
    args = previous['inputs']
    startup = previous
    startup_hashes = None
    if recovery is not None:
        base._require(set(recovery) == {'resume_attempt', 'recreate_attempt'}, 'invalid resumed recovery pins')
        startup, startup_hashes, parent_raw, compose_raw = resumed.load_startup(
            control, previous, document, source_root=str(selected), resume_attempt=recovery['resume_attempt'])
    backend_id = startup['worker_cgroup']['container_id']
    base._require(document.get('services', {}).get('backend', {}).get('environment', {}).get(
        'FULLMAG_STARTUP_ENABLED') != '1', 'cold restore cannot retain startup Solve activation')
    if recovery is None:
        _, parent_raw, compose_raw, _ = base._load_parent(control, previous, document, selected=selected,
            attempt=previous['attempt'], config_sha256=previous['config_sha256'], image_id=args['image_id'],
            backend_container_id=backend_id, allow_legacy_root_namespace=True)
    if removed_actual is None:
        ids, actual = _containers(control, identity, startup, document, backend_id, args['image_id'], running=running)
        _group_inventory(control, ids, helper_id)
    else:
        # The recreate consumer has authenticated the immutable retained
        # snapshot and proved both exact app IDs absent. Never inspect an
        # unrelated successor as a substitute for that archived incarnation.
        base._require(running is False and set(removed_actual) == {'backend', 'frontend'},
                      'removed cold context requires the exact stopped snapshot')
        actual = removed_actual
        ids = {name: row['Id'] for name, row in actual.items()}
        base._require(ids['backend'] == backend_id, 'removed backend differs from parent')
        _removed_inventory(control)
    base._require(actual['backend']['State'].get('StartedAt') == startup.get('backend_started_at'),
                  'backend StartedAt differs from failed development')
    ledger = _ledger(control, document, actual['backend'], **({'resumed_startup': True} if recovery else {}))
    if running:
        cold, budget = _cold(backend_id, document, ledger, **({'startup': startup} if recovery else {}))
    else:
        base._require(isinstance(cold, dict), 'missing pinned cold observation')
        budget = (resumed.projected_budget(cold, ledger, document) if recovery else
                  restore_budget(cold.get('requested_policy'), ledger['policy'], document))
    base._require(startup.get('error') == 'Runtime startup failed; diagnostic API retained: ' + cold['failure_reason'].removesuffix('\n'),
                  'failed development differs from exact cold fence')
    history_args = {'recreate_attempt': recovery['recreate_attempt']} if recovery else {}
    history = _history(control, previous, iteration, cold, **history_args)
    hashes = history['control_hashes']
    base._require(all(cold[key] == hashes[path] for key, path in (
        ('native_config_sha256', 'runtime-control/runtime-service/docker-all.json'),
        ('owner_sha256', 'runtime-control/runtime-services/OWNER.json'),
        ('process_tree_sha256', 'runtime-control/runtime-service/process-tree.json'))), 'live cold native pins differ')
    old = history['historical_budget_environment']
    base._require(old['FULLMAG_DOCKER_CPU_MILLIS'] == str(budget['cpus'] * 1000)
                  and old['FULLMAG_DOCKER_MEMORY_BYTES'] == str(budget['memory_bytes']),
                  'restored limits differ from historical drained Compose budget')
    # The native config policy is validated independently of the rejected
    # request; full policy comparison includes epoch/topology/GPU placement.
    base._require(history['native_policy'] == ledger['policy'], 'native historical policy differs from stored ledger')
    released = base._released(control, actual['backend'])
    base._require(released.get('schema') == 'fullmag.pre-ack-released-observation.v1'
                  and released.get('active_count') == 0 and isinstance(released.get('reservations'), list)
                  and isinstance(released.get('leases'), list), 'released inventory is incomplete')
    result = {'parent_terminal_sha256': base._sha(parent_raw), 'compose_sha256': base._sha(compose_raw),
            'attempt': previous['attempt'], 'config_sha256': base._sha(canonical(document)), 'source_root': str(selected),
            'control_namespace': control.namespace, 'cold_api': cold, 'budget': budget, 'ledger': ledger,
            'history': history, 'released': released, 'run_pins': _run_pins(control, actual['backend']),
            'terminal_catalogs': _catalogs(control, actual['backend']),
            'owner_lock': base._owner_lock_identity(control, args['image_id']),
            'certificate': base._certificate(selected, layout, previous, document),
            'containers': {name: base._container_pin(row) for name, row in actual.items()}}
    base._require(_ledger(control, document, actual['backend'], **({'resumed_startup': True} if recovery else {})) == ledger
                  and _history(control, previous, iteration, cold, **history_args) == history,
                  'ledger or historical native evidence changed during collection')
    if recovery:
        fresh_startup, fresh_hashes, _, _ = resumed.load_startup(
            control, previous, document, source_root=str(selected), resume_attempt=recovery['resume_attempt'])
        base._require(fresh_startup == startup and fresh_hashes == startup_hashes,
                      'resume authority changed during collection')
        if running:
            base._require(_cold(backend_id, document, ledger, startup=startup) == (cold, budget),
                          'cold startup or cgroup limits changed during collection')
        result['resumed_authority'] = dict(recovery, control_hashes=startup_hashes)
    return result, actual


def _removed_inventory(control):
    operation = getattr(control, '_active_operation', None)
    helper = operation.get('helper_container_id') if isinstance(operation, Mapping) else None
    expected = set()
    if helper is not None:
        base._require(isinstance(helper, str) and base.CONTAINER.fullmatch(helper), 'invalid active helper')
        expected.add(helper)
    base._require(base._project_container_ids(control.project) == expected
                  and base._volume_consumer_ids(control.volume) == expected,
                  'removed cold group contains an unexpected consumer')


def _paths(backend_id):
    base._require(isinstance(backend_id, str) and base.CONTAINER.fullmatch(backend_id), 'invalid backend ID')
    root = 'verification/cold-stored-budget-stop-' + backend_id
    return root + '.json', root + '.intent.json'



def _recovery_args(args):
    variant = getattr(args, 'variant', VARIANT)
    base._require(variant in VARIANTS, 'unknown cold restore variant')
    pins = {key: getattr(args, key, None) for key in ('resume_attempt', 'recreate_attempt')}
    if variant == resumed.VARIANT:
        base._require(all(isinstance(v, str) and base.ATTEMPT.fullmatch(v) for v in pins.values()),
                      'resumed restore requires exact resume and recreate attempts')
        return pins
    base._require(not any(v is not None for v in pins.values()), 'resume pins are forbidden for legacy restore')
    return None


def _observed_recovery(observation, variant):
    authority = observation.get('resumed_authority')
    if variant == VARIANT:
        base._require(authority is None, 'legacy restore cannot carry resume authority')
        return None
    base._require(variant == resumed.VARIANT and isinstance(authority, dict)
                  and set(authority) == {'resume_attempt', 'recreate_attempt', 'control_hashes'},
                  'missing typed resume authority')
    pins = {key: authority[key] for key in ('resume_attempt', 'recreate_attempt')}
    base._require(all(isinstance(v, str) and base.ATTEMPT.fullmatch(v) for v in pins.values()),
                  'invalid journal resume/recreate pins')
    return pins


def _controller_sha(variant):
    if variant == VARIANT:
        return base._sha(Path(__file__).read_bytes())
    names = ('docker_volume_cold_budget_restore.py', 'docker_volume_resumed_budget_proof.py',
             'docker_volume_resumed_budget_projection.py', 'docker_volume_preowner_drained.py')
    return base._sha(canonical({name: base._sha(Path(__file__).with_name(name).read_bytes()) for name in names}))

def stop(args):
    recovery = _recovery_args(args)
    variant = resumed.VARIANT if recovery else VARIANT
    from docker_dev import _select_source, _compose_identity
    from docker_dev_host import require_host
    require_host()
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), Path(args.source_root))
    identity = _compose_identity(layout); control = BuildControl(identity, args.image_id)
    base._require(base.ATTEMPT.fullmatch(args.attempt) and base.SHA.fullmatch(args.config_sha256)
                  and base.IMAGE.fullmatch(args.image_id), 'invalid operator pins')
    journal_path, intent_path = _paths(args.backend_container_id)
    apply = bool(args.apply)
    if apply:
        base._require(isinstance(args.expected_plan_sha256, str) and base.SHA.fullmatch(args.expected_plan_sha256),
                      'apply requires exact reviewed preview SHA')
    if getattr(args, 'continue_intent_sha256', None) is not None:
        return _continue(control, identity, selected, layout, args, journal_path, intent_path)
    inputs = {key: getattr(args, key) for key in ('attempt', 'config_sha256', 'image_id', 'backend_container_id', 'drain_attempt')}
    inputs.update(source_root=str(selected), variant=variant, controller_sha256=_controller_sha(variant))
    if recovery:
        inputs.update(recovery)
    with control.operation(PHASE if apply else PHASE + '-preview', inputs) as operation:
        base._require(control.read_bytes(journal_path, optional=True) is None
                      and control.read_bytes(intent_path, optional=True) is None, 'stop already has intent/journal; no replay')
        root = 'development/attempts/' + args.attempt
        _, previous, _ = base._record(control, root + '/terminal.json', canonical_record=True)
        _, document, _ = base._record(control, root + '/compose.json', canonical_record=True)
        base._require((previous.get('config_sha256', base._sha(canonical(document))) if recovery else previous.get('config_sha256')) == args.config_sha256
                      and previous.get('inputs', {}).get('image_id') == args.image_id
                      and (previous.get('backend_container') if recovery else previous.get('worker_cgroup', {}).get('container_id')) == args.backend_container_id,
                      'operator pins differ from failed development')
        observation, before = _collect(control, identity, selected, previous, document, layout, args.drain_attempt, running=True, **({'recovery': recovery} if recovery else {}))
        plan = dict(schema=SCHEMA, variant=variant, observation=observation, controller_sha256=inputs['controller_sha256'])
        plan_sha = base._sha(canonical(plan)); control.write(operation['root'] + '/plan.json', plan)
        if not apply:
            result = {'state': 'preview-passed', 'plan_sha256': plan_sha}
            operation['receipt'].update(state='succeeded', result=result); print(json.dumps(result)); return result
        base._require(plan_sha == args.expected_plan_sha256, 'fresh plan differs from reviewed preview')
        intent = {'schema': INTENT_SCHEMA, 'state': 'stop-authorized', 'plan_sha256': plan_sha, 'plan': plan,
                  'operation': {'phase': PHASE, 'root': operation['root'], 'attempt': operation['receipt']['attempt']}}
        intent_sha = base._publish_immutable(control, intent_path, intent)
        operation['daemon_pending'] = True
        # Docker stop with a finite grace period escalates to SIGKILL. This
        # path sends exactly one SIGTERM and only observes afterwards.
        result = docker_capture('kill', '--signal', 'SIGTERM', before['backend']['Id'], timeout=15)
        base._require(result.returncode == 0, 'SIGTERM result is unknown; retain intent and observe only')
        _wait_backend_stop(before['backend']['Id'], observation['containers']['backend'])
        after_observation, after = _collect(control, identity, selected, previous, document, layout,
                                           args.drain_attempt, running=False, cold=observation['cold_api'], **({'recovery': recovery} if recovery else {}))
        base._require(after_observation == observation, 'inventory changed during cold stop')
        stopped = {'backend': base._stopped_state(after['backend'], observation['containers']['backend'])}
        journal = {'schema': SCHEMA, 'state': 'stopped-confirmed', 'variant': variant,
                   'intent_relative': intent_path, 'intent_sha256': intent_sha, 'plan_sha256': plan_sha,
                   'operation': intent['operation'], 'observation': observation, 'stopped': stopped,
                   'native_drain_performed': False, 'data_preserved': True}
        digest = base._publish_immutable(control, journal_path, journal)
        operation['daemon_pending'] = False
        result = {'state': 'stopped-confirmed', 'journal_relative': journal_path, 'journal_sha256': digest}
        operation['receipt'].update(state='succeeded', result=result); print(json.dumps(result)); return result


def authenticate_journal(control, metadata):
    """Validate immutable intent, terminal operation and budget on every use."""
    base._require(isinstance(metadata, dict) and set(metadata) == {'journal_relative', 'journal_sha256'},
                  'restore pointer shape differs')
    path = metadata['journal_relative']
    import re
    match = re.fullmatch(r'verification/cold-stored-budget-stop-([0-9a-f]{64})\.json', str(path))
    base._require(match is not None and isinstance(metadata['journal_sha256'], str)
                  and base.SHA.fullmatch(metadata['journal_sha256']), 'invalid restore journal pointer')
    _, journal, _ = base._record(control, path, expected=metadata['journal_sha256'], canonical_record=True)
    _, intent, _ = base._record(control, _paths(match[1])[1], expected=journal.get('intent_sha256'), canonical_record=True)
    variant = journal.get('variant')
    base._require(variant in VARIANTS, 'unknown journal restore variant')
    plan = intent.get('plan', {})
    op = journal.get('operation', {})
    base._require(journal.get('schema') == SCHEMA and journal.get('state') == 'stopped-confirmed'
                  and journal.get('variant') == variant and journal.get('native_drain_performed') is False
                  and journal.get('data_preserved') is True and intent.get('schema') == INTENT_SCHEMA
                  and intent.get('state') == 'stop-authorized' and journal.get('intent_relative') == _paths(match[1])[1]
                  and journal.get('plan_sha256') == intent.get('plan_sha256') == base._sha(canonical(plan))
                  and plan.get('schema') == SCHEMA and plan.get('variant') == variant
                  and plan.get('observation') == journal.get('observation')
                  and intent.get('operation') == op and op.get('phase') == PHASE
                  and isinstance(op.get('attempt'), str) and base.ATTEMPT.fullmatch(op['attempt'])
                  and op.get('root') == PHASE + '/attempts/' + op['attempt'], 'restore journal authority differs')
    raw, operation, _ = base._record(control, op['root'] + '/terminal.json', canonical_record=True)
    receipt_raw, _, _ = base._record(control, op['root'] + '/receipt.json', canonical_record=True)
    observed = journal['observation']
    base._require(raw == receipt_raw and operation.get('state') == 'succeeded'
                  and operation.get('phase') == PHASE and operation.get('attempt') == op['attempt']
                  and operation.get('compose_project') == control.project and operation.get('control_volume') == control.volume
                  and operation.get('result') == {'state': 'stopped-confirmed', 'journal_relative': path,
                                                  'journal_sha256': metadata['journal_sha256']}
                  and operation.get('inputs', {}).get('attempt') == observed.get('attempt')
                  and operation['inputs'].get('config_sha256') == observed.get('config_sha256')
                  and operation['inputs'].get('drain_attempt') == observed.get('history', {}).get('iteration')
                  and operation['inputs'].get('variant') == variant
                  and operation['inputs'].get('source_root') == observed.get('source_root')
                  and operation['inputs'].get('controller_sha256') == plan.get('controller_sha256')
                  and observed.get('control_namespace') == control.namespace
                  and observed.get('containers', {}).get('backend', {}).get('container_id') == match[1],
                  'restore stop operation is not terminal/scope-bound')
    parent_root = 'development/attempts/' + observed['attempt']
    _, parent, _ = base._record(control, parent_root + '/terminal.json', expected=observed['parent_terminal_sha256'], canonical_record=True)
    _, document, _ = base._record(control, parent_root + '/compose.json', expected=observed['compose_sha256'], canonical_record=True)
    recovery = _observed_recovery(observed, variant)
    if recovery:
        startup, hashes, _, _ = resumed.load_startup(control, parent, document,
            source_root=observed['source_root'], resume_attempt=recovery['resume_attempt'], current=False)
        base._require(hashes == observed['resumed_authority']['control_hashes']
                      and all(operation['inputs'].get(key) == value for key, value in recovery.items())
                      and observed['history'].get('recreate_attempt') == recovery['recreate_attempt']
                      and startup['backend_started_at'] == observed['containers']['backend']['started_at']
                      and startup['backend_container'] == match[1], 'journal resume authority differs')
        budget = resumed.projected_budget(observed['cold_api'], observed['ledger'], document)
        resumed.authenticate_archived_history(control, parent, observed)
    else:
        base._require(parent.get('config_sha256') == observed['config_sha256'], 'legacy parent digest differs')
        budget = restore_budget(observed['cold_api']['requested_policy'], observed['ledger']['policy'], document)
    base._require(observed['config_sha256'] == base._sha(canonical(document))
                  and budget == observed['budget'], 'restore budget/source no longer matches authenticated policy')
    return journal


def retained_context(control, previous, document, actual, *, fresh_state=False, removed_container_proof=None):
    backend_id = actual.get('backend', {}).get('Id') if isinstance(actual, Mapping) else None
    if not isinstance(backend_id, str) or base.CONTAINER.fullmatch(backend_id) is None:
        return None
    path, intent = _paths(backend_id)
    from docker_volume_stop_unadmitted import _control_bytes
    raw = _control_bytes(control, path, optional=True)
    if raw is None:
        base._require(_control_bytes(control, intent, optional=True) is None, 'interrupted cold stop has no terminal journal')
        return None
    base._require(not fresh_state, 'cold restore requires retained stopped services')
    metadata = {'journal_relative': path, 'journal_sha256': base._sha(raw)}
    journal = authenticate_journal(control, metadata); observed = journal['observation']
    recovery = _observed_recovery(observed, journal['variant'])
    from docker_dev import _select_source, _compose_identity
    selected, layout = _select_source(Path(observed['source_root']), Path(observed['source_root']))
    if removed_container_proof is not None:
        proof = removed_container_proof
        base._require(proof.get('schema') == 'fullmag.docker-removed-recreation-container.v1'
                      and proof.get('container_id') == backend_id
                      and proof.get('frontend_container') == actual['frontend']['Id']
                      and proof.get('image_id') == actual['backend']['Image']
                      and proof.get('prior_terminal_sha256') == observed['parent_terminal_sha256']
                      and proof.get('prior_compose_sha256') == observed['compose_sha256'],
                      'removed recreation proof differs from cold restore source')
    fresh, rows = _collect(control, _compose_identity(layout), selected, previous, document, layout,
                           observed['history']['iteration'], running=False, cold=observed['cold_api'],
                           removed_actual=actual if removed_container_proof is not None else None,
                           **({'recovery': recovery} if recovery else {}))
    base._require(fresh == observed, 'retained cold restore inventory changed')
    base._require(set(journal['stopped']) == {'backend'}, 'cold stop unexpectedly stopped another service')
    base._require(base._stopped_state(rows['backend'], observed['containers']['backend']) == journal['stopped']['backend'],
                  'stopped backend differs from restore journal')
    for name, row in rows.items():
        base._require(base._container_pin(actual[name]) == observed['containers'][name],
                      'retained incarnation differs from restore journal')
    return ColdBudgetRestoreContext(previous_config_sha256=observed['history']['native_config_sha256'],
                                    cold_budget_restore=metadata)


def authenticated_budget(control, document, metadata, *, source_root):
    journal = authenticate_journal(control, metadata)
    base._require(document.get('name') == control.project
                  and journal['observation']['source_root'] == source_root, 'restore target project/source differs')
    return copy.deepcopy(journal['observation']['budget'])


def apply_restored_budget(control, document, metadata, *, source_root):
    overlay_budget(document, authenticated_budget(control, document, metadata, source_root=source_root))
    return metadata


def _publish_once(control, path, document):
    raw = canonical(document) + b'\n'
    existing = control.read_bytes(path, optional=True)
    if existing is None:
        try:
            base._publish_immutable(control, path, document)
        except BuildControlError:
            # A completed identical publication is safe after a lost ack.
            base._require(control.read_bytes(path, optional=True) == raw, 'immutable continuation publication differs')
    else:
        base._require(existing == raw, 'immutable continuation publication differs')
    base._require(control.read_bytes(path) == raw, 'immutable continuation publication readback differs')
    return base._sha(raw)


def _continuation_commit(control, op, original_raw, result, intent_path, intent_sha, journal_path, journal_sha):
    """CAS publication under a dedicated observer flock; never unlink active.

    The original BuildControl helper still owns operation.lock. It alone
    removes its active marker after seeing the terminal receipt written last.
    Replaying an interrupted commit admits only the archived receipt or the
    exact prepared final bytes, and verifies every already published target.
    """
    root = op['root']; directory = root + '/cold-restore-continuation'
    archive = directory + '/original-receipt.json'; prepared = directory + '/result.json'
    original = base._json(original_raw, 'original cold stop receipt')
    _publish_once(control, archive, original)
    result_sha = _publish_once(control, prepared, result)
    path = control.path(root); saved = control.path(archive); ready = control.path(prepared)
    intent = control.path(intent_path); journal = control.path(journal_path)
    original_sha = base._sha(original_raw)
    phase = control.path(PHASE)
    targets = [path + '/receipt.json', phase + '/current.json', phase + '/verified.json', path + '/terminal.json']
    quoted = ' '.join(shlex.quote(target) for target in targets)
    script = (
        "umask 027; "
        f"test ! -L '{path}/cold-restore-observer.lock'; "
        f"if test -e '{path}/cold-restore-observer.lock'; then test -f '{path}/cold-restore-observer.lock'; "
        f"test $(stat -c %h '{path}/cold-restore-observer.lock') = 1; fi; "
        f"exec 9>'{path}/cold-restore-observer.lock'; flock -n 9; "
        f"test \"$(sha256sum '{intent}' | cut -d' ' -f1)\" = '{intent_sha}'; "
        f"test \"$(sha256sum '{journal}' | cut -d' ' -f1)\" = '{journal_sha}'; "
        f"test \"$(sha256sum '{saved}' | cut -d' ' -f1)\" = '{original_sha}'; "
        f"test \"$(sha256sum '{ready}' | cut -d' ' -f1)\" = '{result_sha}'; "
        f"if test -e '{path}/terminal.json'; then "
        f"for p in {quoted}; do test ! -L \"$p\"; test \"$(sha256sum \"$p\" | cut -d' ' -f1)\" = '{result_sha}'; done; "
        "else "
        f"test \"$(cat /control/active)\" = '{op['attempt']}'; "
        "exec 8<>/control/operation.lock; if flock -n 8; then exit 72; fi; "
        f"s=$(sha256sum '{path}/receipt.json' | cut -d' ' -f1); "
        f"test \"$s\" = '{original_sha}' || test \"$s\" = '{result_sha}'; "
        f"for p in {quoted}; do "
        "test ! -L \"$p\"; parent=$(dirname \"$p\"); test \"$(readlink -f \"$parent\")\" = \"$parent\"; "
        "t=$(mktemp \"$parent/.cold-restore.XXXXXXXX\"); "
        f"cat '{ready}' > \"$t\"; sync \"$t\"; mv -T -- \"$t\" \"$p\"; sync \"$parent\"; done; fi"
    )
    result = bounded_capture(control.helper_args(script), data=b'', timeout=90, maximum=64 * 1024)
    base._require(result.returncode == 0, 'cold continuation finalization unconfirmed; preserve exact intent/lease')
    for target in (root + '/receipt.json', PHASE + '/current.json', PHASE + '/verified.json', root + '/terminal.json'):
        base._require(base._sha(control.read_bytes(target)) == result_sha, 'continuation terminal publication differs')
    deadline = time.monotonic() + 30
    while True:
        status = bounded_capture(control.helper_args('test ! -e /control/active'), data=b'', timeout=10, maximum=4096)
        if status.returncode == 0:
            return
        base._require(time.monotonic() < deadline, 'terminal exists but original helper lease release is unconfirmed')
        time.sleep(.25)


def _wait_original_terminal(control, root, *, timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        raw = control.read_bytes(root + '/terminal.json', optional=True, timeout=10)
        if raw is not None:
            return raw
        base._require(time.monotonic() < deadline,
                      'successful original producer has no terminal yet; observe only, do not finalize concurrently')
        time.sleep(.25)


def _wait_original_publication(control, op, terminal_raw, *, timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        paths = (op['root'] + '/receipt.json', PHASE + '/current.json', PHASE + '/verified.json')
        if all(control.read_bytes(path, optional=True, timeout=10) == terminal_raw for path in paths):
            return
        base._require(time.monotonic() < deadline,
                      'original terminal exists but publication readback is incomplete; observe only')
        time.sleep(.25)


def _continue(control, identity, selected, layout, args, journal_path, intent_path):
    recovery = _recovery_args(args)
    variant = resumed.VARIANT if recovery else VARIANT
    base._require(args.apply is True and isinstance(args.continue_intent_sha256, str)
                  and base.SHA.fullmatch(args.continue_intent_sha256), 'continuation requires explicit apply and exact intent SHA')
    _, intent, _ = base._record(control, intent_path, expected=args.continue_intent_sha256, canonical_record=True)
    plan = intent.get('plan', {}); observed = plan.get('observation', {}); op = intent.get('operation', {})
    base._require(intent.get('schema') == INTENT_SCHEMA and intent.get('state') == 'stop-authorized'
                  and plan.get('schema') == SCHEMA and plan.get('variant') == variant
                  and intent.get('plan_sha256') == args.expected_plan_sha256 == base._sha(canonical(plan))
                  and plan.get('controller_sha256') == _controller_sha(variant)
                  and op.get('phase') == PHASE and isinstance(op.get('attempt'), str)
                  and base.ATTEMPT.fullmatch(op['attempt']) and op.get('root') == PHASE + '/attempts/' + op['attempt']
                  and observed.get('attempt') == args.attempt and observed.get('config_sha256') == args.config_sha256
                  and observed.get('source_root') == str(selected) and observed.get('history', {}).get('iteration') == args.drain_attempt
                  and observed.get('containers', {}).get('backend', {}).get('container_id') == args.backend_container_id
                  and observed['containers']['backend'].get('image_id') == args.image_id,
                  'continuation intent/plan/operator pins differ')
    base._require(_observed_recovery(observed, variant) == recovery, 'continuation recovery pins differ')
    root = 'development/attempts/' + args.attempt
    _, previous, _ = base._record(control, root + '/terminal.json', expected=observed['parent_terminal_sha256'], canonical_record=True)
    _, document, _ = base._record(control, root + '/compose.json', expected=observed['compose_sha256'], canonical_record=True)
    terminal_raw, _, _ = base._record(control, op['root'] + '/terminal.json', optional=True)
    helper_id = None
    if terminal_raw is not None:
        _wait_original_publication(control, op, terminal_raw)
    if terminal_raw is None:
        receipt_raw, receipt, _ = base._record(control, op['root'] + '/receipt.json', canonical_record=True)
        archive_raw, _, _ = base._record(control, op['root'] + '/cold-restore-continuation/original-receipt.json', optional=True)
        if archive_raw is None and receipt.get('state') == 'succeeded':
            # The original success writer publishes receipt before terminal.
            # Its helper's operation.lock does not exclude that host writer.
            # Wait for its own terminal; never enter a second publication path.
            _wait_original_terminal(control, op['root'])
            return _continue(control, identity, selected, layout, args, journal_path, intent_path)
        original_raw = archive_raw if archive_raw is not None else receipt_raw
        original = base._json(original_raw, 'interrupted cold stop receipt')
        base._require(original.get('state') == 'outcome-unknown-resources-retained'
                      and type(original.get('finished_at')) in (int, float)
                      and 0 < original['finished_at'] < float('inf')
                      and original.get('phase') == PHASE and original.get('attempt') == op['attempt']
                      and original.get('compose_project') == control.project and original.get('control_volume') == control.volume
                      and original.get('inputs', {}).get('controller_sha256') == plan['controller_sha256']
                      and original['inputs'].get('variant') == variant
                      and original['inputs'].get('attempt') == args.attempt
                      and original['inputs'].get('config_sha256') == args.config_sha256
                      and original['inputs'].get('backend_container_id') == args.backend_container_id
                      and original['inputs'].get('image_id') == args.image_id
                      and original['inputs'].get('source_root') == str(selected)
                      and original['inputs'].get('drain_attempt') == args.drain_attempt
                      and all(original['inputs'].get(key) == value for key, value in (recovery or {}).items()),
                      'original stop operation is not the exact interrupted owner')
        if archive_raw is not None and receipt_raw != archive_raw:
            prepared_raw, _, _ = base._record(control, op['root'] + '/cold-restore-continuation/result.json')
            base._require(receipt_raw == prepared_raw, 'partial continuation receipt differs from prepared CAS')
        helper_id = control._inspect_operation_helper({'receipt': original})
        _publish_once(control, op['root'] + '/cold-restore-continuation/original-receipt.json', original)
    # This wait sends no signal, including when the first signal's ack was lost.
    _wait_backend_stop(args.backend_container_id, observed['containers']['backend'])
    fresh, actual = _collect(control, identity, selected, previous, document, layout, args.drain_attempt,
                             running=False, cold=observed['cold_api'], helper_id=helper_id, **({'recovery': recovery} if recovery else {}))
    base._require(fresh == observed, 'continuation inventory differs from the exact stop intent')
    stopped = {'backend': base._stopped_state(actual['backend'], observed['containers']['backend'])}
    journal = {'schema': SCHEMA, 'state': 'stopped-confirmed', 'variant': variant,
               'intent_relative': intent_path, 'intent_sha256': args.continue_intent_sha256,
               'plan_sha256': intent['plan_sha256'], 'operation': op, 'observation': observed,
               'stopped': stopped, 'native_drain_performed': False, 'data_preserved': True}
    digest = _publish_once(control, journal_path, journal)
    result = {'state': 'stopped-confirmed', 'journal_relative': journal_path, 'journal_sha256': digest}
    if terminal_raw is None:
        control._inspect_operation_helper({'receipt': original}, expected_id=helper_id)
        finalized = copy.deepcopy(original); finalized.pop('error', None)
        finalized.update(state='succeeded', result=result, cold_restore_continuation={
            'schema': 'fullmag.cold-stored-budget-continuation.v1', 'intent_sha256': args.continue_intent_sha256})
        _continuation_commit(control, op, original_raw, finalized, intent_path, args.continue_intent_sha256, journal_path, digest)
    authenticate_journal(control, {key: result[key] for key in ('journal_relative', 'journal_sha256')})
    print(json.dumps(result)); return result
