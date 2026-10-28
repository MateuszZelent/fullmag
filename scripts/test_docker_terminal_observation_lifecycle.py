"""Interpreted fixture regressions only; never call native CLI, HTTP or lifecycle."""
import contextlib
import copy
import hashlib
import importlib.util
import importlib.machinery
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock
import docker_volume_terminal_observation as producer

ROOT = Path(__file__).parent
loader = importlib.machinery.SourceFileLoader("candidate_runtime_service", str(ROOT.parent / "docker/all-in-one/runtime_service.py"))
spec = importlib.util.spec_from_loader(loader.name, loader)
service = importlib.util.module_from_spec(spec)
sys.modules[loader.name] = service
loader.exec_module(service)


class Transport(unittest.TestCase):
    def setUp(self):
        fixture_directory = tempfile.TemporaryDirectory(prefix="fullmag-terminal-observation-")
        self.addCleanup(fixture_directory.cleanup)
        self.directory = Path(fixture_directory.name)
        import test_docker_terminal_observation_producer as original
        original.ProducerTests.setUpClass()
        self.proof = copy.deepcopy(original.ProducerTests.expected)
        raw = producer.canonical(self.proof) + b"\n"
        digest = producer.sha(raw)
        self.parent = self.directory / "terminal-observation" / digest
        self.parent.mkdir(parents=True)
        (self.parent / "proof.json").write_bytes(raw)
        request = {"schema": "fullmag.terminal-observation-request.v1",
                   "proof_path": f"terminal-observation/{digest}/proof.json", "proof_sha256": digest}
        request_raw = producer.canonical(request) + b"\n"
        (self.parent / "request.json").write_bytes(request_raw)
        self.env = {service.TERMINAL_OBSERVATION_REQUEST_ENV: f"terminal-observation/{digest}/request.json",
                    service.TERMINAL_OBSERVATION_DIGEST_ENV: producer.sha(request_raw),
                    "FULLMAG_STARTUP_ENABLED": "0",
                    "FULLMAG_RUNTIME_PROVENANCE": str(service.ACCEPTED_REATTACH_PROVENANCE),
                    "FULLMAG_RUNTIME_IMAGE_ID": "sha256:" + "d" * 64}
        config = self.directory / "native.json"
        config.write_bytes(b'{"fixture":"target-native-config"}\n')
        self.paths = types.SimpleNamespace(state_root=self.directory, config=config)
        self.patches = []
        self.replace("process_environment", mock.Mock(side_effect=lambda *a, **k: dict(self.env)))
        self.replace("_read_json", mock.Mock(return_value={
            "schema": "fullmag.docker-all-image.v1", "state": "succeeded", "commit": "c" * 40,
            "source_snapshot_sha256": "e" * 64, "image_id": self.env["FULLMAG_RUNTIME_IMAGE_ID"]}))
        self.native = self.replace("_run_cli", mock.Mock(return_value={
            "schema_version": "runtime_service_terminal_run_evidence.v1", "run_id": self.proof["run_id"],
            "terminal_evidence_sha256": self.proof["terminal_evidence_sha256"],
            "mutations_applied": False, "solve_replayed": False}))
        self.replace("_http_json", mock.Mock(side_effect=AssertionError("HTTP forbidden in fixture unless explicitly stubbed")))

    def replace(self, name, value):
        patch = mock.patch.object(service, name, value)
        result = patch.start()
        self.addCleanup(patch.stop)
        return result

    def preflight(self):
        return service.terminal_observation_preflight(self.paths)

    def test_target_launch_preserves_historical_proof_and_uses_fresh_config(self):
        before = (self.parent / "proof.json").read_bytes()
        preflight = self.preflight()
        with service.terminal_observation_api_input(self.paths, terminal_preflight=preflight) as (env, stream, launch):
            payload = json.load(stream)
            self.assertEqual(env[service.TERMINAL_OBSERVATION_STDIN_ENV], "1")
            self.assertNotIn(service.TERMINAL_OBSERVATION_STDIN_ENV, self.env)
            self.assertEqual(payload["target_image_id"], self.env["FULLMAG_RUNTIME_IMAGE_ID"])
            self.assertEqual(launch["binding"]["source_native_config_sha256"], self.proof["native_config_sha256"])
            self.assertEqual(launch["binding"]["native_config_sha256"], producer.sha(self.paths.config.read_bytes()))
            self.assertEqual(launch["binding"]["terminal_evidence_sha256"], self.proof["terminal_evidence_sha256"])
        self.assertEqual((self.parent / "proof.json").read_bytes(), before)
        self.assertEqual(self.native.call_count, 1)
        self.assertEqual(self.native.call_args.args[1][:2], ["runtime", "service-inspect-terminal-run"])
        self.assertFalse(list(self.parent.glob("installed-*.json")))

    def test_missing_pair_rejected_before_native(self):
        self.env.pop(service.TERMINAL_OBSERVATION_DIGEST_ENV)
        with self.assertRaises(RuntimeError): self.preflight()
        self.native.assert_not_called()

    def test_corrupt_request_cas_rejected(self):
        (self.parent / "request.json").write_bytes(b'{}\n')
        with self.assertRaises(RuntimeError): self.preflight()

    def test_duplicate_request_fields_rejected(self):
        raw = b'{"schema":"x","schema":"y"}\n'
        (self.parent / "request.json").write_bytes(raw)
        self.env[service.TERMINAL_OBSERVATION_DIGEST_ENV] = producer.sha(raw)
        with self.assertRaises(RuntimeError): self.preflight()

    def test_conflicting_startup_and_accepted_controls_rejected(self):
        for name, value in (("FULLMAG_STARTUP_ENABLED", "1"),
                            (service.ACCEPTED_REATTACH_REQUEST_ENV, "fixture"),
                            (service.TERMINAL_OBSERVATION_STDIN_ENV, "1")):
            with self.subTest(name=name):
                old = dict(self.env)
                self.env[name] = value
                with self.assertRaises(RuntimeError): self.preflight()
                self.env = old
        self.native.assert_not_called()

    def test_changed_preflight_rejected(self):
        preflight = self.preflight()
        preflight["proof_sha256"] = "f" * 64
        with self.assertRaises(RuntimeError):
            with service.terminal_observation_api_input(self.paths, terminal_preflight=preflight): pass
        self.native.assert_not_called()

    def test_wrong_terminal_digest_or_mutating_response_rejected(self):
        for key, value in (("terminal_evidence_sha256", "f" * 64),
                           ("mutations_applied", True), ("solve_replayed", True)):
            with self.subTest(key=key):
                original = self.native.return_value.copy()
                self.native.return_value[key] = value
                with self.assertRaises(RuntimeError):
                    with service.terminal_observation_api_input(self.paths, terminal_preflight=self.preflight()): pass
                self.native.return_value = original
        self.assertFalse(list(self.parent.glob("launch-*.json")))

    def test_private_launch_mutex_rejects_concurrent_owner(self):
        preflight = self.preflight()
        with service.terminal_observation_api_input(self.paths, terminal_preflight=preflight):
            with self.assertRaises(RuntimeError):
                with service.terminal_observation_api_input(self.paths, terminal_preflight=preflight): pass
        self.assertEqual(self.native.call_count, 1)

    def test_normal_mode_delegates_without_native_inspection(self):
        self.env = {}
        @contextlib.contextmanager
        def old(*a, **k): yield {"ordinary": "environment"}, None
        self.replace("accepted_reattach_api_input", old)
        with service.terminal_observation_api_input(self.paths) as result:
            self.assertEqual(result, ({"ordinary": "environment"}, None, None))
        self.native.assert_not_called()

    def test_missing_real_native_install_receipt_is_failure(self):
        preflight = self.preflight()
        with service.terminal_observation_api_input(self.paths, terminal_preflight=preflight) as (_, _, launch):
            pass
        handle = types.SimpleNamespace(api_identity={"api_instance_id": "01234567-89ab-4def-8123-0123456789ab"})
        with self.assertRaises((RuntimeError, FileNotFoundError)):
            service.terminal_observation_runtime_receipt(self.paths, preflight=preflight, launch=launch, handle=handle)

    def test_fixture_install_receipt_requires_api_readback_identity(self):
        preflight = self.preflight()
        with service.terminal_observation_api_input(self.paths, terminal_preflight=preflight) as (_, _, launch): pass
        api = "01234567-89ab-4def-8123-0123456789ab"
        binding = launch["binding"]
        receipt = {"schema": "fullmag.terminal-observation-restored.v1", "api_instance_id": api,
                   "run_id": self.proof["run_id"], "session_id": self.proof["session_id"],
                   "session_epoch": self.proof["session_epoch"], "scene_revision": self.proof["scene_revision"],
                   "terminal_outcome": "failed", "proof_sha256": preflight["proof_sha256"],
                   "launch_sha256": launch["sha256"], "source_image_id": self.proof["image_id"],
                   "source_config_sha256": self.proof["config_sha256"],
                   "target_build_id": binding["target_build_id"],
                   "target_source_sha256": binding["target_source_sha256"],
                   "target_image_id": binding["target_image_id"], "native_config_sha256": binding["native_config_sha256"],
                   "terminal_evidence_sha256": self.proof["terminal_evidence_sha256"]}
        (self.parent / ("installed-" + api + ".json")).write_bytes(producer.canonical(receipt) + b"\n")
        http = mock.Mock(return_value=(200, [("x-fullmag-api-instance", api)],
                                      {"run_id": self.proof["run_id"], "session_id": self.proof["session_id"], "status": "failed"}))
        self.replace("_http_json", http)
        handle = types.SimpleNamespace(api_identity={"api_instance_id": api})
        result = service.terminal_observation_runtime_receipt(self.paths, preflight=preflight, launch=launch, handle=handle)
        self.assertEqual(result["schema"], "fullmag.terminal-observation-runtime.v1")
        http.return_value = (200, [("x-fullmag-api-instance", "wrong")], http.return_value[2])
        with self.assertRaises(RuntimeError):
            service.terminal_observation_runtime_receipt(self.paths, preflight=preflight, launch=launch, handle=handle)


class EmptyStop(unittest.TestCase):
    def setUp(self):
        self.token, self.old = "a" * 32, "b" * 32
        self.actual = {name: {"Id": name, "Image": "sha256:" + "c" * 64,
                             "Config": {"fixture": name}, "Mounts": [],
                             "State": {"StartedAt": "fixture", "Running": False}} for name in ("backend", "frontend")}
        raw = lambda x: producer.canonical(x) + b"\n"
        stopped = raw(self.actual)
        process = {"state": "drained"}
        self.current = {"schema": "fullmag.docker-build-operation.v1", "phase": "iteration",
                        "state": "succeeded", "attempt": self.token, "idle_backend_stopped": True,
                        "compose_project": "fixture", "control_volume": "fixture-volume",
                        "inputs": {"source_root": "/fixture/source", "attempt": self.old},
                        "config_sha256": "d" * 64, "idle_stop_containers_sha256": producer.sha(stopped)}
        self.base = "iteration/attempts/" + self.token + "/"
        self.records = {"iteration/current.json": raw(self.current), self.base + "terminal.json": raw(self.current),
                        self.base + "receipt.json": raw(self.current), self.base + "idle-preflight.json": raw({"status": "ok", "active_session": False}),
                        self.base + "idle-stop-containers.json": stopped,
                        self.base + "backend-drain.json": raw({"schema": "fullmag.docker-idle-restart-drain.v1",
                         "backend_container_id": "backend", "process_receipt": process,
                         "process_receipt_sha256": producer.sha(raw(process))})}

    def validate(self):
        return producer.validate_empty_stop(self.records.__getitem__, project="fixture", volume="fixture-volume",
                   source_root="/fixture/source", attempt=self.old, config_sha256="d" * 64, actual=self.actual)

    def test_exact_empty_stop(self):
        self.assertEqual(self.validate()[0], self.token)

    def test_mount_order_is_ignored_but_mount_content_is_not(self):
        self.actual["backend"]["Mounts"] = [
            {"Destination": "/state", "Source": "fixture-state", "RW": True},
            {"Destination": "/source", "Source": "fixture-source", "RW": False}]
        stopped = producer.canonical(self.actual) + b"\n"
        self.records[self.base + "idle-stop-containers.json"] = stopped
        self.current["idle_stop_containers_sha256"] = producer.sha(stopped)
        for relative in ("iteration/current.json", self.base + "terminal.json", self.base + "receipt.json"):
            self.records[relative] = producer.canonical(self.current) + b"\n"
        self.actual["backend"]["Mounts"].reverse()
        self.assertEqual(self.validate()[0], self.token)
        self.actual["backend"]["Mounts"][0]["RW"] = True
        with self.assertRaises(ValueError): self.validate()

    def test_nonempty_workspace_rejected(self):
        self.records[self.base + "idle-preflight.json"] = producer.canonical({"status": "ok", "active_session": True})
        with self.assertRaises(ValueError): self.validate()

    def test_incarnation_or_running_change_rejected(self):
        for key, value in (("StartedAt", "new"), ("Running", True)):
            with self.subTest(key=key):
                old = copy.deepcopy(self.actual)
                self.actual["backend"]["State"][key] = value
                with self.assertRaises(ValueError): self.validate()
                self.actual = old

    def test_missing_or_corrupt_archive_rejected(self):
        self.records[self.base + "terminal.json"] = b"{}\n"
        with self.assertRaises(ValueError): self.validate()

    def test_native_drain_not_terminal_rejected(self):
        value = producer.decode(self.records[self.base + "backend-drain.json"])
        value["process_receipt"]["state"] = "ready"
        self.records[self.base + "backend-drain.json"] = producer.canonical(value)
        with self.assertRaises(ValueError): self.validate()

    def test_context_rejects_unknown_fields_and_crossed_env(self):
        context = {"environment": {producer.REQUEST_ENV: "terminal-observation/" + "a" * 64 + "/request.json",
                                  producer.REQUEST_SHA_ENV: "b" * 64},
                   "metadata": {"schema": producer.CONTEXT_SCHEMA, "proof_sha256": "a" * 64,
                                "request_sha256": "b" * 64, "stop_attempt": "c" * 32, "stop_sha256": "d" * 64}}
        self.assertEqual(producer.validate_context(context), context)
        context["metadata"]["native_restart"] = True
        with self.assertRaises(ValueError): producer.validate_context(context)


class HostWrapper(unittest.TestCase):
    setUp = EmptyStop.setUp
    def test_private_context_rebuilds_source_proof_without_native_action(self):
        import test_docker_terminal_observation_producer as original
        import docker_volume_accepted_reattach as existing
        original.ProducerTests.setUpClass()
        fixture = original.ProducerTests
        scope = fixture.scope
        current = copy.deepcopy(self.current)
        current["compose_project"] = scope["compose_project"]
        current["control_volume"] = scope["control_volume"]
        current["inputs"]["source_root"] = scope["source_root"]
        raw = producer.canonical(current) + b"\n"
        controls = dict(fixture.controls)
        controls.update(self.records)
        for relative in ("iteration/current.json", self.base + "terminal.json", self.base + "receipt.json"):
            controls[relative] = raw
        proof_raw = producer.canonical(fixture.expected) + b"\n"
        controls["verification/fixture-proof.json"] = proof_raw
        control = types.SimpleNamespace(project=scope["compose_project"], volume=scope["control_volume"])
        with mock.patch.object(existing, "_control_bytes", side_effect=lambda c, relative, **k: controls[relative]), \
             mock.patch.object(existing, "_read_store_regular", side_effect=lambda root, relative, *a, **k: fixture.records[relative]), \
             mock.patch.object(producer, "_publish_private_records") as publish:
            context = producer.prepare_context(
                control, proof_relative="verification/fixture-proof.json", proof_sha256=producer.sha(proof_raw),
                store_root=Path("/fixture"), source_root=scope["source_root"],
                attempt=self.old, config_sha256="d" * 64, actual=self.actual)
        self.assertEqual(context["metadata"]["proof_sha256"], producer.sha(proof_raw))
        self.assertEqual(publish.call_count, 1)
        self.assertEqual(publish.call_args.args[1][0][1], proof_raw)
        self.assertNotIn("native_restart_metadata", context)


class LeasedRevalidation(unittest.TestCase):
    setUp = EmptyStop.setUp

    def context(self):
        proof_raw = producer.canonical({"fixture": "immutable source proof"}) + b"\n"
        proof_sha = producer.sha(proof_raw)
        relative = "terminal-observation/" + proof_sha
        request_raw = producer.canonical({"schema": "fullmag.terminal-observation-request.v1",
                        "proof_path": relative + "/proof.json", "proof_sha256": proof_sha}) + b"\n"
        self.records["runtime-control/" + relative + "/proof.json"] = proof_raw
        self.records["runtime-control/" + relative + "/request.json"] = request_raw
        return {"environment": {producer.REQUEST_ENV: relative + "/request.json",
                                producer.REQUEST_SHA_ENV: producer.sha(request_raw)},
                "metadata": {"schema": producer.CONTEXT_SCHEMA, "proof_sha256": proof_sha,
                             "request_sha256": producer.sha(request_raw), "stop_attempt": self.token,
                             "stop_sha256": producer.sha(self.records[self.base + "terminal.json"])}}

    def execute(self, context):
        import docker_volume_accepted_reattach as existing
        reads = []
        def read(control, relative, **kwargs):
            reads.append(relative)
            return self.records[relative]
        before = copy.deepcopy(self.records)
        control = types.SimpleNamespace(project="fixture", volume="fixture-volume")
        with mock.patch.object(existing, "_control_bytes", side_effect=read), \
             mock.patch.object(producer, "_publish_private_records") as publish:
            try:
                producer.revalidate_context(control, context, source_root="/fixture/source",
                    attempt=self.old, config_sha256="d" * 64, actual=self.actual)
            finally:
                self.assertEqual(self.records, before)
                publish.assert_not_called()
                self.assertNotIn("iteration/current.json", reads)

    def test_current_pointer_may_belong_to_owned_recreate_operation(self):
        context = self.context()
        self.records["iteration/current.json"] = b'{"fixture":"new operation pointer"}\n'
        self.execute(context)

    def test_restart_then_stop_with_same_ids_is_rejected_before_mutation(self):
        context = self.context()
        for service_name in ("backend", "frontend"):
            with self.subTest(service=service_name):
                old = copy.deepcopy(self.actual)
                self.actual[service_name]["State"]["StartedAt"] = "restarted-and-stopped"
                with self.assertRaises(ValueError): self.execute(context)
                self.actual = old

    def test_changed_stopped_identity_config_mounts_or_running_rejected(self):
        context = self.context()
        for field, value in (("Id", "replacement"), ("Image", "sha256:" + "f" * 64),
                             ("Config", {"fixture": "changed"}), ("Mounts", [{"fixture": "changed"}])):
            with self.subTest(field=field):
                old = copy.deepcopy(self.actual)
                self.actual["backend"][field] = value
                with self.assertRaises(ValueError): self.execute(context)
                self.actual = old
        self.actual["frontend"]["State"]["Running"] = True
        with self.assertRaises(ValueError): self.execute(context)

    def test_stale_stop_or_private_cas_is_rejected_before_mutation(self):
        context = self.context()
        for relative in (self.base + "terminal.json",
                         "runtime-control/" + context["environment"][producer.REQUEST_ENV]):
            with self.subTest(relative=relative):
                before = dict(self.records)
                self.records[relative] = b'{"fixture":"changed"}\n'
                with self.assertRaises(ValueError): self.execute(context)
                self.records = before


if __name__ == "__main__":
    unittest.main()
