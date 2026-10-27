"""Explicit re-attestation of a stopped Linux session after device renumbering.

No runtime is started and no lease or simulation artifact is changed. The
normal retained-certificate guard remains strict; this separate operation
repeats the existing native storage probe before publishing new host evidence.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re

import fullmag_storage as storage
import linux_native_host as host
from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, toolchain_configuration
from docker_dev_host import local_volume


def proposal(certificate, marker, native, *, inode, engine_id, image_id):
    if (certificate != marker or certificate.get('schema') != host.HOST_SCHEMA
            or certificate.get('storage_profile') != host.PROFILE
            or certificate.get('role') != 'session'
            or certificate.get('owner_scope') != 'docker-linux'
            or certificate.get('engine_id') != engine_id
            or certificate.get('image_id') != image_id
            or certificate.get('host_inode') != inode
            or certificate.get('restart_verified') is not True
            or not re.fullmatch(r'[0-9a-f]{32}', certificate.get('owner_token', ''))):
        raise BuildControlError('Re-attestation requires the same verified owner, engine, image and directory inode')
    if set(native) != {'host_root', 'host_filesystem', 'host_platform', 'host_device', 'host_root_no_reparse'}:
        raise BuildControlError('Unexpected native volume identity fields')
    for key, value in native.items():
        if key != 'host_device' and certificate.get(key) != value:
            raise BuildControlError('Storage identity changed beyond device numbering: ' + key)
    old, new = certificate.get('host_device'), native['host_device']
    if any(type(v) is not int or v <= 0 for v in (old, new)) or old == new:
        raise BuildControlError('Re-attestation requires a changed positive device number')
    return {**certificate, 'host_device': new, 'restart_verified': False}


def _evidence(state, engine_id, image_id):
    paths = [state / host.CERTIFICATE_NAME, state / host.OWNER_NAME,
             state / '.linux-native-sentinel', state / '.linux-native-restart',
             state / '.linux-native-probe.json']
    raw = {p.name: host.read_owned_regular(p) for p in paths}
    certificate = json.loads(raw[host.CERTIFICATE_NAME])
    new = proposal(certificate, json.loads(raw[host.OWNER_NAME]), local_volume(state),
                   inode=state.stat().st_ino, engine_id=engine_id, image_id=image_id)
    payload = (certificate['owner_token'] + ':' + image_id).encode('ascii')
    probe = json.loads(raw['.linux-native-probe.json'])
    if (raw['.linux-native-sentinel'] != payload or raw['.linux-native-restart'] != payload
            or hashlib.sha256(payload).hexdigest() != certificate.get('restart_expected_sha256')
            or probe.get('schema') != 'fullmag.linux-native-probe.v1'
            or probe.get('image_id') != image_id or probe.get('owner_token') != certificate['owner_token']
            or probe.get('host_attestation_sha256') != hashlib.sha256(raw[host.CERTIFICATE_NAME]).hexdigest()
            or not host.CHECKS.issubset(probe.get('checks', {}))
            or any(v is not True for v in probe['checks'].values())):
        raise BuildControlError('Retained sentinel/restart/probe evidence differs')
    return raw, certificate, new


def require_stopped(record):
    state = record.get('State', {})
    if (state.get('Running') is not False or state.get('Pid') != 0
            or state.get('Paused') or state.get('Restarting') or state.get('Dead')):
        raise BuildControlError('Storage re-attestation requires stopped application containers')


def _containers(previous, identity, state, image, excluded=None):
    from docker_volume_dev import _validate_retained_service
    document = identity['document']
    image_config = json.loads(docker_capture('image', 'inspect', image).stdout)[0]['Config']
    proofs = {}
    for service in ('backend', 'frontend'):
        identifier = previous[service + '_container']
        records = json.loads(docker_capture('inspect', identifier).stdout)
        if len(records) != 1:
            raise BuildControlError('Ambiguous retained container')
        record = records[0]
        require_stopped(record)
        labels = record.get('Config', {}).get('Labels', {})
        if (record.get('Id') != identifier or record.get('Image') != image
                or labels.get('com.docker.compose.project') != identity['project_name']
                or labels.get('com.docker.compose.service') != service
                or labels.get('org.fullmag.source.worktree-id') != identity['worktree_id']):
            raise BuildControlError('Retained container source/image/owner differs')
        _validate_retained_service(document, record, service, image_config)
        proofs[service] = {'id': identifier, 'state': record['State'],
                           'mounts_sha256': hashlib.sha256(canonical(record['Mounts'])).hexdigest()}
    ids = docker_capture('ps', '--quiet', '--no-trunc').stdout.decode().split()
    for identifier in ids:
        if identifier == excluded:
            continue
        row = json.loads(docker_capture('inspect', identifier).stdout)[0]
        labels = row.get('Config', {}).get('Labels', {})
        if (labels.get('com.docker.compose.project') == identity['project_name']
                or labels.get('org.fullmag.source.worktree-id') == identity['worktree_id']):
            raise BuildControlError('Selected group still has a live consumer')
        for mount in row.get('Mounts', []):
            if mount.get('Type') == 'bind':
                source = Path(mount['Source'])
                if source == state or state in source.parents or source in state.parents:
                    raise BuildControlError('A running container overlaps the retained session bind')
    return proofs


def run(args):
    if os.name == 'nt':
        raise BuildControlError('This operation is only for Linux/WSL device renumbering')
    if not re.fullmatch(r'[0-9a-f]{32}', args.attempt):
        raise BuildControlError('Exact retained development attempt required')
    from docker_dev import _select_source, _compose_identity
    selected, layout = _select_source(Path(args.repo_root).resolve(strict=True), args.source_root)
    identity = _compose_identity(layout)
    configured = toolchain_configuration(selected, identity)
    control = BuildControl(identity, configured['services']['fem-gpu-toolchain']['build']['args']['FULLMAG_CUDA_BASE_IMAGE'])
    control.prepare()
    previous = control.read('development/attempts/' + args.attempt + '/terminal.json')
    document = control.read('development/attempts/' + args.attempt + '/compose.json')
    if (previous.get('state') != 'succeeded' or previous.get('compose_project') != control.project
            or previous['inputs']['source_root'] != str(selected)
            or hashlib.sha256(canonical(document)).hexdigest() != args.config_sha256
            or document.get('name') != control.project):
        raise BuildControlError('Retained source/Compose/development proof differs')
    state = storage.validate_path(Path(previous['state_root']), layout['runtime_root'], 'retained Linux sessions')
    image = previous['inputs']['image_id']
    engine = docker_capture('info', '--format', '{{.ID}}').stdout.decode().strip()
    raw, old, new = _evidence(state, engine, image)
    context = {**identity, 'document': document}
    containers = _containers(previous, context, state, image)
    plan = {'schema': 'fullmag.linux-device-reattest.v1', 'source_root': str(selected),
            'attempt': args.attempt, 'config_sha256': args.config_sha256,
            'state_root': str(state), 'engine_id': engine, 'image_id': image,
            'old_host_device': old['host_device'], 'new_host_device': new['host_device'],
            'host_inode': old['host_inode'], 'containers': containers,
            'evidence_sha256': {k: hashlib.sha256(v).hexdigest() for k, v in raw.items()},
            'implementation_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in [Path(__file__), Path(host.__file__), Path(__file__).with_name('docker_dev.py')]}}
    digest = hashlib.sha256(canonical(plan)).hexdigest()
    if not args.apply:
        return {'state': 'validated-preview', 'plan_sha256': digest, 'plan': plan}
    if args.expected_plan_sha256 != digest:
        raise BuildControlError('Re-attestation plan changed; repeat the preview')
    with control.operation('linux-device-reattest', {'plan_sha256': digest, **plan}) as operation:
        excluded = operation['helper_container_id']
        if (_containers(previous, context, state, image, excluded) != containers
                or _evidence(state, engine, image)[0] != raw):
            raise BuildControlError('Re-attestation evidence changed under the control lease')
        control.write(operation['root'] + '/before.json', {'plan': plan, 'certificate': old,
            'raw_evidence_hex': {k: v.hex() for k, v in raw.items()}})
        probe_index = 0
        def probe(*unused, **kwargs):
            nonlocal probe_index
            probe_index += 1
            name = 'fullmag-storage-probe-' + operation['receipt']['attempt'] + '-' + str(probe_index)
            operation['daemon_pending'] = True
            result = docker_capture('run', '--rm', '--name', name,
                '--label', 'org.fullmag.recovery.operation=' + operation['receipt']['attempt'],
                '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--user', '65532:65532', '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
                '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m',
                '--mount', 'type=bind,src=' + str(state) + ',dst=/state',
                '--mount', 'type=bind,src=' + str(state / host.CERTIFICATE_NAME) + ',dst=/run/fullmag/linux-native-host.json,readonly',
                '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'FULLMAG_RUNTIME_IMAGE_ID=' + image,
                '--env', 'FULLMAG_DOCKER_HOST_ID=' + hashlib.sha256(engine.encode()).hexdigest(),
                '--entrypoint', '/usr/local/bin/python3', image, '-c',
                'import sys;sys.path.insert(0,"/opt/fullmag");from linux_native_probe import run;run(False)', timeout=120, allow_failure=True)
            observed = docker_capture('inspect', name, allow_failure=True)
            if observed.returncode == 0:
                records = json.loads(observed.stdout)
                if (len(records) != 1 or records[0].get('Image') != image
                        or records[0].get('Config', {}).get('Labels', {}).get('org.fullmag.recovery.operation') != operation['receipt']['attempt']):
                    raise BuildControlError('Storage probe process identity is unknown')
                require_stopped(records[0])
            elif ('no such object: ' + name) not in observed.stderr.decode().lower():
                raise BuildControlError('Storage probe termination could not be confirmed')
            operation['daemon_pending'] = False
            if result.returncode:
                raise BuildControlError('Storage-only probe failed: ' + result.stderr.decode()[-1200:])
            return result.stdout.decode()
        try:
            host.write_bound_evidence(state / host.CERTIFICATE_NAME, new)
            host.publish_evidence(state / host.OWNER_NAME, new)
            host.complete_preflight(probe, 'storage-only-probe', state, state / host.CERTIFICATE_NAME,
                                    new, log_writer=lambda message: None)
        except Exception:
            if operation['daemon_pending']:
                # A timeout is not a terminal probe. Preserve the journal and
                # exact new/old evidence until its named process is reconciled.
                raise
            host.write_bound_evidence(state / host.CERTIFICATE_NAME, old)
            for name, value in raw.items():
                if name != host.CERTIFICATE_NAME:
                    host.publish_bytes(state / name, value)
            raise
        if (any(new.get(k) != v for k, v in local_volume(state).items())
                or state.stat().st_ino != old['host_inode']):
            raise BuildControlError('Host directory changed during re-attestation')
        after = host.read_owned_regular(state / host.CERTIFICATE_NAME)
        control.write(operation['root'] + '/after.json', {'certificate': new,
            'certificate_sha256': hashlib.sha256(after).hexdigest(), 'storage_probe_count': probe_index})
        operation['receipt'].update(state='succeeded', certificate_sha256=hashlib.sha256(after).hexdigest(),
                                    storage_probe_count=probe_index)
    return {'state': 'succeeded', 'plan_sha256': digest,
            'operation_attempt': operation['receipt']['attempt'], 'certificate_sha256': hashlib.sha256(after).hexdigest()}
