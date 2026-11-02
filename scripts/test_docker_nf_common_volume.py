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

    def test_group_volume_preserves_package_and_boris_prefix_subpaths(self):
        cache = dict(group_volume="selected-control", build_subpath="private/backend",
            shared_packages=True, shared_package_subpath="groups/"+"1"*64,
            volume_names=dict(build="selected-control", package="shared-packages"))
        for role, case in (("boris", "r0"), ("fullmag", None), ("compare", None)):
            with self.subTest(role=role):
                value = q.specification(binding(), "selected-control", cache,
                    "nf-scientific/attempts/"+RUN+"/qualification", Path("/owned/export"), role, case)
                package = next(m for m in value["mounts"] if m["target"] == "/package")
                self.assertEqual(package["subpath"], cache["shared_package_subpath"])
                if role == "boris":
                    prefix = next(m for m in value["mounts"] if m["target"] == "/opt/fullmag-boris")
                    self.assertEqual(prefix["subpath"], "private/backend/external-reference-boris/"+
                        binding()["producer_attempt"]+"/prefix")
                q.attest(observed(value), value, RUN, 0)
                self.assertTrue(all(m["readonly"] for m in value["mounts"] if m["kind"] == "volume"))

    def test_private_cache_requires_explicit_safe_subpaths(self):
        for field in ("build_subpath", "shared_package_subpath"):
            for bad in (None, "", "../escape", "/root", "a//b", "a,readonly"):
                with self.subTest(field=field, bad=bad), self.assertRaises(q.BuildControlError):
                    cache = dict(group_volume="group", build_subpath="private/backend", shared_packages=True,
                        shared_package_subpath="groups/"+"1"*64,
                        volume_names=dict(build="group", package="packages"))
                    cache[field] = bad
                    q.specification(binding(), "control", cache, "nf/qualification", Path("/owned/export"), "boris", "r0")

    def test_copy_retains_backend_subpath_and_readonly_access(self):
        control = SimpleNamespace(helper_args=lambda script, **kwargs:
            ["docker", "run", "--entrypoint", "sh", "helper", "-c", script])
        for subpath in ("", "private/backend", "task/private/backend"):
            cache = dict(volume_names=dict(build="selected-build"))
            if subpath:
                cache.update(group_volume="selected-build", build_subpath=subpath)
            with self.subTest(subpath=subpath):
                argv = q.copy_args(control, "fixed-copy", RUN, cache)
                self.assertEqual(argv[argv.index("--mount")+1],
                    "type=volume,src=selected-build,dst=/build,readonly,volume-nocopy" +
                    (",volume-subpath="+subpath if subpath else ""))
                self.assertEqual(argv[argv.index("--entrypoint"):], ["--entrypoint", "sh", "helper", "-c", "fixed-copy"])

    def test_copy_refuses_missing_or_unsafe_private_subpath(self):
        for subpath in (None, "", "../escape", "/private/backend", "a//b", "a,readonly"):
            with self.subTest(subpath=subpath), self.assertRaises(q.BuildControlError):
                q.copy_args(SimpleNamespace(), "fixed-copy", RUN, dict(group_volume="selected-build",
                    volume_names=dict(build="selected-build"), build_subpath=subpath))

    def test_cpu_compatibility_path_keeps_roles_device_denied(self):
        for role in ("boris", "fullmag", "compare"):
            with self.subTest(role=role):
                value = spec(role)
                paths = value["environment"]["LD_LIBRARY_PATH"].split(":")
                self.assertEqual("/usr/local/cuda/compat" in paths, role == "fullmag")
                self.assertEqual(value["environment"]["NVIDIA_VISIBLE_DEVICES"], "void")
                self.assertEqual(value["environment"]["NVIDIA_DRIVER_CAPABILITIES"], "")
                argv = q.create_args(value, RUN, 0)
                self.assertEqual(argv[argv.index("--runtime")+1], "runc")
                self.assertNotIn("--gpus", argv)
                self.assertNotIn("--device", argv)
                q.attest(observed(value), value, RUN, 0)

    def test_fullmag_cpu_attestation_rejects_device_or_loader_drift(self):
        value = spec("fullmag")
        for key, changed in (("Runtime", "nvidia"), ("DeviceRequests", [{"Count": -1}]),
                             ("Devices", [{"PathOnHost": "/dev/dxg"}])):
            with self.subTest(key=key), self.assertRaises(q.BuildControlError):
                actual = observed(value)
                actual["HostConfig"][key] = changed
                q.attest(actual, value, RUN, 0)
        actual = observed(value)
        actual["Config"]["Env"] = ["LD_LIBRARY_PATH=/foreign" if entry.startswith("LD_LIBRARY_PATH=")
            else entry for entry in actual["Config"]["Env"]]
        with self.assertRaises(q.BuildControlError):
            q.attest(actual, value, RUN, 0)

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

    def test_wsl_export_alias_requires_exact_inode_identity(self):
        s=spec();selected=Path("/registered/scientific/output")
        s["mounts"][-1]["source"]=str(selected)
        v=observed(s);token="4"*64
        alias="/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/"+token
        next(m for m in v["Mounts"] if m["Destination"]=="/export")["Source"]=alias
        with patch.object(Path,"is_dir",return_value=True),patch.object(Path,"samefile",autospec=True,return_value=True) as samefile:
            q.attest(v,s,RUN,0)
            samefile.assert_called_once_with(Path("/mnt/wsl/docker-desktop-bind-mounts/Ubuntu")/token,selected)
        with patch.object(Path,"is_dir",return_value=True),patch.object(Path,"samefile",return_value=False):
            with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)
        with patch.object(Path,"is_dir",return_value=False),patch.object(Path,"samefile") as samefile:
            with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)
            samefile.assert_not_called()

    def test_wsl_export_alias_rejects_prefix_and_traversal_without_inode_access(self):
        s=spec();s["mounts"][-1]["source"]="/registered/scientific/output"
        prefix="/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/"
        for alias in (prefix,prefix+"g"*64,prefix+"../"+"4"*64,"/foreign/"+"4"*64):
            with self.subTest(alias=alias):
                v=observed(s)
                next(m for m in v["Mounts"] if m["Destination"]=="/export")["Source"]=alias
                with patch.object(Path,"is_dir",return_value=True),patch.object(Path,"samefile") as samefile:
                    with self.assertRaises(q.BuildControlError):q.attest(v,s,RUN,0)
                    samefile.assert_not_called()

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
            write=write,_line=Mock(side_effect=["READY","LOGGED"]),
            _pin_operation_helper=Mock(return_value=CID),_active_operation=None)
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





class IsolatedWorkerImportBoundary(unittest.TestCase):
    def entrypoint(self, source_name, role, *, host_import=False):
        import ast
        import json
        import shutil
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            if source_name=='docker_nf_common_volume.original.py':
                source=Path(q.__file__).read_text()
                eager=next(node for node in ast.walk(ast.parse(source))
                    if isinstance(node,ast.ImportFrom) and node.module=='docker_build_control')
                (root/'docker_nf_common_volume.py').write_text(ast.get_source_segment(source,eager)+'\n')
            else:
                shutil.copyfile(Path(q.__file__),root/'docker_nf_common_volume.py')
            shutil.copyfile(Path(sys.modules['docker_build_control'].__file__),root/'docker_build_control.py')
            code=r"""import importlib.util,json,runpy,sys
root,role,host_import=sys.argv[1:]
sys.path.insert(0,root)
assert importlib.util.find_spec('docker_dev_host') is None
path=root+'/docker_nf_common_volume.py'
sys.argv=[path,role]
class WorkerEntered(BaseException): pass
def profile(frame,event,arg):
 if event=='call' and frame.f_code.co_name in ('_boris','_fullmag','_compare') and frame.f_globals.get('__name__')=='__main__':
  sys.setprofile(None)
  assert frame.f_code.co_name==role
  assert 'docker_build_control' not in sys.modules
  assert 'docker_dev_host' not in sys.modules
  value={'a':'µ','nested':[1,True,None]}
  assert frame.f_globals['canonical'](value)==json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')
  frame.f_globals['require'](True,'valid')
  try:frame.f_globals['require'](False,'worker validation remains enforced')
  except RuntimeError as error:assert str(error)=='N/F volume qualification: worker validation remains enforced'
  else:raise AssertionError('worker validation was bypassed')
  print(json.dumps({'entered':role,'host_imported':False,'solver_started':False}))
  raise WorkerEntered()
if host_import=='no':sys.setprofile(profile)
try:
 runpy.run_path(path,run_name='dependency_probe' if host_import=='yes' else '__main__')
except WorkerEntered:pass
"""
            result=subprocess.run([sys.executable,'-I','-S','-B','-c',code,str(root),role,'yes' if host_import else 'no'],
                capture_output=True,text=True,timeout=15)
            return result

    def test_eager_host_import_reproduces_missing_host_module_before_worker_dispatch(self):
        result=self.entrypoint('docker_nf_common_volume.original.py','_boris')
        self.assertNotEqual(result.returncode,0)
        self.assertIn("ModuleNotFoundError: No module named 'docker_dev_host'",result.stderr)
        self.assertEqual(result.stdout,'')

    def test_each_exact_worker_reaches_dispatch_without_host_modules_or_solver(self):
        import json
        for role in ('_boris','_fullmag','_compare'):
            with self.subTest(role=role):
                result=self.entrypoint('docker_nf_common_volume.py',role)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(json.loads(result.stdout),dict(entered=role,host_imported=False,solver_started=False))

    def test_host_import_keeps_existing_host_dependency_boundary(self):
        result=self.entrypoint('docker_nf_common_volume.py','_boris',host_import=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn("ModuleNotFoundError: No module named 'docker_dev_host'",result.stderr)
        self.assertEqual(result.stdout,'')


if __name__=="__main__":unittest.main()
