"""Interpreted relocation request/mount/consumer checks; no Docker lifecycle."""
from __future__ import annotations

import copy
from pathlib import Path
from types import SimpleNamespace
import unittest
import json
from unittest.mock import patch

from docker_build_control import BuildControlError
import docker_group_ledger_relocation as relocation


class LedgerRelocationRequestTests(unittest.TestCase):
    def setUp(self):
        self.control = SimpleNamespace(project="fullmag-worktree-test", volume="fullmag-control-test",
            namespace="", identity={"source_root": "/sources/antenna"}, subpath=lambda value: value)
        self.request = {"schema": relocation.SCHEMA, "compose_project": self.control.project,
            "control_volume": self.control.volume, "source_root": "/sources/antenna", "source_commit": "a" * 40,
            "daemon_id_sha256": "b" * 64, "host_id": "c" * 64,
            "source_volume": "fullmag-dev-group-ledger-v1-source", "target_subpath": "private/ledger",
            "source_volume_sha256": "d" * 64, "target_volume_sha256": "e" * 64,
            "logical_root": "/host-ledger/ledger", "copy_script_sha256": "f" * 64,
            "expected_inspection": {"schema_version": relocation.INSPECTION, "host_id": "c" * 64},
            "native_program": {"image_id": "sha256:" + "1" * 64, "package_volume": "fullmag-shared-packages-test",
                "package_subpath": "groups/" + "2" * 64,
                "candidate": "/opt/fullmag/package/.development/candidates/.backend-package-candidate-fixed",
                "receipt_sha256": "3" * 64, "cli_sha256": "4" * 64},
            "bootstrap": {"terminal_path": "group-ledger-bootstrap/attempts/" + "5" * 32 + "/terminal.json",
                "terminal_sha256": "6" * 64, "result_path": "group-ledger-bootstrap/attempts/" + "5" * 32 + "/result.json",
                "result_sha256": "7" * 64, "container_id": "8" * 64, "started_at": "2026-11-01T00:00:00Z"}}

    def test_exact_request_is_preserved_and_never_mutated(self):
        before = copy.deepcopy(self.request)
        self.assertIs(relocation.validate_request(self.control, self.request), self.request)
        self.assertEqual(before, self.request)

    def test_uninspected_source_is_allowed_only_for_read_only_preview(self):
        self.request["expected_inspection"] = None
        with self.assertRaisesRegex(BuildControlError, "inspection is required"):
            relocation.validate_request(self.control, self.request)
        relocation.validate_request(self.control, self.request, allow_uninspected=True)

    def test_foreign_group_and_paths_are_refused(self):
        for key, value in (("compose_project", "foreign"), ("control_volume", "foreign"),
                           ("source_root", "/sources/other"), ("target_subpath", "private/backend"),
                           ("logical_root", "/target/ledger"), ("source_volume", self.control.volume)):
            with self.subTest(key=key):
                request = copy.deepcopy(self.request)
                request[key] = value
                with self.assertRaises(BuildControlError):
                    relocation.validate_request(self.control, request)

    def test_unknown_fields_and_noncanonical_hashes_are_refused(self):
        for key, value in (("extra", True), ("host_id", "C" * 64), ("source_commit", "a" * 12),
                           ("source_volume_sha256", "latest"), ("daemon_id_sha256", True)):
            request = copy.deepcopy(self.request)
            request[key] = value
            with self.assertRaises(BuildControlError):
                relocation.validate_request(self.control, request)

    def test_native_program_cannot_escape_its_candidate_or_package_view(self):
        for key, value in (("image_id", "latest"), ("candidate", "/bin/fullmag"),
                           ("candidate", "/opt/fullmag/package/.development/candidates/../fullmag"),
                           ("package_subpath", "groups/../foreign"), ("package_volume", "other,readonly")):
            request = copy.deepcopy(self.request)
            request["native_program"][key] = value
            with self.assertRaises(BuildControlError):
                relocation.validate_request(self.control, request)

    def test_bootstrap_records_are_exactly_one_operation(self):
        for key, value in (("terminal_path", "development/current.json"),
                           ("result_path", "group-ledger-bootstrap/attempts/" + "9" * 32 + "/result.json"),
                           ("container_id", "short-id"), ("started_at", "")):
            request = copy.deepcopy(self.request)
            request["bootstrap"][key] = value
            with self.assertRaises(BuildControlError):
                relocation.validate_request(self.control, request)

    def test_failed_current_start_cannot_hide_last_successful_ledger_history(self):
        attempt = "a" * 32
        records = {"development/current.json": {"attempt": "b" * 32, "state": "failed-confirmed"},
            "development/verified.json": {"attempt": attempt, "state": "succeeded", "compose_project": self.control.project},
            "development/attempts/" + attempt + "/group-ledger.json": {"schema": "fullmag.docker-group-ledger.v1",
                "compose_project": self.control.project, "daemon_id_sha256": self.request["daemon_id_sha256"],
                "volume_name": self.request["source_volume"]}}
        self.control.read = lambda name, optional=False: records.get(name)
        with self.assertRaisesRegex(BuildControlError, "fresh initialization refused"):
            relocation.admit_migrated_ledger(self.control, {"receipt": {}}, self.request["daemon_id_sha256"])
        records["development/verified.json"]["compose_project"] = "foreign"
        with self.assertRaisesRegex(BuildControlError, "authority is malformed"):
            relocation.admit_migrated_ledger(self.control, {"receipt": {}}, self.request["daemon_id_sha256"])

    def test_active_consumers_refuse_both_source_and_control_volumes(self):
        for volume in (self.request["source_volume"], self.request["control_volume"]):
            row = {"Id": "active", "State": {"Running": True}, "Mounts": [{"Type": "volume", "Name": volume}]}
            with self.assertRaisesRegex(BuildControlError, "active consumer"):
                relocation.assert_no_consumers(self.request, [row])
            relocation.assert_no_consumers(self.request, [row], ["active"])
            row["State"]["Running"] = False
            relocation.assert_no_consumers(self.request, [row])
        relocation.assert_no_consumers(self.request, [{"Id": "other", "State": {"Running": True},
            "Mounts": [{"Type": "volume", "Name": "unrelated"}]}])

    def test_legacy_history_requires_receipt_before_any_fresh_initializer(self):
        attempt = "a" * 32
        records = {"development/current.json": {"attempt": attempt, "ledger_profile": "group-ledger-v1"},
            "development/attempts/" + attempt + "/group-ledger.json": {
                "schema": "fullmag.docker-group-ledger.v1", "compose_project": self.control.project,
                "daemon_id_sha256": self.request["daemon_id_sha256"], "volume_name": self.request["source_volume"],
                "host_id": self.request["host_id"]}}
        self.control.read = lambda key, optional=False: records.get(key)
        operation = {"root": "development/attempts/" + "b" * 32, "receipt": {}}
        with patch.object(relocation, "bounded_capture") as native:
            with self.assertRaisesRegex(BuildControlError, "fresh initialization refused"):
                relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
            native.assert_not_called()
        records.pop("development/attempts/" + attempt + "/group-ledger.json")
        with self.assertRaisesRegex(BuildControlError, "record is missing"):
            relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
        records.clear()
        relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])

    def test_adoption_publishes_pin_only_after_exact_native_target_preview(self):
        attempt = "a" * 32
        inspection = self.request["expected_inspection"]
        inspection.update(semantic_snapshot_sha256="a" * 64, manifest_sha256="b" * 64)
        release = {"schema_version": "fullmag.group-ledger-relocation-fence-release.v1", "status": "revalidated",
            "semantic_snapshot_sha256": inspection["semantic_snapshot_sha256"], "manifest_sha256": inspection["manifest_sha256"]}
        preview = {"schema_version": "fullmag.group-ledger-relocation-preview.v1", "status": "verified",
            "inspection": inspection, "expected_inspection_sha256": relocation.sha(relocation.canonical(inspection))}
        receipt = {"schema": relocation.SCHEMA, "state": "verified", "request": self.request,
            "source_inspection": inspection, "source_release": release, "target_preview": preview}
        receipt_path = "group-ledger-relocation/attempts/" + "c" * 32 + "/relocation.json"
        pointer = {"schema": relocation.SCHEMA, "receipt_path": receipt_path,
            "receipt_sha256": relocation.sha(relocation.canonical(receipt))}
        records = {"development/current.json": {"attempt": attempt},
            "development/attempts/" + attempt + "/group-ledger.json": {
                "schema": "fullmag.docker-group-ledger.v1", "compose_project": self.control.project,
                "daemon_id_sha256": self.request["daemon_id_sha256"], "volume_name": self.request["source_volume"],
                "host_id": self.request["host_id"]},
            receipt_path: receipt}
        publication = {"schema": "fullmag.docker-build-operation.v1", "phase": "group-ledger-relocation",
            "state": "succeeded", "attempt": "c" * 32, "compose_project": self.control.project,
            "control_volume": self.control.volume, "inputs": {"source_root": self.control.identity["source_root"]},
            "runtime_started": False, "solve_started": False,
            "relocation_receipt": receipt_path, "relocation_sha256": pointer["receipt_sha256"]}
        records["group-ledger-relocation/current.json"] = publication
        records["group-ledger-relocation/attempts/" + "c" * 32 + "/terminal.json"] = copy.deepcopy(publication)
        self.control.read = lambda key, optional=False: records.get(key)
        self.control.write = lambda key, value: records.update({key: value})
        self.control.write_bytes = lambda key, value: records.update({key: value})
        self.control.path = lambda key: "/control/" + key
        operation = {"root": "development/attempts/" + "d" * 32, "receipt": {}}
        with patch.object(relocation, "_helper", return_value=["pinned-helper"]), patch.object(relocation, "bounded_capture",
                return_value=SimpleNamespace(returncode=0, stdout=json.dumps(preview).encode())):
            relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
        self.assertEqual(operation["receipt"]["group_ledger_relocation"],
            {key: pointer[key] for key in ("receipt_path", "receipt_sha256")})
        operation["receipt"].clear()
        bad = {**preview, "inspection": {**inspection, "manifest_sha256": "e" * 64}}
        with patch.object(relocation, "_helper", return_value=["pinned-helper"]), patch.object(relocation, "bounded_capture",
                return_value=SimpleNamespace(returncode=0, stdout=json.dumps(bad).encode())):
            with self.assertRaisesRegex(BuildControlError, "startup preview differs"):
                relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
        self.assertNotIn("group_ledger_relocation", operation["receipt"])

        # A partial attempt cannot skip the native check just because it has a pin.
        own_pin = {key: pointer[key] for key in ("receipt_path", "receipt_sha256")}
        operation["receipt"]["group_ledger_relocation"] = own_pin
        records[operation["root"] + "/group-ledger.json"] = {"volume_name": self.control.volume,
                                                               "host_id": self.request["host_id"]}
        with patch.object(relocation, "_helper", return_value=["pinned-helper"]), patch.object(relocation, "bounded_capture",
                return_value=SimpleNamespace(returncode=1)) as native:
            with self.assertRaisesRegex(BuildControlError, "refused relocated history"):
                relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
            native.assert_called_once()
        records["development/attempts/" + attempt + "/group-ledger.json"]["volume_name"] = self.control.volume
        self.control.helper_args = lambda script: ["docker", "--entrypoint", "sh", "image", "-c", script]
        with patch.object(relocation, "bounded_capture", return_value=SimpleNamespace(returncode=1)):
            with self.assertRaisesRegex(BuildControlError, "missing or uninitialized"):
                relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
        with patch.object(relocation, "bounded_capture", return_value=SimpleNamespace(returncode=0)) as check:
            relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
            check.assert_called_once()  # Normal native admission owns later package versions.
        records["development/current.json"]["group_ledger_relocation"] = {**own_pin, "receipt_sha256": "0" * 64}
        with self.assertRaisesRegex(BuildControlError, "lineage changed"):
            relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
        records["development/current.json"]["group_ledger_relocation"] = own_pin
        records.pop("group-ledger-relocation/current.json")
        with self.assertRaisesRegex(BuildControlError, "lost its ledger relocation receipt"):
            relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])

    def test_bootstrap_mounts_are_bound_to_exact_package_and_source(self):
        native = self.request["native_program"]
        row = {"Mounts": [], "HostConfig": {"Mounts": []}}
        for target, volume, subpath in (("/opt/fullmag/package", native["package_volume"], native["package_subpath"]),
                                       ("/host-ledger", self.request["source_volume"], "")):
            row["Mounts"].append({"Type": "volume", "Name": volume, "Destination": target, "RW": True, "Driver": "local"})
            row["HostConfig"]["Mounts"].append({"Type": "volume", "Source": volume, "Target": target,
                "VolumeOptions": {"NoCopy": True, **({"Subpath": subpath} if subpath else {})}})
        relocation._validate_bootstrap_mounts(row, self.request)
        for part in ("package", "ledger", "subpath", "nocopy", "readonly", "overlay", "duplicate"):
            with self.subTest(part=part):
                bad = copy.deepcopy(row)
                if part == "package": bad["Mounts"][0]["Name"] = "foreign"
                elif part == "ledger": bad["Mounts"][1]["Name"] = "foreign"
                elif part == "subpath": bad["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = "groups/" + "9" * 64
                elif part == "nocopy": bad["HostConfig"]["Mounts"][1]["VolumeOptions"]["NoCopy"] = False
                elif part == "readonly": bad["Mounts"][0]["RW"] = False
                elif part == "overlay": bad["Mounts"].append({"Destination": "/opt/fullmag/package/bin"})
                else: bad["Mounts"].append(copy.deepcopy(bad["Mounts"][0]))
                with self.assertRaises(BuildControlError): relocation._validate_bootstrap_mounts(bad, self.request)

    def test_existing_private_group_cannot_initialize_missing_or_empty_history(self):
        attempt = "a" * 32
        records = {"development/current.json": {"attempt": attempt},
            "development/attempts/" + attempt + "/group-ledger.json": {
                "schema": "fullmag.docker-group-ledger.v1", "compose_project": self.control.project,
                "daemon_id_sha256": self.request["daemon_id_sha256"], "volume_name": self.control.volume,
                "host_id": self.request["host_id"]}}
        self.control.read = lambda key, optional=False: records.get(key)
        self.control.helper_args = lambda script: ["docker", "--entrypoint", "sh", "image", "-c", script]
        operation = {"root": "development/attempts/" + "b" * 32, "receipt": {}}
        with patch.object(relocation, "bounded_capture", return_value=SimpleNamespace(returncode=1)) as native:
            with self.assertRaisesRegex(BuildControlError, "missing or uninitialized"):
                relocation.require_initialized_private_ledger(self.control)
            self.assertIn("readonly", native.call_args.args[0][2])
        with patch.object(relocation, "bounded_capture", return_value=SimpleNamespace(returncode=0)):
            relocation.require_initialized_private_ledger(self.control)
        with patch.object(relocation, "bounded_capture") as native:
            relocation.admit_migrated_ledger(self.control, operation, self.request["daemon_id_sha256"])
            native.assert_not_called()

    def test_native_command_uses_fixed_root_and_explicit_pinned_program(self):
        command = relocation._native_script(self.request, "ledger-relocation-preview",
            "--expected-inspection", "/control/source.json", "--expected-inspection-sha256", "a" * 64)
        import shlex
        argv = shlex.split(command)
        self.assertEqual(argv[:3], ["python3", "-B", "-c"])
        self.assertEqual(argv[6:12], ["runtime", "ledger-relocation-preview", "--ledger-root",
            "/host-ledger/ledger", "--host-id", "c" * 64])
        self.assertIn("exclude_candidate_marker", argv[3])
        compile(argv[3], "native-program-probe", "exec")



class FreshArchivedLedgerAdmissionTests(unittest.TestCase):
    def setUp(self):
        from pathlib import Path
        self.token = "e" * 32
        self.previous = {"attempt": "a" * 32, "state": "succeeded", "compose_project": "test-group"}
        self.archive = {"preserved_group_ledger_volume": "test-private", "preserved_group_ledger_subpath": "private/ledger",
                        "fresh_group_ledger_device_inode": "8:22", "fresh_group_ledger_role_device_inode": "8:10",
                        "archived_group_ledger_device_inode": "8:11", "archived_group_ledger_owner": "65532:65532"}
        self.generation = {"generation": self.token, "archive_terminal_sha256": relocation.sha(relocation.canonical(self.archive))}
        self.records = {"development/verified.json": self.previous, "group-ledger-generation.json": self.generation,
            "recreate-services/attempts/" + self.token + "/terminal.json": {
                "state": "succeeded", "phase": "recreate-services", "attempt": self.token,
                "compose_project": "test-group", "control_volume": "test-private",
                "inputs": {"attempt": self.previous["attempt"]}, "runtime_control_archive": self.archive}}
        self.operation = {"root": "development/attempts/" + "b" * 32,
            "receipt": {"phase": "development", "attempt": "b" * 32, "compose_project": "test-group",
                        "control_volume": "test-private", "inputs": {"source_root": str(Path(__file__).resolve().parents[1])}}}
        self.control = SimpleNamespace(project="test-group", volume="test-private", namespace="",
            identity={"source_root": str(Path(__file__).resolve().parents[1])}, subpath=lambda value: value, _active_operation=self.operation,
            _assert_live_operation_helper=lambda operation: "helper",
            _inspect_operation_helper=lambda operation, expected_id: expected_id,
            read=lambda name, optional=False: self.records.get(name),
            read_bytes=lambda name, optional=False: relocation.canonical(self.records[name])
                       if name in self.records else None,
            write=lambda name, value: self.records.update({name: copy.deepcopy(value)}))
        self.daemon = "d" * 64

    def candidate(self):
        with patch("docker_volume_fresh_runtime.pinned_group_archive", return_value=self.archive), \
             patch("docker_host_ledger._daemon_info", return_value={"id_sha256": self.daemon}):
            return relocation._fresh_candidate(self.control, self.operation, self.daemon, self.generation, self.previous)

    def test_fresh_admission_error_keeps_exit_code_and_stdout(self):
        result = SimpleNamespace(returncode=127, stderr=b"",
                                 stdout=b"python3: executable file not found")
        with patch.object(relocation, "_fresh_operation", return_value="helper"), \
             patch.object(relocation, "bounded_capture", return_value=result):
            with self.assertRaisesRegex(BuildControlError,
                    r"Fresh ledger admission refused \(exit 127\): python3: executable file not found"):
                relocation._probe_fresh_candidate(self.control, self.operation, {})

    def test_fresh_admission_error_prefers_bounded_stderr(self):
        detail = b"x" * 3000 + b"required-diagnostic"
        result = SimpleNamespace(returncode=1, stderr=detail, stdout=b"unused-output")
        with patch.object(relocation, "_fresh_operation", return_value="helper"), \
             patch.object(relocation, "bounded_capture", return_value=result):
            with self.assertRaises(BuildControlError) as caught:
                relocation._probe_fresh_candidate(self.control, self.operation, {})
        self.assertEqual(str(caught.exception),
                         "Fresh ledger admission refused (exit 1): "
                         + detail.decode()[-2048:])

    def test_fresh_admission_stderr_still_refuses_success_exit(self):
        result = SimpleNamespace(returncode=0, stderr=b"unexpected warning",
                                 stdout=b'{"state":"empty"}')
        with patch.object(relocation, "_fresh_operation", return_value="helper"), \
             patch.object(relocation, "bounded_capture", return_value=result):
            with self.assertRaisesRegex(BuildControlError, r"refused \(exit 0\)"):
                relocation._probe_fresh_candidate(self.control, self.operation, {})

    def test_early_preflight_records_prospective_only_and_initialized_is_ordinary(self):
        candidate = self.candidate()
        with patch.object(relocation, "_fresh_operation", return_value="helper"), \
             patch.object(relocation, "_fresh_candidate", return_value=candidate), \
             patch.object(relocation, "_probe_fresh_candidate", return_value="empty") as probe:
            self.assertTrue(relocation.prepare_fresh_ledger_admission(self.control, self.operation, self.daemon, self.generation, self.previous))
            probe.assert_called_once_with(self.control, self.operation, candidate)
        self.assertEqual(self.operation["receipt"][relocation.FRESH_FIELD], candidate)
        self.assertIn(self.operation["root"] + "/receipt.json", self.records)
        self.assertFalse(any("first-admission" in key for key in self.records))
        self.operation["receipt"].pop(relocation.FRESH_FIELD)
        with patch.object(relocation, "_fresh_operation", return_value="helper"), \
             patch.object(relocation, "_fresh_candidate", return_value=candidate), \
             patch.object(relocation, "_probe_fresh_candidate", return_value="initialized"):
            self.assertFalse(relocation.prepare_fresh_ledger_admission(self.control, self.operation, self.daemon, self.generation, self.previous))
        self.assertNotIn(relocation.FRESH_FIELD, self.operation["receipt"])

    def rotated_failed_predecessor(self):
        old = self.candidate()
        old.update(generation="d" * 32, generation_record={"generation": "d" * 32},
                   operation_attempt=self.previous["attempt"], previous_development_attempt="9" * 32)
        self.previous.update(schema="fullmag.docker-build-operation.v1", phase="development",
            control_volume=self.control.volume, inputs={"source_root": self.control.identity["source_root"]},
            state_root="/retained-state", initialized_group_ledger_readmission={
                "schema": relocation.INITIALIZED_ADMISSION, "candidate": old})
        self.records["development/attempts/" + self.previous["attempt"] + "/terminal.json"] = copy.deepcopy(self.previous)
        failed_id = "c" * 32
        failed = {**copy.deepcopy(self.previous), "attempt": failed_id, "state": "failed-confirmed",
            "backend_container": "1" * 64, "frontend_container": "2" * 64, "config_sha256": "3" * 64}
        failed[relocation.INITIALIZED_FIELD]["candidate"].update(
            operation_attempt=failed_id, previous_development_attempt=self.previous["attempt"])
        self.records["development/attempts/" + failed_id + "/terminal.json"] = failed
        archived = self.records["recreate-services/attempts/" + self.token + "/terminal.json"]
        archived.update(inputs={"attempt": failed_id, "config_sha256": failed["config_sha256"]},
            previous_state_root=self.previous["state_root"],
            removed_containers=[failed["backend_container"], failed["frontend_container"]])
        return failed, archived

    def test_rotated_initialized_history_admits_only_new_unclaimed_generation(self):
        self.rotated_failed_predecessor()
        candidate = self.candidate()
        with patch.object(relocation, "_fresh_operation", return_value="helper"), \
             patch.object(relocation, "_fresh_candidate", return_value=candidate), \
             patch.object(relocation, "_probe_fresh_candidate", return_value="empty"):
            self.assertTrue(relocation.prepare_fresh_ledger_admission(
                self.control, self.operation, self.daemon, self.generation, self.previous))
        self.assertEqual(self.operation["receipt"][relocation.FRESH_FIELD], candidate)
        self.assertNotIn(relocation.INITIALIZED_FIELD, self.operation["receipt"])

    def test_reconciled_interrupted_attempt_has_its_own_archived_root(self):
        import docker_volume_development_interrupted as interrupted
        failed, archived = self.rotated_failed_predecessor()
        candidate = self.candidate()
        previous_path = Path("/managed/docker-volume-dev") / self.previous["attempt"]
        self.previous["state_root"] = str(previous_path)
        self.records["development/attempts/" + self.previous["attempt"] + "/terminal.json"]["state_root"] = str(previous_path)
        path = str(previous_path.parent / failed["attempt"])
        failed["state_root"] = archived["previous_state_root"] = path
        original = {"state_root": path, "state": "starting-services", "attempt": failed["attempt"]}
        original.update({service + "_container": failed[service + "_container"] for service in ("backend", "frontend")})
        sha = relocation.sha(relocation.canonical(original) + b"\n")
        failed["reconciliation"] = {"schema": interrupted.STARTING_SERVICES_SCHEMA, "original_receipt_sha256": sha}
        root = "development/attempts/" + failed["attempt"]
        self.records[root + "/unknown-receipt.json"] = original
        relocation._require_archive_predecessor(self.control, archived, candidate)
        self.records[root + "/unknown-receipt.json"] = {**original, "state_root": "/foreign"}
        with self.assertRaises(BuildControlError):
            relocation._require_archive_predecessor(self.control, archived, candidate)

    def test_rotated_failed_predecessor_requires_exact_archive_and_history(self):
        for kind in ("state", "source", "volume", "state-root", "containers", "old-generation", "previous", "config", "missing"):
            self.setUp()
            failed, archived = self.rotated_failed_predecessor()
            if kind == "state":failed["state"] = "outcome-unknown-resources-retained"
            elif kind == "source":failed["inputs"]["source_root"] = "/foreign"
            elif kind == "volume":failed["control_volume"] = "foreign"
            elif kind == "state-root":archived["previous_state_root"] = "/foreign"
            elif kind == "containers":archived["removed_containers"] = ["4" * 64, "5" * 64]
            elif kind == "old-generation":failed[relocation.INITIALIZED_FIELD]["candidate"]["generation"] = "8" * 32
            elif kind == "previous":failed[relocation.INITIALIZED_FIELD]["candidate"]["previous_development_attempt"] = "7" * 32
            elif kind == "config":failed["config_sha256"] = "4" * 64
            else:self.records.pop("development/attempts/" + failed["attempt"] + "/terminal.json")
            with self.subTest(kind=kind), self.assertRaises(BuildControlError):
                relocation._require_unstarted_generation(self.control, self.candidate())

    def test_late_commit_revalidates_exact_generation_then_consumes_once(self):
        candidate = self.candidate();self.operation["receipt"][relocation.FRESH_FIELD] = candidate
        with patch.object(relocation, "_fresh_operation", return_value="helper"), \
             patch.object(relocation, "_fresh_candidate", return_value=candidate), \
             patch.object(relocation, "_probe_fresh_candidate", return_value="claimed") as probe:
            relocation.commit_fresh_ledger_admission(self.control, self.operation)
            probe.assert_called_once_with(self.control, self.operation, candidate, commit=True)
        for change in ("generation", "archive", "later-admission"):
            with self.subTest(change=change):
                saved = copy.deepcopy(self.records)
                if change == "generation":self.records["group-ledger-generation.json"] = {**self.generation, "generation": "f" * 32}
                elif change == "archive":self.records["recreate-services/attempts/" + self.token + "/terminal.json"]["runtime_control_archive"] = {}
                else:self.records["development/verified.json"] = {**self.previous, "attempt": "c" * 32}
                with patch.object(relocation, "_fresh_operation", return_value="helper"), \
                     patch.object(relocation, "_fresh_candidate", return_value=candidate), \
                     patch.object(relocation, "_probe_fresh_candidate") as probe:
                    with self.assertRaises(BuildControlError):
                        relocation.commit_fresh_ledger_admission(self.control, self.operation)
                    probe.assert_not_called()
                self.records.clear();self.records.update(saved)

    def test_archive_cas_daemon_and_foreign_role_refuse(self):
        for kind in ("cas", "daemon", "foreign-role"):
            with self.subTest(kind=kind), patch("docker_volume_fresh_runtime.pinned_group_archive", return_value=self.archive) as archive, \
                 patch("docker_host_ledger._daemon_info", return_value={"id_sha256": self.daemon}) as daemon:
                if kind == "cas":archive.side_effect = BuildControlError("archive CAS differs")
                elif kind == "daemon":daemon.return_value = {"id_sha256": "9" * 64}
                else:archive.return_value = {**self.archive, "preserved_group_ledger_subpath": "private/other"}
                with self.assertRaises(BuildControlError):
                    relocation._fresh_candidate(self.control, self.operation, self.daemon, self.generation, self.previous)

    def test_double_operation_and_another_consumer_refuse(self):
        with patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value={"helper"}), \
             patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value={"helper"}):
            self.assertEqual(relocation._fresh_operation(self.control, self.operation), "helper")
            other = copy.deepcopy(self.operation)
            with self.assertRaisesRegex(BuildControlError, "active operation"):
                relocation._fresh_operation(self.control, other)
        with patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value={"helper", "worker"}), \
             patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value={"helper"}):
            with self.assertRaisesRegex(BuildControlError, "another consumer"):
                relocation._fresh_operation(self.control, self.operation)

    def test_actual_one_shot_filesystem_claim_is_durable_and_never_resets_missing_history(self):
        import io
        import os
        from pathlib import Path
        import stat
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "control";role = root / "private/ledger";leaf = role / "ledger"
            leaf.mkdir(parents=True);role.chmod(0o750);leaf.chmod(0o750)
            archived = root / "runtime-archives" / self.token / "group-ledger";archived.mkdir(parents=True)
            owner = str(os.getuid()) + ":" + str(os.getgid())
            identity = lambda path: str(path.stat().st_dev) + ":" + str(path.stat().st_ino)
            candidate = self.candidate();candidate.update(fresh_device_inode=identity(leaf), role_device_inode=identity(role),
                                                         archived_device_inode=identity(archived), archived_owner=owner)
            code = relocation._FRESH_ADMISSION_SCRIPT.replace("Path('/control')", "Path(" + repr(str(root)) + ")").replace("'65532:65532'", repr(owner))
            def execute(mode):
                output = io.StringIO()
                raw = relocation.canonical({"candidate": candidate, "mode": mode})
                with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(raw))), patch("sys.stdout", output):
                    exec(compile(code, "<first-admission>", "exec"), {})
                return json.loads(output.getvalue())
            self.assertEqual(execute("inspect"), {"state": "empty"})
            claim = root / "group-ledger-first-admission" / (self.token + ".json")
            self.assertFalse(claim.exists())
            real_sync = os.fsync;synced = []
            def sync(fd):synced.append(os.readlink('/proc/self/fd/' + str(fd)));real_sync(fd)
            with patch.object(os, "fsync", side_effect=sync):
                self.assertEqual(execute("commit"), {"state": "claimed"})
            self.assertEqual(json.loads(claim.read_bytes()), candidate)
            self.assertEqual(synced, [str(claim), str(claim.parent), str(root)])
            for mode in ("inspect", "commit"):
                with self.assertRaisesRegex(AssertionError, "already claimed"):
                    execute(mode)
            for name in ("HOST_RESOURCE_LEDGER.json", "HOST_RESOURCE_LEDGER.init.json"):
                (leaf / name).write_text('{}')
            self.assertEqual(execute("inspect"), {"state": "initialized"})
            (leaf / "HOST_RESOURCE_LEDGER.json").unlink()
            with self.assertRaisesRegex(AssertionError, "already claimed"):
                execute("inspect")
            (leaf / "HOST_RESOURCE_LEDGER.init.json").unlink()
            with self.assertRaisesRegex(AssertionError, "already claimed"):
                execute("commit")

    def test_foreign_fresh_inode_refuses_before_claim(self):
        import io
        import os
        from pathlib import Path
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "control";leaf = root / "private/ledger/ledger";leaf.mkdir(parents=True)
            candidate = self.candidate();candidate.update(role_device_inode=str(leaf.parent.stat().st_dev)+':'+str(leaf.parent.stat().st_ino),
                                                         fresh_device_inode='0:1')
            owner = str(os.getuid()) + ':' + str(os.getgid())
            code = relocation._FRESH_ADMISSION_SCRIPT.replace("Path('/control')", "Path("+repr(str(root))+")").replace("'65532:65532'", repr(owner))
            with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(relocation.canonical({"candidate": candidate, "mode": "commit"})))), \
                 patch("sys.stdout", io.StringIO()), self.assertRaises(AssertionError):
                exec(compile(code, "<first-admission>", "exec"), {})
            self.assertFalse((root/'group-ledger-first-admission').exists())


class InitializedLedgerReadmissionTests(unittest.TestCase):
    """Run the readonly probe on real files; fake only Docker/control transport."""

    def setUp(self):
        self.fixture()

    def fixture(self):
        import os
        import tempfile
        from pathlib import Path
        from bootstrap_docker_toolchain import CONTROL_VOLUME_SCHEMA, CONTROL_ROOT, control_volume_name
        from docker_group_ledger import host_id
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.probe_calls = 0
        self.root = Path(temporary.name) / "control"
        self.role = self.root / "private/ledger"
        self.leaf = self.role / "ledger"
        self.token, self.creator_id, self.previous_id = "e" * 32, "c" * 32, "a" * 32
        self.archived = self.root / "runtime-archives" / self.token / "group-ledger"
        for p in [self.leaf, self.archived]:
            p.mkdir(parents=True)
        for p in [self.role, self.leaf, self.archived]:
            p.chmod(0o750)
        for name in ["HOST_RESOURCE_LEDGER.json", "HOST_RESOURCE_LEDGER.init.json"]:
            (self.leaf / name).write_bytes(b'{"retained":true}\n')
        self.owner = str(os.getuid()) + ":" + str(os.getgid())
        self.project = "fullmag-master"
        self.volume = control_volume_name(self.project)
        self.source = str(Path(__file__).resolve().parents[1])
        self.daemon = "d" * 64
        old = lambda p: "8:" + str(p.stat().st_ino)
        self.archive = {
            "preserved_group_ledger_volume": self.volume,
            "preserved_group_ledger_subpath": "private/ledger",
            "fresh_group_ledger_role_device_inode": old(self.role),
            "fresh_group_ledger_device_inode": old(self.leaf),
            "archived_group_ledger_device_inode": old(self.archived),
            "archived_group_ledger_owner": self.owner,
            "archived_group_ledger_mode": "750",
        }
        self.generation = {"generation": self.token,
                           "archive_terminal_sha256": relocation.sha(relocation.canonical(self.archive))}
        self.operation = {"root": "development/attempts/" + "b" * 32,
                          "receipt": {"phase": "development", "attempt": "b" * 32,
                                      "compose_project": self.project, "control_volume": self.volume,
                                      "inputs": {"source_root": self.source}},
                          "daemon_pending": False}
        self.previous = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "succeeded", "attempt": self.previous_id, "compose_project": self.project,
            "control_volume": self.volume, "private_group_storage": "group-volume-v1",
            "ledger_profile": "group-ledger-v1", "inputs": {"source_root": self.source},
        }
        self.claim = {
            "schema": relocation.FRESH_ADMISSION, "compose_project": self.project,
            "control_volume": self.volume, "source_root": self.source,
            "daemon_id_sha256": self.daemon, "generation": self.token,
            "generation_record": self.generation,
            "archive_terminal_sha256": self.generation["archive_terminal_sha256"],
            "fresh_device_inode": old(self.leaf), "role_device_inode": old(self.role),
            "archived_device_inode": old(self.archived), "archived_owner": self.owner,
            "previous_development_attempt": "f" * 32, "operation_attempt": self.creator_id,
        }
        self.claim_path = "group-ledger-first-admission/" + self.token + ".json"
        self.creator_path = "development/attempts/" + self.creator_id + "/terminal.json"
        self.archive_path = "recreate-services/attempts/" + self.token + "/terminal.json"
        creator = {**copy.deepcopy(self.previous), "attempt": self.creator_id, "state": "failed-confirmed",
                   relocation.FRESH_FIELD: copy.deepcopy(self.claim)}
        ledger = {"schema": "fullmag.docker-group-ledger.v1", "profile": "group-ledger-v1",
                  "daemon_id_sha256": self.daemon, "compose_project": self.project,
                  "volume_name": self.volume, "host_id": host_id(self.daemon, self.project)}
        self.records = {
            self.claim_path: self.claim, self.creator_path: creator,
            "group-ledger-generation.json": self.generation,
            "development/verified.json": self.previous,
            "development/attempts/" + self.previous_id + "/terminal.json": copy.deepcopy(self.previous),
            "development/attempts/" + self.creator_id + "/group-ledger.json": copy.deepcopy(ledger),
            "development/attempts/" + self.previous_id + "/group-ledger.json": copy.deepcopy(ledger),
            self.archive_path: {"state": "succeeded", "phase": "recreate-services",
                                "attempt": self.token, "compose_project": self.project,
                                "control_volume": self.volume, "inputs": {"attempt": "f" * 32},
                                "runtime_control_archive": self.archive},
        }
        self.control = SimpleNamespace(
            project=self.project, volume=self.volume, namespace="", identity={"source_root": self.source},
            subpath=lambda p: p, _active_operation=self.operation,
            _assert_live_operation_helper=lambda operation: "helper",
            _inspect_operation_helper=lambda operation, expected_id: expected_id,
            read=lambda name, optional=False: copy.deepcopy(self.records.get(name)),
            read_bytes=lambda name, optional=False: relocation.canonical(self.records[name])
                       if name in self.records else None,
            write=lambda name, value: self.records.update({name: copy.deepcopy(value)}),
        )
        self.volume_record = {
            "Name": self.volume, "Driver": "local", "Options": {}, "CreatedAt": "2026-01-01T00:00:00Z",
            "Mountpoint": "/var/lib/docker/volumes/" + self.volume + "/_data",
            "Labels": {"com.fullmag.compose.project": self.project,
                       "com.fullmag.toolchain.control.schema": CONTROL_VOLUME_SCHEMA,
                       "com.fullmag.toolchain.control.project": self.project,
                       "com.fullmag.toolchain.control.mount": CONTROL_ROOT},
        }

    def candidate(self):
        return {**copy.deepcopy(self.claim), "operation_attempt": "b" * 32,
                "previous_development_attempt": self.previous_id}

    def transport(self, argv, *, data, **kwargs):
        import io
        import traceback
        from subprocess import CompletedProcess
        self.probe_calls += 1
        self.assertIn("exec", argv)
        self.assertIn("helper", argv)
        code = argv[-1].replace("Path('/control')", "Path(" + repr(str(self.root)) + ")")
        code = code.replace("'65532:65532'", repr(self.owner))
        output = io.StringIO()
        try:
            with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(data))), patch("sys.stdout", output):
                exec(compile(code, "<initialized-readmission>", "exec"), {})
        except Exception:
            return CompletedProcess(argv, 1, output.getvalue().encode(), traceback.format_exc().encode())
        return CompletedProcess(argv, 0, output.getvalue().encode(), b"")

    def context(self):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch("docker_volume_fresh_runtime.pinned_group_archive", return_value=self.archive))
        stack.enter_context(patch("docker_host_ledger._daemon_info", return_value={"id_sha256": self.daemon}))
        stack.enter_context(patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value={"helper"}))
        stack.enter_context(patch("docker_volume_unclaimed_cancellation._volume_consumer_ids", return_value={"helper"}))
        stack.enter_context(patch.object(relocation, "bounded_capture", side_effect=self.transport))
        stack.enter_context(patch.object(relocation, "docker_text",
                                        side_effect=lambda *args: json.dumps([self.volume_record])))
        return stack

    def prepare(self):
        with self.context():
            return relocation.prepare_initialized_ledger_readmission(
                self.control, self.operation, self.candidate(), self.previous)

    def test_initialized_readmission_accepts_changed_device_with_exact_volume_and_history(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertTrue(self.prepare())
        proof = self.operation["receipt"]["initialized_group_ledger_readmission"]
        self.assertEqual(proof["schema"], "fullmag.group-ledger-initialized-readmission.v1")
        self.assertNotIn(relocation.FRESH_FIELD, self.operation["receipt"])
        self.assertFalse((self.root / "group-ledger-first-admission").exists())
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_readmission_preserves_archived_failed_predecessor_history(self):
        previous_id, failed_id = "f" * 32, "8" * 32
        old = copy.deepcopy(self.claim)
        old.update(generation="9" * 32, operation_attempt=previous_id,
                   previous_development_attempt="7" * 32)
        previous = {**copy.deepcopy(self.previous), "attempt": previous_id, "state_root": "/retained-state",
                    relocation.INITIALIZED_FIELD: {"schema": relocation.INITIALIZED_ADMISSION, "candidate": old}}
        failed = {**copy.deepcopy(previous), "attempt": failed_id, "state": "failed-confirmed",
                  "backend_container": "1" * 64, "frontend_container": "2" * 64, "config_sha256": "3" * 64}
        failed[relocation.INITIALIZED_FIELD]["candidate"].update(
            operation_attempt=failed_id, previous_development_attempt=previous_id)
        self.records["development/attempts/" + previous_id + "/terminal.json"] = previous
        self.records["development/attempts/" + failed_id + "/terminal.json"] = failed
        self.records[self.archive_path].update(
            inputs={"attempt": failed_id, "config_sha256": failed["config_sha256"]},
            previous_state_root=previous["state_root"],
            removed_containers=[failed["backend_container"], failed["frontend_container"]])
        self.assertTrue(self.prepare())
        history = self.operation["receipt"][relocation.INITIALIZED_FIELD]["history"]
        for identifier in (previous_id, failed_id):
            self.assertIn("development/attempts/" + identifier + "/terminal.json", history)
        failed["state_root"] = "/foreign"
        with self.assertRaises(BuildControlError):
            self.prepare()

    def test_same_generation_missing_claim_still_refuses(self):
        self.previous[relocation.INITIALIZED_FIELD] = {
            "schema": relocation.INITIALIZED_ADMISSION, "candidate": self.candidate()}
        self.records["development/attempts/" + self.previous_id + "/terminal.json"] = copy.deepcopy(self.previous)
        self.records.pop(self.claim_path)
        with self.assertRaisesRegex(BuildControlError, "Required initialized ledger first claim was lost"):
            self.prepare()

    def test_failed_confirmed_claim_creator_with_later_verified_success_is_valid(self):
        self.assertTrue(self.prepare())
        self.assertEqual(self.records[self.creator_path]["state"], "failed-confirmed")
        for state in ["outcome-unknown-resources-retained", "starting"]:
            self.fixture()
            self.records[self.creator_path]["state"] = state
            with self.subTest(state=state), self.assertRaises(BuildControlError):
                self.prepare()
        self.fixture()
        self.records["development/verified.json"]["state"] = "failed-confirmed"
        with self.assertRaises(BuildControlError):
            self.prepare()

    def test_initialized_readmission_refuses_foreign_or_changed_history(self):
        changes = {
            "group": lambda: self.claim.update(compose_project="foreign"),
            "daemon": lambda: self.claim.update(daemon_id_sha256="9" * 64),
            "source": lambda: self.claim.update(source_root="/foreign"),
            "volume": lambda: self.claim.update(control_volume="foreign"),
            "archive": lambda: self.claim.update(archive_terminal_sha256="0" * 64),
            "generation": lambda: self.claim.update(generation="0" * 32),
            "claim": lambda: self.claim.update(extra=True),
            "creator": lambda: self.records[self.creator_path].update(fresh_group_ledger_admission={}),
            "predecessor": lambda: self.records[self.archive_path]["inputs"].update(attempt="0" * 32),
            "ledger": lambda: self.records["development/attempts/" + self.previous_id + "/group-ledger.json"].update(host_id="0" * 64),
            "volume-label": lambda: self.volume_record["Labels"].update({"com.fullmag.compose.project": "foreign"}),
            "volume-driver": lambda: self.volume_record.update(Driver="foreign"),
        }
        for name, change in changes.items():
            self.fixture()
            change()
            with self.subTest(name=name), self.assertRaises(BuildControlError):
                self.prepare()
            self.assertNotIn("initialized_group_ledger_readmission", self.operation["receipt"])

    def test_initialized_readmission_refuses_filesystem_inode_owner_mode_and_alias_drift(self):
        import os
        for kind in ["role-inode", "leaf-inode", "archive-inode", "mode", "directory-alias",
                     "file-alias", "hardlink", "empty", "oversized", "filesystem", "owner"]:
            self.fixture()
            target = self.leaf / "HOST_RESOURCE_LEDGER.json"
            if kind.endswith("-inode"):
                key = {"role-inode": "role_device_inode", "leaf-inode": "fresh_device_inode",
                       "archive-inode": "archived_device_inode"}[kind]
                # Update both retained sources so only the physical identity differs.
                self.claim[key] = "8:1"
                self.records[self.creator_path][relocation.FRESH_FIELD][key] = "8:1"
                archive_key = {"role-inode": "fresh_group_ledger_role_device_inode",
                               "leaf-inode": "fresh_group_ledger_device_inode",
                               "archive-inode": "archived_group_ledger_device_inode"}[kind]
                self.archive[archive_key] = "8:1"
                self.generation["archive_terminal_sha256"] = relocation.sha(relocation.canonical(self.archive))
                self.claim["archive_terminal_sha256"] = self.generation["archive_terminal_sha256"]
                self.records[self.creator_path][relocation.FRESH_FIELD] = copy.deepcopy(self.claim)
            elif kind == "mode":
                self.role.chmod(0o755)
            elif kind == "directory-alias":
                self.leaf.rename(self.role / "actual");self.leaf.symlink_to(self.role / "actual")
            elif kind == "file-alias":
                target.rename(self.leaf / "actual");target.symlink_to(self.leaf / "actual")
            elif kind == "hardlink":
                os.link(target, self.leaf / "alias")
            elif kind == "empty":
                target.write_bytes(b"")
            elif kind == "oversized":
                with target.open("wb") as stream:stream.truncate(8388609)
            real_fstat = os.fstat
            def observed(fd):
                value = real_fstat(fd)
                if kind in ["filesystem", "owner"] and os.readlink("/proc/self/fd/" + str(fd)) == str(self.role):
                    fields = {name: getattr(value, name) for name in dir(value) if name.startswith("st_")}
                    fields["st_dev" if kind == "filesystem" else "st_uid"] += 1
                    return SimpleNamespace(**fields)
                return value
            with self.subTest(kind=kind), patch.object(os, "fstat", side_effect=observed), self.assertRaises(BuildControlError):
                self.prepare()
            self.assertEqual(self.probe_calls, 1, kind + " must reach the real filesystem probe")

    def test_legacy_or_empty_ledger_retains_exact_v1_behavior(self):
        import io
        self.records.pop(self.claim_path)
        self.assertFalse(self.prepare())
        for p in self.leaf.iterdir():p.unlink()
        code = relocation._FRESH_ADMISSION_SCRIPT.replace("Path('/control')", "Path(" + repr(str(self.root)) + ")")
        code = code.replace("'65532:65532'", repr(self.owner))
        payload = relocation.canonical({"candidate": self.candidate(), "mode": "inspect"})
        with patch("sys.stdin", SimpleNamespace(buffer=io.BytesIO(payload))), patch("sys.stdout", io.StringIO()), self.assertRaises(AssertionError):
            exec(compile(code, "<unchanged-fresh>", "exec"), {})
        self.fixture()
        for p in self.leaf.iterdir():p.unlink()
        with self.assertRaises(BuildControlError):
            self.prepare()

    def test_lost_required_initialized_proof_or_partial_ledger_never_falls_back(self):
        for kind in ["required-claim", "removed-proof", "malformed-claim", "partial"]:
            self.fixture()
            if kind in ["required-claim", "removed-proof"]:
                self.previous["initialized_group_ledger_readmission"] = {"schema": "fullmag.group-ledger-initialized-readmission.v1"}
                self.records["development/attempts/" + self.previous_id + "/terminal.json"] = copy.deepcopy(self.previous)
                self.records.pop(self.claim_path)
                if kind == "removed-proof":self.previous.pop("initialized_group_ledger_readmission")
            elif kind == "malformed-claim":
                self.records[self.claim_path] = {}
            else:
                (self.leaf / "HOST_RESOURCE_LEDGER.init.json").unlink()
            with self.subTest(kind=kind), self.assertRaises(BuildControlError):
                self.prepare()

    def test_null_claim_refuses_full_preparation_even_with_matching_device(self):
        for key, archive_key, path in [
            ("role_device_inode", "fresh_group_ledger_role_device_inode", self.role),
            ("fresh_device_inode", "fresh_group_ledger_device_inode", self.leaf),
            ("archived_device_inode", "archived_group_ledger_device_inode", self.archived),
        ]:
            identity = str(path.stat().st_dev) + ":" + str(path.stat().st_ino)
            self.claim[key] = self.archive[archive_key] = identity
        self.generation["archive_terminal_sha256"] = relocation.sha(relocation.canonical(self.archive))
        self.claim["archive_terminal_sha256"] = self.generation["archive_terminal_sha256"]
        self.records[self.creator_path][relocation.FRESH_FIELD] = copy.deepcopy(self.claim)
        self.records[self.claim_path] = None
        with self.context(), self.assertRaises(BuildControlError):
            relocation.prepare_fresh_ledger_admission(
                self.control, self.operation, self.daemon, self.generation, self.previous)
        self.assertEqual(self.probe_calls, 0)
        self.assertNotIn(relocation.INITIALIZED_FIELD, self.operation["receipt"])

    def test_archived_directory_mode_must_match_pinned_history(self):
        for actual_mode in [0o700, 0o750]:
            self.fixture()
            self.archive["archived_group_ledger_mode"] = "700"
            self.generation["archive_terminal_sha256"] = relocation.sha(relocation.canonical(self.archive))
            self.claim["archive_terminal_sha256"] = self.generation["archive_terminal_sha256"]
            self.records[self.creator_path][relocation.FRESH_FIELD] = copy.deepcopy(self.claim)
            self.archived.chmod(actual_mode)
            with self.subTest(actual_mode=oct(actual_mode)):
                if actual_mode == 0o700:
                    self.assertTrue(self.prepare())
                else:
                    with self.assertRaises(BuildControlError):
                        self.prepare()
                self.assertEqual(self.probe_calls, 1)

    def test_initialized_revalidation_rejects_changed_pins_before_create(self):
        with self.context():
            relocation.prepare_initialized_ledger_readmission(self.control, self.operation, self.candidate(), self.previous)
            relocation.revalidate_initialized_ledger_readmission(self.control, self.operation)
        for kind in ["file", "history", "helper", "mount", "consumer"]:
            self.fixture();self.prepare()
            if kind == "file":(self.leaf / "HOST_RESOURCE_LEDGER.json").write_bytes(b'{"changed":true}')
            elif kind == "history":self.records[self.creator_path]["inputs"]["source_root"] = "/changed"
            elif kind == "helper":self.control._inspect_operation_helper = lambda *args, **kwargs: "different"
            elif kind == "mount":self.volume_record["CreatedAt"] = "2026-02-01T00:00:00Z"
            with self.subTest(kind=kind), self.context():
                if kind == "consumer":
                    with patch("docker_volume_unclaimed_cancellation._project_container_ids", return_value={"helper", "other"}), self.assertRaises(BuildControlError):
                        relocation.revalidate_initialized_ledger_readmission(self.control, self.operation)
                else:
                    with self.assertRaises(BuildControlError):
                        relocation.revalidate_initialized_ledger_readmission(self.control, self.operation)

if __name__ == "__main__":
    unittest.main()
