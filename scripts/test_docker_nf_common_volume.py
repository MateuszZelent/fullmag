"""Pure/mocked qualification-contract regressions; never runs Docker or solvers."""
from copy import deepcopy
from pathlib import Path
from types import MethodType, SimpleNamespace
import unittest
from unittest.mock import patch
import docker_nf_common_volume as q

RUN = "a"*32
CID = "b"*64


def binding():
    return dict(schema=q.SCHEMA, compose_project="fullmag-worktree-test", image_id="sha256:"+"c"*64,
        producer_attempt="d"*32, producer_receipt_sha256="e"*64, prefix_receipt_sha256="f"*64,
        boris_build_proof={"binary_sha256":"1"*64}, boris_outputs={"source_manifest.json":"2"*64})


def spec(role="boris", case="r0"):
    return q.specification(binding(), "selected-control", {"volume_names":{"build":"selected-build", "package":"selected-package"}},
        "nf-scientific/attempts/"+RUN+"/qualification", Path("D:/scientific/owned"), role, case if role=="boris" else None)


def observed(s, status="exited", code=0):
    state = dict(Status=status, Running=status=="running", ExitCode=code, OOMKilled=False, Error="", StartedAt="same-incarnation")
    mounts=[]; requests=[]
    for m in s["mounts"]:
        found=dict(Destination=m["target"], Type=m["kind"], RW=not m["readonly"], Source=m["source"])
        if m["kind"]=="volume":
            found["Name"]=m["source"]
            requests.append(dict(Target=m["target"], Source=m["source"], VolumeOptions={"Subpath":m["subpath"], "NoCopy":True}))
        mounts.append(found)
    return dict(Id=CID, Image=s["image"], State=state,
        Config=dict(Entrypoint=s["command"][:1], Cmd=s["command"][1:], User="65532:65532", WorkingDir="/tmp",
            Healthcheck={"Test":["NONE"]}, Env=[k+"="+v for k,v in s["environment"].items()], Labels={
                "com.docker.compose.project":s["project"], "com.docker.compose.service":"nf-common-scientific",
                "org.fullmag.scientific.attempt":RUN, "org.fullmag.scientific.ordinal":"0"}),
        Mounts=mounts, HostConfig=dict(Memory=q.MEMORY, MemorySwap=q.MEMORY, NanoCpus=q.CPU, PidsLimit=q.PIDS,
            ReadonlyRootfs=True, Privileged=False, NetworkMode="none", Runtime="runc", Init=True, CapDrop=["ALL"],
            CapAdd=[], SecurityOpt=["no-new-privileges:true"], Tmpfs=s["tmpfs"], Mounts=requests,
            LogConfig={"Type":"local", "Config":{"max-size":"8m", "max-file":"1", "compress":"false"}}))


class Control:
    def __init__(self):self.writes=[]
    def write(self,*args):self.writes.append(args)
    def write_bytes(self,*args):self.writes.append(args)


class QualificationContract(unittest.TestCase):
    def test_five_fixed_roles_keep_same_group_image_and_caps(self):
        for role,case in (("boris","r0"),("boris","r1"),("boris","r2"),("fullmag",None),("compare",None)):
            s=spec(role,case);args=q.create_args(s,RUN,0)
            self.assertEqual(s["image"],binding()["image_id"])
            self.assertIn("com.docker.compose.project="+binding()["compose_project"],args)
            self.assertEqual(args[args.index("--memory")+1],str(2<<30))
            self.assertEqual(args[args.index("--cpus")+1],"2")
            self.assertEqual(args[args.index("--pids-limit")+1],"128")
            self.assertIn("--no-healthcheck",args)
            self.assertEqual(s["command"][:4],["/usr/bin/timeout","--signal=TERM","--kill-after=10",str(s["timeout_seconds"])])
            self.assertEqual(s["timeout_seconds"],2100 if role=="fullmag" else 240)
            self.assertTrue(all(m["readonly"] for m in s["mounts"] if m["kind"]=="volume"))
            self.assertEqual([m["target"] for m in s["mounts"] if not m["readonly"]],["/export"])

    def test_single_file_logging_explicitly_disables_default_compression(self):
        s=spec();args=q.create_args(s,RUN,0)
        self.assertEqual([args[i+1] for i,value in enumerate(args) if value=="--log-opt"],
                         ["max-size=8m","max-file=1","compress=false"])
        for value in (None,"true"):
            v=observed(s);options=v["HostConfig"]["LogConfig"]["Config"]
            if value is None:options.pop("compress")
            else:options["compress"]=value
            with self.subTest(compress=value),self.assertRaises(q.BuildControlError):
                q.attest(v,s,RUN,0)

    def test_attestation_accepts_only_exact_spec_and_mount_order_independent(self):
        s=spec();v=observed(s);q.attest(v,s,RUN,0)
        v["Mounts"].reverse();q.attest(v,s,RUN,0)

    def test_attestation_rejects_caps_command_owner_and_subpath_drift(self):
        s=spec();base=observed(s)
        changes=[("HostConfig","Memory",q.MEMORY+1),("HostConfig","MemorySwap",-1),("HostConfig","NanoCpus",1),
            ("HostConfig","PidsLimit",129),("HostConfig","Runtime","nvidia"),("HostConfig","NetworkMode","bridge"),
            ("HostConfig","Privileged",True),("HostConfig","ReadonlyRootfs",False),("HostConfig","Init",False),
            ("Config","Cmd",["arbitrary"]),("Config","User","0:0")]
        for section,key,value in changes:
            with self.subTest(key=key):
                v=deepcopy(base);v[section][key]=value
                with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)
        v=deepcopy(base);v["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"]="foreign"
        with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)
        v=deepcopy(base);v["Config"]["Labels"]["org.fullmag.scientific.attempt"]="foreign"
        with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)

    def test_duplicate_env_and_extra_mount_refused(self):
        s=spec();v=observed(s);v["Config"]["Env"].append("LD_PRELOAD=foreign")
        with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)
        v=observed(s);v["Mounts"].append(dict(Destination="/socket",Type="bind",RW=True,Source="/var/run/docker.sock"))
        with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)

    def test_closed_role_and_mount_inputs_refused(self):
        for role in ("build","backend-build","anything"):
            with self.assertRaises(q.BuildControlError):spec(role,None)
        for key in (None,"coarse","r3"):
            with self.assertRaises(q.BuildControlError):spec("boris",key)
        for subpath in ("../escape","/root","a//b","a/./b"):
            with self.assertRaises(q.BuildControlError):q.volume("selected-build","/source",subpath)

    def exercise(self, values, *, create=CID, fail_start=False, clock=None):
        calls=[];control=Control();operation=dict(receipt={"attempt":RUN},root="nf-scientific/attempts/"+RUN,daemon_pending=False)
        def docker(*args,**kwargs):
            calls.append(args)
            if args[0]=="create":return SimpleNamespace(stdout=create.encode(),stderr=b"")
            if args[0]=="start" and fail_start:raise q.ControlOutcomeUnknown("lost client")
            return SimpleNamespace(stdout=b"bounded logs",stderr=b"")
        with patch.object(q,"docker_capture",side_effect=docker),patch.object(q,"inspect",side_effect=values),patch.object(q.time,"sleep"):
            if clock is None:
                try:q.run_container(control,operation,spec(),0)
                except BaseException as e:error=e
                else:error=None
            else:
                with patch.object(q.time,"monotonic",side_effect=clock):
                    try:q.run_container(control,operation,spec(),0)
                    except BaseException as e:error=e
                    else:error=None
        return operation,calls,error

    def test_success_requires_actual_exit_and_keeps_owned_receipt(self):
        s=spec();op,calls,error=self.exercise([observed(s,"created"),observed(s),observed(s)])
        self.assertIsNone(error);self.assertFalse(op["daemon_pending"])
        self.assertEqual(op["receipt"]["containers"][0]["cleanup"]["owned_id"],CID)
        self.assertTrue(q.SHA.fullmatch(op["receipt"]["containers"][0]["attestation_sha256"]))
        self.assertNotIn("stop",[v[0] for v in calls])

    def test_nonzero_and_oom_are_failures(self):
        s=spec()
        for state in (dict(ExitCode=2),dict(OOMKilled=True)):
            terminal=observed(s);terminal["State"].update(state)
            op,calls,error=self.exercise([observed(s,"created"),terminal,terminal])
            self.assertIsInstance(error,q.BuildControlError);self.assertFalse(op["daemon_pending"])

    def test_unknown_create_retains_exact_name_and_no_foreign_stop(self):
        op,calls,error=self.exercise([],create="lost-id")
        self.assertIsInstance(error,q.BuildControlError);self.assertTrue(op["daemon_pending"])
        self.assertEqual([v[0] for v in calls],["create"])
        self.assertEqual(op["receipt"]["containers"][0]["name"],"fullmag-nf-"+RUN+"-0")

    def test_lost_start_client_stops_only_attested_owned_container(self):
        s=spec();op,calls,error=self.exercise([observed(s,"created"),observed(s,"running"),observed(s)],fail_start=True)
        self.assertIsInstance(error,q.ControlOutcomeUnknown)
        self.assertEqual([v for v in calls if v[0]=="stop"],[("stop","--time","10",CID)])
        self.assertFalse(op["daemon_pending"])

    def test_deadline_has_exact_owned_cleanup(self):
        s=spec();op,calls,error=self.exercise([observed(s,"created"),observed(s,"running"),observed(s,"running"),observed(s)],clock=[0,1000])
        self.assertIsInstance(error,q.BuildControlError);self.assertFalse(op["daemon_pending"])
        self.assertEqual([v for v in calls if v[0]=="stop"],[("stop","--time","10",CID)])

    def test_cleanup_failure_never_claims_reaping_or_known_outcome(self):
        s=spec();op,calls,error=self.exercise([observed(s,"created"),observed(s),RuntimeError("inspect unknown")])
        self.assertIsInstance(error,q.ControlOutcomeUnknown);self.assertTrue(op["daemon_pending"])
        self.assertIn("cleanup_error",op["receipt"]["containers"][0])

    def test_new_identity_rejects_old_schema_and_missing_capacity(self):
        s=spec();v=observed(s)
        record=dict(spec=s,state="exited",exit_code=0,container_id=CID,attestation_sha256="3"*64,
            terminal_state=v["State"],cleanup=dict(owned_id=CID,state=v["State"]))
        value=q.scientific_identity(binding(),RUN,"r0",record,{})
        self.assertEqual(value["schema_version"],q.IDENTITY);self.assertIs(value["physics_qualified"],False)
        for key,value in (("state","created"),("exit_code",False),("attestation_sha256","")):
            bad=deepcopy(record);bad[key]=value
            with self.assertRaises(q.BuildControlError):q.scientific_identity(binding(),RUN,"r0",bad,{})
        bad=binding();bad["schema"]="fullmag.boris.runtime.v4"
        with self.assertRaises(q.BuildControlError):q.scientific_identity(bad,RUN,"r0",record,{})


    def test_before_after_source_probe_tokens_follow_existing_guard(self):
        import ast,inspect
        import docker_dev_codegen as codegen
        implementation=ast.parse(inspect.getsource(q.run))
        calls=[node for node in ast.walk(implementation) if isinstance(node,ast.Call)
               and isinstance(node.func,ast.Name) and node.func.id=="_probe_source"]
        self.assertEqual(len(calls),2)
        protocol=ast.parse(codegen.SOURCE_PROBE_SCRIPT)
        assign=next(node for node in protocol.body if isinstance(node,ast.Assign)
                    and any(isinstance(t,ast.Name) and t.id=="token" for t in node.targets))
        guard=next(node for node in protocol.body if isinstance(node,ast.If)
                   and any(isinstance(n,ast.Constant) and n.value=="invalid source probe token" for n in ast.walk(node)))
        validation=compile(ast.Module(body=[assign,guard],type_ignores=[]),"actual-source-probe-token-guard","exec")
        for call in calls:
            token=eval(compile(ast.Expression(call.args[1]),"actual-probe-call-token","eval"),
                       {"operation":{"receipt":{"attempt":RUN}}})
            with self.subTest(token=token):
                exec(validation,{"sys":SimpleNamespace(argv=["source-probe",token])})

    def test_actual_probe_preserves_binary64_binding_and_prefix_versions(self):
        from local_runner import boris_cpu as boris
        native=binding();proof=native["boris_build_proof"]
        proof.update(capsule_digest="4"*64, compile_flags_sha256="5"*64, cuda_flags_sha256="6"*64)
        baseline=dict(python="3.10.12 pinned", numpy="2.2.6", private_modules=[dict(name="matplotlib",version="3.7.5")])
        probe=dict(binary_sha256=proof["binary_sha256"], binary_version="BORIS pinned", external_python_version=baseline["python"],
            embedded_python_version="3.10.12 embedded", solver_exit_code=0, solver_exit_protocol="fixed", device="cpu",
            precision_abi=boris.abi_binding(dict(job_id=native["producer_attempt"],source_digest=proof["capsule_digest"],
                image_digest=native["image_id"]),proof["compile_flags_sha256"],proof["cuda_flags_sha256"],boris.ABI_FACTS),
            numpy_version=baseline["numpy"],matplotlib_version="3.7.5")
        q.verify_probe(native,probe,baseline)
        for key,value in (("binary_sha256","7"*64),("device","cuda"),("precision_abi",{}),
            ("external_python_version","3.14 other"),("numpy_version","wrong"),("matplotlib_version","wrong")):
            changed=deepcopy(probe);changed[key]=value
            with self.subTest(key=key),self.assertRaises(q.BuildControlError):q.verify_probe(native,changed,baseline)
        changed=deepcopy(probe);changed["arbitrary"]=True
        with self.assertRaises(q.BuildControlError):q.verify_probe(native,changed,baseline)



class CopyHelperLeaseRegression(unittest.TestCase):
    def operation(self):
        from io import BytesIO
        from unittest.mock import Mock
        writes=[]
        def write(path,value):writes.append((path,deepcopy(value)))
        control=SimpleNamespace(project="selected",volume="selected-control",namespace=None,path=q.BuildControl.path,
            helper_args=lambda *a,**kw:["not-executed"],space=lambda:dict(available_bytes=64<<30),
            write=write,_line=Mock(side_effect=["READY","LOGGED"]))
        control.operation_script=MethodType(q.BuildControl.operation_script,control)
        logger=SimpleNamespace(stdin=BytesIO(),wait=Mock(return_value=0))
        return control,logger,writes

    def dispatch(self, control, operation):
        name="fullmag-nf-copy-"+operation["receipt"]["attempt"]
        q.dispatch_copy(control,operation,["docker","run","--rm","--name",name,"fixed-image","fixed-copy"],
                        dict(source="/build/exact",target="/control/exact",outputs={"BorisLin":"1"*64}))

    def test_nonzero_client_live_daemon_cannot_finalize_or_release_operation(self):
        control,logger,writes=self.operation()
        daemon=dict(still_running=True)
        with patch("docker_build_control.subprocess.Popen",return_value=logger),patch.object(q,"bounded_capture",
                return_value=SimpleNamespace(returncode=1,stdout=b"",stderr=b"lost attached client")):
            with self.assertRaises(q.ControlOutcomeUnknown):
                with q.BuildControl.operation(control,"nf-scientific",{}) as operation:
                    self.dispatch(control,operation)
        self.assertTrue(daemon["still_running"])
        self.assertTrue(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["state"],"outcome-unknown-resources-retained")
        self.assertEqual(operation["receipt"]["copy_helper"]["name"],"fullmag-nf-copy-"+operation["receipt"]["attempt"])
        self.assertEqual(operation["receipt"]["copy_helper"]["client_exit_code"],1)
        self.assertTrue(any(v.get("copy_helper",{}).get("state")=="prepared" for _,v in writes))
        self.assertFalse(any(path.endswith("/terminal.json") for path,_ in writes))
        logger.wait.assert_not_called();self.assertEqual(control._line.call_count,1)

    def test_success_ack_is_persisted_before_pending_clears(self):
        control,logger,writes=self.operation()
        with patch("docker_build_control.subprocess.Popen",return_value=logger),patch.object(q,"bounded_capture",
                return_value=SimpleNamespace(returncode=0,stdout=b"",stderr=b"")):
            with q.BuildControl.operation(control,"nf-scientific",{}) as operation:
                self.dispatch(control,operation)
                self.assertFalse(operation["daemon_pending"])
                self.assertEqual(writes[-1][1]["copy_helper"]["terminal_proof"],"attached-docker-run-exit0")
                operation["receipt"]["state"]="succeeded"
        self.assertTrue(any(path.endswith("/terminal.json") for path,_ in writes))
        logger.wait.assert_called_once();self.assertEqual(control._line.call_count,2)

    def test_plain_observation_error_is_also_unknown_not_confirmed(self):
        control,logger,writes=self.operation()
        with patch("docker_build_control.subprocess.Popen",return_value=logger),patch.object(q,"bounded_capture",side_effect=OSError("client failed")):
            with self.assertRaises(q.ControlOutcomeUnknown):
                with q.BuildControl.operation(control,"nf-scientific",{}) as operation:
                    self.dispatch(control,operation)
        self.assertTrue(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["state"],"outcome-unknown-resources-retained")
        self.assertFalse(any(path.endswith("/terminal.json") for path,_ in writes))
        logger.wait.assert_not_called()



if __name__=="__main__":unittest.main()
