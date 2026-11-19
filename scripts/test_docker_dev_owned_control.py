"""Regression checks for the narrowly admitted active build-control helper."""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

import docker_compose_identity as identity
import docker_dev


PROJECT = "fullmag-worktree-owned-control"
ATTEMPT = "a" * 32
IMAGE = "registry.example/fullmag-control@sha256:" + "b" * 64
VOLUME = "fullmag-build-control-owned-control"


def _source_identity() -> dict[str, str]:
    return {
        "project_name": PROJECT,
        "network_name": identity.compose_network_name(PROJECT),
        "project_id": "fullmag-test",
        "worktree_id": "owned-control",
        "checkout_kind": "worktree",
    }


def _owned_control() -> dict[str, str]:
    return {
        "name": "fullmag-control-" + ATTEMPT,
        "image": IMAGE,
        "volume": VOLUME,
        "attempt": ATTEMPT,
    }


def _helper_document(**changes: object) -> dict[str, object]:
    labels = {
        **identity.source_labels(_source_identity()),
        "com.docker.compose.project": PROJECT,
        "com.docker.compose.service": "build-control",
    }
    document: dict[str, object] = {
        "Id": "c" * 64,
        "Name": "/" + _owned_control()["name"],
        "Config": {"Image": IMAGE, "Labels": labels},
        "State": {"Running": True},
        "HostConfig": {
            "Runtime": "runc",
            "NetworkMode": "none",
            "DeviceRequests": [],
            "ReadonlyRootfs": True,
            # The helper declares exactly its writable control volume.
            "Mounts": [{"Target": "/control", "Source": VOLUME, "Type": "volume"}],
        },
        "Mounts": [{
            "Type": "volume",
            "Name": VOLUME,
            "Destination": "/control",
            "RW": True,
        }],
    }
    for key, value in changes.items():
        document[key] = value
    return document


class DockerDevOwnedControlTests(unittest.TestCase):
    def _capture(self, document: dict[str, object], *, include_container: bool = True):
        def capture(*args: object, **kwargs: object) -> str:
            if args[:2] == ("ps", "--all"):
                return ("c" * 64 + "\n") if include_container else ""
            if args[:1] == ("inspect",):
                return json.dumps([document])
            if args[:2] == ("network", "ls"):
                return ""
            raise AssertionError(args)

        return capture

    def test_exact_active_helper_is_admitted(self):
        with patch.object(docker_dev, "_docker_capture",
                          side_effect=self._capture(_helper_document())):
            docker_dev._assert_no_running_fullmag(
                PROJECT, _source_identity(), owned_control=_owned_control()
            )

    def test_default_guard_still_rejects_the_same_helper(self):
        with patch.object(docker_dev, "_docker_capture",
                          side_effect=self._capture(_helper_document())):
            with self.assertRaisesRegex(docker_dev.DirectDockerError, "running or stopped"):
                docker_dev._assert_no_running_fullmag(PROJECT, _source_identity())

    def test_any_other_project_container_still_blocks(self):
        document = _helper_document()
        document["Name"] = "/fullmag-backend"
        with patch.object(docker_dev, "_docker_capture",
                          side_effect=self._capture(document)):
            with self.assertRaisesRegex(docker_dev.DirectDockerError, "unadmitted container"):
                docker_dev._assert_no_running_fullmag(
                    PROJECT, _source_identity(), owned_control=_owned_control()
                )

    def test_owned_control_requires_the_helper_to_still_exist(self):
        with patch.object(
            docker_dev, "_docker_capture",
            side_effect=self._capture(_helper_document(), include_container=False),
        ):
            with self.assertRaisesRegex(docker_dev.DirectDockerError, "no longer present"):
                docker_dev._assert_no_running_fullmag(
                    PROJECT, _source_identity(), owned_control=_owned_control()
                )

    def test_helper_is_rejected_when_isolation_or_mount_changes(self):
        cases = (
            ("HostConfig", {
                "Runtime": "runc", "NetworkMode": "bridge", "DeviceRequests": [],
                "ReadonlyRootfs": True,
            }),
            ("HostConfig", {
                "Runtime": "runc", "NetworkMode": "none", "DeviceRequests": [{"Count": 1}],
                "ReadonlyRootfs": True,
            }),
            ("HostConfig", {
                "Runtime": "runc", "NetworkMode": "none", "DeviceRequests": [],
                "ReadonlyRootfs": False,
            }),
            ("Mounts", [{"Type": "volume", "Name": "foreign", "Destination": "/control"}]),
        )
        for key, value in cases:
            with self.subTest(key=key, value=value), patch.object(
                docker_dev, "_docker_capture", side_effect=self._capture(
                    _helper_document(**{key: value})
                )
            ):
                with self.assertRaises(docker_dev.DirectDockerError):
                    docker_dev._assert_no_running_fullmag(
                        PROJECT, _source_identity(), owned_control=_owned_control()
                    )


if __name__ == "__main__":
    unittest.main()
