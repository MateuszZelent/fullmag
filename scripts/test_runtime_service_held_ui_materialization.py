"""Mocked private launch bridge: no Docker, HTTP, native process or simulation."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("runtime_held_ui_tests", Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py")
service = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = service
SPEC.loader.exec_module(service)
PROCESS_ENVIRONMENT = service.process_environment


def raw(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode() + b"\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class HeldUiLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        control = root / "control"
        control.mkdir()
        build_control = root / "build-control"
        build_control.mkdir()
        patch.object(service, "BUILD_CONTROL_ROOT", build_control).start()
        self.paths = service.RuntimePaths(state_root=control, store=root / "store", config=root / "config.json")
        self.paths.config.write_bytes(raw({"store_root": str(self.paths.store)}))
        self.request_id = "11111111-1111-4111-8111-111111111111"
        self.parent = control / "held-ui-materialization" / self.request_id
        self.parent.mkdir(parents=True)
        self.request = {
            "schema": "fullmag.held-ui-materialization-request.v1",
            "plan": {"attempt": "a"*32, "maintenance_request_id": self.request_id, "plan_sha256": "b"*64},
            "source_scope": {"compose_project": "test-project"},
            "stop_authority": {"stop_attempt": "c"*32},
            "accepted": {"project_id": "project-live-"+"a"*64, "run_id": "run-live-"+"b"*64,
                         "session_id": "session-test", "session_epoch": 1,
                         "session_created_at_unix_ms": 1794582150656, "scene_revision": 2,
                         "run_intent_sha256": "e"*64, "request_receipt_sha256": "f"*64,
                         "command_id": "fm-22222222-2222-4222-8222-222222222222"},
        }
        for key in ("preflight", "api_quiescence", "native_drain", "inventory"):
            data = raw({"schema": "test-" + key})
            file = self.parent / (key + ".json")
            file.write_bytes(data)
            self.request["stop_authority"][key] = {"path": str(file.relative_to(control)), "sha256": sha(data)}
        terminal_relative = "held-ui-materialization-stop/attempts/" + "c"*32 + "/terminal.json"
        terminal = build_control / terminal_relative
        terminal.parent.mkdir(parents=True)
        terminal_raw = raw({"schema": "test-stop-terminal"})
        terminal.write_bytes(terminal_raw)
        self.request["stop_authority"]["terminal"] = {"path": terminal_relative, "sha256": sha(terminal_raw)}
        self.provenance = {"schema": "fullmag.docker-all-image.v1", "state": "succeeded", "commit": "1"*40,
                           "source_snapshot_sha256": "2"*64, "image_id": "sha256:"+"3"*64}
        self.environment = {"FULLMAG_HELD_UI_MATERIALIZATION_REQUEST": str((self.parent / "request.json").relative_to(control)),
                            "FULLMAG_RUNTIME_PROVENANCE": str(service.ACCEPTED_REATTACH_PROVENANCE),
                            "FULLMAG_RUNTIME_IMAGE_ID": self.provenance["image_id"]}
        self.write_request()
        self.addCleanup(patch.stopall)
        patch.object(service, "process_environment", side_effect=lambda *a, **k: dict(self.environment)).start()

    def write_request(self):
        data = raw(self.request)
        (self.parent / "request.json").write_bytes(data)
        self.environment["FULLMAG_HELD_UI_MATERIALIZATION_REQUEST_SHA256"] = sha(data)

    def launch(self, preflight):
        return service.held_ui_materialization_api_input(self.paths, preflight=preflight,
                    terminal_preflight=None, accepted_preflight=None, store_binding="4"*64)

    def test_native_service_children_do_not_inherit_private_stdin_mode(self):
        with patch.dict(service.os.environ, {
            "FULLMAG_DEVELOPMENT_HELD_UI_MATERIALIZATION_STDIN": "1",
            "UNRELATED": "preserved",
        }, clear=True), patch.object(service, "api_environment", return_value={"CONFIG": "native"}):
            environment = PROCESS_ENVIRONMENT(self.paths, service=True)
        self.assertNotIn("FULLMAG_DEVELOPMENT_HELD_UI_MATERIALIZATION_STDIN", environment)
        self.assertEqual(environment["UNRELATED"], "preserved")

    def test_ordinary_startup_remains_noop(self):
        self.environment.clear()
        self.assertIsNone(service.held_ui_materialization_preflight(self.paths))

    def test_ordinary_input_delegates_existing_restore_unchanged(self):
        from contextlib import nullcontext
        self.environment.clear()
        legacy = ({"unchanged": "legacy"}, None, {"legacy": True})
        with patch.object(service, "terminal_observation_api_input", return_value=nullcontext(legacy)) as delegated:
            with service.held_ui_materialization_api_input(self.paths, preflight=None,
                    terminal_preflight={"terminal": True}, accepted_preflight=None, store_binding="4"*64) as actual:
                self.assertEqual(actual, legacy)
        delegated.assert_called_once_with(self.paths, terminal_preflight={"terminal": True}, accepted_preflight=None)

    def test_preflight_is_read_only_and_hashes_every_proof(self):
        before = sorted(str(p.relative_to(self.parent)) for p in self.parent.iterdir())
        preflight = service.held_ui_materialization_preflight(self.paths)
        self.assertEqual(preflight["request"], self.request)
        self.assertEqual(before, sorted(str(p.relative_to(self.parent)) for p in self.parent.iterdir()))
        (self.parent / "inventory.json").write_bytes(b"changed")
        with self.assertRaises(service.RuntimeServiceError):
            service.held_ui_materialization_preflight(self.paths)

    def test_conflicting_restore_and_unknown_fields_fail_before_launch(self):
        for field in ("FULLMAG_STARTUP_ENABLED", "FULLMAG_DEVELOPMENT_RESTORE_STDIN",
                      "FULLMAG_ACCEPTED_REATTACH_REQUEST", "FULLMAG_TERMINAL_OBSERVATION_REQUEST",
                      "FULLMAG_ISOLATED_SNAPSHOT_START", "FULLMAG_ISOLATED_SNAPSHOT_START_SHA256",
                      "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST",
                      "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_REQUEST_SHA256",
                      "FULLMAG_RUNTIME_UNCLAIMED_CANCELLATION_ATTEMPT",
                      "FULLMAG_RUNTIME_RECOVERY_AUTHORIZATION", "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION",
                      "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256", "FULLMAG_STARTUP_SCRIPT",
                      "FULLMAG_STARTUP_PROVENANCE", "FULLMAG_STARTUP_API", "FULLMAG_STARTUP_PROVENANCE_SHA256",
                      "FULLMAG_STARTUP_HELPER_SHA256", "FULLMAG_STARTUP_RECEIPT_KEY"):
            self.environment[field] = "1"
            with self.assertRaises(service.RuntimeServiceError):
                service.held_ui_materialization_preflight(self.paths)
            del self.environment[field]
        self.request["unexpected"] = True
        self.write_request()
        with self.assertRaises(service.RuntimeServiceError):
            service.held_ui_materialization_preflight(self.paths)
        self.assertFalse((self.parent / "launch.json").exists())

    def test_proof_escape_and_symlink_fail_closed(self):
        original = dict(self.request["stop_authority"]["preflight"])
        self.request["stop_authority"]["preflight"]["path"] = "../outside.json"
        self.write_request()
        with self.assertRaises(service.RuntimeServiceError):
            service.held_ui_materialization_preflight(self.paths)
        self.request["stop_authority"]["preflight"] = original
        self.write_request()
        file = self.parent / "preflight.json"
        file.rename(self.parent / "real.json")
        file.symlink_to(self.parent / "real.json")
        with self.assertRaises((service.RuntimeServiceError, OSError)):
            service.held_ui_materialization_preflight(self.paths)

    def test_launch_binds_exact_input_and_refuses_second_launch(self):
        preflight = service.held_ui_materialization_preflight(self.paths)
        with patch.object(service, "_read_json", return_value=self.provenance):
            with self.launch(preflight) as (environment, stream, launch):
                data = stream.read()
                payload = json.loads(data)
                self.assertEqual(payload["schema"], "fullmag.development-held-ui-materialization-restore.v1")
                self.assertEqual(environment["FULLMAG_DEVELOPMENT_HELD_UI_MATERIALIZATION_STDIN"], "1")
                record = json.loads((self.parent / "launch.json").read_bytes())
                self.assertEqual(record["input_sha256"], sha(data))
                self.assertEqual(record["input"], payload)
                self.assertEqual(launch["input_sha256"], sha(data))
            with self.assertRaises(service.RuntimeServiceUnknown):
                with self.launch(preflight):
                    self.fail("existing launch must never launch API twice")

    def test_hardlink_and_nonstandard_json_are_rejected(self):
        original = (self.parent / "request.json").read_bytes()
        (self.parent / "alias.json").hardlink_to(self.parent / "request.json")
        with self.assertRaises(service.RuntimeServiceError):
            service.held_ui_materialization_preflight(self.paths)
        (self.parent / "alias.json").unlink()
        for data in (original.replace(b'"scene_revision":2', b'"scene_revision":NaN'),
                     original.replace(b'"scene_revision":2', b'"scene_revision":2,"scene_revision":3')):
            (self.parent / "request.json").write_bytes(data)
            self.environment["FULLMAG_HELD_UI_MATERIALIZATION_REQUEST_SHA256"] = sha(data)
            with self.assertRaises(service.RuntimeServiceError):
                service.held_ui_materialization_preflight(self.paths)

    def test_acknowledgement_must_match_actual_api_and_original_intent(self):
        from types import SimpleNamespace
        preflight = service.held_ui_materialization_preflight(self.paths)
        with patch.object(service, "_read_json", return_value=self.provenance):
            with self.launch(preflight) as (_, stream, launch):
                payload = json.loads(stream.read())
        accepted = payload["accepted"]
        api_id = "33333333-3333-4333-8333-333333333333"
        handle = SimpleNamespace(api_identity={"api_instance_id": api_id})
        ack = {"schema": "fullmag.development-held-ui-materialization-restore-ack.v1",
               "state": "restored", "launch_id": launch["launch_id"], "input_sha256": launch["input_sha256"],
               "api_instance_id": api_id, **{key: payload["target_runtime"][key] for key in
                    ("config_sha256", "accepted_store_binding")},
               **{key: accepted[key] for key in ("project_id", "run_id", "session_id", "session_epoch",
                   "session_created_at_unix_ms", "scene_revision", "run_intent_sha256", "request_receipt_sha256", "command_id")},
               "catalog_sha256": "5"*64, "start_release_sha256": "6"*64, "gate_action": "released"}
        path = self.parent / ("restore-ack-" + launch["launch_id"] + ".json")
        path.write_bytes(raw(ack))
        result = service.held_ui_materialization_runtime_receipt(self.paths, preflight=preflight, launch=launch, handle=handle)
        self.assertEqual(result["run_id"], accepted["run_id"])
        for key, invalid in (("api_instance_id", "44444444-4444-4444-8444-444444444444"),
                             ("run_intent_sha256", "7"*64), ("scene_revision", True),
                             ("session_epoch", 1794582150656), ("session_created_at_unix_ms", 1),
                             ("gate_action", "new_run")):
            changed = {**ack, key: invalid}
            path.write_bytes(raw(changed))
            with self.subTest(key=key), self.assertRaises(service.RuntimeServiceError):
                service.held_ui_materialization_runtime_receipt(self.paths, preflight=preflight, launch=launch, handle=handle)

    def test_changed_request_after_preflight_never_writes_launch(self):
        preflight = service.held_ui_materialization_preflight(self.paths)
        self.request["accepted"]["scene_revision"] = 3
        self.write_request()
        with self.assertRaises(service.RuntimeServiceError):
            with self.launch(preflight):
                self.fail("changed request must not reach API")
        self.assertFalse((self.parent / "launch.json").exists())


if __name__ == "__main__":
    unittest.main()
