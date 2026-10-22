"""Interpreted regressions for idempotent Docker DEV reconciliation."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import docker_dev_up


def _args(*, script=None, port=3197, port_explicit=False, request_id="test-request"):
    return argparse.Namespace(
        repo_root=Path("/repo"),
        source_root=Path("/repo"),
        port=port,
        port_explicit=port_explicit,
        script=script,
        request_id=request_id,
        profile="dev",
        gpu_access="auto",
        image=None,
        toolchain_image=None,
        source_manifest=None,
        include_untracked=[],
    )


def _group(*, backend_running=True, frontend_running=True, healthy=True):
    backend_state = {
        "Running": backend_running,
        "Health": {"Status": "healthy" if healthy else "unhealthy"},
    }
    backend_image_id = "sha256:" + "e" * 64
    toolchain_image_id = "sha256:" + "f" * 64
    return docker_dev_up.RetainedGroup(
        repo_root=Path("/repo"),
        source_root=Path("/repo"),
        layout={},
        identity={
            "project_name": "fullmag-master",
            "network_name": "fullmag-master_fullmag",
            "project_id": "fullmag-test",
            "worktree_id": "master",
            "checkout_kind": "main-checkout",
        },
        control=Mock(),
        attempt="a" * 32,
        config_sha256="b" * 64,
        port=3297,
        document={"name": "fullmag-master"},
        terminal={
            "state": "succeeded",
            "backend_container": "c" * 64,
            "frontend_container": "d" * 64,
        },
        backend_id="c" * 64,
        frontend_id="d" * 64,
        backend={
            "Image": backend_image_id,
            "Config": {
                "Env": [
                    "FULLMAG_TOOLCHAIN_IMAGE_ID=" + toolchain_image_id,
                    "FULLMAG_RUNTIME_IMAGE_ID=" + backend_image_id,
                    "FULLMAG_PACKAGE_PROVENANCE=/opt/fullmag/control/backend/runtime-provenance.json",
                    "FULLMAG_RUNTIME_PROVENANCE=/opt/fullmag/control/backend/runtime-provenance.json",
                ],
            },
            "State": backend_state,
        },
        frontend={"State": {"Running": frontend_running}},
    )


class DockerDevUpReconciliationTests(unittest.TestCase):
    def setUp(self):
        self._build_input_match_impl = docker_dev_up._build_inputs_match
        self._build_input_guard = patch.object(
            docker_dev_up, "_build_inputs_match", return_value=True
        )
        self._build_input_guard.start()
        self.addCleanup(self._build_input_guard.stop)

    def test_empty_namespace_starts_without_script_then_activates_requested_script(self):
        args = _args(script=Path("examples/model.py"))
        group = _group()
        with patch.object(docker_dev_up, "_discover_group", side_effect=[None, group]), \
                patch("docker_volume_dev.start") as start, \
                patch.object(docker_dev_up, "_activate_if_requested") as activate:
            docker_dev_up.ensure_up(args)
        start.assert_called_once()
        self.assertIsNot(start.call_args.args[0], args)
        self.assertIsNone(start.call_args.args[0].script)
        activate.assert_called_once_with(group, args)

    def test_repeated_activation_reuses_request_fence_and_changed_script_gets_new_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            script = source / "model.py"
            script.write_text("VALUE = 1\n", encoding="utf-8")
            group = docker_dev_up.RetainedGroup(
                **{**vars(_group()), "repo_root": source, "source_root": source}
            )
            args = _args(script=Path("model.py"), request_id=None)
            with patch("fullmag_storage.git", return_value="c" * 40), \
                    patch.object(docker_dev_up, "_discover_group", return_value=group), \
                    patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                    patch.object(docker_dev_up, "_source_matches", return_value=True), \
                    patch("docker_dev_defaults.activate_discovered") as activate:
                docker_dev_up.ensure_up(args)
                docker_dev_up.ensure_up(args)
                script.write_text("VALUE = 2\n", encoding="utf-8")
                docker_dev_up.ensure_up(args)
            request_ids = [call.args[0].request_id for call in activate.call_args_list]
            self.assertEqual(len(request_ids), 3)
            self.assertEqual(request_ids[0], request_ids[1])
            self.assertNotEqual(request_ids[1], request_ids[2])

    def test_malformed_retained_service_validation_is_wrapped(self):
        image = "sha256:" + "e" * 64
        actual = [{
            "Id": "c" * 64,
            "Image": image,
            "Config": {
                "Labels": {
                    "com.docker.compose.project": "fullmag-master",
                    "com.docker.compose.service": "backend",
                    "org.fullmag.source.worktree-id": "master",
                }
            },
        }]
        image_record = [{"Config": {}}]
        identity = {"project_name": "fullmag-master", "worktree_id": "master"}
        for malformed in (KeyError("services"), TypeError("not a mapping")):
            with self.subTest(malformed=type(malformed).__name__), \
                    patch.object(docker_dev_up, "docker_capture", side_effect=[
                        SimpleNamespace(stdout=json.dumps(actual).encode()),
                        SimpleNamespace(stdout=json.dumps(image_record).encode()),
                    ]), \
                    patch("docker_volume_dev._validate_retained_service", side_effect=malformed):
                with self.assertRaises(docker_dev_up.DockerDevUpError):
                    docker_dev_up._inspect_retained_service(
                        {"services": {"backend": {}}}, identity, "backend",
                        "c" * 64, image, {}
                    )

    def test_running_failed_confirmed_group_requires_linked_runtime_receipt(self):
        group = docker_dev_up.RetainedGroup(
            **{**vars(_group()), "terminal": {"state": "failed-confirmed"}}
        )
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch(
                    "docker_volume_activate._linked_runtime_terminals",
                    side_effect=docker_dev_up.BuildControlError(
                        "No succeeded resume or iteration is linked"
                    ),
                ), \
                patch.object(docker_dev_up, "_source_matches") as source_matches:
            with self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "linked succeeded"):
                docker_dev_up.ensure_up(_args())
        source_matches.assert_not_called()

    def test_running_failed_confirmed_group_accepts_linked_current_containers(self):
        group = docker_dev_up.RetainedGroup(
            **{**vars(_group()), "terminal": {"state": "failed-confirmed"}}
        )
        linked = [{
            "backend_container": group.backend_id,
            "frontend_container": group.frontend_id,
        }]
        with patch("docker_volume_activate._linked_runtime_terminals", return_value=linked):
            docker_dev_up._qualify_running_runtime(group)

    def test_changed_toolchain_or_dockerfile_inputs_recreate_before_restart(self):
        for changed in ("toolchain", "image-backend"):
            with self.subTest(changed=changed):
                group = _group()
                with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                        patch.object(
                            docker_dev_up,
                            "_build_inputs_match",
                            side_effect=docker_dev_up.BuildInputDrift([changed]),
                        ), \
                        patch("docker_volume_dev.stop_idle", create=True) as stop_idle, \
                        patch("docker_volume_dev.recreate") as recreate, \
                        patch("docker_volume_dev.restart_idle") as restart:
                    docker_dev_up.ensure_up(_args())
                stop_idle.assert_called_once()
                recreate.assert_called_once()
                restart.assert_not_called()

    def test_build_input_receipts_detect_dependency_and_dockerfile_changes(self):
        group = _group()
        toolchain_image = "sha256:" + "1" * 64
        development_image = "sha256:" + "2" * 64
        backend_image = "sha256:" + "3" * 64
        toolchain_inputs = {
            "source_inputs": [{"path": "docker/fem-gpu/Dockerfile", "sha256": "a" * 64}],
            "build_args": {"FULLMAG_CUDA_BASE_IMAGE": "cuda@sha256:" + "4" * 64},
            "target": "fem-gpu-dev",
        }
        development_inputs = {
            "parent_image_id": toolchain_image,
            "files": [{"path": "docker/all-in-one/Dockerfile.dev", "sha256": "b" * 64}],
        }
        backend_inputs = {
            "parent_image_id": development_image,
            "files": [{"path": "docker/all-in-one/Dockerfile.backend", "sha256": "c" * 64}],
        }

        def receipt(phase, image, inputs):
            return {
                "phase": phase,
                "state": "succeeded",
                "compose_project": group.identity["project_name"],
                "image_id": image,
                "source_digest": hashlib.sha256(
                    docker_dev_up.canonical(inputs)
                ).hexdigest(),
                "inputs": inputs,
            }

        records = {
            "toolchain/verified.json": receipt("toolchain", toolchain_image, toolchain_inputs),
            "image-dev/verified.json": receipt("image-dev", development_image, development_inputs),
            "image-backend/verified.json": receipt("image-backend", backend_image, backend_inputs),
        }
        group = docker_dev_up.RetainedGroup(
            **{
                **vars(group),
                "backend": {
                    **group.backend,
                    "Image": backend_image,
                    "Config": {
                        "Env": [
                            "FULLMAG_TOOLCHAIN_IMAGE_ID=" + toolchain_image,
                            "FULLMAG_RUNTIME_IMAGE_ID=" + backend_image,
                        ]
                    },
                },
                "control": Mock(),
            }
        )
        group.control.read.side_effect = lambda path, optional=False: records.get(path)
        development_manifest = development_inputs["files"]
        backend_manifest = backend_inputs["files"]
        with patch.object(docker_dev_up, "_toolchain_identity", return_value=toolchain_inputs), \
                patch.object(
                    docker_dev_up,
                    "_image_input_manifest",
                    side_effect=[development_manifest, backend_manifest],
                ):
            self.assertTrue(self._build_input_match_impl(group))

        changed_toolchain = {
            **toolchain_inputs,
            "source_inputs": [{"path": "docker/fem-gpu/Dockerfile", "sha256": "e" * 64}],
        }
        with patch.object(docker_dev_up, "_toolchain_identity", return_value=changed_toolchain), \
                patch.object(
                    docker_dev_up,
                    "_image_input_manifest",
                    side_effect=[development_manifest, backend_manifest],
                ):
            with self.assertRaisesRegex(docker_dev_up.BuildInputDrift, "toolchain"):
                self._build_input_match_impl(group)

        changed_backend = [{"path": "docker/all-in-one/Dockerfile.backend", "sha256": "f" * 64}]
        with patch.object(docker_dev_up, "_toolchain_identity", return_value=toolchain_inputs), \
                patch.object(
                    docker_dev_up,
                    "_image_input_manifest",
                    side_effect=[development_manifest, changed_backend],
                ):
            with self.assertRaisesRegex(docker_dev_up.BuildInputDrift, "image-backend"):
                self._build_input_match_impl(group)

    def test_prepared_wrapper_images_keep_the_saved_running_image_authenticated(self):
        from dataclasses import replace
        group = _group()
        old, toolchain, dev, new = ('sha256:' + c * 64 for c in '1234')
        def receipt(phase, image, inputs):
            return {'phase': phase, 'state': 'succeeded',
                    'compose_project': group.identity['project_name'], 'image_id': image,
                    'inputs': inputs, 'source_digest': hashlib.sha256(docker_dev_up.canonical(inputs)).hexdigest()}
        records = {
            'toolchain/verified.json': receipt('toolchain', toolchain, {'source_inputs': []}),
            'image-dev/verified.json': receipt('image-dev', dev, {'parent_image_id': toolchain, 'files': []}),
            'image-backend/verified.json': receipt('image-backend', new, {'parent_image_id': dev, 'files': []}),
        }
        environment = {'FULLMAG_TOOLCHAIN_IMAGE_ID': toolchain, 'FULLMAG_RUNTIME_IMAGE_ID': old}
        service = {'image': old, 'environment': environment}
        backend = {**group.backend, 'Image': old,
                   'Config': {'Env': [key+'='+value for key, value in environment.items()]}}
        group = replace(group, backend=backend, control=Mock(),
                        document={**group.document, 'services': {'backend': service}},
                        terminal={**group.terminal, 'inputs': {'image_id': old}})
        group.control.read.side_effect = lambda name, optional=False: records.get(name)
        with self.assertRaisesRegex(docker_dev_up.BuildInputDrift, 'image-backend'):
            self._build_input_match_impl(group)
        bad_groups = [
            replace(group, terminal={**group.terminal, 'inputs': {'image_id': new}}),
            replace(group, document={**group.document, 'services': {'backend': {**service, 'image': new}}}),
            replace(group, backend={**backend, 'Config': {'Env': [
                'FULLMAG_TOOLCHAIN_IMAGE_ID='+toolchain, 'FULLMAG_RUNTIME_IMAGE_ID='+new]}}),
            replace(group, backend={**backend, 'Config': {'Env': [
                'FULLMAG_TOOLCHAIN_IMAGE_ID='+new, 'FULLMAG_RUNTIME_IMAGE_ID='+old]}}),
        ]
        for bad in bad_groups:
            with self.subTest(bad=bad), self.assertRaises(docker_dev_up.BuildInputUnknown):
                self._build_input_match_impl(bad)

    def test_toolchain_receipt_updated_before_up_recreates_old_authenticated_chain(self):
        group = _group()
        old_toolchain_image = "sha256:" + "4" * 64
        current_toolchain_image = "sha256:" + "5" * 64
        development_image = "sha256:" + "6" * 64
        backend_image = "sha256:" + "7" * 64
        toolchain_inputs = {
            "source_inputs": [{"path": "docker/fem-gpu/Dockerfile", "sha256": "a" * 64}],
            "build_args": {"FULLMAG_CUDA_BASE_IMAGE": "cuda@sha256:" + "8" * 64},
            "target": "fem-gpu-dev",
        }
        development_inputs = {
            "parent_image_id": old_toolchain_image,
            "files": [{"path": "docker/all-in-one/Dockerfile.dev", "sha256": "b" * 64}],
        }
        backend_inputs = {
            "parent_image_id": development_image,
            "files": [{"path": "docker/all-in-one/Dockerfile.backend", "sha256": "c" * 64}],
        }

        def receipt(phase, image, inputs):
            return {
                "phase": phase,
                "state": "succeeded",
                "compose_project": "fullmag-master",
                "image_id": image,
                "source_digest": hashlib.sha256(
                    docker_dev_up.canonical(inputs)
                ).hexdigest(),
                "inputs": inputs,
            }

        records = {
            "toolchain/verified.json": receipt(
                "toolchain", current_toolchain_image, toolchain_inputs
            ),
            "image-dev/verified.json": receipt(
                "image-dev", development_image, development_inputs
            ),
            "image-backend/verified.json": receipt(
                "image-backend", backend_image, backend_inputs
            ),
        }
        group = docker_dev_up.RetainedGroup(
            **{
                **vars(group),
                "backend": {
                    **group.backend,
                    "Image": backend_image,
                    "Config": {
                        "Env": [
                            "FULLMAG_TOOLCHAIN_IMAGE_ID=" + old_toolchain_image,
                            "FULLMAG_RUNTIME_IMAGE_ID=" + backend_image,
                        ]
                    },
                },
                "control": Mock(),
            }
        )
        group.control.read.side_effect = lambda path, optional=False: records.get(path)
        with patch.object(docker_dev_up, "_toolchain_identity", return_value=toolchain_inputs), \
                patch.object(
                    docker_dev_up,
                    "_image_input_manifest",
                    side_effect=[development_inputs["files"], backend_inputs["files"]],
                ):
            with self.assertRaisesRegex(docker_dev_up.BuildInputDrift, "toolchain"):
                self._build_input_match_impl(group)

    def test_missing_build_receipt_blocks_reuse_instead_of_guessing(self):
        group = _group()
        group.control.read.return_value = None
        with self.assertRaises(docker_dev_up.BuildInputUnknown):
            self._build_input_match_impl(group)

    def test_healthy_unchanged_group_is_reused_without_restart(self):
        group = _group()
        args = _args(script=Path("examples/model.py"))
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "_source_matches", return_value=True), \
                patch("docker_volume_dev.restart_idle") as restart, \
                patch("docker_volume_dev.resume") as resume, \
                patch("docker_dev_defaults.activate_discovered") as activate:
            docker_dev_up.ensure_up(args)
        restart.assert_not_called()
        resume.assert_not_called()
        activate.assert_called_once()
        self.assertEqual(activate.call_args.args[0].port, None)

    def test_changed_source_restarts_idle_backend_and_then_activates_script(self):
        group = _group()
        args = _args(script=Path("examples/model.py"))
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "_source_matches", return_value=False), \
                patch("docker_volume_dev.restart_idle") as restart, \
                patch("docker_dev_defaults.activate_discovered") as activate:
            docker_dev_up.ensure_up(args)
        restart.assert_called_once()
        restart_args = restart.call_args.args[0]
        self.assertEqual(restart_args.port, group.port)
        self.assertEqual(restart_args.attempt, group.attempt)
        activate.assert_called_once()

    def test_frontend_only_reuse_starts_frontend_and_restarts_when_source_changed(self):
        group = _group(frontend_running=False)
        args = _args()
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "_source_matches", return_value=False), \
                patch("docker_volume_dev.resume") as resume, \
                patch("docker_volume_dev.restart_idle") as restart:
            docker_dev_up.ensure_up(args)
        resume.assert_called_once()
        self.assertFalse(resume.call_args.args[0].restart_backend)
        restart.assert_called_once()

    def test_stopped_backend_uses_retained_resume_and_preserves_cache(self):
        group = _group(backend_running=False, frontend_running=False)
        args = _args()
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "_image_helpers_match", return_value=True), \
                patch("docker_volume_dev.resume") as resume, \
                patch("docker_volume_dev.restart_idle") as restart:
            docker_dev_up.ensure_up(args)
        resume.assert_called_once()
        self.assertTrue(resume.call_args.args[0].restart_backend)
        restart.assert_not_called()

    def test_stopped_helper_drift_recreates_managed_group_before_activation(self):
        group = _group(backend_running=False, frontend_running=False)
        refreshed = _group()
        args = _args(script=Path("examples/model.py"))
        drift = docker_dev_up.ImageHelperDrift(["backend_dev.py"])
        with patch.object(docker_dev_up, "_discover_group", side_effect=[group, refreshed]), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "_image_helpers_match", side_effect=drift), \
                patch("docker_volume_dev.recreate") as recreate, \
                patch("docker_volume_dev.resume") as resume, \
                patch("docker_dev_defaults.activate_discovered") as activate:
            docker_dev_up.ensure_up(args)
        resume.assert_not_called()
        recreate.assert_called_once()
        recreate_args = recreate.call_args.args[0]
        self.assertIsNone(recreate_args.script)
        self.assertEqual(recreate_args.attempt, group.attempt)
        self.assertEqual(recreate_args.config_sha256, group.config_sha256)
        activate.assert_called_once()

    def test_recreated_group_uses_new_pins_for_repeated_activation_fence(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            (source / "model.py").write_text("VALUE = 1\n", encoding="utf-8")
            group = docker_dev_up.RetainedGroup(
                **{
                    **vars(_group(backend_running=False, frontend_running=False)),
                    "repo_root": source,
                    "source_root": source,
                }
            )
            refreshed = docker_dev_up.RetainedGroup(
                **{
                    **vars(_group()),
                    "repo_root": source,
                    "source_root": source,
                    "attempt": "e" * 32,
                    "config_sha256": "f" * 64,
                }
            )
            args = _args(script=Path("model.py"), request_id=None)
            with patch("fullmag_storage.git", return_value="a" * 40), \
                    patch.object(
                        docker_dev_up,
                        "_discover_group",
                        side_effect=[group, refreshed, refreshed],
                    ), \
                    patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                    patch.object(
                        docker_dev_up,
                        "_image_helpers_match",
                        side_effect=[docker_dev_up.ImageHelperDrift(["backend_dev.py"]), True],
                    ), \
                    patch.object(docker_dev_up, "_source_matches", return_value=True), \
                    patch("docker_volume_dev.recreate"), \
                    patch("docker_volume_dev.resume"), \
                    patch("docker_dev_defaults.activate_discovered") as activate:
                docker_dev_up.ensure_up(args)
                docker_dev_up.ensure_up(args)
                expected_request_id = docker_dev_up._stable_activation_request_id(refreshed, args)
                stale_request_id = docker_dev_up._stable_activation_request_id(group, args)
            request_ids = [call.args[0].request_id for call in activate.call_args_list]
            self.assertEqual(len(request_ids), 2)
            self.assertEqual(request_ids[0], request_ids[1])
            self.assertEqual(request_ids[0], expected_request_id)
            self.assertNotEqual(request_ids[0], stale_request_id)

    def test_recreate_disappeared_group_withholds_activation(self):
        group = _group()
        drift = docker_dev_up.ScriptOutputMappingDrift("output directory changed")
        with patch.object(docker_dev_up, "_discover_group", side_effect=[group, None]), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", side_effect=drift), \
                patch("docker_volume_dev.stop_idle", create=True) as stop_idle, \
                patch("docker_volume_dev.recreate") as recreate, \
                patch("docker_dev_defaults.activate_discovered") as activate:
            with self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "disappeared"):
                docker_dev_up.ensure_up(_args(script=Path("examples/model.py")))
        stop_idle.assert_called_once()
        recreate.assert_called_once()
        activate.assert_not_called()

    def test_running_helper_drift_drains_then_recreates_managed_group(self):
        group = _group()
        args = _args(script=Path("examples/model.py"))
        drift = docker_dev_up.ImageHelperDrift(["backend_dev.py"])
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "_source_matches", side_effect=drift), \
                patch("docker_volume_dev.stop_idle", create=True) as stop_idle, \
                patch("docker_volume_dev.recreate") as recreate, \
                patch("docker_dev_defaults.activate_discovered") as activate:
            docker_dev_up.ensure_up(args)
        stop_idle.assert_called_once()
        self.assertIsNone(stop_idle.call_args.args[0].script)
        recreate.assert_called_once()
        self.assertIsNone(recreate.call_args.args[0].script)
        activate.assert_called_once()

    def test_script_output_mapping_drift_recreates_before_source_probe(self):
        group = _group()
        args = _args(script=Path("examples/model.py"))
        drift = docker_dev_up.ScriptOutputMappingDrift("output directory changed")
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", side_effect=drift), \
                patch.object(docker_dev_up, "_source_matches") as source_matches, \
                patch("docker_volume_dev.stop_idle", create=True) as stop_idle, \
                patch("docker_volume_dev.recreate") as recreate, \
                patch("docker_dev_defaults.activate_discovered") as activate:
            docker_dev_up.ensure_up(args)
        source_matches.assert_not_called()
        stop_idle.assert_called_once()
        recreate.assert_called_once()
        self.assertIsNone(stop_idle.call_args.args[0].script)
        self.assertIsNone(recreate.call_args.args[0].script)
        activate.assert_called_once()

    def test_helper_recreate_is_withheld_when_idle_drain_is_unknown(self):
        group = _group()
        drift = docker_dev_up.ImageHelperDrift(["backend_dev.py"])
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "_source_matches", side_effect=drift), \
                patch("docker_volume_dev.stop_idle", create=True,
                      side_effect=docker_dev_up.DockerDevUpError("drain outcome unknown")) as stop_idle, \
                patch("docker_volume_dev.recreate") as recreate:
            with self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "drain outcome unknown"):
                docker_dev_up.ensure_up(_args())
        stop_idle.assert_called_once()
        recreate.assert_not_called()

    def test_stopped_script_output_mapping_drift_recreates_without_resume(self):
        group = _group(backend_running=False, frontend_running=False)
        refreshed = _group()
        drift = docker_dev_up.ScriptOutputMappingDrift("output directory changed")
        with patch.object(docker_dev_up, "_discover_group", side_effect=[group, refreshed]), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", side_effect=drift), \
                patch.object(docker_dev_up, "_image_helpers_match") as image_helpers, \
                patch("docker_volume_dev.recreate") as recreate, \
                patch("docker_volume_dev.resume") as resume:
            docker_dev_up.ensure_up(_args())
        image_helpers.assert_not_called()
        resume.assert_not_called()
        recreate.assert_called_once()

    def test_script_output_mapping_matches_selected_child_and_rejects_stale_mount(self):
        source = Path(__file__).resolve().parents[1]
        output = source / "examples"
        from docker_script_output_mounts import OUTPUT_ROOT

        document = {
            "name": "fullmag-master",
            "services": {
                "backend": {
                    "volumes": [
                        {"type": "bind", "source": str(source), "target": "/opt/fullmag/source", "read_only": True},
                        {"type": "bind", "source": str(output), "target": OUTPUT_ROOT,
                         "read_only": False, "bind": {"create_host_path": False}},
                    ],
                    "environment": {
                        "FULLMAG_SCRIPT_OUTPUT_ROOT": OUTPUT_ROOT,
                        "FULLMAG_SCRIPT_OUTPUT_SOURCE_DIR": "/opt/fullmag/source/examples",
                    },
                    "x-fullmag-script-output": {
                        "schema": "fullmag.script-output-bind.v1",
                        "source_relative": "examples",
                        "target": OUTPUT_ROOT,
                    },
                },
                "frontend": {"volumes": []},
            },
        }
        group = docker_dev_up.RetainedGroup(
            **{**vars(_group()), "source_root": source, "document": document}
        )
        with patch("docker_script_output_mounts.selected_directory", return_value=output):
            self.assertTrue(docker_dev_up._script_output_mapping_matches(group))
            document["services"]["backend"]["volumes"][1]["source"] = str(source / "examples" / "assets")
            with self.assertRaises(docker_dev_up.ScriptOutputMappingDrift):
                docker_dev_up._script_output_mapping_matches(group)

    def test_stopped_helper_probe_is_labeled_as_owned_build_control_probe(self):
        group = _group(backend_running=False, frontend_running=False)
        image = "sha256:" + "e" * 64
        group = docker_dev_up.RetainedGroup(
            **{**vars(group), "document": {
                "name": group.identity["project_name"],
                "services": {"backend": {"image": image}},
            }}
        )
        result = SimpleNamespace(
            stdout=b'FULLMAG_IMAGE_HELPERS_V1:{"changed":[],"match":true}\n'
        )
        with patch.object(docker_dev_up, "docker_capture", return_value=result) as capture:
            self.assertTrue(docker_dev_up._image_helpers_match(group))
        command = capture.call_args.args
        labels = {
            command[index + 1]
            for index, value in enumerate(command[:-1])
            if value == "--label"
        }
        self.assertIn("com.docker.compose.project=fullmag-master", labels)
        self.assertIn("com.docker.compose.service=build-control", labels)
        self.assertIn("org.fullmag.build.role=probe", labels)
        self.assertIn("org.fullmag.source.project-id=fullmag-test", labels)
        self.assertIn("org.fullmag.source.worktree-id=master", labels)
        self.assertIn("org.fullmag.source.checkout-kind=main-checkout", labels)
        self.assertTrue(any("bind-recursive=disabled" in value for value in command))
        self.assertFalse(any("bind-nonrecursive" in value for value in command))

    def test_source_probe_checks_missing_helper_before_backend_manifest_capture(self):
        self.assertLess(
            docker_dev_up._SOURCE_PROBE.index("if changed_helpers:"),
            docker_dev_up._SOURCE_PROBE.index("import backend_dev"),
        )
        self.assertIn('"matches": False', docker_dev_up._SOURCE_PROBE)
        self.assertIn('raise SystemExit(0)', docker_dev_up._SOURCE_PROBE)

    def test_missing_helper_probe_result_recreates_without_a_second_guest_probe(self):
        group = _group()
        output = (
            b'FULLMAG_SOURCE_MATCH_V1:{"image_helpers_changed":["backend_dev.py (missing)"],'
            b'"image_helpers_match":false,"matches":false}\n'
        )
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch.object(docker_dev_up, "docker_capture", return_value=SimpleNamespace(stdout=output)) as capture, \
                patch("docker_volume_dev.stop_idle", create=True) as stop_idle, \
                patch("docker_volume_dev.recreate") as recreate:
            docker_dev_up.ensure_up(_args())
        self.assertEqual(capture.call_count, 1)
        stop_idle.assert_called_once()
        recreate.assert_called_once()

    def test_control_marker_missing_is_distinct_from_invalid_marker(self):
        control = Mock()
        control.path.return_value = "/control/active"
        control.helper_args.return_value = ["helper"]
        with patch.object(docker_dev_up, "bounded_capture", return_value=SimpleNamespace(returncode=44)):
            self.assertFalse(docker_dev_up._control_file_exists(control, "active"))
        with patch.object(docker_dev_up, "bounded_capture", return_value=SimpleNamespace(returncode=1)), \
                self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "Could not determine"):
            docker_dev_up._control_file_exists(control, "active")
        command = control.helper_args.call_args.args[0]
        self.assertIn("if test -L", command)
        self.assertIn("test ! -L", command)

    def test_stopped_network_allows_no_active_consumers_but_rejects_unknown_owner(self):
        backend = {
            "HostConfig": {"PortBindings": {}, "NetworkMode": "fullmag-net"},
            "NetworkSettings": {"Networks": {"fullmag-master_fullmag": {}}},
        }
        frontend = {
            "HostConfig": {
                "PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3297"}]}
            },
            "NetworkSettings": {"Networks": {"fullmag-master_fullmag": {}}},
        }
        with patch.object(docker_dev_up, "docker_capture", return_value=SimpleNamespace(
            stdout=b'[{"Name":"fullmag-master_fullmag","Driver":"bridge","Labels":{"com.docker.compose.project":"fullmag-master","com.docker.compose.network":"fullmag"},"Containers":{}}]'
        )):
            docker_dev_up._validate_retained_network(
                backend, frontend, "c" * 64, "d" * 64, "fullmag-master",
                "fullmag-master_fullmag", 3297
            )
        with patch.object(docker_dev_up, "docker_capture", return_value=SimpleNamespace(
            stdout=(b'[{"Name":"fullmag-master_fullmag","Driver":"bridge","Labels":{"com.docker.compose.project":"fullmag-master","com.docker.compose.network":"fullmag"},'
                    b'"Containers":{"e":"foreign"}}]')
        )), self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "unknown ownership"):
            docker_dev_up._validate_retained_network(
                backend, frontend, "c" * 64, "d" * 64, "fullmag-master",
                "fullmag-master_fullmag", 3297
            )

        with patch.object(docker_dev_up, "docker_capture", return_value=SimpleNamespace(
            stdout=b"[null]"
        )), self.assertRaisesRegex(
            docker_dev_up.DockerDevUpError, "record is not an object"
        ):
            docker_dev_up._validate_retained_network(
                backend, frontend, "c" * 64, "d" * 64, "fullmag-master",
                "fullmag-master_fullmag", 3297
            )

        with patch.object(docker_dev_up, "docker_capture", return_value=SimpleNamespace(
            stdout=b'[{"Name":"foreign_fullmag","Driver":"bridge","Labels":{"com.docker.compose.project":"fullmag-master","com.docker.compose.network":"fullmag"},"Containers":{}}]'
        )), self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "unknown ownership"):
            docker_dev_up._validate_retained_network(
                backend, frontend, "c" * 64, "d" * 64, "fullmag-master",
                "fullmag-master_fullmag", 3297
            )

        with patch.object(docker_dev_up, "docker_capture", return_value=SimpleNamespace(
            stdout=b'[{"Name":"fullmag-master_fullmag","Driver":"bridge","Labels":{"com.docker.compose.project":"fullmag-master"},"Containers":{}}]'
        )), self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "unknown ownership"):
            docker_dev_up._validate_retained_network(
                backend, frontend, "c" * 64, "d" * 64, "fullmag-master",
                "fullmag-master_fullmag", 3297
            )

    def test_unhealthy_running_backend_is_not_interrupted(self):
        group = _group(healthy=False)
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "not healthy"):
            docker_dev_up.ensure_up(_args())

    def test_unhealthy_backend_without_frontend_is_observed_by_resume(self):
        group = _group(healthy=False, frontend_running=False)
        with patch.object(docker_dev_up, "_discover_group", return_value=group), \
                patch.object(docker_dev_up, "_script_output_mapping_matches", return_value=True), \
                patch("docker_volume_dev.resume") as resume:
            docker_dev_up.ensure_up(_args())
        resume.assert_called_once()
        self.assertFalse(resume.call_args.args[0].restart_backend)

    def test_source_probe_rejects_image_owned_helper_drift(self):
        group = _group()
        output = b'FULLMAG_SOURCE_MATCH_V1:{"image_helpers_changed":["backend_dev.py"],"image_helpers_match":false,"matches":false}\n'
        result = SimpleNamespace(stdout=output)
        with patch.object(docker_dev_up, "docker_capture", return_value=result):
            with self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "image-owned Docker helper"):
                docker_dev_up._source_matches(group)

    def test_source_probe_timeout_is_bounded_but_allows_two_manifest_passes(self):
        self.assertIn("capture_live_source_manifest", docker_dev_up._SOURCE_PROBE)
        with patch.object(docker_dev_up, "docker_capture", return_value=SimpleNamespace(
            stdout=b'FULLMAG_SOURCE_MATCH_V1:{"image_helpers_match":true,"matches":true}\n'
        )) as capture:
            self.assertTrue(docker_dev_up._source_matches(_group()))
        self.assertEqual(capture.call_args.kwargs["timeout"], 600)

    def test_nonterminal_current_receipt_is_unknown_and_must_be_recovered(self):
        control = Mock()
        current = {"attempt": "a" * 32, "state": "starting-services"}
        with self.assertRaisesRegex(docker_dev_up.DockerDevUpError, "unknown outcome"):
            docker_dev_up._read_attempt(control, current)
        control.read.assert_not_called()


if __name__ == "__main__":
    unittest.main()
