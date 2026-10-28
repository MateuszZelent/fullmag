"""Interpreted contract checks for the serialized Windows bind observer."""
import copy
import json
import os
from pathlib import Path
import stat
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_windows_bind_probe as probe


CONTAINER_ID = "a" * 64
MARKER_SHA = "b" * 64
NESTED_SOURCE = "/var/lib/docker/volumes/fullmag_runtime_services/_data"
REQUEST = {
    "container_id": CONTAINER_ID,
    "pid": 2345,
    "uid": 1002,
    "gid": 1003,
    "destination": "/run/desktop/mnt/host/e/source",
    "reference_device": 2049,
    "reference_inode": 100,
    "reference_marker_sha256": MARKER_SHA,
    "nested_mounts": [],
}
NESTED_MOUNT = {
    "type": "volume",
    "destination": REQUEST["destination"] + "/runtime-services",
    "source": NESTED_SOURCE,
    "name": "fullmag_runtime_services",
    "rw": True,
    "probe_path": "/nested-0",
}
NESTED_REQUEST = {**REQUEST, "nested_mounts": [NESTED_MOUNT]}


def _proc_stat(pid=2345, start=98765, comm=b"worker (authenticated)"):
    fields = [b"S"] + [b"1"] * 18 + [str(start).encode("ascii"), b"2"]
    return str(pid).encode("ascii") + b" (" + comm + b") " + b" ".join(fields) + b"\n"


def _status(*, uid=1002, gid=1003, cap_prm="0000000000000000", cap_eff="0000000000000000"):
    return (f"Name:\tworker\nUid:\t{uid} {uid} {uid} {uid}\n"
            f"Gid:\t{gid} {gid} {gid} {gid}\nCapPrm:\t{cap_prm}\nCapEff:\t{cap_eff}\n").encode()


def _cgroup(container_id=CONTAINER_ID):
    return f"0::/system.slice/docker/{container_id}\n".encode("ascii")


def _mount_row(mount_id, device, root, point, *, options="ro,relatime", fstype="ext4",
               source="/dev/test", super_options="rw,relatime"):
    def escaped(value):
        return value.replace("\\", "\\134").replace(" ", "\\040")

    return (f"{mount_id} 1 {device} {escaped(root)} {escaped(point)} {options} shared:1 "
            f"- {fstype} {escaped(source)} {super_options}\n").encode("ascii")


def _valid_mounts():
    helper = b"".join([
        _mount_row(1, "0:0", "/Windows/source", "/candidate", fstype="9p",
                   source="/host_mnt/e/source", super_options="rw,relatime"),
        _mount_row(2, "8:1", "/fullmag/state", "/reference", source="/dev/test"),
        _mount_row(3, "16:0", "/control", "/control", source="/dev/control"),
        _mount_row(4, "17:0", "/ledger", "/ledger", source="/dev/ledger"),
    ])
    target = _mount_row(10, "0:0", "/Windows/source", REQUEST["destination"],
                        options="rw,relatime", fstype="9p", source="/host_mnt/e/source",
                        super_options="rw,relatime")
    return helper, target


def _stat_record(device, inode, kind, *, nlink=None, size=4096, mode=None):
    if mode is None:
        mode = stat.S_IFDIR | 0o755 if kind == "directory" else stat.S_IFREG | 0o444
    if nlink is None:
        nlink = 2 if kind == "directory" else 1
    return {
        "device": device,
        "inode": inode,
        "type": kind,
        "nlink": nlink,
        "size": size,
        "mode": mode,
        "mtime_ns": 123456,
        "ctime_ns": 456789,
        "uid": 1002,
        "gid": 1003,
    }


def _vpd_hex():
    descriptor = b"\x01\x03\x00\x08FMAG0001"
    page = b"\x00\x83" + len(descriptor).to_bytes(2, "big") + descriptor
    return page.hex()


def _valid_result():
    helper_rows, target_row = _valid_mounts()
    helper_parsed = probe._parse_mountinfo(helper_rows)
    target_parsed = probe._parse_mountinfo(target_row)
    directory = stat.S_IFDIR | 0o755
    marker = _stat_record(2049, 200, "regular-file", size=23)
    candidate = _stat_record(0, 300, "directory")
    reference = {
        "device": 2049,
        "inode": 100,
        "mode": directory,
        "marker_sha256_before": MARKER_SHA,
        "marker_sha256_after": MARKER_SHA,
        "marker_size": 23,
        "marker_stat_before": marker,
        "marker_stat_after": copy.deepcopy(marker),
    }
    process = {
        "start_ticks_before": "98765",
        "start_ticks_after": "98765",
        "cgroup_lines_before": [f"0::/system.slice/docker/{CONTAINER_ID}"],
        "cgroup_lines_after": [f"0::/system.slice/docker/{CONTAINER_ID}"],
        "status_uid_before": [1002] * 4,
        "status_uid_after": [1002] * 4,
        "status_gid_before": [1003] * 4,
        "status_gid_after": [1003] * 4,
        "cap_prm_before": "0000000000000000",
        "cap_prm_after": "0000000000000000",
        "cap_eff_before": "0000000000000000",
        "cap_eff_after": "0000000000000000",
        "mnt_namespace_before": "mnt:[4026533001]",
        "mnt_namespace_after": "mnt:[4026533001]",
        "user_namespace_before": "user:[4026533002]",
        "user_namespace_after": "user:[4026533002]",
        "observer_user_namespace_before": "user:[4026533002]",
        "observer_user_namespace_after": "user:[4026533002]",
        "root_cookie_before": {"device": 18 << 8, "inode": 1, "mode": directory},
        "root_cookie_after": {"device": 18 << 8, "inode": 1, "mode": directory},
    }
    return {
        "schema": probe.PROBE_SCHEMA,
        "decision": "observed",
        "request": copy.deepcopy(REQUEST),
        "process": process,
        "reference": reference,
        "protected": {
            "reference": {"device": 2049, "inode": 100, "major": 8, "minor": 1,
                          "vpd83_hex": _vpd_hex()},
            "control": {"device": 4096, "inode": 300, "major": 16, "minor": 0,
                        "vpd83_hex": _vpd_hex()},
            "ledger": {"device": 4352, "inode": 400, "major": 17, "minor": 0,
                       "vpd83_hex": _vpd_hex()},
        },
        "mounts": {
            "helper_mountinfo_sha256_before": "c" * 64,
            "helper_mountinfo_sha256_after": "c" * 64,
            "target_mountinfo_sha256_before": "d" * 64,
            "target_mountinfo_sha256_after": "d" * 64,
            "helper_candidate": helper_parsed[0],
            "helper_reference": helper_parsed[1],
            "helper_control": helper_parsed[2],
            "helper_ledger": helper_parsed[3],
            "target_destination": target_parsed[0],
            "helper_candidate_nested": [],
            "helper_reference_nested": [],
            "target_destination_nested": [],
        },
        "candidate_stat_before": candidate,
        "candidate_stat_after": copy.deepcopy(candidate),
        "actual_stat_before": copy.deepcopy(candidate),
        "actual_stat_after": copy.deepcopy(candidate),
        "nested_evidence": [],
    }


def _valid_nested_result():
    result = _valid_result()
    result["request"] = copy.deepcopy(NESTED_REQUEST)
    nested_destination = NESTED_MOUNT["destination"]
    nested_device = os.makedev(16, 0)
    helper_rows = probe._parse_mountinfo(b"".join([
        _mount_row(1, "0:0", "/Windows/source", "/candidate", fstype="9p",
                   source="/host_mnt/e/source", super_options="rw,relatime"),
        _mount_row(2, "8:1", "/fullmag/state", "/reference", source="/dev/test"),
        _mount_row(3, "16:0", "/fullmag/control", "/control", source="/dev/control"),
        _mount_row(4, "16:0", "/fullmag/ledger", "/ledger", source="/dev/ledger"),
        _mount_row(5, "16:0", "/runtime-services", "/nested-0", source=NESTED_SOURCE),
    ]))
    target_rows = probe._parse_mountinfo(b"".join([
        _mount_row(10, "0:0", "/Windows/source", REQUEST["destination"],
                   options="rw,relatime", fstype="9p", source="/host_mnt/e/source",
                   super_options="rw,relatime"),
        _mount_row(11, "16:0", "/runtime-services", nested_destination,
                   options="rw,relatime", source="/dev/runtime-services"),
    ]))
    result["protected"]["control"] = {
        "device": nested_device, "inode": 300, "major": 16, "minor": 0,
        "vpd83_hex": _vpd_hex(),
    }
    result["protected"]["ledger"] = {
        "device": nested_device, "inode": 400, "major": 16, "minor": 0,
        "vpd83_hex": _vpd_hex(),
    }
    result["mounts"].update({
        "helper_control": helper_rows[2],
        "helper_ledger": helper_rows[3],
        "target_destination_nested": [target_rows[1]],
    })
    before = _stat_record(nested_device, 500, "directory")
    after = copy.deepcopy(before)
    after["size"] += 4096
    after["mtime_ns"] += 100
    fresh_before = copy.deepcopy(before)
    fresh_after = copy.deepcopy(after)
    result["nested_evidence"] = [{
        "mount": copy.deepcopy(NESTED_MOUNT),
        "actual_stat_before": before,
        "actual_stat_after": after,
        "fresh_stat_before": fresh_before,
        "fresh_stat_after": fresh_after,
        "actual_mount": target_rows[1],
        "fresh_mount": helper_rows[4],
    }]
    return result


class ProbeParserTests(unittest.TestCase):
    def test_probe_source_is_self_contained_python_and_never_reads_process_payloads(self):
        compile(probe.PROBE_SOURCE, "<docker-windows-bind-probe>", "exec")
        namespace = {"__name__": "probe_generated_test"}
        exec(probe.PROBE_SOURCE, namespace)
        self.assertEqual(namespace["_validate_request"](NESTED_REQUEST), NESTED_REQUEST)
        self.assertEqual(namespace["MAX_NESTED_MOUNTS"], 16)
        for forbidden in ("/mem", "/environ", "/fd", "/maps", "subprocess", "socket"):
            self.assertNotIn(forbidden, probe.PROBE_SOURCE)
        self.assertIn("O_PATH | os.O_NOFOLLOW", probe.PROBE_SOURCE)
        self.assertIn("/proc/", probe.PROBE_SOURCE)

    def test_destination_parser_accepts_canonical_posix_path_and_rejects_ambiguity(self):
        self.assertEqual(probe._destination_components("/app/data"), ["app", "data"])
        for path in ("relative", "/", "//host/path", "/a//b", "/a/./b", "/a/../b",
                     "/a/", "/a\\b", "/a\x00b", "/a\u202eb"):
            with self.subTest(path=repr(path)):
                with self.assertRaises(ValueError):
                    probe._destination_components(path)

    def test_pid_stat_parser_handles_parentheses_and_pins_start_ticks(self):
        parsed = probe._parse_pid_stat(_proc_stat(), 2345)
        self.assertEqual(parsed, {"pid": 2345, "start_ticks": "98765"})
        self.assertNotEqual(parsed, probe._parse_pid_stat(_proc_stat(start=98766), 2345))
        with self.assertRaises(ValueError):
            probe._parse_pid_stat(_proc_stat(pid=2346), 2345)

    def test_status_parser_extracts_four_uid_gid_values_and_capability_masks(self):
        parsed = probe._parse_process_status(_status())
        self.assertEqual(parsed["uid"], [1002] * 4)
        self.assertEqual(parsed["gid"], [1003] * 4)
        for raw in (_status(uid=1001), _status(gid=1004), _status(cap_prm="0000000000000001"),
                    _status(cap_eff="0000000000000001")):
            with self.subTest(raw=raw):
                parsed = probe._parse_process_status(raw)
                self.assertTrue(any(item != 1002 for item in parsed["uid"])
                                or any(item != 1003 for item in parsed["gid"])
                                or parsed["cap_prm"] != "0000000000000000"
                                or parsed["cap_eff"] != "0000000000000000")

    def test_process_identity_guard_requires_uid_gid_parity_zero_caps_and_same_userns(self):
        request = probe._validate_request(REQUEST)
        status = probe._parse_process_status(_status())
        snapshot = {
            "status_uid": status["uid"],
            "status_gid": status["gid"],
            "cap_prm": status["cap_prm"],
            "cap_eff": status["cap_eff"],
            "user_namespace": "user:[4026531837]",
            "observer_user_namespace": "user:[4026531837]",
        }
        probe._assert_process_identity(snapshot, request)
        for change in ({"status_uid": [1001] * 4}, {"status_gid": [1004] * 4},
                       {"cap_prm": "0000000000000001"},
                       {"cap_eff": "0000000000000001"},
                       {"observer_user_namespace": "user:[4026539999]"}):
            with self.subTest(change=change):
                changed = dict(snapshot)
                changed.update(change)
                with self.assertRaises(ValueError):
                    probe._assert_process_identity(changed, request)

    def test_cgroup_requires_one_exact_full_id_component_and_rejects_prefix(self):
        self.assertEqual(probe._parse_cgroup(_cgroup(), CONTAINER_ID),
                         [f"0::/system.slice/docker/{CONTAINER_ID}"])
        with self.assertRaises(ValueError):
            probe._parse_cgroup(_cgroup("a" * 63 + "b"), CONTAINER_ID)
        with self.assertRaises(ValueError):
            probe._parse_cgroup(f"0::/system.slice/../{CONTAINER_ID}\n".encode(), CONTAINER_ID)

    def test_actual_desktop_cgroup_namespace_parent_and_9p_options(self):
        raw = f"0::/../{CONTAINER_ID}\n".encode()
        self.assertEqual(probe._parse_cgroup(raw, CONTAINER_ID), [raw.decode().strip()])
        # This is a cgroup namespace-relative observation, never an input path.
        with self.assertRaises(ValueError):
            probe._parse_cgroup(f"0::/../../{CONTAINER_ID}\n".encode(), CONTAINER_ID)
        row = _mount_row(5, "0:148", "/git/task", "/candidate", fstype="9p",
                         source="C:\\", super_options=r"rw,aname=drvfs;path=C:\;uid=0;gid=0;metadata;symlinkroot=/mnt/host/,cache=0x5,access=client,msize=65536,trans=fd,rfd=5,wfd=5")
        parsed = probe._parse_mountinfo(row)[0]
        self.assertEqual(parsed['fstype'], '9p')
        probe._validate_mount_row(parsed, 'candidate', '/candidate')

    def test_mountinfo_preserves_exact_source_options_and_rejects_malformed_rows(self):
        helper, _target = _valid_mounts()
        rows = probe._parse_mountinfo(helper)
        self.assertEqual(rows[0]["fstype"], "9p")
        self.assertEqual(rows[0]["source"], "/host_mnt/e/source")
        self.assertEqual(rows[0]["options"], "ro,relatime")
        self.assertEqual(rows[0]["super_options"], "rw,relatime")
        with self.assertRaises(ValueError):
            probe._parse_mountinfo(helper.replace(b"/candidate", b"/candidate/../escape"))
        escaped = _mount_row(5, "8:1", "/root with space", "/path with space")
        with self.assertRaises(ValueError):
            probe._parse_mountinfo(escaped.replace(b"\\040", b"\\999"))

    def test_mount_selector_requires_exact_rows_matching_root_device_and_no_nested_mounts(self):
        helper, target = _valid_mounts()
        selected = probe._select_mount_rows(probe._parse_mountinfo(helper),
                                            probe._parse_mountinfo(target), REQUEST["destination"])
        self.assertEqual(selected["helper_candidate"]["root"], "/Windows/source")
        self.assertEqual(selected["target_destination"]["root"], "/Windows/source")
        selected_ro = probe._select_mount_rows(
            probe._parse_mountinfo(helper),
            probe._parse_mountinfo(target.replace(b"rw,relatime", b"ro,relatime")),
            REQUEST["destination"],
        )
        self.assertIn("ro", selected_ro["target_destination"]["options"].split(","))
        for malformed in (b"ro,rw,relatime", b"relatime"):
            with self.subTest(target_options=malformed):
                with self.assertRaisesRegex(ValueError, "exactly one ro/rw"):
                    probe._select_mount_rows(
                        probe._parse_mountinfo(helper),
                        probe._parse_mountinfo(target.replace(b"rw,relatime", malformed)),
                        REQUEST["destination"],
                    )
        with self.assertRaisesRegex(ValueError, "9p Windows bind"):
            probe._select_mount_rows(
                probe._parse_mountinfo(helper.replace(b"- 9p ", b"- ext4 ", 1)),
                probe._parse_mountinfo(target), REQUEST["destination"],
            )
        with self.assertRaisesRegex(ValueError, "not read-only"):
            probe._select_mount_rows(
                probe._parse_mountinfo(helper.replace(b"ro,relatime", b"ro,rw,relatime", 1)),
                probe._parse_mountinfo(target), REQUEST["destination"],
            )
        nested = helper + _mount_row(9, "0:0", "/Windows/source/sub", "/candidate/sub",
                                     fstype="9p", source="/host_mnt/e/source/sub")
        with self.assertRaisesRegex(ValueError, "nested mounts"):
            probe._select_mount_rows(probe._parse_mountinfo(nested),
                                     probe._parse_mountinfo(target), REQUEST["destination"])

    def test_vpd83_parser_accepts_complete_page_and_rejects_malformed_lengths(self):
        good = bytes.fromhex(_vpd_hex())
        self.assertEqual(probe._validate_vpd83(good), good)
        for raw in (b"", b"\x00\x83\x00\x0c\x01", b"\x00\x82\x00\x01X",
                    b"\x00\x83\x00\x01X", b"\x00\x83\x00\x04\x01\x03\x00\x00"):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    probe._validate_vpd83(raw)

    def test_valid_result_round_trips_and_preserves_target_mount_evidence(self):
        result = _valid_result()
        raw = json.dumps(result, sort_keys=True).encode("utf-8")
        self.assertEqual(probe.validate_probe_result(raw, **REQUEST), result)
        self.assertIn("rw", result["mounts"]["target_destination"]["options"])
        self.assertEqual(set(result["protected"]), {"reference", "control", "ledger"})

    def test_result_validator_rejects_pid_reuse_uid_capability_namespace_and_mount_drift(self):
        mutations = [
            ("process", "start_ticks_after", "99999"),
            ("process", "status_uid_after", [999] * 4),
            ("process", "cap_eff_after", "0000000000000001"),
            ("process", "user_namespace_after", "user:[4026533999]"),
            ("mounts", "target_mountinfo_sha256_after", "e" * 64),
            ("mounts", "helper_candidate_nested", [{"mountpoint": "/candidate/nested"}]),
        ]
        for group, key, value in mutations:
            with self.subTest(group=group, key=key):
                result = _valid_result()
                result[group][key] = value
                with self.assertRaises(ValueError):
                    probe.validate_probe_result(json.dumps(result).encode(), **REQUEST)

    def test_result_validator_rejects_mismatched_container_request_and_vpd(self):
        cases = []
        changed = _valid_result()
        changed["request"]["pid"] += 1
        cases.append(changed)
        changed = _valid_result()
        changed["protected"]["ledger"]["vpd83_hex"] = "00"
        cases.append(changed)
        changed = _valid_result()
        changed["mounts"]["target_destination"]["root"] = "/other/root"
        cases.append(changed)
        for result in cases:
            with self.subTest(result=result):
                with self.assertRaises(ValueError):
                    probe.validate_probe_result(json.dumps(result).encode(), **REQUEST)

    def test_result_validator_accepts_target_ro_or_rw_and_rejects_ambiguous_modes(self):
        for options in ("ro,relatime", "rw,relatime"):
            result = _valid_result()
            result["mounts"]["target_destination"]["options"] = options
            self.assertEqual(probe.validate_probe_result(json.dumps(result).encode(), **REQUEST), result)
        for options in ("ro,rw,relatime", "relatime"):
            with self.subTest(options=options):
                result = _valid_result()
                result["mounts"]["target_destination"]["options"] = options
                with self.assertRaisesRegex(ValueError, "exactly one ro/rw"):
                    probe.validate_probe_result(json.dumps(result).encode(), **REQUEST)
        result = _valid_result()
        result["mounts"]["target_destination"]["fstype"] = "ext4"
        with self.assertRaises(ValueError):
            probe.validate_probe_result(json.dumps(result).encode(), **REQUEST)
        result = _valid_result()
        result["mounts"]["helper_candidate"]["options"] = "ro,rw,relatime"
        with self.assertRaisesRegex(ValueError, "not read-only"):
            probe.validate_probe_result(json.dumps(result).encode(), **REQUEST)

    def test_request_and_json_schema_are_strict(self):
        for changes in ({"extra": True}, {"pid": True}, {"uid": "1002"},
                        {"destination": "/etc/../passwd"}, {"container_id": "a" * 63}):
            request = dict(REQUEST)
            request.update(changes)
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    probe._validate_request(request)
        duplicate = b'{"decision":"observed","decision":"observed"}'
        with self.assertRaises(ValueError):
            probe.validate_probe_result(duplicate, **REQUEST)

    def test_nested_volume_request_is_exact_sorted_bounded_and_canonical(self):
        self.assertEqual(probe._validate_request(NESTED_REQUEST)["nested_mounts"], [NESTED_MOUNT])
        mutations = []
        for key, value in (("type", "bind"), ("destination", "/other/runtime-services"),
                           ("source", "/var/lib/docker/../escape"), ("name", "../unsafe"),
                           ("rw", 1), ("probe_path", "/nested-9")):
            changed = copy.deepcopy(NESTED_REQUEST)
            changed["nested_mounts"][0][key] = value
            mutations.append(changed)
        changed = copy.deepcopy(NESTED_REQUEST)
        changed["nested_mounts"].append(copy.deepcopy(NESTED_MOUNT))
        mutations.append(changed)
        changed = copy.deepcopy(NESTED_REQUEST)
        changed["nested_mounts"] = [
            {**NESTED_MOUNT, "destination": REQUEST["destination"] + "/z", "probe_path": "/nested-0"},
            {**NESTED_MOUNT, "destination": REQUEST["destination"] + "/a", "probe_path": "/nested-1"},
        ]
        mutations.append(changed)
        changed = copy.deepcopy(NESTED_REQUEST)
        changed["nested_mounts"] = [
            {**NESTED_MOUNT, "destination": REQUEST["destination"] + f"/d{index:02}",
             "probe_path": f"/nested-{index}"}
            for index in range(probe.MAX_NESTED_MOUNTS + 1)
        ]
        mutations.append(changed)
        for request in mutations:
            with self.subTest(request=request):
                with self.assertRaises(ValueError):
                    probe._validate_request(request)

    def test_named_nested_volume_selection_requires_exact_target_set_and_ro_helper_alias(self):
        result = _valid_nested_result()
        mounts = result["mounts"]
        helper_rows = [mounts[key] for key in (
            "helper_candidate", "helper_reference", "helper_control", "helper_ledger")
        ] + [result["nested_evidence"][0]["fresh_mount"]]
        target_rows = [mounts["target_destination"], *mounts["target_destination_nested"]]
        selected = probe._select_mount_rows(helper_rows, target_rows, REQUEST["destination"],
                                           NESTED_REQUEST["nested_mounts"])
        self.assertEqual(selected["target_destination_nested"][0]["mountpoint"],
                         NESTED_MOUNT["destination"])
        self.assertEqual(selected["helper_nested_mounts"]["/nested-0"]["options"], "ro,relatime")
        ro_item = {**NESTED_MOUNT, "rw": False}
        ro_target_rows = copy.deepcopy(target_rows)
        ro_target_rows[1]["options"] = "ro,relatime"
        probe._select_mount_rows(helper_rows, ro_target_rows, REQUEST["destination"], [ro_item])
        with self.assertRaisesRegex(ValueError, "mode differs"):
            probe._select_mount_rows(helper_rows, ro_target_rows, REQUEST["destination"],
                                     NESTED_REQUEST["nested_mounts"])
        changed_targets = [target_rows[:-1]]
        for fstype in ("tmpfs", "9p"):
            changed_targets.append(target_rows + [probe._parse_mountinfo(_mount_row(
                12, "16:0", "/other", NESTED_MOUNT["destination"] + "/unknown",
                fstype=fstype))[0]])
        for target_set in changed_targets:
            with self.subTest(targets=target_set):
                with self.assertRaisesRegex(ValueError, "exactly match"):
                    probe._select_mount_rows(helper_rows, target_set, REQUEST["destination"],
                                             NESTED_REQUEST["nested_mounts"])
        changed_helpers = helper_rows[:-1] + [
            probe._parse_mountinfo(_mount_row(
                5, "16:0", "/runtime-services", "/nested-0", options="ro,rw,relatime"))[0]
        ]
        with self.assertRaisesRegex(ValueError, "not read-only"):
            probe._select_mount_rows(changed_helpers, target_rows, REQUEST["destination"],
                                     NESTED_REQUEST["nested_mounts"])
        with self.assertRaisesRegex(ValueError, "unrequested"):
            probe._select_mount_rows(helper_rows + [
                probe._parse_mountinfo(_mount_row(12, "16:0", "/other", "/nested-9"))[0]
            ], target_rows, REQUEST["destination"], NESTED_REQUEST["nested_mounts"])

    def test_nested_runtime_services_volume_evidence_accepts_sibling_and_rejects_drift(self):
        result = _valid_nested_result()
        self.assertEqual(probe.validate_probe_result(json.dumps(result).encode(), **NESTED_REQUEST), result)
        ro_request = copy.deepcopy(NESTED_REQUEST)
        ro_request["nested_mounts"][0]["rw"] = False
        ro_result = _valid_nested_result()
        ro_result["request"] = copy.deepcopy(ro_request)
        ro_result["nested_evidence"][0]["mount"] = copy.deepcopy(ro_request["nested_mounts"][0])
        ro_result["nested_evidence"][0]["actual_mount"]["options"] = "ro,relatime"
        ro_result["mounts"]["target_destination_nested"][0]["options"] = "ro,relatime"
        self.assertEqual(probe.validate_probe_result(json.dumps(ro_result).encode(), **ro_request), ro_result)
        mutations = []
        changed = copy.deepcopy(result)
        changed["nested_evidence"][0]["actual_stat_after"]["inode"] += 1
        mutations.append(changed)
        changed = copy.deepcopy(result)
        changed["nested_evidence"][0]["actual_stat_before"]["device"] = os.makedev(16, 1)
        mutations.append(changed)
        changed = copy.deepcopy(result)
        changed["nested_evidence"][0]["mount"]["source"] = "/var/lib/docker/volumes/other/_data"
        mutations.append(changed)
        changed = copy.deepcopy(result)
        changed["nested_evidence"] = []
        mutations.append(changed)
        changed = copy.deepcopy(result)
        changed["nested_evidence"].append(copy.deepcopy(changed["nested_evidence"][0]))
        mutations.append(changed)
        changed = copy.deepcopy(result)
        changed["mounts"]["target_destination_nested"] = []
        mutations.append(changed)
        for root in ("/fullmag", "/fullmag/control/runtime-services"):
            changed = copy.deepcopy(result)
            nested = changed["nested_evidence"][0]
            nested["actual_mount"]["root"] = root
            nested["fresh_mount"]["root"] = root
            changed["mounts"]["target_destination_nested"][0]["root"] = root
            mutations.append(changed)
        for malformed in mutations:
            with self.subTest(malformed=malformed):
                with self.assertRaises(ValueError):
                    probe.validate_probe_result(json.dumps(malformed).encode(), **NESTED_REQUEST)


if __name__ == "__main__":
    unittest.main()
