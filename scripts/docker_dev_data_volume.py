"""Plan a pinned WSL data move without stopping, admitting, or changing data.

The plan authenticates the retained runtime and records consumers. It is input
to provisioning, not authority to format or delete: those stages must separately
prove the new device, drain, full copy, runtime admission and a new complete Zarr.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PureWindowsPath
import re
import uuid

from docker_build_control import BuildControl, canonical, docker_capture
from docker_compose_identity import compose_project_identity
from docker_development_inputs import select_checkout
from docker_dev_host import local_volume, validate_host_path
from docker_linux_native_readmission import live_bind_path
from docker_volume_reconcile import fingerprint
import data_volume_stopped_windows_bind as stopped_windows
import fullmag_storage as storage
import linux_native_host as host


SCHEMA = 'fullmag.data-volume-plan.v1'
RUNTIME_KEYS = ('attempt', 'config_sha256', 'state_root', 'backend', 'frontend',
                'image_id', 'runtime_witness_path', 'runtime_witness_sha256')
CONTROLLERS = ('docker_dev_data_volume.py', 'fullmag_data_volume.py',
               'fullmag_data_volume_fs.py', 'fullmag_data_volume_manifest.py',
               'fullmag_data_volume_guard.py', 'linux_native_data_volume_migration.py',
               'linux_native_host.py', 'docker_dev.py', 'docker_volume_dev.py',
               'fullmag_storage.py', 'data_volume_stopped_windows_bind.py')


def _require(value, message):
    if not value:
        raise ValueError(message)


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _migration_bind_identity(value, container_state=None):
    """A stopped Windows reference has a separate proof, never live admission."""
    candidate = False
    if container_state is not None:
        try:
            stopped_windows._require_stopped_state(container_state)
            stopped_windows._canonical_windows_path(value)
            candidate = True
        except ValueError:
            pass
    if candidate:
        return None, stopped_windows.qualify_stopped_windows_bind(value, container_state)
    return live_bind_path(value), None


def _sha_field(value):
    return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, 'Duplicate JSON key in migration input')
        result[key] = value
    return result


def _decode(raw):
    def invalid(value):
        raise ValueError('Nonfinite JSON migration input: ' + value)
    def finite(value):
        result = float(value)
        _require(math.isfinite(result), 'Nonfinite JSON migration number')
        return result
    return json.loads(raw, object_pairs_hook=_no_duplicate_keys,
                      parse_constant=invalid, parse_float=finite)


def _runtime_pins(value):
    _require(type(value) is dict and set(RUNTIME_KEYS) <= value.keys(),
             'Complete retained runtime pins required')
    pins = {key: value[key] for key in RUNTIME_KEYS}
    _require(type(pins['attempt']) is str and re.fullmatch(r'[0-9a-f]{32}', pins['attempt']),
             'Exact retained development attempt required')
    _require(all(_sha_field(pins[key]) for key in
                 ('config_sha256', 'backend', 'frontend', 'runtime_witness_sha256')),
             'Exact retained service and digest pins required')
    _require(pins['backend'] != pins['frontend'], 'Runtime services must be distinct')
    _require(type(pins['image_id']) is str and re.fullmatch(r'sha256:[0-9a-f]{64}', pins['image_id']),
             'Immutable retained image required')
    _require(type(pins['runtime_witness_path']) is str and re.fullmatch(
        r'(development|iteration|resume)/attempts/[0-9a-f]{32}/terminal\.json',
        pins['runtime_witness_path']), 'Bounded retained runtime witness required')
    _require(type(pins['state_root']) is str, 'Canonical retained state root required')
    return pins


def _require_existing_control(control, pins):
    """Read helpers must never bootstrap a missing named volume as a side effect."""
    rows = _decode(docker_capture('volume', 'inspect', control.volume).stdout)
    _require(type(rows) is list and len(rows) == 1 and rows[0].get('Name') == control.volume and
             rows[0].get('Driver') == 'local' and not rows[0].get('Options'),
             'Existing stable local control volume required before any read helper')
    rows = _decode(docker_capture('inspect', pins['backend']).stdout)
    _require(type(rows) is list and len(rows) == 1, 'Exact current backend required')
    backend = rows[0]
    _require(backend.get('Id') == pins['backend'] and backend.get('Image') == pins['image_id'] and
             backend.get('State', {}).get('Running') is True and
             backend.get('State', {}).get('Health', {}).get('Status') == 'healthy' and
             any(m.get('Type') == 'volume' and m.get('Name') == control.volume
                 for m in backend.get('Mounts', [])),
             'Pinned live backend must retain the existing control volume')


def _observe_runtime(source, layout, control, pins):
    compose = _decode(control.read_bytes('development/attempts/' + pins['attempt'] + '/compose.json'))
    witness_raw = control.read_bytes(pins['runtime_witness_path'])
    _require(_sha(canonical(compose)) == pins['config_sha256'] and
             compose.get('name') == control.project, 'Retained Compose CAS or group changed')
    _require(_sha(witness_raw) == pins['runtime_witness_sha256'], 'Runtime witness bytes changed')
    witness = _decode(witness_raw)
    _require(witness.get('state') == 'succeeded' and
             witness.get('phase') == pins['runtime_witness_path'].split('/')[0] and
             witness.get('compose_project') == control.project and
             witness.get('control_volume') == control.volume and
             witness.get('backend_container') == pins['backend'] and
             witness.get('frontend_container') == pins['frontend'] and
             witness.get('state_root') == pins['state_root'] and
             witness.get('config_sha256') == pins['config_sha256'],
             'Successful runtime witness does not bind this exact service pair/state')
    if witness['phase'] != 'development':
        _require(witness.get('inputs', {}).get('attempt') == pins['attempt'] and
                 witness.get('inputs', {}).get('config_sha256') == pins['config_sha256'],
                 'Runtime witness does not descend from the retained development attempt')
    _require(control.read_bytes('active', optional=True) is None,
             'Another managed operation is active; retain all resources')
    state = storage.validate_path(pins['state_root'], layout['runtime_root'], 'migration StateRoot')
    user = Path(layout['storage_root']) / 'user-data' / control.project
    roots = {'user_data': user, 'state': state}
    for path in roots.values():
        _require(local_volume(path).get('host_filesystem') == 'ext4', 'Source datasets must be ext4')
    ids = docker_capture('ps', '--all', '--no-trunc', '--format', '{{.ID}}').stdout.decode().split()
    actuals = _decode(docker_capture('inspect', *ids).stdout) if ids else []
    services, consumers, bind_cache, stopped_proofs = {}, [], {}, []
    def physical_bind(value, container_state=None):
        # Desktop can repeat the same Windows bind in many stopped containers.
        # Cache only within this read-only snapshot, never across actions.
        state_sha = _sha(canonical(container_state)) if container_state is not None else None
        key = (value, state_sha)
        if key not in bind_cache:
            try:
                physical, proof = _migration_bind_identity(value, container_state)
                if proof is not None:
                    stopped_proofs.append({'source': value, 'container_state_sha256': state_sha,
                                           'proof': proof})
                bind_cache[key] = (True, physical)
            except (ValueError, RuntimeError, OSError) as error:
                bind_cache[key] = (False, error)
        success, result = bind_cache[key]
        if not success:
            raise result
        return result
    for actual in actuals:
        labels = actual.get('Config', {}).get('Labels') or {}
        owned = actual.get('Id') in (pins['backend'], pins['frontend'])
        if owned:
            service = labels.get('com.docker.compose.service')
            _require(service in ('backend', 'frontend') and service not in services and
                     actual['Id'] == pins[service] and actual.get('Image') == pins['image_id'] and
                     labels.get('com.docker.compose.project') == control.project,
                     'Retained service labels, image, or incarnation changed')
            observed_state = actual.get('State', {})
            _require(observed_state.get('Running') is True and observed_state.get('Status') == 'running' and
                     observed_state.get('Health', {}).get('Status') == 'healthy' and
                     observed_state.get('OOMKilled') is False,
                     'Retained services must be running and healthy when planning')
            services[service] = {'id': actual['Id'], 'fingerprint': fingerprint(actual),
                                 'pid': observed_state['Pid'], 'started_at': observed_state['StartedAt'],
                                 'nano_cpus': actual['HostConfig'].get('NanoCpus'),
                                 'memory_bytes': actual['HostConfig'].get('Memory')}
        elif labels.get('com.docker.compose.project') == control.project:
            consumers.append({'id': actual['Id'], 'reason': 'additional-group-resource'})
        for mount in actual.get('Mounts', []):
            if owned:
                continue
            if mount.get('Name') == control.volume:
                consumers.append({'id': actual['Id'], 'reason': 'control-volume-reference'})
            if mount.get('Type') == 'bind':
                try:
                    physical = physical_bind(mount.get('Source'), actual.get('State'))
                    if physical is not None and any(
                        physical == p or physical in p.parents or p in physical.parents
                        for p in roots.values()
                    ):
                        consumers.append({'id': actual['Id'], 'reason': 'dataset-bind-reference'})
                except (ValueError, RuntimeError, OSError) as error:
                    consumers.append({'id': actual['Id'], 'reason': 'unproven-bind-identity',
                                      'error_type': type(error).__name__})
    _require(set(services) == {'backend', 'frontend'}, 'Retained service pair is absent')
    backend = next(a for a in actuals if a['Id'] == pins['backend'])
    mounts = {m.get('Destination'): m for m in backend.get('Mounts', [])}
    for target, path in [('/state', state), ('/user-data', user), ('/opt/fullmag/source', source)]:
        mount = mounts.get(target, {})
        physical = physical_bind(mount.get('Source')) if mount.get('Type') == 'bind' else None
        _require(physical == path and mount.get('RW') is (target != '/opt/fullmag/source'),
                 'Retained backend bind differs: ' + target)
    certificate_raw = host.read_owned_regular(state / host.CERTIFICATE_NAME)
    certificate = _decode(certificate_raw)
    _require(host.read_owned_regular(state / host.OWNER_NAME) == certificate_raw and
             certificate.get('host_root') == str(state) and
             certificate.get('host_device') == state.stat().st_dev and
             certificate.get('host_inode') == state.stat().st_ino and
             certificate.get('image_id') == pins['image_id'] and
             certificate.get('restart_verified') is True,
             'Current predecessor host admission differs')
    engine = docker_capture('info', '--format', '{{.ID}}').stdout.decode().strip()
    _require(engine and certificate.get('engine_id') == engine, 'Runtime engine identity changed')
    return {'datasets': {role: {'canonical_root': str(p), 'device': p.stat().st_dev,
                                'inode': p.stat().st_ino} for role, p in roots.items()},
            'services': services, 'consumers': consumers, 'engine_id': engine,
            'stopped_windows_bind_proofs': stopped_proofs,
            'certificate_sha256': _sha(certificate_raw), 'compose_sha256': pins['config_sha256'],
            'runtime_source_commit': witness.get('source_commit'),
            'runtime_source_snapshot_sha256': witness.get('source_snapshot_sha256')}


def plan_data_volume(source_root, runtime, *, backing_file, mount_root, distro,
                     capacity_bytes=128*1024**3, volume_id=None):
    """Read-only plan; explicitly leaves device/copy/drain qualification pending."""
    _require(os.name == 'posix', 'This migration plan requires Linux/WSL')
    source = select_checkout(Path(source_root), str(source_root))
    validate_host_path(source, 'migration source checkout')
    layout = storage.resolve_layout(source, profile='docker-all-gpu')
    identity = compose_project_identity(layout)
    from fullmag_data_volume_guard import verify_registered_volume
    _require(verify_registered_volume(layout, identity['project_name']) is None,
             'Group already has a data-volume registration; verify or recover it')
    pins = _runtime_pins(runtime)
    _require(type(capacity_bytes) is int and 1024**3 <= capacity_bytes <= 1024**4,
             'Capacity must be an integer from 1 GiB to 1 TiB')
    _require(type(distro) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,80}', distro), 'Invalid WSL distro')
    volume_id = volume_id or uuid.uuid4().hex
    _require(type(volume_id) is str and re.fullmatch(r'[0-9a-f]{32}', volume_id) and
             volume_id != '0'*32, 'Exact nonzero volume identity required')
    # Validate the Windows mapping and durable paths with the shared pure model.
    image = PureWindowsPath(backing_file)
    backing_wsl = '/mnt/' + image.drive[:1].lower() + '/' + '/'.join(image.parts[1:])
    state = storage.validate_path(pins['state_root'], layout['runtime_root'], 'migration StateRoot')
    roots = {'user_data': Path(layout['storage_root'])/'user-data'/identity['project_name'], 'state': state}
    proposed = {'schema': 'fullmag.user-data-volume.v1', 'state': 'committed',
                'project_id': identity['project_id'], 'worktree_id': identity['worktree_id'],
                'compose_project': identity['project_name'], 'volume_id': volume_id,
                'backing_file_windows': str(backing_file), 'backing_file_wsl': backing_wsl,
                'filesystem_uuid': '11111111-1111-4111-8111-111111111111',
                'mount_root': str(mount_root), 'migration_receipt_sha256': '0'*64,
                'datasets': [{'role': role, 'canonical_root': str(path),
                              'relative_root': 'payload/'+path.relative_to(layout['storage_root']).as_posix()}
                             for role, path in roots.items()]}
    from fullmag_data_volume import validate_registration
    validate_registration(proposed)  # Shape only. This object is NEVER published as registration.
    mount = Path(mount_root)
    for tree in (Path(layout['storage_root']), source):
        _require(not (mount == tree or mount in tree.parents or tree in mount.parents),
                 'New mount root must be disjoint from original storage and checkout')
    _require(not os.path.lexists(backing_wsl), 'Image already exists; refuse overwrite or adoption')
    _require(not os.path.lexists(mount_root), 'Mount root already exists; inspect/recover first')
    control = BuildControl(identity, pins['image_id'])
    _require_existing_control(control, pins)
    observed = _observe_runtime(source, layout, control, pins)
    directory = str(PureWindowsPath('//wsl.localhost/' + distro) /
                    PureWindowsPath(*Path(layout['storage_root']).parts[1:]) /
                    'migrations'/'data-volumes'/volume_id)
    provision = {'schema': 'fullmag.wsl-data-volume-provision.v1', 'volume_id': volume_id,
                 'backing_root_windows': str(image.parent), 'backing_file_windows': str(backing_file),
                 'backing_file_wsl': backing_wsl, 'capacity_bytes': capacity_bytes,
                 'wsl_distro': distro, 'storage_root_wsl': layout['storage_root'],
                 'result_directory_windows': directory}
    return {'schema': SCHEMA, 'state': 'planned-not-applied', 'volume_id': volume_id,
            'project_id': identity['project_id'], 'worktree_id': identity['worktree_id'],
            'compose_project': identity['project_name'], 'source_root': str(source),
            'source_revision': storage.git(source, 'rev-parse', 'HEAD'),
            'storage_root': layout['storage_root'], 'runtime_root': layout['runtime_root'],
            'mount_root': str(mount_root), 'runtime_pins': pins, 'observation': observed,
            'controller_inputs': {name: _sha((source/'scripts'/name).read_bytes()) for name in CONTROLLERS},
            'provision_request': provision, 'mutated': False,
            'pending_gates': ['full-capacity-inventory', 'owned-empty-device', 'managed-drain',
                              'writer-and-consumer-fence', 'archive-and-copy-verification',
                              'bind-transaction', 'new-native-admission', 'new-complete-zarr',
                              'original-duplicate-retirement']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan'])
    parser.add_argument('--source-root', required=True)
    parser.add_argument('--runtime-pins', required=True)
    parser.add_argument('--backing-file', required=True)
    parser.add_argument('--mount-root', required=True)
    parser.add_argument('--wsl-distro', required=True)
    parser.add_argument('--capacity-gib', type=int, default=128)
    parser.add_argument('--volume-id')
    args = parser.parse_args(argv)
    raw = host.read_owned_regular(Path(args.runtime_pins), maximum=1024**2)
    result = plan_data_volume(args.source_root, _decode(raw), backing_file=args.backing_file,
                              mount_root=args.mount_root, distro=args.wsl_distro,
                              capacity_bytes=args.capacity_gib*1024**3, volume_id=args.volume_id)
    result['runtime_pin_file_sha256'] = _sha(raw)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
