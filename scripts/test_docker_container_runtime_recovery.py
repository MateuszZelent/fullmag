"""Focused source and document checks for the named-volume recovery bridge."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "docker" / "all-in-one"
sys.path.insert(0, str(RUNTIME_ROOT))
runtime_service = importlib.import_module("runtime_service")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class ContainerRuntimeRecoveryBridgeTests(unittest.TestCase):
    def _document_fixture(self, root: Path) -> dict[str, object]:
        control = root / "control"
        control.mkdir()
        request_path = control / "recovery" / "request.json"
        attestation_path = control / "recovery" / "attestation.json"
        manifest_path = control / "recovery" / "manifest.json"
        request_path.parent.mkdir()
        owner = {
            "owner_token": "1" * 8 + "-" + "2" * 4 + "-4" + "3" * 3 + "-8" + "4" * 3 + "-" + "5" * 12,
            "process_start_token": "6" * 8 + "-" + "7" * 4 + "-4" + "8" * 3 + "-8" + "9" * 3 + "-" + "a" * 12,
            "state": "ready",
            "target_id": "docker-all",
            "compute_pool_id": "docker-all.compute",
            "preparation_pool_id": "docker-all.preparation",
        }
        digest = "a" * 64
        containers = [
            {
                "container_id": "1" * 64,
                "image_id": "sha256:" + "2" * 64,
                "config_sha256": "3" * 64,
                "service": "backend",
                "compose_project": "fullmag-test",
                "private_pid_namespace": True,
                "host_pid": False,
                "device_requests_sha256": "4" * 64,
            },
            {
                "container_id": "5" * 64,
                "image_id": "sha256:" + "6" * 64,
                "config_sha256": "7" * 64,
                "service": "frontend",
                "compose_project": "fullmag-test",
                "private_pid_namespace": True,
                "host_pid": False,
                "device_requests_sha256": "8" * 64,
            },
        ]
        request = {
            "schema_version": runtime_service.CONTAINER_RECOVERY_REQUEST_SCHEMA,
            "request_id": "123e4567-e89b-42d3-a456-426614174000",
            "config_sha256": digest,
            "owner_sha256": "b" * 64,
            "launch_sha256": "c" * 64,
            "expected_owner": owner,
            "store_root_sha256": "d" * 64,
            "application": {"mode": "external_only", "raw_sha256": "e" * 64},
            "ledger_root_sha256": "f" * 64,
            "ledger_snapshot_sha256": "0" * 64,
            "docker_engine_id_sha256": "1" * 64,
            "docker_manifest_sha256": "",
            "prior_ready_owner_proof_sha256": "3" * 64,
            "device_release_resource_id": "docker-all.gpu",
            "device_release_mapping_sha256": "4" * 64,
            "device_release_gpu_uuid": None,
            "containers": containers,
        }
        manifest_raw = b'{"containers":[]}'
        request["docker_manifest_sha256"] = _sha(manifest_raw)
        request_raw = (json.dumps(request, sort_keys=True, separators=(",", ":")) + "\n").encode()
        request_path.write_bytes(request_raw)
        manifest_path.write_bytes(manifest_raw)
        attestation = {
            "schema_version": runtime_service.CONTAINER_RECOVERY_ATTESTATION_SCHEMA,
            "request_sha256": _sha(request_raw),
            "docker_engine_id_sha256": request["docker_engine_id_sha256"],
            "containers": [
                {
                    "container_id": item["container_id"],
                    "image_id": item["image_id"],
                    "config_sha256": item["config_sha256"],
                    "before": {
                        "private_pid_namespace": True,
                        "host_pid": False,
                        "device_requests_sha256": item["device_requests_sha256"],
                    },
                    "after": {
                        "state": "exited",
                        "pid": 0,
                        "finished_at": "2026-10-19T00:00:00Z",
                        "descendant_count": 0,
                        "private_pid_namespace": True,
                        "host_pid": False,
                        "device_requests_sha256": item["device_requests_sha256"],
                    },
                }
                for item in containers
            ],
            "device_release": {
                "resource_id": request["device_release_resource_id"],
                "gpu_uuid": None,
                "mapping_sha256": request["device_release_mapping_sha256"],
                "mapping_detached": True,
            },
            "manifest_sha256": request["docker_manifest_sha256"],
            "result": "authoritative_teardown",
        }
        attestation_path.write_text(json.dumps(attestation, indent=2) + "\n", encoding="utf-8")
        attestation_sha = _sha(runtime_service._canonical_container_recovery_json(attestation))
        authorization = {
            "schema_version": "fullmag.docker-container-recovery-authorization.v1",
            "request_id": request["request_id"],
            "source_root": "C:\\fullmag\\fullmag",
            "compose_project": "fullmag-test",
            "backend_container_id": containers[0]["container_id"],
            "frontend_container_id": containers[1]["container_id"],
            "old_image_id": containers[0]["image_id"],
            "config_sha256": request["config_sha256"],
            "owner_sha256": request["owner_sha256"],
            "launch_sha256": request["launch_sha256"],
            "operator_authorization_sha256": "5" * 64,
            "native_request_path": str(request_path),
            "native_request_sha256": _sha(request_raw),
            "attestation_path": str(attestation_path),
            "attestation_sha256": attestation_sha,
            "manifest_path": str(manifest_path),
            "manifest_sha256": _sha(manifest_raw),
            "prior_stop_journal_sha256": request["prior_ready_owner_proof_sha256"],
        }
        authorization_path = control / "recovery" / "authorization.json"
        authorization_raw = (json.dumps(authorization, sort_keys=True, separators=(",", ":")) + "\n").encode()
        authorization_path.write_bytes(authorization_raw)
        return {
            "authorization_path": authorization_path,
            "authorization_sha256": _sha(authorization_raw),
            "request": request,
            "attestation": attestation,
            "request_raw": request_raw,
        }

    def test_control_volume_auth_and_canonical_attestation(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            fixture = self._document_fixture(root)
            with mock.patch.object(runtime_service, "CONTAINER_RECOVERY_CONTROL_ROOT", root / "control"), mock.patch.dict(
                os.environ,
                {
                    runtime_service.CONTAINER_RECOVERY_AUTHORIZATION_ENV: str(fixture["authorization_path"]),
                    runtime_service.CONTAINER_RECOVERY_AUTHORIZATION_SHA256_ENV: fixture["authorization_sha256"],
                },
                clear=False,
            ):
                paths = runtime_service.RuntimePaths(
                    state=root,
                    storage=root,
                    runs=root / "runs",
                    store=root / "store",
                    state_root=root / "runtime-control",
                    runtime_services=root / "runtime-services",
                    config=root / "runtime-control" / "runtime-service" / "docker-all.json",
                )
                context = runtime_service._read_container_recovery_authorization(paths)
            self.assertEqual(context["request_sha256"], _sha(fixture["request_raw"]))
            self.assertEqual(
                context["attestation_sha256"],
                context["authorization"]["attestation_sha256"],
            )

    def test_authorization_digest_is_required_and_path_is_not_host_resolved(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            fixture = self._document_fixture(root)
            with mock.patch.object(runtime_service, "CONTAINER_RECOVERY_CONTROL_ROOT", root / "control"), mock.patch.dict(
                os.environ,
                {runtime_service.CONTAINER_RECOVERY_AUTHORIZATION_ENV: str(fixture["authorization_path"])},
                clear=False,
            ):
                paths = runtime_service.RuntimePaths(store=root / "store")
                with self.assertRaises(runtime_service.RuntimeServiceError):
                    runtime_service._read_container_recovery_authorization(paths)
                os.environ[runtime_service.CONTAINER_RECOVERY_AUTHORIZATION_SHA256_ENV] = fixture["authorization_sha256"]
                bad = dict(fixture)
                bad["authorization_path"] = Path("C:\\host\\authorization.json")
                with self.assertRaises(runtime_service.RuntimeServiceError):
                    runtime_service._read_container_recovery_authorization(paths, bad["authorization_path"])

    def test_stale_pending_marker_fails_closed_without_authorization(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            marker = root / "store" / "runtime-services" / "container-recovery" / ("a" * 64)
            marker.mkdir(parents=True)
            (marker / "receipt.json").write_text('{"status":"prepared"}\n', encoding="utf-8")
            paths = runtime_service.RuntimePaths(store=root / "store")
            with mock.patch.dict(
                os.environ,
                {
                    runtime_service.CONTAINER_RECOVERY_AUTHORIZATION_ENV: "",
                    runtime_service.CONTAINER_RECOVERY_AUTHORIZATION_SHA256_ENV: "",
                },
                clear=False,
            ):
                with self.assertRaises(runtime_service.RuntimeServiceError):
                    runtime_service.recover_container_namespace(paths)

    def test_archive_accepts_drained_owner_only_with_authenticated_drain_digest(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            fixture = self._document_fixture(root)
            owner = fixture["request"]["expected_owner"]
            owner_raw = (json.dumps(owner, sort_keys=True) + "\n").encode()
            failed_owner = {**owner, "state": "failed"}
            failed_owner_raw = (json.dumps(failed_owner, sort_keys=True) + "\n").encode()
            drained_owner = {**owner, "state": "drained"}
            drained_owner_raw = (json.dumps(drained_owner, sort_keys=True) + "\n").encode()
            request_sha = "9" * 64
            config_raw = b"configuration\n"
            config_sha = _sha(config_raw)
            request = {
                "owner_sha256": _sha(owner_raw),
                "config_sha256": config_sha,
                "ledger_snapshot_sha256": "a" * 64,
                "prior_ready_owner_proof_sha256": "b" * 64,
                "application": {"mode": "external_only", "raw_sha256": "c" * 64},
                "expected_owner": owner,
            }
            authorization = {
                "owner_sha256": request["owner_sha256"],
                "config_sha256": config_sha,
            }
            store = root / "store"
            runtime_services = store / "runtime-services"
            runtime_services.mkdir(parents=True)
            paths = runtime_service.RuntimePaths(
                store=store,
                runtime_services=runtime_services,
            )
            owner_path = runtime_services / "OWNER.json"
            owner_path.write_bytes(drained_owner_raw)
            archive_root = (
                store / "runtime-services" / "container-recovery" / request_sha / "archive"
            )
            archive_root.mkdir(parents=True)
            archived_files = {}
            for source in runtime_service._container_recovery_expected_sources(owner):
                if source == "configuration.json":
                    source_raw = config_raw
                elif source == "runtime-services/OWNER.json":
                    source_raw = owner_raw
                else:
                    source_raw = source.encode("utf-8") + b"\n"
                    live_path = runtime_service._store_relative_path(
                        paths, runtime_service.PurePosixPath(source)
                    )
                    live_path.parent.mkdir(parents=True, exist_ok=True)
                    live_path.write_bytes(source_raw)
                (archive_root / Path(source).name).write_bytes(source_raw)
                archived_files[source] = _sha(source_raw)
            attestation_sha = "d" * 64
            archive_manifest = {
                "schema_version": runtime_service.CONTAINER_RECOVERY_ARCHIVE_SCHEMA,
                "request_sha256": request_sha,
                "config_sha256": config_sha,
                "attestation_sha256": attestation_sha,
                "ledger_snapshot_sha256": request["ledger_snapshot_sha256"],
                "prior_ready_owner_proof_sha256": request["prior_ready_owner_proof_sha256"],
                "application": request["application"],
                "files": archived_files,
                "absent_sources": {},
            }
            archive_manifest_raw = (
                json.dumps(archive_manifest, sort_keys=True, indent=2) + "\n"
            ).encode()
            (archive_root / "manifest.json").write_bytes(archive_manifest_raw)
            result = {
                "owner_sha256_after": _sha(failed_owner_raw),
                "archived_evidence_path": str(archive_root / "manifest.json"),
                "archived_evidence_sha256": _sha(archive_manifest_raw),
                "archived_files": archived_files,
                "archived_absent_sources": {},
            }
            context = {
                "request": request,
                "authorization": authorization,
                "request_sha256": request_sha,
                "attestation_sha256": attestation_sha,
                "expected_owner": owner,
            }
            runtime_service._validate_container_recovery_archive(
                paths,
                context,
                result,
                authenticated_drained_owner_sha256=_sha(drained_owner_raw),
            )
            with self.assertRaises(runtime_service.RuntimeServiceError):
                runtime_service._validate_container_recovery_archive(paths, context, result)

    def test_entrypoint_orders_container_recovery_before_configuration(self):
        source = (RUNTIME_ROOT / "entrypoint.py").read_text(encoding="utf-8")
        self.assertLess(source.index("initialize_accepted_store(paths)"), source.index("recover_container_namespace(paths)"))
        self.assertLess(source.index("recover_container_namespace(paths)"), source.index("ensure_configuration(paths)"))
        self.assertIn("container_recovery_authorization", source)


if __name__ == "__main__":
    unittest.main()
