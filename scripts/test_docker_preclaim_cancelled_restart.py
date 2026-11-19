"""Interpreted regressions for the narrowly pinned cancelled-preclaim restart."""
from pathlib import Path
import copy
import fcntl
import hashlib
import json
import os
import stat
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_volume_dev as dev
import docker_preclaim_cancelled_restart as preclaim
from docker_build_control import BuildControlError, canonical
import test_docker_volume_receipts as receipt_tests


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def fixture():
    _, request, scene, _, _, _, _, proof = receipt_tests.SavedAuthoringRestartTests().fixture()
    request["schema"] = preclaim.SCHEMA
    pin = {name: "a" * 64 for name in preclaim.HASH_FIELDS}
    pin.update(run_id="run-one", task_id="task-one", command_id="command-one")
    request["cancelled_preclaim"] = pin
    rows = proof["resources"]
    command = {"command_id": pin["command_id"], "kind": "mesh_build", "status": "accepted",
               "target": {"kind": "run", "run_id": pin["run_id"]}}
    rows["commands"]["body"].update(commands=[command], accepted_count=1)
    pin["command_sha256"] = digest(command)
    run = {"run_id": pin["run_id"], "session_id": request["session"]["session_id"],
           "status": "waiting_for_compute"}
    rows["run"].update(status=200, body=run)
    pin["live_run_sha256"] = digest(run)
    for suffix in ("before", "after"):
        rows["current_" + suffix]["body"]["status"] = "waiting_for_compute"
        status = rows["status_" + suffix]["body"]
        status.update(run={"run_id": pin["run_id"]}, lifecycle={"solver": "waiting_for_compute"})
        status["resources"].update(artifact_revision=0, field_revision=0, fields_revision=0)
    proof["run_directories"] = [pin["run_id"]]
    proof["preclaim_cancelled_snapshot"] = {
        "writer_locks_held_together": True, "run_id": pin["run_id"], "task_id": pin["task_id"],
        "host_reservation_count": 0, "run_directories": [pin["run_id"]],
        "run_root_entries": ["run_catalog.json", "run_intent.json", "task_cancellation_intents"],
        **{key: pin[key] for key in preclaim.HASH_FIELDS[:3]}}
    return request, scene, proof


def historical_fixture():
    old, _, old_proof = fixture()
    _, request, scene, _, _, _, _, proof = receipt_tests.SavedAuthoringRestartTests().fixture()
    request["historical_preclaim"] = {
        "session": copy.deepcopy(old["session"]), "archive": {"scene_revision": old["archive"]["scene_revision"]},
        "cancelled_preclaim": copy.deepcopy(old["cancelled_preclaim"])}
    session = request["historical_preclaim"]["session"]
    session.update(session_id="historical-session", session_epoch="historical-session@123")
    proof["run_directories"] = ["run-one"]
    proof["historical_preclaim_cancelled_snapshot"] = old_proof["preclaim_cancelled_snapshot"]
    return request, scene, proof


def combined_fixture():
    request, scene, proof = fixture()
    historical_request, _, historical_proof = historical_fixture()
    historical = historical_request["historical_preclaim"]
    historical["cancelled_preclaim"]["run_id"] = "run-old"
    request["historical_preclaim"] = historical
    proof["run_directories"] = ["run-old", "run-one"]
    proof["preclaim_cancelled_snapshot"]["run_directories"] = proof["run_directories"]
    snapshot = historical_proof["historical_preclaim_cancelled_snapshot"]
    snapshot.update(run_id="run-old", run_directories=proof["run_directories"])
    proof["historical_preclaim_cancelled_snapshot"] = snapshot
    return request, scene, proof


def stopped_fixture():
    request, scene, proof = combined_fixture()
    pin = request["cancelled_preclaim"]
    stop = {"command_id": "stop-one", "kind": "stop", "status": "accepted",
            "target": {"kind": "run", "run_id": pin["run_id"]}}
    pin.update(stop_command_id=stop["command_id"], stop_command_sha256=digest(stop))
    rows = proof["resources"]
    rows["commands"]["body"]["commands"].append(stop)
    rows["commands"]["body"]["accepted_count"] = 2
    rows["run"]["body"]["status"] = "cancelled"
    request["session"]["session_epoch"] += ":tombstone:2"
    pin["live_run_sha256"] = digest(rows["run"]["body"])
    for suffix in ("before", "after"):
        rows["current_" + suffix]["body"]["status"] = "cancelled"
        rows["status_" + suffix]["body"]["session"]["session_epoch"] = request["session"]["session_epoch"]
        rows["status_" + suffix]["body"]["lifecycle"]["solver"] = "cancelled"
        rows["status_" + suffix]["body"]["solver"]["state"] = "cancelled"
    return request, scene, proof


class PublicStopPreclaimBindingTests(receipt_tests.IsolatedReceiptTests):
    def test_saved_authoring_restart_forwards_explicit_stop_only(self):
        for args, expected in ((SimpleNamespace(), False),
                               (SimpleNamespace(stop_only=False), False),
                               (SimpleNamespace(stop_only=True), True)):
            with patch.object(dev, "_retained_operation", return_value=17) as operation:
                self.assertEqual(dev.restart_idle(args), 17)
                operation.assert_called_once_with(args, recreate_services=False,
                                                  restart_idle_service=True, stop_after_drain=expected)

    def test_exact_public_stop_binds_cancelled_current_and_historical_runs(self):
        request, scene, proof = stopped_fixture()
        dev._saved_authoring_validate_request(request, project="fullmag-test", attempt="b" * 32,
                                             config_sha256="c" * 64, selected="/selected")
        dev._saved_authoring_validate_probe(proof, request, scene)
        proof["resources"]["commands"]["body"]["commands"].reverse()
        dev._saved_authoring_validate_probe(proof, request, scene)

    def test_stop_pin_pair_is_complete_valid_and_distinct(self):
        request, _, _ = stopped_fixture()
        for mutate in (lambda p: p.pop("stop_command_id"),
                       lambda p: p.pop("stop_command_sha256"),
                       lambda p: p.update(stop_command_sha256="0" * 64),
                       lambda p: p.update(stop_command_id="../stop"),
                       lambda p: p.update(stop_command_id=p["command_id"])):
            bad = copy.deepcopy(request); mutate(bad["cancelled_preclaim"])
            with self.assertRaises(BuildControlError):
                preclaim.validate_checkpoint(bad)

    def test_changed_stop_journal_or_nonterminal_state_is_rejected(self):
        request, scene, proof = stopped_fixture()
        for mutate in (
            lambda p: p["resources"]["commands"]["body"]["commands"][1].update(command_id="other"),
            lambda p: p["resources"]["commands"]["body"]["commands"][1].update(kind="solve"),
            lambda p: p["resources"]["commands"]["body"]["commands"][1].update(status="running"),
            lambda p: p["resources"]["commands"]["body"]["commands"][1]["target"].update(run_id="other"),
            lambda p: p["resources"]["commands"]["body"]["commands"].append({}),
            lambda p: p["resources"]["commands"]["body"].update(accepted_count=1),
            lambda p: p["resources"]["run"]["body"].update(status="waiting_for_compute"),
            lambda p: p["resources"]["status_after"]["body"]["lifecycle"].update(solver="running"),
            lambda p: p["resources"]["status_after"]["body"]["solver"].update(state="running"),
            lambda p: p["resources"]["status_after"]["body"]["resources"].update(field_revision=1),
        ):
            bad = copy.deepcopy(proof); mutate(bad)
            with self.assertRaises(BuildControlError):
                dev._saved_authoring_validate_probe(bad, request, scene)
        request["cancelled_preclaim"]["stop_command_sha256"] = "f" * 64
        with self.assertRaises(BuildControlError):
            preclaim.validate_binding(proof, request)


class HistoricalPreclaimBindingTests(receipt_tests.IsolatedReceiptTests):
    def test_normal_current_session_accepts_one_pinned_historical_run(self):
        request, scene, proof = historical_fixture()
        dev._saved_authoring_validate_request(request, project="fullmag-test", attempt="b" * 32,
                                             config_sha256="c" * 64, selected="/selected")
        dev._saved_authoring_validate_probe(proof, request, scene)
        self.assertEqual(preclaim.expected_run_directories(request), ["run-one"])

    def test_current_and_historical_cancelled_runs_require_both_exact_proofs(self):
        request, scene, proof = combined_fixture()
        dev._saved_authoring_validate_request(request, project="fullmag-test", attempt="b" * 32,
                                             config_sha256="c" * 64, selected="/selected")
        dev._saved_authoring_validate_probe(proof, request, scene)
        self.assertEqual(preclaim.expected_run_directories(request), ["run-old", "run-one"])
        for name in ("preclaim_cancelled_snapshot", "historical_preclaim_cancelled_snapshot"):
            for mutate in (lambda p: p.pop(name),
                           lambda p: p[name].update(run_directories=["run-one"]),
                           lambda p: p[name].update(run_catalog_sha256="f" * 64),
                           lambda p: p[name].update(host_reservation_count=1)):
                bad = copy.deepcopy(proof); mutate(bad)
                with self.subTest(name=name), self.assertRaises(BuildControlError):
                    dev._saved_authoring_validate_probe(bad, request, scene)
        request["historical_preclaim"]["cancelled_preclaim"]["run_id"] = "run-one"
        with self.assertRaises(BuildControlError):
            preclaim.expected_run_directories(request)

    def test_rejects_ambiguous_or_malformed_historical_identity(self):
        request, _, _ = historical_fixture()
        for mutate in (
            lambda r: r.update(schema=preclaim.SCHEMA),
            lambda r: r.update(cancelled_preclaim=r["historical_preclaim"]["cancelled_preclaim"]),
            lambda r: r["historical_preclaim"].update(session=r["session"]),
            lambda r: r["historical_preclaim"]["session"].update(request_scope_epoch="foreign:4"),
            lambda r: r["historical_preclaim"]["session"].update(source_kind="script"),
            lambda r: r["historical_preclaim"]["archive"].update(scene_revision=True),
            lambda r: r["historical_preclaim"]["archive"].update(scene_revision=-1),
            lambda r: r["historical_preclaim"]["cancelled_preclaim"].update(run_id="../run"),
            lambda r: r["historical_preclaim"]["cancelled_preclaim"].update(run_catalog_sha256="0" * 64),
            lambda r: r["historical_preclaim"].update(extra=True),
        ):
            bad = copy.deepcopy(request); mutate(bad)
            with self.subTest(request=bad), self.assertRaises(BuildControlError):
                dev._saved_authoring_validate_request(bad, project="fullmag-test", attempt="b" * 32,
                                                     config_sha256="c" * 64, selected="/selected")

    def test_historical_exception_does_not_relax_current_live_or_durable_checks(self):
        request, scene, proof = historical_fixture()
        for mutate in (
            lambda p: p["resources"]["commands"]["body"].update(accepted_count=1),
            lambda p: p["resources"]["run"].update(status=200, body={"status": "running"}),
            lambda p: p["resources"]["queue"]["body"].update(items=[{"state": "running"}]),
            lambda p: p["resources"]["status_after"]["body"]["session"].update(session_id="historical-session"),
            lambda p: p["resources"]["scene_after"]["body"].update(revision=2),
            lambda p: p.update(run_directories=["run-one", "other"]),
            lambda p: p["historical_preclaim_cancelled_snapshot"].update(host_reservation_count=1),
            lambda p: p["historical_preclaim_cancelled_snapshot"].update(writer_locks_held_together=False),
            lambda p: p["historical_preclaim_cancelled_snapshot"].update(cancellation_intent_sha256="b" * 64),
            lambda p: p.pop("historical_preclaim_cancelled_snapshot"),
            lambda p: p.update(preclaim_cancelled_snapshot=p["historical_preclaim_cancelled_snapshot"]),
        ):
            bad = copy.deepcopy(proof); mutate(bad)
            with self.subTest(proof=bad), self.assertRaises(BuildControlError):
                dev._saved_authoring_validate_probe(bad, request, scene)

    def test_unrequested_historical_proof_is_rejected(self):
        request, scene, proof = historical_fixture()
        request.pop("historical_preclaim")
        proof["run_directories"] = []
        with self.assertRaises(BuildControlError):
            dev._saved_authoring_validate_probe(proof, request, scene)


class CancelledPreclaimBindingTests(receipt_tests.IsolatedReceiptTests):
    def test_accepts_only_explicit_pinned_schema(self):
        request, scene, proof = fixture()
        dev._saved_authoring_validate_request(request, project="fullmag-test", attempt="b" * 32,
                                             config_sha256="c" * 64, selected="/selected")
        dev._saved_authoring_validate_probe(proof, request, scene)
        for mutate in (
            lambda r: r.update(schema="fullmag.saved-authoring-restart.v1"),
            lambda r: r.pop("cancelled_preclaim"),
            lambda r: r["cancelled_preclaim"].update(task_id="../task"),
            lambda r: r["cancelled_preclaim"].update(run_catalog_sha256="0" * 64),
        ):
            bad = copy.deepcopy(request); mutate(bad)
            with self.assertRaises(BuildControlError):
                dev._saved_authoring_validate_request(bad, project="fullmag-test", attempt="b" * 32,
                                                     config_sha256="c" * 64, selected="/selected")

    def test_legacy_schema_does_not_admit_cancelled_run(self):
        request, scene, proof = fixture()
        request.pop("cancelled_preclaim")
        request["schema"] = "fullmag.saved-authoring-restart.v1"
        with self.assertRaises(BuildControlError):
            dev._saved_authoring_validate_probe(proof, request, scene)

    def test_refuses_changed_runtime_or_missing_durable_proof(self):
        request, scene, proof = fixture()
        mutations = (
            lambda p: p["resources"]["queue"]["body"].update(items=[{"state": "running"}]),
            lambda p: p["resources"]["commands"]["body"].update(running_count=1),
            lambda p: p["resources"]["commands"]["body"]["commands"][0].update(kind="run"),
            lambda p: p["resources"]["commands"]["body"]["commands"].append({}),
            lambda p: p["resources"]["run"]["body"].update(status="running"),
            lambda p: p["resources"]["status_after"]["body"]["session"].update(request_scope_epoch="api-one:5"),
            lambda p: p["resources"]["status_after"]["body"]["resources"].update(field_revision=1),
            lambda p: p["resources"]["status_after"]["body"]["solver"].update(state="running"),
            lambda p: p["resources"]["preparation"].update(status=200),
            lambda p: p["resources"]["mesh_manifest"].update(status=200, body={}),
            lambda p: p["resources"]["scene_after"]["body"].update(revision=2),
            lambda p: p["preclaim_cancelled_snapshot"].update(writer_locks_held_together=False),
            lambda p: p["preclaim_cancelled_snapshot"].update(host_reservation_count=1),
            lambda p: p["preclaim_cancelled_snapshot"].update(run_catalog_sha256="b" * 64),
            lambda p: p.pop("preclaim_cancelled_snapshot"),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                bad = copy.deepcopy(proof); mutate(bad)
                with self.assertRaises(BuildControlError):
                    dev._saved_authoring_validate_probe(bad, request, scene)


class CancelledPreclaimStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.store = root / "store"; self.ledger = root / "ledger"
        for p in (self.store / "runs", self.store / "temp", self.store / "recovery", self.ledger):
            p.mkdir(parents=True)
        for p in (self.store, self.ledger):
            (p / "WRITER.lock").write_bytes(b"")
        self.request, _, _ = fixture()
        self.pin = self.request["cancelled_preclaim"]
        self.run = self.store / "runs" / self.pin["run_id"]
        (self.run / "task_cancellation_intents").mkdir(parents=True)
        command_id = "live-preparation-" + self.pin["command_id"]
        live = {"api_instance_id": "api-one", "session_id": "session-one", "session_epoch": 4,
                "scene_revision": 1, "command_id": command_id, "request_idempotency_key": command_id,
                "startup_source_sha256": "d" * 64,
                "command": {"kind": "startup_script", "request_id": command_id, "source_sha256": "d" * 64}}
        spec = {"parameters": {"live_workspace": live,
                "fullmag.accepted_run_start": {"schema_version": "accepted_run_start_policy.v1", "mode": "manual"}}}
        self.intent = {"schema_version": "run_intent.v1", "run_id": self.pin["run_id"],
                       "specification": spec, "payload_sha256": digest(spec),
                       "idempotency_key": "live-http-" + hashlib.sha256(command_id.encode()).hexdigest()}
        old = {"task_id": self.pin["task_id"], "lifecycle": "queued", "artifact_ids": [],
               "input_fingerprint": "c" * 64}
        self.catalog = {"schema_version": "run_catalog.v1", "run_id": self.pin["run_id"], "revision": 3,
                        "tasks": [{**old, "lifecycle": "cancelled"}]}
        self.cancel = {"schema_version": "task_cancellation_intent.v1", "run_id": self.pin["run_id"],
                       "cancellation_id": "cancel-one", "expected_catalog_revision": 2,
                       "task": old, "reason": "operator"}
        self.cancel["request_sha256"] = digest(self.cancel)
        self.resources = {"schema_version": "host_resource_ledger.v4", "reservations": []}
        helpers = "def canon(value):" + dev._SAVED_AUTHORING_PROBE_SCRIPT.split("def canon(value):", 1)[1].split("scope='session='", 1)[0]
        namespace = dict(fcntl=fcntl, hashlib=hashlib, json=json, os=os, pathlib=__import__("pathlib"),
                         stat=stat, time=time, MAX=8 * 1024 * 1024)
        exec(helpers + preclaim.PROBE_FUNCTION, namespace)
        self.collect = namespace["preclaim_cancelled_snapshot"]
        self.collect_all = namespace["preclaim_cancelled_snapshots"]
        self.write_records()

    def write_records(self):
        for name, path, value in (
            ("run_intent", self.run / "run_intent.json", self.intent),
            ("run_catalog", self.run / "run_catalog.json", self.catalog),
            ("cancellation_intent", self.run / "task_cancellation_intents" / (self.pin["task_id"] + ".json"), self.cancel),
        ):
            raw = canonical(value); path.write_bytes(raw)
            self.pin[name + "_sha256"] = hashlib.sha256(raw).hexdigest()
        (self.ledger / "HOST_RESOURCE_LEDGER.json").write_bytes(canonical(self.resources))

    def test_collects_consistent_snapshot_without_modifying_records(self):
        before = {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()}
        proof = self.collect(self.store, self.ledger, self.request)
        self.assertTrue(proof["writer_locks_held_together"])
        self.assertEqual(proof["host_reservation_count"], 0)
        self.assertEqual(before, {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()})

    def test_historical_snapshot_uses_old_identity_not_current_identity(self):
        historical = {"session": copy.deepcopy(self.request["session"]),
                      "archive": {"scene_revision": self.request["archive"]["scene_revision"]},
                      "cancelled_preclaim": self.pin}
        request = {"schema": "fullmag.saved-authoring-restart.v1",
                   "session": {"session_id": "new-session"}, "historical_preclaim": historical}
        binding = preclaim.validate_historical_checkpoint(request)
        before = {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()}
        snapshot = self.collect(self.store, self.ledger, binding)
        preclaim.validate_historical_binding({"historical_preclaim_cancelled_snapshot": snapshot}, request)
        self.assertEqual(before, {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()})
        changed = copy.deepcopy(binding)
        changed["session"].update(session_id="new-session", session_epoch="new-session@123")
        with self.assertRaisesRegex(RuntimeError, "another live command/session"):
            self.collect(self.store, self.ledger, changed)

    def test_two_run_snapshot_checks_both_records_under_one_lock_pair(self):
        current = copy.deepcopy(self.request)
        current_run = self.run
        self.request = copy.deepcopy(current)
        self.request["session"].update(session_id="historical-session", session_epoch="historical-session@123")
        self.pin = self.request["cancelled_preclaim"]
        self.pin.update(run_id="run-old", task_id="task-old")
        self.run = self.store / "runs" / "run-old"
        (self.run / "task_cancellation_intents").mkdir(parents=True)
        for record in (self.intent, self.catalog, self.cancel):
            record["run_id"] = "run-old"
        self.catalog["tasks"][0]["task_id"] = "task-old"
        self.cancel["task"]["task_id"] = "task-old"
        self.cancel["request_sha256"] = digest({k: v for k, v in self.cancel.items() if k != "request_sha256"})
        self.intent["specification"]["parameters"]["live_workspace"]["session_id"] = "historical-session"
        self.intent["payload_sha256"] = digest(self.intent["specification"])
        self.write_records()
        current["historical_preclaim"] = {"session": self.request["session"],
            "archive": {"scene_revision": 1}, "cancelled_preclaim": self.pin}
        before = {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()}
        result = self.collect_all(self.store, self.ledger, current)
        self.assertEqual(set(result), {"preclaim_cancelled_snapshot", "historical_preclaim_cancelled_snapshot"})
        for snapshot in result.values():
            self.assertTrue(snapshot["writer_locks_held_together"])
            self.assertEqual(snapshot["run_directories"], ["run-old", "run-one"])
        self.assertEqual(before, {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()})
        for run in (current_run, self.run):
            path = run / "run_catalog.json"
            raw = path.read_bytes()
            path.write_bytes(b"{}")
            with self.assertRaisesRegex(RuntimeError, "pinned cancelled record changed"):
                self.collect_all(self.store, self.ledger, current)
            path.write_bytes(raw)
        (self.store / "runs" / "unexpected-run").mkdir()
        with self.assertRaisesRegex(RuntimeError, "other accepted runs"):
            self.collect_all(self.store, self.ledger, current)

    def test_public_stop_cancellation_identity_is_bound_even_when_records_are_repinned(self):
        self.pin.update(stop_command_id="stop-one", stop_command_sha256="e" * 64)
        scope = "\0".join((self.pin["stop_command_id"], self.pin["run_id"], self.pin["task_id"]))
        self.cancel["cancellation_id"] = "cancel-live-" + hashlib.sha256(scope.encode()).hexdigest()
        self.cancel["request_sha256"] = digest({k: v for k, v in self.cancel.items() if k != "request_sha256"})
        self.write_records()
        self.collect(self.store, self.ledger, self.request)
        self.pin["stop_command_id"] = "other-stop"
        with self.assertRaisesRegex(RuntimeError, "bound Stop command"):
            self.collect(self.store, self.ledger, self.request)
        self.pin["stop_command_id"] = "stop-one"
        self.cancel["cancellation_id"] = "cancel-live-" + "f" * 64
        self.cancel["request_sha256"] = digest({k: v for k, v in self.cancel.items() if k != "request_sha256"})
        self.write_records()
        with self.assertRaisesRegex(RuntimeError, "bound Stop command"):
            self.collect(self.store, self.ledger, self.request)

    def test_refuses_pinned_but_non_preclaim_states(self):
        mutations = (
            lambda: self.catalog["tasks"][0].update(attempt_id="claimed"),
            lambda: self.catalog["tasks"][0].update(artifact_ids=["result"]),
            lambda: self.catalog["tasks"][0].update(lifecycle="completed"),
            lambda: self.cancel["task"].update(lifecycle="running"),
            lambda: self.cancel.update(request_sha256="f" * 64),
            lambda: self.intent["specification"]["parameters"]["live_workspace"].update(session_id="foreign"),
            lambda: self.resources.update(reservations=[{"state": "held"}]),
        )
        baseline = copy.deepcopy((self.intent, self.catalog, self.cancel, self.resources))
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.intent, self.catalog, self.cancel, self.resources = copy.deepcopy(baseline)
                mutate()
                self.intent["payload_sha256"] = digest(self.intent["specification"])
                self.write_records()
                with self.assertRaises(RuntimeError):
                    self.collect(self.store, self.ledger, self.request)

    def test_refuses_unpinned_record_changes_and_additional_runs(self):
        (self.run / "run_catalog.json").write_bytes(b"{}")
        with self.assertRaisesRegex(RuntimeError, "pinned cancelled record changed"):
            self.collect(self.store, self.ledger, self.request)
        self.write_records()
        (self.store / "runs" / "foreign-run").mkdir()
        with self.assertRaisesRegex(RuntimeError, "other accepted runs"):
            self.collect(self.store, self.ledger, self.request)

    def test_busy_store_releases_already_acquired_ledger_lock(self):
        held = os.open(self.store / "WRITER.lock", os.O_RDWR)
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(RuntimeError, "lock busy"):
                self.collect(self.store, self.ledger, self.request)
            ledger_fd = os.open(self.ledger / "WRITER.lock", os.O_RDWR)
            try:
                fcntl.flock(ledger_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(ledger_fd)
        finally:
            os.close(held)

    def test_refuses_preparation_record_and_transient_recovery(self):
        extra = self.run / "task_preparation_receipts"
        extra.mkdir()
        with self.assertRaisesRegex(RuntimeError, "preparation, claim, result"):
            self.collect(self.store, self.ledger, self.request)
        extra.rmdir()
        (self.store / "recovery" / "pending.json").write_bytes(b"{}")
        with self.assertRaisesRegex(RuntimeError, "pending store writes/recovery"):
            self.collect(self.store, self.ledger, self.request)


if __name__ == "__main__":
    unittest.main()
