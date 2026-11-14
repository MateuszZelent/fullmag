"""Finish proof of one already-mounted new ext4; never format, mount or copy.

The previous failed attempt and its artifacts remain immutable. A separate
recovery journal must inherit its successful Create/Attach prefix. The isolated
root bootstrap authenticates the entire component graph before imports.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import stat

import linux_data_volume_provision as qualification
import linux_data_volume_format as formatting
from fullmag_data_volume_guard import _open_directory_nofollow, filesystem_uuid_from_fd
from fullmag_data_volume_journal import append_started, append_terminal, validate_journal
from fullmag_data_volume_linux_request import validate_linux_request, _path


SCHEMA = 'fullmag.data-volume-mounted-recovery-request.v1'
COMPONENTS = ('linux_data_volume_recover.py', 'linux_data_volume_format.py',
              'linux_data_volume_provision.py', 'fullmag_data_volume_guard.py',
              'fullmag_data_volume_fs.py', 'fullmag_data_volume_manifest.py',
              'fullmag_data_volume.py', 'fullmag_data_volume_journal.py',
              'fullmag_data_volume_linux_request.py', 'fullmag_data_volume_runtime_binding.py')
DIGEST_KEYS = ('linux_request_sha256', 'failed_journal_sha256', 'format_inputs_sha256',
               'format_started_sha256', 'format_failure_sha256', 'selector_sha256',
               'recovery_journal_sha256')
REQUEST_KEYS = {'schema', 'volume_id', 'storage_root', 'token',
                'failed_journal_relative', 'components', *DIGEST_KEYS}


def validate_request(value):
    need = qualification.require
    need(type(value) is dict and set(value) == REQUEST_KEYS and value['schema'] == SCHEMA,
         'Closed mounted-volume recovery request required')
    for key in ('volume_id', 'token'):
        need(type(value[key]) is str and re.fullmatch('[0-9a-f]{32}', value[key]) and
             value[key] != '0'*32, 'Exact nonzero recovery identity required')
    for key in DIGEST_KEYS:
        need(type(value[key]) is str and re.fullmatch('[0-9a-f]{64}', value[key]),
             'Exact recovery evidence SHA required')
    _path(value['storage_root'], 'recovery storage root')
    need(type(value['failed_journal_relative']) is str and
         re.fullmatch(r'recovery/[0-9a-f]{32}/journal\.json', value['failed_journal_relative']) and
         value['failed_journal_relative'] != 'recovery/'+value['token']+'/journal.json',
         'Exact distinct failed predecessor required')
    need(type(value['components']) is dict and set(value['components']) == set(COMPONENTS) and
         all(type(v) is str and re.fullmatch('[0-9a-f]{64}', v)
             for v in value['components'].values()), 'Exact root recovery component pins required')
    return value


def _components(request):
    for name, expected in request['components'].items():
        raw = qualification._read_optional_regular(Path(__file__).parent/name,
                    'root recovery component', maximum=4*1024**2)
        qualification.require(raw is not None and qualification.digest(raw) == expected,
                              'Recovery component source changed: '+name)


def load_context(path, expected_sha256):
    """Read-only authentication of the failed and new journal branches."""
    need = qualification.require
    need(type(expected_sha256) is str and re.fullmatch('[0-9a-f]{64}', expected_sha256),
         'Exact root recovery request SHA required')
    _, raw = qualification._read(Path(path), expected_sha256)
    request = validate_request(raw)
    op = Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    attempt = op/'recovery'/request['token']
    need(Path(path) == attempt/'mounted-recovery-request.json', 'Recovery request escapes its attempt')
    _components(request)
    _, raw_linux = qualification._read(op/'linux-provision-request.json', request['linux_request_sha256'])
    linux = validate_linux_request(raw_linux)
    need(linux['volume_id'] == request['volume_id'] and linux['storage_root'] == request['storage_root'] and
         linux['controller_sha256'] == request['components']['linux_data_volume_provision.py'],
         'Recovery changed the original Linux scope or controller')
    _, selector = qualification._read(op/'active-attempt.json', request['selector_sha256'])
    need(selector.get('schema') == 'fullmag.data-volume-active-recovery.v2' and
         selector.get('attempt') == request['token'] and
         selector.get('parent_journal_relative') == request['failed_journal_relative'] and
         selector.get('parent_journal_sha256') == request['failed_journal_sha256'],
         'Recovery selector differs from its exact failed predecessor')
    _, failed = qualification._read(op/request['failed_journal_relative'], request['failed_journal_sha256'])
    failed = validate_journal(failed)
    _, prefix = qualification._read(attempt/'journal.json', request['recovery_journal_sha256'])
    prefix = validate_journal(prefix)
    need(len(failed['events']) == 6 and len(prefix['events']) == 4 and
         prefix == dict(failed, events=failed['events'][:4]),
         'Recovery must preserve exactly the successful Create/Attach prefix')
    _, inputs = qualification._read(op/'linux-format-inputs.json', request['format_inputs_sha256'])
    need(type(inputs) is dict and set(inputs) == {'linux_request_sha256', 'formatter_sha256'} and
         inputs['linux_request_sha256'] == request['linux_request_sha256'] and
         type(inputs['formatter_sha256']) is str and re.fullmatch('[0-9a-f]{64}', inputs['formatter_sha256']),
         'Original formatter inputs differ')
    _, started = qualification._read(op/'linux-format-started.json', request['format_started_sha256'])
    need(type(started) is dict and set(started) == {*inputs, 'device'} and
         all(started[k] == v for k, v in inputs.items()), 'Original format-started evidence differs')
    _, failure = qualification._read(op/'linux-provision-failed.json', request['format_failure_sha256'])
    need(failure == dict(inputs, schema='fullmag.data-volume-linux-provision-failure.v1',
         state='failed-confirmed', volume_id=linux['volume_id'], error_type='ValueError',
         image_and_partial_filesystem_retained=True), 'A confirmed original qualification failure is required')
    event_start, event_end = failed['events'][-2:]
    need(event_start['phase'] == event_end['phase'] == 'ext4-mounted' and
         event_start['inputs_sha256'] == event_end['inputs_sha256'] == request['format_inputs_sha256'] and
         event_end['state'] == 'failed-confirmed' and
         event_end['receipt_sha256'] == request['format_failure_sha256'],
         'Failed journal does not authenticate the original format failure')
    baseline, journal_path, journal = qualification.load_lineage(linux, op)
    need(journal_path == attempt/'journal.json' and journal == prefix,
         'Active recovery journal changed')
    for artifact in ('linux-provision-result.json',):
        need(not os.path.lexists(op/artifact), 'Provision result already exists; recovery cannot replay')
    for artifact in ('mounted-recovery-started.json', 'mounted-recovery-failed.json'):
        need(not os.path.lexists(attempt/artifact), 'Recovery already started; reconcile, never replay')
    return {'request': request, 'linux': linux, 'operation_root': op, 'attempt_root': attempt,
            'baseline': baseline, 'journal_path': journal_path, 'journal': journal,
            'device': started['device'], 'original_formatter_sha256': inputs['formatter_sha256']}


def _mounted_row(ready):
    linux, device = ready['request'], ready['device']
    target = Path(linux['mount_root'])
    probe = qualification._capture(['findmnt', '--json', '--mountpoint', str(target), '--output',
                      'TARGET,FSROOT,FSTYPE,UUID,MAJ:MIN,OPTIONS,PROPAGATION'])
    rows = json.loads(probe.stdout).get('filesystems')
    qualification.require(type(rows) is list and len(rows) == 1 and type(rows[0]) is dict,
                          'One exact existing ext4 mount required')
    row = rows[0]
    qualification.require(row.get('target') == str(target) and row.get('fsroot') == '/' and
        row.get('fstype') == 'ext4' and 'uuid' in row and 'UUID' not in row and
        row['uuid'] in (None, linux['filesystem_uuid']) and
        row.get('maj:min') == device['maj:min'] and row.get('propagation') == 'private' and
        {'rw', 'nodev', 'nosuid'} <= set(row.get('options', '').split(',')),
        'Existing new mount identity, UUID, options or propagation differs')
    return row


def _check_pinned_root(ready):
    _mounted_row(ready)
    root = ready['root_descriptor']
    metadata = os.fstat(root)
    qualification.require(metadata.st_ino == 2 and
        metadata.st_dev == os.fstat(ready['descriptor']).st_rdev and
        filesystem_uuid_from_fd(root) == ready['request']['filesystem_uuid'],
        'Pinned new filesystem root changed')
    formatting._verify_root_path(Path(ready['request']['mount_root']), root)


@contextmanager
def _empty_mounted_root(ready):
    """Hold the unused filesystem root FD through marker/result publication."""
    linux = ready['request']
    target = Path(linux['mount_root'])
    _mounted_row(ready)
    root = _open_directory_nofollow(target)
    try:
        before = os.fstat(root)
        qualification.require(before.st_dev == os.fstat(ready['descriptor']).st_rdev and
            before.st_ino == 2 and before.st_uid == 0 and not stat.S_IMODE(before.st_mode) & 0o022 and
            filesystem_uuid_from_fd(root) == linux['filesystem_uuid'],
            'Existing mount is not the protected root of the exact new filesystem')
        qualification.require(os.listdir(root) == ['lost+found'],
                              'Existing new filesystem contains data or a prior marker')
        child = os.open('lost+found', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            metadata = os.fstat(child)
            qualification.require(metadata.st_dev == before.st_dev and metadata.st_uid == 0 and
                stat.S_IMODE(metadata.st_mode) == 0o700 and not os.listdir(child),
                'New filesystem lost+found is not protected and empty')
        finally:
            os.close(child)
        fresh = _open_directory_nofollow(target)
        try:
            after = os.fstat(fresh)
            qualification.require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino),
                                  'Existing mount changed during recovery qualification')
        finally:
            os.close(fresh)
        yield root
    finally:
        os.close(root)


@contextmanager
def prepared_recovery(context):
    linux, selected = context['linux'], context['device']
    current = qualification.probe_host()
    qualification.require(current['boot_id'] == linux['boot_id'] and
        current['mount_namespace'] == context['baseline']['mount_namespace'],
        'Host boot or persistent namespace changed')
    qualification._source_identities(linux)
    devices = list(qualification._device_tree(current['devices']))
    matches = [d for d in devices if d.get('path') == selected.get('path')]
    qualification.require(len(matches) == 1, 'Original new block device is absent or ambiguous')
    observed = matches[0]
    qualification.require(all(observed.get(k) == selected.get(k) for k in
        ('path', 'type', 'size', 'maj:min', 'serial')) and
        selected.get('type') == 'disk' and selected.get('size') == linux['capacity_bytes'] and
        type(selected.get('serial')) is str and bool(selected['serial']) and
        observed.get('ro') is False and not observed.get('children') and
        observed.get('fstype') == 'ext4' and observed.get('uuid') == linux['filesystem_uuid'] and
        [d.get('path') for d in devices if d.get('uuid') == linux['filesystem_uuid']] == [selected['path']] and
        all(d.get('maj:min') != selected.get('maj:min') for d in
            qualification._device_tree(context['baseline']['devices'])),
        'New block device, serial, filesystem or Attach baseline differs')
    descriptor = qualification._open_device(selected, linux)
    try:
        probe = qualification._capture(['blkid', '-p', '-o', 'export', '/proc/self/fd/'+str(descriptor)],
                                        pass_fds=(descriptor,))
        values = dict(line.split('=', 1) for line in probe.stdout.decode('ascii').splitlines() if '=' in line)
        qualification.require(values.get('TYPE') == 'ext4' and values.get('UUID') == linux['filesystem_uuid'],
                              'Pinned block device filesystem differs')
        ready = {'request': linux, 'device': selected, 'descriptor': descriptor}
        with _empty_mounted_root(ready) as root:
            yield dict(ready, root_descriptor=root)
    finally:
        os.close(descriptor)


def recover_mounted(path, expected_sha256):
    qualification.require(os.name == 'posix' and os.geteuid() == 0, 'Persistent host root required')
    # Parse only enough to locate the existing operation lock; load_context
    # authenticates every field and artifact again while that lock is held.
    _, raw = qualification._read(Path(path), expected_sha256)
    request = validate_request(raw)
    op = Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    with formatting._operation_lock(op):
        context = load_context(path, expected_sha256)
        with prepared_recovery(context) as ready:
            started = append_started(context['journal'], 'ext4-mounted', expected_sha256)
            formatting._publish_journal(context['journal_path'], context['journal'], started)
            try:
                formatting._document(context['attempt_root'], 'mounted-recovery-started.json',
                    {'schema': 'fullmag.data-volume-mounted-recovery-started.v1',
                     'volume_id': request['volume_id'], 'request_sha256': expected_sha256,
                     'formatted': False, 'mounted': False})
                _check_pinned_root(ready)
                filesystem = formatting._qualify_mounted_volume(ready)
                _check_pinned_root(ready)
                result = {'schema': 'fullmag.data-volume-linux-provision-result.v1',
                    'state': 'mounted-not-data-migrated', 'volume_id': request['volume_id'],
                    'filesystem_uuid': context['linux']['filesystem_uuid'], 'device': context['device'],
                    'filesystem': filesystem, 'namespace_admitted': False,
                    'linux_request_sha256': request['linux_request_sha256'],
                    'formatter_sha256': request['components']['linux_data_volume_format.py'],
                    'completion_mode': 'recovered-existing-filesystem',
                    'original_formatter_sha256': context['original_formatter_sha256'],
                    'original_failure_sha256': request['format_failure_sha256'],
                    'recovery_request_sha256': expected_sha256}
                result_sha = formatting._document(op, 'linux-provision-result.json', result)
                _check_pinned_root(ready)
                formatting._publish_journal(context['journal_path'], started,
                                            append_terminal(started, 'succeeded', result_sha))
                print(json.dumps(result, sort_keys=True), flush=True)
                return result
            except BaseException as error:
                state = 'failed-confirmed' if isinstance(error, Exception) else 'outcome-unknown-resources-retained'
                failure_sha = formatting._document(context['attempt_root'], 'mounted-recovery-failed.json',
                    {'schema': 'fullmag.data-volume-mounted-recovery-failure.v1', 'state': state,
                     'volume_id': request['volume_id'], 'request_sha256': expected_sha256,
                     'error_type': type(error).__name__, 'image_and_partial_filesystem_retained': True})
                formatting._publish_journal(context['journal_path'], started,
                                            append_terminal(started, state, failure_sha))
                raise
