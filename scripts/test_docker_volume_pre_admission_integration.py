"""Integration regressions for retained pre-admission service recreation.

The fixtures exercise the current retained-operation boundary: proof and
container identity are revalidated under the recreate lease before any
service removal, while accepted-run state is checked through its read-only
bundle path.
"""

from __future__ import annotations

from copy import deepcopy
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

from docker_build_control import BuildControlError


PROJECT = "fullmag-worktree-pre-admission"
VOLUME = PROJECT + "-control"
DEV_ATTEMPT = "9" * 32
BACKEND_ID = "b" * 64
FRONTEND_ID = "c" * 64
IMAGE = "sha256:" + "d" * 64
STARTED_AT = "2026-10-20T15:16:30.069415108Z"
SOURCE_PROJECT = "fullmag-project"
SOURCE_WORKTREE = "pre-admission"


def _service(service: str, identifier: str, *, started_at: str = STARTED_AT) -> dict[str, object]:
    state: dict[str, object] = {"Running": False, "StartedAt": started_at}
    if service == "backend":
        state.update(ExitCode=2, OOMKilled=False, FinishedAt="2026-10-20T15:30:10.872027859Z")
    return {
        "Id": identifier,
        "Image": IMAGE,
        "State": state,
        "Config": {
            "Labels": {
                "com.docker.compose.project": PROJECT,
                "com.docker.compose.service": service,
                "org.fullmag.source.worktree-id": SOURCE_WORKTREE,
            },
        },
    }


class _Operation:
    def __init__(self, events: list[object]) -> None:
        self.events = events
        self.value = {
            "root": "recreate-services/attempts/" + "1" * 32,
            "receipt": {
                "phase": "recreate-services",
                "attempt": "1" * 32,
                "compose_project": PROJECT,
            },
            "daemon_pending": False,
        }

    def __enter__(self) -> dict[str, object]:
        self.events.append("lease-enter")
        return self.value

    def __exit__(self, _type: object, _value: object, _traceback: object) -> bool:
        self.events.append("lease-exit")
        return False


class _Control:
    project = PROJECT
    volume = VOLUME
    namespace = ""
    namespace_registry_sha256 = None

    def __init__(self, previous: dict[str, object], document: dict[str, object], events: list[object]) -> None:
        self.previous = previous
        self.document = document
        self.events = events
        self.writes: list[tuple[str, object]] = []
        self.operation_value = _Operation(events)

    def prepare(self) -> None:
        self.events.append("control-prepare")

    def read(self, relative: str, *, optional: bool = False) -> object:
        if relative.endswith("/terminal.json"):
            return deepcopy(self.previous)
        if relative.endswith("/compose.json"):
            return deepcopy(self.document)
        if optional:
            return None
        raise AssertionError("unexpected control read: " + relative)

    def operation(self, phase: str, _inputs: object) -> _Operation:
        if phase != "recreate-services":
            raise AssertionError("unexpected operation phase: " + phase)
        return self.operation_value

    def write(self, relative: str, value: object) -> None:
        self.writes.append((relative, deepcopy(value)))
        self.events.append("write:" + relative)


class _Harness:
    def __init__(self, *, accepted: bool = False, drift_under_lease: bool = False) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-pre-admission-integration-")
        root = Path(self.temp.name)
        self.source = root / "source"
        self.state = root / "state"
        self.source.mkdir()
        self.state.mkdir()
        self.events: list[object] = []
        self.drift_under_lease = drift_under_lease
        self.inspect_calls: dict[str, int] = {"backend": 0, "frontend": 0}
        self.archive_runtime_control = mock.Mock(return_value={"archived": True})
        self.certificate = {
            "schema": "fullmag.windows-folder-host.v1",
            "storage_profile": "windows-folder-v1",
            "image_id": IMAGE,
            "source_commit": "0" * 40,
            "artifact_receipt_sha256": "0" * 64,
            "binary_hashes": {"fullmag": "0" * 64},
            "restart_verified": False,
            "owner_token": "00000000-0000-4000-8000-000000000001",
        }
        self.identity = {
            "project_name": PROJECT,
            "project_id": SOURCE_PROJECT,
            "worktree_id": SOURCE_WORKTREE,
            "checkout_kind": "worktree",
        }
        self.document = {
            "name": PROJECT,
            "services": {
                "backend": {
                    "image": IMAGE,
                    "gpus": [{"count": "all"}],
                    "environment": {
                        "FULLMAG_DOCKER_DEVICE_ACCESS": "gpu",
                        "FULLMAG_DEV_INCLUDE_UNTRACKED": "[]",
                        "FULLMAG_STARTUP_ENABLED": "0",
                    },
                    "labels": {
                        "com.docker.compose.project": PROJECT,
                        "com.docker.compose.service": "backend",
                        "org.fullmag.source.worktree-id": SOURCE_WORKTREE,
                    },
                    "volumes": [],
                },
                "frontend": {
                    "image": IMAGE,
                    "labels": {
                        "com.docker.compose.project": PROJECT,
                        "com.docker.compose.service": "frontend",
                        "org.fullmag.source.worktree-id": SOURCE_WORKTREE,
                    },
                    "volumes": [],
                },
            },
            "volumes": {},
        }
        self.config_sha256 = hashlib.sha256(self._canonical(self.document)).hexdigest()
        self.previous = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "failed-confirmed",
            "attempt": DEV_ATTEMPT,
            "compose_project": PROJECT,
            "control_volume": VOLUME,
            "state_root": str(self.state),
            "backend_container": BACKEND_ID,
            "frontend_container": FRONTEND_ID,
            "backend_volumes": ["backend-cache"],
            "frontend_volume": "frontend-build",
            "inputs": {
                "source_root": str(self.source),
                "image_id": IMAGE,
                "source_project_id": SOURCE_PROJECT,
                "source_worktree_id": SOURCE_WORKTREE,
                "source_checkout_kind": "worktree",
                "gpu_access_requested": "auto",
                "device_access": "gpu",
                "gpu_preflight": "PASS",
            },
        }
        self.actual = {
            "backend": _service("backend", BACKEND_ID),
            "frontend": _service("frontend", FRONTEND_ID),
        }
        self.accepted_environment = {
            "FULLMAG_ACCEPTED_REATTACH_REQUEST": "accepted-run-reattach/" + "a" * 64 + ".json",
            "FULLMAG_ACCEPTED_REATTACH_REQUEST_SHA256": "1" * 64,
        }
        self.accepted_pins = {
            "schema": "fullmag.docker-accepted-run-reattach-producer.v1",
            "state": "prepared",
            "request_sha256": "1" * 64,
            "proof_sha256": "2" * 64,
        }
        self.accepted = accepted
        self.control = _Control(self.previous, self.document, self.events)
        self.args = types.SimpleNamespace(
            repo_root=self.source,
            source_root=self.source,
            attempt=DEV_ATTEMPT,
            config_sha256=self.config_sha256,
            include_untracked=None,
            gpu_access=None,
            restart_backend=False,
            script=None,
            fresh_state=False,
            resume_recreation=None,
            profile="dev",
            image=None,
            toolchain_image=None,
            source_manifest=None,
            recovery_authorization=None,
            port=3197,
        )

    @staticmethod
    def _canonical(value: object) -> bytes:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()

    def close(self) -> None:
        self.temp.cleanup()

    def docker_text(self, *arguments: str, **_kwargs: object) -> str:
        if arguments[:2] == ("image", "inspect"):
            return json.dumps([{"Id": IMAGE, "Config": {"Entrypoint": ["entry"], "Cmd": ["serve"]}}])
        if arguments[:1] != ("inspect",):
            raise AssertionError("unexpected docker_text: " + repr(arguments))
        identifiers = {BACKEND_ID: "backend", FRONTEND_ID: "frontend"}
        service = identifiers[arguments[1]]
        self.inspect_calls[service] += 1
        observed = deepcopy(self.actual[service])
        if self.drift_under_lease and service == "backend" and self.inspect_calls[service] == 2:
            observed["State"]["StartedAt"] = "2026-10-20T15:16:31.000000000Z"
        self.events.append("inspect:" + service + ":" + str(self.inspect_calls[service]))
        return json.dumps([observed])

    def compose_capture(self, _document: object, *arguments: str, **_kwargs: object) -> bytes:
        service = arguments[-1]
        if service == "backend":
            return (BACKEND_ID + "\n").encode()
        if service == "frontend":
            return (FRONTEND_ID + "\n").encode()
        raise AssertionError("unexpected compose service: " + service)

    def docker_capture(self, *arguments: str, **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if arguments and arguments[0] == "inspect":
            return subprocess.CompletedProcess(arguments, 1, b"", b"no such helper")
        if arguments and arguments[0] == "rm":
            self.events.append("rm")
            return subprocess.CompletedProcess(arguments, 0, b"", b"")
        raise AssertionError("unexpected docker_capture: " + repr(arguments))


def _helper_module(harness: _Harness, *, proof_drift: bool = False, reject: bool = False) -> types.ModuleType:
    module = types.ModuleType("docker_volume_pre_admission_recreate")

    class _TypedProofError(RuntimeError):
        pass

    module.PreAdmissionRecreateError = _TypedProofError
    calls = {"count": 0}

    def validate(*_arguments: object, **_keywords: object) -> dict[str, object]:
        calls["count"] += 1
        harness.events.append(("proof", calls["count"]))
        if reject:
            raise _TypedProofError("post-publication or probe evidence is present")
        proof: dict[str, object] = {
            "schema": "fullmag.docker-pre-admission-recreate.v1",
            "state": "validated",
            "parent_attempt": DEV_ATTEMPT,
            "config_sha256": harness.config_sha256,
            "certificate": {"restart_verified": False, "owner_sha256": "3" * 64},
            "failure": {"backend_started_at": STARTED_AT, "published_paths_absent": [
                "handoff-log.json", "backend-build-receipt.json", "provenance.json", "storage-probe-log.json",
            ]},
        }
        if proof_drift and calls["count"] == 2:
            proof["failure"]["failure_log_sha256"] = "4" * 64
        return proof

    module.validate_pre_admission_recreate = validate
    module.calls = calls
    return module


class RetainedPreAdmissionIntegrationTests(unittest.TestCase):
    def _run(self, harness: _Harness, *, helper: types.ModuleType, accepted_module: types.ModuleType | None = None, recovery_context=None, device_probe=None):
        import docker_build_control
        import docker_dev
        import docker_volume_cancelled_activation_guard
        import docker_volume_activation_reconcile
        import docker_volume_dev as dev

        configuration = {"services": {"fem-gpu-toolchain": {"build": {"args": {
            "FULLMAG_CUDA_BASE_IMAGE": "sha256:" + "e" * 64,
        }}}}}
        identity = harness.identity
        started = mock.Mock(return_value={"started": True})
        patches = [
            # The retained recreation cases in this harness have no cancelled
            # activation recovery record; model that optional helper read as
            # an authenticated absence while exercising the real guard.
            mock.patch.object(
                docker_volume_cancelled_activation_guard,
                "_read_control_bytes",
                return_value=None,
            ),
            mock.patch.object(dev, "require_host"),
            mock.patch.object(docker_dev, "_select_source", return_value=(harness.source, {"runtime_root": str(harness.state)})),
            mock.patch.object(docker_dev, "_compose_identity", return_value=identity),
            mock.patch.object(docker_build_control, "toolchain_configuration", return_value=configuration),
            mock.patch.object(dev, "BuildControl", return_value=harness.control),
            mock.patch.object(dev, "_operator_probe_record_from_retained", return_value={}),
            mock.patch.object(dev, "compose_capture", side_effect=harness.compose_capture),
            mock.patch.object(dev, "docker_text", side_effect=harness.docker_text),
            mock.patch.object(dev, "docker_capture", side_effect=harness.docker_capture),
            mock.patch.object(dev, "_validate_retained_service"),
            mock.patch.object(dev, "_retained_recovery_context",
                              **({"side_effect": recovery_context} if callable(recovery_context)
                                 else {"return_value": recovery_context or {}})),
            mock.patch.object(dev, "_retained_certificate", return_value=harness.certificate),
            mock.patch.object(dev, "_certificate_path", return_value=harness.state / "certificate.json"),
            mock.patch.object(dev.storage, "validate_path", side_effect=lambda value, *_args: Path(value)),
            mock.patch.object(dev, "_retained_startup_enabled", return_value=False),
            mock.patch.object(
                docker_volume_activation_reconcile,
                "reconcile_unknown_activation",
                return_value=(
                    {"attempt": "a" * 32} if harness.accepted else None
                ),
            ),
            mock.patch.object(dev, "start", started),
            # Fresh state archives the old runtime root through the managed
            # control helper; the harness control is not a real BuildControl.
            mock.patch(
                "docker_volume_fresh_runtime.archive_runtime_control",
                harness.archive_runtime_control,
            ),
        ]
        if accepted_module is not None:
            patches.append(mock.patch.dict(sys.modules, {"docker_volume_accepted_reattach": accepted_module}))
            patches.extend([
                mock.patch.object(dev, "_validate_accepted_reattach_environment", side_effect=lambda value: value),
                mock.patch.object(dev, "_validate_accepted_reattach_metadata", side_effect=lambda value, _environment: value),
            ])
        patches.append(mock.patch.object(dev, "_probe_retained_device_access",
                                         **({"side_effect": device_probe} if device_probe is not None else {"return_value": "gpu"})))
        patches.append(mock.patch.dict(sys.modules, {"docker_volume_pre_admission_recreate": helper}))
        with ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            result = dev._retained_operation(harness.args, recreate_services=True)
        return result, started

    def _accepted_module(self, harness: _Harness, *, drift: bool = False) -> types.ModuleType:
        module = types.ModuleType("docker_volume_accepted_reattach")
        module.produce_accepted_reattach = mock.Mock(
            side_effect=lambda *_args, **_kwargs: (
                harness.events.append("accepted-produce-before-lease")
                or {"environment": deepcopy(harness.accepted_environment), "pins": deepcopy(harness.accepted_pins)}
            )
        )
        fresh_environment = deepcopy(harness.accepted_environment)
        fresh_pins = deepcopy(harness.accepted_pins)
        if drift:
            fresh_pins["proof_sha256"] = "f" * 64
        module.build_accepted_reattach_bundle = mock.Mock(
            side_effect=lambda *_args, **_kwargs: (
                harness.events.append("accepted-bundle-under-lease")
                or {"environment": fresh_environment, "pins": fresh_pins}
            )
        )
        return module

    def test_offline_proof_is_rechecked_with_exact_lease_before_removal(self) -> None:
        import docker_volume_offline_reconcile as offline

        harness = _Harness()
        self.addCleanup(harness.close)
        helper = _helper_module(harness)
        harness.args.offline_reconciliation = "7" * 32
        calls = []

        def validate(*_args, **kwargs):
            calls.append(kwargs)
            self.assertEqual(kwargs["expected_operation_attempt"], "7" * 32)
            if len(calls) == 1:
                self.assertNotIn("lease-enter", harness.events)
                self.assertNotIn("current_operation", kwargs)
                return True
            self.assertIn("lease-enter", harness.events)
            self.assertIs(kwargs["current_operation"], harness.control.operation_value.value)
            raise BuildControlError("offline proof changed under lease")

        with mock.patch.object(offline, "validate_for_recreate", side_effect=validate):
            with self.assertRaisesRegex(BuildControlError, "offline proof changed under lease"):
                self._run(harness, helper=helper)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("rm", harness.events)
        harness.archive_runtime_control.assert_not_called()

    def test_exact_failure_proofs_are_revalidated_under_lease_before_rm(self) -> None:
        harness = _Harness()
        self.addCleanup(harness.close)
        helper = _helper_module(harness)
        before = deepcopy(harness.certificate)
        result, started = self._run(harness, helper=helper)

        self.assertEqual(result, {"started": True})
        self.assertEqual(helper.calls["count"], 2)
        self.assertEqual(harness.certificate, before)
        self.assertLess(harness.events.index(("proof", 2)), harness.events.index("rm"))
        self.assertLess(harness.events.index(("proof", 2)), harness.events.index("lease-exit"))
        self.assertIsNotNone(started.call_args.kwargs["reuse_state"])
        self.assertIsNone(harness.args.script)
        self.assertFalse(harness.args.fresh_state)

    def test_accepted_run_is_revalidated_read_only_under_same_lease(self) -> None:
        harness = _Harness(accepted=True)
        self.addCleanup(harness.close)
        helper = _helper_module(harness)
        accepted = self._accepted_module(harness)
        _result, started = self._run(harness, helper=helper, accepted_module=accepted)

        self.assertLess(
            harness.events.index("accepted-bundle-under-lease"),
            harness.events.index("rm"),
        )
        self.assertLess(
            harness.events.index("lease-enter"),
            harness.events.index("accepted-bundle-under-lease"),
        )
        self.assertEqual(accepted.produce_accepted_reattach.call_count, 1)
        self.assertEqual(accepted.build_accepted_reattach_bundle.call_count, 1)
        self.assertEqual(
            started.call_args.kwargs["accepted_reattach_environment"],
            harness.accepted_environment,
        )
        self.assertEqual(
            started.call_args.kwargs["accepted_reattach_metadata"],
            harness.accepted_pins,
        )

    def test_started_at_drift_under_lease_is_rejected_before_rm(self) -> None:
        harness = _Harness(drift_under_lease=True)
        self.addCleanup(harness.close)
        helper = _helper_module(harness)
        with self.assertRaisesRegex(BuildControlError, "incarnation changed under lease"):
            self._run(harness, helper=helper)
        self.assertNotIn("rm", harness.events)
        self.assertEqual(helper.calls["count"], 1)

    def test_proof_drift_under_lease_is_rejected_before_rm(self) -> None:
        harness = _Harness()
        self.addCleanup(harness.close)
        helper = _helper_module(harness, proof_drift=True)
        with self.assertRaisesRegex(BuildControlError, "proof changed"):
            self._run(harness, helper=helper)
        self.assertNotIn("rm", harness.events)
        self.assertEqual(helper.calls["count"], 2)

    def test_accepted_archive_drift_is_rejected_before_rm(self) -> None:
        harness = _Harness(accepted=True)
        self.addCleanup(harness.close)
        helper = _helper_module(harness)
        accepted = self._accepted_module(harness, drift=True)
        with self.assertRaisesRegex(BuildControlError, "Accepted-run reattach changed"):
            self._run(harness, helper=helper, accepted_module=accepted)
        self.assertNotIn("rm", harness.events)
        self.assertIn("accepted-bundle-under-lease", harness.events)

    def test_postpublication_or_probe_failure_is_typed_and_has_no_lease_or_rm(self) -> None:
        harness = _Harness()
        self.addCleanup(harness.close)
        helper = _helper_module(harness, reject=True)
        with self.assertRaisesRegex(BuildControlError, "post-publication or probe"):
            self._run(harness, helper=helper)
        self.assertNotIn("lease-enter", harness.events)
        self.assertNotIn("rm", harness.events)

    def test_retained_accepted_bootstrap_cannot_silently_drop_reattach_context(self) -> None:
        for kind in ("metadata", "empty-metadata", "malformed-metadata", "compose-env", "container-env"):
            with self.subTest(kind=kind):
                harness = _Harness()
                self.addCleanup(harness.close)
                if kind == "metadata":
                    harness.previous["accepted_reattach"] = deepcopy(harness.accepted_pins)
                elif kind == "empty-metadata":
                    harness.previous["accepted_reattach"] = {}
                elif kind == "malformed-metadata":
                    harness.previous["accepted_reattach"] = None
                elif kind == "compose-env":
                    harness.document["services"]["backend"]["environment"][
                        "FULLMAG_ACCEPTED_REATTACH_REQUEST"
                    ] = "accepted-run-reattach/retained.json"
                else:
                    harness.actual["backend"]["Config"]["Env"] = [
                        "FULLMAG_ACCEPTED_REATTACH_REQUEST=accepted-run-reattach/retained.json"
                    ]
                harness.config_sha256 = hashlib.sha256(harness._canonical(harness.document)).hexdigest()
                harness.args.config_sha256 = harness.config_sha256
                helper = _helper_module(harness)
                with self.assertRaisesRegex(BuildControlError, "no authenticated reattach context"):
                    self._run(harness, helper=helper)
                self.assertNotIn("lease-enter", harness.events)
                self.assertNotIn("rm", harness.events)
                self.assertEqual(helper.calls["count"], 0)

    def test_admitted_recreate_does_not_reuse_historical_pending_metadata(self) -> None:
        harness = _Harness()
        self.addCleanup(harness.close)
        harness.certificate["restart_verified"] = True
        harness.previous["post_build_generation"] = {"historical": "consumed"}
        harness.previous["post_build_start"] = {"state": "pending"}
        helper = _helper_module(harness, reject=True)
        result, started = self._run(harness, helper=helper)
        self.assertEqual(result, {"started": True})
        self.assertEqual(helper.calls["count"], 0)
        self.assertNotIn("post_build_generation", started.call_args.kwargs)
        self.assertIsNotNone(started.call_args.kwargs["reuse_state"])

    def _after_ready_route(self, *, backend_id=BACKEND_ID,
                           failure_kind="native-after-ready-failure", historical_only=False):
        import docker_volume_dev as dev
        import docker_volume_post_build_generation as generation
        harness = _Harness()
        self.addCleanup(harness.close)
        harness.certificate["restart_verified"] = True
        metadata = {"schema": "fullmag.docker-native-failed-stop-recreate.v1",
                    "failure_kind": failure_kind, "container_id": backend_id,
                    "image_id": IMAGE, "claim_pending": False}
        context = {"native_restart_metadata": metadata, "previous_config_sha256": "a" * 64}
        if historical_only:
            harness.previous["native_failed_restart"] = metadata
            context = {}
        original_read = harness.control.read
        def read(relative, *, optional=False):
            if relative == "verification/stop-failed-" + BACKEND_ID + ".json":
                return {"state": "stopped-confirmed"}
            return original_read(relative, optional=optional)
        harness.control.read = read
        with mock.patch.object(dev, "_post_build_certificate_evidence", return_value={}), \
             mock.patch.object(dev, "_read_runtime_config_digest", return_value="a" * 64), \
             mock.patch.object(generation, "build_failed_owner_continuation",
                               side_effect=BuildControlError("nine-key continuation selected")) as continuation:
            if backend_id == BACKEND_ID and failure_kind == "native-after-ready-failure" and not historical_only:
                result, started = self._run(harness, helper=_helper_module(harness), recovery_context=context)
                self.assertEqual(result, {"started": True})
                self.assertEqual(started.call_args.kwargs["native_restart_metadata"], metadata)
                continuation.assert_not_called()
            else:
                with self.assertRaisesRegex(BuildControlError, "nine-key continuation selected"):
                    self._run(harness, helper=_helper_module(harness), recovery_context=context)
                continuation.assert_called_once()
                self.assertNotIn("rm", harness.events)

    def test_original_after_ready_restart_keeps_native_context_without_later_continuation(self):
        self._after_ready_route()

    def test_later_namespace_and_other_failure_still_require_continuation(self):
        self._after_ready_route(backend_id="a" * 64)
        self._after_ready_route(failure_kind="native-start-failure")

    def test_historical_after_ready_metadata_is_not_restart_authority(self):
        self._after_ready_route(historical_only=True)

    def test_fresh_state_remains_explicit_and_does_not_use_the_exception(self) -> None:
        harness = _Harness()
        self.addCleanup(harness.close)
        harness.args.fresh_state = True
        harness.previous["post_build_generation"] = {"historical": "retained"}
        harness.previous["post_build_start"] = {"state": "pending"}
        helper = _helper_module(harness, reject=True)
        _result, started = self._run(harness, helper=helper)
        self.assertEqual(helper.calls["count"], 0)
        self.assertIsNone(started.call_args.kwargs["reuse_state"])
        harness.archive_runtime_control.assert_called_once()

if __name__ == "__main__":
    unittest.main()
