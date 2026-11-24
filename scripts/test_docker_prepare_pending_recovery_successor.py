"""Fail-closed publication and immutable evidence for pending v6 handoff."""
import copy
import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import docker_prepare_pending_recovery_successor as s
from docker_build_control import BuildControlError
from test_docker_prepare_container_recovery import Control
from test_docker_pending_inbox_recovery import request_fixture


REAL_EXECUTOR = s._executor


class SuccessorTests(unittest.TestCase):
    def setUp(self):
        self.control = Control()
        self.previous = {"attempt": "a" * 32, "config_sha256": "b" * 64}
        self.request = request_fixture()
        self.pending = self.request.pop("retained_pending_inboxes")
        self.request.update(schema_version=s.recovery.ATTEMPT_HISTORY_REQUEST_SCHEMA,
            request_id="123e4567-e89b-42d3-a456-426614174000", containers=[],
            device_release_resource_id="cpu", device_release_mapping_sha256="c" * 64,
            docker_engine_id_sha256="d" * 64)
        self.observation = {"ancestor": {}, "protected_sha256": {}, "storage_proof": {},
                            "original_absence": [], "containers": {}}
        self.executor_patch = patch.object(s, "_executor", return_value=({"binary": {"path": "/opt/fullmag/package/bin/fullmag-bin", "sha256": "f" * 64}}, {"git_commit": "d" * 40, "source_snapshot_sha256": "e" * 64})).start()
        self.observe = patch.object(s, "_observe", return_value=(self.observation, {}, self.request)).start()
        patch.object(s.recovery, "validate_request", side_effect=lambda value: value).start()
        patch.object(s.recovery, "validate_attestation", side_effect=lambda value, *args: value).start()
        patch.object(s.recovery, "_control_bytes", side_effect=lambda control, path, optional=False: control.records.get(path)).start()
        self.addCleanup(patch.stopall)

    def prepare(self, **kwargs):
        return s.prepare(self.control, self.previous, {}, {}, self.pending,
                         executor_pin={"path": "executor.json", "sha256": "f" * 64},
                         request_id="123e4567-e89b-42d3-a456-426614174001", **kwargs)

    def test_service_observation_ignores_only_health_log_without_mutating_input(self):
        before = {"Id": "a" * 64, "Mounts": [{"Destination": "/state", "Source": "/original"},
                    {"Destination": "/package", "Source": "/package"}],
                  "State": {"StartedAt": "start", "Health": {"Status": "healthy", "FailingStreak": 0,
                            "Log": [{"Start": "old", "ExitCode": 0}]}}}
        original = copy.deepcopy(before)
        observed = copy.deepcopy(before)
        observed["State"]["Health"]["Log"].append({"Start": "new", "ExitCode": 0})
        observed["Mounts"].reverse()
        self.assertEqual(s._stable_service_observation(before), s._stable_service_observation(observed))
        self.assertEqual(before, original)
        self.assertEqual(len(observed["State"]["Health"]["Log"]), 2)
        for mutate in (lambda value: value["State"]["Health"].update(Status="unhealthy"),
                       lambda value: value["State"]["Health"].update(FailingStreak=1),
                       lambda value: value["State"].update(StartedAt="restarted"),
                       lambda value: value["Mounts"][0].update(Source="/other")):
            changed = copy.deepcopy(observed); mutate(changed)
            self.assertNotEqual(s._stable_service_observation(before), s._stable_service_observation(changed))

    def test_exec_ids_churn_is_not_an_incarnation_change(self):
        before = {"Id": "a" * 64, "Image": "sha256:" + "b" * 64, "ExecIDs": None,
                  "Mounts": [{"Destination": "/state", "Source": "/original"}],
                  "Config": {"Hostname": "owner"},
                  "State": {"Pid": 123, "StartedAt": "start", "Status": "running", "Running": True}}
        original = copy.deepcopy(before)
        for exec_ids in (None, [], ["exec-a"], ["exec-b", "exec-c"]):
            observed = {**copy.deepcopy(before), "ExecIDs": exec_ids}
            self.assertEqual(s._stable_service_observation(before), s._stable_service_observation(observed))
            self.assertEqual(observed["ExecIDs"], exec_ids)
        self.assertEqual(before, original)
        for mutate in (lambda value: value["State"].update(Pid=456),
                       lambda value: value["State"].update(StartedAt="restarted"),
                       lambda value: value["State"].update(Status="exited", Running=False),
                       lambda value: value.update(Image="sha256:" + "c" * 64),
                       lambda value: value["Mounts"][0].update(Source="/other"),
                       lambda value: value["Config"].update(Hostname="other")):
            changed = copy.deepcopy(before); changed["ExecIDs"] = ["transient"]
            mutate(changed)
            self.assertNotEqual(s._stable_service_observation(before), s._stable_service_observation(changed))

    def test_failed_development_receipt_without_ids_uses_compose_discovery(self):
        image = "sha256:" + "d" * 64
        document = {"name": self.control.project, "services": {service: {"image": image} for service in ("backend", "frontend")}}
        previous = {"attempt": "a" * 32, "state": "failed-confirmed", "backend_started_at": "start",
                    "config_sha256": s._sha(s.canonical(document))}
        actual = {service: {"Id": str(i) * 64, "Image": image, "Mounts": [],
                            "Config": {"Labels": {"com.docker.compose.project": self.control.project,
                                                   "com.docker.compose.service": service}},
                            "State": {"StartedAt": "start"}}
                  for i, service in enumerate(("backend", "frontend"), 1)}
        def discover(doc, *args): return actual[args[-1]]["Id"].encode()
        def inspect(identifier): return next(value for value in actual.values() if value["Id"] == identifier)
        original = copy.deepcopy(previous)
        with patch.object(s, "compose_capture", side_effect=discover), patch.object(s, "_inspect", side_effect=inspect), \
             patch.object(s, "docker_capture", return_value=SimpleNamespace(stdout=json.dumps([{"Id": image, "Config": {}}]).encode())), \
             patch("docker_volume_dev._validate_retained_service"), \
             patch.object(s.recovery, "_assert_no_foreign_storage_consumers"):
            s._services(self.control, previous, document, actual)
            self.assertEqual(previous, original)
            for mutated in ({**previous, "backend_container": "f" * 64},
                            {**previous, "backend_started_at": "other"}):
                with self.assertRaises(BuildControlError): s._services(self.control, mutated, document, actual)
            with patch.object(s, "compose_capture", return_value=("f" * 64).encode()):
                with self.assertRaises(BuildControlError): s._services(self.control, previous, document, actual)
            with patch.object(s, "compose_capture", return_value=b""):
                with self.assertRaises(s.recovery.ContainerRecoveryError): s._services(self.control, previous, document, actual)

    def test_dryrun_is_inert_and_new_request_uuid_required(self):
        self.prepare()
        self.assertEqual(self.control.records, {})
        self.assertEqual(self.control.events, [])
        with self.assertRaisesRegex(BuildControlError, "new UUID"):
            s.prepare(self.control, self.previous, {}, {}, self.pending, executor_pin={}, request_id=self.request["request_id"])

    def test_candidate_has_fresh_attestation_and_never_runtime_authorization(self):
        result = self.prepare(publish=True)
        self.assertFalse(result["compute_started"])
        self.assertFalse(any(path.endswith("authorization.json") for path in self.control.records))
        candidate = s._read(self.control, result["candidate"])
        request = s._read(self.control, candidate["request"])
        attestation = s._read(self.control, candidate["attestation"])
        self.assertEqual(request["schema_version"], s.recovery.PENDING_INBOX_REQUEST_SCHEMA)
        self.assertEqual(attestation["request_sha256"], candidate["request"]["sha256"])
        self.assertEqual(request["retained_pending_inboxes"], self.pending)
        self.assertEqual(self.observe.call_count, 2)

    def test_v7_candidate_preserves_inert_v6_and_propagates_absence_twice(self):
        self.request["retained_terminal_runs"].append({**self.request["retained_terminal_runs"][0], "run_id": "run-absent"})
        old = self.prepare(publish=True)
        frozen = copy.deepcopy(self.control.records)
        absent = [{"run_id": "run-absent", "task_id": "task-before-prepare", "attempt_id": "attempt-before-prepare",
                   "resource_id": "cpu", "ownership_epoch": 1, "inbox_absence": "directory_absent",
                   "release_proof_sha256": "a" * 64}]
        result = s.prepare(self.control, self.previous, {}, {}, self.pending, executor_pin={"path": "executor.json", "sha256": "f" * 64},
                           retained_absent_inboxes=absent, request_id="123e4567-e89b-42d3-a456-426614174002", publish=True)
        candidate = s._read(self.control, result["candidate"])
        request = s._read(self.control, candidate["request"])
        self.assertEqual(request["schema_version"], "runtime_service_container_recovery_request.v7")
        self.assertEqual(request["retained_absent_inboxes"], absent)
        self.assertNotEqual(result["candidate"], old["candidate"])
        for path, raw in frozen.items(): self.assertEqual(self.control.records[path], raw)
        for call in self.observe.call_args_list[-2:]: self.assertEqual(call.kwargs["retained_absent_inboxes"], absent)
        self.assertEqual(self.executor_patch.call_args.kwargs["request_schema"], "runtime_service_container_recovery_request.v7")
        self.assertFalse(any(path.endswith("authorization.json") for path in self.control.records))
        # The same UUID cannot replace the old inert v6 candidate.
        with self.assertRaises(s.recovery.ContainerRecoveryError):
            self.prepare(retained_absent_inboxes=absent, publish=True)

    def test_changed_snapshot_under_lease_cannot_publish(self):
        self.observe.side_effect = [(self.observation, {}, self.request), ({**self.observation, "changed": True}, {}, self.request)]
        with self.assertRaisesRegex(BuildControlError, "changed under"):
            self.prepare(publish=True)
        self.assertEqual(self.control.records, {})

    def test_immutable_candidate_refuses_conflicting_bytes(self):
        first = self.prepare(publish=True)
        path = first["request"]["path"]
        self.control.records[path] += b" "
        with self.assertRaisesRegex(s.recovery.ContainerRecoveryError, "different bytes"):
            self.prepare(publish=True)

    def test_raw_digest_and_duplicate_json_fields_refuse(self):
        self.control.records["evidence.json"] = b'{"x":1}'
        with self.assertRaisesRegex(BuildControlError, "record changed"):
            s._read(self.control, {"path": "evidence.json", "sha256": "a" * 64})
        raw = b'{"x":1,"x":2}'
        self.control.records["evidence.json"] = raw
        with self.assertRaises(s.recovery.ContainerRecoveryError):
            s._read(self.control, s._ref("evidence.json", raw))
        with self.assertRaises(s.recovery.ContainerRecoveryError):
            s._read(self.control, {"path": "../outside", "sha256": "a" * 64})

    def test_any_native_receipt_blocks_successor(self):
        sha = "a" * 64
        path = "runtime-control/runtime-services/container-recovery/" + sha + "/receipt.json"
        s._no_completion(self.control, sha)
        for state in ("prepared", "recovered", "corrupt"):
            self.control.records[path] = json.dumps({"status": state}).encode()
            with self.assertRaisesRegex(BuildControlError, "receipt already exists"):
                s._no_completion(self.control, sha)

    def test_preview_requires_exact_request_attestation_outcome_and_build(self):
        request = {**request_fixture(), **{key: "a" * 64 for key in ("config_sha256", "owner_sha256", "launch_sha256", "ledger_snapshot_sha256")}}
        candidate = {"request": {"path": "request.json", "sha256": "b" * 64},
                     "attestation": {"path": "attestation.json", "sha256": "c" * 64},
                     "executor": {}, "observation": {"containers": {}},
                     "development_attempt": "a" * 32, "compose_config_sha256": "b" * 64}
        preview = {**request, "schema_version": s.PREVIEW_SCHEMA, "status": "validated",
                   "request_sha256": "b" * 64, "attestation_sha256": "c" * 64,
                   "expected_outcome": "retained_pending_inboxes_recovered",
                   "executor_build_commit": "d" * 40, "executor_build_snapshot": "e" * 64}
        def check(value, mutation=None):
            raw = s.recovery._canonical(value)
            self.control.records["stdout.json"] = raw
            execution = {"schema": "fullmag.pending-recovery-preview-execution.v1", "executor": {}, "candidate": {},
                         "argv": ["/opt/fullmag/package/bin/fullmag-bin", "runtime", "service-preview-container-recovery",
                                  "--config", "/opt/fullmag/runtime-control/runtime-service/docker-all.json",
                                  "--request", "/opt/fullmag/control/request.json", "--request-sha256", "b" * 64,
                                  "--attestation", "/opt/fullmag/control/attestation.json", "--attestation-sha256", "c" * 64],
                         "exit_code": 0, "stdout": s._ref("stdout.json", raw),
                         "binary_sha256_before": "f" * 64, "binary_sha256_after": "f" * 64,
                         "operation": {"attempt": "a" * 32}}
            if mutation: execution.update(mutation)
            encoded = s.recovery._canonical(execution)
            self.control.records["execution.json"] = encoded
            pin = s._ref("execution.json", encoded)
            self.control.records["pending-recovery-preview/attempts/" + "a" * 32 + "/terminal.json"] = b"{}"
            terminal = {"preview_execution": pin, "inputs": {"candidate": {}, "executor": {}}}
            with patch("docker_volume_drained_successor._operation", return_value=("root", terminal)):
                return s._preview(self.control, pin, candidate, request, {})
        self.assertEqual(check(preview), preview)
        for key, value in (("status", "failed"), ("request_sha256", "f" * 64),
                           ("attestation_sha256", "f" * 64), ("owner_sha256", "f" * 64),
                           ("expected_outcome", "retained_attempt_history_recovered"),
                           ("executor_build_snapshot", "f" * 64), ("executor_build_commit", "a" * 40)):
            with self.subTest(key=key), self.assertRaises(BuildControlError): check({**preview, key: value})
        for mutation in ({"exit_code": 1}, {"binary_sha256_after": "e" * 64},
                         {"argv": ["fullmag-bin", "runtime", "service-recover-container"]}):
            with self.subTest(mutation=mutation), self.assertRaises(BuildControlError): check(preview, mutation)

    def test_executor_rejects_missing_v6_changed_binary_and_foreign_build(self):
        container = {"id": "a" * 64, "image_id": "sha256:" + "b" * 64, "started_at": "now"}
        package = {"schema": "fullmag.direct-compose.backend-build-receipt.v1", "state": "succeeded",
                   "source": {"resolved_commit": "c" * 40, "source_snapshot_sha256": "d" * 64},
                   "artifacts": [{"path": "bin/fullmag-bin", "sha256": "e" * 64}]}
        capabilities = {"schema_version": "runtime_service_container_recovery_capabilities.v1",
                        "supported_recovery_schemas": [s.recovery.PENDING_INBOX_REQUEST_SCHEMA],
                        "build_identity": {"git_commit": "c" * 40, "source_snapshot_sha256": "d" * 64}}
        def check(pkg, caps, selected=container, schema=s.recovery.PENDING_INBOX_REQUEST_SCHEMA):
            def store(path, value):
                raw = s.recovery._canonical(value); self.control.records[path] = raw
                return s._ref(path, raw)
            executor = {"schema": "fullmag.pending-recovery-executor.v1", "container": selected,
                        "package_receipt": store("package.json", pkg), "capabilities": store("caps.json", caps),
                        "binary": {"path": "/opt/fullmag/package/bin/fullmag-bin", "sha256": "e" * 64}}
            return REAL_EXECUTOR(self.control, store("executor.json", executor), {"backend": container}, request_schema=schema)
        check(package, capabilities)
        with self.assertRaises(BuildControlError): check(package, capabilities, schema="runtime_service_container_recovery_request.v7")
        check(package, {**capabilities, "supported_recovery_schemas": [s.recovery.PENDING_INBOX_REQUEST_SCHEMA, "runtime_service_container_recovery_request.v7"]},
              schema="runtime_service_container_recovery_request.v7")
        for bad in ({**package, "state": "failed"}, {**package, "artifacts": []},
                    {**package, "source": {**package["source"], "resolved_commit": "f" * 40}}):
            with self.assertRaises(BuildControlError): check(bad, capabilities)
        for bad in ({**capabilities, "supported_recovery_schemas": []},
                    {**capabilities, "extra": "unsupported"}):
            with self.assertRaises(BuildControlError): check(package, bad)
        with self.assertRaises(BuildControlError): check(package, capabilities, {**container, "started_at": "later"})

    def test_ancestor_manifest_binds_original_host_and_raw_container_config(self):
        configs = {service: {"Hostname": "old-host" if service == "backend" else "frontend"} for service in ("backend", "frontend")}
        pins = [{"service": service, "container_id": str(i) * 64, "image_id": "sha256:" + "f" * 64,
                 "config_sha256": s._sha(s.recovery._canonical(configs[service]))} for i, service in enumerate(("backend", "frontend"), 1)]
        request = {"containers": pins, "expected_owner": {"host": "old-host"}, "docker_engine_id_sha256": "d" * 64,
                   "prior_ready_owner_proof_sha256": "e" * 64}
        auth = {"request_id": "uuid", "source_root": "/source", "prior_stop_journal_sha256": "e" * 64}
        manifest = {"schema": "fullmag.docker-container-recovery-manifest.v1", "request_id": "uuid",
                    "source_root": "/source", "compose_project": "group", "docker_engine_id_sha256": "d" * 64,
                    "prior_ready_owner_proof_sha256": "e" * 64, "stop_journal_sha256": "e" * 64,
                    "containers": [{"service": pin["service"], "pin": pin,
                        "inspect": {"Id": pin["container_id"], "Image": pin["image_id"], "Config": configs[pin["service"]],
                                    "State": {"Running": False, "Pid": 0}}} for pin in pins]}
        s._validate_ancestor_manifest(manifest, request, auth, "group")
        for mutate in (lambda m: m.update(compose_project="foreign"),
                       lambda m: m["containers"][0]["inspect"]["Config"].update(Hostname="new-host"),
                       lambda m: m["containers"][0]["inspect"]["State"].update(Running=True),
                       lambda m: m.update(containers=m["containers"][:1])):
            bad = copy.deepcopy(manifest); mutate(bad)
            with self.assertRaises(BuildControlError): s._validate_ancestor_manifest(bad, request, auth, "group")

    def test_stop_witness_authenticates_raw_python_probe_and_exact_exit(self):
        before = {"backend": {"id": "a" * 64, "image_id": "sha256:" + "b" * 64, "started_at": "start"},
                  "frontend": {"id": "c" * 64, "image_id": "sha256:" + "b" * 64, "started_at": "front-start"}}
        after = {**before["backend"], "status": "exited", "running": False, "pid": 0,
                 "exit_code": 0, "oom_killed": False, "finished_at": "end"}
        actual = {service: {"Id": value["id"], "Image": value["image_id"], "State": {"StartedAt": value["started_at"]}}
                  for service, value in before.items()}
        actual["backend"]["State"].update(Status="exited", Running=False, Pid=0, ExitCode=0, OOMKilled=False, FinishedAt="end")
        candidate = {"observation": {"containers": before, "protected_sha256": {"owner": "d" * 64}}}
        base = "pending-diagnostic-stop/attempts/" + "e" * 32
        def store(path, value, raw=False):
            data = value if raw else s.recovery._canonical(value)
            self.control.records[path] = data
            return s._ref(path, data)
        witness = {"schema": s.STOP_SCHEMA, "development_attempt": self.previous["attempt"],
                   "compose_config_sha256": self.previous["config_sha256"],
                   "operation": {"phase": "pending-diagnostic-stop", "attempt": "e" * 32, "terminal_sha256": "f" * 64},
                   "backend_before": before["backend"], "backend_after": after, "frontend": before["frontend"],
                   "protected_sha256": {"owner": "d" * 64}, "preview": store(base + "/preview.json", {}),
                   "probe": store(base + "/probe.py", b"print('read only')", raw=True)}
        result = {"state": "stopped-confirmed", "backend_id": before["backend"]["id"], "exit_code": 0,
                  "operation_attempt": "e" * 32, "frontend_preserved": True, "history_preserved": True, "solve_started": False,
                  **{key: witness[key] for key in ("backend_before", "backend_after", "frontend", "protected_sha256", "preview", "probe")}}
        witness["result"] = store(base + "/result.json", result)
        terminal = {"diagnostic_stop_result": witness["result"]}
        with patch("docker_volume_drained_successor._operation", return_value=(base, terminal)):
            pin = store("stop.json", witness)
            s._stop(self.control, pin, candidate, self.previous, actual)
            for key, value in (("StartedAt", "restarted"), ("ExitCode", 1), ("Running", True), ("FinishedAt", "later")):
                bad = copy.deepcopy(actual); bad["backend"]["State"][key] = value
                with self.subTest(key=key), self.assertRaises(BuildControlError):
                    s._stop(self.control, pin, candidate, self.previous, bad)
            with self.assertRaises(BuildControlError):
                s._stop(self.control, pin, candidate, self.previous, actual, removed_container_proof={"schema": "foreign"})
            terminal.clear()
            with self.assertRaisesRegex(BuildControlError, "bound by terminal"):
                s._stop(self.control, pin, candidate, self.previous, actual)

    def test_failed_final_revalidation_never_publishes_selector(self):
        result = self.prepare(publish=True)
        candidate = s._read(self.control, result["candidate"])
        request = s._read(self.control, candidate["request"])
        with patch.object(s, "_validate_evidence", return_value=(candidate, {}, request)), \
             patch.object(s, "_authorization", return_value={"inert": "fixture"}), \
             patch.object(s, "validate_published", side_effect=BuildControlError("changed")):
            with self.assertRaisesRegex(BuildControlError, "changed"):
                s.publish(self.control, self.previous, {}, {}, result["candidate"], {}, {})
        self.assertFalse(any(path.endswith("successor.json") for path in self.control.records))

    def test_successor_selector_is_last_and_no_old_document_rewritten(self):
        result = self.prepare(publish=True)
        candidate = s._read(self.control, result["candidate"])
        request = s._read(self.control, candidate["request"])
        before = copy.deepcopy(self.control.records)
        with patch.object(s, "_validate_evidence", return_value=(candidate, {}, request)), \
             patch.object(s, "_authorization", return_value={"inert": "fixture"}), \
             patch.object(s, "validate_published", return_value={}):
            published = s.publish(self.control, self.previous, {}, {}, result["candidate"], {}, {})
        self.assertFalse(published["compute_started"])
        for path, raw in before.items(): self.assertEqual(self.control.records[path], raw)
        self.assertTrue(self.control.events[-2].endswith("successor.json"))


if __name__ == "__main__":
    unittest.main()
