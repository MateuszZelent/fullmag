"""Source-level regressions for managed activation in a retained DEV group."""
from __future__ import annotations

import json
import hashlib
import copy
import os
from pathlib import Path, PureWindowsPath
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_volume_activate as activate
import docker_volume_dev
from docker_build_control import BuildControlError


class DockerVolumeActivationTests(unittest.TestCase):
    def test_default_request_fence_is_fresh_and_namespaced(self) -> None:
        attempt = "a" * 32
        digest = "b" * 64
        helper = SimpleNamespace(StartupScriptError=ValueError)
        first = activate._request_id(helper, attempt, digest, None)
        second = activate._request_id(helper, attempt, digest, None)
        self.assertNotEqual(first, second)
        self.assertRegex(first, r"^docker-volume-[0-9a-f]{32}$")
        self.assertRegex(second, r"^docker-volume-[0-9a-f]{32}$")

    def test_explicit_request_fence_is_validated_and_preserved(self) -> None:
        explicit = "operator-request-42"
        validated = []

        def validate(value):
            validated.append(value)
            return value

        helper = SimpleNamespace(StartupScriptError=ValueError, _validate_request_id=validate)
        self.assertEqual(
            activate._request_id(helper, "a" * 32, "b" * 64, explicit),
            explicit,
        )
        self.assertEqual(validated, [explicit])

    def test_selected_helper_loader_uses_selected_prepare_contract(self) -> None:
        """The worktree helper must supply prepare, even if the main helper differs."""
        from docker_volume_dev import _startup_helper

        selected_helper = (
            "from pathlib import Path\n"
            "class StartupScriptError(Exception):\n"
            "    pass\n"
            "MAX_PROVENANCE_BYTES = 1024\n"
            "STARTUP_ACTIVATION_TIMEOUT_SECONDS = 17.0\n"
            "ACTIVATION_RECEIPT_PATH = Path('/state/selected/activation.json')\n"
            "def prepare(*args, **kwargs):\n"
            "    return 'selected-helper'\n"
        ).encode()
        selected_storage = b"SELECTED_STORAGE = True\n"
        with tempfile.TemporaryDirectory() as directory:
            selected = Path(directory)
            scripts = selected / "scripts"
            scripts.mkdir()
            (scripts / "docker_startup_script.py").write_bytes(selected_helper)
            (scripts / "fullmag_storage.py").write_bytes(selected_storage)
            startup_digest = hashlib.sha256(selected_helper).hexdigest()
            storage_digest = hashlib.sha256(selected_storage).hexdigest()

            class Control:
                image = "helper-image"

                def helper_args(self, command):
                    return ["helper-image", command]

            result = subprocess.CompletedProcess(
                [], 0,
                stdout=(
                    f"{startup_digest}  /opt/fullmag/docker_startup_script.py\n"
                    f"{storage_digest}  /opt/fullmag/fullmag_storage.py\n"
                ).encode(),
                stderr=b"",
            )
            with patch("docker_volume_dev.bounded_capture", return_value=result):
                helper, hashes = _startup_helper(
                    Control(), selected, "sha256:" + "a" * 64
                )

        main_helper = SimpleNamespace(prepare=lambda *args, **kwargs: "main-helper")
        self.assertEqual(main_helper.prepare(), "main-helper")
        self.assertEqual(helper.prepare(), "selected-helper")
        self.assertEqual(hashes["docker_startup_script.py"], startup_digest)

    def test_legacy_startup_helper_prepare_keeps_its_original_call_signature(self) -> None:
        calls = []

        def prepare(source, script, *, request_id, source_commit):
            calls.append((source, script, request_id, source_commit))
            return "legacy-authorization"

        helper = SimpleNamespace(prepare=prepare)
        result = activate._prepare_startup_authorization(
            helper, Path("/checkout"), Path("examples/model.py"),
            request_id="request-1", source_commit="a" * 40, solver_profile=False,
        )
        self.assertEqual(result, "legacy-authorization")
        self.assertEqual(calls, [(Path("/checkout"), Path("examples/model.py"), "request-1", "a" * 40)])

    def test_profile_opt_in_rejects_old_pinned_helper_before_retirement(self) -> None:
        calls = []

        def old_prepare(source, script, *, request_id, source_commit):
            calls.append((source, script))
            return "legacy-authorization"

        helper = SimpleNamespace(prepare=old_prepare, solver_profile_sha256=lambda _value: "b" * 64)
        with self.assertRaisesRegex(BuildControlError, "cannot accept solver profile"):
            activate._require_solver_profile_support(helper)
        self.assertEqual(calls, [])

        source = Path(__file__).with_name("docker_volume_activate.py").read_text(encoding="utf-8")
        support_check = source.index(
            "profile_digest = _require_solver_profile_support(startup_helper) if solver_profile else None"
        )
        retirement = source.index("retained_retirement = _retained_retirement_context(")
        self.assertLess(support_check, retirement)

    def test_activation_contract_comes_from_selected_helper(self) -> None:
        helper = SimpleNamespace(
            STARTUP_ACTIVATION_TIMEOUT_SECONDS=17.0,
            ACTIVATION_RECEIPT_PATH=Path("/state/selected/activation.json"),
        )
        self.assertEqual(
            activate._activation_contract(helper),
            (77.0, "/state/selected/activation.json"),
        )

    def test_activation_contract_normalizes_windows_path_and_rejects_host_paths(self) -> None:
        helper = SimpleNamespace(
            STARTUP_ACTIVATION_TIMEOUT_SECONDS=17.0,
            ACTIVATION_RECEIPT_PATH=PureWindowsPath(r"\state\selected\activation.json"),
        )
        self.assertEqual(
            activate._activation_contract(helper),
            (77.0, "/state/selected/activation.json"),
        )
        for marker in (
            PureWindowsPath(r"C:\state\selected\activation.json"),
            PureWindowsPath(r"\\server\share\activation.json"),
            PureWindowsPath(r"\state\..\escape.json"),
        ):
            with self.subTest(marker=marker), self.assertRaises(BuildControlError):
                activate._activation_contract(
                    SimpleNamespace(
                        STARTUP_ACTIVATION_TIMEOUT_SECONDS=17.0,
                        ACTIVATION_RECEIPT_PATH=marker,
                    )
                )

    def test_managed_receipt_contract_is_keyed_to_request_and_pinned_to_control(self) -> None:
        def path_for_key(key):
            return Path(
                "/opt/fullmag/control/backend/script-activation-"
                + key
                + "/activation.json"
            )

        helper = SimpleNamespace(activation_receipt_path_for_key=path_for_key)
        key, path = activate._managed_activation_receipt_contract(helper, "new-run")
        self.assertEqual(key, hashlib.sha256(b"new-run").hexdigest())
        self.assertEqual(
            path,
            "/opt/fullmag/control/backend/script-activation-"
            + key
            + "/activation.json",
        )
        invalid_helper = SimpleNamespace(
            activation_receipt_path_for_key=lambda _key: Path("/tmp/activation.json")
        )
        with self.assertRaises(BuildControlError):
            activate._managed_activation_receipt_contract(invalid_helper, "new-run")

    def test_non_object_receipts_fail_closed(self) -> None:
        control = SimpleNamespace(project="fullmag-worktree-demo")
        with self.assertRaises(BuildControlError):
            activate._validate_running_group(
                control, {}, [], {}, "sha256:" + "a" * 64
            )
        with self.assertRaises(BuildControlError):
            activate._linked_runtime_terminals(
                control, "a" * 32, [], source_root="C:/git/fullmag",
                image="sha256:" + "a" * 64, config_sha256="b" * 64,
            )

    def test_activation_output_accepts_only_terminal_json_state(self) -> None:
        payload = b"diagnostic\n" + json.dumps({"state": "activated"}).encode() + b"\n"
        self.assertEqual(activate._json_result(payload)["state"], "activated")
        self.assertIsNone(activate._json_result(b"wrapper failed\n"))

    def test_activation_inputs_keep_development_attempt_separate(self) -> None:
        inputs = activate._activation_operation_inputs(
            development_attempt="d" * 32,
            config_sha256="c" * 64,
            source_root="C:/git/fullmag",
            image="sha256:" + "a" * 64,
            source_relative="examples/model.py",
            source_sha256="b" * 64,
            request_id="request-1",
            provenance_sha256="e" * 64,
            backend_container="f" * 64,
            activation_receipt_key="1" * 64,
            activation_receipt_path="/opt/fullmag/control/backend/script-activation-"
            + "1" * 64
            + "/activation.json",
        )
        self.assertEqual(inputs["development_attempt"], "d" * 32)
        self.assertNotIn("attempt", inputs)

    def test_activation_inputs_bind_the_optional_solver_profile_digest(self) -> None:
        base = {
            "development_attempt": "d" * 32,
            "config_sha256": "c" * 64,
            "source_root": "C:/git/fullmag",
            "image": "sha256:" + "a" * 64,
            "source_relative": "examples/model.py",
            "source_sha256": "b" * 64,
            "request_id": "request-1",
            "provenance_sha256": "e" * 64,
            "backend_container": "f" * 64,
            "activation_receipt_key": "1" * 64,
            "activation_receipt_path": (
                "/opt/fullmag/control/backend/script-activation-"
                + "1" * 64
                + "/activation.json"
            ),
        }
        legacy = activate._activation_operation_inputs(**base)
        profiled = activate._activation_operation_inputs(
            **base, solver_profile_sha256="2" * 64
        )
        self.assertNotIn("solver_profile_sha256", legacy)
        self.assertEqual(profiled["solver_profile_sha256"], "2" * 64)
        self.assertNotEqual(legacy, profiled)

    def test_rejected_activation_is_terminal_failure_with_own_attempt(self) -> None:
        operation = {
            "daemon_pending": True,
            "receipt": {"attempt": "a" * 32},
        }
        rejection = {
            "http_status": 422,
            "code": "workspace_not_empty",
            "message": "workspace is not empty",
        }
        with self.assertRaisesRegex(BuildControlError, "activation was rejected") as raised:
            activate._record_activation_result(
                operation,
                {"state": "rejected", "rejection": rejection},
            )
        self.assertEqual(raised.exception.rejection, rejection)
        self.assertFalse(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["attempt"], "a" * 32)
        self.assertEqual(operation["receipt"]["state"], "failed-confirmed")
        self.assertEqual(operation["receipt"]["activation_state"], "rejected")

    def test_activated_result_is_success(self) -> None:
        operation = {
            "daemon_pending": True,
            "receipt": {"attempt": "a" * 32},
        }
        activate._record_activation_result(
            operation,
            {
                "state": "activated",
                "response": {"session_id": "session-1", "run_id": "run-1"},
            },
        )
        self.assertFalse(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["attempt"], "a" * 32)
        self.assertEqual(operation["receipt"]["state"], "succeeded")
        self.assertEqual(operation["receipt"]["activation_state"], "activated")
        self.assertEqual(operation["receipt"]["session_id"], "session-1")

    def test_profiled_activation_requires_the_accepted_profile_digest(self) -> None:
        operation = {
            "daemon_pending": True,
            "receipt": {
                "attempt": "a" * 32,
                "inputs": {"solver_profile_sha256": "2" * 64},
            },
        }
        with self.assertRaisesRegex(BuildControlError, "solver profile digest"):
            activate._record_activation_result(
                operation,
                {"state": "activated", "response": {"session_id": "session-1", "run_id": "run-1"}},
            )
        self.assertTrue(operation["daemon_pending"])
        self.assertNotIn("state", operation["receipt"])

        activate._record_activation_result(
            operation,
            {"state": "activated", "response": {
                "session_id": "session-1", "run_id": "run-1",
                "solver_profile_sha256": "2" * 64,
            }},
        )
        self.assertFalse(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["state"], "succeeded")

    def test_profiled_rejection_is_retained_without_acceptance_digest(self) -> None:
        operation = {
            "daemon_pending": True,
            "receipt": {
                "attempt": "a" * 32,
                "inputs": {"solver_profile_sha256": "2" * 64},
            },
        }
        with self.assertRaisesRegex(BuildControlError, "activation was rejected"):
            activate._record_activation_result(
                operation,
                {"state": "rejected", "rejection": {
                    "http_status": 422,
                    "code": "accepted_solver_profile_unsupported",
                    "message": "profile unsupported for this study",
                }},
            )
        self.assertFalse(operation["daemon_pending"])
        self.assertEqual(operation["receipt"]["state"], "failed-confirmed")

    def _linked_receipt_fixture(self, phase: str = "resume"):
        original_attempt = "a" * 32
        linked_attempt = "b" * 32
        config_sha256 = "c" * 64
        backend_image = "sha256:" + "d" * 64
        original = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "failed-confirmed",
            "attempt": original_attempt,
            "compose_project": "fullmag-worktree-demo",
            "config_sha256": config_sha256,
            "inputs": {
                "source_root": "C:/git/fullmag",
                "image_id": backend_image,
            },
            "state_root": "C:/fullmag-storage",
            "backend_volumes": ["fullmag-backend-build"],
            "frontend_volume": "fullmag-frontend-build",
            "source_commit": "e" * 40,
            "source_digest": "f" * 64,
            "source_snapshot_sha256": "1" * 64,
            "backend_build_receipt_sha256": "2" * 64,
        }
        linked = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": phase,
            "state": "succeeded",
            "attempt": linked_attempt,
            "compose_project": original["compose_project"],
            "config_sha256": config_sha256,
            "inputs": {
                "attempt": original_attempt,
                "config_sha256": config_sha256,
            },
            "backend_container": "3" * 64,
            "frontend_container": "4" * 64,
            "state_root": original["state_root"],
            "backend_volumes": original["backend_volumes"],
            "frontend_volume": original["frontend_volume"],
            "source_commit": original["source_commit"],
            "source_digest": original["source_digest"],
            "source_snapshot_sha256": original["source_snapshot_sha256"],
            "backend_build_receipt_sha256": original["backend_build_receipt_sha256"],
        }
        if phase == "iteration":
            linked["inputs"].update(
                source_root=original["inputs"]["source_root"],
                image_id=backend_image,
            )
        documents = {
            phase + "/verified.json": copy.deepcopy(linked),
            phase + "/attempts/" + linked_attempt + "/terminal.json": copy.deepcopy(linked),
        }

        class Control:
            def read(self, relative, *, optional=False):
                if relative not in documents:
                    if optional:
                        return None
                    raise AssertionError("unexpected control read: " + relative)
                return documents[relative]

        return Control(), original_attempt, original, linked, config_sha256, backend_image, documents

    def _retained_group_fixture(
        self,
        frontend_image: str | None = None,
        *,
        frontend_running: bool = True,
        ui_mode: str | None = None,
    ):
        backend_image = "sha256:" + "a" * 64
        frontend_image = frontend_image or "sha256:" + "b" * 64
        backend_id = "c" * 64
        frontend_id = "d" * 64
        document = {
            "name": "fullmag-worktree-demo",
            "services": {
                "backend": {
                    "image": backend_image,
                    "environment": {"FULLMAG_SOURCE_HOST_ROOT": "C:/git/fullmag",
                                    "FULLMAG_SESSION_STORAGE_PROFILE": "windows-folder-v1"},
                    "volumes": [{
                        "type": "bind",
                        "source": "C:/git/fullmag",
                        "target": "/opt/fullmag/source",
                        "read_only": True,
                    }],
                },
                "frontend": {
                    "image": frontend_image,
                    "environment": {},
                    "volumes": [],
                    "ports": ["127.0.0.1:3197:8080"],
                },
            },
        }
        terminal = {
            "backend_container": backend_id,
            "frontend_container": frontend_id,
        }
        if ui_mode is not None:
            terminal.update(
                ui_mode=ui_mode,
                finished_at=1.0,
                backend_started_at="2026-11-04T00:00:00Z",
                frontend_started_at=("2026-11-04T00:00:00Z" if frontend_running
                                     else "0001-01-01T00:00:00Z"),
            )
        control = SimpleNamespace(project=document["name"])
        identity = {"worktree_id": "demo-worktree"}
        actual_images = {"backend": backend_image, "frontend": frontend_image}
        image_configs = {
            backend_image: {"Cmd": ["backend-image"]},
            frontend_image: {"Cmd": ["frontend-image"]},
        }
        ids = {"backend": backend_id, "frontend": frontend_id}

        def compose_capture(_document, *arguments):
            return (ids[arguments[-1]] + "\n").encode()

        def docker_text(*arguments, **_kwargs):
            if arguments[:2] == ("image", "inspect"):
                return json.dumps([{"Config": image_configs[arguments[2]]}])
            if arguments[0] == "inspect":
                service = next(name for name, identifier in ids.items() if identifier == arguments[1])
                return json.dumps([{
                    "Id": arguments[1],
                    "Image": actual_images[service],
                    "Config": {
                        "Labels": {
                            "com.docker.compose.project": document["name"],
                            "com.docker.compose.service": service,
                            "org.fullmag.source.worktree-id": identity["worktree_id"],
                        },
                    },
                    "State": ({
                        "Running": True,
                        "StartedAt": ("2026-11-04T00:00:00Z" if service == "backend"
                                       else "2026-11-04T00:00:00Z"),
                        "Health": {"Status": "healthy"},
                    } if service == "backend" or frontend_running else {
                        "Running": False,
                        "Status": "created",
                        "StartedAt": "0001-01-01T00:00:00Z",
                    }),
                }])
            raise AssertionError(arguments)

        return control, identity, document, terminal, backend_image, compose_capture, docker_text

    def test_linked_resume_and_iteration_receipts_are_accepted(self) -> None:
        for phase in ("resume", "iteration"):
            with self.subTest(phase=phase):
                control, original_attempt, original, linked, config_sha256, image, _documents = (
                    self._linked_receipt_fixture(phase)
                )
                terminals = activate._linked_runtime_terminals(
                    control,
                    original_attempt,
                    original,
                    source_root=original["inputs"]["source_root"],
                    image=image,
                    config_sha256=config_sha256,
                )
                self.assertEqual(terminals, [linked])

    def test_unrelated_resume_does_not_hide_matching_iteration(self) -> None:
        control, original_attempt, original, linked, config_sha256, image, documents = (
            self._linked_receipt_fixture("iteration")
        )
        unrelated = copy.deepcopy(linked)
        unrelated.update(phase="resume", attempt="7" * 32, config_sha256="8" * 64)
        unrelated["inputs"].update(attempt="9" * 32, config_sha256="8" * 64)
        documents["resume/verified.json"] = unrelated
        self.assertEqual(
            activate._linked_runtime_terminals(
                control, original_attempt, original,
                source_root=original["inputs"]["source_root"], image=image,
                config_sha256=config_sha256,
            ),
            [linked],
        )

    def test_linked_receipt_rejects_wrong_attempt_or_config(self) -> None:
        control, original_attempt, original, _linked, config_sha256, image, documents = (
            self._linked_receipt_fixture()
        )
        documents["resume/verified.json"]["inputs"]["attempt"] = "e" * 32
        documents["resume/attempts/" + "b" * 32 + "/terminal.json"]["inputs"]["attempt"] = "e" * 32
        with self.assertRaises(BuildControlError):
            activate._linked_runtime_terminals(
                control,
                original_attempt,
                original,
                source_root=original["inputs"]["source_root"],
                image=image,
                config_sha256=config_sha256,
            )

        control, original_attempt, original, _linked, config_sha256, image, documents = (
            self._linked_receipt_fixture()
        )
        documents["resume/verified.json"]["config_sha256"] = "9" * 64
        documents["resume/attempts/" + "b" * 32 + "/terminal.json"]["config_sha256"] = "9" * 64
        with self.assertRaises(BuildControlError):
            activate._linked_runtime_terminals(
                control,
                original_attempt,
                original,
                source_root=original["inputs"]["source_root"],
                image=image,
                config_sha256=config_sha256,
            )

    def test_linked_receipt_rejects_terminal_or_container_identity_drift(self) -> None:
        control, original_attempt, original, _linked, config_sha256, image, documents = (
            self._linked_receipt_fixture()
        )
        documents["resume/attempts/" + "b" * 32 + "/terminal.json"]["frontend_container"] = "5" * 64
        with self.assertRaises(BuildControlError):
            activate._linked_runtime_terminals(
                control,
                original_attempt,
                original,
                source_root=original["inputs"]["source_root"],
                image=image,
                config_sha256=config_sha256,
            )

        fixture = self._retained_group_fixture()
        control, identity, document, terminal, backend_image, compose, docker_text = fixture
        terminal["frontend_container"] = "e" * 64
        with patch.object(activate, "compose_capture", side_effect=compose), \
                patch.object(activate, "_docker_text", side_effect=docker_text), \
                patch("docker_volume_dev._validate_retained_service"):
            with self.assertRaises(BuildControlError):
                activate._validate_running_group(
                    control, identity, document, terminal, backend_image
                )

    def test_retained_group_accepts_distinct_backend_and_frontend_images(self) -> None:
        fixture = self._retained_group_fixture()
        control, identity, document, terminal, backend_image, compose, docker_text = fixture
        with patch.object(activate, "compose_capture", side_effect=compose), \
                patch.object(activate, "_docker_text", side_effect=docker_text), \
                patch("docker_volume_dev._validate_retained_service") as validator:
            result = activate._validate_running_group(
                control, identity, document, terminal, backend_image
            )
        self.assertEqual(result, ("c" * 64, "d" * 64))
        self.assertEqual(validator.call_count, 2)
        self.assertEqual(validator.call_args_list[0].args[2], "backend")
        self.assertEqual(validator.call_args_list[0].args[3]["Cmd"], ["backend-image"])
        self.assertEqual(validator.call_args_list[1].args[2], "frontend")
        self.assertEqual(validator.call_args_list[1].args[3]["Cmd"], ["frontend-image"])

    def test_headless_retained_group_requires_explicit_mode_and_stopped_frontend(self) -> None:
        fixture = self._retained_group_fixture(frontend_running=False, ui_mode="headless")
        control, identity, document, terminal, backend_image, compose, docker_text = fixture
        with patch.object(activate, "compose_capture", side_effect=compose), \
                patch.object(activate, "_docker_text", side_effect=docker_text), \
                patch("docker_volume_dev._validate_retained_service"), \
                patch("docker_dev_defaults._validate_live_network") as network:
            result = activate._validate_running_group(
                control, identity, document, terminal, backend_image,
                frontend_required=False,
            )
        self.assertEqual(result, ("c" * 64, "d" * 64))
        self.assertFalse(network.call_args.kwargs["frontend_required"])

    def test_finish_readiness_accepts_stopped_frontend_only_for_headless(self) -> None:
        document = {"services": {
            "backend": {"image": "backend-image"},
            "frontend": {"image": "frontend-image"},
        }}
        backend = {"Image": "backend-image", "State": {
            "Running": True, "StartedAt": "backend-start",
            "Health": {"Status": "healthy"},
        }}
        frontend = {"Image": "frontend-image", "State": {
            "Running": False, "Status": "created", "StartedAt": "frontend-not-started",
        }}
        with patch.object(docker_volume_dev, "_validate_retained_service"):
            self.assertTrue(docker_volume_dev._service_readiness_satisfied(
                document, backend, "backend", {}, expected_image="backend-image",
                expected_started_at="backend-start", headless=True,
            ))
            self.assertTrue(docker_volume_dev._service_readiness_satisfied(
                document, frontend, "frontend", {}, expected_image="frontend-image",
                expected_started_at="frontend-not-started", headless=True,
            ))
            with self.assertRaisesRegex(BuildControlError, "exited before readiness"):
                docker_volume_dev._service_readiness_satisfied(
                    document, frontend, "frontend", {}, expected_image="frontend-image",
                    expected_started_at="frontend-not-started", headless=False,
                )
            backend["State"]["Health"]["Status"] = "starting"
            self.assertFalse(docker_volume_dev._service_readiness_satisfied(
                document, backend, "backend", {}, expected_image="backend-image",
                expected_started_at="backend-start", headless=True,
            ))

    def test_headless_retained_group_rejects_a_gui_receipt_or_running_frontend(self) -> None:
        fixtures = (
            ("GUI receipt", self._retained_group_fixture(frontend_running=False, ui_mode="gui")),
            ("running frontend", self._retained_group_fixture(frontend_running=True, ui_mode="headless")),
            ("legacy receipt", self._retained_group_fixture(frontend_running=False)),
        )
        for label, fixture in fixtures:
            with self.subTest(case=label):
                control, identity, document, terminal, backend_image, compose, docker_text = fixture
                with patch.object(activate, "compose_capture", side_effect=compose), \
                        patch.object(activate, "_docker_text", side_effect=docker_text), \
                        patch("docker_volume_dev._validate_retained_service"), \
                        patch("docker_dev_defaults._validate_live_network"):
                    with self.assertRaises(BuildControlError):
                        activate._validate_running_group(
                            control, identity, document, terminal, backend_image,
                            frontend_required=False,
                        )

    def test_headless_group_rejects_failed_or_restarted_frontend(self) -> None:
        base = self._retained_group_fixture(frontend_running=False, ui_mode="headless")
        control, identity, document, terminal, backend_image, compose, original_text = base
        frontend_id = terminal["frontend_container"]
        bad_states = (
            {"Running": False, "Status": "exited", "ExitCode": 137, "OOMKilled": False,
             "StartedAt": terminal["frontend_started_at"]},
            {"Running": False, "Status": "exited", "ExitCode": 0, "OOMKilled": True,
             "StartedAt": terminal["frontend_started_at"]},
            {"Running": False, "Status": "exited", "ExitCode": 0,
             "StartedAt": terminal["frontend_started_at"]},
            {"Running": False, "Status": "exited", "ExitCode": 0, "OOMKilled": False,
             "StartedAt": "2026-11-04T00:00:01Z"},
        )
        for bad_state in bad_states:
            with self.subTest(state=bad_state):
                def docker_text(*arguments, **kwargs):
                    records = json.loads(original_text(*arguments, **kwargs))
                    if arguments[:2] == ("inspect", frontend_id):
                        records[0]["State"].update(bad_state)
                    return json.dumps(records)

                with patch.object(activate, "compose_capture", side_effect=compose), \
                        patch.object(activate, "_docker_text", side_effect=docker_text), \
                        patch("docker_volume_dev._validate_retained_service"), \
                        patch("docker_dev_defaults._validate_live_network"):
                    with self.assertRaises(BuildControlError):
                        activate._validate_running_group(
                            control, identity, document, terminal, backend_image,
                            frontend_required=False,
                        )

    def test_mode_aware_runtime_selection_uses_latest_mode_and_current_source(self) -> None:
        control, original_attempt, original, headless, config_sha256, image, documents = (
            self._linked_receipt_fixture("resume")
        )
        original.update(state="succeeded", ui_mode="gui", finished_at=10.0)
        headless.update(
            ui_mode="headless", finished_at=20.0,
            backend_started_at="backend-start-2", frontend_started_at="frontend-start-1",
        )
        headless["inputs"].update(
            source_root=original["inputs"]["source_root"], image_id=image,
        )
        headless.update(
            source_commit="3" * 40, source_digest="4" * 64,
            source_snapshot_sha256="5" * 64, backend_build_receipt_sha256="6" * 64,
        )
        documents["resume/verified.json"] = copy.deepcopy(headless)
        documents["resume/attempts/" + headless["attempt"] + "/terminal.json"] = copy.deepcopy(headless)
        self.assertEqual(
            activate._linked_runtime_terminals(
                control, original_attempt, original,
                source_root=original["inputs"]["source_root"], image=image,
                config_sha256=config_sha256,
            ),
            [headless],
        )

        gui = copy.deepcopy(headless)
        gui.update(phase="iteration", attempt="7" * 32, ui_mode="gui", finished_at=30.0)
        gui["inputs"].update(attempt=original_attempt, config_sha256=config_sha256)
        gui.update(
            source_commit="8" * 40, source_digest="9" * 64,
            source_snapshot_sha256="a" * 64, backend_build_receipt_sha256="b" * 64,
        )
        documents["iteration/verified.json"] = copy.deepcopy(gui)
        documents["iteration/attempts/" + gui["attempt"] + "/terminal.json"] = copy.deepcopy(gui)
        self.assertEqual(
            activate._linked_runtime_terminals(
                control, original_attempt, original,
                source_root=original["inputs"]["source_root"], image=image,
                config_sha256=config_sha256,
            ),
            [gui],
        )

    def test_mode_aware_runtime_selection_rejects_nonfinite_or_ambiguous_time(self) -> None:
        control, original_attempt, original, linked, config_sha256, image, documents = (
            self._linked_receipt_fixture("resume")
        )
        original.update(state="succeeded", ui_mode="gui", finished_at=10.0)
        linked.update(
            ui_mode="headless", finished_at=float("nan"),
            backend_started_at="backend-start-2", frontend_started_at="frontend-start-1",
        )
        linked["inputs"].update(source_root=original["inputs"]["source_root"], image_id=image)
        documents["resume/verified.json"] = copy.deepcopy(linked)
        documents["resume/attempts/" + linked["attempt"] + "/terminal.json"] = copy.deepcopy(linked)
        with self.assertRaises(BuildControlError):
            activate._linked_runtime_terminals(
                control, original_attempt, original,
                source_root=original["inputs"]["source_root"], image=image,
                config_sha256=config_sha256,
            )

        linked["finished_at"] = 20.0
        documents["resume/verified.json"] = copy.deepcopy(linked)
        documents["resume/attempts/" + linked["attempt"] + "/terminal.json"] = copy.deepcopy(linked)
        gui = copy.deepcopy(linked)
        gui.update(phase="iteration", attempt="7" * 32, ui_mode="gui")
        gui["inputs"].update(attempt=original_attempt, config_sha256=config_sha256)
        documents["iteration/verified.json"] = copy.deepcopy(gui)
        documents["iteration/attempts/" + gui["attempt"] + "/terminal.json"] = copy.deepcopy(gui)
        with self.assertRaisesRegex(BuildControlError, "Conflicting"):
            activate._linked_runtime_terminals(
                control, original_attempt, original,
                source_root=original["inputs"]["source_root"], image=image,
                config_sha256=config_sha256,
            )

    def test_retained_group_accepts_docker_desktop_host_mount_spelling(self) -> None:
        fixture = self._retained_group_fixture()
        control, identity, document, terminal, backend_image, compose, docker_text = fixture
        document["services"]["backend"]["volumes"][0]["source"] = "/host_mnt/c/git/fullmag"
        with patch.object(activate, "compose_capture", side_effect=compose), \
                patch.object(activate, "_docker_text", side_effect=docker_text), \
                patch("docker_volume_dev._validate_retained_service"):
            result = activate._validate_running_group(
                control, identity, document, terminal, backend_image,
                source_root="C:/git/fullmag",
            )
        self.assertEqual(result, ("c" * 64, "d" * 64))

    def test_linux_activation_preserves_pinned_daemon_bind_and_client_source(self) -> None:
        fixture = self._retained_group_fixture()
        control, identity, document, terminal, image, compose, docker_text = fixture
        backend = document["services"]["backend"]
        backend["environment"].update(FULLMAG_SOURCE_HOST_ROOT="/home/operator/fullmag",
                                      FULLMAG_SESSION_STORAGE_PROFILE="linux-native-v1")
        backend["volumes"][0]["source"] = "/home/operator/fullmag"
        backend["x-fullmag-daemon-binds"] = {
            "/opt/fullmag/source": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/source"}
        with (patch.object(activate, "compose_capture", side_effect=compose),
              patch.object(activate, "_docker_text", side_effect=docker_text),
              patch("docker_volume_dev._validate_retained_service") as validator):
            self.assertEqual(activate._validate_running_group(
                control, identity, document, terminal, image, source_root="/home/operator/fullmag"),
                ("c" * 64, "d" * 64))
            self.assertEqual(validator.call_args_list[0].args[0]["services"]["backend"]["x-fullmag-daemon-binds"],
                             backend["x-fullmag-daemon-binds"])
            with self.assertRaisesRegex(BuildControlError, "selected source"):
                activate._validate_running_group(control, identity, document, terminal, image,
                                                  source_root="/home/another/fullmag")
            backend["environment"]["FULLMAG_SESSION_STORAGE_PROFILE"] = "unverified"
            with self.assertRaisesRegex(BuildControlError, "storage profile"):
                activate._validate_running_group(control, identity, document, terminal, image)

    def test_activation_accepts_linux_host_before_validating_attempt(self) -> None:
        arguments = SimpleNamespace(attempt="invalid")
        with patch("docker_dev_host.require_host") as require_host:
            with self.assertRaisesRegex(BuildControlError, "exact attempt"):
                activate.activate(arguments)
        require_host.assert_called_once_with()

    def test_retained_group_rejects_source_identity_mount_drift(self) -> None:
        fixture = self._retained_group_fixture()
        control, identity, document, terminal, backend_image, compose, docker_text = fixture
        document["services"]["backend"]["environment"]["FULLMAG_SOURCE_HOST_ROOT"] = "C:/git/other"
        with patch.object(activate, "compose_capture", side_effect=compose), \
                patch.object(activate, "_docker_text", side_effect=docker_text), \
                patch("docker_volume_dev._validate_retained_service"):
            with self.assertRaisesRegex(BuildControlError, "differs from its readonly bind"):
                activate._validate_running_group(
                    control, identity, document, terminal, backend_image,
                    source_root="C:/git/fullmag",
                )

    def test_retained_group_rejects_selected_source_drift(self) -> None:
        fixture = self._retained_group_fixture()
        control, identity, document, terminal, backend_image, compose, docker_text = fixture
        with patch.object(activate, "compose_capture", side_effect=compose), \
                patch.object(activate, "_docker_text", side_effect=docker_text), \
                patch("docker_volume_dev._validate_retained_service"):
            with self.assertRaisesRegex(BuildControlError, "differs from the selected source"):
                activate._validate_running_group(
                    control, identity, document, terminal, backend_image,
                    source_root="C:/git/other",
                )

    def test_retained_group_rejects_frontend_image_drift(self) -> None:
        wrong_frontend = "sha256:" + "e" * 64
        fixture = self._retained_group_fixture(frontend_image=wrong_frontend)
        control, identity, document, terminal, backend_image, compose, docker_text = fixture
        actual = {"backend": backend_image, "frontend": "sha256:" + "f" * 64}
        original = docker_text

        def drifted_docker_text(*arguments, **kwargs):
            value = json.loads(original(*arguments, **kwargs))
            if arguments[0] == "inspect" and arguments[1] == "d" * 64:
                value[0]["Image"] = actual["frontend"]
            return json.dumps(value)

        with patch.object(activate, "compose_capture", side_effect=compose), \
                patch.object(activate, "_docker_text", side_effect=drifted_docker_text), \
                patch("docker_volume_dev._validate_retained_service"):
            with self.assertRaises(BuildControlError):
                activate._validate_running_group(
                    control, identity, document, terminal, backend_image
                )

    def test_fixed_wrapper_loads_dataclass_helper_from_temp_image_path(self) -> None:
        helper = (
            "from dataclasses import dataclass\n"
            "from pathlib import PurePosixPath\n"
            "ACTIVATION_RECEIPT_PATH = PurePosixPath('/state/original/activation.json')\n"
            "def activation_receipt_path_for_key(key):\n"
            "    return PurePosixPath('/opt/fullmag/control/backend/script-activation-' + key + '/activation.json')\n"
            "@dataclass\n"
            "class Marker:\n"
            "    value: str\n"
            "def run_from_environment():\n"
            "    return {'state': 'activated', 'marker': Marker(str(ACTIVATION_RECEIPT_PATH)).value}\n"
        ).encode()
        with tempfile.TemporaryDirectory() as directory:
            helper_path = Path(directory) / "docker_startup_script.py"
            helper_path.write_bytes(helper)
            script = activate.FIXED_ACTIVATION_SCRIPT.replace(
                "/opt/fullmag/docker_startup_script.py",
                helper_path.as_posix(),
            )
            environment = {
                "FULLMAG_STARTUP_HELPER_SHA256": hashlib.sha256(helper).hexdigest(),
                "FULLMAG_STARTUP_RECEIPT_KEY": "a" * 64,
            }
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-c", script],
                env={**os.environ, **environment},
                capture_output=True,
                text=True,
                check=False,
            )
            invalid_environment = {**environment, "FULLMAG_STARTUP_RECEIPT_KEY": "A" * 64}
            invalid = subprocess.run(
                [sys.executable, "-I", "-B", "-c", script],
                env={**os.environ, **invalid_environment},
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {
                "state": "activated",
                "marker": "/opt/fullmag/control/backend/script-activation-"
                + "a" * 64
                + "/activation.json",
            },
        )
        self.assertNotEqual(invalid.returncode, 0)
        self.assertIn("receipt key is missing or invalid", invalid.stderr)


if __name__ == "__main__":
    unittest.main()
