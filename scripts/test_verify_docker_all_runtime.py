"""Pure contract checks for the all-in-Docker runtime verifier."""
from __future__ import annotations

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
