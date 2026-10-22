"""Build or promote one pinned repair package in the existing failed backend, without serving."""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
from pathlib import Path
import re
import subprocess

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture, mirror_console
from docker_compose_identity import validate_source_labels
from docker_dev_host import docker_argv


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_terminal(process, owner):
    require(process.get('schema') == 'fullmag.docker-process-tree.v1'
            and process.get('state') in {'shutdown_unknown', 'failed_outcome_retained'}
            and type(process.get('api_pid')) is int and process['api_pid'] > 0
            and type(process.get('api_exit_code')) is int,
            'An exact terminal API process receipt is required')
    require(owner.get('schema_version') == 'runtime_service_owner.v1' and owner.get('state') == 'failed',
            'An exact Failed native owner is required')
    children = owner.get('children')
    require(isinstance(children, list) and len(children) == 2
            and all(isinstance(child, dict) for child in children)
            and {child.get('role') for child in children} == {'compute', 'preparation'}
            and all(child.get('status') in {'exited_success', 'exited_failure'}
                    and type(child.get('pid')) is int and child['pid'] > 0 for child in children),
            'Both scheduler children must be terminal')


def validate_backend(actual, identity, backend_id, image_id):
    require(actual.get('Id') == backend_id and actual.get('Image') == image_id,
            'Backend container or image pin differs')
    state = actual.get('State', {})
    labels = actual.get('Config', {}).get('Labels', {})
    require(state.get('Running') is True and not state.get('Restarting')
            and labels.get('com.docker.compose.project') == identity['project_name']
            and labels.get('com.docker.compose.service') == 'backend',
            'The existing running backend of the selected group is required')
    validate_source_labels(actual, identity)
    mounts = actual.get('Mounts', [])
    source = [mount for mount in mounts if mount.get('Destination') == '/opt/fullmag/source']
    require(len(source) == 1 and source[0].get('Type') == 'bind' and source[0].get('RW') is False,
            'The selected backend source must remain a readonly bind')


RUNTIME = r'''
import argparse, contextlib, ctypes, fcntl, os, stat, subprocess, sys, tempfile, time
sys.path.insert(0, '/opt/fullmag')
import backend_dev as backend
import runtime_service as runtime


def read(path):
    backend._assert_no_links(path, 'recovery build evidence')
    data, metadata = backend._read_regular(path, 'recovery build evidence', 8*1024*1024)
    require(metadata.st_nlink == 1, 'Evidence must be one regular file')
    return data


def no_runtime(process, owner):
    forbidden = {process['api_pid'], owner['pid'], *(child['pid'] for child in owner['children'])}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            status = (entry/'stat').read_text().rsplit(')', 1)[1].split()[0]
            if status == 'Z':
                continue
            args = (entry/'cmdline').read_bytes().split(b'\0')
            program = Path(os.fsdecode(args[0])).name
        except (FileNotFoundError, ProcessLookupError):
            continue
        require(int(entry.name) not in forbidden and not program.startswith('fullmag')
                and program not in {'cargo', 'rustc', 'make', 'cmake', 'ninja', 'nvcc', 'cc1', 'cc1plus'},
                'An API, owner, scheduler or native Fullmag process is still alive')


def pinned_evidence(request, paths):
    process_raw = read(runtime.process_receipt_path(paths))
    owner_raw = read(runtime.runtime_services_root(paths)/'OWNER.json')
    require(hashlib.sha256(process_raw).hexdigest() == request['process_receipt_sha256']
            and hashlib.sha256(owner_raw).hexdigest() == request['owner_sha256'],
            'Pinned process receipt or Failed owner changed')
    process, owner = json.loads(process_raw), json.loads(owner_raw)
    validate_terminal(process, owner)
    runtime._validate_terminal_owner(owner, state='failed', name='repair build Failed owner',
        allowed_child_statuses=('exited_success', 'exited_failure'))
    require(process.get('accepted_store') == str(paths.store), 'Accepted store binding differs')
    no_runtime(process, owner)
    records = [runtime.process_receipt_path(paths), runtime.runtime_services_root(paths)/'OWNER.json',
               paths.config, Path('/opt/fullmag/control/backend/runtime-provenance.json'),
               Path(os.environ.get('FULLMAG_HOST_LEDGER_ROOT', '/host-ledger/ledger'))/'HOST_RESOURCE_LEDGER.json']
    return {str(path): hashlib.sha256(read(path)).hexdigest() for path in records}


def retained_unknown():
    print('recovery-build: outcome unknown; runtime/build guards retained', flush=True)
    while True:
        time.sleep(1)


@contextlib.contextmanager
def runtime_locks(build_lock=True):
    paths = runtime.canonical_paths()
    with contextlib.ExitStack() as locks:
        for name in ('STARTUP-GATE.lock', 'LAUNCH.lock', 'OWNER.lock'):
            path = runtime.runtime_services_root(paths)/name
            backend._assert_no_links(path, 'repair build runtime lock')
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
            locks.callback(os.close, fd)
            metadata = os.fstat(fd)
            require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1, 'Invalid runtime lock inode')
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            require(path.stat().st_ino == metadata.st_ino and path.stat().st_dev == metadata.st_dev,
                    'Runtime lock inode changed')
        if build_lock:
            locks.enter_context(backend._runtime_build_lock(Path('/build')))
        yield paths



def archive_superseded(request, paths, before, current):
    pins = request.get('superseded')
    if pins is None:
        return
    source = Path('/opt/fullmag/source/docker/all-in-one')
    source_files = {'FULLMAG_RECOVERY_HELPER_SHA256': source/'backend_candidate_recovery.py',
                    'FULLMAG_RECOVERY_BACKEND_SHA256': source/'backend_dev.py'}
    def verify_sources():
        require({key: hashlib.sha256(read(path)).hexdigest() for key, path in source_files.items()}
                == request['recovery_source_pins'], 'Candidate recovery helper sources changed')
    verify_sources()
    recovery_request = {'schema': 'fullmag.backend-candidate-recovery.v1', **pins}
    request_path = Path(request['result_path']).with_name('superseded-candidate-request.json')
    backend._write_json(request_path, recovery_request, 'superseded candidate request')
    command = [sys.executable, '-B', str(source_files['FULLMAG_RECOVERY_HELPER_SHA256']),
               '--request', str(request_path), '--request-sha256', hashlib.sha256(read(request_path)).hexdigest()]
    environment = {**os.environ, **request['recovery_source_pins']}
    preview = subprocess.run(command, env=environment, capture_output=True)
    require(preview.returncode == 0, 'Superseded candidate pins refused: ' + preview.stderr.decode(errors='replace')[-4096:])
    require(pinned_evidence(request, paths) == before
            and backend._validated_package(backend.PACKAGE_ROOT, 'unchanged pre-archive package',
                exclude_development_control=True) == current, 'Runtime or package changed before archive')
    verify_sources()
    # From apply onward an unknown result must retain the native guards and operation lease.
    try:
        applied = subprocess.run([*command, '--apply'], env=environment, capture_output=True)
        require(applied.returncode == 0, 'Superseded candidate archive incomplete: '
                + applied.stderr.decode(errors='replace')[-4096:])
        result = json.loads(applied.stdout)
        expected_source = backend.PACKAGE_ROOT/'.development'/'candidates'/pins['candidate_basename']
        require(result.get('state') == 'quarantined' and result.get('source') == str(expected_source)
                and result.get('destination') == str(expected_source.parent.parent/'quarantine'/expected_source.name),
                'Superseded candidate archive result differs')
        verify_sources()
        require(pinned_evidence(request, paths) == before
                and backend._validated_package(backend.PACKAGE_ROOT, 'unchanged archived package',
                    exclude_development_control=True) == current, 'Runtime or package changed during archive')
        backend._write_json(Path(request['result_path']).with_name('superseded-candidate-result.json'),
                            result, 'superseded candidate result')
        print('recovery-build: superseded-candidate ' + json.dumps(result, sort_keys=True), flush=True)
    except BaseException:
        retained_unknown()


def failed_make_result(request, candidate, paths, before, current):
    # The image-owned producer commits this receipt only after process.wait().
    # A compiler log string or a generic exception is never exit proof.
    expected = backend.PACKAGE_ROOT/'.development'/'candidates'/candidate.name
    require(candidate == expected, 'Failed Make candidate belongs to another package')
    backend._validate_candidate_marker(candidate, backend.PACKAGE_ROOT, Path('/build'), state='building')
    require(sorted(path.name for path in candidate.iterdir()) == [backend.PACKAGE_CANDIDATE_MARKER],
            'Known failed Make acknowledgement requires an unpublished marker-only candidate')
    attempt = backend._read_failed_make_attempt(Path('/build'), candidate)
    require(attempt is not None and attempt[0]['state'] == 'failed'
            and type(attempt[0]['exit_code']) is int and attempt[0]['exit_code'] != 0,
            'Known failed Make requires its durable nonzero waited exit receipt')
    require(pinned_evidence(request, paths) == before
            and backend._validated_package(backend.PACKAGE_ROOT, 'unchanged failed Make package',
                exclude_development_control=True) == current, 'Protected runtime or package changed after failed Make')
    return {'schema': 'fullmag.docker-recovery-build-failure.v1', 'state': 'failed-confirmed',
        'candidate': str(candidate), 'source_commit': request['source_commit'],
        'make_exit_code': attempt[0]['exit_code'],
        'make_attempt_sha256': hashlib.sha256(read(attempt[1]/backend.FAILED_MAKE_RECEIPT_NAME)).hexdigest(),
        'marker_sha256': hashlib.sha256(read(candidate/backend.PACKAGE_CANDIDATE_MARKER)).hexdigest(),
        'log_sha256': attempt[0]['log_sha256'], 'log_size': attempt[0]['log_size'],
        'package_promoted': False, 'runtime_started': False}


def rename_no_replace(source, destination):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number), str(destination))


def archive_failed_make(request, result, paths, before, current):
    candidate = Path(result['candidate'])
    require(failed_make_result(request, candidate, paths, before, current) == result,
            'Failed Make proof changed before archive')
    destination = candidate.parent.parent/'quarantine'/candidate.name
    backend._assert_no_links(destination, 'failed candidate archive')
    backend._ensure_directory(destination.parent, 'failed candidate quarantine')
    backend._fsync_owned_tree(candidate, 'failed candidate before archive')
    rename_no_replace(candidate, destination)
    backend._fsync_directory(candidate.parent, 'failed candidate source')
    backend._fsync_directory(destination.parent, 'failed candidate archive')
    require(hashlib.sha256(read(destination/backend.PACKAGE_CANDIDATE_MARKER)).hexdigest()
            == result['marker_sha256'], 'Archived candidate marker differs')
    require(pinned_evidence(request, paths) == before
            and backend._validated_package(backend.PACKAGE_ROOT, 'unchanged archived failure package',
                exclude_development_control=True) == current, 'Runtime or package changed during failed archive')
    return {**result, 'candidate_archive': str(destination)}


def guard(request, ready_fd, decision_fd):
    with runtime_locks(build_lock=False) as paths:
        before = pinned_evidence(request, paths)
        current = backend._validated_package(backend.PACKAGE_ROOT, 'current repair source package',
                                            exclude_development_control=True)
        archive_superseded(request, paths, before, current)
        with backend._runtime_build_lock(Path('/build')):
            control_root = backend._ensure_package_development_root(backend.PACKAGE_ROOT)
            require(not os.path.lexists(control_root/backend.PACKAGE_ROTATION_JOURNAL_NAME),
                    'Pending package rotation requires its existing recovery')
            require(not any((control_root/backend.PACKAGE_CANDIDATES_DIRNAME).iterdir()),
                    'Earlier candidates require their existing retirement/recovery')
            require(pinned_evidence(request, paths) == before
                    and backend._validated_package(backend.PACKAGE_ROOT, 'unchanged build admission package',
                        exclude_development_control=True) == current, 'Runtime or package changed before build admission')
            with os.fdopen(ready_fd, 'w') as ready, os.fdopen(decision_fd, 'r') as decisions:
                ready.write('READY\n'); ready.flush()
                # EOF after READY is unknown, while an explicit pre-build abort is verifiable.
                try:
                    decision = decisions.readline(64)
                    if decision == 'ABORT\n':
                        require(pinned_evidence(request, paths) == before, 'Runtime changed before abort')
                        require(backend._validated_package(backend.PACKAGE_ROOT, 'unchanged abort package',
                                exclude_development_control=True) == current, 'Current package changed before abort')
                        ready.write('ABORTED\n'); ready.flush()
                        return
                    require(decision == 'BEGIN\n', 'Repair build acknowledgement missing')
                    ready.write('BUILDING\n'); ready.flush()
                    line = decisions.readline(4096)
                    require(line.endswith('\n'), 'Repair build completion missing')
                    result = json.loads(line)
                    if result.get('schema') == 'fullmag.docker-recovery-build-failure.v1':
                        expected = failed_make_result(request, Path(result['candidate']), paths, before, current)
                        require(result == expected, 'Failed Make acknowledgement differs from its durable proof')
                        result = archive_failed_make(request, result, paths, before, current)
                        backend._write_json(Path(request['result_path']), result, 'known failed Make result')
                        ready.write('FAILED_CONFIRMED\n'); ready.flush()
                        return
                    require(set(result) == {'candidate', 'receipt_sha256'}, 'Invalid repair acknowledgement')
                    candidate = Path(result['candidate'])
                    backend._validate_candidate_marker(candidate, backend.PACKAGE_ROOT, Path('/build'), state='ready')
                    receipt, raw, _ = backend._validated_package(candidate, 'repair candidate', exclude_candidate_marker=True)
                    require(hashlib.sha256(raw).hexdigest() == result['receipt_sha256'], 'Repair receipt changed')
                    require(pinned_evidence(request, paths) == before, 'Runtime or ledger evidence changed during build')
                    require(backend._validated_package(backend.PACKAGE_ROOT, 'unchanged current package',
                            exclude_development_control=True) == current, 'Current package was changed')
                except BaseException:
                    retained_unknown()



def inside(request):
    require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == request['compose_project'], 'Compose project differs')
    require(os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == request['source_root'], 'Selected source differs')
    require(os.environ.get('FULLMAG_BACKEND_CARGO_PROFILE', 'backend-dev') == 'backend-dev', 'Wrong build profile')
    ready_r, ready_w = os.pipe()
    decision_r, decision_w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(ready_r); os.close(decision_w)
        try:
            guard(request, ready_w, decision_r)
        except BaseException as error:
            print('recovery-build: guard admission refused: ' + str(error), flush=True)
            os._exit(2)
        os._exit(0)
    os.close(ready_w); os.close(decision_r)
    ready = os.fdopen(ready_r, 'r')
    decision = os.fdopen(decision_w, 'w')
    if ready.readline(64) != 'READY\n':
        os.waitpid(pid, 0)
        raise SystemExit(42)
    began = False
    print('recovery-build: guard-ready pid=' + str(pid), flush=True)
    try:
        build_root, package = Path('/build'), backend.PACKAGE_ROOT
        control_root = backend._ensure_package_development_root(package)
        require(not os.path.lexists(control_root/backend.PACKAGE_ROTATION_JOURNAL_NAME),
                'Pending package rotation requires its existing recovery')
        require(not any((control_root/backend.PACKAGE_CANDIDATES_DIRNAME).iterdir()),
                'Earlier candidates require their existing retirement/recovery')
        current = backend._validated_package(package, 'current backend package', exclude_development_control=True)
        backend._preflight_candidate_storage(build_root, current[0])
        args = argparse.Namespace(source_root=Path('/opt/fullmag/source'),
            git_common_root=Path(os.environ.get('FULLMAG_SOURCE_GIT_COMMON', '/opt/fullmag/source-git')),
            source_tar=None)
        args.manifest = backend._capture_start_manifest(args, build_root)
        manifest, _ = backend._read_json(args.manifest, 'repair live manifest')
        require(manifest.get('resolved_commit') == request['source_commit'], 'Source HEAD changed')
        _, toolchain = backend._toolchain_identity()
        jobs = int(os.environ.get('CARGO_BUILD_JOBS', '2'))
        require(1 <= jobs <= 64, 'Invalid Cargo build budget')
        candidate = Path(tempfile.mkdtemp(prefix='.backend-package-candidate-',
                         dir=control_root/backend.PACKAGE_CANDIDATES_DIRNAME))
        backend._write_candidate_marker(candidate, package, build_root, state='building')
        before_build = pinned_evidence(request, runtime.canonical_paths())
        began = True
        decision.write('BEGIN\n'); decision.flush()
        require(ready.readline(64) == 'BUILDING\n', 'Runtime guard build handoff unknown')
        require(backend._prepare_locked(args, build_root, candidate, jobs, toolchain, candidate) == 0,
                'Canonical repair build failed')
        backend._validate_candidate_marker(candidate, package, build_root, state='ready')
        receipt, raw, _ = backend._validated_package(candidate, 'repair candidate', exclude_candidate_marker=True)
        result = {'candidate': str(candidate), 'receipt_sha256': hashlib.sha256(raw).hexdigest()}
        decision.write(json.dumps(result) + '\n'); decision.flush(); decision.close()
        _, status = os.waitpid(pid, 0)
        require(os.waitstatus_to_exitcode(status) == 0, 'Runtime/build guard release is unconfirmed')
        result.update(schema='fullmag.docker-recovery-build.v1', state='ready',
                      source=receipt['source'], runtime_qualification='NOT VERIFIED',
                      package_promoted=False, runtime_started=False)
        backend._write_json(Path(request['result_path']), result, 'repair build result')
        print('recovery-build: ready-candidate ' + json.dumps(result, sort_keys=True), flush=True)
    except BaseException as error:
        if began and isinstance(error, backend.BackendBuildError):
            try:
                result = failed_make_result(request, candidate, runtime.canonical_paths(),
                    before_build, current)
            except BaseException:
                # Missing, successful, malformed or uncertain Make proof retains guards.
                pass
            else:
                decision.write(json.dumps(result) + '\n'); decision.flush(); decision.close()
                require(ready.readline(64) == 'FAILED_CONFIRMED\n', 'Failed Make guard ACK unknown')
                _, status = os.waitpid(pid, 0)
                require(os.waitstatus_to_exitcode(status) == 0, 'Failed Make guard release unknown')
                print('recovery-build: known-failed-Make ' + json.dumps(result, sort_keys=True), flush=True)
                raise SystemExit(43)
        if not began:
            print('recovery-build: refused before Make: ' + str(error), flush=True)
            decision.write('ABORT\n'); decision.flush(); decision.close()
            if ready.readline(64) == 'ABORTED\n':
                _, status = os.waitpid(pid, 0)
                if os.waitstatus_to_exitcode(status) == 0:
                    raise SystemExit(42)
        decision.close()
        retained_unknown()
    finally:
        ready.close()



def publish_candidate(request, paths, before, status):
    package, build_root = backend.PACKAGE_ROOT, Path('/build')
    control_root = backend._ensure_package_development_root(package)
    candidate = control_root/backend.PACKAGE_CANDIDATES_DIRNAME/request['candidate_basename']
    backend._validate_candidate_marker(candidate, package, build_root, state='ready')
    require(not os.path.lexists(control_root/backend.PACKAGE_ROTATION_JOURNAL_NAME),
            'A pending rotation requires its existing recovery')
    require(list((control_root/backend.PACKAGE_CANDIDATES_DIRNAME).iterdir()) == [candidate],
            'Promotion requires exactly the pinned ready candidate')
    previous = backend._validated_package(package, 'current promotion package', exclude_development_control=True)
    receipt, candidate_raw, _ = backend._validated_package(candidate, 'promotion candidate', exclude_candidate_marker=True)
    require(hashlib.sha256(previous[1]).hexdigest() == request['current_receipt_sha256']
            and hashlib.sha256(candidate_raw).hexdigest() == request['candidate_receipt_sha256'],
            'Current or candidate package receipt differs')
    marker = backend._validate_candidate_marker(candidate, package, build_root, state='ready')
    require(marker['artifact_inventory_sha256'] == backend._sha256_bytes(backend._canonical(receipt['artifacts'])),
            'Candidate inventory differs from its owner marker')
    provenance_before = backend._snapshot_bound_provenance()
    require(provenance_before is not None
            and hashlib.sha256(provenance_before).hexdigest() == request['provenance_sha256'],
            'Current provenance differs')
    args = argparse.Namespace(source_root=Path('/opt/fullmag/source'),
        git_common_root=Path(os.environ.get('FULLMAG_SOURCE_GIT_COMMON', '/opt/fullmag/source-git')))
    fresh_manifest = backend._capture_start_manifest(args, build_root)
    _, toolchain = backend._toolchain_identity()
    require(backend._package_matches_fresh_live_manifest(receipt, fresh_manifest, toolchain, 'backend-dev'),
            'Ready candidate differs from the current source/toolchain; rebuild the repair candidate')
    import base64
    backend._write_json(Path(request['result_path']).with_name('previous-provenance.json'),
        {'schema': 'fullmag.recovery-promotion-original.v1', 'sha256': request['provenance_sha256'],
         'base64': base64.b64encode(provenance_before).decode()}, 'previous promotion provenance')
    immutable = {key: value for key, value in before.items() if key != str(backend.PROVENANCE_PATH)}
    rotation = None
    published = False
    try:
        status['mutated'] = True
        rotation = backend._rotate_package(package, candidate, control_root, previous[2], previous[1], candidate_raw)
        backend._publish_runtime_provenance(package)
        published = True
        current, current_raw, _ = backend._validated_package(package, 'promoted package', exclude_development_control=True)
        provenance = json.loads(read(backend.PROVENANCE_PATH))
        require(hashlib.sha256(current_raw).hexdigest() == request['candidate_receipt_sha256']
                and provenance.get('build_receipt_sha256') == request['candidate_receipt_sha256']
                and provenance.get('package_root') == str(package)
                and provenance.get('backend_build_receipt') == str(package/'backend-build-receipt.json')
                and provenance.get('binary_hashes') == {item['path'][4:]: item['sha256']
                    for item in current['artifacts'] if item['path'].startswith('bin/')},
                'Promoted package and canonical provenance are incoherent')
        after = pinned_evidence(request, paths)
        require({key: value for key, value in after.items() if key != str(backend.PROVENANCE_PATH)} == immutable,
                'Owner, process, configuration or ledger changed during promotion')
        backend._finalize_published_candidate(candidate, rotation)
        backend._clear_rotation_journal(rotation)
        result = {'schema': 'fullmag.docker-recovery-promotion.v1', 'state': 'promoted',
            'candidate': str(candidate), 'receipt_sha256': request['candidate_receipt_sha256'],
            'provenance_sha256': hashlib.sha256(read(backend.PROVENANCE_PATH)).hexdigest(),
            'rollback_package': rotation.get('backup'), 'package_promoted': True,
            'runtime_started': False, 'runtime_qualification': 'NOT VERIFIED'}
        backend._write_json(Path(request['result_path']), result, 'repair promotion result')
        return result
    except BaseException:
        if not published:
            backend._restore_bound_provenance(provenance_before)
            if rotation is not None:
                errors = backend._rollback_package_rotation(rotation)
                require(not errors, 'Repair promotion rollback is incomplete: ' + '; '.join(errors))
        if rotation is not None and not os.path.lexists(control_root/backend.PACKAGE_ROTATION_JOURNAL_NAME):
            backend._write_rotation_journal(rotation, 'committed')
        raise


def inside_promote(request):
    status = {'mutated': False}
    try:
        require(os.environ.get('FULLMAG_COMPOSE_PROJECT') == request['compose_project'], 'Compose project differs')
        require(os.environ.get('FULLMAG_SOURCE_HOST_ROOT') == request['source_root'], 'Selected source differs')
        with runtime_locks() as paths:
            before = pinned_evidence(request, paths)
            result = publish_candidate(request, paths, before, status)
        print('recovery-build: promoted ' + json.dumps(result, sort_keys=True), flush=True)
    except BaseException as error:
        print('recovery-build: promotion refused or incomplete: ' + str(error), flush=True)
        if not status['mutated']:
            raise SystemExit(42)
        raise

'''


def backend_control_path(path):
    require(path.startswith('/control/') and '..' not in Path(path).parts,
            'Expected a validated BuildControl path')
    return '/opt/fullmag/control/' + path.removeprefix('/control/')


def inside_code(promote=False):
    return ('import hashlib, json\nfrom pathlib import Path\n' + inspect.getsource(require)
            + '\n' + inspect.getsource(validate_terminal) + '\n' + RUNTIME
            + ('\ninside_promote(json.loads(sys.argv[1]))\n' if promote else '\ninside(json.loads(sys.argv[1]))\n'))


def inspect_one(kind, name):
    rows = json.loads(docker_capture(kind, 'inspect', name).stdout)
    require(len(rows) == 1, 'Exactly one Docker identity is required')
    return rows[0]


def run(args):
    from docker_dev import _select_source, _compose_identity
    import docker_backend_volume_cache as cache
    from docker_volume_dev import _validate_retained_service
    from docker_volume_reconcile import fingerprint
    for value, pattern in ((args.backend_container_id, r'[0-9a-f]{64}'),
                           (args.image_id, r'sha256:[0-9a-f]{64}'),
                           (args.process_receipt_sha256, r'[0-9a-f]{64}'),
                           (args.owner_sha256, r'[0-9a-f]{64}')):
        require(re.fullmatch(pattern, value), 'Full immutable recovery pins are required')
    promote = bool(getattr(args, 'promote', False))
    promotion_pins = ('candidate_basename', 'candidate_receipt_sha256', 'current_receipt_sha256', 'provenance_sha256')
    if promote:
        require(re.fullmatch(r'\.backend-package-candidate-[A-Za-z0-9._-]+', args.candidate_basename or ''),
                'Exact candidate basename required')
        for name in promotion_pins[1:]:
            require(re.fullmatch(r'[0-9a-f]{64}', getattr(args, name) or ''), 'Exact promotion digest required: ' + name)
    else:
        require(not any(getattr(args, name, None) for name in promotion_pins), 'Promotion pins require --promote')
    superseded_names = ('superseded_candidate_basename', 'superseded_marker_sha256',
                        'superseded_receipt_sha256', 'superseded_make_attempt_sha256')
    superseded_values = [getattr(args, name, None) for name in superseded_names]
    superseded = None
    if any(superseded_values):
        require(not promote and all(superseded_values), 'Complete superseded candidate pins require build-only mode')
        require(re.fullmatch(r'\.backend-package-candidate-[A-Za-z0-9._-]+', superseded_values[0]),
                'Exact superseded candidate basename required')
        require(all(re.fullmatch(r'[0-9a-f]{64}', value) for value in superseded_values[1:]),
                'Exact superseded candidate digests required')
        superseded = dict(zip(('candidate_basename', 'marker_sha256', 'receipt_sha256', 'make_attempt_sha256'),
                              superseded_values))
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    identity = _compose_identity(layout)
    control = BuildControl(identity, args.image_id)
    control.prepare()
    previous = control.read('development/verified.json')
    root = 'development/attempts/' + previous['attempt']
    document, profile = control.read(root + '/compose.json'), control.read(root + '/backend-cache.json')
    image = inspect_one('image', args.image_id)
    actual = inspect_one('container', args.backend_container_id)
    validate_backend(actual, identity, args.backend_container_id, args.image_id)
    _validate_retained_service(document, actual, 'backend', image['Config'])
    require(previous.get('state') == 'succeeded' and previous.get('compose_project') == control.project
            and previous.get('inputs', {}).get('source_root') == str(selected)
            and previous.get('backend_container') == args.backend_container_id
            and document.get('name') == control.project, 'Verified source/backend authority differs')
    expected_cache = cache.cache_key(selected, identity['worktree_id'],
                                    profile['toolchain_image_id'], profile['cargo_profile'])
    require(profile['cache_key'] == expected_cache['key'], 'Build cache belongs to another source/toolchain')
    profile = {**profile, 'volume_documents': {role: inspect_one('volume', name)
               for role, name in profile['volume_names'].items()}}
    cache.validate_container(actual, profile)
    protected = {profile['volume_names'][role] for role in ('build', 'package')}
    ids = docker_capture('ps', '--quiet', '--no-trunc').stdout.decode().split()
    rows = json.loads(docker_capture('inspect', *ids).stdout) if ids else []
    require(not any(row['Id'] != args.backend_container_id and any(
        mount.get('Name') in protected for mount in row.get('Mounts', [])) for row in rows),
        'Another running container consumes the backend build/package cache')
    inputs = {key: getattr(args, key) for key in ('backend_container_id', 'image_id',
              'process_receipt_sha256', 'owner_sha256')}
    import fullmag_storage as storage
    inputs.update(source_root=str(selected), compose_project=control.project,
                  source_commit=storage.git(selected, 'rev-parse', 'HEAD'),
                  backend_started_at=actual['State']['StartedAt'],
                  container_fingerprint=fingerprint(actual), controller_sha256=hashlib.sha256(inside_code(promote).encode()).hexdigest())
    if promote:
        inputs.update({name: getattr(args, name) for name in promotion_pins})
    if superseded is not None:
        inputs.update(superseded=superseded, recovery_source_pins={key: hashlib.sha256((selected/path).read_bytes()).hexdigest()
            for key, path in {'FULLMAG_RECOVERY_HELPER_SHA256': 'docker/all-in-one/backend_candidate_recovery.py',
                              'FULLMAG_RECOVERY_BACKEND_SHA256': 'docker/all-in-one/backend_dev.py'}.items()})
    with control.operation('recovery-promotion' if promote else 'recovery-build', inputs) as operation:
        request = {**inputs, 'result_path': backend_control_path(control.path(operation['root'] + '/result.json'))}
        fresh = inspect_one('container', args.backend_container_id)
        require(fingerprint(fresh) == inputs['container_fingerprint']
                and fresh.get('State', {}).get('StartedAt') == inputs['backend_started_at']
                and fresh.get('State', {}).get('Running') is True,
                'Backend incarnation changed before repair build')
        operation['daemon_pending'] = True
        process = subprocess.Popen(docker_argv('exec', args.backend_container_id, '/usr/local/bin/python3', '-B',
            '-c', inside_code(promote), json.dumps(request)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for chunk in iter(lambda: process.stdout.read1(65536), b''):
            operation['logger'].stdin.write(chunk); operation['logger'].stdin.flush()
            mirror_console(chunk)
        code = process.wait()
        if code == 43:
            result = control.read(operation['root'] + '/result.json')
            require(result.get('schema') == 'fullmag.docker-recovery-build-failure.v1'
                    and result.get('state') == 'failed-confirmed'
                    and type(result.get('make_exit_code')) is int and result['make_exit_code'] != 0
                    and result.get('source_commit') == inputs['source_commit']
                    and result.get('package_promoted') is False and result.get('runtime_started') is False,
                    'Failed Make has no exact acknowledged terminal result')
            operation['daemon_pending'] = False
            operation['receipt'].update(state='failed-confirmed', image_id=args.image_id, failure=result)
            raise BuildControlError('Canonical repair Make failed with known exit '
                                    + str(result['make_exit_code']) + '; candidate and evidence preserved')
        if code == 42:
            operation['daemon_pending'] = False
            operation['receipt']['state'] = 'failed-confirmed'
            raise BuildControlError('Repair operation refused before mutation; runtime guards released')
        require(code == 0, 'Repair outcome unknown; managed operation lease and recovery evidence retained')
        result = control.read(operation['root'] + '/result.json')
        require(result.get('state') == ('promoted' if promote else 'ready')
                and result.get('package_promoted') is promote,
                'No verified repair candidate result')
        operation['daemon_pending'] = False
        operation['receipt'].update(state='succeeded', image_id=args.image_id, candidate=result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--backend-container-id', required=True)
    parser.add_argument('--image-id', required=True)
    parser.add_argument('--process-receipt-sha256', required=True)
    parser.add_argument('--owner-sha256', required=True)
    for name in ('candidate-basename', 'marker-sha256', 'receipt-sha256', 'make-attempt-sha256'):
        parser.add_argument('--superseded-' + name)
    parser.add_argument('--promote', action='store_true')
    parser.add_argument('--candidate-basename')
    parser.add_argument('--candidate-receipt-sha256')
    parser.add_argument('--current-receipt-sha256')
    parser.add_argument('--provenance-sha256')
    try:
        run(parser.parse_args())
    except (BuildControlError, ValueError, OSError) as error:
        parser.exit(2, str(error) + '\n')


if __name__ == '__main__':
    main()
