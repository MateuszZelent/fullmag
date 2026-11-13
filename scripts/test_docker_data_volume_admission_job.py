"""Root admission RPC tests; no real WSL or Docker execution."""

from contextlib import ExitStack
import copy
import hashlib
import json
import os
from pathlib import Path
import py_compile
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scripts import docker_data_volume_root_bootstrap as root_bootstrap
from scripts import linux_data_volume_admission as admission_stage
from scripts import fullmag_data_volume_journal as journal_module
from scripts import fullmag_data_volume_manifest as manifest_module
from scripts.test_docker_data_volume_copy_job import FakeFence, FakeProcess


class AdmissionJobScenario:
    def __init__(self, test_case):
        self.test_case = test_case
        from scripts.test_linux_data_volume_admission import AdmissionLoadScenario

        self.lineage = AdmissionLoadScenario(test_case)
        self.case = self.lineage
        self.read_paths = []
        read = self.case.read
        optional = self.case.optional

        def tracked_read(path, expected=None):
            self.read_paths.append(Path(path))
            return read(path, expected)

        def tracked_optional(path, *args, **kwargs):
            self.read_paths.append(Path(path))
            return optional(path, *args, **kwargs)

        self.case.read = tracked_read
        self.case.optional = tracked_optional
        self.source = self.case.source
        self.distro = "UbuntuFixture"
        self.image = "sha256:" + "5" * 64
        self.identity = {
            "project_name": "compose-fixture",
            "project_id": "project-fixture",
            "worktree_id": "worktree-fixture",
        }
        native = self.case.stage.admission.migration.host
        (self.case.original_fixture_roots["state"] / native.OWNER_NAME).write_bytes(
            self.case.certificate_raw
        )
        self.case.manifest = manifest_module.inventory_datasets(self.case.original_fixture_roots)
        self.case.manifest["roots"] = {
            role: {
                "path": row["canonical_root"],
                "device": row["device"],
                "inode": row["inode"],
            }
            for role, row in self.case.linux["source_roots"].items()
        }
        manifest_path = Path(self.case.copy_result["manifest_path"])
        self.case.copy_result["manifest_sha256"] = self.case.put(manifest_path, self.case.manifest)
        self.case.copy_result["data_sha256"] = self.case.manifest["data_sha256"]
        self._refresh_lineage()
        self.request = self.case.request
        self.request_path = self.case.path
        self.request_sha256 = self.case.request_sha
        self.ready = json.loads(self.case.docs[self.case.op / "admission-fence-ready.json"])
        self.events = []
        self.operation = {
            "root": str(self.case.op),
            "receipt": {
                "phase": "data-volume-migration",
                "attempt": self.request["token"],
                "state": "started",
            },
            "daemon_pending": True,
        }
        self.fence = FakeFence(
            self.operation,
            self.events,
            token=self.request["token"],
            volume_id=self.request["volume_id"],
        )
        self.fence.control.project = self.identity["project_name"]
        self.fence.control.image = self.image
        self.fence.ready = copy.deepcopy(self.ready)
        self.fence.released = False
        self.fence.relocated = object()
        self.fence.request["source_roots"] = {
            role: {key: row[key] for key in ("device", "inode")}
            for role, row in self.case.linux["source_roots"].items()
        }
        self.layout = {"storage_root": self.case.copy_request["storage_root"]}
        self.native_current = {
            name: (self.case.original_fixture_roots["state"] / name).read_bytes()
            for name in self.case.stage.admission.migration.host.READMISSION_FILES
        }
        self.certificate_inode = None

    def _refresh_lineage(self):
        case = self.case
        case.plan["provision_request"] = {"wsl_distro": self.distro}
        case.plan["runtime_pins"]["image_id"] = self.image
        case.plan_raw = (json.dumps(case.plan, sort_keys=True) + "\n").encode()
        plan_sha = case.put(case.op / "plan.json", case.plan)
        case.plan_sha = plan_sha

        case.copy.drain["plan_sha256"] = plan_sha
        case.copy_request["drain_sha256"] = case.put(case.op / "group-drained.json", case.copy.drain)
        case.copy_request_sha = case.put(case.op / "linux-copy-request.json", case.copy_request)
        case.copy_result["request_sha256"] = case.copy_request_sha
        case.copy_sha = case.put(case.op / "linux-copy-result.json", case.copy_result)

        bind_components = self.case.stage.bind_stage.COMPONENTS
        case.bind_request["copy_request_sha256"] = case.copy_request_sha
        case.bind_request["copy_receipt_sha256"] = case.copy_sha
        case.bind_request["components"] = {
            name: hashlib.sha256((self.source / "scripts" / name).read_bytes()).hexdigest()
            for name in bind_components
        }
        case.bind_request_sha = case.put(case.op / "linux-bind-request.json", case.bind_request)

        marker_path = case.bind_result["pending_marker"]["path"]
        marker = {
            "schema": case.stage.bind_stage.pending.SCHEMA,
            **{key: case.plan[key] for key in ("project_id", "worktree_id", "compose_project", "source_root")},
            "volume_id": case.linux["volume_id"],
            "plan_sha256": plan_sha,
            "linux_request_sha256": case.copy_request["linux_request_sha256"],
            "copy_receipt_sha256": case.copy_sha,
            "state_root": case.linux["source_roots"]["state"]["canonical_root"],
            "user_data_root": case.linux["source_roots"]["user_data"]["canonical_root"],
        }
        marker_sha = case.put(Path(marker_path), marker)
        case.bind_result.update(
            request_sha256=case.bind_request_sha,
            copy_receipt_sha256=case.copy_sha,
            pending_marker={"path": marker_path, "sha256": marker_sha},
        )
        case.bind_result["switch"]["data_sha256"] = case.copy_result["data_sha256"]
        case.bind_sha = case.put(case.op / "linux-bind-result.json", case.bind_result)

        ready_path = case.op / "admission-fence-ready.json"
        self.ready = json.loads(case.docs[ready_path])
        case.request.update(
            bind_request_sha256=case.bind_request_sha,
            bind_receipt_sha256=case.bind_sha,
            components={
                name: hashlib.sha256((self.source / "scripts" / name).read_bytes()).hexdigest()
                for name in admission_stage.COMPONENTS
            },
        )
        case.request_sha = case.put(case.path, case.request)

        journal = journal_module.new_journal(case.linux["volume_id"], plan_sha)
        terminals = (
            ("image-created", "a" * 64, "b" * 64),
            ("image-attached", "c" * 64, "d" * 64),
            ("ext4-mounted", "e" * 64, case.copy_request["provision_result_sha256"]),
            ("group-drained", case.copy_request["drain_sha256"], case.copy_request["drain_sha256"]),
            ("copy-verified", case.copy_request_sha, case.copy_sha),
            ("binds-switched", case.bind_request_sha, case.bind_sha),
        )
        for phase, inputs_sha, receipt_sha in terminals:
            journal = journal_module.append_terminal(
                journal_module.append_started(journal, phase, inputs_sha), "succeeded", receipt_sha
            )
        case.journal = journal

    def patches(self, job, *, authenticate_relocated=True):
        case = self.case
        stack = ExitStack()
        stack.enter_context(patch.object(job.qualification, "_read", side_effect=case.read))
        stack.enter_context(patch.object(
            job.qualification, "_read_optional_regular", side_effect=case.optional
        ))
        stack.enter_context(patch.object(
            job.qualification,
            "_selected_journal",
            side_effect=lambda _op: (case.op / "journal.json", copy.deepcopy(case.journal)),
        ))
        stack.enter_context(patch.object(job.copy_job.storage, "resolve_layout", return_value=self.layout))
        stack.enter_context(patch.object(job, "compose_project_identity", return_value=self.identity))
        plan_value = (case.docs[case.op / "plan.json"], copy.deepcopy(case.plan), None)
        stack.enter_context(patch.object(job, "load_plan", return_value=plan_value))
        stack.enter_context(patch.object(job.bind_job, "load_plan", return_value=plan_value))
        if authenticate_relocated:
            self.relocated_check = stack.enter_context(
                patch.object(job.relocated, "require_relocated", return_value=None)
            )
        self.wsl = stack.enter_context(patch.object(job, "_wsl_executable", return_value="/fixture/wsl.exe"))
        return stack

    def terminal_context(self):
        case = self.case
        return {
            "operation_root": case.op,
            "request": case.request,
            "request_sha256": case.request_sha,
            "plan_raw": case.docs[case.op / "plan.json"],
            "plan": case.plan,
            "linux": case.linux,
            "copy_request": case.copy_request,
            "copy_result": case.copy_result,
            "bind_request": case.bind_request,
            "bind_result": case.bind_result,
            "drain": case.copy.drain,
        }

    def patch_native_reads(self, job, stack):
        roots = self.case.bind_result["switch"]["roots"]["state"]
        old_root = Path(roots["backup_root"])
        new_root = Path(roots["canonical_root"])
        old_files = {
            name: (self.case.original_fixture_roots["state"] / name).read_bytes()
            for name in self.case.stage.admission.migration.host.READMISSION_FILES
        }

        def read_native(path, expected_entry=None):
            path = Path(path)
            name = path.name
            raw = old_files[name] if path.parent == old_root else self.native_current[name]
            if expected_entry is not None:
                if (len(raw) != expected_entry["size"] or
                        hashlib.sha256(raw).hexdigest() != expected_entry["sha256"]):
                    raise ValueError("fixture native bytes differ from authenticated parent metadata")
            return raw

        stack.enter_context(patch.object(job, "_read_native_file", side_effect=read_native))
        inode = self.certificate_inode or [roots["bound_identity"]["device"], 777, 1000, 0o600, 1]
        self.certificate_inode = copy.deepcopy(inode)
        stack.enter_context(patch.object(
            job.native_host, "_readmission_certificate_inode", return_value=inode
        ))
        return old_files

    def publish_success(self, job):
        context = self.terminal_context()
        with self.patches(job) as stack:
            old_files = self.patch_native_reads(job, stack)
            before = job._snapshot_native_before(context)
        self.native_current[job.native_host.CERTIFICATE_NAME] = before["candidate_raw"]
        self.native_current[job.native_host.OWNER_NAME] = before["candidate_raw"]
        result = {
            "schema": "fullmag.data-volume-linux-admission-result.v1",
            "state": "admission-prepared-not-admitted",
            "volume_id": self.request["volume_id"],
            "token": self.request["token"],
            "request_sha256": self.request_sha256,
            "bind_receipt_sha256": self.request["bind_receipt_sha256"],
            "copy_receipt_sha256": self.case.bind_request["copy_receipt_sha256"],
            "pending_marker": self.case.bind_result["pending_marker"],
            "preparation": {
                "schema": "fullmag.data-volume-admission-apply.v1",
                "state": "admission-prepared-not-admitted",
                "volume_id": self.request["volume_id"],
                "archive": {
                    "path": str(Path(self.case.linux["mount_root"]) / "migration" /
                                 self.request["volume_id"] / "state-admission.json"),
                    "sha256": "e" * 64,
                },
                "certificate_sha256": before["certificate_sha256"],
                "namespace_admitted": False,
                "originals_retired": False,
            },
            "source_data_sha256": self.case.copy_result["data_sha256"],
            "namespace_admitted": False,
            "data_migrated": False,
            "originals_retired": False,
        }
        case = self.case
        case.put(case.op / "linux-admission-started.json", {
            "schema": "fullmag.data-volume-admission-started.v1",
            "volume_id": self.request["volume_id"],
            "token": self.request["token"],
            "request_sha256": self.request_sha256,
        })
        result_sha = case.put(case.op / "linux-admission-result.json", result)
        started = journal_module.append_started(case.journal, "admission-prepared", self.request_sha256)
        case.journal = journal_module.append_terminal(started, "succeeded", result_sha)
        return before, result, result_sha, old_files


class AdmissionBootstrapContracts(unittest.TestCase):
    def test_bootstrap_has_exact_closed_admission_component_graph(self):
        program = root_bootstrap.bootstrap("admission")

        self.assertEqual(tuple(root_bootstrap.ADMISSION_COMPONENTS), tuple(admission_stage.COMPONENTS))
        self.assertEqual(len(admission_stage.COMPONENTS), 19)
        self.assertEqual(len(set(admission_stage.COMPONENTS)), 19)
        self.assertIn("STAGE = 'admission'", program)
        self.assertIn("linux_data_volume_admission", program)
        self.assertIn("admission_verified(request_path, request_sha256)", program)

    @staticmethod
    def _fixture(root, sentinel):
        source = root / "source"
        scripts = source / "scripts"
        scripts.mkdir(parents=True)
        operation = root / "operation"
        operation.mkdir()
        request_path = operation / "linux-admission-request.json"
        good_dependency = (
            "from pathlib import Path\n"
            f"Path({str(sentinel)!r}).write_text(__file__ + '|' + str(__cached__))\n"
            "def marker():\n    return None\n"
        ).encode()
        admission_entrypoint = (
            "from fullmag_data_volume_bind import marker\n"
            "def admission_verified(request_path, request_sha256):\n"
            "    return marker()\n"
            "if __name__ == '__main__':\n    admission_verified('', '')\n"
        ).encode()
        components = {}
        for name in admission_stage.COMPONENTS:
            raw = admission_entrypoint if name == "linux_data_volume_admission.py" else (
                good_dependency if name == "fullmag_data_volume_bind.py" else b"\n"
            )
            (scripts / name).write_bytes(raw)
            components[name] = hashlib.sha256(raw).hexdigest()
        request = {
            "schema": admission_stage.SCHEMA,
            "volume_id": "1" * 32,
            "storage_root": "/srv/fullmag/storage",
            "token": "2" * 32,
            "bind_request_sha256": "3" * 64,
            "bind_receipt_sha256": "4" * 64,
            "fence_ready_sha256": "5" * 64,
            "components": components,
        }
        request_raw = json.dumps(request, sort_keys=True).encode()
        request_path.write_bytes(request_raw)
        expected_json = json.dumps(components, sort_keys=True, separators=(",", ":"))
        return source, scripts, request_path, request_raw, expected_json, good_dependency

    def test_isolated_admission_bootstrap_uses_only_pinned_source_not_poisoned_pyc(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-admission-bootstrap-pyc-") as temporary:
            root = Path(temporary)
            good = root / "good-effect"
            poison = root / "evil-effect"
            source, scripts, request_path, raw, expected, good_source = self._fixture(root, good)
            self.assertEqual(len(good_source), len(good_source.replace(str(good).encode(), str(poison).encode())))
            dependency = scripts / "fullmag_data_volume_bind.py"
            evil_source = good_source.replace(str(good).encode(), str(poison).encode())
            dependency.write_bytes(evil_source)
            fixed_mtime_ns = 1_700_000_000_000_000_000
            os.utime(dependency, ns=(fixed_mtime_ns, fixed_mtime_ns))
            py_compile.compile(str(dependency), doraise=True)
            dependency.write_bytes(good_source)
            os.utime(dependency, ns=(fixed_mtime_ns, fixed_mtime_ns))

            ordinary = subprocess.run(
                [sys.executable, "-B", str(scripts / "linux_data_volume_admission.py")],
                cwd=root, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
            self.assertTrue(poison.exists())
            poison.unlink()

            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", root_bootstrap.bootstrap("admission"),
                 str(source), str(request_path), hashlib.sha256(raw).hexdigest(), expected],
                cwd=root, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(good.read_text(), str(scripts / "fullmag_data_volume_bind.py") + "|None")
            self.assertFalse(poison.exists())

    def test_admission_entrypoint_source_drift_is_rejected_before_import_side_effect(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-admission-bootstrap-drift-") as temporary:
            root = Path(temporary)
            sentinel = root / "entrypoint-imported"
            source, scripts, request_path, raw, expected, _good = self._fixture(root, root / "unused")
            drift = (
                "from pathlib import Path\n"
                f"Path({str(sentinel)!r}).touch()\n"
                "def admission_verified(request_path, request_sha256):\n    return None\n"
            ).encode()
            (scripts / "linux_data_volume_admission.py").write_bytes(drift)
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", root_bootstrap.bootstrap("admission"),
                 str(source), str(request_path), hashlib.sha256(raw).hexdigest(), expected],
                cwd=root, capture_output=True, text=True, timeout=10,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("source changed", result.stderr)
            self.assertFalse(sentinel.exists())


class AdmissionPrepareCommandTests(unittest.TestCase):
    def test_package_and_direct_clients_accept_the_same_live_parent_relocation(self):
        from scripts import docker_data_volume_admission_job as package_job
        import docker_data_volume_admission_job as direct_job
        from scripts.test_docker_data_volume_relocated import RelocatedGroupTests

        case = RelocatedGroupTests()
        case.setUp()
        self.addCleanup(case.doCleanups)
        view = case.issue()
        for client in (package_job, direct_job):
            with self.subTest(client=client.__name__):
                observed = client.relocated.require_relocated(view, case.case.source_root, case.case.plan)
                self.assertEqual(observed["old_roots"]["state"],
                                 Path(case.result["switch"]["roots"]["state"]["backup_root"]))

    def test_prepare_uses_fixed_admission_bootstrap_and_live_relocated_scope(self):
        from scripts import docker_data_volume_admission_job as job

        fixture = AdmissionJobScenario(self)
        with fixture.patches(job):
            command, operation_root, request = job.prepare_command(
                fixture.fence, fixture.source, fixture.distro, fixture.request_path, fixture.request_sha256
            )

        self.assertEqual(command, [
            "/fixture/wsl.exe", "--distribution", fixture.distro, "--user", "root", "--exec",
            "/usr/bin/python3", "-I", "-B", "-c", root_bootstrap.bootstrap("admission"),
            str(fixture.source), str(fixture.request_path), fixture.request_sha256,
            json.dumps(fixture.request["components"], sort_keys=True, separators=(",", ":")),
        ])
        self.assertEqual(operation_root, fixture.case.op)
        self.assertEqual(request, fixture.request)
        self.assertEqual(fixture.relocated_check.call_args.args,
                         (fixture.fence.relocated, fixture.source, fixture.case.plan))
        fixture.wsl.assert_called_once_with()

    def test_saved_relocated_mapping_refuses_before_wsl_launch(self):
        from scripts import docker_data_volume_admission_job as job

        fixture = AdmissionJobScenario(self)
        fixture.fence.relocated = {"old_roots": {"/state": "/saved/backup"}}
        with fixture.patches(job, authenticate_relocated=False), self.assertRaises(ValueError):
            job.prepare_command(
                fixture.fence, fixture.source, fixture.distro, fixture.request_path, fixture.request_sha256
            )
        fixture.wsl.assert_not_called()

    def test_invalid_distro_or_component_drift_refuses_before_wsl_launch(self):
        from scripts import docker_data_volume_admission_job as job

        for mutation in ("distro", "component"):
            with self.subTest(mutation=mutation):
                fixture = AdmissionJobScenario(self)
                distro = fixture.distro
                if mutation == "distro":
                    distro = "Ubuntu;unexpected"
                else:
                    fixture.request["components"]["linux_data_volume_admission.py"] = "0" * 64
                    fixture.request_sha256 = fixture.case.put(fixture.request_path, fixture.request)
                with fixture.patches(job), self.assertRaises((ValueError, RuntimeError)):
                    job.prepare_command(
                        fixture.fence, fixture.source, distro,
                        fixture.request_path, fixture.request_sha256,
                    )
                fixture.wsl.assert_not_called()


class AdmissionRunnerDelegationTests(unittest.TestCase):
    def test_snapshot_retention_requires_boolean_before_any_fence_or_process(self):
        from scripts import docker_data_volume_admission_job as job
        for value in (None, 1, "true", {}, []):
            with self.subTest(value=value):
                fence = SimpleNamespace(check=Mock())
                with self.assertRaisesRegex(ValueError, "retention must be an internal boolean"):
                    job.run_root_admission(fence, Path('/source'), 'Ubuntu', Path('/request'), 'a'*64,
                                           retain_native_snapshot=value)
                fence.check.assert_not_called()

    def test_retained_snapshot_comes_from_the_same_supervision_and_is_not_aliased(self):
        from scripts import docker_data_volume_admission_job as job

        fixture = AdmissionJobScenario(self)
        context = fixture.terminal_context()
        context["command"] = ["fixed-admission-client"]
        native_before = {"new_files": {"certificate": b"before"}}
        terminal = {"state": "admission-prepared-not-admitted", "receipt_sha256": "f" * 64}
        with patch.object(job, "_prepare_context", return_value=context), \
             patch.object(job, "_snapshot_native_before", return_value=native_before), \
             patch.object(job.relocated, "require_relocated"), \
             patch.object(job, "run_prepared_root", return_value=terminal):
            actual, retained = job.run_root_admission(
                fixture.fence, fixture.source, fixture.distro, fixture.request_path,
                fixture.request_sha256, retain_native_snapshot=True,
            )
        self.assertIs(actual, terminal)
        self.assertEqual(retained, native_before)
        retained["new_files"]["certificate"] = b"changed"
        self.assertEqual(native_before["new_files"]["certificate"], b"before")
        self.assertNotIn("native_before", terminal)

    def test_root_runner_uses_admission_stage_and_original_copy_acknowledgement(self):
        from scripts import docker_data_volume_admission_job as job

        fixture = AdmissionJobScenario(self)
        context = fixture.terminal_context()
        context["command"] = ["fixed-admission-client"]
        sentinel_snapshot = {"candidate_raw": b"in-memory-only"}
        terminal = {"state": "admission-prepared-not-admitted", "receipt_sha256": "f" * 64}
        with patch.object(job, "_prepare_context", return_value=context), \
             patch.object(job, "_snapshot_native_before", return_value=sentinel_snapshot), \
             patch.object(job.relocated, "require_relocated") as relocated_check, \
             patch.object(job, "run_prepared_root", return_value=terminal) as supervise:
            result = job.run_root_admission(
                fixture.fence, fixture.source, fixture.distro, fixture.request_path,
                fixture.request_sha256, poll_interval=0.25,
            )

        self.assertIs(result, terminal)
        relocated_check.assert_called_once_with(fixture.fence.relocated, fixture.source, context["plan"])
        self.assertEqual(supervise.call_args.args[:6], (
            "admission", fixture.fence, context["command"], context["operation_root"],
            context["request"], context["request_sha256"],
        ))
        self.assertTrue(callable(supervise.call_args.args[6]))
        self.assertEqual(supervise.call_args.kwargs["release_copy_sha256"],
                         fixture.case.bind_request["copy_receipt_sha256"])
        self.assertEqual(supervise.call_args.kwargs["poll_interval"], 0.25)

    def test_shared_supervisor_accepts_admission_and_releases_only_original_copy_sha(self):
        from scripts import docker_data_volume_copy_job as copy_job

        with tempfile.TemporaryDirectory(prefix="fullmag-admission-supervisor-") as temporary:
            operation_root = Path(temporary) / "operation"
            operation_root.mkdir()
            token = "5" * 32
            volume_id = "1" * 32
            request = {"token": token, "volume_id": volume_id}
            operation = {
                "root": str(operation_root),
                "receipt": {"phase": "data-volume-migration", "attempt": token, "state": "started"},
                "daemon_pending": True,
            }
            events = []
            fence = FakeFence(operation, events, token=token, volume_id=volume_id)
            process = FakeProcess(events, [None, 0])
            terminal = {
                "state": "admission-prepared-not-admitted",
                "receipt_sha256": "f" * 64,
                "result": {"namespace_admitted": False},
            }
            popen = Mock(return_value=process)
            with patch.object(
                copy_job, "subprocess",
                SimpleNamespace(DEVNULL=subprocess.DEVNULL, Popen=popen),
            ), patch.object(copy_job.time, "sleep", return_value=None):
                result = copy_job.run_prepared_root(
                    "admission", fence, ["fixed-admission-client"], operation_root,
                    request, "a" * 64, lambda *_args: terminal,
                    release_copy_sha256="c" * 64, poll_interval=0.001,
                )

            self.assertIs(result, terminal)
            self.assertEqual(fence.finish_calls, ["c" * 64])
            self.assertTrue(process.waited)
            self.assertFalse(process.terminated or process.killed)
            self.assertIs(operation["data_admission_root_process"], process)
            self.assertTrue((operation_root / "linux-admission-client-intent.json").is_file())

    def test_shared_supervisor_requires_admission_copy_release_sha_before_intent(self):
        from scripts import docker_data_volume_copy_job as copy_job

        with tempfile.TemporaryDirectory(prefix="fullmag-admission-supervisor-refusal-") as temporary:
            operation_root = Path(temporary) / "operation"
            operation_root.mkdir()
            token = "5" * 32
            volume_id = "1" * 32
            request = {"token": token, "volume_id": volume_id}
            operation = {
                "root": str(operation_root),
                "receipt": {"phase": "data-volume-migration", "attempt": token, "state": "started"},
                "daemon_pending": True,
            }
            fence = FakeFence(operation, [], token=token, volume_id=volume_id)
            with self.assertRaises(ValueError):
                copy_job.run_prepared_root(
                    "admission", fence, ["fixed-admission-client"], operation_root,
                    request, "a" * 64, lambda *_args: {}, release_copy_sha256=None,
                )

            self.assertEqual(fence.finish_calls, [])
            self.assertFalse((operation_root / "linux-admission-client-intent.json").exists())


class AdmissionTerminalContracts(unittest.TestCase):
    def scenario(self):
        from scripts import docker_data_volume_admission_job as job

        fixture = AdmissionJobScenario(self)
        before, result, _receipt_sha, old_files = fixture.publish_success(job)
        return job, fixture, before, result, old_files

    def call(self, job, fixture, before, exit_code=0):
        with fixture.patches(job) as stack:
            fixture.patch_native_reads(job, stack)
            return job.validate_terminal(
                fixture.case.op, fixture.request, fixture.request_sha256, exit_code,
                expected_before=before,
            )

    def test_exit_zero_journal_and_result_validate_without_reading_protected_archive(self):
        job, fixture, before, result, old_files = self.scenario()
        terminal = self.call(job, fixture, before)

        self.assertEqual(terminal["state"], "admission-prepared-not-admitted")
        self.assertEqual(terminal["result"], result)
        self.assertEqual(terminal["receipt_sha256"], hashlib.sha256(
            fixture.case.docs[fixture.case.op / "linux-admission-result.json"]
        ).hexdigest())
        self.assertEqual(set(old_files), set(job.native_host.READMISSION_FILES))
        archive = Path(result["preparation"]["archive"]["path"])
        self.assertNotIn(archive, fixture.read_paths)

    def test_nonzero_exit_and_late_started_or_wrong_journal_never_validate(self):
        for change in ("nonzero", "started", "late", "wrong-bind", "wrong-plan", "missing-result"):
            with self.subTest(change=change):
                job, fixture, before, _result, _old_files = self.scenario()
                if change == "started":
                    fixture.case.journal["events"].pop()
                elif change == "late":
                    fixture.case.journal["events"].append({
                        "phase": "another-phase", "state": "succeeded",
                        "inputs_sha256": "a" * 64, "receipt_sha256": "b" * 64,
                    })
                elif change == "wrong-bind":
                    fixture.case.journal["events"][-3]["receipt_sha256"] = "c" * 64
                elif change == "wrong-plan":
                    fixture.case.journal["request_sha256"] = "d" * 64
                elif change == "missing-result":
                    fixture.case.docs.pop(fixture.case.op / "linux-admission-result.json")
                exit_code = 13 if change == "nonzero" else 0
                with self.assertRaises((ValueError, OSError, KeyError)):
                    self.call(job, fixture, before, exit_code)

    def test_wrong_scope_flags_pending_or_ambiguous_failure_are_rejected(self):
        mutations = (
            ("volume", lambda result: result.update(volume_id="f" * 32)),
            ("admission flag", lambda result: result.update(namespace_admitted=True)),
            ("migration flag", lambda result: result.update(data_migrated=True)),
            ("archive path", lambda result: result["preparation"]["archive"].update(path="/foreign/archive")),
            ("certificate digest", lambda result: result["preparation"].update(certificate_sha256="0" * 64)),
            ("pending digest", lambda result: result["pending_marker"].update(sha256="0" * 64)),
        )
        for label, mutate in mutations:
            with self.subTest(label=label):
                job, fixture, before, _result, _old_files = self.scenario()
                result_path = fixture.case.op / "linux-admission-result.json"
                result = json.loads(fixture.case.docs[result_path])
                mutate(result)
                fixture.case.put(result_path, result)
                with self.assertRaises((ValueError, OSError, KeyError)):
                    self.call(job, fixture, before)

        job, fixture, before, _result, _old_files = self.scenario()
        failure_path = fixture.case.op / "linux-admission-failed.json"
        with patch.object(job.os.path, "lexists", side_effect=lambda path: Path(path) == failure_path):
            with self.assertRaises(ValueError):
                self.call(job, fixture, before)

    def test_pending_bytes_candidate_files_protected_files_or_certificate_inode_drift_refuse(self):
        job, fixture, before, _result, _old_files = self.scenario()
        marker_path = Path(fixture.case.bind_result["pending_marker"]["path"])
        fixture.case.docs[marker_path] += b" "
        with self.assertRaises(ValueError):
            self.call(job, fixture, before)

        for name in (job.native_host.CERTIFICATE_NAME, job.native_host.READMISSION_FILES[2]):
            with self.subTest(name=name):
                job, fixture, before, _result, _old_files = self.scenario()
                fixture.native_current[name] += b"drift"
                with self.assertRaises(ValueError):
                    self.call(job, fixture, before)

        job, fixture, before, _result, _old_files = self.scenario()
        fixture.certificate_inode[1] += 1
        with self.assertRaises(ValueError):
            self.call(job, fixture, before)

    def test_pre_root_snapshot_requires_old_new_native_bytes_to_match_manifest(self):
        from scripts import docker_data_volume_admission_job as job

        fixture = AdmissionJobScenario(self)
        context = fixture.terminal_context()
        roots = fixture.case.bind_result["switch"]["roots"]["state"]
        old_root = Path(roots["backup_root"])
        new_root = Path(roots["canonical_root"])
        def diverged_reader(path, expected_entry=None):
            path = Path(path)
            raw = (fixture.case.original_fixture_roots["state"] / path.name).read_bytes()
            if path.parent == new_root and path.name == job.native_host.CERTIFICATE_NAME:
                return raw + b"drift"
            return raw

        with fixture.patches(job) as stack:
            stack.enter_context(patch.object(job, "_read_native_file", side_effect=diverged_reader))
            stack.enter_context(patch.object(
                job.native_host, "_readmission_certificate_inode",
                return_value=[roots["bound_identity"]["device"], 777, 1000, 0o600, 1],
            ))
            with self.assertRaises(ValueError):
                job._snapshot_native_before(context)

    def test_native_file_reader_matches_real_tinyfile_to_authenticated_manifest_metadata(self):
        from scripts import docker_data_volume_admission_job as job

        fixture = AdmissionJobScenario(self)
        name = job.native_host.CERTIFICATE_NAME
        entry = next(item for item in fixture.case.manifest["entries"]
                     if item["role"] == "state" and item["path"] == name)
        raw = job._read_native_file(fixture.case.original_fixture_roots["state"] / name, entry)
        self.assertEqual(raw, fixture.case.certificate_raw)


if __name__ == "__main__":
    unittest.main()
