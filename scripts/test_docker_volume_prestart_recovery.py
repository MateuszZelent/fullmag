"""Offline tests; no Docker, sockets, source mutation, or compiled tests."""
import copy
import hashlib
import json
from pathlib import Path
import re
import types
import unittest
from unittest.mock import patch
from docker_build_control import BuildControlError, canonical
import docker_volume_prestart_recovery as recovery
import docker_volume_reconcile as original

ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / "docs/superpowers/plans/2026-10-23-oci-prestart-recovery-proposal.patch.txt"


def proposed_sources():
    result = {}
    sections = re.split(r"(?m)^--- a/", PATCH.read_text())[1:]
    if hasattr(original, "PRESTART_SCHEMA"):
        return {section.split("\n", 1)[0]: (ROOT / section.split("\n", 1)[0]).read_text()
                for section in sections}
    for section in sections:
        name, rest = section.split("\n", 1)
        lines = (ROOT / name).read_text().splitlines(keepends=True)
        out, cursor = [], 0
        for hunk in re.split(r"(?m)^@@ ", rest)[1:]:
            header, body = hunk.split("\n", 1)
            start = int(re.match(r"-(\d+)", header).group(1)) - 1
            out.extend(lines[cursor:start]); cursor = start
            for row in body.splitlines(keepends=True):
                if row.startswith((" ", "-")):
                    if lines[cursor] != row[1:]:
                        raise AssertionError("Proposal source changed: " + name)
                    cursor += 1
                if row.startswith((" ", "+")):
                    out.append(row[1:])
        out.extend(lines[cursor:]); result[name] = "".join(out)
    return result


class PrestartRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = proposed_sources()
        cls.controller = types.ModuleType("proposal_reconcile")
        cls.controller.__file__ = str(ROOT / "scripts/docker_volume_reconcile.py")
        exec(compile(cls.sources["scripts/docker_volume_reconcile.py"], cls.controller.__file__, "exec"), cls.controller.__dict__)

    def setUp(self):
        self.process = patch("subprocess.Popen", side_effect=AssertionError("offline: subprocess forbidden"))
        self.network = patch("socket.socket", side_effect=AssertionError("offline: network forbidden"))
        self.process.start(); self.network.start()
        self.addCleanup(self.process.stop); self.addCleanup(self.network.stop)
        state = dict(Status="exited", Pid=0, Running=False, Paused=False, Restarting=False,
                     OOMKilled=False, Dead=False, ExitCode=0, Error="", StartedAt="old", FinishedAt="stop")
        self.actual = {name: {"State": copy.deepcopy(state)} for name in ("backend", "frontend")}
        self.actual["backend"]["State"].update(ExitCode=128, Error="error running prestart hook #0: nvidia-container-cli: ldcache error: process /sbin/ldconfig terminated with signal 9")
        self.proof = {key: "a" * 64 for key in ("checkpoint_sha256", "drain_sha256", "preflight_sha256")}
        self.repin()

    def repin(self):
        for name in self.actual:
            self.proof[name + "_state_sha256"] = original.digest(canonical(self.actual[name]["State"]))
        self.proof["error_sha256"] = original.digest(self.actual["backend"]["State"]["Error"].encode())

    def test_exact_stopped_hook_failure(self):
        recovery.validate_stopped_states(self.actual, self.proof)

    def test_state_digest_mismatch(self):
        self.actual["backend"]["State"]["FinishedAt"] = "changed"
        with self.assertRaises(BuildControlError): recovery.validate_stopped_states(self.actual, self.proof)

    def test_recomputed_pins_do_not_authorize_running_or_oom(self):
        for field, value in (("Pid", 1), ("Running", True), ("OOMKilled", True), ("Dead", True), ("Paused", True), ("Restarting", True), ("ExitCode", 2), ("Status", "created")):
            with self.subTest(field=field):
                actual = copy.deepcopy(self.actual); actual["backend"]["State"][field] = value
                proof = dict(self.proof); proof["backend_state_sha256"] = original.digest(canonical(actual["backend"]["State"]))
                with self.assertRaises(BuildControlError): recovery.validate_stopped_states(actual, proof)

    def test_wrong_hook_is_refused_even_with_recomputed_hash(self):
        self.actual["backend"]["State"]["Error"] = "permission denied"
        self.repin()
        with self.assertRaises(BuildControlError): recovery.validate_stopped_states(self.actual, self.proof)

    def test_frontend_failure_refused(self):
        self.actual["frontend"]["State"]["ExitCode"] = 137
        self.repin()
        with self.assertRaises(BuildControlError): recovery.validate_stopped_states(self.actual, self.proof)

    def test_missing_pin_refused(self):
        del self.proof["preflight_sha256"]
        with self.assertRaises(BuildControlError): recovery.validate_stopped_states(self.actual, self.proof)

    def failure_fixture(self):
        from contextlib import ExitStack
        import docker_volume_dev as dev
        import docker_volume_stop_unadmitted as stop
        stack = ExitStack(); self.addCleanup(stack.close)
        checkpoint = {"archive": {"sha256": "archive"}, "containers": {"backend": {}, "frontend": {}}}
        current_raw = b'{"state":"drained"}'
        current = json.loads(current_raw)
        drain = {"schema": "fullmag.docker-idle-restart-drain.v1", "backend_container_id": "backend",
                 "process_receipt_sha256": original.digest(current_raw), "process_receipt": current}
        probe = {"process_receipt": {"service_owner": "mock-owner"}}
        docs = {"saved-authoring-checkpoint.json": canonical(checkpoint), "backend-drain.json": canonical(drain),
                "saved-authoring-final-preflight.json": canonical(probe)}
        proof = dict(self.proof)
        for key, filename in (("checkpoint", "saved-authoring-checkpoint.json"), ("drain", "backend-drain.json"), ("preflight", "saved-authoring-final-preflight.json")):
            proof[key+"_sha256"] = original.digest(docs[filename])
        checkpoint["containers"]["backend"] = {"id":"backend"}
        docs["saved-authoring-checkpoint.json"] = canonical(checkpoint)
        proof["checkpoint_sha256"] = original.digest(docs["saved-authoring-checkpoint.json"])
        request = {"failure": proof, "prestart_helper_sha256": original.digest(Path(recovery.__file__).read_bytes()),
                   "config_sha256": "config", "source_root": "/repo", "containers": checkpoint["containers"]}
        prior = {"inputs": {"attempt":"base", "saved_authoring_checkpoint_sha256": proof["checkpoint_sha256"]},
                 "saved_authoring_restore_required": checkpoint["archive"]}
        stack.enter_context(patch.object(original,"read_raw",side_effect=lambda control,path,**kw: docs.get(path.split("/")[-1])))
        terminal = stack.enter_context(patch.object(stop,"_read_terminal_process_receipt",return_value=(current_raw,current)))
        delegates = {name: stack.enter_context(patch.object(dev,name)) for name in
            ("_saved_authoring_validate_request", "_saved_authoring_validate_drain", "_saved_authoring_verify_retained_history", "_saved_authoring_read_archive")}
        return types.SimpleNamespace(project="group"), request, prior, docs, terminal, delegates

    def test_failure_delegates_native_drain_history_archive(self):
        control, request, prior, docs, terminal, delegates = self.failure_fixture()
        self.assertEqual(recovery.validate_failure(control,"root",request,prior,self.actual,Path("/state")),request["failure"])
        terminal.assert_called_once()
        for delegate in delegates.values(): delegate.assert_called_once()

    def test_changed_checkpoint_rejected_before_native_read(self):
        control, request, prior, docs, terminal, delegates = self.failure_fixture()
        docs["saved-authoring-checkpoint.json"] += b" "
        with self.assertRaises(BuildControlError): recovery.validate_failure(control,"root",request,prior,self.actual,Path("/state"))
        terminal.assert_not_called()

    def test_changed_native_receipt_rejected(self):
        control, request, prior, docs, terminal, delegates = self.failure_fixture()
        terminal.return_value = (b"changed", {"state":"running"})
        with self.assertRaises(BuildControlError): recovery.validate_failure(control,"root",request,prior,self.actual,Path("/state"))

    def test_archive_or_history_or_owner_refusal_propagates(self):
        control, request, prior, docs, terminal, delegates = self.failure_fixture()
        for name in ("_saved_authoring_validate_drain", "_saved_authoring_verify_retained_history", "_saved_authoring_read_archive"):
            with self.subTest(name=name):
                delegates[name].side_effect = BuildControlError("changed")
                with self.assertRaises(BuildControlError): recovery.validate_failure(control,"root",request,prior,self.actual,Path("/state"))
                delegates[name].side_effect = None

    def test_new_backend_generation_refused(self):
        control, request, prior, docs, terminal, delegates = self.failure_fixture()
        prior["backend_started_at"] = "new"
        with self.assertRaises(BuildControlError): recovery.validate_failure(control,"root",request,prior,self.actual,Path("/state"))

    def test_prestart_claim_uses_failure_only_publication_targets(self):
        control = types.SimpleNamespace(path=lambda value: "/control/" + value)
        for schema in (recovery.SCHEMA, original.FAILED_BUILD_SCHEMA):
            with self.subTest(schema=schema):
                request = {"schema": schema, "attempt": "a"*32,
                           "unknown_receipt_sha256": "b"*64}
                script = self.controller.claim_script(control, "iteration/attempts/" + "a"*32,
                    request, "b"*64, publish_verified=False)
                self.assertIn("terminal.json", script)
                self.assertIn("iteration/current.json", script)
                self.assertNotIn("verified.json", script)
                self.assertNotIn("rm ", script)

    def test_unrecognized_iteration_failure_schema_is_rejected(self):
        control = types.SimpleNamespace(path=lambda value: "/control/" + value)
        for schema in (original.SCHEMA, original.ACTIVATION_PREFLIGHT_SCHEMA, "unknown"):
            with self.subTest(schema=schema), self.assertRaises(BuildControlError):
                self.controller.claim_script(control, "iteration/attempts/" + "a"*32,
                    {"schema": schema, "attempt": "a"*32, "unknown_receipt_sha256": "b"*64},
                    "b"*64, publish_verified=False)

    def test_legacy_continuation_noop(self):
        self.assertIsNone(recovery.continuation(None, types.SimpleNamespace(), {}, {}, {}, None))

    def test_partial_continuation_pin_refused(self):
        with self.assertRaises(BuildControlError):
            recovery.continuation(None, types.SimpleNamespace(prestart_reconciliation="a"*32), {}, {}, {}, None)

    def test_proposed_python_sources_parse_without_application(self):
        for name, source in self.sources.items():
            if name.endswith(".py"): compile(source, name, "exec")

    def test_exact_schema_and_legacy_failed_build_remain_separate(self):
        pin = dict(id="a"*64, image="sha256:"+"a"*64, started_at="old", fingerprint="a"*64)
        request = dict(schema=recovery.SCHEMA, attempt="a"*32, compose_project="group", source_root="/repo", port=3203,
            config_sha256="a"*64, unknown_receipt_sha256="a"*64, controller_sha256="a"*64,
            prestart_helper_sha256="a"*64, containers={name: dict(pin,id=char*64) for name,char in (("lease","a"),("backend","b"),("frontend","c"))}, failure=self.proof)
        self.controller.validate_request(request)
        request["schema"] = original.FAILED_BUILD_SCHEMA
        del request["prestart_helper_sha256"]
        with self.assertRaises(BuildControlError): self.controller.validate_request(request)

    def test_inspection_requires_lease_live_but_both_services_stopped(self):
        seen = []
        request = {"schema": recovery.SCHEMA, "compose_project": "group", "containers": {name:{"id":name} for name in ("lease","backend","frontend")}}
        def capture(*args): return types.SimpleNamespace(stdout=b"[{}]")
        with patch.object(self.controller, "docker_capture", side_effect=capture), patch.object(self.controller, "validate_incarnation", side_effect=lambda actual,pin,project,**kw: seen.append((pin["id"],kw["running"]))):
            self.controller.inspect_pins(request)
        self.assertEqual(seen, [("lease",True),("backend",False),("frontend",False)])


if __name__ == "__main__": unittest.main()
