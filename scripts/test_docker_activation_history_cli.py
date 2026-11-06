"""Boundary and orchestration tests for managed activation-history archiving."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_activation_history as history
from docker_activation_history_policy import HistoryError, canonical, digest
from docker_build_control import BuildControl as ActualBuildControl, BuildControlError


ATTEMPT = "a" * 32
PLAN_SHA = "b" * 64
BACKEND_IMAGE = "sha256:" + "c" * 64
HELPER_IMAGE = "sha256:" + "d" * 64


def _args(*, apply=False, plan_sha256="", activation=ATTEMPT):
    return types.SimpleNamespace(
        repo_root=Path("/repo"), source_root=Path("/selected"),
        activation=activation, apply=apply, plan_sha256=plan_sha256,
    )


class AuthoredZarrTests(unittest.TestCase):
    def test_accepts_one_canonical_literal_user_data_zarr(self):
        authored = b'study.storage(output_dir="/user-data/scan.zarr")\n'
        self.assertEqual(str(history.authored_zarr(authored)), "/user-data/scan.zarr")

    def test_accepts_nested_canonical_literal_user_data_zarr(self):
        authored = b'study.storage(output_dir="/user-data/nested/scan.zarr")\n'
        self.assertEqual(str(history.authored_zarr(authored)), "/user-data/nested/scan.zarr")

    def test_rejects_expression_traversal_and_multiple_targets(self):
        cases = (
            b'study.storage(output_dir="/user-data/" + "scan.zarr")\n',
            b'study.storage(output_dir="/user-data/../scan.zarr")\n',
            (b'study.storage(output_dir="/user-data/one.zarr")\n'
             b'study.storage(output_dir="/user-data/two.zarr")\n'),
            (b'study.storage(output_dir="/user-data/one.zarr")\n'
             b'study.storage(output_dir=selected_output)\n'),
        )
        for source in cases:
            with self.subTest(source=source), self.assertRaises(HistoryError):
                history.authored_zarr(source)


class ActivationHistoryShellBoundaryTests(unittest.TestCase):
    def dispatch(self, recipe):
        source = (Path(__file__).resolve().parent / "just_storage_shell.sh").read_text(encoding="utf-8")
        body = source.split('  *"scripts/docker_activation_history.py"*)\n', 1)[1].split("\n    ;;", 1)[0]
        with tempfile.TemporaryDirectory(prefix="fullmag-history-shell-") as directory:
            script_dir = Path(directory)
            (script_dir / "docker_activation_history.py").write_text(
                "import json,sys; print(json.dumps(sys.argv[1:]))\n", encoding="utf-8")
            environment = dict(os.environ, RECIPE_LITERAL=recipe, FIXED_PYTHON=sys.executable,
                               FIXED_SCRIPT_DIR=str(script_dir))
            program = ("set -euo pipefail\nrecipe=\"$RECIPE_LITERAL\"\n"
                       "python_cmd=\"$FIXED_PYTHON\"\nscript_dir=\"$FIXED_SCRIPT_DIR\"\n" + body)
            bash = "/bin/bash" if os.name == "posix" else (shutil.which("bash") or "bash")
            return subprocess.run([bash, "--noprofile", "--norc", "-c", program],
                                  env=environment, capture_output=True, text=True, timeout=15)

    def test_preview_and_apply_dispatch_exact_fixed_argv_with_literal_source_path(self):
        source_root = "/selected/$(printf literal); & worktree"
        recipe = ('python "/ignored/scripts/docker_activation_history.py" '
                  f'--repo-root "/repo with spaces" --source-root \'{source_root}\' '
                  f"--activation '{ATTEMPT}'")
        preview = self.dispatch(recipe)
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertEqual(json.loads(preview.stdout), [
            "--repo-root", "/repo with spaces", "--source-root", source_root,
            "--activation", ATTEMPT,
        ])

        apply_recipe = recipe + f" --apply --plan-sha256 '{PLAN_SHA}'"
        applied = self.dispatch(apply_recipe)
        self.assertEqual(applied.returncode, 0, applied.stderr)
        self.assertEqual(json.loads(applied.stdout), [
            "--repo-root", "/repo with spaces", "--source-root", source_root,
            "--activation", ATTEMPT, "--apply", "--plan-sha256", PLAN_SHA,
        ])

    def test_rejects_extra_syntax_bad_activation_bad_plan_and_missing_pins(self):
        valid = ('python "/ignored/scripts/docker_activation_history.py" '
                 '--repo-root "/repo" --source-root \'/selected\' '
                 f"--activation '{ATTEMPT}'")
        invalid = (
            valid + "; printf injected",
            valid.replace(ATTEMPT, "A" * 32),
            valid + " --unexpected",
            valid + " --apply",
            valid + " --apply --plan-sha256 'not-a-digest'",
        )
        for recipe in invalid:
            with self.subTest(recipe=recipe):
                result = self.dispatch(recipe)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(result.stdout.strip())


class _FixtureBuildControl:
    """A no-Docker fixture that runs the real BuildControl.helper_args method."""

    helper_args = ActualBuildControl.helper_args
    _namespace_guard = ActualBuildControl._namespace_guard

    def __init__(self, identity, image):
        self.identity = dict(identity)
        self.project = identity["project_name"]
        self.image = image
        self.volume = "fullmag-control-" + self.project
        self.namespace = "namespaces/" + "e" * 32
        self.namespace_registry_sha256 = "f" * 64
        self.labels = {
            "org.fullmag.build-control.schema": "fullmag.build-control.v1",
            "org.fullmag.compose.project": self.project,
            "org.fullmag.source.worktree-id": identity["worktree_id"],
            "org.fullmag.build.role": "control",
            "com.fullmag.compose.project": self.project,
            "com.fullmag.toolchain.control.schema": "fullmag.docker-toolchain-control.v1",
            "com.fullmag.toolchain.control.project": self.project,
            "com.fullmag.toolchain.control.mount": "/opt/fullmag/control",
        }


class _FixtureReadOnlyBuildControl(_FixtureBuildControl):
    def helper_args(self, script, *, name=None, initialize=False):
        args = ActualBuildControl.helper_args(self, script, name=name, initialize=initialize)
        for index, value in enumerate(args[:-1]):
            if value == "--mount" and ",dst=/control," in args[index + 1]:
                args[index + 1] += ",readonly"
        return args


def _identity():
    return {
        "project_name": "fullmag-history-test",
        "project_id": "project-test",
        "worktree_id": "worktree-test",
        "checkout_kind": "worktree",
    }


class ActivationHistoryHelperArgsTests(unittest.TestCase):
    def setUp(self):
        self.identity = _identity()
        self.control = _FixtureBuildControl(self.identity, HELPER_IMAGE)
        self.selected = Path("/selected/$(printf literal); worktree")
        self.store = Path("/user-data/session-store")
        self.output = Path("/user-data")

    def helper_args(self, action):
        with mock.patch.object(history, "ReadOnlyBuildControl", _FixtureReadOnlyBuildControl), \
             mock.patch.object(history.uuid, "uuid4", return_value=types.SimpleNamespace(hex="fixed")), \
             mock.patch("docker_build_control.docker_argv", return_value=["docker", "run"]):
            return history.helper_args(self.control, self.selected, BACKEND_IMAGE,
                                       self.store, self.output, action=action)

    @staticmethod
    def without_expected_bind_changes(args, *, preview):
        normalized = list(args)
        index = 0
        while index < len(normalized):
            if normalized[index] == "--mount" and index + 1 < len(normalized):
                mount = normalized[index + 1]
                if any(target in mount for target in (",dst=/opt/fullmag/source,readonly",
                                                       ",dst=/history-store,readonly",
                                                       ",dst=/history-output,readonly")):
                    del normalized[index:index + 2]
                    continue
            if normalized[index] == "--memory":
                normalized[index + 1] = "64m"
            if (preview and normalized[index] == "--mount"
                    and ",dst=/control," in normalized[index + 1]
                    and normalized[index + 1].endswith(",readonly")):
                normalized[index + 1] = normalized[index + 1][:-len(",readonly")]
            index += 1
        return normalized

    def test_preserves_real_helper_security_flags_and_scopes_readonly_inputs(self):
        command = ("/usr/local/bin/python3 -B /opt/fullmag/source/scripts/"
                   "docker_activation_history.py --guest")
        with mock.patch("docker_build_control.docker_argv", return_value=["docker", "run"]):
            baseline = ActualBuildControl.helper_args(
                _FixtureBuildControl(self.identity, BACKEND_IMAGE), command,
                name="fullmag-history-fixed")

        for action in ("preview", "apply"):
            args = self.helper_args(action)
            self.assertEqual(self.without_expected_bind_changes(args, preview=action == "preview"), baseline)
            self.assertEqual(args[args.index("--memory") + 1], "256m")
            binds = [args[index + 1] for index, value in enumerate(args[:-1])
                     if value == "--mount" and ",dst=/opt/fullmag/source," in args[index + 1]
                     or value == "--mount" and any(target in args[index + 1] for target in (
                         ",dst=/history-store,", ",dst=/history-output,"))]
            self.assertEqual(set(binds), {
                "type=bind,src=" + str(self.selected) + ",dst=/opt/fullmag/source,readonly",
                "type=bind,src=" + str(self.store) + ",dst=/history-store,readonly",
                "type=bind,src=" + str(self.output) + ",dst=/history-output,readonly",
            })
            control_mounts = [args[index + 1] for index, value in enumerate(args[:-1])
                              if value == "--mount" and ",dst=/control," in args[index + 1]]
            self.assertEqual(len(control_mounts), 1)
            self.assertEqual(control_mounts[0].endswith(",readonly"), action == "preview")

    def test_refuses_control_group_or_namespace_identity_mismatch(self):
        with mock.patch.object(history, "ReadOnlyBuildControl", _FixtureReadOnlyBuildControl):
            for field, value in (("volume", "foreign-control"),
                                 ("namespace", "namespaces/" + "1" * 32),
                                 ("namespace_registry_sha256", "2" * 64)):
                control = _FixtureBuildControl(self.identity, HELPER_IMAGE)
                setattr(control, field, value)
                with self.subTest(field=field), self.assertRaises(HistoryError):
                    history.helper_args(control, self.selected, BACKEND_IMAGE,
                                        self.store, self.output, action="preview")

    def test_refuses_non_immutable_helper_image_identity(self):
        with self.assertRaises(BuildControlError):
            history.helper_args(self.control, self.selected, "latest",
                                self.store, self.output, action="preview")


class ActivationHistoryRunTests(unittest.TestCase):
    def setUp(self):
        self.services = {
            "container-backend": {
                "image": BACKEND_IMAGE,
                "started_at": "2026-11-05T12:00:00Z",
                "running": True,
            }
        }
        self.request = {
            "attempt": ATTEMPT,
            "action": "preview",
            "source_files": [],
            "identity": {"services": self.services, "compose_project": "fullmag-history-test"},
        }
        self.plan = {"identity": self.request["identity"], "candidates": [{"attempt": ATTEMPT}],
                     "schema": "reviewed-plan-fixture"}
        self.plan_sha = digest(canonical(self.plan))

    def control(self, retained=None):
        class Control:
            def read(inner, relative, optional=False):
                if relative == "activation/history-operations-v1/" + self.plan_sha + "/plan.json":
                    return retained
                return None
        return Control()

    def context(self, retained=None):
        return self.control(retained), Path("/selected"), BACKEND_IMAGE, Path("/store"), Path("/output"), dict(self.request)

    @staticmethod
    def helper_result(value, plan, plan_sha):
        if value["action"] == "preview":
            document = {"state": "preview", "plan": plan, "plan_sha256": plan_sha}
        else:
            document = {"state": "applied", "plan_sha256": plan_sha}
        return types.SimpleNamespace(returncode=0, stdout=canonical(document), stderr=b"")

    def test_invalid_activation_and_plan_pin_fail_before_host_admission(self):
        invalid_inputs = (_args(activation="not-an-attempt"),
                          _args(apply=True, plan_sha256="malformed"))
        for args in invalid_inputs:
            with self.subTest(args=args), mock.patch.object(history, "host_context") as admission:
                with self.assertRaises(HistoryError):
                    history.run(args)
                admission.assert_not_called()

    def test_apply_refuses_if_fresh_preview_digest_changed(self):
        args = _args(apply=True, plan_sha256=PLAN_SHA)
        previews = []

        def capture(command, *, data, **kwargs):
            previews.append(json.loads(data))
            return self.helper_result(previews[-1], self.plan, "9" * 64)

        with mock.patch.object(history, "host_context", return_value=self.context()), \
             mock.patch.object(history, "helper_args", return_value=["isolated-helper"]), \
             mock.patch.object(history, "bounded_capture", side_effect=capture) as invoke, \
             mock.patch.object(history, "_consumer_inventory") as consumers:
            with self.assertRaisesRegex(HistoryError, "preview changed"):
                history.run(args)
        invoke.assert_called_once()
        self.assertEqual(previews[0]["action"], "preview")
        consumers.assert_not_called()

    def test_retained_pinned_plan_resumes_apply_without_a_new_preview(self):
        retained = dict(self.plan)
        args = _args(apply=True, plan_sha256=self.plan_sha)
        calls = []

        def capture(command, *, data, **kwargs):
            value = json.loads(data)
            calls.append(value)
            return self.helper_result(value, self.plan, self.plan_sha)

        with mock.patch.object(history, "host_context", return_value=self.context(retained)), \
             mock.patch.object(history, "helper_args", return_value=["isolated-helper"]), \
             mock.patch.object(history, "bounded_capture", side_effect=capture), \
             mock.patch.object(history, "_consumer_inventory", return_value=self.services):
            result = history.run(args)
        self.assertEqual(result["state"], "applied")
        self.assertEqual([call["action"] for call in calls], ["apply"])
        self.assertEqual(calls[0]["plan"], retained)

    def test_changed_consumer_image_identity_refuses_before_apply_helper_admission(self):
        retained = dict(self.plan)
        changed = {"container-backend": {**self.services["container-backend"],
                                         "image": "sha256:" + "9" * 64}}
        args = _args(apply=True, plan_sha256=self.plan_sha)
        with mock.patch.object(history, "host_context", return_value=self.context(retained)), \
             mock.patch.object(history, "helper_args", return_value=["isolated-helper"]), \
             mock.patch.object(history, "bounded_capture") as invoke, \
             mock.patch.object(history, "_consumer_inventory", return_value=changed):
            with self.assertRaisesRegex(HistoryError, "incarnation changed"):
                history.run(args)
        invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()
