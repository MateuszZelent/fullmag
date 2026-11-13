"""Copy two drained datasets to the authenticated new ext4, never retire them.

The managed parent must hold the host/group lease and the five live native
copy fences until this process has a confirmed terminal receipt. Persisted
fence/drain evidence binds this operation; it does not itself hold those locks.
No bind switch, admission, registration, source deletion, or solver occurs here.
"""
from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat

import linux_data_volume_provision as qualification
from fullmag_data_volume_fs import archive_and_extract
from fullmag_data_volume_guard import _open_directory_nofollow, resolve_mount_uuid
from fullmag_data_volume_journal import append_started, append_terminal, next_phase
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
from linux_data_volume_format import _document, _publish_journal


SCHEMA = 'fullmag.data-volume-linux-copy-request.v1'
COMPONENTS = ('linux_data_volume_copy.py', 'fullmag_data_volume_fs.py',
              'fullmag_data_volume_manifest.py', 'fullmag_data_volume_guard.py',
              'fullmag_data_volume.py',
              'fullmag_data_volume_journal.py', 'fullmag_data_volume_linux_request.py',
              'linux_data_volume_provision.py', 'linux_data_volume_format.py',
              'fullmag_data_volume_runtime_binding.py')
REQUEST_KEYS = {'schema', 'volume_id', 'storage_root', 'token', 'linux_request_sha256',
                'provision_result_sha256', 'drain_sha256', 'fence_ready_sha256', 'components'}


def validate_request(value):
    require = qualification.require
    require(type(value) is dict and set(value) == REQUEST_KEYS and value['schema'] == SCHEMA,
            'Closed root copy request required')
    for key in ('volume_id', 'token'):
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{32}', value[key]) and
                value[key] != '0'*32, 'Exact nonzero copy identity required')
    for key in ('linux_request_sha256', 'provision_result_sha256', 'drain_sha256', 'fence_ready_sha256'):
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{64}', value[key]),
                'Exact copy evidence SHA required')
    from fullmag_data_volume_linux_request import _path
    _path(value['storage_root'], 'copy storage root')
    require(type(value['components']) is dict and set(value['components']) == set(COMPONENTS) and
            all(type(v) is str and re.fullmatch('[0-9a-f]{64}', v) for v in value['components'].values()),
            'Exact root copy component pins required')
    return value


def _components(request):
    directory = Path(__file__).parent
    for name in COMPONENTS:
        raw = qualification._read_optional_regular(directory/name, 'root copy source', maximum=4*1024**2)
        qualification.require(raw is not None and qualification.digest(raw) == request['components'][name],
                              'Root copy source changed: '+name)


def _source_roots(linux):
    roots = {}
    for role, pin in linux['source_roots'].items():
        root = Path(pin['canonical_root'])
        fd = _open_directory_nofollow(root)
        try:
            metadata = os.fstat(fd)
            qualification.require((metadata.st_dev, metadata.st_ino) == (pin['device'], pin['inode']),
                                  'Original copy dataset identity changed: '+role)
        finally:
            os.close(fd)
        roots[role] = root
    return roots


def _mounted_root(linux, provision):
    """Read-only authentication of the exact formatter-owned mount and marker."""
    target = Path(linux['mount_root'])
    observed = qualification._capture(['findmnt', '--json', '--target', str(target),
        '--output', 'TARGET,FSTYPE,UUID,MAJ:MIN,OPTIONS'])
    rows = json.loads(observed.stdout).get('filesystems')
    qualification.require(type(rows) is list and len(rows) == 1, 'One exact copy destination mount required')
    row = rows[0]
    qualification.require(type(row) is dict and 'uuid' in row and 'UUID' not in row,
                          'Copy destination mount must report exactly one UUID field')
    if row['uuid'] is None:
        row = dict(row)
        row['uuid'] = resolve_mount_uuid(target, None, major_minor=row.get('maj:min'))
    else:
        qualification.require(type(row['uuid']) is str and bool(row['uuid']),
                              'Copy destination mount UUID must be a nonempty string')
    qualification.require(row.get('target') == str(target) and row.get('fstype') == 'ext4' and
        row.get('uuid') == linux['filesystem_uuid'] and
        row.get('maj:min') == provision['filesystem']['mount']['maj:min'] and
        {'rw','nodev','nosuid'} <= set(row.get('options', '').split(',')),
        'Copy destination filesystem identity or mount options changed')
    fd = _open_directory_nofollow(target)
    try:
        m = os.fstat(fd)
        qualification.require(m.st_uid == 0 and not stat.S_IMODE(m.st_mode) & 0o022 and
            (m.st_dev, m.st_ino) == (provision['filesystem']['device'], provision['filesystem']['inode']) and
            all(m.st_dev != p['device'] for p in linux['source_roots'].values()),
            'Copy destination is not the exact protected new filesystem')
    finally:
        os.close(fd)
    _, marker = qualification._read(target/'.fullmag-user-data-volume.json')
    expected = {'schema':'fullmag.user-data-volume-identity.v1', 'volume_id':linux['volume_id'],
        'filesystem_uuid':linux['filesystem_uuid'], 'created_receipt_sha256':linux['created_receipt_sha256'],
        'attached_receipt_sha256':linux['attached_receipt_sha256'],
        'controller_sha256':linux['controller_sha256'], 'data_migrated':False}
    qualification.require(marker == expected, 'New-volume ownership marker differs')
    return target


def validate_held_fence(held,token,volume_id,process_receipt_sha256):
    """Authenticate the common five-guard snapshot; the caller holds it live."""
    qualification.require(set(held) == {'schema','state','token','volume_id','observation'} and
        held['schema'] == 'fullmag.data-copy-fence-event.v1' and held['state'] == 'held' and
        held['volume_id'] == volume_id and held['token'] == token and
        held['observation'].get('schema') == 'fullmag.data-volume-copy-fences.v1' and
        held['observation'].get('authentication',{}).get('process_receipt_sha256') == process_receipt_sha256 and
        held['observation'].get('authentication',{}).get('released',{}).get('active_count') == 0,
        'Held copy-fence evidence differs from the terminal native drain')
    locks = held['observation'].get('locks')
    expected = ['/opt/fullmag/runtime-control/runtime-services/'+k+'.lock' for k in ('STARTUP-GATE','LAUNCH','OWNER')]
    expected += ['/host-ledger/ledger/WRITER.lock','/state/runs/docker-all/session-store/WRITER.lock']
    qualification.require(type(locks) is list and len(locks) == 5 and
        [p.get('path') for p in locks] == expected and
        all(set(p) == {'path','device','inode'} and all(type(p[k]) is int and p[k] > 0 for k in ('device','inode')) for p in locks) and
        len({(p['device'],p['inode']) for p in locks}) == 5, 'All five distinct copy locks must be pinned')


def validate_result(result,request,linux,request_sha256):
    """Authenticate one completed copy without granting switch authority."""
    require=qualification.require
    require(type(result) is dict and set(result) == {'schema','state','volume_id','token','request_sha256',
        'filesystem_uuid','data_sha256','manifest_path','manifest_sha256','archive_path','archive_sha256',
        'copied_roots','namespace_admitted','originals_retired'} and
        result['schema'] == 'fullmag.data-volume-linux-copy-result.v1' and
        result['state'] == 'copied-and-verified-not-switched' and result['volume_id'] == request['volume_id'] and
        result['token'] == request['token'] and result['request_sha256'] == request_sha256 and
        result['namespace_admitted'] is False and result['originals_retired'] is False,
        'Root copy success scope differs')
    target=Path(linux['mount_root']);archive=target/'migration'/request['volume_id']
    copies={role:str(target/'payload'/Path(pin['canonical_root']).relative_to(linux['storage_root']))
            for role,pin in linux['source_roots'].items()}
    require(result['filesystem_uuid'] == linux['filesystem_uuid'] and
        result['manifest_path'] == str(archive/'source-manifest.json') and
        result['archive_path'] == str(archive/'originals.pax') and result['copied_roots'] == copies and
        all(type(result[k]) is str and re.fullmatch('[0-9a-f]{64}',result[k])
            for k in ('data_sha256','manifest_sha256','archive_sha256')),
        'Root copy terminal paths or content pins differ')
    return result


def load_context(request_path, request_sha256, *, completed_receipt_sha256=None):
    """Authenticate inputs or an explicit completed copy, without mutation.

    The completed view cannot re-enter copy_verified: its journal must already
    have advanced. It only supplies the authenticated inputs for a later stage.
    """
    qualification.require(os.name == 'posix' and os.geteuid() == 0, 'Host root required for metadata-preserving copy')
    qualification.require(type(request_sha256) is str and re.fullmatch('[0-9a-f]{64}', request_sha256),
                          'Exact root copy request SHA required')
    qualification.require(completed_receipt_sha256 is None or
        (type(completed_receipt_sha256) is str and re.fullmatch('[0-9a-f]{64}',completed_receipt_sha256)),
        'Exact completed copy receipt SHA required')
    _, raw_request = qualification._read(Path(request_path), request_sha256)
    request = validate_request(raw_request)
    _components(request)
    op = Path(request['storage_root'])/'migrations/data-volumes'/request['volume_id']
    qualification.require(Path(request_path) == op/'linux-copy-request.json', 'Copy request escapes its selected operation')
    _, linux_raw = qualification._read(op/'linux-provision-request.json', request['linux_request_sha256'])
    linux = validate_linux_request(linux_raw)
    qualification.require(linux['volume_id'] == request['volume_id'] and
                          linux['storage_root'] == request['storage_root'], 'Copy Linux provision scope differs')
    host = qualification.probe_host()
    qualification.require(host['boot_id'] == linux['boot_id'], 'Copy must use the provisioned WSL boot and namespace')
    plan_raw, plan, _binding = load_plan(op, linux)
    qualification.require(plan.get('volume_id') == request['volume_id'] and
        plan.get('storage_root') == linux['storage_root'] and plan.get('mount_root') == linux['mount_root'] and
        plan.get('observation', {}).get('datasets') == linux['source_roots'], 'Copy plan source scope differs')
    _, provision = qualification._read(op/'linux-provision-result.json', request['provision_result_sha256'])
    qualification.require(provision.get('schema') == 'fullmag.data-volume-linux-provision-result.v1' and
        provision.get('state') == 'mounted-not-data-migrated' and
        provision.get('volume_id') == linux['volume_id'] and provision.get('filesystem_uuid') == linux['filesystem_uuid'] and
        provision.get('linux_request_sha256') == request['linux_request_sha256'] and
        provision.get('formatter_sha256') == request['components']['linux_data_volume_format.py'] and
        provision.get('namespace_admitted') is False, 'Formatter terminal receipt differs')
    _, drain = qualification._read(op/'group-drained.json', request['drain_sha256'])
    qualification.require(set(drain) == {'schema','volume_id','token','plan_sha256','source_roots',
        'stop_attempt','stop_sha256','process_receipt_sha256','containers'} and
        drain['schema'] == 'fullmag.data-volume-group-drained.v1' and drain['volume_id'] == request['volume_id'] and
        drain['token'] == request['token'] and drain['plan_sha256'] == qualification.digest(plan_raw) and
        drain['source_roots'] == linux['source_roots'] and
        type(drain['containers']) is dict and set(drain['containers']) == {'backend','frontend'} and
        all(drain['containers'][k] == plan['runtime_pins'][k] for k in drain['containers']),
        'Managed drain belongs to another copy scope')
    qualification.require(type(drain['stop_attempt']) is str and re.fullmatch('[0-9a-f]{32}',drain['stop_attempt']) and
        all(type(drain[k]) is str and re.fullmatch('[0-9a-f]{64}',drain[k])
            for k in ('stop_sha256','process_receipt_sha256')), 'Exact managed stop pins required')
    _, held = qualification._read(op/'copy-fence-ready.json', request['fence_ready_sha256'])
    validate_held_fence(held,request['token'],request['volume_id'],drain['process_receipt_sha256'])
    journal_path, journal = qualification._selected_journal(op)
    qualification.require(journal['volume_id'] == request['volume_id'] and
        journal['request_sha256'] == qualification.digest(plan_raw), 'Copy journal belongs to another original plan')
    if completed_receipt_sha256 is None:
        qualification.require(next_phase(journal) == 'copy-verified' and
            journal['events'][-1]['phase'] == 'group-drained' and
            journal['events'][-1]['receipt_sha256'] == request['drain_sha256'],
            'Copy requires a completed formatter and managed group drain')
        result=None
    else:
        qualification.require(next_phase(journal) == 'binds-switched' and
            journal['events'][-1]['phase'] == 'copy-verified' and
            journal['events'][-1]['inputs_sha256'] == request_sha256 and
            journal['events'][-1]['receipt_sha256'] == completed_receipt_sha256 and
            not os.path.lexists(op/'linux-copy-failed.json'),
            'Completed copy must match the exact successful journal terminal')
        _,result=qualification._read(op/'linux-copy-result.json',completed_receipt_sha256)
        result=validate_result(result,request,linux,request_sha256)
    drained=[e for e in journal['events'] if e['phase'] == 'group-drained' and e['state'] == 'succeeded']
    qualification.require(len(drained) == 1 and drained[0]['receipt_sha256'] == request['drain_sha256'],
                          'Managed drain is not the journalled copy predecessor')
    mounted = next((e for e in journal['events'] if e['phase'] == 'ext4-mounted' and e['state'] == 'succeeded'), None)
    qualification.require(mounted is not None and mounted['receipt_sha256'] == request['provision_result_sha256'],
                          'Formatter result is not the journalled mounted volume')
    roots = _source_roots(linux)
    target = _mounted_root(linux, provision)
    return {'request':request,'linux':linux,'operation_root':op,'journal_path':journal_path,
            'journal':journal,'roots':roots,'target':target,'provision':provision,
            'plan':plan,'plan_sha256':qualification.digest(plan_raw),'drain':drain,'copy_result':result}


@contextmanager
def _operation_lock(op):
    parent = _open_directory_nofollow(op)
    lock = None
    try:
        lock = os.open('linux-copy.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                       0o600, dir_fd=parent)
        m = os.fstat(lock)
        qualification.require(stat.S_ISREG(m.st_mode) and m.st_nlink == 1 and
            m.st_uid in (0,os.fstat(parent).st_uid) and not stat.S_IMODE(m.st_mode) & 0o022,
            'Unsafe copy operation lock')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        if lock is not None:os.close(lock)
        os.close(parent)


def _new_directory(parent, name):
    fd = _open_directory_nofollow(parent)
    try:
        m = os.fstat(fd)
        qualification.require(m.st_uid == 0 and not stat.S_IMODE(m.st_mode) & 0o022,
                              'New migration namespace must have a protected root-owned parent')
        os.mkdir(name, mode=0o700, dir_fd=fd)
        created = os.stat(name, dir_fd=fd, follow_symlinks=False)
        child = _open_directory_nofollow(parent/name)
        try:
            actual = os.fstat(child)
            qualification.require((actual.st_dev,actual.st_ino) == (created.st_dev,created.st_ino) and
                actual.st_dev == m.st_dev and actual.st_uid == 0 and stat.S_IMODE(actual.st_mode) == 0o700 and
                not os.listdir(child), 'New migration namespace was replaced')
        finally:os.close(child)
        os.fsync(fd)
    finally:os.close(fd)


def copy_verified(request_path, request_sha256):
    context = load_context(request_path, request_sha256)
    op, request = context['operation_root'], context['request']
    with _operation_lock(op):
        # Reauthenticate after acquiring the copy mutex, including no replay.
        fresh = load_context(request_path, request_sha256)
        qualification.require(fresh == context, 'Copy context changed before its lock')
        target = context['target']; archive_root = target/'migration'/request['volume_id']
        for path in (op/'linux-copy-started.json',op/'linux-copy-result.json',op/'linux-copy-failed.json',
                     target/'payload',target/'migration'):
            qualification.require(not os.path.lexists(path), 'Copy target already exists; reconcile, never replay')
        started = append_started(context['journal'], 'copy-verified', request_sha256)
        _publish_journal(context['journal_path'], context['journal'], started)
        result_written = False
        try:
            _document(op, 'linux-copy-started.json', {'schema':'fullmag.data-volume-copy-started.v1',
                'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256})
            _new_directory(target, 'migration');_new_directory(target/'migration', request['volume_id'])
            # Full metadata-aware manifest + PAX archive + independent re-read.
            copied = archive_and_extract(request['storage_root'], context['roots'],
                                         archive_root/'originals.pax', target/'payload')
            _source_roots(context['linux']);_mounted_root(context['linux'],context['provision'])
            manifest_sha = _document(archive_root,'source-manifest.json',copied['source_manifest'])
            result = {'schema':'fullmag.data-volume-linux-copy-result.v1','state':'copied-and-verified-not-switched',
                'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256,
                'filesystem_uuid':context['linux']['filesystem_uuid'],'data_sha256':copied['data_sha256'],
                'manifest_path':str(archive_root/'source-manifest.json'),'manifest_sha256':manifest_sha,
                'archive_path':copied['archive_path'],'archive_sha256':copied['archive_sha256'],
                'copied_roots':copied['copied_roots'],'namespace_admitted':False,'originals_retired':False}
            result_sha = _document(op,'linux-copy-result.json',result);result_written = True
            _publish_journal(context['journal_path'],started,append_terminal(started,'succeeded',result_sha))
            return result
        except BaseException as error:
            state = ('failed-confirmed' if isinstance(error,Exception) and not result_written
                     else 'outcome-unknown-resources-retained')
            failure = {'schema':'fullmag.data-volume-linux-copy-failure.v1','state':state,
                'volume_id':request['volume_id'],'token':request['token'],'request_sha256':request_sha256,
                'error_type':type(error).__name__,'originals_and_partial_copy_retained':True}
            failure_sha = _document(op,'linux-copy-failed.json',failure)
            _, journal_now = qualification._read(context['journal_path'])
            if journal_now == started:
                _publish_journal(context['journal_path'],started,append_terminal(started,state,failure_sha))
            raise


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    parser.add_argument('--request-sha256', required=True)
    args = parser.parse_args(argv)
    print(json.dumps(copy_verified(args.request,args.request_sha256),sort_keys=True))


if __name__ == '__main__':
    main()
