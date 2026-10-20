"""Owned coordinator quiescence with an actual Linux-side claim fence."""
from contextlib import ExitStack, closing
import ast
import hashlib
import inspect
import json
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid

from fullmag_storage import StorageError, atomic_json, file_lock, validate_path
from local_runner import container_client as client
from local_runner import boris_transition as transition
from local_runner.service import ServicePaths, request_stop, read_stop_request

SOURCE_FILES = ('fullmag_storage.py', 'local_runner/build_executor.py',
                'local_runner/coordinator.py', 'local_runner/container_main.py',
                'local_runner/service.py', 'local_runner/queue.py', 'local_runner/container_api.py')
MAX_METADATA = 4*1024**2
HANDSHAKE_SECONDS = 5
DOCKER_SECONDS = 15


def _claim_contract(source, function):
    tree = ast.parse(source)
    definitions = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == function]
    if len(definitions) != 1:
        raise ValueError('Reviewed claim function missing')
    lock_names = {n.targets[0].id for n in ast.walk(definitions[0])
                  if isinstance(n, ast.Assign) and len(n.targets)==1 and isinstance(n.targets[0],ast.Name)
                  and any(isinstance(part,ast.Constant) and part.value=='local-runner-coordinator.lock' for part in ast.walk(n.value))}
    claims = []
    def visit(node, held=False):
        if isinstance(node, ast.With):
            held = held or any(isinstance(item.context_expr, ast.Call)
                              and isinstance(item.context_expr.func, ast.Name)
                              and item.context_expr.func.id == 'file_lock'
                              and any((isinstance(n, ast.Constant) and n.value == 'local-runner-coordinator.lock')
                                      or (isinstance(n,ast.Name) and n.id in lock_names) for n in ast.walk(item.context_expr)) for item in node.items)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'claim':
            if not held:
                raise ValueError('Queue claim outside coordinator Linux fence')
            claims.append(node)
        for child in ast.iter_child_nodes(node):visit(child, held)
    visit(tree)
    if len(claims) != 1 or claims[0] not in list(ast.walk(definitions[0])):
        raise ValueError('Unexpected queue claim route')


# Once armed, EOF must not release a fence protecting an uncertain Docker stop.
# Recovery destroys the exact coordinator; no lease expires by age.
REMOTE = 'import ast,fcntl,hashlib,json,os,pathlib,select,stat,sys,time\n' + inspect.getsource(_claim_contract) + r'''
def line(timeout=5):
 if not select.select([sys.stdin.buffer],[],[],timeout)[0]:raise ValueError('protocol timeout')
 raw=sys.stdin.buffer.readline(4097)
 if len(raw)>4096 or not raw.endswith(b'\n'):raise ValueError('protocol EOF/bound')
 return json.loads(raw)
def emit(state):print(json.dumps(dict(state=state,nonce=nonce,pid=os.getpid())),flush=True)
initial=line();nonce=initial['nonce'];expected=initial['sources']
assert set(expected)==set(FILES) and len(nonce)==32
root=pathlib.Path('/opt/runner/scripts');total=0
for name in FILES:
 p=root/name;assert p.is_file() and not p.is_symlink()
 size=p.stat().st_size;total+=size;assert size<=1024**2 and total<=4*1024**2
 with p.open('rb') as stream:data=stream.read(1024**2+1)
 assert len(data)==size and hashlib.sha256(data).hexdigest()==expected[name]
 if name=='local_runner/build_executor.py':_claim_contract(data.decode(),'execute_build')
 if name=='local_runner/coordinator.py':_claim_contract(data.decode(),'execute_once')
 if name=='fullmag_storage.py':
  tree=ast.parse(data.decode());functions=[n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='file_lock'];assert len(functions)==1
  assert any(isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and isinstance(n.func.value,ast.Name) and n.func.value.id=='fcntl' and n.func.attr=='flock' for n in ast.walk(functions[0]))
p=pathlib.Path('/storage/locks/local-runner-coordinator.lock')
assert not p.is_symlink() and not p.parent.is_symlink() and p.is_file()
fd=os.open(p,os.O_RDWR|os.O_NOFOLLOW);identity=os.fstat(fd);assert stat.S_ISREG(identity.st_mode)
try:
 try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:emit('BUSY');sys.exit(4)
 emit('HELD');armed=False
 while True:
  if armed:
   ready=select.select([sys.stdin.buffer],[],[],5)[0]
   if not ready:continue
   raw=sys.stdin.buffer.readline(4097)
   if not raw:
    while True:time.sleep(5)
   if len(raw)>4096 or not raw.endswith(b'\n'):
    while True:time.sleep(5)
   message=json.loads(raw)
  else:message=line(50)
  assert message['nonce']==nonce
  current=p.stat();assert (identity.st_dev,identity.st_ino)==(current.st_dev,current.st_ino)
  operation=message['operation']
  if operation=='PING':emit('HELD')
  elif operation=='ARM':armed=True;emit('ARMED')
  elif operation=='RELEASE' and not armed:emit('RELEASED');break
  else:raise ValueError('protocol operation refused')
finally:
 # Exceptions after ARM must quarantine, rather than opening a claim window.
 if locals().get('armed',False):
  while True:time.sleep(5)
 os.close(fd)
'''
REMOTE = 'FILES='+repr(SOURCE_FILES)+'\n'+REMOTE


def _docker_environment():
    if os.name != 'nt':raise client.ContainerClientError('Owned lifecycle requires Windows Docker Desktop')
    executable = shutil.which('docker.exe')
    if not executable:raise client.ContainerClientError('Native Docker Desktop CLI unavailable')
    env = {k:v for k,v in os.environ.items() if k not in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')}
    result = subprocess.run([executable,'context','inspect','desktop-linux'],capture_output=True,timeout=5,env=env)
    try:endpoint=json.loads(result.stdout)[0]['Endpoints']['docker']['Host']
    except (ValueError,KeyError,IndexError,TypeError):raise client.ContainerClientError('Docker Desktop endpoint not attested') from None
    if result.returncode or endpoint!='npipe:////./pipe/dockerDesktopLinuxEngine':raise client.ContainerClientError('Nonlocal Docker endpoint refused')
    return executable,env


def _docker(arguments):
    executable,env=_docker_environment()
    try:result=subprocess.run([executable,'--context','desktop-linux',*arguments],capture_output=True,timeout=DOCKER_SECONDS,env=env)
    except subprocess.TimeoutExpired:raise client.ContainerClientError('Owned Docker lifecycle request timed out') from None
    if result.returncode or len(result.stdout)>MAX_METADATA:raise client.ContainerClientError('Owned Docker lifecycle request failed or exceeded bound')
    return result.stdout.decode('utf-8')


class LinuxFence:
    def __init__(self, identifier, sources):
        executable,env=_docker_environment()
        self.nonce=uuid.uuid4().hex;self.armed=False
        self.process=subprocess.Popen([executable,'--context','desktop-linux','exec','-i',identifier,'python3','-B','-u','-c',REMOTE],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env)
        self.messages=queue.Queue(maxsize=4)
        def reader():
            try:
                while True:
                    raw=self.process.stdout.readline(4097)
                    self.messages.put_nowait(raw)
                    if not raw or len(raw)>4096:break
            except (OSError,queue.Full):pass
        self.reader=threading.Thread(target=reader,daemon=True);self.reader.start()
        try:
            self._write(dict(nonce=self.nonce,sources=sources));self._expect('HELD')
        except BaseException:
            self.close_before_stop();raise

    def _write(self,value):
        data=(json.dumps(value,separators=(',',':'))+'\n').encode()
        if len(data)>4096:raise client.ContainerClientError('Fence input bound exceeded')
        self.process.stdin.write(data);self.process.stdin.flush()

    def _expect(self,state):
        try:raw=self.messages.get(timeout=HANDSHAKE_SECONDS)
        except queue.Empty:raise client.ContainerClientError('Linux fence handshake timed out') from None
        try:value=json.loads(raw)
        except (ValueError,UnicodeError):raise client.ContainerClientError('Linux fence EOF or invalid acknowledgement') from None
        if (len(raw)>4096 or set(value)!={'state','nonce','pid'} or value['state']!=state or value['nonce']!=self.nonce
                or type(value['pid']) is not int or value['pid']<=0 or self.process.poll() is not None):
            raise client.ContainerClientError('Linux fence not actually held by the owned exec')
        return value

    def check(self):
        self._write(dict(nonce=self.nonce,operation='PING'));return self._expect('HELD')

    def arm(self):
        self.armed=True
        self._write(dict(nonce=self.nonce,operation='ARM'));return self._expect('ARMED')

    def close_before_stop(self):
        if self.armed:return
        # EOF releases only this exec's unarmed Linux lock. Never Docker kill.
        if self.process.stdin and not self.process.stdin.closed:self.process.stdin.close()
        try:self.process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            self.process.kill();self.process.wait(timeout=5)
        self.process.stdout.close();self.reader.join(timeout=1)

    def confirm_destroyed(self):
        try:self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:raise client.ContainerClientError('Exited coordinator exec was not confirmed destroyed') from None
        if self.process.stdin and not self.process.stdin.closed:self.process.stdin.close()
        self.process.stdout.close();self.reader.join(timeout=1)


def _configs(layout,owner,public_sha,catalog_sha,baseline=None):
    storage=client._storage_root(layout);client._config_paths(layout)
    blobs=[transition._read_bytes(storage/'index'/name) for name in transition.NAMES]
    _,public,_=transition._validate_pair(storage,owner,blobs)
    if transition._sha(blobs[1])!=public_sha or transition._sha(blobs[2])!=catalog_sha:
        raise client.ContainerClientError('Lifecycle public config compare-and-swap failed')
    if baseline is not None and blobs!=baseline:raise client.ContainerClientError('Private config pair changed during lifecycle guard')
    return blobs,public


def _attested(layout,owner,public,identifier,docker_call):
    storage=client._storage_root(layout);_,secret_path,_=client._config_paths(layout)
    current=client._attest(client._inspect_container(docker_call,identifier),storage=storage,secret_path=secret_path,public=public,operator=owner)
    if current['container_id']!=identifier:raise client.ContainerClientError('Coordinator incarnation changed')
    return current


def _inventory(docker_call,identifier):
    ids=client._docker_text(docker_call,['ps','-a','--no-trunc','--format','{{.ID}}']).split()
    if len(ids)>4096 or len(set(ids))!=len(ids) or any(not client._CONTAINER_ID_RE.fullmatch(i) for i in ids):raise client.ContainerClientError('Complete bounded Docker inventory required')
    items=client._docker_json(docker_call,['inspect',*ids]) if ids else []
    if not isinstance(items,list) or len(items)!=len(ids) or {v.get('Id') for v in items if isinstance(v,dict)}!=set(ids):raise client.ContainerClientError('Docker inventory identity incomplete')
    for item in items:
        state=item.get('State',{});config=item.get('Config',{});labels=config.get('Labels') or {}
        if (not isinstance(state,dict) or type(state.get('Running')) is not bool or state.get('Status') not in ('created','running','paused','restarting','removing','exited','dead') or not isinstance(labels,dict)):
            raise client.ContainerClientError('Docker inventory state incomplete')
        active=state['Running'] or state.get('Paused') or state.get('Restarting') or state['Status'] in ('running','paused','restarting')
        name=str(item.get('Name','')).lower()
        owned='fullmag' in name or labels.get('owner')=='fullmag-local-runner' or any(k.startswith('com.fullmag.') for k in labels)
        if active and owned and item['Id']!=identifier and not ('buildx_buildkit' in name and labels.get('owner')!='fullmag-local-runner' and not any(k.startswith('com.fullmag.') for k in labels)):raise client.ContainerClientError('Active Fullmag worker prevents owned coordinator stop')
    return len(items)


def _queue_guard(storage):
    path=storage/'index'/'runner-jobs.sqlite'
    if path.is_symlink() or not path.is_file():raise client.ContainerClientError('Complete queue inventory required')
    with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=3)) as db:
        if db.execute('PRAGMA user_version').fetchone()[0]!=1:raise client.ContainerClientError('Unsupported queue schema')
        if db.execute("SELECT 1 FROM jobs WHERE state IS NULL OR state NOT IN ('queued','succeeded','failed','cancelled','blocked','interrupted') OR lease_token IS NOT NULL LIMIT 1").fetchone():raise client.ContainerClientError('Active or uncertain queue lease prevents lifecycle stop')
        cursor=db.execute('SELECT * FROM jobs ORDER BY sequence LIMIT 100001')
        digest=hashlib.sha256();total=0;count=0
        digest.update(json.dumps([column[0] for column in cursor.description],separators=(',',':')).encode())
        for row in cursor:
            count+=1;encoded=json.dumps(row,separators=(',',':')).encode();total+=len(encoded)
            if count>100000 or len(encoded)>65536 or total>32*1024**2:raise client.ContainerClientError('Queue inventory exceeds guard bound')
            digest.update(b'\n'+encoded)
        return dict(jobs=count,sha256=digest.hexdigest())


def _guard(layout,owner,public,identifier,docker_call,health_call):
    current=_attested(layout,owner,public,identifier,docker_call)
    if not current['running'] or current['state']!='running':raise client.ContainerClientError('Exact running coordinator required')
    health=health_call(layout,owner,'GET','/health')
    client._assert_replacement_health(health)
    if (health.get('accepting_jobs') is not False or health.get('stop_requested') is not True or health.get('worker_alive') is not False or health.get('worker_error') is not None or health.get('legacy_jobs')!=[]):raise client.ContainerClientError('Authenticated completed drain required')
    marker=read_stop_request(ServicePaths.from_storage(client._storage_root(layout)))
    if marker is None:raise client.ContainerClientError('Durable pause marker required')
    inventory=_inventory(docker_call,identifier)
    return dict(container_id=identifier,image_id=public['image_id'],containers=inventory,queue=_queue_guard(client._storage_root(layout)))


def quiesce_and_stop(layout, owner, *, expected_container_id, expected_image_id, expected_public_sha256,
                     expected_catalog_sha256, expected_source_hashes, docker_call=None, health_call=None, fence_factory=None):
    """Stop only the exact drained coordinator while its Linux claim fence holds."""
    owner=client._owner(owner);client._image_id(expected_image_id)
    if not client._CONTAINER_ID_RE.fullmatch(expected_container_id or '') or set(expected_source_hashes)!=set(SOURCE_FILES) or any(not re.fullmatch('[a-f0-9]{64}',v) for v in [expected_public_sha256,expected_catalog_sha256,*expected_source_hashes.values()]):raise client.ContainerClientError('Exact coordinator/config/reviewed source digests required')
    docker_call=docker_call or _docker;health_call=health_call or client.request;fence_factory=fence_factory or LinuxFence
    storage=client._storage_root(layout);destination=validate_path(Path(layout['build_root'])/('coordinator-quiesce-'+uuid.uuid4().hex),storage);destination.mkdir(parents=True)
    receipt=dict(schema='fullmag.runner.coordinator-quiesce.v2',operator=owner,storage=str(storage),container_id=expected_container_id,image_id=expected_image_id,status='RUNNING',host_locks_claim_fence=False,linux_fence_script_sha256=hashlib.sha256(REMOTE.encode()).hexdigest(),reviewed_source_hashes=expected_source_hashes,worker_stop_executed=False,queue_mutation_executed=False,profile_mutation_executed=False,expected_public_sha256=expected_public_sha256,expected_catalog_sha256=expected_catalog_sha256,producer_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    receipt_path=destination/'terminal-receipt.json';receipt['receipt_path']=str(receipt_path)
    atomic_json(receipt_path,receipt)
    fence=None;arm_requested=False;stop_requested=False;exited=False
    try:
        with ExitStack() as locks:
            _,_,container_lock=client._config_paths(layout)
            locks.enter_context(file_lock(container_lock,'owned coordinator lifecycle',blocking=False))
            locks.enter_context(file_lock(storage/'locks'/'local-runner-coordinator.lock','host lifecycle serialization only',blocking=False))
            transition.assert_no_pending(storage)
            from local_runner.coordinator_replacement import assert_no_pending, snapshot
            assert_no_pending(storage)
            baseline,public=_configs(layout,owner,expected_public_sha256,expected_catalog_sha256)
            if public['image_id']!=expected_image_id:raise client.ContainerClientError('Expected coordinator image differs from public config')
            receipt['initial_guard']=_guard(layout,owner,public,expected_container_id,docker_call,health_call)
            fence=fence_factory(expected_container_id,expected_source_hashes);receipt['held_ack']=fence.check()
            receipt['status']='FENCE_HELD';atomic_json(receipt_path,receipt)
            _configs(layout,owner,expected_public_sha256,expected_catalog_sha256,baseline)
            receipt['final_guard']=_guard(layout,owner,public,expected_container_id,docker_call,health_call)
            _configs(layout,owner,expected_public_sha256,expected_catalog_sha256,baseline)
            receipt['config_snapshot']=snapshot(destination,storage,owner,baseline)
            fence.check();arm_requested=True
            receipt['status']='ARM_REQUESTED';atomic_json(receipt_path,receipt)
            receipt['armed_ack']=fence.arm()
            stop_requested=True;receipt['status']='STOP_REQUESTED_NOT_CONFIRMED';atomic_json(receipt_path,receipt)
            client._docker_text(docker_call,['stop','--time','10',expected_container_id])
            terminal=_attested(layout,owner,public,expected_container_id,docker_call)
            if terminal['running'] or terminal['state']!='exited':raise client.ContainerClientError('Owned coordinator exit not confirmed')
            exited=True;receipt['terminal_container']=terminal
            fence.confirm_destroyed();receipt['exec_destroyed']=True
            _configs(layout,owner,expected_public_sha256,expected_catalog_sha256,baseline)
            _inventory(docker_call,expected_container_id)
            if _queue_guard(storage)!=receipt['final_guard']['queue']:raise client.ContainerClientError('Queue changed across guarded coordinator stop')
            if read_stop_request(ServicePaths.from_storage(storage)) is None:
                request_stop(ServicePaths.from_storage(storage),requested_by=owner,reason='owned coordinator lifecycle remains paused')
            receipt['pause_marker_sha256']=hashlib.sha256(ServicePaths.from_storage(storage).stop_request_path.read_bytes()).hexdigest()
            receipt.update(status='SUCCEEDED_EXITED_PAUSED_ONLY',pause_marker_preserved=True,qualification='REPLACEMENT_NOT_EXECUTED')
            return receipt
    except BaseException:
        receipt['status']='STOP_UNCONFIRMED_FENCE_QUARANTINED' if stop_requested and not exited else ('EXITED_RECOVERY_REQUIRED' if exited else ('ARM_UNCONFIRMED_FENCE_QUARANTINED' if arm_requested else 'REFUSED_BEFORE_STOP'))
        raise
    finally:
        if fence is not None and not arm_requested:fence.close_before_stop()
        receipt['finished_at']=time.time()
        receipt['coordinator_stop_requested']=stop_requested
        receipt['actual_container_exited']=exited
        atomic_json(receipt_path,receipt)
