import copy,json,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
import docker_volume_recovery_failure_reconcile as failure
import docker_volume_reconcile as core
from docker_build_control import BuildControlError,canonical

LOG=b"backend-dev: phase=make state=complete exit_code=2 duration_ms=20\nbackend-dev: canonical Make target failed with exit code 2\n"
def actual():
    return {"State":{"Status":"exited","Running":False,"OOMKilled":False,"Dead":False,"Restarting":False,
        "ExitCode":2,"FinishedAt":"2026-10-28T18:18:00Z","Error":"","Pid":0,"Paused":False}}
def req():
    return {"failure":{"exit_code":2,"finished_at":"2026-10-28T18:18:00Z","log_sha256":core.digest(LOG)}}

class FailureTests(unittest.TestCase):
    def test_canonical_compile_failure(self): failure.validate_failure(actual(),req(),LOG)
    def test_admission_handoff_refused(self):
        for marker in ["phase=start state=handoff","phase=api state=exec","phase=gate state=complete","phase=start state=cache-hit"]:
            log=marker.encode()+b"\n"+LOG;r=req();r["failure"]["log_sha256"]=core.digest(log)
            with self.subTest(marker=marker),self.assertRaises(BuildControlError): failure.validate_failure(actual(),r,log)
    def test_nonterminal_oom_restart_foreign_finish_refused(self):
        for key,value in [("Status","running"),("Running",True),("OOMKilled",True),("Dead",True),("Restarting",True),("ExitCode",137),("FinishedAt","foreign"),("Error","daemon error"),("Pid",23),("Paused",True)]:
            row=actual();row["State"][key]=value
            with self.subTest(key=key),self.assertRaises(BuildControlError):failure.validate_failure(row,req(),LOG)
    def test_changed_or_noncanonical_log_refused(self):
        with self.assertRaises(BuildControlError): failure.validate_failure(actual(),req(),LOG+b"changed")
        log=b"compiler error";r=req();r["failure"]["log_sha256"]=core.digest(log)
        with self.assertRaises(BuildControlError):failure.validate_failure(actual(),r,log)
    def test_unchanged_history_and_storage(self):
        value={k:{"pin":"original"} for k in ("authorization_pins","raw_records","storage_proof","retained_terminal_runs","retained_held_manual_runs","retained_attempt_histories","docker_engine_id_sha256","network")}
        value["containers"]={"backend":{"Id":"b"*64,"Image":"sha256:"+"a"*64,"Config":{},"HostConfig":{},"Mounts":[]},"frontend":{"pin":"original"}}
        failure.unchanged(value,copy.deepcopy(value))
        for key in list(value)[:-1]:
            changed=copy.deepcopy(value);changed[key]={"pin":"other"}
            with self.subTest(key=key),self.assertRaises(BuildControlError):failure.unchanged(value,changed)
        changed=copy.deepcopy(value);changed["containers"]["frontend"]={}
        with self.assertRaises(BuildControlError):failure.unchanged(value,changed)

class CommitTests(unittest.TestCase):
    def setup_case(self, directory):
        root=Path(directory); attempt="a"*32;relative="recovery-build/attempts/"+attempt
        path=root/relative;path.mkdir(parents=True)
        raw=canonical({"state":"outcome-unknown-resources-retained"})
        result=canonical({"state":"failed-confirmed","runtime_started":False})
        verified=b'{"state":"succeeded","preserved":true}'
        (root/"active").write_text(attempt)
        (path/"receipt.json").write_bytes(raw);(path/"unknown-receipt.json").write_bytes(raw)
        (root/"recovery-build/verified.json").write_bytes(verified)
        journal=relative+"/reconciliation/"+core.digest(result);(root/journal).mkdir(parents=True)
        (root/journal/"result.json").write_bytes(result)
        request={"schema":failure.SCHEMA,"attempt":attempt,"unknown_receipt_sha256":core.digest(raw),
            "phase_current_sha256":None,"verified_sha256":core.digest(verified)}
        control=SimpleNamespace(path=lambda p:str(root/p))
        script=core.commit_script(control,relative,request,journal,core.digest(result),core.digest(raw),phase="recovery-build",publish_verified=False)
        # Rewrite only literal sandbox /control/active; no real daemon state is mounted here.
        script=script.replace('/control/active',str(root/'active'))
        return root,path,request,control,script,result,verified,relative,journal,raw
    def test_real_shell_publishes_failed_receipt_preserving_verified_active(self):
        with tempfile.TemporaryDirectory() as temp:
            root,path,request,control,script,result,verified,*_=self.setup_case(temp)
            run=subprocess.run(['bash','-euc',script],capture_output=True)
            self.assertEqual(run.returncode,0,run.stderr.decode())
            self.assertEqual((path/'terminal.json').read_bytes(),result)
            self.assertEqual((root/'recovery-build/current.json').read_bytes(),result)
            self.assertEqual((root/'recovery-build/verified.json').read_bytes(),verified)
            self.assertEqual((root/'active').read_text(),request['attempt'])
    def test_cas_change_refuses_without_terminal(self):
        for which in ['receipt','verified','active','current']:
            with self.subTest(which=which),tempfile.TemporaryDirectory() as temp:
                root,path,request,control,script,*_=self.setup_case(temp)
                target={'receipt':path/'receipt.json','verified':root/'recovery-build/verified.json','active':root/'active','current':root/'recovery-build/current.json'}[which]
                target.write_text('changed')
                run=subprocess.run(['bash','-euc',script],capture_output=True)
                self.assertNotEqual(run.returncode,0)
                self.assertFalse((path/'terminal.json').exists())
    def test_wrong_schema_or_success_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            root,path,request,control,script,result,verified,relative,journal,raw=self.setup_case(temp)
            for schema,publish in [(failure.SCHEMA,True),('unknown',False)]:
                request['schema']=schema
                with self.assertRaises(BuildControlError):
                    core.commit_script(control,relative,request,journal,core.digest(result),core.digest(raw),phase='recovery-build',publish_verified=publish)
    def test_partial_terminal_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root,path,request,control,script,*_=self.setup_case(temp)
            (path/'terminal.json').write_text('existing')
            run=subprocess.run(['bash','-euc',script],capture_output=True)
            self.assertNotEqual(run.returncode,0)
            self.assertEqual((path/'terminal.json').read_text(),'existing')



from unittest.mock import patch

class HelperTests(unittest.TestCase):
    def fixture(self):
        project='fullmag-master';attempt='a'*32
        owner={'phase':'recovery-build','state':'outcome-unknown-resources-retained','attempt':attempt,
               'compose_project':project,'control_volume':'control','helper_container':'fullmag-control-'+attempt}
        raw=canonical(owner)
        lease={'Id':'b'*64,'Name':'/'+owner['helper_container'],'Image':'sha256:'+'c'*64,
            'State':{'Running':True,'StartedAt':'2026-10-28T18:07:00Z'},
            'Config':{'User':'65532:65532','Labels':{'com.docker.compose.project':project,'com.docker.compose.service':'build-control'},'Entrypoint':['/bin/bash'],'Cmd':['-euo','pipefail','-c','original-operation']},
            'HostConfig':{'NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False},
            'Mounts':[{'Type':'volume','Destination':'/control','Name':'control','RW':True}]}
        pin={'id':lease['Id'],'image':lease['Image'],'started_at':lease['State']['StartedAt'],'fingerprint':core.fingerprint(lease)}
        request={'schema':failure.SCHEMA,'attempt':attempt,'compose_project':project,'source_root':'/selected','port':3203,
            'unknown_receipt_sha256':core.digest(raw),'containers':{'lease':pin,'backend':dict(pin,id='d'*64),'frontend':dict(pin,id='e'*64)},'failure':req()['failure'],'phase_current_sha256':None,'verified_sha256':None}
        for name in ['before_sha256','build_request_sha256','compose_sha256','previous_sha256','controller_sha256','reconciler_sha256','recovery_controller_sha256']:request[name]='f'*64
        control=SimpleNamespace(project=project,volume='control',image=lease['Image'],operation_script=lambda *a:'original-operation',path=lambda p:'/fixture/'+p)
        return control,request,raw,lease
    def run_fixture(self,control,request,raw,lease,observer=None):
        def capture(*args):
            if args[:2]==('image','inspect'): return SimpleNamespace(stdout=json.dumps([{'Id':control.image}]).encode())
            return SimpleNamespace(stdout=json.dumps([observer]).encode())
        with patch.object(failure,'read_raw',return_value=raw),patch.object(failure,'inspect_pins',return_value={'lease':lease}),patch.object(failure,'docker_capture',side_effect=capture):
            return failure.authenticated_control_helpers(control,{'request':request,'observer':observer})
    def test_only_exact_original_lease_permitted(self):
        control,request,raw,lease=self.fixture()
        self.assertEqual(self.run_fixture(control,request,raw,lease),{lease['Id']})
    def test_changed_command_user_mount_or_privilege_refused(self):
        changes=[lambda x:x['Config'].update(Cmd=['sleep','infinity']),lambda x:x['Config'].update(User='root'),lambda x:x['Mounts'].append({'Type':'bind','Source':'/state','Destination':'/state','RW':True}),lambda x:x['HostConfig'].update(Privileged=True)]
        for change in changes:
            control,request,raw,lease=self.fixture();change(lease)
            with self.subTest(change=change),self.assertRaises(BuildControlError):self.run_fixture(control,request,raw,lease)
    def test_foreign_receipt_or_context_refused(self):
        control,request,raw,lease=self.fixture()
        with self.assertRaises(BuildControlError):self.run_fixture(control,request,raw+b' ',lease)
        with self.assertRaises(BuildControlError):failure.authenticated_control_helpers(control,{'request':request,'observer':None,'extra':[]})
    def test_exact_observer_and_no_other_command(self):
        control,request,raw,lease=self.fixture();observer=copy.deepcopy(lease)
        observer['Id']='1'*64;observer['Name']='/fullmag-recovery-failure-observer-'+'2'*32
        root='recovery-build/attempts/'+request['attempt']
        command=core.claim_script(control,root,request,core.digest(raw),phase='recovery-build',publish_verified=False)
        observer['Config']['Cmd']=['-euo','pipefail','-c',command]
        self.assertEqual(self.run_fixture(control,request,raw,lease,observer),{lease['Id'],observer['Id']})
        observer['Config']['Cmd']=['-euo','pipefail','-c','unrelated']
        with self.assertRaises(BuildControlError):self.run_fixture(control,request,raw,lease,observer)
    def test_request_unknown_fields_or_duplicate_containers_refused(self):
        control,request,raw,lease=self.fixture();failure.validate_request(request)
        request['extra']=True
        with self.assertRaises(BuildControlError):failure.validate_request(request)
        del request['extra'];request['containers']['backend']=request['containers']['lease']
        with self.assertRaises(BuildControlError):failure.validate_request(request)

if __name__=='__main__':unittest.main()
