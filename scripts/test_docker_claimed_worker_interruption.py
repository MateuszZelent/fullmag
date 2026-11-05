from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid

import docker_claimed_worker_interruption as claimed
import docker_orphan_recovery as recovery


def _sha(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


class ClaimedWorkerInterruptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-claimed-interruption-")
        self.root = Path(self.temp.name)
        self.engine_id = "sha256:" + "1" * 64
        self.engine = {"ID": self.engine_id}
        self.container_id = "c" * 64
        self.image_id = "sha256:" + "2" * 64
        self.project = "fullmag-test"
        self.started_at = "2026-11-05T10:00:00Z"
        self.finished_at = "2026-11-05T10:05:00Z"
        self.gpu_uuid = "GPU-00000000-0000-4000-8000-000000000001"
        self.configured_placement = {"gpu_uuid": self.gpu_uuid, "device_access": "gpu"}
        self.device_release_mapping_sha256 = recovery.canonical_json_sha256(
            self.configured_placement
        )
        self.device_requests = [
            {"Driver": "nvidia", "Count": -1, "Capabilities": [["gpu"]]}
        ]
        self.state_bind = {
            "Type": "bind", "Source": str(self.root / "state"),
            "Destination": "/state", "RW": True,
        }
        self.package_bind = {
            "Type": "bind", "Source": str(self.root / "package"),
            "Destination": "/opt/fullmag/package", "RW": True,
        }
        self.config = {
            "User": "65532:65532",
            "Env": ["FULLMAG_DOCKER_ROLE=backend"],
            "Labels": {
                "com.docker.compose.project": self.project,
                "com.docker.compose.service": "backend",
                "org.fullmag.runtime": "docker-all-gpu-v1",
            },
        }
        self.before = {
            "Id": self.container_id,
            "Name": "/arbitrary-name-backend",  # Names never establish sole-worker identity.
            "Image": self.image_id,
            "Config": deepcopy(self.config),
            "HostConfig": {
                "Privileged": False,
                "ReadonlyRootfs": True,
                "PidMode": None,
                "IpcMode": "private",
                "NetworkMode": "bridge",
                "Devices": [],
                "CapAdd": [],
                "DeviceRequests": deepcopy(self.device_requests),
            },
            "Mounts": [self.state_bind, self.package_bind],
            "State": {
                "Status": "running", "Running": True, "Pid": 4217,
                "StartedAt": self.started_at, "FinishedAt": "",
            },
        }
        self.after = deepcopy(self.before)
        self.after["State"] = {
            "Status": "exited", "Running": False, "Pid": 0,
            "StartedAt": self.started_at, "FinishedAt": self.finished_at,
        }
        self.request = self._request()
        self.preserved_files = self._preserved_files_manifest()
        self.inspection_manifest = self._inspection_manifest()
        self.manifest_arg = {
            "inspection_manifest": self.inspection_manifest,
            "preserved_files_manifest": self.preserved_files,
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _request(self) -> dict[str, object]:
        pins = {
            name: _sha(f"pin:{name}")
            for name in (
                "owner_sha256", "config_sha256", "process_receipt_sha256",
                "launch_sha256", "journal_sha256", "inbox_sha256",
                "execution_started_sha256", "supervisor_slot_sha256",
                "package_receipt_sha256", "executable_sha256",
                "source_snapshot_sha256", "mount_attestation_sha256",
                "preserved_files_manifest_sha256",
            )
        }
        pins["config_sha256"] = _sha(b"native service configuration bytes")
        pins["execution_started_sha256"] = _sha(b"started receipt")
        identity = {
            "store_id": "sha256:" + "3" * 64,
            "host_id": "host-01",
            "run_id": "run-01",
            "task_id": "task-01",
            "attempt_id": "attempt-01",
            "ownership_epoch": 2,
            "resource_id": "gpu-01",
            "lease_token": "lease-01",
            "reservation_request_sha256": _sha("reservation request"),
            "reservation_before_sha256": _sha("reservation before"),
            "lease_before_sha256": _sha("lease before"),
            "runtime_generation_sha256": _sha("runtime generation"),
        }
        root_relative = (
            "runs/run-01/worker-attempts/task-01/attempt-01/epoch-2"
        )
        self._root_relative = root_relative
        files = {
            "worker_execution_started.v1.json": {
                "bytes": len(b"started receipt"),
                "sha256": pins["execution_started_sha256"],
            },
            "results/partial.csv": {"bytes": 8, "sha256": _sha("partial\n")},
        }
        preserved = {
            "schema_version": "claimed_worker_preserved_files.v1",
            "root_relative": root_relative,
            "files": files,
        }
        pins["preserved_files_manifest_sha256"] = recovery.canonical_json_sha256(preserved)
        self._request_identity = identity
        self._request_pins = pins
        return {
            "schema_version": claimed.REQUEST_SCHEMA,
            "request_id": "00000000-0000-4000-8000-000000000001",
            "identity": identity,
            "consumed_launch_token": "00000000-0000-4000-8000-000000000002",
            "catalog_before_sha256": _sha("catalog before"),
            "catalog_revision": 7,
            "expected_task": {
                "task_id": identity["task_id"],
                "input_fingerprint": _sha("input"),
                "lifecycle": "running",
                "attempt_id": identity["attempt_id"],
                "ownership_epoch": identity["ownership_epoch"],
                "resource_id": identity["resource_id"],
            },
            "pins": pins,
            "docker_engine_id_sha256": _sha(self.engine_id),
            "device_release_mapping_sha256": self.device_release_mapping_sha256,
            "gpu_uuid": self.gpu_uuid,
            "container": {
                "scope": "dedicated_parent",
                "container_id": self.container_id,
                "image_id": self.image_id,
                "compose_project": self.project,
                "service": "backend",
                "config_sha256": recovery.canonical_json_sha256(self.config),
                "private_pid_namespace": True,
                "host_pid": False,
                "sole_worker_scope": True,
                "device_requests": deepcopy(self.device_requests),
            },
            "container_started_at": self.started_at,
        }

    def _preserved_files_manifest(self) -> dict[str, object]:
        return {
            "schema_version": "claimed_worker_preserved_files.v1",
            "root_relative": self._root_relative,
            "files": {
                "worker_execution_started.v1.json": {
                    "bytes": len(b"started receipt"),
                    "sha256": self._request_pins["execution_started_sha256"],
                },
                "results/partial.csv": {"bytes": 8, "sha256": _sha("partial\n")},
            },
        }

    def _inspection_document(self) -> dict[str, object]:
        return {
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
                "device_requests": deepcopy(self.device_requests),
            },
            "after": {
                "container_id": self.container_id,
                "image_id": self.image_id,
                "service": "backend",
                "role": "backend",
                "user": "65532:65532",
                "state": "exited",
                "pid": 0,
                "finished_at": self.finished_at,
                "descendant_count": 0,
                "private_pid_namespace": True,
                "host_pid": False,
                "device_requests": deepcopy(self.device_requests),
            },
            "device_release": {
                "resource_id": self._request_identity["resource_id"],
                "mapping_sha256": self.device_release_mapping_sha256,
                "mapping_detached": True,
                "gpu_uuid": self.gpu_uuid,
            },
        }

    def _inspection_manifest(self, document: dict[str, object] | None = None, *, name: str = "inspection-manifest") -> dict[str, str]:
        path = self.root / f"{name}.json"
        if document is None:
            document = self._inspection_document()
        raw = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        path.write_bytes(raw)
        return {"path": str(path), "sha256": _sha(raw)}

    def _build(self, **changes: object) -> dict[str, object]:
        return claimed.build_teardown_attestation(
            changes.get("request", self.request),
            changes.get("engine_before", self.engine),
            changes.get("engine_after", self.engine),
            changes.get("beforeinspect", self.before),
            changes.get("afterinspect", self.after),
            changes.get("manifest", self.manifest_arg),
        )

    def test_valid_request_is_deep_copied_and_matches_canonical_native_digest(self) -> None:
        original = deepcopy(self.request)
        validated = claimed.validate_request(self.request)
        self.assertNotEqual(validated["container"]["config_sha256"],
                            validated["pins"]["config_sha256"])
        self.assertEqual(validated["expected_task"]["readiness"], {"state": "ready"})
        self.assertEqual(validated["expected_task"]["artifact_ids"], [])
        native_json_value = deepcopy(original)
        native_json_value["expected_task"]["readiness"] = {"state": "ready"}
        native_json_value["expected_task"]["artifact_ids"] = []
        self.assertEqual(
            claimed.canonical_request_sha256(self.request),
            recovery.canonical_json_sha256(native_json_value),
        )
        self.request["pins"]["owner_sha256"] = _sha("mutated after validation")
        self.assertEqual(original["pins"]["owner_sha256"], validated["pins"]["owner_sha256"])

    def test_inline_inspection_matches_pinned_reference_without_host_file(self) -> None:
        manifest = deepcopy(self.manifest_arg)
        document = self._inspection_document()
        manifest['inspection_manifest'] = {'document': document,
            'sha256': recovery.canonical_json_sha256(document)}
        self.assertEqual(self._build(), self._build(manifest=manifest))
        manifest['inspection_manifest']['document']['after']['pid'] = 1
        with self.assertRaises(ValueError):
            self._build(manifest=manifest)

    def test_every_request_pin_requires_a_nonzero_lowercase_sha256(self) -> None:
        for field in self._request_pins:
            for invalid in ("0" * 64, "A" * 64, "not-a-digest"):
                request = deepcopy(self.request)
                request["pins"][field] = invalid
                with self.subTest(field=field, invalid=invalid), self.assertRaises(recovery.OrphanRecoveryError):
                    claimed.validate_request(request)

    def test_request_rejects_extra_fields_at_each_native_boundary(self) -> None:
        mutations = (
            lambda request: request.update(extra=True),
            lambda request: request.update({7: "not-json"}),
            lambda request: request["identity"].update(extra=True),
            lambda request: request["pins"].update(extra=True),
            lambda request: request["container"].update(extra=True),
            lambda request: request["expected_task"].update(extra=True),
        )
        for mutate in mutations:
            request = deepcopy(self.request)
            mutate(request)
            with self.subTest(request=request), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(request)

    def test_request_requires_exact_task_binding_and_canonical_nonnil_uuids(self) -> None:
        for field, value in (
            ("task_id", "another-task"),
            ("attempt_id", "another-attempt"),
            ("ownership_epoch", 3),
            ("resource_id", "another-resource"),
        ):
            request = deepcopy(self.request)
            request["expected_task"][field] = value
            with self.subTest(field=field), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(request)
        for field, value in (
            ("request_id", "00000000-0000-0000-0000-000000000000"),
            ("request_id", "00000000-0000-4000-8000-00000000000A"),
            ("consumed_launch_token", "not-a-uuid"),
        ):
            request = deepcopy(self.request)
            request[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(request)
        for field, value in (("catalog_revision", 1 << 53), ("catalog_revision", True)):
            request = deepcopy(self.request)
            request[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(request)

    def test_store_identifiers_match_native_component_rules(self) -> None:
        request = deepcopy(self.request)
        identity = request["identity"]
        identity.update(
            run_id="_run", task_id="-task", attempt_id="_attempt",
            resource_id="-resource", lease_token="_lease",
        )
        request["expected_task"].update(
            task_id="-task", attempt_id="_attempt", resource_id="-resource"
        )
        validated = claimed.validate_request(request)
        self.assertEqual(validated["identity"]["run_id"], "_run")
        for bad_id in (".", "..", "bad.", "CON", "COM1", "a/b"):
            invalid = deepcopy(request)
            invalid["identity"]["run_id"] = bad_id
            with self.subTest(bad_id=bad_id), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(invalid)

    def test_session_task_watermark_and_genesis_follow_typed_json_contract(self) -> None:
        request = deepcopy(self.request)
        identity = request["identity"]
        checkpoint = {
            "schema_version": "coordinator_checkpoint.v1",
            "command_sequence": 0,
            "event_sequence": 0,
            "claim": {
                "run_id": identity["run_id"],
                "task_id": identity["task_id"],
                "attempt_id": identity["attempt_id"],
                "ownership_epoch": identity["ownership_epoch"],
                "lease": {"lease_token": identity["lease_token"], "heartbeat_sequence": 3},
            },
            "task": {
                "run_id": identity["run_id"],
                "task_id": identity["task_id"],
                "attempt_id": identity["attempt_id"],
                "ownership_epoch": identity["ownership_epoch"],
            },
        }
        request["expected_task"]["coordinator_watermark"] = {
            "command_sequence": 0, "event_sequence": 0
        }
        request["expected_task"]["coordinator_genesis"] = {
            "run_id": identity["run_id"],
            "task_id": identity["task_id"],
            "attempt_id": identity["attempt_id"],
            "ownership_epoch": identity["ownership_epoch"],
            "lease_token": identity["lease_token"],
            "lease_heartbeat_sequence": 3,
            "checkpoint_sha256": recovery.canonical_json_sha256(checkpoint),
            "checkpoint": checkpoint,
        }
        claimed.validate_request(request)
        for invalid_sequence in (True, 0.0):
            invalid = deepcopy(request)
            invalid["expected_task"]["coordinator_genesis"]["checkpoint"]["command_sequence"] = invalid_sequence
            checkpoint_copy = invalid["expected_task"]["coordinator_genesis"]["checkpoint"]
            invalid["expected_task"]["coordinator_genesis"]["checkpoint_sha256"] = recovery.canonical_json_sha256(checkpoint_copy)
            with self.subTest(invalid_sequence=invalid_sequence), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(invalid)

    def test_request_requires_dedicated_private_backend_and_explicit_sole_worker(self) -> None:
        for field, value in (
            ("scope", "shared_parent"),
            ("service", "frontend"),
            ("private_pid_namespace", False),
            ("host_pid", True),
            ("sole_worker_scope", False),
        ):
            request = deepcopy(self.request)
            request["container"][field] = value
            with self.subTest(field=field), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(request)
        request = deepcopy(self.request)
        request["container"].pop("sole_worker_scope")
        with self.assertRaises(recovery.OrphanRecoveryError):
            claimed.validate_request(request)

    def test_valid_attestation_replays_identically_and_pins_both_manifests(self) -> None:
        first = self._build()
        replay = self._build()
        self.assertEqual(first, replay)
        self.assertEqual(
            set(first),
            {
                "namespace", "before_started_at", "after_started_at",
                "preserved_files_manifest_sha256",
            },
        )
        self.assertEqual(
            set(first["namespace"]),
            {
                "schema_version", "request_sha256", "docker_engine_id_sha256",
                "containers", "device_release", "manifest_sha256", "result",
            },
        )
        self.assertEqual(
            first["preserved_files_manifest_sha256"],
            self.request["pins"]["preserved_files_manifest_sha256"],
        )
        self.assertEqual(
            first["namespace"]["manifest_sha256"], self.inspection_manifest["sha256"]
        )
        self.assertEqual(
            first["namespace"]["device_release"]["mapping_sha256"],
            self.request["device_release_mapping_sha256"],
        )
        self.assertNotEqual(
            first["namespace"]["device_release"]["mapping_sha256"],
            recovery.canonical_json_sha256(self.device_requests),
        )
        self.assertEqual(
            first["namespace"]["device_release"]["gpu_uuid"], self.gpu_uuid
        )
        self.assertEqual(first["namespace"]["containers"][0]["after"]["state"], "exited")
        self.assertEqual(first["namespace"]["containers"][0]["after"]["pid"], 0)
        self.assertTrue(first["namespace"]["device_release"]["mapping_detached"])

    def test_configured_placement_pin_and_gpu_uuid_are_exact_and_distinct_from_device_requests(self) -> None:
        for field, value in (
            ("device_release_mapping_sha256", "0" * 64),
            ("device_release_mapping_sha256", "A" * 64),
            ("gpu_uuid", ""),
            ("gpu_uuid", "00000000-0000-4000-8000-000000000001"),
            ("gpu_uuid", "GPU-00000000-0000-4000-8000-00000000000A"),
        ):
            request = deepcopy(self.request)
            request[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(recovery.OrphanRecoveryError):
                claimed.validate_request(request)
        request = deepcopy(self.request)
        request.pop("device_release_mapping_sha256")
        with self.assertRaises(recovery.OrphanRecoveryError):
            claimed.validate_request(request)

        document = self._inspection_document()
        document["device_release"]["mapping_sha256"] = _sha("different placement")
        bad = {
            "inspection_manifest": self._inspection_manifest(document, name="wrong-placement"),
            "preserved_files_manifest": self.preserved_files,
        }
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)
        document = self._inspection_document()
        document["device_release"]["gpu_uuid"] = "GPU-00000000-0000-4000-8000-000000000002"
        bad = {
            "inspection_manifest": self._inspection_manifest(document, name="wrong-gpu"),
            "preserved_files_manifest": self.preserved_files,
        }
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)
        document = self._inspection_document()
        document["device_release"].pop("gpu_uuid")
        bad = {
            "inspection_manifest": self._inspection_manifest(document, name="missing-gpu"),
            "preserved_files_manifest": self.preserved_files,
        }
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)

    def test_cpu_release_keeps_nullable_gpu_uuid_out_of_namespace(self) -> None:
        request = deepcopy(self.request)
        request["gpu_uuid"] = None
        cpu_mapping_sha = recovery.canonical_json_sha256({"device_access": "cpu"})
        request["device_release_mapping_sha256"] = cpu_mapping_sha
        document = self._inspection_document()
        document["device_release"]["mapping_sha256"] = cpu_mapping_sha
        document["device_release"].pop("gpu_uuid")
        manifest = {
            "inspection_manifest": self._inspection_manifest(document, name="cpu-inspection"),
            "preserved_files_manifest": self.preserved_files,
        }
        result = self._build(request=request, manifest=manifest)
        self.assertNotIn("gpu_uuid", result["namespace"]["device_release"])
        self.assertEqual(
            result["namespace"]["device_release"]["mapping_sha256"],
            request["device_release_mapping_sha256"],
        )

    def test_engine_identity_and_started_at_must_remain_stable(self) -> None:
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(engine_after={"ID": "sha256:" + "9" * 64})
        changed = deepcopy(self.after)
        changed["State"]["StartedAt"] = "2026-11-05T10:00:01Z"
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(afterinspect=changed)

    def test_engine_must_prove_exited_pid_zero_and_unprivileged_dedicated_container(self) -> None:
        changed = deepcopy(self.after)
        changed["State"]["Status"] = "dead"  # An unknown stop result is not an exited proof.
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(afterinspect=changed)
        changed = deepcopy(self.after)
        changed["State"]["Pid"] = 1
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(afterinspect=changed)
        changed = deepcopy(self.before)
        changed["HostConfig"]["Privileged"] = True
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(beforeinspect=changed)
        changed = deepcopy(self.after)
        changed["HostConfig"]["PidMode"] = "host"
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(afterinspect=changed)

    def test_both_manifest_contracts_are_exact_and_match_the_request_pin(self) -> None:
        bad = deepcopy(self.manifest_arg)
        bad["extra"] = True
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)
        bad = deepcopy(self.manifest_arg)
        bad["preserved_files_manifest"]["root_relative"] += "/other"
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)
        bad = deepcopy(self.manifest_arg)
        bad["preserved_files_manifest"]["files"]["worker_execution_started.v1.json"]["sha256"] = _sha("other Started receipt")
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)
        bad = deepcopy(self.manifest_arg)
        bad["preserved_files_manifest"]["files"]["../escape"] = {
            "bytes": 1, "sha256": _sha("escape")
        }
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)
        bad = deepcopy(self.manifest_arg)
        bad["inspection_manifest"]["sha256"] = _sha("wrong manifest bytes")
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)
        document = self._inspection_document()
        document["device_release"]["mapping_detached"] = False
        path = self.root / "attached-gpu.json"
        raw = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        path.write_bytes(raw)
        bad = deepcopy(self.manifest_arg)
        bad["inspection_manifest"] = {"path": str(path), "sha256": _sha(raw)}
        with self.assertRaises(recovery.OrphanRecoveryError):
            self._build(manifest=bad)


if __name__ == "__main__":
    unittest.main()
