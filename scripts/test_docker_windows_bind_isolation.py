"""Synthetic metadata regressions; no native provider or Docker operation runs."""
import copy
import ntpath
import stat
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_windows_bind_isolation as isolation
from docker_build_control import BuildControlError

SOURCE = r"D:\git\fullmag\storage"
FOREIGN = "a" * 64
BACKEND = "b" * 64


def file_id(number):
    return "0x" + format(number, "032x")


def descendants():
    return {"schema": isolation.INVENTORY_SCHEMA, "entries": 0, "directories": 0, "files": 0,
            "sha256": isolation._sha(b""), "reparse_points": 0, "links": [],
            "max_entries": isolation.MAX_DESCENDANT_ENTRIES, "budget_ms": isolation.DESCENDANT_BUDGET_MS}


def native_identity(path, number, ancestors, kind="file", volume=None):
    return {"path": path, "volume": volume or path[:2], "serial": "12ABCDEF",
            "filesystem": "NTFS", "fixed": True, "no_reparse": True,
            "file_id": file_id(number), "ancestor_file_ids": [file_id(item) for item in ancestors],
            "kind": kind, "hardlinks": [] if kind == "directory" else [path],
            "descendants": descendants() if kind == "directory" else None}


def native():
    origin = r"C:\Users\admin\AppData\Local\Docker\wsl\disk"
    target = r"D:\DockerDesktop\wsl\disk"
    return {"schema": isolation.NATIVE_SCHEMA, "distro": "Ubuntu",
            "candidate": native_identity(SOURCE, 10, [12, 11, 1], "directory"),
            "registry": [
                {"name": "Ubuntu", "base": r"D:\git\fullmag\wsl\Ubuntu", "filename": "ext4.vhdx"},
                {"name": "docker-desktop", "base": r"C:\Users\admin\AppData\Local\Docker\wsl\main",
                 "filename": "ext4.vhdx"}],
            "desktop_disk_origin": origin, "desktop_disk_root": target,
            "desktop_disk_junction": {"path": origin, "target": target},
            "settings_sha256": "c" * 64,
            "settings_keys": ["AutoStart", "IntegratedWslDistros", "SettingsVersion"],
            "backings": {
                "wsl-current": native_identity(r"D:\git\fullmag\wsl\Ubuntu\ext4.vhdx", 20, [22, 21, 12, 11, 1]),
                "wsl-docker-desktop": native_identity(
                    r"C:\Users\admin\AppData\Local\Docker\wsl\main\ext4.vhdx", 30, [32, 31, 34, 35, 36, 37, 38, 2]),
                "docker-desktop-data": native_identity(target + r"\docker_data.vhdx", 40, [42, 41, 43, 1])}}


def container(identifier):
    return {"Id": identifier, "Image": "sha256:" + "d" * 64,
            "Config": {"Labels": {}, "Env": ["PRIVATE=never-copied"]},
            "HostConfig": {"Binds": [SOURCE + ":/foreign"], "Mounts": []},
            "Mounts": [{"Type": "bind", "Source": SOURCE, "Destination": "/foreign"}],
            "NetworkSettings": {"Networks": {"private": {"NetworkID": "e" * 64}}},
            "State": {"Status": "exited", "Running": False, "Paused": False, "Restarting": False,
                      "OOMKilled": False, "Dead": False, "Pid": 0, "ExitCode": 0,
                      "StartedAt": "2026-10-27T01:00:00Z", "FinishedAt": "2026-10-27T02:00:00Z",
                      "Error": "", "Health": {"Log": ["irrelevant health log"]}}}


def proof():
    context = {"identity": {"project_name": "fullmag-worktree-fixture", "source_root": "/home/user/repo",
                            "checkout_kind": "worktree"},
               "project": "fullmag-worktree-fixture", "source_root": "/home/user/repo",
               "reference_root": "/home/user/storage", "control_volume": "fixture-control",
               "control_namespace": "", "ledger_volume": "fixture-ledger", "distro": "Ubuntu"}
    observed = {"engine": {"ID": "engine", "Name": "docker-desktop", "OperatingSystem": "Docker Desktop",
                           "OSType": "linux", "KernelVersion": "6.6-microsoft-standard-WSL2"},
                "backend": isolation._container_pin(container(BACKEND)),
                "foreign": isolation._container_pin(container(FOREIGN)),
                "linux": {"source_root": context["source_root"], "reference_root": context["reference_root"],
                          "source_inode": 101, "reference_inode": 102, "root_device": 2128,
                          "root_mount": {"target": "/", "fstype": "ext4", "fsroot": "/"},
                          "marker_sha256": "f" * 64, "engine_id": "engine"},
                "mapping": {"path": "/mnt/d/git/fullmag/storage", "roundtrip": SOURCE,
                            "mount": {"target": "/mnt/d", "source": "D:\\", "fstype": "9p", "fsroot": "/"},
                            "device": 111, "inode": 555, "mode": stat.S_IFDIR | 0o755, "nlink": 1},
                "native": native(), "contained_links": []}
    return {"schema": isolation.SCHEMA, "decision": "disjoint", "container_id": FOREIGN,
            "source_sha256": isolation._sha(SOURCE.encode()), "context": context,
            "provider_sha256": isolation._sha(isolation.WINDOWS_PROVIDER.encode()),
            "before": observed, "after": copy.deepcopy(observed)}


def file_link_fixture():
    value = native()
    inventory = value["candidate"]["descendants"]
    inventory.update(entries=3, directories=1, files=2, reparse_points=1,
                     links=[{"path": r"lib\alias.so", "tag": "0xa000001d", "kind": "file", "target": None}])
    mapping = proof()["before"]["mapping"]
    hop = {"path": "lib/alias.so", "native_entry_kind": "file", "native_reparse_tag": "0xa000001d",
           "target": "alias.so.0", "device": mapping["device"],
           "inode": 123, "mode": stat.S_IFLNK | 0o777}
    final = {"path": "lib/alias.so.0", "device": mapping["device"],
             "inode": 124, "mode": stat.S_IFREG | 0o644}
    return value, mapping, [{"path": r"lib\alias.so", "native_entry_kind": "file", "target_kind": "file", "hops": [hop], "final": final}]


class WindowsIsolationTests(unittest.TestCase):
    def check_native(self, value, source=SOURCE):
        return isolation._validate_native(value, source, "Ubuntu")

    def check_proof(self, value, source=SOURCE):
        return isolation.validate_windows_bind_disjoint_proof(value, source=source, container_id=FOREIGN)

    def test_actual_storage_shape_is_disjoint_from_three_qualified_backings(self):
        value = native()
        self.assertIs(self.check_native(value), value)
        self.assertEqual(self.check_proof(proof())["before"]["native"].get("schema"), isolation.NATIVE_SCHEMA)

    def test_parent_of_ubuntu_backing_is_refused(self):
        value = native()
        path = r"D:\git\fullmag"
        value["candidate"] = native_identity(path, 12, [11, 1], "directory")
        with self.assertRaises(BuildControlError):
            self.check_native(value, path)

    def test_short_name_parent_alias_is_refused_by_native_ancestor_id(self):
        value = native()
        path = r"D:\git\FULLMA~1"
        value["candidate"] = native_identity(path, 12, [11, 1], "directory")
        with self.assertRaisesRegex(BuildControlError, "physically aliases"):
            self.check_native(value, path)

    def test_file_identity_alias_is_refused_even_with_another_spelling(self):
        value = native()
        path = r"D:\unrelated-name.vhdx"
        value["candidate"] = native_identity(path, 20, [1])
        with self.assertRaisesRegex(BuildControlError, "physically aliases"):
            self.check_native(value, path)

    def test_other_drive_letter_with_same_serial_cannot_hide_file_or_parent_alias(self):
        for number, kind in ((20, "file"), (12, "directory")):
            value = native()
            path = r"E:\different-spelling"
            value["candidate"] = native_identity(path, number, [99], kind)
            with self.subTest(kind=kind), self.assertRaisesRegex(BuildControlError, "physically aliases"):
                self.check_native(value, path)

    def test_backing_inventory_cannot_alias_itself_under_another_drive_letter(self):
        value = native()
        backing = value["backings"]["docker-desktop-data"]
        backing["file_id"] = value["backings"]["wsl-docker-desktop"]["file_id"]
        with self.assertRaisesRegex(BuildControlError, "aliases itself"):
            self.check_native(value)

    def test_each_backing_is_mandatory(self):
        for role in isolation.BACKINGS:
            with self.subTest(role=role):
                value = native()
                del value["backings"][role]
                with self.assertRaises(BuildControlError):
                    self.check_native(value)

    def test_candidate_and_backing_hardlinks_are_refused(self):
        for role in ["candidate", *isolation.BACKINGS]:
            with self.subTest(role=role):
                value = native()
                item = value["candidate"] if role == "candidate" else value["backings"][role]
                item["kind"] = "file"
                item["descendants"] = None
                item["hardlinks"] = [item["path"], r"D:\alias"]
                with self.assertRaises(BuildControlError):
                    self.check_native(value)

    def test_cross_volume_backing_can_explicitly_leave_hardlinks_unassessed(self):
        value = native()
        backing = value["backings"]["wsl-docker-desktop"]
        backing["serial"] = "24077CEF"
        backing["hardlinks"] = None
        self.assertIs(self.check_native(value), value)
        self.assertIsNone(value["backings"]["wsl-docker-desktop"]["hardlinks"])

    def test_same_volume_backing_unknown_hardlinks_are_refused_for_every_role(self):
        for role in isolation.BACKINGS:
            value = native()
            value["backings"][role]["hardlinks"] = None
            with self.subTest(role=role), self.assertRaisesRegex(BuildControlError, "unknown hardlinks"):
                self.check_native(value)

    def test_candidate_file_unknown_hardlinks_are_always_refused(self):
        value = native()
        value["candidate"]["kind"] = "file"
        value["candidate"]["descendants"] = None
        value["candidate"]["hardlinks"] = None
        with self.assertRaisesRegex(BuildControlError, "unknown hardlinks"):
            self.check_native(value)

    def test_cross_volume_reported_multiple_hardlinks_still_refuse(self):
        value = native()
        backing = value["backings"]["wsl-docker-desktop"]
        backing["serial"] = "24077CEF"
        backing["hardlinks"] = [backing["path"], r"C:\other-name.vhdx"]
        with self.assertRaisesRegex(BuildControlError, "multiple hardlinks"):
            self.check_native(value)

    def test_child_junction_or_symlink_inventory_is_refused(self):
        value = native()
        inventory = value["candidate"]["descendants"]
        inventory.update(entries=1, directories=1, reparse_points=1)
        with self.assertRaisesRegex(BuildControlError, "reparse points"):
            self.check_native(value)

    def test_contained_sibling_file_link_is_explicitly_qualified_without_zero_reparse_claim(self):
        value, mapping, evidence = file_link_fixture()
        self.check_native(value)
        self.assertEqual(value["candidate"]["descendants"]["reparse_points"], 1)
        self.assertIs(isolation._validate_link_evidence(evidence, mapping, value), evidence)

    def test_relative_file_link_targets_reject_absolute_unc_drive_backslash_and_parent_escape(self):
        for target in ("/etc/passwd", "../elsewhere", "lib/../elsewhere", "C:elsewhere",
                       r"\\server\share", r"other\target", "bad\ntarget"):
            with self.subTest(target=target), self.assertRaises(BuildControlError):
                isolation._resolve_link_target("alias.so", target)

    def test_unknown_native_file_reparse_tag_or_link_inventory_overflow_is_refused(self):
        value, _, _ = file_link_fixture()
        value["candidate"]["descendants"]["links"][0].update(
            tag="0xa0000003", target=SOURCE + r"\lib\alias.so.0")
        with self.assertRaisesRegex(BuildControlError, "tag"):
            self.check_native(value)
        value, _, _ = file_link_fixture()
        inventory = value["candidate"]["descendants"]
        inventory["links"] *= isolation.MAX_RELATIVE_LINKS + 1
        with self.assertRaisesRegex(BuildControlError, "fixed bound"):
            self.check_native(value)

    def test_every_hop_must_belong_to_exact_native_file_link_inventory(self):
        value, mapping, evidence = file_link_fixture()
        evidence[0]["hops"].append(dict(evidence[0]["hops"][0], path="lib/alias.so.0", target="final.so"))
        evidence[0]["final"]["path"] = "lib/final.so"
        with self.assertRaisesRegex(BuildControlError, "native LX_SYMLINK"):
            isolation._validate_link_evidence(evidence, mapping, value)
        with self.assertRaisesRegex(BuildControlError, "exact native inventory"):
            isolation._validate_link_evidence([], mapping, value)

    def test_file_link_hop_bound_directory_target_and_cross_device_target_are_refused(self):
        for change in ("hops", "directory", "device"):
            value, mapping, evidence = file_link_fixture()
            if change == "hops":
                evidence[0]["hops"] *= isolation.MAX_RELATIVE_LINK_HOPS + 1
            elif change == "directory":
                evidence[0]["final"]["mode"] = stat.S_IFDIR | 0o755
            else:
                evidence[0]["final"]["device"] += 1
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                isolation._validate_link_evidence(evidence, mapping, value)

    def test_linux_file_link_qualification_rereads_raw_target_and_lstat_identity(self):
        value, mapping, expected = file_link_fixture()
        hop, final = expected[0]["hops"][0], expected[0]["final"]
        def identity(path):
            pin = hop if str(path).endswith("/alias.so") else final
            return {key: pin[key] for key in ("device", "inode", "mode")}
        with mock.patch.object(isolation, "_file_identity", side_effect=identity) as lstat, \
             mock.patch.object(isolation, "_link_parent_directories"), \
             mock.patch.object(isolation.os, "readlink", return_value="alias.so.0") as readlink, \
             mock.patch.object(isolation.time, "monotonic", return_value=0):
            self.assertEqual(isolation._qualify_links(mapping, value), expected)
            self.assertEqual(readlink.call_count, 2)
            self.assertEqual(lstat.call_count, 4)

    def test_linux_file_link_target_drift_and_cycle_are_refused(self):
        value, mapping, evidence = file_link_fixture()
        hop = evidence[0]["hops"][0]
        identity = {key: hop[key] for key in ("device", "inode", "mode")}
        with mock.patch.object(isolation, "_file_identity", return_value=identity), \
             mock.patch.object(isolation, "_link_parent_directories"), \
             mock.patch.object(isolation.os, "readlink", side_effect=["alias.so.0", "changed.so"]), \
             mock.patch.object(isolation.time, "monotonic", return_value=0):
            with self.assertRaisesRegex(BuildControlError, "drifted"):
                isolation._qualify_links(mapping, value)
        with mock.patch.object(isolation, "_file_identity", return_value=identity), \
             mock.patch.object(isolation, "_link_parent_directories"), \
             mock.patch.object(isolation.os, "readlink", return_value="alias.so"), \
             mock.patch.object(isolation.time, "monotonic", return_value=0):
            with self.assertRaisesRegex(BuildControlError, "cycle"):
                isolation._qualify_links(mapping, value)

    def test_contained_lx_directory_link_qualifies_without_following_windows_reparse(self):
        value, mapping, evidence = file_link_fixture()
        inventory = value["candidate"]["descendants"]
        inventory.update(directories=2, files=1)
        inventory["links"][0]["kind"] = "directory"
        evidence[0]["native_entry_kind"] = "directory"
        evidence[0]["hops"][0]["native_entry_kind"] = "directory"
        evidence[0]["target_kind"] = "directory"
        evidence[0]["final"]["mode"] = stat.S_IFDIR | 0o755
        self.check_native(value)
        isolation._validate_link_evidence(evidence, mapping, value)
        hop, final = evidence[0]["hops"][0], evidence[0]["final"]
        def identity(path):
            pin = hop if str(path).endswith("/alias.so") else final
            return {key: pin[key] for key in ("device", "inode", "mode")}
        with mock.patch.object(isolation, "_file_identity", side_effect=identity), \
             mock.patch.object(isolation, "_link_parent_directories"), \
             mock.patch.object(isolation.os, "readlink", return_value="alias.so.0"):
            self.assertEqual(isolation._qualify_links(mapping, value), evidence)

    def test_file_attributed_lx_can_have_a_qualified_contained_directory_target(self):
        value, mapping, evidence = file_link_fixture()
        evidence[0]["target_kind"] = "directory"
        evidence[0]["final"]["mode"] = stat.S_IFDIR | 0o755
        isolation._validate_link_evidence(evidence, mapping, value)
        hop, final = evidence[0]["hops"][0], evidence[0]["final"]
        def identity(path):
            pin = hop if str(path).endswith("/alias.so") else final
            return {key: pin[key] for key in ("device", "inode", "mode")}
        with mock.patch.object(isolation, "_file_identity", side_effect=identity), \
             mock.patch.object(isolation, "_link_parent_directories"), \
             mock.patch.object(isolation.os, "readlink", return_value="alias.so.0"):
            self.assertEqual(isolation._qualify_links(mapping, value), evidence)

    def test_transitive_lx_links_bind_each_native_kind_separately_from_final_kind(self):
        value, mapping, evidence = file_link_fixture()
        inventory = value["candidate"]["descendants"]
        inventory.update(entries=4, directories=2, files=2, reparse_points=2)
        inventory["links"].append({"path": r"lib\alias.so.0", "tag": "0xa000001d",
                                    "kind": "directory", "target": None})
        second = dict(evidence[0]["hops"][0], path="lib/alias.so.0", inode=125,
                      native_entry_kind="directory", target="final")
        final = dict(evidence[0]["final"], path="lib/final", mode=stat.S_IFDIR | 0o755)
        evidence[0].update(target_kind="directory", final=final)
        evidence[0]["hops"].append(second)
        evidence.append({"path": r"lib\alias.so.0", "native_entry_kind": "directory",
                         "target_kind": "directory", "hops": [second], "final": final})
        isolation._validate_link_evidence(evidence, mapping, value)
        evidence[0]["hops"][1]["native_entry_kind"] = "file"
        with self.assertRaisesRegex(BuildControlError, "native LX_SYMLINK"):
            isolation._validate_link_evidence(evidence, mapping, value)

    def test_forged_target_kind_or_unknown_evidence_field_is_refused(self):
        for change in ("target_kind", "native_entry_kind", "extra"):
            value, mapping, evidence = file_link_fixture()
            if change == "extra":
                evidence[0]["bypass"] = True
            else:
                evidence[0][change] = "directory"
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                isolation._validate_link_evidence(evidence, mapping, value)

    def test_leading_parent_link_target_is_bounded_at_candidate_root(self):
        self.assertEqual(isolation._resolve_link_target("node_modules/pkg", "../.pnpm/pkg"), ".pnpm/pkg")
        self.assertEqual(isolation._resolve_link_target("a/b/pkg", "../../target"), "target")
        for path, target in (("pkg", "../target"), ("a/pkg", "../../target"),
                             ("a/pkg", "x/../target"), ("a/pkg", "./target"),
                             ("a/pkg", "x//target")):
            with self.subTest(path=path, target=target), self.assertRaises(BuildControlError):
                isolation._resolve_link_target(path, target)

    def test_directory_target_kind_must_match_final_and_cannot_end_outside_or_in_cycle(self):
        value, mapping, evidence = file_link_fixture()
        value["candidate"]["descendants"].update(directories=2, files=1)
        value["candidate"]["descendants"]["links"][0]["kind"] = "directory"
        evidence[0]["native_entry_kind"] = "directory"
        evidence[0]["hops"][0]["native_entry_kind"] = "directory"
        evidence[0]["target_kind"] = "directory"
        for change in ("file", "escape", "cycle"):
            candidate = copy.deepcopy(evidence)
            if change == "escape":
                candidate[0]["hops"][0]["target"] = "../../outside"
            elif change == "cycle":
                candidate[0]["hops"][0]["target"] = "alias.so"
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                isolation._validate_link_evidence(candidate, mapping, value)

    def test_unknown_native_link_kind_is_refused(self):
        value, _, _ = file_link_fixture()
        value["candidate"]["descendants"]["links"][0]["kind"] = "junction"
        with self.assertRaises(BuildControlError):
            self.check_native(value)

    def test_linux_file_link_parent_cannot_be_a_symlink(self):
        def metadata(path):
            mode = stat.S_IFLNK if str(path) == "/candidate/linked" else stat.S_IFDIR
            return SimpleNamespace(st_mode=mode | 0o755, st_dev=111)
        with mock.patch.object(Path, "lstat", autospec=True, side_effect=metadata):
            with self.assertRaisesRegex(BuildControlError, "symlink"):
                isolation._link_parent_directories(Path("/candidate"), Path("/candidate/linked/alias.so"), 111)

    def test_file_link_evidence_target_or_final_identity_changes_refuse_full_proof(self):
        for field in ("target", "inode"):
            value, _, evidence = file_link_fixture()
            candidate = proof()
            candidate["before"]["native"] = value
            candidate["before"]["contained_links"] = evidence
            candidate["after"] = copy.deepcopy(candidate["before"])
            if field == "target":
                candidate["after"]["contained_links"][0]["hops"][0]["target"] = "different.so"
            else:
                candidate["after"]["contained_links"][0]["final"]["inode"] += 1
            expected_error = "Relative link does not end" if field == "target" else "identities drifted"
            with self.subTest(field=field), self.assertRaisesRegex(BuildControlError, expected_error):
                self.check_proof(candidate)

    def test_directory_descendant_inventory_has_fixed_entry_and_time_bounds(self):
        for changes in ({"entries": isolation.MAX_DESCENDANT_ENTRIES + 1,
                         "files": isolation.MAX_DESCENDANT_ENTRIES + 1},
                        {"max_entries": isolation.MAX_DESCENDANT_ENTRIES + 1},
                        {"budget_ms": isolation.DESCENDANT_BUDGET_MS + 1},
                        {"entries": True}, {"files": -1}, {"entries": 1}):
            value = native()
            value["candidate"]["descendants"].update(changes)
            with self.subTest(changes=changes), self.assertRaises(BuildControlError):
                self.check_native(value)

    def test_missing_directory_descendant_inventory_cannot_qualify(self):
        value = native()
        value["candidate"]["descendants"] = None
        with self.assertRaisesRegex(BuildControlError, "inventory is incomplete"):
            self.check_native(value)

    def test_descendant_provider_excludes_volatile_metadata_and_per_entry_native_processes(self):
        walk = isolation.WINDOWS_PROVIDER.split("function Descendants(", 1)[1].split("function Identity(", 1)[0]
        for field in ("Length", "CreationTimeUtc", "LastWriteTimeUtc", "Refresh"):
            for target in ("entry", "directory", "after"):
                self.assertNotIn("$" + target + "." + field, walk)
        self.assertNotIn("ConvertTo-Json", walk)
        self.assertNotIn("FileId $currentDir", walk)
        self.assertIn("FileId $root", walk)

    def test_descendant_walk_limits_item_provider_to_reparse_entries_and_bounds_budget_calls(self):
        ancestor = isolation.WINDOWS_PROVIDER.split("function NoReparse(", 1)[1].split("function FileId(", 1)[0]
        walk = isolation.WINDOWS_PROVIDER.split("function Descendants(", 1)[1].split("function Identity(", 1)[0]
        self.assertNotIn("Get-Item", ancestor)
        self.assertIn("[IO.File]::GetAttributes($cursor)", ancestor)
        self.assertIn("[IO.DirectoryInfo]::new($currentDir)", walk)
        ordinary_prefix, link_and_rest = walk.split("if ($isLink) {", 1)
        link_branch, ordinary_suffix = link_and_rest.split(
            "if (($attributes -band 0x10) -ne 0) {", 1)
        ordinary_entry_path = ordinary_prefix + ordinary_suffix
        self.assertNotIn("Get-Item", ordinary_entry_path)
        self.assertEqual(link_branch.count("Get-Item -Force -LiteralPath $entry.FullName"), 2)
        self.assertIn("if ($tag -ceq '0xa0000003')", link_branch)
        self.assertIn("elseif ($tag -ceq '0xa000000c')", link_branch)
        self.assertIn("if ($links.Count -ge 256)", link_branch)
        entries = walk.split("foreach ($entry in $directory.EnumerateFileSystemInfos())", 1)[1]
        entries = entries.split("NoReparse $currentDir", 1)[0]
        self.assertEqual(entries.count("DescendantBudget $clock"), 1)
        self.assertIn("if ($entryCount -gt 100000 -or $clock.ElapsedMilliseconds -ge 15000)", entries)

    def test_descendant_budget_failure_has_observation_counters(self):
        budget = isolation.WINDOWS_PROVIDER.split("function DescendantBudget(", 1)[1].split("function Descendants(", 1)[0]
        for counter in ("entries=", "directories=", "files=", "pending=", "elapsed_ms="):
            self.assertIn(counter, budget)

    def test_changed_directory_descendant_inventory_refuses_whole_proof(self):
        value = proof()
        value["after"]["native"]["candidate"]["descendants"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(BuildControlError, "identities drifted"):
            self.check_proof(value)

    def test_file_candidate_does_not_scan_or_claim_descendant_inventory(self):
        value = native()
        value["candidate"] = native_identity(SOURCE, 10, [12, 11, 1])
        self.check_native(value)
        value["candidate"]["descendants"] = descendants()
        with self.assertRaisesRegex(BuildControlError, "cannot claim"):
            self.check_native(value)

    def test_kernel_nested_mounts_under_either_proof_root_are_refused(self):
        for path in (Path("/home/user/repo"), Path("/home/user/storage")):
            mount = {"children": [{"target": str(path / "runs"), "source": "D:\\",
                                   "fstype": "9p", "fsroot": "/"}]}
            with self.subTest(path=path), self.assertRaisesRegex(BuildControlError, "nested external"):
                isolation._reject_submounts(mount, path)

    def test_linux_identity_rejects_reference_submount_before_reading_marker(self):
        root = {"target": "/", "source": "/dev/test", "fstype": "ext4", "fsroot": "/", "options": "rw"}
        nested = dict(root, children=[{"target": "/fixture-reference/runs", "source": "D:\\",
                                      "fstype": "9p", "fsroot": "/"}])
        with mock.patch.object(isolation, "_canonical_linux", side_effect=lambda value: Path(value)), \
             mock.patch.object(isolation, "_findmnt", side_effect=[root, root, nested]) as findmnt, \
             mock.patch("linux_native_host.read_owned_regular") as marker:
            with self.assertRaisesRegex(BuildControlError, "nested external"):
                isolation._linux_identity("/", "/fixture-reference")
            self.assertEqual(findmnt.call_args_list,
                             [mock.call("/"), mock.call(Path("/"), recursive=True),
                              mock.call(Path("/fixture-reference"), recursive=True)])
            marker.assert_not_called()

    def test_reparse_or_non_fixed_or_non_native_volume_is_refused(self):
        for field, bad in [("no_reparse", False), ("fixed", False), ("filesystem", "CIFS")]:
            value = native()
            value["candidate"][field] = bad
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                self.check_native(value)

    def test_unqualified_default_junction_or_data_filename_is_refused(self):
        for change in ("junction", "data", "origin"):
            value = native()
            if change == "junction":
                value["desktop_disk_junction"]["target"] = r"E:\elsewhere"
            elif change == "origin":
                value["desktop_disk_origin"] = r"C:\custom\disk"
            else:
                value["backings"]["docker-desktop-data"]["path"] = r"D:\elsewhere.vhdx"
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                self.check_native(value)

    def test_registered_distro_binding_cannot_be_replaced(self):
        value = native()
        value["registry"][0]["base"] = r"D:\another"
        with self.assertRaises(BuildControlError):
            self.check_native(value)

    def test_known_wsl_setting_is_allowed_but_custom_resource_paths_are_refused(self):
        self.check_native(native())
        for key in ("diskImageLocation", "customDataFolder", "wslVhdPath", "ResourcesLocation"):
            value = native()
            value["settings_keys"] = sorted(value["settings_keys"] + [key])
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                self.check_native(value)

    def test_unsafe_native_source_syntax_is_refused(self):
        for path in [r"\\server\share", r"D:relative", "D:\\", r"D:\a\..\b", r"D:\a:stream",
                     "D:\\folder.\\file", "D:\\folder \\file", "D:\\a,b"]:
            with self.subTest(path=path), self.assertRaises(BuildControlError):
                isolation._windows_path(path)

    def test_exact_raw_source_digest_is_required(self):
        value = proof()
        with self.assertRaises(BuildControlError):
            self.check_proof(value, SOURCE.replace("\\", "/"))

    def test_all_observation_drift_is_refused(self):
        for field in isolation.OBSERVATION_FIELDS:
            value = proof()
            value["after"][field] = {"changed": True}
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                self.check_proof(value)

    def test_same_device_or_non_ext4_reference_is_refused(self):
        for change in ("device", "filesystem"):
            value = proof()
            for observed in (value["before"], value["after"]):
                if change == "device":
                    observed["mapping"]["device"] = observed["linux"]["root_device"]
                else:
                    observed["linux"]["root_mount"]["fstype"] = "9p"
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                self.check_proof(value)

    def test_wrong_drvfs_drive_or_object_kind_is_refused(self):
        for change in ("drive", "kind"):
            value = proof()
            for observed in (value["before"], value["after"]):
                if change == "drive":
                    observed["mapping"]["mount"]["source"] = "E:\\"
                else:
                    observed["mapping"]["mode"] = stat.S_IFREG | 0o600
            with self.subTest(change=change), self.assertRaises(BuildControlError):
                self.check_proof(value)

    def test_non_desktop_or_non_wsl_engine_cannot_qualify_even_with_matching_id(self):
        for field, wrong in (("OperatingSystem", "Ubuntu"), ("KernelVersion", "linuxkit"), ("OSType", "windows")):
            value = proof()
            for observed in (value["before"], value["after"]):
                observed["engine"][field] = wrong
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                self.check_proof(value)

    def test_container_pin_ignores_health_logs_but_pins_critical_configuration(self):
        before = container(FOREIGN)
        after = copy.deepcopy(before)
        after["State"]["Health"]["Log"].append("another periodic health record")
        self.assertEqual(isolation._container_pin(before), isolation._container_pin(after))
        after["Config"]["Env"].append("CHANGED=1")
        self.assertNotEqual(isolation._container_pin(before), isolation._container_pin(after))
        self.assertNotIn("PRIVATE=never-copied", str(isolation._container_pin(before)))

    def test_container_pin_ignores_only_mount_inventory_order(self):
        before = container(FOREIGN)
        before["Mounts"].append({"Type": "volume", "Name": "foreign-cache",
                                  "Destination": "/cache", "RW": True,
                                  "Options": {"Subpath": "owned", "NoCopy": True}})
        after = copy.deepcopy(before)
        after["Mounts"].reverse()
        original = copy.deepcopy(before["Mounts"])
        self.assertEqual(isolation._container_pin(before), isolation._container_pin(after))
        self.assertEqual(before["Mounts"], original)

    def test_container_pin_preserves_source_rw_and_nested_mount_options(self):
        before = container(FOREIGN)
        before["Mounts"][0].update(RW=False, Options={"Propagation": "rprivate"})
        for field, changed in (("Source", r"E:\different"), ("RW", True),
                               ("Options", {"Propagation": "shared"})):
            after = copy.deepcopy(before)
            after["Mounts"][0][field] = changed
            with self.subTest(field=field):
                self.assertNotEqual(isolation._container_pin(before), isolation._container_pin(after))

    def test_container_pin_refuses_duplicate_mount_destinations(self):
        value = container(FOREIGN)
        value["Mounts"].append({"Type": "bind", "Source": r"E:\other", "Destination": "/foreign"})
        with self.assertRaisesRegex(BuildControlError, "destinations are duplicated"):
            isolation._container_pin(value)

    def test_container_pin_refuses_missing_empty_or_nontext_mount_destination(self):
        for bad in (None, "", 17, []):
            value = container(FOREIGN)
            value["Mounts"][0]["Destination"] = bad
            with self.subTest(destination=bad), self.assertRaises(BuildControlError):
                isolation._container_pin(value)
        value = container(FOREIGN)
        del value["Mounts"][0]["Destination"]
        with self.assertRaises(BuildControlError):
            isolation._container_pin(value)

    def test_json_duplicate_keys_and_oversized_response_are_refused(self):
        for raw in (b'{"path":1,"path":2}', b"x" * (isolation.MAX_BYTES + 1)):
            with self.assertRaises(BuildControlError):
                isolation._json(raw)

    def test_prelease_proof_is_read_only_and_can_be_repeated_under_lease(self):
        expected = proof()
        own, foreign = container(BACKEND), container(FOREIGN)
        for active in (None, {"root": "fixture/attempts/" + "e" * 32}):
            control = SimpleNamespace(_active_operation=active)
            with mock.patch.object(isolation, "_inspect", side_effect=lambda cid: copy.deepcopy(own if cid == BACKEND else foreign)), \
                 mock.patch.object(isolation, "_context", return_value=expected["context"]), \
                 mock.patch.object(isolation, "_observation", return_value=expected["before"]), \
                 mock.patch.object(isolation, "_engine", return_value=expected["before"]["engine"]), \
                 mock.patch("docker_bind_overlap_probe._archive_foreign_proof") as archive:
                result = isolation.prove_windows_bind_disjoint(control, own, foreign, SOURCE, "/home/user/storage")
                self.assertEqual(result, expected)
                archive.assert_called_once_with(control, expected)

    def test_foreign_change_after_native_observation_refuses_before_archive(self):
        expected = proof()
        own, foreign = container(BACKEND), container(FOREIGN)
        changed = copy.deepcopy(foreign)
        changed["HostConfig"]["Privileged"] = True
        with mock.patch.object(isolation, "_inspect", side_effect=[own, foreign, own, foreign, own, changed]), \
             mock.patch.object(isolation, "_context", return_value=expected["context"]), \
             mock.patch.object(isolation, "_observation", return_value=expected["before"]), \
             mock.patch.object(isolation, "_engine", return_value=expected["before"]["engine"]), \
             mock.patch("docker_bind_overlap_probe._archive_foreign_proof") as archive:
            with self.assertRaises(BuildControlError):
                isolation.prove_windows_bind_disjoint(SimpleNamespace(), own, foreign, SOURCE, "/home/user/storage")
            archive.assert_not_called()


if __name__ == "__main__":
    unittest.main()
