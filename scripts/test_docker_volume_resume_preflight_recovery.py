"""Offline tests; Docker and user stores are never accessed."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import docker_volume_resume_preflight_recovery as m
from docker_build_control import BuildControl, BuildControlError, canonical
from docker_volume_reconcile import claim_script, commit_script

class Control:
    namespace = ""
    path = staticmethod(BuildControl.path)
    project = "test-group"
    volume = "test-volume"

def fixture():
    pins = {m.BASE_ROOT + "/" + n: "a" * 64 for n in ("receipt.json", "terminal.json", "compose.json", "backend-cache.json", "group-ledger.json", "frontend-seed.json", "cache-maintenance-compose.json")}
    pins.update({m.ROOT + "/build.log": "b" * 64, "active": m.digest((m.ATTEMPT + "\n").encode()), "resume/current.json": None, "resume/verified.json": None})
    pins.update({p: None for p in m.ABSENT}); pins[m.BASE_ROOT + "/compose.json"] = m.RAW_COMPOSE
    containers = {}
    for name in ("lease", *m.SERVICES):
        containers[name] = dict(id=m.APPROVED_IDS[name], image="sha256:" + "1" * 64, fingerprint="2" * 64,
            started_at="2026-11-05T13:52:42.662357457Z" if name == "lease" else "2026-11-05T13:29:27.299108362Z")
        if name != "lease": containers[name].update(finished_at="2026-11-05T13:40:29.919920844Z", exit_code=2 if name == "backend" else 1)
    return dict(schema=m.SCHEMA, attempt=m.ATTEMPT, base_attempt=m.BASE, source_root="/worktree", source_revision="3" * 40,
        compose_project="test-group", control_volume="test-volume", engine_id="engine", unknown_receipt_sha256=m.ORIGINAL,
        compose_sha256=m.COMPOSE, controller_inputs={n: "4" * 64 for n in m.CONTROLLERS}, control_pins=pins,
        containers=containers, protected_store={"fixture": True}, empty_ledger_relative="private/ledger/ledger")

class Validation(unittest.TestCase):
    def test_exact_request(self):m.validate_request(fixture())
    def test_mutations_refused(self):
        for key,value in [("schema","legacy"),("attempt","0"*32),("base_attempt","0"*32),("unknown_receipt_sha256","0"*64),
            ("compose_sha256","0"*64),("empty_ledger_relative","private"),("source_root","/safe/../unsafe"),("protected_store",{}),("source_revision","short")]:
            with self.subTest(key=key):
                r=fixture();r[key]=value
                with self.assertRaises(BuildControlError):m.validate_request(r)
    def test_missing_extra_or_native_state_refused(self):
        mutations=[lambda r:r.update(skip=True),lambda r:r.pop('protected_store'),lambda r:r['controller_inputs'].pop('docker_volume_resume_protected.py')]
        mutations += [lambda r,p=p:r['control_pins'].update({p:'5'*64}) for p in m.ABSENT]
        for mutate in mutations:
            r=fixture();mutate(r)
            with self.assertRaises(BuildControlError):m.validate_request(r)
    def test_reincarnation_refused(self):
        for name in ('lease',*m.SERVICES):
            r=fixture();r['containers'][name]['id']='5'*64
            with self.assertRaises(BuildControlError):m.validate_request(r)
        for name in m.SERVICES:
            r=fixture();r['containers'][name]['finished_at']='2026-11-05T14:00:00Z'
            with self.assertRaises(BuildControlError):m.validate_request(r)
    def test_result_preserves_failure_and_is_deterministic(self):
        original=dict(state='unknown',error=m.ERROR,finished_at=123.5,opaque={'retained':True});raw=canonical(original)
        result=m.failure_result(raw,'1'*64);self.assertEqual(result,m.failure_result(raw,'1'*64))
        value=json.loads(result);self.assertEqual(value['error'],original['error']);self.assertEqual(value['finished_at'],123.5)
        self.assertEqual(value['opaque'],original['opaque']);self.assertFalse(value['reconciliation']['services_started'])
    def test_old_paths_and_placeholder_refused(self):
        from docker_volume_development_interrupted import validate_request
        with self.assertRaises(BuildControlError):validate_request(fixture())
        for sha in (None,'__RESULT_SHA__','short'):
            with self.assertRaises(BuildControlError):claim_script(Control(),m.ROOT,fixture(),m.ORIGINAL,phase='resume',publish_verified=False,result_sha256=sha)
        with self.assertRaises(BuildControlError):commit_script(Control(),m.ROOT,fixture(),'journal','1'*64,m.ORIGINAL,phase='resume',publish_verified=True)
    def test_preview_never_publishes(self):
        r=fixture();raw=canonical(r)
        with patch.object(m,'preview',return_value=(b'original',b'result',{'checked':True},False)),patch.object(m,'write_immutable') as write,patch.object(m.subprocess,'Popen') as spawn:
            self.assertEqual(m.reconcile(Control(),Path('/worktree'),raw,m.digest(raw))['state'],'validated-only')
            write.assert_not_called();spawn.assert_not_called()
    def test_bad_request_hash_never_observes(self):
        with patch.object(m,'preview') as preview:
            with self.assertRaises(BuildControlError):m.reconcile(Control(),Path('/worktree'),canonical(fixture()),'0'*64)
            preview.assert_not_called()
    def test_raw_compose_and_semantic_pins_are_distinct(self):
        raw=json.dumps({'name':'group','services':{}},indent=2).encode()
        self.assertNotEqual(m.digest(raw),m.digest(canonical(json.loads(raw))))
        r=fixture();r['control_pins'][m.BASE_ROOT+'/compose.json']=m.COMPOSE
        with self.assertRaises(BuildControlError):m.validate_request(r)

class Shell(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'control';self.root.mkdir()
        self.r=fixture();self.original=b'original unknown\n';self.result=b'deterministic failed\n';self.sha=m.digest(self.result)
        self.po=patch.object(m,'ORIGINAL',m.digest(self.original));self.po.start();self.r['unknown_receipt_sha256']=m.ORIGINAL
        self.pc=patch.object(m,'RAW_COMPOSE',m.digest(b'fixture compose'));self.pc.start()
        for rel,sha in list(self.r['control_pins'].items()):
            if sha is None:continue
            raw=(m.ATTEMPT+'\n').encode() if rel=='active' else b'fixture compose' if rel.endswith('/compose.json') else ('fixture '+rel).encode()
            self.write(rel,raw);self.r['control_pins'][rel]=m.digest(raw)
        self.write(m.ROOT+'/receipt.json',self.original);self.write(m.ROOT+'/unknown-receipt.json',self.original)
        self.write(m.ROOT+'/reconciliation/'+self.sha+'/result.json',self.result)
        (self.root/self.r['empty_ledger_relative']).mkdir(parents=True)
        self.owner=subprocess.Popen(['bash','-euo','pipefail','-c','exec 9>"$1/operation.lock"; flock -n 9; printf "READY\n"; read -r done','owner',str(self.root)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.assertEqual(self.owner.stdout.readline(),b'READY\n')
    def tearDown(self):
        if self.owner.stdin and not self.owner.stdin.closed:self.owner.stdin.write(b'done\n');self.owner.stdin.close()
        self.owner.wait(timeout=5);self.owner.stdout.close();self.owner.stderr.close();self.po.stop();self.pc.stop();self.temp.cleanup()
    def write(self,rel,raw):
        p=self.root/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
    def script(self,current=None):
        s=claim_script(Control(),m.ROOT,self.r,m.digest(self.original if current is None else current),phase='resume',publish_verified=False,result_sha256=self.sha)
        self.assertNotIn('rm /control/active',s);self.assertNotIn('rm -- /control/active',s)
        return s.replace('/control',str(self.root))
    def run_commit(self,script=None,sha=None):
        return subprocess.run(['bash','-euo','pipefail','-c',script or self.script()],input=('BEGIN\nCOMMIT '+(sha or self.sha)+'\n').encode(),capture_output=True,timeout=10)
    def test_publish_keeps_original_lease_and_log(self):
        result=self.run_commit();self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn(b'COMMITTED',result.stdout)
        for p in (m.ROOT+'/receipt.json','resume/current.json',m.ROOT+'/terminal.json'):self.assertEqual((self.root/p).read_bytes(),self.result)
        self.assertEqual((self.root/'active').read_bytes(),(m.ATTEMPT+'\n').encode());self.assertIsNone(self.owner.poll())
        self.assertEqual((self.root/(m.ROOT+'/unknown-receipt.json')).read_bytes(),self.original)
        self.assertFalse((self.root/'resume/verified.json').exists())
    def test_changed_cas_or_native_owner_fails(self):
        for rel in [m.BASE_ROOT+'/compose.json',m.ROOT+'/build.log',m.ABSENT[0]]:
            with self.subTest(rel=rel):
                path=self.root/rel;before=path.read_bytes() if path.exists() else None;self.write(rel,b'changed')
                result=self.run_commit();self.assertNotEqual(result.returncode,0);self.assertFalse((self.root/(m.ROOT+'/terminal.json')).exists())
                if before is None:path.unlink()
                else:path.write_bytes(before)
    def test_new_ledger_refuses(self):
        self.write(self.r['empty_ledger_relative']+'/reservation.json',b'new')
        self.assertNotEqual(self.run_commit().returncode,0);self.assertFalse((self.root/(m.ROOT+'/terminal.json')).exists())
    def test_missing_owner_lock_refuses(self):
        self.owner.stdin.write(b'done\n');self.owner.stdin.close();self.owner.wait(timeout=5)
        self.assertEqual(self.run_commit().returncode,72)
    def test_exact_partial_publication_resumes(self):
        self.write(m.ROOT+'/receipt.json',self.result);self.write('resume/current.json',self.result)
        result=self.run_commit(self.script(current=self.result));self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((self.root/(m.ROOT+'/terminal.json')).read_bytes(),self.result)
    def test_different_commit_hash_refused(self):
        self.assertNotEqual(self.run_commit(sha='7'*64).returncode,0)
        self.assertFalse((self.root/(m.ROOT+'/terminal.json')).exists())
    def test_eof_before_begin_does_not_publish(self):
        result=subprocess.run(['bash','-euo','pipefail','-c',self.script()],input=b'',capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr);self.assertFalse((self.root/(m.ROOT+'/terminal.json')).exists())

if __name__=='__main__':unittest.main()
