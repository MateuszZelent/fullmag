import copy,json,os,pathlib,shlex,subprocess,tempfile,unittest
from unittest.mock import patch
import docker_volume_missing_owner_failure as m
from docker_build_control import canonical,BuildControlError
BASE=pathlib.Path(__file__).resolve().parent
REQUEST=json.loads('{"attempt":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","before_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","build_request_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","compose_project":"fullmag-worktree-fixture","compose_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","containers":{"backend":{"fingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","id":"1111111111111111111111111111111111111111111111111111111111111111","image":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","started_at":"2026-10-28T00:00:00Z"},"frontend":{"fingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","id":"2222222222222222222222222222222222222222222222222222222222222222","image":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","started_at":"2026-10-28T00:00:00Z"},"lease":{"fingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","id":"3333333333333333333333333333333333333333333333333333333333333333","image":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","started_at":"2026-10-28T00:00:00Z"}},"controller_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","failure":{"exit_code":2,"finished_at":"2026-10-28T00:01:00Z","log_sha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"phase_current_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","port":3203,"previous_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","prior_request":"prior.json","prior_request_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","reconciler_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","recovery_controller_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","schema":"fullmag.retained-recovery-missing-owner-failure.v1","source_root":"/source","unknown_receipt_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","verified_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}')

class TransactionTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
  self.req=copy.deepcopy(REQUEST);self.op='recovery-build/attempts/'+self.req['attempt']
  self.original=canonical({'schema':'fullmag.docker-build-operation.v1','phase':'recovery-build','state':'outcome-unknown-resources-retained','attempt':self.req['attempt'],'inputs':{'attempt':'a'*32,'request':'submitted.json','request_sha256':m.digest(b'submitted')}})
  self.script=m.transaction_script(self.req,self.original,root=self.root,external=False)
  spec=json.loads(shlex.split(self.script)[-1])
  self.spec=spec;self.pins={}
  # Fixture pins are real hashes; original request shapes retain all production guards.
  for rel,sha in spec['pins'].items():
   if sha is not None:
    raw=('fixture '+rel).encode();self.put(rel,raw);self.pins[rel]=m.digest(raw)
   else:self.pins[rel]=None
  spec['pins']=self.pins
  self.script='exec python3 -I -B -c '+shlex.quote(m.TRANSACTION)+' '+shlex.quote(canonical(spec).decode())
  self.put(self.op+'/receipt.json',self.original);self.put('active',(self.req['attempt']+'\n').encode());self.put('operation.lock',b'')
 def tearDown(self):self.tmp.cleanup()
 def put(self,p,raw):
  p=self.root/p;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
 def run_script(self,command='COMMIT\n',script=None):
  return subprocess.run(['bash','-euo','pipefail','-c',script or self.script],input=command,text=True,capture_output=True,timeout=5)
 def test_commit_and_identical_replay(self):
  first=self.run_script();self.assertEqual(first.returncode,0,first.stderr)
  self.assertFalse((self.root/'active').exists());self.assertEqual((self.root/self.op/'terminal.json').read_bytes(),m.result_bytes(self.req,json.loads(self.original)))
  second=self.run_script();self.assertEqual(second.returncode,0,second.stderr)
  for rel,sha in self.pins.items():self.assertEqual(m.digest((self.root/rel).read_bytes()) if sha else None,sha)
 def test_abort_keeps_active_and_no_terminal(self):
  r=self.run_script('ABORT\n');self.assertNotEqual(r.returncode,0);self.assertTrue((self.root/'active').exists());self.assertFalse((self.root/self.op/'terminal.json').exists())
 def test_each_lock_busy(self):
  import fcntl
  for rel in ('operation.lock',self.op+'/reconcile-observer.lock',self.op+'/reconcile-commit.lock'):
   self.put(rel,b'')
   with (self.root/rel).open('rb') as f:
    fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);r=self.run_script();self.assertNotEqual(r.returncode,0,rel)
   self.assertTrue((self.root/'active').exists())
 def test_foreign_active(self):
  self.put('active',b'b'*32);self.assertNotEqual(self.run_script().returncode,0)
 def test_changed_pin(self):
  rel=next(k for k,v in self.pins.items() if v);self.put(rel,b'changed');self.assertNotEqual(self.run_script().returncode,0)
 def test_foreign_terminal(self):
  self.put(self.op+'/terminal.json',b'foreign');self.assertNotEqual(self.run_script().returncode,0)
 def test_foreign_missing_owner_journal(self):
  self.put(self.op+'/missing-owner-failure/foreign/intent.json',b'foreign')
  self.assertNotEqual(self.run_script().returncode,0)
 def test_symlink_lock(self):
  (self.root/'operation.lock').unlink();(self.root/'operation.lock').symlink_to('/dev/null');self.assertNotEqual(self.run_script().returncode,0)
 def test_replay_each_publication_interruption(self):
  for marker in ("publish(operation/'unknown-receipt.json',original)","publish(journal/'intent.json',intent)","publish(journal/'result.json',result)","publish(operation/'terminal.json',result)","publish(operation/'receipt.json',result,original)","if a is not None:os.unlink(active);sync(root)"):
   with self.subTest(marker=marker):
    # Restore only our isolated fixture between injection cases.
    self.tearDown();self.setUp()
    injected=m.TRANSACTION.replace(marker,marker+'\nraise RuntimeError("injected interruption")')
    script='exec python3 -I -B -c '+shlex.quote(injected)+' '+shlex.quote(canonical(self.spec|{'pins':self.pins}).decode())
    self.assertNotEqual(self.run_script(script=script).returncode,0)
    resumed=self.run_script();self.assertEqual(resumed.returncode,0,resumed.stderr)
 def test_missing_active_incomplete_refused(self):
  (self.root/'active').unlink();self.assertNotEqual(self.run_script().returncode,0)
 def test_changed_pin_after_locked(self):
  p=subprocess.Popen(['bash','-euo','pipefail','-c',self.script],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  self.assertEqual(p.stdout.readline().strip(),'LOCKED');self.put(next(k for k,v in self.pins.items() if v),b'changed')
  _,err=p.communicate('COMMIT\n',timeout=5);self.assertNotEqual(p.returncode,0,err);self.assertTrue((self.root/'active').exists())

class GuardTests(unittest.TestCase):
 def test_old_schema_refused(self):
  r=dict(REQUEST);r['schema']='fullmag.retained-recovery-failed-build-reconciliation.v1'
  with self.assertRaises(BuildControlError):m.validate_request(r)
 def test_live_owner_refused(self):
  with patch.object(m,'_probe_helper_absence',return_value=None),self.assertRaises(BuildControlError):m.missing_owner(REQUEST)
 def test_id_and_name_required(self):
  with patch.object(m,'_probe_helper_absence',side_effect=['absent',None]) as p,self.assertRaises(BuildControlError):m.missing_owner(REQUEST)
  self.assertEqual(p.call_count,2)
 def test_docker_error_is_not_absence(self):
  with patch.object(m,'_probe_helper_absence',side_effect=BuildControlError('timeout')),self.assertRaises(BuildControlError):m.missing_owner(REQUEST)
 def test_legacy_failure_still_requires_live_lease(self):
  import inspect,docker_volume_recovery_failure_reconcile as old
  self.assertIn('running=name == "lease"',inspect.getsource(old.inspect_pins))
  self.assertIn('validate_original_owner(actual["lease"]',inspect.getsource(old.collect))
 def test_legacy_offline_still_rejects_recovery_build(self):
  from docker_volume_offline_reconcile import _validate_operation_phase
  with self.assertRaises(BuildControlError):_validate_operation_phase({'phase':'recovery-build','state':'outcome-unknown-resources-retained'})


class MixedContextTests(unittest.TestCase):
 def test_mixed_contexts_refused(self):
  import docker_volume_container_recovery as recovery
  with self.assertRaisesRegex(BuildControlError,'cannot be combined'):
   recovery.prepare_abrupt_stop_proof(None,{}, {},failure_reconciliation_helpers={},missing_owner_reconciliation={})
  with self.assertRaisesRegex(BuildControlError,'cannot be combined'):
   recovery._assert_no_foreign_storage_consumers(None,{}, {},failure_reconciliation_helpers={},missing_owner_reconciliation={})

class LedgerLockTests(unittest.TestCase):
 def test_snapshot_lock_under_transaction_shared_lock(self):
  import ast,fcntl
  source=pathlib.Path(m.__file__).with_name('docker_volume_container_recovery.py').read_text()
  tree=ast.parse(source)
  function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_ledger_and_store_snapshot')
  script=next(n.value.value for n in ast.walk(function) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='script' for t in n.targets) and isinstance(n.value,ast.Constant))
  start=script.index("fd=os.open(ledger/'WRITER.lock'")
  end=script.index("    document=json.loads",start)
  lock_code=script[start:end]+"    print('ACQUIRED')\nfinally:\n    os.close(fd)\n"
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'WRITER.lock';p.write_bytes(b'')
   with p.open('rb') as f:
    fcntl.flock(f,fcntl.LOCK_SH|fcntl.LOCK_NB)
    for shared,success in ((True,True),(False,False)):
     code='import fcntl,os,pathlib,time\nledger=pathlib.Path('+repr(d)+')\nobservation='+repr({'authenticated_shared_ledger':shared})+'\n'+lock_code
     r=subprocess.run(['python3','-I','-B','-c',code],capture_output=True,timeout=8)
     self.assertEqual(r.returncode==0,success,r.stderr)
 def test_shared_mode_has_no_public_boolean_argument(self):
  import ast
  source=pathlib.Path(m.__file__).with_name('docker_volume_container_recovery.py').read_text();tree=ast.parse(source)
  function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_ledger_and_store_snapshot')
  names=[a.arg for a in function.args.args+function.args.kwonlyargs]
  self.assertNotIn('shared_ledger_lock',names)
  text=ast.get_source_segment(source,function)
  self.assertIn('shared_ledger_lock = False',text)
  self.assertIn('authenticated = authenticated_control_helpers(control, missing_owner_reconciliation)',text)
  self.assertIn('shared_ledger_lock = bool(authenticated)',text)


class CollectTests(unittest.TestCase):
 def setUp(self):
  from types import SimpleNamespace
  import docker_volume_dev as dev,docker_volume_container_recovery as recovery
  self.dev,self.recovery=dev,recovery
  self.r=copy.deepcopy(REQUEST);r=self.r;self.root='recovery-build/attempts/'+r['attempt'];base='development/attempts/'+'f'*32
  self.c=SimpleNamespace(project=r['compose_project'],volume='fixture-control')
  self.log=b"backend-dev: phase=make state=complete exit_code=2 duration_ms=20\nbackend-dev: canonical Make target failed with exit code 2\n"
  self.actual={'backend':{'Id':r['containers']['backend']['id'],'Image':r['containers']['backend']['image'],'Config':{},'HostConfig':{},'Mounts':[],
   'State':{'Status':'exited','Running':False,'OOMKilled':False,'Dead':False,'Restarting':False,'ExitCode':2,'FinishedAt':r['failure']['finished_at'],'Error':'','Pid':0,'Paused':False}},'frontend':{'unchanged':True}}
  r['failure']['log_sha256']=m.digest(self.log)
  document={'name':r['compose_project'],'services':{'frontend':{'ports':[{'published':r['port'],'host_ip':'127.0.0.1'}]}}}
  pins={'development_attempt':'f'*32,'compose_config_sha256':m.digest(canonical(document)),
   'old_image_id':r['containers']['backend']['image'],'source_root':r['source_root'],'compose_project':r['compose_project'],
   'backend_container_id':r['containers']['backend']['id'],'frontend_container_id':r['containers']['frontend']['id']}
  self.build={'schema':dev._RECOVERY_HISTORY_BUILD_SCHEMA,'authorization_pins':pins,'source_commit':'a'*40,'controller_sha256':'b'*64,
   'retained_terminal_runs':[],'retained_held_manual_runs':[],'retained_attempt_histories':[]}
  before={'authorization_pins':pins,'raw_records':{'raw':'unchanged'},'storage_proof':{'store':'unchanged'},'retained_terminal_runs':[],
   'retained_held_manual_runs':[],'retained_attempt_histories':[],'docker_engine_id_sha256':'c'*64,'network':{'network':'unchanged'},'containers':self.actual}
  self.after=copy.deepcopy(before)
  original={'schema':'fullmag.docker-build-operation.v1','phase':'recovery-build','state':'outcome-unknown-resources-retained',
   'attempt':r['attempt'],'compose_project':r['compose_project'],'control_volume':self.c.volume,'helper_container':'fullmag-control-'+r['attempt'],
   'backend_started_at':r['containers']['backend']['started_at'],'inputs':{'source_root':r['source_root'],'request':'submitted.json',
    'request_sha256':m.digest(canonical(self.build)),'attempt':pins['development_attempt'],'config_sha256':pins['compose_config_sha256'],
    'image_id':pins['old_image_id'],'source_commit':self.build['source_commit'],'controller_sha256':self.build['controller_sha256']}}
  self.records={self.root+'/receipt.json':canonical(original),self.root+'/before.json':canonical(before),self.root+'/request.json':canonical(self.build),
   'submitted.json':canonical(self.build),base+'/terminal.json':canonical({'state_root':'/state'}),base+'/compose.json':canonical(document),'active':r['attempt'].encode()}
  for field,path in [('unknown_receipt_sha256',self.root+'/receipt.json'),('before_sha256',self.root+'/before.json'),('build_request_sha256',self.root+'/request.json'),('previous_sha256',base+'/terminal.json'),('compose_sha256',base+'/compose.json')]:r[field]=m.digest(self.records[path])
  r['phase_current_sha256']=None;r['verified_sha256']=None
  for key,path in [('controller_sha256',m.__file__),('reconciler_sha256',pathlib.Path(m.__file__).with_name('docker_volume_reconcile.py')),('recovery_controller_sha256',recovery.__file__)]:r[key]=m.digest(pathlib.Path(path).read_bytes())
  prior=dict(r);prior.pop('prior_request');prior.pop('prior_request_sha256');prior['schema']='fullmag.retained-recovery-failed-build-reconciliation.v1'
  self.records[r['prior_request']]=canonical(prior);r['prior_request_sha256']=m.digest(canonical(prior))
 def run_collect(self,*,log=None,actual=None,certificate_error=False,proof_error=False):
  from contextlib import ExitStack
  from types import SimpleNamespace
  import docker_dev
  def read(_c,path,optional=False):
   if path in self.records:return self.records[path]
   if optional:return None
   raise BuildControlError('Missing fixture '+path)
  with ExitStack() as stack:
   stack.enter_context(patch.object(m,'read_raw',side_effect=read));stack.enter_context(patch.object(m,'missing_owner'))
   stack.enter_context(patch.object(m,'inspect_pins',return_value=self.actual if actual is None else actual))
   stack.enter_context(patch.object(m,'docker_capture',return_value=SimpleNamespace(stdout=self.log if log is None else log,stderr=b'')))
   stack.enter_context(patch.object(self.dev,'_recovery_build_request',return_value=self.build))
   stack.enter_context(patch.object(self.recovery,'prepare_abrupt_stop_proof',return_value=self.after,side_effect=BuildControlError('Foreign observer') if proof_error else None))
   stack.enter_context(patch.object(docker_dev,'_select_source',return_value=(pathlib.Path(self.r['source_root']),{'runtime_root':'/runtime'})))
   stack.enter_context(patch.object(self.dev.storage,'validate_path',return_value=pathlib.Path('/state')))
   stack.enter_context(patch.object(self.dev,'_recovery_build_certificate',return_value={'certificate':'unchanged'},side_effect=BuildControlError('Certificate changed') if certificate_error else None))
   return m.collect(self.c,pathlib.Path(self.r['source_root']),self.r)
 def test_valid_collection(self):self.assertEqual(self.run_collect()['failure_log_sha256'],self.r['failure']['log_sha256'])
 def test_changed_certificate_gate_propagates(self):
  with self.assertRaises(BuildControlError):self.run_collect(certificate_error=True)
 def test_changed_raw_records_and_store(self):
  for key in ('raw_records','storage_proof','retained_attempt_histories','network'):
   with self.subTest(key=key):
    old=self.after[key];self.after[key]={'changed':True}
    with self.assertRaises(BuildControlError):self.run_collect()
    self.after[key]=old
 def test_changed_log(self):
  with self.assertRaises(BuildControlError):self.run_collect(log=self.log+b'changed')
 def test_changed_service(self):
  changed=copy.deepcopy(self.actual);changed['backend']['Config']['changed']=True
  with self.assertRaises(BuildControlError):self.run_collect(actual=changed)
 def test_phase_records_and_publication_refused(self):
  for path in ('recovery-build/current.json','recovery-build/verified.json',self.root+'/backend-build-receipt.json',self.root+'/provenance.json',self.root+'/native-capabilities.json',self.root+'/handoff-log.json'):
   with self.subTest(path=path):
    self.records[path]=b'changed'
    with self.assertRaises(BuildControlError):self.run_collect()
    self.records.pop(path)
 def test_changed_prior_request(self):
  self.records[self.r['prior_request']]+=b' '
  with self.assertRaises(BuildControlError):self.run_collect()
 def test_changed_prior_pins(self):
  self.r['containers']['backend']['started_at']='changed'
  with self.assertRaises(BuildControlError):self.run_collect()
 def test_foreign_consumer_gate_propagates(self):
  with self.assertRaises(BuildControlError):self.run_collect(proof_error=True)

class ObserverIncarnationTests(unittest.TestCase):
 def run_observer(self,state):
  from types import SimpleNamespace
  r=copy.deepcopy(REQUEST);name='fullmag-missing-owner-'+m.digest(canonical(r))[:32]
  row={'Id':'f'*64,'Image':'sha256:'+'c'*64,'State':state,'Config':{},'HostConfig':{},'Mounts':[]}
  context={'request':r,'observer':{'name':name,'id':row['Id'],'started_at':'started','fingerprint':m.fingerprint(row)}}
  with patch.object(m,'missing_owner'),patch.object(m,'transaction_resources',return_value=(b'{}',pathlib.Path('/store'),'ledger')),patch.object(m,'transaction_script',return_value='fixed'),patch.object(m,'inspect_transaction',return_value=row['Id']),patch.object(m,'docker_capture',return_value=SimpleNamespace(stdout=json.dumps([row]).encode())):
   return m.authenticated_control_helpers(SimpleNamespace(project=r['compose_project']),context)
 def test_stopped_between_inspects_refused(self):
  with self.assertRaises(BuildControlError):self.run_observer({'StartedAt':'started','Running':False,'Status':'exited'})
 def test_status_mismatch_refused(self):
  with self.assertRaises(BuildControlError):self.run_observer({'StartedAt':'started','Running':True,'Status':'restarting'})
 def test_restarted_between_inspects_refused(self):
  with self.assertRaises(BuildControlError):self.run_observer({'StartedAt':'changed','Running':True,'Status':'running'})
 def test_live_exact_observer(self):self.assertEqual(self.run_observer({'StartedAt':'started','Running':True,'Status':'running'}),{'f'*64})

class TransactionImageTests(unittest.TestCase):
 def test_pinned_runtime_image_preserves_control_scope(self):
  from types import SimpleNamespace
  original=SimpleNamespace(image="base-without-python",project="project",volume="volume",namespace="scope")
  selected=m.transaction_control(original,REQUEST)
  self.assertEqual(selected.image,REQUEST["containers"]["backend"]["image"])
  self.assertEqual(original.image,"base-without-python")
  self.assertEqual((selected.project,selected.volume,selected.namespace),("project","volume","scope"))
 def test_mutable_image_tag_refused(self):
  from types import SimpleNamespace
  request=copy.deepcopy(REQUEST);request["containers"]["backend"]["image"]="runtime:latest"
  with self.assertRaises(BuildControlError):m.transaction_control(SimpleNamespace(),request)

class WslTransactionMountTests(unittest.TestCase):
 def inspect(self,source,proofs=(True,True),returned="container",identities=((1,2),)*4,change=None):
  from types import SimpleNamespace
  row={"Id":"container","Name":"/name","Image":"image","Config":{},"State":{"Running":True,"Status":"running","StartedAt":"started"},"HostConfig":{"Mounts":[{"Target":"/store","Source":source}]},"Mounts":[{"Destination":"/store","Source":source,"RW":False}]}
  after=copy.deepcopy(row)
  if change:change(after)
  with patch.object(m,"docker_capture",side_effect=[SimpleNamespace(stdout=json.dumps([x]).encode()) for x in (row,after)]), patch("docker_dev_codegen._source_mount_matches_selected",side_effect=proofs) as samefile, patch.object(m,"directory_identity",side_effect=identities), patch.object(m,"_inspect_transaction_helper",return_value=returned) as strict:
   result=m.inspect_transaction(SimpleNamespace(),"name","script",pathlib.Path("/expected"),"ledger")
   return result,strict.call_args.args[3],samefile.call_count
 def test_proven_alias_rechecked(self):
  source="/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/"+"a"*64
  result,expected,count=self.inspect(source)
  self.assertEqual((result,expected,count),("container",pathlib.Path(source),2))
 def test_wrong_or_changed_inode_refused(self):
  source="/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/"+"a"*64
  for proofs in ((False,),(True,False)):
   with self.subTest(proofs=proofs),self.assertRaises(BuildControlError):self.inspect(source,proofs)
  with self.assertRaises(BuildControlError):self.inspect(source,identities=((1,2),(1,2),(1,3),(1,3)))
 def test_replaced_container_refused(self):
  source="/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/"+"a"*64
  with self.assertRaises(BuildControlError):self.inspect(source,returned="different")
 def test_restart_or_mount_change_refused(self):
  source="/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/"+"a"*64
  for change in (lambda row:row["State"].update(StartedAt="new"),lambda row:row["State"].update(Running=False),lambda row:row["Mounts"][0].update(Source="/different"),lambda row:row["Mounts"][0].update(RW=True)):
   with self.assertRaises(BuildControlError):self.inspect(source,change=change)
 def test_other_paths_keep_legacy_exact_validation(self):
  for source in ("/Expected","/expected","/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/not-a-token"):
   with self.subTest(source=source):
    _,expected,count=self.inspect(source)
    self.assertEqual(expected,pathlib.Path("/expected"));self.assertEqual(count,0)

if __name__=='__main__':unittest.main()
