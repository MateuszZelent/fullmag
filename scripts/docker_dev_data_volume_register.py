"""Commit one genuinely started, fully qualified migrated DEV group's storage.

No copy, bind, startup, Solve, registration recovery or deletion occurs here.
The original copied_group host scope remains live. Its old capabilities are
deliberately consumed by the first final journal append, never widened.
"""
from __future__ import annotations

from copy import deepcopy
import base64
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import stat
import subprocess
import uuid

from docker_activation_history import authored_zarr
from docker_build_control import canonical, docker_capture
from docker_dev_run_script import _probe_with_retry, RESULT_SCHEMA
from docker_startup_script import _validate_activation_receipt
from docker_volume_reconcile import fingerprint
import docker_data_volume_startup_scope as startup
import fullmag_data_volume as model
import fullmag_data_volume_guard as guard
import fullmag_data_volume_pending as pending_module
import fullmag_storage as storage
from fullmag_data_volume_journal import append_started, append_terminal, next_phase
from fullmag_data_volume_zarr_qualification import qualify_completed_fem_zarr
from linux_data_volume_format import _document, _encoded, _publish_journal, _exclusive
import linux_data_volume_provision as qualification


ARTIFACTS = ('qualification-inputs.json', 'qualification-write-probe.json',
             'runtime-qualified.json', 'zarr-qualified.json', 'migration-qualified.json',
             'volume-registered.json', 'registration-committed.json', 'registration-failed.json')
CERTIFICATE_SOURCES = (
    'backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp',
    'backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp',
    'backends/fem/gpu/cuda/demag_poisson/hypre_validation_policy.cpp',
)
COMPONENTS = ('docker_dev_data_volume_register.py', 'fullmag_data_volume_completion.py',
    'fullmag_data_volume_zarr_qualification.py', 'fullmag_data_volume.py',
    'fullmag_data_volume_guard.py', 'fullmag_data_volume_pending.py',
    'fullmag_data_volume_journal.py', 'docker_dev_run_script.py',
    'docker_startup_script.py', 'docker_data_volume_startup_scope.py',
    'docker_dev_data_volume_restart.py', 'docker_data_volume_restart_context.py',
    'docker_data_volume_relocated.py', 'linux_data_volume_format.py')

require = qualification.require


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _raw(path):
    raw = guard._read_optional_regular(Path(path), 'volume completion evidence', maximum=8*1024**2)
    require(raw is not None, 'Completion evidence is absent: '+str(path))
    return raw


def _pins(source):
    return {name: _sha(_raw(source/'scripts'/name)) for name in COMPONENTS}


def prepare_registration_directory(source_root, volume_id):
    """Prepare only the operator-owned index namespace before the root cutover."""
    from docker_dev_data_volume_copy import _load_source
    context = _load_source(source_root, volume_id)
    with storage.build_lock(context['layout']):
        require(_load_source(source_root, volume_id) == context, 'Volume preparation scope changed')
        index = Path(context['layout']['storage_root'])/'index'
        parent = guard._open_directory_nofollow(index)
        child = None
        try:
            info = os.fstat(parent)
            require(info.st_uid == os.geteuid() and not stat.S_IMODE(info.st_mode) & 0o022,
                    'Registration index must be protected and owned by the operator')
            try:
                os.mkdir('data-volumes', mode=0o755, dir_fd=parent)
            except FileExistsError:
                pass
            child = os.open('data-volumes', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            directory = os.fstat(child)
            require(directory.st_dev == info.st_dev and directory.st_uid == os.geteuid() and
                not stat.S_IMODE(directory.st_mode) & 0o022,
                'Existing registration directory has a foreign owner or writer')
            os.fsync(parent)
            return {'path': str(index/'data-volumes'), 'device': directory.st_dev, 'inode': directory.st_ino}
        finally:
            if child is not None:
                os.close(child)
            os.close(parent)


def _execution(execution, evidence):
    keys = {'schema', 'state', 'outcome', 'status', 'exit_code', 'attempt', 'config_sha256',
            'source_sha256', 'request_id', 'session_id', 'run_id', 'api_instance_id',
            'session_epoch', 'request_scope_epoch'}
    require(type(execution) is dict and set(execution) == keys and
        execution['schema'] == RESULT_SCHEMA and execution['state'] == 'terminal' and
        execution['outcome'] == execution['status'] == 'completed' and
        type(execution['exit_code']) is int and execution['exit_code'] == 0 and
        execution['attempt'] == evidence['development_attempt'] and
        execution['config_sha256'] == evidence['config_sha256'],
        'Exact completed execution of the new started group required')
    require(all(type(execution[k]) is str and execution[k] for k in
        ('request_id', 'session_id', 'run_id', 'api_instance_id', 'session_epoch', 'request_scope_epoch')) and
        re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}', execution['request_id']) and
        re.fullmatch('[0-9a-f]{64}', execution['source_sha256']), 'Completed run identity is malformed')
    return deepcopy(execution)


def _observe_run(backend, execution):
    value = _probe_with_retry(backend, 'run', **{k: execution[k] for k in
        ('api_instance_id', 'session_id', 'run_id', 'session_epoch', 'request_scope_epoch')})
    require(value.get('state') == 'observed' and value.get('run_status') == 'completed' and
        all(value.get(k) == execution[k] for k in
        ('api_instance_id', 'session_id', 'run_id', 'session_epoch', 'request_scope_epoch')),
        'New runtime no longer confirms the exact completed qualification run')
    return {k: value[k] for k in ('schema', 'state', 'run_status', 'api_instance_id',
                                  'session_id', 'run_id', 'session_epoch', 'request_scope_epoch')}


def _activation(control, context, execution, relative):
    key = _sha(execution['request_id'].encode())
    path = 'backend/script-activation-'+key+'/activation.json'
    raw = control.read_bytes(path)
    require(type(raw) is bytes and len(raw) <= 8*1024**2, 'Bounded image-side activation receipt required')
    value = _validate_activation_receipt(guard._parse_object(raw, 'qualification activation'))
    require(value['state'] == 'activated' and value['request_id'] == execution['request_id'] and
        value['source_sha256'] == execution['source_sha256'] and
        value['authorization'].get('source_root') == str(context['source']) and
        value['authorization'].get('source_relative') == relative and
        all(value['result']['response'].get(k) == execution[k] for k in ('run_id', 'session_id')),
        'Qualification activation is not the exact source/run of this group')
    return path, raw


def _live_containers(context, evidence):
    identifiers = evidence['containers']
    result = docker_capture('inspect', identifiers['backend'], identifiers['frontend'])
    actuals = guard._parse_object(b'{"containers":'+result.stdout+b'}', 'qualification containers')['containers']
    require(type(actuals) is list and len(actuals) == 2 and
        {row.get('Id') for row in actuals} == set(identifiers.values()), 'Exact new service pair required')
    snapshot = {}
    for role, identifier in identifiers.items():
        row = next(row for row in actuals if row['Id'] == identifier)
        state = row.get('State', {}); labels = row.get('Config', {}).get('Labels') or {}
        require(row.get('Image') == context['plan']['runtime_pins']['image_id'] and
            state.get('Running') is True and state.get('Health', {}).get('Status') == 'healthy' and
            all(state.get(key) is False for key in ('Paused', 'Dead', 'Restarting', 'OOMKilled')) and
            labels.get('com.docker.compose.project') == context['identity']['project_name'] and
            labels.get('com.docker.compose.service') == role, 'New service identity or health changed')
        snapshot[role] = {'fingerprint': fingerprint(row), 'started_at': state['StartedAt']}
    return snapshot


_BUILD_RECEIPT = r'''import base64,hashlib,json,os,stat
p='/opt/fullmag/package/backend-build-receipt.json'
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
try:
    before=os.fstat(fd);assert stat.S_ISREG(before.st_mode) and before.st_size<=2*1024**2
    with os.fdopen(os.dup(fd),'rb') as stream:raw=stream.read(2*1024**2+1)
    after=os.fstat(fd)
    assert (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)
    assert len(raw)==before.st_size
    print(json.dumps({'sha256':hashlib.sha256(raw).hexdigest(),'receipt':json.loads(raw),
        'raw_base64':base64.b64encode(raw).decode('ascii')}))
finally:os.close(fd)
'''


def _native_build(evidence):
    result = docker_capture('exec', evidence['containers']['backend'], '/usr/local/bin/python3',
                            '-I', '-B', '-c', _BUILD_RECEIPT, timeout=30)
    require(result.returncode == 0 and len(result.stdout) <= 8*1024**2, 'Bounded native build receipt required')
    value = guard._parse_object(result.stdout, 'native completion build')
    require(set(value) == {'sha256', 'receipt', 'raw_base64'} and type(value['raw_base64']) is str,
            'Exact native build receipt export required')
    raw = base64.b64decode(value['raw_base64'], validate=True)
    require(len(raw) <= 2*1024**2 and _sha(raw) == value['sha256'] and
        guard._parse_object(raw, 'retained native build bytes') == value['receipt'],
        'Native build receipt export bytes differ from their recorded digest')
    receipt = value.get('receipt', {})
    contract = receipt.get('native_contracts', {}).get('contracts', {}).get('fem-demag-poisson', {})
    require(value.get('sha256') == evidence['backend_build_receipt_sha256'] and
        receipt.get('state') == 'succeeded' and receipt.get('source', {}).get('resolved_commit') == evidence['source_commit'] and
        receipt.get('source', {}).get('source_snapshot_sha256') == evidence['source_snapshot_sha256'] and
        contract.get('state') == 'passed' and contract.get('test', {}).get('exit_code') == 0,
        'New native package or its Poisson contract differs from StartedGroup')
    return value


def _host_roots(context, prepared):
    roots = prepared['bound_terminal']['result']['switch']['roots']
    require(set(roots) == {'user_data', 'state'}, 'Both migrated roots required')
    for role, row in roots.items():
        path = Path(row['canonical_root'])
        observed = guard._observe_mount(path)
        payload = guard._observe_directory(Path(row['copied_root']))
        require(row['canonical_root'] == context['linux']['source_roots'][role]['canonical_root'] and
            observed['target'] == str(path) and observed['filesystem'] == 'ext4' and
            observed['filesystem_uuid'] == context['linux']['filesystem_uuid'] and
            {key: observed[key] for key in ('device', 'inode')} == payload == row['bound_identity'],
            'Canonical migrated bind or payload identity changed: '+role)
    return roots


_WRITE_PROBE = r'''import fcntl,json,os,re,stat,sys,uuid
value=json.loads(sys.argv[1])
assert set(value)=={'token','volume_id','nonce','backend','run_id','mode'}
mode=value.pop('mode');assert mode in ('write','read')
assert all(type(value[k]) is str and re.fullmatch('[0-9a-f]{32}',value[k]) for k in ('token','volume_id','nonce'))
def directory(path):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in path.split('/')[1:]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=child
        return fd
    except BaseException:
        os.close(fd);raise
result={}
for role,path in (('state','/state'),('user_data','/user-data')):
    root=directory(path)
    try:
        before=os.fstat(root);space=os.fstatvfs(root)
        assert not space.f_flag & os.ST_RDONLY
        buffer=bytearray(17);assert fcntl.ioctl(root,0x80111500,buffer,True)==0 and buffer[0]==16
        payload=dict(value,schema='fullmag.data-volume-write-proof.v1',role=role)
        raw=(json.dumps(payload,sort_keys=True,indent=2)+'\n').encode()
        name='.fullmag-volume-write-'+value['token']+'.json'
        flags=(os.O_RDWR|os.O_CREAT|os.O_EXCL) if mode=='write' else os.O_RDONLY
        fd=os.open(name,flags|os.O_NOFOLLOW,0o644,dir_fd=root)
        try:
            if mode=='write':
                with os.fdopen(os.dup(fd),'wb') as stream:
                    stream.write(raw);stream.flush();os.fsync(stream.fileno())
            os.lseek(fd,0,os.SEEK_SET);assert os.read(fd,len(raw)+1)==raw
            file=os.fstat(fd);assert stat.S_ISREG(file.st_mode) and file.st_nlink==1
        finally:os.close(fd)
        os.fsync(root)
        check=directory(path)
        try:
            after=os.fstat(check);assert (before.st_dev,before.st_ino)==(after.st_dev,after.st_ino)
        finally:os.close(check)
        result[role]={'device':before.st_dev,'inode':before.st_ino,
            'filesystem_uuid':str(uuid.UUID(bytes=bytes(buffer[1:]))),'proof_name':name,
            'proof_device':file.st_dev,'proof_inode':file.st_ino,'proof':payload,
            'available_bytes':space.f_bavail*space.f_frsize}
    finally:os.close(root)
print(json.dumps(result,sort_keys=True))
'''


def _write_probe(context, evidence, execution, token, *, retained=None):
    nonce = uuid.uuid4().hex if retained is None else retained['state']['proof']['nonce']
    values = {'token': token, 'volume_id': context['linux']['volume_id'], 'nonce': nonce,
              'backend': evidence['containers']['backend'], 'run_id': execution['run_id']}
    arguments = dict(values, mode='write' if retained is None else 'read')
    result = docker_capture('exec', values['backend'], '/usr/local/bin/python3', '-I', '-B', '-c',
                           _WRITE_PROBE, json.dumps(arguments, sort_keys=True), timeout=30)
    require(result.returncode == 0 and len(result.stdout) <= 128*1024, 'Guest write probe did not confirm both roots')
    observed = guard._parse_object(result.stdout, 'new-volume guest write proof')
    require(set(observed) == {'state', 'user_data'}, 'Guest write proof omitted a dataset')
    for role, row in observed.items():
        root = Path(context['linux']['source_roots'][role]['canonical_root'])
        metadata = guard._observe_directory(root)
        expected_name = '.fullmag-volume-write-'+token+'.json'
        expected = dict(values, schema='fullmag.data-volume-write-proof.v1', role=role)
        require(type(row) is dict and row.get('proof_name') == expected_name and row.get('proof') == expected and
            row.get('filesystem_uuid') == context['linux']['filesystem_uuid'] and
            {key: row.get(key) for key in ('device', 'inode')} == metadata,
            'Guest write proof does not identify the canonical new root: '+role)
        raw, proof = qualification._read(root/expected_name)
        file = (root/expected_name).stat(follow_symlinks=False)
        require(proof == expected and (file.st_dev, file.st_ino) == (row['proof_device'], row['proof_inode']),
                'Guest nonce is not visible through the identical host file')
        row['proof_sha256'] = _sha(raw)
        if retained is not None:
            require({k: row[k] for k in row if k != 'available_bytes'} ==
                {k: retained[role][k] for k in retained[role] if k != 'available_bytes'},
                'Qualification nonce or its filesystem identity changed: '+role)
    return observed


def _residual_source_audit(context, evidence):
    source = context['source']
    require(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip() ==
            evidence['source_commit'], 'Source HEAD changed after the qualification build')
    files = {}
    for relative in CERTIFICATE_SOURCES:
        raw = _raw(source/relative)
        committed = subprocess.check_output(['git', 'show', evidence['source_commit']+':'+relative], cwd=source)
        require(raw == committed, 'Residual certification source differs from the qualified build commit')
        files[relative] = _sha(raw)
    return {'kind': 'native_true_residual_acceptance', 'source_commit': evidence['source_commit'],
        'source_snapshot_sha256': evidence['source_snapshot_sha256'], 'files': files,
        'scope': 'native independent A*x-b certification; stored final value, no separate postprocess solve'}


def _registration(context, qualified_sha):
    plan, linux = context['plan'], context['linux']
    windows = PureWindowsPath(plan['provision_request']['backing_file_windows'])
    backing_wsl = '/mnt/'+windows.drive[:1].lower()+'/'+'/'.join(windows.parts[1:])
    return model.validate_registration({'schema': 'fullmag.user-data-volume.v1', 'state': 'committed',
        **{key: plan[key] for key in ('project_id', 'worktree_id', 'compose_project', 'volume_id', 'mount_root')},
        'backing_file_windows': plan['provision_request']['backing_file_windows'],
        'backing_file_wsl': backing_wsl, 'filesystem_uuid': linux['filesystem_uuid'],
        'datasets': [{'role': role, 'canonical_root': row['canonical_root'],
                      'relative_root': 'payload/'+Path(row['canonical_root']).relative_to(linux['storage_root']).as_posix()}
                     for role, row in linux['source_roots'].items()],
        'migration_receipt_sha256': qualified_sha})


def _index_cas(path, original, registration_path, registration_sha, volume_id):
    value = guard._parse_object(original, 'worktree completion index')
    require('data_volume_registration' not in value, 'Index already contains a volume registration')
    value['data_volume_registration'] = {'path': str(registration_path), 'sha256': registration_sha,
                                         'volume_id': volume_id}
    parent = guard._open_directory_nofollow(path.parent)
    try:
        require(_raw(path) == original, 'Worktree index changed before registration CAS')
        name = '.'+path.name+'.registration-'+uuid.uuid4().hex
        raw = _encoded(value); _exclusive(parent, name, raw)
        require(_raw(path) == original, 'Worktree index changed during registration CAS')
        os.replace(name, path.name, src_dir_fd=parent, dst_dir_fd=parent); os.fsync(parent)
    finally:
        os.close(parent)
    require(_raw(path) == raw, 'Registration index readback changed')
    return _sha(raw)


def _absent_below(root, relative):
    """Prove absence without treating permission errors as a missing file."""
    parts = Path(relative).parts
    require(parts and not Path(relative).is_absolute() and '..' not in parts,
            'Canonical output relative to its original dataset required')
    descriptor = guard._open_directory_nofollow(root)
    try:
        for name in parts[:-1]:
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            except FileNotFoundError:
                return True
            os.close(descriptor); descriptor = child
        try:
            os.stat(parts[-1], dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return True
        return False
    finally:
        os.close(descriptor)


def register_qualified_group(started, execution, script, *, expected_device):
    """Publish only after one fresh full FEM SP4 output and exact native readback."""
    require(startup.current_scope() is None, 'Close qualification scope before committing registration')
    issuer = startup._resolve_started_issuer(started)
    prepared = started._prepared
    record = issuer.require_started_group(started, prepared)
    evidence = record['result']['started_evidence']
    execution = _execution(execution, evidence)
    require(expected_device in ('cpu', 'gpu'), 'Exact FEM qualification lane required')
    require(getattr(prepared, '_completion_attempted', None) is None, 'Completion already attempted; reconcile without replay')
    context = deepcopy(prepared['context']); source = context['source']; op = context['operation_root']
    control = started._control
    require(source == Path(__file__).resolve().parents[1] and control._active_operation is None,
            'Completion must use its genuine local source and idle group control')
    relative = str(script)
    path = Path(relative)
    require(not path.is_absolute() and str(path) == relative and '..' not in path.parts and path.suffix == '.py',
            'Canonical qualification script relative to the selected source required')
    raw_script = _raw(source/path)
    require(_sha(raw_script) == execution['source_sha256'], 'Completed script source changed')
    authored = authored_zarr(raw_script)
    user_root = Path(context['linux']['source_roots']['user_data']['canonical_root'])
    zarr = user_root.joinpath(*authored.parts[2:])
    require(_raw(zarr.with_suffix('.py')) == raw_script, 'Full Zarr needs its identical adjacent host script')
    relative_output = zarr.relative_to(user_root).as_posix()
    backup = Path(prepared['bound_terminal']['result']['switch']['roots']['user_data']['backup_root'])
    require(_absent_below(backup, relative_output), 'Qualification output existed before the storage move')
    for name in ARTIFACTS:
        require(not os.path.lexists(op/name), 'Completion artifacts already exist; reconcile without replay')
    index = Path(context['layout']['storage_root'])/'index'/(context['identity']['worktree_id']+'.json')
    registration_path = index.parent/'data-volumes'/index.name
    original_index = _raw(index)
    require('data_volume_registration' not in guard._parse_object(original_index, 'worktree index') and
            not os.path.lexists(registration_path), 'Registration pair already exists')
    roots = deepcopy(_host_roots(context, prepared))
    journal_path, journal = qualification._selected_journal(op)
    require(next_phase(journal) == 'runtime-qualified', 'Final publication must follow admission exactly once')
    pending_path = pending_module.pending_path(context['layout']); pending_raw = _raw(pending_path)
    components = _pins(source); source_audit = _residual_source_audit(context, evidence)
    activation_path, activation_raw = _activation(control, context, execution, relative)
    api = _observe_run(evidence['containers']['backend'], execution)
    containers = _live_containers(context, evidence)
    native_build = _native_build(evidence)
    source_audit['build_receipt_sha256'] = native_build['sha256']
    result = qualify_completed_fem_zarr(zarr, execution['run_id'], script_sha256=execution['source_sha256'],
        expected_device=expected_device, native_build_identity={
            'git_commit': evidence['source_commit'], 'source_snapshot_sha256': evidence['source_snapshot_sha256']})
    token = uuid.uuid4().hex
    inputs = {'schema': 'fullmag.data-volume-completion-inputs.v1', 'volume_id': context['linux']['volume_id'],
        'token': token, 'source_root': str(source), 'components': components, 'execution': execution,
        'restart_receipt_sha256': record['receipt_sha256'], 'copy_receipt_sha256': context['copy_receipt_sha256'],
        'journal_sha256': _sha(_raw(journal_path)), 'pending_sha256': _sha(pending_raw),
        'index_sha256': _sha(original_index), 'zarr_tree_sha256': result['tree_sha256']}
    issuer.require_started_group(started, prepared)
    prepared._completion_attempted = token
    input_sha = _document(op, 'qualification-inputs.json', inputs)
    try:
        write_proof = _write_probe(context, evidence, execution, token)
        _document(op, 'qualification-write-probe.json', write_proof)
        issuer.require_started_group(started, prepared)

        def bookend():
            # This consumes only frozen read-only evidence, not the old
            # StartedGroup after its first final journal append.
            require(_pins(source) == components and _raw(source/path) == raw_script and
                {name: _sha(_raw(source/name)) for name in CERTIFICATE_SOURCES} == source_audit['files'] and
                _raw(zarr.with_suffix('.py')) == raw_script and _raw(pending_path) == pending_raw and
                control.read_bytes(activation_path) == activation_raw and
                _host_roots(context, prepared) == roots and _live_containers(context, evidence) == containers and
                _native_build(evidence) == native_build and
                _observe_run(evidence['containers']['backend'], execution) == api,
                'Frozen qualification evidence changed during publication')
            _write_probe(context, evidence, execution, token, retained=write_proof)
            repeated = qualify_completed_fem_zarr(zarr, execution['run_id'],
                script_sha256=execution['source_sha256'], expected_device=expected_device,
                native_build_identity={'git_commit': evidence['source_commit'],
                                       'source_snapshot_sha256': evidence['source_snapshot_sha256']})
            require(repeated == result, 'Qualification Zarr changed during completion publication')

        with control.operation('data-volume-migration', inputs) as operation:
            require(_pins(source) == components and _raw(index) == original_index and
                _raw(pending_path) == pending_raw and _sha(_raw(journal_path)) == inputs['journal_sha256'] and
                control.read_bytes(activation_path) == activation_raw,
                'Completion evidence changed before its managed publication')
            require(_host_roots(context, prepared) == roots and
                _observe_run(evidence['containers']['backend'], execution) == api,
                'New runtime or migrated roots changed before publication')
            repeated = qualify_completed_fem_zarr(zarr, execution['run_id'],
                script_sha256=execution['source_sha256'], expected_device=expected_device,
                native_build_identity={'git_commit': evidence['source_commit'],
                                       'source_snapshot_sha256': evidence['source_snapshot_sha256']})
            require(repeated == result, 'Qualification Zarr changed under the completion lease')
            current = journal
            # Journal starts accept proofs already completed above. They do
            # not claim the native execution began at this publication time.
            for phase, name, value in (
                ('runtime-qualified', 'runtime-qualified.json', {'schema': 'fullmag.data-volume-runtime-qualified.v1',
                    'state': 'qualified', 'volume_id': context['linux']['volume_id'],
                    'compose_project': control.project, 'source_root': str(source),
                    'started_evidence': evidence, 'guest_write_proof': write_proof, 'api_run_observation': api,
                    'activation_receipt_sha256': _sha(activation_raw), 'residual_source_audit': source_audit,
                    'backend_build_receipt': native_build}),
                ('zarr-qualified', 'zarr-qualified.json', {'schema': 'fullmag.data-volume-zarr-qualified.v1',
                    'state': 'qualified', 'volume_id': context['linux']['volume_id'],
                    'compose_project': control.project, 'source_root': str(source),
                    'run_id': execution['run_id'], 'request_id': execution['request_id'],
                    'script_sha256': execution['source_sha256'], 'execution': execution, 'qualification': result}),
            ):
                started_phase = append_started(current, phase, input_sha)
                _publish_journal(journal_path, current, started_phase)
                receipt_sha = _document(op, name, value)
                finished = append_terminal(started_phase, 'succeeded', receipt_sha)
                _publish_journal(journal_path, started_phase, finished); current = finished
            qualified = {'schema': 'fullmag.data-volume-migration-qualified.v1',
                'state': 'runtime-and-full-zarr-qualified',
                **{key: context['plan'][key] for key in ('project_id', 'worktree_id', 'compose_project', 'volume_id')},
                'plan_sha256': context['plan_sha256'], 'copy_receipt_sha256': context['copy_receipt_sha256'],
                'restart_receipt_sha256': record['receipt_sha256'],
                'runtime_qualification_sha256': _sha(_raw(op/'runtime-qualified.json')),
                'zarr_qualification_sha256': _sha(_raw(op/'zarr-qualified.json')),
                'namespace_admitted': True, 'data_migrated': True, 'originals_retired': False}
            qualified_sha = _document(op, 'migration-qualified.json', qualified)
            registration = _registration(context, qualified_sha)
            registration_sha = _sha(_encoded(registration))
            started_phase = append_started(current, 'volume-registered', qualified_sha)
            _publish_journal(journal_path, current, started_phase)
            _document(registration_path.parent, registration_path.name, registration)
            published_index_sha = _index_cas(index, original_index, registration_path, registration_sha,
                                              context['linux']['volume_id'])
            require(_raw(registration_path) == _encoded(registration) and _sha(_raw(index)) == published_index_sha,
                    'Registration pair changed before terminal publication')
            registered = {'schema': 'fullmag.data-volume-registered.v1', 'state': 'registration-pair-published',
                'volume_id': context['linux']['volume_id'], 'registration_sha256': registration_sha,
                'migration_receipt_sha256': qualified_sha, 'index_path': str(index),
                'index_sha256_at_publication': published_index_sha}
            registered_sha = _document(op, 'volume-registered.json', registered)
            finished = append_terminal(started_phase, 'succeeded', registered_sha)
            _publish_journal(journal_path, started_phase, finished)
            commit = {'schema': 'fullmag.data-volume-registration-commit.v1',
                **{key: context['plan'][key] for key in ('project_id', 'worktree_id', 'compose_project', 'volume_id')},
                'plan_sha256': context['plan_sha256'], 'copy_receipt_sha256': context['copy_receipt_sha256'],
                'registration_sha256': registration_sha, 'migration_receipt_sha256': qualified_sha,
                'journal_relative': journal_path.relative_to(op).as_posix(), 'journal_prefix': finished}
            bookend()
            commit_sha = _document(op, 'registration-committed.json', commit)
            bookend()
            proof = guard.verify_registered_volume(context['layout'], control.project,
                state_root=Path(context['linux']['source_roots']['state']['canonical_root']))
            operation['receipt'].update(state='succeeded', volume_id=context['linux']['volume_id'],
                registration_sha256=registration_sha, registration_commit_sha256=commit_sha,
                namespace_admitted=True, data_migrated=True, originals_retired=False)
            return {'state': 'registered-originals-retained', 'registration': registration,
                    'registration_sha256': registration_sha, 'commit_sha256': commit_sha, 'mount_proof': proof}
    except BaseException as error:
        _document(op, 'registration-failed.json', {'schema': 'fullmag.data-volume-registration-failure.v1',
            'state': 'outcome-unknown-resources-retained', 'volume_id': context['linux']['volume_id'],
            'token': token, 'inputs_sha256': input_sha, 'error_type': type(error).__name__,
            'all_results_and_originals_retained': True})
        raise
