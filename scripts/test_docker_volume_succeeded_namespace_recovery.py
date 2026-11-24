"""Focused safety regressions for kernel-fenced succeeded namespace recovery."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_volume_succeeded_namespace_recovery as recovery
from docker_build_control import BuildControlError, canonical


class KernelEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def test_kernel_fence_blocks_other_process_allocation_and_releases(self):
        path = self.root / "WRITER.lock"
        path.write_bytes(b"")
        code = ("import fcntl,os,sys; f=os.open(sys.argv[1],os.O_RDWR); "
                "fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)")
        with recovery.kernel_lock(path):
            result = subprocess.run([sys.executable, "-B", "-c", code, str(path)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"BlockingIOError", result.stderr)
        self.assertEqual(subprocess.run([sys.executable, "-B", "-c", code, str(path)], capture_output=True).returncode, 0)

    def test_existing_immutable_replay_syncs_file_and_directory(self):
        path = self.root / "proof.json"
        recovery.immutable_bytes(path, b"proof")
        with patch.object(recovery.os, "fsync", wraps=os.fsync) as fsync:
            recovery.immutable_bytes(path, b"proof")
        self.assertEqual(fsync.call_count, 2)

    def test_empty_immutable_layer_evidence_has_durable_exact_replay(self):
        path = self.root / "empty-log.bin"
        recovery.immutable_bytes(path, b"")
        recovery.immutable_bytes(path, b"")
        with self.assertRaises(BuildControlError):
            recovery.immutable_bytes(path, b"changed")

    def test_only_monotonic_nanosecond_heartbeat_is_normalized(self):
        base = {"heartbeat_at": "2026-11-04T10:00:00.123456789Z", "pid": 42, "state": "ready"}
        recovery.same_owner_with_monotonic_heartbeat(base, {**base, "heartbeat_at": "2026-11-04T10:00:00.123456790Z"})
        for bad in ({**base, "heartbeat_at": "2026-11-04T10:00:00.123456788Z"},
                    {**base, "pid": 43}, {**base, "state": "failed"}, {**base, "extra": 1},
                    {**base, "heartbeat_at": "2026-11-04T10:00:01"}):
            with self.assertRaises(BuildControlError):
                recovery.same_owner_with_monotonic_heartbeat(base, bad)

    def test_bounded_kernel_wait_acquires_same_lock_after_real_holder_exit(self):
        path = self.root / "WRITER.lock"
        path.write_bytes(b"")
        code = ("import fcntl,os,sys,time; f=os.open(sys.argv[1],os.O_RDWR); "
                "fcntl.flock(f,fcntl.LOCK_EX); print('held',flush=True); time.sleep(.15)")
        holder = subprocess.Popen([sys.executable, "-B", "-c", code, str(path)], stdout=subprocess.PIPE)
        self.addCleanup(lambda: holder.wait(timeout=5))
        self.assertEqual(holder.stdout.readline(), b"held\n")
        with recovery.kernel_lock(path, timeout_seconds=1):
            self.assertEqual(holder.wait(timeout=5), 0)
        holder.stdout.close()

    def test_only_exact_services_and_owned_control_helper_may_consume_volume(self):
        control = SimpleNamespace(project="group", volume="private")
        operation = {"helper_container_id": "helper"}
        expected = {"backend", "frontend", "helper"}
        with patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value=expected), \
             patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value=expected):
            recovery.require_exact_consumers(control, operation, {"backend", "frontend"})
        for group, volume in ((expected | {"foreign"}, expected), (expected, expected | {"other-group"}),
                              (expected - {"backend"}, expected)):
            with patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value=group), \
                 patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value=volume):
                with self.assertRaisesRegex(BuildControlError, "consumer"):
                    recovery.require_exact_consumers(control, operation, {"backend", "frontend"})

    def test_recreate_before_create_allows_frontend_and_owned_helper_only(self):
        control = SimpleNamespace(project="group", volume="private")
        expected = {"frontend", "helper"}
        with patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value=expected), \
             patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value=expected):
            recovery.require_exact_consumers(control, {"helper_container_id": "helper"}, {"frontend"})

    def test_same_start_live_to_zombie_is_terminal_not_pid_reuse(self):
        raw = Path("/proc/self/stat").read_text()
        prefix, tail = raw.rsplit(")", 1)
        fields = tail.split()
        zombie = list(fields)
        zombie[0] = "Z"
        with patch.object(Path, "read_text", side_effect=[raw, prefix + ") " + " ".join(zombie)]), \
             patch.object(recovery, "stream_sha", return_value="a" * 64):
            self.assertIsNone(recovery.process_identity(os.getpid()))

    def test_changed_start_is_refused_even_when_second_stat_is_zombie(self):
        raw = Path("/proc/self/stat").read_text()
        prefix, tail = raw.rsplit(")", 1)
        fields = tail.split()
        zombie = list(fields)
        zombie[0], zombie[19] = "Z", str(int(fields[19]) + 1)
        with patch.object(Path, "read_text", side_effect=[raw, prefix + ") " + " ".join(zombie)]), \
             patch.object(recovery, "stream_sha", return_value="a" * 64):
            with self.assertRaisesRegex(BuildControlError, "changed during observation"):
                recovery.process_identity(os.getpid())

    def test_observation_finish_contains_no_signal_or_new_operation_call(self):
        import ast
        import inspect
        for function in (recovery.guest_finish_stop, recovery.run_finish_stop):
            calls = [node for node in ast.walk(ast.parse(inspect.getsource(function))) if isinstance(node, ast.Call)]
            forbidden = {"kill", "killpg", "operation", "guest_stop", "retire_namespace"}
            self.assertFalse(any((isinstance(node.func, ast.Attribute) and node.func.attr in forbidden)
                                or (isinstance(node.func, ast.Name) and node.func.id in forbidden) for node in calls))

    def test_root_exec_is_limited_to_the_bounded_layer_archive_helper(self):
        import ast
        import inspect
        privileged = []
        for function in ast.parse(inspect.getsource(recovery)).body:
            if not isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for call in ast.walk(function):
                if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name) or call.func.id != "docker_capture":
                    continue
                values = [arg.value if isinstance(arg, ast.Constant) else None for arg in call.args]
                if "--user" in values and values[values.index("--user") + 1] == "0":
                    privileged.append((function.name, values))
        self.assertEqual(len(privileged), 1)
        self.assertEqual(privileged[0][0], "run_layer_snapshot")
        self.assertEqual(privileged[0][1][:4], ["exec", "--user", "0", "-i"])
        self.assertNotIn("--privileged", privileged[0][1])

    def test_unknown_writable_layer_path_is_preserved_and_remains_unqualified(self):
        source = self.root / "unknown-layer-data.bin"
        source.write_bytes(b"preserve this unknown layer file")
        with patch.object(recovery, "file_sha", side_effect=AssertionError("Unknown payload must not be read")):
            result = recovery.guest_layer_snapshot("A " + str(source) + "\n")
        self.assertEqual(result["unknown_paths"], [str(source)])
        self.assertFalse(result["entries"][0]["recognized_runtime_path"])
        self.assertEqual(result["entries"][0]["disposition"], "unknown-retained-in-container")
        self.assertEqual(source.read_bytes(), b"preserve this unknown layer file")

    def layer_payload_fixture(self):
        raw = b"bounded root-owned ldconfig cache"
        row = {"path": "/var/cache/ldconfig/aux-cache", "recognized_runtime_path": True,
               "kind": "regular", "disposition": "preserved-control-file", "size": len(raw),
               "sha256": recovery.digest(raw), "uid": 0, "gid": 0, "mode": stat.S_IFREG | 0o600}
        return raw, row, {"entries": [row], "unknown_paths": [], "preserved_bytes": len(raw)}

    def test_split_root_reader_never_receives_cross_uid_control_archive_path(self):
        raw, row, inventory = self.layer_payload_fixture()
        actions, stored = [], {}
        def root_reader(observed):
            if observed["path"].startswith("/opt/fullmag/control"):
                raise PermissionError("root without DAC_OVERRIDE cannot access owner-0700 control")
            self.assertEqual(observed, row)
            actions.append("root-system-read")
            return raw
        def normal_writer(path, payload):
            actions.append("normal-control-write")
            stored[path] = payload
        recovery.copy_layer_payloads(SimpleNamespace(write_bytes=normal_writer), "verification/owned-0700", inventory, root_reader)
        self.assertEqual(actions, ["root-system-read", "normal-control-write"])
        self.assertEqual(stored, {"verification/owned-0700/layer-files/" + row["sha256"] + ".bin": raw})

    def test_unknown_or_oversize_inventory_refuses_before_any_payload_read(self):
        import copy
        for change in ("unknown", "file-limit", "total-limit", "unrecognized"):
            raw, row, inventory = self.layer_payload_fixture()
            if change == "unknown": inventory["unknown_paths"] = ["/secret"]
            elif change == "file-limit": row["size"] = recovery.MAX_BYTES + 1
            elif change == "unrecognized": row["recognized_runtime_path"] = False
            elif change == "total-limit":
                row["size"] = recovery.MAX_BYTES
                inventory["entries"] = [copy.deepcopy(row) for _ in range(9)]
                inventory["preserved_bytes"] = 9 * recovery.MAX_BYTES
            with self.subTest(change=change), patch("builtins.print"), \
                 patch.object(recovery, "guest_layer_payload") as reader:
                with self.assertRaises(BuildControlError):
                    recovery.copy_layer_payloads(SimpleNamespace(write_bytes=lambda *_: self.fail("unexpected write")),
                                                 "verification/test", inventory, reader)
                reader.assert_not_called()

    def test_payload_hash_change_refuses_before_control_write(self):
        _, _, inventory = self.layer_payload_fixture()
        with self.assertRaisesRegex(BuildControlError, "hash changed"):
            recovery.copy_layer_payloads(SimpleNamespace(write_bytes=lambda *_: self.fail("corrupt payload written")),
                                         "verification/test", inventory, lambda _: b"changed")

    def test_root_payload_read_is_exact_whitelisted_system_file_and_metadata(self):
        raw, row, _ = self.layer_payload_fixture()
        metadata = SimpleNamespace(st_mode=row["mode"], st_uid=0, st_gid=0, st_size=len(raw))
        with patch.object(recovery, "regular", return_value=raw) as reader, patch.object(Path, "stat", return_value=metadata), \
             patch.object(recovery.os, "geteuid", return_value=0):
            self.assertEqual(recovery.guest_layer_payload(row), raw)
        reader.assert_called_once_with(Path(row["path"]), recovery.MAX_BYTES, allow_empty=True)
        with self.assertRaises(BuildControlError):
            recovery.guest_layer_payload({**row, "path": "/opt/fullmag/control/private"})

    def test_metadata_snapshot_never_hashes_even_known_regular_files(self):
        source = self.root / "known-runtime-file"
        source.write_bytes(b"metadata only")
        with patch.object(recovery, "recognized_layer_path", return_value=True), \
             patch.object(recovery, "file_sha", side_effect=AssertionError("Metadata reader must not open payload")):
            inventory = recovery.guest_layer_snapshot("A " + str(source) + "\n")
        self.assertEqual(inventory["entries"][0]["kind"], "regular")
        self.assertNotIn("sha256", inventory["entries"][0])

    def test_two_owner_matrix_uses_root_zero_or_existing_default_not_file_uid(self):
        _, root_row, _ = self.layer_payload_fixture()
        normal_row = {**root_row, "path": "/run/fullmag/linux-native-host.json", "uid": 1000, "gid": 1000,
                      "mode": stat.S_IFREG | 0o640}
        for row, reader_uid in ((root_row, 0), (normal_row, 65532)):
            metadata = SimpleNamespace(st_mode=row["mode"], st_uid=row["uid"], st_gid=row["gid"], st_size=row["size"])
            with self.subTest(owner=row["uid"], reader=reader_uid), \
                 patch.object(recovery.os, "geteuid", return_value=reader_uid), \
                 patch.object(Path, "stat", return_value=metadata), \
                 patch.object(recovery, "file_sha", return_value="a" * 64) as hasher:
                self.assertEqual(recovery.guest_layer_hash(row), "a" * 64)
                hasher.assert_called_once_with(Path(row["path"]))
        for row, wrong_uid in ((root_row, 65532), (normal_row, 0)):
            with self.subTest(owner=row["uid"], wrong_reader=wrong_uid), \
                 patch.object(recovery.os, "geteuid", return_value=wrong_uid):
                with self.assertRaisesRegex(BuildControlError, "owner class"):
                    recovery.guest_layer_hash(row)

    def test_unknown_or_hash_budget_refuses_before_any_owner_hash(self):
        _, row, inventory = self.layer_payload_fixture()
        inventory["unknown_paths"] = ["/unknown"]
        with patch.object(recovery, "file_sha") as reader:
            with self.assertRaises(BuildControlError):
                recovery.hash_layer_inventory(inventory, reader)
            reader.assert_not_called()
        inventory["unknown_paths"] = []
        row["size"] = 512 * 1024 * 1024 + 1
        with patch.object(recovery, "file_sha") as reader:
            with self.assertRaises(BuildControlError):
                recovery.hash_layer_inventory(inventory, reader)
            reader.assert_not_called()

    def layer_row_for_file(self, path, disposition):
        info = path.lstat()
        return {"path": str(path), "recognized_runtime_path": True, "kind": "regular", "disposition": disposition,
                "uid": info.st_uid, "gid": info.st_gid, "mode": info.st_mode, "size": info.st_size}

    def test_writable_hardlink_hash_remains_refused(self):
        path = self.root / "writable-hardlink"
        path.write_bytes(b"do not relax writable aliases")
        os.link(path, self.root / "other-link")
        row = self.layer_row_for_file(path, "preserved-control-file")
        with patch.object(recovery, "recognized_layer_path", return_value=True):
            with self.assertRaisesRegex(BuildControlError, "aliased"):
                recovery.guest_layer_hash(row)

    def test_readonly_classification_without_actual_mount_is_refused(self):
        path = self.root / "ordinary-file"
        path.write_bytes(b"a classification is not a mount proof")
        row = self.layer_row_for_file(path, "external-readonly-file-mount")
        with patch.object(recovery, "recognized_layer_path", return_value=True):
            with self.assertRaisesRegex(BuildControlError, "exact current read-only mount"):
                recovery.guest_layer_hash(row)

    def test_readonly_symlink_is_refused(self):
        target = self.root / "target"
        target.write_bytes(b"symlink target")
        path = self.root / "alias"
        path.symlink_to(target)
        row = self.layer_row_for_file(path, "external-readonly-file-mount")
        with patch.object(recovery, "recognized_layer_path", return_value=True):
            with self.assertRaises(BuildControlError):
                recovery.guest_layer_hash(row)

    def test_actual_readonly_driver_mount_accepts_hardlinks_without_relaxing_generic_hash(self):
        path = Path("/usr/bin/nvidia-smi")
        if not path.exists() or path.lstat().st_nlink < 2:
            self.skipTest("requires the Docker Desktop read-only hardlinked driver mount")
        row = self.layer_row_for_file(path, "external-readonly-file-mount")
        # This changes only the owner-class test input. The real open/hash still
        # runs as the unprivileged test process on the actual read-only mount.
        with patch.object(recovery.os, "geteuid", return_value=0):
            actual = recovery.guest_layer_hash(row)
        with path.open("rb") as source:
            self.assertEqual(actual, recovery.stream_sha(source))
        with self.assertRaisesRegex(BuildControlError, "aliased"):
            recovery.file_sha(path)

    def test_layer_diff_order_is_canonical_but_raw_hash_is_preserved(self):
        first = "C /etc\nA /usr/bin/nvidia-smi\nC /var/cache\n"
        second = "C /var/cache\nC /etc\nA /usr/bin/nvidia-smi\n"
        self.assertNotEqual(recovery.digest(first.encode()), recovery.digest(second.encode()))
        self.assertEqual(recovery.canonical_layer_diff_sha256(first), recovery.canonical_layer_diff_sha256(second))
        source = self.root / "inventory-file"
        source.write_bytes(b"metadata")
        raw = "A " + str(source) + "\n"
        inventory = recovery.guest_layer_snapshot(raw)
        self.assertEqual(inventory["diff_sha256"], recovery.digest(raw.encode()))
        self.assertEqual(inventory["canonical_diff_sha256"], recovery.canonical_layer_diff_sha256(raw))
        self.assertEqual(inventory["unknown_paths"], [str(source)])

    def test_layer_diff_changed_status_or_path_is_not_equivalent(self):
        first = recovery.canonical_layer_diff_sha256("C /etc\nA /usr/bin/nvidia-smi\n")
        for changed in ("D /etc\nA /usr/bin/nvidia-smi\n", "C /etc\nA /usr/bin/other\n",
                        "C /etc\n", "C /etc\nA /usr/bin/nvidia-smi\nA /unknown\n"):
            with self.subTest(changed=changed):
                self.assertNotEqual(first, recovery.canonical_layer_diff_sha256(changed))

    def test_layer_diff_duplicates_invalid_status_and_unsafe_paths_are_refused(self):
        for raw in ("A /etc\nA /etc\n", "A /etc\nD /etc\n", "X /etc\n", "C etc\n",
                    "C /etc/../var\n", "C /etc//cache\n", "C /etc\n\n", "C /etc\0cache\n"):
            with self.subTest(raw=raw), self.assertRaises(BuildControlError):
                recovery.canonical_layer_diff_sha256(raw)

    def test_recreate_plans_guest_pid1_and_discards_only_backend_old_daemon_pins(self):
        import contextlib
        from subprocess import CompletedProcess
        source = str(self.root)
        alias = "/run/desktop/old-source-alias"
        labels = {"com.docker.compose.project": "group", "com.docker.compose.service": "backend"}
        original = {"Id": "a" * 64, "Image": "sha256:" + "b" * 64,
            "Config": {"Labels": labels, "Entrypoint": [], "Cmd": [], "User": "65532:65532", "Env": []},
            "HostConfig": {"ReadonlyRootfs": True, "Privileged": False, "GroupAdd": [], "Tmpfs": {}, "Init": True},
            "Mounts": [{"Type": "bind", "Source": alias, "Destination": "/opt/fullmag/source", "RW": False}],
            "State": {"Running": True, "Restarting": False, "OOMKilled": False, "StartedAt": "started"}}
        document = {"name": "group", "services": {"backend": {"init": True, "user": "65532:65532",
            "entrypoint": [], "command": [], "environment": {}, "labels": labels,
            "volumes": [{"type": "bind", "source": source, "target": "/opt/fullmag/source", "read_only": True}],
            "x-fullmag-daemon-binds": {"/opt/fullmag/source": alias}}, "frontend": {
            "x-fullmag-daemon-binds": {"/frontend": "/old/frontend-alias"}}}}
        frontend = copy.deepcopy(original)
        frontend["Id"] = "c" * 64
        frontend["Config"]["Labels"]["com.docker.compose.service"] = "frontend"
        core = {"old_container_id": original["Id"], "old_image_id": original["Image"],
                "private_volume_name": "private", "docker_engine_id_sha256": "d" * 64}
        seed = {"schema": "fullmag.succeeded-namespace-recreate-request.v1", "source_root": source,
                "compose_project": "group", "frontend": recovery.container_pin(frontend)}
        for key in ("native_request", "guest_request", "compose", "retirement_result"):
            seed[key + "_path"], seed[key + "_sha256"] = "/opt/fullmag/control/verification/" + key + ".json", "e" * 64
        native = {"schema_version": "runtime_service_succeeded_namespace_recovery.v1", "teardown": core,
                  "engine_receipts_directory": "/opt/fullmag/control/verification/engine"}
        guest = {"schema": "fullmag.succeeded-namespace-guest.v1", "teardown": core,
                 "teardown_request_sha256": recovery.digest(canonical(core))}
        retired = {"schema": "fullmag.succeeded-namespace-retirement.v1", "state": "removed-confirmed",
                   "core_request_sha256": recovery.digest(canonical(core)), "old_container_id": original["Id"],
                   "before_inspect_sha256": "f" * 64}
        before = {"argv": ["inspect", original["Id"]], "exit_code": 0, "stderr": "", "stdout": json.dumps([original])}
        @contextlib.contextmanager
        def operation(*_):
            yield {"root": "attempt"}
        control = SimpleNamespace(project="group", volume="private", operation=operation)
        planned = []
        class ObservedPlan(Exception): pass
        def inspect_one(kind, _):
            return {"Config": {"Entrypoint": [], "Cmd": []}} if kind == "image" else frontend
        def config_capture(configured, *command, **_):
            self.assertEqual(command, ("config", "--format", "json"))
            planned.append(configured)
            raise ObservedPlan()
        responses = [CompletedProcess([], 1, b"[]", ("error: no such object: " + original["Id"]).encode()),
                     CompletedProcess([], 0, b"", b"")]
        with patch.object(recovery, "BuildControl", return_value=control), \
             patch.object(recovery, "control_document", side_effect=[seed, native, guest, retired, document, before]) as documents, \
             patch.object(recovery, "docker_capture", side_effect=responses) as captured, \
             patch("docker_dev._select_source", return_value=(self.root, {})), patch("docker_dev._compose_identity", return_value={}), \
             patch("docker_dev_recovery_build.inspect_one", side_effect=inspect_one), \
             patch("docker_build_control.compose_capture", side_effect=config_capture) as compose, \
             patch("docker_volume_container_recovery._docker_engine_sha", return_value=core["docker_engine_id_sha256"]):
            with self.assertRaises(ObservedPlan):
                recovery.run_recreate(SimpleNamespace(source_root=source, image_id=original["Image"], request="verification/seed.json", request_sha256="e" * 64))
            def loses_init(configured, *_, **__):
                resolved = copy.deepcopy(configured)
                resolved["services"]["backend"].pop("init")
                return canonical(resolved)
            documents.side_effect = [seed, native, guest, retired, document, before]
            captured.side_effect = responses
            compose.side_effect = loses_init
            with self.assertRaisesRegex(BuildControlError, "preserve explicit init=false"):
                recovery.run_recreate(SimpleNamespace(source_root=source, image_id=original["Image"], request="verification/seed.json", request_sha256="e" * 64))
        configured = planned[0]
        self.assertFalse(configured["services"]["backend"]["init"])
        self.assertNotIn("x-fullmag-daemon-binds", configured["services"]["backend"])
        self.assertEqual(configured["services"]["frontend"], document["services"]["frontend"])
        self.assertTrue(document["services"]["backend"]["init"])
        self.assertEqual(document["services"]["backend"]["x-fullmag-daemon-binds"], {"/opt/fullmag/source": alias})
        from docker_volume_dev import _validate_retained_service
        canonical_actual = copy.deepcopy(original)
        canonical_actual["Mounts"][0]["Source"] = source
        canonical_actual["HostConfig"]["Init"] = False
        canonical_actual["Config"].update(Entrypoint=configured["services"]["backend"]["entrypoint"], Cmd=[])
        _validate_retained_service(configured, canonical_actual, "backend", {})
        mixed = copy.deepcopy(configured)
        mixed["services"]["backend"]["volumes"].append({"type": "bind", "source": str(self.root / "data"), "target": "/user-data"})
        mixed["services"]["backend"]["x-fullmag-daemon-binds"] = {"/user-data": "/run/desktop/retained-data"}
        mixed_actual = copy.deepcopy(canonical_actual)
        mixed_actual["Mounts"].append({"Type": "bind", "Source": "/run/desktop/retained-data", "Destination": "/user-data", "RW": True})
        historical = copy.deepcopy(mixed)
        historical["services"]["backend"]["x-fullmag-daemon-binds"]["/opt/fullmag/source"] = alias
        mixed["services"]["backend"]["x-fullmag-daemon-binds"] = recovery.matching_original_daemon_binds(historical, mixed_actual)
        self.assertEqual(mixed["services"]["backend"]["x-fullmag-daemon-binds"], {"/user-data": "/run/desktop/retained-data"})
        _validate_retained_service(mixed, mixed_actual, "backend", {})
        mixed_actual["Mounts"][-1]["Source"] = "/run/desktop/foreign-data"
        mixed["services"]["backend"]["x-fullmag-daemon-binds"] = recovery.matching_original_daemon_binds(historical, mixed_actual)
        self.assertEqual(mixed["services"]["backend"]["x-fullmag-daemon-binds"], {})
        with self.assertRaises(BuildControlError):
            _validate_retained_service(mixed, mixed_actual, "backend", {})
        canonical_actual["Mounts"][0]["Source"] = str(self.root / "foreign")
        with self.assertRaises(BuildControlError):
            _validate_retained_service(configured, canonical_actual, "backend", {})

    def test_symlink_lock_is_refused(self):
        target = self.root / "real"
        target.write_bytes(b"")
        alias = self.root / "alias"
        alias.symlink_to(target)
        with self.assertRaises(BuildControlError):
            with recovery.kernel_lock(alias):
                self.fail("alias admitted")

    def test_hardlink_lock_is_refused(self):
        target = self.root / "real"
        target.write_bytes(b"")
        os.link(target, self.root / "second")
        with self.assertRaises(BuildControlError):
            with recovery.kernel_lock(target):
                self.fail("hardlink admitted")

    def test_lock_inode_replacement_is_refused(self):
        target = self.root / "lock"
        target.write_bytes(b"")
        with self.assertRaisesRegex(BuildControlError, "inode changed"):
            with recovery.kernel_lock(target):
                target.rename(self.root / "original")
                target.write_bytes(b"")

    def test_immutable_publication_replays_exact_bytes_only(self):
        path = self.root / "proof.json"
        recovery.immutable_write(path, {"state": "observed"})
        recovery.immutable_write(path, {"state": "observed"})
        with self.assertRaisesRegex(BuildControlError, "replay differs"):
            recovery.immutable_write(path, {"state": "changed"})
        self.assertEqual(json.loads(path.read_bytes()), {"state": "observed"})

    def test_raw_inventory_preserves_empty_logs_and_refuses_omitted_alias(self):
        (self.root / "empty.log").write_bytes(b"")
        self.assertEqual(recovery.raw_inventory(self.root)[str(self.root / "empty.log")], recovery.digest(b""))
        (self.root / "alias").symlink_to(self.root / "empty.log")
        with self.assertRaises(BuildControlError):
            recovery.raw_inventory(self.root)

    def test_duplicate_json_and_nonfinite_are_refused(self):
        for value in (b'{"state":1,"state":2}', b'{"state":NaN}', b'[]', b''):
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                recovery.strict_json(value)

    def test_termination_observer_does_not_signal_or_escalate_on_timeout(self):
        pin = {"role": "owner", "pid": 123, "start_token": "linux-starttime-99", "executable_sha256": "a" * 64}
        observed = {k: pin[k] for k in ("pid", "start_token", "executable_sha256")}
        with patch.object(recovery, "process_identity", return_value=observed), patch.object(recovery.time, "monotonic", side_effect=[0, 2]), patch.object(recovery.os, "kill") as kill:
            with self.assertRaisesRegex(BuildControlError, "no escalation"):
                recovery.observe_terminated([pin], 1)
            kill.assert_not_called()

    def test_termination_observer_refuses_pid_reuse(self):
        pin = {"role": "owner", "pid": 123, "start_token": "linux-starttime-99", "executable_sha256": "a" * 64}
        with patch.object(recovery, "process_identity", return_value={"pid": 123, "start_token": "linux-starttime-100", "executable_sha256": "a" * 64}):
            with self.assertRaisesRegex(BuildControlError, "reused"):
                recovery.observe_terminated([pin], 1)

    def test_process_pin_observes_actual_pid_start_and_executable(self):
        observed = recovery.process_identity(os.getpid())
        self.assertEqual(observed["pid"], os.getpid())
        self.assertRegex(observed["start_token"], r"linux-starttime-[0-9]+")
        self.assertRegex(observed["executable_sha256"], r"[0-9a-f]{64}")
        request = {"processes": [{"role": "owner", **observed}]}
        recovery.require_processes(request)
        request["processes"][0]["start_token"] = "linux-starttime-1"
        with self.assertRaises(BuildControlError):
            recovery.require_processes(request)


class EngineEvidenceTests(unittest.TestCase):
    cid = "a" * 64

    def result(self, code, out=b"", err=b""):
        return recovery.engine_receipt("e" * 64, ["inspect", self.cid], SimpleNamespace(returncode=code, stdout=out, stderr=err))

    def test_wire_uses_real_cli_outcome_without_http_invention(self):
        value = self.result(1, b"[]\n", ("Error: No such object: " + self.cid + "\n").encode())
        self.assertEqual(set(value), {"schema", "engine_id_sha256", "argv", "exit_code", "stdout", "stderr"})
        self.assertEqual(value["schema"], "fullmag.succeeded-namespace-engine-command.v1")
        recovery.validate_not_found(self.cid, value)

    def test_nonforced_exact_removal(self):
        value = {"argv": ["rm", self.cid], "exit_code": 0, "stdout": self.cid + "\n", "stderr": ""}
        recovery.validate_removed(self.cid, value)
        for changes in ({"argv": ["rm", "--force", self.cid]}, {"stdout": "other"}, {"exit_code": 1}, {"stderr": "warning"}):
            with self.subTest(changes=changes), self.assertRaises(BuildControlError):
                recovery.validate_removed(self.cid, {**value, **changes})

    def test_notfound_is_exact_not_permission_or_connectivity(self):
        for err in ("permission denied", "Cannot connect to Docker daemon", "Error: No such object: " + "b" * 64):
            with self.subTest(err=err), self.assertRaises(BuildControlError):
                recovery.validate_not_found(self.cid, self.result(1, b"[]", err.encode()))
        with self.assertRaises(BuildControlError):
            recovery.validate_not_found(self.cid, self.result(0, b"[]", ("Error: No such object: " + self.cid).encode()))


class WorkerEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.store = Path(self.temporary.name) / "store"
        self.ledger = Path(self.temporary.name) / "ledger"
        self.root = self.store / "runs" / "run-one"
        self.root.mkdir(parents=True)
        self.ledger.mkdir()
        self.env = patch.dict(os.environ, {"FULLMAG_HOST_LEDGER_ROOT": str(self.ledger)})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.claim = dict(run_id="run-one", task_id="task-one", attempt_id="attempt-one", ownership_epoch=1, lease_token="lease-one")
        self.identity = {"run_id": "run-one", "task_id": "task-one", "lease_token": "lease-one", "store_id": "sha256:" + "a" * 64,
                         "resource_id": "cpu", "owner": {"kind": "solver", "attempt_id": "attempt-one", "ownership_epoch": 1}}
        self.task = {"task_id": "task-one", "attempt_id": "attempt-one", "ownership_epoch": 1, "lifecycle": "succeeded", "artifact_ids": ["bundle", "manifest"]}
        self.write(self.root / "run_catalog.json", {"revision": 7, "tasks": [self.task]})
        self.lease = {**self.claim, "state": "active", "heartbeat_sequence": 0}
        self.write(self.root / "resource_leases/cpu/lease-one.json", self.lease)
        self.commands = [{"sequence": index + 1, "message_id": "c" + str(index), "claim": self.claim, "command": {"kind": kind}}
                         for index, kind in enumerate(("prepare", "start"))]
        self.events = [{"sequence": 1, "message_id": "e0", "claim": self.claim, "event": {"kind": "completed"}}]
        for index, envelope in enumerate(self.commands):
            self.journal("command", index + 1, envelope)
        self.journal("event", 1, self.events[0], terminal=True)
        self.inbox = {"schema_version": "worker_inbox.v1", "claim": self.claim, "applied": self.commands, "pending": None}
        self.write(self.root / "worker_inbox/one.json", self.wrapped(self.inbox))
        self.attempt = self.root / "worker-attempts/task-one/attempt-one/epoch-1"
        self.write(self.attempt / "worker_execution_started.v1.json", {"state": "started"})
        self.write(self.attempt / "worker_execution_completed.v1.json", {"state": "completed"})
        package = b"bundle bytes"
        package_hash = recovery.digest(package)
        package_path = self.store / "objects/sha256" / package_hash
        package_path.parent.mkdir(parents=True)
        package_path.write_bytes(package)
        output = {"artifact_id": "bundle", "object_ref": package_hash, "content_sha256": package_hash,
                  "codec_id": "fullmag.antenna.closed_loop_bundle", "codec_version": "v1"}
        manifest = {"schema_version": "study_output_manifest.v3", **{k: v for k, v in self.claim.items() if k != "lease_token"}, "outputs": [output]}
        manifest_raw = canonical(manifest) + b"\n"
        manifest_hash = recovery.digest(manifest_raw)
        (self.store / "objects/sha256" / manifest_hash).write_bytes(manifest_raw)
        self.entries = []
        for name, sha, kind in (("bundle", package_hash, "antenna"), ("manifest", manifest_hash, "study_output_manifest")):
            self.entries.append({"artifact_id": name, "artifact_type": kind, "object_ref": sha, "content_sha256": sha,
                                 "status": "published", "required": True, **{k: self.claim[k] for k in ("task_id", "attempt_id", "ownership_epoch")}})
        self.write(self.root / "artifact_catalog.json", {"entries": self.entries})
        self.reservation = {"state": "committed", "identity": self.identity, "worker_launch_gate": {"state": "consumed", "token": "launch"}, "runtime_generation_sha256": "f" * 64}
        self.write(self.ledger / "HOST_RESOURCE_LEDGER.json", {"reservations": [self.reservation]})
        self.archive = Path(self.temporary.name) / "saved.fms"
        self.archive.write_bytes(b"preserved scene")
        self.core = {"identity": self.identity, "expected_task": self.task, "catalog_revision": 7,
                     "lease_before_sha256": recovery.digest(canonical(self.lease)), "worker_launch_token": "launch",
                     "runtime_generation_sha256": "f" * 64,
                     "journal_sha256": recovery.digest(canonical({"commands": self.commands, "events": self.events})),
                     "inbox_sha256": recovery.digest(canonical(self.inbox)),
                     "artifacts_sha256": recovery.digest(canonical(self.entries)),
                     "reservation_before_sha256": recovery.digest(canonical(self.reservation)),
                     "execution_started_sha256": recovery.digest((self.attempt / "worker_execution_started.v1.json").read_bytes()),
                     "execution_completed_sha256": recovery.digest((self.attempt / "worker_execution_completed.v1.json").read_bytes())}
        self.request = {"teardown": self.core, "lease_heartbeat_sequence": 0,
                        "archive": {"path": str(self.archive), "sha256": recovery.digest(self.archive.read_bytes())}}
        self.repin()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(canonical(value) + b"\n")

    def wrapped(self, payload):
        return {"payload": payload, "payload_sha256": recovery.digest(canonical(payload))}

    def journal(self, direction, sequence, envelope, terminal=False):
        payload = {"message": {"envelope": envelope}, "checkpoint": {"task": {"lifecycle": "succeeded"}}}
        row = {**self.claim, "direction": direction, "sequence": sequence, "entry_id": envelope["message_id"], "terminal": terminal, **self.wrapped(payload)}
        self.write(self.root / "coordinator_journal" / direction / (str(sequence) + ".json"), row)

    def repin(self):
        self.request["documents"] = {**recovery.raw_inventory(self.root), **{str(path): recovery.file_sha(path) for path in (self.store / "objects/sha256").iterdir()}}

    def check(self):
        return recovery.validate_worker_evidence(self.request, SimpleNamespace(store=self.store))

    def test_exact_complete_succeeded_missing_exit_is_admitted_without_release(self):
        self.assertIs(self.check()["reservation_released"], False)
        self.assertEqual(json.loads((self.ledger / "HOST_RESOURCE_LEDGER.json").read_bytes())["reservations"][0]["state"], "committed")

    def test_raw_inventory_omission_is_refused(self):
        self.request["documents"].pop(str(self.root / "artifact_catalog.json"))
        with self.assertRaises(BuildControlError):
            self.check()

    def test_existing_exit_receipt_remains_refused_even_when_repinning(self):
        self.write(self.root / "worker_process_exit_receipts/one.json", {"exit_code": 0})
        self.repin()
        with self.assertRaisesRegex(BuildControlError, "ordinary recovery"):
            self.check()

    def test_pending_inbox_is_refused_even_when_raw_inventory_is_repinning(self):
        self.inbox["pending"] = self.commands[-1]
        self.write(self.root / "worker_inbox/one.json", self.wrapped(self.inbox))
        self.core["inbox_sha256"] = recovery.digest(canonical(self.inbox))
        self.repin()
        with self.assertRaisesRegex(BuildControlError, "pending"):
            self.check()

    def test_other_active_task_is_refused(self):
        self.write(self.store / "runs/foreign/run_catalog.json", {"tasks": [{"lifecycle": "running"}]})
        with self.assertRaisesRegex(BuildControlError, "not terminal"):
            self.check()

    def test_another_reservation_is_refused(self):
        self.write(self.ledger / "HOST_RESOURCE_LEDGER.json", {"reservations": [self.reservation, self.reservation]})
        with self.assertRaisesRegex(BuildControlError, "Another consumer"):
            self.check()

    def test_consumed_launch_token_cannot_be_replaced(self):
        self.reservation["worker_launch_gate"]["token"] = "other"
        self.write(self.ledger / "HOST_RESOURCE_LEDGER.json", {"reservations": [self.reservation]})
        with self.assertRaises(BuildControlError):
            self.check()

    def test_corrupt_cas_is_refused(self):
        path = next((self.store / "objects/sha256").iterdir())
        path.write_bytes(b"changed")
        with self.assertRaises(BuildControlError):
            self.check()

    def test_two_start_commands_are_refused(self):
        self.commands.append({**self.commands[-1], "sequence": 3, "message_id": "c2"})
        self.journal("command", 3, self.commands[-1])
        self.write(self.root / "worker_inbox/one.json", self.wrapped(self.inbox))
        self.core["inbox_sha256"] = recovery.digest(canonical(self.inbox))
        self.core["journal_sha256"] = recovery.digest(canonical({"commands": self.commands, "events": self.events}))
        self.repin()
        with self.assertRaisesRegex(BuildControlError, "Completed journal"):
            self.check()


class RetirementObservationTests(unittest.TestCase):
    def fixture(self):
        cid, engine = "a" * 64, "b" * 64
        core = {"old_container_id": cid, "old_image_id": "sha256:" + "c" * 64,
                "docker_engine_id_sha256": engine, "compose_project": "group", "private_volume_name": "private"}
        before = {"Id": cid, "Image": core["old_image_id"], "Config": {"Labels": {
            "com.docker.compose.project": "group", "com.docker.compose.service": "backend"}}, "HostConfig": {"PidMode": ""},
            "Mounts": [{"Type": "volume", "Name": "private", "Source": "/volume", "Destination": "/opt/fullmag/control", "RW": True}],
            "State": {"Running": True, "Pid": 123, "StartedAt": "started", "Restarting": False, "OOMKilled": False}}
        stopped = copy.deepcopy(before)
        stopped["State"].update(Running=False, Pid=0, ExitCode=143, FinishedAt="2026-11-05T08:09:00Z")
        def receipt(argv, code, out, err=""):
            return {"schema": "fullmag.succeeded-namespace-engine-command.v1", "engine_id_sha256": engine,
                    "argv": argv, "exit_code": code, "stdout": out, "stderr": err}
        records = dict(zip(recovery.ENGINE_RECEIPT_NAMES, [
            receipt(["inspect", cid], 0, json.dumps([before])), receipt(["kill", "--signal", "TERM", cid], 0, cid + "\n"),
            receipt(["inspect", cid], 0, json.dumps([stopped])), receipt(["rm", cid], 0, cid + "\n"),
            receipt(["inspect", cid], 1, "[]\n", "error: no such object: " + cid + "\n")]))
        return core, {"backend": recovery.container_pin(before)}, records

    def test_exact_lowercase_receipt_finishes_observation_without_changing_receipts(self):
        core, seed, receipts = self.fixture()
        original = copy.deepcopy(receipts)
        result = recovery.retirement_result_from_receipts(core, seed, receipts)
        self.assertEqual(result["state"], "removed-confirmed")
        self.assertEqual(result["old_container_id"], core["old_container_id"])
        self.assertEqual(result["stopped_pid"], 0)
        self.assertEqual(result["descendant_count"], 0)
        self.assertFalse(result["stop_escalated"])
        self.assertFalse(result["solve_replay"])
        self.assertEqual(receipts, original)

    def test_changed_engine_identity_force_signal_live_namespace_and_bad_absence_refuse(self):
        for change in ("engine", "kill", "force-rm", "wrong-cid", "permission", "daemon", "live", "missing"):
            core, seed, receipts = self.fixture()
            if change == "engine": receipts[recovery.ENGINE_RECEIPT_NAMES[0]]["engine_id_sha256"] = "d" * 64
            elif change == "kill": receipts[recovery.ENGINE_RECEIPT_NAMES[1]]["argv"][2] = "KILL"
            elif change == "force-rm": receipts[recovery.ENGINE_RECEIPT_NAMES[3]]["argv"].insert(1, "--force")
            elif change == "wrong-cid": receipts[recovery.ENGINE_RECEIPT_NAMES[4]]["stderr"] = "error: no such object: " + "e" * 64
            elif change == "permission": receipts[recovery.ENGINE_RECEIPT_NAMES[4]]["stderr"] = "permission denied"
            elif change == "daemon": receipts[recovery.ENGINE_RECEIPT_NAMES[4]]["stderr"] = "Cannot connect to the Docker daemon"
            elif change == "live":
                doc = json.loads(receipts[recovery.ENGINE_RECEIPT_NAMES[2]]["stdout"])
                doc[0]["State"]["Running"] = True
                receipts[recovery.ENGINE_RECEIPT_NAMES[2]]["stdout"] = json.dumps(doc)
            elif change == "missing": receipts.pop(recovery.ENGINE_RECEIPT_NAMES[1])
            with self.subTest(change=change), self.assertRaises((BuildControlError, ValueError)):
                recovery.retirement_result_from_receipts(core, seed, receipts)

    def test_retirement_finish_has_no_new_operation_signal_or_removal_call(self):
        import ast
        import inspect
        tree = ast.parse(inspect.getsource(recovery.run_finish_retirement))
        for call in [node for node in ast.walk(tree) if isinstance(node, ast.Call)]:
            if isinstance(call.func, ast.Attribute):
                self.assertNotIn(call.func.attr, {"kill", "killpg", "operation", "unlink", "remove"})
            elif isinstance(call.func, ast.Name) and call.func.id == "docker_capture":
                self.assertIsInstance(call.args[0], ast.Constant)
                self.assertEqual(call.args[0].value, "inspect")


class FailedRecreateObservationTests(unittest.TestCase):
    def fixture(self):
        core, _, records = RetirementObservationTests().fixture()
        actual = json.loads(records[recovery.ENGINE_RECEIPT_NAMES[0]]["stdout"])[0]
        actual["HostConfig"]["Init"] = True
        actual["State"].update(Running=False, Pid=0, ExitCode=1, OOMKilled=False,
            Restarting=False, FinishedAt="2026-11-05T08:37:18Z")
        logs = SimpleNamespace(returncode=0, stdout=b"", stderr=recovery.FAILED_GUEST_PID1_STDERR)
        return actual, recovery.container_pin(actual), core["old_image_id"], logs

    def test_inspect_mount_order_hash_preserves_raw_and_every_value(self):
        actual, _, _, _ = self.fixture()
        actual["Mounts"].append({"Type": "bind", "Source": "/source", "Destination": "/source", "RW": False})
        original = copy.deepcopy(actual)
        reordered = copy.deepcopy(actual)
        reordered["Mounts"].reverse()
        expected = recovery.inspect_mount_order_sha256(actual)
        self.assertEqual(expected, recovery.inspect_mount_order_sha256(reordered))
        self.assertEqual(actual, original)
        for change in ("mount_value", "mount_extra_field", "other_field"):
            altered = copy.deepcopy(reordered)
            if change == "mount_value": altered["Mounts"][0]["RW"] = True
            elif change == "mount_extra_field": altered["Mounts"][0]["Mode"] = "ro"
            else: altered["State"]["ExitCode"] = 2
            with self.subTest(change=change):
                self.assertNotEqual(expected, recovery.inspect_mount_order_sha256(altered))

    def test_inspect_mount_order_hash_refuses_duplicate_or_missing_destinations(self):
        actual, _, _, _ = self.fixture()
        actual["Mounts"].append(copy.deepcopy(actual["Mounts"][0]))
        with self.assertRaises(BuildControlError):
            recovery.inspect_mount_order_sha256(actual)
        actual["Mounts"][-1].pop("Destination")
        with self.assertRaises(BuildControlError):
            recovery.inspect_mount_order_sha256(actual)

    def test_stopped_fms_tar_is_exact_bounded_nonlink_payload(self):
        import io
        import tarfile
        payload = b"saved-full-scene"
        def tar_bytes(names, kind=tarfile.REGTYPE, size=None):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as output:
                for name in names:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    item.size = len(payload) if size is None else size
                    if kind != tarfile.REGTYPE:
                        item.size, item.linkname = 0, "elsewhere"
                    output.addfile(item, io.BytesIO(payload) if kind == tarfile.REGTYPE else None)
            return stream.getvalue()
        good = tar_bytes(["scene.fms"])
        recovery.validate_stopped_fms_tar(good, "/state/runs/projects/scene.fms", recovery.digest(payload))
        for bad in [tar_bytes(["other.fms"]), tar_bytes(["scene.fms", "extra"]),
                    tar_bytes(["scene.fms"], tarfile.SYMTYPE), tar_bytes(["scene.fms"], tarfile.LNKTYPE),
                    good[:515], good + b"x" * recovery.MAX_BYTES]:
            with self.subTest(length=len(bad)), self.assertRaises(BuildControlError):
                recovery.validate_stopped_fms_tar(bad, "/state/runs/projects/scene.fms", recovery.digest(payload))
        with self.assertRaises(BuildControlError):
            recovery.validate_stopped_fms_tar(good, "/state/runs/projects/scene.fms", "a" * 64)

    def test_exact_exited_guest_proves_only_prewrite_pid1_refusal(self):
        actual, pin, image, logs = self.fixture()
        recovery.validate_failed_guest_pid1(actual, pin, image, logs)
        self.assertFalse(actual["State"]["Running"])
        self.assertEqual(logs.stderr, b"succeeded namespace guest refused: namespace recovery guest must be the Linux backend PID1\n")

    def test_other_exit_oom_running_namespace_and_log_causes_refuse(self):
        changes = [("HostConfig", "Init", False), ("HostConfig", "PidMode", "host"),
            ("State", "Running", True), ("State", "Pid", 12), ("State", "ExitCode", 0),
            ("State", "OOMKilled", True), ("State", "Restarting", True),
            ("State", "FinishedAt", ""), ("State", "FinishedAt", "0001-01-01T00:00:00Z")]
        for section, field, value in changes:
            actual, pin, image, logs = self.fixture()
            actual[section][field] = value
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                recovery.validate_failed_guest_pid1(actual, pin, image, logs)
        for field, value in [("returncode", 1), ("stdout", b"API started"),
                             ("stderr", recovery.FAILED_GUEST_PID1_STDERR + b"another error")]:
            actual, pin, image, logs = self.fixture()
            setattr(logs, field, value)
            with self.subTest(log_field=field), self.assertRaises(BuildControlError):
                recovery.validate_failed_guest_pid1(actual, pin, image, logs)
        actual, pin, image, logs = self.fixture()
        with self.assertRaises(BuildControlError):
            recovery.validate_failed_guest_pid1(actual, {**pin, "container_id": "d" * 64}, image, logs)

    def test_failed_recreate_observer_never_launches_signals_removes_or_creates_operation(self):
        import ast
        import inspect
        tree = ast.parse(inspect.getsource(recovery.run_finish_failed_recreate))
        for call in [node for node in ast.walk(tree) if isinstance(node, ast.Call)]:
            if isinstance(call.func, ast.Attribute):
                self.assertNotIn(call.func.attr, {"kill", "killpg", "operation", "unlink", "remove"})
            elif isinstance(call.func, ast.Name) and call.func.id == "docker_capture":
                self.assertIsInstance(call.args[0], ast.Constant)
                self.assertIn(call.args[0].value, {"logs", "inspect", "cp"})
        source = inspect.getsource(recovery.run_finish_failed_recreate)
        preview = source.index('if not args.apply:')
        first_write = source.index('control.write')
        self.assertLess(preview, first_write)
        self.assertIn('"api_started": False', source)
        self.assertIn('"reservations_modified": False', source)


class ManagedCandidatePathTests(unittest.TestCase):
    def fixture(self):
        attempt = "a" * 32
        root = "/opt/fullmag/control/recovery-build/attempts/" + attempt
        result = {"schema": "fullmag.docker-recovery-build.v1", "state": "ready", "package_promoted": False,
                  "runtime_started": False, "candidate": "/candidate", "receipt_sha256": "b" * 64,
                  "source": {"resolved_commit": "c" * 40, "source_snapshot_sha256": "d" * 64}}
        inputs = {"source_root": "/source", "compose_project": "group", "image_id": "old-image",
                  "backend_container_id": "old-container", "source_commit": "c" * 40, "owner_sha256": "e" * 64,
                  "process_receipt_sha256": "f" * 64, "diagnostic_api_only": True}
        terminal = {"schema": "fullmag.docker-build-operation.v1", "phase": "recovery-build", "state": "succeeded",
                    "attempt": attempt, "compose_project": "group", "control_volume": "private",
                    "image_id": "old-image", "inputs": inputs, "candidate": result}
        native = {"teardown": {"old_image_id": "old-image", "old_container_id": "old-container"},
                  "build_commit": "c" * 40, "owner_sha256": "e" * 64, "process_receipt_sha256": "1" * 64,
                  "package_receipt_sha256": "b" * 64, "source_snapshot_sha256": "d" * 64, "candidate_storage": {},
                  "stop_request_sha256": "2" * 64, "stop_proof_path": "/opt/fullmag/control/verification/test/kernel-stop-proof.json"}
        stop_proof = {"schema": recovery.STOP_PROOF_SCHEMA, "state": "native-processes-terminated",
                      "request_sha256": "2" * 64, "process_exit_status": "unknown", "reservation_released": False,
                      "solve_replay": False, "post_stop_process_receipt_sha256": "f" * 64}
        documents = {}
        def publish():
            documents.clear()
            proof_raw = canonical(stop_proof) + b"\n"
            documents["verification/test/kernel-stop-proof.json"] = proof_raw
            native["stop_proof_sha256"] = recovery.digest(proof_raw)
            for name, value in (("terminal", terminal), ("result", result)):
                raw = canonical(value) + b"\n"
                documents[(root + "/" + name + ".json").removeprefix("/opt/fullmag/control/")] = raw
                native["candidate_storage"]["managed_" + name + "_path"] = root + "/" + name + ".json"
                native["candidate_storage"]["managed_" + name + "_sha256"] = recovery.digest(raw)
        publish()
        return SimpleNamespace(project="group", volume="private", read_bytes=documents.__getitem__), native, terminal, result, publish

    def test_exact_actual_managed_paths_are_accepted_without_copy_to_verification(self):
        control, native, terminal, result, _ = self.fixture()
        self.assertNotEqual(native["process_receipt_sha256"], terminal["inputs"]["process_receipt_sha256"])
        self.assertEqual(recovery.managed_candidate_result(control, native, "/source"), result)

    def test_original_ready_pin_cannot_replace_the_post_stop_diagnostic_build_pin(self):
        control, native, terminal, _, publish = self.fixture()
        terminal["inputs"]["process_receipt_sha256"] = native["process_receipt_sha256"]
        publish()
        with self.assertRaises(BuildControlError):
            recovery.managed_candidate_result(control, native, "/source")
        control, native, _, _, _ = self.fixture()
        native["stop_proof_sha256"] = "0" * 64
        with self.assertRaises(BuildControlError):
            recovery.managed_candidate_result(control, native, "/source")

    def test_copy_traversal_and_cross_attempt_paths_are_refused(self):
        for path in ("/opt/fullmag/control/verification/result.json",
                     "/opt/fullmag/control/recovery-build/attempts/" + "a" * 32 + "/../result.json",
                     "/opt/fullmag/control/recovery-build/attempts/short/result.json"):
            control, native, _, _, _ = self.fixture()
            native["candidate_storage"]["managed_result_path"] = path
            with self.subTest(path=path), self.assertRaises(BuildControlError):
                recovery.managed_candidate_result(control, native, "/source")
        control, native, _, _, _ = self.fixture()
        native["candidate_storage"]["managed_terminal_path"] = native["candidate_storage"]["managed_terminal_path"].replace("a" * 32, "b" * 32)
        with self.assertRaises(BuildControlError):
            recovery.managed_candidate_result(control, native, "/source")

    def test_wrong_terminal_identity_and_changed_raw_pins_are_refused(self):
        for target, key, value in (("terminal", "state", "failed"), ("terminal", "attempt", "b" * 32),
                ("terminal", "compose_project", "other"), ("terminal", "control_volume", "other"),
                ("inputs", "source_root", "/other"), ("inputs", "owner_sha256", "0" * 64),
                ("inputs", "process_receipt_sha256", "0" * 64), ("inputs", "backend_container_id", "other"),
                ("inputs", "diagnostic_api_only", False), ("result", "package_promoted", True),
                ("result", "runtime_started", True), ("result", "receipt_sha256", "0" * 64)):
            control, native, terminal, result, publish = self.fixture()
            {"terminal": terminal, "inputs": terminal["inputs"], "result": result}[target][key] = value
            publish()
            with self.subTest(target=target, key=key), self.assertRaises(BuildControlError):
                recovery.managed_candidate_result(control, native, "/source")
        control, native, _, _, _ = self.fixture()
        native["candidate_storage"]["managed_result_sha256"] = "0" * 64
        with self.assertRaises(BuildControlError):
            recovery.managed_candidate_result(control, native, "/source")


if __name__ == "__main__":
    unittest.main()
