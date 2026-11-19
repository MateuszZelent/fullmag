"""Close one failed, unreleased startup activation for fresh-state archival.

This is a technical handoff under the original activation helper's lease.
It never cancels/replays a solver or rewrites its RunIntent. The old store,
activation marker and unknown receipt are retained. Only a fresh-state
recreation is admitted afterwards; restoring this generation stays forbidden.
"""
from __future__ import annotations

import hashlib
import io
import inspect
import json
import time
from collections.abc import Mapping
from pathlib import Path
import os
import tarfile

from docker_build_control import BuildControlError, canonical, docker_capture


RECORD = "preparation-abort/current.json"
SCHEMA = "fullmag.docker-unreleased-preparation-abort.v1"


def _fail(message):
    raise BuildControlError(message)


def _catalog_ledger_control_sha256(value):
    state = value.get("runtime_state")
    if (not isinstance(state, dict) or set(state) != {"schema_version", "readiness_sha256", "snapshot_sha256"}
            or state.get("schema_version") != "host_runtime_state.v1"):
        raise ValueError("Catalog-failure ledger has no exact v4 runtime state")
    for field in ("readiness_sha256", "snapshot_sha256"):
        digest = state.get(field)
        if (not isinstance(digest, str) or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)):
            raise ValueError("Catalog-failure ledger has an invalid runtime-state digest")
    # Inventory samples advance independently of reservations. Preserve every
    # other field, including readiness, policy, ownership and all reservations.
    stable = {**value, "runtime_state": {**state, "snapshot_sha256": None}}
    return hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def _store_probe(backend_id, activation, *, catalog_failure=False):
    # Only the exact current unreleased startup run is eligible. Historical
    # runs remain untouched; an archive-only exception permits one exact
    # pending preparation lease, without cancelling or releasing it.
    script = ("ACTIVATION = " + repr(activation) + "\nCATALOG_FAILURE = " + repr(catalog_failure)
              + "\n" + inspect.getsource(_catalog_ledger_control_sha256)
              + r'''import fcntl,hashlib,json,os,pathlib,stat,time
root=pathlib.Path('/state/runs/docker-all/session-store')
def raw(path,maximum=16*1024*1024):
    if path.parent.resolve(strict=True)!=path.parent: raise RuntimeError('noncanonical store parent')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>maximum:
            raise RuntimeError('store record is not a bounded regular file')
        data=os.read(fd,maximum+1)
        if len(data)!=st.st_size: raise RuntimeError('store record changed while reading')
        return data
    finally: os.close(fd)
def unique(pairs):
    out={}
    for k,v in pairs:
        if k in out: raise RuntimeError('duplicate JSON key')
        out[k]=v
    return out
def valid_id(value):
    return (isinstance(value,str) and 0<len(value)<=128 and value not in ('.','..')
        and all(ch.isascii() and (ch.isalnum() or ch in '._-') for ch in value))
def valid_sha(value):
    return isinstance(value,str) and len(value)==64 and all(ch in '0123456789abcdef' for ch in value)
def valid_prefixed_sha(value):
    return isinstance(value,str) and value.startswith('sha256:') and valid_sha(value[7:])
def positive_int(value):
    return type(value) is int and value>0
def linux_native_store_id():
    if os.environ.get('FULLMAG_SESSION_STORAGE_PROFILE')!='linux-native-v1':
        raise RuntimeError('held preparation archive requires the Linux native storage profile')
    state=pathlib.Path('/state')
    if state.resolve(strict=True)!=state or root.resolve(strict=True)!=root:
        raise RuntimeError('session store root is linked or noncanonical')
    try: relative=root.relative_to(state).as_posix()
    except ValueError: raise RuntimeError('session store root escapes its attested state root')
    if not relative or any(part in ('','.','..') for part in pathlib.PurePosixPath(relative).parts):
        raise RuntimeError('session store relative path is invalid')
    host=json.loads(raw(pathlib.Path('/run/fullmag/linux-native-host.json'),1024*1024),object_pairs_hook=unique)
    owner=json.loads(raw(state/'.fullmag-linux-native-owner.json',1024*1024),object_pairs_hook=unique)
    token=host.get('owner_token'); engine=host.get('engine_id')
    host_value=json.dumps(host,sort_keys=True,separators=(',',':'),ensure_ascii=False)
    owner_value=json.dumps(owner,sort_keys=True,separators=(',',':'),ensure_ascii=False)
    import unicodedata
    if (host_value!=owner_value or host.get('schema')!='fullmag.linux-native-host.v1'
        or host.get('storage_profile')!='linux-native-v1' or host.get('role')!='session'
        or host.get('owner_scope')!='docker-linux' or host.get('restart_verified') is not True
        or not isinstance(token,str) or len(token)!=32 or any(ch not in '0123456789abcdef' for ch in token)
        or not isinstance(engine,str) or not engine or len(engine.encode('utf-8'))>256
        or any(unicodedata.category(ch)=='Cc' for ch in engine)):
        raise RuntimeError('Linux native host owner/profile evidence is invalid')
    stable={'schema':'fullmag.linux-native-store-identity.v1','engine_id':engine,
        'owner_token':token,'relative_state_path':relative}
    encoded=json.dumps(stable,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')
    return 'sha256:'+hashlib.sha256(encoded).hexdigest()
def obj(path): return json.loads(raw(path),object_pairs_hook=unique)
def lock_for_probe(descriptor):
    deadline=time.monotonic()+2.0
    while True:
        try:
            fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if not CATALOG_FAILURE or time.monotonic()>=deadline: raise
            time.sleep(0.02)
ledger=pathlib.Path('/host-ledger/ledger')
lf=os.open(ledger/'WRITER.lock',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
lock_for_probe(lf)
data=raw(ledger/'HOST_RESOURCE_LEDGER.json'); value=json.loads(data,object_pairs_hook=unique)
rows=value.get('reservations')
if isinstance(rows,dict): rows=list(rows.values())
if value.get('schema_version')!='host_resource_ledger.v4' or not isinstance(rows,list) or any(not isinstance(r,dict) for r in rows):
    raise RuntimeError('host reservation ledger is not a supported bounded document')
active_rows=[r for r in rows if r.get('state')!='released']
fd=os.open(root/'WRITER.lock',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
    if not stat.S_ISREG(os.fstat(fd).st_mode): raise RuntimeError('store writer lock is not regular')
    lock_for_probe(fd)
    found=[]; pins={}; active_preparation=[]; matched_project_id=None
    runs=list((root/'runs').iterdir())
    if len(runs)>256: raise RuntimeError('store exceeds bounded abort scope')
    for run in runs:
        if run.is_symlink() or not run.is_dir(): raise RuntimeError('invalid run directory')
        for name in ('resource_leases','preparation_resource_leases'):
            lease_root=run/name
            if lease_root.is_symlink(): raise RuntimeError('linked lease directory')
            if lease_root.exists():
                if not lease_root.is_dir(): raise RuntimeError('lease root is not a directory')
                for parent,dirs,files in os.walk(lease_root,followlinks=False):
                    if any((pathlib.Path(parent)/d).is_symlink() for d in dirs): raise RuntimeError('linked lease parent')
                    for name in files:
                        p=pathlib.Path(parent)/name
                        lease_raw=raw(p); lease=json.loads(lease_raw,object_pairs_hook=unique)
                        if lease.get('state')=='released':
                            pins[str(p.relative_to(root))]=hashlib.sha256(lease_raw).hexdigest()
                        elif lease_root.name=='preparation_resource_leases' and lease.get('state')=='active':
                            active_preparation.append((run.name,str(p.relative_to(root)),lease,hashlib.sha256(lease_raw).hexdigest()))
                            pins[str(p.relative_to(root))]=hashlib.sha256(lease_raw).hexdigest()
                        else: raise RuntimeError('active or unknown resource lease')
        intent_path=run/'run_intent.json'
        intent=obj(intent_path)
        specification=intent.get('specification',{})
        params=specification.get('parameters',{})
        command=params.get('live_workspace',{}).get('command',{})
        if command.get('request_id')!=ACTIVATION['request_id']: continue
        catalog_path=run/'run_catalog.json'
        try: catalog=obj(catalog_path)
        except FileNotFoundError:
            if not CATALOG_FAILURE: raise
            catalog=None
        if (intent.get('schema_version')!='run_intent.v1' or intent.get('run_id')!=run.name
            or specification.get('schema_version')!='run_spec.v2' or specification.get('run_id')!=run.name
            or hashlib.sha256(json.dumps(specification,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!=intent.get('payload_sha256')
            or params.get('fullmag.accepted_run_start')!={'schema_version':'accepted_run_start_policy.v1','mode':'manual'}
            or command.get('kind')!='startup_script'
            or command.get('source_sha256')!=ACTIVATION['source_sha256']
            or intent.get('idempotency_key')!='live-http-'+ACTIVATION['activation_receipt_key']):
            raise RuntimeError('activation is not an exact unreleased, unprepared manual run')
        if CATALOG_FAILURE:
            if catalog is not None: raise RuntimeError('catalog-failure archive requires an absent RunCatalog')
        else:
            tasks=catalog.get('tasks',[])
            if (catalog.get('schema_version')!='run_catalog.v1' or catalog.get('run_id')!=run.name
            or type(catalog.get('revision')) is not int or catalog['revision']<=0
            or len(tasks)!=1 or tasks[0].get('lifecycle')!='accepted'
            or tasks[0].get('readiness')!={'state':'blocked','reason':'accepted_task_awaiting_preparation'}
            or tasks[0].get('artifact_ids')!=[]):
                raise RuntimeError('activation is not an exact unreleased, unprepared manual task')
        found.append(run.name)
        if CATALOG_FAILURE:
            matched_project_id=specification.get('snapshot',{}).get('project_id')
            if not valid_id(matched_project_id): raise RuntimeError('accepted run project identity is invalid')
        for p in ([intent_path] if CATALOG_FAILURE else [intent_path,catalog_path]):
            pins[str(p.relative_to(root))]=hashlib.sha256(raw(p)).hexdigest()
    if len(found)!=1: raise RuntimeError('activation has no unique held RunIntent')
    run_id=found[0]; run=root/'runs'/run_id
    task=None if CATALOG_FAILURE else obj(run/'run_catalog.json')['tasks'][0]
    target_lease=[entry for entry in active_preparation if entry[0]==run_id]
    if CATALOG_FAILURE:
        if active_rows or active_preparation or {p.name for p in run.iterdir()}!={'run_intent.json'}:
            raise RuntimeError('catalog-failure run acquired admission, release, task or lease state')
        mode='unmaterialized_catalog'
        run_inventory={'directories':[],'files':['run_intent.json']}
    elif not active_rows and not active_preparation:
        mode='unadmitted'
        if {p.name for p in run.iterdir()}!={'run_intent.json','run_catalog.json'}:
            raise RuntimeError('unadmitted activation acquired durable task state')
        run_inventory={'directories':[],'files':['run_catalog.json','run_intent.json']}
    else:
        if len(active_rows)!=1 or len(active_preparation)!=1 or len(target_lease)!=1:
            raise RuntimeError('archive-only proof requires one exact active preparation reservation and lease')
        mode='held_preparation'
        _,lease_relative,lease,lease_sha=target_lease[0]
        allowed_lease_keys={'schema_version','resource_id','budget','run_id','task_id','preparation_attempt_id','lease_token','state','acquired_at','heartbeat_at','heartbeat_sequence','released_at','host_launch_binding'}
        required_lease_keys={'schema_version','resource_id','budget','run_id','task_id','preparation_attempt_id','lease_token','state','acquired_at','heartbeat_at','heartbeat_sequence','host_launch_binding'}
        if (not required_lease_keys.issubset(lease) or not set(lease).issubset(allowed_lease_keys)
            or lease.get('schema_version')!='preparation_resource_lease.v1' or lease.get('state')!='active'
            or lease.get('released_at') is not None or lease.get('run_id')!=run_id
            or lease.get('task_id')!=task.get('task_id')):
            raise RuntimeError('active preparation lease is malformed or already released')
        identity=active_rows[0].get('identity'); binding=lease.get('host_launch_binding')
        if not isinstance(identity,dict) or not isinstance(binding,dict):
            raise RuntimeError('preparation reservation identity or host binding is missing')
        attempt=lease.get('preparation_attempt_id'); resource=lease.get('resource_id'); token=lease.get('lease_token')
        store_id=identity.get('store_id')
        if store_id!=linux_native_store_id():
            raise RuntimeError('preparation reservation store identity differs from the mounted state root')
        expected_identity={'store_id':store_id,'run_id':run_id,'task_id':task.get('task_id'),
            'resource_id':resource,'owner':{'kind':'preparation','preparation_attempt_id':attempt},'lease_token':token}
        row=active_rows[0]
        allowed_row_keys={'identity','request_sha256','host_id','policy_revision','host_owner_epoch',
            'runtime_generation_sha256','compute_node_owner_id','compute_node_owner_epoch','topology_sha256',
            'budget','exclusive_gpu_uuids','gpu_vram_bytes_by_uuid','cpu_ids','release_proof_sha256','state',
            'worker_launch_gate','preparation_launch_gate','preparation_launch_owner','node_policy_revision',
            'scheduling_priority','parallelism'}
        required_row_keys={'identity','request_sha256','host_id','policy_revision','host_owner_epoch',
            'topology_sha256','budget','state','preparation_launch_gate'}
        if (not required_row_keys.issubset(row) or not set(row).issubset(allowed_row_keys)
            or identity!=expected_identity or row.get('state')!='committed'
            or not valid_sha(row.get('request_sha256')) or not valid_sha(row.get('topology_sha256'))
            or row.get('budget')!=lease.get('budget') or row.get('release_proof_sha256') is not None
            or row.get('worker_launch_gate') is not None
            or row.get('preparation_launch_gate')!={'state':'pending'}
            or row.get('preparation_launch_owner') is not None):
            raise RuntimeError('preparation reservation is not the exact committed pending permit')
        policy=binding.get('policy'); generation=binding.get('runtime_generation_sha256')
        if (set(binding)-{'schema_version','ledger_root','policy','runtime_generation_sha256'}
            or not {'schema_version','ledger_root','policy'}.issubset(binding)
            or binding.get('schema_version')!='host_launch_binding.v1'
            or binding.get('ledger_root')!=str(ledger)
            or not isinstance(policy,dict) or policy!=value.get('policy')
            or policy.get('schema_version') not in ('host_resource_ledger_policy.v1','host_resource_ledger_policy.v2','host_resource_ledger_policy.v3')
            or not positive_int(policy.get('revision')) or not positive_int(policy.get('owner_epoch'))
            or not isinstance(policy.get('host_id'),str) or not policy.get('host_id')
            or not valid_sha(policy.get('topology_sha256'))
            or (policy.get('schema_version') in ('host_resource_ledger_policy.v2','host_resource_ledger_policy.v3') and generation is None)
            or (generation is not None and not valid_sha(generation))
            or generation!=row.get('runtime_generation_sha256')
            or not positive_int(row.get('policy_revision')) or row.get('policy_revision')!=policy.get('revision')
            or not positive_int(row.get('host_owner_epoch')) or row.get('host_owner_epoch')!=policy.get('owner_epoch')
            or row.get('host_id')!=policy.get('host_id') or row.get('topology_sha256')!=policy.get('topology_sha256')
            or not valid_prefixed_sha(store_id)):
            raise RuntimeError('preparation host binding differs from its pinned ledger generation')
        if (set(task)!={'task_id','input_fingerprint','lifecycle','readiness','artifact_ids'}
            or not isinstance(task.get('input_fingerprint'),str) or len(task['input_fingerprint'])!=64
            or any(ch not in '0123456789abcdef' for ch in task['input_fingerprint'])):
            raise RuntimeError('accepted task contains admission or output state')
        if (not valid_id(run_id) or not valid_id(task.get('task_id'))
            or not valid_id(attempt) or not valid_id(resource) or not valid_id(token)
            or lease_relative!='runs/'+run_id+'/preparation_resource_leases/'+resource+'/'+token+'.json'):
            raise RuntimeError('preparation lease is outside its canonical run path')
        directories=['preparation_resource_leases','preparation_resource_leases/'+resource]
        files=['run_catalog.json','run_intent.json','preparation_resource_leases/'+resource+'/'+token+'.json']
        observed_dirs=[]; observed_files=[]
        for parent,dirs,leaf_files in os.walk(run,followlinks=False):
            parent_path=pathlib.Path(parent)
            for child in dirs:
                entry=parent_path/child
                if entry.is_symlink() or not entry.is_dir(): raise RuntimeError('linked or invalid held-run directory')
                observed_dirs.append(entry.relative_to(run).as_posix())
            for child in leaf_files:
                entry=parent_path/child
                if entry.is_symlink(): raise RuntimeError('linked held-run file')
                observed_files.append(entry.relative_to(run).as_posix())
            if len(observed_dirs)>16 or len(observed_files)>32:
                raise RuntimeError('held run exceeds the bounded archive-only inventory')
        run_inventory={'directories':sorted(observed_dirs),'files':sorted(observed_files)}
        if run_inventory!={'directories':sorted(directories),'files':sorted(files)}:
            raise RuntimeError('held run contains a release, claim, receipt, output or unknown file')
        for relative in files:
            path=run/relative
            pins[str(path.relative_to(root))]=hashlib.sha256(raw(path)).hexdigest()
        if pins.get(lease_relative)!=lease_sha:
            raise RuntimeError('active preparation lease pin changed during proof')
    proof={'run_id':run_id,'mode':mode,'run_inventory':run_inventory,'store_pins':pins,'ledger_sha256':hashlib.sha256(data).hexdigest(),'run_ids':sorted(p.name for p in runs)}
    if CATALOG_FAILURE:
        proof.update(project_id=matched_project_id,ledger_control_sha256=_catalog_ledger_control_sha256(value))
    print(json.dumps(proof,sort_keys=True))
finally:
    os.close(fd)
    os.close(lf)
''')
    return json.loads(docker_capture("exec", backend_id, "python3", "-B", "-c", script, timeout=30).stdout)


def _run_inventory(run):
    directories = []
    files = []
    for parent, dirs, leaf_files in os.walk(run, followlinks=False):
        parent_path = Path(parent)
        for name in dirs:
            path = parent_path / name
            if path.is_symlink() or not path.is_dir():
                _fail("Held run contains a linked or invalid directory")
            directories.append(path.relative_to(run).as_posix())
        for name in leaf_files:
            path = parent_path / name
            if path.is_symlink():
                _fail("Held run contains a linked file")
            files.append(path.relative_to(run).as_posix())
        if len(directories) > 16 or len(files) > 32:
            _fail("Held run exceeds the bounded archive-only inventory")
    return {"directories": sorted(directories), "files": sorted(files)}


def _stopped_ledger_sha256(container_id, *, catalog_failure=False):
    archive = docker_capture(
        "cp", container_id + ":/host-ledger/ledger/HOST_RESOURCE_LEDGER.json", "-", timeout=90
    ).stdout
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:*") as source:
            members = source.getmembers()
            if (len(members) != 1 or members[0].name != "HOST_RESOURCE_LEDGER.json"
                    or not members[0].isfile() or members[0].size > 16 * 1024 * 1024):
                _fail("Stopped backend did not return one bounded host-ledger document")
            stream = source.extractfile(members[0])
            if stream is None:
                _fail("Stopped backend host-ledger archive is unreadable")
            data = stream.read(16 * 1024 * 1024 + 1)
            if len(data) != members[0].size:
                _fail("Stopped backend host-ledger document changed while reading")
            return (_catalog_ledger_control_sha256(json.loads(data)) if catalog_failure else
                    hashlib.sha256(data).hexdigest())
    except (tarfile.TarError, OSError) as error:
        raise BuildControlError("Stopped backend host-ledger archive is invalid") from error


def abort_pending_preparation(args, control, selected, identity, previous, document,
                              previous_root, operation_inputs, resume_pin):
    from docker_volume_activation_reconcile import (
        _validate_helper, _validate_helper_logged, _wait_for_helper_exit,
        _validate_activation_receipt,
    )
    from docker_volume_stop_diagnostic import (
        ATTEMPT_RE, _read_raw, _json, _container_snapshot, _probe_backend,
        _probe_evidence, _terminal_receipt,
    )
    from docker_volume_unclaimed_cancellation import (
        _project_container_ids, _volume_consumer_ids, _publish_immutable,
    )
    attempt = args.pending_activation
    catalog_failure = bool(getattr(args, "catalog_failure", False))
    if catalog_failure:
        from docker_volume_catalog_failure import probe_catalog_failure, verify_catalog_failure_drain
    evidence_keys = (("runtime_config_sha256", "process_receipt_sha256", "ready_owner_identity",
                      "api_instance_id", "session_identity", "preparation_sha256", "commands_sha256")
                     if catalog_failure else ("runtime_config_sha256", "failed_owner_sha256",
                                             "process_receipt_sha256", "api_failure_fence_sha256"))
    def same_store(left, right):
        if not catalog_failure:
            return left == right
        return ({key: value for key, value in left.items() if key != "ledger_sha256"}
                == {key: value for key, value in right.items() if key != "ledger_sha256"})
    if ATTEMPT_RE.fullmatch(attempt) is None:
        _fail("Pending activation is not a complete attempt identity")
    root = "activation/attempts/" + attempt
    abort_root = root + "/preparation-abort"
    saved_preflight = control.read(abort_root + "/preflight.json", optional=True)
    if catalog_failure and getattr(args, "preview", False) and saved_preflight is not None:
        _fail("Catalog-failure stop already has an intent; preview cannot resume it")
    image, ids, actual = _container_snapshot(
        args, selected, identity, control, previous, document,
        allow_stopped_backend=saved_preflight is not None,
    )
    name = "fullmag-control-" + attempt
    _, helper_id = _validate_helper(control, name, attempt)
    if _read_raw(control, "active") != (attempt + "\n").encode():
        _fail("Original activation does not own the control lease")
    receipt_raw = _read_raw(control, root + "/receipt.json")
    receipt = _json(receipt_raw, "pending activation")
    inputs = receipt.get("inputs", {})
    expected = dict(development_attempt=args.attempt, config_sha256=args.config_sha256,
                    source_root=str(selected), image_id=image, backend_container=ids["backend"])
    if (receipt.get("phase") != "activation" or receipt.get("attempt") != attempt
        or receipt.get("state") != "outcome-unknown-resources-retained"
        or receipt.get("retirement_phase") != "startup"
        or receipt.get("helper_container") != name
        or any(inputs.get(k) != v for k, v in expected.items())):
        _fail("Pending activation immutable inputs differ")
    if control.read(root + "/terminal.json", optional=True) is not None:
        _fail("Pending activation is already terminal")
    key = inputs.get("activation_receipt_key")
    if not isinstance(key, str) or key != hashlib.sha256(inputs["request_id"].encode()).hexdigest():
        _fail("Pending activation request/marker identity differs")
    marker_relative = "backend/script-activation-" + key + "/activation.json"
    marker_raw = _read_raw(control, marker_relative)
    marker = _json(marker_raw, "pending activation marker")
    if (marker.get("state") != "started" or marker.get("request_id") != inputs["request_id"]
        or marker.get("source_sha256") != inputs.get("source_sha256")
        or marker.get("provenance_sha256") != inputs.get("provenance_sha256")):
        _fail("Image-owned activation marker differs")
    # The original HTTP caller must already have acknowledged Unknown and
    # closed its logger. Do not race an active caller's terminal publication.
    _validate_helper_logged(helper_id)
    final_receipt, final_raw, _ = _validate_activation_receipt(
        control, activation_attempt=attempt, development_attempt=args.attempt,
        config_sha256=args.config_sha256, source_root=str(selected), image_id=image,
        backend_id=ids["backend"],
    )
    expected_consumers = set(ids.values()) | {helper_id}
    def recheck():
        if (_project_container_ids(control.project) != expected_consumers
            or _volume_consumer_ids(control.volume) != expected_consumers):
            _fail("The selected group/control volume has another consumer")
        _validate_helper(control, name, attempt)
        if _read_raw(control, "active") != (attempt + "\n").encode() or _read_raw(control, marker_relative) != marker_raw:
            _fail("Activation lease or marker changed")
        current = _json(_read_raw(control, root + "/receipt.json"), "activation receipt")
        if current.get("inputs") != inputs or current.get("retirement_phase") != "startup":
            _fail("Activation inputs changed")
        image_now, ids_now, actual_now = _container_snapshot(args, selected, identity, control, previous, document)
        if image_now != image or ids_now != ids or any(
            actual_now[s]["State"]["StartedAt"] != actual[s]["State"]["StartedAt"] for s in ids):
            _fail("Compose incarnation changed")
        before = (probe_catalog_failure(ids["backend"], inputs) if catalog_failure else
                  _probe_evidence(control, previous_root, _probe_backend(ids["backend"])))
        store = _store_probe(ids["backend"], inputs, catalog_failure=catalog_failure)
        if catalog_failure and any(before[k] != store[k] for k in ("run_id", "project_id")):
            _fail("Catalog failure API and locked store identify different runs")
        return before, store
    if saved_preflight is None:
        before, store = recheck()
        again, again_store = recheck()
        if (any(before[k] != again[k] for k in evidence_keys)
            or not same_store(store, again_store)):
            _fail("Failed owner or unreleased store changed before stop")
        if catalog_failure and getattr(args, "preview", False):
            return {"state": "preview-passed", "stop_applied": False,
                    "run_id": store["run_id"], "store_mode": store["mode"],
                    "backend_container_id": ids["backend"],
                    "proof_sha256": hashlib.sha256(canonical({"runtime": before, "store": store})).hexdigest()}
        preflight = {"schema": SCHEMA, "state": "stopping-confirmed-unreleased-preparation",
            **expected, "activation_attempt": attempt, "backend_started_at": actual["backend"]["State"]["StartedAt"],
            "request_id": inputs["request_id"],
            "marker_sha256": hashlib.sha256(marker_raw).hexdigest(),
            "store": store, "process_receipt_sha256": before["process_receipt_sha256"],
            "catalog_failure": catalog_failure,
            "failed_owner_sha256": before.get("failed_owner_sha256"), "diagnostic_evidence": before,
            "created_at": time.time()}
        _publish_immutable(control, abort_root + "/preflight.json", canonical(preflight) + b"\n")
        docker_capture("stop", "--time", "60", ids["backend"], timeout=90)
    else:
        preflight = saved_preflight
        if (preflight.get("schema") != SCHEMA
            or preflight.get("state") != "stopping-confirmed-unreleased-preparation"
            or preflight.get("activation_attempt") != attempt
            or preflight.get("catalog_failure", False) != catalog_failure
            or any(preflight.get(k) != v for k, v in expected.items())
            or preflight.get("backend_started_at") != actual["backend"]["State"]["StartedAt"]
            or preflight.get("marker_sha256") != hashlib.sha256(marker_raw).hexdigest()):
            _fail("Retained preparation abort preflight differs")
        before, store = preflight["diagnostic_evidence"], preflight["store"]
        if actual["backend"]["State"]["Running"]:
            again, again_store = recheck()
            if (any(again[k] != before[k] for k in evidence_keys) or not same_store(store, again_store)):
                _fail("Running generation changed after retained abort preflight")
            docker_capture("stop", "--time", "60", ids["backend"], timeout=90)
    stopped = json.loads(docker_capture("inspect", ids["backend"]).stdout)[0]
    if stopped["State"].get("Running") or stopped["State"].get("StartedAt") != preflight["backend_started_at"]:
        _fail("Exact failed backend stop is unconfirmed")
    # The API may finish a read-model finalizer while it is stopping. Do not
    # infer an unchanged held run solely from its pre-stop observation.
    store_root = Path(previous["state_root"]) / "runs/docker-all/session-store"
    from docker_control_namespace import _file_hash
    runs = list((store_root / "runs").iterdir())
    if sorted(p.name for p in runs) != store["run_ids"]:
        _fail("Run inventory changed during preparation abort")
    post_pins = {}
    store_mode = store.get("mode", "unadmitted")
    if store_mode not in {"unadmitted", "held_preparation", "unmaterialized_catalog"}:
        _fail("Preparation abort store proof has an unknown mode")
    held_mode = store_mode == "held_preparation"
    for run in runs:
        if run.is_symlink() or not run.is_dir():
            _fail("Retained run directory changed")
        if run.name == store["run_id"]:
            if held_mode:
                inventory = _run_inventory(run)
                if inventory != store.get("run_inventory"):
                    _fail("Held preparation run inventory changed during abort")
                from docker_volume_dev import _session_host
                host = _session_host()
                for relative in inventory["files"]:
                    p = run / relative
                    try:
                        raw = host.read_owned_regular(p, maximum=16 * 1024 * 1024)
                    except (OSError, ValueError) as error:
                        raise BuildControlError("Held preparation run file is no longer safely readable") from error
                    post_pins[str(p.relative_to(store_root))] = hashlib.sha256(raw).hexdigest()
            else:
                expected_files = ({"run_intent.json"} if store_mode == "unmaterialized_catalog" else
                                  {"run_intent.json", "run_catalog.json"})
                if {p.name for p in run.iterdir()} != expected_files:
                    _fail("The held activation acquired a release, claim, lease or other state")
                for p in run.iterdir():
                    post_pins[str(p.relative_to(store_root))] = _file_hash(p)
        for name in ("resource_leases", "preparation_resource_leases"):
            lease_root = run / name
            if lease_root.is_symlink():
                _fail("Retained lease directory became linked")
            if not lease_root.exists():
                continue
            for parent, dirs, files in os.walk(lease_root, followlinks=False):
                if any((Path(parent) / d).is_symlink() for d in dirs):
                    _fail("Retained lease parent became linked")
                for name in files:
                    p = Path(parent) / name
                    post_pins[str(p.relative_to(store_root))] = _file_hash(p)
    if post_pins != store["store_pins"]:
        _fail("Retained store or lease inventory changed during preparation abort")
    ledger_pin = "ledger_control_sha256" if catalog_failure else "ledger_sha256"
    if _stopped_ledger_sha256(ids["backend"], catalog_failure=catalog_failure) != store.get(ledger_pin):
        _fail("Host reservation ledger changed while stopping the preparation owner")
    if _read_raw(control, root + "/receipt.json") != final_raw:
        _fail("Acknowledged unknown activation receipt changed during stop")
    operation = {"root": abort_root, "receipt": {"image_id": image,
        "inputs": {**operation_inputs, "frontend_container_id": ids["frontend"]}}}
    stop = (verify_catalog_failure_drain(control, stopped, before) if catalog_failure else
            _terminal_receipt(control, operation, ids["backend"], before, stopped, resume_pin))
    outcome = "accepted-catalog-materialization-failed" if catalog_failure else "accepted-preparation-failed"
    terminal = {**preflight, "state": "stopped-awaiting-fresh-archive",
        "activation_outcome": outcome, "execution_state": "not-started",
        "restart_policy": "fresh-state-only", "original_receipt_sha256": hashlib.sha256(final_raw).hexdigest(),
        "stop": stop, "finished_at": time.time()}
    existing_terminal = control.read(abort_root + "/terminal.json", optional=True)
    if existing_terminal is not None:
        if {k: v for k, v in existing_terminal.items() if k != "finished_at"} != {k: v for k, v in terminal.items() if k != "finished_at"}:
            _fail("Retained preparation abort terminal differs")
        terminal = existing_terminal
    terminal_raw = canonical(terminal) + b"\n"
    _publish_immutable(control, abort_root + "/terminal.json", terminal_raw)
    current = control.read(RECORD, optional=True)
    if current != terminal:
        if current is not None:
            # This is a current pointer, while each activation's terminal above
            # remains immutable. Rotate it only after positively preserving the
            # previous abort's completed archive under this helper's lease.
            pin_completed_fresh_archive(control)
            if control.read(RECORD) != current:
                _fail("Preparation abort current pointer changed during archival")
        control.write(RECORD, terminal)
        if control.read(RECORD) != terminal:
            _fail("Preparation abort current pointer did not persist exactly")
    # The original receipt/started marker remain byte-for-byte intact. Only
    # this authenticated helper removes its own active marker after this ACK.
    helper_terminal = {**final_receipt, "state": "failed-confirmed",
        "activation_state": outcome, "execution_state": "not-started",
        "restart_policy": "fresh-state-only", "preparation_abort_path": abort_root + "/terminal.json",
        "preparation_abort_sha256": hashlib.sha256(terminal_raw).hexdigest()}
    _publish_immutable(control, root + "/terminal.json", canonical(helper_terminal) + b"\n")
    _wait_for_helper_exit(helper_id)
    return terminal


def require_fresh_archive(control, args, previous, document, *, recreate_services):
    """Never resume a stopped generation whose pending activation was aborted."""
    record = control.read(RECORD, optional=True)
    if record is None or record.get("development_attempt") != previous.get("attempt"):
        return None
    if (record.get("schema") != SCHEMA or record.get("state") != "stopped-awaiting-fresh-archive"
        or record.get("config_sha256") != args.config_sha256
        or record.get("source_root") != previous.get("inputs", {}).get("source_root")
        or record.get("image_id") != previous.get("inputs", {}).get("image_id")
        or (previous.get("backend_container") is not None
            and record.get("backend_container") != previous.get("backend_container"))
        or record.get("restart_policy") != "fresh-state-only"
        or record.get("execution_state") != "not-started"):
        _fail("Preparation abort does not bind the retained generation")
    if not recreate_services or not getattr(args, "fresh_state", False):
        _fail("Aborted preparation must be preserved by recreate-volume --fresh-state; resume/replay is forbidden")
    if previous.get("backend_container") is None:
        from docker_volume_stop_diagnostic import _validate_resume_terminal
        pin = _validate_resume_terminal(
            control, record.get("stop", {}).get("resume_attempt"),
            development_attempt=previous["attempt"], config_sha256=args.config_sha256,
            previous=previous,
            phase=record.get("stop", {}).get("continuation_phase", "resume"),
        )
        if (pin["sha256"] != record["stop"].get("resume_terminal_sha256")
            or pin["backend_container"] != record["backend_container"]
            or pin["backend_started_at"] != record["backend_started_at"]):
            _fail("Preparation abort linked resume proof differs")
    activation = record.get("activation_attempt")
    from docker_volume_stop_diagnostic import ATTEMPT_RE, _read_raw
    if not isinstance(activation, str) or ATTEMPT_RE.fullmatch(activation) is None:
        _fail("Aborted activation identity is invalid")
    path = "activation/attempts/" + activation
    raw = _read_raw(control, path + "/preparation-abort/terminal.json")
    if json.loads(raw) != record:
        _fail("Preparation abort current pointer differs from its immutable terminal")
    if hashlib.sha256(_read_raw(control, path + "/receipt.json")).hexdigest() != record["original_receipt_sha256"]:
        _fail("Original unknown activation receipt changed")
    helper_terminal = json.loads(_read_raw(control, path + "/terminal.json"))
    if helper_terminal.get("preparation_abort_sha256") != hashlib.sha256(raw).hexdigest():
        _fail("Original helper did not acknowledge the preparation abort")
    actual = json.loads(docker_capture("inspect", record["backend_container"]).stdout)[0]
    if (actual.get("Id") != record["backend_container"] or actual.get("Image") != record["image_id"]
        or actual.get("State", {}).get("Running") is not False
        or actual["State"].get("StartedAt") != record["backend_started_at"]):
        _fail("Aborted backend generation was restarted or changed")
    return record


def _fresh_archive_generation(control, archive_attempt=None):
    """Read the current generation or reconstruct one from one exact archive."""
    from docker_volume_stop_diagnostic import ATTEMPT_RE

    if archive_attempt is None:
        return control.read("group-ledger-generation.json", optional=True)
    if not isinstance(archive_attempt, str) or ATTEMPT_RE.fullmatch(archive_attempt) is None:
        _fail("Explicit fresh archive attempt must be an exact 32-hex identity")

    path = "recreate-services/attempts/" + archive_attempt
    archive_path = path + "/runtime-control-archive-terminal.json"
    archive = control.read(archive_path, optional=True)
    recreation = control.read(path + "/terminal.json", optional=True)
    if not isinstance(archive, Mapping) or not isinstance(recreation, Mapping):
        _fail("Explicit fresh archive attempt has no immutable completed records")
    return {
        "schema": "fullmag.docker-group-ledger-generation.v1",
        "compose_project": archive.get("compose_project"),
        "generation": archive_attempt,
        "archive_terminal_path": archive_path,
        "archive_terminal_sha256": hashlib.sha256(canonical(archive)).hexdigest(),
        "preserved_volume": archive.get("preserved_group_ledger_volume"),
    }


def _fresh_archive_matches_abort(control, record, generation):
    from docker_volume_stop_diagnostic import ATTEMPT_RE

    if not isinstance(record, Mapping) or not isinstance(generation, Mapping):
        return False
    activation_attempt = record.get("activation_attempt")
    if not isinstance(activation_attempt, str) or ATTEMPT_RE.fullmatch(activation_attempt) is None:
        return False
    token = generation.get("generation")
    if not isinstance(token, str) or ATTEMPT_RE.fullmatch(token) is None:
        return False
    path = "recreate-services/attempts/" + token
    archive_path = path + "/runtime-control-archive-terminal.json"
    if generation.get("archive_terminal_path") != archive_path:
        return False
    archive = control.read(archive_path, optional=True)
    recreation = control.read(path + "/terminal.json", optional=True)
    if not isinstance(archive, Mapping) or not isinstance(recreation, Mapping):
        return False
    removed = archive.get("removed_containers")
    recreation_inputs = recreation.get("inputs")
    if not isinstance(removed, Mapping) or not isinstance(recreation_inputs, Mapping):
        return False
    recreation_namespace = recreation.get("control_namespace")
    namespace_matches = (
        recreation_namespace == control.namespace
        if control.namespace
        else recreation_namespace in (None, "")
    )
    if (
        generation.get("schema") != "fullmag.docker-group-ledger-generation.v1"
        or generation.get("compose_project") != control.project
        or generation.get("archive_terminal_sha256")
            != hashlib.sha256(canonical(archive)).hexdigest()
        or generation.get("preserved_volume")
            != archive.get("preserved_group_ledger_volume")
        or archive.get("schema") != "fullmag.docker-fresh-runtime-archive-terminal.v1"
        or archive.get("state") != "succeeded"
        or archive.get("operation_attempt") != token
        or archive.get("compose_project") != control.project
        or archive.get("control_volume") != control.volume
        or archive.get("control_namespace") != control.namespace
        or removed.get("backend") != record.get("backend_container")
        or recreation.get("schema") != "fullmag.docker-build-operation.v1"
        or recreation.get("phase") != "recreate-services"
        or recreation.get("state") != "succeeded"
        or recreation.get("attempt") != token
        or recreation.get("compose_project") != control.project
        or recreation.get("control_volume") != control.volume
        or not namespace_matches
        or recreation.get("fresh_state") is not True
        or recreation.get("runtime_control_archive") != archive
        or recreation_inputs.get("attempt") != record.get("development_attempt")
        or recreation_inputs.get("config_sha256") != record.get("config_sha256")
    ):
        return False
    return True


def has_fresh_archive(control, record, *, archive_attempt=None):
    """Authenticate the existing archive/Compose terminal, never just its age."""
    from docker_volume_stop_diagnostic import ATTEMPT_RE
    if not isinstance(record, Mapping):
        return False
    activation_attempt = record.get("activation_attempt")
    if not isinstance(activation_attempt, str) or ATTEMPT_RE.fullmatch(activation_attempt) is None:
        return False
    anchor = control.read("preparation-abort/archives/" + activation_attempt + ".json", optional=True)
    if anchor is not None:
        if (anchor.get("schema") != "fullmag.docker-preparation-abort-archive.v1"
            or anchor.get("abort_sha256") != hashlib.sha256(canonical(record)).hexdigest()):
            _fail("Preparation abort archive anchor differs")
        if archive_attempt is not None:
            anchored_generation = anchor.get("group_ledger_generation")
            if (not isinstance(anchored_generation, Mapping)
                or anchored_generation.get("generation") != archive_attempt):
                _fail("Preparation abort is anchored to another fresh archive attempt")
        generation = anchor.get("group_ledger_generation")
    else:
        generation = _fresh_archive_generation(control, archive_attempt)
    if generation is None:
        return False
    return _fresh_archive_matches_abort(control, record, generation)


def pin_completed_fresh_archive(control, *, archive_attempt=None):
    """Keep a proven archive admissible when a later DEV generation rotates."""
    from docker_volume_unclaimed_cancellation import _publish_immutable
    record = control.read(RECORD, optional=True)
    if record is None:
        if archive_attempt is not None:
            _fail("Explicit fresh archive pin has no preparation abort record")
        return
    if not isinstance(record, Mapping):
        _fail("Preparation abort current pointer is malformed")
    from docker_volume_stop_diagnostic import ATTEMPT_RE
    activation_attempt = record.get("activation_attempt")
    if not isinstance(activation_attempt, str) or ATTEMPT_RE.fullmatch(activation_attempt) is None:
        _fail("Preparation abort activation identity is invalid")
    path = "preparation-abort/archives/" + activation_attempt + ".json"
    if control.read(path, optional=True) is not None:
        if not has_fresh_archive(control, record, archive_attempt=archive_attempt):
            _fail("Existing preparation archive anchor is no longer valid")
        return
    if not has_fresh_archive(control, record, archive_attempt=archive_attempt):
        _fail("Preparation abort has no completed fresh archive to pin")
    generation = _fresh_archive_generation(control, archive_attempt)
    anchor = {
        "schema": "fullmag.docker-preparation-abort-archive.v1",
        "abort_sha256": hashlib.sha256(canonical(record)).hexdigest(),
        "group_ledger_generation": generation,
    }
    _publish_immutable(control, path, canonical(anchor) + b"\n")
