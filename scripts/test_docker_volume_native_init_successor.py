"""Observe-only successor regressions; Docker/control I/O is replaced in memory."""
from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_dev
import docker_volume_dev as dev
import docker_volume_native_init_successor as successor
from docker_build_control import BuildControlError, canonical

PROJECT = "fullmag-worktree-init-successor"
IMAGE, BACKEND, ORIGINAL = "sha256:" + "a" * 64, "b" * 64, "c" * 64
ATTEMPT, PARENT, RECREATE = "1" * 32, "2" * 32, "3" * 32
START, END = "2026-10-23T01:00:00.000000000Z", "2026-10-23T01:00:02.000000000Z"
STAMP = "2026-10-23T01:00:01.000000000Z "
TRACE = [
    "Traceback (most recent call last):",
    '  File "/opt/fullmag/entrypoint.py", line 521, in serve',
    '  File "/opt/fullmag/runtime_service.py", line 1421, in ensure_configuration',
    '  File "/opt/fullmag/runtime_service.py", line 932, in initialize_host_configuration',
    "runtime_service.RuntimeServiceError: native Docker host profile initialization failed: " + successor.POLICY_ERROR,
]


def streams(lines=TRACE):
    return {"stdout": b"", "stderr": "".join(STAMP + line + "\n" for line in lines).encode()}


class Fixture:
    def __init__(self):
        self.control = SimpleNamespace(project=PROJECT, volume=PROJECT + "-control",
            identity={"project_id": "project", "worktree_id": "worktree", "checkout_kind": "worktree",
                      "source_root": "/home/test/git/fullmag/worktrees/worktree"},
            write=Mock(side_effect=AssertionError("observation must not write")))
        native = {"schema": dev._NATIVE_STOP_RECREATE_METADATA_SCHEMA,
            "failure_kind": "native-after-ready-failure", "container_id": ORIGINAL, "claim_pending": False}
        common = {"source_root": "/home/test/git/fullmag/worktrees/worktree", "source_project_id": "project",
            "source_worktree_id": "worktree", "source_checkout_kind": "worktree", "image_id": IMAGE,
            "gpu_access_requested": "auto", "native_failed_restart": native}
        self.previous = {"schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "attempt": ATTEMPT, "state": "failed-confirmed", "compose_project": PROJECT,
            "control_volume": self.control.volume, "started_at": 20, "finished_at": 30,
            "backend_started_at": START, "backend_container": BACKEND, "state_root": "/state/session",
            "backend_volumes": ["build", "package"], "frontend_volume": "frontend",
            "inputs": {**deepcopy(common), "device_access": "cpu", "gpu_preflight": "NOT_REQUIRED",
                       "previous_config_sha256": "d" * 64}}
        probes = dict(docker_dev.OPERATOR_PROBE_ENVIRONMENT_DEFAULTS)
        probe_sha = docker_dev._operator_probe_environment_sha256(probes)
        environment = {**probes, "FULLMAG_DOCKER_DEVICE_ACCESS": "cpu",
            "FULLMAG_OPERATOR_PROBE_ENVIRONMENT_SHA256": probe_sha,
            "FULLMAG_DEVELOPMENT_INPUTS_PATH": "/opt/fullmag/control/frontend/development-inputs.json"}
        self.document = {"name": PROJECT, "services": {
            "backend": {"environment": environment, "volumes": []},
            "frontend": {"environment": {"FULLMAG_DEVELOPMENT_INPUTS_PATH": "/opt/fullmag/control/development-inputs.json"},
                         "volumes": [{"source": "build-control", "target": "/opt/fullmag/control",
                                      "volume": {"subpath": "frontend"}}]}}}
        self.parent_compose = deepcopy(self.document)
        self.parent_compose["services"]["backend"]["environment"]["FULLMAG_DOCKER_DEVICE_ACCESS"] = "gpu"
        self.parent_compose["services"]["backend"]["gpus"] = "all"
        self.parent = {**deepcopy(self.previous), "attempt": PARENT, "inputs": {
            **common, "device_access": "gpu", "gpu_preflight": "PASS"},
            "operator_probe_environment_schema": docker_dev.OPERATOR_PROBE_ENVIRONMENT_SCHEMA,
            "operator_probe_environment": probes, "operator_probe_environment_sha256": probe_sha}
        self.recreation = {"attempt": RECREATE, "finished_at": 10, "inputs": {"attempt": PARENT,
            "config_sha256": hashlib.sha256(canonical(self.parent_compose)).hexdigest()}}
        self.records = {"development/current.json": self.previous,
            f"development/attempts/{ATTEMPT}/terminal.json": self.previous,
            f"development/attempts/{ATTEMPT}/compose.json": self.document,
            "recreate-services/current.json": self.recreation,
            f"recreate-services/attempts/{RECREATE}/terminal.json": self.recreation,
            f"development/attempts/{PARENT}/terminal.json": self.parent,
            f"development/attempts/{PARENT}/compose.json": self.parent_compose,
            f"recreate-services/attempts/{RECREATE}/retained-containers.json": {"backend": ORIGINAL}}
        labels = {"com.docker.compose.project": PROJECT, "com.docker.compose.service": "backend",
            "org.fullmag.source.project-id": "project", "org.fullmag.source.worktree-id": "worktree",
            "org.fullmag.source.checkout-kind": "worktree"}
        self.actual = {"Id": BACKEND, "Image": IMAGE, "RestartCount": 0,
            "State": {"Running": False, "Status": "exited", "Pid": 0, "ExitCode": 1,
                      "OOMKilled": False, "StartedAt": START, "FinishedAt": END, "Error": ""},
            "HostConfig": {"PidMode": "", "ReadonlyRootfs": True, "Privileged": False},
            "Config": {"Labels": labels, "Env": [key + "=" + value for key, value in environment.items()]}, "Mounts": []}
        self.context = {"native_restart_metadata": deepcopy(native), "previous_config_sha256": "d" * 64,
                        "retained_extra": {"unchanged": True}}
        self.proof, self.released = {"container_id": ORIGINAL}, {"active_count": 0}
        self.raw_overrides, self.logs, self.unresolved = {}, streams(), None
        self.validator = Mock(side_effect=lambda *_a, **_k: (None, self.proof, self.context))

    def read(self, _control, path, _label):
        value = self.records[path]
        return self.raw_overrides.get(path, canonical(value)), deepcopy(value)

    def invoke(self, **kwargs):
        def docker_text(*args):
            if args == ("inspect", BACKEND): return json.dumps([self.actual])
            if args == ("image", "inspect", IMAGE): return json.dumps([{"Id": IMAGE, "Config": {}}])
            raise AssertionError(args)
        with ExitStack() as stack:
            stack.enter_context(patch.object(dev, "_read_canonical_control_record", side_effect=self.read))
            stack.enter_context(patch.object(dev, "_validate_removed_recreation_proof", self.validator))
            stack.enter_context(patch.object(dev, "docker_text", side_effect=docker_text))
            stack.enter_context(patch("docker_volume_stop_unadmitted._control_bytes", side_effect=lambda *_a, **_k: self.unresolved))
            stack.enter_context(patch("docker_volume_pre_ack_retry._released_snapshot", side_effect=lambda *_a: self.released))
            stack.enter_context(patch.object(successor, "docker_capture", return_value=subprocess.CompletedProcess(
                [], 0, self.logs["stdout"], self.logs["stderr"])))
            return successor.retained_context(self.control, self.previous, self.document,
                kwargs.pop("backend_id", BACKEND), fresh_state=kwargs.pop("fresh_state", False), **kwargs)


class NativeInitSuccessorTests(unittest.TestCase):
    def test_exact_trace_preserves_bytes_including_timestamped_trailing_blank(self):
        log = streams(TRACE + ["", "   "])
        self.assertEqual(successor.validate_log_streams(log, {"started_at": START, "finished_at": END}), log)

    def test_wrong_trace_handoff_order_duplicates_and_timestamp_are_refused(self):
        cases = [TRACE[:-1] + ["native-after-ready-failure"],
            TRACE + ["API ready"], ["[fullmag-backend] Starting API and runtime service"] + TRACE,
            [TRACE[0], TRACE[2], TRACE[1], *TRACE[3:]],
            [line.replace("entrypoint.py", "other.py") for line in TRACE],
            TRACE + TRACE]
        for lines in cases:
            with self.subTest(lines=lines), self.assertRaises(BuildControlError):
                successor.validate_log_streams(streams(lines), {"started_at": START, "finished_at": END})
        split = streams()
        split["stdout"] = streams()["stderr"]
        with self.assertRaises(BuildControlError):
            successor.validate_log_streams(split, {"started_at": START, "finished_at": END})
        for raw in [streams()["stderr"].replace(STAMP.encode(), b""),
                    streams()["stderr"].replace(b"01:00:01", b"01:00:03")]:
            with self.subTest(raw=raw), self.assertRaises(BuildControlError):
                successor.validate_log_streams({"stdout": b"", "stderr": raw}, {"started_at": START, "finished_at": END})

    def test_real_constructor_keeps_original_context_and_removed_proof(self):
        f = Fixture()
        before = deepcopy((f.records, f.context, f.proof, f.actual))
        result = f.invoke()
        self.assertIsInstance(result, successor.NativeInitSuccessorContext)
        self.assertEqual(dict(result), f.context)
        self.assertEqual(result.target_device_access, "gpu")
        self.assertEqual(result.witness["observed_device_access"], "cpu")
        self.assertIs(result.witness["removed_predecessor"], f.proof)
        self.assertEqual(result.witness["original_native_restart"], f.context["native_restart_metadata"])
        self.assertEqual(result.witness["successor_terminal_sha256"], hashlib.sha256(canonical(f.previous)).hexdigest())
        args, kwargs = f.validator.call_args
        self.assertEqual(args[2:5], (f.parent, f.parent_compose, {key: f.control.identity[key]
                         for key in ("project_id", "worktree_id", "checkout_kind")}))
        self.assertEqual(kwargs["previous_raw"], canonical(f.parent))
        self.assertEqual(kwargs["retained_raw"], canonical(f.records[f"recreate-services/attempts/{RECREATE}/retained-containers.json"]))
        self.assertEqual((f.records, f.context, f.proof, f.actual), before)
        f.control.write.assert_not_called()

    def test_original_container_and_unrelated_failure_do_not_claim_successor_authority(self):
        f = Fixture()
        self.assertIsNone(f.invoke(backend_id=ORIGINAL))
        f.previous["inputs"]["native_failed_restart"]["failure_kind"] = "other"
        self.assertIsNone(f.invoke())
        f.validator.assert_not_called()
        f.control.write.assert_not_called()

    def test_state_namespace_profile_source_and_cas_mutations_are_refused_without_writes(self):
        mutations = [
            ("previous", ("state",), "ready"), ("previous", ("inputs", "source_worktree_id"), "other"),
            ("previous", ("inputs", "device_access"), "gpu"),
            ("previous", ("inputs", "source_root"), "/other"),
            ("previous", ("inputs", "native_failed_restart", "claim_pending"), True),
            ("previous", ("inputs", "previous_config_sha256"), "e" * 64),
            ("previous", ("inputs", "accepted_reattach"), {}),
            ("document", ("services", "backend", "environment", "FULLMAG_STARTUP_ENABLED"), "1"),
            ("parent", ("inputs", "source_root"), "/other"),
            ("parent", ("operator_probe_environment_sha256",), "0" * 64),
            ("parent", ("inputs", "device_access"), "cpu"), ("parent", ("state_root",), "/other"),
            ("recreation", ("finished_at",), 40), ("recreation", ("inputs", "config_sha256"), "0" * 64),
            ("context", ("native_restart_metadata", "container_id"), "e" * 64),
            ("proof", ("container_id",), "e" * 64), ("released", ("active_count",), 1),
            ("actual", ("State", "Running"), True), ("actual", ("State", "ExitCode"), 2),
            ("actual", ("State", "Pid"), 42), ("actual", ("State", "OOMKilled"), True),
            ("actual", ("RestartCount",), 1), ("actual", ("RestartCount",), True),
            ("actual", ("State", "Error"), "lifecycle error"), ("actual", ("HostConfig", "PidMode"), "host"),
            ("actual", ("Config", "Labels", "org.fullmag.source.worktree-id"), "other"),
            ("actual", ("Config", "Env"), []), ("actual", ("HostConfig", "ReadonlyRootfs"), False)]
        for owner, path, value in mutations:
            with self.subTest(owner=owner, path=path):
                f = Fixture(); target = getattr(f, owner)
                for key in path[:-1]: target = target[key]
                target[path[-1]] = value
                before = deepcopy((f.records, f.context, f.proof, f.actual))
                with self.assertRaises(BuildControlError): f.invoke()
                self.assertEqual((f.records, f.context, f.proof, f.actual), before)
                f.control.write.assert_not_called()
        for path in ["development/current.json", f"development/attempts/{ATTEMPT}/compose.json",
                     f"recreate-services/attempts/{RECREATE}/terminal.json"]:
            f = Fixture(); f.records[path] = {"tampered": True}
            with self.subTest(path=path), self.assertRaises(BuildControlError): f.invoke()
        f = Fixture(); f.raw_overrides["development/current.json"] = canonical(f.previous) + b"\n"
        with self.assertRaises(BuildControlError): f.invoke()

    def test_unresolved_activation_and_modified_logs_are_refused_without_writes(self):
        for mutate in [lambda f: setattr(f, "unresolved", b"{}"),
                       lambda f: setattr(f, "logs", streams(TRACE + ["API ready"]))]:
            f = Fixture(); mutate(f)
            with self.assertRaises(BuildControlError): f.invoke()
            f.control.write.assert_not_called()

    def test_replacement_authority_requires_retained_state_and_no_removal_proof(self):
        for kwargs in [{"fresh_state": True}, {"removed_container_proof": {"container_id": BACKEND}}]:
            f = Fixture()
            with self.subTest(kwargs=kwargs), self.assertRaises(BuildControlError): f.invoke(**kwargs)
            f.control.write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
