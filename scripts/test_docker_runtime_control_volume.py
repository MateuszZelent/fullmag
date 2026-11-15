"""Regression checks for the Docker runtime-control volume boundary."""

from __future__ import annotations

import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import docker_build_control as build_control


REPO_ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


runtime_service = _load(
    "fullmag_runtime_service_control_volume_test",
    REPO_ROOT / "docker/all-in-one/runtime_service.py",
)
entrypoint = _load(
    "fullmag_entrypoint_control_volume_test",
    REPO_ROOT / "docker/all-in-one/entrypoint.py",
)
healthcheck = _load(
    "fullmag_healthcheck_control_volume_test",
    REPO_ROOT / "docker/all-in-one/healthcheck.py",
)


def _docker_environment() -> dict[str, str]:
    return {
        "FULLMAG_SESSION_STORAGE_PROFILE": "windows-folder-v1",
        "FULLMAG_CONTAINER_STATE_ROOT": "/state",
        "FULLMAG_PROJECT_STORAGE_ROOT": "/state",
        "FULLMAG_RUNS_ROOT": "/state/runs/docker-all",
        "FULLMAG_RUNTIME_CONTROL_ROOT": "/opt/fullmag/runtime-control",
        "FULLMAG_RUNTIME_SERVICES_ROOT": "/opt/fullmag/runtime-control/runtime-services",
        "FULLMAG_STATE_ROOT": "/opt/fullmag/runtime-control",
        "FULLMAG_STATE_DIR": "/opt/fullmag/runtime-control",
        "FULLMAG_RUNTIME_SERVICE_CONFIG": (
            "/opt/fullmag/runtime-control/runtime-service/docker-all.json"
        ),
        "FULLMAG_REPO_ROOT": "/opt/fullmag/source",
        "FULLMAG_RUNTIME_ROOT": "/opt/fullmag/package",
        "FULLMAG_RUNTIME_PROVENANCE": "/opt/fullmag/control/backend/runtime-provenance.json",
        "FULLMAG_WORKTREE_ID": "docker-all",
    }


class RuntimeControlVolumeTests(unittest.TestCase):
    def test_canonical_paths_split_technical_and_user_namespaces(self):
        paths = runtime_service.canonical_paths(_docker_environment())

        self.assertEqual(paths.state, Path("/state"))
        self.assertEqual(paths.store, Path("/state/runs/docker-all/session-store"))
        self.assertEqual(paths.state_root, Path("/opt/fullmag/runtime-control"))
        self.assertEqual(
            paths.provenance,
            Path("/opt/fullmag/control/backend/runtime-provenance.json"),
        )
        self.assertEqual(
            runtime_service.runtime_services_root(paths),
            Path("/opt/fullmag/runtime-control/runtime-services"),
        )
        self.assertEqual(
            paths.config,
            Path("/opt/fullmag/runtime-control/runtime-service/docker-all.json"),
        )
        self.assertEqual(
            runtime_service.process_receipt_path(paths),
            Path("/opt/fullmag/runtime-control/runtime-service/process-tree.json"),
        )
        self.assertEqual(
            runtime_service._store_relative_path(
                paths, PurePosixPath("runtime-services/OWNER.json")
            ),
            Path("/opt/fullmag/runtime-control/runtime-services/OWNER.json"),
        )
        self.assertEqual(
            runtime_service._store_relative_path(paths, PurePosixPath("runs/run.json")),
            Path("/state/runs/docker-all/session-store/runs/run.json"),
        )

    def test_linux_profile_preserves_runtime_volume_and_recovery_views(self):
        environment = _docker_environment()
        environment["FULLMAG_SESSION_STORAGE_PROFILE"] = "linux-native-v1"
        with patch.dict(os.environ, environment, clear=True):
            paths = runtime_service.canonical_paths()
            api = runtime_service.api_environment(paths)
        self.assertEqual(paths.host_certificate, Path("/run/fullmag/linux-native-host.json"))
        self.assertEqual(api["FULLMAG_SESSION_STORAGE_PROFILE"], "linux-native-v1")
        self.assertEqual(api["FULLMAG_RUNTIME_CONTROL_ROOT"], "/opt/fullmag/runtime-control")
        self.assertEqual(api["FULLMAG_RUNTIME_SERVICES_ROOT"], "/opt/fullmag/runtime-control/runtime-services")
        self.assertEqual(runtime_service._store_relative_path(paths, PurePosixPath("runtime-services/OWNER.json")),
                         Path("/opt/fullmag/runtime-control/runtime-services/OWNER.json"))
        self.assertEqual(paths.provenance, Path("/opt/fullmag/control/backend/runtime-provenance.json"))

    def test_canonical_paths_rejects_unmanaged_runtime_provenance_location(self):
        environment = _docker_environment()
        environment["FULLMAG_RUNTIME_PROVENANCE"] = "/state/provenance.json"
        with self.assertRaisesRegex(
            runtime_service.RuntimeServiceError, "FULLMAG_RUNTIME_PROVENANCE.*fixed"
        ):
            runtime_service.canonical_paths(environment)

    def test_source_identity_uses_build_control_volume_provenance(self):
        paths = runtime_service.canonical_paths(_docker_environment())
        provenance = {
            "commit": "a" * 40,
            "native_source_identity": {"source_snapshot_sha256": "b" * 64},
        }
        with patch.object(runtime_service, "_read_json", return_value=provenance) as read_json:
            self.assertEqual(runtime_service._source_identity(paths), ("a" * 40, "b" * 64))
        read_json.assert_called_once_with(paths.provenance, "runtime image provenance")

    def test_api_environment_keeps_user_store_and_technical_cache_separate(self):
        paths = runtime_service.canonical_paths(_docker_environment())
        with patch.dict(
            os.environ,
            {
                "FULLMAG_SESSION_STORAGE_PROFILE": "windows-folder-v1",
                "FULLMAG_FEM_MESH_CACHE_DIR": "/build/cache/fem-mesh",
                "CUDA_CACHE_PATH": "/build/cache/cuda-compute",
            },
            clear=True,
        ):
            environment = runtime_service.api_environment(paths)

        self.assertEqual(environment["FULLMAG_PROJECT_STORAGE_ROOT"], "/state")
        self.assertEqual(environment["FULLMAG_RUNS_ROOT"], "/state/runs/docker-all")
        self.assertEqual(environment["HOME"], "/opt/fullmag/runtime-control")
        self.assertEqual(
            environment["FULLMAG_RUNTIME_SERVICE_CONFIG"],
            "/opt/fullmag/runtime-control/runtime-service/docker-all.json",
        )
        self.assertEqual(environment["FULLMAG_FEM_MESH_CACHE_DIR"], "/build/cache/fem-mesh")
        self.assertEqual(environment["CUDA_CACHE_PATH"], "/build/cache/cuda-compute")

    def test_prepare_storage_does_not_create_legacy_technical_state_on_windows_bind(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state = root / "state"
            control = root / "runtime-control"
            paths = runtime_service.RuntimePaths(
                state=state,
                storage=state,
                runs=state / "runs" / "docker-all",
                store=state / "runs" / "docker-all" / "session-store",
                state_root=control,
                runtime_services=control / "runtime-services",
                source=root / "source",
                package=root / "package",
                config=control / "runtime-service" / "docker-all.json",
            )
            with patch.dict(
                os.environ,
                {"FULLMAG_SESSION_STORAGE_PROFILE": "windows-folder-v1"},
                clear=True,
            ):
                runtime_service.prepare_storage(paths)

            self.assertTrue((state / ".fullmag-storage.json").is_file())
            self.assertTrue((control / "local-live" / "current").is_dir())
            self.assertTrue((control / "runtime-services").is_dir())
            self.assertFalse((state / ".fullmag").exists())

    def test_entrypoint_rejects_compiler_cache_under_windows_state(self):
        with patch.dict(
            os.environ,
            {"FULLMAG_FEM_MESH_CACHE_DIR": "/state/.fullmag/mesh-cache"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "must remain outside"):
                entrypoint.technical_paths()

    def test_entrypoint_defaults_are_volume_paths(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                entrypoint.technical_paths(),
                (
                    Path("/opt/fullmag/runtime-control"),
                    Path("/build/cache/fem-mesh"),
                    Path("/build/cache/cuda-compute"),
                ),
            )

    def test_healthcheck_uses_runtime_control_receipt(self):
        self.assertEqual(
            healthcheck.backend_receipt_path(
                {"FULLMAG_RUNTIME_CONTROL_ROOT": "/opt/fullmag/runtime-control"}
            ),
            Path("/opt/fullmag/runtime-control/runtime-service/process-tree.json"),
        )
        with self.assertRaisesRegex(RuntimeError, "absolute"):
            healthcheck.backend_receipt_path(
                {"FULLMAG_RUNTIME_PROCESS_RECEIPT": "../process-tree.json"}
            )

    def test_dev_image_defaults_do_not_put_technical_cache_in_state(self):
        dockerfile = (REPO_ROOT / "docker/all-in-one/Dockerfile.dev").read_text(
            encoding="utf-8"
        )
        self.assertIn("FULLMAG_RUNTIME_CONTROL_ROOT=/opt/fullmag/runtime-control", dockerfile)
        self.assertIn(
            "FULLMAG_RUNTIME_SERVICE_CONFIG=/opt/fullmag/runtime-control/runtime-service/docker-all.json",
            dockerfile,
        )
        self.assertIn("FULLMAG_FEM_MESH_CACHE_DIR=/build/cache/fem-mesh", dockerfile)
        self.assertIn("CUDA_CACHE_PATH=/build/cache/cuda-compute", dockerfile)
        self.assertNotIn("FULLMAG_FEM_MESH_CACHE_DIR=/state", dockerfile)
        self.assertNotIn("CUDA_CACHE_PATH=/state", dockerfile)


class BuildAttemptAdmissionTests(unittest.TestCase):
    def _control(self, *, namespace="", registry_sha256=None):
        instance = object.__new__(build_control.BuildControl)
        instance.project = "fullmag-attempt-admission-test"
        instance.volume = "fullmag-attempt-admission-test-control"
        instance.image = "registry.invalid/helper@sha256:" + "a" * 64
        instance.namespace = namespace
        instance.namespace_registry_sha256 = registry_sha256
        instance._active_operation = None
        return instance

    @staticmethod
    def _seed_attempts(control_root: Path, phase: str, count: int):
        attempts_root = control_root / phase / "attempts"
        attempts_root.mkdir(parents=True, exist_ok=True)
        for index in range(count):
            attempt = attempts_root / f"{index:032x}"
            attempt.mkdir()
            (attempt / "history.bin").write_bytes(f"legacy-attempt-{index}".encode())
            legacy_receipt = {
                "schema": "fullmag.docker-build-operation.v1",
                "phase": phase,
                "attempt": attempt.name,
                "attempt_limit": 64,
            }
            (attempt / "receipt.json").write_bytes(build_control.canonical(legacy_receipt) + b"\n")
        return attempts_root

    @staticmethod
    def _snapshot_files(root: Path):
        return {
            str(path.relative_to(root)): path.read_bytes()
            for path in sorted(root.rglob("*"))
            if path.is_file()
        }

    def _script(self, phase, token, control_root, registry_root=None, *, namespace=""):
        instance = self._control(namespace=namespace, registry_sha256="0" * 64)
        script = instance.operation_script(phase, token).replace("/control", str(control_root))
        if registry_root is not None:
            script = script.replace("/registry", str(registry_root))
        return script

    @staticmethod
    def _run_denied_script(script):
        return subprocess.run(
            ["/bin/bash", "-euo", "pipefail", "-c", script],
            input=b"",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=5,
            check=False,
        )

    @unittest.skipUnless(sys.platform == "linux", "shell admission fixture requires Linux")
    def test_profile_producer_admits_attempt_65_and_preserves_all_old_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            control_root = Path(temporary) / "control"
            control_root.mkdir()
            phase = "profile-run-producer"
            attempts_root = self._seed_attempts(control_root, phase, 64)
            before = self._snapshot_files(attempts_root)
            token = "f" * 32
            process = subprocess.Popen(
                [
                    "/bin/bash",
                    "-euo",
                    "pipefail",
                    "-c",
                    self._script(phase, token, control_root),
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                self.assertEqual(process.stdout.readline(), b"READY\n")
                self.assertEqual((control_root / "active").read_bytes(), (token + "\n").encode())
                process.stdin.close()
                self.assertEqual(process.stdout.readline(), b"LOGGED\n")
                (attempts_root / token / "terminal.json").write_bytes(b"{}\n")
                self.assertEqual(process.wait(timeout=5), 0, process.stderr.read().decode())
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                if process.stdin is not None and not process.stdin.closed:
                    process.stdin.close()
                process.stdout.close()
                process.stderr.close()

            self.assertEqual(len([path for path in attempts_root.iterdir() if path.is_dir()]), 65)
            self.assertEqual(
                {key: value for key, value in self._snapshot_files(attempts_root).items()
                 if key != f"{token}/build.log" and key != f"{token}/terminal.json"},
                before,
            )
            legacy_receipt = json.loads(
                (attempts_root / f"{0:032x}" / "receipt.json").read_bytes()
            )
            self.assertEqual(legacy_receipt["attempt_limit"], 64)
            self.assertNotIn("attempt_limit_policy_version", legacy_receipt)
            self.assertFalse((control_root / "active").exists())

    @unittest.skipUnless(sys.platform == "linux", "shell admission fixture requires Linux")
    def test_profile_at_256_and_build_at_64_are_refused_before_new_attempt_or_active(self):
        for phase, count in (("profile-run-producer", 256), ("toolchain", 64)):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temporary:
                control_root = Path(temporary) / "control"
                control_root.mkdir()
                attempts_root = self._seed_attempts(control_root, phase, count)
                before = self._snapshot_files(attempts_root)
                token = "e" * 32

                result = self._run_denied_script(self._script(phase, token, control_root))

                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b"READY\n", result.stdout)
                self.assertEqual(self._snapshot_files(attempts_root), before)
                self.assertFalse((attempts_root / token).exists())
                self.assertFalse((control_root / "active").exists())

    @unittest.skipUnless(sys.platform == "linux", "shell admission fixture requires Linux")
    def test_active_closing_and_registry_mismatch_guards_still_refuse_shell_admission(self):
        cases = ("active", "closing", "registry")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                control_root = root / "control"
                control_root.mkdir()
                token = "d" * 32
                registry_root = None
                namespace = ""
                if case == "active":
                    marker = control_root / "active"
                    marker.write_bytes(b"existing-owner\n")
                elif case == "closing":
                    marker = control_root / "cache-retirement" / "closing.json"
                    marker.parent.mkdir()
                    marker.write_bytes(b"closing\n")
                else:
                    namespace = "private"
                    registry_root = root / "registry"
                    (registry_root / "namespaces").mkdir(parents=True)
                    (registry_root / "namespaces" / "current.json").write_bytes(b"{}\n")
                    registry_lock = registry_root / "operation.lock"
                    registry_lock.write_bytes(b"")
                    os.link(registry_lock, control_root / "operation.lock")
                    marker = registry_root / "namespaces" / "current.json"
                marker_before = marker.read_bytes()

                script = self._script(
                    "profile-run-producer",
                    token,
                    control_root,
                    registry_root,
                    namespace=namespace,
                )
                result = self._run_denied_script(script)

                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b"READY\n", result.stdout)
                self.assertEqual(marker.read_bytes(), marker_before)
                self.assertFalse(
                    (control_root / "profile-run-producer" / "attempts" / token).exists()
                )
                if case == "active":
                    self.assertEqual(marker.read_bytes(), b"existing-owner\n")
                else:
                    self.assertFalse((control_root / "active").exists())

    def test_low_space_still_refuses_before_starting_the_control_helper(self):
        instance = self._control()
        helper_calls = []
        instance.space = lambda: {"available_bytes": 8 * 1024**3}
        instance.helper_args = lambda *args, **kwargs: helper_calls.append(args)

        with patch.object(build_control.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(build_control.BuildControlError, "32 GiB"):
                with instance.operation("profile-run-producer", {}):
                    self.fail("low-space admission must not yield")

        popen.assert_not_called()
        self.assertEqual(helper_calls, [])

    def test_receipt_uses_the_shell_admission_limit_and_versions_only_new_producer_policy(self):
        class FakeLogger:
            def __init__(self):
                self.stdin = io.BytesIO()
                self.stdout = io.BytesIO(b"READY\nLOGGED\n")

            def wait(self, timeout=None):
                return 0

        loggers = [FakeLogger(), FakeLogger()]
        receipts = {}
        writes = []
        for phase in ("profile-run-producer", "toolchain"):
            instance = self._control()
            instance.space = lambda: {"available_bytes": 64 * 1024**3}
            instance.helper_args = lambda *args, **kwargs: ["mock-helper"]
            instance._pin_operation_helper = lambda operation: "b" * 64
            instance.write = lambda path, value: writes.append((path, value))
            with patch.object(build_control.subprocess, "Popen", return_value=loggers.pop(0)), \
                 patch.object(build_control, "mirror_console", return_value=False):
                with instance.operation(phase, {}) as operation:
                    operation["receipt"]["state"] = "succeeded"
                    receipts[phase] = dict(operation["receipt"])

        for phase, receipt in receipts.items():
            self.assertEqual(
                receipt["attempt_limit"],
                build_control.attempt_limit_for_phase(phase),
            )
        self.assertEqual(receipts["profile-run-producer"]["attempt_limit"], 256)
        self.assertEqual(
            receipts["profile-run-producer"]["attempt_limit_policy_version"],
            build_control.ATTEMPT_LIMIT_POLICY_VERSION,
        )
        self.assertEqual(receipts["toolchain"]["attempt_limit"], 64)
        self.assertNotIn("attempt_limit_policy_version", receipts["toolchain"])
        self.assertGreaterEqual(len(writes), 6)


if __name__ == "__main__":
    unittest.main()
