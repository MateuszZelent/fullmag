"""Fixture-only terminal observation exit checks; no Docker, native CLI or HTTP."""
import ast
from contextlib import ExitStack
import hashlib
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).parent
import test_docker_volume_idle_stop as existing
import docker_volume_dev as dev

TREE = ast.parse((ROOT / "docker_volume_dev.py").read_text())
RETAINED = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "_retained_operation")
START = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == "start")


def guard(*, recreate=False, restart=False, stop=False, fresh=False, proof=None, declared=True,
          failed=False, restart_backend=False):
    statements = []
    for n in RETAINED.body:
        if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in {
                "retained_terminal_observation", "terminal_observation_exit", "terminal_observation_failed_resume"} for t in n.targets):
            statements.append(n)
        if isinstance(n, ast.If) and any(isinstance(x, ast.Name) and x.id == "retained_terminal_observation"
                                         for x in ast.walk(n.test)):
            statements.append(n)
    assert len(statements) == 4
    env = {"document": {"services": {"backend": {"environment":
            {"FULLMAG_TERMINAL_OBSERVATION_REQUEST": "fixture/request.json"} if declared else {}}}},
           "restart_idle_service": restart, "stop_after_drain": stop, "recreate_services": recreate,
            "args": SimpleNamespace(fresh_state=fresh, terminal_observation_proof=proof, restart_backend=restart_backend),
           "previous": {"state": "failed-confirmed" if failed else "succeeded"},
           "refresh_frontend_service": False, "resume_recreation_id": None,
           "BuildControlError": dev.BuildControlError}
    exec(compile(ast.Module(body=statements, type_ignores=[]), "<candidate-exit-guard>", "exec"), env)
    return env["terminal_observation_exit"]


class ExitRoute(unittest.TestCase):
    def test_declared_terminal_observation_allows_stop_only_then_explicit_fresh(self):
        self.assertTrue(guard(restart=True, stop=True))
        self.assertTrue(guard(recreate=True, fresh=True))
        self.assertTrue(guard(restart=True))
        with self.assertRaises(dev.BuildControlError): guard(recreate=True)
        with self.assertRaises(dev.BuildControlError): guard()
        self.assertFalse(guard(declared=False))

    def test_only_failed_same_container_restart_may_reuse_retained_controls(self):
        self.assertFalse(guard(failed=True, restart_backend=True))
        for options in ({}, {"failed": True}, {"restart_backend": True},
                        {"failed": True, "restart_backend": True, "recreate": True}):
            with self.subTest(options=options), self.assertRaises(dev.BuildControlError):
                guard(**options)

    def test_exit_guard_runs_before_any_resume_dispatch(self):
        ids = {}
        for i, node in enumerate(RETAINED.body):
            if isinstance(node, ast.If) and any(isinstance(n, ast.Name) and n.id == "retained_terminal_observation"
                                               for n in ast.walk(node.test)):
                ids["guard"] = i
            if isinstance(node, ast.If) and isinstance(node.test, ast.Compare) and any(
                    isinstance(n, ast.Name) and n.id == "resume_recreation_id" for n in ast.walk(node.test)):
                ids["resume"] = i
        self.assertLess(ids["guard"], ids["resume"])

    def test_existing_fresh_handoff_selects_new_state_and_clears_restore_controls(self):
        reuse = next(n for n in ast.walk(RETAINED) if isinstance(n, ast.Assign) and any(
                    isinstance(t, ast.Name) and t.id == "reuse" for t in n.targets))
        env = {"fresh_state": True}
        exec(compile(ast.Module(body=[reuse], type_ignores=[]), "<fresh-state-handoff>", "exec"), env)
        self.assertIsNone(env["reuse"])
        clearing = next(n for n in ast.walk(START) if isinstance(n, ast.For)
                        and isinstance(n.iter, ast.Tuple)
                        and any(isinstance(e, ast.Constant) and e.value == "FULLMAG_TERMINAL_OBSERVATION_REQUEST"
                                for e in n.iter.elts))
        backend = {"environment": {"FULLMAG_TERMINAL_OBSERVATION_REQUEST": "old",
                    "FULLMAG_TERMINAL_OBSERVATION_REQUEST_SHA256": "old",
                    "FULLMAG_DEVELOPMENT_TERMINAL_OBSERVATION_STDIN": "1", "UNRELATED": "preserved"}}
        exec(compile(ast.Module(body=[clearing], type_ignores=[]), "<fresh-environment>", "exec"),
             {"backend": backend})
        self.assertEqual(backend["environment"], {"UNRELATED": "preserved"})
        archive = next(n for n in ast.walk(RETAINED) if isinstance(n, ast.If)
                       and isinstance(n.test, ast.Name) and n.test.id == "fresh_state"
                       and any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                               and c.func.id == "archive_runtime_control" for c in ast.walk(n)))
        self.assertTrue(any(isinstance(n, ast.keyword) and n.arg == "previous_state_root" for n in ast.walk(archive)))
        self.assertTrue(any(isinstance(n, ast.keyword) and n.arg == "removed_containers" for n in ast.walk(archive)))


class ManagedStop(unittest.TestCase):
    def fixture(self):
        fixture = existing.IdleStopFixture()
        fixture.environment.update({
            "FULLMAG_TERMINAL_OBSERVATION_REQUEST": "terminal-observation/" + "e" * 64 + "/request.json",
            "FULLMAG_TERMINAL_OBSERVATION_REQUEST_SHA256": "f" * 64})
        fixture.args.allow_prepared_session = True
        fixture.args.config_sha256 = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        original_text = fixture.text
        def text(*args, **kwargs):
            if args[:1] == ("exec",):
                return '{"status":"ok","active_session":true}'
            return original_text(*args, **kwargs)
        fixture.text = text
        return fixture

    def execute(self, fixture, drain, probe):
        # Reuse the repository fixture, replacing only its module-under-test.
        with patch.object(existing, "dev", dev):
            helpers = existing.DockerVolumeIdleStopTests()
            patchers = helpers._patches(fixture, drain)
            with ExitStack() as stack:
                entered = [stack.enter_context(p) for p in patchers]
                terminal = stack.enter_context(patch.object(dev, "_terminal_session_restart_probe", return_value=probe))
                dev.stop_idle(fixture.args)
                terminal.assert_called_once_with(existing.BACKEND_ID, allow_prepared=True)
                entered[-1].assert_not_called()  # _finish
                entered[-2].assert_not_called()  # recreate

    def test_failed_current_terminal_env_stops_without_restart_or_replay(self):
        fixture = self.fixture()
        proof = {"schema": "fullmag.docker-terminal-session-drain-preflight.v1",
                 "run": {"run_id": "fixture-failed-run", "status": "failed"},
                 "session_id": "fixture-session", "held_run_intent_sha256": {"fixture-held": "a" * 64}}
        self.execute(fixture, (b'{"state":"drained"}\n', {"state": "drained"}), proof)
        receipt = next(event[1] for event in fixture.events if event[0] == "exit")
        self.assertTrue(receipt["idle_backend_stopped"])
        self.assertEqual(receipt["state"], "succeeded")
        self.assertIn("terminal_session_preflight_sha256", receipt)
        self.assertTrue(fixture.backend_stopped and fixture.frontend_stopped)
        self.assertFalse(any(event[0] in {"start", "rm"} for event in fixture.events))

    def test_unknown_native_drain_retains_services_and_cannot_continue_to_fresh_start(self):
        fixture = self.fixture()
        with self.assertRaisesRegex(dev.BuildControlError, "native drain unknown"):
            self.execute(fixture, dev.BuildControlError("native drain unknown"),
                         {"schema": "fullmag.docker-terminal-session-drain-preflight.v1",
                          "run": {"run_id": "fixture-failed-run", "status": "failed"}})
        self.assertFalse(any(event[0] in {"start", "rm"} for event in fixture.events))
        self.assertFalse(any(event[0] == "exit" and event[1].get("state") == "succeeded"
                             for event in fixture.events))


class ManagedFailedResume(unittest.TestCase):
    def fixture(self):
        fixture = ManagedStop().fixture()
        fixture.previous["state"] = "failed-confirmed"
        fixture.backend_stopped = True
        fixture.frontend_stopped = True
        fixture.args.restart_backend = True
        fixture.args.port = 3203
        fixture.environment["FULLMAG_SOURCE_GIT_COMMON"] = "/fixture/git-common"
        fixture.environment["FULLMAG_TOOLCHAIN_IMAGE_ID"] = existing.IMAGE
        fixture.args.config_sha256 = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        return fixture

    def execute(self, fixture, prestart_error=None):
        import docker_volume_prestart_recovery as prestart
        unchanged = dev.canonical(fixture.document)
        starts = []
        def compose(document, *args, **kwargs):
            if args[:1] == ("start",):
                starts.append((args[1], existing.BACKEND_ID if args[1] == "backend" else existing.FRONTEND_ID))
                self.assertEqual(dev.canonical(document), unchanged)
                return b""
            return fixture.compose(document, *args, **kwargs)
        with patch.object(existing, "dev", dev):
            patchers = existing.DockerVolumeIdleStopTests()._patches(
                fixture, (b'{"state":"drained"}\n', {"state": "drained"}))
            with ExitStack() as stack:
                entered = [stack.enter_context(p) for p in patchers]
                stack.enter_context(patch.object(dev, "compose_capture", side_effect=compose))
                stack.enter_context(patch.object(dev, "_frontend"))
                new_start = stack.enter_context(patch.object(dev, "start"))
                native = stack.enter_context(patch.object(
                    prestart, "continuation", return_value=None, side_effect=prestart_error))
                try:
                    dev.resume(fixture.args)
                    native.assert_called_once()
                    entered[-1].assert_called_once()  # _finish verifies publication/admission
                finally:
                    new_start.assert_not_called()
                    entered[-2].assert_not_called()  # recreate
                    self.assertEqual(dev.canonical(fixture.document), unchanged)
                    self.assertFalse(any(event[0] in {"stop", "rm", "start"} for event in fixture.events))
        return starts

    def test_failed_compile_resume_starts_same_containers_and_preserves_proof_environment(self):
        fixture = self.fixture()
        before = dict(fixture.environment)
        starts = self.execute(fixture)
        self.assertEqual(starts, [("frontend", existing.FRONTEND_ID), ("backend", existing.BACKEND_ID)])
        self.assertEqual(fixture.environment, before)
        self.assertIn("FULLMAG_TERMINAL_OBSERVATION_REQUEST", fixture.environment)
        self.assertIn("FULLMAG_TERMINAL_OBSERVATION_REQUEST_SHA256", fixture.environment)

    def test_existing_native_prestart_refusal_prevents_any_service_start(self):
        fixture = self.fixture()
        with self.assertRaisesRegex(dev.BuildControlError, "native prestart refusal"):
            self.execute(fixture, dev.BuildControlError("native prestart refusal"))


class ManagedIdleRestart(unittest.TestCase):
    def fixture(self):
        fixture = ManagedStop().fixture()
        fixture.args.port = 3203
        fixture.environment["FULLMAG_TOOLCHAIN_IMAGE_ID"] = existing.IMAGE
        fixture.document["services"]["backend"]["volumes"] = [
            {"target": "/opt/fullmag/source-git", "source": "/fixture/source-git"}]
        fixture.args.config_sha256 = hashlib.sha256(dev.canonical(fixture.document)).hexdigest()
        original_capture = fixture.capture
        def capture(*args, **kwargs):
            if args[0] == "start":
                fixture.events.append(("start", args[1:]))
                if args[1] == existing.BACKEND_ID:
                    fixture.backend_stopped = False
                elif args[1] == existing.FRONTEND_ID:
                    fixture.frontend_stopped = False
                else:
                    raise AssertionError("restart must use an existing service identifier")
                return SimpleNamespace(stdout=b"", stderr=b"", returncode=0)
            return original_capture(*args, **kwargs)
        fixture.capture = capture
        return fixture

    def execute(self, fixture, *, drain_error=None, probe_error=None):
        before = dev.canonical(fixture.document)
        proof = {"schema": "fullmag.docker-terminal-session-drain-preflight.v1",
                 "run": {"run_id": "fixture-failed-run", "status": "failed"},
                 "session_id": "fixture-session"}
        drain = drain_error or (b'{"state":"drained"}\n', {"state": "drained"})
        with patch.object(existing, "dev", dev):
            patchers = existing.DockerVolumeIdleStopTests()._patches(fixture, drain)
            with ExitStack() as stack:
                entered = [stack.enter_context(p) for p in patchers]
                terminal = stack.enter_context(patch.object(
                    dev, "_terminal_session_restart_probe", return_value=proof, side_effect=probe_error))
                new_start = stack.enter_context(patch.object(dev, "start"))
                try:
                    dev.restart_idle(fixture.args)
                    terminal.assert_called_once_with(existing.BACKEND_ID, allow_prepared=True)
                    entered[-1].assert_called_once()
                finally:
                    self.assertEqual(dev.canonical(fixture.document), before)
                    new_start.assert_not_called()
                    entered[-2].assert_not_called()
                    self.assertFalse(any(event[0] == "rm" for event in fixture.events))

    def test_healthy_failed_observation_restarts_same_ids_without_dropping_proof(self):
        fixture = self.fixture()
        before = dict(fixture.environment)
        self.execute(fixture)
        self.assertEqual([event[1][0] for event in fixture.events if event[0] == "start"],
                         [existing.BACKEND_ID, existing.FRONTEND_ID])
        self.assertEqual(fixture.environment, before)
        writes = [event[1] for event in fixture.events if event[0] == "write"]
        self.assertTrue(any(path.endswith("/terminal-session-preflight.json") for path in writes))
        self.assertTrue(any(path.endswith("/backend-drain.json") for path in writes))

    def test_native_drain_refusal_prevents_restart(self):
        fixture = self.fixture()
        with self.assertRaisesRegex(dev.BuildControlError, "native drain unknown"):
            self.execute(fixture, drain_error=dev.BuildControlError("native drain unknown"))
        self.assertFalse(any(event[0] == "start" for event in fixture.events))

    def test_nonterminal_current_probe_refusal_prevents_backend_stop_and_restart(self):
        fixture = self.fixture()
        with self.assertRaisesRegex(dev.BuildControlError, "current run is active"):
            self.execute(fixture, probe_error=dev.BuildControlError("current run is active"))
        # Existing preflight failure handling may restore the frontend.
        self.assertFalse(any(event[0] == "start" and event[1][0] == existing.BACKEND_ID
                             for event in fixture.events))
        self.assertFalse(fixture.backend_stopped)

    def test_unhealthy_backend_is_rejected_before_any_service_stop(self):
        fixture = self.fixture()
        original_actual = fixture.actual
        def actual(service):
            value = original_actual(service)
            if service == "backend":
                value["State"]["Health"]["Status"] = "unhealthy"
            return value
        fixture.actual = actual
        with self.assertRaisesRegex(dev.BuildControlError, "healthy backend"):
            self.execute(fixture)
        self.assertFalse(any(event[0] in {"stop", "start"} for event in fixture.events))


if __name__ == "__main__":
    unittest.main()
