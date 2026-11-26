"""Interpreted checks of the single-attempt managed GSG postprocessor."""
import argparse
from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import docker_gsg_reference as reference
from docker_build_control import BuildControlError, canonical


class Control:
    def __init__(self):
        self.files = {}
        self.operations = []
        self.project = "test-project"

    def read_bytes(self, path, optional=False):
        if path not in self.files and not optional:
            raise BuildControlError("Missing test control input")
        return self.files.get(path)

    def write_bytes(self, path, raw):
        self.files[path] = raw

    @contextmanager
    def operation(self, phase, inputs):
        value = {"receipt": {}, "root": "gsg-reference/attempts/test", "daemon_pending": False,
                 "logger": argparse.Namespace(stdin=io.BytesIO())}
        self.operations.append((phase, inputs, value))
        yield value


class BackendPreparationAdmissionTests(unittest.TestCase):
    def admit(self, *, standalone=False, archive=None, health="healthy", foreign=False):
        from contextlib import ExitStack
        from types import SimpleNamespace
        source = Path("/registered-source")
        backend = "a" * 64
        document = {"name": "test-project", "services": {"backend": {"environment": {}}}}
        terminal = {"compose_project": "test-project", "inputs": {"source_root": str(source), "image_id": "sha256:" + "b" * 64}}
        control = SimpleNamespace(project="test-project", volume="test-volume", namespace="",
            read=lambda path: document if path.endswith("compose.json") else terminal)
        observed = {"Id": backend, "Image": terminal["inputs"]["image_id"],
                    "State": {"StartedAt": "2026-11-11T00:00:00Z", "Health": {"Status": health}}}
        with ExitStack() as stack:
            for name, value in [
                ("docker_volume_activate._linked_runtime_terminals", [terminal]),
                ("docker_volume_activate._validate_running_group", ("f" * 64 if foreign else backend,)),
                ("docker_dev_codegen._running_service", (backend, observed)),
                ("docker_readonly_result_archive.validate_document", archive),
                ("docker_dev_codegen._environment", {}),
                ("docker_dev_codegen._mount_for", {"Name": control.volume}),
                ("docker_dev_codegen._inspect_named_volume", {}),
                ("docker_dev_codegen._validate_control_mount_subpath", None),
                ("docker_dev_codegen._backend_documents", (None, None, "c" * 64, None)),
                ("docker_dev_codegen._validate_backend", ("source", "d" * 64, "e" * 64)),
            ]:
                stack.enter_context(patch(name, return_value=value))
            return reference.qualified_backend(control, source, {}, "1" * 32,
                reference.sha(canonical(document)), **({"allow_no_archive": True} if standalone else {}))

    def test_standalone_preparation_allows_absent_archive_after_normal_backend_validation(self):
        value = self.admit(standalone=True)
        self.assertIsNone(value["archive_manifest_sha256"])
        self.assertEqual(value["api_binary_sha256"], "e" * 64)

    def test_reference_route_still_requires_approved_archive(self):
        with self.assertRaisesRegex(BuildControlError, "Approved read-only result archive"):
            self.admit()

    def test_standalone_never_ignores_foreign_archive_or_backend(self):
        for kwargs in ({"archive": {"manifest_sha256": "f" * 64, "request_sha256": "e" * 64}},
                       {"health": "unhealthy"}, {"foreign": True}):
            with self.subTest(kwargs=kwargs), self.assertRaises(BuildControlError):
                self.admit(standalone=True, **kwargs)


class ManagedReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.selected = Path(self.temp.name)
        (self.selected / "scripts").mkdir()
        for name in (*reference.TOOLS, reference.DRIVER):
            (self.selected / "scripts" / name).write_text("# pinned source\n")
        self.control = Control()
        self.pins = {"backend_container_id": "a" * 64, "compose_project": "test-project"}
        self.args = argparse.Namespace(mode="prepare", request_sha256="", attempt="b"*32, config_sha256="c"*64)

    def execute(self):
        with patch.object(reference, "qualified_backend", return_value=self.pins), patch.object(reference, "sync_prepared"), patch("builtins.print"):
            return reference.execute(self.control, self.selected, {}, self.args)

    def prepare(self):
        self.assertEqual(self.execute(), 0)
        raw = next(raw for path, raw in self.control.files.items() if path.endswith("/request.json"))
        return raw, reference.sha(raw)

    def test_prepare_pins_exact_five_sources_and_never_dispatches(self):
        with patch.object(reference, "docker_capture") as capture, patch.object(reference, "attached") as attached:
            raw, digest = self.prepare()
        capture.assert_not_called(); attached.assert_not_called()
        request = json.loads(raw)
        self.assertEqual(request["reference_checks"], 9)
        self.assertEqual(request["automatic_retries"], 0)
        self.assertEqual(request["proposal_sha256"], reference.PROPOSAL_SHA)
        self.assertEqual(request["wheel"], reference.WHEEL)
        self.assertEqual(set(request["tools"]), set(reference.TOOLS))
        self.assertEqual(len([p for p in self.control.files if "/prepared/" in p]), 5)
        self.assertEqual(self.control.operations[0][0], "gsg-reference")
        self.assertEqual(self.control.operations[0][1]["request_sha256"], digest)

    def test_preflight_requires_exact_prepared_pin(self):
        self.prepare(); self.args.mode = "preflight"; self.args.request_sha256 = "d" * 64
        with self.assertRaisesRegex(BuildControlError, "request differs"):
            self.execute()

    def test_preflight_zero_evaluations_and_no_run(self):
        _, self.args.request_sha256 = self.prepare(); self.args.mode = "preflight"
        response = argparse.Namespace(returncode=0, stdout=canonical(self.preflight_value()), stderr=b"")
        with patch.object(reference, "docker_capture", return_value=response) as capture, patch.object(reference, "attached") as attached:
            self.assertEqual(self.execute(), 0)
        self.assertEqual(capture.call_args.args[-1], "preflight")
        attached.assert_not_called()

    def test_nonzero_preflight_evaluation_refuses(self):
        _, self.args.request_sha256 = self.prepare(); self.args.mode = "preflight"
        response = argparse.Namespace(returncode=0, stdout=canonical({"status":"PREFLIGHT PASS", "reference_evaluations":1, "new_solve":False}), stderr=b"")
        with patch.object(reference, "docker_capture", return_value=response), self.assertRaisesRegex(BuildControlError, "zero-evaluation"):
            self.execute()

    def test_started_or_launch_or_result_prevents_repeat(self):
        for name in ("launch.json", "started.json", "worker-exit.json", "result.json"):
            with self.subTest(name=name):
                self.control.files = {reference.ROOT + "/" + name: b"{}"}
                with self.assertRaisesRegex(BuildControlError, "already dispatched"):
                    self.execute()

    def test_source_change_after_prepare_refuses(self):
        _, self.args.request_sha256 = self.prepare(); self.args.mode = "run"
        (self.selected / "scripts" / reference.DRIVER).write_text("# changed\n")
        with patch.object(reference, "attached") as attached, self.assertRaisesRegex(BuildControlError, "request differs"):
            self.execute()
        attached.assert_not_called()

    def test_immutable_source_is_never_replaced(self):
        self.control.files["x"] = b"old"
        with self.assertRaises(BuildControlError):
            reference.immutable(self.control, "x", b"new")
        self.assertEqual(self.control.files["x"], b"old")

    def test_corrected_snapshot_preserves_old_preparation_and_shared_launch_guard(self):
        _, old_digest = self.prepare()
        old_files = dict(self.control.files)
        (self.selected / "scripts" / reference.DRIVER).write_text("# corrected decoder\n")
        self.assertEqual(self.execute(), 0)
        self.assertTrue(all(self.control.files[path] == raw for path, raw in old_files.items()))
        requests = [path for path in self.control.files if path.endswith("/request.json")]
        self.assertEqual(len(requests), 2)
        self.assertTrue(any(old_digest in path for path in requests))
        self.control.files[reference.ROOT + "/launch.json"] = b"{}"
        with self.assertRaisesRegex(BuildControlError, "already dispatched"):
            self.execute()

    def test_linked_source_refuses(self):
        original = self.selected / "scripts" / reference.DRIVER
        other = self.selected / "other.py"; original.rename(other); original.symlink_to(other)
        with self.assertRaisesRegex(BuildControlError, "symlink"):
            reference.source_files(self.selected)

    def test_attached_unknown_transport_retains_pending(self):
        operation = {"daemon_pending":False, "receipt":{}, "logger":argparse.Namespace(stdin=io.BytesIO())}
        process = argparse.Namespace(stdout=io.BytesIO(b"bounded progress\n"), wait=lambda: 1)
        with patch.object(reference.subprocess, "Popen", return_value=process), self.assertRaisesRegex(BuildControlError, "not confirmed"):
            reference.attached(self.control, operation, "a"*64, "b"*64)
        self.assertTrue(operation["daemon_pending"])

    def test_attached_accepts_only_exact_reaped_exit(self):
        for mismatch in (False, True):
            operation = {"daemon_pending":False, "receipt":{}, "logger":argparse.Namespace(stdin=io.BytesIO())}
            proof = {"schema":"fullmag.gsg-reference-worker-exit.v1", "request_sha256":"b"*64,
                     "exit_code":1 if mismatch else 0, "child_reaped":True,
                     "source_inputs_stable":True, "new_solve":False}
            self.control.files[reference.ROOT + "/worker-exit.json"] = canonical(proof)
            self.control.files[reference.ROOT + "/result.json"] = canonical({
                "schema":"fullmag.gsg-source-convergence-reference-result.v1", "request_sha256":"b"*64,
                "exit_code":0, "checks_completed":9, "checks_passed":9, "checks_total":9,
                "qualified_basis":False, "new_solve":False, "qualification":"NOT VERIFIED"})
            process = argparse.Namespace(stdout=io.BytesIO(), wait=lambda: 0)
            with patch.object(reference.subprocess, "Popen", return_value=process):
                if mismatch:
                    with self.assertRaises(BuildControlError):
                        reference.attached(self.control, operation, "a"*64, "b"*64)
                    self.assertTrue(operation["daemon_pending"])
                else:
                    self.assertEqual(reference.attached(self.control, operation, "a"*64, "b"*64)[0], 0)
                    self.assertFalse(operation["daemon_pending"])

    def test_reaped_zero_without_durable_nine_results_refuses(self):
        operation = {"daemon_pending":False, "receipt":{}, "logger":argparse.Namespace(stdin=io.BytesIO())}
        self.control.files[reference.ROOT + "/worker-exit.json"] = canonical({
            "schema":"fullmag.gsg-reference-worker-exit.v1", "request_sha256":"b"*64,
            "exit_code":0, "child_reaped":True, "source_inputs_stable":True, "new_solve":False})
        self.control.files[reference.ROOT + "/result.json"] = b"{}"
        process = argparse.Namespace(stdout=io.BytesIO(), wait=lambda: 0)
        with patch.object(reference.subprocess, "Popen", return_value=process), self.assertRaisesRegex(BuildControlError, "nine-check"):
            reference.attached(self.control, operation, "a"*64, "b"*64)
        self.assertFalse(operation["daemon_pending"])

    def test_directory_sync_orders_all_ancestors_bottom_up(self):
        root = self.selected / "control"
        target = root / "verification/gsg-source-convergence-reference-20261105/one-approved-attempt/prepared"
        target.mkdir(parents=True)
        namespace = {}
        order = []
        real_open = os.open
        real_fsync = os.fsync
        def opened(path, flags):
            order.append(Path(path)); return real_open(path, flags)
        with patch.object(os, "open", side_effect=opened), patch.object(os, "fsync", wraps=real_fsync):
            exec(reference.DIRECTORY_SYNC.replace('/opt/fullmag/control', str(root)).replace('Path(sys.argv[1])', 'Path(' + repr(str(target)) + ')'), namespace)
        self.assertEqual(order, [target, *list(target.parents)[:4]])
        self.assertEqual(order[-1], root)

    def test_directory_sync_refuses_linked_ancestor(self):
        root = self.selected / "control"; root.mkdir()
        actual = self.selected / "actual"; actual.mkdir()
        (root / "verification").symlink_to(actual, target_is_directory=True)
        (root / "verification/gsg-source-convergence-reference-20261105/one-approved-attempt/prepared").mkdir(parents=True)
        with self.assertRaisesRegex(RuntimeError, "not canonical"):
            exec(reference.DIRECTORY_SYNC.replace('/opt/fullmag/control', str(root)).replace('Path(sys.argv[1])', 'Path(' + repr(str(root/'verification/gsg-source-convergence-reference-20261105/one-approved-attempt/prepared')) + ')'), {})

    def preflight_value(self):
        rows = [{"label":label, "cells":count, "source_state_sha256":"a"*64,
                 "prepared_execution_sha256":"b"*64, "bundle_sha256":"c"*64, "ir_sha256":"d"*64,
                 "run_id":"run-fixture", "solution_set_id":"solution-fixture", "revision":"1",
                 "source_current_a":1., "payloads":{str(i):{"sha256":"e"*64,"byte_length":8} for i in range(10)}}
                for label,count in (("100nm",14299),("75nm",25516),("50nm",72911))]
        return {"status":"PREFLIGHT PASS", "reference_evaluations":0,"new_solve":False,"cases":rows,"dependency":{}}

    def test_run_refuses_without_successful_preflight(self):
        _, self.args.request_sha256 = self.prepare(); self.args.mode = "run"
        with patch.object(reference, "attached") as attached, self.assertRaisesRegex(BuildControlError, "successful preflight"):
            self.execute()
        attached.assert_not_called()

    def test_preflight_other_request_pin_refuses(self):
        raw, digest = self.prepare(); request = json.loads(raw)
        value = reference.preflight_record(self.preflight_value(), "d"*64, request)
        self.control.files[reference.ROOT + "/snapshots/" + digest + "/preflight.json"] = canonical(value)
        with self.assertRaisesRegex(BuildControlError, "pins differ"):
            reference.require_preflight(self.control, digest, request)

    def test_preflight_incomplete_source_closure_refuses(self):
        value = self.preflight_value(); del value['cases'][2]['ir_sha256']
        with self.assertRaisesRegex(BuildControlError, "incomplete"):
            reference.preflight_record(value, "a"*64, {"driver_sha256":"b"*64})

    def worker_fixture(self):
        root = self.selected / "control"
        files = {name:b"# fixture only\n" for name in reference.TOOLS}
        files[reference.DRIVER] = b"import sys\nprint('preflight' if '--preflight' in sys.argv else 'fixture child reaped')\n"
        request = reference.make_request(self.pins, files)
        raw = canonical(request)
        snapshot = root / "snapshots" / reference.sha(raw)
        (snapshot / "prepared").mkdir(parents=True)
        (snapshot / "request.json").write_bytes(raw)
        for name, data in files.items():
            (snapshot / "prepared" / name).write_bytes(data)
        return root, reference.sha(raw), reference.WORKER.replace(reference.ATTEMPT, str(root))

    def test_worker_preflight_does_not_claim_attempt(self):
        root, digest, wrapper = self.worker_fixture()
        result = subprocess.run([sys.executable, "-B", "-c", wrapper, digest, "preflight"], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((root/"launch.json").exists())
        self.assertFalse((root/"worker-exit.json").exists())

    def test_worker_reaps_exact_child_and_refuses_repeat(self):
        root, digest, wrapper = self.worker_fixture()
        result = subprocess.run([sys.executable, "-B", "-c", wrapper, digest, "run"], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        proof = json.loads((root/"worker-exit.json").read_bytes())
        self.assertTrue(proof["child_reaped"]); self.assertEqual(proof["request_sha256"], digest)
        second = subprocess.run([sys.executable, "-B", "-c", wrapper, digest, "run"], capture_output=True)
        self.assertNotEqual(second.returncode, 0)
        self.assertIn(b"FileExistsError", second.stderr)

    def test_worker_source_tamper_precedes_dispatch(self):
        root, digest, wrapper = self.worker_fixture()
        (root/"snapshots"/digest/"prepared"/reference.TOOLS[0]).write_text("# tampered\n")
        result = subprocess.run([sys.executable, "-B", "-c", wrapper, digest, "run"], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((root/"launch.json").exists())


class FineManagedReferenceTests(unittest.TestCase):
    def test_explicit_86k_request_has_new_plan_and_preserves_old_default(self):
        changed=dict(self.binding,cells=85980)
        value=reference.make_fine_request(self.pins,self.files,canonical(changed),
            work_profile="gsg_junction_fine_reference_86k_v1")
        self.assertEqual(value["work_profile"],"gsg_junction_fine_reference_86k_v1")
        self.assertEqual(value["proposal_sha256"],"bb7667f455287d43f7e127ccbc28da4dfa6f15b3795d375c7503e9eb5781e901")
        with self.assertRaises((ValueError,BuildControlError)):
            reference.make_fine_request(self.pins,self.files,canonical(changed))

    def setUp(self):
        from test_run_gsg_junction_reference import fixture
        import run_gsg_junction_reference as junction
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.selected=Path(self.temp.name).resolve()
        self.binding,self.data,self.manifest,self.client=fixture(self.selected)
        (self.selected/'scripts').mkdir()
        for name in (*reference.TOOLS,reference.DRIVER,reference.FINE_DRIVER):
            (self.selected/'scripts'/name).write_text('# pinned source\n')
        self.control=Control()
        self.source_raw=canonical(self.binding)+b'\n'
        self.control.files[reference.FINE_SOURCE]=self.source_raw
        self.pins={'backend_container_id':'a'*64,'compose_project':'test-project'}
        self.files=reference.source_files(self.selected,junction_fine=True)
        request=reference.make_fine_request(self.pins,self.files,self.source_raw)
        self.digest=reference.sha(canonical(request)+b'\n')
        self.args=argparse.Namespace(mode='junction-fine-preflight',request_sha256=self.digest,
                                     attempt='b'*32,config_sha256='c'*64)
        _,proof=junction.load_source(self.client,self.binding,self.selected)
        self.proof=dict(status='PREFLIGHT PASS',reference_evaluations=0,new_solve=False,cases=[proof],dependency={})

    def execute(self):
        result=argparse.Namespace(returncode=0,stdout=canonical(self.proof),stderr=b'')
        with patch.object(reference,'qualified_backend',return_value=self.pins) as backend,\
             patch.object(reference,'sync_prepared'),patch.object(reference,'docker_capture',return_value=result),\
             patch('builtins.print'):
            code=reference.execute(self.control,self.selected,{},self.args)
        self.assertTrue(all(c.kwargs.get('allow_no_archive') is True for c in backend.call_args_list))
        return code

    def test_fine_preflight_pins_one_source_and_six_tools_without_run(self):
        with patch.object(reference,'attached') as attached:
            self.assertEqual(self.execute(),0)
        attached.assert_not_called()
        request=json.loads(self.control.files[reference.FINE_ROOT+'/snapshots/'+self.digest+'/request.json'])
        self.assertEqual(request['reference_checks'],3)
        self.assertEqual(request['source'],self.binding)
        self.assertEqual(request['source_binding_sha256'],reference.sha(self.source_raw))
        self.assertEqual(len(request['tools']),5)
        self.assertFalse(any(p.startswith(reference.ROOT+'/') for p in self.control.files))

    def test_fine_run_requires_own_successful_preflight(self):
        self.args.mode='junction-fine-run'
        with patch.object(reference,'attached') as attached,self.assertRaisesRegex(BuildControlError,'successful preflight'):
            self.execute()
        attached.assert_not_called()

    def test_changed_source_or_wrong_native_proof_cannot_use_old_pin(self):
        self.binding['source_current_a'] *= -1
        self.control.files[reference.FINE_SOURCE]=canonical(self.binding)+b'\n'
        with self.assertRaisesRegex(BuildControlError,'request differs'):
            self.execute()
        self.control.files[reference.FINE_SOURCE]=self.source_raw
        self.proof['cases'][0]['source_current_a'] *= -1
        with self.assertRaisesRegex(BuildControlError,'source'):
            self.execute()

    def test_fine_refuses_source_over80k_and_does_not_change_nine_point_default(self):
        self.binding['cells']=80001
        with self.assertRaises((ValueError,BuildControlError)):
            reference.make_fine_request(self.pins,self.files,canonical(self.binding))
        old=reference.make_request(self.pins,{name:b'# old\n' for name in (*reference.TOOLS,reference.DRIVER)})
        self.assertEqual(old['reference_checks'],9)
        self.assertEqual(set(old['tools']),set(reference.TOOLS))
        self.assertNotIn('source',old)

    def test_fine_attached_requires_three_results_after_reaped_exit(self):
        for count in (3,9):
            with self.subTest(count=count):
                operation={'daemon_pending':False,'receipt':{},'logger':argparse.Namespace(stdin=io.BytesIO())}
                proof=dict(schema='fullmag.gsg-reference-worker-exit.v1',request_sha256=self.digest,
                           exit_code=0,child_reaped=True,source_inputs_stable=True,new_solve=False)
                self.control.files[reference.FINE_ROOT+'/worker-exit.json']=canonical(proof)
                self.control.files[reference.FINE_ROOT+'/result.json']=canonical(dict(
                    schema='fullmag.gsg-junction-reference-result.v1',request_sha256=self.digest,
                    exit_code=0,checks_completed=count,checks_passed=count,checks_total=count,
                    new_solve=False,qualified_basis=False,qualification='NOT VERIFIED'))
                process=argparse.Namespace(stdout=io.BytesIO(),wait=lambda:0)
                with patch.object(reference.subprocess,'Popen',return_value=process):
                    if count==3:
                        self.assertEqual(reference.attached(self.control,operation,'a'*64,self.digest,
                                                           junction_fine=True)[0],0)
                    else:
                        with self.assertRaisesRegex(BuildControlError,'three-check'):
                            reference.attached(self.control,operation,'a'*64,self.digest,junction_fine=True)
                self.assertFalse(operation['daemon_pending'])

    def test_real_fine_wrapper_reaps_fixture_child_and_refuses_repeat(self):
        root=self.selected/'control'
        files={name:b'# fixture only\n' for name in reference.FINE_TOOLS}
        files[reference.FINE_DRIVER]=b"import sys\nprint('fixture child; no reference evaluations')\n"
        request=reference.make_fine_request(self.pins,files,self.source_raw)
        raw=canonical(request);digest=reference.sha(raw)
        snapshot=root/'snapshots'/digest
        (snapshot/'prepared').mkdir(parents=True)
        (snapshot/'request.json').write_bytes(raw)
        for name,value in files.items():(snapshot/'prepared'/name).write_bytes(value)
        wrapper=reference.FINE_WORKER.replace(reference.FINE_ATTEMPT,str(root))
        result=subprocess.run([sys.executable,'-B','-c',wrapper,digest,'preflight'],capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertFalse((root/'launch.json').exists())
        result=subprocess.run([sys.executable,'-B','-c',wrapper,digest,'run'],capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        proof=json.loads((root/'worker-exit.json').read_bytes())
        self.assertTrue(proof['child_reaped'])
        self.assertTrue(proof['source_inputs_stable'])
        self.assertEqual(proof['request_sha256'],digest)
        second=subprocess.run([sys.executable,'-B','-c',wrapper,digest,'run'],capture_output=True)
        self.assertNotEqual(second.returncode,0)
        self.assertIn(b'FileExistsError',second.stderr)

    def test_fine_wrapper_has_separate_root_and_driver(self):
        self.assertIn(reference.FINE_ATTEMPT,reference.FINE_WORKER)
        self.assertIn(reference.FINE_DRIVER,reference.FINE_WORKER)
        self.assertNotIn(reference.ATTEMPT,reference.FINE_WORKER)
        self.assertIn(reference.ATTEMPT,reference.WORKER)

if __name__ == "__main__":
    unittest.main()
