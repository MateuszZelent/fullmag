"""Regression checks for the Docker runtime-control volume boundary."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path, PurePosixPath
import sys
import tempfile
import unittest
from unittest.mock import patch


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


if __name__ == "__main__":
    unittest.main()
