"""Source-only junction preparation checks; no solver, Docker or mesher."""
import argparse
from contextlib import contextmanager
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import docker_gsg_mesh_preparation as preparation
from docker_build_control import BuildControlError, canonical


class Control:
    instance = None
    def __init__(self, *args):
        Control.instance = self
        self.files = {}; self.project = "fixture"
        self.operation_value = None
    def prepare(self):pass
    def read_bytes(self, path, optional=False):return self.files.get(path)
    def write_bytes(self, path, raw):self.files[path] = raw
    @contextmanager
    def operation(self, phase, inputs):
        self.phase = phase
        self.operation_value = {"receipt":{"attempt":"a"*32}, "daemon_pending":False}
        yield self.operation_value


class JunctionPreparationTests(unittest.TestCase):
    def test_missing_guest_input_publishes_terminal_refusal_before_any_child(self):
        output = self.root / ("a"*32); output.mkdir()
        request = {"operation_id": output.name, "level": "50",
                   "schema": "fullmag.gsg-junction-preparation.v1"}
        raw = canonical(request); path = output / "request.json"; path.write_bytes(raw)
        with patch.object(preparation, "OUTPUTS", str(self.root)), \
             patch.object(preparation, "FIXED_FILES", {str(self.root/"absent"): "f"*64}), \
             patch.object(preparation, "sync_directories"), \
             patch.object(preparation, "configure_guest_resources") as configure, \
             patch.object(preparation, "capture_cli") as capture, \
             patch.object(preparation, "warm_input") as warm:
            code = preparation.guest(str(path), preparation.digest(raw))
        proof = json.loads((output/"result.json").read_bytes())
        self.assertEqual(code, 2)
        self.assertEqual(proof["status"], "REFUSED / NOT PREPARED")
        self.assertTrue(proof["child_reaped"])
        self.assertIsNone(proof["child_pid"])
        self.assertIsNone(proof["inputs"])
        self.assertIn("FileNotFoundError", proof["error"])
        self.assertFalse((output/"started.json").exists())
        self.assertFalse((output/"tmp").exists())
        configure.assert_not_called(); capture.assert_not_called(); warm.assert_not_called()

    def test_missing_guest_completion_preserves_bootstrap_error_and_pending_lease(self):
        stderr = b"FileNotFoundError: missing preparation input\\n"
        with self.assertRaisesRegex(BuildControlError, "unknown"):
            self.host_run(lambda *args, **kwargs: argparse.Namespace(returncode=1, stdout=b"", stderr=stderr))
        control = Control.instance
        root = preparation.OUTPUTS + "/" + "a"*32
        self.assertEqual(control.files[root+"/bootstrap.stderr.log"], stderr)
        self.assertTrue(control.operation_value["daemon_pending"])

    def test_retained_fine_guest_never_calls_warm_input_or_mesher(self):
        from types import SimpleNamespace
        output = self.root / ("a"*32); output.mkdir()
        input_root = self.root / "input"; input_root.mkdir()
        request = {"operation_id": output.name, "level": preparation.RETAINED_FINE_LEVEL,
                   "schema": "fullmag.gsg-junction-preparation.v1", "controller_sha256": "d"*64,
                   "backend_build_receipt_sha256": "e"*64}
        raw = canonical(request); path = output / "request.json"; path.write_bytes(raw)
        original_read = Path.read_bytes
        receipt = "/opt/fullmag/package/backend-build-receipt.json"
        package = canonical({"artifacts": [{"path": "bin/fullmag-bin", "sha256": "f"*64}]})
        common = {name: "b"*64 for name in (preparation.PROJECT, preparation.PROFILE, preparation.RESOURCES)}
        frozen = {str(input_root/name): pin for name, pin in preparation.RETAINED_FINE_FILES.items()}
        def pin(path, maximum, **kwargs):
            name = str(path)
            sha = "e"*64 if name == receipt else "f"*64 if name == preparation.CLI else frozen.get(name, common.get(name, "d"*64))
            return {"sha256": sha, "bytes": 1}
        calls = []
        with patch.object(preparation, "CORNER12P5_INPUT", str(input_root)):
            inventory = self.fine_inventory()
        def capture(command, directory, environment, *, input_root):
            calls.append((command, input_root))
            value = self.request_value(); value["study_problem_catalog"]["entries"] = [{"problem": {}}]
            pretty = canonical(value); (directory/"request.pretty.json").write_bytes(pretty)
            return 0, {"request.pretty.json": len(pretty), "stderr.log": 0}, [], 123
        persistence = SimpleNamespace(load_mesh_artifact=lambda *args, **kwargs:
            SimpleNamespace(mesh=SimpleNamespace(to_ir=lambda name: {})))
        with patch.object(preparation, "OUTPUTS", str(self.root)), \
             patch.object(preparation, "CORNER12P5_INPUT", str(input_root)), \
             patch.object(preparation, "FIXED_FILES", common), \
             patch.object(preparation, "file_pin", side_effect=pin), \
             patch.object(Path, "read_bytes", lambda p: package if str(p) == receipt else original_read(p)), \
             patch.object(preparation, "configure_guest_resources", return_value=[0]), \
             patch.object(preparation, "sync_directories"), \
             patch.object(preparation, "warm_input", side_effect=AssertionError("new mesh forbidden")) as warm, \
             patch.object(preparation, "produce_mesh", side_effect=AssertionError("Gmsh forbidden")) as mesher, \
             patch.object(preparation, "capture_cli", side_effect=capture), \
             patch.object(preparation, "preparation_phase", return_value={"capture": inventory}) as phases, \
             patch.object(preparation, "mesh_report", return_value={}), \
             patch.object(preparation, "verify_retained_fine_cache_mesh", return_value={}), \
             patch.object(preparation, "verify_retained_fine_request", return_value={}) as verified, \
             patch.dict(sys.modules, {"fullmag": SimpleNamespace(), "fullmag.meshing": SimpleNamespace(),
                                      "fullmag.meshing.persistence": persistence}):
            code = preparation.guest(str(path), preparation.digest(raw))
        self.assertEqual(code, 0); warm.assert_not_called(); mesher.assert_not_called()
        self.assertEqual([call.args[3] for call in phases.call_args_list], ["inventory-before", "inventory-final"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], input_root)
        self.assertEqual(calls[0][0][-1], "--prepare-only")
        verified.assert_called_once()
        self.assertFalse(json.loads((output/"result.json").read_bytes())["new_solve"])


    def test_retained_fine_lowered_physics_rejects_each_protected_change(self):
        expected_stage={"id":"inspect_gsg","source_object_id":"antenna","current_transport_id":"gsg_charge",
            "port_mode_ids":["gsg_port"],"model":"quasistatic_conduction_biot_savart3d",
            "oersted_realization":"direct_tetra_quadrature","conductor_mesh_policy":"authored_shared_domain",
            "field_sampling_domain":{"kind":"global"},"target_refs":[{"kind":"global"}],
            "solver_policy":"volume_inspection_v1","outputs":[{"id":"gsg_inspection","quantity":"H_ant_basis"}]}
        solver={"engine":"cg","linear":{"absolute_tolerance":0.0,"max_iterations":10000,"relative_tolerance":1e-12},
            "operator_version":"fem_charge_conforming_h1_p1.transparent.v1","physical_residual_version":"charge_balance_integrated_l2.v1"}
        transport={"kind":"current_transport","name":"gsg_charge","model":"ohmic_poisson","coupling":"one_way",
            "domain":[{"object_id":"antenna"}],"boundaries":[],"gauge":"zero_mean","solver":solver}
        problem={"antenna_field_solve_stages":[expected_stage],"current_modules":[transport],
            "antenna_port_modes":[{"branches":[{"id":part,"inlet_terminal_ref":part+"_in",
                "outlet_terminal_ref":part+"_out","signed_weight":0.0} for part in ("signal","ground_left","ground_right")],
                "current_transport_id":"gsg_charge","id":"gsg_port","normalization":{"kind":"source_cut_rt0",
                "orientation":"minus_outward","source_cut_ref":"inlet_cut"},"normalization_current_a":1.0,
                "schema_version":"antenna_port_mode.v3","source_object_id":"antenna"}],"magnets":[],"energy_terms":[]}
        preparation.verify_retained_fine_physics(problem)
        mutations=[("stage-policy",lambda d:d["antenna_field_solve_stages"][0].update(solver_policy="production_default")),
            ("realization",lambda d:d["antenna_field_solve_stages"][0].update(oersted_realization="analytic_rt0_surface")),
            ("extra-policy",lambda d:d["antenna_field_solve_stages"][0].update(surface_field_policy={})),
            ("stage-source",lambda d:d["antenna_field_solve_stages"][0].update(source_object_id="foreign")),
            ("gauge",lambda d:d["current_modules"][0].update(gauge="pin")),
            ("operator",lambda d:d["current_modules"][0]["solver"].update(operator_version="foreign")),
            ("tolerance",lambda d:d["current_modules"][0]["solver"]["linear"].update(relative_tolerance=1e-6)),
            ("iterations",lambda d:d["current_modules"][0]["solver"]["linear"].update(max_iterations=10001)),
            ("coupling",lambda d:d["current_modules"][0].update(coupling="reciprocal")),
            ("port-sign",lambda d:d["antenna_port_modes"][0]["normalization"].update(orientation="plus_outward")),
            ("LLG",lambda d:d["magnets"].append({"id":"not-authorized"}))]
        for name,mutate in mutations:
            changed=copy.deepcopy(problem);mutate(changed)
            with self.subTest(name=name),self.assertRaises(BuildControlError):
                preparation.verify_retained_fine_physics(changed)

    def capture_export(self, script, *, scene_only=False):
        command = [preparation.PYTHON,"-X","utf8","-B","-S",preparation.CAPTURE,
                   "--script",str(script),"--fullmag-root",preparation.FULLMAG]
        inventory = subprocess.run(command+["--phase","inventory"],
            cwd=script.parent,env=preparation.capture_environment(),text=True,capture_output=True,timeout=90,check=True)
        pin = json.loads(inventory.stdout)["capture"]["inventory_sha256"]
        return subprocess.run(command+["--phase","export","--expected-inventory",pin]+
            (["--scene-only"] if scene_only else []),
            cwd=script.parent,env=preparation.capture_environment(),text=True,capture_output=True,timeout=90)

    def test_retained_fine_real_capture_refuses_cache_miss_before_meshing(self):
        source = Path(__file__).resolve().parents[1]/"examples/sushruth_2020_closed_gsg/corner12p5_20261112/input"
        for name in preparation.CORNER12P5_FILES:
            (self.root/name).write_bytes((source/name).read_bytes())
        (self.root/Path(preparation.RETAINED_FINE_CACHE).parent).mkdir(parents=True)
        before = {str(path.relative_to(self.root)):path.read_bytes()
                  for path in self.root.rglob("*") if path.is_file()}
        result = self.capture_export(self.root/preparation.CORNER12P5_SCRIPT)
        self.assertNotEqual(result.returncode,0,result.stdout)
        self.assertIn("source_capture_",result.stderr)
        self.assertIn("gmsh",result.stderr.lower())
        self.assertEqual(before,{str(path.relative_to(self.root)):path.read_bytes()
                         for path in self.root.rglob("*") if path.is_file()})
        self.assertFalse((self.root/preparation.RETAINED_FINE_CACHE).exists())

    def test_real_capture_keeps_refusal_when_authoring_catches_exception(self):
        source = Path(__file__).resolve().parents[1]/"examples/sushruth_2020_closed_gsg/corner12p5_20261112/input"
        script = self.root/preparation.CORNER12P5_SCRIPT
        for name in preparation.CORNER12P5_FILES:
            (self.root/name).write_bytes((source/name).read_bytes())
        script.write_text(script.read_text()+"\ntry:\n    import gmsh\nexcept Exception:\n    pass\n")
        result = self.capture_export(script,scene_only=True)
        self.assertNotEqual(result.returncode,0,result.stdout)
        self.assertIn("source_capture_observed_violation",result.stderr)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()),sorted(preparation.CORNER12P5_FILES))

    def fine_inventory(self):
        rows=[{"relative_path":"source/"+name,"role":"source","sha256":pin,
               "byte_count":1,"absolute_path":str(Path(preparation.CORNER12P5_INPUT)/name)}
              for name,pin in preparation.RETAINED_FINE_FILES.items()]
        return {"records":rows,"runtime":{"source_bytes":3},"inventory_sha256":"1"*64}

    def test_retained_fine_cli_and_inventory_are_closed_and_cache_only(self):
        level="retained-corner12p5"
        command=preparation.cli_command(level,"a"*32)
        self.assertEqual(command[2],preparation.CORNER12P5_INPUT+"/"+preparation.CORNER12P5_SCRIPT)
        self.assertEqual(command[-1],"--prepare-only")
        self.assertEqual(command[command.index("--idempotency-key")+1],"gsg-retained-corner12p5-prepare-"+"a"*32)
        inventory=self.fine_inventory()
        preparation.verify_retained_fine_inventory(inventory,Path(preparation.CORNER12P5_INPUT))
        for row_index in range(3):
            changed=copy.deepcopy(inventory);changed["records"][row_index]["sha256"]="0"*64
            with self.subTest(row=row_index),self.assertRaises(BuildControlError):
                preparation.verify_retained_fine_inventory(changed,Path(preparation.CORNER12P5_INPUT))
        for changed in ({"records":inventory["records"][:-1],"runtime":{"source_bytes":2}},
                        {"records":inventory["records"]*2,"runtime":{"source_bytes":6}}):
            with self.assertRaises(BuildControlError):
                preparation.verify_retained_fine_inventory(changed,Path(preparation.CORNER12P5_INPUT))
        with self.assertRaises(BuildControlError):
            preparation.verify_retained_fine_inventory(inventory,Path("/wrong"))
        with self.assertRaises(BuildControlError):
            preparation.cli_command(level,"a"*32,input_root="/wrong")

    def test_retained_fine_cache_geometry_detects_changed_or_missing_tetrahedron(self):
        import numpy as np
        root=Path(__file__).resolve().parents[1]/"examples/sushruth_2020_closed_gsg/corner12p5_20261112/input"
        path=root/preparation.RETAINED_FINE_CACHE
        with np.load(path,allow_pickle=False) as cache:
            mesh={"nodes":cache["nodes"].tolist(),"cells":{
                "types":cache["cell_types"].tolist(),"offsets":cache["cell_offsets"].tolist(),
                "nodes":cache["cell_nodes"].tolist()}}
        report=preparation.verify_retained_fine_cache_mesh(mesh,path)
        self.assertEqual(report["cells"],85980)
        changed=copy.deepcopy(mesh);changed["cells"]["nodes"][0]=changed["cells"]["nodes"][1]
        with self.assertRaises(BuildControlError):
            preparation.verify_retained_fine_cache_mesh(changed,path)
        changed=copy.deepcopy(mesh);changed["cells"]["types"].pop()
        with self.assertRaises(BuildControlError):
            preparation.verify_retained_fine_cache_mesh(changed,path)
        with self.assertRaises((BuildControlError,FileNotFoundError)):
            preparation.verify_retained_fine_cache_mesh(mesh,root/"missing.npz")

    def test_characteristic_size_is_not_an_unjustified_two_h_edge_bound(self):
        h = 12.5e-9
        nodes = []
        for x in (-350e-9,-100e-9,100e-9,350e-9):
            for y in (-11.8e-6,11.8e-6):
                nodes.extend([[x,y,30e-9],[x+3*h,y,30e-9],
                              [x,y+h,30e-9],[x,y,30e-9+h]])
        mesh = {"nodes":nodes, "cells":{"types":["tet4"]*8,
                "offsets":list(range(0,33,4)), "nodes":list(range(32))}}
        report = preparation.corner12p5_refinement_report(mesh)
        self.assertGreater(report["maximum_edge_m"],2*h)
        self.assertEqual(report["requested_corner_size_m"],h)
        self.assertNotIn("edge_admission_limit_m",report)
        self.assertFalse(report["field_error_bound"])

    def test_corner12p5_changes_only_mesh_refinement_and_study_output_identity(self):
        import ast
        base = Path(__file__).resolve().parents[1] / "examples/sushruth_2020_closed_gsg"
        paths = [base / "restart_20261111/input/fem_antenna_gsg_corner25_restart_20261111.py",
                 base / "corner12p5_20261112/input/fem_antenna_gsg_corner12p5.py"]
        normalized = []
        for path in paths:
            tree = ast.parse(path.read_bytes())
            if isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Constant):
                tree.body.pop(0)
            for node in ast.walk(tree):
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    node.value = node.value.replace("fem_antenna_gsg_corner25_restart_20261111", "study").replace(
                        "fem_antenna_gsg_corner12p5", "study")
                if isinstance(node, ast.Assign) and any(
                        isinstance(target, ast.Name) and target.id == "corner_mesh_size_m"
                        for target in node.targets):
                    node.value = ast.Constant("refinement")
            normalized.append(ast.dump(tree))
        self.assertEqual(*normalized)
        self.assertEqual((paths[0].parent / preparation.CARRIER).read_bytes(),
                         (paths[1].parent / preparation.CARRIER).read_bytes())

    def test_corner12p5_fresh_input_is_pinned_and_prepare_only(self):
        command = preparation.cli_command("corner12p5", "a"*32)
        root = "/opt/fullmag/script-output/sushruth_2020_closed_gsg/corner12p5_20261112/input"
        self.assertEqual(command[2], root + "/fem_antenna_gsg_corner12p5.py")
        self.assertEqual(command[-1], "--prepare-only")
        self.assertNotIn("--api-url", command)
        with self.assertRaises(BuildControlError):
            preparation.cli_command("corner12p5", "a"*32, input_root="/wrong")
        source = Path(__file__).resolve().parents[1] / (
            "examples/sushruth_2020_closed_gsg/corner12p5_20261112/input/fem_antenna_gsg_corner12p5.py")
        raw = source.read_bytes()
        preparation.verify_corner12p5_script(raw)
        for before, after in ((b"200e-9", b"201e-9"), (b"250e-9", b"251e-9"),
                              (b"3.5e7", b"3.6e7"), (b"1e-3", b"2e-3"),
                              (b"gsg-convergence-targets", b"foreign-carrier")):
            with self.subTest(before=before), self.assertRaises(BuildControlError):
                preparation.verify_corner12p5_script(raw.replace(before, after))
        self.assertIn(root + "/fem_antenna_gsg_corner12p5.py",
                      preparation.inventory_command(Path(root), "corner12p5"))

    def test_corner12p5_measures_each_corner_and_refuses_missing_region(self):
        h = 12.5e-9
        vertices, connectivity = [], []
        for x in (-350e-9, -100e-9, 100e-9, 350e-9):
            for y in (-11.8e-6, 11.8e-6):
                start = len(vertices)
                vertices += [[x,y,30e-9], [x+h,y,30e-9],
                             [x,y+h,30e-9], [x,y,30e-9+h]]
                connectivity += list(range(start,start+4))
        mesh = {"nodes": vertices, "cells": {"types": ["tet4"]*8,
                "offsets": list(range(0,33,4)), "nodes": connectivity}}
        report = preparation.corner12p5_refinement_report(mesh)
        self.assertEqual(len(report["corners"]),8)
        self.assertTrue(all(row["cells"] > 0 for row in report["corners"]))
        self.assertAlmostEqual(report["maximum_edge_m"]/h, 2.**.5)
        self.assertFalse(report["field_error_bound"])
        coarse = copy.deepcopy(mesh);coarse["nodes"][1][0] += 100e-9
        self.assertGreater(preparation.corner12p5_refinement_report(coarse)["maximum_edge_m"],
                           report["maximum_edge_m"])
        missing = copy.deepcopy(mesh);missing["cells"]["types"].pop()
        missing["cells"]["nodes"] = missing["cells"]["nodes"][:-4]
        missing["cells"]["offsets"].pop()
        with self.assertRaisesRegex(BuildControlError,"corner"):
            preparation.corner12p5_refinement_report(missing)
        oversized = copy.deepcopy(mesh);oversized["cells"]["types"] = ["tet4"]*80001
        with self.assertRaisesRegex(BuildControlError,"80000"):
            preparation.corner12p5_refinement_report(oversized)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_cpu_and_memory_bounds_survive_capture_environment_clear(self):
        probe = """import json,os,resource,subprocess,sys
import docker_gsg_mesh_preparation as preparation
selected = preparation.configure_guest_resources()
child = subprocess.run([sys.executable, '-B', '-c',
    "import json,os,resource;print(json.dumps({'affinity':sorted(os.sched_getaffinity(0)),'as':resource.getrlimit(resource.RLIMIT_AS),'core':resource.getrlimit(resource.RLIMIT_CORE),'omp':os.environ.get('OMP_NUM_THREADS')}))"],
    env={}, text=True, capture_output=True, check=True)
print(json.dumps({'selected':selected,'child':json.loads(child.stdout)}))
"""
        result = subprocess.run([sys.executable, "-B", "-c", probe],
            env={**os.environ, "PYTHONPATH": str(Path(preparation.__file__).parent)},
            text=True, capture_output=True, check=True)
        observed = json.loads(result.stdout)
        self.assertEqual(len(observed["selected"]), 1)
        self.assertEqual(observed["child"]["affinity"], observed["selected"])
        self.assertEqual(observed["child"]["as"], [4294967296, 4294967296])
        self.assertEqual(observed["child"]["core"], [0, 0])
        self.assertIsNone(observed["child"]["omp"])

    def test_cli_has_only_prepare_no_api_or_submit_or_execution(self):
        command = preparation.cli_command("35", "a"*32)
        self.assertEqual(command[:2], [preparation.CLI, "run-script-accepted"])
        self.assertEqual(command[-1], "--prepare-only")
        self.assertIn("gsg_junction_prepare_35nm.py", command[2])
        for forbidden in ("--api-url", "--submit-only", "run-json", "run-problem-json-direct"):
            self.assertNotIn(forbidden, command)
        for bad in ("75", "../50", "0"):
            with self.assertRaises(BuildControlError):preparation.cli_command(bad, "a"*32)
        with self.assertRaises(BuildControlError):preparation.cli_command("50", "../"+"a"*32)

    def test_corner_profile_is_pinned_and_prepare_only(self):
        command = preparation.cli_command("corner25", "a"*32)
        self.assertEqual(command[-1], "--prepare-only")
        self.assertEqual(command[2], preparation.INPUTS + "/gsg_junction_prepare_corner25nm.py")
        self.assertEqual(preparation.LEVELS["corner25"], "d5616c2e9125d3cd9f24f19580ee95cd5023d5e3de31098ae31b76867c55f148")
        self.assertEqual(preparation.FIXED_FILES[preparation.INPUTS + "/corner-input-validation.json"], "0539442bb331a432a19a0acafa57102540cebe606662cfa69d977d29a1aef3d5")
        self.assertNotIn("--api-url", command)
        for bad in ("corner35", "../corner25"):
            with self.assertRaises(BuildControlError):
                preparation.cli_command(bad, "a"*32)

    def test_fixed_inputs_exact_pins(self):
        self.assertEqual(set(preparation.LEVELS), {"50", "35", "25", "corner25"})
        self.assertEqual(preparation.VALIDATION_SHA, "9bfb62d363aa14632829fa55b369d5c12c9403dc9f378d41814b38ec50fb623a")
        self.assertEqual(preparation.FIXED_FILES[preparation.INPUTS+"/"+preparation.CARRIER], preparation.CARRIER_SHA)
        self.assertEqual(len(preparation.FIXED_FILES), 10)
        self.assertEqual(preparation.MAX_REQUEST, 96*1024*1024)

    def test_file_pin_checks_hash_size_type_links_and_change(self):
        path = self.root / "file"; path.write_bytes(b"owned source")
        self.assertEqual(preparation.file_pin(path, 100)["sha256"], preparation.digest(b"owned source"))
        with self.assertRaises(BuildControlError):preparation.file_pin(path, 1)
        link = self.root / "link";link.symlink_to(path)
        with self.assertRaises(BuildControlError):preparation.file_pin(link, 100)
        os.link(path, self.root/"hardlink")
        with self.assertRaises(BuildControlError):preparation.file_pin(path, 100)
        path.chmod(0o444)
        self.assertEqual(preparation.file_pin(path,100,sealed=True)["bytes"],12)

    def test_file_identity_drift_during_hash_refuses(self):
        path=self.root/'drifting';path.write_bytes(b'original')
        before=path.stat()
        fields={name:getattr(before,name) for name in ('st_dev','st_ino','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')}
        fields['st_ctime_ns']+=1
        with patch.object(preparation.os,'fstat',side_effect=[before,argparse.Namespace(**fields)]),self.assertRaisesRegex(BuildControlError,'changed while hashing'):
            preparation.file_pin(path,100)

    def test_parent_symlink_refuses(self):
        real = self.root/"real";real.mkdir();(real/"value").write_bytes(b"x")
        (self.root/"alias").symlink_to(real, target_is_directory=True)
        with self.assertRaises(BuildControlError):preparation.file_pin(self.root/"alias/value",100)

    def request_value(self):
        return {"archive_base64":"unchanged==", "run_intent":{"u64":2**63+7,"signed_zero":-0.0,"unicode":"μm"},
                "study_plan":{}, "study_problem_catalog":{"entries":[]}, "asset_paths":{}}

    def test_normalization_preserves_every_field_value_and_large_integer(self):
        value = self.request_value();raw = json.dumps(value,indent=4).encode()
        decoded, compact = preparation.normalize_request(raw)
        self.assertEqual(decoded,value);self.assertEqual(json.loads(compact),value)
        self.assertEqual(json.loads(compact)["run_intent"]["u64"],2**63+7)
        self.assertLess(len(compact),len(raw))

    def test_normalization_never_accepts_truncated_duplicate_unknown_or_oversized(self):
        raw = json.dumps(self.request_value()).encode()
        for bad in (raw[:-1], b'{"a":1,"a":2}', raw[:-1]+b',"unknown":1}'):
            with self.assertRaises((BuildControlError,ValueError)):preparation.normalize_request(bad)
        with patch.object(preparation,"MAX_REQUEST",1),self.assertRaises(BuildControlError):
            preparation.normalize_request(raw)
        with patch.object(preparation,"MAX_STDOUT",1),self.assertRaises(BuildControlError):
            preparation.normalize_request(raw)

    def test_publish_is_create_once_and_directory_sync_required(self):
        path = self.root/"started.json"
        with patch.object(preparation,"sync_directories") as synced:
            preparation.publish(path,{"new_solve":False});synced.assert_called_once_with(self.root)
            with self.assertRaises(FileExistsError):preparation.publish(path,{"new_solve":False})
        self.assertEqual(json.loads(path.read_bytes()),{"new_solve":False})

    def test_spool_reaps_and_bounds_both_streams_without_prefix_acceptance(self):
        command = [sys.executable,"-B","-c","import sys;sys.stdout.write('x'*100);sys.stderr.write('y'*20);sys.exit(2)"]
        with patch.object(preparation,"INPUTS",str(self.root)),patch.object(preparation,"MAX_STDOUT",10),patch.object(preparation,"MAX_METADATA",5):
            code,totals,errors,pid = preparation.capture_cli(command,self.root,dict(os.environ))
        self.assertEqual(code,2);self.assertEqual(errors,[])
        self.assertEqual(totals,{"request.pretty.json":100,"stderr.log":20})
        self.assertEqual((self.root/"request.pretty.json").stat().st_size,10)
        self.assertEqual((self.root/"stderr.log").stat().st_size,5)

    def test_spool_collision_preserves_existing_bytes_and_reaps_child(self):
        path=self.root/"request.pretty.json";path.write_bytes(b"old")
        with patch.object(preparation,"INPUTS",str(self.root)):
            code,totals,errors,pid=preparation.capture_cli([sys.executable,"-B","-c","print('not overwritten')"],self.root,dict(os.environ))
        self.assertEqual(code,0);self.assertTrue(errors);self.assertEqual(path.read_bytes(),b"old")
        self.assertGreater(totals['request.pretty.json'],0)

    def fixture_mesh(self):
        xyz=[]; connectivity=[]
        for i in range(5):
            xyz.extend([[3.*i,0.,0.],[3.*i+1,0.,0.],[3.*i,1.,0.],[3.*i,0.,1.]])
            connectivity.extend(range(4*i,4*i+4))
        xyz[4:8]=[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,-1.]]
        connectivity[4:8]=[4,6,5,7]
        mesh={"nodes":xyz,"cells":{"types":["tet4"]*5,"offsets":list(range(0,21,4)),"nodes":connectivity}}
        carrier={"nodes":xyz,"cells":{"types":["tet4"]*24,"offsets":list(range(0,97,4)),"nodes":[0,1,2,3]*24}}
        source={"schema_version":"conservative_current_source.v2","kind":"closed_geometry_potential_jump",
                "object_id":"antenna","geometry_id":"gsg","stable_vertex_ids":list(range(20)),
                "material_parts":[{"part_id":"part"+str(i),"element_ordinals":[i],"material_assignment_index":i} for i in range(5)],
                "closure":{"operator_version":"fem_closed_current_geometry.v2","source_cuts":[{"translation_m":[0.,0.,0.],
                    "potential_drop_v":0.001,"face_pairs":[{"minus_face_vertex_ids":[0,1,2],"plus_face_vertex_ids":[4,5,6]}]}]}}
        transport={"conservative_current_source":source,"materials":[{"material":{"sigma_Spm":35000000.}} for _ in range(5)]}
        problem={"backend_policy":{"requested_backend":"fem","execution_precision":"double"},"validation_profile":{"execution_mode":"strict"},
                 "current_modules":[transport],"physics_graph":{"modules":[{"kind":"current_transport","family_payload":copy.deepcopy(transport)}]},
                 "geometry_assets":{"fem_mesh_assets":[{"geometry_name":"gsg","mesh":mesh}],"fem_domain_mesh_asset":{"mesh":copy.deepcopy(carrier)}},
                 "problem_meta":{"runtime_metadata":{"mesh_workflow":{"fixture":"all source fields retained"},
                    "antenna_coincident_preparations":[{"object_id":"antenna","geometry_id":"gsg","preparation":{"complete":True}}]}}}
        return problem,carrier

    def test_complete_mesh_source_cut_material_world_carrier_and_nonadmission_report(self):
        problem,carrier=self.fixture_mesh();value=preparation.mesh_report(problem,carrier)
        self.assertEqual(value['source_cells'],5);self.assertEqual(len(value['parts']),5)
        self.assertEqual(value['source_cut_face_pairs'],1);self.assertFalse(value['eta_helper_admitted'])
        self.assertTrue(all(row['minimum_volume_m3']>0 and row['minimum_edge_m']>0 for row in value['parts'].values()))
        self.assertEqual(value['carrier_sha256'],preparation.CARRIER_SHA)

    def test_realized_cell_distributions_have_known_lengths_and_volumes(self):
        problem, carrier = self.fixture_mesh()
        report = preparation.mesh_report(problem, carrier)
        for row in report["parts"].values():
            self.assertEqual(set(row["maximum_cell_edge_percentiles_m"]), {"p05", "p50", "p95"})
            for value in row["maximum_cell_edge_percentiles_m"].values():
                self.assertAlmostEqual(value, 2**0.5)
            for value in row["cell_volume_percentiles_m3"].values():
                self.assertAlmostEqual(value, 1/6)

    def test_quantiles_are_linear_over_cells_and_include_singletons(self):
        values = [5., 1., 4., 2., 3.]
        report = preparation.cell_percentiles(values)
        self.assertAlmostEqual(report["p05"], 1.2)
        self.assertAlmostEqual(report["p50"], 3.)
        self.assertAlmostEqual(report["p95"], 4.8)
        self.assertEqual(values, [5., 1., 4., 2., 3.])
        self.assertEqual(preparation.cell_percentiles([7.]), {"p05": 7., "p50": 7., "p95": 7.})

    def test_nonfinite_edge_refuses_even_with_finite_nodes_and_positive_volume(self):
        problem, carrier = self.fixture_mesh()
        carrier = copy.deepcopy(carrier)
        mesh = problem["geometry_assets"]["fem_mesh_assets"][0]["mesh"]
        # The determinant is finite and positive, but the diagonal exceeds float64.
        mesh["nodes"][8:12] = [[0., 0., 0.], [1.3e308, 1.3e308, 0.],
                               [-1e-154, 1e-154, 0.], [0., 0., 1e-154]]
        with self.assertRaisesRegex(BuildControlError, "Nonfinite source edge"):
            preparation.mesh_report(problem, carrier)

    def test_missing_part_overlap_nonpositive_or_carrier_change_refuses(self):
        original,carrier=self.fixture_mesh()
        for change in ('missing','overlap','negative','carrier','graph','cut'):
            problem=copy.deepcopy(original);source=problem['current_modules'][0]['conservative_current_source']
            if change=='missing':source['material_parts'].pop()
            elif change=='overlap':source['material_parts'][0]['element_ordinals']=[1]
            elif change=='negative':problem['geometry_assets']['fem_mesh_assets'][0]['mesh']['cells']['nodes'][:4]=[1,0,2,3]
            elif change=='carrier':problem['geometry_assets']['fem_domain_mesh_asset']['mesh']['nodes'][0][0]=123.
            elif change=='cut':source['closure']['source_cuts'][0]['potential_drop_v']=0.002
            if change!='graph':problem['physics_graph']['modules'][0]['family_payload']=copy.deepcopy(problem['current_modules'][0])
            else:problem['physics_graph']['modules'][0]['family_payload']={}
            with self.subTest(change=change),self.assertRaises(BuildControlError):preparation.mesh_report(problem,carrier)

    def test_final_input_drift_cannot_publish_success(self):
        from types import SimpleNamespace
        output = self.root / ("a" * 32)
        output.mkdir()
        request = {"operation_id": output.name, "level": "50", "schema": "fullmag.gsg-junction-preparation.v1",
                   "controller_sha256": "d" * 64, "backend_build_receipt_sha256": "e" * 64}
        request_path = output / "request.json"
        raw = canonical(request)
        request_path.write_bytes(raw)
        reads = {"receipt": 0}
        original_read = Path.read_bytes
        receipt_path = "/opt/fullmag/package/backend-build-receipt.json"
        package = canonical({"artifacts": [{"path": "bin/fullmag-bin", "sha256": "f" * 64}]})
        def read_bytes(path):
            return package if str(path) == receipt_path else original_read(path)
        def file_pin(path, maximum, **kwargs):
            if str(path) == receipt_path:
                reads["receipt"] += 1
                sha = "0" * 64 if reads["receipt"] == 3 else "e" * 64
            else:
                sha = "f" * 64 if str(path) == preparation.CLI else "d" * 64
            return {"sha256": sha, "bytes": 1}
        def capture(command, directory, environment, *, input_root=None):
            value = self.request_value()
            value["study_problem_catalog"]["entries"] = [{"problem": {}}]
            pretty = canonical(value)
            (directory / "request.pretty.json").write_bytes(pretty)
            return 0, {"request.pretty.json": len(pretty), "stderr.log": 0}, [], 123
        persistence = SimpleNamespace(load_mesh_artifact=lambda *args, **kwargs:
            SimpleNamespace(mesh=SimpleNamespace(to_ir=lambda name: {})))
        with patch.object(preparation, "OUTPUTS", str(self.root)), patch.object(preparation, "FIXED_FILES", {}), \
             patch.object(preparation, "file_pin", side_effect=file_pin), patch.object(Path, "read_bytes", read_bytes), \
             patch.object(preparation, "sync_directories"), patch.object(preparation, "configure_guest_resources", return_value=[0]), \
             patch.object(preparation, "warm_input", return_value=(self.root, {"mesh": {}}, {})), \
             patch.object(preparation, "capture_cli", side_effect=capture), patch.object(preparation, "mesh_report", return_value={}), \
             patch.dict(sys.modules, {"fullmag": SimpleNamespace(), "fullmag.meshing": SimpleNamespace(),
                                      "fullmag.meshing.persistence": persistence}):
            code = preparation.guest(str(request_path), preparation.digest(raw))
        result = json.loads((output / "result.json").read_bytes())
        self.assertEqual(reads["receipt"], 3)
        self.assertEqual(code, 2)
        self.assertEqual(result["exit_code"], 2)
        self.assertTrue(result["child_reaped"])
        self.assertEqual(result["status"], "REFUSED / NOT PREPARED")
        self.assertIn("receipt changed", result["error"])

    def host_run(self,result_factory,qualifications=None,level='50',preflight_error=None):
        args=argparse.Namespace(level=level,source_root=self.root,attempt='b'*32,config_sha256='c'*64)
        pins={'backend_container_id':'d'*64,'backend_build_receipt_sha256':'e'*64}
        configured={'services':{'fem-gpu-toolchain':{'build':{'args':{'FULLMAG_CUDA_BASE_IMAGE':'fixture'}}}}}
        with patch('docker_dev._select_source',return_value=(self.root,{})),patch('docker_dev._compose_identity',return_value={}), \
             patch.object(preparation,'toolchain_configuration',return_value=configured),patch.object(preparation,'BuildControl',Control), \
             patch.object(preparation.reference,'qualified_backend',side_effect=qualifications or [pins,pins,pins]),patch.object(preparation,'docker_capture',side_effect=result_factory), \
             patch.object(preparation,'preflight_inputs',side_effect=preflight_error),patch('builtins.print'):
            return preparation.run(args)

    def test_missing_host_input_never_acquires_an_operation(self):
        with self.assertRaisesRegex(BuildControlError, "missing input"):
            self.host_run(lambda *args, **kwargs: self.fail("guest must not be dispatched"),
                          preflight_error=BuildControlError("missing input"))
        self.assertIsNone(Control.instance.operation_value)

    def test_drift_during_result_journal_write_prevents_commit_and_retains_unknown(self):
        from types import SimpleNamespace
        import docker_volume_reconcile as recovery
        from docker_build_control import ControlOutcomeUnknown
        request = {"schema": preparation.PRESTART_SCHEMA, "attempt": preparation.PRESTART_ATTEMPT,
                   "unknown_receipt_sha256": preparation.PRESTART_RECEIPT,
                   "helper_image": "image", "verified_sha256": None}
        original = canonical({"state": "outcome-unknown-resources-retained"})
        args = SimpleNamespace(preview_sha256=preparation.digest(canonical(request)+b"\n"))
        history = self.root/preparation.PRESTART_HISTORY
        history.parent.mkdir(parents=True); history.write_bytes(b"historical")
        commands = []; saved = {}; drift = [False]
        pipe = SimpleNamespace(closed=False, write=lambda data: commands.append(data), flush=lambda: None)
        pipe.close = lambda: setattr(pipe, "closed", True)
        process = SimpleNamespace(stdin=pipe, poll=lambda: None, wait=lambda timeout: 0)
        lines = iter(["READY", "OBSERVING", "COMMITTED"])
        control = SimpleNamespace(helper_args=lambda *args, **kwargs: ["fixture"], _line=lambda p: next(lines))
        def preview(*args):
            return ({**request, **({"drift": True} if drift[0] else {})}, original)
        def write(control, path, raw):
            saved[path] = raw
            if path.endswith("/result.json"): drift[0] = True
        def read(control, path, *args):
            if path.endswith("/terminal.json"):
                return next(raw for name,raw in saved.items() if name.endswith("/result.json"))
            return None
        with patch.object(preparation, "prestart_preview", side_effect=preview), \
             patch.object(recovery, "write_immutable", side_effect=write), \
             patch.object(recovery, "read_raw", side_effect=read), \
             patch.object(recovery, "claim_script", return_value="claim"), \
             patch.object(recovery, "validate_original_owner"), \
             patch.object(preparation.subprocess, "Popen", return_value=process), \
             patch.object(preparation, "docker_capture", return_value=SimpleNamespace(
                 stdout=canonical([{"State": {"Running": True}}]))), patch("builtins.print"):
            with self.assertRaisesRegex(ControlOutcomeUnknown, "outcome unknown"):
                preparation.close_prestart(args, control, self.root, {})
        self.assertEqual(commands, [b"BEGIN\n"])
        self.assertFalse(any(name.endswith("/terminal.json") for name in saved))

    def test_prestart_probe_rejects_started_tampered_live_or_unreadable_guest(self):
        value = {"files": {"controller.py": {"sha256": preparation.PRESTART_CONTROLLER, "bytes": 56049},
                           "request.json": {"sha256": preparation.PRESTART_REQUEST, "bytes": 1070}},
                 "processes": [], "unreadable": 0, "alias_missing": True, "queue_items": []}
        preparation.validate_prestart_probe(value)
        for change in ("started", "digest", "size", "live", "permission", "bool", "alias", "queue", "unknown"):
            with self.subTest(change=change):
                bad = copy.deepcopy(value)
                if change == "started": bad["files"]["started.json"] = {}
                elif change == "digest": bad["files"]["controller.py"]["sha256"] = "0"*64
                elif change == "size": bad["files"]["request.json"]["bytes"] += 1
                elif change == "live": bad["processes"] = ["91051"]
                elif change == "permission": bad["unreadable"] = 1
                elif change == "bool": bad["unreadable"] = False
                elif change == "alias": bad["alias_missing"] = False
                elif change == "queue": bad["queue_items"] = [{"state": "running"}]
                elif change == "unknown": bad["unknown"] = None
                with self.assertRaises(BuildControlError):
                    preparation.validate_prestart_probe(bad)

    def test_gsg_prestart_commit_is_failure_only_and_schema_scoped(self):
        import docker_volume_reconcile as recovery
        control = type("Paths", (), {"path": staticmethod(lambda p: "/control/"+p)})()
        request = {"attempt": "a"*32, "unknown_receipt_sha256": "b"*64,
                   "schema": "fullmag.gsg-prestart-input-failure.v1"}
        root = "gsg-mesh-preparation/attempts/" + request["attempt"]
        script = recovery.commit_script(control, root, request, "journal", "c"*64, "b"*64,
                                         phase="gsg-mesh-preparation", publish_verified=False)
        self.assertIn("/gsg-mesh-preparation/current.json", script)
        self.assertNotIn("/verified.json", script)
        for schema, verified in (("foreign", False), (request["schema"], True)):
            with self.assertRaises(BuildControlError):
                recovery.commit_script(control, root, {**request, "schema": schema}, "journal",
                                       "c"*64, "b"*64, phase="gsg-mesh-preparation", publish_verified=verified)

    def test_backend_drift_prevents_dispatch(self):
        pins={'backend_container_id':'d'*64,'backend_build_receipt_sha256':'e'*64}
        calls=[]
        with self.assertRaisesRegex(BuildControlError,'Backend changed'):
            self.host_run(lambda *a,**k:calls.append(a),qualifications=[pins,{**pins,'backend_container_id':'f'*64}])
        self.assertEqual(calls,[])
        self.assertFalse(Control.instance.operation_value['daemon_pending'])

    def test_lost_client_retains_pending_and_never_retries(self):
        calls=[]
        def failure(*args,**kwargs):calls.append(args);raise TimeoutError('client lost')
        with self.assertRaises(TimeoutError):self.host_run(failure)
        self.assertEqual(len(calls),1);self.assertTrue(Control.instance.operation_value['daemon_pending'])
        self.assertNotIn('state',Control.instance.operation_value['receipt'])

    def test_absent_reap_proof_after_client_exit_retains_pending(self):
        with self.assertRaisesRegex(BuildControlError,'unknown'):
            self.host_run(lambda *args,**kwargs:argparse.Namespace(returncode=1))
        self.assertTrue(Control.instance.operation_value['daemon_pending'])

    def test_known_failed_preparation_is_terminal_without_retry(self):
        calls=[]
        def failure(*args,**kwargs):
            calls.append(args);control=Control.instance
            root=preparation.OUTPUTS+'/'+('a'*32)
            pin=preparation.digest(control.files[root+'/request.json'])
            control.files[root+'/result.json']=canonical({'schema':'fullmag.gsg-junction-preparation-result.v1',
                'request_sha256':pin,'child_reaped':True,'new_solve':False,'exit_code':2,'status':'REFUSED / NOT PREPARED'})
            return argparse.Namespace(returncode=2)
        self.assertEqual(self.host_run(failure),2)
        self.assertEqual(len(calls),1);self.assertFalse(Control.instance.operation_value['daemon_pending'])
        self.assertEqual(Control.instance.operation_value['receipt']['state'],'failed-confirmed')


    def test_retained_host_receipt_does_not_claim_old_input_validation(self):
        def prepared(*args, **kwargs):
            control = Control.instance
            root = preparation.OUTPUTS + "/" + "a"*32
            request = json.loads(control.files[root + "/request.json"])
            self.assertEqual(request["level"], preparation.RETAINED_LEVEL)
            self.assertNotIn("input_validation_sha256", request)
            control.files[root + "/result.json"] = canonical({
                "schema": "fullmag.gsg-junction-preparation-result.v1",
                "request_sha256": preparation.digest(control.files[root + "/request.json"]),
                "child_reaped": True, "new_solve": False, "exit_code": 0,
                "status": "PREPARED INPUT ONLY / NOT VERIFIED"})
            return argparse.Namespace(returncode=0)
        self.assertEqual(self.host_run(prepared, level=preparation.RETAINED_LEVEL), 0)

    def retained_inventory(self):
        rows = [{"relative_path": "source/" + name, "role": "source", "sha256": pin,
                 "byte_count": 1, "absolute_path": str(Path(preparation.RETAINED_INPUT) / name)}
                for name, pin in preparation.RETAINED_FILES.items()]
        rows.append({"relative_path": "fullmag/runtime/loader.py", "role": "runtime",
                     "sha256": "f"*64, "byte_count": 1, "absolute_path": "/runtime/loader.py"})
        return {"records": rows, "runtime": {"source_bytes": 3, "runtime_bytes": 1},
                "inventory_sha256": "1"*64}

    def test_retained_cli_keeps_cwd_alias_resources_and_never_submits(self):
        command = preparation.cli_command(preparation.RETAINED_LEVEL, "a"*32)
        self.assertEqual(command[2], preparation.RETAINED_INPUT + "/" + preparation.RETAINED_SCRIPT)
        self.assertEqual(command[-1], "--prepare-only")
        self.assertEqual(command[command.index("--project")+1], preparation.PROJECT)
        self.assertEqual(command[command.index("--execution-profile")+1], preparation.PROFILE)
        self.assertEqual(command[command.index("--resources")+1], preparation.RESOURCES)
        self.assertEqual(command[command.index("--idempotency-key")+1],
                         "gsg-retained-corner25-prepare-" + "a"*32)
        for forbidden in ("--api-url", "--submit-only", "run-json"):
            self.assertNotIn(forbidden, command)
        with self.assertRaisesRegex(BuildControlError, "cwd"):
            preparation.cli_command(preparation.RETAINED_LEVEL, "a"*32, input_root="/wrong")
        inventory = preparation.inventory_command(Path(preparation.RETAINED_INPUT), preparation.RETAINED_LEVEL)
        self.assertEqual(inventory[inventory.index("--script")+1], command[2])

    def test_retained_inventory_requires_exact_three_inputs_and_alias_paths(self):
        original = self.retained_inventory()
        preparation.verify_retained_inventory(original, Path(preparation.RETAINED_INPUT))
        for kind in ("script", "cache", "carrier", "missing", "extra", "duplicate", "cwd", "budget"):
            value = copy.deepcopy(original)
            source_rows = [row for row in value["records"] if row["role"] == "source"]
            if kind in ("script", "cache", "carrier"):
                selector = preparation.RETAINED_SCRIPT if kind == "script" else preparation.RETAINED_CACHE if kind == "cache" else preparation.CARRIER
                next(row for row in source_rows if row["relative_path"] == "source/" + selector)["sha256"] = "0"*64
            elif kind == "missing":
                value["records"].remove(source_rows[0])
            elif kind == "extra":
                value["records"].append({"relative_path": "source/unexpected", "role": "source", "sha256": "0"*64,
                                         "byte_count": 1, "absolute_path": preparation.RETAINED_INPUT + "/unexpected"})
            elif kind == "duplicate":
                value["records"].append(copy.deepcopy(source_rows[0]))
            elif kind == "cwd":
                source_rows[0]["absolute_path"] = "/wrong/" + preparation.RETAINED_SCRIPT
            else:
                value["runtime"]["source_bytes"] = 8*1024*1024+1
            with self.subTest(kind=kind), self.assertRaises(BuildControlError):
                preparation.verify_retained_inventory(value, Path(preparation.RETAINED_INPUT))

    def retained_request(self):
        problem, carrier = self.fixture_mesh()
        source = problem["current_modules"][0]["conservative_current_source"]
        source["revision"] = preparation.RETAINED_SOURCE_REVISION
        problem["physics_graph"]["modules"][0]["family_payload"] = copy.deepcopy(problem["current_modules"][0])
        target = problem["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
        target.update(facets={}, mesh_name="fixture", boundary_markers=[], element_markers=[])
        metadata = problem["problem_meta"]["runtime_metadata"]
        metadata.update(output_storage={"output_dir": preparation.RETAINED_STEM + ".zarr",
            "temp_dir": None, "data_format": "zarr", "cleanup": "on_success", "existing_output": "error"},
            output_storage_source_dir=preparation.RETAINED_INPUT,
            output_storage_source_stem=preparation.RETAINED_STEM)
        key = "gsg-retained-corner25-prepare-" + "a"*32
        value = self.request_value()
        value["run_intent"] = {"idempotency_key": key, "specification": {
            "run_id": "run-" + preparation.digest(key.encode()),
            "requested_execution": {"backend": "fem", "device": "cpu", "precision": "double", "mode": "strict",
                "minimum_resources": {"cpu_millis": 1000, "memory_bytes": 4294967296,
                                      "gpu_memory_bytes": 0, "storage_bytes": 536870912}}}}
        value["study_problem_catalog"]["entries"] = [{"problem": problem}]
        report = {"source_vertices": 14194, "source_cells": 40728,
                  "source_mesh_sha256": preparation.RETAINED_MESH_SHA}
        return value, report

    def verify_retained_fixture(self, value, report, operation_id="a"*32):
        problem = value["study_problem_catalog"]["entries"][0]["problem"]
        target = problem["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
        carrier = {key: target[key] for key in ("nodes", "cells", "facets", "mesh_name", "boundary_markers", "element_markers")}
        with patch.object(preparation, "RETAINED_MODULES_SHA", preparation.digest(canonical(problem["current_modules"]))), \
             patch.object(preparation, "RETAINED_CARRIER_SHA", preparation.digest(canonical(carrier))):
            preparation.verify_retained_request(value, report, Path(preparation.RETAINED_INPUT), operation_id)

    def test_retained_request_preserves_storage_identity_and_source(self):
        value, report = self.retained_request()
        before = copy.deepcopy(value)
        self.verify_retained_fixture(value, report)
        self.assertEqual(value, before)
        for kind in ("directory", "stem", "format", "overwrite", "source-dir", "source-stem", "revision", "cells",
                     "mesh", "identity", "run", "device", "resources"):
            changed, changed_report = copy.deepcopy(value), copy.deepcopy(report)
            problem = changed["study_problem_catalog"]["entries"][0]["problem"]
            metadata = problem["problem_meta"]["runtime_metadata"]
            if kind == "directory":metadata["output_storage"]["output_dir"] = "different.zarr"
            elif kind == "stem":metadata["output_storage"]["output_dir"] = "../outside.zarr"
            elif kind == "format":metadata["output_storage"]["data_format"] = "hdf5"
            elif kind == "overwrite":metadata["output_storage"]["existing_output"] = "timestamp"
            elif kind == "source-dir":metadata["output_storage_source_dir"] = "/opt/fullmag/source/examples"
            elif kind == "source-stem":metadata["output_storage_source_stem"] = "old"
            elif kind == "revision":problem["current_modules"][0]["conservative_current_source"]["revision"] = "sha256:"+"0"*64
            elif kind == "cells":changed_report["source_cells"] -= 1
            elif kind == "mesh":changed_report["source_mesh_sha256"] = "0"*64
            elif kind == "identity":changed["run_intent"]["idempotency_key"] += "-retry"
            elif kind == "run":changed["run_intent"]["specification"]["run_id"] = "run-old"
            elif kind == "device":changed["run_intent"]["specification"]["requested_execution"]["device"] = "gpu"
            else:changed["run_intent"]["specification"]["requested_execution"]["minimum_resources"]["cpu_millis"] = 2000
            with self.subTest(kind=kind), self.assertRaises(BuildControlError):
                self.verify_retained_fixture(changed, changed_report)

    def test_retained_request_rejects_changed_current_and_sampling_hashes(self):
        value, report = self.retained_request()
        with patch.object(preparation, "RETAINED_MODULES_SHA", "0"*64), \
             patch.object(preparation, "RETAINED_CARRIER_SHA", "0"*64), self.assertRaises(BuildControlError):
            preparation.verify_retained_request(value, report, Path(preparation.RETAINED_INPUT), "a"*32)
        problem = value["study_problem_catalog"]["entries"][0]["problem"]
        with patch.object(preparation, "RETAINED_MODULES_SHA", preparation.digest(canonical(problem["current_modules"]))), \
             patch.object(preparation, "RETAINED_CARRIER_SHA", "0"*64), self.assertRaisesRegex(BuildControlError, "carrier"):
            preparation.verify_retained_request(value, report, Path(preparation.RETAINED_INPUT), "a"*32)

    def test_retained_guest_uses_only_inventory_prepare_inventory_without_mesher(self):
        from types import SimpleNamespace
        output = self.root / ("a"*32); output.mkdir()
        input_root = self.root / "input"; input_root.mkdir()
        request = {"operation_id": output.name, "level": preparation.RETAINED_LEVEL,
                   "schema": "fullmag.gsg-junction-preparation.v1", "controller_sha256": "d"*64,
                   "backend_build_receipt_sha256": "e"*64}
        raw = canonical(request); path = output / "request.json"; path.write_bytes(raw)
        original_read = Path.read_bytes
        receipt = "/opt/fullmag/package/backend-build-receipt.json"
        package = canonical({"artifacts": [{"path": "bin/fullmag-bin", "sha256": "f"*64}]})
        common = {name: "b"*64 for name in (preparation.PROJECT, preparation.PROFILE, preparation.RESOURCES)}
        frozen = {str(input_root/name): pin for name, pin in preparation.RETAINED_FILES.items()}
        def pin(path, maximum, **kwargs):
            name = str(path)
            sha = "e"*64 if name == receipt else "f"*64 if name == preparation.CLI else frozen.get(name, common.get(name, "d"*64))
            return {"sha256": sha, "bytes": 1}
        calls = []
        with patch.object(preparation, "RETAINED_INPUT", str(input_root)):
            inventory = self.retained_inventory()
        def capture(command, directory, environment, *, input_root):
            calls.append((command, input_root))
            value = self.request_value(); value["study_problem_catalog"]["entries"] = [{"problem": {}}]
            pretty = canonical(value); (directory/"request.pretty.json").write_bytes(pretty)
            return 0, {"request.pretty.json": len(pretty), "stderr.log": 0}, [], 123
        persistence = SimpleNamespace(load_mesh_artifact=lambda *args, **kwargs:
            SimpleNamespace(mesh=SimpleNamespace(to_ir=lambda name: {})))
        with patch.object(preparation, "OUTPUTS", str(self.root)), \
             patch.object(preparation, "RETAINED_INPUT", str(input_root)), \
             patch.object(preparation, "FIXED_FILES", common), \
             patch.object(preparation, "file_pin", side_effect=pin), \
             patch.object(Path, "read_bytes", lambda p: package if str(p) == receipt else original_read(p)), \
             patch.object(preparation, "configure_guest_resources", return_value=[0]), \
             patch.object(preparation, "sync_directories"), \
             patch.object(preparation, "warm_input", side_effect=AssertionError("new mesh forbidden")) as warm, \
             patch.object(preparation, "produce_mesh", side_effect=AssertionError("Gmsh forbidden")) as mesher, \
             patch.object(preparation, "capture_cli", side_effect=capture), \
             patch.object(preparation, "preparation_phase", return_value={"capture": inventory}) as phases, \
             patch.object(preparation, "mesh_report", return_value={}), \
             patch.object(preparation, "verify_retained_request") as verified, \
             patch.dict(sys.modules, {"fullmag": SimpleNamespace(), "fullmag.meshing": SimpleNamespace(),
                                      "fullmag.meshing.persistence": persistence}):
            code = preparation.guest(str(path), preparation.digest(raw))
        self.assertEqual(code, 0); warm.assert_not_called(); mesher.assert_not_called()
        self.assertEqual([call.args[3] for call in phases.call_args_list], ["inventory-before", "inventory-final"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], input_root)
        self.assertEqual(calls[0][0][-1], "--prepare-only")
        verified.assert_called_once()
        self.assertFalse(json.loads((output/"result.json").read_bytes())["new_solve"])


    def test_edges92_cli_uses_pinned_input_without_execution(self):
        command = preparation.cli_command("retained-edges92", "a"*32)
        self.assertEqual(command[2], "/opt/fullmag/script-output/sushruth_2020_closed_gsg/edge_field_20261111/input/fem_antenna_gsg_edges92_h_only.py")
        self.assertEqual(command[-1], "--prepare-only")
        self.assertEqual(command[command.index("--idempotency-key")+1],
                         "gsg-retained-edges92-prepare-"+"a"*32)
        with self.assertRaisesRegex(BuildControlError, "cwd"):
            preparation.cli_command("retained-edges92", "a"*32, input_root="/wrong")

    def test_edges92_inventory_is_exact_and_excludes_mesh_cache(self):
        root = Path(preparation.H_ONLY_INPUT)
        rows = [{"relative_path":"source/"+name, "role":"source", "sha256":pin,
                 "byte_count":1, "absolute_path":str(root/name)}
                for name,pin in preparation.H_ONLY_FILES.items()]
        inventory = {"records":rows,"runtime":{"source_bytes":len(rows)}}
        preparation.verify_h_only_inventory(inventory,root)
        for field in ("sha256","absolute_path"):
            value=copy.deepcopy(inventory);value["records"][0][field]="wrong"
            with self.subTest(field=field),self.assertRaises(BuildControlError):
                preparation.verify_h_only_inventory(value,root)
        value=copy.deepcopy(inventory);value["records"].append(copy.deepcopy(rows[0]))
        with self.assertRaises(BuildControlError):
            preparation.verify_h_only_inventory(value,root)
        self.assertFalse(any("cache" in name for name in preparation.H_ONLY_FILES))



    def test_h_only_inventory_accepts_the_approved_target_design_sibling(self):
        root=Path(preparation.H_ONLY_INPUT)
        files=dict(preparation.H_ONLY_FILES)
        files["edge-targets.json"]="634ff9c5167ddb508202504881cd571021fd936b20afe49c2148af685cf2edde"
        rows=[{"relative_path":"source/"+name,"role":"source","sha256":pin,"byte_count":1,
               "absolute_path":str(root/name)} for name,pin in files.items()]
        preparation.verify_h_only_inventory({"records":rows,"runtime":{"source_bytes":len(rows)}},root)
        rows[-1]["sha256"]="0"*64
        with self.assertRaises(BuildControlError):
            preparation.verify_h_only_inventory({"records":rows,"runtime":{"source_bytes":len(rows)}},root)

    def h_only_request(self):
        source = {"kind":"retained_preparation_asset","schema_version":"retained_preparation_asset_source.v1",
                  "object_id":"antenna","geometry_id":"fixture",
                  "preparation_asset":{"asset_id":"script-file-"+preparation.digest(b"source/gsg-source-preparation.json"),
                       "content_sha256":preparation.H_ONLY_FILES["gsg-source-preparation.json"]},
                  "historical_prepared_source":{"object_id":"antenna","geometry_id":"fixture"},
                  "historical_preparation":{"source_cells":40728},"authored_closure":{"schema_version":"structured_current_closure.v2"}}
        current = {"name":"gsg_charge","model":"ohmic_poisson","coupling":"one_way",
                   "boundaries":[], "conservative_current_source":source}
        carrier = {"nodes":[[float(i),0.,-1.] for i in range(92)],
                   "cells":{"types":["tet4"]*132,"offsets":list(range(0,529,4)),"nodes":[0,1,2,3]*132}}
        policy = {"policy_version":"caller_supplied_rt0_surface.inspection.v1","limits":{"total":[1]},"tolerances":{}}
        stage = {"id":"inspect_gsg_edges92","source_object_id":"antenna","current_transport_id":"gsg_charge",
                 "oersted_realization":"analytic_rt0_surface","retained_current_source":preparation.H_ONLY_LOCATOR,
                 "retained_source_preparation":source["preparation_asset"],"surface_field_policy":policy}
        metadata = {"output_storage":{"output_dir":preparation.H_ONLY_STEM+".zarr","temp_dir":None,
                    "data_format":"zarr","cleanup":"on_success","existing_output":"error"},
                    "output_storage_source_dir":preparation.H_ONLY_INPUT,"output_storage_source_stem":preparation.H_ONLY_STEM}
        key="gsg-retained-edges92-prepare-"+"a"*32
        value={"run_intent":{"idempotency_key":key,"specification":{"run_id":"run-"+preparation.digest(key.encode()),
            "requested_execution":{"backend":"fem","device":"cpu","mode":"strict","precision":"double",
             "minimum_resources":{"cpu_millis":1000,"memory_bytes":4294967296,"gpu_memory_bytes":0,"storage_bytes":536870912}}}},
            "study_problem_catalog":{"entries":[{"problem":{"backend_policy":{"requested_backend":"fem","execution_precision":"double"},
             "validation_profile":{"execution_mode":"strict"},"study":{"kind":"antenna_field_solve","selection":{"port_mode_id":"gsg_port","stage_id":"inspect_gsg_edges92"}},
             "antenna_field_solve_stages":[stage],"current_modules":[current],
             "physics_graph":{"modules":[{"kind":"current_transport","family_payload":copy.deepcopy(current)}]},
             "geometry_assets":{"fem_domain_mesh_asset":{"mesh":copy.deepcopy(carrier)}},
             "problem_meta":{"runtime_metadata":metadata}}}]}}
        del value["study_problem_catalog"]["entries"][0]["problem"]["physics_graph"]["modules"][0]["family_payload"]["boundaries"]
        return value,carrier

    def verify_h_only_fixture(self,value,carrier):
        import struct
        baseline,_=self.h_only_request()
        problem=baseline["study_problem_catalog"]["entries"][0]["problem"]
        stage=problem["antenna_field_solve_stages"][0]
        source=problem["current_modules"][0]["conservative_current_source"]
        pins={"H_ONLY_PREPARED_SHA":preparation.digest(canonical(source["historical_prepared_source"])),
              "H_ONLY_PREPARATION_SHA":preparation.digest(canonical(source["historical_preparation"])),
              "H_ONLY_CLOSURE_SHA":preparation.digest(canonical(source["authored_closure"])),
              "H_ONLY_POLICY_SHA":preparation.digest(canonical(stage["surface_field_policy"])),
              "H_ONLY_POSITIONS_SHA":preparation.digest(b"".join(struct.pack("<3d",*p) for p in carrier["nodes"]))}
        with patch.multiple(preparation,**pins):
            return preparation.verify_h_only_request(value,carrier,Path(preparation.H_ONLY_INPUT),"a"*32)

    def test_h_only_request_authenticates_frozen_projection_and_storage(self):
        value,carrier=self.h_only_request()
        result=self.verify_h_only_fixture(value,carrier)
        self.assertEqual(result["source_cells"],40728)
        self.assertEqual(result["target_count"],92)
        self.assertTrue(result["reused_source_preparation"])
        self.assertEqual(result["charge_solve_count"],0)
        for kind in ("parent","policy","asset","legacy","realization","current-kind","graph","new-mesh",
                     "targets","cells","storage","run","resource","extra-stage","study","selection","boundaries"):
            changed=copy.deepcopy(value)
            problem=changed["study_problem_catalog"]["entries"][0]["problem"]
            stage=problem["antenna_field_solve_stages"][0]
            if kind=="parent":
                stage["retained_current_source"]=dict(preparation.H_ONLY_LOCATOR,run_id="foreign")
            elif kind=="policy":stage["surface_field_policy"]={"changed":True}
            elif kind=="asset":stage["retained_source_preparation"]={"asset_id":"foreign"}
            elif kind=="legacy":stage["conservative_current_view_ref"]="legacy"
            elif kind=="realization":stage["oersted_realization"]="direct_tetra_quadrature"
            elif kind=="current-kind":problem["current_modules"][0]["conservative_current_source"]["kind"]="closed_geometry_potential_jump"
            elif kind=="graph":problem["physics_graph"]["modules"][0]["family_payload"]={}
            elif kind=="new-mesh":problem["problem_meta"]["runtime_metadata"]["antenna_coincident_preparations"]=[{}]
            elif kind=="targets":problem["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]["nodes"][0][0]=999.
            elif kind=="cells":problem["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]["cells"]["nodes"][0]=7
            elif kind=="storage":problem["problem_meta"]["runtime_metadata"]["output_storage"]["existing_output"]="replace"
            elif kind=="run":changed["run_intent"]["specification"]["run_id"]="different"
            elif kind=="resource":changed["run_intent"]["specification"]["requested_execution"]["minimum_resources"]["cpu_millis"]=2000
            elif kind=="study":problem["study"]["kind"]="relax"
            elif kind=="selection":problem["study"]["selection"]["stage_id"]="other"
            elif kind=="boundaries":problem["current_modules"][0]["boundaries"]=[{"foreign":"condition"}]
            else:problem["antenna_field_solve_stages"].append(copy.deepcopy(stage))
            with self.subTest(kind=kind),self.assertRaises(BuildControlError):
                self.verify_h_only_fixture(changed,carrier)



class RetainedPreparationShellTests(unittest.TestCase):
    def invoke_wrapper(self, level, suffix=""):
        import os
        import subprocess
        import tempfile
        root = Path(__file__).resolve().parent.parent
        with tempfile.TemporaryDirectory() as directory:
            recorder = Path(directory) / "python-recorder"
            recorder.write_text(chr(10).join(("#!" + sys.executable, "import json, sys",
                "if sys.argv[1:2] == [\'-c\']: assert sys.version_info.major == 3",
                "else: print(json.dumps(sys.argv[1:]))", "")))
            recorder.chmod(0o700)
            body = (f'python3 "{root}/scripts/docker_gsg_mesh_preparation.py" '
                    f"--source-root '{root}' --attempt '" + "a"*32
                    + "' --config-sha256 '" + "b"*64 + "' --level '" + level + "'" + suffix)
            return subprocess.run(["bash", str(root/"scripts/just_storage_shell.sh"), body],
                env=dict(os.environ, FULLMAG_STORAGE_PYTHON=str(recorder)),
                capture_output=True, text=True, timeout=10)

    def test_explicit_retained_level_reaches_only_the_fixed_controller(self):
        result = self.invoke_wrapper("retained-corner25")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(result.stdout)
        self.assertTrue(args[1].endswith("/scripts/docker_gsg_mesh_preparation.py"))
        self.assertEqual(args[-2:], ["--level", "retained-corner25"])

    def test_unknown_or_composed_level_is_rejected_before_controller(self):
        for level, suffix in (("retained-corner26", ""), ("../retained-corner25", ""),
                              ("retained-corner25", "; echo SHOULD_NOT_EXECUTE")):
            result = self.invoke_wrapper(level, suffix)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertNotIn("SHOULD_NOT_EXECUTE", result.stdout)
            self.assertIn("invalid GSG mesh preparation recipe", result.stderr)


if __name__=='__main__':unittest.main()
