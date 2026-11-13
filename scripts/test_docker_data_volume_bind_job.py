"""Root bind client adapter delegates supervision to the shared copy-job kernel."""
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
from unittest.mock import patch

from scripts import docker_data_volume_bind_job as job
from scripts import test_linux_data_volume_copy as copy_fixtures
from scripts.test_docker_data_volume_copy_job import FakeFence
from scripts import fullmag_data_volume_journal as journal_module
from scripts import fullmag_data_volume_pending as pending
from scripts import linux_data_volume_bind as bind_stage


TOKEN = "9" * 32
VOLUME_ID = "1" * 32
REQUEST_SHA256 = "a" * 64


class BindCommandScenario:
    def __init__(self):
        self.copy = copy_fixtures.CopyContextTests()
        self.copy.setUp()
        self.copy_receipt_sha256, _ = self.copy.completed_copy()
        self.source = Path(job.__file__).resolve().parents[1]
        self.identity = {
            "project_name": "fullmag-worktree-bindfixture",
            "project_id": "project-fixture",
            "worktree_id": "worktree-fixture",
        }
        self.image = "sha256:" + "5" * 64
        self.copy.plan.update(
            source_root=str(self.source),
            project_id=self.identity["project_id"],
            worktree_id=self.identity["worktree_id"],
            compose_project=self.identity["project_name"],
            provision_request={"wsl_distro": "UbuntuFixture"},
        )
        self.copy.plan["runtime_pins"]["image_id"] = self.image
        self.copy.plan_raw = (json.dumps(self.copy.plan, sort_keys=True) + "\n").encode()
        self.copy.drain["plan_sha256"] = hashlib.sha256(self.copy.plan_raw).hexdigest()
        self.copy.journal["request_sha256"] = hashlib.sha256(self.copy.plan_raw).hexdigest()
        self.token = TOKEN
        self.request = {
            "schema": bind_stage.SCHEMA,
            "volume_id": VOLUME_ID,
            "storage_root": self.copy.request["storage_root"],
            "token": self.token,
            "copy_request_sha256": "f" * 64,
            "copy_receipt_sha256": self.copy_receipt_sha256,
            "fence_ready_sha256": "6" * 64,
            "components": {
                name: hashlib.sha256((Path(bind_stage.__file__).parent / name).read_bytes()).hexdigest()
                for name in bind_stage.COMPONENTS
            },
        }
        self.request_raw = json.dumps(self.request, sort_keys=True).encode()
        self.request_sha256 = hashlib.sha256(self.request_raw).hexdigest()
        self.request_path = self.copy.op / "linux-bind-request.json"
        self.ready = copy.deepcopy(self.copy.ready)
        self.ready["token"] = self.token
        self.events = []
        self.operation = {
            "root": str(self.copy.op),
            "receipt": {"phase": "data-volume-migration", "attempt": self.token, "state": "started"},
            "daemon_pending": True,
        }
        self.fence = FakeFence(self.operation, self.events, token=self.token, volume_id=VOLUME_ID)
        self.fence.control.project = self.identity["project_name"]
        self.fence.control.image = self.image
        self.fence.ready = self.ready
        self.fence.released = False
        self.fence.request["source_roots"] = {
            role: {key: value[key] for key in ("device", "inode")}
            for role, value in self.copy.linux["source_roots"].items()
        }
        self.layout = {"storage_root": self.copy.request["storage_root"]}

    def read(self, path, expected=None):
        if path == self.request_path:
            if expected != self.request_sha256:
                raise ValueError("wrong fixture bind request pin")
            return self.request_raw, copy.deepcopy(self.request)
        if path.name == "bind-fence-ready.json":
            if expected != self.request["fence_ready_sha256"]:
                raise ValueError("wrong fixture bind fence pin")
            return json.dumps(self.ready).encode(), copy.deepcopy(self.ready)
        if path.parent == self.copy.op and path.name not in self.copy.evidence:
            raise ValueError("foreign fixture request path")
        return self.copy.read(path, expected)

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch.object(job.qualification, "_read", side_effect=self.read))
        stack.enter_context(patch.object(job.copy_job.storage, "resolve_layout", return_value=self.layout))
        stack.enter_context(patch.object(job, "compose_project_identity", return_value=self.identity))
        stack.enter_context(patch.object(job, "load_plan", return_value=(self.copy.plan_raw, self.copy.plan, None)))
        stack.enter_context(patch.object(
            job.qualification,
            "_selected_journal",
            return_value=(self.copy.op / "journal.json", self.copy.journal),
        ))
        self.wsl = stack.enter_context(patch.object(job, "_wsl_executable", return_value="/mnt/c/Windows/System32/wsl.exe"))
        return stack

    def call(self, *, distro="UbuntuFixture", request_path=None):
        return job.prepare_command(
            self.fence, self.source, distro, request_path or self.request_path, self.request_sha256
        )


class BindTerminalScenario:
    def __init__(self, test_case):
        self.temporary = tempfile.TemporaryDirectory(prefix="fullmag-bind-terminal-")
        test_case.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.storage_root = self.base / "storage"
        self.operation_root = self.storage_root / "migrations" / "data-volumes" / VOLUME_ID
        self.operation_root.mkdir(parents=True)
        (self.storage_root / "index").mkdir(parents=True)
        self.source_root = self.base / "source"
        self.source_root.mkdir()
        self.runtime_root = self.storage_root / "runtimes" / "worktree-fixture"
        self.source_roots = {
            "state": {
                "canonical_root": str(self.runtime_root / "docker-volume-dev" / "attempt"),
                "device": 101,
                "inode": 201,
            },
            "user_data": {
                "canonical_root": str(self.storage_root / "user-data" / "compose-fixture"),
                "device": 101,
                "inode": 202,
            },
        }
        self.mount_root = self.base / "new-volume"
        self.mount_root.mkdir()
        self.filesystem_uuid = "123e4567-e89b-12d3-a456-426614174000"
        self.linux = {
            "volume_id": VOLUME_ID,
            "storage_root": str(self.storage_root),
            "mount_root": str(self.mount_root),
            "filesystem_uuid": self.filesystem_uuid,
            "source_roots": self.source_roots,
        }
        linux_raw = json.dumps(self.linux, sort_keys=True).encode()
        self.linux_sha256 = hashlib.sha256(linux_raw).hexdigest()
        self.copy_request = {
            "volume_id": VOLUME_ID,
            "storage_root": str(self.storage_root),
            "token": "8" * 32,
            "linux_request_sha256": self.linux_sha256,
            "drain_sha256": "6" * 64,
        }
        self.copy_request_raw = json.dumps(self.copy_request, sort_keys=True).encode()
        self.copy_request_sha256 = hashlib.sha256(self.copy_request_raw).hexdigest()
        self.request = {
            "schema": bind_stage.SCHEMA,
            "volume_id": VOLUME_ID,
            "storage_root": str(self.storage_root),
            "token": TOKEN,
            "copy_request_sha256": self.copy_request_sha256,
            "copy_receipt_sha256": "3" * 64,
            "fence_ready_sha256": "4" * 64,
            "components": {name: "5" * 64 for name in bind_stage.COMPONENTS},
        }
        self.plan = {
            "schema": "fullmag.data-volume-plan.v1",
            "volume_id": VOLUME_ID,
            "storage_root": str(self.storage_root),
            "mount_root": str(self.mount_root),
            "source_root": str(self.source_root),
            "project_id": "project-fixture",
            "worktree_id": "worktree-fixture",
            "compose_project": "compose-fixture",
            "runtime_root": str(self.runtime_root),
            "observation": {"datasets": self.source_roots},
            "runtime_pins": {"backend": "a" * 64, "frontend": "b" * 64},
        }
        self.plan_raw = (json.dumps(self.plan, sort_keys=True) + "\n").encode()
        self.copy_result = {
            "schema": "fullmag.data-volume-linux-copy-result.v1",
            "state": "copied-and-verified-not-switched",
            "volume_id": VOLUME_ID,
            "token": self.copy_request["token"],
            "request_sha256": self.copy_request_sha256,
            "filesystem_uuid": self.filesystem_uuid,
            "data_sha256": "9" * 64,
            "manifest_path": str(self.mount_root / "migration" / VOLUME_ID / "source-manifest.json"),
            "manifest_sha256": "a" * 64,
            "archive_path": str(self.mount_root / "migration" / VOLUME_ID / "originals.pax"),
            "archive_sha256": "b" * 64,
            "copied_roots": {
                role: str(self.mount_root / "payload" / Path(root["canonical_root"]).relative_to(self.storage_root))
                for role, root in self.source_roots.items()
            },
            "namespace_admitted": False,
            "originals_retired": False,
        }
        self.copy_raw = json.dumps(self.copy_result, sort_keys=True).encode()
        self.request["copy_receipt_sha256"] = hashlib.sha256(self.copy_raw).hexdigest()
        self.bind_request_raw = json.dumps(self.request, sort_keys=True).encode()
        self.request_sha256 = hashlib.sha256(self.bind_request_raw).hexdigest()
        self.pending_layout = {
            "repo_root": str(self.source_root),
            "storage_root": str(self.storage_root),
            "runtime_root": str(self.runtime_root),
            "worktree_id": "worktree-fixture",
            "env": {"FULLMAG_PROJECT_ID": "project-fixture"},
        }
        self.pending_value = {
            "schema": pending.SCHEMA,
            "project_id": "project-fixture",
            "worktree_id": "worktree-fixture",
            "compose_project": "compose-fixture",
            "source_root": str(self.source_root),
            "volume_id": VOLUME_ID,
            "plan_sha256": hashlib.sha256(self.plan_raw).hexdigest(),
            "linux_request_sha256": self.linux_sha256,
            "copy_receipt_sha256": self.request["copy_receipt_sha256"],
            "state_root": self.source_roots["state"]["canonical_root"],
            "user_data_root": self.source_roots["user_data"]["canonical_root"],
        }
        self.pending_path = pending.pending_path(self.pending_layout)
        self.pending_path.parent.mkdir(parents=True)
        self.write(self.pending_path, self.pending_value)

        self.root_rows = {}
        for offset, role in enumerate(("state", "user_data"), start=1):
            original = self.source_roots[role]
            canonical = Path(original["canonical_root"])
            backup = canonical.with_name("." + canonical.name + ".fullmag-before-" + VOLUME_ID)
            copied = self.copy_result["copied_roots"][role]
            underlay_id = {"device": 101, "inode": 300 + offset}
            bound_id = {"device": 501, "inode": 600 + offset}
            self.root_rows[role] = {
                "role": role,
                "canonical_root": str(canonical),
                "backup_root": str(backup),
                "copied_root": copied,
                "original_identity": {key: original[key] for key in ("device", "inode")},
                "underlay_identity": underlay_id,
                "bound_identity": bound_id,
                "mount": {
                    "target": str(canonical),
                    "fstype": "ext4",
                    "uuid": self.filesystem_uuid,
                    "options": "rw,nodev,nosuid",
                    "propagation": "private",
                },
            }
        self.switch = {
            "schema": "fullmag.data-volume-bind-result.v1",
            "state": "binds-switched-not-admitted",
            "volume_id": VOLUME_ID,
            "filesystem_uuid": self.filesystem_uuid,
            "data_sha256": self.copy_result["data_sha256"],
            "roots": self.root_rows,
            "namespace_admitted": False,
            "originals_retired": False,
        }
        self.journal_path = self.operation_root / "journal.json"
        self.write(self.operation_root / "linux-bind-request.json", self.request)
        self.write(self.operation_root / "linux-copy-request.json", self.copy_request)
        self.write(self.operation_root / "linux-provision-request.json", self.linux)
        self.write(self.operation_root / "linux-copy-result.json", self.copy_result)

    @staticmethod
    def write(path, value):
        raw = json.dumps(value, sort_keys=True).encode()
        Path(path).write_bytes(raw)
        return raw

    def success_result(self, *, marker=None, switch=None):
        if marker is None:
            marker = {"path": str(self.pending_path), "sha256": hashlib.sha256(self.pending_path.read_bytes()).hexdigest()}
        return {
            "schema": "fullmag.data-volume-linux-bind-result.v1",
            "state": "binds-switched-not-admitted",
            "volume_id": VOLUME_ID,
            "token": TOKEN,
            "request_sha256": self.request_sha256,
            "copy_receipt_sha256": self.request["copy_receipt_sha256"],
            "pending_marker": marker,
            "switch": self.switch if switch is None else switch,
            "namespace_admitted": False,
            "originals_retired": False,
        }

    def journal(self, terminal_state=None, receipt_sha256=None):
        journal = journal_module.new_journal(VOLUME_ID, hashlib.sha256(self.plan_raw).hexdigest())
        for phase in journal_module.PHASES[:5]:
            phase_sha = self.request["copy_request_sha256"] if phase == "copy-verified" else hashlib.sha256(
                phase.encode()
            ).hexdigest()
            receipt = self.request["copy_receipt_sha256"] if phase == "copy-verified" else hashlib.sha256(
                (phase + "-receipt").encode()
            ).hexdigest()
            journal = journal_module.append_terminal(
                journal_module.append_started(journal, phase, phase_sha), "succeeded", receipt
            )
        journal = journal_module.append_started(journal, "binds-switched", self.request_sha256)
        if terminal_state is not None:
            journal = journal_module.append_terminal(journal, terminal_state, receipt_sha256)
        self.journal_path.write_bytes(json.dumps(journal, sort_keys=True).encode())
        return journal

    def publish_success(self, result=None, *, state="succeeded"):
        result = self.success_result() if result is None else result
        raw = self.write(self.operation_root / "linux-bind-result.json", result)
        receipt = hashlib.sha256(raw).hexdigest()
        self.journal(state, receipt)
        return result

    def patches(self):
        stack = ExitStack()
        stack.enter_context(patch.object(job.bind_stage, "validate_request", side_effect=lambda value: value))
        stack.enter_context(patch.object(job.copy_stage, "validate_request", return_value=self.copy_request))
        stack.enter_context(patch.object(job, "validate_linux_request", return_value=self.linux))
        stack.enter_context(patch.object(job, "load_plan", return_value=(self.plan_raw, self.plan, None)))
        stack.enter_context(patch.object(job.copy_stage, "validate_result", return_value=self.copy_result))
        return stack


class RootBindRunnerDelegationTests(unittest.TestCase):
    def test_isolated_direct_import_works_with_only_scripts_on_sys_path(self):
        script_dir = Path(job.__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix="fullmag-bind-import-outside-root-") as outside:
            probe = (
                "import sys\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "import docker_data_volume_bind_job\n"
                "assert callable(docker_data_volume_bind_job.run_root_bind)\n"
            )
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", probe, str(script_dir)],
                cwd=outside,
                capture_output=True,
                text=True,
                timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_releases_copy_fence_with_the_original_verified_copy_receipt(self):
        from scripts import docker_data_volume_bind_job as job

        fence = SimpleNamespace(check=lambda: None)
        source = Path("/selected/fullmag")
        request_path = Path("/srv/fullmag/storage/migrations/data-volumes/" + "1" * 32 + "/linux-bind-request.json")
        request_sha256 = "a" * 64
        request = {"copy_receipt_sha256": "b" * 64}
        command = ["fixed-root-bind-client"]
        operation_root = Path("/srv/fullmag/storage/migrations/data-volumes/" + "1" * 32)
        terminal = {"state": "binds-switched-not-admitted", "receipt_sha256": "c" * 64}

        with patch.object(job, "prepare_command", return_value=(command, operation_root, request)), \
             patch.object(job, "validate_terminal", return_value=terminal) as validator, \
             patch.object(job, "run_prepared_root", return_value=terminal) as supervise:
            result = job.run_root_bind(
                fence, source, "Ubuntu", request_path, request_sha256, poll_interval=0.25
            )

        self.assertIs(result, terminal)
        supervise.assert_called_once_with(
            "bind",
            fence,
            command,
            operation_root,
            request,
            request_sha256,
            validator,
            release_copy_sha256=request["copy_receipt_sha256"],
            poll_interval=0.25,
        )


class RootBindCommandContracts(unittest.TestCase):
    def test_argv_uses_fixed_isolated_root_bootstrap_and_exact_pins(self):
        fixture = BindCommandScenario()
        with fixture.patches():
            argv, operation_root, request = fixture.call()

        self.assertEqual(argv, [
            "/mnt/c/Windows/System32/wsl.exe", "--distribution", "UbuntuFixture", "--user", "root",
            "--exec", "/usr/bin/python3", "-I", "-B", "-c", job._ROOT_BIND_BOOTSTRAP,
            str(fixture.source), str(fixture.request_path), fixture.request_sha256,
            json.dumps(fixture.request["components"], sort_keys=True, separators=(",", ":")),
        ])
        self.assertEqual(operation_root, fixture.copy.op)
        self.assertEqual(request, fixture.request)

    def test_untrusted_distro_and_foreign_request_path_stop_before_root_execution(self):
        for case in ("distro", "path"):
            with self.subTest(case=case):
                fixture = BindCommandScenario()
                with fixture.patches():
                    with self.assertRaises(ValueError):
                        fixture.call(
                            distro="UbuntuFixture; touch sentinel" if case == "distro" else "UbuntuFixture",
                            request_path=fixture.copy.op / "foreign-bind-request.json" if case == "path" else None,
                        )
                    fixture.wsl.assert_not_called()

    def test_component_drift_refuses_root_execution(self):
        fixture = BindCommandScenario()
        fixture.request["components"]["linux_data_volume_bind.py"] = "0" * 64
        fixture.request_raw = json.dumps(fixture.request, sort_keys=True).encode()
        fixture.request_sha256 = hashlib.sha256(fixture.request_raw).hexdigest()
        with fixture.patches(), self.assertRaisesRegex(ValueError, "component source changed"):
            fixture.call()
        fixture.wsl.assert_not_called()

    def test_isolated_root_bootstrap_rejects_changed_module_before_import_side_effect(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-bind-bootstrap-tamper-") as temporary:
            base = Path(temporary)
            source = base / "source"
            scripts = source / "scripts"
            scripts.mkdir(parents=True)
            operation = base / "operation"
            operation.mkdir()
            request_path = operation / "linux-bind-request.json"
            sentinel = base / "imported-before-pin-check"
            safe_bytes = b"def bind_verified(*args):\n    return None\n"
            component_pins = {}
            for name in job.bind_stage.COMPONENTS:
                component_pins[name] = hashlib.sha256(safe_bytes).hexdigest()
                (scripts / name).write_bytes(safe_bytes)
            malicious = (
                "from pathlib import Path\n"
                f"Path({str(sentinel)!r}).write_text('imported')\n"
                "def bind_verified(*args):\n    return None\n"
            ).encode()
            (scripts / "linux_data_volume_bind.py").write_bytes(malicious)
            request = {
                "schema": bind_stage.SCHEMA,
                "volume_id": "1" * 32,
                "storage_root": "/srv/fullmag/storage",
                "token": "2" * 32,
                "copy_request_sha256": "a" * 64,
                "copy_receipt_sha256": "b" * 64,
                "fence_ready_sha256": "c" * 64,
                "components": component_pins,
            }
            request_raw = json.dumps(request, sort_keys=True).encode()
            request_path.write_bytes(request_raw)
            component_json = json.dumps(component_pins, sort_keys=True, separators=(",", ":"))
            result = subprocess.run(
                [
                    sys.executable, "-I", "-B", "-c", job._ROOT_BIND_BOOTSTRAP,
                    str(source), str(request_path), hashlib.sha256(request_raw).hexdigest(), component_json,
                ],
                cwd=base,
                capture_output=True,
                text=True,
                timeout=10,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("component changed", result.stderr)
            self.assertFalse(sentinel.exists())

    def test_isolated_bootstrap_executes_hashed_source_bytes_instead_of_timestamp_valid_pyc(self):
        with tempfile.TemporaryDirectory(prefix="fullmag-bind-bootstrap-pyc-") as temporary:
            base = Path(temporary)
            source = base / "source"
            scripts = source / "scripts"
            scripts.mkdir(parents=True)
            operation = base / "operation"
            operation.mkdir()
            request_path = operation / "linux-bind-request.json"
            good_sentinel = base / "sentinel-good"
            evil_sentinel = base / "sentinel-evil"

            good_dependency = (
                "from pathlib import Path\n"
                f"Path({str(good_sentinel)!r}).write_text('good')\n"
                "def execute_good():\n    return None\n"
            ).encode()
            evil_dependency = (
                "from pathlib import Path\n"
                f"Path({str(evil_sentinel)!r}).write_text('evil')\n"
                "def execute_good():\n    return None\n"
            ).encode()
            self.assertEqual(len(good_dependency), len(evil_dependency))

            component_pins = {}
            for name in job.bind_stage.COMPONENTS:
                raw = b"\n"
                if name == "fullmag_data_volume_pending.py":
                    raw = good_dependency
                elif name == "linux_data_volume_bind.py":
                    raw = (
                        b"from fullmag_data_volume_pending import execute_good\n"
                        b"def bind_verified(*args):\n    execute_good()\n"
                    )
                component_pins[name] = hashlib.sha256(raw).hexdigest()
                (scripts / name).write_bytes(raw)

            poisoned_source = scripts / "fullmag_data_volume_pending.py"
            poisoned_source.write_bytes(evil_dependency)
            fixed_mtime_ns = 1_700_000_000_000_000_000
            os.utime(poisoned_source, ns=(fixed_mtime_ns, fixed_mtime_ns))
            py_compile.compile(str(poisoned_source), doraise=True)
            poisoned_source.write_bytes(good_dependency)
            os.utime(poisoned_source, ns=(fixed_mtime_ns, fixed_mtime_ns))

            request = {
                "schema": bind_stage.SCHEMA,
                "volume_id": "1" * 32,
                "storage_root": "/srv/fullmag/storage",
                "token": "2" * 32,
                "copy_request_sha256": "a" * 64,
                "copy_receipt_sha256": "b" * 64,
                "fence_ready_sha256": "c" * 64,
                "components": component_pins,
            }
            request_raw = json.dumps(request, sort_keys=True).encode()
            request_path.write_bytes(request_raw)
            expected_json = json.dumps(component_pins, sort_keys=True, separators=(",", ":"))

            ordinary = subprocess.run(
                [
                    sys.executable, "-I", "-B", "-c",
                    "import sys; sys.path.insert(0, sys.argv[1]); "
                    "from fullmag_data_volume_pending import execute_good; execute_good()",
                    str(scripts),
                ],
                cwd=base,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(ordinary.returncode, 0, ordinary.stderr)
            self.assertTrue(evil_sentinel.exists(), "ordinary -B import did not exercise the poisoned pyc control")
            self.assertFalse(good_sentinel.exists())
            evil_sentinel.unlink()

            bootstrapped = subprocess.run(
                [
                    sys.executable, "-I", "-B", "-c", job._ROOT_BIND_BOOTSTRAP,
                    str(source), str(request_path), hashlib.sha256(request_raw).hexdigest(), expected_json,
                ],
                cwd=base,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(bootstrapped.returncode, 0, bootstrapped.stderr)
            self.assertTrue(good_sentinel.exists(), "bootstrap did not execute the pinned source bytes")
            self.assertFalse(evil_sentinel.exists(), "bootstrap executed timestamp-valid unpinned pyc bytes")

    def test_wrong_runtime_source_group_or_fence_ack_refuses_root_execution(self):
        for case in ("source", "group", "image", "fence"):
            with self.subTest(case=case):
                fixture = BindCommandScenario()
                if case == "source":
                    fixture.copy.plan["source_root"] = "/other/source"
                elif case == "group":
                    fixture.identity["worktree_id"] = "other-worktree"
                elif case == "image":
                    fixture.fence.control.image = "sha256:" + "8" * 64
                else:
                    fixture.fence.ready = dict(fixture.ready, state="released")
                fixture.copy.plan_raw = (json.dumps(fixture.copy.plan, sort_keys=True) + "\n").encode()
                with fixture.patches(), self.assertRaises(ValueError):
                    fixture.call()
                fixture.wsl.assert_not_called()

    def test_copy_journal_volume_or_original_plan_sha_drift_refuses_root_execution(self):
        for field, value in (("volume_id", "e" * 32), ("request_sha256", "0" * 64)):
            with self.subTest(field=field):
                fixture = BindCommandScenario()
                fixture.copy.journal[field] = value
                with fixture.patches(), self.assertRaises(ValueError):
                    fixture.call()
                fixture.wsl.assert_not_called()


class RootBindTerminalContracts(unittest.TestCase):
    def scenario(self):
        return BindTerminalScenario(self)

    def call(self, fixture, exit_code=0):
        with fixture.patches():
            return job.validate_terminal(
                fixture.operation_root, fixture.request, fixture.request_sha256, exit_code
            )

    def test_exact_success_requires_terminal_journal_copy_lineage_and_pending_marker(self):
        fixture = self.scenario()
        result = fixture.publish_success()

        terminal = self.call(fixture, 0)

        self.assertEqual(terminal["state"], "binds-switched-not-admitted")
        self.assertEqual(terminal["receipt_sha256"], hashlib.sha256(
            (fixture.operation_root / "linux-bind-result.json").read_bytes()
        ).hexdigest())
        self.assertEqual(terminal["result"], result)
        self.assertFalse(terminal["result"]["namespace_admitted"])
        self.assertFalse(terminal["result"]["originals_retired"])

    def test_only_exact_confirmed_failure_with_nonzero_exit_is_terminal(self):
        fixture = self.scenario()
        failure = {
            "schema": "fullmag.data-volume-linux-bind-failure.v1",
            "state": "failed-confirmed",
            "volume_id": VOLUME_ID,
            "token": TOKEN,
            "request_sha256": fixture.request_sha256,
            "error_type": "OSError",
            "originals_and_copies_retained": True,
            "manual_recovery_required": True,
        }
        raw = fixture.write(fixture.operation_root / "linux-bind-failed.json", failure)
        fixture.pending_path.unlink()
        fixture.journal("failed-confirmed", hashlib.sha256(raw).hexdigest())

        terminal = self.call(fixture, 17)

        self.assertEqual(terminal["state"], "failed-confirmed")
        self.assertEqual(terminal["result"], failure)
        self.assertEqual(terminal["receipt_sha256"], hashlib.sha256(raw).hexdigest())
        with self.assertRaises(ValueError):
            self.call(fixture, 0)

    def test_wrong_nested_scope_flags_or_mount_propagation_are_rejected(self):
        mutations = (
            ("result admission", lambda result: result.update(namespace_admitted=True)),
            ("copy receipt", lambda result: result.update(copy_receipt_sha256="e" * 64)),
            ("backup path", lambda result: result["switch"]["roots"]["state"].update(backup_root="/foreign")),
            ("shared bind", lambda result: result["switch"]["roots"]["user_data"]["mount"].update(
                propagation="shared"
            )),
        )
        for label, mutate in mutations:
            with self.subTest(label=label):
                fixture = self.scenario()
                result = fixture.success_result()
                mutate(result)
                fixture.publish_success(result)
                with self.assertRaises(ValueError):
                    self.call(fixture, 0)

    def test_pending_marker_must_match_its_receipt_and_original_copy_scope(self):
        fixture = self.scenario()
        changed_marker = dict(fixture.pending_value, worktree_id="foreign-worktree")
        raw = fixture.write(fixture.pending_path, changed_marker)
        result = fixture.success_result(marker={
            "path": str(fixture.pending_path),
            "sha256": hashlib.sha256(raw).hexdigest(),
        })
        fixture.publish_success(result)

        with self.assertRaises(ValueError):
            self.call(fixture, 0)

    def test_bind_journal_volume_or_original_plan_sha_drift_is_rejected(self):
        for field, value in (("volume_id", "e" * 32), ("request_sha256", "0" * 64)):
            with self.subTest(field=field):
                fixture = self.scenario()
                fixture.publish_success()
                journal = json.loads(fixture.journal_path.read_text())
                journal[field] = value
                fixture.journal_path.write_text(json.dumps(journal, sort_keys=True))
                with self.assertRaises(ValueError):
                    self.call(fixture, 0)

    def test_unknown_started_missing_and_ambiguous_terminals_never_release(self):
        cases = ("unknown", "started", "missing", "success_and_failure", "wrong_exit")
        for case in cases:
            with self.subTest(case=case):
                fixture = self.scenario()
                result = fixture.success_result()
                if case != "missing":
                    raw = fixture.write(fixture.operation_root / "linux-bind-result.json", result)
                if case == "unknown":
                    fixture.journal("outcome-unknown-resources-retained", hashlib.sha256(raw).hexdigest())
                    exit_code = 17
                elif case == "started":
                    fixture.journal()
                    exit_code = 0
                elif case == "missing":
                    fixture.journal("succeeded", "c" * 64)
                    exit_code = 0
                elif case == "success_and_failure":
                    fixture.journal("succeeded", hashlib.sha256(raw).hexdigest())
                    fixture.write(fixture.operation_root / "linux-bind-failed.json", {"ambiguous": True})
                    exit_code = 0
                else:
                    fixture.journal("succeeded", hashlib.sha256(raw).hexdigest())
                    exit_code = 17
                with self.assertRaises((ValueError, OSError)):
                    self.call(fixture, exit_code)

    def test_boolean_exit_is_not_a_terminal_process_code(self):
        fixture = self.scenario()
        fixture.publish_success()
        with self.assertRaises(ValueError):
            self.call(fixture, True)


if __name__ == "__main__":
    unittest.main()
