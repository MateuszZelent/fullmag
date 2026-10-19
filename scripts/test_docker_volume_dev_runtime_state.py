"""Regressions for native preparation of a fresh Windows runtime state."""

from __future__ import annotations

import hashlib
import inspect
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev
import docker_platform


class DockerVolumeDevRuntimeStateTests(unittest.TestCase):
    @staticmethod
    def _development_context():
        identity = {
            "project_name": "fullmag-worktree-test",
            "project_id": "fullmag",
            "worktree_id": "worktree-test",
            "checkout_kind": "worktree",
        }
        control = docker_volume_dev.BuildControl.__new__(docker_volume_dev.BuildControl)
        control.identity = dict(identity)
        control.project = identity["project_name"]
        operation = {
            "root": "development/attempts/" + "a" * 32,
            "lease_ready": True,
            "receipt": {
                "phase": "development",
                "attempt": "a" * 32,
                "compose_project": identity["project_name"],
                "inputs": {
                    "source_root": str(Path(__file__).resolve().parents[1]),
                    "source_project_id": identity["project_id"],
                    "source_worktree_id": identity["worktree_id"],
                    "source_checkout_kind": identity["checkout_kind"],
                },
            },
        }
        return identity, control, operation

    def test_recovery_reuses_only_matching_development_operation(self):
        identity, control, operation = self._development_context()
        receipt = docker_volume_dev._validate_existing_development_operation(
            control, operation, Path(__file__).resolve().parents[1], identity
        )
        self.assertEqual(receipt["phase"], "development")
        self.assertEqual(
            docker_volume_dev._validate_prepared_start_context(
                {
                    "toolchain": {
                        "image_id": "sha256:" + "b" * 64,
                        "inputs": {"build_args": {}},
                    },
                    "images": {"backend": {"image_id": "sha256:" + "c" * 64}},
                }
            )[0]["image_id"],
            "sha256:" + "b" * 64,
        )
        operation["receipt"]["phase"] = "resume"
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "development phase"):
            docker_volume_dev._validate_existing_development_operation(
                control, operation, Path(__file__).resolve().parents[1], identity
            )

    def test_recovery_context_rejects_identity_and_environment_override(self):
        identity, control, operation = self._development_context()
        operation["receipt"]["inputs"]["source_root"] = "/other-checkout"
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "source differs"):
            docker_volume_dev._validate_existing_development_operation(
                control, operation, Path(__file__).resolve().parents[1], identity
            )
        self.assertEqual(
            docker_volume_dev._validate_recovery_environment(
                {"FULLMAG_CONTAINER_RECOVERY_REQUEST": "request-1"}
            ),
            {"FULLMAG_CONTAINER_RECOVERY_REQUEST": "request-1"},
        )
        for name in ("FULLMAG_SOURCE_ROOT", "PATH"):
            with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "unsupported"):
                docker_volume_dev._validate_recovery_environment({name: "value"})

    def test_precreate_uses_real_write_probe_and_exact_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            state.mkdir()

            with patch.object(docker_volume_dev.sys, "platform", "win32"):
                prepared = docker_volume_dev._precreate_new_windows_runtime_state(state)

            expected = tuple(
                relative.as_posix()
                for relative in docker_volume_dev._NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES
            )
            self.assertEqual(prepared, expected)
            for relative in expected:
                self.assertTrue((state / relative).is_dir())
            self.assertEqual(
                list((state / expected[-1]).iterdir()),
                [],
                "the write probe must not leave technical files in Windows runtime state",
            )

    def test_precreate_rejects_existing_runtime_data_without_adopting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            existing = state / "runs/docker-all/session-store"
            existing.mkdir(parents=True)
            marker = existing / "existing.json"
            marker.write_text("keep", encoding="utf-8")

            with patch.object(docker_volume_dev.sys, "platform", "win32"), self.assertRaises(
                docker_volume_dev.BuildControlError
            ):
                docker_volume_dev._precreate_new_windows_runtime_state(state)

            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
            self.assertTrue(existing.is_dir())

    def test_precreate_rejects_reparse_entry_before_creating_children(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            state.mkdir()
            redirected = root / "outside"
            redirected.mkdir()
            try:
                (state / "runs").symlink_to(redirected, target_is_directory=True)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlink test requires native reparse support: {error}")

            with patch.object(docker_volume_dev.sys, "platform", "win32"), self.assertRaises(
                docker_volume_dev.BuildControlError
            ):
                docker_volume_dev._precreate_new_windows_runtime_state(state)

            self.assertEqual(list(redirected.iterdir()), [])
            self.assertFalse((redirected / "docker-all").exists())

    def test_linux_certificate_bind_is_sibling_and_not_reachable_through_writable_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "attempt"
            state.mkdir()
            certificate_directory = docker_platform.certificate_directory(state)
            self.assertEqual(certificate_directory.parent, state.parent)
            self.assertEqual(certificate_directory.name, state.name + "-host-admission")

            rendered = {
                "services": {
                    "backend": {
                        "volumes": [
                            {"type": "bind", "source": str(state), "target": "/state"},
                            {
                                "type": "bind",
                                "source": str(certificate_directory),
                                "target": docker_platform.LINUX_CERTIFICATE_DIRECTORY_TARGET,
                                "read_only": True,
                            },
                        ]
                    },
                    "frontend": {"volumes": []},
                }
            }
            docker_volume_dev._assert_linux_certificate_mount_isolated(
                rendered, certificate_directory
            )

            nested_certificate = state / "host-admission"
            rendered["services"]["backend"]["volumes"][1]["source"] = str(nested_certificate)
            rendered["services"]["backend"]["volumes"][1]["target"] = (
                docker_platform.LINUX_CERTIFICATE_DIRECTORY_TARGET
            )
            with self.assertRaisesRegex(
                docker_volume_dev.BuildControlError, "exposed through a non-dedicated"
            ):
                docker_volume_dev._assert_linux_certificate_mount_isolated(
                    rendered, nested_certificate
                )

    def test_linux_active_backend_peer_requires_the_same_host_ledger(self):
        expected = (
            "fullmag-linux-host-ledger-v1",
            "project-identity",
            "/storage/fullmag-host-ledger",
            "/storage/build-volumes/ledger.img",
            "daemon-identity",
        )
        peer = {
            "Name": "fullmag-backend-peer",
            "Config": {
                "Hostname": "fullmag-backend-peer",
                "Env": [
                    "FULLMAG_DOCKER_ROLE=backend",
                    "FULLMAG_HOST_LEDGER_PROFILE=" + expected[0],
                    "FULLMAG_HOST_LEDGER_PROJECT_ID=" + expected[1],
                    "FULLMAG_HOST_LEDGER_MOUNT_ROOT=" + expected[2],
                    "FULLMAG_HOST_LEDGER_BACKING_IMAGE=" + expected[3],
                    "FULLMAG_DOCKER_HOST_ID=" + expected[4],
                ],
                "Labels": {},
            },
        }
        unrelated = {"Config": {"Env": ["FULLMAG_DOCKER_ROLE=frontend"], "Labels": {}}}
        self.assertIsNone(
            docker_volume_dev._assert_ledger_peer_documents([peer, unrelated], expected)
        )

        foreign = {
            "Name": "fullmag-foreign-ledger",
            "Config": {
                **peer["Config"],
                "Env": [
                    value.replace(expected[2], "/storage/other-ledger")
                    for value in peer["Config"]["Env"]
                ],
            },
        }
        with self.assertRaisesRegex(
            docker_volume_dev.BuildControlError, "different or unproven host-ledger identity"
        ):
            docker_volume_dev._assert_ledger_peer_documents([foreign], expected)

        unknown = {
            "Name": "fullmag-unproven-backend",
            "Config": {
                "Env": ["FULLMAG_DOCKER_ROLE=backend"],
                "Labels": {},
            },
        }
        with self.assertRaisesRegex(
            docker_volume_dev.BuildControlError, "different or unproven host-ledger identity"
        ):
            docker_volume_dev._assert_ledger_peer_documents([unknown], expected)

    def test_linux_start_identity_roundtrips_into_retained_storage_receipt(self):
        profile = "linux-native-v1"
        runtime_identity = (234567, 345678)
        identity_record = {"uid": runtime_identity[0], "gid": runtime_identity[1]}
        operation = {"receipt": {"inputs": {}}}
        self.assertEqual(
            docker_volume_dev._stamp_start_storage_identity(
                operation, profile, runtime_identity
            ),
            identity_record,
        )
        self.assertEqual(operation["receipt"]["storage_profile"], profile)
        self.assertEqual(operation["receipt"]["runtime_identity"], identity_record)
        self.assertEqual(operation["receipt"]["inputs"]["runtime_identity"], identity_record)
        start_source = inspect.getsource(docker_volume_dev.start)
        self.assertIn("_stamp_start_storage_identity(", start_source)
        self.assertIn('operation_inputs["storage_profile"] = host_profile', start_source)
        self.assertIn('operation_inputs["runtime_identity"] = {', start_source)

        image = "sha256:" + "a" * 64
        docker_host = {"profile": profile, "daemon_id": "local-daemon"}
        certificate = {"image_id": image, "storage_profile": profile, "owner_token": "owner"}
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir()
            certificate_path = Path(temporary) / "state-host-admission" / "linux-native-host.json"
            owner_path = state / ".fullmag-linux-native-owner.json"
            retained = operation["receipt"]
            retained.update(
                state_root=str(state),
                docker_host=docker_host,
                owner_token="owner",
                host_certificate_sha256=hashlib.sha256(b"certificate").hexdigest(),
            )
            with patch.object(docker_volume_dev.storage, "validate_path", side_effect=lambda path, *_: Path(path)), \
                 patch.object(docker_volume_dev, "_host_certificate_paths", return_value=(certificate_path, owner_path)), \
                 patch.object(docker_volume_dev, "_read_host_certificate", return_value=certificate), \
                 patch.object(docker_volume_dev, "_verify_linux_certificate_owner"), \
                 patch.object(docker_platform, "admit_storage_path", return_value={"filesystem": "ext4", "device": "/dev/test"}), \
                 patch.object(docker_platform, "runtime_identity_record", return_value={
                     "profile": profile, "uid": runtime_identity[0], "gid": runtime_identity[1],
                 }), \
                 patch.object(docker_platform, "read_owned_regular", return_value=b"certificate"):
                result = docker_volume_dev._load_retained_storage(
                    {"runtime_root": str(Path(temporary))},
                    retained,
                    profile,
                    image,
                    docker_host,
                )
                self.assertEqual(result, (state, certificate_path, owner_path, certificate))
                retained.pop("runtime_identity")
                with self.assertRaisesRegex(
                    docker_volume_dev.BuildControlError,
                    "runtime UID/GID differs from its pinned receipt",
                ):
                    docker_volume_dev._load_retained_storage(
                        {"runtime_root": str(Path(temporary))},
                        retained,
                        profile,
                        image,
                        docker_host,
                    )

    def test_start_wires_preparation_before_mount_and_compose(self):
        source = inspect.getsource(docker_volume_dev.start)
        self.assertLess(
            source.index("_precreate_new_windows_runtime_state(state)"),
            source.index("admit_storage_path(state)"),
        )
        self.assertLess(
            source.index("_precreate_new_windows_runtime_state(state)"),
            source.index("_start_compose_services(control, operation, document)"),
        )

    def test_new_control_helper_captures_strip_endpoint_overrides_and_keep_pinned_prefix(self):
        endpoint_prefix = ["docker", "--host", "unix:///run/user/234567/docker.sock"]

        class Control:
            image = "sha256:" + "a" * 64

            @staticmethod
            def path(relative):
                return "/opt/fullmag/control/" + relative

            @staticmethod
            def helper_args(script):
                return [*docker_platform.docker_cli_prefix(), "run", Control.image, script]

        result = SimpleNamespace(returncode=0, stdout=b"{}", stderr=b"")
        readers = (
            (docker_volume_dev._read_cancelled_activation_bytes, (Control(), "runtime-control/cancelled.json")),
            (docker_volume_dev._read_runtime_config_digest, (Control(),)),
        )
        for reader, arguments in readers:
            with self.subTest(reader=reader.__name__), \
                 patch.dict(os.environ, {
                     "PATH": "/usr/bin",
                     "DOCKER_HOST": "tcp://untrusted.invalid:2375",
                     "DOCKER_CONTEXT": "untrusted-context",
                 }, clear=True), \
                 patch.object(docker_platform.os, "name", "posix"), \
                 patch.object(docker_platform, "docker_cli_prefix", return_value=endpoint_prefix), \
                 patch.object(docker_volume_dev, "bounded_capture", return_value=result) as capture:
                reader(*arguments)

            command = capture.call_args.args[0]
            self.assertEqual(command[:3], endpoint_prefix)
            self.assertEqual(capture.call_args.kwargs["env"], {"PATH": "/usr/bin"})


if __name__ == "__main__":
    unittest.main()
