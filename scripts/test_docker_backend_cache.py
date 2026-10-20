from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import docker_backend_cache as cache  # noqa: E402


IMAGE = "sha256:" + "a" * 64
TOOLCHAIN = "sha256:" + "b" * 64
UUID = "11111111-1111-1111-1111-111111111111"
TOKEN = "22222222-2222-2222-2222-222222222222"


class BackendCacheCapacityTests(unittest.TestCase):
    def test_new_cache_defaults_to_24_gib_and_legacy_capacity_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            backing = Path(temporary) / "cache.ext4"
            self.assertEqual(cache._existing_backing_size(backing), cache.CACHE_SIZE_BYTES)
            with mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
                Path, "is_symlink", return_value=False
            ), mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(
                Path, "stat", return_value=SimpleNamespace(st_size=cache.LEGACY_CACHE_SIZE_BYTES)
            ):
                self.assertEqual(cache._existing_backing_size(backing), cache.LEGACY_CACHE_SIZE_BYTES)

    def test_unidentified_capacity_is_rejected(self):
        backing = Path("/storage/build-volumes/cache.ext4")
        with mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
            Path, "is_symlink", return_value=False
        ), mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(
            Path, "stat", return_value=SimpleNamespace(st_size=13 * 1024 * 1024 * 1024)
        ), self.assertRaisesRegex(cache.BackendCacheError, "12 GiB, 24 GiB, 40 GiB, or 50 GiB"):
            cache._existing_backing_size(backing)

    def test_50_gib_capacity_is_accepted(self):
        backing = Path("/storage/build-volumes/cache.ext4")
        with mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
            Path, "is_symlink", return_value=False
        ), mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(
            Path, "stat", return_value=SimpleNamespace(st_size=cache.MAX_CACHE_SIZE_BYTES)
        ):
            self.assertEqual(cache._existing_backing_size(backing), cache.MAX_CACHE_SIZE_BYTES)

    def test_growth_requires_delta_plus_margin(self):
        backing = Path("/storage/build-volumes/cache.ext4")
        with mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
            Path, "is_symlink", return_value=False
        ), mock.patch.object(cache, "_existing_backing_size", return_value=cache.LEGACY_CACHE_SIZE_BYTES), mock.patch.object(
            cache.shutil, "disk_usage", return_value=SimpleNamespace(free=cache.GROWTH_FREE_SPACE_MARGIN_BYTES)
        ), self.assertRaisesRegex(cache.BackendCacheError, "growth"):
            cache._guard_growth_space(backing, Path("/storage"))

    def test_extended_growth_requires_delta_plus_margin(self):
        backing = Path("/storage/build-volumes/cache.ext4")
        with mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
            Path, "is_symlink", return_value=False
        ), mock.patch.object(cache, "_existing_backing_size", return_value=cache.CACHE_SIZE_BYTES), mock.patch.object(
            cache.shutil, "disk_usage", return_value=SimpleNamespace(free=cache.GROWTH_FREE_SPACE_MARGIN_BYTES)
        ), self.assertRaisesRegex(cache.BackendCacheError, "growth"):
            cache._guard_growth_space(
                backing,
                Path("/storage"),
                cache.CACHE_SIZE_BYTES,
                cache.EXTENDED_CACHE_SIZE_BYTES,
            )

    def test_max_growth_requires_delta_plus_margin(self):
        backing = Path("/storage/build-volumes/cache.ext4")
        with mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
            Path, "is_symlink", return_value=False
        ), mock.patch.object(cache, "_existing_backing_size", return_value=cache.EXTENDED_CACHE_SIZE_BYTES), mock.patch.object(
            cache.shutil, "disk_usage", return_value=SimpleNamespace(free=cache.GROWTH_FREE_SPACE_MARGIN_BYTES)
        ), self.assertRaisesRegex(cache.BackendCacheError, "growth"):
            cache._guard_growth_space(
                backing,
                Path("/storage"),
                cache.EXTENDED_CACHE_SIZE_BYTES,
                cache.MAX_CACHE_SIZE_BYTES,
            )

    def test_growth_rejects_skipping_the_40_gib_step(self):
        backing = Path("/storage/build-volumes/cache.ext4")
        with mock.patch.object(Path, "exists", return_value=True), mock.patch.object(
            Path, "is_symlink", return_value=False
        ), mock.patch.object(cache, "_existing_backing_size", return_value=cache.CACHE_SIZE_BYTES), \
                self.assertRaisesRegex(cache.BackendCacheError, "adjacent"):
            cache._guard_growth_space(
                backing,
                Path("/storage"),
                cache.CACHE_SIZE_BYTES,
                cache.MAX_CACHE_SIZE_BYTES,
            )

    def test_partial_growth_journal_allows_24_gib_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            backing = Path(temporary) / "cache.ext4"
            backing.touch()
            journal = Path(str(backing) + ".growth-v1.json")
            journal.write_text(json.dumps({
                "schema": cache.GROWTH_SCHEMA,
                "operation": "grow",
                "state": "started",
                "cache_key": "c" * 64,
                "previous_size_bytes": cache.LEGACY_CACHE_SIZE_BYTES,
                "size_bytes": cache.CACHE_SIZE_BYTES,
            }))
            self.assertTrue(cache._growth_journal_is_present(backing, "c" * 64))
            journal.write_text(journal.read_text().replace('"started"', '"foreign"'))
            self.assertFalse(cache._growth_journal_is_present(backing, "c" * 64))

    def test_partial_growth_journal_for_extended_capacity_is_transition_scoped(self):
        with tempfile.TemporaryDirectory() as temporary:
            backing = Path(temporary) / "cache.ext4"
            backing.touch()
            journal = cache._growth_journal_path(
                backing, cache.CACHE_SIZE_BYTES, cache.EXTENDED_CACHE_SIZE_BYTES,
            )
            journal.write_text(json.dumps({
                "schema": cache.GROWTH_SCHEMA,
                "operation": "grow",
                "state": "started",
                "cache_key": "c" * 64,
                "previous_size_bytes": cache.CACHE_SIZE_BYTES,
                "size_bytes": cache.EXTENDED_CACHE_SIZE_BYTES,
            }))
            self.assertTrue(cache._growth_journal_is_present(
                backing,
                "c" * 64,
                cache.CACHE_SIZE_BYTES,
                cache.EXTENDED_CACHE_SIZE_BYTES,
                state="started",
            ))
            self.assertFalse(cache._growth_journal_is_present(
                backing,
                "c" * 64,
                cache.LEGACY_CACHE_SIZE_BYTES,
                cache.CACHE_SIZE_BYTES,
            ))
            journal.write_text(journal.read_text().replace('"started"', '"succeeded"'))
            self.assertTrue(cache._growth_journal_is_present(
                backing,
                "c" * 64,
                cache.CACHE_SIZE_BYTES,
                cache.EXTENDED_CACHE_SIZE_BYTES,
            ))
            self.assertFalse(cache._growth_journal_is_present(
                backing,
                "c" * 64,
                cache.CACHE_SIZE_BYTES,
                cache.EXTENDED_CACHE_SIZE_BYTES,
                state="started",
            ))

    def test_partial_growth_journal_for_max_capacity_uses_v3_suffix(self):
        with tempfile.TemporaryDirectory() as temporary:
            backing = Path(temporary) / "cache.ext4"
            backing.touch()
            journal = cache._growth_journal_path(
                backing, cache.EXTENDED_CACHE_SIZE_BYTES, cache.MAX_CACHE_SIZE_BYTES,
            )
            self.assertEqual(journal.name, "cache.ext4" + cache.GROWTH_V3_SUFFIX)
            journal.write_text(json.dumps({
                "schema": cache.GROWTH_SCHEMA,
                "operation": "grow",
                "state": "started",
                "cache_key": "c" * 64,
                "previous_size_bytes": cache.EXTENDED_CACHE_SIZE_BYTES,
                "size_bytes": cache.MAX_CACHE_SIZE_BYTES,
            }))
            self.assertTrue(cache._growth_journal_is_present(
                backing,
                "c" * 64,
                cache.EXTENDED_CACHE_SIZE_BYTES,
                cache.MAX_CACHE_SIZE_BYTES,
            ))
            self.assertFalse(cache._growth_journal_is_present(
                backing,
                "c" * 64,
                cache.CACHE_SIZE_BYTES,
                cache.EXTENDED_CACHE_SIZE_BYTES,
            ))


class BackendCacheAdmissionTests(unittest.TestCase):
    class PrepareDocker:
        def __call__(self, *args, **kwargs):
            if args[0] == "ps":
                return ""
            if args[:2] == ("image", "inspect"):
                image = args[2]
                return json.dumps([{"Id": image, "Config": {"Volumes": None}, "Os": "linux", "Architecture": "amd64"}])
            if args[0] == "compose" and "config" in args:
                env = kwargs["environment"]
                return json.dumps({
                    "name": "backend-cache-test",
                    "services": {
                        "backend": {
                            "image": env[cache.ENV_RUNTIME_IMAGE_ID],
                            "user": "65532:65532",
                            "read_only": True,
                            "labels": {
                                cache.CONSUMER_PROFILE_LABEL: env[cache.ENV_PROFILE],
                                cache.CONSUMER_KEY_LABEL: env[cache.ENV_KEY],
                            },
                            "volumes": [{"type": "bind", "source": env[cache.ENV_MOUNT_ROOT], "target": cache.GUEST_TARGET, "read_only": False}],
                        },
                        cache.MAINTENANCE_SERVICE: {
                            "image": env[cache.ENV_HELPER_IMAGE], "privileged": True, "network_mode": "none",
                            "environment": {cache.ENV_BACKEND_PACKAGE: env[cache.ENV_BACKEND_PACKAGE]},
                        },
                    },
                })
            if args[0] == "compose" and "run" in args:
                env = kwargs["environment"]
                return json.dumps({
                    "schema": cache.SCHEMA, "profile": cache.PROFILE, "state": "ready",
                    "project_id": env[cache.ENV_PROJECT_ID], "cache_key": env[cache.ENV_KEY],
                    "backing_image": env[cache.ENV_BACKING_IMAGE], "mount_root": env[cache.ENV_MOUNT_ROOT],
                    "package_root": env[cache.ENV_BACKEND_PACKAGE],
                    "mount_target": env[cache.ENV_MOUNT_TARGET], "filesystem": "ext4",
                    "filesystem_uuid": UUID, "filesystem_label": cache.IMAGE_LABEL,
                    "loop_device": "/dev/loop7", "mount_active": True,
                    "size_bytes": int(env[cache.ENV_SIZE_BYTES]),
                    "runtime_image_id": env[cache.ENV_RUNTIME_IMAGE_ID],
                    "toolchain_image_id": env[cache.ENV_TOOLCHAIN_IMAGE],
                })
            raise AssertionError(args)

    class GrowthDocker(PrepareDocker):
        def __init__(self):
            self.calls = []

        def __call__(self, *args, **kwargs):
            self.calls.append((args, kwargs))
            if args[0] == "compose" and "run" in args:
                env = kwargs["environment"]
                options = {}
                for index, value in enumerate(args[:-1]):
                    if value == "-e" and "=" in args[index + 1]:
                        name, item = args[index + 1].split("=", 1)
                        options[name] = item
                previous_size = int(options["FULLMAG_BACKEND_CACHE_GROW_FROM_BYTES"])
                target_size = int(options["FULLMAG_BACKEND_CACHE_GROW_TO_BYTES"])
                growth_suffix = {
                    (cache.LEGACY_CACHE_SIZE_BYTES, cache.CACHE_SIZE_BYTES): cache.GROWTH_V1_SUFFIX,
                    (cache.CACHE_SIZE_BYTES, cache.EXTENDED_CACHE_SIZE_BYTES): cache.GROWTH_V2_SUFFIX,
                    (cache.EXTENDED_CACHE_SIZE_BYTES, cache.MAX_CACHE_SIZE_BYTES): cache.GROWTH_V3_SUFFIX,
                }[(previous_size, target_size)]
                return json.dumps({
                    "schema": cache.SCHEMA, "profile": cache.PROFILE, "state": "grown",
                    "project_id": env[cache.ENV_PROJECT_ID], "cache_key": env[cache.ENV_KEY],
                    "backing_image": env[cache.ENV_BACKING_IMAGE], "mount_root": env[cache.ENV_MOUNT_ROOT],
                    "package_root": env[cache.ENV_BACKEND_PACKAGE],
                    "mount_target": env[cache.ENV_MOUNT_TARGET], "filesystem": "ext4",
                    "filesystem_uuid": UUID, "filesystem_label": cache.IMAGE_LABEL,
                    "loop_device": "/dev/loop7", "mount_active": True,
                    "previous_size_bytes": previous_size,
                    "size_bytes": target_size,
                    "runtime_image_id": env[cache.ENV_RUNTIME_IMAGE_ID],
                    "toolchain_image_id": env[cache.ENV_TOOLCHAIN_IMAGE],
                    "owner_token": TOKEN,
                    "growth_receipt": env[cache.ENV_BACKING_IMAGE] + growth_suffix,
                })
            return super().__call__(*args, **kwargs)

    def test_prepare_selects_24_gib_for_new_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "storage").mkdir()
            profile = cache.prepare(
                {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                SCRIPTS.parent, IMAGE, root / "run", self.PrepareDocker(),
                source_root=root, toolchain_image=TOOLCHAIN,
            )
            self.assertEqual(profile["size_bytes"], cache.CACHE_SIZE_BYTES)
            self.assertEqual(profile["environment"][cache.ENV_SIZE_BYTES], str(cache.CACHE_SIZE_BYTES))
            self.assertEqual(profile["package_root"], "/mnt/fullmag-backend-cache-fullmag-test-" + profile["cache_key"][:16] + "/package")
            self.assertEqual(profile["environment"][cache.ENV_BACKEND_PACKAGE], profile["package_root"])
            self.assertTrue(profile["package_root"].startswith("/mnt/"))
            self.assertNotRegex(profile["package_root"], r"^[A-Za-z]:")

    def test_prepare_preserves_existing_12_gib_capacity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "storage").mkdir()
            with mock.patch.object(cache, "_existing_backing_size", return_value=cache.LEGACY_CACHE_SIZE_BYTES):
                profile = cache.prepare(
                    {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                    SCRIPTS.parent, IMAGE, root / "run", self.PrepareDocker(),
                    source_root=root, toolchain_image=TOOLCHAIN,
                )
            self.assertEqual(profile["size_bytes"], cache.LEGACY_CACHE_SIZE_BYTES)
            self.assertEqual(profile["environment"][cache.ENV_SIZE_BYTES], str(cache.LEGACY_CACHE_SIZE_BYTES))

    def test_prepare_admits_existing_40_gib_capacity_without_resizing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "storage").mkdir()
            with mock.patch.object(cache, "_existing_backing_size", return_value=cache.EXTENDED_CACHE_SIZE_BYTES), \
                    mock.patch.object(cache, "_guard_new_backing_space"):
                profile = cache.prepare(
                    {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                    SCRIPTS.parent, IMAGE, root / "run", self.PrepareDocker(),
                    source_root=root, toolchain_image=TOOLCHAIN,
                )
            self.assertEqual(profile["size_bytes"], cache.EXTENDED_CACHE_SIZE_BYTES)
            self.assertEqual(
                profile["environment"][cache.ENV_SIZE_BYTES],
                str(cache.EXTENDED_CACHE_SIZE_BYTES),
            )

    def test_prepare_admits_existing_50_gib_capacity_without_resizing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "storage").mkdir()
            with mock.patch.object(cache, "_existing_backing_size", return_value=cache.MAX_CACHE_SIZE_BYTES), \
                    mock.patch.object(cache, "_guard_new_backing_space") as guard:
                profile = cache.prepare(
                    {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                    SCRIPTS.parent, IMAGE, root / "run", self.PrepareDocker(),
                    source_root=root, toolchain_image=TOOLCHAIN,
                )
            self.assertEqual(profile["size_bytes"], cache.MAX_CACHE_SIZE_BYTES)
            self.assertEqual(
                profile["environment"][cache.ENV_SIZE_BYTES],
                str(cache.MAX_CACHE_SIZE_BYTES),
            )
            guard.assert_called_once()

    def test_grow_explicitly_selects_24_to_40_transition(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "storage").mkdir()
            docker = self.GrowthDocker()
            with mock.patch.object(cache, "_existing_backing_size", return_value=cache.CACHE_SIZE_BYTES), \
                    mock.patch.object(cache, "_guard_growth_space") as guard:
                profile = cache.grow(
                    {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                    SCRIPTS.parent,
                    IMAGE,
                    root / "run",
                    docker,
                    source_root=root,
                    toolchain_image=TOOLCHAIN,
                    target_size=cache.EXTENDED_CACHE_SIZE_BYTES,
                )
            self.assertEqual(profile["size_bytes"], cache.EXTENDED_CACHE_SIZE_BYTES)
            guard.assert_called_once_with(
                mock.ANY,
                mock.ANY,
                cache.CACHE_SIZE_BYTES,
                cache.EXTENDED_CACHE_SIZE_BYTES,
            )
            run_calls = [args for args, _kwargs in docker.calls if args[0] == "compose" and "run" in args]
            self.assertEqual(len(run_calls), 1)
            self.assertIn(
                f"FULLMAG_BACKEND_CACHE_GROW_FROM_BYTES={cache.CACHE_SIZE_BYTES}",
                run_calls[0],
            )
            self.assertIn(
                f"FULLMAG_BACKEND_CACHE_GROW_TO_BYTES={cache.EXTENDED_CACHE_SIZE_BYTES}",
                run_calls[0],
            )

    def test_grow_explicitly_selects_40_to_50_transition(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "storage").mkdir()
            docker = self.GrowthDocker()
            with mock.patch.object(cache, "_existing_backing_size", return_value=cache.EXTENDED_CACHE_SIZE_BYTES), \
                    mock.patch.object(cache, "_guard_growth_space") as guard:
                profile = cache.grow(
                    {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                    SCRIPTS.parent,
                    IMAGE,
                    root / "run",
                    docker,
                    source_root=root,
                    toolchain_image=TOOLCHAIN,
                    target_size=cache.MAX_CACHE_SIZE_BYTES,
                )
            self.assertEqual(profile["size_bytes"], cache.MAX_CACHE_SIZE_BYTES)
            guard.assert_called_once_with(
                mock.ANY,
                mock.ANY,
                cache.EXTENDED_CACHE_SIZE_BYTES,
                cache.MAX_CACHE_SIZE_BYTES,
            )
            run_calls = [args for args, _kwargs in docker.calls if args[0] == "compose" and "run" in args]
            self.assertEqual(len(run_calls), 1)
            self.assertIn(
                f"FULLMAG_BACKEND_CACHE_GROW_FROM_BYTES={cache.EXTENDED_CACHE_SIZE_BYTES}",
                run_calls[0],
            )
            self.assertIn(
                f"FULLMAG_BACKEND_CACHE_GROW_TO_BYTES={cache.MAX_CACHE_SIZE_BYTES}",
                run_calls[0],
            )
            self.assertTrue(any(cache.GROWTH_V3_SUFFIX in str(arg) for arg in run_calls[0]))

    def test_grow_40_gib_requires_an_explicit_50_gib_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "storage").mkdir()
            with mock.patch.object(cache, "_existing_backing_size", return_value=cache.EXTENDED_CACHE_SIZE_BYTES), \
                    self.assertRaisesRegex(cache.BackendCacheError, "target_size=MAX_CACHE_SIZE_BYTES"):
                cache.grow(
                    {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                    SCRIPTS.parent,
                    IMAGE,
                    root / "run",
                    self.GrowthDocker(),
                    source_root=root,
                    toolchain_image=TOOLCHAIN,
                )

    def test_growth_receipt_attests_size_uuid_owner_and_exact_journal(self):
        values = {
            "project_id": "fullmag-test",
            "cache_key": "c" * 64,
            "backing_image": "/storage/build-volumes/cache.ext4",
            "mount_root": "/mnt/fullmag-backend-cache-fullmag-test-cccccccccccccccc",
            "package_root": "/mnt/fullmag-backend-cache-fullmag-test-cccccccccccccccc/package",
            "mount_target": cache.MOUNT_TARGET,
        }
        receipt = {
            "schema": cache.SCHEMA,
            "profile": cache.PROFILE,
            "state": "grown",
            "project_id": values["project_id"],
            "cache_key": values["cache_key"],
            "backing_image": values["backing_image"],
            "mount_root": values["mount_root"],
            "package_root": values["mount_root"] + "/package",
            "mount_target": values["mount_target"],
            "filesystem": "ext4",
            "filesystem_label": cache.IMAGE_LABEL,
            "filesystem_uuid": UUID,
            "loop_device": "/dev/loop7",
            "mount_active": True,
            "previous_size_bytes": cache.LEGACY_CACHE_SIZE_BYTES,
            "size_bytes": cache.CACHE_SIZE_BYTES,
            "runtime_image_id": IMAGE,
            "toolchain_image_id": TOOLCHAIN,
            "owner_token": TOKEN,
            "growth_receipt": values["backing_image"] + ".growth-v1.json",
        }
        cache._validate_growth_receipt(receipt, values, IMAGE, TOOLCHAIN)
        receipt["size_bytes"] = cache.LEGACY_CACHE_SIZE_BYTES
        with self.assertRaises(cache.BackendCacheError):
            cache._validate_growth_receipt(receipt, values, IMAGE, TOOLCHAIN)

    def test_growth_receipt_attests_24_to_40_transition_and_v2_journal(self):
        values = {
            "project_id": "fullmag-test",
            "cache_key": "c" * 64,
            "backing_image": "/storage/build-volumes/cache.ext4",
            "mount_root": "/mnt/fullmag-backend-cache-fullmag-test-cccccccccccccccc",
            "package_root": "/mnt/fullmag-backend-cache-fullmag-test-cccccccccccccccc/package",
            "mount_target": cache.MOUNT_TARGET,
        }
        receipt = {
            "schema": cache.SCHEMA,
            "profile": cache.PROFILE,
            "state": "grown",
            "project_id": values["project_id"],
            "cache_key": values["cache_key"],
            "backing_image": values["backing_image"],
            "mount_root": values["mount_root"],
            "package_root": values["mount_root"] + "/package",
            "mount_target": values["mount_target"],
            "filesystem": "ext4",
            "filesystem_label": cache.IMAGE_LABEL,
            "filesystem_uuid": UUID,
            "loop_device": "/dev/loop7",
            "mount_active": True,
            "previous_size_bytes": cache.CACHE_SIZE_BYTES,
            "size_bytes": cache.EXTENDED_CACHE_SIZE_BYTES,
            "runtime_image_id": IMAGE,
            "toolchain_image_id": TOOLCHAIN,
            "owner_token": TOKEN,
            "growth_receipt": values["backing_image"] + cache.GROWTH_V2_SUFFIX,
        }
        cache._validate_growth_receipt(
            receipt,
            values,
            IMAGE,
            TOOLCHAIN,
            expected_previous_size=cache.CACHE_SIZE_BYTES,
            expected_size=cache.EXTENDED_CACHE_SIZE_BYTES,
        )

    def test_growth_receipt_attests_40_to_50_transition_and_v3_journal(self):
        values = {
            "project_id": "fullmag-test",
            "cache_key": "c" * 64,
            "backing_image": "/storage/build-volumes/cache.ext4",
            "mount_root": "/mnt/fullmag-backend-cache-fullmag-test-cccccccccccccccc",
            "package_root": "/mnt/fullmag-backend-cache-fullmag-test-cccccccccccccccc/package",
            "mount_target": cache.MOUNT_TARGET,
        }
        receipt = {
            "schema": cache.SCHEMA,
            "profile": cache.PROFILE,
            "state": "grown",
            "project_id": values["project_id"],
            "cache_key": values["cache_key"],
            "backing_image": values["backing_image"],
            "mount_root": values["mount_root"],
            "package_root": values["mount_root"] + "/package",
            "mount_target": values["mount_target"],
            "filesystem": "ext4",
            "filesystem_label": cache.IMAGE_LABEL,
            "filesystem_uuid": UUID,
            "loop_device": "/dev/loop7",
            "mount_active": True,
            "previous_size_bytes": cache.EXTENDED_CACHE_SIZE_BYTES,
            "size_bytes": cache.MAX_CACHE_SIZE_BYTES,
            "runtime_image_id": IMAGE,
            "toolchain_image_id": TOOLCHAIN,
            "owner_token": TOKEN,
            "growth_receipt": values["backing_image"] + cache.GROWTH_V3_SUFFIX,
        }
        cache._validate_growth_receipt(
            receipt,
            values,
            IMAGE,
            TOOLCHAIN,
            expected_previous_size=cache.EXTENDED_CACHE_SIZE_BYTES,
            expected_size=cache.MAX_CACHE_SIZE_BYTES,
        )

    def test_mount_consumer_guard_rejects_exact_bind_even_without_cache_label(self):
        container = "d" * 64

        def docker(*args, **kwargs):
            if args[:3] == ("ps", "--all", "--quiet"):
                return container + "\n"
            if args[:2] == ("inspect", container):
                return json.dumps([{"Mounts": [{"Type": "bind", "Source": "/mnt/cache"}]}])
            raise AssertionError(args)

        with self.assertRaisesRegex(cache.BackendCacheError, "declared"):
            cache._assert_no_mount_consumers(docker, "/mnt/cache")


class BackendCacheSourceChecks(unittest.TestCase):
    def test_existing_owned_cache_adds_only_package_child_and_rejects_foreign_child(self):
        helper = SCRIPTS / "lib" / "docker_backend_cache.sh"
        source = helper.read_text(encoding="utf-8")
        prefix, separator, _ = source.partition("\ntrap cleanup EXIT\n")
        self.assertTrue(separator, "helper must expose its functions before main/trap")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mounted = root / "mounted"
            mounted.mkdir()

            create_scenario = prefix + r'''
set -Eeuo pipefail
ROOT="${HARNESS_ROOT:?}"
MOUNT_ROOT="$ROOT/mounted"
PACKAGE_ROOT="$MOUNT_ROOT/package"
RUNTIME_UID=65532
RUNTIME_GID=65532
host() {
  case "$1" in
    test) shift; command test "$@" ;;
    mkdir) shift; command mkdir "$@" ;;
    chown|chmod) return 0 ;;
    stat) printf '%s\n' '65532 65532 770' ;;
    *) printf 'unexpected host operation: %s\n' "$1" >&2; return 1 ;;
  esac
}
ensure_package
test -d "$PACKAGE_ROOT"
printf '%s\n' created
'''
            create_path = root / "create-package.sh"
            create_path.write_text(create_scenario, encoding="utf-8")
            create_path.chmod(0o700)
            environment = dict(os.environ)
            environment["HARNESS_ROOT"] = str(root)
            created = subprocess.run(
                ["bash", str(create_path)], env=environment, capture_output=True, text=True, check=False,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            self.assertEqual(created.stdout.strip(), "created")
            self.assertTrue((mounted / "package").is_dir())

            foreign_scenario = prefix + r'''
set -Eeuo pipefail
ROOT="${HARNESS_ROOT:?}"
MOUNT_ROOT="$ROOT/mounted"
PACKAGE_ROOT="$MOUNT_ROOT/package"
RUNTIME_UID=65532
RUNTIME_GID=65532
host() {
  case "$1" in
    test) shift; command test "$@" ;;
    stat) printf '%s\n' '0 0 755' ;;
    *) printf 'unexpected host operation: %s\n' "$1" >&2; return 1 ;;
  esac
}
ensure_package
'''
            foreign_path = root / "foreign-package.sh"
            foreign_path.write_text(foreign_scenario, encoding="utf-8")
            foreign_path.chmod(0o700)
            rejected = subprocess.run(
                ["bash", str(foreign_path)], env=environment, capture_output=True, text=True, check=False,
            )
            self.assertEqual(rejected.returncode, 2, rejected.stdout)
            self.assertIn("ownership changed", rejected.stderr)

            unowned_scenario = prefix + r'''
set -Eeuo pipefail
ROOT="${HARNESS_ROOT:?}"
MOUNT_ROOT="$ROOT/unowned"
OWNER_MARKER="$MOUNT_ROOT/.fullmag-backend-cache-owner.json"
CREATED_IMAGE=0
host() {
  case "$1" in
    test) shift; command test "$@" ;;
    *) printf 'unexpected host operation: %s\n' "$1" >&2; return 1 ;;
  esac
}
mkdir -p "$MOUNT_ROOT"
admit_mounted_cache
'''
            unowned_path = root / "unowned-cache.sh"
            unowned_path.write_text(unowned_scenario, encoding="utf-8")
            unowned_path.chmod(0o700)
            unowned = subprocess.run(
                ["bash", str(unowned_path)], env=environment, capture_output=True, text=True, check=False,
            )
            self.assertEqual(unowned.returncode, 2, unowned.stdout)
            self.assertIn("no owner marker", unowned.stderr)
            self.assertFalse((root / "unowned" / "package").exists())

    def test_shell_growth_path_is_parseable_and_does_not_clear_or_format(self):
        helper = SCRIPTS / "lib" / "docker_backend_cache.sh"
        source = helper.read_text(encoding="utf-8")
        overlay = SCRIPTS.parent / "compose.backend-cache.yaml"
        overlay_source = overlay.read_text(encoding="utf-8")
        self.assertEqual(subprocess.run(["bash", "-n", str(helper)], check=False).returncode, 0)
        self.assertIn("losetup --set-capacity", source)
        self.assertIn("resize2fs", source)
        self.assertIn("growth_journal started", source)
        self.assertIn("growth_journal succeeded", source)
        self.assertIn("update_owner_marker_size", source)
        self.assertIn("growth_journal_state", source)
        self.assertIn('journal_line="$(growth_journal_state)"', source)
        self.assertIn("EXTENDED_IMAGE_SIZE_BYTES=42949672960", source)
        self.assertIn("MAX_IMAGE_SIZE_BYTES=53687091200", source)
        self.assertIn(".growth-v2.json", source)
        self.assertIn(".growth-v3.json", source)
        self.assertIn("EXTENDED_IMAGE_SIZE_BYTES:$MAX_IMAGE_SIZE_BYTES", source)
        self.assertIn('"$GROW_TO_VALUE"', source)
        self.assertNotIn("<<<", source)
        self.assertNotIn("growth requires the cache mount to be inactive", source)
        self.assertIn("existing backend cache has no owner marker", source)
        self.assertIn("backend package root ownership changed", source)
        self.assertIn('host mkdir "$PACKAGE_ROOT"', source)
        self.assertIn('"package_root":package', source)
        self.assertIn("FULLMAG_BACKEND_PACKAGE", overlay_source)
        self.assertIn("Resolved backend package root is required", overlay_source)
        self.assertNotIn("rm -rf", source)
        self.assertNotIn("resize2fs -f", source)


if __name__ == "__main__":
    unittest.main()
