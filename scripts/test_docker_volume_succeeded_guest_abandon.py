"""Offline admission and interruption regressions. Never contacts Docker."""
from copy import deepcopy
import io
import json
from pathlib import Path
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import docker_volume_succeeded_guest_abandon as c


class MemoryControl:
    project = "test-group"
    volume = "test-private-volume"
    def __init__(self, documents=None):
        self.documents = documents or {}
    def read_bytes(self, path, *, optional=False, **_):
        if path in self.documents:
            return self.documents[path]
        if optional:
            return None
        raise AssertionError("Unexpected missing document: " + path)


def actual(service, running=True):
    return {"Id": ("a" if service == "backend" else "b") * 64, "Image": "sha256:" + "c" * 64,
            "Config": {"Labels": {"com.docker.compose.project": "test-group", "com.docker.compose.service": service}},
            "HostConfig": {}, "Mounts": [], "State": {"Running": running, "Restarting": False,
                "OOMKilled": False, "Pid": 12 if running else 0, "ExitCode": 0,
                "StartedAt": "2026-11-05T11:20:10.341375824Z", "FinishedAt": "2026-11-05T12:00:00Z"}}


def request():
    backend, frontend = actual("backend"), actual("frontend")
    helper = deepcopy(backend);helper["Id"] = "d" * 64
    return {"schema": c.REQUEST, "request_id": "c1c54726-2519-42af-a3d8-c8e7ae610d6e",
            "source_root": "/repo", "image_id": backend["Image"],
            "recreate_request_path": c.PREFIX + "verification/original/seed.json",
            "recreate_request_sha256": "e" * 64, "original_attempt": "f" * 32,
            "original_receipt_sha256": "1" * 64, "helper": c.base.container_pin(helper),
            "backend": c.base.container_pin(backend), "frontend": c.base.container_pin(frontend),
            "expected_observation_sha256": "0" * 64}


class AbandonAdmissionTests(unittest.TestCase):
    def test_request_and_placeholder_are_typed(self):
        value = request()
        self.assertEqual(c.validate_request(value), value)
        changed = deepcopy(value);changed["expected_observation_sha256"] = "2" * 64
        self.assertEqual(c._request_intent(value), c._request_intent(changed))
        self.assertNotEqual(c.digest(c.canonical(value)), c.digest(c.canonical(changed)))

    def test_noncanonical_request_refuses_before_lineage_or_runtime_observation(self):
        req = request()
        raw = json.dumps(req, indent=2).encode()
        control = MemoryControl({"verification/request.json": raw})
        args = SimpleNamespace(source_root="/repo", image_id=req["image_id"],
            request="verification/request.json", request_sha256=c.digest(raw), apply=True)
        with patch("docker_dev._select_source", return_value=(Path("/repo"), object())), \
             patch("docker_dev._compose_identity", return_value={}), \
             patch.object(c, "BuildControl", return_value=control), \
             patch.object(c, "load_lineage") as lineage:
            with self.assertRaisesRegex(c.base.BuildControlError, "canonical JSON"):
                c.run(args)
        lineage.assert_not_called()

    def test_observation_binds_canonical_changes_not_raw_docker_diff_order(self):
        lineage = {"compose_sha256": "1" * 64, "core": {"docker_engine_id_sha256": "2" * 64}, "sources": {"controller": "3" * 64}}
        layers = {"backend": {"diff_sha256": "4" * 64, "canonical_diff_sha256": "5" * 64,
            "entries": [{"path": "/etc/ld.so.cache", "sha256": "6" * 64}]}}
        first = c.observation(request(), lineage, {}, layers, "7" * 64)
        self.assertIn("diff_sha256", layers["backend"])
        reordered = deepcopy(layers);reordered["backend"]["diff_sha256"] = "8" * 64
        self.assertEqual(first, c.observation(request(), lineage, {}, reordered, "7" * 64))
        for key in ("canonical_diff_sha256", "entries"):
            changed = deepcopy(reordered)
            changed["backend"][key] = "9" * 64 if key != "entries" else [{"path": "/etc/ld.so.cache", "sha256": "a" * 64}]
            with self.subTest(key=key):
                self.assertNotEqual(first, c.observation(request(), lineage, {}, changed, "7" * 64))

    def test_no_old_no_spawn_schema_or_extra_authority(self):
        for name, value in (("schema", "fullmag.succeeded-namespace-failed-recreate-finish.v1"),
                            ("extra", True), ("request_id", "00000000-0000-0000-0000-000000000000"),
                            ("recreate_request_path", c.PREFIX + "verification/../active")):
            with self.subTest(name=name):
                item = request();item[name] = value
                with self.assertRaises((c.base.BuildControlError, ValueError)):
                    c.validate_request(item)

    def test_changed_pin_cannot_authorize_signal(self):
        for key in ("container_id", "image_id", "started_at", "fingerprint"):
            value = request();value["backend"][key] = ("9" * 64 if key != "started_at" else "2026-11-06T00:00:00Z")
            called = []
            with self.subTest(key=key), self.assertRaises(c.base.BuildControlError):
                c.signal_once(MemoryControl(), value, "backend", None, lambda _: actual("backend"),
                              lambda: called.append("signal"), lambda: None)
            self.assertEqual(called, [])

    def test_fresh_only_guards(self):
        c._fresh_only(SimpleNamespace(fresh_state=True), recreate_services=True, retire_only=False)
        for name in ("script", "recovery_authorization", "resume_recreation", "completed_recreation_attempt",
                     "terminal_observation_proof", "build_for_recovery", "pending_recovery_successor", "headless"):
            args = SimpleNamespace(fresh_state=True, **{name: True})
            with self.subTest(name=name), self.assertRaises(c.base.BuildControlError):
                c._fresh_only(args, recreate_services=True, retire_only=False)
        for recreate, fresh, retire in ((False, True, False), (True, False, False), (True, True, True)):
            with self.assertRaises(c.base.BuildControlError):
                c._fresh_only(SimpleNamespace(fresh_state=fresh), recreate_services=recreate, retire_only=retire)

    def test_guest_cannot_hide_new_work_or_lost_fence(self):
        req = request();lineage = {"seed": {"guest_request_sha256": "3" * 64}, "guest": {"guest_sha256": "4" * 64}}
        state = {"schema": "fullmag.succeeded-guest-abandon-guest.v1", "guest_request_sha256": "3" * 64,
                 "backend_id": req["backend"]["container_id"], "pid1_source_sha256": "4" * 64,
                 "diagnostic_only": True, "no_other_processes": True, "no_pending_work": True, "protected": {"hash": "5" * 64}}
        c.validate_guest_state(req, lineage, state)
        for key in ("diagnostic_only", "no_other_processes", "no_pending_work", "pid1_source_sha256", "backend_id"):
            changed = deepcopy(state);changed[key] = False
            with self.subTest(key=key), self.assertRaises(c.base.BuildControlError):
                c.validate_guest_state(req, lineage, changed)

    def test_existing_intent_running_never_replays(self):
        calls = []
        with self.assertRaises(c.base.BuildControlError):
            c.signal_once(MemoryControl(), request(), "backend", b"intent", lambda _: actual("backend"),
                          lambda: calls.append("signal"), lambda: calls.append("wait"))
        self.assertEqual(calls, [])

    def test_existing_intent_stopped_is_observation_only(self):
        calls = []
        result = c.signal_once(MemoryControl(), request(), "backend", b"intent", lambda _: actual("backend", False),
                               lambda: calls.append("signal"), lambda: calls.append("wait"))
        self.assertFalse(result["State"]["Running"])
        self.assertEqual(calls, [])

    def test_timeout_has_no_second_signal_or_escalation(self):
        calls = []
        def wait():
            raise c.base.BuildControlError("SIGTERM timeout")
        with self.assertRaisesRegex(c.base.BuildControlError, "timeout"):
            c.signal_once(MemoryControl(), request(), "backend", None, lambda _: actual("backend"),
                          lambda: calls.append("SIGTERM") or True, wait)
        self.assertEqual(calls, ["SIGTERM"])

    def test_no_success_without_stop_and_no_signal_if_intent_create_lost(self):
        for signal in (lambda: True, lambda: False):
            with self.assertRaises(c.base.BuildControlError):
                c.signal_once(MemoryControl(), request(), "backend", None, lambda _: actual("backend"), signal, lambda: None)

    def test_stopped_pid_and_oom_guards(self):
        for key, value in (("Pid", 10), ("OOMKilled", True), ("Restarting", True), ("FinishedAt", "0001-01-01T00:00:00Z")):
            item = actual("backend", False);item["State"][key] = value
            with self.subTest(key=key), self.assertRaises(c.base.BuildControlError):
                c.validate_stopped(item, request()["backend"], "test-group", "backend")

    def test_resume_or_attestation_refuses(self):
        lineage = {"guest": {"status_path": c.PREFIX + "verification/x/status.json",
                              "resume_intent_path": c.PREFIX + "verification/x/resume.json"},
                   "seed": {"guest_request_path": c.PREFIX + "verification/x/guest.json"}}
        c._no_handoff(MemoryControl(), lineage)
        for suffix in ("status.native-preview.json", "status.handoff-committed.json", "resume.json", "engine-attestation.json"):
            control = MemoryControl({"verification/x/" + suffix: b"{}"})
            with self.subTest(suffix=suffix), self.assertRaises(c.base.BuildControlError):
                c._no_handoff(control, lineage)

    def test_stopped_payload_validation_including_empty(self):
        for payload in (b"", b"preserved runtime file"):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as archive:
                row = tarfile.TarInfo("runtime.json");row.size = len(payload)
                archive.addfile(row, io.BytesIO(payload))
            expected = {"path": "/etc/runtime.json", "size": len(payload), "sha256": c.digest(payload)}
            c._validate_tar(stream.getvalue(), expected)
            expected["sha256"] = "0" * 64
            with self.assertRaises(c.base.BuildControlError):
                c._validate_tar(stream.getvalue(), expected)

    def test_kernel_fence_code_compiles_without_execution(self):
        compile(c.FENCE, "<diagnostic-fence>", "exec")


    def test_no_engine_receipt_means_no_confirmed_stop(self):
        req = request();control = MemoryControl()
        root = c._root(req);request_sha = c.digest(c.canonical(req) + b"\n")
        for service in c.SERVICES:
            cid = req[service]["container_id"]
            docs = {
                "signal-intent.json": {"schema": "fullmag.succeeded-guest-sigterm-intent.v1", "request_sha256": request_sha,
                    "service": service, "pin": req[service], "signal": "SIGTERM", "escalation": False},
                "sigterm.json": {"engine_id_sha256": "7" * 64, "argv": ["kill", "--signal", "SIGTERM", cid],
                    "exit_code": 0, "stdout": cid + "\n", "stderr": ""},
                "stopped-inspect.json": {"engine_id_sha256": "7" * 64, "argv": ["inspect", cid], "exit_code": 0,
                    "stdout": json.dumps([actual(service, False)]), "stderr": ""},
            }
            for suffix, value in docs.items():
                control.documents[root + "/" + service + "/" + suffix] = c.canonical(value)
            control.documents[root + "/" + service + "/stdout.log"] = b""
            control.documents[root + "/" + service + "/stderr.log"] = b""
        self.assertEqual(len(c._stop_documents(control, req, "7" * 64, request_sha)), 10)
        path = root + "/backend/sigterm.json"
        original = control.documents.pop(path)
        with self.assertRaises(AssertionError):
            c._stop_documents(control, req, "7" * 64, request_sha)
        changed = json.loads(original);changed["argv"][2] = "SIGKILL";control.documents[path] = c.canonical(changed)
        with self.assertRaises(c.base.BuildControlError):
            c._stop_documents(control, req, "7" * 64, request_sha)

    def test_unknown_inspect_failure_is_not_helper_absence(self):
        cid = "a" * 64
        missing = SimpleNamespace(returncode=1, stdout=b"[]\n", stderr=("Error: No such object: " + cid).encode())
        with patch.object(c, "docker_capture", return_value=missing):
            self.assertIsNone(c._inspect_optional(cid))
        missing.stderr = b"permission denied"
        with patch.object(c, "docker_capture", return_value=missing), self.assertRaises(c.base.BuildControlError):
            c._inspect_optional(cid)

    def test_readonly_helper_preserves_exact_subpaths_and_path_environment(self):
        control = MemoryControl()
        control.helper_args = lambda script: ["docker", "run", "--entrypoint", "/bin/bash", "image", "-c", script]
        backend = actual("backend", False)
        roots = ("/state", "/host-ledger", "/opt/fullmag/runtime-control", "/opt/fullmag/source")
        backend["Mounts"] = [{"Type": "volume", "Name": "test-volume", "Destination": root} for root in roots]
        backend["HostConfig"]["Mounts"] = [{"Target": root, "VolumeOptions": {"Subpath": "part" + str(i)}}
                                               for i, root in enumerate(roots)]
        backend["Config"]["Env"] = ["FULLMAG_HOST_LEDGER_ROOT=/host-ledger/ledger", "FULLMAG_RUNTIME_SERVICES_ROOT=/opt/fullmag/runtime-control/runtime-service", "SECRET_DO_NOT_FORWARD=hidden"]
        captured = []
        def read(args, **kwargs):
            captured.append(args)
            return SimpleNamespace(returncode=0, stdout=b'{"files":23}', stderr=b"")
        with patch("docker_build_control.bounded_capture", side_effect=read):
            self.assertEqual(c.read_protected(control, {"guest": {}}, backend), {"files": 23})
        args = captured[0]
        self.assertEqual(sum("readonly,volume-nocopy,volume-subpath=part" in item for item in args), 4)
        self.assertIn("FULLMAG_RUNTIME_SERVICES_ROOT=/opt/fullmag/runtime-control/runtime-service", args)
        self.assertFalse(any("SECRET_DO_NOT_FORWARD" in item for item in args))


class NaturalHealthProbeTests(unittest.TestCase):
    def test_exact_health_probe_must_naturally_exit_then_rescan(self):
        with patch.object(c, "_extra_processes", side_effect=[[(123, c.HEALTH_COMMAND)], []]) as scan, \
             patch.object(c.time, "sleep") as sleep, patch.object(c.time, "monotonic", side_effect=[0.0, 0.1]), \
             patch.object(c, "docker_capture", side_effect=AssertionError("No signal/runtime command permitted")):
            c.wait_for_no_extra_processes({1, 7, 99})
        self.assertEqual(scan.call_count, 2)
        sleep.assert_called_once_with(0.05)

    def test_unknown_worker_or_altered_health_command_refuses_immediately(self):
        for command in (b"/candidate/bin/fullmag-worker\0", c.HEALTH_COMMAND + b"--changed\0"):
            with patch.object(c, "_extra_processes", return_value=[(123, command)]), \
                 patch.object(c.time, "sleep") as sleep, \
                 patch.object(c, "docker_capture", side_effect=AssertionError("No signal/runtime command permitted")):
                with self.assertRaisesRegex(c.base.BuildControlError, "Another process"):
                    c.wait_for_no_extra_processes({1, 7, 99})
                sleep.assert_not_called()

    def test_live_health_at_deadline_is_not_ignored_or_killed(self):
        with patch.object(c, "_extra_processes", return_value=[(123, c.HEALTH_COMMAND)]), \
             patch.object(c.time, "monotonic", side_effect=[0.0, 2.0]), patch.object(c.time, "sleep") as sleep, \
             patch.object(c, "docker_capture", side_effect=AssertionError("No signal/runtime command permitted")):
            with self.assertRaisesRegex(c.base.BuildControlError, "naturally exit"):
                c.wait_for_no_extra_processes({1, 7, 99})
            sleep.assert_not_called()

    def test_unknown_process_during_health_wait_still_refuses(self):
        with patch.object(c, "_extra_processes", side_effect=[[(123, c.HEALTH_COMMAND)], [(456, b"worker\0")]]), \
             patch.object(c.time, "sleep"), patch.object(c.time, "monotonic", side_effect=[0.0, 0.1]), \
             patch.object(c, "docker_capture", side_effect=AssertionError("No signal/runtime command permitted")):
            with self.assertRaisesRegex(c.base.BuildControlError, "Another process"):
                c.wait_for_no_extra_processes({1, 7, 99})


class FrontendLayerAdapterTests(unittest.TestCase):
    def inventory(self):
        return {"schema": "fullmag.succeeded-namespace-writable-layer.v1", "diff_sha256": "1" * 64,
                "canonical_diff_sha256": "2" * 64, "preserved_bytes": 4,
                "unknown_paths": [c.FRONTEND_OWNER, c.FRONTEND_CACHE], "entries": [
                    {"path": "/etc/ld.so.cache", "change": "C", "kind": "regular", "mode": 0o100644,
                     "uid": 0, "gid": 0, "size": 4, "recognized_runtime_path": True, "disposition": "preserved-control-file"},
                    {"path": c.FRONTEND_OWNER, "change": "A", "kind": "directory", "mode": 0o40700,
                     "uid": 65532, "gid": 65532, "size": 60, "recognized_runtime_path": False},
                    {"path": c.FRONTEND_CACHE, "change": "C", "kind": "directory", "mode": 0o40755,
                     "uid": 0, "gid": 0, "size": 4096, "recognized_runtime_path": False}]}

    def test_base_partition_and_totals_remain_exact(self):
        raw = self.inventory();before = deepcopy(raw)
        known, special = c._frontend_rows(raw, "frontend")
        self.assertEqual(raw, before)
        self.assertEqual(known["preserved_bytes"], 4)
        self.assertEqual(known["unknown_paths"], [])
        c.base.hash_layer_inventory(known, lambda _row: "a" * 64)
        merged = deepcopy(raw);merged["entries"] = known["entries"] + special
        again, selected = c._frontend_rows(merged, "frontend")
        self.assertEqual(again["preserved_bytes"], 4)
        self.assertEqual(len(selected), 2)
        self.assertEqual(merged["diff_sha256"], before["diff_sha256"])
        self.assertEqual(merged["canonical_diff_sha256"], before["canonical_diff_sha256"])

    def test_backend_descendants_files_symlinks_deleted_paths_refuse(self):
        with self.assertRaises(c.base.BuildControlError):
            c._frontend_rows(self.inventory(), "backend")
        for index, field, value in ((1, "kind", "symlink"), (1, "mode", 0o120777), (1, "change", "D"),
                                    (1, "kind", "regular"), (2, "kind", "regular"), (2, "change", "D")):
            inventory = self.inventory();inventory["entries"][index][field] = value
            with self.subTest(index=index, field=field), self.assertRaises(c.base.BuildControlError):
                c._frontend_rows(inventory, "frontend")
        inventory = self.inventory()
        inventory["entries"].append({"path": c.FRONTEND_OWNER + "/child"})
        inventory["unknown_paths"].append(c.FRONTEND_OWNER + "/child")
        known, _special = c._frontend_rows(inventory, "frontend")
        with self.assertRaises(c.base.BuildControlError):
            c.base.hash_layer_inventory(known, lambda _: "a" * 64)

    def test_only_original_base_files_are_copied(self):
        inventory = self.inventory();calls = []
        def execute(_cid, function, payload, **_kwargs):
            calls.append(function)
            if function == "guest_layer_snapshot": return c.canonical(inventory)
            if function == "guest_layer_hash": return c.digest(b"base").encode()
            if function == "frontend_mountpoint_metadata": return c.canonical(payload)
            if function == "guest_layer_payload": return b"base"
            raise AssertionError(function)
        with patch.object(c, "docker_capture", return_value=SimpleNamespace(stdout=b"", stderr=b"")), \
             patch.object(c, "_layer_exec", side_effect=execute):
            merged = c.layer_snapshot("pinned", "frontend")
            saved = {};control = MemoryControl();control.write_bytes = lambda path, raw: saved.setdefault(path, raw)
            c.copy_layer_payloads(control, "proof/frontend", "pinned", "frontend", merged)
        self.assertEqual(merged["preserved_bytes"], 4)
        self.assertEqual(list(saved.values()), [b"base"])
        self.assertEqual(calls.count("guest_layer_hash"), 1)
        self.assertEqual(calls.count("frontend_mountpoint_metadata"), 2)

    def test_immutable_syncs_all_new_ancestors_and_existing_replay(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "control";root.mkdir()
            commands = []
            control = MemoryControl();control.path = lambda relative: "/control/" + relative
            def capture(*args, **_kwargs):
                commands.append(args)
                return SimpleNamespace(stdout=b"created\n", stderr=b"")
            with patch.object(c, "docker_capture", side_effect=capture):
                c._immutable(control, "helper", "new/deep/proof.json", b"payload")
            command = commands[0];code = command[command.index("-c") + 1]
            code = code.replace("'/control/'", repr(str(root) + "/")).replace("'/control'", repr(str(root)))
            path = root / "new/deep/proof.json"
            for _ in range(2):
                synced = [];real_sync = os.fsync
                def sync(fd):
                    synced.append(os.readlink('/proc/self/fd/' + str(fd)));real_sync(fd)
                with patch("sys.argv", ["publisher", str(path)]), \
                     patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(b"payload"))), \
                     patch("sys.stdout", io.StringIO()), patch.object(os, "fsync", side_effect=sync):
                    exec(compile(code, "<immutable-publisher>", "exec"), {})
                self.assertEqual(synced, [str(path), str(path.parent), str(path.parent.parent), str(root)])


class PostStopReadAndProvenanceTests(unittest.TestCase):
    def backend(self):
        row = actual("backend", False)
        roots = ["/state", "/host-ledger", "/opt/fullmag/runtime-control", "/opt/fullmag/source",
                 "/state/runs/docker-all/session-store/runtime-services"]
        row["Mounts"] = [{"Type": "volume", "Name": "private", "Destination": root} for root in roots]
        row["HostConfig"]["Mounts"] = [{"Target": root, "VolumeOptions": {"Subpath": "part/" + str(i)}}
                                       for i, root in enumerate(roots)]
        row["Config"]["Env"] = ["FULLMAG_HOST_LEDGER_ROOT=/host-ledger/ledger"]
        return row

    def test_exact_nested_runtime_services_mount_is_mirrored_readonly(self):
        control = MemoryControl();control.helper_args = lambda script: ["docker", "run", "--entrypoint", "/bin/bash", "image", "-c", script]
        captured = []
        def read(args, **_kwargs):
            captured.append(args)
            return SimpleNamespace(returncode=0, stdout=b'{"unchanged":true}', stderr=b"")
        with patch("docker_build_control.bounded_capture", side_effect=read):
            c.read_protected(control, {"guest": {}}, self.backend())
        nested = [arg for arg in captured[0] if "dst=/state/runs/docker-all/session-store/runtime-services," in arg]
        self.assertEqual(nested, ["type=volume,src=private,dst=/state/runs/docker-all/session-store/runtime-services,readonly,volume-nocopy,volume-subpath=part/4"])

    def test_nested_path_escape_refuses_before_helper_and_error_keeps_bounded_cause(self):
        control = MemoryControl();control.helper_args = lambda script: ["docker", "run", "--entrypoint", "/bin/bash", "image", "-c", script]
        backend = self.backend();backend["HostConfig"]["Mounts"][-1]["VolumeOptions"]["Subpath"] = "../wrong"
        with patch("docker_build_control.bounded_capture") as run:
            with self.assertRaisesRegex(c.base.BuildControlError, "Unsafe volume subpath"):
                c.read_protected(control, {"guest": {}}, backend)
            run.assert_not_called()
        response = SimpleNamespace(returncode=1, stdout=b"", stderr=b"x" * 4000 + b"missing OWNER.json")
        with patch("docker_build_control.bounded_capture", return_value=response):
            with self.assertRaisesRegex(c.base.BuildControlError, "missing OWNER.json") as error:
                c.read_protected(control, {"guest": {}}, self.backend())
            self.assertLess(len(str(error.exception)), 2150)

    def test_changed_reader_records_actual_pre_and_post_sources(self):
        req = request();controller = "docker_volume_succeeded_guest_abandon.py";original = "docker_volume_succeeded_namespace_recovery.py"
        archived = b"actual pre-stop source"
        before = {controller: c.digest(archived), original: "b" * 64}
        after = {controller: "a" * 64, original: "b" * 64}
        observed = {"sources": deepcopy(before)};lineage = {"sources": after, "core": {"docker_engine_id_sha256": "7" * 64}}
        path = c._root(req) + "/pre-stop-controller.py"
        control = MemoryControl({path: archived})
        with patch.object(c, "_stop_documents", return_value={"typed-stops": "c" * 64}) as stops:
            phase, documents, receipt_hashes = c._source_phase(control, req, lineage, observed, "d" * 64)
        stops.assert_called_once_with(control, req, "7" * 64, "d" * 64)
        self.assertEqual(phase["pre_stop_sources"], before)
        self.assertEqual(phase["sources"], after)
        self.assertEqual(observed["sources"], before)
        self.assertEqual(phase["pre_stop_controller_path"], c.PREFIX + path)
        self.assertEqual(documents, {path: c.digest(archived)})
        self.assertEqual(receipt_hashes, {"typed-stops": "c" * 64})

    def test_archive_missing_changed_or_base_changed_cannot_authorize_continuation(self):
        req = request();controller = "docker_volume_succeeded_guest_abandon.py";original = "docker_volume_succeeded_namespace_recovery.py"
        before = {controller: c.digest(b"old"), original: "b" * 64}
        lineage = {"sources": {controller: "a" * 64, original: "b" * 64}, "core": {"docker_engine_id_sha256": "7" * 64}}
        path = c._root(req) + "/pre-stop-controller.py"
        for documents in ({}, {path: b"changed"}):
            with patch.object(c, "_stop_documents", return_value={}), self.assertRaises((AssertionError, c.base.BuildControlError)):
                c._source_phase(MemoryControl(documents), req, lineage, {"sources": before}, "d" * 64)
        changed = deepcopy(lineage);changed["sources"][original] = "c" * 64
        with patch.object(c, "_stop_documents") as stops:
            with self.assertRaisesRegex(c.base.BuildControlError, "Original recovery source"):
                c._source_phase(MemoryControl({path: b"old"}), req, changed, {"sources": before}, "d" * 64)
            stops.assert_not_called()
        with patch.object(c, "_stop_documents", side_effect=c.base.BuildControlError("No exact stopped receipts")):
            with self.assertRaisesRegex(c.base.BuildControlError, "stopped receipts"):
                c._source_phase(MemoryControl({path: b"old"}), req, lineage, {"sources": before}, "d" * 64)

    def test_unchanged_source_needs_no_fabricated_archive(self):
        sources = {"docker_volume_succeeded_guest_abandon.py": "a" * 64,
                   "docker_volume_succeeded_namespace_recovery.py": "b" * 64}
        lineage = {"sources": sources, "core": {"docker_engine_id_sha256": "7" * 64}}
        with patch.object(c, "_stop_documents", return_value={}):
            phase, documents, _stops = c._source_phase(MemoryControl(), request(), lineage, {"sources": sources}, "d" * 64)
        self.assertEqual(phase, {"sources": sources, "pre_stop_sources": sources})
        self.assertEqual(documents, {})


class OriginalLineageTests(unittest.TestCase):
    def fixture(self):
        req = request();control = MemoryControl()
        core = {"private_volume_name": control.volume, "docker_engine_id_sha256": "7" * 64}
        native = {"schema_version": "runtime_service_succeeded_namespace_recovery.v1", "teardown": core,
                  "package_receipt_sha256": "8" * 64, "source_snapshot_sha256": "9" * 64}
        guest = {"schema": "fullmag.succeeded-namespace-guest.v1", "teardown": core,
                 "teardown_request_sha256": c.digest(c.canonical(core)), "candidate_path": "/candidate",
                 "candidate_receipt_sha256": "8" * 64, "source_snapshot_sha256": "9" * 64,
                 "guest_sha256": c.digest(b"source")}
        authored = {"name": control.project, "services": {"backend": {"init": True}, "frontend": {}}}
        seed = {"schema": "fullmag.succeeded-namespace-recreate-request.v1", "source_root": req["source_root"],
                "compose_project": control.project, "frontend": deepcopy(req["frontend"]),
                "native_request_path": c.PREFIX + "verification/o/native.json", "native_request_sha256": "1" * 64,
                "guest_request_path": c.PREFIX + "verification/o/guest.json", "guest_request_sha256": "2" * 64,
                "compose_path": c.PREFIX + "verification/o/compose.json", "compose_sha256": "3" * 64}
        seed["frontend"]["started_at"] = "2026-11-05T10:00:00Z"
        planned = deepcopy(authored);planned["services"]["backend"].update(init=False,
            entrypoint=["/usr/local/bin/python3", "-B", "/opt/fullmag/source/scripts/docker_volume_succeeded_namespace_guest.py",
                        "--request", seed["guest_request_path"], "--request-sha256", seed["guest_request_sha256"]],
            command=[], **{"x-fullmag-daemon-binds": {}})
        receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": "succeeded-namespace-recreate",
                   "state": "outcome-unknown-resources-retained", "attempt": req["original_attempt"],
                   "compose_project": control.project, "control_volume": control.volume,
                   "helper_container": "fullmag-control-" + req["original_attempt"],
                   "inputs": {"source_root": req["source_root"], "request_sha256": req["recreate_request_sha256"],
                              "controller_sha256": c.digest(b"source")}}
        raw = c.canonical(receipt) + b"\n";req["original_receipt_sha256"] = c.digest(raw)
        root = c._original_root(req)
        control.documents.update({root + "/receipt.json": raw, root + "/compose.json": c.canonical(planned) + b"\n"})
        docs = {req["recreate_request_path"]: seed, seed["native_request_path"]: native,
                seed["guest_request_path"]: guest, seed["compose_path"]: authored}
        return req, control, docs

    def load(self, req, control, docs):
        with patch.object(c, "_read", side_effect=lambda _c, path, _sha: docs[path]), \
             patch("docker_volume_container_recovery._docker_engine_sha", return_value="7" * 64), \
             patch.object(c.base, "regular", return_value=b"source"), \
             patch.object(c.base, "managed_candidate_result", return_value={"candidate": "/candidate"}):
            return c.load_lineage(control, req)

    def test_current_frontend_start_is_explicit_not_historical_reinterpretation(self):
        req, control, docs = self.fixture()
        self.assertNotEqual(docs[req["recreate_request_path"]]["frontend"]["started_at"], req["frontend"]["started_at"])
        self.assertFalse(self.load(req, control, docs)["compose"]["services"]["backend"]["init"])

    def test_changed_frontend_identity_or_init_true_refuses(self):
        for key in ("container_id", "image_id", "fingerprint"):
            req, control, docs = self.fixture();req["frontend"][key] = "bad"
            with self.subTest(key=key), self.assertRaises(c.base.BuildControlError):
                self.load(req, control, docs)
        req, control, docs = self.fixture()
        path = c._original_root(req) + "/compose.json"
        planned = json.loads(control.documents[path]);planned["services"]["backend"]["init"] = True
        control.documents[path] = c.canonical(planned)
        with self.assertRaises(c.base.BuildControlError):
            self.load(req, control, docs)

    def test_other_helper_or_receipt_cannot_be_terminalized(self):
        req, control, docs = self.fixture();path = c._original_root(req) + "/receipt.json"
        receipt = json.loads(control.documents[path]);receipt["helper_container"] = "foreign"
        control.documents[path] = c.canonical(receipt);req["original_receipt_sha256"] = c.digest(control.documents[path])
        with self.assertRaises(c.base.BuildControlError):
            self.load(req, control, docs)


if __name__ == "__main__":
    unittest.main()
