"""Source-only checks; no Rust/native test compilation or Docker mutation."""
import importlib.util
import hashlib
import json
import tempfile
import os
import re
import sys
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import nullcontext

import fullmag_docker_runtime as runtime
import run_managed_browser as managed
import docker_backend_volume_cache as volume_cache
from test_docker_backend_volume_cache import (
    DockerVolumeFixture,
    _maintenance_receipt,
    _profile,
)


def _v2_cache_fixture(root):
    profile = {
        "schema": volume_cache.SCHEMA,
        "profile": volume_cache.PROFILE,
        "state": "prepared",
        "project_id": "fullmag",
        "control_project": "fullmag-worktree-test",
        "worktree_id": "worktree-test",
        "cache_key": "c" * 64,
        "unit_key": "d" * 64,
        "owner_id": "e" * 64,
        "cargo_profile": "backend-dev",
        "runtime_image_id": "sha256:" + "a" * 64,
        "toolchain_image_id": "sha256:" + "b" * 64,
        "volume_names": {
            volume_cache.BUILD_VOLUME_ROLE: "fullmag-cache-build-test",
            volume_cache.PACKAGE_VOLUME_ROLE: "fullmag-cache-package-test",
            volume_cache.CONTROL_VOLUME_ROLE: "fullmag-build-control-worktree-test",
        },
        "build_root": volume_cache.BUILD_TARGET,
        "mount_root": volume_cache.BUILD_TARGET,
        "package_root": volume_cache.PACKAGE_TARGET,
        "receipt_path": volume_cache.RECEIPT_TARGET,
        "receipt_storage": "docker-named-volume",
        "host_receipt_path": None,
    }
    profile["environment"] = volume_cache._cache_environment(profile)
    profile["mounts"] = volume_cache.mount_specs(profile)
    profile["volume_documents"] = {
        role: {
            "Name": profile["volume_names"][role],
            "Driver": "local",
            "Options": {},
            "Scope": "local",
            "Mountpoint": "/var/lib/docker/volumes/" + profile["volume_names"][role] + "/_data",
            "Labels": volume_cache.volume_labels(profile, role),
        }
        for role in volume_cache.VOLUME_ROLES
    }
    profile["receipt_path"] = volume_cache.RECEIPT_TARGET
    profile["receipt_storage"] = "docker-named-volume"
    profile["host_receipt_path"] = None
    ready = volume_cache.validate(
        profile,
        profile["volume_documents"],
        _maintenance_receipt(profile),
        receipt_path=volume_cache.RECEIPT_TARGET,
    )
    ready["compose_overlay"] = None
    ready["maintenance_compose_overlay"] = None
    return ready


class DockerRuntimeContract(unittest.TestCase):
    def test_prepare_ready_profile_passes_runtime_cache_validator(self):
        with tempfile.TemporaryDirectory() as directory:
            profile, layout, source, repo, runroot = _profile(directory)
            docker = DockerVolumeFixture(profile)
            ready = volume_cache.prepare_ready(
                layout,
                repo,
                profile["runtime_image_id"],
                runroot,
                docker,
                lambda prepared, _overlay: _maintenance_receipt(prepared),
                source_root=source,
                toolchain_image=profile["toolchain_image_id"],
                control_volume_name=profile["volume_names"][volume_cache.CONTROL_VOLUME_ROLE],
            )
            self.assertEqual(ready["receipt_path"], volume_cache.RECEIPT_TARGET)
            self.assertEqual(ready["receipt_storage"], "docker-named-volume")
            self.assertIsNone(ready["host_receipt_path"])
            self.assertIsNone(ready.get("compose_overlay"))
            self.assertIsNone(ready.get("maintenance_compose_overlay"))
            self.assertIs(
                runtime._validate_backend_volume_cache(
                    ready, expected_package=volume_cache.PACKAGE_TARGET
                ),
                volume_cache,
            )

    def test_v2_cache_accepts_independent_named_volume_targets_and_exact_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = _v2_cache_fixture(root)
            adapter = runtime._validate_backend_volume_cache(
                cache, expected_package=volume_cache.PACKAGE_TARGET
            )
            self.assertIs(adapter, volume_cache)
            self.assertEqual(cache["mount_root"], volume_cache.BUILD_TARGET)
            self.assertEqual(cache["package_root"], volume_cache.PACKAGE_TARGET)
            tampered = dict(cache)
            tampered["mount_root"] = volume_cache.PACKAGE_TARGET
            with self.assertRaisesRegex(ValueError, "build root"):
                runtime._validate_backend_volume_cache(tampered)

    def test_backend_start_v2_does_not_apply_v1_child_path_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = _v2_cache_fixture(root)
            provenance = root / "provenance.json"
            receipt = root / "backend-start-receipt.json"
            provenance.write_text("{}\n", encoding="utf-8")
            receipt.write_text("{}\n", encoding="utf-8")
            inputs = {
                "schema": "fullmag.direct-compose.backend-start-inputs.v1",
                "state": "ready",
                "source_mode": "live-shadow-v1",
                "image_id": "sha256:" + "a" * 64,
                "toolchain_image_id": "sha256:" + "b" * 64,
                "toolchain_manifest_sha256": "c" * 64,
                "cargo_profile": "backend-dev",
                "build_profile": "dev",
                "source_project_id": "project-test",
                "source_worktree_id": "worktree-test",
                "source_checkout_kind": "worktree",
                "source_root": "/checkout",
                "git_common_dir": "/git-common",
                "provenance_path": runtime.BACKEND_PROVENANCE_PATH,
                "helper_context": "/opt/fullmag/control/docker-dev/backend-start/" + "e" * 32 + "-helpers.json",
                "backend_start_receipt": "/opt/fullmag/control/docker-dev/backend-start/" + "e" * 32 + ".json",
                "startup_helper_hashes": {
                    "docker_startup_script.py": "1" * 64,
                    "fullmag_storage.py": "2" * 64,
                },
                "package_root": volume_cache.PACKAGE_TARGET,
                "backend_cache": cache,
            }
            self.assertIs(runtime._validate_backend_start_inputs(inputs, {}), inputs)

    def test_unknown_backend_cache_schema_is_not_treated_as_v1_or_v2(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = _v2_cache_fixture(Path(directory))
            cache["schema"] = "fullmag.backend-build-cache.unknown"
            with self.assertRaisesRegex(ValueError, "unsupported schema"):
                runtime._validate_backend_volume_cache(cache)

    def test_live_compose_rejects_non_mapping_start_inputs_before_docker(self):
        with patch.object(runtime, "docker") as docker_call:
            with self.assertRaisesRegex(ValueError, "Backend start inputs must be an object"):
                runtime.compose_spec(
                    "sha256:" + "a" * 64, Path("/state-host"), 3197,
                    host_certificate=Path("/host-certificate.json"),
                    workspace_state_root=Path("/user-data"),
                    package="/mnt/cache/package", provenance=Path("/provenance.json"),
                    inputs_path=Path("/inputs.json"), backend_start=[],
                )
            docker_call.assert_not_called()

    def test_development_backend_package_does_not_require_static_frontend(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            (package / "bin").mkdir()
            for name in runtime.REQUIRED_BINARIES:
                (package / "bin" / name).write_bytes(b"artifact")
            (package / "_fullmag_core.so").write_bytes(b"extension")
            runtime.validate_runtime_artifacts(package, development=True)
            with self.assertRaisesRegex(ValueError, "web/index.html"):
                runtime.validate_runtime_artifacts(package)
            (package / "bin" / "fullmag-api").unlink()
            with self.assertRaisesRegex(ValueError, "bin/fullmag-api"):
                runtime.validate_runtime_artifacts(package, development=True)

    def test_backend_package_mount_stays_in_daemon_posix_namespace(self):
        expected = runtime._daemon_mount_path(
            "/mnt/fullmag-cache/package", "backend package root"
        )
        self.assertEqual(expected, runtime.PurePosixPath("/mnt/fullmag-cache/package"))
        self.assertEqual(
            runtime._daemon_mount_path(
                "/mnt/fullmag-cache/package", "backend package bind"
            ),
            expected,
        )
        for value in ("C:/fullmag/package", "relative/package", "/mnt/cache/../package"):
            with self.assertRaisesRegex(ValueError, "canonical daemon path"):
                runtime._daemon_mount_path(value, "backend package root")

    def test_development_gate_starts_with_provisional_certificate_then_binds_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            provenance = root / "provenance.json"
            provenance.write_text("{}\n", encoding="utf-8")
            inputs = {
                "image_id": "sha256:" + "a" * 64,
                "toolchain_image_id": "sha256:" + "b" * 64,
                "toolchain_manifest_sha256": "c" * 64,
                "provenance_path": str(provenance),
            }
            source_identity = {"project_name": "fullmag-worktree-test"}
            provisional, hashes, delegation = runtime._provisional_development_certificate(
                inputs, source_identity
            )
            self.assertEqual(provisional["commit"], "0" * 40)
            self.assertEqual(set(hashes), set(runtime.REQUIRED_BINARIES))
            self.assertEqual(
                set(delegation),
                {
                    "schema", "cargo_profile", "toolchain_image_id", "package_root",
                    "provenance_path", "group_identity", "source_identity",
                },
            )
            self.assertEqual(delegation["cargo_profile"], "backend-dev")
            self.assertEqual(delegation["toolchain_image_id"], inputs["toolchain_image_id"])
            self.assertEqual(delegation["package_root"], "/opt/fullmag/package")
            self.assertEqual(delegation["provenance_path"], runtime.BACKEND_PROVENANCE_PATH)
            self.assertEqual(delegation["group_identity"], "fullmag-worktree-test")
            self.assertEqual(
                delegation["source_identity"],
                {
                    "commit": "0" * 40,
                    "source_digest": "0" * 64,
                    "source_snapshot_sha256": "0" * 64,
                    "native_source_identity_sha256": "0" * 64,
                },
            )
            certificate = {
                "image_id": inputs["image_id"],
                "source_commit": provisional["commit"],
                "binary_hashes": hashes,
                "artifact_receipt_sha256": provisional["build_receipt_sha256"],
                "development_build": delegation,
                "restart_verified": False,
            }
            assembly = {
                "commit": "d" * 40,
                "source_digest": "1" * 64,
                "source_snapshot_sha256": "2" * 64,
                "native_source_identity": {"head_commit_full": "d" * 40, "source_snapshot_sha256": "2" * 64},
                "binary_hashes": {name: "e" * 64 for name in runtime.REQUIRED_BINARIES},
                "build_receipt_sha256": "f" * 64,
            }
            refreshed = runtime._refresh_development_certificate(certificate, assembly, inputs)
            self.assertEqual(refreshed["source_commit"], "d" * 40)
            self.assertEqual(refreshed["binary_hashes"], assembly["binary_hashes"])
            self.assertFalse(refreshed["restart_verified"])
            expected_native_identity_sha256 = hashlib.sha256(
                (json.dumps(assembly["native_source_identity"], separators=(",", ":"), sort_keys=True) + "\n")
                .encode("utf-8")
            ).hexdigest()
            self.assertEqual(
                refreshed["development_build"]["source_identity"],
                {
                    "commit": "d" * 40,
                    "source_digest": "1" * 64,
                    "source_snapshot_sha256": "2" * 64,
                    "native_source_identity_sha256": expected_native_identity_sha256,
                },
            )
            changed_assembly = dict(assembly)
            changed_assembly.update(
                commit="a" * 40,
                source_digest="3" * 64,
                source_snapshot_sha256="4" * 64,
                native_source_identity={"head_commit_full": "a" * 40, "source_snapshot_sha256": "4" * 64},
            )
            retained = runtime._refresh_development_certificate(
                refreshed, changed_assembly, inputs
            )
            self.assertEqual(
                retained["development_build"]["source_identity"],
                refreshed["development_build"]["source_identity"],
            )

    def test_direct_project_name_is_validated_before_startup_mutations(self):
        with patch.object(runtime.storage, "resolve_layout") as resolve:
            for name in ("../fullmag", "Fullmag", "fullmag;other", ""):
                with self.assertRaisesRegex(ValueError, "Invalid Compose project name"):
                    runtime.start(None, None, 3197, project_name=name)
            resolve.assert_not_called()

    def test_backend_start_source_group_maps_to_compose_identity_fields(self):
        backend_start = {
            "source_project_id": "project-test",
            "source_worktree_id": "worktree-test",
            "source_checkout_kind": "worktree",
        }
        source_identity = {
            "project_name": "fullmag-worktree-test",
            "project_id": "project-test",
            "worktree_id": "worktree-test",
            "checkout_kind": "worktree",
        }
        runtime._validate_backend_start_source_group(backend_start, source_identity)
        source_identity["checkout_kind"] = "main-checkout"
        with self.assertRaisesRegex(ValueError, "source group"):
            runtime._validate_backend_start_source_group(backend_start, source_identity)

    def test_compiled_receipt_identity_rejects_building_placeholder(self):
        with self.assertRaisesRegex(ValueError, "successful compiled receipt"):
            runtime._backend_assembly_receipt_identity({
                "state": "building",
                "image_id": "sha256:" + "a" * 64,
            })
        assembly = {
            "state": "succeeded",
            "exit_code": 0,
            "commit": "b" * 40,
            "native_source_identity": {"head_commit_full": "b" * 40},
            "source_digest": "c" * 64,
            "source_snapshot_sha256": "d" * 64,
            "live_manifest_sha256": "e" * 64,
        }
        self.assertEqual(
            runtime._backend_assembly_receipt_identity(assembly),
            {
                "compiled_source_commit": "b" * 40,
                "native_source_identity": assembly["native_source_identity"],
                "source_digest": "c" * 64,
                "source_snapshot_sha256": "d" * 64,
                "live_manifest_sha256": "e" * 64,
            },
        )

    def test_compose_service_container_id_requires_one_valid_service(self):
        compose_args = ["compose", "--project-name", "fullmag-test"]
        with patch.object(runtime, "docker", return_value="a" * 64 + "\n") as docker_call:
            self.assertEqual(
                runtime._compose_service_container_id(compose_args, "backend"),
                "a" * 64,
            )
        docker_call.assert_called_once_with(*compose_args, "ps", "--quiet", "backend")
        for output in ("", "a" * 64 + "\n" + "b" * 64 + "\n", "not-an-id\n"):
            with patch.object(runtime, "docker", return_value=output):
                with self.assertRaisesRegex(ValueError, "exactly one valid running container ID"):
                    runtime._compose_service_container_id(compose_args, "backend")

    def test_workspace_user_data_is_stable_and_scoped_to_compose_group(self):
        with tempfile.TemporaryDirectory() as directory:
            layout = {"storage_root": directory}
            path = runtime._workspace_user_data_root(layout, "fullmag-worktree-alpha")
            self.assertEqual(path, Path(directory) / "user-data" / "fullmag-worktree-alpha")
            self.assertTrue(path.is_dir())
            again = runtime._workspace_user_data_root(layout, "fullmag-worktree-alpha")
            self.assertEqual(again, path)
            with self.assertRaisesRegex(ValueError, "Invalid Compose project name"):
                runtime._workspace_user_data_root(layout, "../other")

    @unittest.skipUnless(os.environ.get("FULLMAG_TEST_COMPOSE_CONFIG") == "1", "Read-only Compose CLI integration gate")
    def test_workspace_uses_one_loopback_port_and_explicit_gpu(self):
        service = runtime.compose_spec("sha256:" + "a" * 64, Path("/state-host"), 3197,
                                       Path("/owned/host.json"),
                                       workspace_state_root=Path("/owned/user-data"))["services"]["backend"]
        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(service["ports"][0]["published"], "3197")
        self.assertEqual(service["ports"][0]["target"], 8081)
        self.assertEqual(service["gpus"][0]["count"], -1)
        self.assertTrue(service["read_only"])
        self.assertEqual([m["target"] for m in service["volumes"]],
                         ["/user-data", "/state", "/run/fullmag/windows-folder-host.json"])
        self.assertEqual(service["environment"]["FULLMAG_WORKSPACE_STATE_DIR"], "/user-data")

    @unittest.skipUnless(os.environ.get("FULLMAG_TEST_COMPOSE_CONFIG") == "1", "Read-only Compose CLI integration gate")
    def test_development_separates_live_frontend_from_session_writer(self):
        inputs = {"source_root": "/checkout"}
        spec = runtime.compose_spec("sha256:" + "a" * 64, Path("/owned/state"), 3197,
                                    Path("/owned/host.json"), workspace_state_root=Path("/owned/user-data"),
                                    inputs=inputs,
                                    inputs_path=Path("/owned/inputs.json"),
                                    package=Path("/owned/package"), provenance=Path("/owned/assembly.json"))
        self.assertEqual(set(spec["services"]), {"backend", "frontend"})
        backend, frontend = spec["services"]["backend"], spec["services"]["frontend"]
        self.assertFalse(backend.get("ports"))
        self.assertEqual(backend["gpus"][0]["count"], -1)
        self.assertNotIn("gpus", frontend)
        self.assertEqual(frontend["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(frontend["ports"][0]["target"], 8080)
        self.assertEqual(frontend["environment"]["FULLMAG_API_PROXY_TARGET"], "http://backend:8081")
        self.assertEqual(frontend["depends_on"]["backend"]["condition"], "service_started")
        self.assertEqual([m["target"] for m in frontend["volumes"] if not m.get("read_only")],
                         ["/state/development"])
        self.assertNotIn("/state", [m["target"] for m in frontend["volumes"]])
        self.assertNotIn("/user-data", [m["target"] for m in frontend["volumes"]])
        self.assertEqual(backend["environment"]["FULLMAG_WORKSPACE_STATE_DIR"], "/user-data")
        user_data_mount = next(m for m in backend["volumes"] if m["target"] == "/user-data")
        self.assertEqual(user_data_mount["source"], "/owned/user-data")
        source = next(m for m in backend["volumes"] if m["target"] == "/opt/fullmag/source")
        self.assertTrue(source["read_only"])
        self.assertEqual(source["source"], "/checkout")
        self.assertFalse(source["bind"]["create_host_path"])
        self.assertEqual(set(backend["networks"]), {"fullmag"})
        self.assertEqual(set(frontend["networks"]), {"fullmag"})
        self.assertFalse(spec["networks"]["fullmag"].get("external", False))
        self.assertNotIn("volumes", spec)

    def test_docker_timeout_preserves_unknown_operation_without_retry(self):
        with patch.object(runtime.subprocess, "run", side_effect=subprocess.TimeoutExpired(["docker"], 3)) as run:
            with self.assertRaises(runtime.DockerOutcomeUnknown) as caught:
                runtime.docker("wait", "owned-container", timeout=3)
            self.assertEqual(caught.exception.operation, ["wait", "owned-container"])
            self.assertEqual(caught.exception.timeout_seconds, 3)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(run.call_args.kwargs["timeout"], 3)

    def test_dev_frontend_and_startup_script_use_distinct_bounded_compose_waits(self):
        import docker_startup_script as startup
        self.assertGreaterEqual(runtime.STARTUP_READY_TIMEOUT_SECONDS,
                                startup.STARTUP_ACTIVATION_TIMEOUT_SECONDS + 60)
        self.assertGreaterEqual(runtime.STARTUP_DOCKER_CLIENT_TIMEOUT_SECONDS,
                                runtime.STARTUP_READY_TIMEOUT_SECONDS + 60)
        self.assertEqual(
            runtime._runtime_ready_timeouts(None, {"authorization": {}}),
            (runtime.STARTUP_READY_TIMEOUT_SECONDS, runtime.STARTUP_DOCKER_CLIENT_TIMEOUT_SECONDS),
        )
        self.assertEqual(
            runtime._runtime_ready_timeouts({}, None),
            (runtime.FRONTEND_DEV_READY_TIMEOUT_SECONDS,
             runtime.FRONTEND_DEV_DOCKER_CLIENT_TIMEOUT_SECONDS),
        )
        self.assertEqual(runtime._runtime_ready_timeouts(None, None), (90, 150))
        self.assertGreaterEqual(
            runtime.FRONTEND_DEV_READY_TIMEOUT_SECONDS,
            2 * 120 + (60 * 60) + 60,
        )
        self.assertGreaterEqual(
            runtime.FRONTEND_DEV_DOCKER_CLIENT_TIMEOUT_SECONDS,
            runtime.FRONTEND_DEV_READY_TIMEOUT_SECONDS + 60,
        )
        repository = Path(__file__).resolve().parents[1]
        dev_compose = (repository / "compose.dev.yaml").read_text(encoding="utf-8")
        frontend_block = dev_compose.split("\n  frontend:\n", 1)[1]
        backend_block = dev_compose.split("\n  backend:\n", 1)[1].split("\n  frontend:\n", 1)[0]
        self.assertRegex(frontend_block, r"(?m)^      backend: \{condition: service_started\}$")
        self.assertNotIn("service_healthy", frontend_block)
        self.assertIn("FULLMAG_API_PROXY_TARGET: http://backend:8081", frontend_block)
        self.assertNotRegex(backend_block, r"(?m)^    ports:")
        health = re.search(r"(?m)^      start_period: (?P<seconds>[0-9]+)s$", frontend_block)
        self.assertIsNotNone(health)
        self.assertEqual(int(health.group("seconds")), runtime.FRONTEND_DEV_READY_TIMEOUT_SECONDS)
        static_compose = (repository / "compose.static.yaml").read_text(encoding="utf-8")
        self.assertNotIn("\n  frontend:", static_compose)

    def test_startup_receipt_requires_ready_matching_activation(self):
        authorization = {
            "schema": "fullmag.docker-startup-script.v1",
            "authorization": "explicit_startup_script",
            "request_id": "startup-receipt-test",
            "source_sha256": "a" * 64,
            "source_relative": "models/scene.py",
        }
        response = {
            "schema": "fullmag.startup-script-activation.v1",
            "authorization": "explicit_startup_script",
            "request_id": authorization["request_id"],
            "source_sha256": authorization["source_sha256"],
            "status": "accepted",
            "session_id": "session-startup-receipt-test",
            "run_id": "run-startup-receipt-test",
            "step_ids": ["step-startup-receipt-test"],
            "scene_revision": 0,
            "runtime_metadata": {"interactive": False, "wait_for_solve": False},
            "execution": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
        }
        receipt = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "ready",
            "startup_activation": {
                "schema": "fullmag.startup-script-activation.v1",
                "state": "activated",
                "request_id": authorization["request_id"],
                "source_sha256": authorization["source_sha256"],
                "source_relative": authorization["source_relative"],
                "response": response,
            },
        }
        import docker_startup_script as startup_helper
        self.assertIs(runtime._validate_startup_process_receipt(
            receipt, authorization, startup_helper
        ), receipt)
        changed = json.loads(json.dumps(receipt))
        changed["startup_activation"]["request_id"] = "other-request"
        with self.assertRaisesRegex(ValueError, "fence"):
            runtime._validate_startup_process_receipt(changed, authorization, startup_helper)

    def test_startup_receipt_preserves_fenced_unknown_activation_diagnostic(self):
        import docker_startup_script as startup_helper

        authorization = {
            "schema": "fullmag.docker-startup-script.v1",
            "authorization": "explicit_startup_script",
            "request_id": "startup-unknown-receipt-test",
            "source_sha256": "a" * 64,
            "source_relative": "models/scene.py",
        }
        diagnostic = {
            "schema": startup_helper.STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA,
            "state": "unknown",
            "request_id": authorization["request_id"],
            "source_sha256": authorization["source_sha256"],
            "source_relative": authorization["source_relative"],
            "durable_state": "started",
            "error": "startup activation returned HTTP 409: session store writer is busy",
        }
        receipt = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "ready",
            "startup_activation": diagnostic,
        }

        with self.assertRaises(runtime.StartupActivationOutcomeUnknown) as caught:
            runtime._validate_startup_process_receipt(
                receipt, authorization, startup_helper
            )
        self.assertEqual(caught.exception.diagnostic, diagnostic)
        self.assertIn("HTTP 409", str(caught.exception))
        self.assertEqual(
            caught.exception.operation,
            ["startup-activation", authorization["request_id"]],
        )

        for key, value in (
            ("request_id", "other-request"),
            ("source_sha256", "b" * 64),
            ("source_relative", "other/scene.py"),
            ("durable_state", "completed"),
            ("error", ""),
        ):
            malformed = json.loads(json.dumps(receipt))
            malformed["startup_activation"][key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "fence"):
                runtime._validate_startup_process_receipt(
                    malformed, authorization, startup_helper
                )

        with self.assertRaisesRegex(ValueError, "fence"):
            runtime._validate_startup_process_receipt(receipt, authorization, None)
        missing_schema = json.loads(json.dumps(receipt))
        missing_schema["startup_activation"].pop("schema")
        with self.assertRaisesRegex(ValueError, "fence"):
            runtime._validate_startup_process_receipt(missing_schema, authorization, None)

    def test_static_startup_bind_requires_assembled_native_identity(self):
        expected = {"head_commit_full": "a" * 40,
                    "source_snapshot_sha256": "b" * 64,
                    "source_snapshot_dirty": False}
        assembly = {"commit": "a" * 40, "source_mode": "commit",
                    "native_source_identity": expected}
        with tempfile.TemporaryDirectory() as directory:
            selected = Path(directory).resolve()
            with patch("local_runner.build_source.native_identity", return_value=expected) as identity:
                self.assertEqual(runtime._require_static_source_identity(assembly, selected), expected)
            identity.assert_called_once_with(selected, "snapshot")
            with patch("local_runner.build_source.native_identity", return_value={**expected, "source_snapshot_dirty": True}):
                with self.assertRaisesRegex(ValueError, "assembled native source identity"):
                    runtime._require_static_source_identity(assembly, selected)

    def test_compose_migration_forwards_resolved_source_identity_to_network_guard(self):
        identity = {
            "project_name": "fullmag-worktree-network-test",
            "network_name": "fullmag-worktree-network-test_fullmag",
            "project_id": "project-test",
            "worktree_id": "worktree-test",
            "checkout_kind": "worktree",
        }
        with patch("docker_dev._assert_no_running_fullmag") as guard:
            runtime._assert_compose_project_absent(identity["project_name"], identity)
        guard.assert_called_once_with(identity["project_name"], identity)

    def test_live_shadow_source_provenance_is_dev_only_and_has_no_archive(self):
        commit = "a" * 40
        native = {
            "head_commit_full": commit,
            "source_snapshot_sha256": "b" * 64,
            "source_snapshot_dirty": True,
        }
        assembly = {
            "source_mode": "live-shadow-v1",
            "runtime_mode": "development_source_bind",
            "commit": commit,
            "source_digest": "c" * 64,
            "source_snapshot_sha256": native["source_snapshot_sha256"],
            "native_source_identity": native,
            "source_manifest": "/owned/live-manifest.json",
            "live_manifest_sha256": "d" * 64,
            "source_git_common_dir": "/owned/.git",
        }
        observed = runtime._validate_assembly_source_provenance(assembly, frontend="dev")
        self.assertEqual(observed["source_mode"], "live-shadow-v1")
        self.assertEqual(observed["live_manifest_sha256"], "d" * 64)
        observed_without_host_manifest = runtime._validate_assembly_source_provenance(
            {key: value for key, value in assembly.items() if key != "source_manifest"},
            frontend="dev",
        )
        self.assertEqual(observed_without_host_manifest["live_manifest_sha256"], "d" * 64)
        with self.assertRaisesRegex(ValueError, "development runtime"):
            runtime._validate_assembly_source_provenance(assembly, frontend="static")
        with self.assertRaisesRegex(ValueError, "must not claim a source archive"):
            runtime._validate_assembly_source_provenance(
                {**assembly, "source_archive": {"path": "/owned/source.tar"}}, frontend="dev"
            )
        with self.assertRaisesRegex(ValueError, "canonical live manifest"):
            runtime._validate_assembly_source_provenance(
                {key: value for key, value in assembly.items() if key != "live_manifest_sha256"},
                frontend="dev",
            )

    def test_legacy_archive_provenance_stays_strict_without_live_fields(self):
        commit = "e" * 40
        assembly = {
            "source_mode": "snapshot",
            "runtime_mode": "packaged_release",
            "commit": commit,
            "source_digest": "f" * 64,
            "native_source_identity": {
                "head_commit_full": commit,
                "source_snapshot_sha256": "1" * 64,
            },
            "source_archive": {
                "path": "/owned/source.tar",
                "manifest_path": "/owned/source.json",
                "sha256": "2" * 64,
                "bytes": 17,
            },
        }
        observed = runtime._validate_assembly_source_provenance(assembly, frontend="static")
        self.assertEqual(observed["source_mode"], "snapshot")
        with self.assertRaisesRegex(ValueError, "live-only provenance"):
            runtime._validate_assembly_source_provenance(
                {**assembly, "live_manifest_sha256": "3" * 64}, frontend="static"
            )
        with self.assertRaisesRegex(ValueError, "archive provenance is invalid"):
            runtime._validate_assembly_source_provenance(
                {**assembly, "source_archive": {**assembly["source_archive"], "bytes": True}},
                frontend="static",
            )

    def test_startup_helper_inventory_uses_frozen_assembly_bytes_on_crlf_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / "image-output"
            context = output / "context"
            context.mkdir(parents=True)
            source = root / "selected"
            (source / "scripts").mkdir(parents=True)
            repository = Path(__file__).resolve().parents[1]
            for name in runtime._STARTUP_HELPERS:
                frozen = repository / "scripts" / name
                (context / name).write_bytes(frozen.read_bytes())
                # A Windows checkout can expose the same text with CRLF.  The
                # byte contract must select the frozen assembly helper instead
                # of normalizing or silently accepting a different digest.
                (source / "scripts" / name).write_bytes(
                    frozen.read_bytes().replace(b"\n", b"\r\n")
                )
            assembly = {
                "startup_helper_hashes": {
                    name: runtime.digest(context / name) for name in runtime._STARTUP_HELPERS
                },
                "output": str(output),
            }
            helper, attestation = runtime._startup_helper_for_start(
                assembly, {"build_storage_root": str(root)}, source
            )
            self.assertEqual(attestation["source"], "assembly_context")
            self.assertEqual(Path(helper.__file__).resolve(), (context / "docker_startup_script.py").resolve())
            self.assertNotEqual(attestation["hashes"], assembly["startup_helper_hashes"])

    def test_startup_helper_exec_uses_selected_bytes_and_restores_foreign_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            selected = root / "selected-checkout"
            (selected / "scripts").mkdir(parents=True)
            repository = Path(__file__).resolve().parents[1]
            for name in runtime._STARTUP_HELPERS:
                (selected / "scripts" / name).write_bytes(
                    (repository / "scripts" / name).read_bytes()
                )
            assembly = {
                "startup_helper_hashes": {
                    name: runtime.digest(selected / "scripts" / name)
                    for name in runtime._STARTUP_HELPERS
                }
            }
            foreign_startup = object()
            # Preserve a present None entry exactly as well as a foreign
            # startup object; temporary execution must not perturb either.
            foreign_storage = None
            with patch.dict(sys.modules, {
                "docker_startup_script": foreign_startup,
                "fullmag_storage": foreign_storage,
            }, clear=False):
                before = {
                    name: sys.modules.get(name)
                    for name in runtime._STARTUP_HELPER_MODULES.values()
                }
                helper, attestation = runtime._startup_helper_for_start(
                    assembly, {"build_storage_root": str(root)}, selected
                )
                after = {
                    name: sys.modules.get(name)
                    for name in runtime._STARTUP_HELPER_MODULES.values()
                }
            self.assertEqual(attestation["source"], "selected_checkout")
            self.assertEqual(Path(helper.__file__).resolve(),
                             (selected / "scripts/docker_startup_script.py").resolve())
            self.assertIsNot(helper, foreign_startup)
            self.assertEqual(before, after)

    def test_startup_helper_exec_restores_sys_modules_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            repository = Path(__file__).resolve().parents[1]
            helpers = {}
            for name in runtime._STARTUP_HELPERS:
                path = root / name
                path.write_bytes((repository / "scripts" / name).read_bytes())
                helpers[name] = (path, path.read_bytes())
            broken_path = root / "docker_startup_script.py"
            helpers["docker_startup_script.py"] = (broken_path, b"def broken(:\n")
            foreign_startup = object()
            foreign_storage = None
            with patch.dict(sys.modules, {
                "docker_startup_script": foreign_startup,
                "fullmag_storage": foreign_storage,
            }, clear=False):
                before = {
                    name: sys.modules.get(name)
                    for name in runtime._STARTUP_HELPER_MODULES.values()
                }
                with self.assertRaises(SyntaxError):
                    runtime._exec_verified_startup_helpers(helpers)
                after = {
                    name: sys.modules.get(name)
                    for name in runtime._STARTUP_HELPER_MODULES.values()
                }
            self.assertEqual(before, after)

    def test_startup_helper_exec_uses_captured_bytes_after_path_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            selected = root / "selected-checkout"
            (selected / "scripts").mkdir(parents=True)
            repository = Path(__file__).resolve().parents[1]
            for name in runtime._STARTUP_HELPERS:
                (selected / "scripts" / name).write_bytes(
                    (repository / "scripts" / name).read_bytes()
                )
            assembly = {
                "startup_helper_hashes": {
                    name: runtime.digest(selected / "scripts" / name)
                    for name in runtime._STARTUP_HELPERS
                }
            }
            original_exec = runtime._exec_verified_startup_helpers
            startup_path = selected / "scripts/docker_startup_script.py"

            def mutate_after_capture(helpers):
                startup_path.write_bytes(b"raise RuntimeError('path was reread')\n")
                return original_exec(helpers)

            with patch.object(runtime, "_exec_verified_startup_helpers",
                              side_effect=mutate_after_capture):
                helper, attestation = runtime._startup_helper_for_start(
                    assembly, {"build_storage_root": str(root)}, selected
                )
            self.assertEqual(attestation["source"], "selected_checkout")
            self.assertEqual(helper.RESPONSE_SCHEMA, "fullmag.startup-script-activation.v1")

    def test_artifact_digest_handles_empty_and_multiblock_files_on_python_310(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact"
            for data in (b"", b"abc", b"artifact-block" * 100000):
                path.write_bytes(data)
                self.assertEqual(runtime.digest(path), hashlib.sha256(data).hexdigest())

    def test_development_image_context_contains_no_application_sources_or_binaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helpers = root / "capsule/tree/docker/all-in-one"
            helpers.mkdir(parents=True)
            for name in ("Dockerfile", "Dockerfile.dev", "entrypoint.py", "windows_folder_probe.py",
                         "runtime_service.py", "frontend_dev.py", "healthcheck.py"):
                (helpers / name).write_text(name)
            scripts = root / "capsule/tree/scripts"
            scripts.mkdir(parents=True)
            (scripts / "docker_startup_script.py").write_text("pinned startup helper")
            (scripts / "fullmag_storage.py").write_text("pinned storage helper")
            (root / "capsule/tree/application-secret-sentinel").write_text("source")
            package = root / "package"
            (package / "bin").mkdir(parents=True)
            (package / "bin/fullmag-bin").write_bytes(b"immutable compiled backend")
            stage = root / "development-context"
            stage.mkdir()
            hashes = runtime.stage_image_context(root / "capsule", package, stage, development=True)
            self.assertFalse((stage / "source").exists())
            self.assertFalse((stage / "package").exists())
            self.assertEqual((stage / "Dockerfile").read_text(), "Dockerfile.dev")
            self.assertEqual((stage / "docker_startup_script.py").read_text(), "pinned startup helper")
            self.assertEqual((stage / "fullmag_storage.py").read_text(), "pinned storage helper")
            self.assertEqual(hashes["fullmag-bin"], __import__("hashlib").sha256(b"immutable compiled backend").hexdigest())
            release = root / "release-context"
            release.mkdir()
            runtime.stage_image_context(root / "capsule", package, release, development=False)
            self.assertEqual((release / "source/application-secret-sentinel").read_text(), "source")
            self.assertEqual((release / "package/bin/fullmag-bin").read_bytes(), b"immutable compiled backend")

    def test_source_selection_accepts_main_or_registered_worktree_and_rejects_foreign(self):
        from docker_development_inputs import select_checkout
        with tempfile.TemporaryDirectory() as directory:
            main, task, foreign = [Path(directory) / name for name in ("main", "task", "foreign")]
            for path in (main, task, foreign):
                path.mkdir()
            records = [{"worktree": str(main)}, {"worktree": str(task)}]
            with patch("docker_development_inputs.main_checkout", return_value=main), \
                    patch.object(runtime.storage, "worktree_records", return_value=records), \
                    patch("docker_development_inputs.local_volume"), \
                    patch.dict(os.environ, {"FULLMAG_SOURCE_ROOT": ""}):
                self.assertEqual(select_checkout(task), main.resolve())
                self.assertEqual(select_checkout(main, task), task.resolve())
                with self.assertRaisesRegex(ValueError, "registered checkout"):
                    select_checkout(main, foreign)

    def test_package_requires_every_runtime_service_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            artifacts = [*("bin/" + name for name in runtime.REQUIRED_BINARIES),
                         "web/index.html", "_fullmag_core.so"]
            for relative in artifacts:
                path = package / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            runtime.validate_runtime_artifacts(package)
            for name in runtime.REQUIRED_BINARIES:
                path = package / "bin" / name
                path.unlink()
                with self.assertRaisesRegex(ValueError, "Missing runtime artifact"):
                    runtime.validate_runtime_artifacts(package)
                path.touch()

    def load_service(self):
        import sys
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py"
        spec = importlib.util.spec_from_file_location("all_docker_service_test", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def test_process_environment_pins_optional_package_root_without_rewriting_source_root(self):
        service = self.load_service()
        paths = service.RuntimePaths()
        with patch.dict(
            os.environ,
            {
                "FULLMAG_RUNTIME_PACKAGE_ROOT": "/foreign/package",
                "FULLMAG_RUNTIME_ROOT": "/foreign/legacy-package",
                "FULLMAG_REPO_ROOT": "/foreign/source",
            },
            clear=True,
        ):
            environment = service.process_environment(paths)
        self.assertEqual(environment["FULLMAG_RUNTIME_PACKAGE_ROOT"], str(paths.package))
        self.assertEqual(environment["FULLMAG_RUNTIME_ROOT"], str(paths.package))
        self.assertEqual(environment["FULLMAG_REPO_ROOT"], str(paths.source))

        with patch.dict(
            os.environ,
            {
                "FULLMAG_RUNTIME_ROOT": "/foreign/legacy-package",
                "FULLMAG_REPO_ROOT": "/foreign/source",
            },
            clear=True,
        ):
            legacy_environment = service.process_environment(paths)
        self.assertNotIn("FULLMAG_RUNTIME_PACKAGE_ROOT", legacy_environment)
        self.assertEqual(legacy_environment["FULLMAG_RUNTIME_ROOT"], str(paths.package))
        self.assertEqual(legacy_environment["FULLMAG_REPO_ROOT"], str(paths.source))

    def test_prepare_storage_creates_current_live_workspace(self):
        from dataclasses import replace

        service = self.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = replace(
                service.RuntimePaths(),
                state=root,
                storage=root,
                runs=root / "runs" / service.WORKTREE_ID,
                store=root / "runs" / service.WORKTREE_ID / "session-store",
                state_root=root / ".fullmag",
                config=root / "runtime.json",
            )
            with patch.dict(
                os.environ,
                {"FULLMAG_SESSION_STORAGE_PROFILE": service.WINDOWS_STORAGE_PROFILE},
                clear=True,
            ):
                self.assertEqual(service.prepare_storage(paths), paths)
            self.assertTrue(
                (paths.state_root / "local-live" / "current").is_dir()
            )

    def load_entrypoint(self):
        import sys
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/entrypoint.py"
        spec = importlib.util.spec_from_file_location("all_docker_entrypoint_test", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module

    def test_entrypoint_persists_owner_before_startup_activation_failure(self):
        import copy
        from types import SimpleNamespace

        service_module = self.load_service()
        entrypoint = self.load_entrypoint()
        owner = {"owner_token": "known", "state": "ready"}
        terminal = {"owner_token": "known", "state": "drained"}
        handle = service_module.RuntimeHandle(
            service_module.RuntimePaths(), {}, owner, 8081
        )
        paths = SimpleNamespace(
            state_root=Path("/state/.fullmag"), store=Path("/state/runs/docker-all/session-store")
        )
        receipts = []
        api = SimpleNamespace(
            pid=123,
            poll=lambda: None,
            terminate=lambda: None,
            wait=lambda timeout: 0,
        )
        service = SimpleNamespace(
            RuntimeHandle=service_module.RuntimeHandle,
            prepare_storage=lambda: paths,
            initialize_accepted_store=lambda _paths: {"binding": "test"},
            recover_idle_failure=lambda _paths: None,
            ensure_configuration=lambda _paths: {},
            process_environment=lambda _paths: {},
            start=lambda _paths, **_kwargs: handle,
            stop=lambda _handle, timeout: terminal,
            _atomic_json=lambda _path, value, _label: receipts.append(copy.deepcopy(value)),
        )

        def fail_activation():
            self.assertEqual(receipts[-1]["service_owner"], owner)
            raise RuntimeError("startup activation failed")

        event = SimpleNamespace(wait=lambda _seconds: True)
        with patch.dict(sys.modules, {"runtime_service": service}), \
                patch.object(entrypoint.threading, "Event", return_value=event), \
                patch.object(entrypoint.signal, "signal"), \
                patch.object(entrypoint.subprocess, "Popen", return_value=api), \
                patch.object(entrypoint, "activate_startup_script", side_effect=fail_activation):
            self.assertEqual(entrypoint.serve(), 1)

        self.assertGreaterEqual(len(receipts), 4)
        self.assertEqual(receipts[1]["service_owner"], owner)
        self.assertEqual(receipts[-1]["state"], "drained")
        self.assertEqual(receipts[-1]["service_owner"], owner)
        self.assertEqual(receipts[-1]["terminal_service_owner"], terminal)
        self.assertEqual(receipts[-1]["error"], "startup activation failed")

    def test_startup_activation_unknown_keeps_runtime_supervised_without_retry(self):
        import copy
        from types import SimpleNamespace
        from unittest import mock

        service_module = self.load_service()
        entrypoint = self.load_entrypoint()
        owner = {"owner_token": "known", "state": "ready"}
        terminal = {"owner_token": "known", "state": "drained"}
        handle = service_module.RuntimeHandle(
            service_module.RuntimePaths(), {}, owner, 8081
        )
        diagnostic = {
            "schema": entrypoint.STARTUP_ACTIVATION_DIAGNOSTIC_SCHEMA,
            "state": "unknown",
            "request_id": "startup-runtime-test",
            "source_sha256": "a" * 64,
            "source_relative": "models/scene.py",
            "durable_state": "started",
            "error": "startup activation returned HTTP 409: session store writer is busy",
        }
        paths = SimpleNamespace(
            state_root=Path("/state/.fullmag"),
            store=Path("/state/runs/docker-all/session-store"),
        )
        receipts = []
        api = mock.Mock(pid=123)
        api.poll.return_value = None
        api.wait.return_value = 0
        service = SimpleNamespace(
            RuntimeHandle=service_module.RuntimeHandle,
            RuntimeServiceTransient=service_module.RuntimeServiceTransient,
            prepare_storage=mock.Mock(return_value=paths),
            initialize_accepted_store=mock.Mock(return_value={"binding": "test"}),
            recover_idle_failure=mock.Mock(return_value=None),
            ensure_configuration=mock.Mock(return_value={}),
            process_environment=mock.Mock(return_value={}),
            start=mock.Mock(return_value=handle),
            check=mock.Mock(return_value=None),
            stop=mock.Mock(return_value=terminal),
            _atomic_json=lambda _path, value, _label: receipts.append(copy.deepcopy(value)),
        )
        event = mock.Mock()
        event.wait.side_effect = [False, True]
        unknown = entrypoint.StartupActivationOutcome(diagnostic)
        activation = mock.Mock(side_effect=unknown)
        with patch.dict(sys.modules, {"runtime_service": service}), \
                patch.object(entrypoint.threading, "Event", return_value=event), \
                patch.object(entrypoint.signal, "signal"), \
                patch.object(entrypoint.subprocess, "Popen", return_value=api), \
                patch.object(entrypoint, "activate_startup_script", activation):
            self.assertEqual(entrypoint.serve(), 0)

        activation.assert_called_once_with()
        service.check.assert_called_once_with(handle, full_api_probe=False)
        service.stop.assert_called_once_with(handle, timeout=30)
        api.terminate.assert_called_once_with()
        ready = next(receipt for receipt in receipts if receipt.get("state") == "ready")
        self.assertEqual(ready["startup_activation"], diagnostic)
        self.assertEqual(receipts[-1]["state"], "drained")
        self.assertEqual(receipts[-1]["startup_activation"], diagnostic)
        self.assertEqual(receipts[-1]["terminal_service_owner"], terminal)

    def test_service_budget_is_cpu_only_and_fits_container(self):
        service = self.load_service()
        config = service.build_configuration(service.RuntimePaths(), {})
        self.assertEqual(config["schema_version"], "runtime_service_config.v1")
        self.assertIsNone(config["host_execution"])
        compute = config["compute_resources"][0]
        self.assertEqual(compute["kind"], "cpu")
        prep = config["preparation_resources"][0]
        self.assertEqual(compute["budget"]["gpu_memory_bytes"], 0)
        self.assertLessEqual(compute["budget"]["cpu_millis"] + prep["budget"]["cpu_millis"], 4000)
        for env in ({"FULLMAG_RUNTIME_COMPUTE_CPU_MILLIS": "4001"},
                    {"FULLMAG_RUNTIME_COMPUTE_MEMORY_BYTES": str(8 * 1024**3)},
                    {"FULLMAG_RUNTIME_PREPARATION_CPU_MILLIS": "0"}):
            with self.assertRaises(service.RuntimeServiceError):
                service.build_configuration(service.RuntimePaths(), env)

    def host_profile_fixture(self, service):
        import copy
        config = service.build_configuration(service.RuntimePaths(), {})
        config["schema_version"] = "runtime_service_config.v2"
        cpu = config["compute_resources"][0]
        gpu = copy.deepcopy(cpu)
        gpu.update(resource_id="docker-all.compute.gpu", kind="gpu")
        gpu["budget"]["gpu_memory_bytes"] = 2 * service.GIB
        config["compute_resources"].append(gpu)
        gpu_uuid = "GPU-01234567-89ab-cdef-0123-456789abcdef"
        config["host_execution"] = {
            "schema_version": "runtime_service_host_execution.v1",
            "ledger_root": "/host-ledger/ledger",
            "runtime_generation_sha256": "a" * 64,
            "compute_max_concurrency": 1,
            "preparation_max_concurrency": 1,
            "policy": {"schema_version": "host_resource_ledger_policy.v2",
                       "allowed_cpu_ids": [0, 1, 2, 3],
                       "gpu_vram_bytes_by_uuid": {gpu_uuid: 4 * service.GIB}},
            "compute_placements": {
                cpu["resource_id"]: {"cpu_ids": [0, 1, 2], "gpu_uuid": None},
                gpu["resource_id"]: {"cpu_ids": [0, 1, 2], "gpu_uuid": gpu_uuid},
            },
            "preparation_cpu_ids": {"docker-all.preparation.cpu": [3]},
        }
        return {
            "schema_version": service.HOST_PROFILE_SCHEMA,
            "configuration": config,
            "host_identity": {"allowed_cpu_ids": [0, 1, 2, 3], "gpu_uuids": [gpu_uuid]},
            "readiness": {"schema_version": service.HOST_READINESS_GPU_SCHEMA},
            "runtime_generation_sha256": "a" * 64,
        }

    def _write_authenticated_drain_fixture(self, service, paths, *, include_service_owner=True):
        import copy

        runtime_services = paths.store / "runtime-services"
        runtime_services.mkdir(parents=True)
        (paths.state_root / "runtime-service").mkdir(parents=True)
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "owner_token": "11111111-1111-4111-8111-111111111111",
            "process_start_token": "22222222-2222-4222-8222-222222222222",
            "pid": 1234,
            "host": "fullmag-test-host",
            "target_id": service.TARGET_ID,
            "protocol": "stdin-v1",
            "state": "ready",
            "acquired_at": "2026-10-17T10:00:00Z",
            "heartbeat_at": "2026-10-17T10:00:01Z",
            "compute_pool_generation": 7,
            "preparation_pool_generation": 8,
            "control_address": "127.0.0.1:43123",
            "build_commit": "a" * 40,
            "build_snapshot": "b" * 64,
            "compute_pool_id": service.COMPUTE_POOL_ID,
            "preparation_pool_id": service.PREPARATION_POOL_ID,
            "children": [
                {"role": "compute", "pid": 17, "status": "running"},
                {"role": "preparation", "pid": 18, "status": "running"},
            ],
        }
        terminal = copy.deepcopy(owner)
        terminal["state"] = "drained"
        terminal["children"] = [
            {**child, "status": "exited_success"} for child in owner["children"]
        ]
        receipt = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "drained",
            "terminal_service_owner": terminal,
        }
        if include_service_owner:
            receipt["service_owner"] = owner
        service._atomic_json(
            paths.state_root / "runtime-service/process-tree.json",
            receipt,
            "test process tree receipt",
        )
        service._atomic_json(
            runtime_services / "OWNER.json", terminal, "test terminal owner"
        )
        service._atomic_json(
            runtime_services / f"docker-client-{owner['owner_token']}.json",
            owner,
            "test owner pin",
        )
        lock_path = runtime_services / "OWNER.lock"
        lock_path.write_bytes(b"runtime-service-owner-lock\n")
        return owner, terminal, lock_path

    def _initialize_host_fixture(self, service, stored_host_id, ledger_document=None):
        from dataclasses import replace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            ledger = root / "ledger"
            ledger.mkdir()
            if stored_host_id is not None or ledger_document is not None:
                (ledger / service.HOST_RESOURCE_LEDGER_FILE).write_text(
                    json.dumps(ledger_document or {
                        "schema_version": "host_resource_ledger.v4",
                        "policy": {"host_id": stored_host_id},
                    }),
                    encoding="utf-8",
                )
            package = root / "package"
            executable = package / "bin" / "fullmag-runtime-service"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"runtime-service")
            executable.chmod(0o755)
            paths = replace(
                service.RuntimePaths(),
                state=root,
                storage=root,
                runs=root / "runs",
                store=root / "runs" / "session-store",
                state_root=root / ".fullmag",
                package=package,
                config=root / "runtime.json",
            )
            daemon_host_id = "a" * 64
            environment = {
                "FULLMAG_DOCKER_HOST_EXECUTION": "1",
                "FULLMAG_HOST_LEDGER_PROFILE": service.HOST_LEDGER_PROFILE,
                "FULLMAG_DOCKER_HOST_ID": daemon_host_id,
            }
            completed = subprocess.CompletedProcess(
                [str(executable)], 0, stdout=b"{}", stderr=b""
            )
            with patch.object(service, "HOST_LEDGER_ROOT", ledger), \
                    patch.dict(os.environ, environment, clear=True), \
                    patch.object(service.subprocess, "run", return_value=completed) as run, \
                    patch.object(service, "_validate_host_profile", return_value={"ok": True}):
                service.initialize_host_configuration(paths)
                return run, daemon_host_id

    def test_initializer_preserves_legacy_policy_id_and_daemon_attestation(self):
        service = self.load_service()
        daemon_host_id = "a" * 64
        for stored_host_id, expected_host_id in (
            (service.LEGACY_DOCKER_HOST_ID, service.LEGACY_DOCKER_HOST_ID),
            (daemon_host_id, daemon_host_id),
            (None, daemon_host_id),
        ):
            with self.subTest(stored_host_id=stored_host_id):
                run, observed_daemon_host_id = self._initialize_host_fixture(
                    service, stored_host_id
                )
                command = run.call_args.args[0]
                self.assertEqual(command[-2:], ["--host-id", expected_host_id])
                self.assertEqual(
                    run.call_args.kwargs["env"]["FULLMAG_DOCKER_HOST_ID"],
                    observed_daemon_host_id,
                )

    def test_initializer_accepts_native_ledger_size_above_python_json_default(self):
        service = self.load_service()
        gpu_capacity = {
            f"GPU-00000000-0000-4000-8000-{index:012x}": 2**63
            for index in range(1, 4097)
        }
        document = {
            "schema_version": "host_resource_ledger.v2",
            "policy": {
                "schema_version": "host_resource_ledger_policy.v2",
                "host_id": service.LEGACY_DOCKER_HOST_ID,
                "topology_sha256": "a" * 64,
                "revision": 1,
                "owner_epoch": 1,
                "total_budget": {
                    "cpu_millis": 1000,
                    "memory_bytes": 1,
                    "gpu_memory_bytes": 0,
                    "storage_bytes": 1,
                },
                "gpu_vram_bytes_by_uuid": gpu_capacity,
                "allowed_cpu_ids": [0],
            },
            "reservations": [],
        }
        encoded = json.dumps(document).encode("utf-8")
        self.assertGreater(len(encoded), 256 * 1024)
        self.assertLessEqual(len(encoded), service.MAX_HOST_LEDGER_BYTES)
        run, _ = self._initialize_host_fixture(
            service, service.LEGACY_DOCKER_HOST_ID, ledger_document=document
        )
        self.assertEqual(run.call_args.args[0][-2:], ["--host-id", service.LEGACY_DOCKER_HOST_ID])

    def test_initializer_rejects_oversized_ledger_before_native_factory(self):
        from dataclasses import replace
        service = self.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            ledger = root / "ledger"
            ledger.mkdir()
            oversized = ledger / service.HOST_RESOURCE_LEDGER_FILE
            oversized.write_bytes(
                b'{"policy":{"host_id":"docker-all-host"},"padding":"'
                + b"x" * service.MAX_HOST_LEDGER_BYTES
                + b'"}'
            )
            package = root / "package"
            executable = package / "bin" / "fullmag-runtime-service"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"runtime-service")
            executable.chmod(0o755)
            paths = replace(service.RuntimePaths(), state=root, storage=root,
                            package=package, config=root / "runtime.json")
            with patch.object(service, "HOST_LEDGER_ROOT", ledger), \
                    patch.dict(os.environ, {
                        "FULLMAG_DOCKER_HOST_ID": "a" * 64,
                        "FULLMAG_HOST_LEDGER_PROFILE": service.HOST_LEDGER_PROFILE,
                    }, clear=True), \
                    patch.object(service.subprocess, "run") as run:
                with self.assertRaisesRegex(service.RuntimeServiceError, "bounded regular file"):
                    service.initialize_host_configuration(paths)
            run.assert_not_called()

    def test_initializer_rejects_unexpected_policy_id_before_native_factory(self):
        service = self.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            ledger = root / "ledger"
            ledger.mkdir()
            (ledger / service.HOST_RESOURCE_LEDGER_FILE).write_text(
                json.dumps({"schema_version": "host_resource_ledger.v4",
                            "policy": {"host_id": "foreign-host"}}),
                encoding="utf-8",
            )
            package = root / "package"
            executable = package / "bin" / "fullmag-runtime-service"
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"runtime-service")
            executable.chmod(0o755)
            from dataclasses import replace
            paths = replace(service.RuntimePaths(), state=root, storage=root,
                            package=package, config=root / "runtime.json")
            with patch.object(service, "HOST_LEDGER_ROOT", ledger), \
                    patch.dict(os.environ, {
                        "FULLMAG_DOCKER_HOST_ID": "a" * 64,
                        "FULLMAG_HOST_LEDGER_PROFILE": service.HOST_LEDGER_PROFILE,
                    }, clear=True), \
                    patch.object(service.subprocess, "run") as run:
                with self.assertRaisesRegex(service.RuntimeServiceError, "differs"):
                    service.initialize_host_configuration(paths)
            run.assert_not_called()

    def test_initializer_requires_canonical_host_ledger_profile(self):
        service = self.load_service()
        with patch.dict(os.environ, {
            "FULLMAG_DOCKER_HOST_ID": "a" * 64,
            "FULLMAG_HOST_LEDGER_PROFILE": "other-profile",
        }, clear=True):
            with self.assertRaisesRegex(service.RuntimeServiceError, "canonical host-ledger-v1"):
                service._validated_docker_host_id()

    def test_native_host_profile_rejects_wrong_store_device_policy_and_overcommit(self):
        import copy
        service = self.load_service()
        value = self.host_profile_fixture(service)
        self.assertEqual(service._validate_host_profile(value, service.RuntimePaths()),
                         value["configuration"])
        mutations = [
            lambda c: c.update(store_root="/tmp/session-store"),
            lambda c: c.update(schema_version="runtime_service_config.v1"),
            lambda c: c["host_execution"].update(ledger_root="/state/shared-ledger"),
            lambda c: c["host_execution"].update(compute_max_concurrency=2),
            lambda c: c["host_execution"]["policy"].update(schema_version="host_resource_ledger_policy.v1"),
            lambda c: c["compute_resources"][1]["budget"].update(gpu_memory_bytes=0),
            lambda c: c["compute_resources"][0]["budget"].update(gpu_memory_bytes=1),
            lambda c: c["compute_resources"][1]["budget"].update(cpu_millis=4000),
            lambda c: c["compute_resources"][1]["budget"].update(memory_bytes=8 * service.GIB),
            lambda c: c["host_execution"]["compute_placements"]["docker-all.compute.gpu"].update(gpu_uuid="GPU-other"),
        ]
        for mutate in mutations:
            changed = copy.deepcopy(value)
            mutate(changed["configuration"])
            with self.subTest(profile=changed), self.assertRaises(service.RuntimeServiceError):
                service._validate_host_profile(changed, service.RuntimePaths())

    def test_native_host_profile_requires_matching_runtime_generation(self):
        import copy
        service = self.load_service()
        value = self.host_profile_fixture(service)
        for generation in (None, "", "a" * 63, "A" * 64, "b" * 64):
            changed = copy.deepcopy(value)
            changed["configuration"]["host_execution"]["runtime_generation_sha256"] = generation
            with self.subTest(generation=generation), self.assertRaisesRegex(
                    service.RuntimeServiceError, "runtime generation"):
                service._validate_host_profile(changed, service.RuntimePaths())
        for generation in (None, "", "a" * 63, "A" * 64, "b" * 64):
            changed = copy.deepcopy(value)
            changed["runtime_generation_sha256"] = generation
            with self.subTest(profile_generation=generation), self.assertRaisesRegex(
                    service.RuntimeServiceError, "runtime generation"):
                service._validate_host_profile(changed, service.RuntimePaths())

    @unittest.skipIf(os.name == "nt", "Guest publication fsync is qualified on Linux")
    def test_authorized_recreate_rotates_only_generation_and_retains_exact_config(self):
        import copy
        import hashlib
        from dataclasses import replace
        service = self.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = replace(service.RuntimePaths(), config=root / "runtime.json")
            old = self.host_profile_fixture(service)["configuration"]
            expected = copy.deepcopy(old)
            expected["host_execution"]["runtime_generation_sha256"] = "b" * 64
            service._atomic_json(paths.config, old, "test config")
            original = paths.config.read_bytes()
            old_sha = hashlib.sha256(original).hexdigest()
            sentinel = root / "saved-session.json"
            sentinel.write_bytes(b"user session remains intact")
            environment = {"FULLMAG_DOCKER_HOST_EXECUTION": "1",
                           "FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256": old_sha}
            with patch.dict(os.environ, environment, clear=True), patch.object(
                    service, "initialize_host_configuration", return_value=expected):
                self.assertEqual(service.ensure_configuration(paths), expected)
                self.assertEqual(service.ensure_configuration(paths), expected)
            self.assertEqual(json.loads(paths.config.read_bytes()), expected)
            self.assertEqual((root / f"docker-all.previous-{old_sha}.json").read_bytes(), original)
            self.assertEqual(sentinel.read_bytes(), b"user session remains intact")

    @unittest.skipIf(os.name == "nt", "Guest owner lock is qualified on Linux")
    def test_stale_recreate_pin_requires_authenticated_drain(self):
        import copy
        import hashlib
        from dataclasses import replace

        service = self.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = replace(
                service.RuntimePaths(),
                state=root,
                storage=root,
                runs=root / "runs" / service.WORKTREE_ID,
                store=root / "runs" / service.WORKTREE_ID / "session-store",
                state_root=root / ".fullmag",
                config=root / "runtime.json",
            )
            old = self.host_profile_fixture(service)["configuration"]
            expected = copy.deepcopy(old)
            expected["host_execution"]["runtime_generation_sha256"] = "b" * 64
            service._atomic_json(paths.config, old, "test config")
            original = paths.config.read_bytes()
            current_sha = hashlib.sha256(original).hexdigest()
            stale_sha = "f" * 64
            self.assertNotEqual(stale_sha, current_sha)
            self._write_authenticated_drain_fixture(
                service, paths, include_service_owner=False
            )
            environment = {
                "FULLMAG_DOCKER_HOST_EXECUTION": "1",
                "FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256": stale_sha,
            }
            with patch.dict(os.environ, environment, clear=True), patch.object(
                    service, "initialize_host_configuration", return_value=expected):
                self.assertEqual(service.ensure_configuration(paths), expected)
            self.assertEqual(json.loads(paths.config.read_bytes()), expected)
            self.assertEqual(
                (root / f"docker-all.previous-{current_sha}.json").read_bytes(),
                original,
            )
            self.assertFalse((root / f"docker-all.previous-{stale_sha}.json").exists())

    @unittest.skipIf(os.name == "nt", "Guest owner lock is qualified on Linux")
    def test_stale_recreate_pin_rejects_failed_or_unknown_owner(self):
        import copy
        from dataclasses import replace

        service = self.load_service()
        for owner_state in ("failed", "unknown"):
            with self.subTest(owner_state=owner_state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                paths = replace(
                    service.RuntimePaths(),
                    state=root,
                    storage=root,
                    runs=root / "runs" / service.WORKTREE_ID,
                    store=root / "runs" / service.WORKTREE_ID / "session-store",
                    state_root=root / ".fullmag",
                    config=root / "runtime.json",
                )
                old = self.host_profile_fixture(service)["configuration"]
                expected = copy.deepcopy(old)
                expected["host_execution"]["runtime_generation_sha256"] = "b" * 64
                service._atomic_json(paths.config, old, "test config")
                original = paths.config.read_bytes()
                self._write_authenticated_drain_fixture(
                    service, paths, include_service_owner=False
                )
                terminal_path = paths.store / "runtime-services/OWNER.json"
                terminal = json.loads(terminal_path.read_text(encoding="utf-8"))
                terminal["state"] = owner_state
                service._atomic_json(terminal_path, terminal, "test invalid terminal owner")
                environment = {
                    "FULLMAG_DOCKER_HOST_EXECUTION": "1",
                    "FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256": "f" * 64,
                }
                with patch.dict(os.environ, environment, clear=True), patch.object(
                        service, "initialize_host_configuration", return_value=expected):
                    with self.assertRaises(service.RuntimeServiceError):
                        service.ensure_configuration(paths)
                self.assertEqual(paths.config.read_bytes(), original)

    @unittest.skipIf(os.name == "nt", "Guest owner lock is qualified on Linux")
    def test_ordinary_host_restart_rotates_generation_after_authenticated_drain(self):
        import copy
        import hashlib
        from dataclasses import replace

        service = self.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = replace(
                service.RuntimePaths(),
                state=root,
                storage=root,
                runs=root / "runs" / service.WORKTREE_ID,
                store=root / "runs" / service.WORKTREE_ID / "session-store",
                state_root=root / ".fullmag",
                config=root / "runtime.json",
            )
            old = self.host_profile_fixture(service)["configuration"]
            expected = copy.deepcopy(old)
            expected["host_execution"]["runtime_generation_sha256"] = "b" * 64
            service._atomic_json(paths.config, old, "test config")
            original = paths.config.read_bytes()
            old_sha = hashlib.sha256(original).hexdigest()
            self._write_authenticated_drain_fixture(
                service, paths, include_service_owner=False
            )
            environment = {"FULLMAG_DOCKER_HOST_EXECUTION": "1"}
            with patch.dict(os.environ, environment, clear=True), patch.object(
                    service, "initialize_host_configuration", return_value=expected):
                self.assertEqual(service.ensure_configuration(paths), expected)
                self.assertEqual(service.ensure_configuration(paths), expected)
            self.assertEqual(json.loads(paths.config.read_bytes()), expected)
            self.assertEqual(
                (root / f"docker-all.previous-{old_sha}.json").read_bytes(), original
            )

    @unittest.skipIf(os.name == "nt", "Guest owner lock is qualified on Linux")
    def test_ordinary_host_restart_rejects_active_or_unknown_previous_owner(self):
        import copy
        from dataclasses import replace

        service = self.load_service()
        for scenario in ("active", "unknown"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                paths = replace(
                    service.RuntimePaths(),
                    state=root,
                    storage=root,
                    runs=root / "runs" / service.WORKTREE_ID,
                    store=root / "runs" / service.WORKTREE_ID / "session-store",
                    state_root=root / ".fullmag",
                    config=root / "runtime.json",
                )
                old = self.host_profile_fixture(service)["configuration"]
                expected = copy.deepcopy(old)
                expected["host_execution"]["runtime_generation_sha256"] = "b" * 64
                service._atomic_json(paths.config, old, "test config")
                original = paths.config.read_bytes()
                _, terminal, lock_path = self._write_authenticated_drain_fixture(
                    service, paths
                )
                if scenario == "unknown":
                    terminal["state"] = "unknown"
                    service._atomic_json(
                        paths.store / "runtime-services/OWNER.json",
                        terminal,
                        "test unknown owner",
                    )
                environment = {"FULLMAG_DOCKER_HOST_EXECUTION": "1"}
                holder = None
                try:
                    if scenario == "active":
                        holder = subprocess.Popen(
                            [
                                sys.executable,
                                "-c",
                                (
                                    "import fcntl, sys; "
                                    "stream = open(sys.argv[1], 'r+b'); "
                                    "fcntl.flock(stream.fileno(), fcntl.LOCK_EX); "
                                    "print('locked', flush=True); sys.stdin.read()"
                                ),
                                str(lock_path),
                            ],
                            stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            text=True,
                        )
                        self.assertEqual(holder.stdout.readline().strip(), "locked")
                    with patch.dict(os.environ, environment, clear=True), patch.object(
                            service, "initialize_host_configuration", return_value=expected):
                        with self.assertRaisesRegex(
                                service.RuntimeServiceError,
                                "still active" if scenario == "active" else "not drained"):
                            service.ensure_configuration(paths)
                finally:
                    if holder is not None:
                        holder.stdin.close()
                        try:
                            holder.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            holder.terminate()
                            holder.wait(timeout=3)
                        holder.stdout.close()
                self.assertEqual(paths.config.read_bytes(), original)

    @unittest.skipIf(os.name == "nt", "Guest publication fsync is qualified on Linux")
    def test_recreate_rejects_missing_wrong_hash_or_operator_profile_changes(self):
        import copy
        import hashlib
        from dataclasses import replace
        service = self.load_service()
        for scenario in ("no_authorization", "wrong_hash", "profile_change", "corrupt_backup"):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                paths = replace(service.RuntimePaths(), config=root / "runtime.json")
                old = self.host_profile_fixture(service)["configuration"]
                expected = copy.deepcopy(old)
                expected["host_execution"]["runtime_generation_sha256"] = "b" * 64
                service._atomic_json(paths.config, old, "test config")
                original = paths.config.read_bytes()
                old_sha = hashlib.sha256(original).hexdigest()
                environment = {"FULLMAG_DOCKER_HOST_EXECUTION": "1"}
                if scenario != "no_authorization":
                    environment["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = (
                        "f" * 64 if scenario == "wrong_hash" else old_sha
                    )
                if scenario == "profile_change":
                    expected["heartbeat_interval_milliseconds"] += 1
                if scenario == "corrupt_backup":
                    (root / f"docker-all.previous-{old_sha}.json").write_bytes(b"different history")
                with patch.dict(os.environ, environment, clear=True), patch.object(
                        service, "initialize_host_configuration", return_value=expected):
                    with self.assertRaises(service.RuntimeServiceError):
                        service.ensure_configuration(paths)
                self.assertEqual(paths.config.read_bytes(), original)

    @unittest.skipIf(os.name == "nt", "Guest publication fsync is qualified on Linux")
    def test_recreate_requires_existing_config_and_can_pin_legacy_generation(self):
        import copy
        import hashlib
        from dataclasses import replace
        service = self.load_service()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            paths = replace(service.RuntimePaths(), config=root / "runtime.json")
            expected = self.host_profile_fixture(service)["configuration"]
            environment = {"FULLMAG_DOCKER_HOST_EXECUTION": "1",
                           "FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256": "f" * 64}
            with patch.dict(os.environ, environment, clear=True), patch.object(
                    service, "initialize_host_configuration", return_value=expected):
                with self.assertRaisesRegex(service.RuntimeServiceError, "configuration is missing"):
                    service.ensure_configuration(paths)
            self.assertFalse(paths.config.exists())
            legacy = copy.deepcopy(expected)
            legacy["host_execution"].pop("runtime_generation_sha256")
            service._atomic_json(paths.config, legacy, "legacy config")
            original = paths.config.read_bytes()
            environment["FULLMAG_DOCKER_PREVIOUS_CONFIG_SHA256"] = hashlib.sha256(original).hexdigest()
            with patch.dict(os.environ, environment, clear=True), patch.object(
                    service, "initialize_host_configuration", return_value=expected):
                self.assertEqual(service.ensure_configuration(paths), expected)

    def test_requested_host_mode_never_falls_back_to_cpu_profile(self):
        service = self.load_service()
        with patch.dict(os.environ, {"FULLMAG_DOCKER_HOST_EXECUTION": "1"}), \
                patch.object(service, "initialize_host_configuration",
                             side_effect=service.RuntimeServiceError("GPU unavailable")), \
                patch.object(service, "build_configuration") as legacy:
            with self.assertRaisesRegex(service.RuntimeServiceError, "GPU unavailable"):
                service.ensure_configuration(service.RuntimePaths())
            legacy.assert_not_called()

    def test_windows_folder_cli_timeout_budgets_cover_bootstrap_and_status(self):
        service = self.load_service()
        paths = service.RuntimePaths()
        bootstrap = {
            "schema": "fullmag.docker-accepted-store-bootstrap.v1",
            "store_root": str(paths.store),
            "binding": "a" * 64,
        }
        with patch.object(service, "prepare_storage"), \
                patch.object(service, "_run_cli", return_value=bootstrap) as cli:
            service.initialize_accepted_store(paths)
            self.assertEqual(
                cli.call_args.kwargs["timeout"],
                service.STORE_BOOTSTRAP_CLI_TIMEOUT_SECONDS,
            )

            status_result = {
                "schema_version": "runtime_service_discovery.v1",
                "status": "ready",
                "owner": {"owner_token": "known", "children": []},
            }
            cli.reset_mock(return_value=True, side_effect=True)
            cli.return_value = status_result
            service._service_status(paths)
            self.assertEqual(
                cli.call_args.kwargs["timeout"],
                service.SERVICE_STATUS_CLI_TIMEOUT_SECONDS,
            )

    def test_service_shutdown_rejects_changed_owner_without_drain(self):
        service = self.load_service()
        owner = {"owner_token": "old", "children": [{"role": "compute", "pid": 3},
                                                      {"role": "preparation", "pid": 4}]}
        changed = {**owner, "owner_token": "new"}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081)
        with patch.object(service, "_wait_api_closed"), \
                patch.object(service, "_read_ready_owner", return_value=changed), \
                patch.object(service, "_run_cli") as cli:
            with self.assertRaises(service.RuntimeServiceUnknown):
                service.stop(handle)
            cli.assert_not_called()

    def test_service_stop_delegates_terminal_proof_to_canonical_rust(self):
        service = self.load_service()
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3},
                                                        {"role": "preparation", "pid": 4}]}
        terminal = {**owner, "children": [{**child, "status": "exited_success"} for child in owner["children"]]}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081)
        with patch.object(service, "_wait_api_closed"), \
                patch.object(service, "_read_ready_owner", return_value=owner), \
                patch.object(service, "_pin_owner", return_value=Path("/state/pinned-owner.json")), \
                patch.object(service, "_run_cli", return_value={"schema_version": "runtime_service_discovery.v1",
                             "status": "drained", "owner": terminal}) as cli:
            self.assertEqual(service.stop(handle), terminal)
            self.assertIn("service-drain-confirmed", cli.call_args.args[1])
            cli.side_effect = service.RuntimeServiceUnknown("unconfirmed outcome")
            with self.assertRaises(service.RuntimeServiceUnknown):
                service.stop(handle)
            self.assertEqual(cli.call_count, 2)

    def test_start_retains_confirmed_owner_when_later_observation_fails(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0",
                    "build_identity": {"git_commit": "commit"},
                    "runtime_store_binding": {"binding": "a" * 64}}
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3}]}
        for failure_at in ("_pin_owner", "_read_ready_owner"):
            with patch.object(service, "prepare_storage"), \
                    patch.object(service, "ensure_configuration", return_value={}), \
                    patch.object(service, "wait_for_api", return_value=identity), \
                    patch.object(service, "_run_cli", return_value={"schema_version": "runtime_service_discovery.v1",
                                 "status": "ready", "owner": owner}), \
                    patch.object(service, "_pin_owner") as pin, \
                    patch.object(service, "_read_ready_owner", return_value=owner) as read, \
                    patch.object(service, "_service_status") as status:
                (pin if failure_at == "_pin_owner" else read).side_effect = OSError(
                    "lost observation"
                )
                with self.assertRaises(Exception) as caught:
                    service.start(service.RuntimePaths(), expected_binding="a" * 64)
                self.assertEqual(caught.exception.pinned_handle.owner, owner)
                status.assert_not_called()

    def test_start_uses_published_owner_without_readonly_status_cli(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0",
                    "build_identity": {"git_commit": "commit"},
                    "runtime_store_binding": {"binding": "a" * 64}}
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3}]}
        with patch.object(service, "prepare_storage"), \
                patch.object(service, "ensure_configuration", return_value={}), \
                patch.object(service, "wait_for_api", return_value=identity), \
                patch.object(service, "_run_cli", return_value={"schema_version": "runtime_service_discovery.v1",
                             "status": "ready", "owner": owner}), \
                patch.object(service, "_pin_owner"), \
                patch.object(service, "_read_ready_owner", return_value=owner) as read, \
                patch.object(service, "_wait_for_api_liveness") as liveness, \
                patch.object(service, "_service_status") as status:
            handle = service.start(service.RuntimePaths(), expected_binding="a" * 64)
        self.assertEqual(handle.owner, owner)
        read.assert_called_once()
        liveness.assert_called_once()
        self.assertEqual(
            liveness.call_args.kwargs["timeout"],
            service.STARTUP_LIVENESS_GRACE_SECONDS,
        )
        status.assert_not_called()

    def test_start_rejects_owner_change_before_startup_liveness(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0",
                    "build_identity": {"git_commit": "commit"},
                    "runtime_store_binding": {"binding": "a" * 64}}
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3}]}
        changed = {**owner, "owner_token": "replaced"}
        with patch.object(service, "prepare_storage"), \
                patch.object(service, "ensure_configuration", return_value={}), \
                patch.object(service, "wait_for_api", return_value=identity), \
                patch.object(service, "_run_cli", return_value={"schema_version": "runtime_service_discovery.v1",
                             "status": "ready", "owner": owner}), \
                patch.object(service, "_pin_owner"), \
                patch.object(service, "_read_ready_owner", return_value=changed), \
                patch.object(service, "_wait_for_api_liveness") as liveness, \
                patch.object(service, "_service_status") as status:
            with self.assertRaisesRegex(service.RuntimeServiceUnknown, "owner changed"):
                service.start(service.RuntimePaths(), expected_binding="a" * 64)
        liveness.assert_not_called()
        status.assert_not_called()

    def test_startup_liveness_grace_accepts_starting_then_ready(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0"}
        headers = [("x-api-contract-version", "1.0.0"),
                   ("x-fullmag-api-instance", "instance")]
        starting = {
            "schema_version": "application_service_status.v1",
            "configured": True,
            "state": "starting",
            "reason": {"code": "owner_starting", "message": "startup is in progress"},
        }
        ready = {
            "schema_version": "application_service_status.v1",
            "configured": True,
            "state": "ready",
            "reason": {"code": "service_ready", "message": "ready"},
        }
        with patch.object(service, "_http_json",
                          side_effect=[(200, headers, starting), (200, headers, ready)]) as probe, \
                patch.object(service.time, "sleep") as sleep:
            service._wait_for_api_liveness(8081, identity, timeout=1.0)
        self.assertEqual(probe.call_count, 2)
        sleep.assert_called_once()

    def test_startup_liveness_retries_transient_only_with_pinned_owner(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0"}
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3}]}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        transient = service.RuntimeServiceNotReady(
            configured=True,
            state="observation_unknown",
            reason_code="live_probe_failed",
            reason_message="native control probe raced owner publication",
            retryable=False,
        )
        with patch.object(service, "_probe_api_liveness",
                          side_effect=[transient, None]) as probe, \
                patch.object(service, "_assert_pinned_ready_owner") as owner_proof, \
                patch.object(service, "_run_cli") as cli, \
                patch.object(service.time, "sleep") as sleep:
            service._wait_for_api_liveness(
                8081, identity, timeout=1.0, handle=handle
            )
        self.assertEqual(probe.call_count, 2)
        owner_proof.assert_called_once_with(handle)
        sleep.assert_called_once()
        cli.assert_not_called()

    def test_startup_liveness_retries_transport_only_with_pinned_owner(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0"}
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3}]}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        transport = service.RuntimeServiceTransportError("API probe timed out")
        with patch.object(service, "_probe_api_liveness",
                          side_effect=[transport, None]) as probe, \
                patch.object(service, "_assert_pinned_ready_owner") as owner_proof, \
                patch.object(service, "_run_cli") as cli, \
                patch.object(service.time, "sleep") as sleep:
            service._wait_for_api_liveness(
                8081, identity, timeout=service.STARTUP_LIVENESS_GRACE_SECONDS,
                handle=handle,
            )
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(
            probe.call_args_list[0].kwargs["timeout"],
            service.API_LIVENESS_TIMEOUT_SECONDS,
        )
        owner_proof.assert_called_once_with(handle)
        sleep.assert_called_once()
        cli.assert_not_called()

    def test_startup_transport_expiry_is_unknown_without_liveness_observation(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0"}
        owner = {"owner_token": "known", "children": [{"role": "compute", "pid": 3}]}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        clock = iter((0.0, 0.0, 2.0, 2.0))
        with patch.object(service, "_probe_api_liveness",
                          side_effect=service.RuntimeServiceTransportError("API probe timed out")) as probe, \
                patch.object(service, "_assert_pinned_ready_owner") as owner_proof, \
                patch.object(service.time, "monotonic", side_effect=clock), \
                patch.object(service.time, "sleep"):
            with self.assertRaisesRegex(service.RuntimeServiceUnknown, "timed out") as caught:
                service._wait_for_api_liveness(
                    8081, identity, timeout=1.0, handle=handle
                )
        probe.assert_called_once()
        owner_proof.assert_called_once_with(handle)
        self.assertFalse(hasattr(caught.exception, "liveness_observation"))

    def test_startup_liveness_grace_does_not_retry_identity_failure(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0"}
        headers = [("x-api-contract-version", "1.0.0"),
                   ("x-fullmag-api-instance", "other-instance")]
        response = {
            "schema_version": "application_service_status.v1",
            "configured": True,
            "state": "starting",
            "reason": {"code": "owner_starting", "message": "startup is in progress"},
        }
        with patch.object(service, "_http_json", return_value=(200, headers, response)) as probe, \
                patch.object(service.time, "sleep") as sleep:
            with self.assertRaisesRegex(service.RuntimeServiceError, "instance identity changed"):
                service._wait_for_api_liveness(8081, identity, timeout=1.0)
        probe.assert_called_once()
        sleep.assert_not_called()

    def test_liveness_failure_retains_reason_for_process_receipt(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0"}
        headers = [("x-api-contract-version", "1.0.0"),
                   ("x-fullmag-api-instance", "instance")]
        response = {
            "schema_version": "application_service_status.v1",
            "configured": True,
            "state": "observation_unknown",
            "reason": {"code": "live_probe_failed", "message": "control probe failed"},
        }
        with patch.object(service, "_http_json", return_value=(200, headers, response)):
            with self.assertRaises(service.RuntimeServiceNotReady) as caught:
                service._wait_for_api_liveness(8081, identity, timeout=1.0)
        self.assertEqual(caught.exception.liveness_observation, response)
        self.assertFalse(caught.exception.retryable)
        receipt = {}
        self.load_entrypoint()._retain_liveness_observation(receipt, caught.exception)
        self.assertEqual(receipt["api_liveness"], response)

    def test_supervision_classifies_only_live_probe_failure_as_transient(self):
        service = self.load_service()
        transient = service.RuntimeServiceNotReady(
            configured=True,
            state="observation_unknown",
            reason_code="live_probe_failed",
            reason_message="native probe was temporarily unavailable",
            retryable=False,
        )
        different_reason = service.RuntimeServiceNotReady(
            configured=True,
            state="observation_unknown",
            reason_code="live_identity_changed",
            reason_message="owner identity changed",
            retryable=False,
        )
        invalid_reason = service.RuntimeServiceNotReady(
            configured=True,
            state="observation_unknown",
            reason_code="owner_invalid",
            reason_message="owner metadata is invalid",
            retryable=False,
        )
        self.assertTrue(service._is_transient_supervision_observation(transient))
        self.assertFalse(service._is_transient_supervision_observation(different_reason))
        self.assertTrue(service._is_transient_supervision_observation(invalid_reason))
        self.assertFalse(
            service._is_transient_supervision_observation(
                service.RuntimeServiceNotReady(
                    configured=False,
                    state="observation_unknown",
                    reason_code="live_probe_failed",
                    reason_message="native service is not configured",
                    retryable=False,
                )
            )
        )
        self.assertFalse(
            service._is_transient_supervision_observation(
                service.RuntimeServiceError("API runtime-service liveness schema changed")
            )
        )

    def test_supervision_promotes_live_probe_failure_without_native_cli(self):
        service = self.load_service()
        identity = {
            "api_instance_id": "instance",
            "api_contract_version": "1.0.0",
            "runtime_store_binding": {"binding": "a" * 64},
        }
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "ready",
            "owner_token": "known",
            "children": [],
        }
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        for reason_code in ("live_probe_failed", "owner_read_failed", "owner_invalid"):
            failure = service.RuntimeServiceNotReady(
                configured=True,
                state="observation_unknown",
                reason_code=reason_code,
                reason_message="native service could not be verified",
                retryable=False,
            )
            with patch.object(service, "_probe_api_identity", return_value=(identity, {})), \
                    patch.object(service, "_probe_api_liveness", side_effect=failure), \
                    patch.object(service, "_read_json", return_value=owner) as read, \
                    patch.object(service, "_run_cli") as cli:
                with self.assertRaises(service.RuntimeServiceTransient):
                    service.check(handle, full_api_probe=True)
            self.assertGreaterEqual(read.call_count, 1)
            cli.assert_not_called()

    def test_supervision_transient_window_recovers_and_expires(self):
        service = self.load_service()
        entrypoint = self.load_entrypoint()
        handle = object()
        transient = service.RuntimeServiceTransient("live probe temporarily failed")
        transient.liveness_observation = {
            "schema_version": "application_service_status.v1",
            "configured": True,
            "state": "observation_unknown",
            "reason": {"code": "live_probe_failed", "message": "probe failed"},
        }
        with patch.object(service, "check", side_effect=[transient, None, transient, transient]), \
                patch.object(entrypoint, "print") as output:
            degraded = entrypoint._supervise_once(
                service, handle, full_api_probe=True, now=100.0, degraded_since=None
            )
            self.assertEqual(degraded, 100.0)
            self.assertIsNone(
                entrypoint._supervise_once(
                    service, handle, full_api_probe=False, now=110.0,
                    degraded_since=degraded
                )
            )
            degraded = entrypoint._supervise_once(
                service, handle, full_api_probe=True, now=200.0, degraded_since=None
            )
            with self.assertRaisesRegex(service.RuntimeServiceUnknown, "stayed degraded") as caught:
                entrypoint._supervise_once(
                    service, handle, full_api_probe=False,
                    now=200.0 + service.SUPERVISION_GRACE_SECONDS,
                    degraded_since=degraded,
                )
            self.assertEqual(
                caught.exception.liveness_observation,
                transient.liveness_observation,
            )
        self.assertEqual(output.call_count, 3)

    def test_supervision_identity_failure_remains_immediate(self):
        service = self.load_service()
        entrypoint = self.load_entrypoint()
        handle = object()
        failure = service.RuntimeServiceUnknown("API instance identity changed")
        with patch.object(service, "check", side_effect=failure), \
                patch.object(entrypoint, "print") as output:
            with self.assertRaises(service.RuntimeServiceUnknown) as caught:
                entrypoint._supervise_once(
                    service, handle, full_api_probe=False, now=100.0, degraded_since=None
                )
            self.assertIs(caught.exception, failure)
        output.assert_not_called()

    def test_supervision_rejects_api_binding_change(self):
        service = self.load_service()
        identity = {"api_instance_id": "instance", "api_contract_version": "1.0.0",
                    "build_identity": {"git_commit": "commit"},
                    "runtime_store_binding": {"binding": "a" * 64}}
        owner = {"owner_token": "known", "children": []}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        changed = {**identity, "runtime_store_binding": {"binding": "b" * 64}}
        with patch.object(service, "_probe_api_liveness") as liveness, \
                patch.object(service, "_probe_api_identity", return_value=(changed, {})), \
                patch.object(service, "_service_status", return_value=owner):
            with self.assertRaises(service.RuntimeServiceUnknown):
                service.check(handle)
        liveness.assert_not_called()

    def test_supervision_reads_ready_owner_without_restarting_native_cli(self):
        service = self.load_service()
        identity = {
            "api_instance_id": "instance",
            "api_contract_version": "1.0.0",
            "runtime_store_binding": {"binding": "a" * 64},
        }
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "ready",
            "owner_token": "known",
            "children": [
                {"role": "compute", "pid": 3, "status": "running"},
                {"role": "preparation", "pid": 4, "status": "running"},
            ],
        }
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        with patch.object(service, "_probe_api_liveness") as liveness, \
                patch.object(service, "_read_json", return_value=owner) as read, \
                patch.object(service, "_run_cli") as cli, \
                patch.object(service, "_service_status") as status:
            service.check(handle, full_api_probe=False)
        self.assertGreaterEqual(read.call_count, 1)
        self.assertTrue(str(read.call_args.args[0]).endswith("runtime-services/OWNER.json"))
        liveness.assert_called_once_with(
            8081,
            identity,
            timeout=service.API_LIVENESS_TIMEOUT_SECONDS,
        )
        cli.assert_not_called()
        status.assert_not_called()

    def test_supervision_rejects_changed_owner_without_native_cli(self):
        service = self.load_service()
        identity = {
            "api_instance_id": "instance",
            "api_contract_version": "1.0.0",
            "runtime_store_binding": {"binding": "a" * 64},
        }
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "ready",
            "owner_token": "known",
            "children": [
                {"role": "compute", "pid": 3, "status": "running"},
                {"role": "preparation", "pid": 4, "status": "running"},
            ],
        }
        changed = {**owner, "owner_token": "replaced"}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        with patch.object(service, "_probe_api_liveness"), \
                patch.object(service, "_read_json", return_value=changed), \
                patch.object(service, "_run_cli") as cli, \
                patch.object(service, "_service_status") as status:
            with self.assertRaisesRegex(service.RuntimeServiceUnknown, "owner changed"):
                service.check(handle, full_api_probe=False)
        cli.assert_not_called()
        status.assert_not_called()

    def test_supervision_rejects_malformed_owner_before_transient_grace(self):
        service = self.load_service()
        identity = {
            "api_instance_id": "instance",
            "api_contract_version": "1.0.0",
            "runtime_store_binding": {"binding": "a" * 64},
        }
        owner = {"owner_token": "known", "children": []}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        with patch.object(service, "_probe_api_liveness") as liveness, \
                patch.object(service, "_read_json", return_value={"state": "ready"}), \
                patch.object(service, "_run_cli") as cli:
            with self.assertRaisesRegex(service.RuntimeServiceUnknown, "schema"):
                service.check(handle, full_api_probe=False)
        liveness.assert_not_called()
        cli.assert_not_called()

    def test_owner_read_retries_atomic_publish_gap_then_requires_exact_pin(self):
        service = self.load_service()
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "ready",
            "owner_token": "known",
            "children": [],
        }
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081)
        with patch.object(
            service, "_read_json", side_effect=[FileNotFoundError("OWNER.json"), owner]
        ) as read, patch.object(service.time, "sleep") as sleep:
            self.assertEqual(service._assert_pinned_ready_owner(handle), owner)
        self.assertEqual(read.call_count, 2)
        sleep.assert_called_once_with(service.READY_OWNER_MISSING_POLL_SECONDS)

    def test_owner_replacement_after_atomic_publish_gap_remains_fatal(self):
        service = self.load_service()
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "ready",
            "owner_token": "known",
            "children": [],
        }
        replacement = {**owner, "owner_token": "replacement"}
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081)
        with patch.object(
            service,
            "_read_json",
            side_effect=[FileNotFoundError("OWNER.json"), replacement],
        ), patch.object(service.time, "sleep"):
            with self.assertRaisesRegex(service.RuntimeServiceUnknown, "owner changed"):
                service._assert_pinned_ready_owner(handle)

    def test_owner_read_persistent_missing_is_bounded(self):
        service = self.load_service()
        clock = iter((0.0, 0.1, 1.1))
        with patch.object(
            service, "_read_json", side_effect=FileNotFoundError("OWNER.json")
        ) as read, patch.object(service.time, "monotonic", side_effect=clock), patch.object(
            service.time, "sleep"
        ) as sleep:
            with self.assertRaises(FileNotFoundError):
                service._read_ready_owner(service.RuntimePaths())
        self.assertEqual(read.call_count, 2)
        sleep.assert_called_once_with(service.READY_OWNER_MISSING_POLL_SECONDS)

    def test_owner_schema_failure_is_immediate_without_missing_retry(self):
        service = self.load_service()
        with patch.object(service, "_read_json", return_value={"state": "ready"}) as read, \
                patch.object(service.time, "sleep") as sleep:
            with self.assertRaisesRegex(service.RuntimeServiceError, "schema"):
                service._read_ready_owner(service.RuntimePaths())
        read.assert_called_once()
        sleep.assert_not_called()

    def test_supervision_api_failure_is_fail_closed_with_pinned_owner_proof(self):
        service = self.load_service()
        identity = {
            "api_instance_id": "instance",
            "api_contract_version": "1.0.0",
            "runtime_store_binding": {"binding": "a" * 64},
        }
        owner = {
            "schema_version": "runtime_service_owner.v1",
            "state": "ready",
            "owner_token": "known",
            "children": [],
        }
        handle = service.RuntimeHandle(service.RuntimePaths(), {}, owner, 8081, identity)
        with patch.object(
            service, "_probe_api_liveness", side_effect=service.RuntimeServiceError("API down")
        ), patch.object(service, "_read_json", return_value=owner) as read, \
                patch.object(service, "_run_cli") as cli, \
                patch.object(service, "_service_status") as status:
            with self.assertRaises(service.RuntimeServiceUnknown):
                service.check(handle, full_api_probe=False)
        self.assertGreaterEqual(read.call_count, 1)
        cli.assert_not_called()
        status.assert_not_called()

    @unittest.skipIf(os.name == "nt", "Container metadata fsync/no-follow is tested on Linux")
    def test_service_config_preserves_existing_operator_profile(self):
        service = self.load_service()
        from dataclasses import replace
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory).resolve() / "runtime.json"
            paths = replace(service.RuntimePaths(), config=config)
            with patch.object(service, "initialize_host_configuration", return_value={"expected": "profile"}), \
                    patch.dict(os.environ, {
                "FULLMAG_HOST_LEDGER_PROFILE": service.HOST_LEDGER_PROFILE,
                "FULLMAG_DOCKER_HOST_ID": "a" * 64,
            }, clear=True):
                first = service.ensure_configuration(paths)
            original = config.read_bytes()
            changed = {**first, "startup_timeout_seconds": 61}
            config.write_text(json.dumps(changed))
            retained = config.read_bytes()
            with patch.dict(os.environ, {
                "FULLMAG_HOST_LEDGER_PROFILE": service.HOST_LEDGER_PROFILE,
                "FULLMAG_DOCKER_HOST_ID": "a" * 64,
            }, clear=True), self.assertRaises(service.RuntimeServiceError):
                service.ensure_configuration(paths)
            self.assertEqual(config.read_bytes(), retained)
            target = config.with_name("target.json")
            target.write_bytes(original)
            config.unlink()
            config.symlink_to(target)
            with patch.dict(os.environ, {
                "FULLMAG_HOST_LEDGER_PROFILE": service.HOST_LEDGER_PROFILE,
                "FULLMAG_DOCKER_HOST_ID": "a" * 64,
            }, clear=True), self.assertRaises((service.RuntimeServiceError, OSError)):
                service.ensure_configuration(paths)
            self.assertEqual(target.read_bytes(), original)

    def test_runtime_rejects_toolchain_policy_that_overrides_model_requests(self):
        valid = {"Env": ['FULLMAG_FEM_REQUIRE_GPU=0', 'FULLMAG_FEM_MFEM_DEVICE=']}
        runtime.validate_workspace_environment(valid)
        for assignment in ('FULLMAG_FDM_EXECUTION=gpu', 'FULLMAG_FEM_EXECUTION=auto',
                           'FULLMAG_FEM_REQUIRE_GPU=1', 'FULLMAG_FEM_MFEM_DEVICE=cuda'):
            config = {"Env": [*valid["Env"], assignment]}
            with self.assertRaisesRegex(ValueError, "overrides model execution"):
                runtime.validate_workspace_environment(config)

    @unittest.skipUnless(os.environ.get("FULLMAG_TEST_COMPOSE_CONFIG") == "1", "Read-only Compose CLI integration gate")
    def test_windows_certificate_is_read_only_and_profile_is_explicit(self):
        service = runtime.compose_spec("sha256:" + "a" * 64, Path("C:/owned/state"), 3197,
                                       Path("C:/owned/host.json"),
                                       workspace_state_root=Path("/owned/user-data"))["services"]["backend"]
        self.assertEqual(service["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"], "windows-folder-v1")
        certificate = next(m for m in service["volumes"] if m["target"] == "/run/fullmag/windows-folder-host.json")
        self.assertTrue(certificate["read_only"])

    @unittest.skipIf(os.name == "nt", "Guest probes require Linux no-follow and flock")
    def test_guest_probes_require_restart_before_grant_and_reject_junction(self):
        import hashlib
        import uuid
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/windows_folder_probe.py"
        spec = importlib.util.spec_from_file_location("windows_folder_probe_test", path)
        guest = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guest)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / ".windows-folder-probe"
            directory.mkdir()
            target = directory / "junction-target"
            target.mkdir()
            (directory / "host-junction").symlink_to(target, target_is_directory=True)
            image = "sha256:" + "a" * 64
            owner = str(uuid.uuid4())
            host = {"schema": "fullmag.windows-folder-host.v1", "storage_profile": "windows-folder-v1",
                    "role": "session", "owner_scope": "docker-desktop-linux", "host_root_no_reparse": True,
                    "host_drive_type": 3, "host_filesystem": "NTFS", "image_id": image,
                    "owner_token": owner, "restart_verified": False,
                    "restart_expected_sha256": hashlib.sha256((owner + ":" + image).encode()).hexdigest()}
            certificate = root / "host.json"
            marker = root / ".fullmag-windows-folder-owner.json"
            certificate.write_text(json.dumps(host))
            marker.write_text(json.dumps(host))
            with patch.object(guest, "ROOT", root), patch.object(guest, "HOST", certificate), \
                    patch.dict(os.environ, {"FULLMAG_RUNTIME_IMAGE_ID": image}):
                first = guest.run(False)
                self.assertFalse(first["checks"]["restart_readback"])
                with self.assertRaisesRegex(RuntimeError, "Native host has not confirmed"):
                    guest.run(True)
                self.assertFalse((root / ".fullmag-windows-folder-grant.json").exists())
                restart = guest.run(False)
                self.assertTrue(all(restart["checks"].values()))
                host["restart_verified"] = True
                certificate.write_text(json.dumps(host))
                marker.write_text(json.dumps(host))
                grant = guest.run(True)
                self.assertTrue(all(grant["checks"].values()))
                self.assertEqual(grant["host_attestation_sha256"], hashlib.sha256(certificate.read_bytes()).hexdigest())
                self.assertTrue((root / ".fullmag-windows-folder-grant.json").is_file())
                (directory / "host-junction").unlink()
                (directory / "host-junction").mkdir()
                with self.assertRaisesRegex(RuntimeError, "Guest did not expose"):
                    guest.run(True)

    def test_rejects_mutable_image_and_invalid_port(self):
        for image, port in (("fullmag:latest", 3197), ("sha256:" + "a" * 64, 80)):
            with self.assertRaises(ValueError):
                runtime.compose_spec(image, Path("/state-host"), port)

    def test_toolchain_preflight_is_pinned_isolated_and_validates_manifest(self):
        manifest = {
            "schema": runtime.TOOLCHAIN_MANIFEST_SCHEMA,
            "declared": {},
            "actual": {"source_commits": {
                name: "a" * 40 for name in runtime.TOOLCHAIN_SOURCE_COMMITS
            }},
            "latest": {"status": "not-queried"},
            "build": {"phase": "runtime"},
        }
        with patch.object(runtime, "docker", return_value=json.dumps(manifest)) as docker_call:
            self.assertEqual(runtime._preflight_toolchain_image("sha256:" + "b" * 64), manifest)
        command = docker_call.call_args.args
        self.assertEqual(command[:8], (
            "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop",
        ))
        self.assertIn("no-new-privileges:true", command)
        self.assertIn("--entrypoint", command)
        self.assertIn("/usr/local/bin/python3", command)
        self.assertNotIn("--gpus", command)
        self.assertNotIn("--mount", command)
        self.assertNotIn("--env", command)
        self.assertEqual(
            docker_call.call_args.kwargs["timeout"],
            runtime.TOOLCHAIN_PREFLIGHT_TIMEOUT_SECONDS,
        )

        for changed in (
            {**manifest, "schema": "fullmag.old-toolchain.v0"},
            {**manifest, "actual": {}},
            {**manifest, "actual": {"source_commits": {
                **manifest["actual"]["source_commits"], "petsc": ""
            }}},
        ):
            with self.subTest(changed=changed):
                with patch.object(runtime, "docker", return_value=json.dumps(changed)):
                    with self.assertRaises(ValueError):
                        runtime._preflight_toolchain_image("sha256:" + "b" * 64)

        with self.assertRaisesRegex(ValueError, "immutable SHA-256"):
            runtime._preflight_toolchain_image("fullmag/fem-gpu:latest")

    @unittest.skipIf(os.name == "nt", "Linux O_NOFOLLOW probe contract")
    def test_toolchain_probe_requires_bounded_regular_nonsymlink_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "dependency-versions.json"
            manifest.write_text('{"schema":"fullmag.docker.fem-gpu-dependencies.v1"}', encoding="utf-8")
            command = [sys.executable, "-c", runtime._TOOLCHAIN_MANIFEST_PROBE,
                       str(manifest), str(runtime.TOOLCHAIN_MANIFEST_MAX_BYTES)]
            accepted = subprocess.run(command, capture_output=True, text=True, check=False)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual(json.loads(accepted.stdout), {"schema": runtime.TOOLCHAIN_MANIFEST_SCHEMA})

            link = root / "manifest-link"
            link.symlink_to(manifest)
            rejected_link = subprocess.run(
                [sys.executable, "-c", runtime._TOOLCHAIN_MANIFEST_PROBE,
                 str(link), str(runtime.TOOLCHAIN_MANIFEST_MAX_BYTES)],
                capture_output=True, text=True, check=False,
            )
            self.assertNotEqual(rejected_link.returncode, 0)

            oversized = root / "oversized"
            oversized.write_bytes(b"x" * 33)
            rejected_size = subprocess.run(
                [sys.executable, "-c", runtime._TOOLCHAIN_MANIFEST_PROBE,
                 str(oversized), "32"],
                capture_output=True, text=True, check=False,
            )
            self.assertNotEqual(rejected_size.returncode, 0)

    def test_old_configured_toolchain_is_rejected_before_capture_or_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            layout = {"storage_root": str(root), "runs_root": str(root / "runs" / "task"),
                      "worktree_id": "task", "repo_root": str(root / "repo")}
            with patch.object(runtime.storage, "resolve_layout", return_value=layout), \
                    patch("local_runner.build_executor.configured_build",
                          return_value={"image_digest": "sha256:" + "e" * 64}), \
                    patch.object(runtime, "_preflight_toolchain_image",
                                 side_effect=ValueError("missing dependency manifest")) as preflight, \
                    patch("local_runner.source.capture_source") as capture, \
                    patch("local_runner.container_client.request") as request:
                with self.assertRaisesRegex(ValueError, "missing dependency manifest"):
                    runtime.submit_build(root / "repo", "b" * 40)
            preflight.assert_called_once_with("sha256:" + "e" * 64)
            capture.assert_not_called()
            request.assert_not_called()

    @unittest.skipIf(os.name == "nt", "Bash shell admission is checked on Linux")
    def test_just_shell_admits_quoted_recipe_and_rejects_composite(self):
        repo = Path(__file__).resolve().parents[1]
        recipe = (f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" '
                  "build-image --job-id '" + "a" * 32 + "' --commit '" + "b" * 40 + "'")
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "python-probe"
            probe.write_text('#!/bin/sh\nif [ "$1" = "-c" ]; then exit 0; fi\nprintf "%s\\n" "$@"\n')
            probe.chmod(0o755)
            env = {**os.environ, "FULLMAG_STORAGE_PYTHON": str(probe)}
            command = ["bash", str(repo / "scripts/just_storage_shell.sh")]
            recipes = [recipe, recipe + " --development", recipe + " --development --source-root '/checkout'",
                       f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" submit-development' + " --source-root '/checkout'",
                       f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" submit-development',
                       recipe + " --source-digest '" + "c" * 64 + "' --native-snapshot-sha256 '" + "d" * 64 + "'",
                       f'python3 "{repo}/scripts/fullmag_docker_runtime.py" --repo-root "{repo}" '
                       "start --assembly-receipt '/owned/receipt.json' --port '3197' --frontend 'dev'",
                       f'python3 "{repo}/scripts/verify_docker_all_runtime.py" --repo-root "{repo}" '
                       "'/owned/receipt.json'"]
            for candidate in recipes:
                accepted = subprocess.run([*command, candidate], env=env, text=True, capture_output=True)
                self.assertEqual(accepted.returncode, 0, accepted.stderr)
                self.assertIn("docker-all-gpu", accepted.stdout)
                rejected = subprocess.run([*command, candidate + "; true"], env=env,
                                          text=True, capture_output=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("invalid all-in-Docker", rejected.stderr)

    def test_gpu_release_keeps_receipt_profile(self):
        commit = "b" * 40
        context = {"job_id": "a" * 32, "source_digest": "c" * 64,
                   "profile": "fem-gpu-release", "image_digest": "sha256:" + "d" * 64,
                   "native_source_identity": {"head_commit_full": commit,
                                              "source_snapshot_dirty": False}}
        journal = {**context, "phase": "terminal", "state": "succeeded", "exit_code": 0,
                   "trusted_hashes": {name: "e" * 64 for name in
                                      ("context.json", "build_entrypoint.py", "worker_entrypoint.py")}}
        with patch.object(managed, "read_json", side_effect=[journal, context]), \
                patch.object(managed, "digest", return_value="e" * 64), \
                patch.object(managed, "validate_build_receipt", return_value={}) as validate:
            managed.validate_managed_build(Path(tempfile.gettempdir()).resolve() / context["job_id"], commit,
                                           expected_profile="fem-gpu-release")
            self.assertEqual(validate.call_args.args[1]["profile"], "fem-gpu-release")

    def test_default_cpu_validator_rejects_gpu_release(self):
        with patch.object(managed, "read_json", side_effect=[
            {"phase": "terminal", "state": "succeeded", "exit_code": 0,
             "profile": "fem-gpu-release"}, {}]):
            with self.assertRaisesRegex(ValueError, "terminal and successful"):
                managed.validate_managed_build(Path(tempfile.gettempdir()).resolve() / "job", "b" * 40)

    def test_submission_uses_gpu_queue_and_independent_source_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            layout = {"storage_root": str(root), "runs_root": str(root / "runs" / "test-worktree"),
                      "worktree_id": "test-worktree", "repo_root": str(root / "repo")}
            commit = "b" * 40
            manifest = {"resolved_commit": commit, "source_digest": "c" * 64}
            with patch.object(runtime.storage, "resolve_layout", return_value=layout), \
                    patch.object(runtime, "read_json", return_value={"worktree_id": layout["worktree_id"], "repo_root": layout["repo_root"]}), \
                    patch.object(runtime.storage, "initialize"), \
                    patch.object(runtime.storage, "build_lock", return_value=nullcontext()), \
                    patch("local_runner.build_executor.configured_build",
                          return_value={"image_digest": "sha256:" + "e" * 64}), \
                    patch.object(runtime, "_preflight_toolchain_image", return_value={}), \
                    patch("local_runner.build_source.native_identity", return_value={}), \
                    patch("local_runner.build_source.bind_identity", return_value={}), \
                    patch("local_runner.source.capture_source", return_value=manifest) as capture, \
                    patch("local_runner.container_client.request", side_effect=[
                        {"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]},
                        {"job_id": "d" * 32, "state": "queued"}]) as request, \
                    patch("builtins.print"):
                runtime.submit_build(root / "repo", commit)
                self.assertIsNone(capture.call_args.kwargs["content_store"])
                self.assertEqual(capture.call_args.kwargs["ref"], commit)
                payload = request.call_args.kwargs["payload"]
                self.assertEqual(payload["profile"], "fem-gpu-release")
                self.assertEqual(payload["operation"], "build")
                self.assertEqual(payload["source_digest"], manifest["source_digest"])
                self.assertEqual(payload["payload"]["source_mode"], "commit")
                self.assertEqual(payload["payload"]["capture_id"], payload["request_key"])
                self.assertEqual(payload["payload"]["capsule_relative"],
                                 "runs/test-worktree/" + payload["request_key"] + "/source")
                self.assertEqual(request.call_args_list[0].kwargs["method"], "GET")
                self.assertEqual(request.call_args_list[1].kwargs["method"], "POST")
                accepted = json.loads(next((root / "runs/test-worktree").glob("*/submission.json")).read_text())
                self.assertEqual(accepted["state"], "submitted")
                self.assertEqual(accepted["queue_state_at_submission"], "queued")
                self.assertFalse(accepted["build_claimed_at_submission"])
                self.assertEqual(accepted["build_qualification"], "NOT VERIFIED")
                self.assertIn("never stops or restarts", accepted["queue_policy"])
                request.reset_mock()
                request.side_effect = [{"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]},
                                       TimeoutError("response lost after POST")]
                with self.assertRaises(TimeoutError):
                    runtime.submit_build(root / "repo", commit)
                receipts = [json.loads(path.read_text()) for path in (root / "runs/test-worktree").glob("*/submission.json")]
                pending = [value for value in receipts if value["state"] == "submission_unconfirmed"]
                self.assertEqual(len(pending), 1)
                self.assertEqual(pending[0]["request_key"], pending[0]["submission"]["request_key"])
                self.assertEqual(pending[0]["capture_id"], pending[0]["request_key"])
                self.assertEqual(request.call_count, 2)

    def test_development_image_uses_the_selected_worktree_for_snapshot_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            selected = root / "worktree"
            selected.mkdir()
            with patch("docker_development_inputs.select_checkout", return_value=selected) as choose, \
                    patch.object(runtime.storage, "resolve_layout", return_value={}) as resolve, \
                    patch.object(runtime, "runtime_package_use", return_value=nullcontext()), \
                    patch.object(runtime, "prepare_gpu_release", side_effect=ValueError("stop before outputs")):
                with self.assertRaisesRegex(ValueError, "stop before outputs"):
                    runtime.build_image(root / "client", "a" * 32, "b" * 40, development=True,
                                        source_digest="c" * 64, native_snapshot_sha256="d" * 64,
                                        source_root=selected)
                choose.assert_called_once_with(root / "client", selected)
                resolve.assert_called_once_with(selected, runtime.PROFILE)

    def test_development_build_captures_main_and_rejects_capture_races(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            layout = {"storage_root": str(root), "runs_root": str(root / "runs/task"),
                      "worktree_id": "task", "repo_root": str(root / "main")}
            main = root / "main"
            # Native Windows admission verifies every selected checkout
            # ancestor before capture.  Keep this fixture a real registered
            # directory so the test exercises capture-race behavior rather
            # than the intended missing-path rejection.
            main.mkdir()
            manifest = {"resolved_commit": "b" * 40, "source_digest": "c" * 64}
            native = {"source_snapshot_sha256": "e" * 64}
            with patch.object(runtime.storage, "git", side_effect=lambda repo, *args: args[-1]), \
                    patch.object(runtime.storage, "resolve_layout", return_value=layout), \
                    patch.object(runtime, "read_json", return_value={"worktree_id": "task", "repo_root": layout["repo_root"]}), \
                    patch.object(runtime.storage, "initialize"), \
                    patch.object(runtime.storage, "build_lock", return_value=nullcontext()), \
                    patch("docker_development_inputs.main_checkout", return_value=main), \
                    patch.object(runtime.storage, "worktree_records", return_value=[{"worktree": str(main)}]), \
                    patch("local_runner.build_executor.configured_build",
                          return_value={"image_digest": "sha256:" + "e" * 64}), \
                    patch.object(runtime, "_preflight_toolchain_image", return_value={}), \
                    patch("local_runner.build_source.native_identity", return_value=native) as identity, \
                    patch("local_runner.build_source.bind_identity", return_value=native), \
                    patch("local_runner.source.capture_source", return_value=manifest) as capture, \
                    patch("local_runner.container_client.request", side_effect=[
                        {"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]},
                        {"job_id": "d" * 32}]) as request, patch("builtins.print"):
                runtime.submit_build(root / "task", development=True)
                self.assertEqual(capture.call_args.args[0], main)
                self.assertEqual(capture.call_args.kwargs["mode"], "snapshot")
                self.assertIsNone(capture.call_args.kwargs["ref"])
                self.assertIsNone(capture.call_args.kwargs["content_store"])
                payload = request.call_args.kwargs["payload"]["payload"]
                self.assertEqual(payload["origin_repo"], str(main))
                self.assertEqual(payload["source_mode"], "snapshot")
                request.reset_mock()
                request.side_effect = [{"accepting_jobs": True, "allowed_profiles": ["fem-gpu-release"]}]
                identity.side_effect = [native, {"source_snapshot_sha256": "f" * 64}]
                with self.assertRaisesRegex(ValueError, "changed during backend snapshot"):
                    runtime.submit_build(root / "task", development=True)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args.kwargs["method"], "GET")

    def test_entrypoint_rejects_windows_9p_before_cuda_or_writes(self):
        path = Path(__file__).resolve().parents[1] / "docker/all-in-one/entrypoint.py"
        spec = importlib.util.spec_from_file_location("all_docker_entrypoint", path)
        entry = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entry)
        with patch.object(entry.subprocess, "check_output", return_value="1021997\n"), \
                patch.object(entry.ctypes, "CDLL") as load, \
                patch.object(entry.Path, "mkdir") as mkdir:
            with self.assertRaisesRegex(RuntimeError, "Unsupported durable session filesystem"):
                entry.preflight()
            load.assert_not_called()
            mkdir.assert_not_called()


if __name__ == "__main__":
    unittest.main()
