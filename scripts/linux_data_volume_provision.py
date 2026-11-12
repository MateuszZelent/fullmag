"""Qualify one newly attached empty VHDX in the persistent WSL host namespace.

This module never selects a caller-supplied device path. Create/Attach lineage,
an inventory saved before Attach, the current boot/namespace and original data
identities must agree before a new empty disk is selected. The CLI currently
exposes read-only probe/preflight; formatting is a separate guarded stage.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from uuid import UUID

from fullmag_data_volume_fs import select_new_empty_device
from fullmag_data_volume_guard import (_open_directory_nofollow, _parse_object,
                                      _read_optional_regular)
from fullmag_data_volume_journal import next_phase, validate_journal
from fullmag_data_volume_linux_request import validate_linux_request


MAX_BYTES = 4 * 1024**2
DEVICE_COLUMNS = 'NAME,PATH,TYPE,SIZE,FSTYPE,UUID,RO,MOUNTPOINTS,MAJ:MIN,SERIAL'
READ_TOOLS = {'lsblk': '/usr/bin/lsblk', 'blockdev': '/usr/sbin/blockdev',
              'wipefs': '/usr/sbin/wipefs', 'blkid': '/usr/sbin/blkid',
              'findmnt': '/usr/bin/findmnt'}
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C'}


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _read(path, expected=None):
    raw = _read_optional_regular(Path(path), 'Linux provision evidence', maximum=MAX_BYTES)
    require(raw is not None, 'Required Linux provision evidence is absent')
    if expected is not None:
        require(digest(raw) == expected, 'Linux provision evidence SHA changed: ' + str(path))
    return raw, _parse_object(raw, 'Linux provision evidence')


def _capture(argv, *, pass_fds=(), allowed=(0,)):
    require(argv and argv[0] in READ_TOOLS, 'Only fixed read-only device probes are allowed')
    result = subprocess.run([READ_TOOLS[argv[0]], *argv[1:]], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            pass_fds=pass_fds, env=ENV, timeout=30)
    require(result.returncode in allowed and len(result.stdout) + len(result.stderr) <= MAX_BYTES,
             'Read-only device probe failed: ' + argv[0])
    return result


def probe_host():
    require(os.name == 'posix' and os.geteuid() == 0, 'Linux host root is required for device proofs')
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    namespace = os.readlink('/proc/self/ns/mnt')
    pid1 = os.readlink('/proc/1/ns/mnt')
    require(namespace == pid1 and not Path('/.dockerenv').exists(),
             'Provisioning requires the persistent host namespace, outside a container/sandbox')
    raw = _capture(['lsblk', '--json', '--bytes', '--tree', '--output', DEVICE_COLUMNS]).stdout
    devices = json.loads(raw).get('blockdevices')
    require(type(devices) is list and devices, 'Kernel block inventory is unavailable')
    return {'schema': 'fullmag.linux-block-inventory.v1', 'uid': os.geteuid(),
            'boot_id': boot, 'mount_namespace': namespace, 'pid1_mount_namespace': pid1,
            'devices': devices}


def _selected_journal(op):
    reference_raw = _read_optional_regular(op/'active-attempt.json', 'recovery selector')
    if reference_raw is None:
        path = op/'journal.json'
    else:
        reference = _parse_object(reference_raw, 'recovery selector')
        version = reference.get('schema')
        keys = {'schema', 'volume_id', 'attempt', 'journal_relative', 'parent_journal_sha256', 'state'}
        require(type(version) is str and version in {'fullmag.data-volume-active-recovery.v1',
                            'fullmag.data-volume-active-recovery.v2'}, 'Unsupported recovery selector')
        if version.endswith('.v2'):
            keys.add('parent_journal_relative')
        require(set(reference) == keys and reference['state'] == 'started' and
                 reference['volume_id'] == op.name and type(reference['attempt']) is str and
                 re.fullmatch(r'[0-9a-f]{32}', reference['attempt']) is not None,
                 'Exact recovery selector required')
        require(reference['journal_relative'] == 'recovery/'+reference['attempt']+'/journal.json',
                 'Recovery selector escapes its exact attempt')
        require(type(reference['parent_journal_sha256']) is str and
                 re.fullmatch(r'[0-9a-f]{64}', reference['parent_journal_sha256']) is not None,
                 'Exact parent journal SHA required')
        parent_relative = reference.get('parent_journal_relative', 'journal.json')
        require(type(parent_relative) is str and
                 (parent_relative == 'journal.json' or
                  re.fullmatch(r'recovery/[0-9a-f]{32}/journal\.json', parent_relative)) and
                 parent_relative != reference['journal_relative'],
                 'Recovery predecessor path escapes its exact attempt')
        _, parent = _read(op/parent_relative, reference['parent_journal_sha256'])
        parent = validate_journal(parent)
        require(parent['volume_id'] == op.name and parent['events'] and
                 parent['events'][-1]['state'] == 'failed-confirmed',
                 'Recovery must preserve its exact failed predecessor')
        path = op/reference['journal_relative']
    _, journal = _read(path)
    journal = validate_journal(journal)
    if reference_raw is not None:
        require(parent['request_sha256'] == journal['request_sha256'],
                 'Recovery changed the immutable migration request')
    return path, journal


def load_lineage(request, op):
    plan_raw, plan = _read(op/'plan.json')
    journal_path, journal = _selected_journal(op)
    require(journal['volume_id'] == request['volume_id'] and
             journal['request_sha256'] == digest(plan_raw) and next_phase(journal) == 'ext4-mounted',
             'Attach must have succeeded and ext4 provisioning must not have started')
    require(plan.get('volume_id') == request['volume_id'] and
             plan.get('storage_root') == request['storage_root'] and
             plan.get('mount_root') == request['mount_root'] and
             plan.get('observation', {}).get('datasets') == request['source_roots'],
             'Linux request differs from the exact original data scope')
    _, provision = _read(op/'provision-request.json', request['provision_request_sha256'])
    require(plan.get('provision_request') == provision,
             'Actual provision payload differs from the planned Windows request')
    _, created = _read(op/'created.json', request['created_receipt_sha256'])
    _, attached = _read(op/'attached.json', request['attached_receipt_sha256'])
    common = 'fullmag.wsl-data-volume-platform-result.v1'
    for evidence, state in ((created, 'created'), (attached, 'attached-not-formatted')):
        require(evidence.get('schema') == common and evidence.get('state') == state and
                 evidence.get('volume_id') == request['volume_id'] and
                 evidence.get('request_sha256') == request['provision_request_sha256'],
                 'Windows create/attach lineage differs')
    require(provision.get('schema') == 'fullmag.wsl-data-volume-provision.v1' and
             provision.get('volume_id') == request['volume_id'] and
             provision.get('storage_root_wsl') == request['storage_root'] and
             provision.get('capacity_bytes') == request['capacity_bytes'] and
             attached.get('create_receipt_sha256') == request['created_receipt_sha256'],
             'Windows request scope or create receipt changed')
    for field in ('path', 'disk_identifier', 'capacity_bytes', 'creation_utc_ticks'):
        require(created.get('image', {}).get(field) == attached.get('image', {}).get(field),
                 'Attached image differs from the newly created image')
    require(created.get('image', {}).get('path') == provision.get('backing_file_windows') and
             created.get('image', {}).get('capacity_bytes') == request['capacity_bytes'],
             'New image identity/capacity differs')
    disk_id = created['image'].get('disk_identifier')
    require(type(disk_id) is str and str(UUID(disk_id)) == disk_id and UUID(disk_id).int != 0,
             'New image has no canonical nonzero disk identifier')
    for phase, sha in (('image-created', request['created_receipt_sha256']),
                       ('image-attached', request['attached_receipt_sha256'])):
        terminals = [e for e in journal['events'] if e['phase'] == phase and e['state'] == 'succeeded']
        require(len(terminals) == 1 and terminals[0]['receipt_sha256'] == sha,
                 'Journal terminal receipt differs from the authenticated platform receipt')
    attempt = journal_path.parent
    _, baseline = _read(attempt/'baseline-devices.json', request['baseline_sha256'])
    _, attach_inputs = _read(attempt/'attach-inputs.json', request['attach_inputs_sha256'])
    starts = [e for e in journal['events'] if e['phase'] == 'image-attached' and e['state'] == 'started']
    require(len(starts) == 1 and starts[0]['inputs_sha256'] == request['attach_inputs_sha256'],
             'Baseline was not pinned before this attach')
    for key in ('provision_request_sha256', 'created_receipt_sha256', 'baseline_sha256', 'boot_id'):
        require(attach_inputs.get(key) == request[key], 'Attach input changed: ' + key)
    require(baseline.get('schema') == 'fullmag.linux-block-inventory.v1' and
             type(baseline.get('uid')) is int and baseline.get('uid') == 0 and
             baseline.get('boot_id') == request['boot_id'] and
             baseline.get('mount_namespace') == baseline.get('pid1_mount_namespace'),
             'Baseline is not a host-root inventory from this boot')
    return baseline, journal_path, journal


def _source_identities(request):
    for entry in request['source_roots'].values():
        descriptor = _open_directory_nofollow(Path(entry['canonical_root']))
        try:
            observed = os.fstat(descriptor)
            require((observed.st_dev, observed.st_ino) == (entry['device'], entry['inode']),
                     'Original dataset identity or host namespace changed')
        finally:
            os.close(descriptor)


def _open_device(selected, request):
    path = Path(selected['path'])
    require(path.parent == Path('/dev') and re.fullmatch(r'sd[a-z]+', path.name),
             'Only the exactly selected new SCSI disk is supported')
    before = path.lstat()
    require(stat.S_ISBLK(before.st_mode), 'New device is not a direct block node')
    expected = selected.get('maj:min')
    require(expected == str(os.major(before.st_rdev))+':'+str(os.minor(before.st_rdev)),
             'Block-node and kernel major/minor differ')
    protected = {v['device'] for v in request['source_roots'].values()} | {os.stat('/').st_dev}
    require(before.st_rdev not in protected, 'Original/root filesystem cannot be formatted')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(descriptor)
        require(stat.S_ISBLK(opened.st_mode) and
                 (opened.st_dev, opened.st_ino, opened.st_rdev) ==
                 (before.st_dev, before.st_ino, before.st_rdev), 'Device node changed while opening')
        size = _capture(['blockdev', '--getsize64', '/proc/self/fd/'+str(descriptor)],
                         pass_fds=(descriptor,)).stdout.strip()
        require(int(size) == request['capacity_bytes'], 'Opened block device has wrong capacity')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _empty_device(descriptor):
    path = '/proc/self/fd/'+str(descriptor)
    result = _capture(['wipefs', '--no-act', '--json', path], pass_fds=(descriptor,))
    data = json.loads(result.stdout)
    require(type(data) is dict and data.get('signatures') == [], 'Device contains existing signatures')
    result = _capture(['blkid', '-p', '-o', 'export', path], pass_fds=(descriptor,), allowed=(0, 2, 8))
    require(result.returncode == 2 and not result.stdout.strip(),
             'Device has a filesystem, ambiguous signature, or unproven empty state')


def _device_tree(devices):
    for device in devices:
        yield device
        yield from _device_tree(device.get('children') or [])


@contextmanager
def prepared_device(request_path, expected_sha256):
    require(os.name == 'posix' and os.geteuid() == 0, 'Only host root can qualify the new device')
    require(type(expected_sha256) is str and re.fullmatch(r'[0-9a-f]{64}', expected_sha256),
             'Exact Linux request SHA required')
    _, value = _read(Path(request_path), expected_sha256)
    request = validate_linux_request(value)
    require(request['controller_sha256'] == digest(Path(__file__).read_bytes()),
             'Provision controller source changed')
    op = Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    require(Path(request_path) == op/'linux-provision-request.json',
             'Linux request must be at its exact operational path')
    baseline, journal_path, journal = load_lineage(request, op)
    current = probe_host()
    require(current['boot_id'] == request['boot_id'] and
             current['mount_namespace'] == baseline['mount_namespace'],
             'Host boot or persistent mount namespace changed')
    _source_identities(request)
    require(not os.path.lexists(request['mount_root']), 'New mount root already exists; recover instead')
    require(all(d.get('uuid') != request['filesystem_uuid'] for d in _device_tree(current['devices'])),
             'Requested new filesystem UUID already exists')
    selected = select_new_empty_device(baseline['devices'], current['devices'], request['capacity_bytes'])
    descriptor = _open_device(selected, request)
    try:
        _empty_device(descriptor)
        yield {'request': request, 'operation_root': op, 'journal_path': journal_path,
               'journal': journal, 'device': selected, 'descriptor': descriptor,
               'mount_namespace': current['mount_namespace']}
    finally:
        os.close(descriptor)


def preflight(request_path, expected_sha256):
    with prepared_device(request_path, expected_sha256) as ready:
        request = ready['request']
        return {'schema': 'fullmag.data-volume-linux-preflight.v1', 'state': 'verified-read-only',
                'volume_id': request['volume_id'], 'device': ready['device'],
                'filesystem_uuid_requested': request['filesystem_uuid'],
                'mount_root': request['mount_root'], 'mount_namespace': ready['mount_namespace'],
                'mutated': False, 'formatted': False, 'mounted': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['probe', 'preflight'])
    parser.add_argument('--request')
    parser.add_argument('--request-sha256')
    args = parser.parse_args(argv)
    if args.command == 'probe':
        result = probe_host()
    else:
        require(args.request and args.request_sha256, 'Exact request path and SHA required')
        result = preflight(args.request, args.request_sha256)
    print(json.dumps(result, sort_keys=True, ensure_ascii=False))


if __name__ == '__main__':
    main()
