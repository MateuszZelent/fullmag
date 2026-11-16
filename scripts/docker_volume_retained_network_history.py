"""Closed, read-only proof for retained-owner DEV network failures before start.

This admits failure publication only. It confers no runtime rotation, recovery,
restart or Solve authority, and does not modify the retained native records.
"""
from __future__ import annotations

from collections.abc import Mapping

from docker_build_control import BuildControlError, canonical
from docker_volume_reconcile import digest, fingerprint, read_raw, require
from docker_volume_recreated_network_history import (
    PUBLICATION_PATHS, _group, _identity_inputs, _sha, _time, _token,
    _validate_provenance,
)
from docker_volume_prelaunch_failure_stop import decode

MAX_ATTEMPTS = 16
MAX_RECORDS = 64
PRESTART_FORBIDDEN = {
    'backend_container', 'frontend_container', 'backend_container_id', 'frontend_container_id',
    'backend_started_at', 'backend_build_receipt_sha256', 'backend_package_cache_hit',
    'startup', 'url', 'config_sha256', 'backend_build_receipt', 'provenance',
}


def validate_retained_history(control, *, failed_attempt, original, publications, attempts,
                              current_sha256, verified_sha256, recreation_attempt,
                              recreation_sha256, stop_attempt, stop_sha256,
                              native_config_sha256):
    """Bind failed prestart/current, verified runtime, managed stop and removal.

    Raw SHA pins select historical records; semantic checks establish their
    relationship. The manifest covers byte-exact protected records for CAS.
    """
    for value, label in ((current_sha256, 'current'), (verified_sha256, 'verified'),
                         (recreation_sha256, 'recreation'), (stop_sha256, 'stop'),
                         (native_config_sha256, 'native config')):
        _sha(value, label)
    for value, label in ((failed_attempt, 'failed attempt'), (stop_attempt, 'stop attempt'),
                         (recreation_attempt, 'recreation attempt')):
        _token(value, label)
    require(isinstance(control.identity, Mapping), 'Retained control identity is missing')
    identity = control.identity
    retained = {}

    def record(path, expected=None):
        value_raw = read_raw(control, path)
        require(isinstance(value_raw, bytes), 'Required retained record is absent: ' + path)
        sha = digest(value_raw)
        require(expected is None or sha == expected, 'Retained record pin differs: ' + path)
        # Native Rust OWNER and ready-pin producers use pretty JSON without
        # a trailing newline. Pin raw bytes; never normalize retained evidence.
        value = decode(value_raw)
        retained[path] = sha
        return value_raw, value

    def operation(phase, token, expected=None):
        root = phase + '/attempts/' + token
        terminal_raw, value = record(root + '/terminal.json', expected)
        receipt_raw, _ = record(root + '/receipt.json')
        require(receipt_raw == terminal_raw, 'Historical receipt differs from terminal: ' + root)
        require(value.get('schema') == 'fullmag.docker-build-operation.v1'
                and value.get('attempt') == token and value.get('phase') == phase,
                'Historical operation identity differs: ' + root)
        _group(value, control, root)
        return terminal_raw, value

    target_terminal = 'development/attempts/' + failed_attempt + '/terminal.json'
    require(set(publications) == PUBLICATION_PATHS | {target_terminal}
            and publications[target_terminal] is None, 'Retained publication inventory differs')
    for path in PUBLICATION_PATHS:
        observed, _ = record(path)
        require(observed == publications[path], 'Retained publication changed: ' + path)
    for name in ('network-failure-reconcile.lock', 'reconciliation/prepared.json',
                 'reconciliation/result.json', 'reconciliation/network-failure-proof.json'):
        require(read_raw(control, 'development/attempts/' + failed_attempt + '/' + name, optional=True) is None,
                'An earlier or partial retained failure publication exists')
    current_raw, current = record('development/current.json', current_sha256)
    verified_raw, verified = record('development/verified.json', verified_sha256)
    current_attempt = _token(current.get('attempt'), 'retained current attempt')
    verified_attempt = _token(verified.get('attempt'), 'retained verified attempt')
    require(len({failed_attempt, current_attempt, verified_attempt, stop_attempt, recreation_attempt}) == 5,
            'Retained operations must be distinct')
    require(current.get('state') == 'failed-confirmed'
            and not (set(current) & PRESTART_FORBIDDEN)
            and isinstance(current.get('error'), str) and bool(current['error']),
            'Retained current is not a confirmed failure before service publication')
    current_compose = 'development/attempts/' + current_attempt + '/compose.json'
    require(read_raw(control, current_compose, optional=True) is None,
            'Retained current passed Compose publication; only a pre-Compose failure is admissible')
    retained[current_compose] = None
    require(verified.get('state') == 'succeeded', 'Retained verified is not a successful runtime')
    require(isinstance(attempts, list) and 3 <= len(attempts) <= MAX_ATTEMPTS
            and all(isinstance(row, tuple) and len(row) == 2 and row[1] == 'd'
                    for row in attempts)
            and len({row[0] for row in attempts}) == len(attempts),
            'Retained development inventory is malformed or exceeds its bound')
    require({failed_attempt, current_attempt, verified_attempt}.issubset({row[0] for row in attempts}),
            'Retained pointer attempts are absent from the inventory')
    for token, _ in attempts:
        _token(token, 'historical development attempt')
        if token == failed_attempt:
            continue
        terminal_raw, value = operation('development', token)
        _identity_inputs(value.get('inputs'), identity, 'Historical development')
        require(value.get('state') in {'succeeded', 'failed-confirmed'},
                'Another development attempt has an unresolved outcome')
        require(_time(value.get('finished_at'), 'Historical finish') < _time(original.get('started_at'), 'Failure start'),
                'Historical development overlaps the failed attempt')
        require(_time(value.get('finished_at'), 'Historical finish') <= _time(current.get('finished_at'), 'Current finish'),
                'Retained current does not name the latest development terminal')
        if value.get('state') == 'succeeded':
            require(_time(value.get('finished_at'), 'Successful finish') <= _time(verified.get('finished_at'), 'Verified finish'),
                    'Retained verified does not name the latest successful development')
        if token == current_attempt:
            require(terminal_raw == current_raw, 'Current pointer differs from its historical terminal')
        if token == verified_attempt:
            require(terminal_raw == verified_raw, 'Verified pointer differs from its historical terminal')
    _group(original, control, 'Failed prestart')
    _identity_inputs(original.get('inputs'), identity, 'Failed prestart')
    require(original.get('attempt') == failed_attempt and original.get('phase') == 'development'
            and original.get('state') == 'outcome-unknown-resources-retained'
            and not (set(original) & PRESTART_FORBIDDEN), 'Failed attempt crossed the prestart boundary')

    config_sha = _sha(verified.get('config_sha256'), 'Verified Compose pin')
    _, compose = record('development/attempts/' + verified_attempt + '/compose.json')
    require(digest(canonical(compose)) == config_sha and compose.get('name') == control.project
            and set(compose.get('services', {})) == {'backend', 'frontend'}, 'Verified Compose differs')
    _, stop = operation('iteration', stop_attempt, stop_sha256)
    _, recreation = operation('recreate-services', recreation_attempt, recreation_sha256)
    backend = verified.get('backend_container')
    frontend = verified.get('frontend_container')
    require(isinstance(backend, str) and isinstance(frontend, str) and backend != frontend
            and len(backend) == len(frontend) == 64
            and all(char in '0123456789abcdef' for char in backend + frontend),
            'Verified service identities are malformed')
    for value, label in ((stop, 'Managed stop'), (recreation, 'Managed recreation')):
        inputs = value.get('inputs')
        require(value.get('state') == 'succeeded' and isinstance(inputs, dict)
                and inputs.get('attempt') == verified_attempt and inputs.get('config_sha256') == config_sha,
                label + ' does not bind verified runtime')
    stop_inputs = stop['inputs']
    recreation_inputs = recreation['inputs']
    require(stop_inputs.get('source_root') == identity.get('source_root'),
            'Managed stop source root differs from the selected checkout')
    require('source_root' not in recreation_inputs
            or recreation_inputs['source_root'] == identity.get('source_root'),
            'Managed recreation source root differs from the selected checkout')
    require(stop.get('idle_backend_stopped') is True and stop.get('config_sha256') == config_sha
            and stop.get('backend_container') == backend and stop.get('frontend_container') == frontend,
            'Managed stop is not the exact successful stop-only operation')
    require(recreation.get('removed_containers') == [backend, frontend]
            and recreation.get('fresh_state') is False
            and recreation.get('previous_state_root') == verified.get('state_root')
            and 'runtime_control_archive' not in recreation,
            'Managed recreation is not the retained-owner service removal')
    times = [_time(verified.get('finished_at'), 'Verified finish'),
             _time(stop.get('started_at'), 'Stop start'), _time(stop.get('finished_at'), 'Stop finish'),
             _time(recreation.get('started_at'), 'Recreation start'),
             _time(recreation.get('finished_at'), 'Recreation finish'),
             _time(current.get('started_at'), 'Current start'), _time(current.get('finished_at'), 'Current finish'),
             _time(original.get('started_at'), 'Failure start')]
    require(all(left < right for left, right in zip(times, times[1:])), 'Retained operation order differs')
    stop_root = 'iteration/attempts/' + stop_attempt
    _, stop_compose = record(stop_root + '/compose.json')
    require(stop_compose == compose, 'Managed stop used a different Compose document')
    _, snapshot = record(stop_root + '/idle-stop-containers.json', _sha(stop.get('idle_stop_containers_sha256'), 'Stop snapshot'))
    require(set(snapshot) == {'backend', 'frontend'}, 'Stopped service snapshot is incomplete')
    for service, identifier in (('backend', backend), ('frontend', frontend)):
        observed = snapshot[service]
        state = observed.get('State', {})
        require(observed.get('Id') == identifier and all(state.get(key) == value for key, value in {
            'Running': False, 'Status': 'exited', 'Pid': 0, 'ExitCode': 0, 'OOMKilled': False}.items()),
            'Stop snapshot is not the exact cleanly stopped service')
    _, removed_snapshot = record('recreate-services/attempts/' + recreation_attempt + '/retained-containers.json')
    require(set(removed_snapshot) == {'backend', 'frontend'}, 'Recreation snapshot is incomplete')
    from docker_compose_identity import source_labels
    for service in ('backend', 'frontend'):
        stopped, removed = snapshot[service], removed_snapshot[service]
        labels = stopped.get('Config', {}).get('Labels', {})
        require(all(labels.get(key) == value for key, value in source_labels(identity).items())
                and labels.get('com.docker.compose.project') == control.project
                and labels.get('com.docker.compose.service') == service
                and stopped.get('Image') == compose['services'][service].get('image'),
                'Stopped snapshot source/image differs from verified Compose')
        require(fingerprint(stopped) == fingerprint(removed) and stopped.get('State') == removed.get('State'),
                'Recreation removed a different stopped service incarnation')
    process_raw, process = record('runtime-control/runtime-service/process-tree.json')
    _, drain = record(stop_root + '/backend-drain.json')
    require(drain.get('schema') == 'fullmag.docker-idle-restart-drain.v1'
            and drain.get('backend_container_id') == backend and drain.get('process_receipt') == process
            and drain.get('process_receipt_sha256') == digest(process_raw)
            and process.get('schema') == 'fullmag.docker-process-tree.v1' and process.get('state') == 'drained',
            'Managed drain differs from retained process receipt')
    _, owner = record('runtime-control/runtime-services/OWNER.json')
    ready = process.get('service_owner')
    require(isinstance(ready, dict), 'Retained native ready owner is missing')
    # Reuse the native owner authority for complete protocol, generation and
    # child-status validation, rather than accepting a bare drained label.
    from docker_volume_drained_successor import _validate_native_owners
    try:
        native = _validate_native_owners(ready, owner)
        terminal = process.get('terminal_service_owner')
        require(isinstance(terminal, dict), 'Native terminal owner is missing')
        native._validate_terminal_owner(terminal, state='drained', name='retained drain terminal')
        _, ready_pin = record('runtime-control/runtime-services/docker-client-' + ready['owner_token'] + '.json')
        native._validate_terminal_owner(ready_pin, state='ready', name='retained ready pin')
        require(native._owner_fingerprint(ready) == native._owner_fingerprint(ready_pin)
                and native._owner_fingerprint(owner) == native._owner_fingerprint(terminal)
                and native._owner_identity(ready) == native._owner_identity(owner)
                and native._owner_child_identity(ready) == native._owner_child_identity(owner),
                'Native owner/children transition differs from authenticated drain')
    except (RuntimeError, ValueError, KeyError, TypeError) as error:
        raise BuildControlError('Retained native owner authentication failed: ' + str(error)) from error
    _, config = record('runtime-control/runtime-service/docker-all.json', native_config_sha256)
    require(config.get('schema_version') in {'runtime_service_config.v1', 'runtime_service_config.v2'}
            and all(config.get(key) == owner.get(key) for key in
                    ('target_id', 'compute_pool_id', 'preparation_pool_id')),
            'Retained native configuration belongs to another owner/pool')
    _, provenance = record('backend/runtime-provenance.json')
    provenance_identity = _validate_provenance(provenance, process)
    require(provenance_identity['build_receipt_sha256'] == verified.get('backend_build_receipt_sha256'),
            'Retained provenance differs from the verified backend build')
    require(len(retained) <= MAX_RECORDS, 'Retained manifest exceeds its record bound')
    return dict(schema='fullmag.docker-development-network-retained-history.v1', mode='retained-prestart',
                current_attempt=current_attempt, verified_attempt=verified_attempt, stop_attempt=stop_attempt,
                recreation_attempt=recreation_attempt, retained_records=retained,
                manifest_sha256=digest(canonical(retained)), **provenance_identity)
