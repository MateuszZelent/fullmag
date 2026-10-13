"""Regressions for the bounded managed-browser exemption in the build guard."""
import copy
from pathlib import Path
import tempfile
import unittest

from local_runner import build_executor as executor
from run_managed_browser import compose_spec


def browser():
    project_id = "a" * 32
    worktree_id = "eigensolve-" + "b" * 16
    capture_id = "c" * 32
    build_job_id = "d" * 32
    root = Path(tempfile.gettempdir()).resolve() / "fullmag-browser-guard"
    storage_root = root / "storage"
    build_storage_root = root / "build-storage"
    source = storage_root / "runs" / worktree_id / capture_id / "source" / "tree"
    package = (storage_root / "runs" / worktree_id / build_job_id / "artifacts"
               / "outputs" / ".fullmag" / "local")
    run_root = (build_storage_root / "builds" / worktree_id / "managed-browser-cpu"
                / "runs" / project_id)
    image = "sha256:" + "e" * 64
    compose_command = compose_spec(image, source, package, run_root / "state", 3104)[
        "services"]["browser"]["command"]
    inspect_command = [compose_command[0], compose_command[1], compose_command[2].replace("$$", "$")]
    system_sources = {
        "HostsPath": "/var/lib/docker/containers/browser/hosts",
        "HostnamePath": "/var/lib/docker/containers/browser/hostname",
        "ResolvConfPath": "/var/lib/docker/containers/browser/resolv.conf",
    }
    mounts = [
        {"Type": "bind", "Source": str(source), "Destination": "/source",
         "RW": False, "Propagation": "rprivate"},
        {"Type": "bind", "Source": str(package), "Destination": "/package",
         "RW": False, "Propagation": "rprivate"},
        {"Type": "bind", "Source": str(run_root / "state"), "Destination": "/state",
         "RW": True, "Propagation": "rprivate"},
    ]
    mounts.extend({"Type": "bind", "Source": system_sources[field], "Destination": target,
                   "RW": False, "Propagation": "rprivate"}
                  for target, field in executor._MANAGED_BROWSER_SYSTEM_MOUNT_FIELDS.items())
    item = {
        "Name": "/fullmag-browser-" + project_id + "-browser-1",
        "Image": image,
        **system_sources,
        "Config": {
            "Image": image, "User": "65532:65532", "Entrypoint": [],
            "WorkingDir": "/source",
            "Cmd": inspect_command,
            "Labels": {
                "com.docker.compose.project": "fullmag-browser-" + project_id,
                "com.docker.compose.service": "browser",
                "com.docker.compose.container-number": "1",
                "com.docker.compose.oneoff": "False",
                "com.docker.compose.config-hash": "f" * 64,
                "com.docker.compose.project.config_files": str(run_root / "compose.json"),
                "com.docker.compose.project.working_dir": str(run_root),
            },
        },
        "HostConfig": {
            "ReadonlyRootfs": True, "Privileged": False, "NetworkMode": "bridge",
            "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
            "NanoCpus": 4 * 10**9, "Memory": 2 * 1024**3, "PidsLimit": 128,
            "DeviceRequests": [], "Devices": [], "DeviceCgroupRules": [],
            "Tmpfs": {"/tmp": "rw,nosuid,nodev,size=256m"},
        },
        "Mounts": mounts,
    }
    return item, storage_root, build_storage_root


def attested(item, storage_root, build_storage_root):
    return executor.is_attested_managed_browser_container(
        item, storage_root=storage_root, build_storage_root=build_storage_root)


def blocking(item, storage_root=None, build_storage_root=None):
    return executor.is_blocking_fullmag_container(
        item, storage_root=storage_root, build_storage_root=build_storage_root)


def mount(item, target):
    return next(value for value in item["Mounts"] if value["Destination"] == target)


def optional_tmpfs_mount():
    return {"Type": "tmpfs", "Source": "", "Destination": "/tmp", "RW": True,
            "Propagation": "", "Mode": ""}


def browser_with_posix_roots():
    item, _, _ = browser()
    storage_root = "/tmp/fullmag-browser-guard/storage"
    build_storage_root = "/tmp/fullmag-browser-guard/build-storage"
    worktree_id = "eigensolve-" + "b" * 16
    project_id = "a" * 32
    mount(item, "/source")["Source"] = (
        storage_root + "/runs/" + worktree_id + "/" + "c" * 32 + "/source/tree")
    mount(item, "/package")["Source"] = (
        storage_root + "/runs/" + worktree_id + "/" + "d" * 32
        + "/artifacts/outputs/.fullmag/local")
    mount(item, "/state")["Source"] = (
        build_storage_root + "/builds/" + worktree_id + "/managed-browser-cpu/runs/"
        + project_id + "/state")
    labels = item["Config"]["Labels"]
    labels["com.docker.compose.project.working_dir"] = (
        build_storage_root + "/builds/" + worktree_id + "/managed-browser-cpu/runs/" + project_id)
    labels["com.docker.compose.project.config_files"] = (
        labels["com.docker.compose.project.working_dir"] + "/compose.json")
    return item, storage_root, build_storage_root


class ManagedBrowserGuardTests(unittest.TestCase):
    def test_current_launcher_mount_contract_is_the_only_exemption(self):
        item, storage_root, build_storage_root = browser()
        self.assertTrue(attested(item, storage_root, build_storage_root))
        self.assertFalse(blocking(item, storage_root, build_storage_root))
        self.assertTrue(blocking(item))
        item["Mounts"] = [value for value in item["Mounts"]
                          if value["Destination"] not in executor._MANAGED_BROWSER_SYSTEM_MOUNT_FIELDS]
        for field in executor._MANAGED_BROWSER_SYSTEM_MOUNT_FIELDS.values():
            item.pop(field)
        self.assertTrue(attested(item, storage_root, build_storage_root))

    def test_mount_allowlist_rejects_extra_bind_volume_device_and_duplicate_targets(self):
        item, storage_root, build_storage_root = browser()
        for extra in (
            {"Type": "bind", "Source": str(storage_root / "cache"),
             "Destination": "/workspace", "RW": True, "Propagation": "rprivate"},
            {"Type": "bind", "Source": str(storage_root / "cache"),
             "Destination": "/cache", "RW": False, "Propagation": "rprivate"},
            {"Type": "volume", "Source": "build-cache", "Destination": "/cache",
             "RW": True, "Propagation": "rprivate"},
            {"Type": "device", "Source": "/dev/nvidia0", "Destination": "/dev/gpu",
             "RW": True, "Propagation": "rprivate"},
        ):
            with self.subTest(extra=extra):
                changed = copy.deepcopy(item)
                changed["Mounts"].append(extra)
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        changed["Mounts"].append(copy.deepcopy(mount(item, "/source")))
        self.assertFalse(attested(changed, storage_root, build_storage_root))
        for target in ("/source", "/package", "/state"):
            changed = copy.deepcopy(item)
            changed["Mounts"] = [value for value in changed["Mounts"]
                                 if value["Destination"] != target]
            self.assertFalse(attested(changed, storage_root, build_storage_root))

    def test_mount_destinations_reject_alias_traversal_and_noncanonical_spellings(self):
        item, storage_root, build_storage_root = browser()
        for destination in ("/source/", "/source/../package", "//source",
                            "/source//tree", "\\source", "/SOURCE"):
            with self.subTest(destination=destination):
                changed = copy.deepcopy(item)
                mount(changed, "/source")["Destination"] = destination
                self.assertFalse(attested(changed, storage_root, build_storage_root))

    def test_bind_sources_and_flags_must_match_their_exact_roles(self):
        item, storage_root, build_storage_root = browser()
        mutations = (
            ("/source", "Type", "volume"),
            ("/source", "RW", True),
            ("/source", "Propagation", "shared"),
            ("/package", "RW", 0),
            ("/state", "RW", False),
            ("/state", "Propagation", "rshared"),
        )
        for target, field, value in mutations:
            with self.subTest(target=target, field=field, value=value):
                changed = copy.deepcopy(item)
                mount(changed, target)[field] = value
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        for target, source in (
            ("/source", str(storage_root / "runs" / "other-worktree" / ("c" * 32)
                             / "source" / "tree")),
            ("/package", str(storage_root / "runs" / "other-worktree"
                             / ("d" * 32) / "artifacts" / "outputs" / ".fullmag" / "local")),
        ):
            with self.subTest(target=target):
                changed = copy.deepcopy(item)
                mount(changed, target)["Source"] = source
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        source = mount(changed, "/source")["Source"]
        mount(changed, "/source")["Source"] = source + "/../tree"
        self.assertFalse(attested(changed, storage_root, build_storage_root))

    def test_project_state_and_compose_file_are_bound_to_current_namespace(self):
        item, storage_root, build_storage_root = browser()
        mutations = (
            ("com.docker.compose.project.working_dir", str(build_storage_root / "other")),
            ("com.docker.compose.project.config_files", str(build_storage_root / "other.json")),
        )
        for label, value in mutations:
            with self.subTest(label=label):
                changed = copy.deepcopy(item)
                changed["Config"]["Labels"][label] = value
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        mount(changed, "/state")["Source"] = str(
            build_storage_root / "builds" / ("eigensolve-" + "b" * 16)
            / "managed-browser-cpu" / "runs" / ("f" * 32) / "state")
        self.assertFalse(attested(changed, storage_root, build_storage_root))

    def test_tmpfs_requires_only_the_bounded_current_tmp_contract(self):
        item, storage_root, build_storage_root = browser()
        # The daemon's Mounts array may omit HostConfig.Tmpfs entries.
        self.assertTrue(attested(item, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        changed["Mounts"].append(optional_tmpfs_mount())
        self.assertTrue(attested(changed, storage_root, build_storage_root))
        host_config_changes = (
            None,
            {"/tmp": "rw,nosuid,nodev"},
            {"/tmp": "rw,nosuid,nodev,size=257m"},
            {"/tmp": "rw,nosuid,nodev,size=256m,rw"},
            {"/tmp": "rw,nosuid,nodev,size=256m", "/var/tmp": "rw,size=1g"},
            {"/tmp/../var/tmp": "rw,nosuid,nodev,size=256m"},
        )
        for value in host_config_changes:
            with self.subTest(tmpfs=value):
                changed = copy.deepcopy(item)
                changed["HostConfig"]["Tmpfs"] = value
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        mount_changes = (
            ("Type", "bind"), ("Source", "/host/tmp"), ("RW", 1),
            ("RW", False), ("Propagation", "rprivate"),
            ("Mode", "rw,nosuid,nodev,size=1g"),
        )
        for field, value in mount_changes:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(item)
                changed["Mounts"].append(optional_tmpfs_mount())
                mount(changed, "/tmp")[field] = value
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        changed["Mounts"].append({"Type": "tmpfs", "Source": "", "Destination": "/scratch",
                                  "RW": True, "Propagation": ""})
        self.assertFalse(attested(changed, storage_root, build_storage_root))

    def test_optional_docker_system_mounts_require_inspect_source_identity(self):
        item, storage_root, build_storage_root = browser()
        for target, field in executor._MANAGED_BROWSER_SYSTEM_MOUNT_FIELDS.items():
            changed = copy.deepcopy(item)
            del changed[field]
            self.assertFalse(attested(changed, storage_root, build_storage_root))
            changed = copy.deepcopy(item)
            changed[field] = "/var/lib/docker/containers/other/hosts"
            self.assertFalse(attested(changed, storage_root, build_storage_root))
            changed = copy.deepcopy(item)
            mount(changed, target)["Source"] = "relative/docker/hosts"
            self.assertFalse(attested(changed, storage_root, build_storage_root))
            changed = copy.deepcopy(item)
            mount(changed, target)["RW"] = "false"
            self.assertFalse(attested(changed, storage_root, build_storage_root))
            changed = copy.deepcopy(item)
            mount(changed, target)["RW"] = True
            self.assertTrue(attested(changed, storage_root, build_storage_root))
            changed = copy.deepcopy(item)
            mount(changed, target)["Propagation"] = "shared"
            self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        changed["Mounts"].append({"Type": "bind", "Source": "/etc/passwd",
                                  "Destination": "/etc/passwd", "RW": False,
                                  "Propagation": "rprivate"})
        self.assertFalse(attested(changed, storage_root, build_storage_root))

    def test_windows_docker_desktop_source_aliases_normalize_but_traversal_does_not(self):
        expected = executor._host_path_parts("C:/Fullmag/storage/runs/a")
        self.assertEqual(expected, executor._host_path_parts(r"c:\Fullmag\storage\runs\a"))
        self.assertEqual(expected, executor._host_path_parts("/host_mnt/c/Fullmag/storage/runs/a"))
        self.assertEqual(expected, executor._host_path_parts(
            "/run/desktop/mnt/host/c/Fullmag/storage/runs/a"))
        self.assertEqual(executor._host_path_parts(r"\\server\share\Fullmag"),
                         executor._host_path_parts("//SERVER/share/Fullmag"))
        self.assertIsNone(executor._host_path_parts("C:/Fullmag/storage/runs/../escape"))
        self.assertIsNone(executor._host_path_parts("/host_mnt/c/Fullmag//storage"))
        self.assertIsNone(executor._host_path_parts("/run/desktop/mnt/host/c\\Fullmag\\storage"))
        self.assertEqual(executor._host_path_parts("C:/Fullmag/FOO"),
                         executor._host_path_parts("c:/fullmag/foo"))
        self.assertNotEqual(executor._host_path_parts("C:/Fullmag/Straße"),
                            executor._host_path_parts("C:/Fullmag/Strasse"))
        self.assertIsNone(executor._relative_host_path(
            "C:/Fullmag/Straße", "C:/Fullmag/Strasse/runs"))
        self.assertIsNone(executor._relative_host_path(
            "C:/Fullmag/Strasse", "C:/Fullmag/Straße/runs"))
        self.assertIsNone(executor._relative_host_path(
            "/tmp/storage", "/tmp/storage\\outside"))

    def test_posix_backslashes_cannot_alias_paths_for_any_mount_or_project_root(self):
        item, storage_root, build_storage_root = browser_with_posix_roots()
        self.assertTrue(attested(item, storage_root, build_storage_root))
        for target, segment in (("/source", "/runs/"), ("/package", "/runs/"),
                                ("/state", "/builds/")):
            with self.subTest(target=target):
                changed = copy.deepcopy(item)
                value = mount(changed, target)["Source"]
                mount(changed, target)["Source"] = value.replace(segment, "\\" + segment[1:], 1)
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        for label in ("com.docker.compose.project.working_dir",
                      "com.docker.compose.project.config_files"):
            with self.subTest(label=label):
                changed = copy.deepcopy(item)
                value = changed["Config"]["Labels"][label]
                changed["Config"]["Labels"][label] = value.replace("/builds/", "\\builds/", 1)
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        self.assertEqual((None, None), executor._managed_browser_guard_roots({
            "storage_root": "/tmp/storage\\escaped", "build_storage_root": "/tmp/build",
        }))

    def test_container_coordinator_layout_uses_host_and_daemon_namespaces_without_build_root(self):
        item, local_storage_root, local_build_storage_root = browser()
        host_storage_root = "C:/Fullmag/storage"
        daemon_storage_root = "/run/desktop/mnt/host/c/Fullmag/storage"

        def daemon_path(relative):
            return daemon_storage_root + ("/" + "/".join(relative) if relative else "")

        for target in ("/source", "/package"):
            value = mount(item, target)
            value["Source"] = daemon_path(
                executor._relative_host_path(local_storage_root, value["Source"]))
        state_mount = mount(item, "/state")
        state_mount["Source"] = daemon_path(
            executor._relative_host_path(local_build_storage_root, state_mount["Source"]))
        labels = item["Config"]["Labels"]
        labels["com.docker.compose.project.working_dir"] = daemon_path(
            executor._relative_host_path(
                local_build_storage_root, labels["com.docker.compose.project.working_dir"]))
        labels["com.docker.compose.project.config_files"] = daemon_path(
            executor._relative_host_path(
                local_build_storage_root, labels["com.docker.compose.project.config_files"]))

        layout = {
            "storage_root": "/storage", "container_coordinator": True,
            "host_storage_root": host_storage_root,
            "daemon_storage_root": daemon_storage_root,
        }
        guard_roots = executor._managed_browser_guard_roots(layout)
        self.assertEqual((host_storage_root, host_storage_root), guard_roots)
        self.assertTrue(attested(item, *guard_roots))
        self.assertFalse(blocking(item, *guard_roots))
        self.assertEqual((None, None), executor._managed_browser_guard_roots({
            "storage_root": "/storage", "container_coordinator": True,
            "host_storage_root": host_storage_root,
            "daemon_storage_root": "/run/desktop/mnt/host/d/other-storage",
        }))
        self.assertEqual((None, None), executor._managed_browser_guard_roots({
            "storage_root": "/storage", "container_coordinator": True,
        }))

    def test_name_labels_resources_and_command_still_gate_the_exemption(self):
        item, storage_root, build_storage_root = browser()
        for key, value in {
            "Privileged": True, "ReadonlyRootfs": False, "NetworkMode": "host",
            "CapDrop": [], "SecurityOpt": [], "NanoCpus": 0, "Memory": 0,
            "PidsLimit": -1, "DeviceRequests": [{"Capabilities": [["gpu"]]}],
        }.items():
            with self.subTest(key=key):
                changed = copy.deepcopy(item)
                changed["HostConfig"][key] = value
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        for key, value in (("NanoCpus", True), ("Memory", True), ("PidsLimit", True),
                           ("NanoCpus", 5 * 10**9), ("Memory", 3 * 1024**3), ("PidsLimit", 129)):
            with self.subTest(key=key, value=value):
                changed = copy.deepcopy(item)
                changed["HostConfig"][key] = value
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        for script in (
            "cargo build",
            "set -eu; [ ! -L /state/workspace ] || exit 2; mkdir -p /state/workspace; "
            "cargo build; exec /package/bin/fullmag-api",
            "set -eu; mkdir -p /tmp/fullmag-state; exec /package/bin/fullmag-api",
            "set -eu; mkdir -p /state/workspace; exec /package/bin/fullmag-api",
        ):
            with self.subTest(script=script):
                changed = copy.deepcopy(item)
                changed["Config"]["Cmd"][-1] = script
                self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        changed["Config"]["Image"] = "fullmag:latest"
        self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        changed["Config"]["Labels"] = {}
        self.assertFalse(attested(changed, storage_root, build_storage_root))
        changed = copy.deepcopy(item)
        changed["Config"]["Labels"]["com.docker.compose.project"] = "another-project"
        self.assertFalse(attested(changed, storage_root, build_storage_root))

    def test_runner_buildkit_and_unrelated_container_rules_are_unchanged(self):
        for name in ("/Fullmag_build_runner", "/buildx_buildkit_fullmag-windows0", "/other-service"):
            self.assertFalse(blocking({"Name": name}))
        for value in ({"Name": "/fullmag-worker-123"}, {}, None):
            self.assertTrue(blocking(value))


if __name__ == "__main__":
    unittest.main()
