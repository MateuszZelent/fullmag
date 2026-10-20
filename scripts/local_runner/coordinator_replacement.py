"""Explicit, forward-only replacement of an attested quiesced incarnation."""
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

from fullmag_storage import StorageError, file_lock, validate_path

SCHEMA = 'fullmag.runner.exited-replacement.v1'
MAX_BYTES = 512 * 1024


def pending_path(storage):
    return validate_path(Path(storage) / 'index' / 'local-runner-exited-replacement' / 'pending.json', Path(storage))


def is_pending(storage):
    # Inspect the lexical path too: exists/lexists swallow permission failures.
    raw = Path(storage) / 'index' / 'local-runner-exited-replacement' / 'pending.json'
    try:
        validate_path(raw, Path(storage))
    except (OSError, RuntimeError, ValueError):
        return True
    try:
        raw.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return True


def assert_no_pending(storage):
    if is_pending(storage):
        from local_runner.container_client import ContainerClientError
        raise ContainerClientError('Exited coordinator replacement requires explicit forward recovery')


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _read(path, storage, digest=None):
    from local_runner.container_client import ContainerClientError
    path = validate_path(Path(path), Path(storage))
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ContainerClientError('Replacement proof must be a bounded regular file')
    with path.open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or (digest is not None and _sha(data) != digest):
        raise ContainerClientError('Replacement proof hash or size mismatch')
    return data


def _private(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == 'nt':
        script = "& { param($p) $id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach($sid in @($id,(New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'))) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop }"
        done = subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script,str(path)], capture_output=True, timeout=15)
        if done.returncode:
            raise OSError('Cannot protect replacement snapshot/journal')
    else:
        os.chmod(path, 0o700)


def _write(path, value):
    # The parent ACL protects both the old and new file; no secret is logged.
    data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    if len(data) > MAX_BYTES:
        raise ValueError('Replacement journal exceeds bound')
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        with temporary.open('xb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if os.name == 'nt' and path.exists():
            script = '& { param($source,$target) Set-Acl -LiteralPath $target -AclObject (Get-Acl -LiteralPath $source -ErrorAction Stop) -ErrorAction Stop }'
            done = subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script,str(path),str(temporary)],capture_output=True,timeout=15)
            if done.returncode: raise OSError('Cannot preserve replacement file ACL')
        os.replace(temporary, path)
        if os.name != 'nt':
            descriptor = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(descriptor)
            finally: os.close(descriptor)
    finally:
        if temporary.exists(): temporary.unlink()


def snapshot(destination, storage, owner, blobs):
    from local_runner import boris_transition as transition
    if len(blobs) != 3 or any(len(b) > transition.MAX_CONFIG_BYTES for b in blobs):
        raise ValueError('Quiesce snapshot exceeds config bounds')
    path = validate_path(Path(destination) / 'private' / 'configs.json', storage)
    _private(path.parent)
    _write(path, dict(schema='fullmag.runner.quiesce-config-snapshot.v1', operator=owner,
                     storage=str(storage), configs=[b.hex() for b in blobs]))
    return dict(path=str(path), sha256=_sha(_read(path, storage)))


def _blobs(storage, owner):
    from local_runner import boris_transition as transition
    blobs = [transition._read_bytes(validate_path(storage/'index'/name, storage)) for name in transition.NAMES]
    transition._validate_pair(storage, owner, blobs)
    return blobs


def _delta(storage, owner, before, current, delta, entry_sha):
    from local_runner import boris_transition as transition, container_client as client
    old = list(transition._validate_pair(storage, owner, before))
    new = list(transition._validate_pair(storage, owner, current))
    if delta not in ('unchanged','enable-boris-cpu','disable-boris-cpu'):
        raise client.ContainerClientError('Unknown profile delta')
    if delta == 'unchanged':
        if before != current: raise client.ContainerClientError('Unexpected private configuration change')
        return new[1]
    profile = client.BORIS_CPU_PROFILE
    addition = delta == 'enable-boris-cpu'
    for i in (0,1):
        expected = dict(old[i]); profiles = list(expected['allowed_profiles'])
        if (profile in profiles) == addition:
            raise client.ContainerClientError('Profile delta baseline mismatch')
        expected['allowed_profiles'] = profiles + [profile] if addition else [p for p in profiles if p != profile]
        if expected != new[i]: raise client.ContainerClientError('Token or non-BORIS public/secret configuration changed')
    expected_catalog = dict(old[2]); profiles = dict(expected_catalog['profiles'])
    entry = new[2]['profiles'].get(profile) if addition else profiles.get(profile)
    if entry is None or transition.entry_sha(entry) != entry_sha:
        raise client.ContainerClientError('Expected BORIS entry digest mismatch')
    if addition:
        if profile in profiles: raise client.ContainerClientError('BORIS catalog already enabled')
        profiles[profile] = entry
    else:
        del profiles[profile]
    expected_catalog['profiles'] = profiles
    if expected_catalog != new[2]: raise client.ContainerClientError('Other build profiles changed')
    return new[1]


def _image_proof(storage, image_id, path, digest, docker):
    from local_runner import container_client as client, coordinator_image as producer
    path = validate_path(Path(path), storage)
    if not re.fullmatch('[a-f0-9]{64}',digest or ''): raise client.ContainerClientError('Exact image receipt digest required')
    receipt = json.loads(_read(path, storage, digest))
    if (receipt.get('schema') != 'fullmag.runner.coordinator-image-build.v1' or receipt.get('status') != 'SUCCEEDED_IMAGE_ONLY'
            or receipt.get('image_id') != image_id or receipt.get('native_compilation_executed') is not False
            or receipt.get('operator_changed') is not False):
        raise client.ContainerClientError('Managed coordinator image receipt mismatch')
    context = validate_path(Path(receipt['context']), storage/'tmp')
    if producer.sha(context/'context.json') != receipt['context_sha256']:
        raise client.ContainerClientError('Managed coordinator context digest mismatch')
    manifest = producer.validate_context(context)
    proof = json.loads(_read(path.parent/'source-readback.json', storage, receipt['source_readback_sha256']))
    expected = {e['path']:e['sha256'] for e in manifest['files'] if e['path'] not in ('Dockerfile','.dockerignore')}
    if proof != dict(proof_sha256=receipt['context_sha256'], files=expected):
        raise client.ContainerClientError('Managed coordinator source readback mismatch')
    for name in ('coordinator_replacement.py','build_executor.py','container_main.py'):
        if expected.get('local_runner/'+name) != producer.sha(Path(__file__).with_name(name)):
            raise client.ContainerClientError('Candidate lacks reviewed replacement runtime gate')
    actual = client._docker_json(docker, ['image','inspect',image_id])
    if not isinstance(actual,list) or len(actual)!=1:
        raise client.ContainerClientError('Exact actual coordinator image required')
    value = actual[0]
    config=value.get('Config',{})
    environment=config.get('Env') or []
    if config.get('WorkingDir')!='/opt/runner/scripts' or not isinstance(environment,list) or any(not isinstance(e,str) or e.split('=',1)[0] in ('PYTHONPATH','PYTHONHOME') for e in environment):
        raise client.ContainerClientError('Candidate Python working directory/environment differs from frozen route')
    identity = dict(Id=value.get('Id'), RootFS=value.get('RootFS'), Entrypoint=value.get('Config',{}).get('Entrypoint'))
    if identity != receipt.get('image_inspect') or identity['Id'] != image_id or identity['Entrypoint'] != producer.ENTRYPOINT:
        raise client.ContainerClientError('Actual managed coordinator image drift')
    live = client._docker_json(docker,['run','--rm','--network','none','--read-only','--user','65532:65532',
        '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','256m','--cpus','1',
        '--entrypoint','python3',image_id,'-B','-c',producer.READBACK])
    if live != proof:
        raise client.ContainerClientError('Actual image source readback differs from frozen context')
    return dict(path=str(path),sha256=digest,image_inspect=identity)


def _new_attested(layout, owner, public, identifier, docker):
    from local_runner import container_client as client, coordinator_lifecycle as lifecycle, coordinator_image as producer
    metadata = lifecycle._attested(layout,owner,public,identifier,docker)
    container = client._inspect_container(docker,identifier)
    images = client._docker_json(docker,['image','inspect',public['image_id']])
    if not isinstance(images,list) or len(images)!=1 or images[0].get('Id')!=public['image_id']:
        raise client.ContainerClientError('Replacement actual image missing')
    configured = container.get('Config',{}); original = images[0].get('Config',{})
    if original.get('Entrypoint')!=producer.ENTRYPOINT or any(configured.get(k)!=original.get(k) for k in ('Entrypoint','Cmd','User','WorkingDir','Env')):
        raise client.ContainerClientError('Replacement container command/user differs from frozen image')
    return metadata


def _create(public, storage, secret):
    from local_runner import container_client as client
    if any(',' in str(p) for p in (storage,secret)): raise client.ContainerClientError('Invalid mount path')
    command = ['create','--name',client.CONTAINER_NAME,'--hostname',client.CONTAINER_NAME,'--restart','unless-stopped']
    labels = client._container_labels(public['operator'])
    for key in sorted(labels): command.extend(['--label',key+'='+labels[key]])
    command.extend(['--publish',f"127.0.0.1:{public['port']}:{public['port']}",'--mount',f'type=bind,source={storage},target=/storage',
                    '--mount',f'type=bind,source={secret},target=/control/config.json,readonly',
                    '--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',public['image_id']])
    return command


def _locks(layout):
    from local_runner import container_client as client
    storage = client._storage_root(layout); _,_,lock = client._config_paths(layout)
    stack = ExitStack()
    try:
        stack.enter_context(file_lock(lock,'exited coordinator replacement',blocking=False))
        stack.enter_context(file_lock(storage/'locks'/'local-runner-coordinator.lock','host replacement serialization only',blocking=False))
        return stack
    except BaseException:
        stack.close(); raise


def _quiesce_proof(path, digest, storage, owner, old_id, old_image):
    from local_runner import container_client as client, coordinator_lifecycle as lifecycle, boris_transition as transition
    path=validate_path(Path(path),storage)
    if not re.fullmatch('[a-f0-9]{64}',digest or ''): raise client.ContainerClientError('Exact quiesce receipt digest required')
    receipt=json.loads(_read(path,storage,digest))
    terminal=receipt.get('terminal_container',{})
    if (receipt.get('schema')!='fullmag.runner.coordinator-quiesce.v2' or receipt.get('status')!='SUCCEEDED_EXITED_PAUSED_ONLY'
            or receipt.get('container_id')!=old_id or receipt.get('image_id')!=old_image
            or receipt.get('operator')!=owner or receipt.get('storage')!=str(storage) or receipt.get('receipt_path')!=str(path)
            or receipt.get('producer_sha256')!=_sha(Path(lifecycle.__file__).read_bytes())
            or receipt.get('linux_fence_script_sha256')!=_sha(lifecycle.REMOTE.encode())
            or receipt.get('exec_destroyed') is not True or receipt.get('actual_container_exited') is not True
            or receipt.get('coordinator_stop_requested') is not True
            or terminal.get('container_id')!=old_id or terminal.get('image_id')!=old_image
            or terminal.get('running') is not False or terminal.get('state')!='exited'):
        raise client.ContainerClientError('Successful bound quiesce receipt required')
    for field,state in (('held_ack','HELD'),('armed_ack','ARMED')):
        ack=receipt.get(field,{})
        if ack.get('state')!=state or type(ack.get('pid')) is not int or ack['pid']<=0 or not re.fullmatch('[a-f0-9]{32}',ack.get('nonce','')):
            raise client.ContainerClientError('Quiesce Linux fence acknowledgement missing')
    if receipt['held_ack']['nonce']!=receipt['armed_ack']['nonce'] or receipt['held_ack']['pid']!=receipt['armed_ack']['pid']:
        raise client.ContainerClientError('Quiesce Linux fence incarnation drift')
    sources=receipt.get('reviewed_source_hashes',{})
    if set(sources)!=set(lifecycle.SOURCE_FILES) or any(not re.fullmatch('[a-f0-9]{64}',v or '') for v in sources.values()):
        raise client.ContainerClientError('Quiesce reviewed source identity missing')
    source=receipt['config_snapshot']
    if Path(source['path'])!=path.parent/'private'/'configs.json': raise client.ContainerClientError('Quiesce snapshot path binding invalid')
    frozen=json.loads(_read(source['path'],storage,source['sha256']))
    if frozen.get('schema')!='fullmag.runner.quiesce-config-snapshot.v1' or frozen.get('operator')!=owner or frozen.get('storage')!=str(storage):
        raise client.ContainerClientError('Quiesce private snapshot identity mismatch')
    before=[bytes.fromhex(s) for s in frozen['configs']]
    if len(before)!=3 or any(len(b)>transition.MAX_CONFIG_BYTES for b in before): raise client.ContainerClientError('Snapshot config bound')
    transition._validate_pair(storage,owner,before)
    if _sha(before[1])!=receipt['expected_public_sha256'] or _sha(before[2])!=receipt['expected_catalog_sha256']:
        raise client.ContainerClientError('Quiesce snapshot baseline digest drift')
    return receipt,before


def replace_exited(layout, owner, *, quiesce_receipt, quiesce_receipt_sha256, expected_container_id, expected_image_id,
                   expected_container_sha256, expected_build_config_sha256, image_id, image_build_receipt,
                   image_build_receipt_sha256, profile_delta='unchanged', expected_boris_entry_sha256=None,
                   docker_call=None, health_call=None):
    from local_runner import container_client as client, coordinator_lifecycle as lifecycle, boris_transition as transition
    owner = client._owner(owner); client._image_id(image_id); client._image_id(expected_image_id)
    if not client._CONTAINER_ID_RE.fullmatch(expected_container_id or ''):
        raise client.ContainerClientError('Exact old incarnation required')
    docker = docker_call or lifecycle._docker; health = health_call or client.request
    storage = client._storage_root(layout)
    for digest in (quiesce_receipt_sha256,expected_container_sha256,expected_build_config_sha256,image_build_receipt_sha256):
        if not re.fullmatch('[a-f0-9]{64}', digest or ''): raise client.ContainerClientError('Exact proof digests required')
    with _locks(layout):
        assert_no_pending(storage); transition.assert_no_pending(storage)
        receipt,before = _quiesce_proof(quiesce_receipt,quiesce_receipt_sha256,storage,owner,expected_container_id,expected_image_id)
        current = _blobs(storage,owner)
        if _sha(current[1])!=expected_container_sha256 or _sha(current[2])!=expected_build_config_sha256:
            raise client.ContainerClientError('Current configuration compare-and-swap failed')
        public = _delta(storage,owner,before,current,profile_delta,expected_boris_entry_sha256)
        if public['image_id']!=expected_image_id: raise client.ContainerClientError('Old image config drift')
        old = lifecycle._attested(layout,owner,public,expected_container_id,docker)
        if old['running'] or old['state']!='exited': raise client.ContainerClientError('Quiesced exact exited incarnation required')
        lifecycle._inventory(docker,expected_container_id)
        if lifecycle._queue_guard(storage)!=receipt['final_guard']['queue']: raise client.ContainerClientError('Quiesce queue fingerprint changed')
        proof = _image_proof(storage,image_id,image_build_receipt,image_build_receipt_sha256,docker)
        desired = dict(public,image_id=image_id)
        desired_bytes = (json.dumps(desired,indent=2)+'\n').encode()
        path = pending_path(storage); _private(path.parent)
        journal = dict(schema=SCHEMA,transaction_id=uuid.uuid4().hex,operator=owner,storage=str(storage),phase='PREPARED',
                       old_id=expected_container_id,old_image=expected_image_id,new_id=None,image_id=image_id,image_proof=proof,
                       configs=[b.hex() for b in current],desired_public=desired_bytes.hex(),queue=receipt['final_guard']['queue'],
                       quiesce_receipt=str(quiesce_receipt),quiesce_sha256=quiesce_receipt_sha256,
                       pause_marker_sha256=receipt['pause_marker_sha256'],profile_delta=profile_delta,boris_entry_sha256=expected_boris_entry_sha256)
        _write(path,journal)
        return _advance(layout,owner,journal,docker,health,None)


def recover_exited(layout, owner, transaction_id, *, expected_new_container_id=None, docker_call=None, health_call=None):
    from local_runner import container_client as client, coordinator_lifecycle as lifecycle
    owner = client._owner(owner); storage = client._storage_root(layout)
    with _locks(layout):
        journal = json.loads(_read(pending_path(storage),storage))
        if (journal.get('schema')!=SCHEMA or journal.get('transaction_id')!=transaction_id
                or journal.get('operator')!=owner or journal.get('storage')!=str(storage)):
            raise client.ContainerClientError('Exact replacement recovery identity required')
        return _advance(layout,owner,journal,docker_call or lifecycle._docker,health_call or client.request,expected_new_container_id)


def _advance(layout, owner, journal, docker, health, recovered_id):
    from local_runner import container_client as client, coordinator_lifecycle as lifecycle, boris_transition as transition
    from local_runner.service import read_stop_request, ServicePaths
    storage = client._storage_root(layout); path = pending_path(storage)
    transition.assert_no_pending(storage)
    baseline = [bytes.fromhex(s) for s in journal['configs']]
    desired_bytes = bytes.fromhex(journal['desired_public']); desired = json.loads(desired_bytes)
    if len(baseline)!=3 or any(len(b)>transition.MAX_CONFIG_BYTES for b in baseline+[desired_bytes]): raise client.ContainerClientError('Recovery config bound')
    transition._validate_pair(storage,owner,baseline)
    if not client._IMAGE_RE.fullmatch(journal['image_id']) or (journal['new_id'] is not None and not client._CONTAINER_ID_RE.fullmatch(journal['new_id'])):
        raise client.ContainerClientError('Recovery image/container identity invalid')
    quiesce,original = _quiesce_proof(journal['quiesce_receipt'],journal['quiesce_sha256'],storage,owner,journal['old_id'],journal['old_image'])
    if quiesce['final_guard']['queue']!=journal['queue'] or quiesce['pause_marker_sha256']!=journal['pause_marker_sha256']:
        raise client.ContainerClientError('Recovery quiesce proof drift')
    _delta(storage,owner,original,baseline,journal['profile_delta'],journal['boris_entry_sha256'])
    if journal['old_image']!=json.loads(baseline[1])['image_id'] or desired != dict(json.loads(baseline[1]),image_id=journal['image_id']):
        raise client.ContainerClientError('Recovery desired config drift')
    _image_proof(storage,journal['image_id'],journal['image_proof']['path'],journal['image_proof']['sha256'],docker)
    phases=('PREPARED','REMOVE_REQUESTED','OLD_REMOVED','PUBLIC_UPDATE_REQUESTED','PUBLIC_UPDATED','CREATE_REQUESTED','CREATED','START_REQUESTED','STARTED_PAUSED','SUCCEEDED_PAUSED')
    if journal['phase'] not in phases or not client._CONTAINER_ID_RE.fullmatch(journal['old_id']): raise client.ContainerClientError('Recovery journal state invalid')
    if not re.fullmatch('[a-f0-9]{32}',journal.get('transaction_id','')):
        raise client.ContainerClientError('Recovery transaction ID invalid')
    created = phases.index(journal['phase'])>=phases.index('CREATED')
    if created != (journal['new_id'] is not None): raise client.ContainerClientError('Recovery phase/container binding invalid')
    if recovered_id is not None and (not client._CONTAINER_ID_RE.fullmatch(recovered_id) or journal['new_id'] not in (None,recovered_id)):
        raise client.ContainerClientError('Explicit recovery incarnation mismatch')
    def checkpoint(phase):
        journal['phase']=phase; _write(path,journal)
    def guard():
        current = _blobs(storage,owner)
        if current[0]!=baseline[0] or current[2]!=baseline[2] or current[1] not in (baseline[1],desired_bytes):
            raise client.ContainerClientError('Replacement private configuration CAS drift')
        if lifecycle._queue_guard(storage)!=journal['queue']: raise client.ContainerClientError('Replacement queue fingerprint changed')
        lifecycle._inventory(docker,journal['new_id'] or journal['old_id'])
        if read_stop_request(ServicePaths.from_storage(storage)) is None or _sha(_read(ServicePaths.from_storage(storage).stop_request_path,storage))!=journal['pause_marker_sha256']:
            raise client.ContainerClientError('Replacement durable pause changed or missing')
        if journal['phase'] in ('PUBLIC_UPDATED','CREATE_REQUESTED','CREATED','START_REQUESTED','STARTED_PAUSED','SUCCEEDED_PAUSED') and current[1]!=desired_bytes:
            raise client.ContainerClientError('Desired public image config reverted')
    guard()
    if journal['phase'] in ('PREPARED','REMOVE_REQUESTED'):
        found=client._find_container(docker)
        if found is not None:
            old=lifecycle._attested(layout,owner,json.loads(baseline[1]),journal['old_id'],docker)
            if old['running'] or old['state']!='exited' or old['container_id']!=found: raise client.ContainerClientError('Old incarnation no longer exited/owned')
            checkpoint('REMOVE_REQUESTED'); guard(); client._docker_text(docker,['rm',journal['old_id']])
        elif journal['phase']=='PREPARED': raise client.ContainerClientError('Old incarnation absent before removal checkpoint')
        identifiers=client._docker_text(docker,['ps','-a','--no-trunc','--format','{{.ID}}']).split()
        if journal['old_id'] in identifiers: raise client.ContainerClientError('Exact old incarnation still exists after removal')
        if client._find_container(docker) is not None: raise client.ContainerClientError('Reserved name not empty after exact removal')
        checkpoint('OLD_REMOVED')
    if journal['phase'] in ('OLD_REMOVED','PUBLIC_UPDATE_REQUESTED'):
        if client._find_container(docker) is not None: raise client.ContainerClientError('Foreign reserved name before config update')
        checkpoint('PUBLIC_UPDATE_REQUESTED'); guard()
        # Existing file's ACL is preserved by the established config writer.
        _write(storage/'index'/transition.NAMES[1],desired_bytes)
        checkpoint('PUBLIC_UPDATED')
    if journal['phase'] in ('PUBLIC_UPDATED','CREATE_REQUESTED'):
        guard(); found=client._find_container(docker)
        if found is not None:
            if journal['phase']!='CREATE_REQUESTED' or not client._CONTAINER_ID_RE.fullmatch(recovered_id or '') or found!=recovered_id:
                raise client.ContainerClientError('Ambiguous create requires explicit exact new container ID')
            identifier=recovered_id
        else:
            if recovered_id is not None: raise client.ContainerClientError('Explicit recovery container absent')
            checkpoint('CREATE_REQUESTED'); guard()
            identifier=client._docker_text(docker,_create(desired,storage,storage/'index'/transition.NAMES[0])).strip()
        if not client._CONTAINER_ID_RE.fullmatch(identifier): raise client.ContainerClientError('Create did not return full exact ID')
        _new_attested(layout,owner,desired,identifier,docker)
        journal['new_id']=identifier; checkpoint('CREATED')
    if journal['phase'] in ('CREATED','START_REQUESTED'):
        guard(); current=_new_attested(layout,owner,desired,journal['new_id'],docker)
        if current['state'] not in ('created','exited','running'): raise client.ContainerClientError('Owned new incarnation state uncertain')
        if not current['running']:
            checkpoint('START_REQUESTED'); guard(); client._docker_text(docker,['start',journal['new_id']])
        checkpoint('STARTED_PAUSED')
    guard(); actual=_new_attested(layout,owner,desired,journal['new_id'],docker)
    if not actual['running'] or actual['state']!='running': raise client.ContainerClientError('Started replacement not running')
    snapshot=health(layout,owner,'GET','/health'); client._assert_replacement_health(snapshot)
    if snapshot.get('stop_requested') is not True or snapshot.get('worker_alive') is not False or snapshot.get('accepting_jobs') is not False:
        raise client.ContainerClientError('Replacement authenticated pause not confirmed')
    guard(); checkpoint('SUCCEEDED_PAUSED')
    result=dict(schema=SCHEMA,status='SUCCEEDED_PAUSED',transaction_id=journal['transaction_id'],old_id=journal['old_id'],
                container_id=journal['new_id'],image_id=journal['image_id'],queue=journal['queue'],qualification='INSTALLED_LIFECYCLE_NOT_VERIFIED')
    _write(path.parent/(journal['transaction_id']+'-receipt.json'),result)
    if json.loads(_read(path,storage))!=journal: raise client.ContainerClientError('Replacement pending ownership changed')
    path.unlink()
    transition._sync_directory(path.parent)
    return result