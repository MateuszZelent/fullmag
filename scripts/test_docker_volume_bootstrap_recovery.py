"""Offline contract tests for frozen bootstrap-stop recovery evidence."""
from __future__ import annotations

import copy
from contextlib import ExitStack
import hashlib
import json
import unittest
from unittest.mock import patch

from docker_build_control import BuildControlError, canonical
import docker_volume_bootstrap_recovery as recovery
import docker_volume_stop_bootstrap as stop


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def raw_json(value, *, pretty: bool = False, newline: bool = False) -> bytes:
    if pretty:
        text = json.dumps(value, sort_keys=True, indent=2)
    else:
        text = canonical(value).decode("utf-8")
    if newline:
        text += "\n"
    return text.encode("utf-8")


class FakeControl:
    volume = "fullmag-private-worktree-sp4"
    namespace = "groups/worktree-sp4"

    def __init__(self):
        self.files: dict[str, bytes] = {}


class BootstrapFixture:
    """Construct internally linked evidence without copying host receipts."""

    stop_attempt = "a" * 32
    resume_attempt = "b" * 32
    development_attempt = "d" * 32
    fence_attempt = "e" * 32
    source_root = "/worktrees/sp4"
    compose_project = "fullmag-worktree-sp4"
    backend_id = "1" * 64
    frontend_id = "2" * 64
    image_id = "sha256:" + "3" * 64
    backend_started_at = "2026-11-06T09:10:11.123456789Z"
    current_build_commit = "5" * 40
    current_build_snapshot = "7" * 64
    api_pid = 4312
    api_instance_id = "99999999-9999-4999-8999-999999999999"
    api_failure_fence = (
        "/opt/fullmag/runtime-control/runtime-service/api-failure-"
        + fence_attempt + ".json"
    )

    def __init__(self):
        self.control = FakeControl()
        self.compose = {"name": self.compose_project, "services": {"backend": {}, "frontend": {}}}
        self.development = {
            "attempt": self.development_attempt,
            "phase": "development",
            "compose_project": self.compose_project,
            "inputs": {"source_root": self.source_root},
        }
        self.resume = {
            "attempt": self.resume_attempt,
            "phase": "resume",
            "state": "failed-confirmed",
            "compose_project": self.compose_project,
            "inputs": {"attempt": self.development_attempt},
            "backend_started_at": self.backend_started_at,
            "frontend_started_at": "2026-11-06T09:11:00.000000000Z",
        }
        self.error = stop.TARGET_BUILD_ERROR_PREFIX + "\n" + stop.TARGET_BUILD_ERROR_SUFFIX
        self.before_process = {
            "schema": "fullmag.docker-process-tree.v1",
            "state": "failed_outcome_retained",
            "api_diagnostic_only": True,
            "api_failure_fence": self.api_failure_fence,
            "api_pid": self.api_pid,
            "api_instance_id": self.api_instance_id,
            "error": self.error,
        }
        self.process = {
            **self.before_process,
            "state": "shutdown_unknown",
            "api_exit_code": 137,
            "shutdown_error": stop.EXPECTED_SHUTDOWN_ERROR,
        }
        self.fence = {
            "schema": "fullmag.api-runtime-failure-fence.v1",
            "stage": "runtime_startup",
            "reason": self.error,
            "api_pid": self.api_pid,
            "api_instance_id": self.api_instance_id,
        }
        self.owner = {
            "schema_version": "runtime_service_owner.v1",
            "protocol": "stdin-v1",
            "state": "ready",
            "target_id": "docker-all",
            "owner_token": "owner-token",
            "process_start_token": "process-start-token",
            "host": "managed-host",
            "control_address": "unix:///run/fullmag-owner.sock",
            "acquired_at": "2026-11-05T10:00:00Z",
            "heartbeat_at": "2026-11-06T09:00:00Z",
            "build_commit": "4" * 40,
            "build_snapshot": "6" * 64,
            "compute_pool_generation": 4,
            "preparation_pool_generation": 8,
            "compute_pool_id": "compute-pool",
            "preparation_pool_id": "preparation-pool",
            "pid": 710,
            "children": [
                {"role": "compute", "pid": 711, "status": "running"},
                {"role": "preparation", "pid": 712, "status": "running"},
            ],
        }
        self.launch = {"schema_version": "runtime_service_launch.v1", "state": "ready", "pid": self.owner["pid"]}
        self.config = {
            "schema_version": "runtime_service_config.v2",
            "target_id": "docker-all",
            "store_root": "/state/runs/docker-all/session-store",
        }
        self.terminal = {
            "schema": "fullmag.docker-bootstrap-api-stop.v1",
            "state": "stopped-confirmed",
            "execution_state": "unknown",
            "backend_running": False,
            "frontend_running": True,
            "runtime_owner_state": "ready-history-preserved",
            "resource_leases": "untouched",
            "session_store": "untouched",
            "attempt": self.development_attempt,
            "resume_attempt": self.resume_attempt,
            "source_root": self.source_root,
            "compose_project": self.compose_project,
            "backend_container_id": self.backend_id,
            "frontend_container_id": self.frontend_id,
            "image_id": self.image_id,
            "backend_started_at": self.backend_started_at,
            "api_pid": self.api_pid,
            "api_instance_id": self.api_instance_id,
            "current_build_commit": self.current_build_commit,
            "current_build_snapshot": self.current_build_snapshot,
            "api_exit_code": 137,
            "shutdown_error": stop.EXPECTED_SHUTDOWN_ERROR,
        }
        self.operation = {
            "schema": "fullmag.docker-build-operation.v1",
            "attempt": self.stop_attempt,
            "phase": "stop-bootstrap",
            "state": "succeeded",
            "execution_state": "unknown",
            "compose_project": self.compose_project,
            "stop_state": "stopped-confirmed",
            "control_volume": self.control.volume,
            "control_namespace": self.control.namespace,
        }
        self.preflight = {
            "schema": "fullmag.docker-bootstrap-api-stop-preflight.v1",
            "state": "preflight-confirmed",
        }
        self.pins: dict[str, str] = {}
        self._rebuild()

    def _rebuild(self):
        """Re-link every dependent receipt after a deliberate fixture change."""
        compose_raw = raw_json(self.compose)
        self.resume.setdefault("inputs", {})["config_sha256"] = digest(canonical(self.compose))
        development_raw = raw_json(self.development)
        resume_raw = raw_json(self.resume)
        before_raw = raw_json(self.before_process)
        fence_raw = raw_json(self.fence)
        process_raw = raw_json(self.process)
        owner_raw = raw_json(self.owner)
        launch_raw = raw_json(self.launch)
        config_raw = raw_json(self.config)

        self.pins.update({
            "development_attempt": self.development_attempt,
            "source_root": self.source_root,
            "compose_project": self.compose_project,
            "compose_config_sha256": digest(canonical(self.compose)),
            "backend_container_id": self.backend_id,
            "frontend_container_id": self.frontend_id,
            "old_image_id": self.image_id,
            "process_receipt_sha256": digest(process_raw),
            "owner_sha256": digest(owner_raw),
            "launch_sha256": digest(launch_raw),
            "config_sha256": digest(config_raw),
        })
        self.terminal.update({
            "development_terminal_sha256": digest(development_raw),
            "resume_terminal_sha256": digest(resume_raw),
            "compose_sha256": digest(compose_raw),
            "failure_fence_sha256": digest(fence_raw),
            "resume_process_failure_sha256": digest(before_raw),
            "config_sha256": self.pins["compose_config_sha256"],
            "runtime_config_sha256": self.pins["config_sha256"],
            "process_receipt_sha256_before": digest(before_raw),
            "process_receipt_sha256_after": digest(process_raw),
            "owner_sha256_before": digest(owner_raw),
            "owner_sha256_after": digest(owner_raw),
        })

        shared = (
            "attempt", "resume_attempt", "config_sha256", "backend_container_id",
            "frontend_container_id", "backend_started_at", "image_id",
            "development_terminal_sha256", "resume_terminal_sha256", "compose_sha256",
            "failure_fence_sha256", "api_pid", "api_instance_id", "current_build_commit",
            "current_build_snapshot", "resume_process_failure_sha256",
        )
        self.preflight.update({key: self.terminal[key] for key in shared})
        self.preflight.update({
            "process_receipt_sha256": digest(before_raw),
            "owner_sha256": digest(owner_raw),
            "owner_pids_absent": sorted([self.owner["pid"], *(child["pid"] for child in self.owner["children"])]),
        })

        inputs = {key: self.terminal[key] for key in shared}
        inputs.update({
            "source_root": self.terminal["source_root"],
            "backend_container_id": self.terminal["backend_container_id"],
            "frontend_container_id": self.terminal["frontend_container_id"],
        })
        self.operation.update({
            "compose_project": self.terminal["compose_project"],
            "inputs": inputs,
        })

        terminal_raw = raw_json(self.terminal, pretty=True, newline=True)
        self.operation["stop_bootstrap_terminal_sha256"] = digest(canonical(self.terminal))
        operation_raw = raw_json(self.operation)
        preflight_raw = raw_json(self.preflight)
        self.control.files = {
            "stop-bootstrap/attempts/" + self.stop_attempt + "/stop-bootstrap-terminal.json": terminal_raw,
            "stop-bootstrap/attempts/" + self.stop_attempt + "/terminal.json": operation_raw,
            "stop-bootstrap/attempts/" + self.stop_attempt + "/stop-bootstrap-preflight.json": preflight_raw,
            "resume/attempts/" + self.resume_attempt + "/terminal.json": resume_raw,
            "resume/attempts/" + self.resume_attempt + "/process-failure.json": before_raw,
            "development/attempts/" + self.development_attempt + "/terminal.json": development_raw,
            "development/attempts/" + self.development_attempt + "/compose.json": compose_raw,
            stop._runtime_relative(self.api_failure_fence): fence_raw,
            "runtime-control/runtime-service/process-tree.json": process_raw,
            "runtime-control/runtime-services/OWNER.json": owner_raw,
            "runtime-control/runtime-services/LAUNCH.json": launch_raw,
            "runtime-control/runtime-service/docker-all.json": config_raw,
        }
        self.runtime_records = {
            key: {"path": path, "raw_utf8": self.control.files[path].decode("utf-8"), "sha256": digest(self.control.files[path])}
            for key, path in (
                ("process_receipt", "runtime-control/runtime-service/process-tree.json"),
                ("owner", "runtime-control/runtime-services/OWNER.json"),
                ("launch", "runtime-control/runtime-services/LAUNCH.json"),
                ("config", "runtime-control/runtime-service/docker-all.json"),
            )
        }
        self.backend = {
            "Id": self.backend_id,
            "Image": self.image_id,
            "State": {"StartedAt": self.backend_started_at},
        }
        self.reference = {"attempt": self.stop_attempt, "sha256": digest(terminal_raw)}

    def collect(self):
        return recovery.collect(self.control, dict(self.reference))

    def validate(self, evidence=None, *, control=None, pins=None, runtime_records=None, backend=None):
        return recovery.validate(
            self.collect() if evidence is None else evidence,
            self.pins if pins is None else pins,
            self.runtime_records if runtime_records is None else runtime_records,
            self.backend if backend is None else backend,
            control=self.control if control is None else control,
        )


class BootstrapRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = BootstrapFixture()

        def read_raw(control, path, *, maximum=stop.MAX_EVIDENCE_BYTES):
            raw = control.files.get(path)
            if raw is None:
                raise BuildControlError("missing synthetic fixture record: " + path)
            if len(raw) > maximum:
                raise BuildControlError("synthetic fixture record exceeds bound")
            return raw

        self.read_patch = patch.object(stop, "_read_raw", side_effect=read_raw)
        self.read_patch.start()
        self.addCleanup(self.read_patch.stop)

    def test_collection_and_validation_keep_raw_newline_hash_separate_from_canonical_operation_hash(self):
        fixture = self.fixture
        evidence = fixture.collect()
        stop_record = evidence["records"]["stop"]
        terminal_raw = stop_record["raw_utf8"].encode("utf-8")
        terminal = json.loads(terminal_raw)
        operation = json.loads(evidence["records"]["operation"]["raw_utf8"])

        self.assertTrue(terminal_raw.endswith(b"\n"))
        self.assertEqual(stop_record["sha256"], digest(terminal_raw))
        self.assertEqual(stop_record["sha256"], evidence["reference"]["sha256"])
        self.assertEqual(operation["stop_bootstrap_terminal_sha256"], digest(canonical(terminal)))
        self.assertNotEqual(stop_record["sha256"], operation["stop_bootstrap_terminal_sha256"])
        self.assertEqual(fixture.validate(evidence), {
            "frontend_started_at": fixture.resume["frontend_started_at"],
            "stop_attempt": fixture.stop_attempt,
        })

    def test_collection_requires_well_formed_explicit_attempt_and_raw_digest(self):
        for reference in (
            dict(self.fixture.reference, sha256="f" * 64),
            [self.fixture.stop_attempt, self.fixture.reference["sha256"]],
        ):
            with self.subTest(reference_type=type(reference).__name__), self.assertRaises(BuildControlError):
                recovery.collect(self.fixture.control, reference)

    def test_frozen_records_require_exact_raw_digest_and_fixed_path(self):
        edits = (
            lambda record: record.update(raw_utf8=record["raw_utf8"] + " "),
            lambda record: record.update(sha256="f" * 64),
            lambda record: record.update(path="resume/latest/terminal.json"),
        )
        for edit in edits:
            with self.subTest(edit=edit):
                evidence = self.fixture.collect()
                edit(evidence["records"]["development"])
                with self.assertRaises(BuildControlError):
                    self.fixture.validate(evidence)

    def test_compare_and_swap_refuses_a_source_record_changed_after_collection(self):
        evidence = self.fixture.collect()
        path = evidence["records"]["development"]["path"]
        self.fixture.control.files[path] += b"\n"
        with self.assertRaises(BuildControlError):
            self.fixture.validate(evidence)

    def test_compare_and_swap_refuses_a_runtime_record_changed_after_collection(self):
        path = self.fixture.runtime_records["owner"]["path"]
        self.fixture.control.files[path] += b"\n"
        with self.assertRaises(BuildControlError):
            self.fixture.validate()

    def test_incomplete_or_unfinished_stop_operation_is_not_authorization(self):
        evidence = self.fixture.collect()
        operation = json.loads(evidence["records"]["operation"]["raw_utf8"])
        operation["state"] = "running"
        evidence["records"]["operation"]["raw_utf8"] = raw_json(operation).decode("utf-8")
        evidence["records"]["operation"]["sha256"] = digest(evidence["records"]["operation"]["raw_utf8"].encode("utf-8"))
        with self.assertRaises(BuildControlError):
            self.fixture.validate(evidence, control=None)

    def test_foreign_source_pin_is_rejected(self):
        pins = dict(self.fixture.pins, source_root="/another-checkout")
        with self.assertRaises(BuildControlError):
            self.fixture.validate(pins=pins)

    def test_foreign_group_pin_or_control_namespace_is_rejected(self):
        with self.subTest(binding="compose project"), self.assertRaises(BuildControlError):
            pins = dict(self.fixture.pins, compose_project="fullmag-worktree-other")
            self.fixture.validate(pins=pins)

        with self.subTest(binding="control namespace"), self.assertRaises(BuildControlError):
            foreign_control = FakeControl()
            foreign_control.files = self.fixture.control.files
            foreign_control.volume = self.fixture.control.volume
            foreign_control.namespace = "groups/another-worktree"
            self.fixture.validate(control=foreign_control)

    def test_same_build_owner_cannot_be_reclassified_as_historical_by_repinning(self):
        self.fixture.owner["build_commit"] = self.fixture.current_build_commit
        self.fixture.owner["build_snapshot"] = self.fixture.current_build_snapshot
        self.fixture._rebuild()
        with self.assertRaises(BuildControlError):
            self.fixture.validate()

    def test_service_owner_is_never_fabricated_into_diagnostic_process_receipt(self):
        self.fixture.process["service_owner"] = {"state": "ready"}
        self.fixture._rebuild()
        with self.assertRaises(BuildControlError):
            self.fixture.validate()

    def test_fence_incarnation_must_match_process_and_terminal(self):
        self.fixture.fence["api_instance_id"] = "8" * 32
        self.fixture._rebuild()
        with self.assertRaises(BuildControlError):
            self.fixture.validate()

    def test_backend_started_at_must_match_the_frozen_container_incarnation(self):
        backend = copy.deepcopy(self.fixture.backend)
        backend["State"]["StartedAt"] = "2026-11-06T09:10:12Z"
        with self.assertRaises(BuildControlError):
            self.fixture.validate(backend=backend)

    def test_stale_runtime_bytes_cannot_be_authorized_by_old_hash(self):
        records = copy.deepcopy(self.fixture.runtime_records)
        records["process_receipt"]["raw_utf8"] += " "
        with self.assertRaises(BuildControlError):
            self.fixture.validate(runtime_records=records, control=None)

    def test_malformed_evidence_runtime_and_pin_mappings_raise_controlled_errors(self):
        malformed_evidence = self.fixture.collect()
        malformed_evidence["records"] = []
        with self.assertRaises(BuildControlError):
            self.fixture.validate(malformed_evidence)

        malformed_runtime = copy.deepcopy(self.fixture.runtime_records)
        malformed_runtime["owner"] = ["not", "a", "mapping"]
        with self.assertRaises(BuildControlError):
            self.fixture.validate(runtime_records=malformed_runtime)

        with self.assertRaises(BuildControlError):
            recovery.validate(
                self.fixture.collect(), None, self.fixture.runtime_records, self.fixture.backend,
            )

        with self.assertRaises(BuildControlError):
            recovery.validate(
                self.fixture.collect(), self.fixture.pins, self.fixture.runtime_records, None,
            )

class BootstrapProofIntegrationTests(unittest.TestCase):
    def setUp(self):
        import docker_volume_container_recovery as container_recovery
        self.r = container_recovery
        self.fixture = BootstrapFixture()
        self.read_patch = patch.object(stop, "_read_raw", side_effect=lambda c, path, **kw: c.files[path])
        self.read_patch.start()
        self.addCleanup(self.read_patch.stop)
        f = self.fixture
        pins = {**f.pins, "request_id": "11111111-1111-4111-8111-111111111111"}
        containers = {}
        network = f.compose_project + "_fullmag"
        for role in ("backend", "frontend"):
            containers[role] = {
                "Id": pins[role + "_container_id"], "Image": f.image_id,
                "Config": {"Hostname": f.owner["host"] if role == "backend" else "frontend",
                           "Labels": {"com.docker.compose.project": f.compose_project, "com.docker.compose.service": role}},
                "HostConfig": {"PidMode": "", "IpcMode": "private", "NetworkMode": network},
                "NetworkSettings": {"Networks": {network: {"NetworkID": "e" * 64}}},
                "Mounts": [{"Type": "bind", "Source": "/state/source", "Destination": "/state", "RW": True}],
                "State": {"Status": "exited", "Running": False, "Pid": 0, "ExitCode": 0,
                          "Paused": False, "Restarting": False, "FinishedAt": "2026-11-06T10:00:00Z",
                          "StartedAt": f.backend_started_at if role == "backend" else f.resume["frontend_started_at"]},
            }
        self.terminal = [{"run_id": "run-terminal", "run_intent_sha256": "1" * 64,
                          "run_catalog_sha256": "2" * 64, "artifact_catalog_sha256": None}]
        self.proof = {"schema": self.r.ABRUPT_PROOF_BOOTSTRAP_SCHEMA, "authorization_pins": pins,
                      "docker_engine_id_sha256": "f" * 64, "raw_records": f.runtime_records,
                      "containers": containers, "network": {"name": network, "state": "absent"},
                      "storage_proof": {"run_records": self.terminal}, "retained_terminal_runs": self.terminal,
                      "bootstrap_stop": f.collect()}
        self.auth = self.r.validate_operator_authorization({
            **pins, "schema_version": self.r.ABRUPT_OPERATOR_SCHEMA,
            "abrupt_stop_proof": "verification/bootstrap-proof.json",
            "abrupt_stop_proof_sha256": digest(canonical(self.proof))})

    def test_explicit_bootstrap_proof_validates_real_receipt_chain_without_fabricating_owner(self):
        original = copy.deepcopy(self.proof)
        self.r.validate_abrupt_stop_proof(self.proof, self.auth)
        self.assertEqual(self.proof, original)
        self.r._assert_request_matches_abrupt_retained_pins(
            {"schema_version": self.r.TERMINAL_REQUEST_SCHEMA, "retained_terminal_runs": self.terminal}, self.proof)
        for schema in (self.r.REQUEST_SCHEMA, self.r.HELD_MANUAL_REQUEST_SCHEMA, self.r.ATTEMPT_HISTORY_REQUEST_SCHEMA):
            with self.subTest(schema=schema), self.assertRaisesRegex(BuildControlError, "native terminal recovery v3"):
                self.r._assert_request_matches_abrupt_retained_pins(
                    {"schema_version": schema, "retained_terminal_runs": self.terminal}, self.proof)

    def test_preparer_uses_same_explicit_evidence_after_complete_stopped_pair_observation(self):
        f = self.fixture
        f.control.project = f.compose_project
        with ExitStack() as stack:
            stack.enter_context(patch.object(self.r, "_docker_engine_sha", return_value="f" * 64))
            stack.enter_context(patch.object(self.r, "_inspect_pair", return_value=tuple(self.proof["containers"].values())))
            stack.enter_context(patch.object(self.r, "_assert_no_foreign_storage_consumers"))
            stack.enter_context(patch.object(self.r, "_ledger_and_store_snapshot", return_value=self.proof["storage_proof"]))
            stack.enter_context(patch.object(self.r, "_abrupt_network", return_value=self.proof["network"]))
            for key, function in (("process_receipt", "_runtime_process_receipt"), ("owner", "_runtime_owner"),
                                  ("launch", "_runtime_launch"), ("config", "_runtime_config")):
                record = f.runtime_records[key]
                raw = record["raw_utf8"].encode()
                stack.enter_context(patch.object(self.r, function, return_value=(json.loads(raw), raw, record["sha256"])))
            observed = self.r.prepare_abrupt_stop_proof(
                f.control, self.proof["authorization_pins"], f.compose,
                retained_terminal_runs=self.terminal, bootstrap_stop_reference=f.reference)
        self.assertEqual(observed, self.proof)
        self.assertNotIn("service_owner", json.loads(observed["raw_records"]["process_receipt"]["raw_utf8"]))

    def test_preparer_does_not_select_bootstrap_for_mixed_history_or_held_inventory(self):
        f = self.fixture
        for extra in ({"retained_held_manual_runs": []}, {"retained_attempt_histories": []}):
            with self.subTest(extra=extra), patch.object(recovery, "collect") as collect:
                with self.assertRaisesRegex(BuildControlError, "only terminal recovery v3"):
                    self.r.prepare_abrupt_stop_proof(f.control, self.proof["authorization_pins"], f.compose,
                                                    retained_terminal_runs=self.terminal,
                                                    bootstrap_stop_reference=f.reference, **extra)
                collect.assert_not_called()

    def test_old_proof_cannot_opt_into_missing_owner_by_omission(self):
        old = {key: value for key, value in self.proof.items() if key != "bootstrap_stop"}
        old["schema"] = self.r.ABRUPT_PROOF_SCHEMA
        with self.assertRaisesRegex(BuildControlError, "no authenticated service owner"):
            self.r.validate_abrupt_stop_proof(old, self.auth)
        with self.assertRaisesRegex(BuildControlError, "frozen schema"):
            self.r.validate_abrupt_stop_proof({**old, "bootstrap_stop": self.proof["bootstrap_stop"]}, self.auth)

    def test_bootstrap_proof_requires_terminal_inventory_and_pinned_frontend_incarnation(self):
        for terminals in (None, []):
            with self.subTest(terminals=terminals), self.assertRaises(BuildControlError):
                self.r.validate_abrupt_stop_proof({**self.proof, "retained_terminal_runs": terminals}, self.auth)
        changed = copy.deepcopy(self.proof)
        changed["containers"]["frontend"]["State"]["StartedAt"] = "2026-11-06T11:00:00Z"
        with self.assertRaisesRegex(BuildControlError, "frontend incarnation"):
            self.r.validate_abrupt_stop_proof(changed, self.auth)
        with self.assertRaisesRegex(BuildControlError, "frozen schema"):
            self.r.validate_abrupt_stop_proof({**self.proof, "retained_held_manual_runs": []}, self.auth)

    def test_boundary_dispatch_rechecks_actual_process_owner_and_live_evidence(self):
        f = self.fixture
        self.r._validate_proof_process_owner(f.process, f.owner, self.proof, self.auth, control=f.control)
        with self.assertRaisesRegex(BuildControlError, "differ from frozen"):
            self.r._validate_proof_process_owner({**f.process, "api_pid": 999}, f.owner, self.proof, self.auth)
        owner_path = "runtime-control/runtime-services/OWNER.json"
        f.control.files[owner_path] += b" "
        with self.assertRaisesRegex(BuildControlError, "runtime record changed"):
            self.r._validate_proof_process_owner(f.process, f.owner, self.proof, self.auth, control=f.control)

    def test_legacy_operator_cannot_select_bootstrap_exception_with_hybrid_journal(self):
        f = self.fixture
        hybrid = {**self.proof, "state": "stopped-confirmed", "drained_process_receipt": {}}
        legacy = {**self.auth, "schema_version": self.r.OPERATOR_AUTHORIZATION_SCHEMA}
        with self.assertRaisesRegex(BuildControlError, "explicit abrupt operator"):
            self.r._validate_proof_process_owner(f.process, f.owner, hybrid, legacy)

    def test_repinning_wrong_launch_cannot_defer_failure_until_after_container_removal(self):
        for field, value in (("pid", 9999), ("pid", True), ("state", "failed"), ("state", []), ("schema_version", "wrong")):
            with self.subTest(field=field, value=value):
                f = BootstrapFixture()
                f.launch[field] = value
                f._rebuild()
                with self.assertRaisesRegex(BuildControlError, "LAUNCH"):
                    f.validate()


if __name__ == "__main__":
    unittest.main()
