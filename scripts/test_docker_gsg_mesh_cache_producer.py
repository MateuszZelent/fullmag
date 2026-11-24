"""Offline candidate regressions; no mesher, CLI preparation or solver."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import docker_gsg_mesh_preparation as p
from docker_build_control import BuildControlError, canonical

class ProducerBoundaryTests(unittest.TestCase):
    def inventories(self):
        rows=[{"relative_path":"source/gsg_junction_prepare_50nm.py","role":"source","sha256":p.LEVELS["50"],"byte_count":1,"absolute_path":"/input/gsg_junction_prepare_50nm.py"},
              {"relative_path":"source/"+p.CARRIER,"role":"source","sha256":p.CARRIER_SHA,"byte_count":1,"absolute_path":"/input/"+p.CARRIER},
              {"relative_path":"fullmag/runtime/loader.py","role":"runtime","sha256":"f"*64,"byte_count":1,"absolute_path":"/source/loader.py"}]
        before={"records":rows,"runtime":{"source_bytes":2,"runtime_bytes":1,"capture_policy":"unchanged"}}
        after=copy.deepcopy(before)
        after["records"].append({"relative_path":"source/.fullmag/local/cache/fem_meshes/"+("a"*64)+".npz",
                                "role":"source","sha256":"b"*64,"byte_count":1,"absolute_path":"/input/cache.npz"})
        after["runtime"]["source_bytes"]=3
        return before,after

    def test_guest_rejects_runtime_drift_during_cli_instead_of_publishing_success(self):
        from types import SimpleNamespace
        for drift in (False, True):
            with self.subTest(drift=drift),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);output=root/("a"*32);output.mkdir()
                request={"operation_id":output.name,"level":"50","schema":"fullmag.gsg-junction-preparation.v1",
                         "controller_sha256":"d"*64,"backend_build_receipt_sha256":"e"*64}
                raw=canonical(request);request_path=output/"request.json";request_path.write_bytes(raw)
                original_read=Path.read_bytes
                receipt="/opt/fullmag/package/backend-build-receipt.json"
                package=canonical({"artifacts":[{"path":"bin/fullmag-bin","sha256":"f"*64}]})
                def read_bytes(path):return package if str(path)==receipt else original_read(path)
                def pin(path,maximum,**kwargs):
                    sha="e"*64 if str(path)==receipt else "f"*64 if str(path)==p.CLI else "d"*64
                    return {"sha256":sha,"bytes":1}
                digests={key:key for key in ("source_mesh_sha256","source_sha256","carrier_world_nodes_sha256","carrier_cells_sha256")}
                expected={"records":[{"runtime":"original"}],"inventory_sha256":"1"*64}
                observed=copy.deepcopy(expected)
                if drift:observed["records"][0]["runtime"]="changed during CLI"
                def warm(directory,request,proof):
                    proof["cache_pins"]={}
                    return directory/"input",{"mesh":digests},expected
                def capture(command,directory,environment,*,input_root):
                    value={"archive_base64":"unchanged==","run_intent":{},"study_plan":{},
                           "study_problem_catalog":{"entries":[{"problem":{}}]},"asset_paths":{}}
                    pretty=canonical(value);(directory/"request.pretty.json").write_bytes(pretty)
                    return 0,{"request.pretty.json":len(pretty),"stderr.log":0},[],123
                persistence=SimpleNamespace(load_mesh_artifact=lambda *args,**kwargs:SimpleNamespace(mesh=SimpleNamespace(to_ir=lambda name:{})))
                with patch.object(p,"OUTPUTS",str(root)),patch.object(p,"FIXED_FILES",{}),patch.object(p,"file_pin",side_effect=pin), \
                     patch.object(Path,"read_bytes",read_bytes),patch.object(p,"sync_directories"), \
                     patch.object(p,"configure_guest_resources",return_value=[0]),patch.object(p,"warm_input",side_effect=warm), \
                     patch.object(p,"capture_cli",side_effect=capture) as cli,patch.object(p,"mesh_report",return_value=digests), \
                     patch.object(p,"preparation_phase",return_value={"capture":observed}) as inventory, \
                     patch.dict(sys.modules,{"fullmag":SimpleNamespace(),"fullmag.meshing":SimpleNamespace(),"fullmag.meshing.persistence":persistence}):
                    result=p.guest(str(request_path),p.digest(raw))
                proof=json.loads((output/"result.json").read_bytes())
                cli.assert_called_once();inventory.assert_called_once()
                self.assertEqual(inventory.call_args.args[3],"inventory-final")
                self.assertEqual(result,2 if drift else 0)
                self.assertEqual(proof["exit_code"],result)
                self.assertFalse(proof["new_solve"])
                if drift:
                    self.assertEqual(proof["status"],"REFUSED / NOT PREPARED")
                    self.assertIn("source/runtime inventory",proof["error"])
                else:self.assertEqual(proof["status"],"PREPARED INPUT ONLY / NOT VERIFIED")

    def test_final_inventory_refuses_runtime_script_cache_or_inventory_hash_drift_during_cli(self):
        before, expected = self.inventories()
        expected["inventory_sha256"] = "1" * 64
        p.require_same_inventory(expected, copy.deepcopy(expected))
        for changed_kind in ("runtime", "script", "cache", "addition", "digest"):
            changed = copy.deepcopy(expected)
            if changed_kind == "runtime":changed["records"][2]["sha256"] = "0" * 64
            elif changed_kind == "script":changed["records"][0]["sha256"] = "0" * 64
            elif changed_kind == "cache":changed["records"][-1]["sha256"] = "0" * 64
            elif changed_kind == "addition":changed["records"].append({"unexpected": True})
            else:changed["inventory_sha256"] = "2" * 64
            with self.subTest(kind=changed_kind),self.assertRaises(BuildControlError):
                p.require_same_inventory(expected, changed)

    def test_environment_excludes_all_inherited_cache_snapshot_and_secret_values(self):
        with patch.dict(os.environ,{"FULLMAG_SOURCE_SNAPSHOT_SHA256":"old","FULLMAG_CACHE_ROOT":"/old","SECRET":"hidden"}):
            self.assertEqual(p.capture_environment(),{"PATH":"/usr/local/bin","PYTHONHASHSEED":"0",
                "PYTHONDONTWRITEBYTECODE":"1","PYTHONUNBUFFERED":"1"})

    def test_only_raw_cache_addition_is_accepted_and_cold_files_are_unchanged(self):
        before,after=self.inventories()
        self.assertEqual(len(p.check_cache_inventory(before,after,"50")),1)
        self.assertEqual(len(before["records"]),3)

    def test_changed_existing_source_runtime_inventory_or_runtime_summary_refuses(self):
        for kind in ("source","runtime","runtime-summary","missing","duplicate"):
            before,after=self.inventories()
            if kind=="source":after["records"][0]["sha256"]="0"*64
            elif kind=="runtime":after["records"][2]["sha256"]="0"*64
            elif kind=="runtime-summary":after["runtime"]["capture_policy"]="weaker"
            elif kind=="missing":after["records"].pop(1)
            else:after["records"].append(after["records"][0])
            with self.subTest(kind=kind),self.assertRaises(BuildControlError):p.check_cache_inventory(before,after,"50")

    def test_unexpected_file_wrong_cache_key_empty_cache_and_budget_refuse(self):
        for kind in ("lock","path","uppercase","role","empty","budget"):
            before,after=self.inventories()
            row=after["records"][-1]
            if kind=="lock":row["relative_path"]+=".lock"
            elif kind=="path":row["relative_path"]="source/cache/"+("a"*64)+".npz"
            elif kind=="uppercase":row["relative_path"]=row["relative_path"].replace("a"*64,"A"*64)
            elif kind=="role":row["role"]="runtime"
            elif kind=="empty":after["records"].pop()
            else:after["runtime"]["source_bytes"]=8*1024*1024+1
            with self.subTest(kind=kind),self.assertRaises(BuildControlError):p.check_cache_inventory(before,after,"50")

    def test_every_mesh_source_and_carrier_digest_is_required(self):
        original={key:key for key in ("source_mesh_sha256","source_sha256","carrier_world_nodes_sha256","carrier_cells_sha256")}
        p.require_same_mesh(original,original.copy())
        for key in original:
            changed={**original,key:"changed"}
            with self.subTest(key=key),self.assertRaises(BuildControlError):p.require_same_mesh(original,changed)

    def test_real_child_uses_explicit_copy_cwd_and_minimal_environment(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/"input").mkdir();(root/"logs").mkdir()
            command=[sys.executable,"-B","-c","import os,json;print(json.dumps({'cwd':os.getcwd(),'env':dict(os.environ)}))"]
            code,totals,errors,pid=p.capture_cli(command,root/"logs",p.capture_environment(),input_root=root/"input")
            value=json.loads((root/"logs/request.pretty.json").read_bytes())
            self.assertEqual(code,0);self.assertFalse(errors)
            self.assertEqual(value["cwd"],str(root/"input"))
            self.assertNotIn("FULLMAG_SOURCE_SNAPSHOT_SHA256",value["env"])
            self.assertNotIn("FULLMAG_CACHE_ROOT",value["env"])
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)

    def test_producer_failure_is_reaped_and_prevents_later_phases(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/"original";source.mkdir();output=root/"attempt";output.mkdir()
            script=source/"gsg_junction_prepare_50nm.py";script.write_bytes(b"# frozen input")
            carrier=source/p.CARRIER;carrier.write_bytes(b"carrier")
            pins={"50":p.digest(script.read_bytes())};carrier_sha=p.digest(carrier.read_bytes())
            before,after=self.inventories()
            before["records"][0]["sha256"]=pins["50"];before["records"][1]["sha256"]=carrier_sha
            calls=[]
            def capture(command,directory,environment,*,input_root):
                calls.append(directory.name)
                self.assertEqual(input_root,output/"input")
                raw=canonical({"capture":before}) if directory.name=="inventory-before" else b""
                (directory/"request.pretty.json").write_bytes(raw)
                (directory/"stderr.log").write_bytes(b"refused" if len(calls)==2 else b"")
                return (7 if len(calls)==2 else 0),{"request.pretty.json":len(raw),"stderr.log":7 if len(calls)==2 else 0},[],123
            proof={}
            with patch.object(p,"INPUTS",str(source)),patch.object(p,"LEVELS",pins),patch.object(p,"CARRIER_SHA",carrier_sha),patch.object(p,"capture_cli",side_effect=capture),patch.object(p,"sync_directories"):
                with self.assertRaisesRegex(BuildControlError,"mesh-producer"):p.warm_input(output,{"level":"50","controller_sha256":"d"*64},proof)
            self.assertEqual(calls,["inventory-before","mesh-producer"])
            self.assertTrue(proof["child_reaped"]);self.assertEqual(proof["child_exit_code"],7)
            self.assertEqual(script.read_bytes(),b"# frozen input")
            self.assertEqual(set(x.name for x in source.iterdir()),{script.name,carrier.name})
            self.assertTrue((output/"mesh-producer/exit.json").is_file())

if __name__=="__main__":unittest.main()
