"""Interpreted regression checks for canceled BuildKit reconciliation."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import docker_volume_toolchain_reconcile as subject
import docker_volume_reconcile as publication
from docker_build_control import BuildControlError, canonical


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.original = {"schema": "fullmag.docker-build-operation.v1", "phase": "toolchain",
            "attempt": "a" * 32, "state": "starting", "compose_project": "project",
            "control_volume": "volume", "helper_container": "fullmag-control-" + "a" * 32,
            "started_at": 1000.0, "inputs": {"target": "fem-gpu-dev",
                "build_args": {"FULLMAG_MFEM_BUILD_JOBS": "2"}, "source_inputs": []}}
        self.raw = canonical(self.original) + b"\n"
        self.document = {"services": {"fem-gpu-toolchain": {"build": {
            "dockerfile": "docker/fem-gpu/Dockerfile", "target": "fem-gpu-dev",
            "args": self.original["inputs"]["build_args"]}}}}
        self.record = {"Ref": "b" * 25, "Dockerfile": "docker/fem-gpu/Dockerfile",
            "Target": "fem-gpu-dev", "VCSRevision": "c" * 40, "VCSRepository": "https://example/repo",
            "Status": "canceled", "Error": {"Code": 1, "Message": "context canceled"},
            "StartedAt": 1010.0, "CompletedAt": 1020.0,
            "Labels": {"com.docker.compose.project": "project", "com.docker.compose.service": "fem-gpu-toolchain"},
            "BuildArgs": self.original["inputs"]["build_args"]}
        self.request = {"schema": subject.SCHEMA, "attempt": "a" * 32,
            "unknown_receipt_sha256": subject.digest(self.raw), "compose_sha256": "d" * 64,
            "build_log_sha256": "e" * 64, "helper_fingerprint": "f" * 64,
            "helper_started_at": "1970-01-01T00:16:40Z",
            "phase_current_sha256": None, "verified_sha256": None,
            "build_ref": "b" * 25, "build_record_sha256": subject.digest(canonical(self.record)),
            "source_revision": "c" * 40, "source_repository": "https://example/repo",
            "source_root": str(Path.cwd()), "compose_project": "project", "engine_id": "engine",
            "buildkit_observer": {"kind": "native"},
            "buildx_version": "github.com/docker/buildx v0.36.1-desktop.1 synthetic",
            "builders": [{"Name": "builder", "Driver": "docker", "Nodes": [
                {"Name": "node", "Endpoint": "endpoint", "IDs": ["worker"], "Version": "v0.32.2", "Status": "running"}]}],
            "controller_inputs": {path: "0" * 64 for path in (
                "scripts/docker_volume_toolchain_reconcile.py", "scripts/docker_volume_reconcile.py",
                "scripts/docker_volume_activation_reconcile.py")}}
        self.builder = copy.deepcopy(self.request["builders"][0])

    def test_valid_native_canceled_record(self):
        subject.validate_request(self.request)
        subject.validate_record(self.record, self.request, self.original, self.document)

    def test_each_identity_or_outcome_mismatch_is_rejected(self):
        variants = [
            ("Ref", "q" * 25), ("Status", "completed"), ("Error", {"Code": 0, "Message": ""}),
            ("Dockerfile", "other"), ("Target", "other"), ("BuildArgs", {}),
            ("VCSRevision", "1" * 40), ("VCSRepository", "https://wrong"),
            ("StartedAt", 999), ("StartedAt", 1400), ("CompletedAt", 1000),
            ("Labels", {"com.docker.compose.project": "foreign", "com.docker.compose.service": "fem-gpu-toolchain"}),
            ("Labels", {"com.docker.compose.project": "project", "com.docker.compose.service": "backend"})]
        for key, value in variants:
            with self.subTest(key=key, value=value), self.assertRaises(BuildControlError):
                observed = copy.deepcopy(self.record)
                observed[key] = value
                subject.validate_record(observed, self.request, self.original, self.document)

    def native_record(self):
        result = copy.deepcopy(self.record)
        result["StartedAt"] = "1970-01-01T00:16:50Z"
        result["CompletedAt"] = "1970-01-01T01:17:00+01:00"
        result["Dockerfile"] = "docker\\fem-gpu\\Dockerfile"
        for key in ("Labels", "BuildArgs"):
            result[key] = [{"Name": key, "Value": value} for key, value in result[key].items()]
        result["Error"]["Stack"] = "changing observer stack"
        result["Duration"] = 123
        return result

    def test_projection_ignores_only_observer_noise(self):
        self.assertEqual(subject.build_record(self.native_record()), self.record)
        native = self.native_record()
        native["Error"]["Stack"] = "other observer"
        native["Duration"] = 999
        self.assertEqual(subject.build_record(native), self.record)

    def test_duplicate_build_argument_or_label_is_rejected(self):
        for key in ("BuildArgs", "Labels"):
            native = self.native_record()
            native[key].append(native[key][0])
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                subject.build_record(native)

    def test_missing_or_timezone_free_time_is_rejected(self):
        for value in (None, "nonsense", "1970-01-01T00:16:50"):
            native = self.native_record()
            native["StartedAt"] = value
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                subject.build_record(native)

    def history_fake(self, *, rows=None, active=None, builders=None, record=None):
        if rows is None:
            rows = [{"ref": "builder/node/" + "b" * 25, "created_at": "1970-01-01T00:16:50Z",
                     "completed_at": "1970-01-01T00:17:00Z"}]
        def capture(*args, **kwargs):
            if args == ("buildx", "ls", "--format", "json"):
                value = b"\n".join(canonical(x) for x in (builders or [self.builder]))
            elif args == ("info", "--format", "{{.ID}}"):
                value = b"engine\n"
            elif args == ("buildx", "version"):
                value = self.request["buildx_version"].encode() + b"\n"
            elif args[:3] == ("buildx", "history", "ls"):
                value = b"\n".join(canonical(x) for x in ((active or []) if "status=running" in args else rows))
            elif args[:3] == ("buildx", "history", "inspect"):
                value = canonical(record or self.native_record())
            else:
                self.fail("Unexpected Docker mutation/command: " + repr(args))
            return SimpleNamespace(stdout=value, returncode=0)
        return capture

    def test_history_accepts_one_complete_terminal_record(self):
        with patch.object(subject, "docker_capture", self.history_fake()):
            self.assertEqual(subject.history(self.request, self.original), self.record)

    def test_history_rejects_possible_truncation(self):
        rows = [{"ref": str(i), "created_at": "1970-01-01T00:16:50Z"} for i in range(50)]
        with patch.object(subject, "docker_capture", self.history_fake(rows=rows)), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_history_never_boots_stopped_builder(self):
        self.builder["Nodes"][0]["Status"] = "stopped"
        self.request["builders"] = [self.builder]
        with patch.object(subject, "docker_capture", self.history_fake()), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_active_unattributed_record_is_rejected(self):
        active = [{"ref": "builder/node/" + "b" * 25, "created_at": "1970-01-01T00:16:50Z"}]
        record = self.native_record()
        record["CompletedAt"] = None
        record["Labels"] = []
        with patch.object(subject, "docker_capture", self.history_fake(rows=active, active=active, record=record)), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_builder_aliases_share_one_worker_record(self):
        other = copy.deepcopy(self.builder)
        other["Name"] = "alias"
        self.request["builders"] = sorted([self.builder, other], key=lambda x: x["Name"])
        with patch.object(subject, "docker_capture", self.history_fake(builders=[self.builder, other])):
            self.assertEqual(subject.history(self.request, self.original), self.record)

    def test_worker_alias_is_deduplicated_before_context_specific_query(self):
        first = copy.deepcopy(self.builder)
        first["Name"] = "default"
        preferred = copy.deepcopy(self.builder)
        preferred["Name"] = "desktop-linux"
        self.request["builders"] = [first, preferred]
        self.request["buildkit_observer"] = {"kind": "windows-docker-desktop", "context": "desktop-linux"}
        fake = self.history_fake(builders=[first, preferred])
        calls = []
        def capture(_request, *args, **kwargs):
            if "--builder" in args:
                self.assertEqual(args[args.index("--builder") + 1], "desktop-linux")
                calls.append(args)
            return fake(*args, **kwargs)
        with patch.object(subject, "validate_observer"), patch.object(subject, "observer_capture", capture):
            self.assertEqual(subject.history(self.request, self.original), self.record)
        self.assertEqual(len(calls), 3)

    def test_distinct_worker_collision_is_ambiguous(self):
        other = copy.deepcopy(self.builder)
        other["Name"] = "other"
        other["Nodes"][0]["IDs"] = ["second-worker"]
        self.request["builders"] = [self.builder, other]
        with patch.object(subject, "docker_capture", self.history_fake(builders=[self.builder, other])), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_live_client_parser_excludes_only_read_operations(self):
        safe = [["docker.exe", "stats", "--no-stream"], ["docker", "--context", "desktop-linux", "inspect", "id"],
                ["docker-buildx.exe", "history", "ls"], ["docker", "buildx", "history", "inspect", "ref"],
                ["docker-compose", "ps"], ["python", "scripts/docker_volume_toolchain_reconcile.py", "--preview"]]
        dangerous = [["python", "scripts/docker_dev.py", "--recreate-volume"],
                     ["python", "scripts/bootstrap_docker_toolchain.py"], ["just", "docker-dev"],
                     ["docker", "exec", "id", "echo", "inspect"],
                     ["docker", "run", "image", "inspect"], ["docker", "compose", "-f", "-", "build"],
                     ["docker", "buildx", "bake"], ["docker", "--unknown", "inspect"],
                     ["docker", "--context"], ["docker-buildx.exe", "build", "."]]
        for argv in safe:
            with self.subTest(argv=argv):
                self.assertFalse(subject.potential_build_client(argv))
        for argv in dangerous:
            with self.subTest(argv=argv):
                self.assertTrue(subject.potential_build_client(argv))

    def test_result_never_invents_exit_status_or_success(self):
        raw = subject.failure_result(self.raw, self.record, self.request, "9" * 64)
        result = json.loads(raw)
        self.assertEqual(result["state"], "failed-confirmed")
        self.assertNotIn("exit_code", result)
        self.assertNotIn("image_id", result)
        self.assertEqual(result["build_data_qualification"], "NOT VERIFIED")
        self.assertEqual(result["inputs"], self.original["inputs"])
        self.assertEqual(json.loads(self.raw), self.original)
        self.assertEqual(raw, subject.failure_result(self.raw, self.record, self.request, "9" * 64))
        self.assertNotEqual(raw, subject.failure_result(self.raw, self.record, self.request, "8" * 64))

    def test_publication_is_failure_only_and_keeps_verified_pin(self):
        control = SimpleNamespace(path=lambda p: "/control/" + p)
        script = publication.commit_script(control, "toolchain/attempts/" + "a" * 32,
            self.request, "toolchain/attempts/" + "a" * 32 + "/reconciliation/" + "9" * 64,
            "9" * 64, self.request["unknown_receipt_sha256"], phase="toolchain", publish_verified=False)
        targets = script.split("for p in ", 1)[1].split("; do", 1)[0]
        self.assertNotIn("verified.json", targets)
        self.assertTrue(targets.endswith("/terminal.json'"))
        self.assertIn("exec 8<>/control/operation.lock; if flock -n 8; then exit 72;", script)
        self.assertIn("test ! -e '/control/toolchain/verified.json'", script)
        self.assertIn(self.request["compose_sha256"], script)
        self.assertIn(self.request["build_log_sha256"], script)
        self.assertNotIn("rm /control/active", script)
        for schema, publish in [(subject.SCHEMA, True), (publication.SCHEMA, False),
                                (publication.PRESTART_SCHEMA, False)]:
            request = {**self.request, "schema": schema}
            with self.subTest(schema=schema, publish=publish), self.assertRaises(BuildControlError):
                publication.commit_script(control, "toolchain/attempts/" + "a" * 32,
                    request, "journal", "9" * 64, "0" * 64,
                    phase="toolchain", publish_verified=publish)

    def test_replay_only_accepts_own_exact_result_and_preserves_history(self):
        # Fake I/O executes controller transaction logic; it never invokes Docker.
        import docker_dev
        request_raw = canonical(self.request) + b"\n"
        request_sha = subject.digest(request_raw)
        args = SimpleNamespace(source_root=str(Path.cwd()), request="request.json",
                               request_sha256=request_sha, preview=False)
        root = "toolchain/attempts/" + "a" * 32
        result = subject.failure_result(self.raw, self.record, self.request, request_sha)
        files = {"request.json": request_raw, root + "/receipt.json": self.raw,
                 "active": b"a" * 32 + b"\n", root + "/compose.json": canonical(self.document)}
        self.request["compose_sha256"] = subject.digest(files[root + "/compose.json"])
        request_raw = canonical(self.request) + b"\n"
        request_sha = subject.digest(request_raw)
        args.request_sha256 = request_sha
        files["request.json"] = request_raw
        result = subject.failure_result(self.raw, self.record, self.request, request_sha)
        class FakeControl:
            project = "project"
            volume = "volume"
            def path(self, relative): return "/control/" + relative
            def helper_args(self, script): return [script]
            def write_bytes(self, relative, raw): files[relative] = raw
        control = FakeControl()
        def read(_control, relative, optional=False):
            if relative in files: return files[relative]
            if optional: return None
            raise AssertionError("Unexpected missing file " + relative)
        partial = [True]
        def commit(*_args, **_kwargs):
            files[root + "/receipt.json"] = result
            if partial[0]:
                partial[0] = False
                raise OSError("simulated client interruption after atomic first write")
            files["toolchain/current.json"] = result
            files[root + "/terminal.json"] = result
            del files["active"]  # Model only the original helper's terminal acknowledgement.
            return SimpleNamespace(returncode=0)
        configured = {"services": {"fem-gpu-toolchain": {"build": {"args": {"FULLMAG_CUDA_BASE_IMAGE": "pinned"}}}}}
        with patch.object(docker_dev, "_select_source", return_value=(Path.cwd(), {})), \
             patch.object(docker_dev, "_compose_identity", return_value={}), \
             patch.object(subject, "toolchain_configuration", return_value=configured), \
             patch.object(subject, "BuildControl", return_value=control), \
             patch.object(subject, "preview", return_value=(self.raw, self.record, {})), \
             patch.object(subject, "read_raw", side_effect=read), \
             patch.object(publication, "read_raw", side_effect=read), \
             patch.object(subject, "bounded_capture", side_effect=commit), \
             patch.object(subject, "_probe_helper_absence", return_value="absence-sha"):
            with self.assertRaises(OSError):
                subject.reconcile(args)
            self.assertNotIn(root + "/terminal.json", files)
            self.assertIn("active", files)
            subject.reconcile(args)
            self.assertEqual(files[root + "/unknown-receipt.json"], self.raw)
            self.assertEqual(files[root + "/terminal.json"], result)
            self.assertNotIn("toolchain/verified.json", files)
            subject.reconcile(args)  # Idempotent post-commit verification, no second mutation.
            foreign = json.loads(result)
            foreign["reconciliation"]["request_sha256"] = "0" * 64
            files[root + "/terminal.json"] = canonical(foreign) + b"\n"
            with self.assertRaises(BuildControlError):
                subject.reconcile(args)


    def test_time_filter_precedes_limit_but_running_filter_has_no_time_bound(self):
        fake = self.history_fake()
        calls = []
        def capture(*args, **kwargs):
            if args[:3] == ("buildx", "history", "ls"):
                calls.append(args)
            return fake(*args, **kwargs)
        with patch.object(subject, "docker_capture", capture):
            subject.history(self.request, self.original)
        self.assertEqual(len(calls), 2)
        self.assertIn("startedAt>1970-01-01T00:16:39Z", calls[0])
        self.assertFalse(any("startedAt>=" in item for item in calls[0]))
        self.assertIn("status=running", calls[1])
        self.assertFalse(any("startedAt" in item or "completedAt" in item for item in calls[1]))
        self.assertFalse(any("startedAt<" in item for args in calls for item in args))

    def test_old_running_build_is_not_hidden_by_time_window(self):
        active = [{"ref": "builder/node/" + "b" * 25, "created_at": "1970-01-01T00:00:01Z"}]
        record = self.native_record()
        record["StartedAt"] = "1970-01-01T00:00:01Z"
        record["CompletedAt"] = None
        with patch.object(subject, "docker_capture", self.history_fake(rows=[], active=active, record=record)), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_unreviewed_server_filter_version_is_rejected(self):
        self.builder["Nodes"][0]["Version"] = "v0.31.0"
        self.request["builders"] = [self.builder]
        with patch.object(subject, "docker_capture", self.history_fake()), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_observer_must_target_the_linux_control_engine(self):
        self.request["buildkit_observer"] = {"kind": "native"}
        with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
             patch.object(subject, "observer_capture", return_value=SimpleNamespace(stdout=b"other-engine\n")), \
             self.assertRaises(BuildControlError):
            subject.validate_observer(self.request)

    def test_observer_kind_and_native_options_are_closed(self):
        for observer in ({"kind": "unknown"}, {"kind": "native", "skip_checks": True}):
            self.request["buildkit_observer"] = observer
            with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
                 self.assertRaises(BuildControlError):
                subject.validate_observer(self.request)

    def test_windows_observer_executable_and_version_are_pinned(self):
        raw = b"synthetic pinned Docker executable"
        self.request["buildkit_observer"] = {"kind": "windows-docker-desktop",
            "executable": "/mnt/c/Docker/docker.exe", "context": "desktop-linux",
            "sha256": subject.digest(raw), "version": "1.2.3"}
        with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
             patch.object(Path, "read_bytes", return_value=raw), \
             patch.object(subject, "observer_capture", side_effect=[
                 SimpleNamespace(stdout=b"1.2.3\n"), SimpleNamespace(stdout=b"engine\n"),
                 SimpleNamespace(stdout=self.request["buildx_version"].encode() + b"\n")]):
            subject.validate_observer(self.request)
        for content, version in ((b"replaced executable", b"1.2.3\n"), (raw, b"wrong-version\n")):
            with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
                 patch.object(Path, "read_bytes", return_value=content), \
                 patch.object(subject, "observer_capture", return_value=SimpleNamespace(stdout=version)), \
                 self.assertRaises(BuildControlError):
                subject.validate_observer(self.request)

    def test_changed_or_missing_buildx_plugin_version_is_rejected(self):
        for changed in (b"other plugin version\n", b""):
            with self.subTest(changed=changed), \
                 patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
                 patch.object(subject, "observer_capture", side_effect=[
                     SimpleNamespace(stdout=b"engine\n"), SimpleNamespace(stdout=changed)]), \
                 self.assertRaisesRegex(BuildControlError, "Buildx plugin version changed"):
                subject.validate_observer(self.request)
        self.request.pop("buildx_version")
        with self.assertRaisesRegex(BuildControlError, "Exact Buildx plugin version required"):
            subject.validate_request(self.request)


if __name__ == "__main__":
    unittest.main()
