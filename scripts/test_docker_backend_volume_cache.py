from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import docker_backend_volume_cache as cache  # noqa: E402
import docker_shared_build_storage as shared_storage  # noqa: E402

IMAGE = "sha256:" + "a" * 64
REFRESHED_IMAGE = "sha256:" + "c" * 64
TOOLCHAIN = "sha256:" + "b" * 64


class DockerVolumeFixture:
    def __init__(self, profile, *, roles=(cache.CONTROL_VOLUME_ROLE,)):
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
            if role == cache.CONTROL_VOLUME_ROLE:
                raise AssertionError("bootstrap-owned control volume must not be created by cache adapter")
            self.documents[role] = self._document(role)
            return name
        raise AssertionError(f"unexpected Docker call: {args!r}")


def _profile(
    tmp: str,
    image: str = IMAGE,
    *,
    shared_packages: bool = False,
    worktree_id: str = "docker-all-master-integration-20261017",
    project_id: str = "fullmag",
):
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
        "project_id": project_id,
        "worktree_id": worktree_id,
        "compose_project": f"fullmag-worktree-{worktree_id}",
    }
    profile = cache.prepare(
        layout,
        repo,
        image,
        runroot,
        source_root=source,
        toolchain_image=TOOLCHAIN,
        control_volume_name=f"fullmag-build-control-fullmag-worktree-{worktree_id}",
        shared_packages=shared_packages,
    )
    return profile, layout, source, repo, runroot


def _maintenance_receipt(profile):
    markers = {}
    probes = {}
    for role in cache.VOLUME_ROLES:
        markers[role] = (
            {
                "schema": "fullmag.docker-toolchain-control-owner.v1",
                "state": "owned",
                "role": role,
                "volume_name": profile["volume_names"][role],
                "mount": cache.CONTROL_TARGET,
                "namespace": cache.CONTROL_BACKEND_TARGET,
            }
            if role == cache.CONTROL_VOLUME_ROLE
            else {
                "schema": cache.OWNER_SCHEMA,
                "state": "owned",
                "unit_key": profile["unit_key"],
                "owner_id": profile["owner_id"],
                "role": role,
                "volume_name": profile["volume_names"][role],
                "uid": 65532,
                "gid": 65532,
            }
        )
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
    volume_docs = profile.get("volume_documents", {})

    def volume_mount(role, target, subpath=""):
        name = profile["volume_names"][role]
        document = volume_docs.get(role, {}) if isinstance(volume_docs, dict) else {}
        root = document.get("Mountpoint", f"/var/lib/docker/volumes/{name}/_data")
        source = f"{root}/{subpath}" if subpath else root
        mount = {
            "Type": "volume",
            "Name": name,
            "Source": source,
            "Destination": target,
            "RW": True,
        }
        host_mount = {"Type": "volume", "Source": name, "Target": target}
        if subpath:
            host_mount["VolumeOptions"] = {"Subpath": subpath}
        return mount, host_mount

    mounts = []
    host_mounts = []
    for role, target in (
        (cache.BUILD_VOLUME_ROLE, cache.BUILD_TARGET),
        (cache.PACKAGE_VOLUME_ROLE, cache.PACKAGE_TARGET),
        (cache.CONTROL_VOLUME_ROLE, cache.CONTROL_TARGET),
    ):
        if role == cache.PACKAGE_VOLUME_ROLE:
            subpath = profile.get("shared_package_subpath", "")
        elif role == cache.CONTROL_VOLUME_ROLE:
            subpath = profile.get("control_namespace", "")
        else:
            subpath = ""
        mount, host_mount = volume_mount(role, target, subpath or "")
        mounts.append(mount)
        host_mounts.append(host_mount)
    if profile.get("shared_packages") is True:
        mount, host_mount = volume_mount(
            cache.PACKAGE_VOLUME_ROLE, cache.SHARED_BACKEND_TARGET
        )
        mounts.insert(2, mount)
        host_mounts.insert(2, host_mount)
    if socket:
        mounts.append({
            "Type": "bind",
            "Source": "/var/run/docker.sock",
            "Destination": "/var/run/docker.sock",
            "RW": True,
        })
    labels = cache._container_labels(profile)
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
            "Mounts": host_mounts,
        },
        "Mounts": mounts,
    }


class BackendVolumeCacheTests(unittest.TestCase):
    def test_shared_packages_reuse_project_volume_with_private_groups_and_builds(self):
        with tempfile.TemporaryDirectory() as tmp_a, tempfile.TemporaryDirectory() as tmp_b, tempfile.TemporaryDirectory() as tmp_other:
            first, *_ = _profile(
                tmp_a, shared_packages=True, worktree_id="worktree-alpha"
            )
            second, *_ = _profile(
                tmp_b, shared_packages=True, worktree_id="worktree-beta"
            )
            different_project, *_ = _profile(
                tmp_other, shared_packages=True, worktree_id="worktree-gamma",
                project_id="another-project",
            )
            self.assertNotEqual(first["unit_key"], second["unit_key"])
            self.assertNotEqual(
                first["volume_names"][cache.BUILD_VOLUME_ROLE],
                second["volume_names"][cache.BUILD_VOLUME_ROLE],
            )
            shared_name = first["volume_names"][cache.PACKAGE_VOLUME_ROLE]
            self.assertEqual(shared_name, second["volume_names"][cache.PACKAGE_VOLUME_ROLE])
            self.assertEqual(
                shared_name,
                "fullmag-shared-packages-v1-"
                + hashlib.sha256(b"fullmag").hexdigest()[:24],
            )
            self.assertNotEqual(
                shared_name,
                different_project["volume_names"][cache.PACKAGE_VOLUME_ROLE],
            )
            self.assertEqual(first["shared_package_subpath"], f"groups/{first['unit_key']}")
            self.assertEqual(second["shared_package_subpath"], f"groups/{second['unit_key']}")
            self.assertEqual(
                cache.volume_labels(first, cache.PACKAGE_VOLUME_ROLE),
                shared_storage.shared_volume_labels("fullmag", shared_storage.PACKAGE_ROLE),
            )
            self.assertNotIn(cache.LABEL_UNIT, cache.volume_labels(first, cache.PACKAGE_VOLUME_ROLE))
            self.assertEqual(
                first["environment"]["FULLMAG_SHARED_BACKEND_GROUP"],
                f"groups/{first['unit_key']}",
            )
            self.assertEqual(
                first["environment"]["FULLMAG_SHARED_BACKEND_STORE"],
                cache.SHARED_BACKEND_TARGET,
            )
            self.assertEqual(
                first["mounts"][1]["volume"]["subpath"], first["shared_package_subpath"]
            )
            root_mount = next(
                mount for mount in first["mounts"]
                if mount["target"] == cache.SHARED_BACKEND_TARGET
            )
            self.assertNotIn("subpath", root_mount["volume"])

    def test_shared_package_volume_requires_exact_labels_and_safe_backing(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp, shared_packages=True)
            fixture = DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES)
            package = fixture.documents[cache.PACKAGE_VOLUME_ROLE]
            cache._validate_volume_document(package, profile, cache.PACKAGE_VOLUME_ROLE)
            for mutate in (
                lambda doc: doc.update(Driver="nfs"),
                lambda doc: doc.update(Options={"device": "/host/path"}),
                lambda doc: doc["Labels"].update({cache.LABEL_UNIT: profile["unit_key"]}),
                lambda doc: doc["Labels"].update({shared_storage.LABEL_PROJECT: "foreign"}),
            ):
                corrupted = json.loads(json.dumps(package))
                mutate(corrupted)
                with self.subTest(corrupted=corrupted), self.assertRaises(cache.BackendVolumeCacheError):
                    cache._validate_volume_document(
                        corrupted, profile, cache.PACKAGE_VOLUME_ROLE
                    )

    def test_active_shared_package_consumers_require_registered_exact_group_subpath(self):
        with tempfile.TemporaryDirectory() as tmp_a, tempfile.TemporaryDirectory() as tmp_b:
            current, *_ = _profile(
                tmp_a, shared_packages=True, worktree_id="worktree-current"
            )
            other, *_ = _profile(
                tmp_b, shared_packages=True, worktree_id="worktree-other"
            )
            current["volume_documents"] = DockerVolumeFixture(
                current, roles=cache.VOLUME_ROLES
            ).documents
            other["volume_documents"] = DockerVolumeFixture(
                other, roles=cache.VOLUME_ROLES
            ).documents

            def running(profile):
                result = _container(profile)
                result["State"] = {"Running": True}
                return result

            def maintenance(profile):
                result = running(profile)
                result["Config"]["User"] = "0:0"
                result["Config"]["Entrypoint"] = list(cache.MAINTENANCE_ENTRYPOINT)
                result["Config"]["Cmd"] = ["ensure"]
                result["Config"]["Labels"].update({
                    "com.docker.compose.project": profile["control_project"],
                    "com.docker.compose.service": cache.MAINTENANCE_SERVICE,
                })
                result["Config"]["Env"].extend([
                    "FULLMAG_BACKEND_CACHE_MAINTENANCE_PROFILE=" + cache.MAINTENANCE_PROFILE,
                    "FULLMAG_BACKEND_CACHE_MAINTENANCE_ACTION=ensure",
                ])
                result["Mounts"] = [
                    mount for mount in result["Mounts"]
                    if mount.get("Destination") != cache.SHARED_BACKEND_TARGET
                ]
                result["HostConfig"]["Mounts"] = [
                    mount for mount in result["HostConfig"]["Mounts"]
                    if mount.get("Target") != cache.SHARED_BACKEND_TARGET
                ]
                return result

            cache._assert_no_active_consumers(current, [running(other)])
            cache._assert_no_active_consumers(current, [maintenance(other)])

            spoofed_maintenance = maintenance(other)
            spoofed_maintenance["Config"]["Cmd"] = ["sh", "-c", "true"]
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "incomplete or ambiguous"):
                cache._assert_no_active_consumers(current, [spoofed_maintenance])

            source_path_proof = running(other)
            source_path_proof["HostConfig"].pop("Mounts")
            cache._assert_no_active_consumers(current, [source_path_proof])

            host_config_proof = running(other)
            for mount in host_config_proof["Mounts"]:
                if (mount.get("Name") == current["volume_names"][cache.PACKAGE_VOLUME_ROLE]
                        and mount.get("Destination") == cache.SHARED_BACKEND_TARGET):
                    mount.pop("Source", None)
            cache._assert_no_active_consumers(current, [host_config_proof])

            ambiguous_root = running(other)
            root_entry = next(
                mount for mount in ambiguous_root["HostConfig"]["Mounts"]
                if mount.get("Target") == cache.SHARED_BACKEND_TARGET
            )
            ambiguous_root["HostConfig"]["Mounts"].append(dict(root_entry))
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "ambiguous"):
                cache._assert_no_active_consumers(current, [ambiguous_root])

            own_group = running(current)
            other_build_root = (
                f"/var/lib/docker/volumes/"
                f"{other['volume_names'][cache.BUILD_VOLUME_ROLE]}/_data"
            )
            for mount in own_group["Mounts"]:
                if mount.get("Destination") == cache.BUILD_TARGET:
                    mount["Name"] = other["volume_names"][cache.BUILD_VOLUME_ROLE]
                    mount["Source"] = other_build_root
            own_group["Config"]["Labels"][cache.LABEL_CACHE_KEY] = "c" * 64
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "this backend cache package subpath"):
                cache._assert_no_active_consumers(current, [own_group])

            own_maintenance = maintenance(current)
            own_maintenance["Mounts"] = [
                mount for mount in own_maintenance["Mounts"]
                if mount.get("Destination") == cache.PACKAGE_TARGET
                or mount.get("Destination") == cache.CONTROL_TARGET
                or mount.get("Destination") == cache.BUILD_TARGET
            ]
            for mount in own_maintenance["Mounts"]:
                if mount.get("Destination") == cache.BUILD_TARGET:
                    mount["Name"] = other["volume_names"][cache.BUILD_VOLUME_ROLE]
                    mount["Source"] = other_build_root
            own_maintenance["Config"]["Labels"][cache.LABEL_CACHE_KEY] = "c" * 64
            own_maintenance["Config"]["Env"] = [
                "FULLMAG_BACKEND_CACHE_KEY=" + "c" * 64
                if value.startswith("FULLMAG_BACKEND_CACHE_KEY=") else value
                for value in own_maintenance["Config"]["Env"]
            ]
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "this backend cache package subpath"):
                cache._assert_no_active_consumers(current, [own_maintenance])

            unknown_group = running(other)
            shared_name = current["volume_names"][cache.PACKAGE_VOLUME_ROLE]
            root = current["volume_documents"][cache.PACKAGE_VOLUME_ROLE]["Mountpoint"]
            for mount in unknown_group["Mounts"]:
                if mount.get("Name") == shared_name and mount.get("Destination") == cache.PACKAGE_TARGET:
                    mount["Source"] = root + "/groups/" + "f" * 64
            for mount in unknown_group["HostConfig"]["Mounts"]:
                if mount.get("Source") == shared_name and mount.get("Target") == cache.PACKAGE_TARGET:
                    mount["VolumeOptions"] = {"Subpath": "groups/" + "f" * 64}
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "unknown or unregistered"):
                cache._assert_no_active_consumers(current, [unknown_group])

            unproven_group = running(other)
            for mount in unproven_group["Mounts"]:
                if mount.get("Name") == shared_name and mount.get("Destination") == cache.PACKAGE_TARGET:
                    mount["Source"] = root
            for mount in unproven_group["HostConfig"]["Mounts"]:
                if mount.get("Source") == shared_name and mount.get("Target") == cache.PACKAGE_TARGET:
                    mount.pop("VolumeOptions", None)
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "unknown or unregistered"):
                cache._assert_no_active_consumers(current, [unproven_group])

            private_build_alias = running(other)
            for mount in private_build_alias["Mounts"]:
                if mount.get("Destination") == cache.BUILD_TARGET:
                    mount["Name"] = current["volume_names"][cache.BUILD_VOLUME_ROLE]
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "mounts backend cache volume"):
                cache._assert_no_active_consumers(current, [private_build_alias])

    def test_active_initializer_root_mount_is_registered_and_other_groups_are_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp, shared_packages=True)
            profile["volume_documents"] = DockerVolumeFixture(
                profile, roles=cache.VOLUME_ROLES
            ).documents
            other_unit = "e" * 64
            package_name = profile["volume_names"][cache.PACKAGE_VOLUME_ROLE]
            package_root = profile["volume_documents"][cache.PACKAGE_VOLUME_ROLE]["Mountpoint"]
            helper = {
                "State": {"Running": True},
                "Config": {
                    "Labels": shared_storage.initializer_labels(
                        profile["project_id"], other_unit
                    ),
                    "Env": [
                        f"{key}={value}"
                        for key, value in shared_storage.initializer_environment(other_unit).items()
                    ],
                },
                "Mounts": [{
                    "Type": "volume",
                    "Name": package_name,
                    "Source": package_root,
                    "Destination": cache.SHARED_BACKEND_TARGET,
                }],
            }
            cache._assert_no_active_consumers(profile, [helper])

    def test_shared_runtime_validates_package_subpath_and_root_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp, shared_packages=True)
            ready = dict(profile)
            ready["state"] = "ready"
            ready["volume_documents"] = DockerVolumeFixture(
                profile, roles=cache.VOLUME_ROLES
            ).documents
            maintenance = cache.maintenance_overlay(ready)["services"][cache.MAINTENANCE_SERVICE]
            self.assertNotIn(
                cache.SHARED_BACKEND_TARGET,
                {mount["target"] for mount in maintenance["volumes"]},
            )
            self.assertIn(
                cache.SHARED_BACKEND_TARGET,
                {mount["target"] for mount in ready["mounts"]},
            )
            container = _container(ready)
            attestation = cache.validate_container(container, ready)
            self.assertEqual(attestation["state"], "attested")
            self.assertEqual(
                attestation["targets"]["shared_backend"], cache.SHARED_BACKEND_TARGET
            )

            wrong_subpath = json.loads(json.dumps(container))
            for mount in wrong_subpath["HostConfig"]["Mounts"]:
                if mount["Target"] == cache.PACKAGE_TARGET:
                    mount["VolumeOptions"] = {"Subpath": "groups/" + "f" * 64}
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache.validate_container(wrong_subpath, ready)

            wrong_root_alias = json.loads(json.dumps(container))
            for mount in wrong_root_alias["HostConfig"]["Mounts"]:
                if mount["Target"] == cache.SHARED_BACKEND_TARGET:
                    mount["VolumeOptions"] = {"Subpath": "artifacts"}
            with self.assertRaises(cache.BackendVolumeCacheError):
                cache.validate_container(wrong_root_alias, ready)

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
                control_volume_name=first["volume_names"][cache.CONTROL_VOLUME_ROLE],
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
                {"storage_root": Path(tmp) / "storage", "project_id": "fullmag", "worktree_id": profile["worktree_id"], "compose_project": profile["control_project"]},
                Path(tmp) / "repo",
                IMAGE,
                Path(tmp) / "storage" / "runs" / "run-1",
                docker,
                source_root=Path(tmp) / "source",
                toolchain_image=TOOLCHAIN,
                control_volume_name=profile["volume_names"][cache.CONTROL_VOLUME_ROLE],
            )
            self.assertEqual(set(prepared["volume_documents"]), set(cache.VOLUME_ROLES))
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
                    cache.COMPOSE_CONTROL_VOLUME,
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
                control_volume_name=profile["volume_names"][cache.CONTROL_VOLUME_ROLE],
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
                control_volume_name=profile["volume_names"][cache.CONTROL_VOLUME_ROLE],
            )

            self.assertEqual(ready["build_root"], cache.BUILD_TARGET)

    def test_missing_unit_volume_is_added_without_touching_shared_control(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            docker = DockerVolumeFixture(profile, roles=(cache.BUILD_VOLUME_ROLE, cache.CONTROL_VOLUME_ROLE))
            documents = cache.ensure_volume_pair(docker, profile)
            self.assertEqual(set(documents), set(cache.VOLUME_ROLES))
            creates = [call[0] for call in docker.calls if call[0][:2] == ("volume", "create")]
            self.assertEqual(len(creates), 1)
            self.assertEqual(creates[0][-1], profile["volume_names"][cache.PACKAGE_VOLUME_ROLE])

            docker = DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES)
            docker.documents[cache.PACKAGE_VOLUME_ROLE]["Labels"][cache.LABEL_OWNER] = "foreign"
            with self.assertRaisesRegex(cache.BackendVolumeCacheError, "label mismatch"):
                cache.inspect_volume_pair(docker, profile)
            self.assertFalse(any(call[0][:2] == ("volume", "rm") for call in docker.calls))

    def test_validate_returns_control_volume_receipt_without_host_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, _, _, _, runroot = _profile(tmp)
            docker = DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES)
            result = cache.validate(
                profile,
                docker.documents,
                _maintenance_receipt(profile),
            )
            receipt_path = Path(result["receipt_path"])
            self.assertEqual(receipt_path, Path(cache.RECEIPT_TARGET))
            # The canonical guest path may already exist in the running backend.
            self.assertFalse((runroot / cache.RECEIPT_NAME).exists())
            self.assertEqual(result["receipt_storage"], "docker-named-volume")
            self.assertIsNone(result["host_receipt_path"])
            stored = result["receipt"]
            self.assertEqual(stored["package_root"], cache.PACKAGE_TARGET)
            self.assertEqual(stored["build_root"], cache.BUILD_TARGET)
            self.assertEqual(stored["control_root"], cache.CONTROL_TARGET)
            self.assertEqual(stored["receipt_path"], cache.RECEIPT_TARGET)
            self.assertEqual(stored["receipt_storage"], "docker-named-volume")
            self.assertIsNone(stored["host_receipt_path"])
            self.assertNotIn("/mnt/fullmag", json.dumps(stored))
            self.assertEqual(set(result["overlay"]["services"]), {"backend"})
            self.assertEqual(
                set(result["maintenance_overlay"]["services"]),
                {cache.MAINTENANCE_SERVICE},
            )

    def test_validate_rejects_changed_maintenance_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            docker = DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES)
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
            self.assertEqual(maintenance["cap_add"], ["CHOWN", "DAC_OVERRIDE"])
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
            ready["volume_documents"] = DockerVolumeFixture(
                profile, roles=cache.VOLUME_ROLES
            ).documents
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
                    roles=cache.VOLUME_ROLES,
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
                roles=cache.VOLUME_ROLES,
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
                    control_volume_name=profile["volume_names"][cache.CONTROL_VOLUME_ROLE],
                    active_consumers=inventory,
                )
            self.assertEqual(len(calls), 2)
            self.assertEqual(maintenance_calls, [])

    def test_windows_mount_is_rejected_and_receipt_stays_in_control_volume(self):
        with tempfile.TemporaryDirectory() as tmp:
            profile, *_ = _profile(tmp)
            document = DockerVolumeFixture(profile)._document(cache.BUILD_VOLUME_ROLE)
            for mountpoint in ("/run/desktop/mnt/host/c/fullmag", "/mnt/e/fullmag",
                               "/mnt/z/fullmag", "/host_mnt/e/fullmag"):
                document["Mountpoint"] = mountpoint
                with self.subTest(mountpoint=mountpoint), self.assertRaisesRegex(
                        cache.BackendVolumeCacheError, "Windows host bind"):
                    cache._validate_volume_document(document, profile, cache.BUILD_VOLUME_ROLE)
            document["Mountpoint"] = "/mnt/docker-data/volumes/cache/_data"
            cache._validate_volume_document(document, profile, cache.BUILD_VOLUME_ROLE)
            profile_without_runroot = cache.prepare(
                {"project_id": "fullmag", "worktree_id": profile["worktree_id"], "compose_project": profile["control_project"]},
                Path(tmp) / "repo",
                IMAGE,
                Path(tmp) / "missing-runroot",
                source_root=Path(tmp) / "source",
                toolchain_image=TOOLCHAIN,
                control_volume_name=profile["volume_names"][cache.CONTROL_VOLUME_ROLE],
            )
            self.assertEqual(profile_without_runroot["receipt_path"], cache.RECEIPT_TARGET)
            self.assertIsNone(profile_without_runroot["host_receipt_path"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
