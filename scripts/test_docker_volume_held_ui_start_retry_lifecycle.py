from __future__ import annotations

import copy
import hashlib
import json
import sys
import types
import unittest
from contextlib import contextmanager, ExitStack
from pathlib import Path
from unittest.mock import patch

import docker_build_control
import docker_volume_held_ui_start_retry as controller
import docker_volume_held_ui_start_retry_lifecycle as lifecycle
from test_docker_volume_held_ui_start_retry import _plan


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


class _Control:
    project = "fullmag-worktree-test"
    volume = "fullmag-control-test"
    namespace = ""
    identity = {"source_root": "/work/fullmag"}

    def __init__(self, trace):
        self.trace = trace
        self.files = {}
        self.operation_token = "c" * 32
        self.operations = []

    def read_bytes(self, relative, *, optional=False, maximum=None):
        self.trace.append(("read", relative))
        value = self.files.get(relative)
        if value is None:
            if optional:
                return None
            raise FileNotFoundError(relative)
        if isinstance(value, bytes):
            return value
        return docker_build_control.canonical(value) + b"\n"

    def read(self, relative, *, optional=False):
        raw = self.read_bytes(relative, optional=optional)
        if raw is None:
            return None
        return json.loads(raw)

    def write(self, relative, value):
        self.trace.append(("control-write", relative))
        self.files[relative] = docker_build_control.canonical(value) + b"\n"

    def write_bytes(self, relative, raw):
        self.trace.append(("control-write-bytes", relative))
        self.files[relative] = raw

    @contextmanager
    def operation(self, phase, inputs):
        attempt = self.operation_token
        operation = {
            "lease_ready": True,
            "root": phase + "/attempts/" + attempt,
            "daemon_pending": False,
            "receipt": {
                "schema": "fullmag.docker-build-operation.v1",
                "phase": phase,
                "attempt": attempt,
                "state": "preparing",
                "inputs": dict(inputs),
            },
        }
        self.operations.append(operation)
        self.trace.append(("lease", phase, attempt))
        try:
            yield operation
        except BaseException:
            raise
        else:
            terminal = dict(operation["receipt"])
            terminal["state"] = "succeeded"
            raw = docker_build_control.canonical(terminal) + b"\n"
            self.files[operation["root"] + "/terminal.json"] = raw
            self.files[phase + "/current.json"] = raw
            self.files[phase + "/verified.json"] = raw


def _context():
    trace = []
    control = _Control(trace)
    plan = _plan()
    names = controller.AUTHORITY_NAMES
    authority_raw = {name: ("immutable " + name + "\n").encode() for name in names}
    plan["authority_sha256"] = {name: _sha(raw) for name, raw in authority_raw.items()}
    plan["released_snapshot_sha256"] = _sha(docker_build_control.canonical({
        "active_count": 0, "reservations": [], "leases": [], "ledger": "released",
    }))
    plan_sha = controller.plan_digest(plan)
    state = Path(plan["namespace"]["state_root"])
    selected = Path(plan["namespace"]["source_root"])
    original = {
        "control": control,
        "state": state,
        "selected": selected,
        "request": {"accepted": {"run_id": plan["original"]["run_id"]}},
        "previous": {"attempt": plan["original"]["attempt"]},
        "document": {"services": {"backend": {"environment": {"FULLMAG_DEV_INCLUDE_UNTRACKED": "[]"}}, "frontend": {}}},
    }
    image = plan["failed"]["image_id"]
    actual = {
        "backend": {
            "Id": plan["failed"]["backend_container_id"], "Image": image,
            "State": {"StartedAt": plan["failed"]["backend_started_at"],
                      "Running": True, "Restarting": False},
            "Config": {"Labels": {}}, "HostConfig": {}, "Mounts": [],
        },
        "frontend": {
            "Id": plan["failed"]["frontend_container_id"], "Image": image,
            "State": {"StartedAt": plan["failed"]["frontend_started_at"],
                      "Running": True, "Restarting": False},
            "Config": {"Labels": {}}, "HostConfig": {}, "Mounts": [],
        },
    }
    failed_value = {
        "inputs": {"gpu_access_requested": "auto", "native_contracts": []},
        "backend_volumes": {"control": control.volume},
        "frontend_volume": control.volume,
        "private_group_storage": "group-volume-v1",
        "frontend_generation_id": plan["frontend_handoff"]["frontend_generation_id"],
        "frontend_generation_subpath": plan["frontend_handoff"]["frontend_generation_subpath"],
    }
    failed = {
        "raw": b"exact failed terminal bytes",
        "value": failed_value,
        "document_raw": b"exact failed compose bytes",
        "document": original["document"],
        "verified_raw": b"exact prior verified bytes",
        "actual": actual,
    }
    released_snapshot = {"active_count": 0, "reservations": [], "leases": [], "ledger": "released"}
    context = {
        "schema": lifecycle.CONTEXT_SCHEMA,
        "original_request_context": original,
        "failed_parent": failed,
        "plan": plan,
        "plan_sha256": plan_sha,
        "authority_raw": authority_raw,
        "released_snapshot": released_snapshot,
    }
    control.files["development/current.json"] = failed["raw"]
    control.files["development/verified.json"] = failed["verified_raw"]
    archive_attempt = control.operation_token
    parent = "held-ui-materialization/" + plan["original"]["request_id"] + "/"
    for name, raw in authority_raw.items():
        control.files["runtime-archives/" + archive_attempt + "/" + parent + name] = raw
    return context, trace


class HeldRetryApplyLifecycleTests(unittest.TestCase):
    def _apply_patches(self, context, *, capture_side_effect=None, fail_action=None,
                       released_side_effect=None, archive_error=None, copy_error=None,
                       stopped_observer_error=None, readback=None):
        import docker_volume_dev as dev
        import docker_volume_fresh_runtime as fresh_runtime
        import docker_volume_pre_ack_retry as pre_ack
        import docker_volume_container_recovery as container_recovery
        import docker_dev_network

        trace = context["original_request_context"]["control"].trace
        control = context["original_request_context"]["control"]
        actual = context["failed_parent"]["actual"]
        released = context["released_snapshot"]
        capture_values = capture_side_effect or [context]
        capture_iter = iter(capture_values)

        def capture(*_args, **_kwargs):
            value = next(capture_iter)
            return value

        def docker_text(*args, **_kwargs):
            trace.append(("docker-text", *args))
            if args[0] == "inspect":
                identifier = args[1]
                for item in actual.values():
                    if item["Id"] == identifier:
                        return json.dumps([item])
            if args[0] == "image" and args[1] == "inspect":
                return json.dumps([{"Config": {}}])
            raise AssertionError("unexpected Docker inspection: " + repr(args))

        def docker_action(*args, **_kwargs):
            trace.append(("docker", *args))
            action = args[0]
            if (fail_action == action
                    or (isinstance(fail_action, tuple) and len(fail_action) == 2
                        and action == fail_action[0] and args[-1] == fail_action[1])):
                raise RuntimeError("simulated unknown " + action)
            if action == "stop":
                identifier = args[-1]
                for item in actual.values():
                    if item["Id"] == identifier:
                        item["State"]["Running"] = False

        def publish(target, relative, raw, *, maximum=None):
            trace.append(("publish", relative))
            if (copy_error and relative.endswith("/request.json")
                    and relative.startswith("runtime-control/held-ui-materialization/")):
                raise OSError("simulated create-only copy failure")
            if relative in target.files:
                raise FileExistsError(relative)
            target.files[relative] = raw

        def archive(*_args, **_kwargs):
            trace.append(("archive",))
            if archive_error:
                raise RuntimeError("simulated archive outcome unknown")
            return {"schema": "fullmag.docker-fresh-runtime-archive-terminal.v1", "state": "succeeded"}

        def released_snapshot(*_args, **_kwargs):
            if released_side_effect is not None:
                return released_side_effect
            return released

        def observer(*_args, **_kwargs):
            trace.append(("observe-runtime",))
            return {"runtime": context["plan"]["runtime"],
                    "native_locks": context["plan"]["native_locks"]}

        probe = types.ModuleType("docker_volume_held_ui_retry_probe")
        probe.observe = observer
        def observe_stopped(*_args, **_kwargs):
            trace.append(("observe-stopped",))
            if stopped_observer_error:
                raise docker_build_control.BuildControlError(stopped_observer_error)
            return {"state": "stopped-no-execution"}
        probe.observe_stopped = observe_stopped
        host = types.SimpleNamespace(
            OWNER_NAME="owner.json",
            read_owned_regular=lambda _path: b"certificate bytes",
        )
        dev_patches = [
            patch.object(dev, "docker_text", side_effect=docker_text),
            patch.object(dev, "_validate_retained_service", return_value=None),
            patch.object(dev, "_assert_private_restart_network", return_value=None),
            patch.object(dev, "_session_host", return_value=host),
            patch.object(dev, "_certificate_path", return_value=Path("/state/certificate.json")),
            patch.object(dev, "_retained_certificate", return_value=context["plan"]["certificate"]),
            patch.object(dev, "_operator_probe_record_from_retained", return_value={}),
            patch.object(dev, "_retained_device_access", return_value="gpu"),
            patch.object(dev, "start", side_effect=lambda *a, **kw: trace.append(("start", a, kw))),
            patch.object(dev, "_read_canonical_control_record", side_effect=lambda c, p, _label: (
                c.read_bytes(p), json.loads(c.read_bytes(p)))),
            patch.object(lifecycle, "capture", side_effect=capture),
            patch.object(lifecycle, "assert_consumers", return_value=True),
            patch.object(lifecycle, "certificate_pin", return_value=context["plan"]["certificate"]),
            patch.object(lifecycle, "docker_capture", side_effect=docker_action),
            patch.object(lifecycle, "readback", return_value=readback or {"state": "restored"}),
            patch.object(fresh_runtime, "archive_runtime_control", side_effect=archive),
            patch.object(container_recovery, "_assert_container_absent", return_value=None),
            patch.object(pre_ack, "_released_snapshot", side_effect=released_snapshot),
            patch.object(pre_ack, "_publish_raw", side_effect=publish),
            patch.object(docker_dev_network, "retained_requested_subnet", return_value=None),
            patch.dict(sys.modules, {"docker_volume_held_ui_retry_probe": probe}),
        ]
        return dev_patches

    def _run_apply(self, context, **kwargs):
        import docker_volume_dev as dev
        args = types.SimpleNamespace(
            attempt=context["plan"]["original"]["attempt"],
            config_sha256=context["plan"]["original"]["config_sha256"],
            request_id=context["plan"]["original"]["request_id"],
            run_id=context["plan"]["original"]["run_id"],
            expected_plan_sha256=context["plan"]["original"]["plan_sha256"],
            retry_plan_sha256=context["plan_sha256"],
            failed_held_start_attempt=context["plan"]["failed"]["attempt"],
            failed_held_start_sha256=context["plan"]["failed"]["terminal_sha256"],
            source_root=Path(context["plan"]["namespace"]["source_root"]),
            port=3197, preview=False, apply=True, script=None, fresh_state=False,
            gpu_access="auto", network_subnet=None, native_contract=None,
        )
        # Successful apply reads the real recreation terminal after the lease.
        # The fake managed lease writes it using this exact normal read helper.
        patches = self._apply_patches(context, **kwargs)
        with ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            result = lifecycle.apply(args, context)
        return args, result

    def test_apply_publishes_once_only_claim_before_first_stop(self):
        context, trace = _context()
        with self.assertRaisesRegex(RuntimeError, "unknown stop"):
            self._run_apply(context, fail_action=("stop", context["plan"]["failed"]["frontend_container_id"]))
        events = [event for event in trace if event[0] in {"publish", "docker", "archive", "start"}]
        plan_index = next(i for i, event in enumerate(events) if event == ("publish", lifecycle.reference(context)["plan_path"]))
        claim_path = "held-ui-start-retry/" + context["plan"]["failed"]["attempt"] + "/recreate-claim.json"
        claim_index = next(i for i, event in enumerate(events) if event == ("publish", claim_path))
        first_stop = next(i for i, event in enumerate(events) if event[0] == "docker" and event[1] == "stop")
        self.assertLess(plan_index, first_stop)
        self.assertLess(claim_index, first_stop)
        self.assertIn(claim_path, context["original_request_context"]["control"].files)
        self.assertFalse(any(event[0] in {"archive", "start"} for event in events))

    def test_capture_changed_under_lease_refuses_before_publication_or_stop(self):
        context, trace = _context()
        changed = copy.deepcopy(context)
        changed["plan"]["native_locks"]["owner"]["inode"] += 1
        changed["plan_sha256"] = controller.plan_digest(changed["plan"])
        with self.assertRaisesRegex(docker_build_control.BuildControlError, "capture changed"):
            self._run_apply(context, capture_side_effect=[changed])
        self.assertFalse(any(event[0] == "publish" or (event[0] == "docker" and event[1] == "stop")
                             for event in trace))
        self.assertFalse(any("recreate-claim.json" in key for key in
                             context["original_request_context"]["control"].files))

    def test_stop_and_remove_outcomes_unknown_never_advance_or_replay(self):
        context, trace = _context()
        sequence = [
            (("stop", context["plan"]["failed"]["frontend_container_id"]), False, False),
            (("stop", context["plan"]["failed"]["backend_container_id"]), False, False),
            ("rm", False, False),
        ]
        for fail_action, _unused_one, _unused_two in sequence:
            with self.subTest(fail_action=fail_action):
                context, trace = _context()
                with self.assertRaisesRegex(RuntimeError, "unknown"):
                    self._run_apply(context, fail_action=fail_action)
                self.assertIn("held-ui-start-retry/" + context["plan"]["failed"]["attempt"]
                              + "/recreate-claim.json", context["original_request_context"]["control"].files)
                self.assertFalse(any(event[0] in {"archive", "start"} for event in trace))
                if isinstance(fail_action, tuple) and fail_action[0] == "stop" and fail_action[1] == context["plan"]["failed"]["frontend_container_id"]:
                    self.assertFalse(any(event[0] == "docker" and event[1] == "rm" for event in trace))
                if isinstance(fail_action, tuple) and fail_action[0] == "stop" and fail_action[1] == context["plan"]["failed"]["backend_container_id"]:
                    self.assertFalse(any(event[0] == "docker" and event[1] == "rm" for event in trace))

    def test_changed_released_snapshot_after_stop_refuses_before_remove(self):
        context, trace = _context()
        drifted = {**context["released_snapshot"], "reservations": [["changed"]]}
        with self.assertRaisesRegex(docker_build_control.BuildControlError, "changed after stop"):
            self._run_apply(context, released_side_effect=drifted)
        self.assertTrue(any(event[0] == "docker" and event[1] == "stop" for event in trace))
        self.assertFalse(any(event[0] == "docker" and event[1] == "rm" for event in trace))
        self.assertFalse(any(event[0] in {"archive", "start"} for event in trace))

    def test_changed_stopped_store_proof_refuses_before_remove(self):
        context, trace = _context()
        with self.assertRaisesRegex(docker_build_control.BuildControlError, "store snapshot changed"):
            self._run_apply(context, stopped_observer_error="store snapshot changed after stop")
        self.assertTrue(any(event[0] == "docker" and event[1] == "stop"
                            and event[-1] == context["plan"]["failed"]["backend_container_id"]
                            for event in trace))
        self.assertFalse(any(event[0] == "docker" and event[1] == "rm" for event in trace))
        self.assertFalse(any(event[0] in {"archive", "start"} for event in trace))

    def test_archive_and_copy_failures_retain_claim_and_never_start(self):
        for failure in ("archive", "copy"):
            with self.subTest(failure=failure):
                context, trace = _context()
                kwargs = {"archive_error": True} if failure == "archive" else {"copy_error": True}
                with self.assertRaises((RuntimeError, docker_build_control.BuildControlError)):
                    self._run_apply(context, **kwargs)
                claim = "held-ui-start-retry/" + context["plan"]["failed"]["attempt"] + "/recreate-claim.json"
                self.assertIn(claim, context["original_request_context"]["control"].files)
                self.assertFalse(any(event[0] == "start" for event in trace))

    def test_success_starts_once_with_same_state_and_typed_retry_context(self):
        context, trace = _context()
        args, result = self._run_apply(context)
        starts = [event for event in trace if event[0] == "start"]
        self.assertEqual(len(starts), 1)
        call_args, kwargs = starts[0][1], starts[0][2]
        self.assertEqual(kwargs["reuse_state"]["state"], context["original_request_context"]["state"])
        self.assertEqual(kwargs["reuse_state"]["frontend_start_handoff"], context["plan"]["frontend_handoff"])
        self.assertIs(kwargs["failed_held_ui_start_context"]["original_request_context"],
                      context["original_request_context"])
        self.assertEqual(kwargs["failed_held_ui_start_context"]["retry_attempt"], "c" * 32)
        self.assertEqual(result, {"state": "restored"})


class HeldRetryStartAndArchiveFenceTests(unittest.TestCase):
    def test_existing_start_claim_refuses_before_republication(self):
        context, trace = _context()
        control = context["original_request_context"]["control"]
        ref = lifecycle.reference(context)
        path = "held-ui-start-retry/" + context["plan"]["failed"]["attempt"] + "/start-claim.json"
        control.files[path] = b"already claimed\n"
        operation = {"receipt": {"attempt": "d" * 32}}
        with patch.object(lifecycle, "validate_start_context", return_value=context), \
             patch("docker_volume_pre_ack_retry._publish_raw") as publish:
            with self.assertRaisesRegex(docker_build_control.BuildControlError, "claim exists"):
                lifecycle.before_start(
                    types.SimpleNamespace(attempt=context["plan"]["original"]["attempt"],
                                          config_sha256=context["plan"]["original"]["config_sha256"],
                                          request_id=context["plan"]["original"]["request_id"],
                                          run_id=context["plan"]["original"]["run_id"],
                                          expected_plan_sha256=context["plan"]["original"]["plan_sha256"]),
                    context, control, operation,
                    {"state": context["original_request_context"]["state"],
                     "frontend_start_handoff": context["plan"]["frontend_handoff"]},
                )
        publish.assert_not_called()

    def test_archive_handoff_binds_plan_claim_and_stopped_proof(self):
        context, _trace = _context()
        control = context["original_request_context"]["control"]
        ref = lifecycle.reference(context)
        root = "held-ui-start-retry/" + context["plan"]["failed"]["attempt"]
        control.files[ref["plan_path"]] = docker_build_control.canonical(context["plan"]) + b"\n"
        claim = {**ref, "schema": "fullmag.held-ui-start-retry-recreate-claim.v1",
                 "recreate_attempt": "c" * 32}
        control.files[root + "/recreate-claim.json"] = docker_build_control.canonical(claim) + b"\n"
        stopped = {"schema": "fullmag.held-ui-start-retry-stopped.v1",
                   "state": "stopped-no-execution", "plan_sha256": context["plan_sha256"]}
        operation_root = "recreate-services/attempts/" + "c" * 32
        control.files[operation_root + "/retry-stopped-proof.json"] = docker_build_control.canonical(stopped) + b"\n"
        operation = {"root": operation_root, "receipt": {
            "attempt": "c" * 32, "fresh_state": False,
            "inputs": {"failed_held_ui_start": ref},
            "previous_state_root": context["plan"]["namespace"]["state_root"],
            "retry_stopped_proof_sha256": _sha(docker_build_control.canonical(stopped) + b"\n"),
        }}
        self.assertTrue(lifecycle.validate_archive_handoff(control, operation, context))
        bad = copy.deepcopy(operation)
        bad["receipt"]["inputs"]["failed_held_ui_start"]["plan_sha256"] = "f" * 64
        with self.assertRaises(docker_build_control.BuildControlError):
            lifecycle.validate_archive_handoff(control, bad, context)
        bad = copy.deepcopy(claim)
        bad["recreate_attempt"] = "d" * 32
        control.files[root + "/recreate-claim.json"] = docker_build_control.canonical(bad) + b"\n"
        with self.assertRaises(docker_build_control.BuildControlError):
            lifecycle.validate_archive_handoff(control, operation, context)
        control.files[root + "/recreate-claim.json"] = docker_build_control.canonical(claim) + b"\n"
        bad_stopped = {**stopped, "state": "unknown"}
        control.files[operation_root + "/retry-stopped-proof.json"] = docker_build_control.canonical(bad_stopped) + b"\n"
        operation["receipt"]["retry_stopped_proof_sha256"] = _sha(
            docker_build_control.canonical(bad_stopped) + b"\n")
        with self.assertRaises(docker_build_control.BuildControlError):
            lifecycle.validate_archive_handoff(control, operation, context)


if __name__ == "__main__":
    unittest.main()
