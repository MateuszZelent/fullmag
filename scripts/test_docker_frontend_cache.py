#!/usr/bin/env python3
"""Interpreted regressions for the persistent frontend-cache-v1 adapter."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import docker_frontend_cache as cache
import fullmag_docker_runtime as runtime


IMAGE = "sha256:" + "a" * 64
UUID = "11111111-1111-1111-1111-111111111111"


class FakeDocker:
    def __init__(self):
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[0] == "ps":
            return ""
        if args[:2] == ("image", "inspect"):
            return json.dumps([{"Id": IMAGE, "Config": {"Volumes": None},
                                "Os": "linux", "Architecture": "amd64"}])
        if args[0] == "compose" and "config" in args:
            # Compose omits profiled services unless their profile is enabled.
            if "--profile" not in args or cache.MAINTENANCE_PROFILE not in args:
                return json.dumps({"services": {"frontend": {"volumes": []}}})
            env = kwargs["environment"]
            volumes = [
                {"type": "bind", "source": env[cache.ENV_CACHE_SOURCE],
                 "target": cache.CHILD_TARGETS["cache"], "read_only": False},
                {"type": "bind", "source": env[cache.ENV_PNPM_SOURCE],
                 "target": cache.CHILD_TARGETS["pnpm_store"], "read_only": False},
                {"type": "bind", "source": env[cache.ENV_WORKSPACE_NODE_MODULES_SOURCE],
                 "target": cache.CHILD_TARGETS["workspace_node_modules"], "read_only": False},
                {"type": "bind", "source": env[cache.ENV_CONTROL_ROOM_NODE_MODULES_SOURCE],
                 "target": cache.CHILD_TARGETS["control_room_node_modules"], "read_only": False},
            ]
            return json.dumps({
                "name": "frontend-cache-test",
                "services": {
                    "frontend": {
                        "image": IMAGE,
                        "labels": {
                            cache.CONSUMER_PROFILE_LABEL: env[cache.ENV_PROFILE],
                            cache.CONSUMER_KEY_LABEL: env[cache.ENV_KEY],
                        },
                        "volumes": volumes,
                    },
                    cache.MAINTENANCE_SERVICE: {
                        "image": IMAGE, "privileged": True,
                        "network_mode": "none", "volumes": [],
                    },
                },
            })
        if args[0] == "compose" and "run" in args:
            env = kwargs["environment"]
            return json.dumps({
                "schema": cache.SCHEMA, "profile": cache.PROFILE,
                "state": "ready", "project_id": env[cache.ENV_PROJECT_ID],
                "cache_key": env[cache.ENV_KEY],
                "backing_image": env[cache.ENV_BACKING_IMAGE],
                "mount_root": env[cache.ENV_MOUNT_ROOT],
                "mount_target": env[cache.ENV_MOUNT_TARGET],
                "filesystem": "ext4", "filesystem_uuid": UUID,
                "filesystem_label": cache.IMAGE_LABEL,
                "loop_device": "/dev/loop7", "mount_active": True,
                "size_bytes": cache.CACHE_SIZE_BYTES,
                "runtime_image_id": IMAGE,
            })
        raise AssertionError(f"unexpected Docker call: {args!r}")


class FrontendCacheTests(unittest.TestCase):
    def test_new_windows_cache_checks_full_allocation_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {"storage_root": root, "backing_image": root / "cache.ext4"}
            with mock.patch.object(cache.shutil, "disk_usage", return_value=type("Usage", (), {"free": 1})()):
                with self.assertRaisesRegex(cache.FrontendCacheError, "free bytes"):
                    cache._require_cache_capacity(paths, windows=True)
            self.assertFalse(paths["backing_image"].exists())

    def test_existing_windows_cache_does_not_reserve_its_size_again(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {"storage_root": root, "backing_image": root / "cache.ext4"}
            paths["backing_image"].touch()
            with mock.patch.object(cache.shutil, "disk_usage", side_effect=AssertionError("unexpected reservation")):
                cache._require_cache_capacity(paths, windows=True)

    def test_guest_v1_preserves_seed_contract_without_host_cache_metadata(self):
        from docker_development_inputs import guest_manifest, HOST_CACHE_METADATA_KEYS

        legacy = {"schema": "fullmag.docker-development-inputs.v1",
                  "source_root": "C:/git/fullmag/fullmag", "source_commit": "a" * 40,
                  "host_port": 32871, "workspace_root": "/state/development/workspace",
                  "frontend_root": "/state/development/cache", "files": [],
                  "live_directories": []}
        host = {**legacy, **{name: "retained-host-metadata" for name in HOST_CACHE_METADATA_KEYS}}
        before = dict(host)
        self.assertEqual(guest_manifest(host), legacy)
        self.assertEqual(host, before, "guest publication must retain all host cache evidence")
        self.assertEqual(guest_manifest(legacy), legacy)

    def test_python_shell_contract_uses_short_label_and_identical_paths(self):
        helper = Path(cache.__file__).parents[1] / "scripts" / "lib" / "docker_frontend_cache.sh"
        source = helper.read_text(encoding="utf-8")
        self.assertLessEqual(len(cache.IMAGE_LABEL.encode("ascii")), 16)
        self.assertIn(f'IMAGE_LABEL="{cache.IMAGE_LABEL}"', source)
        self.assertIn('+"\\n"', source)
        self.assertNotIn('+"\\\\n"', source)
        with tempfile.TemporaryDirectory() as temporary:
            paths = cache._cache_paths({"project_id": "fullmag-test", "storage_root": temporary}, "a" * 64)
            self.assertEqual(str(paths["lock_path"]), str(paths["backing_image"]) + ".lock")
        self.assertIn("inspect_unmounted", source)
        self.assertIn('elif [[ "$MOUNT_ACTIVE" == 1 ]]', source)

    def test_existing_image_reuse_only_verifies_and_mountpoint_must_be_empty(self):
        helper = Path(cache.__file__).parents[1] / "scripts" / "lib" / "docker_frontend_cache.sh"
        source = helper.read_text(encoding="utf-8")
        prefix, separator, _ = source.partition("\ntrap cleanup EXIT\n")
        self.assertTrue(separator, "helper must expose its functions before main/trap")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mount_root = root / "mounted"
            mount_root.mkdir()
            for child in (
                "cache",
                "pnpm-store",
                "workspace-node_modules",
                "control-room-node_modules",
            ):
                (mount_root / child).mkdir()
            backing_image = root / "cache.ext4"
            backing_image.touch()
            runtime_lock = mount_root / "cache" / ".fullmag-frontend-runtime.lock"
            runtime_lock.touch()
            runtime_lock.chmod(0o660)
            filesystem_uuid = "11111111-1111-1111-1111-111111111111"
            cache_key = "a" * 64
            owner_marker = mount_root / ".fullmag-frontend-cache-owner.json"
            owner_marker.write_text(
                json.dumps(
                    {
                        "schema": "fullmag.frontend-cache-owner.v1",
                        "profile": cache.PROFILE,
                        "project_id": "fullmag-test",
                        "cache_key": cache_key,
                        "backing_image": str(backing_image),
                        "mount_root": str(mount_root),
                        "filesystem_uuid": filesystem_uuid,
                        "image_size_bytes": cache.CACHE_SIZE_BYTES,
                        "mount_target": "/fullmag-frontend-cache",
                        "runtime_uid": 65532,
                        "runtime_gid": 65532,
                        "owner_token": "22222222-2222-2222-2222-222222222222",
                    },
                    separators=(",", ":"),
                )
                + "\n",
                encoding="utf-8",
            )
            owner_marker.chmod(0o444)

            scenario = prefix + r'''
set -Eeuo pipefail
ROOT="${HARNESS_ROOT:?}"
LOG="$ROOT/commands.log"
PROFILE="fullmag-frontend-cache-v1"
PROJECT_ID="fullmag-test"
CACHE_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
BACKING_IMAGE="$ROOT/cache.ext4"
MOUNT_ROOT="$ROOT/mounted"
OWNER_MARKER="$MOUNT_ROOT/.fullmag-frontend-cache-owner.json"
RUNTIME_LOCK="$MOUNT_ROOT/cache/.fullmag-frontend-runtime.lock"
RUNTIME_IMAGE_ID="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HOST_PID=$$
RUNTIME_UID=65532
RUNTIME_GID=65532
IMAGE_SIZE_BYTES=8589934592
MOUNT_TARGET="/fullmag-frontend-cache"
LOCK_WAIT=1

host() {
  printf 'host' >> "$LOG"
  printf ' %q' "$@" >> "$LOG"
  printf '\n' >> "$LOG"
  case "$1" in
    test)
      shift
      command test "$@"
      ;;
    findmnt)
      printf '%s\n' '/dev/loop7 ext4 11111111-1111-1111-1111-111111111111'
      ;;
    stat)
      if [[ "$2" == '-c' && "$3" == '%s' ]]; then
        printf '%s\n' "$IMAGE_SIZE_BYTES"
      elif [[ "$2" == '-Lc' && "$4" == "$RUNTIME_LOCK" ]]; then
        printf '%s\n' '65532 65532 660'
      elif [[ "$2" == '-Lc' && "$4" == "$MOUNT_ROOT" ]]; then
        printf '%s\n' '0 0 755'
      else
        printf '%s\n' '65532 65532 770'
      fi
      ;;
    cat)
      printf '%s\n' "$BACKING_IMAGE"
      ;;
    blkid)
      if [[ "$3" == 'UUID' ]]; then
        printf '%s\n' '11111111-1111-1111-1111-111111111111'
      elif [[ "$3" == 'LABEL' ]]; then
        printf '%s\n' 'fm-fe-cache-v1'
      else
        return 1
      fi
      ;;
    *)
      printf 'unexpected host operation: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

admit_mounted_cache
printf '%s\n' admitted
'''
            scenario_path = root / "reuse-scenario.sh"
            scenario_path.write_text(scenario, encoding="utf-8")
            scenario_path.chmod(0o700)
            shim_dir = root / "bin"
            shim_dir.mkdir()
            python_shim = shim_dir / "python3"
            python_shim.write_text(
                "#!/bin/sh\n"
                "if [ \"$#\" -ge 2 ] && [ \"$1\" = \"-c\" ]; then\n"
                "  case \"$2\" in *owner_token*) exit 0;; esac\n"
                "fi\n"
                "exec /usr/bin/python3 \"$@\"\n",
                encoding="utf-8",
            )
            python_shim.chmod(0o700)
            environment = dict(os.environ)
            environment["HARNESS_ROOT"] = str(root)
            environment["PATH"] = f"{shim_dir}:{environment['PATH']}"
            completed = subprocess.run(
                ["bash", str(scenario_path)],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.strip(), "admitted")
            calls = (root / "commands.log").read_text(encoding="utf-8")
            operations = {line.split()[1] for line in calls.splitlines() if len(line.split()) > 1}
            self.assertTrue({"findmnt", "stat", "cat", "blkid", "test"} <= operations)
            self.assertTrue(
                {
                    "mkdir",
                    "chown",
                    "chmod",
                    "mkfs.ext4",
                    "truncate",
                    "mount",
                    "losetup",
                    "rm",
                    "umount",
                }.isdisjoint(operations),
                calls,
            )

            foreign_root = root / "unmounted"
            foreign_root.mkdir()
            (foreign_root / "foreign-entry").write_text("owned elsewhere", encoding="utf-8")
            reject_scenario = prefix + r'''
set -Eeuo pipefail
ROOT="${HARNESS_ROOT:?}"
LOG="$ROOT/reject-commands.log"
MOUNT_ROOT="$ROOT/unmounted"
host() {
  printf 'host' >> "$LOG"
  printf ' %q' "$@" >> "$LOG"
  printf '\n' >> "$LOG"
  case "$1" in
    test) shift; command test "$@" ;;
    find) shift; command find "$@" ;;
    *) printf 'unexpected host operation: %s\n' "$1" >&2; return 1 ;;
  esac
}
inspect_unmounted
'''
            reject_path = root / "reject-scenario.sh"
            reject_path.write_text(reject_scenario, encoding="utf-8")
            reject_path.chmod(0o700)
            rejected = subprocess.run(
                ["bash", str(reject_path)],
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(rejected.returncode, 2, rejected.stdout)
            self.assertIn("not empty", rejected.stderr)

    def test_owner_marker_read_is_bounded_and_no_follow(self):
        helper = Path(cache.__file__).parents[1] / "scripts" / "lib" / "docker_frontend_cache.sh"
        source = helper.read_text(encoding="utf-8")
        self.assertIn("os.O_NOFOLLOW|os.O_CLOEXEC", source)
        self.assertIn("s=os.fstat(fd)", source)
        self.assertIn("s.st_size>16384", source)
        self.assertIn("raw=os.read(fd,16385)", source)

    def test_overlay_is_standalone_and_pins_attested_frontend_image(self):
        overlay = Path(cache.__file__).parents[1] / "compose.frontend-cache.yaml"
        source = overlay.read_text(encoding="utf-8")
        self.assertRegex(
            source,
            r"(?ms)^  frontend:\n(?:.*\n){0,4}    image: \"\$\{FULLMAG_FRONTEND_CACHE_RUNTIME_IMAGE_ID",
        )
        self.assertIn("pull_policy: never", source)

    def test_image_identity_is_full_linux_digest(self):
        fake = FakeDocker()
        with self.assertRaises(cache.FrontendCacheError):
            cache._image_attestation(fake, "sha256:" + "a" * 63)

    def test_docker_json_parser_accepts_pretty_output_and_helper_tail(self):
        pretty = json.dumps({"services": {"frontend": {"image": IMAGE}}}, indent=2)
        self.assertEqual(cache._read_json_output(pretty)["services"]["frontend"]["image"], IMAGE)
        tailed = "helper progress 1/1\n" + json.dumps({"state": "ready"}) + "\n"
        self.assertEqual(cache._read_json_output(tailed), {"state": "ready"})

    def test_active_exact_key_consumer_is_rejected_by_inspect_guard(self):
        key = "a" * 64
        children = {
            "cache": "/mnt/cache/cache",
            "pnpm_store": "/mnt/cache/pnpm-store",
            "workspace_node_modules": "/mnt/cache/workspace-node_modules",
            "control_room_node_modules": "/mnt/cache/control-room_node_modules",
        }
        mounts = [
            {"Type": "bind", "Source": source, "Destination": target}
            for target, source in {
                cache.CHILD_TARGETS[name]: path for name, path in children.items()
            }.items()
        ]

        def docker(*args, **kwargs):
            if args[0] == "ps":
                return "a" * 12 + "\n"
            if args[0] == "inspect":
                return json.dumps([{
                    "Config": {"Labels": {
                        cache.CONSUMER_PROFILE_LABEL: cache.PROFILE,
                        cache.CONSUMER_KEY_LABEL: key,
                    }},
                    "Mounts": mounts,
                }])
            raise AssertionError(args)

        with self.assertRaisesRegex(cache.FrontendCacheError, "already held"):
            cache._assert_no_active_consumers(docker, key, children)

    def test_key_ignores_commit_and_authored_source_but_tracks_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "checkout"
            source.mkdir()
            first = cache.cache_key(source, "worktree-abc", 32871, "a" * 64)
            second = cache.cache_key(source, "worktree-abc", 32871, "a" * 64)
            self.assertEqual(first["key"], second["key"])
            (source / "page.tsx").write_text("changed", encoding="utf-8")
            self.assertEqual(
                first["key"],
                cache.cache_key(source, "worktree-abc", 32871, "a" * 64)["key"],
            )
            self.assertNotEqual(
                first["key"],
                cache.cache_key(source, "worktree-abc", 32871, "b" * 64)["key"],
            )

    def test_watchpack_runtime_override_preserves_v1_cache_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "checkout"
            source.mkdir()
            legacy = cache.default_toolpins()
            effective = dict(legacy, watchpack_polling_ms="2000")

            legacy_identity = cache.cache_key(
                source, "worktree-abc", 32871, "a" * 64, toolpins=legacy
            )
            effective_identity = cache.cache_key(
                source, "worktree-abc", 32871, "a" * 64, toolpins=effective
            )

            self.assertEqual(
                legacy[cache.CACHE_IDENTITY_WATCHPACK_POLLING_KEY],
                cache.CACHE_IDENTITY_WATCHPACK_POLLING_MS,
            )
            self.assertEqual(legacy_identity["key"], effective_identity["key"])
            self.assertEqual(
                effective_identity["toolpins"][cache.CACHE_IDENTITY_WATCHPACK_POLLING_KEY],
                cache.CACHE_IDENTITY_WATCHPACK_POLLING_MS,
            )
            self.assertEqual(
                cache.toolpins_digest(legacy), cache.toolpins_digest(effective)
            )

            with self.assertRaisesRegex(cache.FrontendCacheError, "integer polling"):
                cache.cache_key(
                    source,
                    "worktree-abc",
                    32871,
                    "a" * 64,
                    toolpins=dict(legacy, watchpack_polling_ms="not-a-number"),
                )

    def test_prepare_freezes_overlay_and_attests_ext4_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = root / "repo"
            (repo / "scripts" / "lib").mkdir(parents=True)
            (repo / "scripts" / "lib" / "docker_frontend_cache.sh").write_text(
                "#!/bin/sh\n", encoding="utf-8"
            )
            (repo / "compose.frontend-cache.yaml").write_text("services: {}\n", encoding="utf-8")
            source = root / "checkout"
            source.mkdir()
            fake = FakeDocker()
            layout = {"project_id": "fullmag-test", "storage_root": str(root / "storage")}
            result = cache.prepare(
                layout, repo, IMAGE, root / "run", fake,
                source_root=source, worktree_id="worktree-abc", host_port=32871,
                dependency_seed_sha256="a" * 64,
            )
            self.assertEqual(result["schema"], cache.SCHEMA)
            self.assertEqual(result["filesystem_uuid"], UUID)
            self.assertRegex(result["helper_sha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(result["compose_overlay_sha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(set(result["guest_targets"].values()), set(cache.CHILD_TARGETS.values()))
            self.assertTrue(Path(result["receipt_path"]).is_file())
            maintenance = json.loads(Path(result["maintenance_compose"]).read_text())
            self.assertEqual(set(maintenance["services"]), {cache.MAINTENANCE_SERVICE})
            self.assertNotIn("volumes", maintenance)
            self.assertTrue(any(args[0] == "compose" and "run" in args for args, _ in fake.calls))

    def test_container_attestation_rejects_missing_child_or_named_volume(self):
        profile = {
            "schema": cache.SCHEMA, "state": "ready", "cache_key": "a" * 64,
            "filesystem_uuid": UUID,
            "guest_targets": dict(cache.CHILD_TARGETS),
            "children": {name: "/mnt/cache/" + name for name in cache.CHILD_TARGETS},
            "environment": {
                cache.ENV_SCHEMA: cache.SCHEMA,
                cache.ENV_PROFILE: cache.PROFILE,
                cache.ENV_PROJECT_ID: "fullmag-test",
                cache.ENV_KEY: "a" * 64,
                cache.ENV_FILESYSTEM_UUID: UUID,
                cache.ENV_RUNTIME_IMAGE_ID: IMAGE,
            },
        }
        container = {
            "Config": {
                "Env": [f"{key}={value}" for key, value in profile["environment"].items()],
                "Labels": {
                    cache.CONSUMER_PROFILE_LABEL: cache.PROFILE,
                    cache.CONSUMER_KEY_LABEL: "a" * 64,
                },
            },
            "Mounts": [
                {"Type": "bind", "Source": profile["children"][name],
                 "Destination": profile["guest_targets"][name], "RW": True}
                for name in cache.CHILD_TARGETS
            ] + [{"Type": "tmpfs", "Destination": "/tmp", "RW": True}],
        }
        self.assertEqual(cache.validate_container(container, profile)["state"], "attested")
        container["Mounts"].pop(0)
        with self.assertRaises(cache.FrontendCacheError):
            cache.validate_container(container, profile)
        container["Mounts"] = [{"Type": "volume", "Source": "hidden", "Destination": "/state/development/cache"}]
        with self.assertRaises(cache.FrontendCacheError):
            cache.validate_container(container, profile)

    def test_runtime_compose_spec_requires_and_wires_cache_overlay(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            repo = root / "repo"
            (repo / "scripts" / "lib").mkdir(parents=True)
            (repo / "scripts" / "lib" / "docker_frontend_cache.sh").write_text(
                "#!/bin/sh\n", encoding="utf-8"
            )
            overlay = repo / "compose.frontend-cache.yaml"
            overlay.write_text("services: {}\n", encoding="utf-8")
            source = root / "checkout"
            source.mkdir()
            profile = cache.prepare(
                {"project_id": "fullmag-test", "storage_root": str(root / "storage")},
                repo, IMAGE, root / "run", FakeDocker(), source_root=source,
                worktree_id="worktree-abc", host_port=32871,
                dependency_seed_sha256="a" * 64,
            )

            calls = []

            def compose(*args, **kwargs):
                calls.append((args, kwargs))
                return json.dumps({"services": {"backend": {}, "frontend": {}}})

            with mock.patch.object(runtime, "docker", side_effect=compose):
                configured = runtime.compose_spec(
                    IMAGE, root / "state", 32871, root / "certificate.json",
                    workspace_state_root=root / "user-data",
                    repo=repo, inputs={"source_root": str(source)},
                    inputs_path=root / "inputs.json", package=root / "package",
                    provenance=root / "assembly.json", frontend_cache=profile,
                )
            self.assertEqual(set(configured["services"]), {"backend", "frontend"})
            args, kwargs = calls[0]
            self.assertIn(profile["compose_overlay"], args)
            self.assertEqual(
                kwargs["environment"][cache.ENV_KEY], profile["environment"][cache.ENV_KEY]
            )
    def test_helper_is_independent_and_shell_parses(self):
        helper = Path(cache.__file__).parents[1] / "scripts" / "lib" / "docker_frontend_cache.sh"
        source = helper.read_text(encoding="utf-8")
        self.assertNotIn("docker_host_ledger", source)
        self.assertEqual(subprocess.run(["bash", "-n", str(helper)], check=False).returncode, 0)
        overlay = helper.parents[2] / "compose.frontend-cache.yaml"
        self.assertNotIn("\nvolumes:\n", overlay.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
