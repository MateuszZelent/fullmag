"""Qualification regressions: an accepted activation is not a terminal run."""
import copy
import json
import unittest

import docker_activation_history_policy as history
from docker_startup_script import SOLVER_PROFILE_PRESET


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


def profiled_fixture():
    files, catalog, intent = fixture()
    receipt = json.loads(files["receipt.json"])
    result = json.loads(files["result.json"])
    provenance = json.loads(files["startup-provenance.json"])
    profile = copy.deepcopy(SOLVER_PROFILE_PRESET)
    profile_sha = history.digest(history.canonical(profile))
    session = "docker-startup-" + history.digest("\0".join((REQUEST, SOURCE, profile_sha)).encode())
    for record in (receipt, receipt["inputs"], result["response"]):
        record["solver_profile_sha256"] = profile_sha
    receipt["session_id"] = result["response"]["session_id"] = session
    provenance["solver_profile"] = profile
    parameters = intent["specification"]["parameters"]
    parameters["solver_profile"] = copy.deepcopy(profile)
    parameters["live_workspace"]["session_id"] = session
    return files, catalog, intent, receipt, result, provenance


def cuda_traced_fixture():
    files, catalog, intent = fixture()
    receipt = json.loads(files["receipt.json"])
    result = json.loads(files["result.json"])
    provenance = json.loads(files["startup-provenance.json"])
    trace = {
        "schema_version": "accepted_cuda_trace.v1",
        "max_bytes": 67108864,
        "max_duration_ms": 60000,
    }
    trace_sha = history.digest(history.canonical(trace))
    session = "docker-startup-" + history.digest(
        (REQUEST + "\0" + SOURCE + "\0cuda_trace\0" + trace_sha).encode()
    )
    for record in (receipt, receipt["inputs"], result["response"]):
        record["cuda_trace_sha256"] = trace_sha
    receipt["session_id"] = result["response"]["session_id"] = session
    provenance["cuda_trace"] = copy.deepcopy(trace)
    parameters = intent["specification"]["parameters"]
    parameters["cuda_trace"] = copy.deepcopy(trace)
    parameters["live_workspace"]["session_id"] = session
    return files, catalog, intent, receipt, result, provenance, trace, trace_sha


def profile_records(files, receipt, result, provenance, authorization=None):
    provenance_raw = raw(provenance)
    receipt["provenance_sha256"] = receipt["inputs"]["provenance_sha256"] = history.digest(provenance_raw)
    return {**files, "receipt.json": raw(receipt), "terminal.json": raw(receipt),
            "result.json": raw(result), "startup-provenance.json": provenance_raw,
            "authorization.json": raw(provenance if authorization is None else authorization)}


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

    def test_profiled_terminal_run_uses_the_profile_aware_session(self):
        files, catalog, intent, receipt, result, provenance = profiled_fixture()
        qualified = qualify(profile_records(files, receipt, result, provenance), catalog, intent)
        self.assertNotEqual(receipt["session_id"], SESSION)
        self.assertEqual(qualified["session_id"], receipt["session_id"])

    def test_profile_digest_is_required_on_every_boundary(self):
        for location in ("receipt", "inputs", "response"):
            for value in (None, "", "c" * 64, "A" * 64):
                with self.subTest(location=location, value=value):
                    files, catalog, intent, receipt, result, provenance = profiled_fixture()
                    record = {"receipt": receipt, "inputs": receipt["inputs"], "response": result["response"]}[location]
                    if value is None:
                        del record["solver_profile_sha256"]
                    else:
                        record["solver_profile_sha256"] = value
                    with self.assertRaisesRegex(history.HistoryError, "solver profile"):
                        qualify(profile_records(files, receipt, result, provenance), catalog, intent)

    def test_profile_wrappers_must_be_present_and_match_the_managed_preset(self):
        for location in ("provenance", "intent", "authorization"):
            for mutation in ("missing", "null", "disabled", "numeric_enabled", "changed"):
                with self.subTest(location=location, mutation=mutation):
                    files, catalog, intent, receipt, result, provenance = profiled_fixture()
                    authorization = copy.deepcopy(provenance)
                    target = {"provenance": provenance, "intent": intent["specification"]["parameters"],
                              "authorization": authorization}[location]
                    if mutation == "missing":
                        del target["solver_profile"]
                    elif mutation == "null":
                        target["solver_profile"] = None
                    elif mutation == "disabled":
                        target["solver_profile"]["config"]["enabled"] = False
                    elif mutation == "numeric_enabled":
                        target["solver_profile"]["config"]["enabled"] = 1
                    else:
                        target["solver_profile"]["config"]["max_samples"] = 64
                    # Keep authorization and provenance equal when testing
                    # the provenance wrapper itself, and distinct when testing authorization.
                    if location == "provenance":
                        authorization = provenance
                    records = profile_records(files, receipt, result, provenance, authorization)
                    with self.assertRaises(history.HistoryError):
                        qualify(records, catalog, intent)

    def test_legacy_requires_consistent_absence_of_profile_and_digest(self):
        for location in ("provenance", "intent", "receipt", "inputs", "response"):
            for value in (None, "c" * 64):
                with self.subTest(location=location, value=value):
                    files, catalog, intent = fixture()
                    receipt = json.loads(files["receipt.json"])
                    result = json.loads(files["result.json"])
                    provenance = json.loads(files["startup-provenance.json"])
                    if location in ("provenance", "intent"):
                        target = provenance if location == "provenance" else intent["specification"]["parameters"]
                        target["solver_profile"] = None if value is None else copy.deepcopy(SOLVER_PROFILE_PRESET)
                    else:
                        target = {"receipt": receipt, "inputs": receipt["inputs"], "response": result["response"]}[location]
                        target["solver_profile_sha256"] = value
                    with self.assertRaisesRegex(history.HistoryError, "solver profile"):
                        qualify(profile_records(files, receipt, result, provenance), catalog, intent)

    def test_profiled_run_rejects_the_legacy_session_at_each_boundary(self):
        for location in ("receipt", "response", "intent", "all"):
            with self.subTest(location=location):
                files, catalog, intent, receipt, result, provenance = profiled_fixture()
                if location in ("receipt", "all"):
                    receipt["session_id"] = SESSION
                if location in ("response", "all"):
                    result["response"]["session_id"] = SESSION
                if location in ("intent", "all"):
                    intent["specification"]["parameters"]["live_workspace"]["session_id"] = SESSION
                with self.assertRaises(history.HistoryError):
                    qualify(profile_records(files, receipt, result, provenance), catalog, intent)

    def test_cuda_traced_terminal_run_uses_tagged_trace_aware_session_and_is_archivable(self):
        files, catalog, intent, receipt, result, provenance, _trace, trace_sha = cuda_traced_fixture()
        qualified = qualify(profile_records(files, receipt, result, provenance), catalog, intent)
        self.assertEqual(qualified["session_id"], receipt["session_id"])
        self.assertNotEqual(receipt["session_id"], SESSION)
        self.assertEqual(receipt["cuda_trace_sha256"], trace_sha)

    def test_solver_profile_and_cuda_trace_bind_in_the_documented_order(self):
        files, catalog, intent, receipt, result, provenance, _trace, trace_sha = cuda_traced_fixture()
        profile = copy.deepcopy(SOLVER_PROFILE_PRESET)
        profile_sha = history.digest(history.canonical(profile))
        session_material = (
            REQUEST + "\0" + SOURCE + "\0" + profile_sha
            + "\0cuda_trace\0" + trace_sha
        )
        session = "docker-startup-" + history.digest(session_material.encode())
        for record in (receipt, receipt["inputs"], result["response"]):
            record["solver_profile_sha256"] = profile_sha
        receipt["session_id"] = result["response"]["session_id"] = session
        provenance["solver_profile"] = copy.deepcopy(profile)
        parameters = intent["specification"]["parameters"]
        parameters["solver_profile"] = copy.deepcopy(profile)
        parameters["live_workspace"]["session_id"] = session

        qualified = qualify(profile_records(files, receipt, result, provenance), catalog, intent)
        self.assertEqual(qualified["session_id"], session)

    def test_cuda_trace_digest_is_required_and_equal_on_every_history_boundary(self):
        for location in ("receipt", "inputs", "response"):
            for value in (None, "", "c" * 64, "A" * 64):
                with self.subTest(location=location, value=value):
                    files, catalog, intent, receipt, result, provenance, *_ = cuda_traced_fixture()
                    record = {
                        "receipt": receipt,
                        "inputs": receipt["inputs"],
                        "response": result["response"],
                    }[location]
                    if value is None:
                        del record["cuda_trace_sha256"]
                    else:
                        record["cuda_trace_sha256"] = value
                    with self.assertRaisesRegex(history.HistoryError, "cuda trace"):
                        qualify(profile_records(files, receipt, result, provenance), catalog, intent)

    def test_cuda_trace_wrapper_must_be_exact_in_authorization_provenance_and_intent(self):
        for location in ("provenance", "intent", "authorization"):
            for mutation in ("missing", "null", "wrong_schema", "bool_limit", "extra_key", "changed_limit"):
                with self.subTest(location=location, mutation=mutation):
                    files, catalog, intent, receipt, result, provenance, _trace, _trace_sha = cuda_traced_fixture()
                    authorization = copy.deepcopy(provenance)
                    target = {
                        "provenance": provenance,
                        "intent": intent["specification"]["parameters"],
                        "authorization": authorization,
                    }[location]
                    if mutation == "missing":
                        del target["cuda_trace"]
                    elif mutation == "null":
                        target["cuda_trace"] = None
                    elif mutation == "wrong_schema":
                        target["cuda_trace"]["schema_version"] = "accepted_cuda_trace.v2"
                    elif mutation == "bool_limit":
                        target["cuda_trace"]["max_bytes"] = True
                    elif mutation == "extra_key":
                        target["cuda_trace"]["enabled"] = True
                    else:
                        target["cuda_trace"]["max_duration_ms"] = 59999
                    if location == "provenance":
                        authorization = provenance
                    records = profile_records(files, receipt, result, provenance, authorization)
                    with self.assertRaises(history.HistoryError):
                        qualify(records, catalog, intent)

    def test_disabled_history_rejects_unsolicited_cuda_trace_digest_or_wrapper(self):
        for location in ("provenance", "intent", "receipt", "inputs", "response"):
            with self.subTest(location=location):
                files, catalog, intent = fixture()
                receipt = json.loads(files["receipt.json"])
                result = json.loads(files["result.json"])
                provenance = json.loads(files["startup-provenance.json"])
                if location in ("provenance", "intent"):
                    target = provenance if location == "provenance" else intent["specification"]["parameters"]
                    target["cuda_trace"] = None
                else:
                    target = {"receipt": receipt, "inputs": receipt["inputs"],
                              "response": result["response"]}[location]
                    target["cuda_trace_sha256"] = "8" * 64
                with self.assertRaisesRegex(history.HistoryError, "cuda trace"):
                    qualify(profile_records(files, receipt, result, provenance), catalog, intent)

    def test_cuda_traced_run_rejects_legacy_session_id_on_each_identity_record(self):
        for location in ("receipt", "response", "intent"):
            with self.subTest(location=location):
                files, catalog, intent, receipt, result, provenance, *_ = cuda_traced_fixture()
                if location == "receipt":
                    receipt["session_id"] = SESSION
                elif location == "response":
                    result["response"]["session_id"] = SESSION
                else:
                    intent["specification"]["parameters"]["live_workspace"]["session_id"] = SESSION
                with self.assertRaises(history.HistoryError):
                    qualify(profile_records(files, receipt, result, provenance), catalog, intent)

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





class RejectedHistoryTests(unittest.TestCase):
    def evidence(self):
        files, _, _ = fixture()
        receipt = json.loads(files["receipt.json"])
        receipt.update(state="failed-confirmed", activation_state="rejected", run_id=None,
                       session_id=None, retirement_result={"state":"retirement-only","retirement":None}, error="Backend activation was rejected; terminal activation receipt retained and retry is forbidden")
        files["receipt.json"] = files["terminal.json"] = raw(receipt)
        files["result.json"] = raw({"schema":"fullmag.startup-script-activation.v1", "state":"rejected",
            "request_id":REQUEST, "source_sha256":SOURCE, "source_relative":"examples/sp4.py",
            "rejection":{"http_status":422,"code":"accepted_execution_plan_invalid","message":"unsupported capability"}})
        return files

    def check(self, files, records=None, paths=None):
        return history.qualify_rejected_activation(TOKEN, files, project=PROJECT,
            volume=VOLUME, namespace="", store_records=records or {}, inventory_paths=paths or [])

    def test_confirmed_rejection_has_explicit_no_run_kind(self):
        result = self.check(self.evidence())
        self.assertEqual(result["qualification_kind"], "rejected-no-run-v1")
        self.assertIsNone(result["run_id"])
        self.assertEqual(result["files"], history.file_manifest(self.evidence()))

    def test_hidden_run_admission_or_lease_refuses(self):
        for path in ["runs/hidden/run_intent.json", "admission/request.json", "idempotency/key.json",
                     "runs/hidden/resource_leases/gpu/lease.json"]:
            with self.subTest(path=path):
                with self.assertRaises(history.HistoryError):
                    self.check(self.evidence(), {path:raw({"request_id":REQUEST})}, [path])
                with self.assertRaises(history.HistoryError):
                    self.check(self.evidence(), {}, [path])
        with self.assertRaises(history.HistoryError):
            self.check(self.evidence(), {}, ["admission/live-http-"+history.digest(REQUEST.encode())])

    def test_unrelated_admission_is_preserved(self):
        path="runs/other/run_intent.json"
        result=self.check(self.evidence(),{path:raw({"request_id":"another-request"})},[path])
        self.assertIn(path,result["store_record_hashes"])

    def test_ambiguous_rejection_identity_or_reconciliation_refuses(self):
        for change in [{"run_id":"hidden"},{"session_id":"hidden"},{"reconciliation":{}},
                       {"reconciliation":{"state":"recovered"}},{"activation_state":"unknown"},
                       {"source_sha256":"c"*64},{"error":"outcome unknown"}]:
            files=self.evidence();receipt=json.loads(files["receipt.json"]);receipt.update(change)
            files["receipt.json"]=files["terminal.json"]=raw(receipt)
            with self.subTest(change=change),self.assertRaises(history.HistoryError):self.check(files)
        for key,value in [("state","activated"),("request_id","other"),("response",{}),("run_id","hidden")]:
            files=self.evidence();result=json.loads(files["result.json"]);result[key]=value;files["result.json"]=raw(result)
            with self.subTest(key=key),self.assertRaises(history.HistoryError):self.check(files)

    def test_any_predecessor_retirement_or_ambiguous_result_is_refused(self):
        for retirement, result in [({}, {"state":"retirement-only","retirement":{}}),
                                   ({"state":"retired","terminal_outcome":"startup_failed"}, {"state":"retirement-only","retirement":{}}),
                                   (None, None), (None, {"state":"unknown","retirement":None})]:
            files=self.evidence();receipt=json.loads(files["receipt.json"])
            receipt.update(retirement=retirement,retirement_result=result)
            files["receipt.json"]=files["terminal.json"]=raw(receipt)
            with self.subTest(retirement=retirement,result=result),self.assertRaises(history.HistoryError):self.check(files)

    def test_any_related_retirement_path_or_unknown_blob_is_refused(self):
        for path in ["retirements/"+TOKEN,"retirements/"+TOKEN+"/project/extra.json","objects/"+SOURCE]:
            with self.subTest(path=path),self.assertRaises(history.HistoryError):self.check(self.evidence(),{},[path])


if __name__ == "__main__":
    unittest.main()
