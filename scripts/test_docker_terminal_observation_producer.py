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
