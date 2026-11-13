"""Connect repeated-stop observation to the retained installed proof.

Only Docker, mount identity, control bytes, and store bytes are faked. Proof
assembly and ``validate_empty_stop`` remain the production implementations.
"""
from contextlib import ExitStack
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import docker_data_volume_stopped_group as stopped_group
from scripts import test_docker_data_volume_stopped_group as stopped_fixtures
from scripts import test_terminal_observation_repeated_stop as repeated_fixtures
import docker_volume_terminal_observation as observation
import docker_volume_accepted_reattach as retained


class RepeatedStopObserverTests(unittest.TestCase):
    def setUp(self):
        self.repeated = repeated_fixtures.RepeatedTerminalStopTests()
        self.repeated.setUp()
        self.stopped = stopped_fixtures.StoppedCopySourceTests()
        self.stopped.setUp()
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-repeated-stop-")
        self.addCleanup(self.temp.cleanup)
        self._prepare_fixture()

    def _prepare_fixture(self):
        self.source = Path(self.repeated.source.scope["source_root"])
        self.project = self.repeated.source.scope["compose_project"]
        self.volume = self.repeated.source.scope["control_volume"]
        self.image = self.repeated.image
        root = Path(self.temp.name)
        self.state_root = root / "state"
        self.user_root = root / "user-data"
        self.store_root = self.state_root / "runs/docker-all/session-store"
        self.store_root.mkdir(parents=True)
        self.user_root.mkdir()
        self.roots = {"state": self.state_root, "user_data": self.user_root}
        source_rows = {}
        for role, path in self.roots.items():
            stat = path.stat()
            source_rows[role] = {
                "canonical_root": str(path), "device": stat.st_dev, "inode": stat.st_ino,
            }

        self.control = self.stopped.control
        self.control.project = self.project
        self.control.volume = self.volume
        self.control.image = self.image
        self.operation = {
            "receipt": {"phase": "data-volume-migration", "attempt": "7" * 32},
            "helper_container_id": "c" * 64,
        }
        self.control._active_operation = self.operation
        self.control._assert_live_operation_helper = mock.Mock()

        self.stopped.source = self.source
        self.stopped.roots = self.roots
        self.stopped.pins["attempt"] = self.repeated.development
        self.stopped.pins["config_sha256"] = "d" * 64
        self.stopped.pins["image_id"] = self.image
        self.stopped.pins["state_root"] = str(self.state_root)
        self.stopped.plan.update(
            source_root=str(self.source), compose_project=self.project,
            volume_id=self.repeated.source.scope["control_volume"],
        )
        self.stopped.plan["runtime_pins"] = self.stopped.pins
        self.stopped.plan["observation"]["datasets"] = source_rows
        for actual in self.stopped.actuals:
            labels = actual.setdefault("Config", {}).setdefault("Labels", {})
            labels["com.docker.compose.project"] = self.project
            for mount in actual.get("Mounts", []):
                if mount.get("Destination") == "/opt/fullmag/source":
                    mount["Source"] = str(self.source)
                elif mount.get("Destination") == "/state":
                    mount["Source"] = str(self.state_root)
                elif mount.get("Destination") == "/user-data":
                    mount["Source"] = str(self.user_root)
            if actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") in {
                    "backend", "frontend"}:
                actual["Image"] = self.image
        self.stopped.plan["observation"]["services"] = {
            service: {
                "fingerprint": stopped_group.fingerprint(actual),
                "started_at": actual["State"]["StartedAt"],
            }
            for service, actual in zip(("backend", "frontend"), self.stopped.actuals[:2])
        }

        self.repeated.actual = {
            "backend": copy.deepcopy(self.stopped.actuals[0]),
            "frontend": copy.deepcopy(self.stopped.actuals[1]),
        }
        self.repeated.current["backend_container"] = self.repeated.actual["backend"]["Id"]
        self.repeated.current["inputs"]["source_root"] = str(self.source)
        self.repeated.current["inputs"]["image_id"] = self.image
        self.repeated.current["inputs"]["config_sha256"] = "d" * 64
        stop_raw = self._raw(self.repeated.actual)
        self.repeated.records[self.repeated.base + "idle-stop-containers.json"] = stop_raw
        self.repeated.current["idle_stop_containers_sha256"] = observation.sha(stop_raw)
        current_raw = self._raw(self.repeated.current)
        for relative in (self.repeated.base + "terminal.json",
                         self.repeated.base + "receipt.json",
                         "iteration/current.json"):
            self.repeated.records[relative] = current_raw
        drain_path = self.repeated.base + "backend-drain.json"
        drain = observation.decode(self.repeated.records[drain_path])
        drain["backend_container_id"] = self.repeated.actual["backend"]["Id"]
        self.repeated.records[drain_path] = self._raw(drain)
        self.stop_sha = observation.sha(current_raw)

        proof_sha = self.repeated.proof_sha
        relative = "terminal-observation/" + proof_sha
        request = {
            "schema": "fullmag.terminal-observation-request.v1",
            "proof_path": relative + "/proof.json",
            "proof_sha256": proof_sha,
        }
        request_raw = self._raw(request)
        request_sha = observation.sha(request_raw)
        self.repeated.records["runtime-control/" + relative + "/request.json"] = request_raw
        original = self.repeated.proof
        metadata = {
            "schema": observation.CONTEXT_SCHEMA,
            "proof_sha256": proof_sha,
            "request_sha256": request_sha,
            "stop_attempt": original["original_iteration"],
            "stop_sha256": original["operation_sha256"],
        }
        parent = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development", "state": "succeeded",
            "attempt": self.repeated.development,
            "compose_project": self.project, "control_volume": self.volume,
            "config_sha256": "d" * 64,
            "inputs": {"source_root": str(self.source), "image_id": self.image,
                       "config_sha256": "d" * 64},
            "terminal_observation": metadata,
        }
        self.repeated.records[
            "development/attempts/" + self.repeated.development + "/terminal.json"
        ] = self._raw(parent)

    @staticmethod
    def _raw(value):
        return observation.canonical(value) + b"\n"

    def _read_control(self, _control, relative, *, optional=False, **_kwargs):
        try:
            return self.repeated.records[relative]
        except KeyError:
            if optional:
                return None
            raise

    def _read_store(self, _store_root, relative, *_args, **_kwargs):
        return self.repeated.source.store[relative]

    def _docker(self, *argv, **_kwargs):
        if argv[0] == "ps":
            ids = [actual["Id"] for actual in self.stopped.actuals]
            return SimpleNamespace(stdout=("\n".join(ids) + "\n").encode())
        if argv[0] == "inspect":
            return SimpleNamespace(stdout=json.dumps(self.stopped.actuals).encode())
        raise AssertionError("Unexpected Docker observation: " + repr(argv))

    def _patch_observation_boundaries(self):
        stack = ExitStack()
        stack.enter_context(mock.patch.object(stopped_group, "docker_capture", side_effect=self._docker))
        stack.enter_context(mock.patch.object(
            stopped_group, "_migration_bind_identity",
            side_effect=lambda value, *_args: (Path(value), None),
        ))
        stack.enter_context(mock.patch.object(stopped_group, "_control_bytes", side_effect=self._read_control))
        stack.enter_context(mock.patch.object(retained, "_read_store_regular", side_effect=self._read_store))
        return stack

    def _observe(self, *, stop_sha=None):
        with self._patch_observation_boundaries():
            return stopped_group.observe_stopped_group(
                self.control, self.source, self.stopped.plan,
                self.repeated.token, self.stop_sha if stop_sha is None else stop_sha,
            )

    def _parent_path(self):
        return "development/attempts/" + self.repeated.development + "/terminal.json"

    def _rewrite_current_stop_preflight(self, mutate):
        preflight_path = self.repeated.base + "terminal-session-preflight.json"
        preflight = observation.decode(self.repeated.records[preflight_path])
        mutate(preflight)
        self.repeated.records[preflight_path] = self._raw(preflight)
        current = observation.decode(self.repeated.records[self.repeated.base + "terminal.json"])
        current["terminal_session_preflight_sha256"] = observation.sha(observation.canonical(preflight))
        current_raw = self._raw(current)
        for relative in (self.repeated.base + "terminal.json",
                         self.repeated.base + "receipt.json", "iteration/current.json"):
            self.repeated.records[relative] = current_raw
        self.repeated.current = current
        self.stop_sha = observation.sha(current_raw)

    def test_fresh_ordinary_stop_reuses_installed_proof_and_returns_new_process_receipt(self):
        with self._patch_observation_boundaries():
            result = stopped_group.observe_stopped_group(
                self.control, self.source, self.stopped.plan,
                self.repeated.token, self.stop_sha,
            )
        current = self.repeated.current
        drain = observation.decode(
            self.repeated.records[self.repeated.base + "backend-drain.json"]
        )
        self.assertEqual(result["source_proof"], self.repeated.proof)
        self.assertEqual(result["process_receipt_sha256"], drain["process_receipt_sha256"])
        self.assertNotEqual(result["source_proof"]["operation_sha256"], self.stop_sha)
        self.assertEqual(current["attempt"], self.repeated.token)

    def test_changed_stop_digest_is_rejected_before_reusing_retained_proof(self):
        with self.assertRaises(ValueError):
            self._observe(stop_sha="0" * 64)

    def test_retained_parent_source_group_and_config_drift_are_rejected(self):
        baseline = copy.deepcopy(self.repeated.records)
        mutations = (
            ("source", lambda parent: parent["inputs"].update(source_root="/foreign/source")),
            ("group", lambda parent: parent.update(compose_project="foreign-compose")),
            ("config", lambda parent: parent.update(config_sha256="e" * 64)),
        )
        for label, mutate in mutations:
            with self.subTest(parent_field=label):
                self.repeated.records = copy.deepcopy(baseline)
                parent = observation.decode(self.repeated.records[self._parent_path()])
                mutate(parent)
                self.repeated.records[self._parent_path()] = self._raw(parent)
                with self.assertRaises((ValueError, KeyError)):
                    self._observe()

    def test_retained_proof_request_and_proof_bytes_remain_pinned(self):
        baseline = copy.deepcopy(self.repeated.records)
        path = self._parent_path()
        request_path = "runtime-control/terminal-observation/" + self.repeated.proof_sha + "/request.json"
        proof_path = "runtime-control/terminal-observation/" + self.repeated.proof_sha + "/proof.json"
        mutations = (
            ("proof_sha", lambda parent: parent["terminal_observation"].update(proof_sha256="e" * 64)),
            ("request_sha", lambda parent: parent["terminal_observation"].update(request_sha256="f" * 64)),
            ("request_bytes", None),
            ("proof_bytes", None),
        )
        for label, mutate in mutations:
            with self.subTest(pin=label):
                self.repeated.records = copy.deepcopy(baseline)
                if label == "request_bytes":
                    self.repeated.records[request_path] += b" "
                elif mutate is None:
                    self.repeated.records[proof_path] += b" "
                else:
                    parent = observation.decode(self.repeated.records[path])
                    mutate(parent)
                    self.repeated.records[path] = self._raw(parent)
                with self.assertRaises((ValueError, KeyError)):
                    self._observe()

    def test_current_native_owner_configuration_and_queue_drift_are_rejected(self):
        baseline = copy.deepcopy(self.repeated.records)
        native_paths = (
            "runtime-control/runtime-services/OWNER.json",
            "runtime-control/runtime-service/docker-all.json",
        )
        for path in native_paths:
            with self.subTest(native_path=path):
                self.repeated.records = copy.deepcopy(baseline)
                self.repeated.records[path] = self._raw({"foreign": True})
                with self.assertRaises((ValueError, KeyError)):
                    self._observe()

        self.repeated.records = copy.deepcopy(baseline)
        self._rewrite_current_stop_preflight(
            lambda preflight: preflight["compute_queue"].update(
                items=[{"state": "accepted", "run_id": "foreign-run"}],
            )
        )
        with self.assertRaises(ValueError):
            self._observe()


if __name__ == "__main__":
    unittest.main()
