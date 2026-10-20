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

    @staticmethod
    def _frontend_state_maintenance_config(environment: dict[str, str]) -> dict[str, object]:
        return {
            "services": {
                "frontend-cache-maintenance": {
                    "image": environment[cache.ENV_RUNTIME_IMAGE_ID],
                    "pull_policy": "never",
                    "user": "0:0",
                    "read_only": True,
                    "privileged": False,
                    "cap_drop": ["ALL"],
                    "cap_add": ["CHOWN"],
                    "security_opt": ["no-new-privileges:true"],
                    "network_mode": "none",
                    "restart": "no",
                    "entrypoint": [
                        "/usr/local/bin/python3",
                        "/opt/fullmag/backend_volume_cache_maintenance.py",
                    ],
                    "command": ["ensure-frontend-state"],
                    "environment": {
                        "FULLMAG_FRONTEND_STATE_SCHEMA": "fullmag.frontend-development-state-owner.v1",
                        "FULLMAG_FRONTEND_STATE_PROFILE": cache.PROFILE,
                        "FULLMAG_FRONTEND_STATE_MAINTENANCE_PROFILE": "fullmag-frontend-state-maintenance-v1",
                        "FULLMAG_FRONTEND_STATE_MAINTENANCE_ACTION": "ensure",
                        "FULLMAG_FRONTEND_STATE_ROOT": "/state/development",
                        "FULLMAG_FRONTEND_STATE_PROJECT_ID": environment[cache.ENV_PROJECT_ID],
                        "FULLMAG_FRONTEND_STATE_CACHE_KEY": environment[cache.ENV_KEY],
                        "FULLMAG_FRONTEND_STATE_VOLUME": environment[cache.ENV_VOLUME_NAME],
                        "FULLMAG_FRONTEND_STATE_OWNER_UID": "65532",
                        "FULLMAG_FRONTEND_STATE_OWNER_GID": "65532",
                    },
                    "volumes": [
                        {
                            "type": "volume",
                            "source": "frontend-development-state",
                            "target": "/state/development",
                            "volume": {"nocopy": True},
                        }
                    ],
                }
            },
            "volumes": {
                "frontend-development-state": {
                    "name": environment[cache.ENV_VOLUME_NAME],
                    "external": True,
                }
            },
        }

    @staticmethod
    def _frontend_state_maintenance_receipt(environment: dict[str, str]) -> dict[str, object]:
        root = "/state/development"
        control_room = f"{root}/workspace/apps/control-room"
        return {
            "schema": "fullmag.frontend-development-state-owner.v1",
            "profile": cache.PROFILE,
            "maintenance_profile": "fullmag-frontend-state-maintenance-v1",
            "state": "ready",
            "project_id": environment[cache.ENV_PROJECT_ID],
            "cache_key": environment[cache.ENV_KEY],
            "volume_name": environment[cache.ENV_VOLUME_NAME],
            "root": root,
            "owner_uid": 65532,
            "owner_gid": 65532,
            "directories": [
                root,
                f"{root}/workspace",
                f"{root}/workspace/apps",
                control_room,
                *[f"{control_room}/{name}" for name in ("app", "src", "public", "scripts")],
            ],
            "probe": {
                "state": "passed",
                "recursive_chown": False,
                "live_bind_contents": "untouched",
                "marker_validated": True,
            },
        }

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
            self.volumes[name] = {
                "Name": name,
                "Driver": "local",
                "Scope": "local",
                "Options": {},
                "Mountpoint": f"/var/lib/docker/volumes/{name}/_data",
                "Labels": labels,
            }
            return name
        if args[:2] == ("ps", "--quiet"):
            return ""
        if args and args[0] == "compose":
            environment = kwargs.get("environment")
            if not isinstance(environment, dict):
                raise AssertionError("Compose call did not receive an environment")
            if "config" in args:
                return json.dumps(self._frontend_state_maintenance_config(environment))
            if "run" in args:
                return json.dumps(self._frontend_state_maintenance_receipt(environment))
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
        self.assertIn("apps/control-room/next.config.ts", description["dependency_seed_files"])
        self.assertEqual(description["configuration_changes"], "describe_only")

    def test_interrupted_guest_seed_can_resume_only_matching_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary) / "workspace"
            workspace.mkdir()
            (workspace / "apps/control-room/app").mkdir(parents=True)
            expected = {
                Path("package.json"): b"package\n",
                Path("patches/fix.patch"): b"patch\n",
            }
            (workspace / "package.json").write_bytes(expected[Path("package.json")])
            development_inputs._validate_guest_workspace(workspace, expected)

            (workspace / "unexpected.txt").write_bytes(b"foreign\n")
            with self.assertRaisesRegex(ValueError, "unexpected file"):
                development_inputs._validate_guest_workspace(workspace, expected)
            (workspace / "unexpected.txt").unlink()

            (workspace / "package.json").write_bytes(b"different\n")
            with self.assertRaisesRegex(ValueError, "does not match"):
                development_inputs._validate_guest_workspace(workspace, expected)

    def test_interrupted_guest_seed_prunes_live_source_mount_contents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary) / "workspace"
            for name in development_inputs.DIRECTORIES:
                (workspace / "apps/control-room" / name / "nested").mkdir(
                    parents=True
                )
                (workspace / "apps/control-room" / name / "nested" / "source.ts").write_bytes(
                    b"live source\n"
                )
            expected = {
                Path("package.json"): b"package\n",
                Path("patches/fix.patch"): b"patch\n",
            }
            (workspace / "package.json").write_bytes(expected[Path("package.json")])
            development_inputs._validate_guest_workspace(workspace, expected)

            (workspace / "apps/control-room/foreign").mkdir()
            with self.assertRaisesRegex(ValueError, "unexpected directory"):
                development_inputs._validate_guest_workspace(workspace, expected)

    def test_cache_key_does_not_change_when_only_port_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            first = cache.cache_key(source, "worktree-demo", 32871, "a" * 64)
            second = cache.cache_key(source, "worktree-demo", 32872, "a" * 64)
        self.assertEqual(first["key"], second["key"])
        self.assertNotEqual(first["inputs"]["host_port"], second["inputs"]["host_port"])

    def test_state_maintenance_rejects_a_running_same_key_frontend(self) -> None:
        cache_key = "a" * 64
        volume_name = "fullmag-worktree-demo-frontend-dev-v2-" + "a" * 32
        container_id = "b" * 64

        def docker(*args: str, **kwargs: object) -> str:
            del kwargs
            if args[:2] == ("ps", "--quiet"):
                return container_id + "\n"
            if args[:2] == ("inspect", container_id):
                return json.dumps([
                    {
                        "State": {"Running": True},
                        "Config": {
                            "Labels": {
                                cache.CONSUMER_PROFILE_LABEL: cache.PROFILE,
                                cache.CONSUMER_KEY_LABEL: cache_key,
                            }
                        },
                        "Mounts": [
                            {
                                "Type": "volume",
                                "Name": volume_name,
                                "Destination": cache.STATE_TARGET,
                            }
                        ],
                    }
                ])
            raise AssertionError(f"unexpected Docker call: {args!r}")

        with self.assertRaisesRegex(cache.FrontendCacheError, "already held"):
            cache._v2_assert_no_active_consumer(
                docker, cache_key=cache_key, volume_name=volume_name
            )

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
            self.assertEqual(
                profile["control_root"],
                "/opt/fullmag/control/" + profile["cache_key"],
            )
            self.assertEqual(
                profile["inputs_path"], profile["control_root"] + "/development-inputs.json"
            )
            self.assertEqual(
                profile["environment"][cache.ENV_CONTROL_ROOT], profile["control_root"]
            )
            self.assertEqual(
                profile["environment"][cache.ENV_INPUTS_PATH], profile["inputs_path"]
            )
            self.assertEqual(
                profile["control_owner"], {"uid": 65532, "gid": 65532, "mode": "0700"}
            )
            self.assertEqual(profile["receipt_storage"], "docker-named-volume")
            self.assertNotIn("filesystem_uuid", profile)
            self.assertNotIn("mount_root", profile)
            self.assertNotIn("helper_sha256", profile)
            self.assertNotIn("storage_root", profile)
            self.assertNotIn("backing_image", profile)
            self.assertEqual(set(docker.volumes), {
                profile["volume_name"], profile["control_volume_name"]
            })
            compose_calls = [args for args, _ in docker.calls if args and args[0] == "compose"]
            self.assertEqual(sum("config" in args for args in compose_calls), 1)
            self.assertEqual(sum("run" in args for args in compose_calls), 1)

    def test_prepared_volumes_are_reinspected_without_creation_before_start(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            (source / "compose.frontend-cache.yaml").write_text("services: {}\n")
            docker = FakeDocker()
            profile = cache.prepare(
                {"project_id": "fullmag-worktree-demo"}, source, IMAGE, root / "unused-run",
                docker, source_root=source, worktree_id="worktree-demo", host_port=32871,
                dependency_seed_sha256="a" * 64,
                control_volume_name="fullmag-worktree-demo-build-control-v1",
            )
            self.assertIn("inspection", profile["volume"])
            self.assertIn("inspection", profile["control_volume"])
            before = len(docker.calls)
            cache.reinspect_volumes(profile, docker)
            for name in (profile["volume_name"], profile["control_volume_name"]):
                original = json.loads(json.dumps(docker.volumes[name]))
                for field, changed in (("CreatedAt", "2026-10-19T00:00:00Z"),
                                       ("Mountpoint", "/mnt/e/redirected"),
                                       ("Options", {"device": "/host_mnt/e/build", "o": "bind"})):
                    docker.volumes[name][field] = changed
                    with self.subTest(name=name, field=field), self.assertRaises(
                            cache.FrontendCacheError):
                        cache.reinspect_volumes(profile, docker)
                    docker.volumes[name] = json.loads(json.dumps(original))
            self.assertTrue(all(args[:2] == ("volume", "inspect")
                                for args, _ in docker.calls[before:]))

    def test_prepare_rejects_local_volumes_redirected_to_host_storage(self) -> None:
        project_id = "fullmag-worktree-demo"
        key = "a" * 64
        state_name = cache._v2_volume_name(project_id, key)
        labels = {
            cache.VOLUME_SCHEMA_LABEL: cache.SCHEMA,
            cache.VOLUME_PROFILE_LABEL: cache.PROFILE,
            cache.VOLUME_PROJECT_LABEL: project_id,
            cache.VOLUME_KEY_LABEL: key,
        }
        hostile_records = (
            {
                "Name": state_name,
                "Driver": "local",
                "Scope": "local",
                "Options": {
                    "type": "none",
                    "device": "/run/desktop/mnt/host/c/fullmag/storage",
                    "o": "bind",
                },
                "Mountpoint": f"/var/lib/docker/volumes/{state_name}/_data",
                "Labels": labels,
            },
            {
                "Name": state_name,
                "Driver": "local",
                "Scope": "local",
                "Options": {},
                "Mountpoint": "/run/desktop/mnt/host/c/fullmag/storage",
                "Labels": labels,
            },
        )
        for record in hostile_records:
            with self.subTest(record=record):
                docker = FakeDocker()
                docker.volumes[state_name] = record
                with self.assertRaises(cache.FrontendCacheError):
                    cache._v2_ensure_volume(
                        docker, name=state_name, project_id=project_id, key=key
                    )

    def test_prepare_accepts_docker_volume_root_under_non_windows_mnt_path(self) -> None:
        project_id = "fullmag-worktree-demo"
        key = "a" * 64
        name = cache._v2_volume_name(project_id, key)
        docker = FakeDocker()
        docker.volumes[name] = {
            "Name": name,
            "Driver": "local",
            "Scope": "local",
            "Options": {},
            "Mountpoint": f"/mnt/docker-data/volumes/{name}/_data",
            "Labels": {
                cache.VOLUME_SCHEMA_LABEL: cache.SCHEMA,
                cache.VOLUME_PROFILE_LABEL: cache.PROFILE,
                cache.VOLUME_PROJECT_LABEL: project_id,
                cache.VOLUME_KEY_LABEL: key,
            },
        }
        validated = cache._v2_ensure_volume(
            docker, name=name, project_id=project_id, key=key
        )
        self.assertEqual(validated["name"], name)

    def test_prepare_rejects_control_volume_redirected_to_host_storage(self) -> None:
        name = "fullmag-worktree-demo-build-control-v1"
        for record in (
            {
                "Name": name,
                "Driver": "local",
                "Scope": "local",
                "Options": {"type": "none", "device": "C:/fullmag/storage", "o": "bind"},
                "Mountpoint": f"/var/lib/docker/volumes/{name}/_data",
                "Labels": {},
            },
            {
                "Name": name,
                "Driver": "local",
                "Scope": "local",
                "Options": {},
                "Mountpoint": "/mnt/c/fullmag/storage",
                "Labels": {},
            },
        ):
            with self.subTest(record=record):
                docker = FakeDocker()
                docker.volumes[name] = record
                with self.assertRaises(cache.FrontendCacheError):
                    cache._v2_ensure_control_volume(
                        docker, name=name, project_id="fullmag-worktree-demo"
                    )

    def test_fresh_state_volume_is_seeded_with_frontend_ownership(self) -> None:
        root = Path(__file__).parents[1]
        dockerfile = (root / "docker/all-in-one/Dockerfile.dev").read_text(encoding="utf-8")
        compose = (root / "compose.frontend-cache.yaml").read_text(encoding="utf-8")

        self.assertIn("/state/development", dockerfile)
        chown_block = dockerfile.split("chown 65532:65532", 1)[1].split("chown root:root", 1)[0]
        self.assertIn("/state/development", chown_block)
        frontend_service = compose.split("\n  frontend:\n", 1)[1]
        state_mount = frontend_service.split("source: frontend-development-state", 1)[1].split(
            "source: fullmag-build-control", 1
        )[0]
        self.assertNotIn("nocopy", state_mount)
        control_mount = frontend_service.split("source: fullmag-build-control", 1)[1]
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
                cache.ENV_CONTROL_ROOT: "/opt/fullmag/control/" + "a" * 64,
                cache.ENV_INPUTS_PATH: "/opt/fullmag/control/" + "a" * 64 + "/development-inputs.json",
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
        profile["environment"][cache.ENV_INPUTS_PATH] = (
            "/opt/fullmag/control/" + "b" * 64 + "/development-inputs.json"
        )
        with self.assertRaisesRegex(cache.FrontendCacheError, "cache-key scoped"):
            cache.validate_container(document, profile)
        profile["environment"][cache.ENV_INPUTS_PATH] = (
            "/opt/fullmag/control/" + "a" * 64 + "/development-inputs.json"
        )
        document["Mounts"][0] = {
            "Type": "bind", "Source": "C:/host-storage", "Destination": "/state/development", "RW": True
        }
        with self.assertRaises(cache.FrontendCacheError):
            cache.validate_container(document, profile)


if __name__ == "__main__":
    unittest.main()
