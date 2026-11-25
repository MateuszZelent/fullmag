"""Failure-only recovery for an absent retained recovery-build lease owner."""
import copy
import json
from pathlib import Path
import re
import shlex
import subprocess

from docker_build_control import BuildControlError, canonical, docker_capture
from docker_volume_reconcile import digest, fingerprint, read_raw, require, validate_incarnation
from docker_volume_recovery_failure_reconcile import unchanged, validate_failure
from docker_volume_recovery_failure_reconcile import validate_request as validate_live_request
from docker_volume_offline_reconcile import _transaction_mounts, _inspect_transaction_helper
from docker_volume_activation_reconcile import _probe_helper_absence

SCHEMA = "fullmag.retained-recovery-missing-owner-failure.v1"
SHA = re.compile(r"[0-9a-f]{64}\Z")


def validate_request(request):
    require(isinstance(request, dict) and request.get("schema") == SCHEMA, "Wrong missing-owner schema")
    old = dict(request)
    require(set(old) >= {"prior_request", "prior_request_sha256"}, "Missing prior authorization pin")
    path = old.pop("prior_request")
    sha = old.pop("prior_request_sha256")
    from docker_volume_offline_reconcile import _relative
    _relative(path)
    require(isinstance(sha, str) and SHA.fullmatch(sha), "Invalid prior request SHA")
    old["schema"] = "fullmag.retained-recovery-failed-build-reconciliation.v1"
    validate_live_request(old)
    require(type(request["port"]) is int and 1 <= request["port"] <= 65535, "Invalid loopback port")


def missing_owner(request):
    # Exact not-found is required for ID AND name; timeout is never absence.
    for identity in (request["containers"]["lease"]["id"], "fullmag-control-" + request["attempt"]):
        require(_probe_helper_absence(identity) is not None, "Original helper still exists")


def inspect_pins(request):
    from docker_volume_container_recovery import _stable_container_observation
    result = {}
    for role in ("backend", "frontend"):
        pin = request["containers"][role]
        rows = json.loads(docker_capture("inspect", pin["id"]).stdout)
        require(len(rows) == 1, "Ambiguous stopped service")
        validate_incarnation(rows[0], pin, request["compose_project"], running=False)
        result[role] = _stable_container_observation(rows[0])
    return result


def result_bytes(request, original):
    result = copy.deepcopy(original)
    result.update(state="failed-confirmed", package_built=False, runtime_started=False,
        storage_admitted=False, runtime_qualification="NOT VERIFIED",
        reconciliation={"schema": SCHEMA, "request_sha256": digest(canonical(request)),
            "unknown_receipt_sha256": request["unknown_receipt_sha256"],
            "prior_request_sha256": request["prior_request_sha256"],
            "failure": request["failure"], "absent_owner_id": request["containers"]["lease"]["id"],
            "raw_records_unchanged": True, "storage_proof_unchanged": True})
    # Retain the original observation timestamp; replay has identical bytes.
    return canonical(result) + b"\n"


def validate_replay(control, request, original_raw, result_raw):
    root = "recovery-build/attempts/" + request["attempt"]
    journal = root + "/missing-owner-failure/" + digest(canonical(request))
    receipt = read_raw(control, root + "/receipt.json")
    terminal = read_raw(control, root + "/terminal.json", optional=True)
    result = read_raw(control, journal + "/result.json", optional=True)
    intent = read_raw(control, journal + "/intent.json", optional=True)
    expected_intent = canonical({"schema": SCHEMA, "request": request,
        "result_sha256": digest(result_raw)}) + b"\n"
    require(receipt in (original_raw, result_raw), "Foreign operation receipt")
    require(terminal in (None, result_raw) and result in (None, result_raw)
            and intent in (None, expected_intent), "Foreign partial journal")
    if receipt == result_raw or terminal is not None:
        require(result == result_raw and intent == expected_intent, "Terminal lacks exact durable journal")
    active = read_raw(control, "active", optional=True)
    require(active in ((request["attempt"] + "\n").encode(), request["attempt"].encode(), None), "Foreign active token")
    if active is None:
        require(receipt == result_raw and terminal == result_raw and result == result_raw and intent == expected_intent,
                "Missing active without complete identical journal")

def collect(control, selected, request, *, observer=None):
    import docker_volume_dev as dev
    import docker_volume_container_recovery as recovery
    from docker_dev import _select_source
    validate_request(request)
    prior_raw = read_raw(control, request["prior_request"])
    require(digest(prior_raw) == request["prior_request_sha256"], "Prior authorized request changed")
    prior = json.loads(prior_raw)
    validate_live_request(prior)
    require(all(request[k] == prior[k] for k in prior if k not in {
        "schema", "controller_sha256", "reconciler_sha256", "recovery_controller_sha256"}),
        "Missing-owner request changed original scientific/runtime pins")
    missing_owner(request)
    require(request["compose_project"] == control.project and request["source_root"] == str(selected),
            "Source/group differs")
    require(digest(Path(__file__).read_bytes()) == request["controller_sha256"]
            and digest(Path(__file__).with_name("docker_volume_reconcile.py").read_bytes()) == request["reconciler_sha256"],
            "Reviewed reconciliation code changed")
    require(digest(Path(recovery.__file__).read_bytes()) == request["recovery_controller_sha256"], "Recovery observer code changed")
    root = "recovery-build/attempts/" + request["attempt"]
    current_raw = read_raw(control, root + "/receipt.json")
    saved = read_raw(control, root + "/unknown-receipt.json", optional=True)
    original_raw = saved if saved is not None else current_raw
    require(digest(original_raw) == request["unknown_receipt_sha256"], "Unknown operation CAS differs")
    original = json.loads(original_raw)
    require(original.get("schema") == "fullmag.docker-build-operation.v1"
            and original.get("phase") == "recovery-build" and original.get("state") == "outcome-unknown-resources-retained"
            and original.get("attempt") == request["attempt"] and original.get("compose_project") == control.project
            and original.get("control_volume") == control.volume, "Wrong retained operation")
    require(original.get("helper_container") == "fullmag-control-" + request["attempt"], "Wrong original helper")
    require(original.get("backend_started_at") == request["containers"]["backend"]["started_at"], "Wrong build incarnation")
    result_raw = result_bytes(request, original)
    validate_replay(control, request, original_raw, result_raw)
    inputs = original["inputs"]
    require(inputs.get("source_root") == str(selected), "Operation source differs")
    build_raw = read_raw(control, root + "/request.json")
    require(digest(build_raw) == request["build_request_sha256"], "Build request changed")
    build = dev._recovery_build_request(build_raw)
    submitted_raw = read_raw(control, inputs["request"])
    require(digest(submitted_raw) == inputs["request_sha256"] and json.loads(submitted_raw) == build,
            "Historical submitted request changed")
    pins = build["authorization_pins"]
    require(inputs["attempt"] == pins["development_attempt"] and inputs["config_sha256"] == pins["compose_config_sha256"]
            and inputs["image_id"] == pins["old_image_id"] and inputs["source_commit"] == build["source_commit"]
            and inputs["controller_sha256"] == build["controller_sha256"]
            and pins["source_root"] == str(selected) and pins["compose_project"] == control.project,
            "Historical recovery authorization differs")
    for role in ("backend", "frontend"):
        require(request["containers"][role]["id"] == pins[role + "_container_id"]
                and request["containers"][role]["image"] == pins["old_image_id"], "Wrong authorized service")
    base = "development/attempts/" + pins["development_attempt"]
    previous_raw = read_raw(control, base + "/terminal.json")
    require(digest(previous_raw) == request["previous_sha256"], "Development receipt changed")
    previous = json.loads(previous_raw)
    compose_raw = read_raw(control, base + "/compose.json")
    require(digest(compose_raw) == request["compose_sha256"], "Compose document changed")
    document = json.loads(compose_raw)
    require(digest(canonical(document)) == pins["compose_config_sha256"] and document.get("name") == control.project,
            "Compose authority differs")
    ports = document["services"]["frontend"].get("ports", [])
    require(len(ports) == 1 and str(ports[0].get("published")) == str(request["port"])
            and ports[0].get("host_ip") == "127.0.0.1", "Loopback port differs")
    before_raw = read_raw(control, root + "/before.json")
    require(digest(before_raw) == request["before_sha256"], "Before proof changed")
    before = json.loads(before_raw)
    actual = inspect_pins(request)
    output = docker_capture("logs", "--since", request["containers"]["backend"]["started_at"], request["containers"]["backend"]["id"])
    log = output.stdout + output.stderr
    validate_failure(actual["backend"], request, log)
    for name in ("backend-build-receipt.json", "provenance.json", "native-capabilities.json", "handoff-log.json"):
        require(read_raw(control, root + "/" + name, optional=True) is None, "Publication boundary already crossed")
    options = {"retained_attempt_histories": build["retained_attempt_histories"]} if build["schema"] == dev._RECOVERY_HISTORY_BUILD_SCHEMA else {}
    after = recovery.prepare_abrupt_stop_proof(control, pins, document,
        retained_terminal_runs=build["retained_terminal_runs"], retained_held_manual_runs=build["retained_held_manual_runs"],
        missing_owner_reconciliation={"request": request, "observer": observer}, **options)
    unchanged(before, after)
    require(after["containers"]["backend"] == actual["backend"] and after["containers"]["frontend"] == actual["frontend"],
            "Service changed during observation")
    _, layout = _select_source(selected, selected)
    state = dev.storage.validate_path(Path(previous["state_root"]), layout["runtime_root"], "retained Linux sessions")
    certificate = dev._recovery_build_certificate(state, document, build)
    # Only certificate_sha256 has historical authority; other hashes pin this observation window.
    for name, expected in (("current.json", request["phase_current_sha256"]), ("verified.json", request["verified_sha256"])):
        value = read_raw(control, "recovery-build/" + name, optional=True)
        require((digest(value) if value is not None else None) == expected, "Recovery phase record changed")
    missing_owner(request)
    require(inspect_pins(request) == actual, "Service/helper changed during proof")
    return {"root": root, "original": original, "original_raw": original_raw, "current_raw": original_raw,
        "proof": after, "certificate": certificate, "failure_log_sha256": digest(log)}


# This program runs only in the exact isolated control helper. All writes are
# control records. Store and ledger are read-only mounts held under shared locks.
TRANSACTION = r"""import fcntl,hashlib,json,os,pathlib,stat,sys,tempfile
spec=json.loads(sys.argv[1]); root=pathlib.Path(spec['root']); fds=[]
def sha(raw): return hashlib.sha256(raw).hexdigest()
def directory(path, create=False):
    path=pathlib.Path(path)
    current=pathlib.Path('/')
    for part in path.parts[1:]:
        current=current/part
        if create and not current.exists():
            current.mkdir(); sync(current.parent)
        st=current.lstat()
        if not stat.S_ISDIR(st.st_mode): raise RuntimeError('Non-directory ancestor')
def sync(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)
def read(path, optional=False):
    directory(path.parent)
    try: fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    except FileNotFoundError:
        if optional: return None
        raise
    try:
        st=os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>8*1024*1024: raise RuntimeError('Unsafe bounded record')
        with os.fdopen(fd,'rb',closefd=False) as f: raw=f.read(8*1024*1024+1)
        after=os.fstat(fd)
        if len(raw)!=st.st_size or (st.st_ino,st.st_size,st.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns): raise RuntimeError('Record changed')
        return raw
    finally: os.close(fd)
def lock(path, shared=False, create=False):
    directory(path.parent)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK if shared else os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_CREAT if create else 0),0o640)
    st=os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1: raise RuntimeError('Unsafe lock')
    fcntl.flock(fd,(fcntl.LOCK_SH if shared else fcntl.LOCK_EX)|fcntl.LOCK_NB); fds.append(fd)
def pin():
    for rel,expected in spec['pins'].items():
        raw=read(root/rel,True)
        if (sha(raw) if raw is not None else None)!=expected: raise RuntimeError('Immutable pin changed: '+rel)
def publish(path, raw, old=None):
    directory(path.parent,True)
    current=read(path,True)
    if current==raw:return
    if current!=old:raise RuntimeError('Foreign publication')
    fd,tmp=tempfile.mkstemp(prefix='.missing-owner-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path);sync(path.parent)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
active=root/'active'; operation=root/spec['operation']
result=spec['result'].encode(); intent=spec['intent'].encode(); original=spec['original'].encode()
journal=root/spec['journal']
directory(root);lock(root/'operation.lock')
lock(operation/'reconcile-observer.lock',create=True);lock(operation/'reconcile-commit.lock',create=True)
if spec['external']:
    lock(pathlib.Path('/store/WRITER.lock'),True)
    lock(pathlib.Path('/ledger/ledger/WRITER.lock'),True)
    p=pathlib.Path('/ledger/ledger/HOST_INVENTORY_OWNER.lock')
    if p.exists() or p.is_symlink():lock(p,True)
pin()
scope=operation/'missing-owner-failure'
if scope.exists() or scope.is_symlink():
    directory(scope)
    if any(p.name!=journal.name for p in scope.iterdir()):raise RuntimeError('Foreign missing-owner journal')
a=read(active,True)
if a not in (None,spec['attempt'].encode(),(spec['attempt']+'\n').encode()):raise RuntimeError('Foreign active')
for path,wanted in ((journal/'intent.json',intent),(journal/'result.json',result),(operation/'terminal.json',result)):
    observed=read(path,True) if path.parent.exists() else None
    if observed not in (None,wanted):raise RuntimeError('Foreign journal')
if read(operation/'receipt.json') not in (original,result):raise RuntimeError('Foreign receipt')
if read(operation/'unknown-receipt.json',True) not in (None,original):raise RuntimeError('Foreign original receipt')
if a is None:
    if any(read(p)!=v for p,v in ((journal/'intent.json',intent),(journal/'result.json',result),(operation/'terminal.json',result),(operation/'receipt.json',result))):raise RuntimeError('Incomplete released transaction')
print('LOCKED',flush=True)
if sys.stdin.readline().strip()!='COMMIT':sys.exit(71)
pin()
if read(active,True)!=a:raise RuntimeError('Active changed under lock')
publish(operation/'unknown-receipt.json',original)
publish(journal/'intent.json',intent)
publish(journal/'result.json',result)
publish(operation/'terminal.json',result)
publish(operation/'receipt.json',result,original)
pin()
if read(active,True)!=a:raise RuntimeError('Active changed before release')
if a is not None:os.unlink(active);sync(root)
if read(active,True) is not None:raise RuntimeError('Active not released')
for p,v in ((journal/'intent.json',intent),(journal/'result.json',result),(operation/'terminal.json',result),(operation/'receipt.json',result)):
    if read(p)!=v:raise RuntimeError('Completion differs')
print('COMPLETED',flush=True)
"""


def transaction_script(request, original_raw, *, root="/control", external=True):
    validate_request(request)
    original=json.loads(original_raw)
    operation="recovery-build/attempts/"+request["attempt"]
    base="development/attempts/"+original["inputs"]["attempt"]
    pins={operation+"/before.json":request["before_sha256"],
        operation+"/request.json":request["build_request_sha256"],
        base+"/terminal.json":request["previous_sha256"], base+"/compose.json":request["compose_sha256"],
        "recovery-build/current.json":request["phase_current_sha256"],
        "recovery-build/verified.json":request["verified_sha256"],
        request["prior_request"]:request["prior_request_sha256"],
        original["inputs"]["request"]:original["inputs"]["request_sha256"]}
    for name in ("backend-build-receipt.json","provenance.json","native-capabilities.json","handoff-log.json"):
        pins[operation+"/"+name]=None
    from docker_volume_offline_reconcile import _relative
    for path in pins:_relative(path)
    result=result_bytes(request,original)
    spec={"root":str(root),"attempt":request["attempt"],"operation":operation,"external":external,
        "journal":operation+"/missing-owner-failure/"+digest(canonical(request)),"pins":pins,
        "result":result.decode(),"original":original_raw.decode(),
        "intent":(canonical({"schema":SCHEMA,"request":request,"result_sha256":digest(result)})+b"\n").decode()}
    return "exec python3 -I -B -c "+shlex.quote(TRANSACTION)+" "+shlex.quote(canonical(spec).decode())


def transaction_resources(control, request):
    root="recovery-build/attempts/"+request["attempt"]
    raw=read_raw(control,root+"/unknown-receipt.json",optional=True)
    if raw is None:raw=read_raw(control,root+"/receipt.json")
    require(digest(raw)==request["unknown_receipt_sha256"],"Original receipt missing")
    original=json.loads(raw)
    base="development/attempts/"+original["inputs"]["attempt"]
    document=json.loads(read_raw(control,base+"/compose.json"))
    from docker_volume_offline_reconcile import _group_ledger_volume
    ledger_volume,_=_group_ledger_volume(document,control.project)
    mounts=document['services']['backend']['volumes']
    state=[m for m in mounts if m.get('target')=='/state']
    require(len(state)==1 and state[0]['type']=='bind',"Exact state bind required")
    store=Path(state[0]['source'])/'runs/docker-all/session-store'
    return raw,store,ledger_volume


def directory_identity(path):
    info = path.stat()
    return info.st_dev, info.st_ino


def inspect_transaction(control, name, script, store, ledger):
    # Only this recovery resolves Desktop aliases; legacy validation is exact.
    rows = json.loads(docker_capture("inspect", name).stdout)
    require(len(rows) == 1, "Ambiguous missing-owner transaction")
    before = rows[0]
    mounts = before.get("HostConfig", {}).get("Mounts", [])
    bound = [mount for mount in mounts if mount.get("Target") == "/store"]
    require(len(bound) == 1, "Missing exact store mount")
    source = bound[0].get("Source")
    alias = isinstance(source, str) and re.fullmatch(
        r"/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/([A-Za-z0-9][A-Za-z0-9._-]*)/([0-9a-f]{64})", source)
    if not alias:
        return _inspect_transaction_helper(control, name, script, store, ledger)
    runtime = [mount for mount in before.get("Mounts", []) if mount.get("Destination") == "/store"]
    require(len(runtime) == 1 and runtime[0].get("Source") == source, "WSL store mount sources differ")
    from docker_dev_codegen import _source_mount_matches_selected
    require(_source_mount_matches_selected(source, store), "WSL store alias identity differs")
    local = Path("/mnt/wsl/docker-desktop-bind-mounts") / alias.group(1) / alias.group(2)
    identities = directory_identity(store), directory_identity(local)
    require(identities[0] == identities[1], "WSL store inode differs")
    pinned = before.get("Id"), before.get("Name"), before.get("State", {}).get("StartedAt"), fingerprint(before)
    identifier = _inspect_transaction_helper(control, name, script, Path(source), ledger)
    require(identifier == pinned[0], "WSL helper was replaced")
    rows = json.loads(docker_capture("inspect", identifier).stdout)
    require(len(rows) == 1, "Missing WSL transaction helper")
    after = rows[0]
    require((after.get("Id"), after.get("Name"), after.get("State", {}).get("StartedAt"), fingerprint(after)) == pinned
            and after.get("State", {}).get("Running") is True
            and after.get("State", {}).get("Status") == "running", "WSL helper incarnation changed")
    require(_source_mount_matches_selected(source, store)
            and (directory_identity(store), directory_identity(local)) == identities,
            "WSL store identity changed during inspection")
    return identifier


def transaction_control(control, request):
    # The base CUDA helper does not contain Python. Reuse the exact stopped
    # backend image already pinned and validated by collect, like the v5 reader.
    image = request["containers"]["backend"]["image"]
    require(isinstance(image, str) and image.startswith("sha256:")
            and SHA.fullmatch(image[7:]), "Transaction requires the pinned backend image")
    runtime_control = copy.copy(control)
    runtime_control.image = image
    return runtime_control


def authenticated_control_helpers(control, context):
    require(isinstance(context,dict) and set(context)=={"request","observer"},"Foreign missing-owner context")
    request=context['request'];validate_request(request);missing_owner(request)
    require(request['compose_project']==control.project,'Foreign helper project')
    observer=context['observer']
    if observer is None:return set()
    require(isinstance(observer,dict) and set(observer)=={'name','id','started_at','fingerprint'},"Unpinned missing-owner helper")
    expected='fullmag-missing-owner-'+digest(canonical(request))[:32]
    require(observer['name']==expected,"Foreign transaction helper")
    raw,store,ledger=transaction_resources(control,request)
    script=transaction_script(request,raw)
    identifier=inspect_transaction(transaction_control(control,request),expected,script,store,ledger)
    require(identifier==observer['id'],"Replaced transaction helper")
    rows=json.loads(docker_capture('inspect',identifier).stdout)
    require(len(rows)==1 and rows[0]['State'].get('Running') is True
            and rows[0]['State'].get('Status')=='running' and rows[0]['State']['StartedAt']==observer['started_at']
            and fingerprint(rows[0])==observer['fingerprint'],'Restarted transaction helper')
    return {identifier}


def reconcile(args, control, selected, request, request_raw):
    validate_request(request)
    require(digest(request_raw)==args.request_sha256 and json.loads(request_raw)==request,"Request CAS differs")
    before=collect(control,selected,request)
    if getattr(args,'preview',False):return {'state':'validated-only','schema':SCHEMA,'attempt':request['attempt']}
    raw,store,ledger=transaction_resources(control,request)
    script=transaction_script(request,raw)
    name='fullmag-missing-owner-'+digest(canonical(request))[:32]
    require(_probe_helper_absence(name) is not None,"Prior transaction helper exists")
    runtime_control=transaction_control(control,request)
    command=runtime_control.helper_args(script,name=name)
    _transaction_mounts(command,store_root=store,ledger_volume=ledger)
    process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    try:
        require(control._line(process)=='LOCKED','Recovery exclusion unavailable')
        identifier=inspect_transaction(runtime_control,name,script,store,ledger)
        rows=json.loads(docker_capture('inspect',identifier).stdout)
        require(len(rows)==1,'Missing transaction helper')
        observer={'name':name,'id':identifier,'started_at':rows[0]['State']['StartedAt'],
                  'fingerprint':fingerprint(rows[0])}
        require(collect(control,selected,request,observer=observer)==before,'Evidence changed under locks')
        authenticated_control_helpers(control,{'request':request,'observer':observer})
        missing_owner(request)
        require(process.poll() is None,'Transaction helper disappeared')
        process.stdin.write(b'COMMIT\n');process.stdin.flush();process.stdin.close()
        require(control._line(process)=='COMPLETED','Finalization unknown; identical journal replay required')
        require(process.wait(timeout=30)==0,'Transaction did not finish')
        validate_replay(control,request,raw,result_bytes(request,json.loads(raw)))
        require(read_raw(control,'active',optional=True) is None,'Exact active not released')
        return {'state':'failed-confirmed','schema':SCHEMA,'attempt':request['attempt']}
    finally:
        if process.stdin and not process.stdin.closed:process.stdin.close()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:raise BuildControlError('Missing-owner transaction retained; inspect journal')
