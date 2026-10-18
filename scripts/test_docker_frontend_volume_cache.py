"""Source-level regression cases for the frontend named-volume contract."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import docker_frontend_volume_cache as cache


class FrontendVolumePlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fullmag-frontend-volume-")
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name).resolve()
        self.layout = {"repo_root": str(self.source), "worktree_id": "worktree-abc"}
        self.identity = {
            "project_name": "fullmag-worktree-abc",
            "project_id": "project-abc",
            "worktree_id": "worktree-abc",
            "source_root": str(self.source),
        }
        self.compose_identity = patch.object(
            cache, "compose_project_identity", return_value=self.identity
        )
        self.compose_identity.start()
        self.addCleanup(self.compose_identity.stop)
        self.image = "sha256:" + "a" * 64

    def make_plan(self, *, image=None):
        return cache.plan(self.layout, self.source, image or self.image)

    def test_docker_command_pins_context_utf8_and_filters_only_child_environment(self):
        result = subprocess.CompletedProcess(["docker"], 0, "{}", "")
        with patch.dict(
            os.environ,
            {"DOCKER_CONTEXT": "unexpected-context", "DOCKER_HOST": "tcp://example.invalid"},
        ), patch.object(cache.subprocess, "run", return_value=result) as run:
            cache._docker(["volume", "inspect", "named-volume"])
            self.assertEqual(os.environ["DOCKER_CONTEXT"], "unexpected-context")
            self.assertEqual(os.environ["DOCKER_HOST"], "tcp://example.invalid")

        args, kwargs = run.call_args
        self.assertEqual(
            args[0],
            ["docker", "--context", "desktop-linux", "volume", "inspect", "named-volume"],
        )
        self.assertEqual(kwargs["encoding"], "utf-8")
        self.assertEqual(kwargs["errors"], "strict")
        self.assertTrue(kwargs["text"])
        self.assertNotIn("DOCKER_CONTEXT", kwargs["env"])
        self.assertNotIn("DOCKER_HOST", kwargs["env"])

    def test_volume_identity_ignores_run_and_source_changes_but_tracks_toolchain(self):
        first = self.make_plan()
        second = self.make_plan()
        other_toolchain = self.make_plan(image="sha256:" + "b" * 64)
        self.assertEqual(first["volume_name"], second["volume_name"])
        self.assertNotEqual(first["volume_name"], other_toolchain["volume_name"])
        self.assertEqual(first["development_mount"]["target"], "/state/development")
        self.assertEqual(first["source_mount"]["target"], "/run/fullmag/source")
        self.assertEqual(
            [Path(item["source"]).name for item in first["live_source_mounts"]],
            ["app", "src", "public", "scripts"],
        )
        self.assertTrue(all(item["read_only"] for item in first["live_source_mounts"]))

    def test_volume_inspect_rejects_wrong_identity_or_writable_options(self):
        planned = self.make_plan()
        planned["creation_id"] = "1" * 32
        labels = cache._expected_volume_labels(planned)
        actual = {
            "Name": planned["volume_name"],
            "Driver": "local",
            "Scope": "local",
            "Options": {},
            "Mountpoint": "/var/lib/docker/volumes/frontend/_data",
            "Labels": labels,
        }
        cache.validate_volume([actual], planned)
        wrong = dict(actual, Labels={**labels, cache.LABELS["role"]: "other"})
        with self.assertRaises(cache.FrontendVolumeError):
            cache.validate_volume([wrong], planned)
        wrong = dict(actual, Options={"type": "none"})
        with self.assertRaises(cache.FrontendVolumeError):
            cache.validate_volume([wrong], planned)

    def test_new_volume_is_initialized_once_with_creation_nonce_then_verified(self):
        planned = self.make_plan()
        nonce = "2" * 32
        labels = {**planned["volume_labels"], cache.LABELS["creation"]: nonce}
        actual = {
            "Name": planned["volume_name"], "Driver": "local", "Scope": "local",
            "Options": {}, "Mountpoint": "/var/lib/docker/volumes/frontend/_data",
            "Labels": labels,
        }
        calls = []

        def docker(args, **kwargs):
            calls.append((args, kwargs))
            if args[:2] == ["volume", "inspect"] and len(
                [c for c in calls if c[0][:2] == ["volume", "inspect"]]
            ) == 1:
                return subprocess.CompletedProcess(args, 1, "", "Error: no such volume")
            if args[:2] == ["volume", "create"]:
                self.assertIn(f"{cache.LABELS['creation']}={nonce}", args)
                return subprocess.CompletedProcess(args, 0, planned["volume_name"], "")
            if args[:2] == ["volume", "inspect"]:
                return subprocess.CompletedProcess(args, 0, json.dumps([actual]), "")
            raise AssertionError(args)

        with patch.object(cache.uuid, "uuid4", return_value=SimpleNamespace(hex=nonce)), \
                patch.object(cache, "_docker", side_effect=docker), patch.object(
                    cache, "_maintenance"
                ) as maintenance:
            effective = cache.ensure(
                planned, source_root=self.source, image_id=self.image
            )
        self.assertEqual(effective["creation_id"], nonce)
        self.assertEqual(
            [call.args[2] for call in maintenance.call_args_list],
            ["initialize", "verify"],
        )

    def test_existing_owned_volume_is_verified_without_root_initialization(self):
        planned = self.make_plan()
        nonce = "3" * 32
        actual = {
            "Name": planned["volume_name"], "Driver": "local", "Scope": "local",
            "Options": {}, "Mountpoint": "/var/lib/docker/volumes/frontend/_data",
            "Labels": {**planned["volume_labels"], cache.LABELS["creation"]: nonce},
        }
        result = subprocess.CompletedProcess(
            ["docker", "volume", "inspect"], 0, json.dumps([actual]), ""
        )
        with patch.object(cache, "_docker", return_value=result), patch.object(
            cache, "_maintenance"
        ) as maintenance:
            effective = cache.ensure(
                planned, source_root=self.source, image_id=self.image
            )
        self.assertEqual(effective["creation_id"], nonce)
        self.assertEqual([call.args[2] for call in maintenance.call_args_list], ["verify"])

    def test_maintenance_compose_has_exact_bounded_helper_resources(self):
        repository_template = (
            Path(__file__).resolve().parents[1]
            / "docker"
            / "all-in-one"
            / cache.MAINTENANCE_COMPOSE
        )
        template = json.loads(repository_template.read_text(encoding="utf-8"))
        service_name = cache.MAINTENANCE_SERVICE
        expected = {"pids_limit": 16, "mem_limit": "128m", "cpus": 0.25}
        service = template["services"][service_name]
        self.assertEqual({key: service.get(key) for key in expected}, expected)

        planned = self.make_plan()
        planned["creation_id"] = "4" * 32
        maintenance_path = (
            self.source / "docker" / "all-in-one" / cache.MAINTENANCE_COMPOSE
        )
        maintenance_path.parent.mkdir(parents=True)
        maintenance_path.write_text(json.dumps(template), encoding="utf-8")
        rendered = json.loads(cache._compose_document(planned, self.image, "verify"))
        rendered_service = rendered["services"][service_name]
        self.assertEqual({key: rendered_service.get(key) for key in expected}, expected)

        for key, invalid_value in (
            ("pids_limit", 17),
            ("mem_limit", "256m"),
            ("cpus", 0.5),
        ):
            invalid_template = json.loads(json.dumps(template))
            invalid_template["services"][service_name][key] = invalid_value
            maintenance_path.write_text(json.dumps(invalid_template), encoding="utf-8")
            with self.subTest(key=key), self.assertRaises(cache.FrontendVolumeError):
                cache._compose_document(planned, self.image, "verify")

        for key in expected:
            invalid_template = json.loads(json.dumps(template))
            del invalid_template["services"][service_name][key]
            maintenance_path.write_text(json.dumps(invalid_template), encoding="utf-8")
            with self.subTest(missing=key), self.assertRaises(cache.FrontendVolumeError):
                cache._compose_document(planned, self.image, "verify")


if __name__ == "__main__":
    unittest.main()
