from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import docker_backend_volume_cache as cache  # noqa: E402

IMAGE = "sha256:" + "a" * 64
REFRESHED_IMAGE = "sha256:" + "c" * 64
TOOLCHAIN = "sha256:" + "b" * 64


class DockerVolumeFixture:
    def __init__(self, profile, *, roles=()):
        self.profile = profile
        self.documents = {
            role: self._document(role)
            for role in roles
        }
        self.calls = []

    def _document(self, role):
        name = self.profile["volume_names"][role]
        return {
            "Name": name,
            "Driver": "local",
            "Options": {},
            "Scope": "local",
            "Mountpoint": f"/var/lib/docker/volumes/{name}/_data",
            "Labels": cache.volume_labels(self.profile, role),
        }

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ("volume", "inspect"):
            name = args[2]
            for role, expected in self.profile["volume_names"].items():
                if expected == name:
                    if role not in self.documents:
                        raise cache.VolumeNotFound(name)
                    return [self.documents[role]]
            raise AssertionError(name)
        if args[:2] == ("volume", "create"):
            name = args[-1]
            role = next(
                role for role, expected in self.profile["volume_names"].items()
                if expected == name
            )
            self.documents[role] = self._document(role)
            return name
        raise AssertionError(f"unexpected Docker call: {args!r}")


def _profile(tmp: str, image: str = IMAGE):
    root = Path(tmp)
    source = root / "source"
    repo = root / "repo"
    storage = root / "storage"
    runroot = storage / "runs" / "run-1"
    source.mkdir()
    repo.mkdir()
    runroot.mkdir(parents=True)
    layout = {
        "storage_root": str(storage),
        "project_id": "fullmag",
        "worktree_id": "docker-all-master-integration-20261017",
    }
    profile = cache.prepare(
        layout,
        repo,
        image,
        runroot,
        source_root=source,
        toolchain_image=TOOLCHAIN,
    )
    return profile, layout, source, repo, runroot


def _maintenance_receipt(profile):
    markers = {}
    probes = {}
    for role in (cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE):
        markers[role] = {
            "schema": cache.OWNER_SCHEMA,
            "state": "owned",
            "unit_key": profile["unit_key"],
            "owner_id": profile["owner_id"],
            "role": role,
            "volume_name": profile["volume_names"][role],
            "uid": 65532,
            "gid": 65532,
        }
        probes[role] = {
            "regular_marker": True,
            "writable": True,
            "readonly_reopen": True,
            "no_reparse": True,
        }
    return {
        "schema": cache.MAINTENANCE_RECEIPT_SCHEMA,
        "profile": cache.PROFILE,
        "state": "ready",
        "project_id": profile["project_id"],
        "cache_key": profile["cache_key"],
        "unit_key": profile["unit_key"],
        "owner_id": profile["owner_id"],
        "cargo_profile": profile["cargo_profile"],
        "runtime_image_id": profile["runtime_image_id"],
        "toolchain_image_id": profile["toolchain_image_id"],
        "volume_names": dict(profile["volume_names"]),
        "markers": markers,
        "probe": {
            "schema": cache.PROBE_SCHEMA,
            "state": "passed",
            "owner_uid": 65532,
            "owner_gid": 65532,
            "volumes": probes,
        },
    }


def _container(profile, *, socket=False):
    mounts = [
        {
            "Type": "volume",
            "Name": profile["volume_names"][cache.BUILD_VOLUME_ROLE],
            "Destination": cache.BUILD_TARGET,
            "RW": True,
        },
        {
            "Type": "volume",
            "Name": profile["volume_names"][cache.PACKAGE_VOLUME_ROLE],
            "Destination": cache.PACKAGE_TARGET,
            "RW": True,
        },
    ]
    if socket:
        mounts.append({
            "Type": "bind",
            "Source": "/var/run/docker.sock",
            "Destination": "/var/run/docker.sock",
            "RW": True,
        })
    labels = {
        cache.LABEL_SCHEMA: cache.SCHEMA,
        cache.LABEL_PROFILE: cache.PROFILE,
        cache.LABEL_PROJECT: profile["project_id"],
        cache.LABEL_CACHE_KEY: profile["cache_key"],
        cache.LABEL_UNIT: profile["unit_key"],
        cache.LABEL_WORKTREE: profile["worktree_id"],
        cache.LABEL_TOOLCHAIN: profile["toolchain_image_id"],
        cache.LABEL_CARGO_PROFILE: profile["cargo_profile"],
        cache.LABEL_OWNER: profile["owner_id"],
    }
    return {
        "Config": {
            "User": "65532:65532",
            "Env": [f"{key}={value}" for key, value in profile["environment"].items()],
            "Labels": labels,
        },
        "HostConfig": {
            "ReadonlyRootfs": True,
            "Privileged": False,
            "NetworkMode": "fullmag_default",
            "PidMode": "",
            "Binds": [],
        },
        "Mounts": mounts,
    }


class BackendVolumeCacheTests(unittest.TestCase):
    def test_runtime_image_refresh_reuses_stable_pair_and_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            first, layout, source, repo, runroot = _profile(tmp, IMAGE)
            second = cache.prepare(
                layout,
                repo,
                REFRESHED_IMAGE,
                runroot,
                source_root=source,
                toolchain_image=TOOLCHAIN,
            )
            self.assertEqual(first["cache_key"], second["cache_key"])
            self.assertEqual(first["unit_key"], second["unit_key"])
            self.assertEqual(first["volume_names"], second["volume_names"])
            self.assertNotEqual(first["runtime_image_id"], second["runtime_image_id"])
            for role in (cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE):
                labels = cache.volume_labels(first, role)
                self.assertNotIn(cache.LABEL_ROLE.replace("volume-role", "runtime-image"), labels)
                self.assertNotIn(REFRESHED_IMAGE, json.dumps(labels))

    def test_prepare_creates_only_exact_pair_without_driver_options(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            docker = DockerVolumeFixture(profile)
            prepared = cache.prepare(
                {"storage_root": Path(tmp) / "storage", "project_id": "fullmag", "worktree_id": profile["worktree_id"]},
                Path(tmp) / "repo",
                IMAGE,
                Path(tmp) / "storage" / "runs" / "run-1",
                docker,
                source_root=Path(tmp) / "source",
                toolchain_image=TOOLCHAIN,
            )
            self.assertEqual(set(prepared["volume_documents"]), {"build", "package"})
            creates = [call[0] for call in docker.calls if call[0][:2] == ("volume", "create")]
            self.assertEqual(len(creates), 2)
            for args in creates:
                self.assertNotIn("--opt", args)
                self.assertNotIn("--mount", args)
                self.assertNotIn("/mnt/c", args)
                self.assertNotIn("/mnt/d", args)

    def test_prepare_ready_uses_separate_managed_maintenance_callback(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, layout, source, repo, runroot = _profile(tmp)
            docker = DockerVolumeFixture(profile)
            seen = {}

            def maintenance(prepared, maintenance_overlay):
                seen["profile"] = prepared
                seen["overlay"] = maintenance_overlay
                self.assertEqual(set(maintenance_overlay["services"]), {cache.MAINTENANCE_SERVICE})
                self.assertEqual(set(maintenance_overlay["volumes"]), {
                    cache.COMPOSE_BUILD_VOLUME,
                    cache.COMPOSE_PACKAGE_VOLUME,
                })
                return _maintenance_receipt(prepared)

            ready = cache.prepare_ready(
                layout,
                repo,
                IMAGE,
                runroot,
                docker,
                maintenance,
                source_root=source,
                toolchain_image=TOOLCHAIN,
            )
            self.assertEqual(ready["state"], "ready")
            self.assertEqual(seen["profile"]["volume_names"], ready["volume_names"])
            self.assertEqual(set(ready["overlay"]["services"]), {"backend"})

    def test_prepare_ready_publishes_canonical_build_root_in_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, layout, source, repo, runroot = _profile(tmp)
            docker = DockerVolumeFixture(profile)

            ready = cache.prepare_ready(
                layout,
                repo,
                IMAGE,
                runroot,
                docker,
                lambda prepared, overlay: _maintenance_receipt(prepared),
                source_root=source,
                toolchain_image=TOOLCHAIN,
            )

            self.assertEqual(ready["build_root"], cache.BUILD_TARGET)

    def test_partial_pair_and_foreign_pair_fail_closed_without_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            docker = DockerVolumeFixture(profile, roles=(cache.BUILD_VOLUME_ROLE,))
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "partial"):
                cache.ensure_volume_pair(docker, profile)
            self.assertFalse(any(call[0][:2] == ("volume", "create") for call in docker.calls))

            docker = DockerVolumeFixture(profile, roles=(cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE))
            docker.documents[cache.PACKAGE_VOLUME_ROLE]["Labels"][cache.LABEL_OWNER] = "foreign"
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "label mismatch"):
                cache.inspect_volume_pair(docker, profile)
            self.assertFalse(any(call[0][:2] == ("volume", "rm") for call in docker.calls))

    def test_validate_writes_canonical_receipt_and_never_fakes_package_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            docker = DockerVolumeFixture(profile, roles=(cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE))
            result = cache.validate(
                profile,
                docker.documents,
                _maintenance_receipt(profile),
            )
            receipt_path = Path(result["receipt_path"])
            self.assertTrue(receipt_path.is_file())
            stored = json.loads(receipt_path.read_text())
            self.assertEqual(stored["package_root"], cache.PACKAGE_TARGET)
            self.assertEqual(stored["build_root"], cache.BUILD_TARGET)
            self.assertEqual(stored["host_receipt_path"], str(receipt_path))
            self.assertTrue(str(receipt_path).startswith(str(Path(tmp) / "storage")))
            self.assertNotIn("/mnt/fullmag", json.dumps(stored))
            self.assertEqual(set(result["overlay"]["services"]), {"backend"})
            self.assertEqual(
                set(result["maintenance_overlay"]["services"]),
                {cache.MAINTENANCE_SERVICE},
            )

    def test_validate_rejects_changed_maintenance_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            docker = DockerVolumeFixture(profile, roles=(cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE))
            receipt = _maintenance_receipt(profile)
            receipt["runtime_image_id"] = REFRESHED_IMAGE
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "image identity"):
                cache.validate(profile, docker.documents, receipt)

    def test_overlay_and_container_contract_reject_unsafe_isolation(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            overlay = cache.overlay(profile)
            self.assertEqual(set(overlay["services"]), {"backend"})
            self.assertEqual(
                overlay["services"]["backend"]["labels"],
                cache._container_labels(profile),
            )
            maintenance_overlay = cache.maintenance_overlay(profile)
            maintenance = maintenance_overlay["services"][cache.MAINTENANCE_SERVICE]
            self.assertEqual(maintenance["network_mode"], "none")
            self.assertEqual(maintenance["cap_drop"], ["ALL"])
            self.assertEqual(maintenance["cap_add"], ["CHOWN"])
            self.assertNotIn("gpus", maintenance)
            self.assertEqual(maintenance["volumes"], cache.mount_specs(profile))
            bad = json.loads(json.dumps(maintenance_overlay))
            bad["services"][cache.MAINTENANCE_SERVICE]["network_mode"] = "host"
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache.validate_maintenance_overlay(bad, profile)

            with self.assertRaises(cache.BackendVolumeCacheError):
                cache.validate_overlay(maintenance_overlay, profile)

            ready = dict(profile)
            ready["state"] = "ready"
            self.assertEqual(cache.validate_container(_container(ready), ready)["state"], "attested")
            unsafe = _container(ready)
            unsafe["HostConfig"]["ReadonlyRootfs"] = False
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "isolation changed"):
                cache.validate_container(unsafe, ready)
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "Docker socket"):
                cache.validate_container(_container(ready, socket=True), ready)

    def test_active_consumer_and_malformed_overlay_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            consumer = {
                "State": {"Running": True},
                "Config": {
                    "Labels": {
                        key: value
                        for key, value in cache.volume_labels(profile, cache.BUILD_VOLUME_ROLE).items()
                        if key != cache.LABEL_ROLE
                    }
                },
                "Mounts": [],
            }
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "active owned"):
                cache._assert_no_active_consumers(profile, [consumer])
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache.validate_overlay({"services": []}, profile)
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache.validate_overlay({"services": {"backend": {}, cache.MAINTENANCE_SERVICE: []}}, profile)

    def test_foreign_cache_and_shared_guest_targets_are_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            foreign = {
                cache.LABEL_PROFILE: "backend-build-cache-v1",
                cache.LABEL_CACHE_KEY: "f" * 64,
            }
            consumer = {
                "State": {"Running": True},
                "Config": {"Labels": foreign},
                "Mounts": [
                    {
                        "Type": "bind",
                        "Source": "/workspace/independent/build",
                        "Destination": cache.BUILD_TARGET,
                    },
                    {
                        "Type": "bind",
                        "Source": "/workspace/independent/package",
                        "Destination": cache.PACKAGE_TARGET,
                    },
                ],
            }
            foreign_v2 = cache._container_labels(profile)
            foreign_v2.update({
                cache.LABEL_SCHEMA: cache.SCHEMA,
                cache.LABEL_PROFILE: cache.PROFILE,
                cache.LABEL_CACHE_KEY: "e" * 64,
                cache.LABEL_UNIT: "foreign-unit",
                cache.LABEL_OWNER: "foreign-owner",
            })
            v2_consumer = {
                "State": {"Running": True},
                "Config": {"Labels": foreign_v2},
                "Mounts": list(consumer["Mounts"]),
            }
            cache._assert_no_active_consumers(profile, [consumer, v2_consumer])

            for source in (
                r"C:\\git\\fullmag\\storage\\other-cache",
                r"\\\\docker-desktop\\data\\other-cache",
            ):
                windows_consumer = {
                    "State": {"Running": True},
                    "Config": {"Labels": {}},
                    "Mounts": [
                        {
                            "Type": "bind",
                            "Source": source,
                            "Destination": cache.BUILD_TARGET,
                        }
                    ],
                }
                cache._assert_no_active_consumers(profile, [windows_consumer])

            posix_backslash = {
                "State": {"Running": True},
                "Config": {"Labels": {}},
                "Mounts": [{
                    "Type": "bind",
                    "Source": (
                        f"/var/lib/docker/volumes/"
                        f"{profile['volume_names'][cache.BUILD_VOLUME_ROLE]}/_data\\child"
                    ),
                    "Destination": cache.BUILD_TARGET,
                }],
            }
            with self.assertRaises(cache.BackendVolumeCacheError):
                inspected_profile = dict(profile)
                inspected_profile["volume_documents"] = DockerVolumeFixture(
                    profile,
                    roles=(cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE),
                ).documents
                cache._assert_no_active_consumers(inspected_profile, [posix_backslash])

            posix_double_slash = {
                "State": {"Running": True},
                "Config": {"Labels": {}},
                "Mounts": [{
                    "Type": "bind",
                    "Source": (
                        f"//var/lib/docker/volumes/"
                        f"{profile['volume_names'][cache.BUILD_VOLUME_ROLE]}/_data/child"
                    ),
                    "Destination": cache.BUILD_TARGET,
                }],
            }
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache._assert_no_active_consumers(inspected_profile, [posix_double_slash])

    def test_exact_owner_unit_and_cache_key_block_without_mounts(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            labels = cache._container_labels(profile)
            consumer = {
                "State": {"Running": True},
                "Config": {
                    "Labels": {
                        key: labels[key]
                        for key in (
                            cache.LABEL_OWNER,
                            cache.LABEL_UNIT,
                            cache.LABEL_CACHE_KEY,
                        )
                    }
                },
                "Mounts": [],
            }
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "active owned"):
                cache._assert_no_active_consumers(profile, [consumer])

    def test_selected_volume_blocks_under_any_guest_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            consumer = {
                "State": {"Running": True},
                "Config": {"Labels": {}},
                "Mounts": [
                    {
                        "Type": "volume",
                        "Name": profile["volume_names"][cache.BUILD_VOLUME_ROLE],
                        "Destination": "/independent/target",
                    }
                ],
            }
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "mounts backend cache volume"):
                cache._assert_no_active_consumers(profile, [consumer])

    def test_unknown_active_mount_type_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            consumer = {
                "State": {"Running": True},
                "Config": {"Labels": {}},
                "Mounts": [{"Type": "future-daemon-mount"}],
            }
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "unsupported"):
                cache._assert_no_active_consumers(profile, [consumer])

    def test_selected_volume_backing_alias_blocks_before_reusing_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            docker = DockerVolumeFixture(
                profile,
                roles=(cache.BUILD_VOLUME_ROLE, cache.PACKAGE_VOLUME_ROLE),
            )
            mountpoint = docker.documents[cache.BUILD_VOLUME_ROLE]["Mountpoint"]
            for source in (
                mountpoint,
                mountpoint + "/nested",
                mountpoint.rsplit("/", 1)[0],
            ):
                consumer = {
                    "State": {"Running": True},
                    "Config": {"Labels": {}},
                    "Mounts": [
                        {
                            "Type": "bind",
                            "Source": source,
                            "Destination": "/unrelated",
                        }
                    ],
                }
                with self.assertRaisesRegex(cache.BackendVolumeCacheError, "aliases backend cache volume"):
                    cache.ensure_volume_pair(
                        docker,
                        profile,
                        active_consumers=[consumer],
                    )

            unrelated = {
                "State": {"Running": True},
                "Config": {"Labels": {}},
                "Mounts": [
                    {
                        "Type": "bind",
                        "Source": "/var/lib/docker/volumes/other/_data",
                        "Destination": "/unrelated",
                    }
                ],
            }
            cache.ensure_volume_pair(
                docker,
                profile,
                active_consumers=[unrelated],
            )

            fresh = DockerVolumeFixture(profile)
            future_mountpoint = (
                f"/var/lib/docker/volumes/"
                f"{profile['volume_names'][cache.BUILD_VOLUME_ROLE]}/_data/alias"
            )
            alias_before_create = {
                "State": {"Running": True},
                "Config": {"Labels": {}},
                "Mounts": [{
                    "Type": "bind",
                    "Source": future_mountpoint,
                    "Destination": "/unrelated",
                }],
            }
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "aliases backend cache volume"):
                cache.ensure_volume_pair(
                    fresh,
                    profile,
                    active_consumers=[alias_before_create],
                )

            foreign_name_source_alias = {
                "State": {"Running": True},
                "Config": {"Labels": {}},
                "Mounts": [{
                    "Type": "volume",
                    "Name": "independent-volume",
                    "Source": mountpoint,
                    "Destination": "/unrelated",
                }],
            }
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "aliases backend cache volume"):
                cache.ensure_volume_pair(
                    docker,
                    profile,
                    active_consumers=[foreign_name_source_alias],
                )

    def test_active_consumer_provider_refreshes_before_maintenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, layout, source, repo, runroot = _profile(tmp)
            docker = DockerVolumeFixture(profile)
            snapshots = [
                (),
                ({
                    "State": {"Running": True},
                    "Config": {"Labels": {}},
                    "Mounts": [{
                        "Type": "volume",
                        "Name": profile["volume_names"][cache.BUILD_VOLUME_ROLE],
                        "Destination": "/unrelated",
                    }],
                },),
            ]
            calls = []

            def inventory():
                calls.append(True)
                return snapshots.pop(0)

            maintenance_calls = []

            def maintenance(prepared, maintenance_overlay):
                maintenance_calls.append(True)
                return _maintenance_receipt(prepared)

            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "mounts backend cache volume"):
                cache.prepare_ready(
                    layout,
                    repo,
                    IMAGE,
                    runroot,
                    docker,
                    maintenance,
                    source_root=source,
                    toolchain_image=TOOLCHAIN,
                    active_consumers=inventory,
                )
            self.assertEqual(len(calls), 2)
            self.assertEqual(maintenance_calls, [])

    def test_windows_mount_and_symlink_receipt_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            document = DockerVolumeFixture(profile)._document(cache.BUILD_VOLUME_ROLE)
            document["Mountpoint"] = "/run/desktop/mnt/host/c/fullmag"
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "Windows host bind"):
                cache._validate_volume_document(document, profile, cache.BUILD_VOLUME_ROLE)
            link = Path(tmp) / "storage" / "runs" / "link"
            link.symlink_to(Path(tmp) / "storage" / "runs" / "run-1", target_is_directory=True)
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache._receipt_path({"storage_root": Path(tmp) / "storage"}, link)


if __name__ == "__main__":
    unittest.main(verbosity=2)
