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
from fullmag_data_volume_fs import archive_and_extract, requalify_existing_copy
from fullmag_data_volume_guard import _open_directory_nofollow, resolve_mount_uuid
from fullmag_data_volume_journal import append_started, append_terminal, next_phase, validate_journal
from fullmag_data_volume_linux_request import validate_linux_request
from fullmag_data_volume_runtime_binding import load_plan
from linux_data_volume_format import _document, _publish_journal, _encoded


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


RECOVERY_SCHEMA = 'fullmag.data-volume-copy-recovery-request.v1'
RECOVERY_DIGESTS = ('original_copy_request_sha256','failed_copy_receipt_sha256',
                    'failed_journal_sha256','selector_sha256','recovery_journal_sha256','fence_ready_sha256')
RECOVERY_KEYS = {'schema','volume_id','storage_root','token','failed_journal_relative','components',*RECOVERY_DIGESTS}


def validate_recovery_request(value):
    require = qualification.require
    require(type(value) is dict and set(value) == RECOVERY_KEYS and value['schema'] == RECOVERY_SCHEMA,
            'Closed root copy recovery request required')
    for key in ('volume_id','token'):
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{32}',value[key]) and value[key] != '0'*32,
                'Exact nonzero recovery identity required')
    for key in RECOVERY_DIGESTS:
        require(type(value[key]) is str and re.fullmatch('[0-9a-f]{64}',value[key]),
                'Exact copy recovery evidence SHA required')
    from fullmag_data_volume_linux_request import _path
    _path(value['storage_root'],'copy recovery storage root')
    require(type(value['failed_journal_relative']) is str and
        re.fullmatch(r'recovery/[0-9a-f]{32}/journal\.json',value['failed_journal_relative']) and
        value['failed_journal_relative'] != 'recovery/'+value['token']+'/journal.json',
        'Exact distinct failed copy predecessor required')
    require(type(value['components']) is dict and set(value['components']) == set(COMPONENTS) and
        all(type(v) is str and re.fullmatch('[0-9a-f]{64}',v) for v in value['components'].values()),
        'Exact root copy recovery component pins required')
    return value


RECOVERY_PROBE_SCHEMA = 'fullmag.data-volume-copy-recovery-probe.v1'


def validate_recovery_probe_request(value):
    qualification.require(type(value) is dict and set(value) == RECOVERY_KEYS and
        value['schema'] == RECOVERY_PROBE_SCHEMA, 'Closed root copy recovery probe request required')
    validate_recovery_request(dict(value,schema=RECOVERY_SCHEMA))
    return value


def _recovery_evidence(op, original, recovery, recovery_sha256, *, completed_result=None, probe=False):
    """Authenticate immutable failure, selector, prefix and fresh held ack."""
    require = qualification.require
    request = validate_recovery_request(recovery)
    require(request['volume_id'] == original['volume_id'] and request['storage_root'] == original['storage_root'] and
            request['token'] != original['token'], 'Recovery changed the original copy scope or reused its token')
    _, pinned_original = qualification._read(op/'linux-copy-request.json',request['original_copy_request_sha256'])
    require(pinned_original == original, 'Recovery original copy request differs')
    _, failure = qualification._read(op/'linux-copy-failed.json',request['failed_copy_receipt_sha256'])
    require(type(failure) is dict and set(failure) == {'schema','state','volume_id','token','request_sha256',
        'error_type','originals_and_partial_copy_retained'} and
        failure['schema'] == 'fullmag.data-volume-linux-copy-failure.v1' and failure['state'] == 'failed-confirmed' and
        failure['volume_id'] == original['volume_id'] and failure['token'] == original['token'] and
        failure['request_sha256'] == request['original_copy_request_sha256'] and
        type(failure['error_type']) is str and re.fullmatch('[A-Za-z_][A-Za-z0-9_]*',failure['error_type']) and
        failure['originals_and_partial_copy_retained'] is True, 'Confirmed original copy failure required')
    _, original_started = qualification._read(op/'linux-copy-started.json')
    require(original_started == {'schema':'fullmag.data-volume-copy-started.v1','volume_id':original['volume_id'],
        'token':original['token'],'request_sha256':request['original_copy_request_sha256']},
        'Original copy start evidence differs')
    _, failed = qualification._read(op/request['failed_journal_relative'],request['failed_journal_sha256'])
    failed = validate_journal(failed)
    require(failed['volume_id'] == original['volume_id'] and len(failed['events']) == 10,
            'Exact failed copy journal required')
    start,end = failed['events'][-2:]
    require(start['phase'] == end['phase'] == 'copy-verified' and
        start['inputs_sha256'] == end['inputs_sha256'] == request['original_copy_request_sha256'] and
        end['state'] == 'failed-confirmed' and end['receipt_sha256'] == request['failed_copy_receipt_sha256'],
        'Failed copy terminal differs from its request and receipt')
    prefix = validate_journal(dict(failed,events=failed['events'][:8]))
    require(next_phase(prefix) == 'copy-verified' and
        prefix['events'][-1]['receipt_sha256'] == original['drain_sha256'] and
        qualification.digest(_encoded(prefix)) == request['recovery_journal_sha256'],
        'Recovery must preserve exactly the successful eight-event drain prefix')
    _, selector = qualification._read(op/'active-attempt.json',request['selector_sha256'])
    attempt = op/'recovery'/request['token']
    journal_path,journal = qualification._selected_journal(op)
    if probe:
        # The failed parent remains selected until this read-only root client
        # has a real terminal. The host later performs its selector CAS.
        _,previous = qualification._read(attempt/'previous-active-attempt.json',request['selector_sha256'])
        require(previous == selector and journal_path == op/request['failed_journal_relative'] and
            journal == failed, 'Copy recovery probe requires the exact selected failed parent')
        _,current = qualification._read(attempt/'journal.json',request['recovery_journal_sha256'])
        require(current == prefix, 'Copy recovery probe prefix differs from the exact drain prefix')
    else:
        require(selector == {'schema':'fullmag.data-volume-active-recovery.v2','volume_id':original['volume_id'],
            'attempt':request['token'],'journal_relative':'recovery/'+request['token']+'/journal.json',
            'parent_journal_relative':request['failed_journal_relative'],
            'parent_journal_sha256':request['failed_journal_sha256'],'state':'started'},
            'Copy recovery selector differs from its failed predecessor')
        require(journal_path == attempt/'journal.json' and journal['request_sha256'] == prefix['request_sha256'] and
            journal['events'][:8] == prefix['events'], 'Selected copy recovery journal prefix differs')
    if completed_result is None and not probe:
        _,current = qualification._read(journal_path,request['recovery_journal_sha256'])
        require(current == prefix, 'Copy recovery journal already advanced; never replay')
    elif completed_result is not None:
        result = completed_result
        _, recovery_started = qualification._read(attempt/'copy-recovery-started.json')
        require(recovery_started == {'schema':'fullmag.data-volume-copy-recovery-started.v1',
            'volume_id':original['volume_id'],'token':request['token'],'request_sha256':recovery_sha256,
            'original_copy_request_sha256':request['original_copy_request_sha256']} and
            not os.path.lexists(attempt/'copy-recovery-failed.json'),
            'Recovered copy must have one confirmed start and no recovery failure')
        require(result.get('recovery_request_sha256') == recovery_sha256 and
            result.get('failed_copy_receipt_sha256') == request['failed_copy_receipt_sha256'] and
            result.get('request_sha256') == request['original_copy_request_sha256'] and len(journal['events']) >= 10,
            'Completed recovery lineage differs')
        result_raw,persisted = qualification._read(op/'linux-copy-result.json')
        require(persisted == result and journal['events'][8:10] ==
            append_terminal(append_started(prefix,'copy-verified',recovery_sha256),'succeeded',
                            qualification.digest(result_raw))['events'][8:10],
            'Completed recovery journal terminal differs')
    _,drain = qualification._read(op/'group-drained.json',original['drain_sha256'])
    if probe:
        # This observation runs before acquiring fresh native fences. Only the
        # immutable historical witness is authenticated; it grants no authority.
        require(request['fence_ready_sha256'] == original['fence_ready_sha256'],
                'Copy recovery probe must pin the original historical fence witness')
        _,held = qualification._read(op/'copy-fence-ready.json',original['fence_ready_sha256'])
        validate_held_fence(held,original['token'],original['volume_id'],drain['process_receipt_sha256'])
    else:
        _,held = qualification._read(attempt/'fence-ready.json',request['fence_ready_sha256'])
        validate_held_fence(held,request['token'],original['volume_id'],drain['process_receipt_sha256'])
    return {'request':request,'attempt_root':attempt,'journal_path':journal_path,'journal':journal}


def require_current_copy_components(source, op, original_request, result):
    """Require the exact current v1 graph or authenticated v2 recovery graph."""
    original = validate_request(original_request)
    op = Path(op)
    qualification.require(op == Path(original['storage_root'])/'migrations/data-volumes'/original['volume_id'],
                          'Copy component operation scope differs')
    _,linux = qualification._read(op/'linux-provision-request.json',original['linux_request_sha256'])
    validate_result(result,original,validate_linux_request(linux),result.get('request_sha256'))
    if result.get('schema') == 'fullmag.data-volume-linux-copy-result.v1':
        qualification.require(not os.path.lexists(op/'linux-copy-failed.json'),
                              'Original copy failure requires explicit authenticated v2 recovery')
        graph = original['components']
    else:
        qualification.require(result.get('schema') == 'fullmag.data-volume-linux-copy-result.v2' and
            type(result.get('recovery_request_sha256')) is str and
            re.fullmatch('[0-9a-f]{64}',result['recovery_request_sha256']), 'Closed copy result version required')
        # The selected token is read through the closed selector; the full
        # request reauthenticates its exact hash, predecessor and selected path.
        _,selector = qualification._read(op/'active-attempt.json')
        token = selector.get('attempt')
        qualification.require(type(token) is str and re.fullmatch('[0-9a-f]{32}',token),
                              'Exact selected recovery token required')
        _,raw = qualification._read(op/'recovery'/token/'copy-recovery-request.json',result['recovery_request_sha256'])
        evidence = _recovery_evidence(op,original,raw,result['recovery_request_sha256'],completed_result=result)
        graph = evidence['request']['components']
    for name,expected in graph.items():
        raw = qualification._read_optional_regular(Path(source)/'scripts'/name,'current copy component',maximum=4*1024**2)
        qualification.require(raw is not None and qualification.digest(raw) == expected,
                              'Root copy source changed: '+name)
    return graph


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
    v2 = type(result) is dict and result.get('schema') == 'fullmag.data-volume-linux-copy-result.v2'
    extra = {'completion_mode','recovery_request_sha256','failed_copy_receipt_sha256'} if v2 else set()
    require(type(result) is dict and set(result) == extra | {'schema','state','volume_id','token','request_sha256',
        'filesystem_uuid','data_sha256','manifest_path','manifest_sha256','archive_path','archive_sha256',
        'copied_roots','namespace_admitted','originals_retired'} and
        result['schema'] in ('fullmag.data-volume-linux-copy-result.v1','fullmag.data-volume-linux-copy-result.v2') and
        result['state'] == 'copied-and-verified-not-switched' and result['volume_id'] == request['volume_id'] and
        result['token'] == request['token'] and result['request_sha256'] == request_sha256 and
        result['namespace_admitted'] is False and result['originals_retired'] is False,
        'Root copy success scope differs')
    if v2:
        require(result['completion_mode'] == 'requalified-existing-archive-and-payload' and
            all(type(result[k]) is str and re.fullmatch('[0-9a-f]{64}',result[k])
                for k in ('recovery_request_sha256','failed_copy_receipt_sha256')),
            'Recovered copy completion evidence differs')
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


def _original_context(request_path, request_sha256):
    """Read immutable original scope and mount identity, without phase authority.

    Callers separately authenticate either the original current graph or the
    closed recovery graph and exact journal transition before any mutation.
    """
    qualification.require(os.name == 'posix' and os.geteuid() == 0, 'Host root required for metadata-preserving copy')
    qualification.require(type(request_sha256) is str and re.fullmatch('[0-9a-f]{64}', request_sha256),
                          'Exact root copy request SHA required')
    _, raw_request = qualification._read(Path(request_path), request_sha256)
    request = validate_request(raw_request)
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
            'plan':plan,'plan_sha256':qualification.digest(plan_raw),'drain':drain}


def load_context(request_path, request_sha256, *, completed_receipt_sha256=None):
    """Authenticate a new copy or exact completed v1/v2, never replay recovery."""
    qualification.require(completed_receipt_sha256 is None or
        (type(completed_receipt_sha256) is str and re.fullmatch('[0-9a-f]{64}',completed_receipt_sha256)),
        'Exact completed copy receipt SHA required')
    context = _original_context(request_path,request_sha256)
    request,op,journal = context['request'],context['operation_root'],context['journal']
    if completed_receipt_sha256 is None:
        _components(request)
        qualification.require(next_phase(journal) == 'copy-verified' and
            journal['events'][-1]['phase'] == 'group-drained' and
            journal['events'][-1]['receipt_sha256'] == request['drain_sha256'],
            'Copy requires a completed formatter and managed group drain')
        result = None
    else:
        _, result = qualification._read(op/'linux-copy-result.json',completed_receipt_sha256)
        result = validate_result(result,request,context['linux'],request_sha256)
        require_current_copy_components(Path(__file__).parent.parent,op,request,result)
        inputs = result.get('recovery_request_sha256',request_sha256)
        qualification.require(next_phase(journal) == 'binds-switched' and
            journal['events'][-1]['phase'] == 'copy-verified' and
            journal['events'][-1]['inputs_sha256'] == inputs and
            journal['events'][-1]['receipt_sha256'] == completed_receipt_sha256 and
            (result['schema'].endswith('.v2') or not os.path.lexists(op/'linux-copy-failed.json')),
            'Completed copy must match the exact successful journal terminal')
    return dict(context,copy_result=result)


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
                     op/'source-manifest-export.json',
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
            # Keep the PAX and native admission archive behind root-only
            # directories. The unprivileged host parent authenticates this
            # byte-identical metadata export against the same receipt digest.
            export_sha = _document(op,'source-manifest-export.json',copied['source_manifest'])
            qualification.require(export_sha == manifest_sha, 'Source manifest export differs from its private original')
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


def _require_recovery_targets(context, recovery, attempt_root):
    """Shared read-only preconditions, before CAS and again before start."""
    require = qualification.require
    op = context['operation_root']
    plan = context['plan']
    index = op.parents[2]/'index/data-volumes'
    require(type(plan.get('worktree_id')) is str and re.fullmatch('[a-z0-9._-]{1,128}',plan['worktree_id']),
            'Exact original worktree identity required')
    for name in (plan['worktree_id']+'.pending.json',plan['worktree_id']+'.json'):
        require(not os.path.lexists(index/name), 'Pending or registered migration blocks copy recovery')
    archive = context['target']/'migration'/recovery['volume_id']
    for path in (op/'linux-copy-result.json',op/'source-manifest-export.json',archive/'source-manifest.json',
                 archive/('recovery-verification-'+recovery['token']),
                 attempt_root/'copy-recovery-started.json',
                 attempt_root/'copy-recovery-failed.json'):
        require(not os.path.lexists(path), 'Copy recovery artifact exists; reconcile, never replay')
    # Check every bind event, not only the first one; no partial switch is safe.
    require(not any(p.name.startswith(('linux-bind-','linux-admission-')) for p in op.iterdir()),
            'Bind or admission artifacts block copy recovery')


def probe_recovery(path, expected_sha256):
    """Observe preconditions before fresh fences/CAS; grants no copy authority.

    Recovery must repeat its full authentication under fresh native guards.
    This observation never creates a copied scope or a completed-copy receipt.
    """
    require = qualification.require
    require(os.name == 'posix' and os.geteuid() == 0,'Host root required for copy recovery probe')
    require(type(expected_sha256) is str and re.fullmatch('[0-9a-f]{64}',expected_sha256),
            'Exact copy recovery probe request SHA required')
    _,raw = qualification._read(Path(path),expected_sha256)
    probe = validate_recovery_probe_request(raw)
    op = Path(probe['storage_root'])/'migrations/data-volumes'/probe['volume_id']
    attempt = op/'recovery'/probe['token']
    require(Path(path) == attempt/'copy-recovery-probe-request.json',
            'Copy recovery probe request escapes its exact attempt')
    _components(probe)
    context = _original_context(op/'linux-copy-request.json',probe['original_copy_request_sha256'])
    recovery = dict(probe,schema=RECOVERY_SCHEMA)
    evidence = _recovery_evidence(op,context['request'],recovery,expected_sha256,probe=True)
    require(context['journal'] == evidence['journal'],'Copy recovery probe selected parent changed')
    _require_recovery_targets(context,recovery,attempt)
    return {'schema':'fullmag.data-volume-copy-recovery-probe-result.v1','state':'ready-for-copy-recovery',
        'volume_id':probe['volume_id'],'token':probe['token'],'request_sha256':expected_sha256,
        'original_copy_request_sha256':probe['original_copy_request_sha256'],
        'failed_copy_receipt_sha256':probe['failed_copy_receipt_sha256'],
        'filesystem_uuid':context['linux']['filesystem_uuid']}


def _recovery_context(path, expected_sha256):
    require = qualification.require
    require(type(expected_sha256) is str and re.fullmatch('[0-9a-f]{64}',expected_sha256),
            'Exact copy recovery request SHA required')
    _,raw = qualification._read(Path(path),expected_sha256)
    recovery = validate_recovery_request(raw)
    op = Path(recovery['storage_root'])/'migrations/data-volumes'/recovery['volume_id']
    require(Path(path) == op/'recovery'/recovery['token']/'copy-recovery-request.json',
            'Copy recovery request escapes its exact attempt')
    _components(recovery)
    context = _original_context(op/'linux-copy-request.json',recovery['original_copy_request_sha256'])
    evidence = _recovery_evidence(op,context['request'],recovery,expected_sha256)
    require(context['journal'] == evidence['journal'], 'Copy recovery context changed')
    _require_recovery_targets(context,recovery,evidence['attempt_root'])
    return dict(context,recovery=recovery,attempt_root=evidence['attempt_root'])


def recover_verified(path, expected_sha256):
    """Qualify retained artifacts once, without repeating archive/copy/mount."""
    qualification.require(os.name == 'posix' and os.geteuid() == 0,'Host root required for retained copy recovery')
    context = _recovery_context(path,expected_sha256)
    op,request,recovery = context['operation_root'],context['request'],context['recovery']
    with _operation_lock(op):
        fresh = _recovery_context(path,expected_sha256)
        qualification.require(fresh == context,'Copy recovery context changed before its lock')
        started = append_started(context['journal'],'copy-verified',expected_sha256)
        _publish_journal(context['journal_path'],context['journal'],started)
        result_written = False
        try:
            _document(context['attempt_root'],'copy-recovery-started.json',
                {'schema':'fullmag.data-volume-copy-recovery-started.v1','volume_id':request['volume_id'],
                 'token':recovery['token'],'request_sha256':expected_sha256,
                 'original_copy_request_sha256':recovery['original_copy_request_sha256']})
            archive = context['target']/'migration'/request['volume_id']
            copied = requalify_existing_copy(request['storage_root'],context['roots'],archive/'originals.pax',
                context['target']/'payload',archive/('recovery-verification-'+recovery['token']))
            _source_roots(context['linux']); _mounted_root(context['linux'],context['provision'])
            manifest_sha = _document(archive,'source-manifest.json',copied['source_manifest'])
            export_sha = _document(op,'source-manifest-export.json',copied['source_manifest'])
            qualification.require(export_sha == manifest_sha,'Recovered manifest export differs')
            result = {'schema':'fullmag.data-volume-linux-copy-result.v2','state':'copied-and-verified-not-switched',
                'volume_id':request['volume_id'],'token':request['token'],
                'request_sha256':recovery['original_copy_request_sha256'],
                'filesystem_uuid':context['linux']['filesystem_uuid'],'data_sha256':copied['data_sha256'],
                'manifest_path':str(archive/'source-manifest.json'),'manifest_sha256':manifest_sha,
                'archive_path':copied['archive_path'],'archive_sha256':copied['archive_sha256'],
                'copied_roots':copied['copied_roots'],'namespace_admitted':False,'originals_retired':False,
                'completion_mode':'requalified-existing-archive-and-payload',
                'recovery_request_sha256':expected_sha256,'failed_copy_receipt_sha256':recovery['failed_copy_receipt_sha256']}
            validate_result(result,request,context['linux'],recovery['original_copy_request_sha256'])
            result_sha = _document(op,'linux-copy-result.json',result); result_written = True
            _publish_journal(context['journal_path'],started,append_terminal(started,'succeeded',result_sha))
            return result
        except BaseException as error:
            state = ('failed-confirmed' if isinstance(error,Exception) and not result_written and
                     not os.path.lexists(op/'linux-copy-result.json')
                     else 'outcome-unknown-resources-retained')
            failure = {'schema':'fullmag.data-volume-copy-recovery-failure.v1','state':state,
                'volume_id':request['volume_id'],'token':recovery['token'],'request_sha256':expected_sha256,
                'original_copy_request_sha256':recovery['original_copy_request_sha256'],
                'error_type':type(error).__name__,'originals_archive_and_payload_retained':True}
            failure_sha = _document(context['attempt_root'],'copy-recovery-failed.json',failure)
            _,journal_now = qualification._read(context['journal_path'])
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
