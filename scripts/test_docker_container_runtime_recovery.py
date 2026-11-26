"""Focused source and document checks for the named-volume recovery bridge."""

from __future__ import annotations

import copy
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
    def test_terminal_request_matches_host_contract_and_rejects_incomplete_absence_attestation(self):
        import docker_volume_container_recovery as host
        from test_docker_volume_container_recovery import ContainerRecoveryTests
        request=ContainerRecoveryTests.terminal_request()
        self.assertEqual(runtime_service._container_recovery_expected_outcome(request),host.expected_recovery_outcome(request))
        pin=request['retained_terminal_runs'][0]
        invalid=[{**request,'schema_version':host.REQUEST_SCHEMA},
                 {**request,'schema_version':host.RETAINED_REQUEST_SCHEMA},
                 {**request,'retained_cancelled_runs':[]},
                 {**request,'retained_terminal_runs':[pin,pin]},
                 {**request,'retained_terminal_runs':[]},
                 {**request,'retained_terminal_runs':[{k:v for k,v in pin.items() if k!='artifact_catalog_sha256'}]},
                 {**request,'retained_terminal_runs':[{**pin,'artifact_catalog_sha256':'bad'}]}]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(host.ContainerRecoveryError):host.expected_recovery_outcome(value)
                with self.assertRaises(runtime_service.RuntimeServiceError):runtime_service._container_recovery_expected_outcome(value)
        with self.assertRaisesRegex(runtime_service.RuntimeServiceError,'unexpected fields'):
            runtime_service._validate_container_recovery_attestation_document(request,'1'*64,
                {'schema_version':runtime_service.CONTAINER_RECOVERY_ABSENCE_ATTESTATION_SCHEMA},'2'*64)

    @staticmethod
    def history_request():
        return {
            "schema_version": "runtime_service_container_recovery_request.v5",
            "retained_terminal_runs": [{"run_id": "terminal-1", "run_intent_sha256": "1" * 64,
                "run_catalog_sha256": "2" * 64, "artifact_catalog_sha256": None}],
            "retained_held_manual_runs": [{"run_id": "held-1", "run_intent_sha256": "3" * 64,
                "run_catalog_sha256": "4" * 64, "start_release": "absent"}],
            "retained_attempt_histories": [{"run_id": "terminal-1", "run_evidence_sha256": "5" * 64,
                "attempts": [{"task_id": "task-1", "attempt_id": "attempt-1",
                    "ownership_epoch": 1, "resource_id": "resource-1"}]}],
        }

    def test_v5_history_host_parity_bounds_and_legacy_refusals(self):
        import docker_volume_container_recovery as host
        request = self.history_request()
        self.assertEqual(runtime_service._container_recovery_expected_outcome(request),
                         "retained_attempt_history_recovered")
        self.assertEqual(host.expected_recovery_outcome(request),
                         runtime_service._container_recovery_expected_outcome(request))
        history = request["retained_attempt_histories"][0]
        claim = history["attempts"][0]
        invalid = [{**request, "retained_attempt_histories": value}
                   for value in (None, [], [history] * 129, [history, history])]
        invalid.append({key: value for key, value in request.items() if key != "retained_attempt_histories"})
        for changes in ({"run_id": "held-1"}, {"run_id": "foreign"}, {"attempts": []},
                        {"extra": 1}, {"run_evidence_sha256": "0" * 64},
                        {"run_evidence_sha256": "F" * 64}, {"run_evidence_sha256": "short"}):
            invalid.append({**request, "retained_attempt_histories": [{**history, **changes}]})
        for changes in ({"ownership_epoch": True}, {"ownership_epoch": 0}, {"ownership_epoch": -1},
                        {"ownership_epoch": 1.5}, {"extra": 1}, {"task_id": "../escape"},
                        {"attempt_id": "x."}, {"resource_id": "bad/name"}, {"task_id": "x" * 129}):
            invalid.append({**request, "retained_attempt_histories": [
                {**history, "attempts": [{**claim, **changes}]}]})
        for claims in ([claim, claim], [claim, {**claim, "attempt_id": "attempt-2"}],
                       [claim, {**claim, "ownership_epoch": 2}]):
            invalid.append({**request, "retained_attempt_histories": [{**history, "attempts": claims}]})
        for version in range(1, 5):
            invalid.append({**request, "schema_version": "runtime_service_container_recovery_request.v" + str(version)})
        invalid.extend([{**request, "retained_held_manual_runs": []},
                        {**request, "retained_terminal_runs": []},
                        {**request, "retained_cancelled_runs": []}])
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(host.ContainerRecoveryError):
                    host.expected_recovery_outcome(value)
                with self.assertRaises(runtime_service.RuntimeServiceError):
                    runtime_service._container_recovery_expected_outcome(value)
        # The global limit counts claims across histories, not per run.
        second = {**history, "run_id": "terminal-2"}
        bounded = copy.deepcopy(request)
        bounded["retained_terminal_runs"].append({**request["retained_terminal_runs"][0], "run_id": "terminal-2"})
        claims = [{**claim, "attempt_id": "attempt-" + str(i), "ownership_epoch": i} for i in range(1, 129)]
        bounded["retained_attempt_histories"] = [{**history, "attempts": claims[:64]}, {**second, "attempts": claims[64:]}]
        self.assertEqual(host.expected_recovery_outcome(bounded), runtime_service._container_recovery_expected_outcome(bounded))
        bounded["retained_attempt_histories"][1]["attempts"].append({**claim, "attempt_id": "attempt-129", "ownership_epoch": 129})
        with self.assertRaises(host.ContainerRecoveryError): host.expected_recovery_outcome(bounded)
        with self.assertRaises(runtime_service.RuntimeServiceError): runtime_service._container_recovery_expected_outcome(bounded)

    def test_v5_enforces_native_store_ids_and_u64_epoch(self):
        # Native store IDs/u64 are stricter than the host's JSON shape check.
        for changes in ({"ownership_epoch": 1 << 64}, {"task_id": "CON"},
                        {"resource_id": "x" * 201}, {"attempt_id": "_leading"}):
            request = self.history_request()
            request["retained_attempt_histories"][0]["attempts"][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(runtime_service.RuntimeServiceError):
                runtime_service._container_recovery_expected_outcome(request)

    def test_v5_v6_absence_attestation_binds_inventory_and_exact_container(self):
        for factory in (self.history_request, self.pending_request):
            with self.subTest(schema=factory()["schema_version"]), tempfile.TemporaryDirectory() as directory:
                fixture = self._document_fixture(Path(directory))
                request = {**fixture["request"], **factory()}
                digest = _sha(runtime_service._canonical_container_recovery_json(request))
                attestation = {
                    "schema_version": runtime_service.CONTAINER_RECOVERY_ABSENCE_ATTESTATION_SCHEMA,
                    "request_sha256": digest, "docker_engine_id_sha256": request["docker_engine_id_sha256"],
                    "manifest_sha256": request["docker_manifest_sha256"], "result": "authoritative_namespace_absence",
                    "device_release": {"resource_id": request["device_release_resource_id"],
                        "mapping_sha256": request["device_release_mapping_sha256"], "mapping_detached": True},
                    "containers": [{**{key: pin[key] for key in ("container_id", "image_id", "config_sha256", "service")},
                        "absence": {"inspect": {"outcome": "no_such_object", "matched_container_id": pin["container_id"],
                            "output_sha256": "1" * 64}, "ps_all": {"outcome": "empty", "output_sha256": "2" * 64}}}
                        for pin in request["containers"]],
                }
                runtime_service._validate_container_recovery_attestation_document(request, digest, attestation, "a" * 64)
                changed = copy.deepcopy(request)
                changed["retained_attempt_histories"][0]["run_evidence_sha256"] = "6" * 64
                with self.assertRaisesRegex(runtime_service.RuntimeServiceError, "request"):
                    runtime_service._validate_container_recovery_attestation_document(changed,
                        _sha(runtime_service._canonical_container_recovery_json(changed)), attestation, "a" * 64)
                if "retained_pending_inboxes" in request:
                    changed = copy.deepcopy(request)
                    changed["retained_pending_inboxes"][0]["inbox_sha256"] = "7" * 64
                    with self.assertRaisesRegex(runtime_service.RuntimeServiceError, "request"):
                        runtime_service._validate_container_recovery_attestation_document(changed,
                            _sha(runtime_service._canonical_container_recovery_json(changed)), attestation, "a" * 64)
                attestation["containers"][0]["absence"]["inspect"]["matched_container_id"] = "9" * 64
                with self.assertRaises(runtime_service.RuntimeServiceError):
                    runtime_service._validate_container_recovery_attestation_document(request, digest, attestation, "a" * 64)

    def test_v5_capability_required_before_mutator_and_receipt_cannot_downgrade(self):
        from test_runtime_service_terminal_container_recovery import TerminalContainerRecoveryTests
        fixture = TerminalContainerRecoveryTests()
        for mode in ("supported", "unsupported", "v4-outcome"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                paths, context, cap, _ = fixture.fixture(Path(directory))
                context["request"].update(self.history_request())
                context["request_sha256"] = _sha(runtime_service._canonical_container_recovery_json(context["request"]))
                if mode != "unsupported":
                    cap["supported_recovery_schemas"].append("runtime_service_container_recovery_request.v5")
                calls = []
                failed = json.dumps({**context["expected_owner"], "state": "failed"}).encode()
                receipt = fixture.receipt(context, failed)
                if mode == "v4-outcome": receipt["outcome"] = "retained_manual_held_runs_recovered"
                def cli(paths, args, *, timeout, cli, raw_output=None):
                    calls.append(args[1])
                    if args[1] == "service-container-recovery-capabilities":
                        raw_output.append(json.dumps(cap).encode())
                        return cap
                    (paths.runtime_services / "OWNER.json").write_bytes(failed)
                    return receipt
                if mode == "supported":
                    self.assertEqual(fixture.run_recovery(paths, context, cli), receipt)
                else:
                    with self.assertRaises(runtime_service.RuntimeServiceError):
                        fixture.run_recovery(paths, context, cli)
                self.assertEqual(calls, ["service-container-recovery-capabilities"] +
                                 ([] if mode == "unsupported" else ["service-recover-container"]))

    @staticmethod
    def pending_request():
        request = ContainerRuntimeRecoveryBridgeTests.history_request()
        request["schema_version"] = "runtime_service_container_recovery_request.v6"
        request["retained_pending_inboxes"] = [{
            "run_id": "terminal-1", "task_id": "task-current", "attempt_id": "attempt-current",
            "resource_id": "resource-1", "ownership_epoch": 2, "inbox_sha256": "6" * 64,
            "kind": "failed_final_heartbeat",
        }]
        return request

    def test_v6_pending_pin_shapes_bounds_and_legacy_refusals(self):
        import docker_volume_container_recovery as host
        request = self.pending_request()
        self.assertEqual(runtime_service._container_recovery_expected_outcome(request),
                         "retained_pending_inboxes_recovered")
        pin = request["retained_pending_inboxes"][0]
        no_spawn = {**pin, "kind": "cancelled_before_spawn", "release_proof_sha256": "7" * 64}
        self.assertEqual(runtime_service._container_recovery_expected_outcome(
            {**request, "retained_pending_inboxes": [no_spawn]}), "retained_pending_inboxes_recovered")
        invalid = [{**request, "retained_pending_inboxes": value}
                   for value in (None, [], [pin, pin], [pin] * 129)]
        invalid.append({key: value for key, value in request.items() if key != "retained_pending_inboxes"})
        changes = ({"kind": "unknown"}, {"kind": "cancelled_before_spawn"},
            {"release_proof_sha256": None}, {"release_proof_sha256": "7" * 64},
            {"run_id": "held-1"}, {"run_id": "foreign"}, {"task_id": "../escape"},
            {"task_id": "CON"}, {"attempt_id": "_bad"}, {"resource_id": "bad/name"},
            {"task_id": "x" * 201}, {"resource_id": "x" * 201},
            {"ownership_epoch": True}, {"ownership_epoch": 0}, {"ownership_epoch": 1 << 64},
            {"inbox_sha256": "0" * 64}, {"inbox_sha256": "F" * 64}, {"extra": True})
        invalid.extend({**request, "retained_pending_inboxes": [{**pin, **change}]} for change in changes)
        for value in (None, "0" * 64, "F" * 64, "short"):
            invalid.append({**request, "retained_pending_inboxes": [{**no_spawn, "release_proof_sha256": value}]})
        for field in pin:
            invalid.append({**request, "retained_pending_inboxes": [{k:v for k,v in pin.items() if k != field}]})
        invalid.append({**request, "retained_pending_inboxes": [pin, {**pin, "attempt_id": "different"}]})
        for version in range(1, 6):
            for pins in (None, [], [pin]):
                invalid.append({**request, "schema_version": f"runtime_service_container_recovery_request.v{version}",
                                "retained_pending_inboxes": pins})
        for value in invalid:
            with self.subTest(request=value):
                with self.assertRaises(runtime_service.RuntimeServiceError):
                    runtime_service._container_recovery_expected_outcome(value)
                with self.assertRaises(host.ContainerRecoveryError):
                    host.expected_recovery_outcome(value)
        for value in (request, {**request, "retained_pending_inboxes": [no_spawn]}):
            self.assertEqual(host.expected_recovery_outcome(value),
                             runtime_service._container_recovery_expected_outcome(value))
        bounded = {**request, "retained_pending_inboxes": [
            {**pin, "task_id": f"task-{i}"} for i in range(128)]}
        self.assertEqual(runtime_service._container_recovery_expected_outcome(bounded),
                         "retained_pending_inboxes_recovered")
        bounded["retained_pending_inboxes"].append({**pin, "task_id": "task-128"})
        with self.assertRaises(runtime_service.RuntimeServiceError):
            runtime_service._container_recovery_expected_outcome(bounded)

    def test_v6_capability_required_and_receipt_cannot_downgrade(self):
        from test_runtime_service_terminal_container_recovery import TerminalContainerRecoveryTests
        fixture = TerminalContainerRecoveryTests()
        for mode in ("supported", "unsupported", "v5-outcome"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                paths, context, cap, _ = fixture.fixture(Path(directory))
                context["request"].update(self.pending_request())
                context["request_sha256"] = _sha(runtime_service._canonical_container_recovery_json(context["request"]))
                if mode != "unsupported":
                    cap["supported_recovery_schemas"].append("runtime_service_container_recovery_request.v6")
                calls = []
                failed = json.dumps({**context["expected_owner"], "state": "failed"}).encode()
                receipt = fixture.receipt(context, failed)
                if mode == "v5-outcome": receipt["outcome"] = "retained_attempt_history_recovered"
                def cli(paths, args, *, timeout, cli, raw_output=None):
                    calls.append(args[1])
                    if args[1] == "service-container-recovery-capabilities":
                        raw_output.append(json.dumps(cap).encode())
                        return cap
                    (paths.runtime_services / "OWNER.json").write_bytes(failed)
                    return receipt
                if mode == "supported":
                    self.assertEqual(fixture.run_recovery(paths, context, cli), receipt)
                else:
                    with self.assertRaises(runtime_service.RuntimeServiceError):
                        fixture.run_recovery(paths, context, cli)
                self.assertEqual(calls, ["service-container-recovery-capabilities"] +
                                 ([] if mode == "unsupported" else ["service-recover-container"]))

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

    def _archive_fixture(self, root):
        fixture = self._document_fixture(root)
        owner = {**fixture["request"]["expected_owner"],
                 "compute_pool_generation": 2, "preparation_pool_generation": 2}
        owner_raw = (json.dumps(owner, sort_keys=True) + "\n").encode()
        failed_owner_raw = (json.dumps({**owner, "state": "failed"}, sort_keys=True) + "\n").encode()
        ready = {
            **owner, "schema_version": "runtime_service_owner.v1", "protocol": "stdin-v1",
            "owner_token": "7f3fb229-be61-4762-b88d-115c9bfe7bc5", "pid": 2987,
            "host": "new-backend", "build_commit": "e" * 40, "build_snapshot": "f" * 64,
            "compute_pool_generation": 3, "preparation_pool_generation": 3,
            "control_address": "stdin://2987", "acquired_at": "2026-10-20T12:00:00Z",
            "heartbeat_at": "2026-10-20T12:00:01Z",
            "children": [{"role": "compute", "pid": 2988, "status": "running"},
                         {"role": "preparation", "pid": 2989, "status": "running"}],
        }
        drained = {**ready, "state": "drained", "children": [
            {**child, "status": "exited_success"} for child in ready["children"]]}
        drained_raw = (json.dumps(drained, sort_keys=True) + "\n").encode()
        request_sha = "9" * 64
        offers = [{"resource_id": "existing-resource", "capacity": 1}]
        config = {"target_id": "docker-all", "compute_pool_id": "docker-all.compute",
                  "preparation_pool_id": "docker-all.preparation", "compute_resources": offers,
                  "preparation_resources": offers, "host_execution": {"runtime_generation_sha256": "1" * 64}}
        config_raw = json.dumps(config).encode()
        config_sha = _sha(config_raw)
        request = {**fixture["request"], "owner_sha256": _sha(owner_raw), "config_sha256": config_sha}
        authorization = {"owner_sha256": request["owner_sha256"], "config_sha256": config_sha}
        store = root / "store"
        runtime_services = store / "runtime-services"
        runtime_services.mkdir(parents=True)
        paths = runtime_service.RuntimePaths(store=store, runtime_services=runtime_services,
                                             state_root=root / "runtime-control", config=root / "runtime-control/config.json")
        (runtime_services / "OWNER.json").write_bytes(drained_raw)
        pin = runtime_services / ("docker-client-" + ready["owner_token"] + ".json")
        pin.write_text(json.dumps(ready))
        process_path = runtime_service.process_receipt_path(paths)
        process_path.parent.mkdir(parents=True)
        paths.config.write_text(json.dumps({**config, "host_execution": {"runtime_generation_sha256": "2" * 64}}))
        process_path.write_text(json.dumps({"schema": "fullmag.docker-process-tree.v1", "state": "drained",
                                            "service_owner": ready, "terminal_service_owner": drained}))
        archive_root = store / "runtime-services" / "container-recovery" / request_sha / "archive"
        archive_root.mkdir(parents=True)
        pools = {
            "scheduler_pools/docker-all.compute.resources.json": ("scheduler_resource_pool.v1", "docker-all.compute"),
            "scheduler_pools/docker-all.preparation.preparation-resources.json": ("preparation_resource_pool.v1", "docker-all.preparation"),
        }
        archived_files = {}
        for source in runtime_service._container_recovery_expected_sources(owner):
            live_raw = None
            if source == "configuration.json":
                source_raw = config_raw
            elif source == "runtime-services/OWNER.json":
                source_raw = owner_raw
            elif source == "runtime-services/LAUNCH.json":
                old_launch = {"schema_version": "runtime_service_launch.v1", "state": "ready", "pid": 165,
                              "launch_id": "9716ed4a-30bb-41b5-90d5-5fb07e0662b7"}
                source_raw = json.dumps(old_launch).encode()
                live_raw = json.dumps({**old_launch, "pid": 2987,
                                      "launch_id": "e0fc26fe-1eba-48b6-9b6c-f7e0466ffef6"}).encode()
            elif source in pools:
                schema, pool_id = pools[source]
                old_pool = {"schema_version": schema, "pool_id": pool_id, "generation": 2,
                            "resources": [{"resource_id": "existing-resource", "capacity": 1}]}
                source_raw = json.dumps(old_pool).encode()
                live_raw = json.dumps({**old_pool, "generation": 3}).encode()
            elif source.startswith("scheduler_pools/"):
                pool_id = "docker-all.preparation" if source.endswith(".preparation.json") else "docker-all.compute"
                source_raw = json.dumps({"schema_version": "scheduler_pool_checkpoint.v1", "pool_id": pool_id,
                                         "sequence": 1, "run_source": "store", "run_ids": [], "next_run_id": None}).encode()
            else:
                source_raw = source.encode() + b"\n"
            if source not in {"configuration.json", "runtime-services/OWNER.json"}:
                live_path = runtime_service._store_relative_path(paths, runtime_service.PurePosixPath(source))
                live_path.parent.mkdir(parents=True, exist_ok=True)
                live_path.write_bytes(live_raw if live_raw is not None else source_raw)
            (archive_root / Path(source).name).write_bytes(source_raw)
            archived_files[source] = _sha(source_raw)
        new_logs = runtime_services / ready["owner_token"]
        new_logs.mkdir()
        for name in ("compute.stdout.jsonl", "preparation.stdout.jsonl"):
            (new_logs / name).write_text("{}\n")
        attestation_sha = "d" * 64
        archive_manifest = {
            "schema_version": runtime_service.CONTAINER_RECOVERY_ARCHIVE_SCHEMA,
            "request_sha256": request_sha, "config_sha256": config_sha, "attestation_sha256": attestation_sha,
            "ledger_snapshot_sha256": request["ledger_snapshot_sha256"],
            "prior_ready_owner_proof_sha256": request["prior_ready_owner_proof_sha256"],
            "application": request["application"], "files": archived_files, "absent_sources": {},
        }
        archive_manifest_raw = (json.dumps(archive_manifest, sort_keys=True, indent=2) + "\n").encode()
        (archive_root / "manifest.json").write_bytes(archive_manifest_raw)
        result = {"owner_sha256_after": _sha(failed_owner_raw),
                  "archived_evidence_path": str(archive_root / "manifest.json"),
                  "archived_evidence_sha256": _sha(archive_manifest_raw), "archived_files": archived_files,
                  "archived_absent_sources": {}}
        context = {"request": request, "authorization": authorization, "request_sha256": request_sha,
                   "attestation_sha256": attestation_sha, "expected_owner": owner}
        return paths, context, result, _sha(drained_raw), archive_root, pin

    def test_archive_accepts_new_launch_and_pool_generation_only_with_authenticated_drain(self):
        with tempfile.TemporaryDirectory() as raw:
            paths, context, result, digest, _, _ = self._archive_fixture(Path(raw))
            runtime_service._validate_container_recovery_archive(
                paths, context, result, authenticated_drained_owner_sha256=digest)
            with self.assertRaises(runtime_service.RuntimeServiceError):
                runtime_service._validate_container_recovery_archive(paths, context, result)
            with self.assertRaises(runtime_service.RuntimeServiceError):
                runtime_service._validate_container_recovery_archive(
                    paths, context, result, authenticated_drained_owner_sha256="0" * 64)

    def test_authenticated_replay_refuses_foreign_launch_resources_and_ready_pin(self):
        with tempfile.TemporaryDirectory() as raw:
            paths, context, result, digest, _, pin = self._archive_fixture(Path(raw))
            def validate():
                runtime_service._validate_container_recovery_archive(
                    paths, context, result, authenticated_drained_owner_sha256=digest)
            launch_path = runtime_service.runtime_services_root(paths) / "LAUNCH.json"
            resources_path = paths.store / "scheduler_pools/docker-all.compute.resources.json"
            cases = [(launch_path, {"pid": 999}), (launch_path, {"launch_id": "invalid"}),
                     (launch_path, {"state": "spawned"}), (resources_path, {"generation": 4}),
                     (resources_path, {"generation": 2}),
                     (resources_path, {"resources": [{"resource_id": "existing-resource", "capacity": True}]}),
                     (resources_path, {"resources": [{"resource_id": "existing-resource", "capacity": 1.0}]}),
                     (resources_path, {"resources": []}), (resources_path, {"pool_id": "foreign"}),
                     (pin, {"pid": 999})]
            for path, change in cases:
                with self.subTest(path=path, change=change):
                    original = path.read_bytes()
                    path.write_text(json.dumps({**json.loads(original), **change}))
                    with self.assertRaises(runtime_service.RuntimeServiceError):
                        validate()
                    path.write_bytes(original)
            validate()

    def test_initial_failed_owner_replay_does_not_accept_new_generation_records(self):
        with tempfile.TemporaryDirectory() as raw:
            paths, context, result, _, _, _ = self._archive_fixture(Path(raw))
            failed = {**context["expected_owner"], "state": "failed"}
            runtime_service.runtime_services_root(paths).joinpath("OWNER.json").write_text(
                json.dumps(failed, sort_keys=True) + "\n")
            with self.assertRaisesRegex(runtime_service.RuntimeServiceError, "differs from live store"):
                runtime_service._validate_container_recovery_archive(paths, context, result)

    def test_successor_profile_keeps_resource_types_when_live_pool_matches_config(self):
        with tempfile.TemporaryDirectory() as raw:
            paths, context, result, digest, _, _ = self._archive_fixture(Path(raw))
            original_config = paths.config.read_bytes()
            pool_path = paths.store / "scheduler_pools/docker-all.compute.resources.json"
            original_pool = pool_path.read_bytes()
            for capacity in (True, 1.0):
                with self.subTest(capacity=capacity):
                    resources = [{"resource_id": "existing-resource", "capacity": capacity}]
                    paths.config.write_text(json.dumps({**json.loads(original_config), "compute_resources": resources}))
                    pool_path.write_text(json.dumps({**json.loads(original_pool), "resources": resources}))
                    with self.assertRaisesRegex(runtime_service.RuntimeServiceError, "operator profile"):
                        runtime_service._validate_container_recovery_archive(
                            paths, context, result, authenticated_drained_owner_sha256=digest)

    def test_authenticated_successor_preserves_completed_run_checkpoint_history(self):
        with tempfile.TemporaryDirectory() as raw:
            paths, context, result, digest, _, pin = self._archive_fixture(Path(raw))
            checkpoint_path = paths.store / "scheduler_pools/docker-all.compute.json"
            checkpoint_path.write_text(json.dumps({**json.loads(checkpoint_path.read_bytes()),
                                                   "sequence": 2, "run_ids": ["completed-run"]}))
            runtime_service._validate_container_recovery_archive(
                paths, context, result, authenticated_drained_owner_sha256=digest,
                authenticated_successor_owner=json.loads(pin.read_bytes()))

    def test_authenticated_replay_keeps_archived_bytes_old_logs_and_checkpoints_immutable(self):
        with tempfile.TemporaryDirectory() as raw:
            paths, context, result, digest, archive_root, _ = self._archive_fixture(Path(raw))
            old_token = context["expected_owner"]["owner_token"]
            paths_to_change = [archive_root / "LAUNCH.json", archive_root / "docker-all.compute.resources.json",
                               runtime_service.runtime_services_root(paths) / old_token / "compute.stdout.jsonl",
                               paths.store / "scheduler_pools/docker-all.compute.json"]
            for path in paths_to_change:
                with self.subTest(path=path):
                    original = path.read_bytes()
                    path.write_bytes(original + b"changed")
                    with self.assertRaises(runtime_service.RuntimeServiceError):
                        runtime_service._validate_container_recovery_archive(
                            paths, context, result, authenticated_drained_owner_sha256=digest)
                    path.write_bytes(original)

    def test_entrypoint_orders_container_recovery_before_configuration(self):
        source = (RUNTIME_ROOT / "entrypoint.py").read_text(encoding="utf-8")
        self.assertLess(source.index("initialize_accepted_store(paths)"), source.index("recover_container_namespace(paths)"))
        self.assertLess(source.index("recover_container_namespace(paths)"), source.index("ensure_configuration(paths)"))
        self.assertIn("container_recovery_authorization", source)


if __name__ == "__main__":
    unittest.main()
