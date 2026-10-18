#!/usr/bin/env python3
"""Focused pure-contract tests for scripts/docker_orphan_recovery.py."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
import uuid

import docker_orphan_recovery as recovery
import docker_backend_volume_cache as volume_cache

from docker_orphan_recovery import (
    ORPHAN_REQUEST_SCHEMA,
    PACKAGE_PROBE_SCHEMA,
    TEARDOWN_ATTESTATION_SCHEMA,
    OrphanRecoveryError,
    build_orphan_request,
    build_teardown_attestation,
    canonical_json_sha256,
    finalize,
    validate_cached_package_binding,
    validate_orphan_request,
    validate_teardown_attestation,
    write_immutable_json,
    _value_digest,
)


def _raw_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _v2_cache_fixture(root: Path) -> dict[str, object]:
    profile: dict[str, object] = {
        "schema": volume_cache.SCHEMA,
        "profile": volume_cache.PROFILE,
        "state": "ready",
        "project_id": "fullmag",
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
        },
        "build_root": volume_cache.BUILD_TARGET,
        "mount_root": volume_cache.BUILD_TARGET,
        "package_root": volume_cache.PACKAGE_TARGET,
    }
    profile["environment"] = volume_cache._cache_environment(profile)
    profile["mounts"] = volume_cache.mount_specs(profile)
    documents: dict[str, dict[str, object]] = {}
    for role in (volume_cache.BUILD_VOLUME_ROLE, volume_cache.PACKAGE_VOLUME_ROLE):
        documents[role] = {
            "Name": profile["volume_names"][role],
            "Driver": "local",
            "Options": {},
            "Scope": "local",
            "Mountpoint": "/var/lib/docker/volumes/" + str(profile["volume_names"][role]) + "/_data",
            "Labels": volume_cache.volume_labels(profile, role),
        }
    profile["volume_documents"] = documents
    maintenance = {
        "schema": volume_cache.MAINTENANCE_RECEIPT_SCHEMA,
        "profile": volume_cache.PROFILE,
        "state": "ready",
        "project_id": profile["project_id"],
        "cache_key": profile["cache_key"],
        "unit_key": profile["unit_key"],
        "owner_id": profile["owner_id"],
        "cargo_profile": profile["cargo_profile"],
        "runtime_image_id": profile["runtime_image_id"],
        "toolchain_image_id": profile["toolchain_image_id"],
        "volume_names": dict(profile["volume_names"]),
        "markers": {
            role: {
                "schema": volume_cache.OWNER_SCHEMA,
                "state": "owned",
                "unit_key": profile["unit_key"],
                "owner_id": profile["owner_id"],
                "role": role,
                "volume_name": profile["volume_names"][role],
                "uid": 65532,
                "gid": 65532,
            }
            for role in (volume_cache.BUILD_VOLUME_ROLE, volume_cache.PACKAGE_VOLUME_ROLE)
        },
        "probe": {
            "schema": volume_cache.PROBE_SCHEMA,
            "state": "passed",
            "owner_uid": 65532,
            "owner_gid": 65532,
            "volumes": {
                role: {
                    "regular_marker": True,
                    "writable": True,
                    "readonly_reopen": True,
                    "no_reparse": True,
                }
                for role in (volume_cache.BUILD_VOLUME_ROLE, volume_cache.PACKAGE_VOLUME_ROLE)
            },
        },
    }
    profile["maintenance_receipt"] = maintenance
    receipt_path = root / "backend-volume-cache-receipt.json"
    receipt = {
        "schema": volume_cache.SCHEMA,
        "profile": volume_cache.PROFILE,
        "state": "ready",
        "project_id": profile["project_id"],
        "worktree_id": profile["worktree_id"],
        "cache_key": profile["cache_key"],
        "unit_key": profile["unit_key"],
        "owner_id": profile["owner_id"],
        "cargo_profile": profile["cargo_profile"],
        "runtime_image_id": profile["runtime_image_id"],
        "toolchain_image_id": profile["toolchain_image_id"],
        "volume_names": dict(profile["volume_names"]),
        "mounts": list(profile["mounts"]),
        "package_root": volume_cache.PACKAGE_TARGET,
        "build_root": volume_cache.BUILD_TARGET,
        "volume_documents": documents,
        "maintenance_receipt": maintenance,
        "host_receipt_path": str(receipt_path),
    }
    receipt_path.write_bytes(_raw_json(receipt))
    profile["receipt"] = receipt
    profile["receipt_path"] = str(receipt_path)
    overlay_path = root / "compose.backend-cache-v2.json"
    overlay = volume_cache.overlay(profile)
    overlay_path.write_bytes(_raw_json(overlay))
    profile["overlay"] = overlay
    profile["compose_overlay"] = str(overlay_path)
    profile["compose_overlay_sha256"] = hashlib.sha256(overlay_path.read_bytes()).hexdigest()
    maintenance_path = root / "compose.backend-cache-v2-maintenance.json"
    maintenance_overlay = volume_cache.maintenance_overlay(profile)
    maintenance_path.write_bytes(_raw_json(maintenance_overlay))
    profile["maintenance_overlay"] = maintenance_overlay
    profile["maintenance_compose_overlay"] = str(maintenance_path)
    return profile


class OrphanRecoveryContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="fullmag-orphan-contract-"))
        self.package = self.root / "package"
        self.package.mkdir()
        receipt = {"schema": "fullmag.direct-compose.backend-build-receipt.v1", "state": "succeeded"}
        self.receipt_path = self.package / "backend-build-receipt.json"
        self.receipt_path.write_bytes(_raw_json(receipt))
        self.engine_id = "sha256:" + "1" * 64
        self.engine = {"ID": self.engine_id}
        self.container_id = "a" * 64
        self.image_id = "sha256:" + "2" * 64
        self.project = "fullmag-test"
        self.state_bind = {"Type": "bind", "Source": str(self.root / "state"), "Destination": "/state", "RW": True}
        self.package_bind = {"Type": "bind", "Source": str(self.package), "Destination": "/opt/fullmag/package", "RW": True}
        self.before = {
            "Id": self.container_id,
            "Name": "/fullmag-backend",
            "Image": self.image_id,
            "Config": {
                "User": "65532:65532",
                "Env": ["FULLMAG_DOCKER_ROLE=backend"],
                "Labels": {
                    "com.docker.compose.project": self.project,
                    "com.docker.compose.service": "backend",
                    "org.fullmag.runtime": "docker-all-gpu-v1",
                },
            },
            "HostConfig": {
                "Privileged": False,
                "ReadonlyRootfs": True,
                "PidMode": None,
                "IpcMode": "private",
                "NetworkMode": "bridge",
                "Devices": [],
                "CapAdd": [],
                "DeviceRequests": [{"Driver": "nvidia", "Count": -1, "Capabilities": [["gpu"]]}],
            },
            "Mounts": [self.state_bind, self.package_bind],
            "State": {"Status": "running", "Running": True, "Pid": 4217, "FinishedAt": ""},
        }
        self.paths: dict[str, Path] = {}

        def record(name: str, value: object) -> dict[str, object]:
            path = self.root / f"{name}.json"
            raw = _raw_json(value)
            path.write_bytes(raw)
            self.paths[name] = path
            return {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest()}

        def record_canonical(name: str, value: object) -> dict[str, object]:
            path = self.root / f"{name}.json"
            path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            self.paths[name] = path
            return {"path": str(path), "sha256": canonical_json_sha256(value)}

        self.owner_value = {
            "state": "failed",
            "pid": 4217,
            "process_start_token": "owner-start-1",
            "children": [
                {"role": "compute", "status": "exited_failure"},
                {"role": "preparation", "status": "exited_success"},
            ],
        }
        owner = record("owner", self.owner_value)
        owner["value"] = self.owner_value
        self.run_id = "run-orphan"
        self.task_id = "task-orphan"
        self.store_id = "sha256:" + "3" * 64
        self.lease_token = "lease-orphan"
        self.config_value = {"schema": "runtime_service_config.v1", "store_root": "/state", "target_id": "native-local"}
        self.run_receipt = record("run-receipt", {"state": "running", "run_id": self.run_id})
        config = record("config", self.config_value)
        launch = record("launch", {"schema": "launch.v1", "run_id": self.run_id})
        auth = record("host-authorization", {"schema": "host.authorization.v2", "project": self.project})
        windows = record("windows-folder-host", {"schema": "windows-folder-host.v1", "owner": self.project})
        mount = record("host-ledger-attestation", {"schema": "host-ledger.v2", "filesystem": "ext4"})
        self.digest_records = {
            "reservation_request": record_canonical("reservation-request", {"request": "orphan", "run_id": self.run_id}),
            "reservation_before": record_canonical("reservation-before", {"state": "committed", "run_id": self.run_id}),
            "lease_before": record_canonical("lease-before", {"state": "active", "lease_token": self.lease_token}),
            "runtime_generation": record("runtime-generation", {"generation": "g1"}),
            "run_receipt": self.run_receipt,
            "config": config,
            "launch": launch,
            "host_authorization": auth,
            "windows_folder_host": windows,
            "mount_attestation": mount,
        }
        self.pins = {
            "request_id": "00000000-0000-4000-8000-000000000001",
            "compose_project": self.project,
            "backend": {
                "container_id": self.container_id,
                "image_id": self.image_id,
                "compose_project": self.project,
                "scope": "dedicated_parent",
                "sole_worker_scope": True,
                "user": "65532:65532",
                "state_bind": self.state_bind,
                "package_bind": self.package_bind,
                "config_sha256": canonical_json_sha256(self.before["Config"]),
            },
            "run": {
                "store_id": self.store_id,
                "host_id": "host-orphan",
                "run_id": self.run_id,
                "task_id": self.task_id,
                "attempt_id": "attempt-orphan",
                "ownership_epoch": 1,
                "resource_id": "gpu-orphan",
                "lease_token": self.lease_token,
            },
            "owner": owner,
            "worker_launch_gate": {"state": "consumed", "token": "00000000-0000-4000-8000-000000000002"},
            "cached_package": {
                "root": str(self.package),
                "receipt_path": str(self.receipt_path),
                "receipt_sha256": hashlib.sha256(self.receipt_path.read_bytes()).hexdigest(),
                "package_sha256": "4" * 64,
                "read_only": True,
                "state": "succeeded",
                "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            },
            "quiescence": {
                "schema": "fullmag.shared-ledger-quiescence.v2",
                "protocol_version": 2,
                "all_shared_ledger_clients_quiescent": True,
                "legacy_clients_allowed": False,
                "manifest_sha256": "5" * 64,
                "groups": [{"project": self.project, "active_containers": 0, "active_native_owners": 0, "active_leases": 0, "active_reservations": 0}],
            },
        }
        self.pins.update(self.digest_records)
        self.pins["owner"]["canonical"] = False
        self.pins["config"]["canonical"] = False
        self.request = build_orphan_request(self.pins, self.engine, self.before)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def _after(self) -> dict[str, object]:
        after = deepcopy(self.before)
        after["State"] = {"Status": "exited", "Running": False, "Pid": 0, "FinishedAt": "2026-10-17T23:00:00Z"}
        return after

    def _attestation(self) -> dict[str, object]:
        device_requests = self.before["HostConfig"]["DeviceRequests"]
        manifest_value = {
            "schema": "docker-teardown-manifest.v1",
            "before": {
                "container_id": self.container_id,
                "image_id": self.image_id,
                "service": "backend",
                "role": "backend",
                "user": "65532:65532",
                "state": "running",
                "pid": 4217,
                "private_pid_namespace": True,
                "host_pid": False,
                "device_requests": device_requests,
            },
            "after": {
                "container_id": self.container_id,
                "image_id": self.image_id,
                "service": "backend",
                "role": "backend",
                "user": "65532:65532",
                "state": "exited",
                "pid": 0,
                "finished_at": "2026-10-17T23:00:00Z",
                "descendant_count": 0,
                "private_pid_namespace": True,
                "host_pid": False,
                "device_requests": device_requests,
            },
            "device_release": {
                "resource_id": "gpu-orphan",
                "mapping_sha256": "6" * 64,
                "mapping_detached": True,
            },
        }
        manifest_path = self.root / "teardown-manifest.json"
        manifest_path.write_bytes(_raw_json(manifest_value))
        manifest = {
            "path": str(manifest_path),
            "sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        }
        return build_teardown_attestation(self.request, self.engine, self.engine, self.before, self._after(), manifest)

    def _native_completed(self) -> dict[str, object]:
        return {
            "schema_version": "runtime_service_orphan_teardown_result.v1",
            "status": "completed",
            "request_sha256": canonical_json_sha256(self.request),
            "started": False,
            "solve_replayed": False,
            "startup_replayed": False,
            "result": {
                "identity": {
                    "store_id": self.request["store_id"],
                    "run_id": self.request["run_id"],
                    "task_id": self.request["task_id"],
                    "resource_id": self.request["resource_id"],
                    "owner": {
                        "kind": "solver",
                        "attempt_id": self.request["attempt_id"],
                        "ownership_epoch": self.request["ownership_epoch"],
                    },
                    "lease_token": self.request["lease_token"],
                },
                "request_sha256": self.request["reservation_request_sha256"],
                "state": "released",
                "release_proof_sha256": "6" * 64,
                "worker_launch_gate": deepcopy(self.request["worker_launch_gate"]),
            },
        }

    def test_builds_exact_native_request_without_self_digest(self) -> None:
        self.assertEqual(self.request["schema_version"], ORPHAN_REQUEST_SCHEMA)
        self.assertNotIn("request_sha256", self.request)
        self.assertEqual(
            set(self.request),
            {
                "schema_version", "request_id", "store_id", "host_id", "run_id", "task_id",
                "attempt_id", "ownership_epoch", "resource_id", "lease_token",
                "reservation_request_sha256", "reservation_before_sha256", "lease_before_sha256",
                "runtime_generation_sha256", "worker_launch_gate", "run_receipt_sha256",
                "owner_sha256", "config_sha256", "launch_sha256", "host_authorization_sha256",
                "windows_folder_host_sha256", "mount_attestation_sha256", "docker_engine_id_sha256",
                "containers", "expected",
            },
        )
        self.assertEqual(self.request["worker_launch_gate"]["state"], "consumed")
        self.assertEqual(self.request["containers"][0]["container_id"], self.container_id)
        self.assertEqual(self.request["containers"][0]["device_requests"][0]["Count"], -1)
        self.assertEqual(validate_orphan_request(self.request)["run_id"], self.run_id)

    def test_pinned_engine_digest_must_match_observed_engine(self) -> None:
        for pin in ({"docker_engine_id_sha256": "7" * 64},
                    {"engine": {"sha256": "7" * 64}}):
            with self.subTest(pin=pin), self.assertRaises(OrphanRecoveryError):
                build_orphan_request({**self.pins, **pin}, self.engine, self.before)

    def test_uuid_engine_identity_is_hashed_without_rewriting(self) -> None:
        self.engine_id = "81a2002d-4c88-48aa-b4da-fed771788cfa"
        self.engine = {"ID": self.engine_id}
        self.request = build_orphan_request(self.pins, self.engine, self.before)
        self.assertEqual(
            self.request["docker_engine_id_sha256"],
            hashlib.sha256(self.engine_id.encode("utf-8")).hexdigest(),
        )
        attestation = self._attestation()
        self.assertEqual(
            validate_teardown_attestation(self.request, attestation)["result"],
            "authoritative_teardown",
        )

    def test_engine_identity_rejects_noncanonical_or_placeholder_values(self) -> None:
        for value in ("", "unknown", "00000000-0000-0000-0000-000000000000",
                      "81A2002D-4C88-48AA-B4DA-FED771788CFA", "0" * 64,
                      "sha256:" + "0" * 64):
            with self.subTest(value=value), self.assertRaises(OrphanRecoveryError):
                build_orphan_request(self.pins, {"ID": value}, self.before)

    def test_attestation_binds_exact_request_and_factual_exit(self) -> None:
        attestation = self._attestation()
        self.assertEqual(attestation["schema_version"], TEARDOWN_ATTESTATION_SCHEMA)
        self.assertEqual(validate_teardown_attestation(self.request, attestation)["result"], "authoritative_teardown")
        receipt = finalize(self.request, attestation, self._native_completed())
        self.assertEqual(receipt["outcome"], "await_reconciliation")
        bad_after = self._after()
        bad_after["State"]["Pid"] = 99
        manifest = self.root / "teardown-manifest.json"
        manifest.write_bytes(_raw_json({"schema": "docker-teardown-manifest.v1"}))
        with self.assertRaises(OrphanRecoveryError):
            build_teardown_attestation(self.request, self.engine, self.engine, self.before, bad_after, {"path": str(manifest), "sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(), "device_release": {"resource_id": "gpu-orphan", "mapping_sha256": "6" * 64, "mapping_detached": True}})

    def test_rejects_tampered_request_gate_engine_and_package(self) -> None:
        tampered = deepcopy(self.request)
        tampered["worker_launch_gate"]["state"] = "closed"
        with self.assertRaises(OrphanRecoveryError):
            validate_orphan_request(tampered)
        tampered = deepcopy(self.request)
        tampered["docker_engine_id_sha256"] = "7" * 64
        with self.assertRaises(OrphanRecoveryError):
            build_teardown_attestation(tampered, self.engine, self.engine, self.before, self._after(), {"path": str(self.root / "missing"), "sha256": "8" * 64, "device_release": {"resource_id": "gpu-orphan", "mapping_sha256": "6" * 64, "mapping_detached": True}})
        self.receipt_path.write_bytes(_raw_json({"schema": "fullmag.direct-compose.backend-build-receipt.v1", "state": "failed"}))
        with self.assertRaises(OrphanRecoveryError):
            validate_cached_package_binding(self.pins["cached_package"])

    def test_rejects_replay_and_immutable_history_overwrite(self) -> None:
        attestation = self._attestation()
        native = self._native_completed()
        native["started"] = True
        with self.assertRaises(OrphanRecoveryError):
            finalize(self.request, attestation, native)
        history = self.root / "history.json"
        record = {"schema": "history.v1", "request_sha256": canonical_json_sha256(self.request)}
        first = write_immutable_json(history, record)
        self.assertEqual(first, write_immutable_json(history, record))
        with self.assertRaises(OrphanRecoveryError):
            write_immutable_json(history, {"schema": "history.v1", "request_sha256": "9" * 64})

        partial = history.parent / f".{history.name}.crashed-write.tmp"
        partial.write_bytes(b'{"schema":')
        replay = history.parent / "replayed-history.json"
        self.assertEqual(
            write_immutable_json(replay, record),
            hashlib.sha256(_raw_json(record)).hexdigest(),
        )
        self.assertEqual(partial.read_bytes(), b'{"schema":')

    def test_immutable_publication_does_not_expose_partial_final_on_interruption(self) -> None:
        history = self.root / "interrupted-history.json"
        record = {"schema": "history.v1", "request_sha256": "a" * 64}

        def interrupt(temporary: Path, candidate: Path) -> None:
            self.assertTrue(temporary.exists())
            temporary.write_bytes(b'{"partial":')
            raise OSError("simulated publication interruption")

        with patch.object(recovery, "_publish_no_replace", side_effect=interrupt):
            with self.assertRaises(OrphanRecoveryError):
                write_immutable_json(history, record)
        self.assertFalse(history.exists())
        self.assertEqual(list(history.parent.glob(f".{history.name}.*.tmp")), [])
        self.assertEqual(
            write_immutable_json(history, record),
            hashlib.sha256(_raw_json(record)).hexdigest(),
        )

    def test_finalize_requires_exact_native_completion_and_release_proof(self) -> None:
        attestation = self._attestation()
        valid = self._native_completed()
        finalize(self.request, attestation, valid)
        for field in ("schema_version", "request_sha256", "started", "solve_replayed", "startup_replayed"):
            tampered = deepcopy(valid)
            tampered.pop(field)
            with self.assertRaises(OrphanRecoveryError):
                finalize(self.request, attestation, tampered)
        tampered = deepcopy(valid)
        tampered["unexpected"] = True
        with self.assertRaises(OrphanRecoveryError):
            finalize(self.request, attestation, tampered)
        for field, value in (("status", "authoritative_teardown"), ("started", True), ("solve_replayed", True), ("startup_replayed", True)):
            tampered = deepcopy(valid)
            tampered[field] = value
            with self.assertRaises(OrphanRecoveryError):
                finalize(self.request, attestation, tampered)
        for field, value in (
            ("state", "committed"),
            ("release_proof_sha256", "0" * 64),
            ("worker_launch_gate", {"state": "closed"}),
        ):
            tampered = deepcopy(valid)
            tampered["result"][field] = value
            with self.assertRaises(OrphanRecoveryError):
                finalize(self.request, attestation, tampered)
        tampered = deepcopy(valid)
        tampered["result"]["identity"]["lease_token"] = "lease-other"
        with self.assertRaises(OrphanRecoveryError):
            finalize(self.request, attestation, tampered)

    def test_requires_quiescence_and_verified_package(self) -> None:
        without_quiescence = deepcopy(self.pins)
        without_quiescence.pop("quiescence")
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(without_quiescence, self.engine, self.before)
        without_package = deepcopy(self.pins)
        without_package.pop("cached_package")
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(without_package, self.engine, self.before)
        canonical_record = self.root / "canonical-record.json"
        value = {"z": 2, "a": 1}
        canonical_record.write_text(json.dumps(value, indent=2), encoding="utf-8")
        self.assertEqual(
            canonical_json_sha256(value),
            _value_digest(
                {"path": str(canonical_record), "value": value, "canonical": True, "sha256": canonical_json_sha256(value)},
                "canonical record",
            ),
        )

    def test_reservation_and_lease_hashes_are_canonical_over_pretty_json(self) -> None:
        self.assertEqual(
            self.request["reservation_before_sha256"],
            canonical_json_sha256({"state": "committed", "run_id": self.run_id}),
        )
        self.assertEqual(
            self.request["lease_before_sha256"],
            canonical_json_sha256({"state": "active", "lease_token": self.lease_token}),
        )
        tampered = deepcopy(self.pins)
        pretty_path = self.paths["reservation-before"]
        tampered["reservation_before"] = {
            "path": str(pretty_path),
            "sha256": hashlib.sha256(pretty_path.read_bytes()).hexdigest(),
        }
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(tampered, self.engine, self.before)

    def test_rejects_container_namespace_sharing(self) -> None:
        for field in ("IpcMode", "NetworkMode"):
            inspect = deepcopy(self.before)
            inspect["HostConfig"][field] = "container:" + "b" * 64
            with self.assertRaises(OrphanRecoveryError):
                build_orphan_request(self.pins, self.engine, inspect)

    def test_vm_package_requires_bound_same_image_probe(self) -> None:
        artifacts = [{"path": "bin/fullmag-api", "size": 11, "sha256": "a" * 64, "mode": "100755"}]
        receipt = {
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "state": "succeeded",
            "execution_lanes": {lane: {"status": "compiled"} for lane in ("fdm-cpu", "fdm-gpu", "fem-cpu", "fem-gpu")},
            "artifacts": artifacts,
        }
        package = {
            "root": "/mnt/fullmag-backend-cache-vm/package",
            "receipt_path": "/mnt/fullmag-backend-cache-vm/package/backend-build-receipt.json",
            "receipt_sha256": "b" * 64,
            "package_sha256": "c" * 64,
            "read_only": True,
            "state": "succeeded",
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "package_probe": {
                "schema": PACKAGE_PROBE_SCHEMA,
                "container_id": self.container_id,
                "image_id": self.image_id,
                "package_root": "/opt/fullmag/package",
                "receipt_path": "/opt/fullmag/package/backend-build-receipt.json",
                "receipt_sha256": "b" * 64,
                "package_sha256": "c" * 64,
                "read_only_mount": True,
                "state": "succeeded",
                "receipt": receipt,
                "artifacts": artifacts,
            },
        }
        validated = validate_cached_package_binding(
            package,
            expected_container_id=self.container_id,
            expected_image_id=self.image_id,
        )
        self.assertEqual(validated["package_probe"]["schema"], PACKAGE_PROBE_SCHEMA)
        build_package = deepcopy(package)
        build_package["root"] = str(self.package)
        build_package["receipt_path"] = str(self.receipt_path)
        probe_pins = deepcopy(self.pins)
        probe_pins["cached_package"] = build_package
        request = build_orphan_request(probe_pins, self.engine, self.before)
        self.assertEqual(request["containers"][0]["container_id"], self.container_id)
        without_probe = deepcopy(package)
        without_probe.pop("package_probe")
        with self.assertRaises(OrphanRecoveryError):
            validate_cached_package_binding(without_probe, verify_filesystem=False)
        wrong_container = deepcopy(package)
        wrong_container["package_probe"]["container_id"] = "b" * 64
        with self.assertRaises(OrphanRecoveryError):
            validate_cached_package_binding(
                wrong_container,
                expected_container_id=self.container_id,
                expected_image_id=self.image_id,
            )

    def _v2_request_inputs(self) -> tuple[dict[str, object], dict[str, object], dict[str, object], dict[str, object]]:
        cache_root = self.root / "v2-cache"
        cache_root.mkdir()
        cache = _v2_cache_fixture(cache_root)
        before = deepcopy(self.before)
        volume_mounts = [
            {
                "Type": "volume",
                "Name": cache["volume_names"][volume_cache.BUILD_VOLUME_ROLE],
                "Source": "/var/lib/docker/volumes/build/_data",
                "Destination": volume_cache.BUILD_TARGET,
                "RW": True,
            },
            {
                "Type": "volume",
                "Name": cache["volume_names"][volume_cache.PACKAGE_VOLUME_ROLE],
                "Source": "/var/lib/docker/volumes/package/_data",
                "Destination": volume_cache.PACKAGE_TARGET,
                "RW": True,
            },
        ]
        before["Mounts"] = [self.state_bind, *volume_mounts]
        pins = deepcopy(self.pins)
        pins["backend"] = {
            **pins["backend"],
            "package_bind": volume_mounts[1],
        }
        pins["backend_cache"] = cache
        artifacts = [{
            "path": "bin/fullmag-runtime-service",
            "size": 1,
            "sha256": "6" * 64,
            "mode": "100755",
        }]
        package_receipt = {
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "state": "succeeded",
            "execution_lanes": {
                lane: {"status": "compiled"}
                for lane in ("fdm-cpu", "fdm-gpu", "fem-cpu", "fem-gpu")
            },
            "artifacts": artifacts,
        }
        pins["cached_package"] = {
            "root": volume_cache.PACKAGE_TARGET,
            "receipt_path": volume_cache.PACKAGE_TARGET + "/backend-build-receipt.json",
            "receipt_sha256": "7" * 64,
            "package_sha256": "8" * 64,
            "read_only": True,
            "state": "succeeded",
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "package_probe": {
                "schema": PACKAGE_PROBE_SCHEMA,
                "container_id": self.container_id,
                "image_id": self.image_id,
                "package_root": volume_cache.PACKAGE_TARGET,
                "receipt_path": volume_cache.PACKAGE_TARGET + "/backend-build-receipt.json",
                "receipt_sha256": "7" * 64,
                "package_sha256": "8" * 64,
                "read_only_mount": True,
                "state": "succeeded",
                "receipt": package_receipt,
                "artifacts": artifacts,
            },
        }
        return pins, self.engine, before, cache

    def test_v2_request_binds_exact_named_volume_pair_and_package_probe(self) -> None:
        pins, engine, before, cache = self._v2_request_inputs()
        request = build_orphan_request(pins, engine, before)
        self.assertEqual(request["containers"][0]["container_id"], self.container_id)
        self.assertEqual(cache["package_root"], volume_cache.PACKAGE_TARGET)
        self.assertNotIn("state_bind", request["containers"][0])
        after = deepcopy(before)
        after["State"] = {
            "Status": "exited",
            "Running": False,
            "Pid": 0,
            "FinishedAt": "2026-10-17T23:00:00Z",
        }
        device_requests = before["HostConfig"]["DeviceRequests"]
        manifest_value = {
            "schema": "docker-teardown-manifest.v1",
            "before": {
                "container_id": self.container_id,
                "image_id": self.image_id,
                "service": "backend",
                "role": "backend",
                "user": "65532:65532",
                "state": "running",
                "pid": before["State"]["Pid"],
                "private_pid_namespace": True,
                "host_pid": False,
                "device_requests": device_requests,
            },
            "after": {
                "container_id": self.container_id,
                "image_id": self.image_id,
                "service": "backend",
                "role": "backend",
                "user": "65532:65532",
                "state": "exited",
                "pid": 0,
                "finished_at": after["State"]["FinishedAt"],
                "descendant_count": 0,
                "private_pid_namespace": True,
                "host_pid": False,
                "device_requests": device_requests,
            },
            "device_release": {
                "resource_id": "gpu-orphan",
                "mapping_sha256": "6" * 64,
                "mapping_detached": True,
            },
        }
        manifest_path = self.root / "v2-teardown-manifest.json"
        manifest_path.write_bytes(_raw_json(manifest_value))
        manifest = {
            "path": str(manifest_path),
            "sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        }
        attestation = build_teardown_attestation(
            request, engine, engine, before, after, manifest
        )
        self.assertEqual(
            validate_teardown_attestation(request, attestation)["result"],
            "authoritative_teardown",
        )

    def test_v2_request_rejects_foreign_volume_or_unknown_cache_or_nocopy(self) -> None:
        pins, engine, before, cache = self._v2_request_inputs()
        foreign = deepcopy(pins)
        foreign["backend"]["package_bind"]["Name"] = "foreign-package-volume"
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(foreign, engine, before)

        unknown = deepcopy(pins)
        unknown["backend_cache"]["schema"] = "fullmag.backend-build-cache.unknown"
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(unknown, engine, before)

        nocopy = deepcopy(pins)
        nocopy["backend_cache"]["mounts"][0]["volume"]["nocopy"] = False
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(nocopy, engine, before)

        overlay = deepcopy(pins)
        overlay["backend_cache"]["compose_overlay_sha256"] = "9" * 64
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(overlay, engine, before)

        labels = deepcopy(pins)
        labels["backend_cache"]["volume_documents"][
            volume_cache.PACKAGE_VOLUME_ROLE
        ]["Labels"][volume_cache.LABEL_ROLE] = volume_cache.BUILD_VOLUME_ROLE
        with self.assertRaises(OrphanRecoveryError):
            build_orphan_request(labels, engine, before)


if __name__ == "__main__":
    unittest.main()
