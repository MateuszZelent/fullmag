"""Pure native-terminal stop contracts; no Docker, API, drain or solve calls."""
import copy
import json
import pathlib
import tempfile
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
        "scene": {"revision": 7, "objects": []},
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


def http_compute_snapshot():
    value = snapshot()
    command_id = "fm-http-compute-1"
    value["commands"].update(revision=4, accepted_count=1, commands=[{
        "command_id": command_id, "seq": 3, "kind": "relax", "status": "accepted",
        "client_intent_id": "study:relax:p22", "request_id": "request-http-p22",
        "target": {"kind": "run", "run_id": RUN}, "created_at_unix_ms": 1234,
        "dispatched_at_unix_ms": None, "completed_at_unix_ms": None,
        "completion_status": None, "error": None,
    }])
    return value


def http_compute_records():
    value = records()
    command_id = "fm-http-compute-1"
    key_sha = "d" * 64
    requested_target = {"kind": "run"}
    command = {"seq": 0, "command_id": command_id, "kind": "relax",
        "client_intent_id": "study:relax:p22", "target": requested_target}
    receipt = {"key_sha256": key_sha, "request_sha256": "e" * 64,
        "command_id": command_id, "request_id": "request-http-p22", "command_kind": "relax",
        "client_intent_id": "study:relax:p22", "requested_target": requested_target}
    live = value["run_intent.json"]["specification"]["parameters"]["live_workspace"]
    live.update(request_idempotency_key=key_sha, command_id=command_id,
        startup_source_sha256=None, command=command, request_receipt=receipt)
    value["run_intent.json"]["idempotency_key"] = "live-http-v2-" + key_sha
    value.pop("start_release.json")
    return value


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

    def http_compute_fixture(self):
        current = http_compute_snapshot()
        source = http_compute_records()
        preflight = subject.snapshot_binding(current)
        read_store = lambda path: raw(source[path.rsplit("/", 1)[1]])
        read_optional = lambda path: raw(source[path.rsplit("/", 1)[1]]) if path.rsplit("/", 1)[1] in source else None
        binding = subject.run_binding(read_store, preflight, read_optional)
        return current, source, preflight, read_store, read_optional, binding

    def test_literal_running_is_preserved_and_native_success_is_separate(self):
        self.assertEqual(self.preflight["public_run"]["status"], "running")
        self.assertEqual(self.binding["run_id"], RUN)
        subject.validate_drain(self.capture, self.process)

    def test_api_scene_session_and_ready_guards(self):
        mutations = [lambda x: x.update(api_instance_id="foreign"),
            lambda x: x["status"]["session"].update(session_epoch="foreign@123"),
            lambda x: x["status"]["session"].update(request_scope_epoch=API + ":5junk"),
            lambda x: x["run"].update(session_id="other"),
            lambda x: x["scene"].update(revision=8),
            lambda x: x["runtime"].update(state="failed"),
            lambda x: x["run"].update(status="completed"),
            lambda x: x["health"].update(active_session=False)]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                value = copy.deepcopy(self.snapshot)
                mutate(value)
                with self.assertRaises(BuildControlError):
                    subject.snapshot_binding(value)

    def test_scene_requires_canonical_revision_and_only_consistent_typed_alias(self):
        subject.snapshot_binding(self.snapshot)
        matching_alias = copy.deepcopy(self.snapshot)
        matching_alias["scene"]["scene_revision"] = 7
        subject.snapshot_binding(matching_alias)
        invalid_scenes = ({"scene_revision": 7}, {}, {"revision": True}, {"revision": False},
                          {"revision": -1}, {"revision": "7"},
                          {"revision": 7, "scene_revision": 8},
                          {"revision": 7, "scene_revision": True},
                          {"revision": 7, "scene_revision": "7"},
                          {"revision": 7, "scene_revision": None})
        for scene in invalid_scenes:
            value = copy.deepcopy(self.snapshot)
            value["scene"] = scene
            with self.subTest(scene=scene), self.assertRaises(BuildControlError):
                subject.snapshot_binding(value)

    def test_startup_binding_keeps_the_original_v1_capture_shape(self):
        self.assertEqual(set(self.binding), {
            "run_id", "intent_sha256", "catalog_sha256", "start_release_sha256", "specification_sha256",
        })

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
        value.update(completed_count=1, commands=[{"command_id": "cmd-terminal-test", "seq": 1,
            "status": "completed", "completed_at_unix_ms": 12, "completion_status": "completed"}])
        subject.snapshot_binding(self.snapshot)
        value["completed_count"] = 0
        with self.assertRaises(BuildControlError):
            subject.snapshot_binding(self.snapshot)

    def test_terminal_command_timestamp_and_outcome_are_typed(self):
        for timestamp in (False, True, 0, -1, "12", None):
            value = snapshot()
            value["commands"].update(completed_count=1, commands=[{
                "command_id": "cmd-terminal-test", "seq": 1,
                "status": "completed", "completed_at_unix_ms": timestamp, "completion_status": "completed"}])
            with self.subTest(timestamp=timestamp), self.assertRaises(BuildControlError):
                subject.snapshot_binding(value)
        for status, outcome in (("failed", "completed"), ("rejected", "failed"), ("completed", "unknown")):
            value = snapshot()
            value["commands"].update({status + "_count": 1, "commands": [{
                "command_id": "cmd-terminal-test", "seq": 1,
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

    def test_http_compute_capture_binds_one_current_accepted_command_and_absent_release(self):
        current, source, preflight, read_store, read_optional, binding = self.http_compute_fixture()
        self.assertEqual(binding["source_kind"], "http_compute")
        self.assertEqual(binding["accepted_command"], {
            "command_id": "fm-http-compute-1", "kind": "relax", "seq": 3,
            "client_intent_id": "study:relax:p22", "request_id": "request-http-p22",
            "target": {"kind": "run", "run_id": RUN},
        })
        self.assertIsNone(binding["start_release_sha256"])
        self.assertIsNone(subject._record_pins(binding)["start_release.json"])
        observed = {"before": current, "after": copy.deepcopy(current), "ready_owner": OWNER,
            "native_config_sha256": "a" * 64, "evidence": {
                "schema_version": "runtime_service_terminal_run_evidence.v1", "run_id": RUN,
                "terminal_evidence_sha256": "c" * 64, "mutations_applied": False, "solve_replayed": False},
            "run_pins": subject._record_pins(binding)}

        def capture(value, store_reader=read_store, optional_reader=read_optional):
            with mock.patch("docker_build_control.docker_capture",
                            return_value=types.SimpleNamespace(stdout=raw(value))), \
                 mock.patch("docker_volume_terminal_observation._store_reader", return_value=store_reader), \
                 mock.patch.object(subject, "optional_store_reader", return_value=optional_reader):
                return subject.capture("d" * 64, "/unused")

        captured = capture(observed)
        self.assertEqual(captured["run_binding"], binding)
        self.assertEqual(captured["run_binding"]["accepted_command"]["seq"], 3)
        requested_target_snapshot = copy.deepcopy(current)
        requested_target_snapshot["commands"]["commands"][0]["target"] = {"kind": "run"}
        requested_target_preflight = subject.snapshot_binding(requested_target_snapshot)
        requested_target_binding = subject.run_binding(read_store, requested_target_preflight, read_optional)
        self.assertEqual(requested_target_binding["accepted_command"]["target"], {"kind": "run"})
        for key in observed["run_pins"]:
            changed = copy.deepcopy(observed)
            changed["run_pins"][key] = "9" * 64
            with self.subTest(pin=key), self.assertRaises(BuildControlError):
                capture(changed)

        changed_source = copy.deepcopy(source)
        changed_source["run_intent.json"]["specification"]["parameters"]["live_workspace"][
            "request_receipt"]["request_sha256"] = "f" * 64
        changed_reader = lambda path: raw(changed_source[path.rsplit("/", 1)[1]])
        with self.assertRaises(BuildControlError):
            capture(observed, store_reader=changed_reader)

        changed_snapshot = copy.deepcopy(observed)
        changed_snapshot["after"]["commands"]["commands"][0]["seq"] = 4
        changed_snapshot["after"]["commands"]["revision"] = 5
        with self.assertRaises(BuildControlError):
            capture(changed_snapshot)

    def test_http_compute_rejects_foreign_extra_wrong_scope_and_changed_source(self):
        _, source, _, read_store, read_optional, _ = self.http_compute_fixture()
        mutations = [
            ("foreign command", lambda value: value["commands"]["commands"][0].update(command_id="fm-foreign")),
            ("wrong kind", lambda value: value["commands"]["commands"][0].update(kind="solve")),
            ("wrong client intent", lambda value: value["commands"]["commands"][0].update(client_intent_id="other-intent")),
            ("wrong request id", lambda value: value["commands"]["commands"][0].update(request_id="other-request")),
            ("foreign bound run", lambda value: value["commands"]["commands"][0].update(target={"kind": "run", "run_id": "run-foreign"})),
            ("zero sequence", lambda value: value["commands"]["commands"][0].update(seq=0)),
        ]
        for label, mutate in mutations:
            current = http_compute_snapshot()
            mutate(current)
            with self.subTest(case=label), self.assertRaises(BuildControlError):
                preflight = subject.snapshot_binding(current)
                subject.run_binding(read_store, preflight, read_optional)

        extra = http_compute_snapshot()
        extra["commands"]["commands"].append({
            **copy.deepcopy(extra["commands"]["commands"][0]), "command_id": "fm-extra-accepted", "seq": 4,
        })
        extra["commands"].update(revision=5, accepted_count=2)
        with self.assertRaises(BuildControlError):
            subject.snapshot_binding(extra)

        accepted_plus_running = http_compute_snapshot()
        accepted_plus_running["commands"]["commands"].append({
            "command_id": "fm-other-active", "seq": 4, "kind": "solve", "status": "running",
            "created_at_unix_ms": 1235,
        })
        accepted_plus_running["commands"].update(revision=5, running_count=1)
        with self.assertRaises(BuildControlError):
            subject.snapshot_binding(accepted_plus_running)

        unassigned_command_sequence = http_compute_records()
        unassigned_command_sequence["run_intent.json"]["specification"]["parameters"]["live_workspace"][
            "command"]["seq"] = 1
        with self.assertRaises(BuildControlError):
            subject.run_binding(
                lambda path: raw(unassigned_command_sequence[path.rsplit("/", 1)[1]]),
                preflight, lambda path: None,
            )

        wrong_request_target = http_compute_records()
        live = wrong_request_target["run_intent.json"]["specification"]["parameters"]["live_workspace"]
        live["command"]["target"] = {"kind": "stage_id", "stage_id": "stage-foreign"}
        preflight = subject.snapshot_binding(http_compute_snapshot())
        reader = lambda path: raw(wrong_request_target[path.rsplit("/", 1)[1]])
        with self.assertRaises(BuildControlError):
            subject.run_binding(reader, preflight, lambda path: None)

        foreign_epoch = http_compute_records()
        foreign_epoch["run_intent.json"]["specification"]["parameters"]["live_workspace"]["session_epoch"] = 5
        with self.assertRaises(BuildControlError):
            subject.run_binding(lambda path: raw(foreign_epoch[path.rsplit("/", 1)[1]]), preflight, lambda path: None)
        stale_epoch_snapshot = http_compute_snapshot()
        stale_epoch_snapshot["status"]["session"]["request_scope_epoch"] = API + ":5"
        stale_epoch_preflight = subject.snapshot_binding(stale_epoch_snapshot)
        with self.assertRaises(BuildControlError):
            subject.run_binding(read_store, stale_epoch_preflight, read_optional)

        foreign_scene = http_compute_records()
        foreign_scene["run_intent.json"]["specification"]["parameters"]["live_workspace"]["scene_revision"] = 8
        with self.assertRaises(BuildControlError):
            subject.run_binding(lambda path: raw(foreign_scene[path.rsplit("/", 1)[1]]), preflight, lambda path: None)

        unexpected_release = http_compute_records()
        unexpected_release["start_release.json"] = records()["start_release.json"]
        with self.assertRaises(BuildControlError):
            subject.run_binding(
                lambda path: raw(unexpected_release[path.rsplit("/", 1)[1]]),
                preflight,
                lambda path: raw(unexpected_release["start_release.json"]),
            )

        tampered_source = copy.deepcopy(source)
        tampered_source["run_intent.json"]["specification"]["parameters"]["live_workspace"][
            "request_receipt"]["request_sha256"] = "f" * 64
        observed = {"before": http_compute_snapshot(), "after": http_compute_snapshot(),
            "ready_owner": OWNER, "native_config_sha256": "a" * 64, "evidence": {
                "schema_version": "runtime_service_terminal_run_evidence.v1", "run_id": RUN,
                "terminal_evidence_sha256": "c" * 64, "mutations_applied": False, "solve_replayed": False},
            "run_pins": {"run_intent.json": "0" * 64, "run_catalog.json": "1" * 64,
                         "start_release.json": None}}
        with mock.patch("docker_build_control.docker_capture",
                        return_value=types.SimpleNamespace(stdout=raw(observed))), \
             mock.patch("docker_volume_terminal_observation._store_reader",
                        return_value=lambda path: raw(tampered_source[path.rsplit("/", 1)[1]])), \
             mock.patch.object(subject, "optional_store_reader", return_value=lambda path: None):
            with self.assertRaises(BuildControlError):
                subject.capture("d" * 64, "/unused")

    def test_http_compute_record_pins_flow_through_quiescence_and_fresh(self):
        current, _, preflight, read_store, read_optional, binding = self.http_compute_fixture()
        pins = subject._record_pins(binding)
        self.assertIsNone(pins["start_release.json"])
        prepared_observation = {"before": current, "after": copy.deepcopy(current), "ready_owner": OWNER,
            "native_config_sha256": "a" * 64, "process_sha256": "b" * 64,
            "api_pin": self.api_pin(), "run_pins": pins}
        with mock.patch("docker_build_control.docker_capture",
                        return_value=types.SimpleNamespace(stdout=raw(prepared_observation))), \
             mock.patch("docker_volume_terminal_observation._store_reader", return_value=read_store), \
             mock.patch.object(subject, "optional_store_reader", return_value=read_optional):
            prepared = subject.prepare_api_quiescence("d" * 64, "/unused")
        self.assertIsNone(prepared["run_pins"]["start_release.json"])

        retained = copy.deepcopy(self.process)
        retained.pop("terminal_service_owner")
        retained.update(state="failed_outcome_retained", api_pid=22, error=subject.QUIESCE_CAUSE,
                        api_diagnostic_only=False)
        observed = {"evidence": {"schema_version": "runtime_service_terminal_run_evidence.v1",
                "run_id": RUN, "terminal_evidence_sha256": "c" * 64,
                "mutations_applied": False, "solve_replayed": False},
            "run_pins": pins, "retained_process": retained,
            "retained_process_sha256": subject.sha(raw(retained)), "api_closed": True}
        intent = {"schema": subject.QUIESCE_INTENT_SCHEMA, "prepared": prepared}
        with mock.patch("docker_build_control.docker_capture",
                        return_value=types.SimpleNamespace(stdout=raw(observed))), \
             mock.patch("docker_volume_terminal_observation._store_reader", return_value=read_store), \
             mock.patch.object(subject, "optional_store_reader", return_value=read_optional):
            captured = subject.quiesce_api_and_capture("d" * 64, "/unused", intent)
        self.assertIsNone(captured["run_binding"]["start_release_sha256"])
        tampered_release_reader = lambda path: raw(records()["start_release.json"])
        with mock.patch("docker_volume_terminal_observation._store_reader", return_value=read_store), \
             mock.patch.object(subject, "optional_store_reader", return_value=tampered_release_reader):
            with self.assertRaises(BuildControlError):
                subject.quiesce_api_and_capture("d" * 64, "/unused", intent)

        controls, kwargs, control = self.fresh_fixture()
        root = "iteration/attempts/" + kwargs["stop_attempt"] + "/"
        captured = {"schema": subject.SCHEMA, "preflight": preflight, "run_binding": binding,
            "native_config_sha256": subject.sha(b"config"), "terminal_evidence_sha256": "c" * 64,
            "ready_owner": subject.owner_identity(OWNER)}
        controls[root + "native-terminal-stop.json"] = raw(captured)
        terminal = json.loads(controls[root + "terminal.json"])
        terminal["native_terminal_capture_sha256"] = subject.sha(controls[root + "native-terminal-stop.json"])
        controls[root + "terminal.json"] = controls[root + "receipt.json"] = raw(terminal)
        kwargs["stop_sha256"] = subject.sha(raw(terminal))
        with mock.patch("docker_volume_accepted_reattach._control_bytes",
                        side_effect=lambda _, path, **kw: controls[path]), \
             mock.patch("docker_volume_terminal_observation._store_reader", return_value=read_store), \
             mock.patch.object(subject, "optional_store_reader", return_value=read_optional):
            subject.validate_fresh(control, **kwargs)
        with mock.patch("docker_volume_accepted_reattach._control_bytes",
                        side_effect=lambda _, path, **kw: controls[path]), \
             mock.patch("docker_volume_terminal_observation._store_reader", return_value=read_store), \
             mock.patch.object(subject, "optional_store_reader", return_value=tampered_release_reader):
            with self.assertRaises(BuildControlError):
                subject.validate_fresh(control, **kwargs)

    def test_optional_release_pin_is_absence_or_safe_regular_file_never_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            run_dir = root / "runs" / RUN
            run_dir.mkdir(parents=True)
            relative = "runs/" + RUN + "/start_release.json"
            read_optional = subject.optional_store_reader(root)
            self.assertIsNone(read_optional(relative))
            release = raw(records()["start_release.json"])
            (run_dir / "start_release.json").write_bytes(release)
            self.assertEqual(read_optional(relative), release)
            (run_dir / "start_release.json").unlink()
            target = root / "release-target.json"
            target.write_bytes(release)
            (run_dir / "start_release.json").symlink_to(target)
            with self.assertRaises(BuildControlError):
                read_optional(relative)

    def test_probe_uses_the_same_image_owned_cpu_abi_setup_as_the_entrypoint(self):
        import sys
        calls = []
        entrypoint = types.SimpleNamespace(_configure_device_access=lambda: calls.append("device-access"))
        service = types.SimpleNamespace(canonical_paths=lambda: calls.append("paths"))
        with mock.patch.dict(sys.modules, {"entrypoint": entrypoint, "runtime_service": service}), \
             mock.patch.object(sys, "path", sys.path.copy()):
            exec(subject._QUIESCE_PREFIX, {})
        self.assertEqual(calls, ["device-access", "paths"])
        calls.clear()
        entrypoint._configure_device_access = mock.Mock(side_effect=RuntimeError("invalid device policy"))
        with mock.patch.dict(sys.modules, {"entrypoint": entrypoint, "runtime_service": service}), \
             mock.patch.object(sys, "path", sys.path.copy()), self.assertRaisesRegex(RuntimeError, "invalid device policy"):
            exec(subject._QUIESCE_PREFIX, {})
        self.assertEqual(calls, [])

    def test_probe_script_parses_and_keeps_native_fence_mandatory(self):
        import ast
        ast.parse(subject.PROBE)
        self.assertIn("service-inspect-terminal-run", subject.PROBE)
        self.assertNotIn("service-recover", subject.PROBE)

    def _idle_capture(self, *, failure=None, drain_failure=False, quiesce=False, incarnation_change=False):
        from contextlib import ExitStack
        import test_docker_volume_idle_stop as existing
        import docker_volume_dev as dev
        fixture = existing.IdleStopFixture()
        fixture.args.capture_native_terminal = True
        fixture.args.quiesce_api = quiesce
        fixture.args.config_sha256 = subject.sha(dev.canonical(fixture.document))
        process = copy.deepcopy(self.process)
        if quiesce:
            process.update(api_pid=22, error=subject.QUIESCE_CAUSE, api_diagnostic_only=False)
            stopped_backend = fixture.stopped_backend
            def stopped():
                result = stopped_backend()
                result["State"]["ExitCode"] = 1
                return result
            fixture.stopped_backend = stopped
        drain = (raw(process), process)
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
            if quiesce:
                prepared = {"preflight": self.preflight, "run_binding": self.binding,
                            "ready_owner": OWNER, "api_pin": self.api_pin(),
                            "native_config_sha256": self.capture["native_config_sha256"]}
                def close_and_capture(backend, store, intent):
                    self.assertTrue(fixture.control.write_bytes.called)
                    intent_path, intent_raw = fixture.control.write_bytes.call_args.args
                    self.assertTrue(intent_path.endswith("/api-quiescence-intent.json"))
                    self.assertEqual(json.loads(intent_raw), json.loads(raw(intent)))
                    fixture.events.append(("pidfd-close-api", None))
                    if failure:
                        raise failure
                    value = self.quiesced_capture()
                    value["api_quiescence"]["intent_sha256"] = subject.sha(intent_raw)
                    return value
                def prepare(*args):
                    if incarnation_change:
                        original_actual = fixture.actual
                        def changed(service):
                            result = original_actual(service)
                            if service == "backend":
                                result["State"]["StartedAt"] = "new-backend-incarnation"
                            return result
                        fixture.actual = changed
                    return prepared
                stack.enter_context(mock.patch.object(subject, "prepare_api_quiescence", side_effect=prepare))
                stack.enter_context(mock.patch.object(subject, "quiesce_api_and_capture", side_effect=close_and_capture))
            if drain_failure:
                stack.enter_context(mock.patch.object(subject, "validate_drain", side_effect=BuildControlError("drain failed")))
            if failure or drain_failure or incarnation_change:
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

    @staticmethod
    def api_pin():
        return {"pid": 22, "ppid": 11, "start_token": "4240740", "argv": [subject.API_BINARY], "exe": subject.API_BINARY}

    def quiesced_capture(self):
        captured = copy.deepcopy(self.capture)
        process = copy.deepcopy(self.process)
        process.pop("terminal_service_owner")
        process.update(state="failed_outcome_retained", api_pid=22,
                       error=subject.QUIESCE_CAUSE, api_diagnostic_only=False)
        captured["api_quiescence"] = {"schema": subject.QUIESCE_SCHEMA, "intent_sha256": "1" * 64,
            "api_pin": self.api_pin(), "api_closed": True, "signal": "SIGTERM", "retained_process": process,
            "retained_process_sha256": subject.sha(raw(process))}
        return captured

    def test_quiesce_requires_explicit_capture_stop_only(self):
        for args in (types.SimpleNamespace(quiesce_api=True),
                     types.SimpleNamespace(quiesce_api=True, capture_native_terminal=True)):
            with self.assertRaises(BuildControlError):
                subject.validate_options(args, recreate_services=False, restart_idle_service=True, stop_after_drain=False)
        with self.assertRaises(BuildControlError):
            subject.validate_options(types.SimpleNamespace(quiesce_api=True), recreate_services=False,
                                     restart_idle_service=True, stop_after_drain=True)
        self.assertEqual(subject.validate_options(types.SimpleNamespace(quiesce_api=True, capture_native_terminal=True),
                         recreate_services=False, restart_idle_service=True, stop_after_drain=True), (True, None))

    def test_quiescence_transport_is_fixed_one_pidfd_signal_no_fallback(self):
        import ast
        ast.parse(subject.QUIESCE_PREPARE)
        ast.parse(subject.QUIESCE_CAPTURE)
        self.assertEqual(subject.QUIESCE_CAPTURE.count("signal.pidfd_send_signal("), 1)
        for forbidden in ("os.kill(", "SIGKILL", "SIGCONT", "service-recover", "service-drain"):
            self.assertNotIn(forbidden, subject.QUIESCE_CAPTURE)
        self.assertIn("service-inspect-terminal-run", subject.QUIESCE_CAPTURE)
        self.assertIn('"start_release.json":optional_record_pin', subject.PROBE)
        self.assertIn('"start_release.json":optional_record_pin', subject.QUIESCE_CAPTURE)
        self.assertLess(subject.QUIESCE_CAPTURE.index("API/session/scene/resources changed"),
                        subject.QUIESCE_CAPTURE.index("signal.pidfd_send_signal("))

    def test_quiescence_requires_exact_retained_cause_and_native_owner(self):
        captured = self.quiesced_capture()
        subject.validate_quiescence(captured)
        for mutate in (lambda x: x["api_quiescence"].update(api_closed=False),
                       lambda x: x["api_quiescence"].update(signal="SIGKILL"),
                       lambda x: x["api_quiescence"]["retained_process"].update(error="other failure"),
                       lambda x: x["api_quiescence"]["retained_process"].update(api_exit_code=0),
                       lambda x: x["api_quiescence"]["retained_process"].update(api_diagnostic_only=True),
                       lambda x: x["api_quiescence"]["retained_process"]["service_owner"].update(state="failed")):
            value = copy.deepcopy(captured)
            mutate(value)
            # Rehash altered records to test semantic checks, not merely digest refusal.
            proof = value["api_quiescence"]
            proof["retained_process_sha256"] = subject.sha(raw(proof["retained_process"]))
            with self.assertRaises(BuildControlError):
                subject.validate_quiescence(value)

    def test_quiesced_managed_stop_requires_drain_and_backend_exit_one(self):
        fixture = self._idle_capture(quiesce=True)
        self.assertTrue(fixture.backend_stopped)
        self.assertTrue(any(event[0] == "pidfd-close-api" for event in fixture.events))
        self.assertFalse(any(event[0] == "restore-frontend" for event in fixture.events))
        receipt = next(event[1] for event in fixture.events if event[0] == "exit")
        self.assertTrue(fixture.control.operation.call_args.args[1]["quiesce_api"])
        self.assertEqual(receipt["state"], "succeeded")
        self.assertTrue(receipt["backend_stop_issued"])

    def test_restart_during_prepare_refuses_before_intent_and_signal(self):
        fixture = self._idle_capture(quiesce=True, incarnation_change=True)
        self.assertFalse(fixture.backend_stopped)
        self.assertFalse(any(event[0] == "pidfd-close-api" for event in fixture.events))
        self.assertTrue(any(event[0] == "restore-frontend" for event in fixture.events))
        self.assertFalse(any(call.args[0].endswith("/api-quiescence-intent.json")
                             for call in fixture.control.write_bytes.call_args_list))
        receipt = next(event[1] for event in fixture.events if event[0] == "exit")
        self.assertNotIn("api_quiescence_intent_sha256", receipt)

    def test_post_quiescence_busy_or_transport_failure_retains_unknown_without_rollback(self):
        for cause in ("native descriptor busy", "observation timeout after signal"):
            fixture = self._idle_capture(quiesce=True, failure=BuildControlError(cause))
            self.assertFalse(fixture.backend_stopped)
            self.assertFalse(any(event[0] == "restore-frontend" for event in fixture.events))
            receipt = next(event[1] for event in fixture.events if event[0] == "exit")
            self.assertEqual(receipt["api_quiescence_outcome"], "outcome-unknown-retained")
            self.assertFalse(receipt["backend_stop_issued"])
            self.assertFalse(receipt["api_respawned"])
            self.assertEqual(sum(event[0] == "pidfd-close-api" for event in fixture.events), 1)

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

    def test_quiesced_fresh_requires_exact_intent_cas_and_failure_cause(self):
        controls, kwargs, control = self.fresh_fixture()
        root = "iteration/attempts/" + kwargs["stop_attempt"] + "/"
        captured = self.quiesced_capture()
        before = copy.deepcopy(kwargs["actual"])
        before["backend"]["State"]["Running"] = True
        intent = {"schema": subject.QUIESCE_INTENT_SCHEMA, "services": before, "prepared": {
            "preflight": captured["preflight"], "run_binding": captured["run_binding"], "ready_owner": OWNER,
            "api_pin": captured["api_quiescence"]["api_pin"], "native_config_sha256": captured["native_config_sha256"]}}
        intent_raw = raw(intent)
        captured["api_quiescence"]["intent_sha256"] = subject.sha(intent_raw)
        controls[root + "api-quiescence-intent.json"] = intent_raw
        controls[root + "native-terminal-stop.json"] = raw(captured)
        process = copy.deepcopy(self.process)
        process.update(api_pid=22, error=subject.QUIESCE_CAUSE, api_diagnostic_only=False)
        controls[subject.PROCESS_PATH] = raw(process)
        controls[root + "backend-drain.json"] = raw({"schema": "fullmag.docker-idle-restart-drain.v1",
            "backend_container_id": kwargs["actual"]["backend"]["Id"], "process_receipt": process,
            "process_receipt_sha256": subject.sha(raw(process))})
        kwargs["actual"]["backend"]["State"].update(ExitCode=1, OOMKilled=False)
        controls[root + "idle-stop-containers.json"] = raw(kwargs["actual"])
        terminal = json.loads(controls[root + "terminal.json"])
        terminal["inputs"]["quiesce_api"] = True
        terminal["api_quiescence_intent_sha256"] = subject.sha(intent_raw)
        terminal["native_terminal_capture_sha256"] = subject.sha(raw(captured))
        terminal["idle_stop_containers_sha256"] = subject.sha(controls[root + "idle-stop-containers.json"])
        controls[root + "terminal.json"] = controls[root + "receipt.json"] = raw(terminal)
        kwargs["stop_sha256"] = subject.sha(raw(terminal))
        with mock.patch("docker_volume_accepted_reattach._control_bytes", side_effect=lambda _, path, **kw: controls[path]), \
             mock.patch("docker_volume_terminal_observation._store_reader", return_value=self.read_store):
            subject.validate_fresh(control, **kwargs)
            controls[root + "api-quiescence-intent.json"] += b" "
            with self.assertRaises(BuildControlError):
                subject.validate_fresh(control, **kwargs)


if __name__ == "__main__":
    unittest.main()
