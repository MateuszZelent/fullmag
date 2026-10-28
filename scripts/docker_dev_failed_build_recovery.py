"""Preview or explicitly finalize one known failed legacy recovery-build, preserving all evidence."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import inspect
import json
from pathlib import Path
import re
import os
import select
import time
import uuid

import docker_dev_recovery_build as repair
from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture
from docker_compose_identity import source_labels

SCHEMA = 'fullmag.docker-legacy-failed-build-recovery.v1'


RUNTIME = r"""
import select, signal


def sha(path):
    return hashlib.sha256(read(path)).hexdigest()


def process_record(pid):
    root = Path('/proc')/str(pid)
    value = (root/'stat').read_text().rsplit(')', 1)[1].split()
    arguments = (root/'cmdline').read_bytes()
    fields = dict(line.split(':', 1) for line in (root/'status').read_text().splitlines() if ':' in line)
    return {'pid': pid, 'ppid': int(value[1]), 'start_token': value[19],
            'cmdline_sha256': hashlib.sha256(arguments).hexdigest(),
            'sigint_caught': bool(int(fields['SigCgt'].strip(), 16)&2),
            'sigint_ignored': bool(int(fields['SigIgn'].strip(), 16)&2),
            'children': (root/'task'/str(pid)/'children').read_text().split()}


def lock_identities(paths):
    files = [runtime.runtime_services_root(paths)/name for name in
             ('STARTUP-GATE.lock', 'LAUNCH.lock', 'OWNER.lock')]
    files.append(Path('/build/.fullmag-backend-runtime.lock'))
    result = {}
    for path in files:
        backend._assert_no_links(path, 'legacy build native lock')
        metadata = path.stat()
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'Invalid native lock inode')
        result[str(path)] = [metadata.st_dev, metadata.st_ino]
    return result


def held_native_locks(pid, inodes):
    held = set()
    for descriptor in (Path('/proc')/str(pid)/'fd').iterdir():
        try:
            metadata = descriptor.stat()
            held.update(path for path, identity in inodes.items()
                        if [metadata.st_dev, metadata.st_ino] == identity)
        except FileNotFoundError:
            continue
    require(held == set(inodes), 'Legacy child does not hold every exact native build/runtime lock')


def interrupt_owned_controllers(observation):
    processes = observation['processes']
    descriptors = []
    transitions = []
    try:
        require(init_identity() == observation['namespace_init'], 'Namespace init identity changed')
        for process in processes:
            fd = os.pidfd_open(process['pid']); descriptors.append(fd)
            require(process_record(process['pid']) == process, 'Legacy PID/start token changed before signal')
        held_native_locks(processes[1]['pid'], observation['lock_inodes'])
        for index, (process, fd) in enumerate(zip(processes, descriptors)):
            actual = process_record(process['pid'])
            expected = process if index == 0 else {**process, 'ppid': observation['namespace_init']['pid']}
            require(actual == expected, 'Legacy identity or expected reparent transition differs')
            if index:
                require(init_identity() == observation['namespace_init'], 'Namespace init changed after reparent')
                held_native_locks(process['pid'], observation['lock_inodes'])
                transitions.append({'pid': process['pid'], 'from_ppid': process['ppid'], 'to_ppid': observation['namespace_init']['pid']})
            signal.pidfd_send_signal(fd, signal.SIGINT, None, 0)
            require(select.select([fd], [], [], 15)[0] == [fd], 'Legacy process exit is unknown; operation retained')
        return transitions
    finally:
        for fd in descriptors:
            os.close(fd)


def init_identity():
    return {key: value for key, value in process_record(1).items() if key != 'children'}


def observe(request):
    paths = runtime.canonical_paths()
    operation = json.loads(read(Path(request['operation_receipt_path'])))
    inputs = operation['inputs']
    require(operation.get('schema') == 'fullmag.docker-build-operation.v1'
            and operation.get('phase') == 'recovery-build' and operation.get('attempt') == request['attempt']
            and operation.get('state') == 'starting', 'Legacy operation is not the exact retained starting build')
    require(read(Path('/opt/fullmag/control/active')).decode().strip() == request['attempt'],
            'Original control helper no longer owns this active operation')
    protected = pinned_evidence(inputs, paths)
    current = backend._validated_package(backend.PACKAGE_ROOT, 'legacy failed-build unchanged package',
                                        exclude_development_control=True)
    processes = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            arguments = (entry/'cmdline').read_bytes().split(b'\0')
            if len(arguments) < 5 or arguments[1:3] != [b'-B', b'-c']:
                continue
            if hashlib.sha256(arguments[3]).hexdigest() != inputs['controller_sha256']:
                continue
            original = json.loads(arguments[4])
            require(original == {**inputs, 'result_path': request['result_path']},
                    'Legacy controller request differs from the original operation')
            processes.append(process_record(int(entry.name)))
        except (FileNotFoundError, ProcessLookupError):
            continue
    require(len(processes) == 2, 'Exactly two original legacy Python controllers are required')
    parents = [p for p in processes if any(c['ppid'] == p['pid'] for c in processes)]
    require(len(parents) == 1, 'Legacy parent/guard relationship is ambiguous')
    parent = parents[0]; child = next(p for p in processes if p['pid'] != parent['pid'])
    require(parent['children'] == [str(child['pid'])] and not child['children']
            and all(p['sigint_caught'] and not p['sigint_ignored'] for p in processes),
            'Legacy controllers have children or cannot cooperatively unwind with SIGINT')
    candidates = backend.PACKAGE_ROOT/'.development'/'candidates'
    rows = list(candidates.iterdir())
    require(len(rows) == 1, 'Exactly one retained failed candidate is required')
    candidate = rows[0]
    failure = failed_make_result(inputs, candidate, paths, protected, current)
    inodes = lock_identities(paths)
    held_native_locks(child['pid'], inodes)
    return {'protected': protected, 'current_package_sha256': hashlib.sha256(current[1]).hexdigest(),
            'failure': failure, 'processes': [parent, child], 'lock_inodes': inodes,
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'pid_namespace': os.readlink('/proc/self/ns/pid'), 'namespace_init': init_identity(),
            'operation_receipt_sha256': sha(Path(request['operation_receipt_path']))}


def finalize_native_locked(request):
    require(observe(request) == request['observation'], 'Legacy recovery preview changed')
    journal = Path(request['native_journal_path'])
    require(not journal.exists() and not journal.is_symlink(), 'Legacy handoff already attempted; inspect retained proof')
    # This intent is not release proof. Any incomplete handoff retains the
    # original BuildControl active marker; never fabricate a terminal record.
    backend._write_json(journal, {'schema': request['schema'], 'state': 'prepared',
                        'request_sha256': request['canonical_request_sha256']}, 'legacy handoff intent')
    transitions = interrupt_owned_controllers(request['observation'])
    with runtime_locks() as paths:
        require(lock_identities(paths) == request['observation']['lock_inodes'], 'Native lock inode was replaced')
        require(pinned_evidence(request['operation_inputs'], paths) == request['observation']['protected'],
                'Runtime/ledger evidence changed during legacy handoff')
        current = backend._validated_package(backend.PACKAGE_ROOT, 'unchanged legacy handoff package',
                                            exclude_development_control=True)
        require(hashlib.sha256(current[1]).hexdigest() == request['observation']['current_package_sha256'],
                'Current package changed during legacy handoff')
        candidate = Path(request['observation']['failure']['candidate'])
        require(failed_make_result(request['operation_inputs'], candidate, paths,
                    request['observation']['protected'], current) == request['observation']['failure'],
                'Failed Make proof changed during handoff')
        archived = archive_failed_make(request['operation_inputs'], request['observation']['failure'],
                                      paths, request['observation']['protected'], current)
        result = {'schema': request['schema'], 'state': 'native-guards-released',
            'request_sha256': request['canonical_request_sha256'], 'candidate_archive': archived['candidate_archive'],
            'failure': request['observation']['failure'], 'protected_unchanged': True,
            'scientific_claim_modified': False, 'process_exit_confirmed': request['observation']['processes'], 'reparent_transitions': transitions}
        backend._write_json(journal, result, 'legacy native handoff proof')
    return result



def finalize_native(request):
    journal = Path(request['native_journal_path'])
    backend._assert_no_links(journal.parent, 'legacy recovery review')
    lock = Path(request['operation_receipt_path']).parent/'legacy-handoff.lock'
    backend._assert_no_links(lock, 'legacy operation handoff lock')
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o640)
    try:
        metadata = os.fstat(fd)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'Invalid handoff lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require([lock.stat().st_dev,lock.stat().st_ino] == [metadata.st_dev,metadata.st_ino],
                'Legacy operation handoff lock inode changed')
        return finalize_native_locked(request)
    finally:
        os.close(fd)
"""


def host_pidfd_open(pid):
    native = getattr(os, 'pidfd_open', None)
    if native is not None:
        return native(pid)
    # Some standalone Python builds omit this binding despite a capable kernel.
    # Linux x86_64 syscall 434 is SYS_pidfd_open; flags zero preserve pidfd semantics.
    repair.require(os.name == 'posix' and os.uname().sysname == 'Linux'
                   and os.uname().machine == 'x86_64',
                   'Host Python lacks pidfd_open on this unsupported platform')
    repair.require(type(pid) is int and 0 < pid <= 2_147_483_647, 'Invalid pidfd process identity')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    descriptor = libc.syscall(ctypes.c_long(434), ctypes.c_int(pid), ctypes.c_uint(0))
    if descriptor < 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))
    return descriptor


def host_process(pid):
    root = Path('/proc')/str(pid)
    fields = (root/'stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'ppid': int(fields[1]), 'start_token': fields[19],
            'cmdline_sha256': hashlib.sha256((root/'cmdline').read_bytes()).hexdigest(),
            'boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'pid_namespace': os.readlink('/proc/self/ns/pid')}


def manager_pin(inputs):
    expected = ['-B', str(Path(inputs['source_root'])/'scripts/docker_dev_recovery_build.py'),
                '--source-root', inputs['source_root'], '--backend-container-id', inputs['backend_container_id'],
                '--image-id', inputs['image_id'], '--process-receipt-sha256', inputs['process_receipt_sha256'],
                '--owner-sha256', inputs['owner_sha256']]
    found = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            argv = (path/'cmdline').read_bytes().split(bytes([0]))
            if argv[-1:] == [b'']:
                argv.pop()
            if len(argv) == len(expected)+1 and [os.fsdecode(arg) for arg in argv[1:]] == expected:
                found.append(host_process(int(path.name)))
        except (FileNotFoundError, ProcessLookupError):
            continue
    repair.require(len(found) == 1, 'Exactly one original WSL host manager is required')
    return found[0]


def code(apply=False,verify=False):
    library = ('import hashlib,json\nfrom pathlib import Path\n' + inspect.getsource(repair.require)
               + '\n' + inspect.getsource(repair.validate_terminal) + '\n' + repair.RUNTIME + '\n' + RUNTIME)
    call = ('request=json.loads(sys.argv[1]); paths=runtime.canonical_paths(); '
            'current=backend._validated_package(backend.PACKAGE_ROOT,"post-handoff current package",exclude_development_control=True); '
            'print(json.dumps({"protected":pinned_evidence(request["operation_inputs"],paths),'
            '"current_package_sha256":hashlib.sha256(current[1]).hexdigest()},sort_keys=True))' if verify else
            'print(json.dumps(finalize_native(json.loads(sys.argv[1])),sort_keys=True))' if apply
            else 'print(json.dumps(observe(json.loads(sys.argv[1])),sort_keys=True))')
    return library + '\n' + call + '\n'


def helper(control, operation):
    document = repair.inspect_one('container', operation['helper_container'])
    args = control.helper_args(control.operation_script('recovery-build', operation['attempt']),
                               name=operation['helper_container'])
    index = args.index('--entrypoint')
    labels = document.get('Config', {}).get('Labels', {})
    require = repair.require
    require(document['State']['Running'] is True and not document['State'].get('Restarting') and document['Image'] == control.image
            and document['Config'].get('Entrypoint') == ['/bin/bash']
            and document['Config'].get('Cmd') == args[index+3:]
            and labels.get('com.docker.compose.project') == control.project
            and labels.get('com.docker.compose.service') == 'build-control'
            and all(labels.get(key) == value for key, value in {**control.labels, **source_labels(control.identity)}.items()),
            'Original BuildControl helper identity or lease protocol differs')
    require(document.get('Mounts') and len(document['Mounts']) == 1
            and document['Mounts'][0].get('Name') == control.volume
            and document['Mounts'][0].get('Destination') == '/control'
            and document['Mounts'][0].get('RW') is True, 'Original helper control mount differs')
    return {**{key: document[key] for key in ('Id', 'Image', 'Created')}, 'StartedAt': document['State']['StartedAt']}


def context(args):
    from docker_dev import _select_source, _compose_identity
    from docker_volume_dev import _validate_retained_service
    import docker_backend_volume_cache as cache
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    require = repair.require
    require(re.fullmatch('[0-9a-f]{32}', args.attempt or ''), 'Exact operation attempt required')
    require(re.fullmatch('[0-9a-f]{64}', args.backend_container_id or '')
            and re.fullmatch('sha256:[0-9a-f]{64}', args.image_id or ''), 'Full backend/image pins required')
    operation = control.read('recovery-build/attempts/'+args.attempt+'/receipt.json')
    require(operation.get('state') == 'starting' and operation.get('phase') == 'recovery-build'
            and operation.get('attempt') == args.attempt and operation.get('compose_project') == control.project
            and operation.get('control_volume') == control.volume, 'Only the exact retained starting recovery-build is supported')
    inputs = operation.get('inputs', {})
    require(inputs.get('source_root') == str(selected) and inputs.get('backend_container_id') == args.backend_container_id
            and inputs.get('image_id') == args.image_id, 'Retained operation belongs to another source/backend/image')
    actual = repair.inspect_one('container', args.backend_container_id)
    repair.validate_backend(actual, identity, args.backend_container_id, args.image_id)
    from docker_volume_reconcile import fingerprint
    require(fingerprint(actual) == inputs['container_fingerprint']
            and actual['State']['StartedAt'] == inputs['backend_started_at'], 'Backend incarnation changed')
    previous = control.read('development/verified.json'); root='development/attempts/'+previous['attempt']
    document, profile = control.read(root+'/compose.json'), control.read(root+'/backend-cache.json')
    require(previous.get('state') == 'succeeded' and previous.get('compose_project') == control.project
            and previous.get('inputs', {}).get('source_root') == str(selected)
            and previous.get('backend_container') == args.backend_container_id and document.get('name') == control.project,
            'Verified source/backend authority differs')
    expected = cache.cache_key(selected, identity['worktree_id'], profile['toolchain_image_id'], profile['cargo_profile'])
    require(profile['cache_key'] == expected['key'], 'Build cache belongs to another source/toolchain')
    image = repair.inspect_one('image', args.image_id)
    _validate_retained_service(document, actual, 'backend', image['Config'])
    profile = {**profile, 'volume_documents': {role: repair.inspect_one('volume', name)
               for role, name in profile['volume_names'].items()}}
    cache.validate_container(actual, profile)
    protected = {profile['volume_names'][role] for role in ('build', 'package')}
    ids = docker_capture('ps', '--quiet', '--no-trunc').stdout.decode().split()
    rows = json.loads(docker_capture('inspect', *ids).stdout) if ids else []
    require(not any(row['Id'] != args.backend_container_id and any(m.get('Name') in protected
                for m in row.get('Mounts', [])) for row in rows), 'Another container consumes the build/package cache')
    return control, operation, helper(control, operation)


def backend_call(args, request, *, apply=False, verify=False):
    result = docker_capture('exec', args.backend_container_id, '/usr/local/bin/python3', '-B', '-c', code(apply,verify),
                            json.dumps(request), timeout=180)
    return json.loads(result.stdout)


def source_pins():
    return {'adapter_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'repair_sha256': hashlib.sha256(Path(repair.__file__).read_bytes()).hexdigest(),
            'apply_code_sha256': hashlib.sha256(code(True).encode()).hexdigest()}


def validate_request(request, args, operation, helper_pin):
    expected = {'schema','attempt','backend_container_id','image_id','helper','operation_inputs',
                'operation_receipt_path','result_path','source_pins','host_manager','observation','native_journal_path'}
    repair.require(set(request) == expected and request['schema'] == SCHEMA, 'Recovery request schema differs')
    root = '/opt/fullmag/control/recovery-build/attempts/'+args.attempt
    repair.require(request['attempt'] == args.attempt and request['backend_container_id'] == args.backend_container_id
        and request['image_id'] == args.image_id and request['helper'] == helper_pin
        and request['operation_inputs'] == operation['inputs'] and request['source_pins'] == source_pins()
        and request['operation_receipt_path'] == root+'/receipt.json' and request['result_path'] == root+'/result.json'
        and re.fullmatch('/opt/fullmag/control/verification/failed-build-recovery/'+args.attempt
                         +'/[0-9a-f]{32}/native-handoff.json',request['native_journal_path']),
        'Recovery request scope, canonical paths or source pins differ')
    repair.require(host_process(request['host_manager']['pid']) == request['host_manager']
                   and manager_pin(operation['inputs']) == request['host_manager'], 'Original host manager identity differs')


def run(args):
    require = repair.require
    control, operation, helper_pin = context(args)
    root='recovery-build/attempts/'+args.attempt
    if not args.apply:
        request = {'schema': SCHEMA, 'attempt': args.attempt, 'backend_container_id': args.backend_container_id,
                   'image_id': args.image_id, 'helper': helper_pin, 'operation_inputs': operation['inputs'],
                   'operation_receipt_path': '/opt/fullmag/control/'+root+'/receipt.json',
                   'result_path': '/opt/fullmag/control/'+root+'/result.json',
                   'source_pins': source_pins(), 'host_manager': manager_pin(operation['inputs'])}
        manager_fd = host_pidfd_open(request['host_manager']['pid'])
        try:
            require(host_process(request['host_manager']['pid']) == request['host_manager']
                    and not select.select([manager_fd], [], [], 0)[0],
                    'Host manager pidfd identity is not live during preview')
        finally:
            os.close(manager_fd)
        request['observation'] = backend_call(args, request)
        request_id = uuid.uuid4().hex
        relative='verification/failed-build-recovery/'+args.attempt+'/'+request_id
        request['native_journal_path']='/opt/fullmag/control/'+relative+'/native-handoff.json'
        control.write(relative+'/request.json', request)
        raw = canonical(request)+b'\n'; pin=hashlib.sha256(raw).hexdigest()
        report={'schema':SCHEMA,'state':'preview','request':relative+'/request.json','request_sha256':pin,
                'operation':args.attempt,'scope':'Only two exact own legacy build controllers; no scientific release',
                'apply_executed':False,'observation':request['observation']}
        control.write(relative+'/review.json',report)
        print(json.dumps(report,indent=2));return report
    require(args.request and re.fullmatch('[0-9a-f]{64}',args.request_sha256 or ''), 'Apply requires the reviewed request and raw SHA')
    from docker_volume_activation_reconcile import _control_bytes, _validate_helper_logged
    raw=_control_bytes(control,args.request)
    require(hashlib.sha256(raw).hexdigest()==args.request_sha256,'Recovery request raw SHA changed')
    request=json.loads(raw)
    validate_request(request,args,operation,helper_pin)
    request['canonical_request_sha256']=hashlib.sha256(canonical(request)).hexdigest()
    manager_fd=host_pidfd_open(request['host_manager']['pid'])
    try:
        require(host_process(request['host_manager']['pid']) == request['host_manager'], 'Host manager changed before handoff')
        proof=backend_call(args,request,apply=True)
        require(select.select([manager_fd],[],[],45)[0] == [manager_fd],
                'Original host manager has not exited; retain operation')
    finally:
        os.close(manager_fd)
    require(proof.get('state')=='native-guards-released' and proof.get('protected_unchanged') is True,
            'Native legacy handoff is unknown; original operation retained')
    deadline=time.monotonic()+45
    while True:
        try:
            helper(control,operation);log_ack=_validate_helper_logged(helper_pin['Id']);break
        except BuildControlError:
            if time.monotonic()>=deadline:raise
            time.sleep(.5)
    # Original manager must first publish its natural unknown outcome. Never
    # race that still-live writer or overwrite its starting receipt.
    current=control.read(root+'/receipt.json')
    require(current.get('state')=='outcome-unknown-resources-retained'
            and current.get('inputs')==operation['inputs'] and current.get('attempt')==args.attempt,
            'Original host manager has not finalized its observation; retain operation')
    # LOGGED plus exited exact host pidfd closes both original receipt/log writers.
    unknown_raw=_control_bytes(control,root+'/receipt.json')
    require(json.loads(unknown_raw)==current,'Unknown receipt changed after manager exit')
    after=backend_call(args,request,verify=True)
    require(after['protected']==request['observation']['protected']
            and after['current_package_sha256']==request['observation']['current_package_sha256'],
            'Protected runtime/package changed before terminal publication')
    require(helper(control,operation)==helper_pin,'Original helper incarnation changed')
    require(_control_bytes(control,'active').decode().strip()==args.attempt,'Original active marker changed')
    control.write(root+'/legacy-original-receipt.json',operation)
    control.write_bytes(root+'/legacy-unknown-receipt.json',unknown_raw)
    final_log=_control_bytes(control,root+'/build.log')
    final={**current,'state':'failed-confirmed','failure':proof['failure'],'legacy_reconciliation':proof,
           'finished_at':time.time(),'filesystem_after':control.space(),'log_ack':log_ack,
           'final_log_sha256':hashlib.sha256(final_log).hexdigest(),'final_log_size':len(final_log),
           'scientific_claim_modified':False}
    control.write(root+'/receipt.json',final)
    control.write(root+'/terminal.json',final)
    control.write('recovery-build/current.json',final)
    # Only the original lease helper removes active after seeing terminal.json.
    deadline=time.monotonic()+30
    while docker_capture('inspect',helper_pin['Id'],allow_failure=True).returncode==0:
        require(time.monotonic()<deadline,'Original helper exit unknown; retain finalization evidence');time.sleep(.5)
    require(_control_bytes(control,'active',optional=True) is None,'Original operation active marker remains')
    print(json.dumps({'schema':SCHEMA,'state':'failed-confirmed','request_sha256':args.request_sha256,
                      'proof':proof,'apply_executed':True},indent=2))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('source-root','backend-container-id','image-id','attempt'):
        parser.add_argument('--'+name,required=True)
    parser.add_argument('--request');parser.add_argument('--request-sha256')
    parser.add_argument('--apply',action='store_true')
    try:run(parser.parse_args())
    except (BuildControlError,ValueError,OSError,KeyError) as error:parser.exit(2,str(error)+'\n')


if __name__=='__main__':main()
