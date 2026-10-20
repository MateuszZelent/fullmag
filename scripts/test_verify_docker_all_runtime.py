"""Pure contract checks for the all-in-Docker runtime verifier."""
from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import verify_docker_all_runtime as verifier


class DockerAllRuntimeVerifierTests(unittest.TestCase):
    def _receipt(self, **overrides):
        value = {
            "schema": "fullmag.script_run_receipt.v1",
            "requested": {"backend": "fem", "precision": "double"},
            "resolved": {
                "backend": "fem",
                "device": "gpu",
                "precision": "double",
                "fallback": None,
                "requested_effective": {"device": "gpu"},
            },
            "outcome": {"status": "completed", "exit_code": 0},
            "script": {"path": "/opt/fullmag/source/examples/fem_relax_gpu_smoke.py"},
            "results": {"dir": "/state/verification/abc/output"},
        }
        for key, override in overrides.items():
            if isinstance(value.get(key), dict) and isinstance(override, dict):
                value[key] = {**value[key], **override}
            else:
                value[key] = override
        return value

    def _host_ledger_fixture(self, root: Path):
        import docker_host_ledger as ledger

        # Native Windows may expose TemporaryDirectory through an 8.3 short
        # alias (for example RUNNER~1).  Resolve it before deriving any
        # owned paths so the fixture matches the production no-short-path
        # admission guard.
        root = root.resolve()
        image = "sha256:" + "a" * 64
        container_id = "b" * 64
        run_root = root / "run"
        run_root.mkdir()
        mount_root = "/mnt/fullmag-host-ledger-test"
        backing_image = "/tmp/storage/build-volumes/fullmag-host-ledger-v1.ext4"
        host_receipt = {
            "schema": ledger.HOST_RECEIPT_SCHEMA,
            "profile": ledger.PROFILE,
            "state": "ready",
            "project_id": "fullmag-test",
            "backing_image": backing_image,
            "mount_root": mount_root,
            "mount_target": "/host-ledger",
            "ledger_root": mount_root + "/ledger",
            "filesystem": "ext4",
            "filesystem_uuid": "11111111-1111-1111-1111-111111111111",
            "image_size_bytes": ledger.IMAGE_SIZE_BYTES,
            "loop_device": "/dev/loop7",
            "mount_active": True,
            "created_image": True,
        }
        verify_host_receipt = {**host_receipt, "state": "validated", "created_image": False}
        environment = {
            "FULLMAG_HOST_LEDGER_PROFILE": ledger.PROFILE,
            "FULLMAG_HOST_LEDGER_ROOT": ledger.LEDGER_ROOT,
            "FULLMAG_HOST_LEDGER_MOUNT_TARGET": ledger.MOUNT_TARGET,
            "FULLMAG_HOST_LEDGER_MOUNT_ROOT": mount_root,
            "FULLMAG_HOST_LEDGER_LEDGER_ROOT": mount_root + "/ledger",
            "FULLMAG_HOST_LEDGER_BACKING_IMAGE": backing_image,
            "FULLMAG_HOST_LEDGER_PROJECT_ID": "fullmag-test",
            "FULLMAG_DOCKER_HOST_ID": "c" * 64,
        }
        adapter_path = run_root / "host-ledger-adapter-receipt.json"
        adapter = {
            "schema": ledger.RECEIPT_SCHEMA,
            "state": "ready",
            "run_id": "d" * 32,
            "profile": ledger.PROFILE,
            "project_id": "fullmag-test",
            "image_id": image,
            "backing_image": backing_image,
            "mount_root": mount_root,
            "ledger_root": ledger.LEDGER_ROOT,
            "receipt_path": str(adapter_path),
            "environment": environment,
            "host_receipt": host_receipt,
        }
        adapter_path.write_text(json.dumps(adapter, sort_keys=True), encoding="utf-8")
        profile = {
            "schema": ledger.SCHEMA,
            "state": "ready",
            "run_id": "d" * 32,
            "profile": ledger.PROFILE,
            "project_id": "fullmag-test",
            "image_id": image,
            "environment": environment,
            "mount_root": mount_root,
            "ledger_root": ledger.LEDGER_ROOT,
            "ledger_root_daemon": mount_root + "/ledger",
            "backing_image": backing_image,
            "run_root": str(run_root),
            "maintenance_compose": str(run_root / "compose.host-ledger.maintenance.json"),
            "receipt": str(adapter_path),
            "receipt_sha256": hashlib.sha256(adapter_path.read_bytes()).hexdigest(),
            "host_receipt": host_receipt,
        }
        attestation = {
            "schema": "fullmag.docker-host-ledger-attestation.v1",
            "profile": ledger.PROFILE,
            "backend_container_id": container_id,
            "mount_source": mount_root,
            "mount_target": ledger.MOUNT_TARGET,
            "ledger_root": ledger.LEDGER_ROOT,
            "filesystem": "ext4",
            "filesystem_uuid": host_receipt["filesystem_uuid"],
            "loop_device": host_receipt["loop_device"],
            "backing_image": backing_image,
            "backend_verification": "PASS",
            "host_verification": "PASS",
            "host_receipt": verify_host_receipt,
        }
        document = {
            "Id": container_id,
            "Image": image,
            "Config": {
                "User": "65532:65532",
                "Env": [f"{key}={value}" for key, value in {
                    **environment,
                    "FULLMAG_DOCKER_HOST_EXECUTION": "1",
                }.items()],
            },
            "Mounts": [{
                "Destination": ledger.MOUNT_TARGET,
                "Type": "bind",
                "RW": True,
                "Source": mount_root,
            }],
            "HostConfig": {"Privileged": False},
        }
        return {
            "receipt": {
                "image_id": image,
                "container_id": container_id,
                "host_ledger": profile,
                "host_ledger_attestation": attestation,
            },
            "document": document,
            "run_root": run_root,
        }

    def test_host_ledger_attestation_requires_launcher_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(verifier.VerificationError, "adapter receipt"):
                verifier._validate_host_ledger_attestation(
                    {"image_id": "sha256:" + "a" * 64}, {}, Path(directory), lambda *args, **kwargs: "verified"
                )

    def test_host_ledger_attestation_rejects_launcher_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self._host_ledger_fixture(Path(directory))
            fixture["receipt"]["host_ledger_attestation"]["ledger_root"] = "/host-ledger/foreign"
            with self.assertRaisesRegex(verifier.VerificationError, "attestation differs"):
                verifier._validate_host_ledger_attestation(
                    fixture["receipt"], fixture["document"], fixture["run_root"],
                    lambda *args, **kwargs: "verified",
                )

    def test_host_ledger_attestation_accepts_distinct_ensure_and_verify_receipts_without_maintenance(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = self._host_ledger_fixture(Path(directory))
            self.assertEqual(fixture["receipt"]["host_ledger"]["host_receipt"]["state"], "ready")
            self.assertEqual(fixture["receipt"]["host_ledger_attestation"]["host_receipt"]["state"], "validated")
            calls = []

            def fake_docker(*args, **kwargs):
                calls.append((args, kwargs))
                return "verified"

            result = verifier._validate_host_ledger_attestation(
                fixture["receipt"], fixture["document"], fixture["run_root"], fake_docker
            )
            self.assertEqual(result["schema"], "fullmag.docker-host-ledger-attestation.v1")
            self.assertEqual(result["backend_verification"], "PASS")
            self.assertEqual([call[0][0] for call in calls], ["exec"])
            self.assertTrue(all("compose" not in call[0] for call in calls))

    def test_service_rejects_foreign_network_extra_attachment_and_changed_hostname(self):
        import copy
        from docker_compose_attestation import service_network, network_owner
        project, network_id = "fullmag-all-" + "a" * 32, "b" * 64
        name, hostname = project + "_fullmag", "fullmag-" + "a" * 32
        actual = {"HostConfig": {"NetworkMode": name}, "Config": {"Hostname": hostname},
                  "NetworkSettings": {"Networks": {name: {"NetworkID": network_id}}}}
        self.assertEqual(service_network(actual, project, hostname=hostname), network_id)
        changed = copy.deepcopy(actual)
        changed["NetworkSettings"]["Networks"]["foreign"] = {"NetworkID": "c" * 64}
        with self.assertRaisesRegex(ValueError, "project-scoped"):
            service_network(changed, project)
        with self.assertRaisesRegex(ValueError, "hostname"):
            service_network(actual, project, hostname="foreign-host")
        owner = {"Id": network_id, "Name": name, "Driver": "bridge", "Scope": "local",
                 "Labels": {"com.docker.compose.project": project, "com.docker.compose.network": "fullmag"}}
        network_owner(owner, project, network_id)
        with self.assertRaisesRegex(ValueError, "ownership"):
            network_owner({**owner, "Labels": {}}, project, network_id)

    def test_development_source_and_package_are_distinct_readonly_binds(self):
        import copy
        receipt = {"source_root": "/owned/checkout", "assembly_receipt": "/owned/assembly.json",
                   "compiled_source_commit": "a" * 40}
        assembly = {"runtime_mode": "development_source_bind", "package_root": "/owned/package",
                    "commit": "a" * 40}
        mounts = [{"Type": "bind", "Source": source, "Destination": target, "RW": False}
                  for target, source in (("/opt/fullmag/source", "/owned/checkout"),
                                         ("/opt/fullmag/package", "/owned/package"),
                                         ("/opt/fullmag/provenance.json", "/owned/assembly.json"))]
        verifier._validate_development_backend_mounts({"Mounts": mounts}, receipt, assembly)
        for index in range(3):
            changed = copy.deepcopy(mounts)
            changed[index]["RW"] = True
            with self.assertRaisesRegex(verifier.VerificationError, "readonly bind"):
                verifier._validate_development_backend_mounts({"Mounts": changed}, receipt, assembly)
        changed = copy.deepcopy(mounts)
        changed[1]["Source"] = "/foreign/package"
        with self.assertRaisesRegex(verifier.VerificationError, "readonly bind"):
            verifier._validate_development_backend_mounts({"Mounts": changed}, receipt, assembly)
        with self.assertRaisesRegex(verifier.VerificationError, "compiled source identity"):
            verifier._validate_development_backend_mounts({"Mounts": mounts},
                {**receipt, "compiled_source_commit": "b" * 40}, assembly)

    def test_smoke_command_has_explicit_workspace_and_output(self):
        command = verifier._verification_command(
            "/state/verification/abc", "/state/verification/abc/fem-gpu-receipt.json"
        )
        self.assertIn("/opt/fullmag/source/examples/fem_relax_gpu_smoke.py", command)
        self.assertEqual(
            command[command.index("--output-dir") + 1], "/state/verification/abc/output"
        )
        self.assertEqual(
            command[command.index("--workspace-root") + 1], "/state/verification/abc/workspace"
        )
        self.assertEqual(command[command.index("--backend") + 1], "fem")
        self.assertEqual(command[command.index("--precision") + 1], "double")
        self.assertEqual(command[0], "/opt/fullmag/package/bin/fullmag-bin")

    def test_required_binary_attestation_includes_current_writer(self):
        self.assertIn("fullmag-bin", verifier.REQUIRED_BINARY_NAMES)
        self.assertIn("fullmag-api", verifier.REQUIRED_BINARY_NAMES)
        self.assertTrue(
            all(name.startswith("fullmag-api") or name == "fullmag-bin" or name == "fullmag-runtime-service"
                for name in verifier.REQUIRED_BINARY_NAMES)
        )

    def test_dev_runtime_topology_requires_frontend_and_uses_public_8080(self):
        receipt = {
            "frontend_mode": "dev",
            "container_http_port": 8080,
            "url": "http://localhost:3197/workspace",
            "container_id": "a" * 12,
            "frontend_container_id": "b" * 12,
        }
        mode, port, frontend_id = verifier._runtime_topology(receipt)
        self.assertEqual((mode, port, frontend_id), ("dev", 3197, "b" * 12))
        del receipt["frontend_container_id"]
        with self.assertRaisesRegex(verifier.VerificationError, "frontend_container_id"):
            verifier._runtime_topology(receipt)

    def test_static_runtime_topology_uses_backend_8081_without_frontend(self):
        mode, port, frontend_id = verifier._runtime_topology(
            {
                "frontend_mode": "static",
                "container_http_port": 8081,
                "url": "http://localhost:3197/workspace",
            }
        )
        self.assertEqual((mode, port, frontend_id), ("static", 3197, None))

    def test_gpu_smoke_receipt_requires_gpu_without_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(json.dumps(self._receipt()), encoding="utf-8")
            result = verifier._validate_gpu_smoke_receipt(path, "/state/verification/abc")
            self.assertEqual(result["resolved_device"], "gpu")
            document = self._receipt()
            document["resolved"]["device"] = "cpu"
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(verifier.VerificationError, "fallback"):
                verifier._validate_gpu_smoke_receipt(path, "/state/verification/abc")

    def test_gpu_smoke_receipt_rejects_output_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            document = self._receipt()
            document["results"]["dir"] = "/state/other/output"
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(verifier.VerificationError, "output root"):
                verifier._validate_gpu_smoke_receipt(path, "/state/verification/abc")

    def test_session_environment_has_scoped_profile_without_store_scope_override(self):
        environment = verifier._session_environment(
            "/state/verification/abc/session-save-state", "sha256:" + "a" * 64
        )
        self.assertEqual(environment["FULLMAG_SESSION_STORAGE_PROFILE"], "windows-folder-v1")
        self.assertNotIn("FULLMAG_ACCEPTED_STORE_SCOPE", environment)
        self.assertEqual(environment["FULLMAG_STATE_ROOT"], "/state/verification/abc/session-save-state")

    def test_gpu_smoke_receipt_rejects_output_prefix_sibling(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            document = self._receipt()
            document["results"]["dir"] = "/state/verification/abc/output-other"
            path.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaisesRegex(verifier.VerificationError, "output root"):
                verifier._validate_gpu_smoke_receipt(path, "/state/verification/abc")


if __name__ == "__main__":
    unittest.main()
