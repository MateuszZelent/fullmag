"""Execute the actual managed frontend seed guest against isolated Linux fixtures."""
import ast,base64,hashlib,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
SCRIPT=Path(__file__).with_name('docker_volume_dev.py')
def guest(root):
 tree=ast.parse(SCRIPT.read_text(encoding='utf-8'))
 function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_frontend')
 code=next(n.value.value for n in ast.walk(function) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='script' for t in n.targets))
 return code.replace("'/data",repr(str(root))[:-1])
def manifest(data):
 return {'source_root':'/registered/source','worktree_id':'worktree-alpha','source_commit':'a'*40,'files':[{'relative':'package.json','sha256':hashlib.sha256(data).hexdigest()},{'relative':'apps/control-room/package.json','sha256':hashlib.sha256(b'{}').hexdigest()}]}
def request(data,previous=None):
 return {'files':[{'relative':'package.json','data':base64.b64encode(data).decode()},{'relative':'apps/control-room/package.json','data':base64.b64encode(b'{}').decode()}],'inputs':manifest(data),'previous_inputs':previous,'group_storage':True}
@unittest.skipIf(os.name=='nt','guest uses Linux flock; run this suite under WSL Python')
class FrontendSeedTests(unittest.TestCase):
 def run_guest(self,root,data,previous=None):
  return subprocess.run([sys.executable,'-B','-c',guest(root)],input=json.dumps(request(data,previous)).encode(),capture_output=True)
 def test_dependency_change_reuses_state_and_preserves_unknown_results(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);a=b'{"version":1}';b=b'{"version":2}'
   first=self.run_guest(root,a);self.assertEqual(first.returncode,0,first.stderr)
   (root/'workspace/results.bin').write_bytes(b'unique result')
   frozen=root/'frozen-inputs';frozen.mkdir();(frozen/'package.json').write_bytes(a)
   (frozen/'apps/control-room').mkdir(parents=True);(frozen/'apps/control-room/package.json').write_bytes(b'{}')
   m=manifest(a);raw=json.dumps(m,sort_keys=True,separators=(',',':')).encode()+b'\n'
   (root/'inputs-freeze.json').write_text(json.dumps({'schema':'fullmag.docker-development-inputs-freeze.v1','manifest':m,'manifest_digest':hashlib.sha256(raw).hexdigest(),'frozen_root':'/state/development/frozen-inputs','files':m['files']}))
   second=self.run_guest(root,b,m);self.assertEqual(second.returncode,0,second.stderr)
   self.assertEqual((root/'workspace/package.json').read_bytes(),b)
   self.assertEqual((root/'workspace/results.bin').read_bytes(),b'unique result')
   self.assertFalse((root/'inputs-freeze.json').exists())
 def test_unknown_metadata_changes_are_retained(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);a=b'{"version":1}';self.assertEqual(self.run_guest(root,a).returncode,0)
   (root/'workspace/package.json').write_bytes(b'foreign uncommitted data')
   result=self.run_guest(root,b'{"version":2}',manifest(a));self.assertNotEqual(result.returncode,0)
   self.assertEqual((root/'workspace/package.json').read_bytes(),b'foreign uncommitted data')
 def test_workspace_root_symlink_cannot_write_external_data(self):
  with tempfile.TemporaryDirectory() as tmp,tempfile.TemporaryDirectory() as ext:
   root=Path(tmp);outside=Path(ext);(outside/'package.json').write_bytes(b'original')
   (root/'workspace').symlink_to(outside,target_is_directory=True)
   self.assertNotEqual(self.run_guest(root,b'new').returncode,0)
   self.assertEqual((outside/'package.json').read_bytes(),b'original')
 def test_legacy_frontend_seed_runs_without_private_group_storage(self):
  from types import SimpleNamespace
  from unittest import mock
  sys.path.insert(0,str(SCRIPT.parent))
  sys.path.insert(0,str(SCRIPT.parents[1]/'docker/all-in-one'))
  import docker_development_inputs
  import docker_volume_dev

  inputs={'source_root':'/registered/source','worktree_id':'worktree-alpha',
   'source_commit':'a'*40,'files':[],'live_directories':[]}
  writes=[]
  control=SimpleNamespace(project='legacy-project',image='helper-image',
   read=lambda path,optional=False:None,
   write=lambda path,value:writes.append((path,value)),
   helper_args=lambda command:['docker','run','--entrypoint','python','helper-image'])
  operation={'root':'development/attempts/'+'a'*32,'receipt':{'attempt':'a'*32}}
  def capture(args,*,data,timeout):
   request=json.loads(data)
   self.assertFalse(request['group_storage'])
   self.assertIsNone(request['frontend_generation'])
   result={'state':'seeded','files':0,'inputs':inputs,
    'frontend_generation_probe':None,'frontend_generation':None}
   return SimpleNamespace(returncode=0,stdout=json.dumps(result).encode(),stderr=b'')

  with mock.patch.object(docker_development_inputs,'seed',return_value=inputs), \
       mock.patch.object(docker_development_inputs,'metadata_cache_key',return_value='metadata-key'), \
       mock.patch.object(docker_volume_dev,'_uses_private_group_storage',return_value=False), \
       mock.patch.object(docker_volume_dev,'_owned_volume',return_value='legacy-frontend-volume'), \
       mock.patch.object(docker_volume_dev,'bounded_capture',side_effect=capture) as docker:
   observed,volume=docker_volume_dev._frontend(control,operation,Path('/selected'),Path('/state'),3200,
    'frontend-image')

  self.assertEqual(observed,inputs)
  self.assertEqual(volume,'legacy-frontend-volume')
  self.assertEqual(operation['receipt']['frontend_volume'],volume)
  self.assertEqual([path for path,_ in writes],[
   operation['root']+'/frontend-seed.json','frontend/development-inputs.json'])
  docker.assert_called_once()
if __name__=='__main__':unittest.main()
