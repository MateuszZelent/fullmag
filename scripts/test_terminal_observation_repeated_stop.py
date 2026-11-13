"""A new managed drain may retain the original, already installed observation.

Only synthetic control/store records are used; no Docker or native calls.
"""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_volume_terminal_observation as observation
import test_docker_terminal_observation_producer as original


def raw(value):
    return observation.canonical(value) + b"\n"


class RepeatedTerminalStopTests(unittest.TestCase):
    def setUp(self):
        original.ProducerTests.setUpClass()
        self.source = original.ProducerTests()
        self.source.setUp()
        self.proof = self.source.build()
        self.records = self.source.control
        self.token, self.development = "a" * 32, "b" * 32
        self.base = "iteration/attempts/" + self.token + "/"
        self.image = "sha256:" + "8" * 64
        self.actual = {
            role: {"Id": identifier, "Image": self.image, "Config": {"role": role},
                   "Mounts": [], "State": {"StartedAt": "fresh-service", "Running": False}}
            for role, identifier in (("backend", "f" * 64), ("frontend", "9" * 64))
        }
        process = deepcopy(observation.decode(self.records[original.BASE + "backend-drain.json"])["process_receipt"])
        for state in ("service_owner", "terminal_service_owner"):
            process[state].update(owner_token="new-owner", process_start_token="new-owner-process")
        owner = process["service_owner"]
        self.api = "346dfd7e-f50e-450a-ad3e-97a42d8e2ddc"
        self.proof_sha = observation.sha(raw(self.proof))
        native = raw({"native_config": "new-generation"})
        self.native_sha = observation.sha(native)
        launch = {
            "schema": "fullmag.terminal-observation-launch.v1",
            "source_proof_sha256": self.proof_sha,
            "source_native_config_sha256": self.proof["native_config_sha256"],
            "target_build_id": owner["build_commit"], "target_source_sha256": owner["build_snapshot"],
            "target_image_id": self.image, "native_config_sha256": self.native_sha,
            "terminal_evidence_sha256": self.proof["terminal_evidence_sha256"],
        }
        launch_sha = observation.sha(raw(launch))
        installed = {
            "schema": "fullmag.terminal-observation-restored.v1", "api_instance_id": self.api,
            "run_id": self.proof["run_id"], "session_id": self.proof["session_id"],
            "session_epoch": self.proof["session_epoch"], "scene_revision": self.proof["scene_revision"],
            "terminal_outcome": "failed", "proof_sha256": self.proof_sha, "launch_sha256": launch_sha,
            "source_image_id": self.proof["image_id"], "source_config_sha256": self.proof["config_sha256"],
            **{key: launch[key] for key in ("target_build_id", "target_source_sha256", "target_image_id",
                                          "native_config_sha256", "terminal_evidence_sha256")},
        }
        installed_relative = "terminal-observation/" + self.proof_sha + "/installed-" + self.api + ".json"
        self.annotation = {
            "schema": "fullmag.terminal-observation-runtime.v1", "api_instance_id": self.api,
            "run_id": self.proof["run_id"], "session_id": self.proof["session_id"],
            "proof_sha256": self.proof_sha, "launch_sha256": launch_sha,
            "installed_relative": installed_relative, "installed_sha256": observation.sha(raw(installed)),
            **{key: launch[key] for key in ("target_build_id", "target_source_sha256", "target_image_id")},
        }
        process["terminal_observation"] = self.annotation
        self.records.update({
            "runtime-control/terminal-observation/" + self.proof_sha + "/proof.json": raw(self.proof),
            "runtime-control/terminal-observation/" + self.proof_sha + "/launch-" + launch_sha + ".json": raw(launch),
            "runtime-control/" + installed_relative: raw(installed),
            "runtime-control/runtime-service/docker-all.json": native,
            "runtime-control/runtime-service/process-tree.json": raw(process),
            "runtime-control/runtime-services/OWNER.json": raw(process["terminal_service_owner"]),
            "runtime-control/runtime-services/docker-client-new-owner.json": raw(owner),
        })
        preflight = observation.decode(self.records[original.BASE + "terminal-session-preflight.json"])
        preflight.update(api_instance_id=self.api, request_scope_epoch=self.api + ":1", scene_revision=1)
        stopped = raw(self.actual)
        self.current = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "iteration", "state": "succeeded",
            "attempt": self.token, "idle_backend_stopped": True, **self.source.scope,
            "backend_container": self.actual["backend"]["Id"], "config_sha256": "d" * 64,
            "inputs": {"source_root": self.source.scope["source_root"], "attempt": self.development,
                       "image_id": self.image, "config_sha256": "d" * 64},
            "terminal_session_preflight_sha256": observation.sha(observation.canonical(preflight)),
            "idle_stop_containers_sha256": observation.sha(stopped),
        }
        drain = {"schema": "fullmag.docker-idle-restart-drain.v1",
                 "backend_container_id": self.actual["backend"]["Id"], "process_receipt": process,
                 "process_receipt_sha256": observation.sha(raw(process))}
        self.records.update({
            "iteration/current.json": raw(self.current), self.base + "terminal.json": raw(self.current),
            self.base + "receipt.json": raw(self.current),
            self.base + "idle-preflight.json": raw({"status": "ok", "active_session": True}),
            self.base + "terminal-session-preflight.json": raw(preflight),
            self.base + "idle-stop-containers.json": stopped, self.base + "backend-drain.json": raw(drain),
        })

    def validate(self, **kwargs):
        return observation.validate_empty_stop(
            self.records.__getitem__, project=self.source.scope["compose_project"],
            volume=self.source.scope["control_volume"], source_root=self.source.scope["source_root"],
            attempt=self.development, config_sha256="d" * 64, actual=self.actual,
            source_proof=self.proof, **kwargs,
        )

    def change_preflight(self, callback):
        value = observation.decode(self.records[self.base + "terminal-session-preflight.json"])
        callback(value)
        self.records[self.base + "terminal-session-preflight.json"] = raw(value)
        self.current["terminal_session_preflight_sha256"] = observation.sha(observation.canonical(value))
        for name in ("terminal.json", "receipt.json"):
            self.records[self.base + name] = raw(self.current)
        self.records["iteration/current.json"] = raw(self.current)

    def test_new_managed_drain_keeps_the_original_native_proof_unchanged(self):
        before = deepcopy(self.proof)
        token, digest = self.validate()
        self.assertEqual(token, self.token)
        self.assertEqual(digest, observation.sha(raw(self.current)))
        self.assertNotEqual(token, self.proof["original_iteration"])
        self.assertEqual(self.proof, before)
        self.assertEqual(self.source.build(), before)

    def test_exact_stop_pin_is_reusable_without_a_current_pointer(self):
        pin = (self.token, observation.sha(raw(self.current)))
        del self.records["iteration/current.json"]
        self.assertEqual(self.validate(stop_pin=pin), pin)

    def _api_exit(self, code):
        relative=self.base+'backend-drain.json'
        drain=observation.decode(self.records[relative])
        process=drain['process_receipt']
        process['api_exit_code']=code
        process_raw=raw(process)
        drain['process_receipt_sha256']=observation.sha(process_raw)
        self.records[relative]=raw(drain)
        self.records['runtime-control/runtime-service/process-tree.json']=process_raw

    def test_supervisor_sigterm_of_api_keeps_successful_native_drain_valid(self):
        self._api_exit(-15)
        self.assertEqual(self.validate()[0],self.token)

    def test_api_kill_failure_or_boolean_exit_does_not_become_a_successful_stop(self):
        for code in (-9,1,True):
            with self.subTest(code=code):
                self._api_exit(code)
                with self.assertRaisesRegex(ValueError,'successful native drain'):
                    self.validate()

    def test_a_new_run_scene_api_or_unpreserved_held_queue_is_rejected(self):
        baseline = deepcopy(self.records)
        for mutation in (
            lambda p: p["run"].update(run_id="another-run"),
            lambda p: p.update(scene_revision=2),
            lambda p: p.update(api_instance_id="b4a388da-0c78-4341-83b9-1f86bdcfc038"),
            lambda p: p.update(request_scope_epoch=self.api + ":2"),
            lambda p: p["compute_queue"].update(items=[]),
            lambda p: p["run"].update(status="completed"),
        ):
            self.records = deepcopy(baseline)
            self.change_preflight(mutation)
            with self.assertRaises(ValueError):
                self.validate()

    def test_native_configuration_current_process_owner_or_installation_drift_refuses(self):
        baseline = deepcopy(self.records)
        paths = (
            "runtime-control/runtime-service/docker-all.json",
            "runtime-control/runtime-service/process-tree.json",
            "runtime-control/runtime-services/OWNER.json",
            "runtime-control/runtime-services/docker-client-new-owner.json",
            "runtime-control/" + self.annotation["installed_relative"],
        )
        for path in paths:
            with self.subTest(path=path):
                self.records = deepcopy(baseline)
                self.records[path] = raw({"foreign": True})
                with self.assertRaises((ValueError, KeyError)):
                    self.validate()

    def test_new_preflight_cas_and_original_source_bytes_are_still_required(self):
        self.records[self.base + "terminal-session-preflight.json"] += b" "
        with self.assertRaises(ValueError):
            self.validate()

    def test_owned_continuation_keeps_original_proof_but_pins_the_new_stop(self):
        import docker_volume_accepted_reattach as retained
        operation = {
            "root": "data-volume-migration/attempts/" + "7" * 32,
            "lease_ready": True, "daemon_pending": True,
            "receipt": {"attempt": "7" * 32, "phase": "data-volume-migration",
                        "compose_project": self.source.scope["compose_project"],
                        "control_volume": self.source.scope["control_volume"]},
        }
        control = SimpleNamespace(project=self.source.scope["compose_project"],
                                  volume=self.source.scope["control_volume"], namespace="",
                                  _active_operation=operation)
        self.records["development/attempts/" + self.development + "/terminal.json"] = raw({"state": "succeeded"})
        stop_pin = (self.token, observation.sha(raw(self.current)))
        def read(_control, relative, *, optional=False, **_kwargs):
            return self.records.get(relative) if optional else self.records[relative]
        proof_relative = "runtime-control/terminal-observation/" + self.proof_sha + "/proof.json"
        with mock.patch.object(retained, "_control_bytes", side_effect=read), \
             mock.patch.object(retained, "_read_store_regular", side_effect=lambda _root, rel, *_a, **_k: self.source.store[rel]), \
             mock.patch.object(observation, "_publish_private_records") as publish:
            result = observation.prepare_context(
                control, proof_relative=proof_relative, proof_sha256=self.proof_sha,
                store_root=Path('/fixture/store'), source_root=self.source.scope['source_root'],
                attempt=self.development, config_sha256='d' * 64, actual=self.actual,
                stop_pin=stop_pin, owned_operation=operation,
            )
        self.assertEqual(result['metadata']['proof_sha256'], self.proof_sha)
        self.assertEqual((result['metadata']['stop_attempt'], result['metadata']['stop_sha256']), stop_pin)
        self.assertEqual(publish.call_args.args[1][0][1], raw(self.proof))
        self.assertIs(publish.call_args.kwargs['owned_operation'], operation)


if __name__ == "__main__":
    unittest.main()
