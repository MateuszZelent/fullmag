"""Authenticated closed recovery snapshots are historical, never live waivers."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from docker_activation_history_policy import HistoryError, canonical, digest
from docker_activation_history_inventory import control_references, validate_closed_pre_admission_recovery
from docker_dev_reconcile_helper_output_failure import SCHEMA, SCENE_DESERIALIZATION_FAILURE
from test_docker_activation_history_policy import fixture, raw, TOKEN, PROJECT, VOLUME, SOURCE, REQUEST, RUN


class ClosedRecoveryTests(unittest.TestCase):
    def setUp(self):
        files, _, _ = fixture()
        authorization = json.loads(files["authorization.json"])
        self.identity = {"compose_project": PROJECT, "control_volume": VOLUME,
                         "source_root": "/source", "store_root": "/host/store"}
        receipt = json.loads(files["receipt.json"])
        for key in ("run_id", "session_id", "activation_state"):
            receipt.pop(key)
        receipt.update(state="outcome-unknown-resources-retained", retirement_phase="startup",
            helper_container="fullmag-control-" + TOKEN, helper_sha256="e" * 64,
            development_attempt="d" * 32, config_sha256="c" * 64,
            image_id="sha256:" + "1" * 64, backend_container="2" * 64,
            activation_receipt_key="3" * 64,
            activation_receipt_path="/opt/fullmag/control/backend/script-activation-" + "3" * 64 + "/activation.json")
        receipt["inputs"].update({key: receipt[key] for key in (
            "development_attempt", "config_sha256", "image_id", "backend_container",
            "activation_receipt_key", "activation_receipt_path")})
        response = {"code": "internal_error", "message": SCENE_DESERIALIZATION_FAILURE,
                    "error": SCENE_DESERIALIZATION_FAILURE}
        receipt["error"] = "startup activation returned HTTP 500: " + json.dumps(response)
        files["receipt.json"] = raw(receipt)
        self.marker = {"schema": "fullmag.docker-startup-activation-receipt.v1", "state": "started",
                       "request_id": REQUEST, "source_sha256": SOURCE,
                       "provenance_sha256": receipt["provenance_sha256"], "authorization": authorization}
        self.marker_raw = raw(self.marker)
        plan = {"schema": SCHEMA, "activation": TOKEN, "backend": receipt["backend_container"],
                "receipt_sha256": digest(files["receipt.json"]), "marker_sha256": digest(self.marker_raw),
                "config_sha256": receipt["config_sha256"], "source_root": "/source",
                "request_id": REQUEST, "source_sha256": SOURCE, "response": response,
                "backend_started_at": "2026-11-11T09:11:13.295281263Z",
                "protected_runs_sha256": "4" * 64, "run_count": 1}
        intent = {"schema": SCHEMA, "plan": plan, "plan_sha256": digest(canonical(plan))}
        proof = {**intent, "failure_variant": "scene-study-compute-resources-unknown-field",
                 "process_tree_sha256": "5" * 64,
                 "preserved_store": {"root": "/host/store", "runs": [{"run_id": RUN}]},
                 "outcome": "not-admitted", "old_request_replay": "forbidden"}
        files["terminal-history-output-intent.json"] = raw(intent)
        files["terminal-history-output-proof.json"] = raw(proof)
        terminal = {**receipt, "state": "failed-confirmed", "activation_state": "not-admitted",
                    "reconciliation": "pre-admission-output-terminal-history",
                    "release_proof_sha256": digest(canonical(proof)), "finished_at": 3}
        files["terminal.json"] = raw(terminal)
        files.pop("result.json")
        self.files = files
        self.records = {"WRITER.owner.json": raw({"schema": "fullmag.writer.v1", "released": True})}
        self.paths = sorted(self.records)

    def validate(self, files=None, records=None, paths=None):
        return validate_closed_pre_admission_recovery(TOKEN, self.files if files is None else files,
            marker_raw=self.marker_raw, identity=self.identity,
            store_records=self.records if records is None else records,
            inventory_paths=self.paths if paths is None else paths)

    def test_exact_closed_recovery_passes_without_mutation(self):
        before = copy.deepcopy(self.files)
        self.validate()
        self.assertEqual(self.files, before)

    def test_legacy_overflow_proof_without_variant_remains_authenticated(self):
        from docker_dev_reconcile_helper_output_failure import FAILURE
        files = dict(self.files)
        receipt = json.loads(files['receipt.json'])
        response = {'code': 'internal_error', 'message': FAILURE, 'error': FAILURE}
        receipt['error'] = 'startup activation returned HTTP 500: ' + json.dumps(response)
        files['receipt.json'] = raw(receipt)
        intent = json.loads(files['terminal-history-output-intent.json'])
        intent['plan']['response'] = response
        intent['plan']['receipt_sha256'] = digest(files['receipt.json'])
        intent['plan_sha256'] = digest(canonical(intent['plan']))
        files['terminal-history-output-intent.json'] = raw(intent)
        proof = json.loads(files['terminal-history-output-proof.json'])
        proof.update(intent)
        proof.pop('failure_variant')
        files['terminal-history-output-proof.json'] = raw(proof)
        terminal = json.loads(files['terminal.json'])
        terminal['error'] = receipt['error']
        terminal['release_proof_sha256'] = digest(canonical(proof))
        files['terminal.json'] = raw(terminal)
        before = copy.deepcopy(files)
        self.validate(files)
        self.assertEqual(files, before)

    def test_missing_variant_cannot_authenticate_new_scene_failure(self):
        files = dict(self.files)
        proof = json.loads(files['terminal-history-output-proof.json'])
        proof.pop('failure_variant')
        files['terminal-history-output-proof.json'] = raw(proof)
        with self.assertRaises(HistoryError):
            self.validate(files)

    def test_variant_release_overlay_intent_and_receipt_tampering_reject(self):
        for kind in ("variant", "release", "overlay", "missing_intent", "intent", "receipt", "accepted"):
            with self.subTest(kind=kind):
                files = dict(self.files)
                name = "terminal-history-output-proof.json" if kind == "variant" else "terminal.json"
                value = json.loads(files[name])
                if kind == "variant": value["failure_variant"] = "combined-helper-output-limit"
                if kind == "release": value["release_proof_sha256"] = "0" * 64
                if kind == "overlay": value["unexpected"] = True
                if kind == "accepted": value["run_id"] = RUN
                files[name] = raw(value)
                if kind == "missing_intent": files.pop("terminal-history-output-intent.json")
                if kind == "intent": files["terminal-history-output-intent.json"] = raw({})
                if kind == "receipt": files["receipt.json"] += b" "
                with self.assertRaises(HistoryError): self.validate(files)

    def test_fresh_matching_run_intent_or_admission_and_incomplete_inventory_reject(self):
        for path, value in (("runs/new/run_intent.json", {"command": {"request_id": REQUEST}}),
                            ("admission/intake.json", {"idempotency_key": "live-http-" + digest(REQUEST.encode())}),
                            ("runs/new/manifest.json", {"session_id": "docker-startup-" + digest((REQUEST + "\0" + SOURCE).encode())})):
            with self.subTest(path=path):
                records = {**self.records, path: raw(value)}
                with self.assertRaises(HistoryError): self.validate(records=records, paths=sorted(records))
        with self.assertRaises(HistoryError): self.validate(paths=self.paths + ["admission/intake.json"])
        with self.assertRaises(HistoryError): self.validate(records={"WRITER.owner.json": raw({"schema": "fullmag.writer.v1", "released": False})})

    def test_started_marker_and_schema_tampering_reject(self):
        marker = {**self.marker, "state": "activated"}
        with self.assertRaises(HistoryError):
            validate_closed_pre_admission_recovery(TOKEN, self.files, marker_raw=raw(marker),
                identity=self.identity, store_records=self.records, inventory_paths=self.paths)
        files = dict(self.files)
        proof = json.loads(files["terminal-history-output-proof.json"])
        proof["schema"] = "unknown"
        files["terminal-history-output-proof.json"] = raw(proof)
        with self.assertRaises(HistoryError): self.validate(files)

    def test_same_source_under_another_request_is_not_this_failed_admission(self):
        records = {**self.records, "runs/another/run_intent.json": raw({
            "source_sha256": SOURCE, "request_id": "another-request"})}
        self.validate(records=records, paths=sorted(records))

    def own_retirement(self, extra_documents=None):
        prefix = "retirements/" + TOKEN
        documents = {"ui_state.json": b"{}", "workspace_metadata.json": b"{}", "main.py": b"# preserved predecessor"}
        documents.update(extra_documents or {})
        manifest = {"schema": "fullmag.live-workspace-retirement-proof.v2", "state": "retired",
                    "operation_id": TOKEN, "session_id": "docker-startup-predecessor", "run_id": "run-predecessor",
                    "request_scope_epoch": "old-scope:1", "session_epoch": 1, "scene_revision": 2,
                    "state_version": 3, "terminal_outcome": "completed", "terminal_catalog_revision": 1,
                    "ui_state_scope": "backend_typed_workspace", "script_available": True,
                    "terminal_evidence_sha256": "7" * 64,
                    "documents": {name: {"object_ref": digest(content), "sha256": digest(content),
                                          "byte_length": len(content)} for name, content in documents.items()}}
        manifest_path = prefix + "/project/retirement-manifest.json"
        response = {key: manifest[key] for key in ("operation_id", "session_id", "run_id", "request_scope_epoch",
                    "session_epoch", "scene_revision", "state_version", "terminal_outcome", "ui_state_scope",
                    "script_available", "terminal_evidence_sha256")}
        response.update(schema="fullmag.live-workspace-retirement-response.v1", state="retired",
                        api_request_scope_epoch="old-scope:1", archive_manifest_path=manifest_path,
                        archive_sha256=digest(raw(manifest)))
        receipt = json.loads(self.files["receipt.json"])
        receipt.update(retirement=response, retirement_result={"state": "retirement-only", "retirement": response})
        self.files["receipt.json"] = raw(receipt)
        proof = json.loads(self.files["terminal-history-output-proof.json"])
        proof["plan"]["receipt_sha256"] = digest(self.files["receipt.json"])
        proof["plan_sha256"] = digest(canonical(proof["plan"]))
        self.files["terminal-history-output-proof.json"] = raw(proof)
        self.files["terminal-history-output-intent.json"] = raw({key: proof[key] for key in ("schema", "plan", "plan_sha256")})
        self.files["terminal.json"] = raw({**receipt, "state": "failed-confirmed", "activation_state": "not-admitted",
            "reconciliation": "pre-admission-output-terminal-history", "finished_at": 3,
            "release_proof_sha256": digest(canonical(proof))})
        self.records.update({prefix + "/project/" + name: content for name, content in documents.items()})
        self.records[manifest_path] = raw(manifest)
        self.records["runs/run-predecessor/run_catalog.json"] = raw({
            "schema_version": "run_catalog.v1", "run_id": "run-predecessor", "revision": 1})
        self.records["runs/run-predecessor/run_intent.json"] = raw({
            "schema_version": "run_intent.v1", "run_id": "run-predecessor",
            "specification": {"parameters": {"live_workspace": {"session_id": "docker-startup-predecessor"}}}})
        self.paths = sorted([prefix, prefix + "/project", *self.records])
        return prefix, manifest_path

    def test_authenticated_own_predecessor_retirement_is_not_failed_request_admission(self):
        self.own_retirement()
        self.validate()

    def test_producer_script_builder_retirement_is_pinned(self):
        prefix, _ = self.own_retirement({'script_builder.json': b'{"version":1}'})
        self.validate()
        self.records[prefix + '/project/script_builder.json'] = b'changed'
        with self.assertRaises(HistoryError):
            self.validate()

    def test_unknown_retirement_document_still_rejects(self):
        self.own_retirement({'unknown.json': b'{}'})
        with self.assertRaises(HistoryError):
            self.validate()

    def test_foreign_mutated_missing_and_unbound_retirement_manifest_refuse(self):
        for kind in ("foreign", "mutated", "missing", "document", "unbound", "session", "catalog"):
            with self.subTest(kind=kind):
                self.setUp()
                prefix, path = self.own_retirement()
                if kind == "foreign":
                    value = json.loads(self.records[path]);value["operation_id"] = "f" * 32
                    self.records[path] = raw(value)
                if kind == "mutated": self.records[path] += b" "
                if kind == "missing": self.records.pop(path);self.paths.remove(path)
                if kind == "document": self.records[prefix + "/project/main.py"] = b"changed"
                if kind == "session":
                    self.records["runs/run-predecessor/run_intent.json"] = raw({"schema_version": "run_intent.v1", "run_id": "run-predecessor"})
                if kind == "catalog": self.records.pop("runs/run-predecessor/run_catalog.json");self.paths.remove("runs/run-predecessor/run_catalog.json")
                if kind == "unbound":
                    # A substring match in another retirement remains a live reference.
                    path = "retirements/foreign/project/retirement-manifest.json"
                    self.records[path] = raw({"operation_id": TOKEN});self.paths.append(path)
                with self.assertRaises(HistoryError): self.validate()

    def test_retirement_payload_request_identity_and_attempt_elsewhere_still_refuse(self):
        for path, value in (("nested.json", {"metadata": {"request_id": REQUEST}}),
                            ("nested.json", {"metadata": {"activation": TOKEN}})):
            with self.subTest(value=value):
                self.setUp()
                prefix, _ = self.own_retirement()
                relative = prefix + "/project/" + path
                self.records[relative] = raw(value);self.paths.append(relative)
                with self.assertRaises(HistoryError): self.validate()

    def test_different_store_keeps_recovery_live_without_reading_foreign_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory = root / "activation/attempts" / TOKEN
            directory.mkdir(parents=True)
            for name, content in self.files.items():
                (directory / name).write_bytes(content)
            candidate = "6" * 32
            other = root / "activation/attempts" / candidate
            other.mkdir()
            value = raw({"schema": "fullmag.docker-build-operation.v1", "attempt": candidate,
                         "state": "succeeded", "run_id": RUN})
            for name in ("receipt.json", "terminal.json"):
                (other / name).write_bytes(value)
            identity = {**self.identity, "store_root": "/another/selected/store"}
            with mock.patch("docker_activation_history_inventory._closed_recovery_store_evidence") as read:
                result = control_references(root, "0" * 32,
                    store_root=Path("/another/selected/store"), identity=identity)
                self.assertIn(candidate, result["protected"])
                self.assertIn("activation/attempts/" + TOKEN + "/terminal-history-output-proof.json", result["pins"])
                with self.assertRaises(HistoryError):
                    control_references(root, candidate,
                        store_root=Path("/another/selected/store"), identity=identity)
                read.assert_not_called()

    def test_cuda_trace_session_identity_matches_native_startup_separator(self):
        import docker_activation_history_inventory as inventory
        for profile in (None, "8" * 64):
            inputs = {"request_id": REQUEST, "source_sha256": SOURCE, "cuda_trace_sha256": "9" * 64}
            parts = [REQUEST, SOURCE]
            if profile is not None:
                inputs["solver_profile_sha256"] = profile
                parts.append(profile)
            parts.extend(["cuda_trace", "9" * 64])
            expected = "docker-startup-" + digest("\0".join(parts).encode())
            self.assertIn(expected, inventory._closed_recovery_request_identities(TOKEN, inputs))

    def test_reference_inventory_closes_snapshot_but_current_guard_remains_live(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory = root / "activation/attempts" / TOKEN
            directory.mkdir(parents=True)
            for name, content in self.files.items(): (directory / name).write_bytes(content)
            marker_path = root / "backend" / ("script-activation-" + "3" * 64) / "activation.json"
            marker_path.parent.mkdir(parents=True)
            marker_path.write_bytes(self.marker_raw)
            run_attempt = "6" * 32
            run_directory = root / "activation/attempts" / run_attempt
            run_directory.mkdir()
            succeeded = raw({"schema": "fullmag.docker-build-operation.v1", "attempt": run_attempt,
                             "state": "succeeded", "run_id": RUN})
            for name in ("receipt.json", "terminal.json"): (run_directory / name).write_bytes(succeeded)
            with self.assertRaises(HistoryError): control_references(root, run_attempt)
            with mock.patch("docker_activation_history_inventory._closed_recovery_store_evidence",
                            return_value=(self.records, self.paths)):
                result = control_references(root, run_attempt, store_root=Path("/host/store"), identity=self.identity)
                self.assertNotIn(run_attempt, result["protected"])
                self.assertIn("activation/attempts/" + TOKEN + "/terminal-history-output-proof.json", result["pins"])
                (root / "activation/current.json").write_bytes(self.files["terminal.json"])
                with self.assertRaises(HistoryError):
                    control_references(root, TOKEN, store_root=Path("/host/store"), identity=self.identity)


if __name__ == "__main__": unittest.main()
