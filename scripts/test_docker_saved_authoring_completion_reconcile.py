"""Closed saved-authoring completion fences; no Docker calls in these tests."""
import copy
import hashlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import docker_saved_authoring_completion_reconcile as completion
import docker_volume_reconcile as legacy
from docker_build_control import BuildControlError, canonical


def raw(value):
    return canonical(value) + b"\n"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def fixture():
    token = "1" * 32
    project = "fullmag-worktree-test"
    image = "sha256:" + "a" * 64
    source = "/home/user/git/fullmag/worktrees/test"
    process = {"pid": 123, "ppid": 99, "start_token": "345", "cmdline_sha256": "b"*64,
               "boot_id": "boot-identity", "pid_namespace": "pid:[42]"}
    archive = {"sha256": "c"*64, "path": "/state/project.fms"}
    checkpoint = {"archive": archive, "retained_run_catalogs": []}
    compose = {"name": project, "services": {
        "backend": {"environment": {"FULLMAG_STARTUP_ENABLED": "0",
                                    "FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1",
                                    "FULLMAG_AUTO_CACHE_MAINTENANCE": "1"}},
        "frontend": {"ports": [{"host_ip": "127.0.0.1", "published": "3203"}]}}}
    compose_raw = raw(compose)
    receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration",
               "state": "restarting-idle-backend", "attempt": token, "compose_project": project,
               "control_volume": "owned-control", "helper_container": "fullmag-control-"+token,
               "saved_authoring_restore_required": archive, "state_root": "/state",
               "backend_started_at": "backend-start", "frontend_started_at": "frontend-start",
               "inputs": {"attempt": "2"*32, "source_root": source,
                          "image_id": image, "config_sha256": sha(compose_raw[:-1]),
                          "saved_authoring_checkpoint_sha256": sha(raw(checkpoint))}}
    actual = {}
    for i, name in enumerate(("lease", "backend", "frontend"), 3):
        actual[name] = {"Id": str(i)*64, "Image": image,
                       "State": {"StartedAt": name+"-start", "Running": True},
                       "Name": "/fullmag-control-"+token if name == "lease" else "/"+name,
                       "Config": {"User": "65532:65532", "Cmd": ["owned-operation", token], "Labels": {
                           "com.docker.compose.project": project,
                           "com.docker.compose.service": "build-control" if name == "lease" else name}},
                       "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False},
                       "Mounts": [{"Type": "volume", "Destination": "/control",
                                   "Name": "owned-control", "RW": True}] if name == "lease" else []}
    binaries = {n: str(i)*64 for i, n in enumerate(completion.BINARIES, 6)}
    package_receipt = {"state": "succeeded", "artifacts": [
        {"path": "bin/"+name, "sha256": value} for name, value in binaries.items()]}
    provenance = {"state": "succeeded", "build_receipt_sha256": sha(raw(package_receipt)),
                  "source_snapshot_sha256": "9"*64, "binary_hashes": binaries}
    package = {k: {"value": v, "sha256": sha(raw(v))}
               for k, v in (("receipt", package_receipt), ("provenance", provenance))}
    launch = {"attempt": token, "process_identity": process,
              "command": ["/usr/bin/just", "docker-dev-restart-saved-authoring", "2"*32,
                          receipt["inputs"]["config_sha256"], source, "verification/checkpoint.json",
                          sha(raw(checkpoint)), "3203"]}
    process["cmdline_sha256"] = sha(b"\0".join(a.encode() for a in launch["command"])+b"\0")
    exit_observation = {"schema": completion.EXIT_SCHEMA, "attempt": token,
                        "process_identity": process, "exit_code": 2, "wait_completed": True,
                        "launch_observation_sha256": sha(raw(launch))}
    request = {"schema": completion.SCHEMA, "attempt": token, "compose_project": project,
               "source_root": source, "port": 3203, "config_sha256": receipt["inputs"]["config_sha256"],
               "retained_receipt_sha256": sha(raw(receipt)), "controller_sha256": "d"*64,
               "completion_module_sha256": "e"*64,
               "containers": {n: {"id": a["Id"], "image": a["Image"],
                   "started_at": a["State"]["StartedAt"], "fingerprint": legacy.fingerprint(a)}
                   for n, a in actual.items()},
               "package_documents": {"receipt": package["receipt"]["sha256"],
                   "provenance": package["provenance"]["sha256"], "binary_hashes": binaries},
               "checkpoint_sha256": sha(raw(checkpoint)),
               "controller_exit_evidence": {"host_profile": "linux-native-v1",
                   "process_identity": process, "exit_observation_sha256": sha(raw(exit_observation))}}
    observed = {"receipt_raw": raw(receipt), "current_receipt_raw": raw(receipt), "compose_raw": compose_raw,
                "expected_lease_command": ["owned-operation", token], "archive_sha256": archive["sha256"],
                "group_ledger": {"schema_version":"host_resource_ledger.v4","reservations":[]},
                "checkpoint_raw": raw(checkpoint), "containers": actual, "package": package,
                "active": token, "terminal_raw": None,
                "controller_sha256": request["controller_sha256"],
                "completion_module_sha256": request["completion_module_sha256"],
                "controller_launch_raw": raw(launch), "controller_exit_raw": raw(exit_observation),
                "controller_process": None, "active_controllers": [],
                "host_boot_id": process["boot_id"], "pid_namespace": process["pid_namespace"],
                "certificate": {"storage_profile": "linux-native-v1"},
                "ledger_profile": {"profile": "group-ledger-v1"},
                "health": {"status": "ok", "active_session": False},
                "queue": {"items": []}, "retained_catalogs": [],
                "loaded_api": {"package_hashes": binaries,
                               "running_api_sha256": binaries["fullmag-api"],
                               "running_api_identity": [1, 2], "published_api_identity": [1, 2]}}
    return copy.deepcopy(request), copy.deepcopy(observed)


class SavedCompletionValidationTests(unittest.TestCase):
    def test_complete_linux_observation_is_admissible(self):
        request, observed = fixture()
        completion.validate_saved_completion(request, observed)

    def test_every_other_receipt_state_is_rejected(self):
        for state in ("starting", "succeeded", "failed-confirmed", "reconciling-publication", None):
            request, observed = fixture()
            receipt = json.loads(observed["receipt_raw"]); receipt["state"] = state
            observed["receipt_raw"] = raw(receipt)
            request["retained_receipt_sha256"] = sha(observed["receipt_raw"])
            with self.subTest(state=state), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)

    def test_unknown_outcome_is_also_admissible(self):
        request, observed = fixture()
        receipt = json.loads(observed["receipt_raw"])
        receipt["state"] = "outcome-unknown-resources-retained"
        observed["receipt_raw"] = raw(receipt)
        request["retained_receipt_sha256"] = sha(observed["receipt_raw"])
        completion.validate_saved_completion(request, observed)

    def test_cas_and_schema_mutations_are_rejected(self):
        for field in ("schema", "config_sha256", "checkpoint_sha256", "retained_receipt_sha256",
                      "controller_sha256", "completion_module_sha256", "attempt", "source_root",
                      "compose_project", "port"):
            request, observed = fixture()
            request[field] = 3204 if field == "port" else "f"*64
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)
        request, observed = fixture(); request["skip_history"] = True
        with self.assertRaises(BuildControlError):
            completion.validate_saved_completion(request, observed)

    def test_original_live_or_unproven_controller_is_rejected(self):
        for change in ("live", "missing-launch-pin", "missing-exit", "foreign-boot", "active-controller"):
            request, observed = fixture()
            if change == "live": observed["controller_process"] = request["controller_exit_evidence"]["process_identity"]
            if change == "missing-launch-pin":
                launch = json.loads(observed["controller_launch_raw"]); launch.pop("process_identity")
                observed["controller_launch_raw"] = raw(launch)
            if change == "missing-exit": observed["controller_exit_raw"] = b"{}"
            if change == "foreign-boot": observed["host_boot_id"] = "other"
            if change == "active-controller": observed["active_controllers"] = [{"pid": 777}]
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)

    def test_container_incarnation_or_mount_change_is_rejected(self):
        for name in ("lease", "backend", "frontend"):
            for field in ("start", "mount"):
                request, observed = fixture()
                actual = observed["containers"][name]
                if field == "start": actual["State"]["StartedAt"] = "recycled"
                else: actual["Mounts"] = [{"Type": "bind", "Destination": "/foreign"}]
                with self.subTest(name=name,field=field), self.assertRaises(BuildControlError):
                    completion.validate_saved_completion(request, observed)

    def test_wrong_owner_active_or_existing_terminal_is_rejected(self):
        for field,value in (("active","7"*32), ("terminal_raw",b"{}")):
            request, observed = fixture(); observed[field] = value
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)

    def test_package_or_loaded_api_disagreement_is_rejected(self):
        for change in ("receipt", "provenance", "binary", "running-hash", "running-inode"):
            request, observed = fixture()
            if change == "receipt": observed["package"]["receipt"]["sha256"] = "f"*64
            if change == "provenance": observed["package"]["provenance"]["value"]["state"] = "building"
            if change == "binary": observed["loaded_api"]["package_hashes"]["fullmag-bin"] = "f"*64
            if change == "running-hash": observed["loaded_api"]["running_api_sha256"] = "f"*64
            if change == "running-inode": observed["loaded_api"]["running_api_identity"] = [1, 3]
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)

    def test_new_session_queue_or_history_change_is_rejected(self):
        for field,value in (("health",{"status":"ok","active_session":True}),
                            ("queue",{"items":[{"run_id":"new"}]}),
                            ("retained_catalogs",[{"run_id":"foreign"}])):
            request, observed = fixture(); observed[field]=value
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)

    def test_other_storage_or_ledger_profile_is_rejected(self):
        for field,value in (("certificate",{"storage_profile":"windows-folder-v1"}),
                            ("ledger_profile",{"profile":"host-ledger-v1"})):
            request, observed = fixture(); observed[field]=value
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)

    def test_changed_fms_or_checkpoint_binding_is_rejected(self):
        request, observed = fixture()
        checkpoint = json.loads(observed["checkpoint_raw"])
        checkpoint["archive"]["sha256"] = "f"*64
        observed["checkpoint_raw"] = raw(checkpoint)
        with self.assertRaises(BuildControlError):
            completion.validate_saved_completion(request, observed)

    def test_launch_must_match_observed_process_command_hash(self):
        request,observed=fixture()
        identity=request["controller_exit_evidence"]["process_identity"]
        identity["cmdline_sha256"]="f"*64
        launch=json.loads(observed["controller_launch_raw"]);launch["process_identity"]=identity
        observed["controller_launch_raw"]=raw(launch)
        receipt=json.loads(observed["controller_exit_raw"]);receipt["process_identity"]=identity
        receipt["launch_observation_sha256"]=sha(observed["controller_launch_raw"])
        observed["controller_exit_raw"]=raw(receipt)
        request["controller_exit_evidence"]["exit_observation_sha256"]=sha(observed["controller_exit_raw"])
        with self.assertRaisesRegex(BuildControlError,"command"):
            completion.validate_saved_completion(request,observed)

    def test_process_identity_shape_is_closed(self):
        for change in ({"pid":True},{"start_token":""},{"pid_namespace":"other"},{"unexpected":1}):
            request, observed = fixture()
            request["controller_exit_evidence"]["process_identity"].update(change)
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request, observed)

class CompletionTransactionTests(unittest.TestCase):
    def setUp(self):
        self.reader = patch.object(legacy,"read_raw",return_value=None)
        self.reader.start()
        self.addCleanup(self.reader.stop)

    def setup_case(self):
        from types import SimpleNamespace
        request, observed = fixture()
        observed.update(current_receipt_raw=observed["receipt_raw"],
                        expected_lease_command=["owned-operation", request["attempt"]],
                        archive_sha256="c"*64,
                        group_ledger={"schema_version":"host_resource_ledger.v4","reservations":[]})
        observed["containers"]["lease"]["Config"]["Cmd"] = observed["expected_lease_command"]
        request["containers"]["lease"]["fingerprint"] = legacy.fingerprint(observed["containers"]["lease"])
        control = unittest.mock.Mock()
        control.project = request["compose_project"]
        control.path.side_effect = lambda p: "/control/" + p
        control.volume = "owned-control"
        control.namespace = None
        args = SimpleNamespace(request="verification/request.json",request_sha256=sha(raw(request)),
                               port=3203,preview=True,preview_sha256=None)
        return args, control, request, observed

    def test_preview_has_no_publisher_or_finish_side_effect(self):
        args, control, request, observed = self.setup_case()
        with patch.object(completion,"_collect",return_value=(observed,{})), \
             patch.object(completion,"_publish") as publish:
            result = completion.reconcile_saved_completion(args,control,Path(request["source_root"]),request,raw(request))
        self.assertEqual(result["state"],"validated-only")
        self.assertRegex(result["plan_sha256"],r"^[0-9a-f]{64}$")
        publish.assert_not_called()
        control.write.assert_not_called()
        control.write_bytes.assert_not_called()

    def test_apply_requires_matching_preview_and_rechecks_before_publish(self):
        args, control, request, observed = self.setup_case()
        for digest in (None,"f"*64):
            args.preview=False; args.preview_sha256=digest
            with patch.object(completion,"_collect",return_value=(observed,{})), \
                 patch.object(completion,"_publish") as publish, self.assertRaises(BuildControlError):
                completion.reconcile_saved_completion(args,control,Path(request["source_root"]),request,raw(request))
            publish.assert_not_called()
        args.preview=True;args.preview_sha256=None
        with patch.object(completion,"_collect",return_value=(observed,{})):
            plan = completion.reconcile_saved_completion(args,control,Path(request["source_root"]),request,raw(request))
        args.preview=False;args.preview_sha256=plan["plan_sha256"]
        for change in ("archive","session","history","lease"):
            changed=copy.deepcopy(observed)
            if change=="archive": changed["archive_sha256"]="f"*64
            if change=="session": changed["health"]["active_session"]=True
            if change=="history": changed["retained_catalogs"]=[{"run_id":"foreign"}]
            if change=="lease": changed["containers"]["lease"]["Config"]["Cmd"]=["foreign"]
            with self.subTest(change=change), \
                 patch.object(completion,"_collect",side_effect=[(observed,{}),(changed,{})]), \
                 patch.object(completion,"_publish") as publish, self.assertRaises(BuildControlError):
                completion.reconcile_saved_completion(args,control,Path(request["source_root"]),request,raw(request))
            publish.assert_not_called()
        control.write.assert_not_called();control.write_bytes.assert_not_called()

    def test_real_lease_command_archive_and_nonreleased_ledger_refuse(self):
        for change in ("lease","archive","reservation"):
            args,control,request,observed=self.setup_case()
            if change=="lease":
                observed["containers"]["lease"]["Config"]["Cmd"]=["unowned"]
                request["containers"]["lease"]["fingerprint"]=legacy.fingerprint(observed["containers"]["lease"])
            if change=="archive": observed["archive_sha256"]="f"*64
            if change=="reservation": observed["group_ledger"]["reservations"]=[{"state":"running"}]
            with self.subTest(change=change),self.assertRaises(BuildControlError):
                completion.validate_saved_completion(request,observed)

    def test_even_matching_preview_cannot_apply_without_shared_runtime_fence(self):
        args,control,request,observed=self.setup_case()
        with patch.object(completion,"_collect",return_value=(observed,{})):
            plan=completion.reconcile_saved_completion(args,control,Path(request["source_root"]),request,raw(request))
            self.assertFalse(plan["apply_supported"])
            args.preview=False;args.preview_sha256=plan["plan_sha256"]
            with patch("subprocess.Popen") as spawn,self.assertRaisesRegex(BuildControlError,"atomic"):
                completion.reconcile_saved_completion(args,control,Path(request["source_root"]),request,raw(request))
        spawn.assert_not_called();control.write.assert_not_called();control.write_bytes.assert_not_called()

    def test_preview_digest_cannot_be_sent_with_preview(self):
        args,control,request,observed=self.setup_case();args.preview_sha256="f"*64
        with patch.object(completion,"_collect") as collect, self.assertRaises(BuildControlError):
            completion.reconcile_saved_completion(args,control,Path(request["source_root"]),request,raw(request))
        collect.assert_not_called()

    def test_missing_original_launch_evidence_refuses_before_native_gates(self):
        args,control,request,observed=self.setup_case()
        with patch.object(legacy,"read_raw",return_value=None),self.assertRaisesRegex(BuildControlError,"launch"):
            completion._controller_evidence(control,"iteration/attempts/"+request["attempt"],request)




class CompletionPublicationTests(unittest.TestCase):
    def make_case(self):
        args,control,request,observed=CompletionTransactionTests().setup_case()
        args.preview=False
        root="iteration/attempts/"+request["attempt"]
        data={root+"/receipt.json":observed["receipt_raw"],
              "active":request["attempt"].encode()+b"\n",
              "iteration/current.json":b"old","iteration/verified.json":b"old"}
        def read(_control,path,optional=False):
            return data.get(path) if optional else data[path]
        reader=patch.object(legacy,"read_raw",side_effect=read);reader.start();self.addCleanup(reader.stop)
        control.read.side_effect=lambda path:json.loads(data[path])
        return args,control,request,observed,root,data

    def seed_journal(self,args,request,observed,root,data):
        result=json.loads(observed["receipt_raw"])
        result.update(state="succeeded",reconciliation={"schema":completion.SCHEMA,
            "request_sha256":args.request_sha256,
            "retained_receipt_sha256":request["retained_receipt_sha256"]})
        value=raw(result);digest=sha(value)
        data[root+"/reconciliation/completion-v1.json"]=raw({"schema":completion.SCHEMA,
            "request_sha256":args.request_sha256,"result_sha256":digest})
        data[root+"/reconciliation/"+digest+"/result.json"]=value
        data[root+"/reconciliation/"+digest+"/prepared.json"]=raw({
            "request_sha256":args.request_sha256,
            "unknown_receipt_sha256":request["retained_receipt_sha256"],"result_sha256":digest})
        return value

    def test_mutation_during_journal_must_not_reach_commit(self):
        args,control,request,observed,root,data=self.make_case()
        def write(path,value):
            data[path]=value
            if path.endswith("/result.json"):observed["archive_sha256"]="f"*64
        control.write_bytes.side_effect=write
        with patch("subprocess.Popen") as spawn, self.assertRaisesRegex(BuildControlError,"atomic"):
            completion._publish(args,control,Path(request["source_root"]),request,raw(request),
                                observed,{},completion._plan_digest(raw(request),observed))
        spawn.assert_not_called();control.write_bytes.assert_not_called()
        self.assertEqual(data["iteration/verified.json"],b"old")
        self.assertIn("active",data)

    def test_partial_journal_is_not_replayed_through_finish(self):
        args,control,request,observed,root,data=self.make_case()
        self.seed_journal(args,request,observed,root,data)
        with self.assertRaisesRegex(BuildControlError,"partial journal retained"):
            completion._recorded_result(control,root,request,args.request_sha256)
        control.write.assert_not_called();control.write_bytes.assert_not_called()

    def test_recorded_success_must_not_claim_completion_before_original_owner_releases(self):
        args,control,request,observed,root,data=self.make_case()
        value=self.seed_journal(args,request,observed,root,data)
        for path in (root+"/receipt.json",root+"/terminal.json","iteration/current.json","iteration/verified.json"):
            data[path]=value
        answer=completion._recorded_result(control,root,request,args.request_sha256)
        self.assertEqual(answer["state"],"completion-release-pending")
        self.assertIs(answer["lease_release_confirmed"],False)
        data.pop("active") # Simulate original helper's release, never a controller write.
        answer=completion._recorded_result(control,root,request,args.request_sha256)
        self.assertEqual(answer["state"],"succeeded")
        self.assertIs(answer["lease_release_confirmed"],True)
        self.assertTrue(answer["recorded_only"])
        control.write.assert_not_called();control.write_bytes.assert_not_called()

class CompletionEntryPointTests(unittest.TestCase):
    def test_dispatch_is_additive_and_preview_digest_is_forbidden_to_v1(self):
        from types import SimpleNamespace
        root=Path(__file__).resolve().parents[1]
        request,_=fixture();request["source_root"]=str(root)
        control=unittest.mock.Mock()
        configured={"services":{"fem-gpu-toolchain":{"build":{"args":{"FULLMAG_CUDA_BASE_IMAGE":"image"}}}}}
        args=SimpleNamespace(source_root=root,request="verification/request.json",
                             request_sha256=sha(raw(request)),preview=True,preview_sha256=None,port=3203)
        with patch("docker_dev_host.require_host"),patch("docker_dev._select_source",return_value=(root,{})), \
             patch("docker_dev._compose_identity",return_value={}), \
             patch.object(legacy,"toolchain_configuration",return_value=configured), \
             patch.object(legacy,"BuildControl",return_value=control), \
             patch.object(legacy,"read_raw",return_value=raw(request)), \
             patch.object(completion,"reconcile_saved_completion",return_value={"state":"validated-only"}) as delegate, \
             patch("docker_dev._require_native_windows") as windows:
            legacy.reconcile(args)
        delegate.assert_called_once();windows.assert_not_called()
        request["schema"]=legacy.SCHEMA
        args.request_sha256=sha(raw(request));args.preview_sha256="f"*64
        with patch("docker_dev_host.require_host"),patch("docker_dev._select_source",return_value=(root,{})), \
             patch("docker_dev._compose_identity",return_value={}), \
             patch.object(legacy,"toolchain_configuration",return_value=configured), \
             patch.object(legacy,"BuildControl",return_value=control), \
             patch.object(legacy,"read_raw",return_value=raw(request)), \
             patch("docker_dev._require_native_windows") as windows, self.assertRaises(BuildControlError):
            legacy.reconcile(args)
        windows.assert_not_called()

    def test_fixed_shell_passes_only_exact_optional_preview_digest(self):
        import os,subprocess,tempfile
        shell=(Path(__file__).parent/"just_storage_shell.sh").read_text()
        marker='  *"scripts/docker_volume_reconcile.py"*)'
        branch=marker+shell.split(marker,1)[1].split('\n  *',1)[0]
        with tempfile.TemporaryDirectory() as directory:
            stub=Path(directory)/"python"
            stub.write_text('#!/bin/bash\nprintf "%s\\0" "$@"\n');stub.chmod(0o755)
            base='python "/repo/scripts/docker_volume_reconcile.py" --request \'verification/r.json\' --request-sha256 \''+'a'*64+'\' --source-root \'/repo\' --port \'3203\''
            for suffix,valid in ((" --preview",True),(" --preview-sha256 '"+'b'*64+"'",True),
                                 (" --preview-sha256 bad",False),
                                 (" --preview-sha256 '"+'b'*64+"'; echo injected",False),
                                 (" --preview-sha256 '"+'b'*64+"' --restart-backend",False),
                                 (" --preview --preview-sha256 '"+'b'*64+"'",False)):
                env={**os.environ,"recipe":base+suffix,"python_cmd":str(stub),"script_dir":"/trusted/scripts"}
                result=subprocess.run(["bash","-euo","pipefail","-c",'case "$recipe" in\n'+branch+'\nesac\n'],
                                      env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
                with self.subTest(suffix=suffix):
                    if valid:
                        self.assertEqual(result.returncode,0,result.stderr)
                        if "--preview-sha256" in suffix:
                            self.assertEqual(result.stdout.split(b"\0")[-3:-1],[b"--preview-sha256",b"b"*64])
                    else:self.assertNotEqual(result.returncode,0)



if __name__ == "__main__":
    unittest.main()
