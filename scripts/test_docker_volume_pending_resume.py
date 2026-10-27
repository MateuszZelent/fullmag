"""Interpreted pending-continuation regressions; no native compilation."""
from __future__ import annotations

from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_ROOT))

import docker_volume_pending_continuation as pending
import docker_volume_post_build_generation as generation

import docker_volume_dev as docker_dev  # noqa: E402


class RecreateResumeCallerGateTests(unittest.TestCase):

    def test_native_metadata_only_resume_keeps_native_route(self):
        route = pending._classify_recreate_resume(
            {
                "post_build_generation": {"recreate_operation": {"operation_id": "3" * 32}},
            },
            {"restart_verified": True},
            {"native_restart_metadata": {"receipt": "old-native"}},
        )
        self.assertEqual(route, "native")

    def test_false_certificate_carry_accepts_empty_native_context(self):
        route = pending._classify_recreate_resume(
            {
                "post_build_generation": {"recreate_operation": {"operation_id": "3" * 32}},
                "pre_admission_recreate": {
                    "schema": "fullmag.docker-pre-admission-recreate.v1"
                },
            },
            {"restart_verified": False},
            {},
        )
        self.assertEqual(route, "carry")

    def test_admitted_certificate_cannot_enter_carry_route(self):
        with self.assertRaises(pending.PendingCaptureContinuationError):
            pending._classify_recreate_resume(
                {
                    "post_build_generation": {"recreate_operation": {"operation_id": "3" * 32}},
                    "pre_admission_recreate": {
                        "schema": "fullmag.docker-pre-admission-recreate.v1"
                    },
                },
                {"restart_verified": True},
                {},
            )

    def test_metadata_only_provisional_resume_is_rejected_as_partial(self):
        with self.assertRaises(pending.PendingCaptureContinuationError):
            pending._classify_recreate_resume(
                {"post_build_generation": {"recreate_operation": {"operation_id": "3" * 32}}},
                {"restart_verified": False},
                {},
            )

    def test_pre_admission_only_resume_is_rejected_as_partial(self):
        with self.assertRaises(pending.PendingCaptureContinuationError):
            pending._classify_recreate_resume(
                {
                    "pre_admission_recreate": {
                        "schema": "fullmag.docker-pre-admission-recreate.v1"
                    }
                },
                {"restart_verified": False},
                {},
            )

    def test_carry_with_native_authority_is_rejected(self):
        with self.assertRaises(pending.PendingCaptureContinuationError):
            pending._classify_recreate_resume(
                {
                    "post_build_generation": {"recreate_operation": {"operation_id": "3" * 32}},
                    "pre_admission_recreate": {
                        "schema": "fullmag.docker-pre-admission-recreate.v1"
                    },
                },
                {"restart_verified": False},
                {"native_restart_metadata": {"receipt": "unexpected"}},
            )

    def test_missing_new_native_proof_returns_empty_context(self):
        control = SimpleNamespace(project="fullmag", volume="build-control")
        previous = {
            "attempt": "b" * 32,
            "inputs": {"source_root": "/src"},
            # The old continuation proof is intentionally present; it is not
            # a native recovery authority for the new failed backend.
            "post_build_generation": {
                "recreate_operation": {"operation_id": "3" * 32}
            },
        }
        document = {"services": {"backend": {"environment": {}}}}
        with (
            patch.object(docker_dev, "_native_failed_stop_recovery_context", return_value=None),
            patch(
                "docker_volume_pre_ack_retry.retained_pre_ack_context",
                return_value=None,
            ),
            patch("docker_volume_pre_api_stop.retained_context", return_value=None),
        ):
            context = docker_dev._retained_recovery_context(
                control,
                previous,
                document,
                fresh_state=False,
                backend_id="b" * 64,
            )
        self.assertEqual(context, {})


class _Control:
    project = "fullmag-carry-test"
    volume = "fullmag-carry-test-control"

    def read(self, _relative: str, *, optional: bool = False):
        if optional:
            return None
        raise AssertionError("unexpected control-volume read in caller gate")


class RecreatedOperationCallerTests(unittest.TestCase):
    image = "sha256:" + "a" * 64
    old_attempt = "b" * 32
    recreate_attempt = "c" * 32

    def _args(self):
        return SimpleNamespace(
            include_untracked=None,
            gpu_access=None,
            script=None,
            fresh_state=False,
        )

    def _records(self, *, metadata, preproof, native_context, certificate):
        previous = {
            "attempt": self.old_attempt,
            "state_root": "/state/fullmag",
            "inputs": {"source_root": "/src/fullmag", "gpu_access_requested": "auto"},
        }
        return {
            "previous": previous,
            "document": {"services": {"backend": {"environment": {}}}},
            "operation_terminal": {
                "attempt": self.recreate_attempt,
                "post_build_generation": metadata,
                **({"pre_admission_recreate": preproof} if preproof is not None else {}),
            },
            "snapshot": {"backend": {}, "frontend": {}},
            "image_id": self.image,
            "proof": {"container_id": "d" * 64},
            "operator_probe_record": {},
            "native_recovery_context": native_context,
        }, certificate

    def _common_patches(self, records, certificate):
        metadata = records["operation_terminal"].get("post_build_generation")
        preproof = records["operation_terminal"].get("pre_admission_recreate")
        carried = {"metadata": metadata, "previous_config_sha256": "e" * 64}
        patches = [
            patch.object(docker_dev, "_validate_recreation_resume_records", return_value=records),
            patch.object(docker_dev.storage, "validate_path", return_value=Path("/state/fullmag")),
            patch.object(docker_dev, "_certificate_path", return_value=Path("/state/fullmag/CERT")),
            patch.object(docker_dev, "_retained_certificate", return_value=certificate),
            patch.object(docker_dev, "_retained_startup_enabled", return_value=False),
            patch.object(docker_dev, "_session_host", return_value=SimpleNamespace(OWNER_NAME="OWNER")),
            patch.object(docker_dev, "include_untracked_from_compose", return_value=[]),
            patch.object(docker_dev, "_assert_post_build_removed_namespace_absent"),
            patch.object(docker_dev, "_post_build_certificate_evidence", return_value={}),
            patch.object(docker_dev, "_read_runtime_config_digest", return_value="e" * 64),
            patch.object(docker_dev, "start", return_value="started"),
            patch.object(pending, "validate_pending_capture_continuation", return_value=carried),
            patch.object(pending, "validate_carry_recreate_receipt"),
            patch.object(generation, "bind_recreate_operation"),
        ]
        if preproof is None:
            patches.extend(
                [
                    patch.object(
                        generation,
                        "bind_recreate_operation",
                        side_effect=lambda value, _proof: value,
                    ),
                    patch.object(
                        generation,
                        "validate_resume_continuation",
                        side_effect=lambda *_args, **_kwargs: metadata,
                    ),
                ]
            )
        return patches

    def test_carry_resume_calls_actual_start_without_rebinding_old_metadata(self):
        metadata = {"recreate_operation": {"operation_id": self.old_attempt}}
        preproof = {"config_sha256": "e" * 64}
        records, certificate = self._records(
            metadata=metadata,
            preproof=preproof,
            native_context={},
            certificate={"image_id": self.image, "restart_verified": False},
        )
        control = _Control()
        args = self._args()
        patches = self._common_patches(records, certificate)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8], patches[9], patches[10] as start, patches[11] as pending_validate, patches[12] as carry_receipt, patches[13] as bind:
            result = docker_dev._resume_recreated_operation(
                args,
                control,
                Path("/src/fullmag"),
                {"runtime_root": "/runtime"},
                {"project_id": "p", "worktree_id": "w", "checkout_kind": "worktree"},
            )
        self.assertEqual(result, "started")
        # The actual caller must pass the immutable old metadata and the new
        # recreation proof; it must never call bind_recreate_operation here.
        start.assert_called_once()
        self.assertEqual(start.call_args.kwargs["post_build_generation"], metadata)
        self.assertEqual(start.call_args.kwargs["recreation_resume_proof"], records["proof"])
        pending_validate.assert_called_once()
        carry_receipt.assert_called_once()
        bind.assert_not_called()

    def test_native_metadata_only_resume_still_uses_native_validator(self):
        metadata = {"recreate_operation": {"operation_id": self.recreate_attempt}, "runtime_config": {"sha256": "e" * 64}}
        records, certificate = self._records(
            metadata=metadata,
            preproof=None,
            native_context={"native_restart_metadata": {"receipt": "native"}},
            certificate={"image_id": self.image, "restart_verified": True},
        )
        with patch.object(docker_dev, "start", return_value="started") as start, \
             patch.object(docker_dev, "_validate_recreation_resume_records", return_value=records), \
             patch.object(docker_dev.storage, "validate_path", return_value=Path("/state/fullmag")), \
             patch.object(docker_dev, "_certificate_path", return_value=Path("/state/fullmag/CERT")), \
             patch.object(docker_dev, "_retained_certificate", return_value=certificate), \
             patch.object(docker_dev, "_retained_startup_enabled", return_value=False), \
             patch.object(docker_dev, "_session_host", return_value=SimpleNamespace(OWNER_NAME="OWNER")), \
             patch.object(docker_dev, "include_untracked_from_compose", return_value=[]), \
             patch.object(docker_dev, "_post_build_certificate_evidence", return_value={}), \
             patch.object(docker_dev, "_read_runtime_config_digest", return_value="e" * 64), \
             patch.object(generation, "bind_recreate_operation", side_effect=lambda value, _proof: value) as bind, \
             patch.object(generation, "validate_resume_continuation", side_effect=lambda *_a, **_k: metadata):
            result = docker_dev._resume_recreated_operation(
                self._args(),
                _Control(),
                Path("/src/fullmag"),
                {"runtime_root": "/runtime"},
                {"project_id": "p", "worktree_id": "w", "checkout_kind": "worktree"},
            )
        self.assertEqual(result, "started")
        bind.assert_called_once()
        start.assert_called_once()

    def test_false_certificate_without_carry_receipt_stays_rejected(self):
        records, certificate = self._records(
            metadata=None,
            preproof=None,
            native_context={},
            certificate={"image_id": self.image, "restart_verified": False},
        )
        with patch.object(docker_dev, "start") as start, \
             patch.object(docker_dev, "_validate_recreation_resume_records", return_value=records), \
             patch.object(docker_dev.storage, "validate_path", return_value=Path("/state/fullmag")), \
             patch.object(docker_dev, "_certificate_path", return_value=Path("/state/fullmag/CERT")), \
             patch.object(docker_dev, "_retained_certificate", return_value=certificate), \
             patch.object(docker_dev, "_retained_startup_enabled", return_value=False), \
             patch.object(docker_dev, "_session_host", return_value=SimpleNamespace(OWNER_NAME="OWNER")):
            with self.assertRaises(docker_dev.BuildControlError):
                docker_dev._resume_recreated_operation(
                    self._args(),
                    _Control(),
                    Path("/src/fullmag"),
                    {"runtime_root": "/runtime"},
                    {"project_id": "p", "worktree_id": "w", "checkout_kind": "worktree"},
                )
        start.assert_not_called()




class FrontendOnlyResumeTests(unittest.TestCase):
    """A later frontend failure does not invalidate the successful start receipt."""

    def run_resume(self, *, frontend_stopped=True, backend_stopped=False):
        from contextlib import ExitStack
        import hashlib
        from test_docker_volume_idle_stop import IdleStopFixture, DockerVolumeIdleStopTests

        fixture = IdleStopFixture()
        self.last_fixture = fixture
        fixture.frontend_stopped = frontend_stopped
        fixture.backend_stopped = backend_stopped
        fixture.args.port = 3230
        fixture.environment.update(FULLMAG_SOURCE_GIT_COMMON="/opt/fullmag/source-git", FULLMAG_TOOLCHAIN_IMAGE_ID="fixture-toolchain")
        fixture.args.config_sha256 = hashlib.sha256(docker_dev.canonical(fixture.document)).hexdigest()
        helper = DockerVolumeIdleStopTests()
        with ExitStack() as stack:
            mocks = [stack.enter_context(patcher) for patcher in helper._patches(fixture, (b"", {}))]
            prepare = stack.enter_context(patch.object(docker_dev, "_frontend"))
            stack.enter_context(patch.object(docker_dev, "_retained_ledger_profile", return_value={}))
            compose = stack.enter_context(patch.object(docker_dev, "compose_capture", side_effect=fixture.compose))
            docker_dev.resume(fixture.args)
            self.assertEqual(fixture.previous["state"], "succeeded")
            self.assertTrue(prepare.called)
            mocks[-1].assert_called_once()
            self.assertEqual([call.args[1:] for call in compose.call_args_list if call.args[1:2] == ("start",)], [("start", "frontend")])
            self.assertFalse(any(event[0] == "stop" for event in fixture.events))

    def test_successful_start_resumes_only_later_stopped_frontend(self):
        self.run_resume()

    def test_running_frontend_is_rejected_without_lifecycle_change(self):
        with self.assertRaisesRegex(docker_dev.BuildControlError, "backend running and frontend stopped"):
            self.run_resume(frontend_stopped=False)
        self.assertFalse(self.last_fixture.control.operation.called)

    def test_stopped_backend_is_rejected_without_implicit_restart(self):
        with self.assertRaisesRegex(docker_dev.BuildControlError, "backend running and frontend stopped"):
            self.run_resume(backend_stopped=True)
        self.assertFalse(self.last_fixture.control.operation.called)


if __name__ == "__main__":
    unittest.main()
