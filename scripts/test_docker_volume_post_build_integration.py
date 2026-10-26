"""Caller regressions for the post-build continuation lease boundary.

The test uses the existing managed-start seams and a real continuation binding
validator.  Docker, BuildKit and the native runtime remain mocked; the checks
cover ordering and the legal host-certificate rotation at the handoff.
"""
from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import docker_volume_post_build_generation as continuation
import test_docker_volume_post_build_generation as generation_fixtures


NEW_IMAGE = "sha256:" + "f" * 64
TOOLCHAIN_IMAGE = "sha256:" + "e" * 64
ATTEMPT = "a" * 32


class _Operation:
    def __init__(self, control, events: list[object], inputs: object) -> None:
        self.control = control
        self.events = events
        self.value = {
            "schema": "fullmag.docker-build-operation.v1",
            "phase": "development",
            "state": "starting",
            "attempt": ATTEMPT,
            "compose_project": control.project,
            "control_volume": control.volume,
            "root": "development/attempts/" + ATTEMPT,
            "inputs": inputs,
            "receipt": {
                "schema": "fullmag.docker-build-operation.v1",
                "phase": "development",
                "state": "starting",
                "attempt": ATTEMPT,
                "compose_project": control.project,
                "control_volume": control.volume,
                "inputs": inputs,
            },
            "daemon_pending": False,
        }

    def __enter__(self) -> dict[str, object]:
        self.events.append("development-lease-enter")
        return self.value

    def __exit__(self, _type: object, _value: object, _traceback: object) -> bool:
        self.events.append("development-lease-exit")
        return False


class _Control:
    project = generation_fixtures._Control.project
    volume = project + "-control"
    namespace = ""
    namespace_registry_sha256 = None
    image = TOOLCHAIN_IMAGE

    def __init__(self, events: list[object]) -> None:
        self.events = events
        self.writes: list[tuple[str, object]] = []
        self.operation_value: _Operation | None = None
        self.records: dict[str, bytes] = {}

    def operation(self, phase: str, inputs: object) -> _Operation:
        if phase != "development":
            raise AssertionError("unexpected operation phase: " + phase)
        self.operation_value = _Operation(self, self.events, inputs)
        return self.operation_value

    def write(self, relative: str, value: object) -> None:
        self.writes.append((relative, deepcopy(value)))
        self.events.append("write:" + relative)

    def read(self, relative: str, *, optional: bool = False):
        raw = self.read_raw(relative, optional=optional)
        return None if raw is None else json.loads(raw)

    def read_raw(self, relative: str, *, optional: bool = False) -> bytes | None:
        try:
            return self.records[relative]
        except KeyError:
            if optional:
                return None
            raise FileNotFoundError(relative)


class _Host:
    HOST_CERT_PATH = "/run/fullmag/linux-native-host.json"
    OWNER_NAME = ".fullmag-linux-native-owner.json"

    def __init__(self, certificate: dict[str, object], events: list[object]) -> None:
        self.certificate = certificate
        self.events = events

    def reuse_certificate(self, reuse: object, assembly: dict[str, object], engine_id: str, **_kwargs: object):
        del reuse, engine_id
        self.events.append("certificate-rotate")
        rotated = deepcopy(self.certificate)
        rotated.update(
            image_id=assembly["image_id"],
            source_commit="f" * 40,
            binary_hashes={"fullmag": "f" * 64},
            artifact_receipt_sha256="f" * 64,
            restart_verified=False,
        )
        return rotated

    def admit_runtime_uid(self, _path: object) -> None:
        self.events.append("storage-uid-admit")


def _compose_document(project: str) -> dict[str, object]:
    return {
        "name": project,
        "services": {
            "backend": {"environment": {}, "labels": {}, "volumes": []},
            "frontend": {"environment": {}, "labels": {}, "volumes": []},
        },
        "volumes": {},
    }


class PostBuildStartIntegrationTests(unittest.TestCase):
    def _metadata_fixture(self, source):
        fixture = generation_fixtures.PostBuildContinuationTests("test_true_published_case_binds_old_stop_to_new_stopped_namespace")
        fixture.source_root = str(source)
        fixture.setUp()
        self.addCleanup(lambda: None)
        return fixture, fixture._bound()

    def _exercise_start(self, *, drift=False) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="fullmag-post-build-start-")
        self.addCleanup(temporary.cleanup)
        source = Path(temporary.name)
        fixture, metadata = self._metadata_fixture(source)
        events: list[object] = []
        control = _Control(events)
        control.records.update(fixture.recreation_records)
        control.records.update(fixture.records)
        host_certificate = deepcopy(fixture.certificate["stable_identity"])
        host_certificate.update(
            image_id=fixture.image,
            source_commit="0" * 40,
            binary_hashes={"fullmag": "0" * 64},
            artifact_receipt_sha256="0" * 64,
            restart_expected_sha256="1" * 64,
            restart_verified=True,
        )
        host = _Host(host_certificate, events)
        host.read_owned_regular = lambda _path: json.dumps(host_certificate).encode()
        rendered = _compose_document(control.project)
        toolchain = {
            "image_id": TOOLCHAIN_IMAGE,
            "inputs": {"build_args": {"FULLMAG_CUDA_BASE_IMAGE": TOOLCHAIN_IMAGE}},
        }
        state = source / "state"
        state.mkdir()
        certificate_path = state / "linux-native-host.json"
        owner_path = state / host.OWNER_NAME
        args = types.SimpleNamespace(
            repo_root=source,
            source_root=source,
            port=3197,
            profile="dev",
            image=None,
            toolchain_image=None,
            source_manifest=None,
            include_untracked=None,
            gpu_access="auto",
            script=None,
            fresh_state=False,
        )
        reuse = {
            "state": state,
            "host_certificate": certificate_path,
            "owner_marker": owner_path,
            "receipt": {"image_id": fixture.image},
            "operator_probe_environment_record": {},
        }

        def compose_capture(_document: object, *argv: str, **_kwargs: object) -> bytes:
            service = argv[-1]
            return (("b" if service == "backend" else "c") * 64 + "\n").encode()

        def docker_text(*argv: str, **_kwargs: object) -> str:
            if argv[:2] == ("info", "--format"):
                return "engine-id"
            if argv and argv[0] == "inspect":
                identifier = argv[1]
                service = "backend" if identifier.startswith("b") else "frontend"
                return json.dumps([{
                    "Id": identifier,
                    "Mounts": [],
                    "Config": {"Labels": {
                        "com.docker.compose.project": control.project,
                        "com.docker.compose.service": service,
                    }},
                }])
            raise AssertionError("unexpected docker_text: " + repr(argv))

        def docker_capture(*argv: str, **_kwargs: object) -> subprocess.CompletedProcess:
            if argv and argv[0] == "inspect":
                identifier = argv[1]
                return subprocess.CompletedProcess(
                    argv,
                    1,
                    b"",
                    ("Error: No such object: " + identifier + "\n").encode(),
                )
            if argv and argv[0] == "ps":
                return subprocess.CompletedProcess(argv, 0, b"", b"")
            raise AssertionError("unexpected docker_capture: " + repr(argv))

        def finish(_control, _operation, _document, _backend, _frontend, _selected,
                   _state, _certificate_path, certificate, *_rest):
            events.append(("finish", certificate["image_id"], certificate["restart_verified"]))
            # The storage admission gate turns the legal rotated certificate
            # back to verified after checking the new image/provenance.
            certificate["restart_verified"] = True
            self.assertEqual(
                continuation.certificate_stable_identity(certificate),
                metadata["certificate"]["stable_identity"],
            )

        original_prepare = continuation.prepare_start_binding

        def prepare(*prepare_args, **prepare_kwargs):
            events.append("binding-validate")
            return original_prepare(*prepare_args, **prepare_kwargs)

        fake_script_mounts = types.ModuleType("docker_script_output_mounts")
        fake_script_mounts.configure = lambda *_args, **_kwargs: None
        fake_script_mounts.validate = lambda *_args, **_kwargs: None
        fake_cgroup = types.ModuleType("docker_worker_cgroup")
        fake_cgroup.configure_backend = lambda *_args, **_kwargs: None

        import docker_dev
        import fullmag_docker_runtime as runtime
        import docker_volume_cancelled_activation_guard as cancelled_guard

        with ExitStack() as stack:
            patches = [
                mock.patch.object(__import__("docker_volume_dev"), "require_host"),
            ]
            import docker_volume_dev as dev
            patches.extend([
                # These retained-start cases have no cancelled-activation
                # recovery record; the optional control-volume read is absent.
                mock.patch.object(cancelled_guard, "_read_control_bytes", return_value=None),
                mock.patch.object(docker_dev, "_select_source", return_value=(source, {
                    "runtime_root": str(source), "storage_root": str(source),
                })),
                mock.patch.object(docker_dev, "_compose_identity", return_value={
                    "project_name": control.project, "network_name": control.project + "_fullmag",
                    "project_id": "fullmag-project", "worktree_id": "continuation",
                    "checkout_kind": "worktree",
                }),
                # Host filesystem admission has its own contract suite. This
                # caller fixture deliberately uses runner-local temporary data.
                mock.patch.object(dev, "validate_host_path"),
                mock.patch.object(dev, "BuildControl", return_value=control),
                mock.patch.object(dev, "build_volume_toolchain", side_effect=lambda *_args: events.append("buildkit") or toolchain),
                mock.patch.object(dev, "build_volume_runtime_images", return_value={"backend": {"image_id": NEW_IMAGE}}),
                mock.patch.object(dev, "_operator_probe_record_from_fields", return_value={
                    "operator_probe_environment": {},
                    "operator_probe_environment_sha256": hashlib.sha256(b"{}").hexdigest(),
                }),
                mock.patch.object(docker_dev, "_resolve_gpu_access", return_value="cpu"),
                mock.patch.object(docker_dev, "_verify_docker_gpu_access", return_value="cpu"),
                mock.patch.object(docker_dev, "_assert_no_running_fullmag"),
                mock.patch.object(runtime, "assert_loopback_port_available"),
                mock.patch("docker_dev_defaults.configured_group_budget", return_value={}),
                mock.patch("docker_volume_resources._docker_capacity",
                           return_value={"NCPU": 40, "MemTotal": 196 * 1024 ** 3}),
                mock.patch.object(dev, "local_volume", return_value={}),
                mock.patch.object(dev.storage, "validate_path", side_effect=lambda value, *_args: Path(value)),
                mock.patch.object(dev, "_session_host", return_value=host),
                mock.patch.object(dev, "_read_runtime_config_digest", side_effect=lambda _control: (
                    events.append("config-pin-under-lease") or
                    ("2" * 64 if drift else hashlib.sha256(_control.records[continuation.CONFIG_RELATIVE]).hexdigest())
                )),
                mock.patch.object(dev, "_backend_cache", return_value={
                    "volume_names": [], "environment": {},
                    "overlay": {"services": {"backend": {"labels": {}, "volumes": []},
                                                 "frontend": {"volumes": []}}, "volumes": {}},
                }),
                mock.patch.object(dev, "_frontend", return_value=({}, "frontend-build")),
                # A new render uses the group's own ledger (ADR 0067).
                mock.patch.object(dev, "_group_ledger", return_value=({"environment": {}, "volumes": []}, {
                    "profile": "group-ledger-v1", "image_id": NEW_IMAGE,
                    "compose_volume": {"name": "fullmag-dev-group-ledger-v1-test", "external": True},
                })),
                mock.patch.object(runtime, "_provisional_development_certificate", return_value=({"image_id": NEW_IMAGE}, {}, {})),
                mock.patch.object(runtime, "_reuse_host_certificate", side_effect=host.reuse_certificate),
                mock.patch.object(dev, "docker_text", side_effect=docker_text),
                mock.patch.object(dev, "docker_capture", side_effect=docker_capture),
                mock.patch.object(dev.storage, "git", return_value="f" * 40),
                mock.patch.object(docker_dev, "_source_git_common_directory", return_value=source),
                mock.patch.object(docker_dev, "_workspace_state_root", return_value=source / "user-data"),
                mock.patch.object(dev, "docker_argv", return_value=("docker", "compose")),
                mock.patch.object(dev, "bounded_capture", return_value=subprocess.CompletedProcess(
                    ("docker", "compose"), 0, json.dumps(rendered).encode(), b"",
                )),
                mock.patch.object(dev, "_prefix_runtime_control_mounts"),
                mock.patch.object(dev, "_control_namespace_from_document", return_value=None),
                mock.patch.object(dev, "_resolved_control_subpath", side_effect=lambda _control, service: service),
                mock.patch.object(dev, "_reassert_operator_probe_environment"),
                mock.patch.object(dev, "compose_capture", side_effect=compose_capture),
                mock.patch.object(dev, "_start_compose_services", side_effect=lambda *_args: events.append("compose-start")),
                mock.patch.object(dev, "_finish", side_effect=finish),
                mock.patch("docker_backend_volume_cache.validate_container"),
                mock.patch.object(continuation, "prepare_start_binding", side_effect=prepare),
                mock.patch.dict(sys.modules, {
                    "docker_script_output_mounts": fake_script_mounts,
                    "docker_worker_cgroup": fake_cgroup,
                }),
            ])
            for patch in patches:
                stack.enter_context(patch)
            def invoke():
                return dev.start(
                    args,
                    reuse_state=reuse,
                    previous_config_sha256=metadata["runtime_config"]["sha256"],
                    accepted_reattach_environment=fixture.accepted_context[
                        "accepted_reattach_environment"
                    ],
                    accepted_reattach_metadata=fixture.accepted_context[
                        "accepted_reattach_metadata"
                    ],
                    post_build_generation=metadata,
                )
            if drift:
                with self.assertRaisesRegex(continuation.BuildControlError, "runtime config changed"):
                    invoke()
                self.assertNotIn("certificate-rotate", events)
                self.assertNotIn("compose-start", events)
                return
            invoke()

        self.assertLess(events.index("buildkit"), events.index("development-lease-enter"))
        self.assertLess(events.index("development-lease-enter"), events.index("binding-validate"))
        self.assertLess(events.index("binding-validate"), events.index("certificate-rotate"))
        self.assertLess(events.index("development-lease-enter"), events.index("config-pin-under-lease"))
        self.assertLess(events.index("config-pin-under-lease"), events.index("certificate-rotate"))
        self.assertLess(events.index("config-pin-under-lease"), events.index("compose-start"))
        finish = next(item for item in events if isinstance(item, tuple) and item[0] == "finish")
        self.assertEqual(finish[1], NEW_IMAGE)
        self.assertFalse(finish[2])
        self.assertTrue(any(path.endswith("post-build-continuation.json") for path, _value in control.writes))

    def test_start_binds_after_buildkit_and_accepts_legal_certificate_rotation(self):
        self._exercise_start()

    def test_start_rejects_drift_before_mutating_retained_certificate(self):
        self._exercise_start(drift=True)

    def test_runtime_config_digest_is_derived_by_owner_lock_command(self) -> None:
        raw = b'{"generation":1}\n'
        observed: dict[str, str] = {}

        class Control:
            def path(self, relative: str) -> str:
                return "/control/" + relative

            def helper_args(self, script: str) -> tuple[str, str]:
                observed["script"] = script
                return ("helper", "-c")

        import docker_volume_dev as dev
        result = subprocess.CompletedProcess(("helper",), 0, raw, b"")
        with mock.patch.object(dev, "bounded_capture", return_value=result):
            digest = dev._read_runtime_config_digest(Control())
        self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
        self.assertIn("OWNER.lock", observed["script"])
        self.assertIn("exec 9<>", observed["script"])
        self.assertIn("flock -n 9", observed["script"])


if __name__ == "__main__":
    unittest.main()
