"""Interpreted V2 native/tools separation and spec guards; no solver or Docker."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import run_managed_boris_nf_v2 as m
import run_managed_boris_nf as old
import test_run_managed_boris_nf as old_tests


class BorisToolsV2Tests(unittest.TestCase):
    def test_spec_preserves_frozen_worker_isolation_and_explicit_support_mounts(self):
        paths = [Path("owned")]*4
        before = old.scientific_spec("sha256:"+"a"*64, *paths)
        after = m.scientific_spec("sha256:"+"a"*64, *paths)
        self.assertEqual(after["services"]["boris"]["environment"]["PYTHONPATH"],
                         "/source/scripts:/opt/fullmag-boris/source:/opt/fullmag-boris-python")
        mounts = after["services"]["boris"]["volumes"]
        self.assertNotIn("/boris", {v["target"] for v in mounts})
        self.assertEqual({v["target"] for v in mounts if v["target"].startswith("/boris/")},
                         {"/boris/"+name for name in (*m.boris.OUTPUTS,m.WRAPPER_MEMBER)})
        self.assertTrue(all(v["read_only"] for v in mounts if v["target"].startswith("/boris/")))
        after["services"]["boris"]["volumes"] = before["services"]["boris"]["volumes"]
        after["services"]["boris"]["environment"]["PYTHONPATH"] = before["services"]["boris"]["environment"]["PYTHONPATH"]
        self.assertEqual(after, before)
        with self.assertRaises(ValueError): m.scientific_spec("latest", *paths)

    def test_source_paths_are_unique_bounded_and_never_read_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); name = "scripts/a.py"; (root/"scripts").mkdir(); (root/name).write_bytes(b"a")
            self.assertEqual(len(m.tool_hashes(root, [name])), 1)
            for names in ([name,name], ["scripts/../a.py"], ["scripts/./a.py"], ["/scripts/a.py"], ["scripts/a.py:bad"], ["scripts\\a.py"]):
                with self.subTest(names=names),self.assertRaises(ValueError): m.tool_hashes(root, names)
            with patch.object(m.storage,"is_link",return_value=True),self.assertRaises(ValueError): m.tool_hashes(root,[name])
            (root/name).write_bytes(b"a"*33)
            with patch.object(m,"MAX_TOOL_BYTES",32),self.assertRaises(ValueError):m.tool_hashes(root,[name])

    def make_tools(self, base):
        repo=base/"repo"; root=base/"run"; root.mkdir()
        for name in m.TOOL_NAMES:
            path=repo/name; path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b"fixture identity only")
        return repo,root,m.capture_tools(repo,root)

    def test_every_captured_tool_drift_and_unknown_member_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            repo,root,receipt=self.make_tools(Path(temp))
            manifest=m.check_tools(repo,root,receipt)
            self.assertFalse(manifest["solver_capsule_attribution"])
            for name in manifest["files"]:
                with self.subTest(name=name):
                    path=root/"tools"/name; raw=path.read_bytes();path.write_bytes(raw+b"drift")
                    with self.assertRaises(ValueError):m.check_tools(repo,root,receipt)
                    path.write_bytes(raw)
            (root/"tools/foreign.py").write_bytes(b"foreign")
            with self.assertRaises(ValueError):m.check_tools(repo,root,receipt)

    def test_host_tool_drift_and_manifest_receipt_rebinding_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            repo,root,receipt=self.make_tools(Path(temp))
            path=repo/m.SOURCE_FILES[0];raw=path.read_bytes();path.write_bytes(raw+b"drift")
            with self.assertRaises(ValueError):m.check_tools(repo,root,receipt)
            path.write_bytes(raw)
            for manifest_change in ("schema","attribution","receipt"):
                manifest=m.read_json(root/"tools/manifest.json"); original=(root/"tools/manifest.json").read_bytes()
                changed=dict(receipt)
                if manifest_change=="schema":manifest["schema"]="fullmag.boris.managed_run.v1"
                elif manifest_change=="attribution":manifest["solver_capsule_attribution"]=True
                else:changed["tools_manifest_sha256"]="0"*64
                if manifest_change!="receipt":m.storage.atomic_json(root/"tools/manifest.json",manifest)
                with self.subTest(change=manifest_change),self.assertRaises(ValueError):m.check_tools(repo,root,changed)
                (root/"tools/manifest.json").write_bytes(original)

    def native(self, temp, *, alter=None):
        base,root,job,journal,proof=old_tests.ManagedBorisTests().build_fixture(temp)
        capsule=base/"capsule"; (capsule/"tree").mkdir(parents=True)
        for name in m.SOURCE_FILES:
            path=capsule/"tree"/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b"native original capsule")
        if alter:job={**job,**alter}
        with patch.object(m.storage,"resolve_layout",return_value={"storage_root":str(base),"runs_root":str(base/"runs/wt"),"worktree_id":"wt"}),patch.object(m.getpass,"getuser",return_value="alice"),patch.object(m,"request",return_value=job),patch.object(m,"capsule_path",return_value=capsule),patch.object(m,"verify_source",return_value={}) as source,patch.object(m,"validate_build_receipt",return_value={"boris_build_proof":proof}) as validator,patch.object(old,"source_hashes",side_effect=AssertionError("V2 must not use V1 host/capsule equality guard")):
            result=m.resolve_native_build(base,job["job_id"])
            source.assert_called_once_with(capsule,job["source_digest"])
            validator.assert_called_once_with(root/"artifacts",job,journal)
            self.assertEqual(result[3]["boris_build_proof"],proof)
            self.assertEqual(result[3]["source_digest"],job["source_digest"])
            return result

    def test_native_admission_uses_capsule_and_real_receipt_validator_not_old_host_guard(self):
        with tempfile.TemporaryDirectory() as temp:self.native(temp)
        for change in ({"owner":"foreign"},{"state":"running"},{"exit_code":False},{"worktree_id":"foreign"},{"operation":"arbitrary"}):
            with self.subTest(change=change),tempfile.TemporaryDirectory() as temp,self.assertRaises(ValueError):self.native(temp,alter=change)

    def test_old_guard_still_refuses_changed_host_and_no_v1_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            repo=Path(temp)/"repo";source=Path(temp)/"source"
            for root in (repo,source):
                for name in old.SOURCE_FILES:
                    p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(b"same")
            (repo/"scripts/run_boris_nf_interface.py").write_bytes(b"new public V3 dispatch")
            with self.assertRaises(ValueError):old.source_hashes(repo,source)
        with self.assertRaisesRegex(ValueError,"explicit trusted"):m.verify_runtime_identity({"schema_version":"fullmag.boris.runtime.v2"},None,None)

    def test_attestation_requires_exact_id_and_corrected_environment(self):
        spec,observed=old_tests.ManagedBorisTests().inspect_fixture();spec=m.scientific_spec("sha256:"+"a"*64,*[Path("x")]*4)
        observed["Id"]="b"*64; observed["Config"]["Env"]=[k+"="+v for k,v in spec["services"]["boris"]["environment"].items()]
        observed["Mounts"]=[dict(Type="bind",Destination=v["target"],Source=v["source"],RW=not v["read_only"]) for v in spec["services"]["boris"]["volumes"]]
        with patch.object(old,"docker",return_value=json.dumps([observed])):self.assertEqual(m.attest("b"*64,spec,"project"),observed)
        for mutation in ("id","path","duplicate"):
            bad=copy.deepcopy(observed)
            if mutation=="id":bad["Id"]="c"*64
            elif mutation=="path":bad["Config"]["Env"]=[e for e in bad["Config"]["Env"] if not e.startswith("PYTHONPATH=")]+["PYTHONPATH=/source/scripts:/opt/fullmag-boris/source"]
            else:bad["Config"]["Env"].append("PYTHONPATH="+m.PYTHONPATH)
            with self.subTest(mutation=mutation),patch.object(old,"docker",return_value=json.dumps([bad])),self.assertRaises(ValueError):m.attest("b"*64,spec,"project")

    def test_attestation_mount_order_is_stable_but_mount_values_remain_bound(self):
        observed = {key: {} for key in ("Id", "Image", "Config", "HostConfig", "State")}
        observed["Mounts"] = [dict(Destination="/a", Source="first", RW=False),
                              dict(Destination="/b", Source="second", RW=False)]
        expected = m.attestation_digest(observed)
        reordered = copy.deepcopy(observed)
        reordered["Mounts"].reverse()
        self.assertEqual(m.attestation_digest(reordered), expected)
        for key, value in (("Source", "different"), ("RW", True), ("Destination", "/other")):
            changed = copy.deepcopy(observed)
            changed["Mounts"][0][key] = value
            self.assertNotEqual(m.attestation_digest(changed), expected)

    def test_busy_runner_refuses_before_docker_inventory(self):
        with patch.object(m,"request",return_value={"ok":True,"worker_alive":True}),patch.object(old,"docker",side_effect=AssertionError("busy must refuse before Docker")),self.assertRaises(ValueError):m.require_window({})

    def test_identity_carries_two_provenances_and_distinct_version(self):
        root=Path("run");receipt={"build_job_id":"a"*32,"binding":{"boris_build_proof":{"binary_sha256":"b"*64},"source_manifest_sha256":"c"*64,"image_digest":"sha256:"+"d"*64,"source_digest":"e"*64},"tools_manifest_sha256":"f"*64,"runtime_support_sha256":"2"*64}
        value=m.identity(root,receipt,{"binary_version":"BORIS fixture","embedded_python_version":"3.10 fixture"},"1"*64)
        self.assertEqual(value["schema_version"],"fullmag.boris.runtime.v3");self.assertEqual(value["managed_run_schema"],m.SCHEMA)
        self.assertEqual(value["tools_manifest_sha256"],"f"*64);self.assertEqual(value["native_source_digest"],"e"*64);self.assertFalse(value["solver_capsule_attribution"])

    def test_unknown_new_consumer_is_retention_protective(self):
        from local_runner.runtime_references import plan_runtime_references
        with tempfile.TemporaryDirectory() as temp:
            base=Path(temp);(base/"runs").mkdir();path=base/"owned.json"
            m.storage.atomic_json(path,{"schema":m.SCHEMA,"runtime_job_id":"a"*32})
            result=plan_runtime_references(base,[],[],[path],min_artifacts_to_keep=1,
                jobs_complete=True,containers_complete=True,reference_roots_complete=True)
            self.assertTrue(result["unknown_scope"])
            self.assertTrue(any(e.get("code")=="unsupported_reference_schema:"+m.SCHEMA for e in result["errors"]))

    def test_external_observer_never_publishes_a_launched_run(self):
        with patch.object(m.storage,"resolve_layout",return_value={}),patch.object(old,"runtime_root",return_value=Path("owned")),patch.object(m,"read_json",return_value={"schema":m.SCHEMA,"state":"launched_resources_retained"}),patch.object(m,"_publish",side_effect=AssertionError("external observe cannot publish")),self.assertRaises(ValueError):m.observe(Path("repo"),"a"*32)

    def test_runtime_reader_covers_publication_and_only_owned_terminal_failure(self):
        from contextlib import contextmanager, nullcontext
        for fail in (False, True):
            with self.subTest(fail=fail),tempfile.TemporaryDirectory() as temp:
                base=Path(temp);repo=base/"repo";source=base/"source";runs=base/"runs";runs.mkdir()
                for tree in (repo,source):
                    for name in ("scripts/run_managed_boris_nf.py","scripts/local_runner/boris_cpu.py"):
                        path=tree/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b"same immutable helper fixture")
                layout={"storage_root":str(base),"runs_root":str(runs),"build_storage_root":str(base/"builds")}
                binding={"image_digest":"sha256:"+"a"*64}
                timeline=[]
                @contextmanager
                def reader(_):
                    timeline.append("enter")
                    try:yield
                    finally:timeline.append("exit")
                def support(root, *args):
                    (root/"input"/m.WRAPPER_MEMBER).write_bytes(b"runtime support fixture")
                    return {"runtime_support_sha256":"2"*64}
                def publish(*args):
                    self.assertEqual(timeline,["enter"])
                    timeline.append("publish")
                    if fail:raise ValueError("publication fixture failure")
                    return Path("verified-summary")
                def docker(*args):
                    self.assertEqual(timeline,["enter"])
                    if args[:2]==("image","inspect"):
                        return json.dumps([{ "Id":binding["image_digest"],"Config":{"Env":["PYTHONPATH=/opt/fullmag-boris-python"]}}])
                    if args[:1]==("compose",) and args[-4:]==("ps","-a","-q","boris"):return "b"*64
                    if args[:1] in (("compose",),("start",)):return ""
                    raise AssertionError("Unowned or unsupported Docker effect: "+str(args))
                with patch.object(m.storage,"resolve_layout",return_value=layout),patch.object(m,"require_window"),patch.object(m,"runtime_package_use",side_effect=reader),patch.object(m.storage,"file_lock",side_effect=lambda *a:nullcontext()),patch.object(m.storage,"build_lock",side_effect=lambda *a:nullcontext()),patch.object(m,"resolve_native_build",return_value=(layout,base/"outputs",source,binding)),patch.object(m,"capture_tools",return_value={"tools_manifest_sha256":"c"*64}),patch.object(m,"capture_runtime_support",side_effect=support),patch.object(m,"check_runtime_support"),patch.object(m,"check_tools"),patch.object(m,"register_runtime_reference_root"),patch.object(old,"fixed_inputs",return_value=(None,b"scenario fixture",b"{}")),patch.object(old,"docker",side_effect=docker),patch.object(m,"attest",return_value={"Id":"b"*64,"State":{"Status":"exited","Running":False}}),patch.object(m,"_publish",side_effect=publish):
                    if fail:
                        with self.assertRaisesRegex(ValueError,"publication fixture"):m.run(repo,"d"*32,"coarse")
                        receipt=m.read_json(next((runs/"boris-runtime").glob("*/receipt.json")))
                        self.assertEqual(receipt["state"],"failed_resources_retained")
                    else:self.assertEqual(m.run(repo,"d"*32,"coarse"),Path("verified-summary"))
                self.assertEqual(timeline,["enter","publish","exit"])

    def test_public_version_dispatch_never_relabels_v1_or_v2(self):
        from run_boris_nf_interface import validate_runtime_identity
        with patch.object(m,"verify_runtime_identity",return_value=["v3 only"]) as v3,patch.object(old,"verify_runtime_identity",return_value=["old v2"]) as v2:
            self.assertEqual(validate_runtime_identity({"schema_version":m.IDENTITY_SCHEMA},repo_root=Path("repo"),artifact_root=Path("output")),["v3 only"])
            v2.assert_not_called()
            self.assertEqual(validate_runtime_identity({"schema_version":old.RUNTIME_SCHEMA},repo_root=Path("repo"),artifact_root=Path("output")),["old v2"])
            self.assertEqual(v3.call_count,1)
        with self.assertRaises(ValueError):validate_runtime_identity({"schema_version":"fullmag.boris.runtime.future"})

    def test_publication_commit_follows_complete_bundle_and_binds_receipt_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/"export").mkdir()
            binding={"source_digest":"a"*64,"source_manifest_sha256":"b"*64,"image_digest":"sha256:"+"c"*64,"boris_build_proof":{"binary_sha256":"d"*64}}
            receipt={"schema":m.SCHEMA,"runtime_id":root.name,"state":"launched_resources_retained","build_job_id":"e"*32,"resolution":"coarse","binding":binding,"tools_manifest_sha256":"f"*64,"runtime_support_sha256":"2"*64}
            m.storage.atomic_json(root/"receipt.json",receipt)
            probe={"binary_version":"BORIS fixture","embedded_python_version":"3.10 fixture"}
            commit=old.commit_receipt;events=[]
            def final_commit(target,raw):
                self.assertTrue((target/"export/runtime.json").exists());self.assertTrue((target/"export/summary.json").exists())
                self.assertEqual(m.read_json(target/"export/runtime.json")["runtime_receipt_sha256"],m.hashlib.sha256(raw).hexdigest())
                self.assertEqual(m.read_json(target/"receipt.json")["state"],"launched_resources_retained")
                events.append("commit");commit(target,raw)
            with patch.object(m.storage,"resolve_layout",return_value={}),patch.object(old,"runtime_root",return_value=root),patch.object(m,"checked_run",return_value=(root,receipt,{})),patch.object(m,"require_window") as window,patch.object(old,"verified_outputs",return_value=([],probe)),patch.object(m,"attestation_digest",return_value="0"*64),patch.object(old,"fixed_inputs",return_value=(None,b"",b"{}")),patch.object(m,"check_tools"),patch.object(m,"check_runtime_support"),patch.object(m,"resolve_native_build",return_value=(None,None,None,binding)),patch('run_boris_nf_interface._artifact_summary',return_value={"fixture":"publication algorithm only"}),patch.object(old,"commit_receipt",side_effect=final_commit):
                m._publish(Path("repo"),"e"*32)
                self.assertEqual(window.call_count,2)
            self.assertEqual(events,["commit"]);self.assertEqual(m.read_json(root/"receipt.json")["state"],"runtime_succeeded_identity_verified")

if __name__=="__main__":unittest.main()
