"""Interpreted BORIS managed provenance guards; never native execution or Docker."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import run_managed_boris_nf as m
from run_boris_nf_interface import validate_runtime_identity

class ManagedBorisTests(unittest.TestCase):
    def test_strict_json_bounds_keys_and_nonfinite(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"receipt.json"
            for raw in (b'{"x":1,"x":2}',b'{"x":NaN}',b'[]',b'x'*4097,b''):
                with self.subTest(raw=raw[:20]):
                    path.write_bytes(raw)
                    with self.assertRaises(ValueError):m.read_json(path,4096)
            path.write_bytes(b'{"x":1}');self.assertEqual(m.read_json(path),{"x":1})

    def test_linked_proof_file_refused_without_read(self):
        with patch.object(m.storage,"is_link",return_value=True),self.assertRaises(ValueError):
            m.read_json(Path("foreign-link"))

    def test_fixed_input_and_cpu_spec_reject_arbitrary_resolution_or_image(self):
        for resolution in m.RESOLUTIONS:
            config,script,scenario=m.fixed_inputs(resolution)
            self.assertEqual(config.transport_tolerance,1e-5);self.assertEqual(config.transport_max_iterations,200)
            self.assertIn(b"BORIS_EMBEDDED_IDENTITY:",script)
            self.assertEqual(json.loads(scenario)["workload"],"N/F")
        with self.assertRaises(ValueError):m.fixed_inputs("arbitrary")
        with self.assertRaises(ValueError):m.scientific_spec("ubuntu:latest",*[Path("x")]*4)
        spec=m.scientific_spec("sha256:"+"a"*64,*[Path("x")]*4)["services"]["boris"]
        self.assertEqual(spec["network_mode"],"none");self.assertNotIn("ports",spec)
        self.assertEqual(spec["command"],["python3","-B","/source/scripts/run_managed_boris_nf.py","_worker"])
        self.assertNotIn("gpus",spec);self.assertEqual(spec["environment"]["LD_PRELOAD"],"")

    def build_fixture(self,temp):
        base=Path(temp);job_id="a"*32;root=base/"runs/wt"/job_id
        (root/"trusted").mkdir(parents=True);(root/"artifacts/outputs/boris").mkdir(parents=True)
        native={"head_commit_full":"b"*40,"source_snapshot_sha256":"c"*64,"source_snapshot_dirty":False}
        job=dict(job_id=job_id,owner="alice",operation="build",profile=m.boris.PROFILE,state="succeeded",exit_code=0,
                 worktree_id="wt",source_digest="d"*64,payload=dict(native_source_identity=native,capture_id="e"*32,capsule_relative="runs/wt/"+"e"*32+"/source"))
        context=dict(job_id=job_id,source_digest=job["source_digest"],profile=m.boris.PROFILE,image_digest="sha256:"+"f"*64,native_source_identity=native)
        for name in m.TRUSTED:
            (root/"trusted"/name).write_bytes(m.boris.canonical(context) if name=="context.json" else b"trusted synthetic file")
        journal=dict(context,owner="alice",phase="terminal",state="succeeded",exit_code=0,
                     trusted_hashes={n:m.digest(root/"trusted"/n) for n in m.TRUSTED})
        (root/"receipt.json").write_bytes(m.boris.canonical(journal))
        proof={"schema_version":"fullmag.boris.source.v2","qualification":"NOT VERIFIED"}
        (root/"artifacts/outputs/boris/source_manifest.json").write_bytes(m.boris.canonical(proof))
        (root/"artifacts/build-receipt.json").write_bytes(m.boris.canonical({"boris_build_proof":proof}))
        return base,root,job,journal,proof

    def resolve_fixture(self,args,job=None):
        base,root,original,journal,proof=args
        job=original if job is None else job
        with patch.object(m.storage,"resolve_layout",return_value={"storage_root":str(base),"runs_root":str(base/"runs/wt"),"worktree_id":"wt"}), \
             patch.object(m.getpass,"getuser",return_value="alice"),patch.object(m,"request",return_value=job) as api, \
             patch.object(m,"verify_source",return_value={}) as source, \
             patch.object(m,"source_hashes",return_value={"fixed.py":"a"*64}), \
             patch.object(m,"validate_build_receipt",return_value={"boris_build_proof":proof}) as validator, \
             patch.object(m,"docker",side_effect=AssertionError("no Docker execution")):
            result=m.resolved_boris_build(base,original["job_id"])
            validator.assert_called_once_with(root/"artifacts",job,journal)
            self.assertEqual(api.call_count,2);source.assert_called_once()
            return result

    def test_resolver_reuses_real_receipt_validator_with_authenticated_job(self):
        with tempfile.TemporaryDirectory() as temp:
            args=self.build_fixture(temp);result=self.resolve_fixture(args)
            self.assertEqual(result[3]["actor"],"alice")
            self.assertEqual(set(result[3]["trusted_hashes"]),m.TRUSTED)
            self.assertEqual(result[1],args[1]/"artifacts/outputs/boris")

    def test_reject_foreign_actor_nonterminal_profile_exit_or_context(self):
        for key,value in (("owner","bob"),("state","running"),("profile","fem-cpu-release"),("operation","arbitrary"),("worktree_id","foreign-wt"),("exit_code",False),("exit_code",1)):
            with self.subTest(key=key,value=value),tempfile.TemporaryDirectory() as temp:
                args=self.build_fixture(temp);job={**args[2],key:value}
                with self.assertRaises(ValueError):self.resolve_fixture(args,job)
        for case in ("trusted","missing_hash","image","context"):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temp:
                args=self.build_fixture(temp);root=args[1]
                if case=="trusted":(root/"trusted/boris_cpu.py").write_bytes(b"foreign")
                elif case=="context":
                    context=m.read_json(root/"trusted/context.json");context["source_digest"]="0"*64
                    (root/"trusted/context.json").write_bytes(m.boris.canonical(context))
                else:
                    journal=m.read_json(root/"receipt.json")
                    if case=="missing_hash":del journal["trusted_hashes"]["boris_cpu.py"]
                    else:journal["image_digest"]="sha256:"+"0"*64
                    (root/"receipt.json").write_bytes(m.boris.canonical(journal))
                with self.assertRaises(ValueError):self.resolve_fixture(args)

    def test_host_source_drift_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);repo=base/"repo";source=base/"source"
            for root in (repo,source):
                for name in m.SOURCE_FILES:
                    path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b"same")
            self.assertEqual(len(m.source_hashes(repo,source)),len(m.SOURCE_FILES))
            (repo/m.SOURCE_FILES[0]).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError,"differs from capsule"):m.source_hashes(repo,source)

    def inspect_fixture(self):
        spec=m.scientific_spec("sha256:"+"a"*64,*[Path("x")]*4);s=spec["services"]["boris"]
        observed=dict(Image=s["image"],Config=dict(Cmd=s["command"],Entrypoint=[],WorkingDir="/tmp",User="65532:65532",
            Labels={"com.docker.compose.project":"project","com.docker.compose.service":"boris"},Env=[k+"="+v for k,v in s["environment"].items()]),
            HostConfig=dict(Runtime="runc",NetworkMode="none",ReadonlyRootfs=True,Privileged=False,CapDrop=["ALL"],SecurityOpt=["no-new-privileges:true"],Memory=2*1024**3,NanoCpus=2*10**9,PidsLimit=128,Tmpfs={"/tmp":"rw,nosuid,nodev,size=256m"}),
            Mounts=[dict(Type="bind",Destination=x["target"],Source=x["source"],RW=not x["read_only"]) for x in s["volumes"]])
        return spec,observed

    def test_actual_attestation_rejects_command_gpu_ports_network_and_mutable_root(self):
        spec,observed=self.inspect_fixture()
        with patch.object(m,"docker",return_value=json.dumps([observed])):self.assertEqual(m.attest("id",spec,"project"),observed)
        for section,key,value in (("Config","Cmd",["arbitrary"]),("Config","User","root"),("HostConfig","DeviceRequests",[{}]),
                                  ("HostConfig","PortBindings",{"80":[{}]}),("HostConfig","NetworkMode","bridge"),("HostConfig","ReadonlyRootfs",False),("HostConfig","Runtime","nvidia")):
            with self.subTest(key=key):
                bad=copy.deepcopy(observed);bad[section][key]=value
                with patch.object(m,"docker",return_value=json.dumps([bad])),self.assertRaises(ValueError):m.attest("id",spec,"project")

    def test_output_membership_bounds_missing_and_foreign_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for name in m.RAW_OUTPUTS:(root/name).write_bytes(b"synthetic")
            self.assertEqual(len(m.output_closure(root)),len(m.RAW_OUTPUTS))
            (root/"foreign").write_bytes(b"x")
            with self.assertRaises(ValueError):m.output_closure(root)
            (root/"foreign").unlink();(root/m.RAW_OUTPUTS[0]).unlink()
            with self.assertRaises(ValueError):m.output_closure(root)

    def test_v2_without_explicit_context_refuses_and_legacy_stays_refused(self):
        with self.assertRaisesRegex(ValueError,"explicit trusted"):validate_runtime_identity({"schema_version":m.RUNTIME_SCHEMA,"identity_complete":True,"precision":"double"})
        with self.assertRaisesRegex(ValueError,"verified managed build proof"):validate_runtime_identity({"schema_version":"fullmag.boris.runtime.v1","identity_complete":True})
        with self.assertRaises(ValueError):m.identifier("../escape")
        with self.assertRaises(ValueError):m._worker()

    def test_public_v2_cannot_copy_foreign_directory_or_forge_complete(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)/"a";root.mkdir()
            receipt={"state":"runtime_succeeded_identity_verified"}
            with patch.object(m,"checked_run",return_value=(root,receipt,{})),patch.object(m,"verified_outputs",side_effect=AssertionError("must fail before output read")):
                with self.assertRaisesRegex(ValueError,"canonical"):m.verify_runtime_identity({"runtime_id":"a"*32},Path(temp),root/"foreign")

    def test_reobserve_terminal_bundle_is_verify_only_and_never_repairs(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/"export").mkdir();(root/"export/runtime.json").write_bytes(b'{"runtime_id":"synthetic"}')
            receipt={"state":"runtime_succeeded_identity_verified"}
            with patch.object(m.storage,"resolve_layout",return_value={}),patch.object(m,"runtime_root",return_value=root), \
                 patch.object(m,"checked_run",return_value=(root,receipt,{})), \
                 patch.object(m,"verify_runtime_identity",side_effect=ValueError("tampered bundle")), \
                 patch.object(m.storage,"atomic_json",side_effect=AssertionError("no repair writes")):
                with self.assertRaisesRegex(ValueError,"tampered bundle"):m.observe(Path(temp),"a"*32)

    def test_nonzero_oom_bool_and_unfinished_container_refused(self):
        base=dict(Status="exited",Running=False,ExitCode=0,OOMKilled=False,Error="")
        for key,value in (("Status","running"),("Running",True),("ExitCode",1),("ExitCode",143),("ExitCode",False),("OOMKilled",True)):
            with self.subTest(key=key),patch.object(m,"output_closure",side_effect=AssertionError("no output read")):
                with self.assertRaises(ValueError):m.verified_outputs(Path("x"),{},dict(State={**base,key:value}))

    def test_terminal_receipt_never_precedes_complete_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/"export").mkdir()
            receipt=dict(state="launched_resources_retained",build_job_id="a"*32,resolution="coarse",
                binding=dict(image_digest="sha256:"+"b"*64,source_manifest_sha256="c"*64,
                    boris_build_proof=dict(binary_sha256="d"*64)))
            m.storage.atomic_json(root/"receipt.json",receipt)
            probe=dict(binary_version="BORIS synthetic",embedded_python_version="synthetic")
            replace=m.os.replace
            def checked_replace(src,dst):
                if Path(dst)==root/"receipt.json" and m.read_json(src).get("state")=="runtime_succeeded_identity_verified":
                    self.assertTrue((root/"export/runtime.json").is_file(),"RED: succeeded receipt before runtime")
                    self.assertTrue((root/"export/summary.json").is_file(),"RED: succeeded receipt before summary")
                    self.assertEqual(m.read_json(root/"export/runtime.json")["runtime_receipt_sha256"],m.digest(src))
                return replace(src,dst)
            with patch.object(m.storage,"resolve_layout",return_value={}),patch.object(m,"runtime_root",return_value=root), \
                 patch.object(m,"checked_run",return_value=(root,receipt,{"State":{"Running":False,"Status":"exited"}})), \
                 patch.object(m,"verified_outputs",return_value=([],probe)), \
                 patch.object(m,"resolved_boris_build",return_value=(None,None,None,receipt["binding"])), \
                 patch.object(m,"attestation_digest",return_value="e"*64), \
                 patch('run_boris_nf_interface._artifact_summary',return_value={"synthetic":"algorithm-only"}), \
                 patch.object(m.os,"replace",side_effect=checked_replace):
                m.observe(Path(temp),"a"*32)
            self.assertEqual(m.read_json(root/"receipt.json")["state"],"runtime_succeeded_identity_verified")

    def test_crash_reentrant_and_postcommit_error_preserve_publication_state(self):
        for failure in ("interrupt","io","postcommit"):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as temp:
                root=Path(temp);(root/"export").mkdir()
                original=dict(state="launched_resources_retained",build_job_id="a"*32,resolution="coarse",
                    binding=dict(image_digest="sha256:"+"b"*64,source_manifest_sha256="c"*64,
                        boris_build_proof=dict(binary_sha256="d"*64)))
                m.storage.atomic_json(root/"receipt.json",original)
                probe=dict(binary_version="BORIS synthetic",embedded_python_version="synthetic")
                write=m.storage.atomic_json;commit=m.commit_receipt;reentered=[]
                def checked(*args):
                    return root,m.read_json(root/"receipt.json"),{"State":{"Running":False,"Status":"exited"}}
                def publish(path,data,**kwargs):
                    if Path(path)==root/"export/summary.json":
                        self.assertNotEqual(m.read_json(root/"receipt.json")["state"],"runtime_succeeded_identity_verified")
                        with self.assertRaisesRegex(m.storage.StorageError,"busy"):
                            m.observe(Path(temp),"a"*32)
                        reentered.append(True)
                        if failure=="interrupt":raise KeyboardInterrupt("publication crash")
                        if failure=="io":raise OSError("publication I/O")
                    return write(path,data,**kwargs)
                def terminal(root,raw):
                    commit(root,raw)
                    if failure=="postcommit":raise OSError("after terminal replace")
                with patch.object(m.storage,"resolve_layout",return_value={}),patch.object(m,"runtime_root",return_value=root), \
                     patch.object(m,"checked_run",side_effect=checked), \
                     patch.object(m,"verified_outputs",return_value=([],probe)), \
                     patch.object(m,"resolved_boris_build",return_value=(None,None,None,original["binding"])), \
                     patch.object(m,"attestation_digest",return_value="e"*64), \
                     patch('run_boris_nf_interface._artifact_summary',return_value={"synthetic":"algorithm-only"}), \
                     patch.object(m.storage,"atomic_json",side_effect=publish), \
                     patch.object(m,"commit_receipt",side_effect=terminal):
                    with self.assertRaises(KeyboardInterrupt if failure=="interrupt" else OSError):m.observe(Path(temp),"a"*32)
                self.assertEqual(reentered,[True])
                expected={"interrupt":"launched_resources_retained","io":"publication_failed_resources_retained","postcommit":"runtime_succeeded_identity_verified"}[failure]
                self.assertEqual(m.read_json(root/"receipt.json")["state"],expected)
                if failure in ("interrupt","io"):
                    with patch.object(m.storage,"resolve_layout",return_value={}),patch.object(m,"runtime_root",return_value=root), \
                         patch.object(m,"checked_run",side_effect=checked), \
                         patch.object(m,"verified_outputs",return_value=([],probe)), \
                         patch.object(m,"resolved_boris_build",return_value=(None,None,None,original["binding"])), \
                         patch.object(m,"attestation_digest",return_value="e"*64), \
                         patch('run_boris_nf_interface._artifact_summary',return_value={"synthetic":"algorithm-only"}):
                        m.observe(Path(temp),"a"*32)
                    final=m.read_json(root/"receipt.json")
                    self.assertEqual(final["state"],"runtime_succeeded_identity_verified")
                    self.assertNotIn("error",final)
                    self.assertEqual(m.read_json(root/"export/runtime.json")["runtime_receipt_sha256"],m.digest(root/"receipt.json"))
                if failure=="postcommit":
                    self.assertEqual(m.read_json(root/"export/runtime.json")["runtime_receipt_sha256"],m.digest(root/"receipt.json"))
                    self.assertTrue((root/"export/summary.json").is_file())

    def output_fixture(self,temp):
        root=Path(temp);export=root/"export";export.mkdir()
        for name in m.RAW_OUTPUTS:(export/name).write_bytes(b"pure synthetic fixture")
        binding=dict(source_digest="a"*64,image_digest="sha256:"+"b"*64,
            boris_build_proof=dict(binary_sha256="c"*64,compile_flags_sha256="d"*64,cuda_flags_sha256="e"*64))
        receipt=dict(binding=binding,build_job_id="f"*32,container_id="synthetic-container",resolution="coarse")
        abi=m.boris.abi_binding(dict(job_id=receipt["build_job_id"],source_digest=binding["source_digest"],image_digest=binding["image_digest"]),"d"*64,"e"*64,m.boris.ABI_FACTS)
        probe=dict(binary_sha256="c"*64,device="cpu",solver_exit_code=0,precision_abi=abi,
            binary_version="BORIS synthetic",external_python_version="synthetic",embedded_python_version="synthetic",
            numpy_version="synthetic",matplotlib_version="synthetic")
        (export/"runtime_probe.json").write_bytes(m.boris.canonical(probe))
        (export/"solver.stdout.log").write_bytes(b'BORIS_EMBEDDED_IDENTITY:{"python_version":"synthetic"}\nBORIS_NF_STAGE_COMPLETE\n')
        (export/"boris_native_samples.json").write_bytes(m.boris.canonical(dict(schema_version="fullmag.boris_she_nf.native.v1",stage_complete=True,scenario=json.loads(m.fixed_inputs("coarse")[2]))))
        observed=dict(State=dict(Status="exited",Running=False,ExitCode=0,OOMKilled=False,Error=""))
        return root,receipt,observed

    def test_pure_output_probe_and_container_manifest_chain(self):
        with tempfile.TemporaryDirectory() as temp:
            args=self.output_fixture(temp);entries=m.output_closure(args[0]/"export")
            logs=json.dumps(dict(schema="fullmag.boris.output_closure.v1",outputs=entries))
            with patch.object(m,"docker",return_value=logs):
                self.assertEqual(m.verified_outputs(*args)[0],entries)
            self.assertNotIn("identity_complete",args[1])

    def test_output_substitution_foreign_abi_scenario_marker_and_probe_refused(self):
        for case in ("output","binary","abi","scenario","marker","probe","duplicate_manifest"):
            with self.subTest(case=case),tempfile.TemporaryDirectory() as temp:
                args=self.output_fixture(temp);export=args[0]/"export";before=m.output_closure(export)
                if case=="output":(export/m.RAW_FIELDS[0]).write_bytes(b"tampered field")
                elif case in ("binary","abi","probe"):
                    probe=m.read_json(export/"runtime_probe.json")
                    if case=="binary":probe["binary_sha256"]="0"*64
                    elif case=="abi":probe["precision_abi"]["job_id"]="0"*32
                    else:del probe["embedded_python_version"]
                    (export/"runtime_probe.json").write_bytes(m.boris.canonical(probe))
                elif case=="scenario":
                    native=m.read_json(export/"boris_native_samples.json");native["scenario"]={}
                    (export/"boris_native_samples.json").write_bytes(m.boris.canonical(native))
                elif case=="marker":(export/"solver.stdout.log").write_bytes(b"missing")
                entries=before if case=="output" else m.output_closure(export)
                logs=json.dumps(dict(schema="fullmag.boris.output_closure.v1",outputs=entries))
                if case=="duplicate_manifest":logs+="\n"+logs
                with patch.object(m,"docker",return_value=logs),self.assertRaises(ValueError):m.verified_outputs(*args)

if __name__=="__main__":unittest.main()
