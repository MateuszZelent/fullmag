"""Offline shared-cache namespace proofs using the real cache validators."""
import copy
import hashlib
import json
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_backend_volume_cache as cache
import docker_shared_build_storage as shared
import docker_offline_shared_consumers as module
from docker_build_control import BuildControlError, canonical
from test_docker_backend_volume_cache import _profile, _container, DockerVolumeFixture


class SharedConsumerTests(unittest.TestCase):
    def setUp(self):
        self.roots = [tempfile.TemporaryDirectory(), tempfile.TemporaryDirectory()]
        for root in self.roots: self.addCleanup(root.cleanup)
        self.profile = _profile(self.roots[0].name, shared_packages=True, worktree_id="current")[0]
        self.other = _profile(self.roots[1].name, shared_packages=True, worktree_id="other")[0]
        for profile in (self.profile, self.other):
            profile.update(state="ready", volume_documents=DockerVolumeFixture(profile, roles=cache.VOLUME_ROLES).documents)
        self.attempt = "1" * 32
        self.development = {"attempt": self.attempt, "backend_volumes": self.profile["volume_names"]}
        names = shared.shared_volume_names(self.profile["project_id"])
        self.document = {"volumes": {role: {"name": name, "external": True} for role, name in names.items()}}
        self.documents = {doc["Name"]: copy.deepcopy(doc) for doc in self.profile["volume_documents"].values()}
        for role, name in names.items():
            if name not in self.documents:
                self.documents[name] = {"Name": name, "Driver": "local", "Options": {}, "Scope": "local",
                    "Mountpoint": "/var/lib/docker/volumes/" + name + "/_data",
                    "Labels": shared.shared_volume_labels(self.profile["project_id"], role)}
        self.calls = []

    def qualify(self):
        raw = canonical(self.profile)
        relative = f"development/attempts/{self.attempt}/backend-cache.json"
        def read(path, **_kwargs):
            self.assertEqual(path, relative)
            return raw
        def docker(*args):
            self.calls.append(args)
            self.assertEqual(args[:2], ("volume", "inspect"))
            return SimpleNamespace(stdout=json.dumps([self.documents[args[2]]]).encode())
        control = SimpleNamespace(project=self.profile["control_project"], read_raw=read)
        with patch.object(module, "docker_capture", side_effect=docker):
            return module.qualify(control, self.development, self.document, _container(self.profile))

    def foreign(self, running=False):
        row = _container(self.other)
        row["Config"]["Labels"].update({"com.docker.compose.service": "backend",
                                       "com.docker.compose.project": self.other["control_project"]})
        row["State"] = {"Running": running, "Status": "running" if running else "exited", "Pid": 123 if running else 0}
        return row

    def test_live_and_stopped_foreign_units_are_qualified_without_state_mutation(self):
        evidence, names, validate = self.qualify()
        self.assertEqual(evidence["profile_sha256"], hashlib.sha256(canonical(self.profile)).hexdigest())
        self.assertEqual(names, set(shared.shared_volume_names(self.profile["project_id"]).values()))
        for running in (False, True):
            row = self.foreign(running); before = copy.deepcopy(row)
            validate(row)
            self.assertEqual(row, before)
        validate({"Mounts": []})

    def test_other_compose_project_cannot_alias_our_package_unit(self):
        validate = self.qualify()[2]
        row = _container(self.profile)
        row["Config"]["Labels"].update({"com.docker.compose.service": "backend", "com.docker.compose.project": "foreign"})
        with self.assertRaisesRegex(BuildControlError, "this backend cache package subpath"):
            validate(row)

    def test_unregistered_root_missing_mount_and_wrong_type_are_refused(self):
        validate = self.qualify()[2]
        for mutate in (
            lambda r: r["Config"]["Labels"].pop(cache.LABEL_OWNER),
            lambda r: r["Mounts"].pop(2),
            lambda r: r["Mounts"][1].update(Type="bind"),
            lambda r: r["Config"]["Labels"].update({"com.docker.compose.service": "frontend"}),
        ):
            row = self.foreign(); mutate(row)
            with self.assertRaises(BuildControlError): validate(row)

    def test_bind_or_named_volume_alias_to_package_root_is_refused(self):
        validate = self.qualify()[2]
        root = self.profile["volume_documents"][cache.PACKAGE_VOLUME_ROLE]["Mountpoint"]
        for mount in ({"Type": "bind", "Source": root + "/groups"},
                      {"Type": "volume", "Name": "foreign", "Source": root}):
            with self.assertRaisesRegex(BuildControlError, "aliases"):
                validate({"Mounts": [mount]})

    def test_changed_profile_or_volume_evidence_cannot_be_exempted(self):
        saved = copy.deepcopy(self.profile)
        for key, value in (("state", "starting"), ("shared_packages", False), ("control_project", "foreign")):
            self.profile[key] = value
            with self.assertRaises(BuildControlError): self.qualify()
            self.profile = copy.deepcopy(saved)
        package = self.profile["volume_names"][cache.PACKAGE_VOLUME_ROLE]
        self.documents[package]["Labels"][shared.LABEL_PROJECT] = "foreign"
        with self.assertRaises(BuildControlError): self.qualify()

    def test_dependency_volume_labels_and_external_descriptor_are_checked(self):
        cargo = shared.shared_volume_names(self.profile["project_id"])[shared.CARGO_ROLE]
        self.documents[cargo]["Labels"][shared.LABEL_ROLE] = "wrong"
        with self.assertRaises(BuildControlError): self.qualify()
        self.documents[cargo]["Labels"][shared.LABEL_ROLE] = shared.CARGO_ROLE
        self.document["volumes"][shared.CARGO_ROLE]["external"] = False
        with self.assertRaises(BuildControlError): self.qualify()

    def test_unknown_shared_names_remain_protected(self):
        unknown = "fullmag-shared-packages-v1-foreign"
        self.document["volumes"]["foreign"] = {"name": unknown, "external": True}
        self.assertNotIn(unknown, self.qualify()[1])


if __name__ == "__main__":
    unittest.main()
