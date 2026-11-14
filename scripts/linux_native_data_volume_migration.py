"""Prepare copied StateRoot admission under a separately authenticated migration.

The managed caller must hold the exact group/owner/store guards, authenticate a
terminal drain witness and independently verify both copied datasets. Hash pins
alone do not prove those facts. This module grants no runtime namespace, starts
nothing, and deliberately does not broaden the same-inode reboot readmission.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
from uuid import UUID

import linux_native_host as host
from docker_dev_host import local_volume

SCHEMA = 'fullmag.linux-native-data-migration-preparation.v1'
_PIN_KEYS = {'state_root', 'mount_root', 'volume_id', 'filesystem_uuid', 'engine_id',
             'owner_token', 'image_id', 'source_binding_sha256', 'source_device',
             'source_inode', 'observed_device', 'observed_inode', 'source_data_sha256',
             'copied_data_sha256', 'drained_witness_sha256', 'files'}
_PREPARATION_KEYS = {'schema', 'pins', 'original_files', 'candidate',
                     'candidate_raw_base64', 'candidate_sha256', 'certificate_inode',
                     'namespace_admitted'}
_HEX64 = re.compile(r'[0-9a-f]{64}\Z')
_HEX32 = re.compile(r'[0-9a-f]{32}\Z')


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n').encode()


def filesystem_uuid(path):
    observed = subprocess.check_output(
        ['findmnt', '--noheadings', '--output', 'UUID', '--target', str(path)],
        text=True, timeout=15,
    ).strip().splitlines()
    if len(observed) != 1:
        raise ValueError('Migration filesystem UUID is not one observation')
    value = observed[0].strip()
    if str(UUID(value)) != value or UUID(value).int == 0:
        raise ValueError('Migration filesystem UUID is not canonical')
    return value


def _validate_pins(state, pins, original):
    if type(pins) is not dict or set(pins) != _PIN_KEYS or pins['state_root'] != str(state):
        raise ValueError('Migration pins differ from the closed state contract')
    for key in ('volume_id', 'owner_token'):
        if type(pins[key]) is not str or not _HEX32.fullmatch(pins[key]) or set(pins[key]) == {'0'}:
            raise ValueError('Migration identity token differs')
    for key in ('source_binding_sha256', 'source_data_sha256', 'copied_data_sha256',
                'drained_witness_sha256'):
        if type(pins[key]) is not str or not _HEX64.fullmatch(pins[key]):
            raise ValueError('Migration requires exact copy/drain/source digests')
    if pins['source_data_sha256'] != pins['copied_data_sha256']:
        raise ValueError('Migration copied data differ from the source manifest')
    if (type(pins['engine_id']) is not str or not 0 < len(pins['engine_id']) <= 256 or
            type(pins['image_id']) is not str or
            re.fullmatch(r'sha256:[0-9a-f]{64}', pins['image_id']) is None):
        raise ValueError('Migration engine or image identity differs')
    for key in ('source_device', 'source_inode', 'observed_device', 'observed_inode'):
        if type(pins[key]) is not int or pins[key] <= 0:
            raise ValueError('Migration device and inode pins must be positive integers')
    if pins['source_device'] == pins['observed_device']:
        raise ValueError('Data volume migration requires a different filesystem device')
    try:
        if str(UUID(pins['filesystem_uuid'])) != pins['filesystem_uuid'] or UUID(pins['filesystem_uuid']).int == 0:
            raise ValueError('Migration UUID differs')
    except (TypeError, AttributeError) as error:
        raise ValueError('Migration UUID differs') from error
    mount_root = host.storage.absolute(pins['mount_root'], 'Migration mount root')
    if state == mount_root or state in mount_root.parents or mount_root in state.parents:
        raise ValueError('Migration mount view and canonical state must be disjoint')
    if type(pins['files']) is not dict or set(pins['files']) != set(host.READMISSION_FILES):
        raise ValueError('Migration requires all five original admission file hashes')
    if type(original) is not dict or set(original) != set(host.READMISSION_FILES):
        raise ValueError('Migration original admission evidence differs')
    for name in host.READMISSION_FILES:
        raw = original[name]
        if (type(raw) is not bytes or not 0 < len(raw) <= 1024**2 or
                type(pins['files'][name]) is not str or not _HEX64.fullmatch(pins['files'][name]) or
                _sha(raw) != pins['files'][name]):
            raise ValueError('Migration original admission bytes changed')
    certificate = host._readmission_json(original[host.CERTIFICATE_NAME])
    if (host._readmission_json(original[host.OWNER_NAME]) != certificate or
            certificate.get('schema') != host.HOST_SCHEMA or certificate.get('storage_profile') != host.PROFILE or
            certificate.get('role') != 'session' or certificate.get('owner_scope') != 'docker-linux' or
            certificate.get('restart_verified') is not True or certificate.get('host_root') != str(state) or
            certificate.get('host_device') != pins['source_device'] or
            certificate.get('host_inode') != pins['source_inode'] or
            any(certificate.get(k) != pins[k] for k in ('engine_id', 'owner_token', 'image_id')) or
            host.readmission_source_binding_sha256(certificate) != pins['source_binding_sha256']):
        raise ValueError('Migration predecessor owner or source provenance differs')
    native = local_volume(state)
    current = state.stat()
    if (current.st_dev != pins['observed_device'] or current.st_ino != pins['observed_inode'] or
            native.get('host_device') != pins['observed_device'] or native.get('host_root') != str(state) or
            native.get('host_filesystem') != 'ext4' or native.get('host_platform') != 'linux' or
            native.get('host_root_no_reparse') is not True or
            any(certificate.get(k) != v for k, v in native.items() if k != 'host_device') or
            filesystem_uuid(state) != pins['filesystem_uuid'] or
            filesystem_uuid(mount_root) != pins['filesystem_uuid'] or
            mount_root.stat().st_dev != current.st_dev):
        raise ValueError('Migration observed filesystem or copied root identity differs')
    payload = (pins['owner_token'] + ':' + pins['image_id']).encode('ascii')
    probe = host._readmission_json(original['.linux-native-probe.json'])
    if (original['.linux-native-sentinel'] != payload or original['.linux-native-restart'] != payload or
            certificate.get('restart_expected_sha256') != _sha(payload) or
            probe.get('schema') != 'fullmag.linux-native-probe.v1' or
            probe.get('storage_profile') != host.PROFILE or probe.get('owner_token') != pins['owner_token'] or
            probe.get('image_id') != pins['image_id'] or probe.get('root_inode') != pins['source_inode'] or
            probe.get('host_attestation_sha256') != pins['files'][host.CERTIFICATE_NAME] or
            type(probe.get('checks')) is not dict or set(probe['checks']) != host.CHECKS or
            any(v is not True for v in probe['checks'].values())):
        raise ValueError('Migration historical namespace evidence differs')
    candidate = dict(certificate, host_device=current.st_dev, host_inode=current.st_ino,
                     restart_verified=False)
    return candidate, _encoded(candidate)


def _certificate_identity(state):
    return host._readmission_certificate_inode(state)


def prepare_state_migration(state, pins):
    """Read-only, JSON-serializable successor preparation; not admission."""
    state = host.storage.absolute(state, 'Migration canonical state')
    original = {n: host.read_owned_regular(state / n) for n in host.READMISSION_FILES}
    candidate, raw = _validate_pins(state, pins, original)
    return {'schema': SCHEMA, 'pins': copy.deepcopy(pins),
            'original_files': {n: {'sha256': _sha(b), 'base64': base64.b64encode(b).decode('ascii')}
                               for n, b in original.items()},
            'candidate': candidate, 'candidate_raw_base64': base64.b64encode(raw).decode('ascii'),
            'candidate_sha256': _sha(raw), 'certificate_inode': _certificate_identity(state),
            'namespace_admitted': False}


def _validate_preparation(state, prepared):
    if (type(prepared) is not dict or set(prepared) != _PREPARATION_KEYS or
            prepared['schema'] != SCHEMA or prepared['namespace_admitted'] is not False):
        raise ValueError('Migration preparation schema differs')
    encoded = prepared['original_files']
    if type(encoded) is not dict or set(encoded) != set(host.READMISSION_FILES):
        raise ValueError('Migration archived original set differs')
    original = {}
    for name, item in encoded.items():
        if type(item) is not dict or set(item) != {'sha256', 'base64'} or type(item['base64']) is not str or len(item['base64']) > 2*1024**2:
            raise ValueError('Migration encoded evidence is invalid')
        try:
            raw = base64.b64decode(item['base64'], validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError('Migration evidence base64 differs') from error
        if _sha(raw) != item['sha256']:
            raise ValueError('Migration encoded evidence digest differs')
        original[name] = raw
    candidate, raw = _validate_pins(state, prepared['pins'], original)
    if (prepared['candidate'] != candidate or prepared['candidate_sha256'] != _sha(raw) or
            prepared['candidate_raw_base64'] != base64.b64encode(raw).decode('ascii') or
            prepared['certificate_inode'] != _certificate_identity(state)):
        raise ValueError('Migration candidate or certificate bind changed')
    current = {n: host.read_owned_regular(state / n) for n in host.READMISSION_FILES}
    if any(current[n] != original[n] for n in host.READMISSION_FILES[2:]):
        raise ValueError('Migration protected historical namespace evidence changed')
    pair = current[host.CERTIFICATE_NAME], current[host.OWNER_NAME]
    if pair == (original[host.CERTIFICATE_NAME], original[host.OWNER_NAME]):
        phase = 'original'
    elif pair == (original[host.CERTIFICATE_NAME], raw):
        phase = 'marker-published'
    elif pair == (raw, raw):
        phase = 'prepared'
    else:
        raise ValueError('Migration certificate/owner pair is foreign or torn')
    return raw, phase


def apply_state_migration(state, prepared, archive_path, archive_sha256):
    """Publish only an archived, guarded successor; a fresh probe is mandatory."""
    state = host.storage.absolute(state, 'Migration canonical state')
    if type(archive_sha256) is not str or not _HEX64.fullmatch(archive_sha256):
        raise ValueError('Migration archive digest differs')
    raw, phase = _validate_preparation(state, prepared)
    pins = prepared['pins']
    expected = Path(pins['mount_root']) / 'migration' / pins['volume_id'] / 'state-admission.json'
    if str(archive_path) != str(expected):
        raise ValueError('Migration archive path differs from the new volume')
    archived = host.read_owned_regular(expected, maximum=16*1024**2)
    if (_sha(archived) != archive_sha256 or host._readmission_json(archived) != prepared or
            expected.stat().st_dev != state.stat().st_dev or
            filesystem_uuid(expected) != pins['filesystem_uuid']):
        raise ValueError('Migration archived preparation differs or is not on the new volume')
    if phase == 'original':
        host.publish_bytes(state / host.OWNER_NAME, raw)
    if phase != 'prepared':
        host.write_bound_evidence(state / host.CERTIFICATE_NAME, prepared['candidate'])
    _, final_phase = _validate_preparation(state, prepared)
    if final_phase != 'prepared':
        raise ValueError('Migration successor did not reach the prepared phase')
    return {'schema': SCHEMA, 'state': 'prepared-not-admitted', 'namespace_admitted': False,
            'certificate_sha256': _sha(raw), 'previous_phase': phase}
