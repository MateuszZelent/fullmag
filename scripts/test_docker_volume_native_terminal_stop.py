"""Pure native-terminal stop contracts; no Docker, API, drain or solve calls."""
import copy
import json
import types
import unittest
from unittest import mock

import docker_volume_native_terminal_stop as subject
from docker_build_control import BuildControlError

API = "12345678-1234-1234-1234-123456789abc"
RUN = "run-live-test"
OWNER = {key: key for key in ("owner_token", "process_start_token", "host", "target_id", "protocol",
         "build_commit", "build_snapshot", "control_address", "compute_pool_generation", "preparation_pool_generation",
         "compute_pool_id", "preparation_pool_id")}
OWNER.update(pid=12, state="ready", children=[{"role": "compute", "pid": 13, "status": "running"},
                                            {"role": "preparation", "pid": 14, "status": "running"}])


def raw(value):
    return subject.canonical(value) + b"\n"


def snapshot():
    return {"api_instance_id": API, "status": {
        "session": {"session_id": "session-test", "session_epoch": "session-test@123", "request_scope_epoch": API + ":4"},
        "resources": {"scene_revision": 7, "stages_revision": 6}, "solver": {"state": "running"}, "run": {"run_id": RUN}},
        "run": {"run_id": RUN, "session_id": "session-test", "status": "running", "started_at": "123"},
        "scene": {"scene_revision": 7, "objects": []},
        "queue": {"schema_version": "compute_queue.v1", "items": [], "next_cursor": None},
        "commands": {"revision": 0, "commands": [], **{key + "_count": 0 for key in (
            "pending", "accepted", "dispatched", "running", "completed", "rejected", "failed")}},
        "runtime": {"schema_version": "application_service_status.v1", "configured": True, "state": "ready"},
        "health": {"status": "ok", "active_session": True}}


def records():
    live = {"session_id": "session-test", "api_instance_id": API, "session_epoch": 4,
        "scene_revision": 7, "request_idempotency_key": "request-test", "command_id": "request-test",
        "startup_source_sha256": "a" * 64, "command": {"kind": "startup_script", "request_id": "request-test", "source_sha256": "a" * 64}}
    return {"run_intent.json": {"schema_version": "run_intent.v1", "run_id": RUN, "payload_sha256": "b" * 64,
        "specification": {"run_id": RUN, "parameters": {"live_workspace": live}, "snapshot": {"definition_revision": 7}}},
        "run_catalog.json": {"schema_version": "run_catalog.v1", "run_id": RUN, "revision": 18,
                             "tasks": [{"lifecycle": "succeeded"}]},
        "start_release.json": {"schema_version": "accepted_run_start_release.v1", "run_id": RUN, "specification_sha256": "b" * 64}}


class Contracts(unittest.TestCase):
    def setUp(self):
        self.snapshot = snapshot()
        self.preflight = subject.snapshot_binding(self.snapshot)
        self.records = records()
        self.read_store = lambda path: raw(self.records[path.rsplit("/", 1)[1]])
        self.binding = subject.run_binding(self.read_store, self.preflight)
        self.capture = {"schema": subject.SCHEMA, "preflight": self.preflight, "run_binding": self.binding,
                        "native_config_sha256": subject.sha(b"config"), "terminal_evidence_sha256": "c" * 64,
                        "ready_owner": subject.owner_identity(OWNER)}
        terminal_owner = copy.deepcopy(OWNER)
        terminal_owner.update(state="drained")
        for child in terminal_owner["children"]:
            child["status"] = "exited_success"
        self.process = {"schema": "fullmag.docker-process-tree.v1", "state": "drained", "api_exit_code": -15,
                        "accepted_store": "/state/runs/docker-all/session-store", "service_owner": OWNER,
                        "terminal_service_owner": terminal_owner}

    def test_literal_running_is_preserved_and_native_success_is_separate(self):
        self.assertEqual(self.preflight["public_run"]["status"], "running")
        self.assertEqual(self.binding["run_id"], RUN)
        subject.validate_drain(self.capture, self.process)

    def test_api_scene_session_and_ready_guards(self):
        mutations = [lambda x: x.update(api_instance_id="foreign"),
            lambda x: x["status"]["session"].update(session_epoch="foreign@123"),
            lambda x: x["status"]["session"].update(request_scope_epoch=API + ":5junk"),
            lambda x: x["run"].update(session_id="other"),
            lambda x: x["scene"].update(scene_revision=8),
            lambda x: x["runtime"].update(state="failed"),
            lambda x: x["run"].update(status="completed"),
            lambda x: x["health"].update(active_session=False)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = copy.deepcopy(self.snapshot)
                mutate(value)
                with self.assertRaises(BuildControlError):
                    subject.snapshot_binding(value)

    def test_queue_and_active_commands_refused(self):
        for mutate in [lambda x: x["queue"].update(next_cursor="next"),
                       lambda x: x["queue"].update(items=[{"run_id": "foreign"}]),
                       lambda x: x["commands"].update(running_count=1),
                       lambda x: x["commands"].update(commands=[{"status": "running"}])]:
            value = copy.deepcopy(self.snapshot)
            mutate(value)
            with self.assertRaises(BuildControlError):
                subject.snapshot_binding(value)

    def test_terminal_command_entries_require_consistent_counts(self):
        value = self.snapshot["commands"]
        value.update(completed_count=1, commands=[{"status": "completed", "completed_at_unix_ms": 12, "completion_status": "completed"}])
        subject.snapshot_binding(self.snapshot)
        value["completed_count"] = 0
        with self.assertRaises(BuildControlError):
            subject.snapshot_binding(self.snapshot)

    def test_terminal_command_timestamp_and_outcome_are_typed(self):
        for timestamp in (False, True, 0, -1, "12", None):
            value = snapshot()
            value["commands"].update(completed_count=1, commands=[{
                "status": "completed", "completed_at_unix_ms": timestamp, "completion_status": "completed"}])
            with self.subTest(timestamp=timestamp), self.assertRaises(BuildControlError):
                subject.snapshot_binding(value)
        for status, outcome in (("failed", "completed"), ("rejected", "failed"), ("completed", "unknown")):
            value = snapshot()
            value["commands"].update({status + "_count": 1, "commands": [{
                "status": status, "completed_at_unix_ms": 12, "completion_status": outcome}]})
            with self.subTest(status=status), self.assertRaises(BuildControlError):
                subject.snapshot_binding(value)

    def test_options_are_explicit_and_normal_mode_unchanged(self):
        options = dict(recreate_services=False, restart_idle_service=True, stop_after_drain=True)
        self.assertEqual(subject.validate_options(types.SimpleNamespace(), **options), (False, None))
        self.assertEqual(subject.validate_options(types.SimpleNamespace(capture_native_terminal=True), **options), (True, None))
        for changes in ({"stop_after_drain": False}, {"recreate_services": True}, {"restart_idle_service": False}):
            with self.assertRaises(BuildControlError):
                subject.validate_options(types.SimpleNamespace(capture_native_terminal=True), **{**options, **changes})
        with self.assertRaises(BuildControlError):
            subject.validate_options(types.SimpleNamespace(capture_native_terminal=True, capture_terminal_observation=True), **options)
        pins = types.SimpleNamespace(native_terminal_stop="a" * 32, native_terminal_stop_sha256="b" * 64, fresh_state=True)
        self.assertEqual(subject.validate_options(pins, recreate_services=True, restart_idle_service=False,
                         stop_after_drain=False)[1], ("a" * 32, "b" * 64))
        pins.fresh_state = False
        with self.assertRaises(BuildControlError):
            subject.validate_options(pins, recreate_services=True, restart_idle_service=False, stop_after_drain=False)

    def test_native_nonterminal_and_accepted_api_mismatch_refused(self):
        for mutate in [lambda x: x["run_catalog.json"]["tasks"][0].update(lifecycle="running"),
                       lambda x: x["run_intent.json"]["specification"]["parameters"]["live_workspace"].update(api_instance_id="foreign"),
                       lambda x: x["run_intent.json"]["specification"]["snapshot"].update(definition_revision=8)]:
            saved = copy.deepcopy(self.records)
            mutate(self.records)
            with self.assertRaises(BuildControlError):
                subject.run_binding(self.read_store, self.preflight)
            self.records = saved

    def test_failed_drain_or_owner_change_refused(self):
        for mutate in [lambda x: x.update(state="shutdown_unknown"),
                       lambda x: x.update(api_exit_code=1),
                       lambda x: x["terminal_service_owner"].update(pid=99),
                       lambda x: x["terminal_service_owner"]["children"][0].update(status="running")]:
            value = copy.deepcopy(self.process)
            mutate(value)
            with self.assertRaises(BuildControlError):
                subject.validate_drain(self.capture, value)

    def test_native_capture_binds_all_three_records_across_inspection(self):
        observed = {"before": snapshot(), "after": snapshot(), "ready_owner": OWNER,
            "native_config_sha256": "a" * 64, "evidence": {
                "schema_version": "runtime_service_terminal_run_evidence.v1", "run_id": RUN,
                "terminal_evidence_sha256": "c" * 64, "mutations_applied": False, "solve_replayed": False},
            "run_pins": {"run_intent.json": self.binding["intent_sha256"],
                         "run_catalog.json": self.binding["catalog_sha256"],
                         "start_release.json": self.binding["start_release_sha256"]}}
        def capture(value):
            with mock.patch("docker_build_control.docker_capture", return_value=types.SimpleNamespace(stdout=raw(value))), \
                 mock.patch("docker_volume_terminal_observation._store_reader", return_value=self.read_store):
                return subject.capture("d" * 64, "/unused")
        self.assertEqual(capture(observed)["preflight"]["public_run"]["status"], "running")
        for key in observed["run_pins"]:
            value = copy.deepcopy(observed)
            value["run_pins"][key] = "9" * 64
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                capture(value)
        value = copy.deepcopy(observed)
        value["after"]["status"]["resources"]["stages_revision"] += 1
        with self.assertRaises(BuildControlError):
            capture(value)
        value = copy.deepcopy(observed)
        value["evidence"]["solve_replayed"] = True
        with self.assertRaises(BuildControlError):
            capture(value)

    def test_probe_script_parses_and_keeps_native_fence_mandatory(self):
        import ast
        ast.parse(subject.PROBE)
        self.assertIn("service-inspect-terminal-run", subject.PROBE)
        self.assertNotIn("service-recover", subject.PROBE)

    def _idle_capture(self, *, failure=None, drain_failure=False):
        from contextlib import ExitStack
        import test_docker_volume_idle_stop as existing
        import docker_volume_dev as dev
        fixture = existing.IdleStopFixture()
        fixture.args.capture_native_terminal = True
        fixture.args.config_sha256 = subject.sha(dev.canonical(fixture.document))
        drain = (raw(self.process), self.process)
        patches = existing.DockerVolumeIdleStopTests()._patches(fixture, drain)
        base_text, base_capture = fixture.text, fixture.capture
        def text(*args, **kwargs):
            if args[0] == "exec":
                return json.dumps({"status": "ok", "active_session": True})
            return base_text(*args, **kwargs)
        def docker_capture(*args, **kwargs):
            if args[0] == "start":
                self.assertEqual(args[1], existing.FRONTEND_ID)
                fixture.events.append(("restore-frontend", None))
                return types.SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
            return base_capture(*args, **kwargs)
        def capture(*args):
            self.assertTrue(fixture.frontend_stopped)
            self.assertFalse(fixture.backend_stopped)
            fixture.events.append(("native-capture", None))
            if failure:
                raise failure
            return self.capture
        with ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            stack.enter_context(mock.patch.object(dev, "docker_text", side_effect=text))
            stack.enter_context(mock.patch.object(dev, "docker_capture", side_effect=docker_capture))
            stack.enter_context(mock.patch.object(subject, "capture", side_effect=capture))
            if drain_failure:
                stack.enter_context(mock.patch.object(subject, "validate_drain", side_effect=BuildControlError("drain failed")))
            if failure or drain_failure:
                with self.assertRaises(BuildControlError):
                    dev.stop_idle(fixture.args)
            else:
                dev.stop_idle(fixture.args)
        return fixture

    def test_managed_native_capture_then_real_drain_boundary(self):
        fixture = self._idle_capture()
        self.assertTrue(fixture.backend_stopped)
        self.assertIs(fixture.control.operation.call_args.args[1]["capture_native_terminal"], True)
        receipt = next(event[1] for event in fixture.events if event[0] == "exit")
        self.assertEqual(receipt["state"], "succeeded")
        self.assertEqual(receipt["native_terminal_capture_sha256"], subject.sha(raw(self.capture)))
        self.assertFalse(any(event[0] == "restore-frontend" for event in fixture.events))

    def test_busy_inspection_restores_frontend_without_backend_stop(self):
        fixture = self._idle_capture(failure=BuildControlError("native descriptor busy"))
        self.assertFalse(fixture.backend_stopped)
        self.assertTrue(any(event[0] == "restore-frontend" for event in fixture.events))

    def test_drain_failure_never_records_successful_stop(self):
        fixture = self._idle_capture(drain_failure=True)
        receipt = next(event[1] for event in fixture.events if event[0] == "exit")
        self.assertIsNot(receipt.get("idle_backend_stopped"), True)

    def test_inspect_failure_does_not_create_capture(self):
        with mock.patch("docker_build_control.docker_capture", side_effect=BuildControlError("native descriptor busy")):
            with self.assertRaisesRegex(BuildControlError, "busy"):
                subject.capture("d" * 64, "/unused")

    def fresh_fixture(self):
        stop, attempt = "d" * 32, "e" * 32
        image = "sha256:" + "f" * 64
        services = {name: {"Id": value * 64, "Image": image, "Config": {}, "HostConfig": {}, "Mounts": [],
                    "State": {"Running": False, "StartedAt": "start"}} for name, value in (("backend", "1"), ("frontend", "2"))}
        root = "iteration/attempts/" + stop + "/"
        controls = {subject.CONFIG_PATH: b"config", subject.PROCESS_PATH: raw(self.process),
            root + "native-terminal-stop.json": raw(self.capture), root + "idle-stop-containers.json": raw(services),
            root + "backend-drain.json": raw({"schema": "fullmag.docker-idle-restart-drain.v1", "backend_container_id": services["backend"]["Id"],
                "process_receipt": self.process, "process_receipt_sha256": subject.sha(raw(self.process))})}
        terminal = {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration", "attempt": stop,
            "state": "succeeded", "idle_backend_stopped": True, "compose_project": "group", "control_volume": "volume",
            "config_sha256": "a" * 64, "inputs": {"source_root": "source", "attempt": attempt,
                "config_sha256": "a" * 64, "image_id": image, "capture_native_terminal": True},
            "native_terminal_capture_sha256": subject.sha(controls[root + "native-terminal-stop.json"]),
            "idle_stop_containers_sha256": subject.sha(controls[root + "idle-stop-containers.json"]),
            **{name + "_container": services[name]["Id"] for name in services}}
        controls[root + "terminal.json"] = controls[root + "receipt.json"] = raw(terminal)
        kwargs = dict(stop_attempt=stop, stop_sha256=subject.sha(raw(terminal)), source_root="source", attempt=attempt,
                      config_sha256="a" * 64, actual=services, store_root="unused")
        control = types.SimpleNamespace(project="group", volume="volume")
        return controls, kwargs, control

    def test_fresh_archive_requires_exact_terminal_cas_and_incarnations(self):
        controls, kwargs, control = self.fresh_fixture()
        with mock.patch("docker_volume_accepted_reattach._control_bytes", side_effect=lambda _, path, **kw: controls[path]), \
             mock.patch("docker_volume_terminal_observation._store_reader", return_value=self.read_store):
            proof = subject.validate_fresh(control, **kwargs)
            self.assertEqual(proof["stop_sha256"], kwargs["stop_sha256"])
            for name, value in [("stop_sha256", "9" * 64), ("source_root", "foreign"), ("attempt", "9" * 32),
                                ("config_sha256", "9" * 64)]:
                bad = copy.deepcopy(kwargs)
                bad[name] = value
                with self.assertRaises(BuildControlError):
                    subject.validate_fresh(control, **bad)
            kwargs["actual"]["backend"]["State"]["StartedAt"] = "restarted"
            with self.assertRaises(BuildControlError):
                subject.validate_fresh(control, **kwargs)


if __name__ == "__main__":
    unittest.main()
