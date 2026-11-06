"""Docker-free preview/apply tests for the qualified bootstrap frontend stop."""
from __future__ import annotations

from contextlib import contextmanager
import copy
import hashlib
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from docker_build_control import BuildControlError, canonical
import docker_volume_bootstrap_frontend_stop as frontend_stop
import docker_volume_stop_bootstrap as bootstrap_stop


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def snapshot(*, frontend_running: bool) -> dict[str, object]:
    plan = {
        "schema": frontend_stop.PLAN_SCHEMA,
        "engine_id": "engine-1",
        "native_evidence_sha256": {"owner": "a" * 64, "config": "b" * 64},
        "service_fingerprints": {
            "backend": {"started_at": "backend-start", "config_mount_sha256": "c" * 64},
            "frontend": {"started_at": "frontend-start", "config_mount_sha256": "d" * 64},
        },
        "backend_container_id": "1" * 64,
        "frontend_container_id": "2" * 64,
        "frontend_started_at": "frontend-start",
        "bootstrap_stop": {"attempt": "3" * 32, "sha256": "4" * 64},
        "development_attempt": "5" * 32,
    }
    return {
        "plan": plan,
        "plan_sha256": sha(canonical(plan)),
        "ids": {"backend": "1" * 64, "frontend": "2" * 64},
        "backend": {"Id": "1" * 64},
        "frontend": {"Id": "2" * 64},
        "frontend_running": frontend_running,
        "owner_sha256": plan["native_evidence_sha256"]["owner"],
    }


def args(*, apply: bool, expected: str | None = None):
    return SimpleNamespace(
        repo_root="/repo",
        source_root="/selected",
        attempt="5" * 32,
        config_sha256="6" * 64,
        port=3197,
        bootstrap_stop_attempt="3" * 32,
        bootstrap_stop_sha256="4" * 64,
        apply=apply,
        expected_plan_sha256=expected,
    )


class FakeControl:
    project = "fullmag-worktree-sp4"
    volume = "fullmag-control-sp4"
    namespace = "groups/sp4"
    helper_id = "f" * 64

    def __init__(self, events=None):
        self.events = events if events is not None else []
        self.files = {}
        self.operation_count = 0
        self.last_operation = None
        self.prepare_count = 0
        self.identity = {"project_name": self.project, "worktree_id": "sp4", "project_id": "fullmag"}
        self.shared_labels = {"com.fullmag.compose.project": self.project}

    def prepare(self):
        self.prepare_count += 1
        self.events.append(("prepare",))

    def read_bytes(self, relative, *, optional=False, **_kwargs):
        raw = self.files.get(relative)
        if raw is None and not optional:
            raise BuildControlError("missing fake control record")
        return raw

    def _pin_operation_helper(self, operation):
        self.events.append(("pin-helper", operation["receipt"]["phase"]))
        return self.helper_id

    def _assert_live_operation_helper(self, operation):
        self.events.append(("live-helper", operation["receipt"]["phase"]))
        return self.helper_id

    @contextmanager
    def operation(self, phase, inputs):
        self.operation_count += 1
        operation = {
            "receipt": {"phase": phase, "inputs": inputs, "state": "starting"},
            "root": phase + "/attempts/" + "e" * 32,
            "daemon_pending": False,
        }
        self.last_operation = operation
        try:
            yield operation
        except BaseException:
            operation["receipt"]["state"] = (
                "outcome-unknown-resources-retained" if operation["daemon_pending"] else "failed-confirmed"
            )
            raise


@contextmanager
def fake_run_environment(control, observed, events, docker_capture=None):
    ids = {"backend": "1" * 64, "frontend": "2" * 64}
    def consumers(_identity):
        return set(ids.values()) | ({control.helper_id} if control.operation_count else set())

    def publish(target, path, raw):
        events.append(("intent", path, raw))
        target.files[path] = raw

    def capture(*command, **kwargs):
        events.append(("docker", command, kwargs))
        if docker_capture is not None:
            return docker_capture(*command, **kwargs)
        return SimpleNamespace(stdout=b"", returncode=0)

    with patch.object(frontend_stop, "_build_context",
                      return_value=(SimpleNamespace(as_posix=lambda: "/selected"), control.identity, control)), \
         patch.object(frontend_stop, "_observe", side_effect=observed), \
         patch.object(frontend_stop, "_publish_intent", side_effect=publish), \
         patch.object(frontend_stop, "docker_capture", side_effect=capture) as docker_mock, \
         patch("docker_volume_unclaimed_cancellation._project_container_ids", side_effect=consumers), \
         patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", side_effect=consumers):
        yield docker_mock


class BootstrapFrontendStopTests(unittest.TestCase):
    def test_preview_returns_stable_plan_without_operation_write_or_signal(self):
        control, events = FakeControl(), []
        observed = snapshot(frontend_running=True)
        with fake_run_environment(control, [observed], events) as docker:
            result = frontend_stop.run(args(apply=False))

        self.assertEqual(result["state"], "preview")
        self.assertEqual(result["expected_plan_sha256"], sha(canonical(observed["plan"])))
        self.assertEqual(result["plan"], observed["plan"])
        self.assertEqual(control.operation_count, 0)
        self.assertEqual(control.prepare_count, 0)
        self.assertEqual(control.files, {})
        self.assertEqual(events, [])
        docker.assert_not_called()

    def test_apply_publishes_immutable_intent_before_graceful_stop_of_exact_frontend(self):
        events = []
        control = FakeControl(events)
        before, after = snapshot(frontend_running=True), snapshot(frontend_running=False)

        def observe(*_args):
            result = (before, before, before, after)[len([event for event in events if event[0] == "observe"])]
            events.append(("observe", result["frontend_running"]))
            return result

        def docker(*command, **_kwargs):
            self.assertTrue(any(event[0] == "intent" for event in events))
            self.assertEqual(command, ("stop", "--signal", "SIGTERM", "--time", "-1", "2" * 64))
            return SimpleNamespace(stdout=b"", returncode=0)

        with fake_run_environment(control, observe, events, docker_capture=docker):
            result = frontend_stop.run(args(apply=True, expected=before["plan_sha256"]))

        labels = [event[0] for event in events]
        self.assertEqual(labels.count("observe"), 4)
        self.assertLess(labels.index("observe"), labels.index("prepare"))
        self.assertLess(labels.index("prepare"), labels.index("intent"))
        self.assertLess(labels.index("intent"), labels.index("docker"))
        intent_event = next(event for event in events if event[0] == "intent")
        intent = json.loads(intent_event[2])
        self.assertEqual(intent["state"], "intent-written-before-signal")
        self.assertEqual(intent["frontend_container_id"], "2" * 64)
        self.assertEqual(control.files[intent_event[1]], intent_event[2])
        self.assertEqual(result["state"], "stopped-confirmed")
        self.assertFalse(result["native_drain_claimed"])
        self.assertFalse(result["solve_replayed"])
        self.assertFalse(result["new_session_store_created"])
        self.assertEqual(control.last_operation["receipt"]["state"], "succeeded")
        self.assertEqual(control.prepare_count, 1)
        self.assertFalse(control.last_operation["daemon_pending"])

    def test_apply_refuses_changed_backend_owner_frontend_or_engine_fingerprint(self):
        baseline = snapshot(frontend_running=True)
        mutations = (
            ("backend", lambda plan: plan["service_fingerprints"]["backend"].update(started_at="replaced")),
            ("owner", lambda plan: plan["native_evidence_sha256"].update(owner="9" * 64)),
            ("frontend", lambda plan: plan["service_fingerprints"]["frontend"].update(config_mount_sha256="8" * 64)),
            ("engine", lambda plan: plan.update(engine_id="another-engine")),
        )
        for label, mutate in mutations:
            with self.subTest(changed=label):
                control, events = FakeControl(), []
                changed = copy.deepcopy(baseline)
                mutate(changed["plan"])
                changed["plan_sha256"] = sha(canonical(changed["plan"]))
                with fake_run_environment(control, [changed], events):
                    with self.assertRaises(BuildControlError):
                        frontend_stop.run(args(apply=True, expected=baseline["plan_sha256"]))
                self.assertFalse(any(event[0] == "intent" for event in events))
                self.assertFalse(any(event[0] == "docker" for event in events))
                self.assertEqual(control.operation_count, 0)
                self.assertEqual(control.prepare_count, 0)

    def test_already_stopped_frontend_is_reobserved_and_never_signaled_again(self):
        control, events = FakeControl(), []
        before, after = snapshot(frontend_running=False), snapshot(frontend_running=False)
        observations = iter((before, before, before, after))

        def observe(*_args):
            result = next(observations)
            events.append(("observe", result["frontend_running"]))
            return result

        with fake_run_environment(control, observe, events) as docker:
            result = frontend_stop.run(args(apply=True, expected=before["plan_sha256"]))

        self.assertEqual(result["state"], "already-stopped-confirmed")
        self.assertEqual(sum(event[0] == "observe" for event in events), 4)
        self.assertFalse(any(event[0] == "docker" for event in events))
        docker.assert_not_called()

    def test_uncertain_stop_keeps_operation_unknown_and_returns_no_success(self):
        control, events = FakeControl(), []
        before = snapshot(frontend_running=True)
        observations = iter((before, before, before))

        def observe(*_args):
            result = next(observations)
            events.append(("observe", result["frontend_running"]))
            return result

        def timeout(*_command, **_kwargs):
            raise TimeoutError("docker stop result was not observed")

        with fake_run_environment(control, observe, events, docker_capture=timeout):
            with self.assertRaises(TimeoutError):
                frontend_stop.run(args(apply=True, expected=before["plan_sha256"]))

        self.assertTrue(control.last_operation["daemon_pending"])
        self.assertEqual(control.last_operation["receipt"]["state"], "outcome-unknown-resources-retained")
        self.assertEqual(sum(event[0] == "observe" for event in events), 3)

    def test_missing_control_volume_is_refused_before_any_helper_read_or_prepare(self):
        control = FakeControl()
        docker_commands = []

        def docker(*command, **_kwargs):
            docker_commands.append(command)
            if command[:2] == ("volume", "inspect"):
                return SimpleNamespace(returncode=1, stdout=b"", stderr=b"missing")
            if command[:2] == ("volume", "ls"):
                return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
            raise AssertionError("missing-volume preview must not start a helper")

        identity = control.identity
        layout = SimpleNamespace()
        toolchain = {"services": {"fem-gpu-toolchain": {"build": {"args": {
            "FULLMAG_CUDA_BASE_IMAGE": "example@sha256:" + "a" * 64,
        }}}}}
        selected_args = args(apply=False)
        selected_args.repo_root = "/"
        with patch.object(frontend_stop, "require_host"), \
             patch("docker_dev._select_source", return_value=("/selected", layout)), \
             patch("docker_dev._compose_identity", return_value=identity), \
             patch.object(frontend_stop, "toolchain_configuration", return_value=toolchain), \
             patch.object(frontend_stop, "BuildControl", return_value=control), \
             patch.object(frontend_stop, "docker_capture", side_effect=docker), \
             patch.object(bootstrap_stop, "_read_raw", side_effect=AssertionError("must not probe missing volume")) as read:
            with self.assertRaises(BuildControlError):
                frontend_stop._build_context(selected_args)

        self.assertEqual(docker_commands, [
            ("volume", "inspect", control.volume),
            ("volume", "ls", "--format", "{{.Name}}"),
        ])
        self.assertEqual(control.prepare_count, 0)
        read.assert_not_called()


class BootstrapFrontendObservationTests(unittest.TestCase):
    def _observe(self, *, backend_running=False, frontend_started_at="frontend-start",
                 frontend_running=True, validation_error=None):
        args_value = args(apply=False)
        selected = "/selected"
        identity = {"project_name": "fullmag-worktree-sp4", "worktree_id": "sp4", "project_id": "fullmag"}
        control = SimpleNamespace(project="fullmag-worktree-sp4", volume="fullmag-control-sp4",
                                  namespace="groups/sp4")
        backend_id, frontend_id = "1" * 64, "2" * 64
        image = "sha256:" + "3" * 64
        network_name = "fullmag-worktree-sp4_fullmag"
        network_id = "a" * 64
        started = {"backend": "backend-start", "frontend": frontend_started_at}
        compose = {
            "name": control.project,
            "services": {"backend": {}, "frontend": {"ports": [{
                "host_ip": "127.0.0.1", "target": 8080, "protocol": "tcp",
                "mode": "ingress", "published": str(args_value.port),
            }]}},
        }
        terminal = {
            "attempt": args_value.attempt,
            "source_root": "/selected",
            "compose_project": control.project,
            "config_sha256": args_value.config_sha256,
            "backend_container_id": backend_id,
            "frontend_container_id": frontend_id,
            "image_id": image,
            "backend_started_at": started["backend"],
        }

        def record(value):
            raw = canonical(value)
            return {"raw_utf8": raw.decode(), "sha256": sha(raw), "path": "fixture"}

        evidence = {"records": {"stop": record(terminal), "compose": record(compose)}}
        for key in ("operation", "preflight", "resume", "before_process", "development", "fence"):
            evidence["records"][key] = record({"fixture": key})
        rows = []
        for name, identifier in (("backend", backend_id), ("frontend", frontend_id)):
            is_running = backend_running if name == "backend" else frontend_running
            rows.append({
                "Id": identifier,
                "Image": image,
                "RestartCount": 0,
                "Config": {"Labels": {
                    "com.docker.compose.project": control.project,
                    "com.docker.compose.service": name,
                }, "Env": [], "Hostname": "backend-host"},
                "HostConfig": {
                    "NetworkMode": network_name,
                    "PidMode": "private",
                    "IpcMode": "private",
                    "PortBindings": {},
                },
                "Mounts": [],
                "NetworkSettings": {"Networks": {network_name: {
                    "NetworkID": network_id, "Aliases": [name], "Links": None,
                }}},
                "State": {
                    "Status": "running" if is_running else "exited",
                    "Running": is_running,
                    "Paused": False,
                    "Restarting": False,
                    "OOMKilled": False,
                    "Dead": False,
                    "Pid": 123 if is_running else 0,
                    "Error": "",
                    "StartedAt": started[name],
                },
            })
        runtime_by_path = {
            "runtime-control/runtime-services/OWNER.json": b'{"host":"backend-host"}',
            "runtime-control/runtime-service/process-tree.json": b'{"process":"raw"}',
            "runtime-control/runtime-services/LAUNCH.json": b'{"launch":"raw"}',
            "runtime-control/runtime-service/docker-all.json": b'{"config":"raw"}',
        }

        def docker(*command, **_kwargs):
            if command[0] == "network" and command[1] == "ls":
                return SimpleNamespace(stdout=b"", stderr=b"", returncode=0)
            if command[0] == "network" and command[1] == "inspect":
                return SimpleNamespace(stdout=b"[]", stderr=("No such network: " + network_id).encode(), returncode=1)
            if command[0] == "inspect":
                return SimpleNamespace(stdout=json.dumps(rows).encode())
            if command[:2] == ("image", "inspect"):
                return SimpleNamespace(stdout=json.dumps([{"Id": image, "Config": {}}]).encode())
            if command[0] == "info":
                return SimpleNamespace(stdout=b"engine-1\n")
            raise AssertionError("unexpected docker command: " + repr(command))

        def compose_capture(_document, *_command, **_kwargs):
            service = _command[-1]
            return (backend_id if service == "backend" else frontend_id).encode() + b"\n"

        def validate_retained(_document, row, service, _image_config, *, expected_started_at):
            if row["State"]["StartedAt"] != expected_started_at:
                raise BuildControlError("retained service incarnation differs")

        service_validator_patch = patch("docker_volume_dev._validate_retained_service", side_effect=validate_retained)
        network_validator_patch = patch("docker_volume_stop_unadmitted._validate_network")
        network_capture_patch = patch("docker_volume_container_recovery.docker_capture", side_effect=docker)
        contexts = [
            patch.object(frontend_stop.recovery, "collect", return_value=evidence),
            patch.object(frontend_stop.recovery, "validate",
                         side_effect=validation_error or (lambda *_a, **_k: {"frontend_started_at": "frontend-start"})),
            patch.object(frontend_stop, "compose_capture", side_effect=compose_capture),
            patch.object(frontend_stop, "docker_capture", side_effect=docker),
            patch.object(bootstrap_stop, "_read_raw", side_effect=lambda _control, path, **_kw: runtime_by_path[path]),
            patch("docker_compose_identity.validate_source_labels"),
            service_validator_patch,
            network_validator_patch,
            network_capture_patch,
            patch("docker_volume_dev._assert_private_restart_network"),
        ]
        started = []
        for context in contexts:
            started.append(context)
            mock = context.start()
            if context is service_validator_patch:
                service_validator = mock
            elif context is network_validator_patch:
                network_validator = mock
            elif context is network_capture_patch:
                network_capture = mock
        self.addCleanup(lambda: [context.stop() for context in reversed(started)])
        try:
            observation = frontend_stop._observe(args_value, "/selected", identity, control)
        except BaseException:
            raise
        return observation, service_validator, network_validator, network_capture

    def test_observation_validates_both_service_configs_and_native_proof(self):
        observation, service_validator, network_validator, _network_capture = self._observe()
        self.assertEqual(observation["frontend_running"], True)
        self.assertEqual(observation["plan"]["engine_id"], "engine-1")
        self.assertEqual(service_validator.call_count, 2)
        self.assertEqual(
            [call.kwargs["expected_started_at"] for call in service_validator.call_args_list],
            ["backend-start", "frontend-start"],
        )
        network_validator.assert_called_once()

    def test_running_backend_or_frontend_incarnation_drift_is_refused(self):
        with self.assertRaises(BuildControlError):
            self._observe(backend_running=True)
        with self.assertRaises(BuildControlError):
            self._observe(frontend_started_at="different-frontend-incarnation")

    def test_stopped_pair_uses_the_stopped_network_observation(self):
        _observation, _service_validator, network_validator, network_capture = self._observe(
            frontend_running=False,
        )
        network_validator.assert_not_called()
        self.assertTrue(any(call.args[0] == "network" for call in network_capture.call_args_list))

    def test_native_or_bootstrap_proof_refusal_propagates_without_a_stop(self):
        def reject(*_args, **_kwargs):
            raise BuildControlError("native/owner proof changed")

        with self.assertRaisesRegex(BuildControlError, "native/owner proof changed"):
            self._observe(validation_error=reject)


if __name__ == "__main__":
    unittest.main()
