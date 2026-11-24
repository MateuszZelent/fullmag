"""Interpreted finish sequencing and refusal regressions; no Docker lifecycle."""
from contextlib import contextmanager
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import ast
import json
import shlex
import unittest
from unittest.mock import Mock, patch

from docker_build_control import BuildControlError
import docker_group_ledger_finish_host as finish


def context_fixture():
    return {"terminal": {"package_receipt_sha256": "a" * 64}, "original": {"records": {"config": {"sha256": "c" * 64}}},
        "backend": {"Id": "b" * 64, "State": {"Running": False}},
        "frontend": {"Id": "f" * 64, "State": {"Running": False}},
        "reuse": {"state": Path("/retained/state"), "host_certificate": Path("/retained/state/cert.json"),
            "owner_marker": Path("/retained/state/owner.json"), "receipt": {"image_id": "sha256:" + "0" * 64}},
        "device_access": "cpu", "gpu_access": "disabled", "include_untracked": ["crates/new.rs"],
        "relocation": {"request": {"source_volume": "old-ledger", "control_volume": "own-control"}},
        "old_document": {"services": {"frontend": {"ports": [{"target": 8080, "published": "3203", "host_ip": "127.0.0.1"}]}}}}


class FinishTests(unittest.TestCase):
    def test_standard_parser_preserves_port_device_allowlist_and_never_replays_script(self):
        args = SimpleNamespace(repo_root=Path("/repo"), source_root=Path("/source"))
        context = context_fixture()
        parsed = finish.start_arguments(args, context)
        self.assertEqual(parsed.action, "up")
        self.assertEqual(parsed.port, 3203)
        self.assertEqual(parsed.gpu_access, "disabled")
        self.assertEqual(parsed.include_untracked, ["crates/new.rs"])
        self.assertIsNone(parsed.script)
        self.assertIsNone(parsed.source_manifest)
        self.assertFalse(parsed.migrate_host_capacity)
        for ports in ([], [{"target": 8080, "published": 3203, "host_ip": "0.0.0.0"}]):
            context["old_document"]["services"]["frontend"]["ports"] = ports
            with self.assertRaisesRegex(BuildControlError, "loopback port"):
                finish.start_arguments(args, context)

    def test_unknown_created_nf_tombstone_is_refused_not_ignored_or_removed(self):
        context = context_fixture()
        control = SimpleNamespace(project="own")
        own = [context[key]["Id"] for key in ("backend", "frontend")]
        capture = lambda *args: SimpleNamespace(stdout=("\n".join(own + ["n" * 64])).encode())
        with patch.object(finish.common, "docker_capture", side_effect=capture), patch.object(finish.relocation, "_live_consumers") as consumers:
            with self.assertRaisesRegex(BuildControlError, "unknown service/helper"):
                finish.no_extra_services(control, context)
            consumers.assert_not_called()

    def test_exact_service_set_still_requires_no_running_ledger_consumers(self):
        context = context_fixture()
        control = SimpleNamespace(project="own")
        own = [context[key]["Id"] for key in ("backend", "frontend")]
        capture = lambda *args: SimpleNamespace(stdout=("\n".join(own)).encode())
        foreign = [{"Id": "active", "State": {"Running": True}, "Mounts": [{"Type": "volume", "Name": "old-ledger"}]}]
        with patch.object(finish.common, "docker_capture", side_effect=capture), patch.object(finish.relocation, "_live_consumers", return_value=foreign):
            with self.assertRaisesRegex(BuildControlError, "active consumer"):
                finish.no_extra_services(control, context)

    def test_failed_or_foreign_promotion_refuses_before_container_observation(self):
        args = SimpleNamespace(promotion_attempt="a" * 32, promotion_sha256="b" * 64, image_id="sha256:" + "c" * 64)
        control = SimpleNamespace(project="own", volume="own-control")
        with patch.object(finish, "record", return_value={"state": "failed-confirmed"}), patch.object(finish.common, "container") as inspect:
            with self.assertRaisesRegex(BuildControlError, "terminal authority"):
                finish.authority(control, args, Path("/source"), {})
            inspect.assert_not_called()

    def exercise(self, *, apply=True, drift=False, native_failure=False, completed=False):
        context = context_fixture()
        if completed:
            context["completed_finish"] = {"pins": {"completed_finish": "7" * 32}}
        args = SimpleNamespace(repo_root=Path(__file__).resolve().parents[1], source_root=Path("/source"), promotion_attempt="a" * 32,
            promotion_sha256="b" * 64, image_id="sha256:" + "c" * 64, apply=apply)
        control = SimpleNamespace(identity={}, project="own", volume="own-control", prepare=Mock(), write=Mock(), write_bytes=Mock())
        operation = {"root": "group-ledger-finish/attempts/" + "1" * 32, "helper_container_id": "h" * 64,
            "receipt": {}, "daemon_pending": False}
        lease = {"held": False}
        @contextmanager
        def owned(*args):
            lease["held"] = True
            yield operation
            lease["held"] = False
        control.operation = owned
        events = []
        def capture(*argv):
            if argv[0] == "rm":
                self.assertTrue(lease["held"])
                self.assertEqual(set(argv[1:]), {"b" * 64, "f" * 64})
                self.assertFalse("--force" in argv or "--volumes" in argv)
                self.assertEqual(control.write.call_count, 2)
                self.assertEqual(control.write_bytes.call_count, 2)
                events.append("remove")
            return SimpleNamespace(stdout=b"logs", stderr=b"")
        def start(parsed, **kwargs):
            self.assertFalse(lease["held"])
            self.assertEqual(events, [] if completed else ["remove"])
            self.assertEqual(kwargs, {"reuse_state": context["reuse"], "previous_config_sha256": "c" * 64, "retained_device_access": "cpu"})
            self.assertIsNone(parsed.script)
            events.append("start")
            return {"state": "canonical-start"}
        observations = [context, deepcopy(context), deepcopy(context)]
        if drift:
            observations[-1]["backend"]["Id"] = "e" * 64
        with patch.object(finish.common, "require_host"), patch.object(finish.common, "_select_source", return_value=(Path("/source"), {})), \
                patch.object(finish.common, "_compose_identity", return_value={}), patch.object(finish.common, "BuildControl", return_value=control), \
                patch.object(finish, "authority", side_effect=observations), patch.object(finish, "no_extra_services"), \
                patch.object(finish, "native_preflight", side_effect=BuildControlError("native refusal") if native_failure else lambda *_: {"state": "drained"}), \
                patch.object(finish.common, "docker_capture", side_effect=capture) as docker, patch.object(finish.development, "start", side_effect=start) as canonical:
            if drift or native_failure:
                with self.assertRaises(BuildControlError): finish.run(args)
                canonical.assert_not_called()
                self.assertFalse(any(call.args[0] == "rm" for call in docker.call_args_list))
            elif not apply:
                result = finish.run(args)
                self.assertFalse(result["apply"])
                control.prepare.assert_not_called()
                docker.assert_not_called()
                canonical.assert_not_called()
            else:
                self.assertEqual(finish.run(args), {"state": "canonical-start"})
                self.assertEqual(events, ["start"] if completed else ["remove", "start"])
                self.assertEqual(operation["receipt"]["state"], "succeeded")
                self.assertFalse(operation["receipt"]["solve_started"])

    def test_completed_finish_continuation_never_logs_or_removes_absent_services(self): self.exercise(completed=True)

    def test_preview_never_removes_or_starts(self): self.exercise(apply=False)
    def test_apply_archives_before_exact_controlled_removal_then_uses_normal_start(self): self.exercise()
    def test_boundary_incarnation_drift_prevents_removal(self): self.exercise(drift=True)
    def test_native_refusal_prevents_removal(self): self.exercise(native_failure=True)

    def test_guest_preflight_calls_existing_drain_authenticator_and_ro_native_preview(self):
        context = context_fixture()
        context["original"]["records"] = {name: {"path": "/opt/fullmag/control/" + name, "sha256": "c" * 64} for name in ("process", "owner", "config")}
        context["bootstrap"] = {"source": "a" * 40, "source_snapshot_sha256": "d" * 64}
        context["terminal"]["relocation_receipt"] = "group-ledger-relocation/attempts/" + "e" * 32 + "/relocation.json"
        expected = {"schema_version": finish.relocation.INSPECTION, "host_id": "f" * 64}
        context["relocation"]["request"].update(expected_inspection=expected, native_program={}, host_id="f" * 64)
        control = SimpleNamespace(read_bytes=lambda _: finish.common.canonical(expected), path=lambda value: "/control/" + value)
        commands = []
        def helper(_, request, command, **options):
            self.assertTrue(options["target"])
            commands.append(command)
            return [command]
        responses = [SimpleNamespace(returncode=0, stdout=b'{"state":"drained","config_sha256":"' + b'c' * 64 + b'"}', stderr=b""),
            SimpleNamespace(returncode=0, stdout=json.dumps({"status": "verified", "inspection": expected}).encode(), stderr=b"")]
        with patch.object(finish.relocation, "_helper", side_effect=helper), patch.object(finish.relocation, "bounded_capture", side_effect=responses):
            finish.native_preflight(control, context)
        code = shlex.split(commands[0])[3]
        compile(code, "finish-native-preflight", "exec")
        calls = {node.func.attr for node in ast.walk(ast.parse(code)) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertIn("_authenticated_terminal_drain", calls)
        self.assertIn("_read_authenticated_terminal_drain", calls)
        self.assertIn("_validated_package", calls)
        self.assertFalse(calls & {"initialize_host_configuration", "ensure_configuration", "prepare_storage", "_serve", "_rotate_package"})
        self.assertIn("ledger-relocation-preview", commands[1])
        self.assertIn("published", commands[1])


if __name__ == "__main__":
    unittest.main()
