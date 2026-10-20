"""Focused source regressions for the native CPU/GPU device boundary.

These checks are source-only.  They never invoke Docker, native binaries, or
the Rust test harness.
"""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

import docker_dev
import fullmag_docker_runtime as runtime
import setup_docker
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker" / "all-in-one"))
import runtime_service


class DockerCpuAccessContract(unittest.TestCase):
    def test_disabled_never_probes_host_and_selects_cpu(self):
        with patch.object(docker_dev.subprocess, "run") as run:
            self.assertEqual(docker_dev._resolve_gpu_access("disabled"), "cpu")
        run.assert_not_called()

    def test_auto_requires_a_bounded_host_gpu_identity(self):
        completed = docker_dev.subprocess.CompletedProcess(
            ["nvidia-smi"], 0, "GPU-01234567-89ab-cdef-0123-456789abcdef\n", ""
        )
        with patch.object(docker_dev.subprocess, "run", return_value=completed):
            self.assertEqual(docker_dev._resolve_gpu_access("auto"), "gpu")
        failed = docker_dev.subprocess.CompletedProcess(["nvidia-smi"], 1, "", "driver unavailable")
        with patch.object(docker_dev.subprocess, "run", return_value=failed):
            self.assertEqual(docker_dev._resolve_gpu_access("auto"), "cpu")
            with self.assertRaises(docker_dev.DirectDockerError):
                docker_dev._resolve_gpu_access("required")

    def test_invalid_policy_is_rejected_before_any_probe(self):
        with patch.object(docker_dev.subprocess, "run") as run:
            with self.assertRaises(docker_dev.DirectDockerError):
                docker_dev._resolve_gpu_access("maybe")
        run.assert_not_called()

    def test_setup_disabled_skips_host_nvidia_probe(self):
        with patch.object(setup_docker, "probe", return_value={"state": "available"}) as probe:
            checks = setup_docker.host_checks("disabled")
        self.assertEqual(checks["nvidia"]["state"], "not_required")
        self.assertFalse(
            any(call.args and call.args[0][0] == "nvidia-smi" for call in probe.call_args_list)
        )

    def test_auto_downgrades_only_before_compose_when_docker_gpu_probe_fails(self):
        observed = {}

        def reject_probe(*args, **kwargs):
            observed["args"] = args
            raise docker_dev.DirectDockerError("no runtime")

        with patch.object(docker_dev, "_docker_capture", side_effect=reject_probe):
            self.assertEqual(
                docker_dev._verify_docker_gpu_access("gpu", "auto", "sha256:" + "a" * 64, "fullmag-test"),
                "cpu",
            )
        self.assertEqual(observed["args"][0:4], ("run", "--rm", "--pull", "never"))
        self.assertEqual(observed["args"][6:8], ("--gpus", "all"))
        with patch.object(docker_dev, "_docker_capture", side_effect=docker_dev.DirectDockerError("no runtime")):
            with self.assertRaises(docker_dev.DirectDockerError):
                docker_dev._verify_docker_gpu_access(
                    "gpu", "required", "sha256:" + "a" * 64, "fullmag-test"
                )

    def test_compose_cpu_has_no_gpu_overlay_or_device_request(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            compose = repo / "compose.dev.yaml"
            overlay = repo / "compose.dev.gpu.yaml"
            compose.write_text(
                "services:\n  backend:\n    environment:\n      FULLMAG_DOCKER_DEVICE_ACCESS: ${FULLMAG_DOCKER_DEVICE_ACCESS:?required}\n"
                "  frontend:\n",
                encoding="utf-8",
            )
            overlay.write_text("services:\n  backend:\n    gpus: all\n", encoding="utf-8")
            observed = {}

            def fake_docker(*args, **kwargs):
                observed["args"] = args
                observed["environment"] = kwargs["environment"]
                return json.dumps({"services": {"backend": {}, "frontend": {}}})

            with patch.object(runtime, "docker", fake_docker):
                configured = runtime.compose_spec(
                    "sha256:" + "a" * 64,
                    Path("/state"),
                    3197,
                    Path("/host.json"),
                    repo=repo,
                    template=compose,
                    inputs={"source_root": "/checkout", "worktree_id": "worktree-test", "source_commit": "a" * 40},
                    inputs_path=Path("/inputs.json"),
                    package=Path("/package"),
                    provenance=Path("/provenance.json"),
                    workspace_state_root=Path("/user-data"),
                    device_access="cpu",
                )
            self.assertEqual(observed["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"], "cpu")
            self.assertNotIn(str(overlay), observed["args"])
            self.assertNotIn("gpus", configured["services"]["backend"])

    def test_compose_gpu_uses_only_the_explicit_gpu_overlay(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            compose = repo / "compose.dev.yaml"
            overlay = repo / "compose.dev.gpu.yaml"
            compose.write_text(
                "services:\n  backend:\n    environment:\n      FULLMAG_DOCKER_DEVICE_ACCESS: ${FULLMAG_DOCKER_DEVICE_ACCESS:?required}\n"
                "  frontend:\n",
                encoding="utf-8",
            )
            overlay.write_text("services:\n  backend:\n    gpus: all\n", encoding="utf-8")
            observed = {}

            def fake_docker(*args, **kwargs):
                observed["args"] = args
                observed["environment"] = kwargs["environment"]
                return json.dumps({"services": {"backend": {}, "frontend": {}}})

            with patch.object(runtime, "docker", fake_docker):
                configured = runtime.compose_spec(
                    "sha256:" + "a" * 64,
                    Path("/state"),
                    3197,
                    Path("/host.json"),
                    repo=repo,
                    template=compose,
                    inputs={"source_root": "/checkout", "worktree_id": "worktree-test", "source_commit": "a" * 40},
                    inputs_path=Path("/inputs.json"),
                    package=Path("/package"),
                    provenance=Path("/provenance.json"),
                    workspace_state_root=Path("/user-data"),
                    device_access="gpu",
                    device_overlay=overlay,
                )
            self.assertEqual(observed["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"], "gpu")
            self.assertIn(str(overlay), observed["args"])
            self.assertEqual(configured["services"]["backend"], {})

    def test_compose_passes_only_normalized_mixed_probe_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            compose = repo / "compose.dev.yaml"
            compose.write_text(
                "services:\n  backend:\n    environment:\n"
                "      FULLMAG_MIXED_P1_DEVICE: ${FULLMAG_MIXED_P1_DEVICE:-gpu}\n"
                "      FULLMAG_ARTIFACT_FIELD_STORAGE: ${FULLMAG_ARTIFACT_FIELD_STORAGE:-json}\n"
                "  frontend:\n",
                encoding="utf-8",
            )
            observed = {}

            def fake_docker(*args, **kwargs):
                observed["environment"] = kwargs["environment"]
                return json.dumps({"services": {"backend": {}, "frontend": {}}})

            # Inputs-only config inspection has no backend-start snapshot and
            # therefore uses the fixed Compose defaults. Ambient host values
            # must never be reread by the runtime layer.
            with patch.dict(
                docker_dev.os.environ,
                {
                    "FULLMAG_MIXED_P1_DEVICE": " CPU ",
                    "FULLMAG_ARTIFACT_FIELD_STORAGE": "ZARR",
                    "FULLMAG_UNRELATED_SECRET": "must-not-cross",
                },
                clear=True,
            ), patch.object(runtime, "docker", fake_docker):
                runtime.compose_spec(
                    "sha256:" + "a" * 64,
                    Path("/state"),
                    3197,
                    Path("/host.json"),
                    repo=repo,
                    template=compose,
                    inputs={
                        "source_root": "/checkout",
                        "worktree_id": "worktree-test",
                        "source_commit": "a" * 40,
                    },
                    inputs_path=Path("/inputs.json"),
                    package=Path("/package"),
                    provenance=Path("/provenance.json"),
                    workspace_state_root=Path("/user-data"),
                    device_access="cpu",
                )

            self.assertEqual(observed["environment"]["FULLMAG_MIXED_P1_DEVICE"], "gpu")
            self.assertEqual(observed["environment"]["FULLMAG_ARTIFACT_FIELD_STORAGE"], "json")
            self.assertNotIn("FULLMAG_UNRELATED_SECRET", observed["environment"])

    def test_inputs_only_compose_ignores_invalid_ambient_probe_control(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            compose = repo / "compose.dev.yaml"
            compose.write_text(
                "services:\n  backend:\n    environment:\n"
                "      FULLMAG_MIXED_P1_DEVICE: ${FULLMAG_MIXED_P1_DEVICE:-gpu}\n"
                "      FULLMAG_ARTIFACT_FIELD_STORAGE: ${FULLMAG_ARTIFACT_FIELD_STORAGE:-json}\n"
                "  frontend:\n",
                encoding="utf-8",
            )
            observed = {}

            def fake_docker(*args, **kwargs):
                observed["environment"] = kwargs["environment"]
                return json.dumps({"services": {"backend": {}, "frontend": {}}})

            with patch.dict(
                docker_dev.os.environ,
                {"FULLMAG_MIXED_P1_DEVICE": "cuda"},
                clear=True,
            ), patch.object(runtime, "docker", fake_docker):
                # The runtime does not consume ambient host settings in the
                # inputs-only path, so an invalid unused host value cannot
                # mutate or block this config inspection.
                runtime.compose_spec(
                    "sha256:" + "a" * 64,
                    Path("/state"),
                    3197,
                    Path("/host.json"),
                    repo=repo,
                    template=compose,
                    inputs={
                        "source_root": "/checkout",
                        "worktree_id": "worktree-test",
                        "source_commit": "a" * 40,
                    },
                    inputs_path=Path("/inputs.json"),
                    package=Path("/package"),
                    provenance=Path("/provenance.json"),
                    workspace_state_root=Path("/user-data"),
                    device_access="cpu",
                )
            self.assertEqual(observed["environment"]["FULLMAG_MIXED_P1_DEVICE"], "gpu")

    def test_operator_probe_snapshot_normalizes_and_hashes_exactly(self):
        values = docker_dev._normalize_operator_probe_environment({
            "FULLMAG_MIXED_P1_DEVICE": " CPU ",
            "FULLMAG_ARTIFACT_FIELD_STORAGE": " ZARR ",
        })
        self.assertEqual(values, {
            "FULLMAG_MIXED_P1_DEVICE": "cpu",
            "FULLMAG_ARTIFACT_FIELD_STORAGE": "zarr",
        })
        digest = docker_dev._operator_probe_environment_sha256(values)
        self.assertRegex(digest, r"^[0-9a-f]{64}$")
        self.assertEqual(digest, docker_dev._operator_probe_environment_sha256(values))
        with self.assertRaisesRegex(docker_dev.DirectDockerError, "exactly"):
            docker_dev._normalize_operator_probe_environment({
                "FULLMAG_MIXED_P1_DEVICE": "cpu",
                "FULLMAG_ARTIFACT_FIELD_STORAGE": "json",
                "UNRELATED": "secret",
            })

    def test_compose_operator_controls_default_without_host_override(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            compose = repo / "compose.dev.yaml"
            compose.write_text(
                "services:\n  backend:\n    environment:\n"
                "      FULLMAG_MIXED_P1_DEVICE: ${FULLMAG_MIXED_P1_DEVICE:-gpu}\n"
                "      FULLMAG_ARTIFACT_FIELD_STORAGE: ${FULLMAG_ARTIFACT_FIELD_STORAGE:-json}\n"
                "  frontend:\n",
                encoding="utf-8",
            )
            observed = {}

            def fake_docker(*args, **kwargs):
                observed["environment"] = kwargs["environment"]
                return json.dumps({"services": {"backend": {}, "frontend": {}}})

            with patch.dict(docker_dev.os.environ, {}, clear=True), patch.object(
                runtime, "docker", fake_docker
            ):
                runtime.compose_spec(
                    "sha256:" + "a" * 64,
                    Path("/state"),
                    3197,
                    Path("/host.json"),
                    repo=repo,
                    template=compose,
                    inputs={
                        "source_root": "/checkout",
                        "worktree_id": "worktree-test",
                        "source_commit": "a" * 40,
                    },
                    inputs_path=Path("/inputs.json"),
                    package=Path("/package"),
                    provenance=Path("/provenance.json"),
                    workspace_state_root=Path("/user-data"),
                    device_access="cpu",
                )

            self.assertEqual(observed["environment"]["FULLMAG_MIXED_P1_DEVICE"], "gpu")
            self.assertEqual(observed["environment"]["FULLMAG_ARTIFACT_FIELD_STORAGE"], "json")

    def test_cpu_profile_requires_v2_readiness_and_empty_gpu_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = runtime_service.RuntimePaths(store=Path(directory) / "store")
            digest = "a" * 64
            config = {
                "schema_version": "runtime_service_config.v2",
                "store_root": str(paths.store),
                "target_id": "docker-all",
                "compute_pool_id": "docker-all.compute",
                "preparation_pool_id": "docker-all.preparation",
                "compute_resources": [{
                    "resource_id": "docker-all.compute.cpu",
                    "kind": "cpu",
                    "budget": {"cpu_millis": 3000, "memory_bytes": 6 * 1024**3,
                               "gpu_memory_bytes": 0, "storage_bytes": 1024},
                }],
                "preparation_resources": [{
                    "resource_id": "docker-all.preparation.cpu",
                    "budget": {"cpu_millis": 1000, "memory_bytes": 1024**3,
                               "gpu_memory_bytes": 0, "storage_bytes": 1024},
                }],
                "host_execution": {
                    "schema_version": "runtime_service_host_execution.v1",
                    "ledger_root": "/host-ledger/ledger",
                    "runtime_generation_sha256": digest,
                    "policy": {
                        "schema_version": "host_resource_ledger_policy.v3",
                        "host_id": "docker-all-host",
                        "topology_sha256": digest,
                        "revision": 1,
                        "owner_epoch": 1,
                        "total_budget": {"cpu_millis": 4000, "memory_bytes": 7 * 1024**3,
                                         "gpu_memory_bytes": 0, "storage_bytes": 1024},
                        "allowed_cpu_ids": [0, 1],
                    },
                    "compute_max_concurrency": 1,
                    "preparation_max_concurrency": 1,
                    "compute_placements": {
                        "docker-all.compute.cpu": {"cpu_ids": [0], "gpu_uuid": None},
                    },
                    "preparation_cpu_ids": {"docker-all.preparation.cpu": [1]},
                },
            }
            readiness = {
                "schema_version": "host_runtime_readiness.v2",
                "status": "ready",
                "source_kind": "native_fem_cpu_abi",
                "source_snapshot_sha256": digest,
                "runtime_identity_sha256": digest,
                "capabilities": ["fem.cpu"],
                "gpu_runtime_compatibility": {},
                "gpu_visibility": "unavailable",
                "inventory_sha256": digest,
                "capabilities_sha256": "b" * 64,
            }
            profile = {
                "schema_version": "fullmag.docker-host-profile.v2",
                "configuration": config,
                "host_identity": {
                    "host_id": "docker-all-host", "node_id": "docker-all-node",
                    "runtime_owner_id": "docker-all-owner", "boot_id": "boot",
                    "inventory_sha256": digest, "capabilities_sha256": "b" * 64,
                    "allowed_cpu_ids": [0, 1], "gpu_uuids": [],
                },
                "readiness": readiness,
                "runtime_generation_sha256": digest,
            }
            self.assertIs(runtime_service._validate_host_profile(profile, paths, "cpu"), config)
            profile["readiness"]["gpu_visibility"] = "supported"
            with self.assertRaises(runtime_service.RuntimeServiceError):
                runtime_service._validate_host_profile(profile, paths, "cpu")


if __name__ == "__main__":
    unittest.main()
