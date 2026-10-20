#!/usr/bin/env python3
"""Focused interpreted contract checks for explicit runtime recovery."""

from __future__ import annotations

import json
from pathlib import Path
import hashlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_runtime_recovery as recovery  # noqa: E402
import fullmag_docker_runtime as runtime  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker/all-in-one"))
import runtime_service as service  # noqa: E402


class RuntimeRecoveryTests(unittest.TestCase):
    def _fixture(self, root: Path):
        run_root = root / ("a" * 32)
        state = run_root / "state"
        store = state / "runs" / "docker-all" / "session-store"
        runtime = state / ".fullmag" / "runtime-service"
        services = store / "runtime-services"
        evidence = run_root / "receipt-history" / "before-recovery"
        host_ledger = run_root / "host-ledger"
        for path in (runtime, services, evidence, host_ledger):
            path.mkdir(parents=True)
        config = runtime / "docker-all.json"
        owner = services / "OWNER.json"
        launch = services / "LAUNCH.json"
        config.write_text('{"schema_version":"runtime_service_config.v2"}\n', encoding="utf-8")
        owner.write_text(json.dumps({
            "owner_token": "owner-token",
            "process_start_token": "start-token",
            "pid": 12,
            "host": "127.0.0.1",
            "state": "unknown",
            "target_id": "docker-all",
            "control_address": "127.0.0.1:4000",
            "build_commit": "a" * 40,
            "build_snapshot": "b" * 64,
            "compute_pool_id": "docker-all.compute",
            "preparation_pool_id": "docker-all.preparation",
            "compute_pool_generation": "c" * 64,
            "preparation_pool_generation": "d" * 64,
            "children": [],
        }, sort_keys=True) + "\n", encoding="utf-8")
        launch.write_text('{"schema":"launch"}\n', encoding="utf-8")
        certificate = run_root / "windows-folder-host.json"
        certificate.write_text(json.dumps({
            "schema": "fullmag.windows-folder-host.v1",
            "storage_profile": "windows-folder-v1",
            "role": "session",
            "owner_scope": "docker-desktop-linux",
            "host_root": "C:/fullmag-storage",
            "host_filesystem": "NTFS",
            "host_drive_type": 3,
            "host_volume_serial": 123,
            "host_root_no_reparse": True,
            "image_id": "sha256:" + "1" * 64,
        }, sort_keys=True) + "\n", encoding="utf-8")
        mount = host_ledger / "host-ledger-adapter-receipt.json"
        mount.write_text(json.dumps({
            "schema": "fullmag.docker-host-ledger-adapter-receipt.v1",
            "profile": "windows-folder-v1",
            "project_id": "fullmag-host-ledger",
            "storage_root": "C:/fullmag-storage",
            "mount_root": "C:/fullmag-storage/host-ledger",
            "ledger_root": "/host-ledger/ledger",
            "backing_image": "sha256:" + "2" * 64,
            "docker_daemon_id_sha256": "3" * 64,
            "host_receipt": {"filesystem_uuid": "01234567-89ab-cdef-0123-456789abcdef"},
        }, sort_keys=True) + "\n", encoding="utf-8")
        (evidence / "manifest.json").write_text('{"files":[]}\n', encoding="utf-8")
        receipt_path = run_root / "receipt.json"
        receipt = {
            "schema": "fullmag.docker-all-run.v1",
            "state": "failed_resources_retained",
            "container_id": "a" * 64,
            "frontend_container_id": "b" * 64,
            "retained_container_ids": ["a" * 64, "b" * 64],
            "image_id": "sha256:" + "1" * 64,
            "frontend_image_id": None,
            "host_ledger": {"receipt": str(mount)},
        }
        receipt_path.write_text(json.dumps(receipt, sort_keys=True) + "\n", encoding="utf-8")
        authorization_path = run_root / "recovery-authorization.json"
        return {
            "run_root": run_root,
            "state": state,
            "config": config,
            "owner": owner,
            "launch": launch,
            "certificate": certificate,
            "mount": mount,
            "evidence": evidence,
            "receipt_path": receipt_path,
            "receipt": receipt,
            "authorization_path": authorization_path,
        }

    def test_prepare_and_validate_binds_one_stopped_run(self):
        with tempfile.TemporaryDirectory() as raw:
            fixture = self._fixture(Path(raw))
            authorization = recovery.prepare_authorization(
                run_receipt_path=fixture["receipt_path"],
                state_root=fixture["state"],
                config_path=fixture["config"],
                owner_path=fixture["owner"],
                launch_path=fixture["launch"],
                host_certificate_path=fixture["certificate"],
                mount_attestation_path=fixture["mount"],
                evidence_root=fixture["evidence"],
                output_path=fixture["authorization_path"],
                run_receipt=fixture["receipt"],
                container_ids={"backend": "a" * 64, "frontend": "b" * 64},
                image_ids={"backend": "sha256:" + "1" * 64,
                           "frontend": "sha256:" + "1" * 64},
            )
            self.assertEqual(authorization["schema_version"], recovery.AUTH_SCHEMA)
            validated = recovery.validate_authorization(
                fixture["authorization_path"],
                run_receipt_path=fixture["receipt_path"],
                run_receipt=fixture["receipt"],
                state_root=fixture["state"],
                config_path=fixture["config"],
                host_certificate_path=fixture["certificate"],
                mount_attestation_path=fixture["mount"],
            )
            self.assertEqual(validated["request_id"], authorization["request_id"])
            self.assertEqual(validated["request_sha256"], authorization["native_request_sha256"])
            history = fixture["run_root"] / "receipt-history" / "attempt"
            history.mkdir()
            archived = []
            for name, source in (("windows-folder-host.json", fixture["certificate"]),
                                 ("host-ledger/host-ledger-adapter-receipt.json", fixture["mount"])):
                destination = history / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())
                archived.append({
                    "relative": name,
                    "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
                    "size_bytes": destination.stat().st_size,
                })
            (history / "manifest.json").write_text(
                json.dumps({"schema": "fullmag.docker-all-reuse-history.v1", "files": archived}) + "\n",
                encoding="utf-8",
            )
            self.assertEqual(
                set(recovery.validate_preserved_evidence(validated, history)),
                {"windows-folder-host.json", "host-ledger/host-ledger-adapter-receipt.json"},
            )
            (history / "windows-folder-host.json").write_text("tampered\n", encoding="utf-8")
            with self.assertRaises(recovery.RecoveryAuthorizationError):
                recovery.validate_preserved_evidence(validated, history)

    def test_recovery_requires_receipt_declared_nested_mount_path(self):
        with tempfile.TemporaryDirectory() as raw:
            fixture = self._fixture(Path(raw))
            with self.assertRaises(recovery.RecoveryAuthorizationError):
                recovery.prepare_authorization(
                    run_receipt_path=fixture["receipt_path"], state_root=fixture["state"],
                    config_path=fixture["config"], owner_path=fixture["owner"],
                    launch_path=fixture["launch"], host_certificate_path=fixture["certificate"],
                    mount_attestation_path=fixture["run_root"] / "host-ledger-adapter-receipt.json",
                    evidence_root=fixture["evidence"], output_path=fixture["authorization_path"],
                    run_receipt=fixture["receipt"],
                    container_ids={"backend": "a" * 64, "frontend": "b" * 64},
                    image_ids={"backend": "sha256:" + "1" * 64,
                               "frontend": "sha256:" + "1" * 64},
                )

    def test_postrotation_binding_requires_fresh_same_volume_evidence(self):
        with tempfile.TemporaryDirectory() as raw:
            fixture = self._fixture(Path(raw))
            recovery.prepare_authorization(
                run_receipt_path=fixture["receipt_path"], state_root=fixture["state"],
                config_path=fixture["config"], owner_path=fixture["owner"],
                launch_path=fixture["launch"], host_certificate_path=fixture["certificate"],
                mount_attestation_path=fixture["mount"], evidence_root=fixture["evidence"],
                output_path=fixture["authorization_path"], run_receipt=fixture["receipt"],
                container_ids={"backend": "a" * 64, "frontend": "b" * 64},
                image_ids={"backend": "sha256:" + "1" * 64,
                           "frontend": "sha256:" + "1" * 64},
            )
            validated = recovery.validate_authorization(
                fixture["authorization_path"], run_receipt_path=fixture["receipt_path"],
                run_receipt=fixture["receipt"], state_root=fixture["state"],
                config_path=fixture["config"], host_certificate_path=fixture["certificate"],
                mount_attestation_path=fixture["mount"],
            )
            history = fixture["run_root"] / "receipt-history" / "attempt"
            old_mount_relative = validated["authorization"]["mount_attestation_relative_path"]
            (history / Path(old_mount_relative).parent).mkdir(parents=True, exist_ok=True)
            (history / "windows-folder-host.json").write_bytes(fixture["certificate"].read_bytes())
            (history / old_mount_relative).write_bytes(fixture["mount"].read_bytes())

            current_certificate = json.loads(fixture["certificate"].read_text(encoding="utf-8"))
            current_certificate["image_id"] = "sha256:" + "9" * 64
            fixture["certificate"].write_text(
                json.dumps(current_certificate, sort_keys=True) + "\n", encoding="utf-8"
            )
            current_mount = fixture["run_root"] / ".recreate" / "fresh" / "host-ledger" / "host-ledger-adapter-receipt.json"
            current_mount.parent.mkdir(parents=True)
            current_mount_value = json.loads(fixture["mount"].read_text(encoding="utf-8"))
            current_mount_value["receipt_path"] = str(current_mount)
            current_mount.write_text(
                json.dumps(current_mount_value, sort_keys=True) + "\n", encoding="utf-8"
            )
            binding = recovery.validate_postrotation_identity(
                validated,
                history_root=history,
                current_host_certificate_path=fixture["certificate"],
                current_mount_attestation_path=current_mount,
                binding_path=fixture["run_root"] / "recovery-postrotation-binding.json",
            )
            self.assertEqual(binding["binding"]["old"]["mount_attestation_relative"], old_mount_relative)
            self.assertNotEqual(
                binding["binding"]["new"]["mount_attestation_relative"], old_mount_relative
            )
            current_certificate["host_volume_serial"] = 999
            fixture["certificate"].write_text(
                json.dumps(current_certificate, sort_keys=True) + "\n", encoding="utf-8"
            )
            with self.assertRaises(recovery.RecoveryAuthorizationError):
                recovery.validate_postrotation_identity(
                    validated,
                    history_root=history,
                    current_host_certificate_path=fixture["certificate"],
                    current_mount_attestation_path=current_mount,
                    binding_path=fixture["run_root"] / "recovery-postrotation-binding-2.json",
                )
            current_certificate["host_volume_serial"] = 123
            fixture["certificate"].write_text(
                json.dumps(current_certificate, sort_keys=True) + "\n", encoding="utf-8"
            )
            current_mount_value["host_receipt"]["filesystem_uuid"] = "fedcba98-7654-3210-fedc-ba9876543210"
            current_mount.write_text(
                json.dumps(current_mount_value, sort_keys=True) + "\n", encoding="utf-8"
            )
            with self.assertRaises(recovery.RecoveryAuthorizationError):
                recovery.validate_postrotation_identity(
                    validated,
                    history_root=history,
                    current_host_certificate_path=fixture["certificate"],
                    current_mount_attestation_path=current_mount,
                    binding_path=fixture["run_root"] / "recovery-postrotation-binding-3.json",
                )

    def test_tampered_request_and_receipt_pins_fail_closed(self):
        with tempfile.TemporaryDirectory() as raw:
            fixture = self._fixture(Path(raw))
            recovery.prepare_authorization(
                run_receipt_path=fixture["receipt_path"], state_root=fixture["state"],
                config_path=fixture["config"], owner_path=fixture["owner"],
                launch_path=fixture["launch"], host_certificate_path=fixture["certificate"],
                mount_attestation_path=fixture["mount"], evidence_root=fixture["evidence"],
                output_path=fixture["authorization_path"], run_receipt=fixture["receipt"],
                container_ids={"backend": "a" * 64, "frontend": "b" * 64},
                image_ids={"backend": "sha256:" + "1" * 64,
                           "frontend": "sha256:" + "1" * 64},
            )
            auth = json.loads(fixture["authorization_path"].read_text(encoding="utf-8"))
            request = Path(auth["native_request_host_path"])
            request.chmod(0o640)
            request.write_bytes(request.read_bytes().replace(b"runtime_service_recovery_request.v1", b"tampered"))
            with self.assertRaises(recovery.RecoveryAuthorizationError):
                recovery.validate_authorization(
                    fixture["authorization_path"], run_receipt_path=fixture["receipt_path"],
                    run_receipt=fixture["receipt"], state_root=fixture["state"],
                    config_path=fixture["config"], host_certificate_path=fixture["certificate"],
                    mount_attestation_path=fixture["mount"],
                )

    def test_recovery_overlay_is_backend_only_and_readonly(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            authorization = root / "authorization.json"
            authorization.write_text("{}\n", encoding="utf-8")
            overlay = root / "compose.recovery.json"
            runtime._write_recovery_overlay(overlay, authorization)
            document = json.loads(overlay.read_text(encoding="utf-8"))
            backend = document["services"]["backend"]
            self.assertEqual(
                backend["environment"]["FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION"],
                "/run/fullmag/runtime-recovery-authorization.json",
            )
            volume = backend["volumes"][0]
            self.assertTrue(volume["read_only"])
            self.assertFalse(volume["bind"]["create_host_path"])
            self.assertEqual(volume["target"], "/run/fullmag/runtime-recovery-authorization.json")

    def test_native_receipt_uses_rust_names_and_archived_file_map(self):
        with tempfile.TemporaryDirectory() as raw:
            fixture = self._fixture(Path(raw))
            authorization = recovery.prepare_authorization(
                run_receipt_path=fixture["receipt_path"], state_root=fixture["state"],
                config_path=fixture["config"], owner_path=fixture["owner"],
                launch_path=fixture["launch"], host_certificate_path=fixture["certificate"],
                mount_attestation_path=fixture["mount"], evidence_root=fixture["evidence"],
                output_path=fixture["authorization_path"], run_receipt=fixture["receipt"],
                container_ids={"backend": "a" * 64, "frontend": "b" * 64},
                image_ids={"backend": "sha256:" + "1" * 64,
                           "frontend": "sha256:" + "1" * 64},
            )
            store = fixture["state"] / "runs" / "docker-all" / "session-store"
            archive = store / "runtime-services" / "recovery" / authorization["native_request_sha256"] / "archive"
            archive.mkdir(parents=True)
            owner_value = json.loads(fixture["owner"].read_text(encoding="utf-8"))
            owner_token = owner_value["owner_token"]
            compute_pool = owner_value["compute_pool_id"]
            preparation_pool = owner_value["preparation_pool_id"]
            configuration_bytes = fixture["config"].read_bytes()
            original_owner_bytes = fixture["owner"].read_bytes()
            post_owner_value = json.loads(original_owner_bytes.decode("utf-8"))
            post_owner_value["state"] = "failed"
            post_recovery_owner = (json.dumps(post_owner_value, sort_keys=True) + "\n").encode("utf-8")
            post_recovery_digest = hashlib.sha256(post_recovery_owner).hexdigest()
            fixture["owner"].write_bytes(post_recovery_owner)
            source_bytes = {
                "runtime-services/OWNER.json": original_owner_bytes,
                "runtime-services/OWNER.lock": b"owner-lock\n",
                "runtime-services/LAUNCH.json": fixture["launch"].read_bytes(),
                "runtime-services/LAUNCH.lock": b"launch-lock\n",
                "runtime-services/STARTUP-GATE.lock": b"startup-gate\n",
                f"runtime-services/{owner_token}/compute.stdout.jsonl": b"compute\n",
                f"runtime-services/{owner_token}/preparation.stdout.jsonl": b"preparation\n",
                f"scheduler_pools/{compute_pool}.resources.json": b"compute-resources\n",
                f"scheduler_pools/{preparation_pool}.preparation-resources.json": b"preparation-resources\n",
                f"scheduler_pools/{compute_pool}.json": b"compute-pool\n",
                f"scheduler_pools/{preparation_pool}.preparation.json": b"preparation-pool\n",
                "configuration.json": configuration_bytes,
            }
            archived_files = {}
            for relative, source in source_bytes.items():
                if relative != "configuration.json" and relative not in {
                    "runtime-services/OWNER.json", "runtime-services/LAUNCH.json"
                }:
                    source_path = store.joinpath(*relative.split("/"))
                    source_path.parent.mkdir(parents=True, exist_ok=True)
                    source_path.write_bytes(source)
                (archive / Path(relative).name).write_bytes(source)
                archived_files[relative] = hashlib.sha256(source).hexdigest()
            manifest_path = archive / "manifest.json"
            manifest_bytes = (json.dumps({
                "schema_version": "runtime_service_recovery_archive.v1",
                "request_sha256": authorization["native_request_sha256"],
                "config_sha256": authorization["config_sha256"],
                "files": archived_files,
            }, indent=2) + "\n").encode("utf-8")
            manifest_path.write_bytes(manifest_bytes)
            paths = service.RuntimePaths(
                state=fixture["state"], storage=fixture["state"],
                runs=fixture["state"] / "runs" / "docker-all", store=store,
                state_root=fixture["state"] / ".fullmag", source=fixture["state"],
                package=fixture["state"], config=fixture["config"],
                provenance=fixture["state"] / "provenance.json",
                host_certificate=fixture["certificate"],
            )
            result = {
                "schema_version": "runtime_service_recovery.v1",
                "status": "recovered", "outcome": "failed",
                "request_id": authorization["request_id"],
                "request_sha256": authorization["native_request_sha256"],
                "config_sha256": authorization["config_sha256"],
                "owner_sha256_before": authorization["owner_sha256"],
                "owner_state_after": "failed",
                "owner_sha256_after": post_recovery_digest,
                "archived_evidence_path": str(manifest_path),
                "archived_evidence_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                "archived_files": archived_files,
            }
            self.assertEqual(
                service._validate_native_recovery_result(paths, authorization, result), result
            )
            valid_manifest_bytes = manifest_path.read_bytes()
            missing = dict(result)
            missing["archived_files"] = {
                key: value for key, value in archived_files.items() if key != "configuration.json"
            }
            missing_manifest_bytes = (json.dumps({
                "schema_version": "runtime_service_recovery_archive.v1",
                "request_sha256": authorization["native_request_sha256"],
                "config_sha256": authorization["config_sha256"],
                "files": missing["archived_files"],
            }, indent=2) + "\n").encode("utf-8")
            manifest_path.write_bytes(missing_manifest_bytes)
            missing["archived_evidence_sha256"] = hashlib.sha256(missing_manifest_bytes).hexdigest()
            with self.assertRaises(service.RuntimeServiceError):
                service._validate_native_recovery_result(paths, authorization, missing)
            extra = dict(result)
            extra["archived_files"] = dict(archived_files, **{"unexpected.json": "f" * 64})
            extra_manifest_bytes = (json.dumps({
                "schema_version": "runtime_service_recovery_archive.v1",
                "request_sha256": authorization["native_request_sha256"],
                "config_sha256": authorization["config_sha256"],
                "files": extra["archived_files"],
            }, indent=2) + "\n").encode("utf-8")
            manifest_path.write_bytes(extra_manifest_bytes)
            extra["archived_evidence_sha256"] = hashlib.sha256(extra_manifest_bytes).hexdigest()
            with self.assertRaises(service.RuntimeServiceError):
                service._validate_native_recovery_result(paths, authorization, extra)
            manifest_path.write_bytes(valid_manifest_bytes)
            legacy = dict(result)
            legacy["before_owner_sha256"] = legacy.pop("owner_sha256_before")
            with self.assertRaises(service.RuntimeServiceError):
                service._validate_native_recovery_result(paths, authorization, legacy)
            fixture["owner"].write_bytes(original_owner_bytes)
            with self.assertRaises(service.RuntimeServiceError):
                service._validate_native_recovery_result(paths, authorization, result)
            fixture["owner"].write_bytes(post_recovery_owner)
            self.assertEqual(
                service._validate_native_recovery_result(paths, authorization, result), result
            )
            (archive / "OWNER.json").write_bytes(b"tampered archive\n")
            with self.assertRaises(service.RuntimeServiceError):
                service._validate_native_recovery_result(paths, authorization, result)
            (archive / "OWNER.json").write_bytes(original_owner_bytes)
            (archive / "configuration.json").write_bytes(b"tampered configuration\n")
            with self.assertRaises(service.RuntimeServiceError):
                service._validate_native_recovery_result(paths, authorization, result)
            (archive / "configuration.json").write_bytes(configuration_bytes)
            fixture["owner"].write_bytes(b'{"owner_token":"unexpected","state":"failed"}\n')
            with self.assertRaises(service.RuntimeServiceError):
                service._validate_native_recovery_result(paths, authorization, result)

    def test_failed_retained_run_requires_exact_explicit_recovery_fence(self):
        receipt = {
            "state": "failed_resources_retained",
            "container_id": "a" * 64,
            "frontend_container_id": "b" * 64,
            "retained_container_ids": ["a" * 64, "b" * 64],
        }
        with self.assertRaises(ValueError):
            runtime._validate_failed_retained_receipt(receipt, allow=False)
        runtime._validate_failed_retained_receipt(receipt, allow=True)
        receipt.pop("container_id")
        receipt.pop("frontend_container_id")
        runtime._validate_failed_retained_receipt(receipt, allow=True)
        receipt["retained_container_ids"] = ["a" * 64, "a" * 64]
        with self.assertRaises(ValueError):
            runtime._validate_failed_retained_receipt(receipt, allow=True)

    def test_recovery_flag_and_native_command_are_explicit_source_contracts(self):
        docker_dev = (Path(__file__).resolve().parent / "docker_dev.py").read_text(encoding="utf-8")
        runtime_source = (Path(__file__).resolve().parent / "fullmag_docker_runtime.py").read_text(encoding="utf-8")
        service = (Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py").read_text(encoding="utf-8")
        rust = (Path(__file__).resolve().parents[1] / "crates/fullmag-session/src/runtime_service.rs").read_text(encoding="utf-8")
        entrypoint = (Path(__file__).resolve().parents[1] / "docker/all-in-one/entrypoint.py").read_text(encoding="utf-8")
        self.assertIn('"--recover-idle-failure"', docker_dev)
        self.assertIn('"runtime",\n            "service-recover"', service)
        for field in ("owner_sha256_before", "owner_state_after", "owner_sha256_after",
                      "archived_evidence_path", "archived_evidence_sha256", "archived_files"):
            self.assertIn(f'"{field}"', service)
        self.assertIn('"fullmag.docker-runtime-recovery-consumed.v1"', runtime_source)
        self.assertIn("mount_attestation_path_for_receipt", runtime_source)
        self.assertNotIn('reuse["root"] / "host-ledger-adapter-receipt.json"', runtime_source)
        for field in ("owner_sha256_before", "owner_state_after", "owner_sha256_after",
                      "archived_evidence_path", "archived_evidence_sha256", "archived_files"):
            self.assertIn(f"pub {field}", rust)
        self.assertIn("if authorization_path is None", service)
        self.assertLess(
            entrypoint.index("runtime_recovery = service.recover_idle_failure(paths)"),
            entrypoint.index("configuration = service.ensure_configuration(paths)"),
        )


if __name__ == "__main__":
    unittest.main()
