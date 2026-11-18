"""Build-only claimed-interruption guards, without Docker/runtime mutations."""
import ast,contextlib,copy,fcntl,hashlib,json,os,stat,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import docker_dev_recovery_build as repair

def raw(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def sha(v):return hashlib.sha256(raw(v)).hexdigest()
def fixture():
 i=dict(store_id='sha256:'+'1'*64,host_id='host-one',run_id='run-one',task_id='task-one',attempt_id='attempt-one',ownership_epoch=1,resource_id='gpu-one',lease_token='lease-one',reservation_request_sha256='2'*64,runtime_generation_sha256='3'*64)
 c={k:i[k] for k in ('run_id','task_id','attempt_id','ownership_epoch','lease_token')}
 l=dict(schema_version='resource_lease.v1',state='active',kind='gpu',budget={'cpu_millis':1000,'memory_bytes':1,'gpu_memory_bytes':1,'storage_bytes':1},**{k:i[k] for k in ('run_id','task_id','attempt_id','ownership_epoch','resource_id','lease_token')})
 ri={k:i[k] for k in ('store_id','run_id','task_id','resource_id','lease_token')};ri['owner']=dict(kind='solver',attempt_id=i['attempt_id'],ownership_epoch=1)
 token='12345678-1234-1234-1234-123456789abc'
 r=dict(identity=ri,state='committed',host_id=i['host_id'],request_sha256=i['reservation_request_sha256'],runtime_generation_sha256=i['runtime_generation_sha256'],worker_launch_gate=dict(state='consumed',token=token))
 i.update(reservation_before_sha256=sha(r),lease_before_sha256=sha(l))
 t=dict(task_id=i['task_id'],attempt_id=i['attempt_id'],ownership_epoch=1,resource_id=i['resource_id'],lifecycle='running')
 inbox=dict(schema_version='worker_inbox.v1',claim=c,pending=None,applied=[])
 vals=dict(catalog=dict(run_id=i['run_id'],revision=62,tasks=[t]),lease=l,started=dict(identity=dict(schema_version='fullmag.accepted_worker_execution.v1',claim={**{k:v for k,v in c.items() if k!='lease_token'},'lease':{'resource_id':i['resource_id'],'lease_token':i['lease_token'],'kind':l['kind'],'budget':l['budget'],'heartbeat_sequence':0}},start_sequence=2)),inbox=dict(payload=inbox,payload_sha256=sha(inbox)),supervisor_slot=dict(schema_version='fullmag.accepted_worker_supervisor_slot.v3',process_id=102,process_start_token='linux-starttime-one',max_concurrency=1,run_id=i['run_id'],task_id=i['task_id'],resource_id=i['resource_id']),launch=dict(schema_version='runtime_service_launch.v1',state='ready',pid=101))
 observed={k:raw(v) for k,v in vals.items()}
 pin=dict(schema_version='fullmag.claimed-interruption-build-pin.v1',identity=i,consumed_launch_token=token,catalog_revision=62,expected_task=t,files={k:dict(path='/exact/'+k,sha256=hashlib.sha256(v).hexdigest()) for k,v in observed.items()})
 return pin,dict(reservations=[r]),observed

class SnapshotTests(unittest.TestCase):
 def test_exact_repeatable_read_only(self):
  p,l,o=fixture();before=copy.deepcopy((p,l,o));one=repair.validate_claimed_build_snapshot(p,l,o)
  self.assertEqual(one,repair.validate_claimed_build_snapshot(p,l,o));self.assertEqual(before,(p,l,o));self.assertEqual(one['lease']['state'],'active');self.assertEqual(l['reservations'][0]['state'],'committed')
 def test_each_role_bytes_or_digest_drift_refuses(self):
  for role in fixture()[2]:
   for mode in ('bytes','digest'):
    p,l,o=fixture()
    if mode=='bytes':o[role]+=b' '
    else:p['files'][role]['sha256']='0'*64
    with self.subTest(role=role,mode=mode),self.assertRaises(ValueError):repair.validate_claimed_build_snapshot(p,l,o)
 def test_extra_missing_and_changed_capacity_refuse(self):
  for mode in ('extra','released','pending','token','host','identity'):
   p,l,o=fixture();r=l['reservations'][0]
   if mode=='extra':l['reservations'].append(copy.deepcopy(r))
   elif mode=='released':r['state']='released'
   elif mode=='pending':r['worker_launch_gate']['state']='pending'
   elif mode=='token':r['worker_launch_gate']['token']='other'
   elif mode=='host':r['host_id']='other'
   else:r['identity']['store_id']='sha256:'+'4'*64
   with self.subTest(mode=mode),self.assertRaises(ValueError):repair.validate_claimed_build_snapshot(p,l,o)
 def test_catalog_lease_and_slot_semantics_not_only_hashes(self):
  for role,k,v in [('catalog','revision',63),('lease','state','released'),('supervisor_slot','max_concurrency',True),('supervisor_slot','process_id',True)]:
   p,l,o=fixture();changed=json.loads(o[role]);changed[k]=v;o[role]=raw(changed);p['files'][role]['sha256']=hashlib.sha256(o[role]).hexdigest()
   with self.subTest(role=role,key=k),self.assertRaises(ValueError):repair.validate_claimed_build_snapshot(p,l,o)
 def test_started_inbox_and_no_pending_effect_required(self):
  for mode in ('started','inbox','pending','hash'):
   p,l,o=fixture();role='started' if mode=='started' else 'inbox';v=json.loads(o[role])
   if mode=='started':v['identity']['claim']['attempt_id']='foreign'
   elif mode=='inbox':v['payload']['claim']['attempt_id']='foreign'
   elif mode=='pending':v['payload']['pending']={'kind':'start'}
   else:v['payload_sha256']='f'*64
   o[role]=raw(v);p['files'][role]['sha256']=hashlib.sha256(o[role]).hexdigest()
   with self.subTest(mode=mode),self.assertRaises(ValueError):repair.validate_claimed_build_snapshot(p,l,o)
 def test_extra_fields_bool_epoch_nil_token_and_path_refuse(self):
  for mode in ('extra','epoch','token','path'):
   p,l,o=fixture()
   if mode=='extra':p['release_capacity']=True
   elif mode=='epoch':p['identity']['ownership_epoch']=True
   elif mode=='token':p['consumed_launch_token']='00000000-0000-0000-0000-000000000000'
   else:p['identity']['run_id']='../foreign'
   with self.subTest(mode=mode),self.assertRaises(ValueError):repair.validate_claimed_build_snapshot(p,l,o)

class LockTests(unittest.TestCase):
 @contextlib.contextmanager
 def scope(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);ledger=root/'ledger';store=root/'store'
   for p in (ledger,store):p.mkdir();(p/'WRITER.lock').touch()
   ns=dict(contextlib=contextlib,Path=Path,os=os,stat=stat,fcntl=fcntl,require=repair.require,backend=SimpleNamespace(_assert_no_links=lambda *args:None))
   node=next(n for n in ast.parse(repair.RUNTIME).body if isinstance(n,ast.FunctionDef) and n.name=='claimed_build_locks')
   exec(compile(ast.Module(body=[node],type_ignores=[]),'<claimed-locks>','exec'),ns)
   with patch.dict(os.environ,FULLMAG_HOST_LEDGER_ROOT=str(ledger)):yield ns['claimed_build_locks'],ledger,store
 def test_real_locks_held_then_released(self):
  with self.scope() as (locks,ledger,store):
   with locks(dict(claimed_interruption_build={},diagnostic_api_only=True),SimpleNamespace(store=store)):
    for p in (ledger,store):
     with (p/'WRITER.lock').open() as f:
      with self.assertRaises(BlockingIOError):fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
   for p in (ledger,store):
    with (p/'WRITER.lock').open() as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
 def test_default_takes_no_extra_lock_and_claimed_requires_diagnostic(self):
  with self.scope() as (locks,ledger,store):
   with locks({},SimpleNamespace(store=store)):
    with (ledger/'WRITER.lock').open() as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
   with self.assertRaises(ValueError):
    with locks(dict(claimed_interruption_build={}),SimpleNamespace(store=store)):pass

if __name__=='__main__':unittest.main()

class ClaimedBuildShellTests(unittest.TestCase):
 def test_exact_pair_is_forwarded_only_in_diagnostic_mode(self):
  from test_docker_recovery_resume_authority import ResumeShellTests
  shell=ResumeShellTests();relative='verification/claimed-interruption/'+'a'*32+'/build-pin.json'
  pair=" --claimed-build-pin '"+relative+"' --claimed-build-pin-sha256 '"+'f'*64+"'"
  valid=shell.recipe(pair=False)+' --diagnostic-api-only'+pair
  result=shell.dispatch(valid)
  self.assertEqual(result.returncode,0,result.stderr)
  self.assertEqual(result.stdout.split(b'\0')[-5:-1],[b'--claimed-build-pin',relative.encode(),b'--claimed-build-pin-sha256',b'f'*64])
  self.assertNotEqual(shell.dispatch(shell.recipe(pair=False)+pair).returncode,0)
 def test_partial_or_escaped_build_pins_refuse(self):
  from test_docker_recovery_resume_authority import ResumeShellTests
  shell=ResumeShellTests();base=shell.recipe(pair=False)+' --diagnostic-api-only'
  for tail in [" --claimed-build-pin 'verification/claimed-interruption/"+'a'*32+"/build-pin.json'", " --claimed-build-pin '../outside.json' --claimed-build-pin-sha256 '"+'f'*64+"'", " --claimed-build-pin 'verification/claimed-interruption/"+'a'*32+"/build-pin.json' --claimed-build-pin-sha256 '"+'f'*64+"';touch /tmp/forbidden"]:
   with self.subTest(tail=tail):self.assertNotEqual(shell.dispatch(base+tail).returncode,0)

class ConsumerSubpathTests(unittest.TestCase):
 def test_isolated_frontend_allowed_but_backend_aliases_refuse(self):
  import docker_backend_volume_cache as cache
  from test_docker_group_backend_cache import GroupBackendCacheTests
  from test_docker_backend_volume_cache import _profile
  with tempfile.TemporaryDirectory() as tmp:
   profile=GroupBackendCacheTests().prepare(_profile(tmp,shared_packages=True))
   name=profile['volume_names']['build'];root='/var/lib/docker/volumes/'+name+'/_data'
   row={'Id':'frontend','State':{'Running':True},'Config':{'Labels':{}},'Mounts':[{'Type':'volume','Name':name,'Destination':'/state/development','Source':root+'/private/frontend'}],'HostConfig':{'Mounts':[{'Type':'volume','Source':name,'Target':'/state/development','VolumeOptions':{'Subpath':'private/frontend'}}]}}
   repair.validate_other_cache_consumers(profile,[row], 'own-backend')
   for subpath in ('','private','private/backend','private/backend/nested'):
    changed=copy.deepcopy(row);changed['Mounts'][0]['Source']=root+('/'+subpath if subpath else '');changed['HostConfig']['Mounts'][0]['VolumeOptions']['Subpath']=subpath
    with self.subTest(subpath=subpath),self.assertRaises(cache.BackendVolumeCacheError):repair.validate_other_cache_consumers(profile,[changed],'own-backend')
