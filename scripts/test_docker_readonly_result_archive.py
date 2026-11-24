"""Interpreted readonly archive admission/mount regressions; no Docker lifecycle."""
import copy
import fcntl
import json
from pathlib import Path
from subprocess import CompletedProcess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_readonly_result_archive as archive
from docker_build_control import BuildControlError, canonical
from docker_backend_volume_cache import BackendVolumeCacheError


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.selected = self.root / "checkout"
        self.selected.mkdir()
        self.state = self.root / "old-state"
        self.store = self.state / "runs/docker-all/session-store"
        self.store.mkdir(parents=True)
        (self.store / "WRITER.lock").write_bytes(archive.WRITER_BYTES)
        rows = []
        for number in range(4):
            run = "run-" + str(number) * 64
            records = {}
            directory = self.store / "runs" / run
            directory.mkdir(parents=True)
            for name in ("run_intent", "run_catalog", "artifact_catalog"):
                raw = canonical({"run_id": run, "member": name})
                (directory / (name + ".json")).write_bytes(raw)
                records[name + ".json"] = {"sha256": archive.sha(raw), "bytes": len(raw)}
            rows.append({"run_id": run, "project_id": "project-test", "payload_fingerprint": "a" * 64, "records": records})
        self.review = canonical({"schema": "fullmag.retained_result_archive_review_inventory.v1", "source_root": str(self.store), "runs": rows})
        patcher = patch.object(archive, "REVIEW_SHA256", archive.sha(self.review));patcher.start();self.addCleanup(patcher.stop)
        self.protected = {"state_root": str(self.state), "source_root": str(self.selected), "proof_sha256": "d" * 64}
        patcher = patch("docker_volume_resume_protected.describe_archived_protected", return_value=self.protected)
        patcher.start();self.addCleanup(patcher.stop)
        data = {}
        self.control = SimpleNamespace(project="group", volume="private", data=data,
            read_bytes=lambda path, optional=False: data.get(path) if optional else data[path],
            write_bytes=lambda path, raw: data.__setitem__(path, raw),
            subpath=lambda path: "namespaces/" + "c" * 32 + "/" + path)
        self.layout = {"storage_root": self.root}

    def prepared(self):
        result = archive.prepare(self.control, self.selected, self.layout, self.review)
        return result, (result["request"], result["request_sha256"])

    def document(self):
        return {"name": "group", "services": {"backend": {"environment": {}, "volumes": []},
            "frontend": {"environment": {}, "volumes": []}}, "volumes": {"build-control": {"name": "private", "external": True}}}

    def test_default_has_no_environment_mount_or_document_change(self):
        document = self.document();before = copy.deepcopy(document)
        archive.configure(document, self.control, self.selected, None)
        self.assertIsNone(archive.validate_document(document))
        self.assertIsNone(archive.validate_document({}))
        self.assertEqual(document, before)
        self.assertEqual(self.control.data, {})

    def test_preview_revalidates_all_pins_without_publishing(self):
        result = archive.prepare(self.control, self.selected, self.layout, self.review, publish=False)
        self.assertEqual(result["state"], "readonly-result-archive-preview-passed")
        self.assertEqual(self.control.data, {})
        prepared, _ = self.prepared()
        self.assertEqual(result["request_sha256"], prepared["request_sha256"])
        self.assertEqual(result["manifest_sha256"], prepared["manifest_sha256"])

    def test_prepared_manifest_exact_shape_external_sha_and_existing_volume_subpath(self):
        result, pins = self.prepared()
        request, manifest = archive.load_request(self.control, self.selected, pins)
        self.assertEqual(set(manifest), {"schema", "compose_project", "host_source_root", "guest_source_root", "writer_lock", "runs"})
        self.assertEqual(manifest["writer_lock"]["byte_count"], 23)
        self.assertEqual(len(manifest["runs"]), 4)
        self.assertEqual(set(manifest["runs"][0]), {"project_id", "run_id", "payload_fingerprint", "run_intent", "run_catalog", "artifact_catalog"})
        document = self.document();archive.configure(document, self.control, self.selected, pins)
        descriptor = archive.validate_document(document)
        self.assertEqual(set(document["volumes"]), {"build-control"})
        self.assertEqual(descriptor["manifest_sha256"], result["manifest_sha256"])
        self.assertTrue(all(m["read_only"] for m in document["services"]["backend"]["volumes"]))
        self.assertEqual(document["services"]["frontend"], self.document()["services"]["frontend"])
        self.assertLess(len(self.control.data[request["manifest_path"]]), 64 * 1024)

    def test_partial_request_and_environment_unknown_fields_wrong_group_or_pin_refuse(self):
        result, pins = self.prepared()
        for pair in [(pins[0], None), (None, pins[1]), ("../../elsewhere", pins[1])]:
            with self.assertRaises(BuildControlError):archive.option_pins(*pair)
        with self.assertRaises(BuildControlError):archive.load_request(self.control, self.selected, (pins[0], "f" * 64))
        original = self.control.data[pins[0]]
        for change in ("unknown", "group"):
            request = json.loads(original)
            if change == "unknown":request["unknown"] = 1
            else:request["compose_project"] = "foreign"
            changed = canonical(request);self.control.data[pins[0]] = changed
            with self.assertRaises(BuildControlError):archive.load_request(self.control, self.selected, (pins[0], archive.sha(changed)))
        self.control.data[pins[0]] = original
        document = self.document();document["services"]["backend"]["environment"][archive.ENV[0]] = "unadmitted"
        with self.assertRaises(BuildControlError):archive.validate_document(document)

    def test_changed_metadata_missing_writer_symlink_or_busy_writer_refuse_without_writes(self):
        _, pins = self.prepared();before = copy.deepcopy(self.control.data)
        manifest = archive.load_request(self.control, self.selected, pins)[1]
        lock = self.store / "WRITER.lock"
        with lock.open("rb") as owner:
            fcntl.flock(owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):archive.verify_records(manifest)
        lock.rename(self.store / "saved-lock")
        with self.assertRaises(FileNotFoundError):archive.verify_records(manifest)
        lock.symlink_to(self.store / "saved-lock")
        with self.assertRaises(OSError):archive.verify_records(manifest)
        lock.unlink();(self.store / "saved-lock").rename(lock)
        path = self.store / "runs" / manifest["runs"][0]["run_id"] / "run_catalog.json"
        raw = path.read_bytes();path.write_bytes(b"changed")
        with self.assertRaises(BuildControlError):archive.verify_records(manifest)
        path.write_bytes(raw);path.rename(path.with_suffix(".original"));path.symlink_to(path.with_suffix(".original"))
        with self.assertRaises(OSError):archive.verify_records(manifest)
        self.assertEqual(self.control.data, before)

    def test_host_directory_replacement_and_unapproved_review_refuse(self):
        _, pins = self.prepared()
        with self.assertRaises(BuildControlError):archive.prepare(self.control, self.selected, self.layout, self.review + b" ")
        original = self.store.with_name("original");self.store.rename(original);self.store.mkdir()
        with self.assertRaises(BuildControlError):archive.load_request(self.control, self.selected, pins)

    def test_engine_readonly_source_subpath_and_nested_boundaries(self):
        _, pins = self.prepared();document = self.document();archive.configure(document, self.control, self.selected, pins)
        descriptor = document["x-fullmag-readonly-result-archive"]
        actual = {"Mounts": [
            {"Type": "bind", "Source": str(self.store), "Destination": archive.GUEST_ROOT, "RW": False},
            {"Type": "volume", "Name": "private", "Source": "/volume/" + descriptor["volume_subpath"], "Destination": archive.MANIFEST_ROOT, "RW": False}],
            "HostConfig": {"Mounts": [{"Type": "volume", "Source": "private", "Target": archive.MANIFEST_ROOT,
                "ReadOnly": True, "VolumeOptions": {"Subpath": descriptor["volume_subpath"]}}]}}
        response = CompletedProcess([], 0, json.dumps([{"Name": "private", "Mountpoint": "/volume"}]).encode(), b"")
        with patch.object(archive, "docker_capture", return_value=response):
            archive.validate_container(document, actual)
            for change in ("writable", "nested", "source", "subpath"):
                bad = copy.deepcopy(actual)
                if change == "writable":bad["Mounts"][0]["RW"] = True
                elif change == "nested":bad["Mounts"].append({"Type": "bind", "Source": "/foreign", "Destination": archive.GUEST_ROOT + "/runs", "RW": False})
                elif change == "source":bad["Mounts"][0]["Source"] = "/foreign"
                else:bad["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = "private/ledger"
                error = BackendVolumeCacheError if change == "subpath" else BuildControlError
                with self.subTest(change=change), self.assertRaises(error):archive.validate_container(document, bad)

    def five_review(self):
        value = json.loads(self.review)
        run = archive.PARENT_RUN_ID
        records = {}
        directory = self.store / "runs" / run
        directory.mkdir(parents=True)
        for name in ("run_intent", "run_catalog", "artifact_catalog"):
            raw = canonical({"run_id": run, "member": name, "retained_parent": True})
            (directory / (name + ".json")).write_bytes(raw)
            records[name + ".json"] = {"sha256": archive.sha(raw), "bytes": len(raw)}
        value["runs"].append({"run_id": run, "project_id": "project-live-parent",
            "payload_fingerprint": "b" * 64, "records": records})
        raw = canonical(value)
        patcher = patch.object(archive, "PARENT_REVIEW_SHA256", archive.sha(raw))
        patcher.start();self.addCleanup(patcher.stop)
        return raw

    def test_exact_fifth_parent_all_metadata_and_old_request_still_load(self):
        old_result, old_pins = self.prepared()
        old_manifest_raw = self.control.data[json.loads(self.control.data[old_pins[0]])["manifest_path"]]
        five = self.five_review()
        result = archive.prepare(self.control, self.selected, self.layout, five)
        request, manifest = archive.load_request(self.control, self.selected, (result["request"], result["request_sha256"]))
        self.assertEqual(request["review_sha256"], archive.sha(five))
        self.assertEqual(len(manifest["runs"]), 5)
        self.assertEqual(manifest["runs"][:4], json.loads(old_manifest_raw)["runs"])
        self.assertEqual(manifest["runs"][4]["run_id"], archive.PARENT_RUN_ID)
        for name in ("run_intent", "run_catalog", "artifact_catalog"):
            raw = (self.store / "runs" / archive.PARENT_RUN_ID / (name + ".json")).read_bytes()
            self.assertEqual(manifest["runs"][4][name], {"sha256": archive.sha(raw), "byte_count": len(raw)})
        self.assertEqual(archive.load_request(self.control, self.selected, old_pins)[1], json.loads(old_manifest_raw))
        self.assertEqual(old_result["manifest_sha256"], archive.sha(old_manifest_raw))
        document = self.document()
        archive.configure(document, self.control, self.selected, (result["request"], result["request_sha256"]))
        self.assertTrue(all(m["read_only"] for m in document["services"]["backend"]["volumes"]))
        self.assertEqual(document["services"]["frontend"], self.document()["services"]["frontend"])

    def test_five_run_parent_metadata_change_refuses_all_three_records(self):
        five = self.five_review()
        result = archive.prepare(self.control, self.selected, self.layout, five)
        pins = (result["request"], result["request_sha256"])
        before = copy.deepcopy(self.control.data)
        for name in ("run_intent", "run_catalog", "artifact_catalog"):
            path = self.store / "runs" / archive.PARENT_RUN_ID / (name + ".json")
            raw = path.read_bytes();path.write_bytes(raw + b" ")
            with self.subTest(name=name), self.assertRaisesRegex(BuildControlError, "metadata changed"):
                archive.load_request(self.control, self.selected, pins)
            path.write_bytes(raw)
        self.assertEqual(self.control.data, before)

    def test_fifth_parent_other_live_sixth_and_duplicate_refuse(self):
        five = json.loads(self.five_review())
        for kind in ("other-parent", "other-live", "six", "duplicate"):
            value = copy.deepcopy(five)
            if kind == "other-parent":value["runs"][-1]["run_id"] = "run-live-" + "f" * 64
            elif kind == "other-live":value["runs"][0]["run_id"] = "run-live-" + "f" * 64
            elif kind == "six":value["runs"].append(copy.deepcopy(value["runs"][0]))
            else:value["runs"][0] = copy.deepcopy(value["runs"][1])
            raw = canonical(value)
            # Exercise the structural guard independently of the outer immutable inventory SHA.
            with patch.object(archive, "PARENT_REVIEW_SHA256", archive.sha(raw)), self.subTest(kind=kind), self.assertRaises(BuildControlError):
                archive.manifest_from_review(raw, "group", self.store)

    def test_five_run_inventory_bytes_and_review_request_pin_cannot_change(self):
        five = self.five_review()
        for change in (five + b" ", five.replace(b'project-live-parent', b'project-live-other')):
            with self.assertRaisesRegex(BuildControlError, "approved inventory"):
                archive.manifest_from_review(change, "group", self.store)
        result = archive.prepare(self.control, self.selected, self.layout, five)
        request = json.loads(self.control.data[result["request"]])
        request["review_sha256"] = archive.REVIEW_SHA256
        changed = canonical(request)
        self.control.data[result["request"]] = changed
        with self.assertRaisesRegex(BuildControlError, "review differs from its request pin"):
            archive.load_request(self.control, self.selected, (result["request"], archive.sha(changed)))

    def test_retained_archive_options_are_carried_without_default_global_configuration(self):
        _, pins = self.prepared();document = self.document();archive.configure(document, self.control, self.selected, pins)
        args = SimpleNamespace()
        archive.retained_options(args, document)
        self.assertEqual((args.readonly_result_archive_request, args.readonly_result_archive_request_sha256), pins)
        from docker_dev import _parser
        parsed = _parser().parse_args(["recreate-volume", "--attempt", "a" * 32, "--config-sha256", "b" * 64,
            "--source-root", str(self.selected), "--port", "3203", "--readonly-result-archive-request", pins[0],
            "--readonly-result-archive-request-sha256", pins[1]])
        self.assertEqual(parsed.readonly_result_archive_request, pins[0])


if __name__ == "__main__":
    unittest.main()
