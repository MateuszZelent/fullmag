"""Interpreted scope/freshness/custody checks; not a native/browser pass."""
import io
import errno
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import verify_workspace_browser as proof
import verify_development_backend_api as native_gate


class BrowserProofChecks(unittest.TestCase):
    def test_after_grid_document_pins_hashes_but_never_relaxes_archive_metadata(self):
        before = {"archive_base64_sha256": "a" * 64, "revision": 2, "dirty": True,
                  "project_id": "project", "scene_resource_sha256": "b" * 64,
                  "scene_document_sha256": "c" * 64}
        expected = {**before, "scene_resource_sha256": "d" * 64, "scene_document_sha256": "e" * 64}
        proof.validate_after_grid_document(before, expected)
        for key, value in (("archive_base64_sha256", "f" * 64), ("revision", 3),
                           ("dirty", False), ("project_id", "other"),
                           ("scene_resource_sha256", "bad"), ("scene_document_sha256", None)):
            with self.subTest(key=key), self.assertRaises(proof.storage.StorageError):
                proof.validate_after_grid_document(before, {**expected, key: value})
        with self.assertRaises(proof.storage.StorageError):
            proof.validate_after_grid_document(before, {**expected, "extra": True})

    def test_successful_grid_only_clears_mesh_dirty_and_preserves_source(self):
        scene = {"revision": 3, "objects": [
            {"id": "a", "tags": ["mesh:dirty", "user-tag"], "material_ref": "m"},
            {"id": "b", "tags": ["mesh:dirty"]},
            {"id": "c", "tags": ["user-tag"]}],
            "materials": [{"id": "m", "properties": {"alpha": 0.02}}]}
        expected = proof.scene_after_successful_grid(scene)
        self.assertEqual(expected["objects"][0]["tags"], ["user-tag"])
        self.assertNotIn("tags", expected["objects"][1])
        self.assertEqual(expected["objects"][2]["tags"], ["user-tag"])
        self.assertEqual(expected["materials"], scene["materials"])
        self.assertEqual(expected["revision"], 3)
        self.assertEqual(scene["objects"][0]["tags"], ["mesh:dirty", "user-tag"])
        for field, value in (("material_ref", "other"), ("id", "other")):
            changed = json.loads(json.dumps(expected))
            changed["objects"][0][field] = value
            self.assertNotEqual(proof.canonical(expected), proof.canonical(changed))

    def test_terminal_scope_requires_exact_owner_start_and_completed_lifecycle(self):
        restored = dict(api_instance_id="api", session_id="session", backend_session_epoch=1,
                        request_scope_epoch="api:1", session_resource_epoch="session@100")
        terminal = {**restored, "session_resource_epoch": "session@100:tombstone:200"}
        lifecycle = dict(solver="completed", session_resource="tombstoned", commandability="read_only")
        self.assertEqual(proof.validate_terminal_execution_scope(terminal, restored, lifecycle, 190, 210), 200)
        for changes in (dict(api_instance_id="other"), dict(backend_session_epoch=2),
                        dict(request_scope_epoch="api:2"), dict(session_id="other"),
                        dict(session_resource_epoch="session@101:tombstone:200"),
                        dict(session_resource_epoch="session@100"),
                        dict(session_resource_epoch="session@100:tombstone:0200"),
                        dict(session_resource_epoch="session@100:tombstone:99")):
            with self.subTest(changes=changes), self.assertRaises(proof.storage.StorageError):
                proof.validate_terminal_execution_scope({**terminal, **changes}, restored, lifecycle, 190, 210)
        for changes in (dict(solver="awaiting_command"), dict(session_resource="active"),
                        dict(commandability="allowed")):
            with self.subTest(lifecycle=changes), self.assertRaises(proof.storage.StorageError):
                proof.validate_terminal_execution_scope(terminal, restored, {**lifecycle, **changes}, 190, 210)
        for earliest, observed in ((201, 210), (190, 199)):
            with self.subTest(earliest=earliest, observed=observed), self.assertRaises(proof.storage.StorageError):
                proof.validate_terminal_execution_scope(terminal, restored, lifecycle, earliest, observed)

    def test_session_resource_epoch_rejects_noncanonical_or_unbounded_values(self):
        for value in ("session@0", "session@01", "session@+1", "session@1:extra", "session@1:tombstone:0",
                      "session@1:tombstone:2:tombstone:3", "session@" + "9" * 10000):
            with self.subTest(value=value[:60]), self.assertRaises(proof.storage.StorageError):
                proof.parse_session_resource_epoch("session", value)

    def test_solver_execution_distinguishes_application_boundary_from_completion(self):
        self.assertTrue(proof.has_positive_solver_execution(dict(applied_step=0, completed_step=10)))
        self.assertTrue(proof.has_positive_solver_execution(dict(applied_step=42, completed_step=52)))
        for applied, completed in ((0, 0), (42, 42), (42, 41), (-1, 10), (None, 10),
                                   (0, None), (True, 10), (0, True), (0, 1.0)):
            with self.subTest(applied=applied, completed=completed):
                self.assertFalse(proof.has_positive_solver_execution(
                    dict(applied_step=applied, completed_step=completed)))

    def diagnostic_paths(self, directory):
        root = Path(directory).resolve()
        repo, app, fixture = root / "checkout", root / "frozen-product", root / "fixture"
        source = repo / "apps/control-room/scripts/fixtures/native-workspace-restart-page.tsx"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"current diagnostic with material_ref")
        old = app / "scripts/fixtures/native-workspace-restart-page.tsx"
        old.parent.mkdir(parents=True)
        old.write_bytes(b"frozen old diagnostic without material binding")
        fixture.mkdir()
        return repo, app, fixture, source, old

    def test_diagnostic_page_uses_current_snapshot_and_preserves_frozen_product(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, app, fixture, source, old = self.diagnostic_paths(directory)
            old_bytes = old.read_bytes()
            page, evidence = proof.stage_diagnostic_page(repo, app, fixture)
            self.assertEqual(page.read_bytes(), source.read_bytes())
            self.assertNotEqual(page.read_bytes(), old_bytes)
            self.assertEqual(old.read_bytes(), old_bytes)
            self.assertEqual(Path(evidence["snapshot_path"]).read_bytes(), source.read_bytes())
            self.assertEqual(evidence["source_path"], str(source))
            self.assertEqual(evidence["staged_route_sha256"],
                             proof.hashlib.sha256(page.read_bytes()).hexdigest())

    def test_diagnostic_capture_rejects_source_mutation_and_tampered_copy(self):
        for tamper_source in (True, False):
            with self.subTest(source_mutation=tamper_source), tempfile.TemporaryDirectory() as directory:
                repo, app, fixture, source, _ = self.diagnostic_paths(directory)
                real_copy = proof.shutil.copyfile

                def changing_copy(snapshot, page):
                    real_copy(snapshot, page)
                    (source if tamper_source else page).write_bytes(b"tampered diagnostic")

                with patch.object(proof.shutil, "copyfile", side_effect=changing_copy):
                    with self.assertRaisesRegex(proof.storage.StorageError, "changed during capture"):
                        proof.stage_diagnostic_page(repo, app, fixture)

    def test_diagnostic_capture_rejects_link_before_resolving_path(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, app, fixture, source, _ = self.diagnostic_paths(directory)
            with patch.object(proof.runtime_bundle, "_require_regular_file",
                              side_effect=proof.storage.StorageError("linked source")), \
                    patch.object(proof.storage, "validate_path") as resolve:
                with self.assertRaisesRegex(proof.storage.StorageError, "linked source"):
                    proof.stage_diagnostic_page(repo, app, fixture)
                resolve.assert_not_called()

    def test_service_cleanup_timeout_preserves_primary_failure(self):
        child = Mock()
        child.wait.side_effect = native_gate.subprocess.TimeoutExpired("fixture", 20)
        record = dict(waited=False)
        native_gate._wait_for_owned_service_exit(child, record, PermissionError("publication"))
        self.assertFalse(record["waited"])
        self.assertNotIn("exit_code", record)
        self.assertEqual(record["cleanup_error"], "TimeoutExpired")
        child.wait.assert_called_once_with(timeout=20)

    def test_service_cleanup_timeout_without_primary_remains_failure(self):
        child = Mock()
        child.wait.side_effect = native_gate.subprocess.TimeoutExpired("fixture", 20)
        record = dict(waited=False)
        with self.assertRaises(native_gate.subprocess.TimeoutExpired):
            native_gate._wait_for_owned_service_exit(child, record, None)
        self.assertFalse(record["waited"])

    def test_service_ready_retries_publication_sharing_only(self):
        child = Mock(pid=10)
        child.poll.return_value = None
        manifest = dict(git_commit="commit", source_snapshot_sha256="snapshot")
        owner = dict(schema_version="runtime_service_owner.v1", pid=10, state="ready",
                     build_commit="commit", build_snapshot="snapshot")
        path = Mock()
        path.read_text.side_effect = [PermissionError(errno.EACCES, "sharing"), json.dumps(owner)]
        sleep = Mock()
        result = native_gate._wait_for_owned_service_ready(
            path, child, manifest, clock=Mock(side_effect=[0, 0, 0.1]), sleep=sleep)
        self.assertEqual(result, owner)
        sleep.assert_called_once_with(0.1)

    def test_service_ready_persistent_sharing_has_original_deadline(self):
        child = Mock(pid=10)
        child.poll.return_value = None
        path = Mock()
        path.read_text.side_effect = PermissionError(errno.EACCES, "sharing")
        with self.assertRaisesRegex(proof.storage.StorageError, "did not publish Ready"):
            native_gate._wait_for_owned_service_ready(
                path, child, {}, clock=Mock(side_effect=[0, 0, 20]), sleep=Mock())
        path.read_text.assert_called_once()

    def test_service_ready_invalid_and_foreign_owner_fail_without_retry(self):
        child = Mock(pid=10)
        child.poll.return_value = None
        manifest = dict(git_commit="commit", source_snapshot_sha256="snapshot")
        for value, error in (("{", json.JSONDecodeError),
                             (json.dumps(dict(schema_version="runtime_service_owner.v1", pid=11,
                                              state="ready")), proof.storage.StorageError)):
            path, sleep = Mock(), Mock()
            path.read_text.return_value = value
            with self.subTest(value=value), self.assertRaises(error):
                native_gate._wait_for_owned_service_ready(
                    path, child, manifest, clock=Mock(side_effect=[0, 0]), sleep=sleep)
            sleep.assert_not_called()

    def test_service_ready_wrong_build_and_nonsharing_error_fail(self):
        child = Mock(pid=10)
        child.poll.return_value = None
        path, sleep = Mock(), Mock()
        path.read_text.return_value = json.dumps(dict(schema_version="runtime_service_owner.v1",
            pid=10, state="ready", build_commit="other", build_snapshot="snapshot"))
        with self.assertRaisesRegex(proof.storage.StorageError, "differs from the pinned build"):
            native_gate._wait_for_owned_service_ready(path, child,
                dict(git_commit="commit", source_snapshot_sha256="snapshot"),
                clock=Mock(side_effect=[0, 0]), sleep=sleep)
        path.read_text.side_effect = PermissionError(errno.EPERM, "nonsharing")
        with self.assertRaises(PermissionError):
            native_gate._wait_for_owned_service_ready(path, child, {},
                clock=Mock(side_effect=[0, 0]), sleep=sleep)
        sleep.assert_not_called()

    def test_frozen_native_gate_rejects_ambiguous_scope_before_storage(self):
        pin = "a" * 64
        with patch.object(native_gate.storage, "resolve_layout") as resolve:
            for invalid in ("", "a" * 63, "A" * 64, "g" * 64):
                with self.subTest(invalid=invalid), self.assertRaises(proof.storage.StorageError):
                    native_gate.run("unused", frozen_native_build_id=invalid)
            conflicts = {
                "cross_build_bundle": "b" * 32,
                "restart_transport_only": True,
                "observer_pause_only": True,
                "restart_consumer_only": True,
                "consumer_readiness_only": True,
                "consumer_pump_owner_bundle": "b" * 32,
                "candidate_preparation_only": True,
                "workspace_browser_owner_bundle": "b" * 32,
            }
            for name, value in conflicts.items():
                with self.subTest(mode=name), self.assertRaises(proof.storage.StorageError):
                    native_gate.run("unused", frozen_native_build_id=pin, **{name: value})
            resolve.assert_not_called()
        # Frozen packages also support the project-document proof used by the
        # managed archive recipe. Both accepted scopes must reach preflight;
        # no production storage is allocated by this check.
        for scope in ({}, {"project_document_only": True}):
            with self.subTest(accepted_scope=scope), patch.object(
                    native_gate.storage, "resolve_layout", side_effect=RuntimeError("resolver reached")):
                with self.assertRaisesRegex(RuntimeError, "resolver reached"):
                    native_gate.run("unused", frozen_native_build_id=pin, **scope)

    def setUp(self):
        self.expected = {"worktree_id": "fixture", "generation_id": "a" * 32,
                         "ready_build_id": "b" * 64, "ready_source_sha256": "c" * 64,
                         "ui_origin": "http://localhost:3258", "nonce": "12345678-1234-4234-8234-123456789abc"}
        self.pin = "22345678-1234-4234-8234-123456789abc"
        self.frame = {**self.expected, "schema": proof.READY_SCHEMA, "api_instance_id": self.pin,
                      "observed_at_unix_ms": 1000, "valid_until_unix_ms": 2000}

    def test_ready_scope_and_expiry_are_required(self):
        self.assertEqual(proof.validate_ready(self.frame, self.expected, 1500), self.frame)
        for key, value in (("nonce", "wrong"), ("ready_build_id", "d" * 64),
                           ("observed_at_unix_ms", True), ("valid_until_unix_ms", 2500),
                           ("api_instance_id", "00000000-0000-0000-0000-000000000000")):
            with self.subTest(key=key), self.assertRaises(proof.storage.StorageError):
                proof.validate_ready({**self.frame, key: value}, self.expected, 1500)
        with self.assertRaises(proof.storage.StorageError):
            proof.validate_ready(self.frame, self.expected, 2000)

    def test_expired_queued_frame_can_be_inspected_but_cannot_grant_eligibility(self):
        self.assertEqual(proof.validate_ready(self.frame, self.expected, 3000, allow_expired=True), self.frame)
        with self.assertRaises(proof.storage.StorageError):
            proof.validate_ready({**self.frame, "nonce": "wrong"}, self.expected, 3000, allow_expired=True)

    def test_terminal_evidence_requires_real_integer_exit_and_wait(self):
        value = {"pid": 123, "waited": True, "exit_code": 1}
        self.assertEqual(proof.terminal_record(value), value)
        for key, bad in (("pid", True), ("waited", False), ("exit_code", None), ("exit_code", False)):
            with self.subTest(key=key), self.assertRaises(proof.storage.StorageError):
                proof.terminal_record({**value, key: bad})

    def test_truncated_json_transport_is_not_a_terminal_frame(self):
        process = type("Process", (), {"stdout": io.BytesIO(b'{"schema":"terminal"}')})()
        with tempfile.TemporaryDirectory() as directory:
            reader = proof.NativeFrames(process, Path(directory) / "native.log")
            reader._read()
            self.assertIsInstance(reader.error, proof.storage.StorageError)
            self.assertTrue(reader.items.empty())

    def test_session_scope_must_be_bound_to_actual_api_owner(self):
        identity = {"session_id": "session-real", "session_epoch": 1}
        session = {"session_id": "session-real", "session_epoch": "session-real@1234",
                   "request_scope_epoch": self.pin + ":1"}
        with patch.object(proof, "read_api", return_value={"session": session}):
            self.assertEqual(proof.read_session_scope(1, self.pin, identity),
                             {"session_resource_epoch": "session-real@1234",
                              "request_scope_epoch": self.pin + ":1"})
        for change in ({"request_scope_epoch": "old-api:1"}, {"request_scope_epoch": self.pin + ":2"},
                       {"session_id": "other-session"}, {"session_epoch": 1}):
            with self.subTest(change=change), patch.object(proof, "read_api", return_value={"session": {**session, **change}}):
                with self.assertRaises(proof.storage.StorageError):
                    proof.read_session_scope(1, self.pin, identity)
        with patch.object(proof, "read_api", return_value={"session": session}):
            with self.assertRaises(proof.storage.StorageError):
                proof.read_session_scope(1, self.pin, {**identity, "session_epoch": True})
        with patch.object(proof, "read_api", return_value={"session": {**session, "request_scope_epoch": self.pin + ":0"}}):
            self.assertEqual(proof.read_session_scope(1, self.pin, {**identity, "session_epoch": 0})["request_scope_epoch"],
                             self.pin + ":0")

    def test_unwaited_helper_prevents_terminal_custody(self):
        apis = {10: {"waited": True, "exit_code": 1}}
        helpers = {20: {"waited": False}}
        self.assertFalse(proof.terminal_custody(apis, helpers))
        helpers[20].update(waited=True, exit_code=0)
        self.assertTrue(proof.terminal_custody(apis, helpers))
        helpers[20]["exit_code"] = False
        self.assertFalse(proof.terminal_custody(apis, helpers))

    def test_queued_started_helper_is_preserved_as_unknown(self):
        apis, helpers, receipt = {}, {}, {"processes": []}
        frame = {"schema": "fullmag.development-cli-candidate-preparation-progress.v1", "helper_pid": 20}
        self.assertTrue(proof.record_started_frame(frame, apis, helpers, receipt))
        self.assertFalse(helpers[20]["waited"])
        self.assertEqual(receipt["processes"], [helpers[20]])
        proof.record_started_frame(frame, apis, helpers, receipt)
        self.assertEqual(len(receipt["processes"]), 1)

    def test_cleanup_requires_complete_scoped_result(self):
        result = {"schema": proof.RESULT_SCHEMA, "nonce": self.expected["nonce"], "status": "failed",
                  "old_api_pid": 10, "old_api_instance_id": self.pin, "old_api_exit_code": 1,
                  "new_api_pid": None, "new_api_instance_id": None, "new_api_exit_code": None,
                  "helper_processes": [{"pid": 20, "waited": True, "exit_code": 0}]}
        proof.validate_result_frame(result, self.expected["nonce"])
        unknown = {**result, "status": "unknown", "old_api_exit_code": None}
        proof.validate_result_frame(unknown, self.expected["nonce"])
        self.assertFalse(proof.terminal_custody({10: {"waited": False}},
                                              {20: unknown["helper_processes"][0]}))
        for change in ({"nonce": "wrong"}, {"helper_processes": []},
                       {"helper_processes": [{"pid": 20, "waited": False, "exit_code": 0}]},
                       {"status": "passed"}, {"new_api_pid": 30}):
            with self.subTest(change=change), self.assertRaises(proof.storage.StorageError):
                proof.validate_result_frame({**result, **change}, self.expected["nonce"])

    def test_api_log_is_bound_to_owned_process_and_private_root(self):
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory).resolve()
            log = state_root / ("browser-workspace-api-" + "a" * 32 + ".log")
            log.write_text("", encoding="utf-8")
            frame = {"schema": proof.API_LOG_SCHEMA, "nonce": self.expected["nonce"], "api_pid": 10,
                     "api_instance_id": self.pin, "file_name": log.name}
            receipt = {}
            proof.record_api_log_frame(frame, self.expected, state_root, {10: {}}, receipt)
            self.assertEqual(receipt["workspace_browser_api_logs"][0]["path"], str(log))
            for change in ({"nonce": "wrong"}, {"api_pid": 11}, {"file_name": "../" + log.name}):
                with self.subTest(change=change), self.assertRaises(proof.storage.StorageError):
                    proof.record_api_log_frame({**frame, **change}, self.expected, state_root, {10: {}}, receipt)

    def test_cancel_requires_exact_scope_and_does_not_claim_finish(self):
        bridge = proof.ProofBridge(self.expected, 1, None, Mock())
        body = {"schema": "fullmag.development-browser-cancel.v1", "nonce": self.expected["nonce"]}
        for change in ({"nonce": "wrong"}, {"schema": "wrong"}, {"extra": True}):
            with self.subTest(change=change), self.assertRaises(proof.storage.StorageError):
                bridge.cancel({**body, **change})
        self.assertFalse(bridge.cancelled.is_set())
        self.assertEqual(bridge.cancel(body), {"cancel_requested": True})
        self.assertTrue(bridge.cancelled.is_set())
        self.assertFalse(bridge.finished.is_set())
        self.assertIsNone(bridge.browser)
        self.assertTrue(bridge.receipt["workspace_browser_cancel_requested"])
        with self.assertRaisesRegex(proof.storage.StorageError, "cancellation has already"):
            bridge.finish({})

    def test_cancel_cannot_replace_a_submitted_finish(self):
        bridge = proof.ProofBridge(self.expected, 1, None, Mock())
        bridge.finished.set()
        with self.assertRaises(proof.storage.StorageError):
            bridge.cancel({"schema": "fullmag.development-browser-cancel.v1", "nonce": self.expected["nonce"]})
        self.assertFalse(bridge.cancelled.is_set())

    def test_cancel_http_rejects_foreign_origin_before_requesting_cleanup(self):
        bridge = proof.ProofBridge(self.expected, 1, None, Mock())
        server = proof.ThreadingHTTPServer(("127.0.0.1", 0), proof.bridge_handler(bridge))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        body = json.dumps({"schema": "fullmag.development-browser-cancel.v1",
                           "nonce": self.expected["nonce"]})
        try:
            for origin, expected_status in (("http://localhost:3197", 409),
                                            (self.expected["ui_origin"], 200)):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                try:
                    connection.request("POST", "/cancel", body=body,
                                       headers={"Origin": origin, "Content-Type": "application/json"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected_status)
                    response.read()
                    self.assertEqual(bridge.cancelled.is_set(), expected_status == 200)
                    self.assertFalse(bridge.finished.is_set())
                finally:
                    connection.close()
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)
        self.assertFalse(worker.is_alive())

    def test_empty_scene_cannot_be_captured_as_restart_proof(self):
        process = type("Process", (), {"poll": lambda self: None})()
        bridge = proof.ProofBridge(self.expected, 1, None, process)
        bridge.ready = self.frame
        body = {"schema": "fullmag.development-browser-before.v1", "nonce": self.expected["nonce"],
                "api_instance_id": self.pin, "project_document_before": {"dirty": True}}
        with patch.object(proof, "utc_ms", return_value=1500), patch.object(proof, "read_api", return_value={"objects": []}):
            with self.assertRaises(proof.storage.StorageError):
                bridge.capture_before(body)
        self.assertIsNone(bridge.before)


if __name__ == "__main__":
    unittest.main()
