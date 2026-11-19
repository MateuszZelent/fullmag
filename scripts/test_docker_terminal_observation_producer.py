"""Interpreted candidate producer regressions; no runtime or store mutations."""
import copy
import json
import unittest
from pathlib import Path

import docker_volume_terminal_observation as producer

ROOT = Path(__file__).parent
ITERATION = "e" * 32
RUN = "fixture-failed-run"
BASE = f"iteration/attempts/{ITERATION}/"


class TerminalCaptureCpuAbiTests(unittest.TestCase):
    def test_native_probes_initialize_image_device_policy_before_resolving_cli_paths(self):
        import ast
        import inspect
        import sys
        from types import SimpleNamespace
        from unittest.mock import Mock, patch

        # Keep the embedded probe's standard-library import outside the temporary module map.
        __import__("urllib.request")

        for probe in (producer.capture_terminal_observation, producer.diagnostic_terminal_stop_probe):
            with self.subTest(probe=probe.__name__):
                tree = ast.parse(inspect.getsource(probe))
                script = next(node.value.value for node in ast.walk(tree)
                              if isinstance(node, ast.Assign)
                              and any(isinstance(target, ast.Name) and target.id == "script"
                                      for target in node.targets))
                prefix = []
                for node in ast.parse(script).body:
                    prefix.append(node)
                    if isinstance(node, ast.Assign) and any(
                        isinstance(target, ast.Name) and target.id == "paths" for target in node.targets
                    ):
                        break
                compiled = compile(ast.Module(body=prefix, type_ignores=[]), "<terminal-probe-prefix>", "exec")
                calls = []
                entrypoint = SimpleNamespace(_configure_device_access=lambda: calls.append("device-policy"))
                service = SimpleNamespace(canonical_paths=lambda: calls.append("cli-paths"))
                with patch.dict(sys.modules, {"entrypoint": entrypoint, "runtime_service": service}), \
                     patch.object(sys, "path", sys.path.copy()):
                    exec(compiled, {})
                self.assertEqual(calls, ["device-policy", "cli-paths"])
                calls.clear()
                entrypoint._configure_device_access = Mock(side_effect=RuntimeError("invalid device policy"))
                with patch.dict(sys.modules, {"entrypoint": entrypoint, "runtime_service": service}), \
                     patch.object(sys, "path", sys.path.copy()), self.assertRaisesRegex(RuntimeError, "invalid device policy"):
                    exec(compiled, {})
                self.assertEqual(calls, [])


class ProducerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Synthetic contract records, not solver output or native evidence.
        raw = lambda value: producer.canonical(value) + b"\n"
        cls.scope = {"compose_project": "fullmag-fixture", "control_volume": "fixture-control",
                     "source_root": "/fixture/source", "image_id": "sha256:" + "c" * 64}
        owner = {key: "fixture-" + key for key in (
            "owner_token", "process_start_token", "host", "target_id", "protocol", "control_address",
            "compute_pool_id", "preparation_pool_id")}
        owner.update(pid=10, build_commit="d" * 40, build_snapshot="e" * 64,
                     compute_pool_generation=1, preparation_pool_generation=1, state="ready",
                     children=[{"role": "compute", "pid": 11, "status": "running"},
                               {"role": "preparation", "pid": 12, "status": "running"}])
        terminal = copy.deepcopy(owner)
        terminal["state"] = "drained"
        for child in terminal["children"]:
            child["status"] = "exited_success"
        process = {"schema": "fullmag.docker-process-tree.v1", "state": "drained", "api_pid": 9,
                   "api_exit_code": 0, "accepted_store": "/state/runs/docker-all/session-store",
                   "bootstrap": {}, "qualification": "fixture", "service_owner": owner,
                   "terminal_service_owner": terminal}
        source = "b" * 64
        intent = {"schema_version": "run_intent.v1", "run_id": RUN, "payload_sha256": "c" * 64,
                  "specification": {"run_id": RUN,
                      "snapshot": {"project_id": "fixture-project", "definition_revision": 1,
                                   "definition_sha256": "d" * 64},
                      "parameters": {"live_workspace": {
                          "session_id": "fixture-session", "session_epoch": 1,
                          "api_instance_id": "fixture-api", "scene_revision": 1,
                          "request_idempotency_key": "fixture-request", "startup_source_sha256": source,
                          "command_id": "fixture-request", "command": {"kind": "startup_script",
                              "request_id": "fixture-request", "source_sha256": source}}}}}
        cls.records = {f"runs/{RUN}/run_intent.json": raw(intent),
                       f"runs/{RUN}/run_catalog.json": raw({"schema_version": "run_catalog.v1",
                           "run_id": RUN, "revision": 7, "tasks": [{"lifecycle": "failed"}]}),
                       f"runs/{RUN}/start_release.json": raw({"schema_version": "accepted_run_start_release.v1",
                           "run_id": RUN, "specification_sha256": intent["payload_sha256"]}),
                       "runs/fixture-held/run_intent.json": raw({"fixture": "held manual run"})}
        preflight = {"schema": "fullmag.docker-terminal-session-drain-preflight.v1",
                     "api_instance_id": "fixture-api", "session_id": "fixture-session",
                     "session_epoch": "fixture-session@1000", "request_scope_epoch": "fixture-api:1",
                     "run": {"run_id": RUN, "session_id": "fixture-session", "status": "failed",
                             "started_at": "1000"},
                     "compute_queue": {"schema_version": "compute_queue.v1", "next_cursor": None,
                                       "items": [{"run_id": "fixture-held", "state": "accepted"}]},
                     "held_run_intent_sha256": {"fixture-held": producer.sha(cls.records["runs/fixture-held/run_intent.json"])},
                     "runtime_service": {"schema_version": "application_service_status.v1",
                                         "configured": True, "state": "ready"}}
        operation = {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration",
                     "state": "succeeded", "attempt": ITERATION,
                     "compose_project": cls.scope["compose_project"], "control_volume": cls.scope["control_volume"],
                     "backend_container": "f" * 64, "config_sha256": "a" * 64,
                     "inputs": {"source_root": cls.scope["source_root"], "image_id": cls.scope["image_id"],
                                "config_sha256": "a" * 64},
                     "terminal_session_preflight_sha256": producer.sha(producer.canonical(preflight))}
        cls.controls = {BASE + "terminal.json": raw(operation), BASE + "receipt.json": raw(operation),
                        BASE + "terminal-session-preflight.json": raw(preflight),
                        BASE + "backend-drain.json": raw({"schema": "fullmag.docker-idle-restart-drain.v1",
                           "backend_container_id": "f" * 64, "process_receipt": process,
                           "process_receipt_sha256": producer.sha(raw(process))}),
                        "runtime-control/runtime-services/docker-client-fixture-owner_token.json": raw(owner)}
        cls.expected = producer.build_proof(cls.controls.__getitem__, cls.records.__getitem__,
                                           iteration=ITERATION, run_id=RUN, scope=cls.scope,
                                           native_config_sha256="a" * 64,
                                           terminal_evidence_sha256="b" * 64)

    def setUp(self):
        self.control = dict(self.controls)
        self.store = dict(self.records)

    def build(self, scope=None):
        return producer.build_proof(self.control.__getitem__, self.store.__getitem__,
                                    iteration=ITERATION, run_id=RUN, scope=scope or self.scope,
                                    native_config_sha256="a" * 64,
                                    terminal_evidence_sha256="b" * 64)

    def mutate(self, relative, callback, records=None):
        records = self.control if records is None else records
        value = producer.decode(records[relative])
        callback(value)
        records[relative] = producer.canonical(value) + b"\n"

    def change_preflight(self, callback):
        self.mutate(BASE + "terminal-session-preflight.json", callback)
        preflight = producer.decode(self.control[BASE + "terminal-session-preflight.json"])
        pin = producer.sha(producer.canonical(preflight))
        for name in ("terminal.json", "receipt.json"):
            self.mutate(BASE + name, lambda value: value.update(
                terminal_session_preflight_sha256=pin))

    def change_native(self, callback):
        relative = BASE + "backend-drain.json"
        drain = producer.decode(self.control[relative])
        callback(drain["process_receipt"])
        drain["process_receipt_sha256"] = producer.sha(
            producer.canonical(drain["process_receipt"]) + b"\n")
        self.control[relative] = producer.canonical(drain) + b"\n"

    def attach_terminal_observation(self):
        """Attach one producer-shaped, prior-run runtime receipt and its CAS files."""
        prior_proof = {
            "schema": producer.PROOF_SCHEMA,
            "original_iteration": "1" * 32,
            "compose_project": self.scope["compose_project"],
            "control_volume": self.scope["control_volume"],
            "source_root": self.scope["source_root"],
            "image_id": "sha256:" + "f" * 64,
            "config_sha256": "a" * 64,
            "native_config_sha256": "b" * 64,
            "terminal_evidence_sha256": "c" * 64,
            "run_id": "prior-run-6c24",
            "session_id": "prior-session-275",
            "session_epoch": 1000,
            "scene_revision": 4,
        }
        proof_raw = producer.canonical(prior_proof) + b"\n"
        proof_sha = producer.sha(proof_raw)
        api_id = "346dfd7e-f50e-450a-ad3e-97a42d8e2ddc"
        process = producer.decode(self.control[BASE + "backend-drain.json"])["process_receipt"]
        owner = process["service_owner"]
        launch = {
            "schema": "fullmag.terminal-observation-launch.v1",
            "source_proof_sha256": proof_sha,
            "source_native_config_sha256": prior_proof["native_config_sha256"],
            "target_build_id": owner["build_commit"],
            "target_source_sha256": owner["build_snapshot"],
            "target_image_id": self.scope["image_id"],
            "native_config_sha256": "d" * 64,
            "terminal_evidence_sha256": prior_proof["terminal_evidence_sha256"],
        }
        launch_raw = producer.canonical(launch) + b"\n"
        launch_sha = producer.sha(launch_raw)
        installed = {
            "schema": "fullmag.terminal-observation-restored.v1",
            "api_instance_id": api_id,
            "run_id": prior_proof["run_id"],
            "session_id": prior_proof["session_id"],
            "session_epoch": prior_proof["session_epoch"],
            "scene_revision": prior_proof["scene_revision"],
            "terminal_outcome": "completed",
            "proof_sha256": proof_sha,
            "launch_sha256": launch_sha,
            "source_image_id": prior_proof["image_id"],
            "source_config_sha256": prior_proof["config_sha256"],
            "target_build_id": launch["target_build_id"],
            "target_source_sha256": launch["target_source_sha256"],
            "target_image_id": launch["target_image_id"],
            "native_config_sha256": launch["native_config_sha256"],
            "terminal_evidence_sha256": prior_proof["terminal_evidence_sha256"],
        }
        installed_raw = producer.canonical(installed) + b"\n"
        relative = f"terminal-observation/{proof_sha}/installed-{api_id}.json"
        annotation = {
            "schema": "fullmag.terminal-observation-runtime.v1",
            "api_instance_id": api_id,
            "run_id": prior_proof["run_id"],
            "session_id": prior_proof["session_id"],
            "proof_sha256": proof_sha,
            "launch_sha256": launch_sha,
            "installed_relative": relative,
            "installed_sha256": producer.sha(installed_raw),
            "target_build_id": launch["target_build_id"],
            "target_source_sha256": launch["target_source_sha256"],
            "target_image_id": launch["target_image_id"],
        }
        prefix = f"runtime-control/terminal-observation/{proof_sha}/"
        self.control[prefix + "proof.json"] = proof_raw
        self.control[prefix + f"launch-{launch_sha}.json"] = launch_raw
        self.control[prefix + relative.removeprefix(f"terminal-observation/{proof_sha}/")] = installed_raw
        process["terminal_observation"] = annotation
        drain_relative = BASE + "backend-drain.json"
        drain = producer.decode(self.control[drain_relative])
        drain["process_receipt"] = process
        drain["process_receipt_sha256"] = producer.sha(producer.canonical(process) + b"\n")
        self.control[drain_relative] = producer.canonical(drain) + b"\n"
        return annotation

    def attach_recovery_annotations(self):
        self.change_native(lambda value: value.update(
            container_recovery={
                "schema_version": "runtime_service_container_recovery.v1",
                "status": "recovered", "outcome": "retained_terminal_runs_recovered",
                "request_id": "request-1", "request_sha256": "1" * 64,
                "config_sha256": "2" * 64, "attestation_sha256": "3" * 64,
                "owner_sha256_after": "4" * 64,
            },
            container_recovery_authorization={
                "schema_version": "fullmag.docker-container-recovery-authorization.v1",
                "request_id": "request-1", "request_sha256": "1" * 64,
                "config_sha256": "2" * 64, "attestation_sha256": "3" * 64,
                "owner_sha256_after": "4" * 64,
            },
        ))

    # Native pins above are deliberate unit-fixture placeholders, kept in
    # memory only. These tests do not qualify the native fence or publish proof.
    def test_fixture_failed_run_has_exact_original_pins(self):
        proof = self.build()
        self.assertEqual(proof, self.expected)
        self.assertEqual(proof["catalog_revision"], 7)
        self.assertEqual(proof["definition_sha256"],
                         "d" * 64)

    def test_native_pins_are_mandatory_and_never_inferred_from_failed_catalog(self):
        with self.assertRaises(TypeError):
            producer.build_proof(self.control.__getitem__, self.store.__getitem__,
                                 iteration=ITERATION, run_id=RUN, scope=self.scope)
        with self.assertRaises(ValueError):
            producer.build_proof(self.control.__getitem__, self.store.__getitem__,
                                 iteration=ITERATION, run_id=RUN, scope=self.scope,
                                 native_config_sha256="a" * 64, terminal_evidence_sha256="")

    def test_wrong_scope_is_rejected(self):
        for key in self.scope:
            with self.subTest(key=key), self.assertRaises(ValueError):
                scope = dict(self.scope)
                scope[key] = "foreign-scope"
                self.build(scope)

    def test_partial_or_unsuccessful_iteration_is_rejected(self):
        self.mutate(BASE + "terminal.json", lambda value: value.update(state="running"))
        with self.assertRaises(ValueError):
            self.build()

    def test_corrupt_preflight_cas_is_rejected(self):
        self.mutate(BASE + "terminal-session-preflight.json",
                    lambda value: value["run"].update(status="completed"))
        with self.assertRaises(ValueError):
            self.build()

    def test_completed_alias_cannot_replace_failed_observation(self):
        self.change_preflight(lambda value: value["run"].update(status="completed"))
        with self.assertRaises(ValueError):
            self.build()

    def test_wrong_historical_session_is_rejected(self):
        self.change_preflight(lambda value: value.update(
            request_scope_epoch="foreign-api:1"))
        with self.assertRaises(ValueError):
            self.build()

    def test_runnable_historical_queue_is_rejected(self):
        self.change_preflight(lambda value: value["compute_queue"]["items"][0].update(
            state="running"))
        with self.assertRaises(ValueError):
            self.build()

    def test_changed_held_intent_is_rejected(self):
        relative = next(key for key in self.store if key != f"runs/{RUN}/run_intent.json"
                        and key.endswith("/run_intent.json"))
        self.store[relative] += b" "
        with self.assertRaises(ValueError):
            self.build()

    def test_partial_native_receipt_is_rejected(self):
        self.change_native(lambda value: value.update(shutdown_error="unknown"))
        with self.assertRaises(ValueError):
            self.build()

    def test_terminal_observation_runtime_annotation_is_accepted_from_its_own_archives(self):
        annotation = self.attach_terminal_observation()
        proof = self.build()
        self.assertEqual(proof["run_id"], RUN)
        self.assertNotEqual(annotation["run_id"], proof["run_id"])
        self.assertNotEqual(annotation["session_id"], proof["session_id"])

    def test_terminal_observation_runtime_annotation_rejects_unbound_or_unknown_shapes(self):
        self.attach_terminal_observation()
        failures = (
            lambda value: value["terminal_observation"].update(schema="future.v1"),
            lambda value: value["terminal_observation"].update(unrecognized="extra"),
            lambda value: value["terminal_observation"].update(installed_sha256="0" * 64),
            lambda value: value["terminal_observation"].update(
                installed_relative="terminal-observation/../foreign.json"),
        )
        for mutate in failures:
            with self.subTest(mutate=mutate):
                self.control = dict(self.controls)
                self.attach_terminal_observation()
                self.change_native(mutate)
                with self.assertRaises(ValueError):
                    self.build()

    def test_terminal_observation_runtime_annotation_rejects_changed_archived_bindings(self):
        for mutation in ("proof", "launch", "launch_extra", "installed", "installed_source_image",
                         "installed_extra", "owner", "image"):
            with self.subTest(mutation=mutation):
                self.control = dict(self.controls)
                annotation = self.attach_terminal_observation()
                prefix = f"runtime-control/terminal-observation/{annotation['proof_sha256']}/"
                relative = {
                    "proof": prefix + "proof.json",
                    "launch": prefix + f"launch-{annotation['launch_sha256']}.json",
                    "launch_extra": prefix + f"launch-{annotation['launch_sha256']}.json",
                    "installed": "runtime-control/" + annotation["installed_relative"],
                    "installed_source_image": "runtime-control/" + annotation["installed_relative"],
                    "installed_extra": "runtime-control/" + annotation["installed_relative"],
                    "owner": BASE + "backend-drain.json",
                    "image": BASE + "backend-drain.json",
                }[mutation]
                if mutation == "proof":
                    self.control[relative] += b" "
                elif mutation in {"launch", "launch_extra"}:
                    value = producer.decode(self.control[relative])
                    value["target_build_id"] = "f" * 40 if mutation == "launch" else value["target_build_id"]
                    if mutation == "launch_extra":
                        value["unrecognized"] = True
                    self.control[relative] = producer.canonical(value) + b"\n"
                elif mutation in {"installed", "installed_source_image", "installed_extra"}:
                    value = producer.decode(self.control[relative])
                    if mutation == "installed":
                        value["run_id"] = "foreign-run"
                    elif mutation == "installed_source_image":
                        value["source_image_id"] = self.scope["image_id"]
                    else:
                        value["unrecognized"] = True
                    self.control[relative] = producer.canonical(value) + b"\n"
                elif mutation == "owner":
                    drain = producer.decode(self.control[relative])
                    drain["process_receipt"]["service_owner"]["build_commit"] = "f" * 40
                    drain["process_receipt_sha256"] = producer.sha(
                        producer.canonical(drain["process_receipt"]) + b"\n")
                    self.control[relative] = producer.canonical(drain) + b"\n"
                else:
                    drain = producer.decode(self.control[relative])
                    drain["process_receipt"]["terminal_observation"]["target_image_id"] = "sha256:" + "f" * 64
                    drain["process_receipt_sha256"] = producer.sha(
                        producer.canonical(drain["process_receipt"]) + b"\n")
                    self.control[relative] = producer.canonical(drain) + b"\n"
                with self.assertRaises(ValueError):
                    self.build()

    def test_terminal_observation_can_coexist_with_complete_legacy_recovery_annotations(self):
        self.attach_terminal_observation()
        self.attach_recovery_annotations()
        self.build()

    def test_legacy_recovery_annotations_remain_supported_without_terminal_observation(self):
        self.attach_recovery_annotations()
        self.build()

    def test_terminal_observation_with_partial_recovery_annotation_is_rejected(self):
        self.attach_terminal_observation()
        self.change_native(lambda value: value.update(container_recovery={}))
        with self.assertRaises(ValueError):
            self.build()

    def test_foreign_native_owner_cannot_be_used(self):
        self.change_native(lambda value: value["terminal_service_owner"].update(
            owner_token="foreign-owner"))
        with self.assertRaises(ValueError):
            self.build()

    def test_nonterminal_catalog_is_rejected(self):
        self.mutate(f"runs/{RUN}/run_catalog.json",
                    lambda value: value["tasks"][0].update(lifecycle="running"), self.store)
        with self.assertRaises(ValueError):
            self.build()

    def test_crossed_start_release_is_rejected(self):
        self.mutate(f"runs/{RUN}/start_release.json",
                    lambda value: value.update(specification_sha256="f" * 64), self.store)
        with self.assertRaises(ValueError):
            self.build()

    def test_missing_start_release_is_rejected(self):
        del self.store[f"runs/{RUN}/start_release.json"]
        with self.assertRaises(KeyError):
            self.build()

    def use_compute_intent(self):
        target = {"kind": "stage_id", "stage_id": "relax-b"}
        receipt = {"key_sha256": "3" * 64, "request_sha256": "4" * 64,
                   "command_id": "command-from-ui", "request_id": None, "command_kind": "relax",
                   "client_intent_id": "study:relax:fixture", "requested_target": target}

        def update(intent):
            intent["idempotency_key"] = "live-http-v2-" + receipt["key_sha256"]
            live = intent["specification"]["parameters"]["live_workspace"]
            live.update(command_id=receipt["command_id"], startup_source_sha256=None,
                        request_idempotency_key=receipt["key_sha256"], request_receipt=receipt,
                        command={"kind": "relax", "command_id": receipt["command_id"],
                                 "client_intent_id": receipt["client_intent_id"], "target": target})

        self.mutate(f"runs/{RUN}/run_intent.json", update, self.store)
        del self.store[f"runs/{RUN}/start_release.json"]
        self.change_preflight(lambda preflight: preflight.update(scene_revision=1))
        return receipt

    def test_automatic_compute_has_a_separate_receipt_pinned_proof(self):
        receipt = self.use_compute_intent()
        proof = self.build()
        self.assertEqual(proof["schema"], "fullmag.development-terminal-observation-proof.v2")
        self.assertEqual(proof["compute"], {"command_id": receipt["command_id"],
                                          "receipt_sha256": producer.sha(producer.canonical(receipt))})
        self.assertEqual(proof["session_id"], "fixture-session")
        self.assertNotIn("start_release_sha256", proof)
        self.assertNotIn("source_request_id", proof)

    def test_automatic_compute_rejects_mismatched_key_target_or_manual_policy(self):
        for failure in ("key", "target", "kind", "client_intent", "manual"):
            with self.subTest(failure=failure):
                self.store = dict(self.records)
                self.use_compute_intent()
                def change(intent):
                    params = intent["specification"]["parameters"]
                    live = params["live_workspace"]
                    if failure == "key":
                        intent["idempotency_key"] = "live-http-v2-" + "5" * 64
                    elif failure == "target":
                        live["command"]["target"]["stage_id"] = "relax-a"
                    elif failure == "kind":
                        live["command"]["kind"] = "run"
                    elif failure == "client_intent":
                        live["command"]["client_intent_id"] = "other-intent"
                    else:
                        params["fullmag.accepted_run_start"] = {
                            "schema_version": "accepted_run_start_policy.v1", "mode": "manual"}
                self.mutate(f"runs/{RUN}/run_intent.json", change, self.store)
                with self.assertRaises(ValueError):
                    self.build()

    def test_compute_proof_cannot_replace_newer_editable_scene(self):
        self.use_compute_intent()
        self.change_preflight(lambda preflight: preflight.update(scene_revision=2))
        with self.assertRaisesRegex(ValueError, "editable scene changed"):
            self.build()

    def test_held_startup_release_with_compute_receipt_keeps_legacy_proof_shape(self):
        relative = f"runs/{RUN}/start_release.json"
        self.mutate(relative, lambda grant: grant.update(
            schema_version="accepted_run_start_release.v2",
            live_request={"command_id": "release-command", "key_sha256": "7" * 64,
                          "request_sha256": "8" * 64, "request_id": None, "command_kind": "solve"},
        ), self.store)
        proof = self.build()
        self.assertEqual(proof["schema"], producer.PROOF_SCHEMA)
        self.assertEqual(proof["start_release_sha256"], producer.sha(self.store[relative]))
        self.assertEqual(proof["source_request_id"], "fixture-request")
        self.assertNotIn("compute", proof)

    def test_captured_stop_builds_proof_without_external_digest_input(self):
        self.use_compute_intent()
        preflight = producer.decode(self.control[BASE + "terminal-session-preflight.json"])
        capture = producer.capture_binding(self.store.__getitem__, preflight, {
            "schema_version": "runtime_service_terminal_run_evidence.v1",
            "run_id": RUN, "terminal_evidence_sha256": "b" * 64,
            "mutations_applied": False, "solve_replayed": False,
        }, "a" * 64, producer.decode(self.control[BASE + "backend-drain.json"])["process_receipt"]["service_owner"])
        native_raw = producer.canonical(capture) + b"\n"
        self.control[BASE + "terminal-native-observation.json"] = native_raw
        for name in ("terminal.json", "receipt.json"):
            self.mutate(BASE + name, lambda value: value.update(
                idle_backend_stopped=True, terminal_native_observation_sha256=producer.sha(native_raw)))
        proof = producer.build_captured_proof(
            self.control.__getitem__, self.store.__getitem__, iteration=ITERATION, scope=self.scope,
        )
        self.assertEqual(proof, self.build())
        self.assertEqual(proof["schema"], producer.COMPUTE_PROOF_SCHEMA)

        self.mutate(f"runs/{RUN}/run_catalog.json",
                    lambda value: value.update(revision=8), self.store)
        with self.assertRaisesRegex(ValueError, "changed after native capture"):
            producer.build_captured_proof(
                self.control.__getitem__, self.store.__getitem__, iteration=ITERATION, scope=self.scope,
            )

        self.control[BASE + "terminal-native-observation.json"] = native_raw + b" "
        with self.assertRaises(ValueError):
            producer.build_captured_proof(
                self.control.__getitem__, self.store.__getitem__, iteration=ITERATION, scope=self.scope,
            )

    def test_native_capture_rejects_replay_or_a_different_run(self):
        self.use_compute_intent()
        preflight = producer.decode(self.control[BASE + "terminal-session-preflight.json"])
        evidence = {"schema_version": "runtime_service_terminal_run_evidence.v1",
                    "run_id": RUN, "terminal_evidence_sha256": "b" * 64,
                    "mutations_applied": False, "solve_replayed": False}
        for change in ({"solve_replayed": True}, {"mutations_applied": True}, {"run_id": "other-run"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                producer.capture_binding(self.store.__getitem__, preflight, {**evidence, **change}, "a" * 64, {})

    def test_duplicate_keys_are_rejected(self):
        with self.assertRaises(ValueError):
            producer.decode(b'{"run_id":"one","run_id":"two"}')


if __name__ == "__main__":
    unittest.main()
