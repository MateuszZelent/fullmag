#!/usr/bin/env python3
"""Focused regressions for the frontend v2 named-volume adapter."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import docker_frontend_cache as cache
import docker_development_inputs as development_inputs


IMAGE = "sha256:" + "a" * 64


class FakeDocker:
    def __init__(self) -> None:
        self.calls: list[tuple[tuple[str, ...], dict[str, object]]] = []
        self.volumes: dict[str, dict[str, object]] = {}

    def __call__(self, *args: str, **kwargs: object) -> str:
        self.calls.append((args, kwargs))
        if args[:2] == ("image", "inspect"):
            return json.dumps(
                [
                    {
                        "Id": IMAGE,
                        "Config": {"Volumes": None},
                        "Os": "linux",
                        "Architecture": "amd64",
                    }
                ]
            )
        if args[:2] == ("volume", "inspect"):
            name = args[2]
            if name not in self.volumes:
                raise RuntimeError("volume does not exist")
            return json.dumps([self.volumes[name]])
        if args[:2] == ("volume", "create"):
            labels: dict[str, str] = {}
            name = args[-1]
            for index, value in enumerate(args):
                if value == "--label":
                    label, item = args[index + 1].split("=", 1)
                    labels[label] = item
            self.volumes[name] = {"Name": name, "Driver": "local", "Labels": labels}
            return name
        raise AssertionError(f"unexpected Docker call: {args!r}")


class FrontendNamedVolumeTests(unittest.TestCase):
    def test_describe_is_read_only_and_returns_dependency_identity(self) -> None:
        source = Path(__file__).parents[1].resolve()
        with mock.patch.object(
            development_inputs.storage,
            "git",
            side_effect=["a" * 40, "a" * 40],
        ), mock.patch.object(
            development_inputs.storage,
            "identifier",
            return_value="worktree-demo",
        ):
            description = development_inputs.describe(source, 32871)
        self.assertEqual(description["schema"], "fullmag.docker-development-inputs.v1")
        self.assertRegex(description["source_commit"], r"^[0-9a-f]{40}$")
        self.assertRegex(description["dependency_seed_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(description["toolpins_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(description["configuration_changes"], "describe_only")

    def test_cache_key_does_not_change_when_only_port_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            first = cache.cache_key(source, "worktree-demo", 32871, "a" * 64)
            second = cache.cache_key(source, "worktree-demo", 32872, "a" * 64)
        self.assertEqual(first["key"], second["key"])
        self.assertNotEqual(first["inputs"]["host_port"], second["inputs"]["host_port"])

    def test_prepare_creates_group_scoped_volumes_without_host_run_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "checkout"
            source.mkdir()
            repo = root / "repo"
            repo.mkdir()
            (repo / "compose.frontend-cache.yaml").write_text(
                "services:\n  frontend: {}\n", encoding="utf-8"
            )
            docker = FakeDocker()
            profile = cache.prepare(
                {"project_id": "fullmag-worktree-demo"},
                repo,
                IMAGE,
                root / "run-that-must-not-be-created",
                docker,
                source_root=source,
                worktree_id="worktree-demo",
                host_port=32871,
                dependency_seed_sha256="a" * 64,
                control_volume_name="fullmag-worktree-demo-build-control-v1",
            )
            self.assertFalse((root / "run-that-must-not-be-created").exists())
            self.assertEqual(profile["profile"], cache.PROFILE)
            self.assertEqual(profile["guest_targets"]["state"], "/state/development")
            self.assertEqual(
                profile["environment"][cache.ENV_VOLUME_NAME], profile["volume_name"]
            )
            self.assertEqual(
                profile["environment"][cache.ENV_CONTROL_VOLUME],
                profile["control_volume_name"],
            )
            self.assertEqual(
                profile["control_volume_name"],
                "fullmag-worktree-demo-build-control-v1",
            )
            self.assertNotIn("storage_root", profile)
            self.assertNotIn("backing_image", profile)
            self.assertEqual(set(docker.volumes), {
                profile["volume_name"], profile["control_volume_name"]
            })
            self.assertTrue(
                all(args[:2] != ("compose", "run") for args, _ in docker.calls)
            )

    def test_fresh_state_volume_is_seeded_with_frontend_ownership(self) -> None:
        root = Path(__file__).parents[1]
        dockerfile = (root / "docker/all-in-one/Dockerfile.dev").read_text(encoding="utf-8")
        compose = (root / "compose.frontend-cache.yaml").read_text(encoding="utf-8")

        self.assertIn("/state/development", dockerfile)
        self.assertRegex(dockerfile, r"chown 65532:65532[^\n]*/state/development")
        state_mount = compose.split("source: frontend-development-state", 1)[1].split(
            "source: fullmag-build-control", 1
        )[0]
        self.assertNotIn("nocopy", state_mount)
        control_mount = compose.split("source: fullmag-build-control", 1)[1]
        self.assertIn("nocopy: true", control_mount)

    def test_prepare_requires_launcher_control_volume_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "checkout"
            source.mkdir()
            repo = root / "repo"
            repo.mkdir()
            (repo / "compose.frontend-cache.yaml").write_text(
                "services:\n  frontend: {}\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(cache.FrontendCacheError, "control_volume_name"):
                cache.prepare(
                    {"project_id": "fullmag-worktree-demo"},
                    repo,
                    IMAGE,
                    root / "run-that-must-not-be-created",
                    FakeDocker(),
                    source_root=source,
                    worktree_id="worktree-demo",
                    host_port=32871,
                    dependency_seed_sha256="a" * 64,
                )

    def test_validate_container_requires_named_state_volume(self) -> None:
        profile = {
            "schema": cache.SCHEMA,
            "state": "ready",
            "cache_key": "a" * 64,
            "image_id": IMAGE,
            "environment": {
                cache.ENV_SCHEMA: cache.SCHEMA,
                cache.ENV_PROFILE: cache.PROFILE,
                cache.ENV_PROJECT_ID: "fullmag-worktree-demo",
                cache.ENV_KEY: "a" * 64,
                cache.ENV_VOLUME_NAME: "fullmag-worktree-demo-frontend-dev-v2-" + "a" * 32,
                cache.ENV_CONTROL_VOLUME: "fullmag-worktree-demo-build-control-v1",
                cache.ENV_MOUNT_TARGET: "/state/development",
                cache.ENV_RUNTIME_IMAGE_ID: IMAGE,
            },
        }
        expected_volume = profile["environment"][cache.ENV_VOLUME_NAME]
        document = {
            "Image": IMAGE,
            "Config": {
                "Env": [f"{key}={value}" for key, value in profile["environment"].items()],
                "Labels": {
                    cache.CONSUMER_PROFILE_LABEL: cache.PROFILE,
                    cache.CONSUMER_KEY_LABEL: "a" * 64,
                },
            },
            "Mounts": [
                {"Type": "volume", "Name": expected_volume,
                 "Destination": "/state/development", "RW": True},
                {"Type": "volume", "Name": profile["environment"][cache.ENV_CONTROL_VOLUME],
                 "Destination": "/opt/fullmag/control", "RW": True},
                {"Type": "bind", "Source": "C:/git/fullmag/fullmag/apps/control-room/app",
                 "Destination": "/state/development/workspace/apps/control-room/app", "RW": False},
            ],
        }
        self.assertEqual(
            cache.validate_container(document, profile)["volume_name"], expected_volume
        )
        document["Mounts"][0] = {
            "Type": "bind", "Source": "C:/host-storage", "Destination": "/state/development", "RW": True
        }
        with self.assertRaises(cache.FrontendCacheError):
            cache.validate_container(document, profile)


if __name__ == "__main__":
    unittest.main()
