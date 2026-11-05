"""Qualification regressions: an accepted activation is not a terminal run."""
import copy
import json
import unittest

import docker_activation_history_policy as history


TOKEN = "a" * 32
PROJECT = "fullmag-worktree-test"
VOLUME = "fullmag-control-test"
REQUEST = "sp4-history-test"
SOURCE = "b" * 64
RUN = "run-live-test"
SESSION = "docker-startup-" + history.digest((REQUEST + "\0" + SOURCE).encode())


def raw(value):
    return history.canonical(value) + b"\n"


def fixture():
    provenance = {"schema": "fullmag.docker-startup-script.v1", "authorization": "explicit_startup_script",
                  "source_root": "/source", "source_relative": "examples/sp4.py",
                  "source_sha256": SOURCE, "request_id": REQUEST}
    # Preserve a noncanonical historical serialization byte-for-byte.
    provenance_raw = json.dumps(provenance, indent=2).encode() + b"\n"
    inputs = {key: provenance[key] for key in ("source_root", "source_relative", "source_sha256", "request_id")}
    inputs["provenance_sha256"] = history.digest(provenance_raw)
    receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": "activation",
               "state": "succeeded", "activation_state": "activated", "attempt": TOKEN,
               "compose_project": PROJECT, "control_volume": VOLUME, "inputs": inputs,
               "started_at": 1, "finished_at": 2, "run_id": RUN, "session_id": SESSION,
               "provenance_path": "/opt/fullmag/control/activation/attempts/" + TOKEN + "/startup-provenance.json",
               **inputs}
    result = {"schema": "fullmag.startup-script-activation.v1", "state": "activated",
              "request_id": REQUEST, "source_sha256": SOURCE,
              "response": {"schema": "fullmag.startup-script-activation.v1", "status": "accepted",
                           "run_id": RUN, "session_id": SESSION, "request_id": REQUEST, "source_sha256": SOURCE}}
    files = {"receipt.json": raw(receipt), "terminal.json": raw(receipt),
             "result.json": raw(result), "authorization.json": raw(provenance),
             "startup-provenance.json": provenance_raw, "build.log": b""}
    catalog = {"schema_version": "run_catalog.v1", "run_id": RUN, "revision": 1,
               "tasks": [{"task_id": "solve", "lifecycle": "completed", "artifact_ids": ["zarr"]}]}
    intent = {"schema_version": "run_intent.v1", "run_id": RUN,
              "idempotency_key": "live-http-" + history.digest(REQUEST.encode()),
              "specification": {"parameters": {"live_workspace": {"session_id": SESSION}}}}
    return files, catalog, intent


def qualify(files, catalog, intent, **kwargs):
    return history.qualify_activation(
        TOKEN, files, project=PROJECT, volume=VOLUME, namespace="",
        run_catalog_raw=raw(catalog), run_intent_raw=raw(intent),
        lease_records=kwargs.get("leases", {}))


class HistoryQualificationTests(unittest.TestCase):
    def test_succeeded_and_terminal_run_preserve_original_byte_pins(self):
        files, catalog, intent = fixture()
        before = copy.deepcopy(files)
        qualified = qualify(files, catalog, intent)
        self.assertEqual(files, before)
        self.assertEqual(qualified["files"]["startup-provenance.json"]["sha256"],
                         history.digest(files["startup-provenance.json"]))
        self.assertEqual(qualified["run_id"], RUN)

    def test_accepted_activation_with_running_or_missing_tasks_is_not_eligible(self):
        for tasks in ([], [{"task_id": "solve", "lifecycle": "running"}],
                      [{"task_id": "solve", "lifecycle": "unknown"}]):
            with self.subTest(tasks=tasks):
                files, catalog, intent = fixture()
                catalog["tasks"] = tasks
                with self.assertRaises(history.HistoryError):
                    qualify(files, catalog, intent)

    def test_terminal_and_receipt_must_be_identical_succeeded_bytes(self):
        for state in ("failed-confirmed", "outcome-unknown-resources-retained", "starting"):
            with self.subTest(state=state):
                files, catalog, intent = fixture()
                receipt = json.loads(files["receipt.json"])
                receipt["state"] = state
                files["receipt.json"] = files["terminal.json"] = raw(receipt)
                with self.assertRaises(history.HistoryError):
                    qualify(files, catalog, intent)
        files, catalog, intent = fixture()
        files["terminal.json"] += b" "
        with self.assertRaisesRegex(history.HistoryError, "bytes differ"):
            qualify(files, catalog, intent)

    def test_group_namespace_source_and_provenance_pins_are_mandatory(self):
        for key, value in (("compose_project", "other"), ("control_volume", "other"),
                           ("control_namespace", "other"), ("source_sha256", "c" * 64),
                           ("provenance_sha256", "c" * 64), ("provenance_path", "/other"),
                           ("finished_at", 0), ("error", "prior unknown")):
            with self.subTest(key=key):
                files, catalog, intent = fixture()
                receipt = json.loads(files["receipt.json"])
                receipt[key] = value
                files["receipt.json"] = files["terminal.json"] = raw(receipt)
                with self.assertRaises(history.HistoryError):
                    qualify(files, catalog, intent)

    def test_result_and_run_intent_must_bind_same_request(self):
        files, catalog, intent = fixture()
        result = json.loads(files["result.json"])
        result["response"]["run_id"] = "run-other"
        files["result.json"] = raw(result)
        with self.assertRaisesRegex(history.HistoryError, "run identity"):
            qualify(files, catalog, intent)
        files, catalog, intent = fixture()
        intent["idempotency_key"] = "live-http-other"
        with self.assertRaisesRegex(history.HistoryError, "RunIntent"):
            qualify(files, catalog, intent)

    def test_active_and_mismatched_leases_are_not_eligible(self):
        files, catalog, intent = fixture()
        path = "runs/" + RUN + "/resource_leases/cpu/token.json"
        lease = {"schema_version": "resource_lease.v1", "run_id": RUN,
                 "resource_id": "cpu", "lease_token": "token", "state": "released"}
        self.assertEqual(qualify(files, catalog, intent, leases={path: raw(lease)})["leases"],
                         {path: history.digest(raw(lease))})
        for key, value in (("state", "running"), ("state", "unknown"), ("run_id", "other")):
            with self.subTest(key=key, value=value):
                bad = {**lease, key: value}
                with self.assertRaises(history.HistoryError):
                    qualify(files, catalog, intent, leases={path: raw(bad)})

    def test_missing_duplicate_json_and_unsafe_files_fail_closed(self):
        files, catalog, intent = fixture()
        for missing in history.REQUIRED:
            with self.subTest(missing=missing), self.assertRaises(history.HistoryError):
                qualify({k: v for k, v in files.items() if k != missing}, catalog, intent)
        for name in ("../escape", "sub/file", ".history.json", ".", ".."):
            with self.subTest(name=name), self.assertRaises(history.HistoryError):
                qualify({**files, name: b"x"}, catalog, intent)
        with self.assertRaises(history.HistoryError):
            history.document(b'{"state":"succeeded","state":"unknown"}', "duplicate")
        with self.assertRaises(history.HistoryError):
            history.document(b'{"time":NaN}', "nonfinite")

    def test_current_predecessor_and_nested_live_references_are_protected(self):
        predecessor = "b" * 32
        unknown = "c" * 32
        records = {"current": raw({"attempt": TOKEN, "retirement": {"run_id": "old-run"}}),
                   "unknown": raw({"pins": ["/control/activation/attempts/" + unknown + "/terminal.json"]})}
        self.assertEqual(history.referenced_attempts(records, {"old-run": predecessor}),
                         {TOKEN, predecessor, unknown})

    def test_selection_is_bounded_and_preserves_protected_entries(self):
        files, catalog, intent = fixture()
        base = qualify(files, catalog, intent)
        candidates = [{**base, "attempt": f"{i:032x}", "finished_at": i + 1} for i in range(64)]
        protected = {f"{i:032x}" for i in range(4)}
        selected = history.select_candidates(candidates, protected, history_count=0, history_bytes=0)
        self.assertEqual([v["attempt"] for v in selected], [f"{i:032x}" for i in range(4, 20)])
        with self.assertRaisesRegex(history.HistoryError, "capacity"):
            history.select_candidates(candidates, protected, history_count=4096, history_bytes=0)
        with self.assertRaisesRegex(history.HistoryError, "capacity"):
            history.select_candidates(candidates, protected, history_count=0, history_bytes=256 * 1024**2)
        with self.assertRaisesRegex(history.HistoryError, "Duplicate"):
            history.select_candidates([base, base], set(), history_count=0, history_bytes=0)


if __name__ == "__main__":
    unittest.main()
