"""Offline regressions for the one-shot diagnostic guest; no Docker or native run."""
import contextlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("namespace_guest_under_test", Path(__file__).with_name("docker_volume_succeeded_namespace_guest.py"))
guest = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = guest
SPEC.loader.exec_module(guest)


class GuestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.control = self.root / "control"
        self.directory = self.control / "verification/op"
        self.directory.mkdir(parents=True)
        self.package = self.root / "package"
        self.package.mkdir()
        self.host = self.root / "ledger"
        self.host.mkdir()
        for name, value in [("CONTROL", self.control), ("PACKAGE", self.package), ("HOST_LEDGER", self.host)]:
            patch = mock.patch.object(guest, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(value, indent=2).encode()  # Resume need not use canonical whitespace.
        path.write_bytes(raw)
        return guest.sha(raw)

    def fixture(self):
        pin = "a" * 64
        request_path = self.directory / "guest.json"
        config_path = self.directory / "config.json"
        config_pin = self.write(config_path,{"store_root":str(self.root / "store"),"host_execution":{"ledger_root":str(self.host)}})
        teardown = {"schema_version":"host_succeeded_worker_namespace_teardown_request.v1",
            "request_id":"11111111-1111-4111-8111-111111111111", "config_sha256":config_pin,
            "old_container_id":"b" * 64, "identity":{"run_id":"run-test","task_id":"task-test",
                "resource_id":"compute","lease_token":"token-test"}}
        teardown_pin = guest.sha(guest.canonical(teardown))
        intent_pin = guest.sha(guest.canonical({"schema_version":"host_succeeded_worker_namespace_teardown_intent.v1",
            "request_sha256":teardown_pin,"request":teardown}))
        request = {key: pin for key in guest.REQUEST_FIELDS if key.endswith("sha256")}
        request.update({"schema":guest.SCHEMA,"request_id":teardown["request_id"],"teardown":teardown,
            "teardown_request_sha256":teardown_pin,"teardown_intent_sha256":intent_pin,
            "candidate_path":str(self.package / ".development/candidates/.backend-package-candidate-test"),
            "config_path":str(config_path),"config_sha256":config_pin,"status_path":str(self.directory / "guest-status.json"),
            "resume_intent_path":str(self.directory / "resume.json"),"fms_archive_path":"/state/preserved-test.fms"})
        root = {"schema_version":"runtime_service_succeeded_namespace_recovery.v1","request_id":request["request_id"],
            "teardown":teardown,"config_sha256":config_pin,"source_snapshot_sha256":pin,"package_receipt_sha256":pin,
            "executable_sha256":pin,"attestation_path":str(self.directory / "attestation.json"),"attestation_sha256":pin,
            "execution_container_id":"c" * 64,"execution_pid_namespace":"pid:[999]",
            "diagnostic_api_pid":123,"diagnostic_api_start_token":"linux-starttime-1","diagnostic_api_executable_sha256":pin}
        root_path = self.directory / "native.json"
        root_pin = self.write(root_path, root)
        completed = {"schema_version":root["schema_version"],"status":"released","request_sha256":root_pin,
            "teardown_request_sha256":teardown_pin,"task_outcome":"succeeded","process_exit_status":"unknown","solve_replayed":False}
        completion_path = self.directory / "complete.json"
        completion_pin = self.write(completion_path, completed)
        resume = {"schema":guest.RESUME_SCHEMA,"guest_request_sha256":pin,"native_request_path":str(root_path),
            "native_request_sha256":root_pin,"native_completion_path":str(completion_path),
            "native_completion_sha256":completion_pin,"fms_archive_sha256":pin,"solve_replay":False}
        self.write(Path(request["resume_intent_path"]), resume)
        return request_path, request, root, resume

    def test_evidence_reader_rejects_links_duplicates_and_changed_pins(self):
        path = self.directory / "document.json"
        pin = self.write(path, {"valid":True})
        guest.read_json(path, pin)
        with self.assertRaises(guest.GuestError):
            guest.read_json(path, "f" * 64)
        alias = self.directory / "alias.json"
        alias.symlink_to(path)
        with self.assertRaises(guest.GuestError):
            guest.read_json(alias)
        linked = self.directory / "hardlink.json"
        linked.hardlink_to(path)
        with self.assertRaises(guest.GuestError):
            guest.read_json(path)
        duplicate = self.directory / "duplicate.json"
        duplicate.write_bytes(b'{"same":1,"same":2}')
        with self.assertRaises(guest.GuestError):
            guest.read_json(duplicate)

    def test_exact_immutable_replay_finishes_both_durability_barriers(self):
        path = self.directory / "committed.json"
        value = {"committed":True}
        guest.immutable(path,value)
        original = path.read_bytes()
        with mock.patch.object(guest.os,"fsync",wraps=guest.os.fsync) as sync:
            guest.immutable(path,value)
            self.assertEqual(sync.call_count,2)
        for failures in [[OSError("file barrier failed")], [None,OSError("directory barrier failed")]]:
            with mock.patch.object(guest.os,"fsync",side_effect=failures):
                with self.assertRaises(OSError):
                    guest.immutable(path,value)
            self.assertEqual(path.read_bytes(),original)
        with self.assertRaises(guest.GuestError):
            guest.immutable(path,{"committed":False})
        self.assertEqual(path.read_bytes(),original)

    def test_exclusive_lock_preserves_native_descriptor_and_refuses_contention(self):
        path = self.directory / "WRITER.lock"
        raw = b"fullmag.writer.lock.v1\n"
        path.write_bytes(raw)
        with guest.existing_lock(path, raw):
            with self.assertRaises(BlockingIOError):
                with guest.existing_lock(path, raw):
                    self.fail("second writer acquired the same kernel lock")
        self.assertEqual(path.read_bytes(), raw)
        with guest.existing_lock(path, raw):
            pass

    def test_pre_spawn_fence_uses_the_same_runtime_control_authority_as_native(self):
        request_id = "11111111-1111-4111-8111-111111111111"
        service = SimpleNamespace(process_receipt_path=lambda paths: Path("/opt/fullmag/runtime-control/runtime-services/process-tree.json"))
        path = guest.diagnostic_fence_path(service,None,request_id)
        self.assertTrue(path.is_relative_to(Path("/opt/fullmag/runtime-control")))
        self.assertEqual(path.name,"api-failure-succeeded-namespace-"+request_id+".json")
        foreign = SimpleNamespace(process_receipt_path=lambda paths: self.directory / "process-tree.json")
        with self.assertRaises(guest.GuestError):
            guest.diagnostic_fence_path(foreign,None,request_id)

    def test_startup_configuration_cannot_launch_a_script(self):
        guest.forbid_startup({})
        guest.forbid_startup({"FULLMAG_STARTUP_ENABLED":"0"})
        for environment in [{"FULLMAG_STARTUP_ENABLED":"1"}, {"FULLMAG_STARTUP_SCRIPT":""},
            {"FULLMAG_STARTUP_SCRIPT":"study.py"}, {"FULLMAG_STARTUP_UNKNOWN":"0"}]:
            with self.assertRaises(guest.GuestError):
                guest.forbid_startup(environment)

    def test_guest_requires_same_immutable_intent_and_unpublished_candidate(self):
        path, request, _, _ = self.fixture()
        guest.validate_request(request, path)
        for key, value in [("teardown_intent_sha256", "f" * 64), ("candidate_path", str(self.package)),
            ("resume_intent_path", str(self.root / "outside.json"))]:
            changed = {**request, key:value}
            with self.assertRaises(guest.GuestError):
                guest.validate_request(changed, path)

    def test_resume_binds_raw_native_completion_and_preserves_unknown_exit(self):
        _, request, root, resume = self.fixture()
        self.assertEqual(guest.validate_resume(resume, request, "a" * 64), root)
        for key, value in [("guest_request_sha256","e" * 64),("solve_replay",True),
            ("native_completion_sha256","e" * 64),("fms_archive_sha256","e" * 64)]:
            with self.assertRaises(guest.GuestError):
                guest.validate_resume({**resume,key:value},request,"a" * 64)
        complete_path = Path(resume["native_completion_path"])
        complete, _ = guest.read_json(complete_path)
        complete["process_exit_status"] = "0"
        changed = {**resume,"native_completion_sha256":self.write(complete_path,complete)}
        with self.assertRaises(guest.GuestError):
            guest.validate_resume(changed,request,"a" * 64)

    def test_native_success_alone_cannot_cover_a_changed_guarded_file(self):
        file = self.directory / "authority.json"
        file.write_bytes(b"original")
        files = {str(file):guest.file_hash(file)}
        paths = SimpleNamespace(store=self.root / "store",state_root=self.directory)
        guest.validate_guarded_files(files,[file],paths)
        file.write_bytes(b"changed")
        with self.assertRaises(guest.GuestError):
            guest.validate_guarded_files(files,[file],paths)
        with self.assertRaises(guest.GuestError):
            guest.validate_guarded_files({},[file],paths)
        with self.assertRaises(guest.GuestError):
            guest.validate_guarded_files(files,[self.directory / "missing"],paths)

    def test_sigterm_timeout_never_calls_kill_or_resends_signal(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = subprocess.TimeoutExpired("owned-api",10)
        child = guest.Child(process,"linux-starttime-1",Path("/candidate/fullmag-api"),"a" * 64)
        with mock.patch.object(guest,"assert_child"):
            for _ in range(2):
                with self.assertRaises(guest.GuestError):
                    guest.stop_child(child)
        process.terminate.assert_called_once()
        process.kill.assert_not_called()

    def test_api_capture_failure_still_drains_the_registered_direct_child(self):
        request_path,request,_,_ = self.fixture()
        request_pin = self.write(request_path,request)
        process = mock.Mock(pid=123)
        process.poll.return_value = None
        paths = SimpleNamespace(config=Path(request["config_path"]),store=self.root / "store")
        service = SimpleNamespace(canonical_paths=lambda:paths,process_environment=lambda paths:{})
        with mock.patch.object(guest.os,"getpid",return_value=1), \
                mock.patch.object(guest,"image_modules",return_value=(service,mock.Mock())), \
                mock.patch.object(guest,"committed_handoff",return_value=False), \
                mock.patch.object(guest,"validate_package"),mock.patch.object(guest,"no_other_consumers"), \
                mock.patch.object(guest,"diagnostic_fence_path",return_value=self.directory / "api-fence.json"), \
                mock.patch.object(guest,"file_hash",return_value=request["fms_archive_sha256"]), \
                mock.patch.object(guest,"start_token",side_effect=["linux-starttime-1",OSError("proc capture failed")]), \
                mock.patch.object(guest.signal,"signal"),mock.patch.object(guest.subprocess,"Popen",return_value=process) as spawn, \
                mock.patch.dict(guest.os.environ,{},clear=True):
            with self.assertRaisesRegex(OSError,"proc capture"):
                guest.run(request_path,request_pin)
        spawn.assert_called_once()
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=10)
        process.kill.assert_not_called()

    def test_native_capture_failure_keeps_the_direct_child_for_outer_cleanup(self):
        request_path,request,root,resume = self.fixture()
        api = SimpleNamespace(process=SimpleNamespace(pid=123),token="linux-starttime-1")
        process = mock.Mock(pid=124)
        process.poll.return_value = None
        children = []
        service = SimpleNamespace(process_environment=lambda *a,**k:{})
        with mock.patch.object(guest,"container_identity",return_value=(root["execution_container_id"],root["execution_pid_namespace"])), \
                mock.patch.object(guest,"assert_child"), \
                mock.patch.object(guest,"start_token",side_effect=OSError("proc capture failed")), \
                mock.patch.object(guest.subprocess,"Popen",return_value=process) as spawn:
            with self.assertRaisesRegex(OSError,"proc capture"):
                guest.handoff(request,request_path,"a"*64,resume,api,children,service,mock.Mock(),None,None)
            self.assertEqual(len(children),1)
            self.assertIsNone(children[0].token)
            guest.stop_child(children[0])
        spawn.assert_called_once()
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=10)
        process.kill.assert_not_called()

    def test_changed_native_guard_stops_handoff_before_package_rotation(self):
        request_path, request, root, resume = self.fixture()
        api = SimpleNamespace(process=SimpleNamespace(pid=123),token="linux-starttime-1")
        verified = {"schema_version":root["schema_version"],"status":"handoff-verified",
            "request_sha256":resume["native_request_sha256"],"teardown_request_sha256":request["teardown_request_sha256"],
            "task_outcome":"succeeded","process_exit_status":"unknown","solve_replayed":False,"mutations_applied":False,
            "handoff_guarded_files":{}}
        self.write(Path(request["config_path"]),{"host_execution":{"ledger_root":str(self.host)}})
        # This fixture's config pin is used only after native preview; keep it exact.
        request["config_sha256"] = guest.file_hash(Path(request["config_path"]))
        backend = mock.Mock()
        service = SimpleNamespace(process_environment=lambda *a,**k: {})
        stopping = SimpleNamespace(is_set=lambda:False)
        with mock.patch.object(guest,"validate_resume",return_value=root), \
                mock.patch.object(guest,"container_identity",return_value=(root["execution_container_id"],root["execution_pid_namespace"])), \
                mock.patch.object(guest,"assert_child"), mock.patch.object(guest,"stop_child") as stop, \
                mock.patch.object(guest,"own_child",return_value=mock.Mock()), \
                mock.patch.object(guest.subprocess,"Popen"), mock.patch.object(guest,"collect_native",return_value=verified), \
                mock.patch.object(guest,"final_fences",return_value=contextlib.nullcontext()), \
                mock.patch.object(guest,"no_other_consumers"),mock.patch.dict(guest.os.environ,{},clear=True):
            with self.assertRaisesRegex(guest.GuestError,"guarded-file inventory"):
                guest.handoff(request,request_path,"a" * 64,resume,api,[],service,backend,
                    SimpleNamespace(store=self.root / "store"),stopping)
        stop.assert_called_once_with(api)
        backend._rotate_package.assert_not_called()
        backend._publish_runtime_provenance.assert_not_called()

    def test_committed_restart_uses_promoted_package_and_never_replays_recovery(self):
        request_path, request, root, resume = self.fixture()
        receipt = {"source":{"source_snapshot_sha256":request["source_snapshot_sha256"]},"state":"succeeded"}
        receipt_raw = json.dumps(receipt).encode()
        request["candidate_receipt_sha256"] = guest.sha(receipt_raw)
        root["package_receipt_sha256"] = request["candidate_receipt_sha256"]
        resume["native_request_sha256"] = self.write(Path(resume["native_request_path"]),root)
        completion, _ = guest.read_json(Path(resume["native_completion_path"]))
        completion["request_sha256"] = resume["native_request_sha256"]
        resume["native_completion_sha256"] = self.write(Path(resume["native_completion_path"]),completion)
        guest_pin = self.write(request_path,request)
        resume["guest_request_sha256"] = guest_pin
        resume_pin = self.write(Path(request["resume_intent_path"]),resume)
        committed = {"schema":"fullmag.succeeded-namespace-handoff.v1","guest_request_sha256":guest_pin,
            "execution_container_id":"c"*64,"resume_intent_sha256":resume_pin,
            "native_request_sha256":resume["native_request_sha256"],"native_completion_sha256":resume["native_completion_sha256"],
            "package_receipt_sha256":request["candidate_receipt_sha256"],"provenance_sha256":"e"*64,
            "fms_archive_sha256":request["fms_archive_sha256"],"solve_replay":False}
        committed_path = Path(request["status_path"]).with_suffix(".handoff-committed.json")
        guest.immutable(committed_path,committed)
        backend = mock.Mock()
        backend._validated_package.return_value = (receipt,receipt_raw,{})
        paths = SimpleNamespace(config=Path(request["config_path"]),store=self.root / "store")
        class ExecBoundary(BaseException):
            pass
        def hashes(path,maximum=guest.MAX_FILE):
            return "e"*64 if str(path).endswith("runtime-provenance.json") else "a"*64
        with mock.patch.object(guest,"container_identity",return_value=("c"*64,"pid:[new-after-restart]")), \
                mock.patch.object(guest,"final_fences",return_value=contextlib.nullcontext()), \
                mock.patch.object(guest,"no_other_consumers"),mock.patch.object(guest,"file_hash",side_effect=hashes), \
                mock.patch.object(guest.subprocess,"Popen") as spawn, \
                mock.patch.object(guest.os,"execvpe",side_effect=ExecBoundary) as execute, \
                mock.patch.dict(guest.os.environ,{},clear=True):
            with mock.patch.object(guest.os,"fsync",side_effect=OSError("committed durability barrier failed")):
                with self.assertRaisesRegex(OSError,"durability barrier"):
                    guest.committed_handoff(request,request_path,guest_pin,None,backend,paths)
            execute.assert_not_called()
            with self.assertRaises(ExecBoundary):
                guest.committed_handoff(request,request_path,guest_pin,None,backend,paths)
            spawn.assert_not_called()
            execute.assert_called_once()
            self.assertEqual(execute.call_args.args[1], ["/usr/local/bin/python3","-B","/opt/fullmag/entrypoint.py","backend"])
            backend._rotate_package.assert_not_called()
            execute.reset_mock()
            backend._validated_package.return_value = (receipt,receipt_raw+b"changed",{})
            with self.assertRaisesRegex(guest.GuestError,"promoted package"):
                guest.committed_handoff(request,request_path,guest_pin,None,backend,paths)
            execute.assert_not_called()
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
