"""Interpreted admission/reaping checks; no Docker, native library or H."""
import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import docker_gsg_reference as legacy
from docker_build_control import BuildControlError, canonical
try:
    import docker_gsg_surface_reference as surface
except ModuleNotFoundError:
    surface = None


class AvailabilityTests(unittest.TestCase):
    def test_private_surface_controller_is_available(self):
        self.assertIsNotNone(surface, "The approved private surface controller is missing")


class Control:
    project = "test-project"

    def __init__(self):
        self.files = {}
        self.operations = []

    def read_bytes(self, name, optional=False):
        if name not in self.files and not optional:
            raise BuildControlError("Missing test control input: " + name)
        return self.files.get(name)

    def write_bytes(self, name, raw):
        self.files[name] = raw

    @contextmanager
    def operation(self, phase, inputs):
        operation = dict(root="gsg-reference/attempts/test", receipt={}, daemon_pending=False,
                         logger=argparse.Namespace(stdin=io.BytesIO()))
        self.operations.append((phase, inputs, operation))
        yield operation


@unittest.skipIf(surface is None, "controller not implemented yet")
class ManagedSurfaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.selected = Path(self.temp.name).resolve()
        (self.selected / "tools").mkdir()
        (self.selected / "tools" / surface.DRIVER).write_text("# pinned private probe\n")
        for name in surface.NATIVE_SOURCES:
            path = self.selected / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("// pinned native source\n")
        actual = Path(__file__).resolve().parents[1] / surface.POLICY_PATH
        policy = self.selected / surface.POLICY_PATH
        policy.parent.mkdir(parents=True, exist_ok=True)
        policy.write_bytes(actual.read_bytes())
        self.control = Control()
        self.pins = dict(backend_container_id="a"*64, compose_project="test-project",
            backend_build_receipt_sha256="b"*64, backend_provenance_sha256="c"*64,
            api_binary_sha256="d"*64)
        self.binding = dict(library_sha256="e"*64, source_manifest_sha256="f"*64)
        self.args = argparse.Namespace(mode="surface-native-preflight", request_sha256="",
            attempt="1"*32, config_sha256="2"*64)

    def prepare_request(self):
        driver, sources, policy = surface.source_files(self.selected)
        request = surface.make_request(self.pins, driver, sources, policy, self.binding)
        raw = canonical(request) + b"\n"
        return request, raw, legacy.sha(raw)

    def preflight_value(self, request, digest):
        return dict(status="PREFLIGHT PASS", request_sha256=digest, native_evaluations=0,
            new_solve=False, packing=dict(frozen_sha256=request["scope"]["frozen_sha256"],
            source_cells=85980, vertices=23263, canonical_faces=188926),
            library_binding=dict(library_sha256=request["library_sha256"]))

    def worker_proof(self, digest, *, mode="run", code=0, **extra):
        return dict(schema="fullmag.gsg-surface-native-worker-exit.v1", mode=mode,
            request_sha256=digest, exit_code=code, child_reaped=True,
            source_inputs_stable=True, new_solve=False, **extra)

    def execute(self):
        with patch.object(surface, "qualified_backend", return_value=self.pins) as qualify, \
             patch.object(surface, "package_binding", return_value=self.binding), \
             patch.object(surface, "sync_prepared"), patch("builtins.print"):
            code = surface.execute(self.control, self.selected, {}, self.args)
        self.assertTrue(all(call.kwargs.get("allow_no_archive") is True for call in qualify.call_args_list))
        return code

    def test_preflight_creates_immutable_snapshot_without_consuming_native_fence(self):
        request, raw, digest = self.prepare_request()
        root = surface.snapshot_root(digest)
        nonce = legacy.sha(b"gsg-reference/attempts/test")
        self.control.files[root + "/preflight-worker-exit-"+nonce+".json"] = canonical(self.worker_proof(digest, mode="preflight",proof_nonce=nonce))
        result = argparse.Namespace(returncode=0, stdout=canonical(self.preflight_value(request,digest)), stderr=b"")
        with patch.object(surface, "docker_capture", return_value=result), patch.object(surface,"attached") as attached:
            self.assertEqual(self.execute(),0)
        attached.assert_not_called()
        self.assertEqual(self.control.files[root + "/request.json"],raw)
        self.assertIn(root + "/prepared/" + surface.DRIVER,self.control.files)
        self.assertIn(root + "/preflight.json",self.control.files)
        self.assertNotIn(surface.ROOT + "/started.json",self.control.files)
        self.assertFalse(self.control.operations[-1][2]["daemon_pending"])
        self.assertEqual(self.control.operations[-1][0],"gsg-reference")
        self.assertFalse(any(name.startswith(legacy.ROOT + "/") for name in self.control.files))

    def test_preflight_sha_drift_refuses_before_child_dispatch(self):
        _,_,digest = self.prepare_request()
        self.args.request_sha256 = digest
        (self.selected / "tools" / surface.DRIVER).write_text("# corrected decoder\n")
        with patch.object(surface,"docker_capture") as capture, self.assertRaisesRegex(BuildControlError,"request differs"):
            self.execute()
        capture.assert_not_called()

    def test_started_global_refuses_every_mode_without_dispatch(self):
        self.control.files[surface.ROOT + "/started.json"] = b"{}"
        for mode in ("surface-native-preflight","surface-native-run"):
            self.args.mode = mode
            _,_,self.args.request_sha256 = self.prepare_request()
            with self.subTest(mode=mode), patch.object(surface,"docker_capture") as capture, \
                 patch.object(surface,"attached") as attached, self.assertRaisesRegex(BuildControlError,"already started"):
                self.execute()
            capture.assert_not_called();attached.assert_not_called()

    def test_run_requires_retained_matching_preflight(self):
        self.args.mode = "surface-native-run"
        _,_,self.args.request_sha256 = self.prepare_request()
        with patch.object(surface,"attached") as attached, self.assertRaisesRegex(BuildControlError,"successful preflight"):
            self.execute()
        attached.assert_not_called()

    def test_preflight_other_request_or_native_evaluation_refuses(self):
        request,_,digest = self.prepare_request()
        for key,value in [("request_sha256","1"*64),("native_evaluations",1)]:
            proof = self.preflight_value(request,digest);proof[key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                surface.preflight_record(proof,digest,request)

    def test_run_requires_request_pin_before_any_preparation(self):
        self.args.mode = "surface-native-run"
        with self.assertRaisesRegex(BuildControlError,"request SHA"):
            self.execute()
        self.assertEqual(self.control.operations,[])

    def test_attached_unknown_worker_keeps_daemon_pending(self):
        operation = dict(receipt={},daemon_pending=False,logger=argparse.Namespace(stdin=io.BytesIO()))
        process = argparse.Namespace(stdout=io.BytesIO(b"progress\n"),wait=lambda:1)
        with patch.object(surface.subprocess,"Popen",return_value=process), \
             patch.object(surface,"docker_argv",return_value=["docker","exec"]), \
             self.assertRaisesRegex(BuildControlError,"not confirmed"):
            surface.attached(self.control,operation,"a"*64,"b"*64)
        self.assertTrue(operation["daemon_pending"])
        self.assertEqual(operation["logger"].stdin.getvalue(),b"progress\n")

    def test_only_exact_reaped_exit_releases_pending(self):
        digest = "b"*64
        for changed in ({"request_sha256":"c"*64},{"exit_code":2},{"child_reaped":False},{}):
            operation = dict(receipt={},daemon_pending=False,logger=argparse.Namespace(stdin=io.BytesIO()))
            proof = self.worker_proof(digest,code=1);proof.update(changed)
            self.control.files[surface.snapshot_root(digest)+"/worker-exit.json"] = canonical(proof)
            self.control.files[surface.snapshot_root(digest)+"/result.json"] = canonical(dict(
                status="REFUSED",request_sha256=digest,native_evaluations=1,native_status=-3,
                private_numerical_probe=True,accepted_parent_verified=False,inspection_only=True,
                error_certificate_available=False,new_solve=False,qualified_basis=False))
            process = argparse.Namespace(stdout=io.BytesIO(),wait=lambda:1)
            with self.subTest(changed=changed),patch.object(surface.subprocess,"Popen",return_value=process), \
                 patch.object(surface,"docker_argv",return_value=["docker","exec"]):
                if changed:
                    with self.assertRaises(BuildControlError):surface.attached(self.control,operation,"a"*64,digest)
                    self.assertTrue(operation["daemon_pending"])
                else:
                    self.assertEqual(surface.attached(self.control,operation,"a"*64,digest)[0],1)
                    self.assertFalse(operation["daemon_pending"])

    def test_wrong_or_duplicate_package_library_artifact_refuses(self):
        import docker_dev_codegen as codegen
        for artifacts in ([],[{"path":"bin/fullmag-api","sha256":"e"*64}],
                          [{"path":"lib/libfullmag_fem.so","sha256":"e"*64}]*2):
            receipt = dict(source=dict(manifest_sha256="f"*64),artifacts=artifacts)
            with self.subTest(artifacts=artifacts), \
                 patch.object(codegen,"_backend_documents",return_value=(receipt,{},"b"*64,"c"*64+":"+"d"*64)), \
                 patch.object(codegen,"_validate_backend",return_value=({},"c"*64,"d"*64)), \
                 self.assertRaisesRegex(BuildControlError,"FEM library artifact"):
                surface.package_binding("a"*64,self.pins)

    def test_package_receipt_drift_refuses(self):
        import docker_dev_codegen as codegen
        receipt = dict(source=dict(manifest_sha256="f"*64),artifacts=[dict(path="lib/libfullmag_fem.so",sha256="e"*64)])
        with patch.object(codegen,"_backend_documents",return_value=(receipt,{},"1"*64,"c"*64+":"+"d"*64)), \
             patch.object(codegen,"_validate_backend",return_value=({},"c"*64,"d"*64)), \
             self.assertRaisesRegex(BuildControlError,"receipt"):
            surface.package_binding("a"*64,self.pins)

    def test_new_dispatch_does_not_change_old_controller_bytes(self):
        text = (Path(__file__).parent / "docker_gsg_reference.py").read_text()
        insert = ('    if args.mode in ("surface-native-preflight", "surface-native-run"):\n'
                  '        import docker_gsg_surface_reference\n'
                  '        return docker_gsg_surface_reference.execute(control, selected, identity, args)\n')
        restored = text.replace(insert,"").replace(', "surface-native-preflight", "surface-native-run"','')
        self.assertEqual(hashlib.sha256(restored.encode()).hexdigest(),"5207e9f2b20e5683dddd80d0ddedf47f6377da04c5dfa4b45f866b275a90b481")

    def test_failed_preflight_can_repeat_same_request_with_new_operation_proof(self):
        driver = self.selected / "tools" / surface.DRIVER
        driver.write_text("from pathlib import Path\nimport sys\n"
            "marker=Path(__file__).parent/'fixture-first-preflight'\n"
            "seen=marker.exists();marker.touch()\nsys.exit(0 if seen else 2)\n")
        request, _, digest = self.prepare_request()
        physical = self.selected / "control"
        real_run = subprocess.run

        def capture(*args, **kwargs):
            for name, raw in list(self.control.files.items()):
                if name.startswith(surface.ROOT + "/"):
                    path = physical / name[len(surface.ROOT)+1:]
                    path.parent.mkdir(parents=True,exist_ok=True)
                    if not path.exists():path.write_bytes(raw)
            index = args.index("-c")
            command = [sys.executable,"-B","-c",args[index+1].replace(surface.GLOBAL_ROOT,str(physical)),*args[index+2:]]
            result = real_run(command,capture_output=True,timeout=5)
            for path in physical.rglob("*.json"):
                self.control.files[surface.ROOT+"/"+path.relative_to(physical).as_posix()] = path.read_bytes()
            if result.returncode == 0:
                result.stdout = canonical(self.preflight_value(request,digest))
            return result

        original_operation = self.control.operation
        @contextmanager
        def unique_operation(phase, inputs):
            with original_operation(phase,inputs) as operation:
                operation["root"] += "-"+str(len(self.control.operations))
                yield operation

        with patch.object(self.control,"operation",side_effect=unique_operation), \
             patch.object(surface,"docker_capture",side_effect=capture):
            self.assertEqual(self.execute(),2)
            old = dict(self.control.files)
            self.assertEqual(self.execute(),0)
        self.assertTrue(all(self.control.files[name] == raw for name,raw in old.items()))
        proofs = [name for name in self.control.files if "/preflight-worker-exit-" in name]
        self.assertEqual(len(proofs),2)
        self.assertEqual(len({json.loads(self.control.files[name])["proof_nonce"] for name in proofs}),2)
        self.assertIn(surface.snapshot_root(digest)+"/preflight.json",self.control.files)
        self.assertFalse(any(operation["daemon_pending"] for _,_,operation in self.control.operations))
        self.assertNotIn(surface.ROOT+"/started.json",self.control.files)

    def test_wrong_preflight_proof_nonce_keeps_pending(self):
        digest, nonce = "a"*64, "b"*64
        operation = dict(daemon_pending=True)
        proof = self.worker_proof(digest,mode="preflight",proof_nonce="c"*64)
        self.control.files[surface.snapshot_root(digest)+"/preflight-worker-exit-"+nonce+".json"] = canonical(proof)
        with self.assertRaises(BuildControlError):
            surface.worker_exit(self.control,operation,digest,"preflight",0,nonce)
        self.assertTrue(operation["daemon_pending"])

    def test_success_refuses_empty_binary_precision_record(self):
        value = self.successful_result("b"*64)
        value["native_evidence"]["targets"][0]["precisions"][0] = {}
        with self.assertRaises(BuildControlError):surface.require_result(value,"b"*64,0)

    def successful_result(self, digest):
        return dict(status="SUCCEEDED",request_sha256=digest,native_evaluations=1,native_status=0,
            private_numerical_probe=True,accepted_parent_verified=False,inspection_only=True,
            error_certificate_available=False,new_solve=False,qualified_basis=False,
            comparisons=[dict(target_index=i,within_gate=True) for i in (0,8,16)],
            native_evidence=dict(targets=[dict(binary64_requires_highprecision=False,precisions=[dict(
                evaluated=True,refusal_reason="",h_xyz_apm=["0"]*3,whole_h_xyz_apm=["0"]*3,
                sum_local_norm_apm="1",cancellation="1",maximum_face_cancellation="1") for p in range(3)]) for t in range(3)]))

    def test_success_requires_three_comparisons_and_nine_precision_reports(self):
        digest = "b"*64
        surface.require_result(self.successful_result(digest),digest,0)
        for mutate in (lambda r:r["comparisons"].pop(),
                       lambda r:r["native_evidence"]["targets"][1]["precisions"].pop(),
                       lambda r:r["native_evidence"]["targets"][0]["precisions"][2].update(evaluated=False),
                       lambda r:r.update(accepted_parent_verified=True)):
            value = self.successful_result(digest);mutate(value)
            with self.assertRaises(BuildControlError):surface.require_result(value,digest,0)

    def test_binary_refusal_keeps_complete_shape_and_requires_reason_and_fallback(self):
        digest = "b"*64
        value = self.successful_result(digest)
        target = value["native_evidence"]["targets"][0]
        target["binary64_requires_highprecision"] = True
        binary = target["precisions"][0]
        binary.update(evaluated=False,refusal_reason="binary64 numeric refusal",
            h_xyz_apm=[""]*3,whole_h_xyz_apm=[""]*3,sum_local_norm_apm="",
            cancellation="",maximum_face_cancellation="")
        surface.require_result(value,digest,0)
        for name in binary:
            broken = json.loads(json.dumps(value))
            del broken["native_evidence"]["targets"][0]["precisions"][0][name]
            with self.subTest(missing=name),self.assertRaises(BuildControlError):
                surface.require_result(broken,digest,0)
        for reason,fallback in [("",True),("   ",True),("numeric refusal",False)]:
            broken = json.loads(json.dumps(value))
            broken["native_evidence"]["targets"][0]["binary64_requires_highprecision"] = fallback
            broken["native_evidence"]["targets"][0]["precisions"][0]["refusal_reason"] = reason
            with self.subTest(reason=reason,fallback=fallback),self.assertRaises(BuildControlError):
                surface.require_result(broken,digest,0)

    def worker_fixture(self, driver):
        root = self.selected / "control"
        request = dict(driver_sha256=legacy.sha(driver))
        raw = canonical(request)+b"\n";digest = legacy.sha(raw)
        snapshot = root/"snapshots"/digest
        (snapshot/"prepared").mkdir(parents=True)
        (snapshot/"request.json").write_bytes(raw)
        (snapshot/"prepared"/surface.DRIVER).write_bytes(driver)
        return root,snapshot,digest,surface.WORKER.replace(surface.GLOBAL_ROOT,str(root))

    def test_worker_signal_exit_code_matches_reaped_proof(self):
        root,snapshot,digest,worker = self.worker_fixture(b"import os,signal\nos.kill(os.getpid(),signal.SIGTERM)\n")
        result = subprocess.run([sys.executable,"-B","-c",worker,digest,"preflight","f"*64],capture_output=True)
        self.assertEqual(result.returncode,143,result.stderr)
        proof = json.loads((snapshot/("preflight-worker-exit-"+"f"*64+".json")).read_bytes())
        self.assertEqual(proof["exit_code"],result.returncode)
        self.assertEqual(proof["child_exit_code"],-15)
        self.assertTrue(proof["child_reaped"])
        self.assertFalse((root/"started.json").exists())

    def test_worker_timeout_terminates_only_own_fixture_child_and_reaps(self):
        root,snapshot,digest,worker = self.worker_fixture(b"import time\ntime.sleep(10)\n")
        worker = worker.replace("timeout=1800 if mode=='preflight' else 7350","timeout=0.05")
        result = subprocess.run([sys.executable,"-B","-c",worker,digest,"preflight","f"*64],capture_output=True,timeout=5)
        self.assertEqual(result.returncode,124,result.stderr)
        proof = json.loads((snapshot/("preflight-worker-exit-"+"f"*64+".json")).read_bytes())
        self.assertTrue(proof["timed_out"] and proof["child_reaped"])
        self.assertEqual(proof["exit_code"],124)
        self.assertEqual(proof["child_exit_code"],-15)
        self.assertFalse((root/"started.json").exists())

    def test_worker_preflight_reaps_fixture_child_without_global_started(self):
        root = self.selected / "control"
        driver = b"print('fixture preflight; no H')\n"
        request = dict(driver_sha256=legacy.sha(driver))
        raw = canonical(request)+b"\n";digest = legacy.sha(raw)
        snapshot = root/"snapshots"/digest
        (snapshot/"prepared").mkdir(parents=True)
        (snapshot/"request.json").write_bytes(raw)
        (snapshot/"prepared"/surface.DRIVER).write_bytes(driver)
        worker = surface.WORKER.replace(surface.GLOBAL_ROOT,str(root))
        result = subprocess.run([sys.executable,"-B","-c",worker,digest,"preflight","f"*64],capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        proof = json.loads((snapshot/("preflight-worker-exit-"+"f"*64+".json")).read_bytes())
        self.assertTrue(proof["child_reaped"])
        self.assertEqual(proof["request_sha256"],digest)
        self.assertFalse((root/"started.json").exists())
        self.assertFalse((root/"launch.json").exists())

if __name__ == "__main__":
    unittest.main()
