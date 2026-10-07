"""Regressions for preserving the deployed bounded UI exemption during CPU rollout."""
import copy
import unittest
from local_runner import build_executor as executor


def browser():
    project = "fullmag-browser-" + "a" * 32
    image = "sha256:" + "b" * 64
    return {
        "Name": "/" + project + "-browser-1", "Image": image,
        "Config": {
            "Image": image, "User": "65532:65532", "Entrypoint": [],
            "WorkingDir": "/source",
            "Cmd": ["bash", "-c", "set -eu; mkdir -p /tmp/fullmag-state; exec /package/bin/fullmag-api"],
            "Labels": {
                "com.docker.compose.project": project,
                "com.docker.compose.service": "browser",
                "com.docker.compose.container-number": "1",
                "com.docker.compose.oneoff": "False",
                "com.docker.compose.config-hash": "c" * 64,
                "com.docker.compose.project.config_files": "/storage/browser/compose.yaml",
                "com.docker.compose.project.working_dir": "/storage/browser",
            },
        },
        "HostConfig": {
            "ReadonlyRootfs": True, "Privileged": False, "NetworkMode": "bridge",
            "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
            "NanoCpus": 2 * 10**9, "Memory": 1024**3, "PidsLimit": 128,
            "DeviceRequests": [], "Devices": [], "DeviceCgroupRules": [],
        },
        "Mounts": [{"Type": "bind", "Source": "/storage/package", "Destination": "/package", "RW": False}],
    }


class ManagedBrowserGuardTests(unittest.TestCase):
    def test_bounded_browser_can_coexist_with_build(self):
        self.assertTrue(executor.is_attested_managed_browser_container(browser()))
        self.assertFalse(executor.is_blocking_fullmag_container(browser()))

    def test_supported_private_state_launcher_remains_allowed(self):
        item = browser()
        item["Config"]["Cmd"][-1] = "set -eu; [ ! -L /state/workspace ] || exit 2; mkdir -p /state/workspace; exec /package/bin/fullmag-api"
        self.assertFalse(executor.is_blocking_fullmag_container(item))

    def test_name_without_identity_is_not_an_exemption(self):
        item = browser()
        item["Config"]["Labels"] = {}
        self.assertTrue(executor.is_blocking_fullmag_container(item))
        item = browser()
        item["Config"]["Labels"]["com.docker.compose.project"] = "another-project"
        self.assertTrue(executor.is_blocking_fullmag_container(item))

    def test_unsafe_permissions_and_unbounded_resources_block(self):
        mutations = {
            "Privileged": True, "ReadonlyRootfs": False, "NetworkMode": "host",
            "CapDrop": [], "SecurityOpt": [], "NanoCpus": 0, "Memory": 0,
            "PidsLimit": -1, "DeviceRequests": [{"Capabilities": [["gpu"]]}],
        }
        for key, value in mutations.items():
            with self.subTest(key=key):
                item = browser()
                item["HostConfig"][key] = value
                self.assertTrue(executor.is_blocking_fullmag_container(item))
        for key, value in (("NanoCpus", True), ("Memory", True), ("PidsLimit", True),
                           ("NanoCpus", 5 * 10**9), ("Memory", 3 * 1024**3), ("PidsLimit", 129)):
            with self.subTest(key=key, value=value):
                item = browser()
                item["HostConfig"][key] = value
                self.assertTrue(executor.is_blocking_fullmag_container(item))

    def test_socket_device_and_unknown_mounts_block(self):
        for mount in ({"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/socket"},
                      {"Type": "bind", "Source": "/dev/nvidia0", "Destination": "/gpu"},
                      {"Type": "device", "Source": "/x", "Destination": "/y"}, {}):
            with self.subTest(mount=mount):
                item = browser()
                item["Mounts"] = [mount]
                self.assertTrue(executor.is_blocking_fullmag_container(item))

    def test_compute_command_and_mutable_image_block(self):
        for script in ("cargo build", "set -eu; mkdir -p /state/workspace; cargo build; exec /package/bin/fullmag-api"):
            item = browser()
            item["Config"]["Cmd"][-1] = script
            self.assertTrue(executor.is_blocking_fullmag_container(item))
        item = browser()
        item["Config"]["Image"] = "fullmag:latest"
        self.assertTrue(executor.is_blocking_fullmag_container(item))

    def test_runner_buildkit_unrelated_and_unknown_compute_keep_existing_rules(self):
        for name in ("/Fullmag_build_runner", "/buildx_buildkit_fullmag-windows0", "/other-service"):
            self.assertFalse(executor.is_blocking_fullmag_container({"Name": name}))
        for item in ({"Name": "/fullmag-worker-123"}, {}, None):
            self.assertTrue(executor.is_blocking_fullmag_container(item))


if __name__ == "__main__":
    unittest.main()
