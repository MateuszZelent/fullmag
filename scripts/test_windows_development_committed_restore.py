"""Interpreted production preparation from a pinned durable commit and fence."""
from copy import deepcopy
import json
import shutil
import unittest
import uuid

import test_windows_development_acquisition_handoff as fixtures
from windows import development_handoff as capsule
from windows import prepare_committed_restore as consumer


class CommittedRestoreTests(unittest.TestCase):
    stage = fixtures.AcquisitionHandoffTests.stage
    scene_acquisition = fixtures.AcquisitionHandoffTests.scene_acquisition

    def setUp(self):
        fixtures.AcquisitionHandoffTests.setUp(self)
        self.scope = str(uuid.uuid4())
        layout = capsule._STORAGE.resolve_layout(str(self.repo), "windows-native-fdm-cpu-dev")
        layout["runs_root"] = str(self.store / "runs" / "fixture")
        self.accepted = self.store / "runs" / "fixture" / "workspaces" / self.scope / "session-store"
        (self.accepted / "development").mkdir(parents=True)

    def committed_request(self, *, scene=False):
        wire = self.scene_acquisition()[0] if scene else None
        ack = self.stage(wire)
        self.fence = {"schema": "fullmag.development-admission-fence.v1", "owner_token": "a" * 32,
                      "nonce": ack["acquisition_nonce"], "created_at": "2026-10-04T04:00:00Z"}
        self.record = {"schema": "fullmag.development-handoff-commit.v1",
                       "api_instance_id": ack["binding"]["api_instance_id"],
                       "acquisition_nonce": ack["acquisition_nonce"], "handoff_id": ack["handoff"]["handoff_id"],
                       "snapshot_sha256": ack["handoff"]["snapshot_sha256"],
                       "target_build_id": ack["binding"]["target_build_id"],
                       "accepted_store_binding": consumer.store_binding(self.accepted), "fence": self.fence,
                       "created_at": "2026-10-04T04:00:01+00:00"}
        self.commit = self.accepted / "development" / "HANDOFF-COMMIT.json"
        self.fence_path = self.accepted / "development" / "ADMISSION-FENCE.json"
        self.commit.write_text(json.dumps(self.record), encoding="utf-8")
        self.fence_path.write_text(json.dumps(self.fence), encoding="utf-8")
        return {"schema": consumer.REQUEST_SCHEMA, "accepted_store_scope": self.scope,
                "accepted_store_binding": self.record["accepted_store_binding"],
                "commit_sha256": capsule._sha256(self.commit.read_bytes()),
                "acquisition_nonce": ack["acquisition_nonce"], "binding": ack["binding"],
                "candidate_bundle_root": str(self.candidate),
                "candidate_manifest_sha256": capsule._sha256((self.candidate / "manifest.json").read_bytes())}

    def test_empty_and_scene_preparation_do_not_mutate_any_inputs(self):
        for scene in (False, True):
            with self.subTest(scene=scene):
                request = self.committed_request(scene=scene)
                before = {str(p.relative_to(self.store)): p.read_bytes()
                          for p in self.store.rglob("*") if p.is_file()}
                result = consumer.prepare_request(str(self.repo), request)
                self.assertEqual(result["preparation"]["workspace_state"], "session" if scene else "no_session")
                self.assertEqual(result["preparation"]["envelope"] is None, not scene)
                self.assertEqual(result["preparation"]["editor"], self.frontend["editor"])
                self.assertNotIn("owner_token", json.dumps(result))
                self.assertEqual(before, {str(p.relative_to(self.store)): p.read_bytes()
                                         for p in self.store.rglob("*") if p.is_file()})

    def test_foreign_owner_pins_and_scope_refused(self):
        request = self.committed_request()
        for field, value in (("accepted_store_scope", str(uuid.uuid4())), ("accepted_store_scope", "../escape"),
                             ("accepted_store_binding", "0" * 64), ("commit_sha256", "0" * 64),
                             ("acquisition_nonce", str(uuid.uuid4())), ("candidate_manifest_sha256", "0" * 64),
                             ("binding", {**request["binding"], "api_instance_id": str(uuid.uuid4())})):
            with self.subTest(field=field):
                with self.assertRaises(capsule.HandoffError):
                    consumer.prepare_request(str(self.repo), {**request, field: value})

    def test_resigned_commit_still_requires_exact_actual_fence(self):
        request = self.committed_request()
        altered = deepcopy(self.fence)
        altered["created_at"] = "2026-10-04T04:00:02Z"
        self.fence_path.write_text(json.dumps(altered), encoding="utf-8")
        with self.assertRaises(capsule.HandoffError):
            consumer.prepare_request(str(self.repo), request)

    def test_new_record_digest_does_not_hide_foreign_snapshot(self):
        request = self.committed_request()
        self.record["snapshot_sha256"] = "0" * 64
        self.commit.write_text(json.dumps(self.record), encoding="utf-8")
        request["commit_sha256"] = capsule._sha256(self.commit.read_bytes())
        with self.assertRaises(capsule.HandoffError):
            consumer.prepare_request(str(self.repo), request)

    def test_resident_metadata_refused_and_preserved(self):
        request = self.committed_request()
        marker = self.accepted / "runtime-services" / "OWNER.lock"
        marker.parent.mkdir()
        marker.write_bytes(b"owned")
        with self.assertRaises(capsule.HandoffError):
            consumer.prepare_request(str(self.repo), request)
        self.assertEqual(marker.read_bytes(), b"owned")

    def test_copied_records_do_not_authorize_another_actual_store(self):
        request = self.committed_request()
        scope = str(uuid.uuid4())
        other = self.accepted.parent.parent / scope / "session-store"
        shutil.copytree(self.accepted, other)
        with self.assertRaises(capsule.HandoffError):
            consumer.prepare_request(str(self.repo), {**request, "accepted_store_scope": scope})

    def test_modified_candidate_and_unknown_request_fields_refused(self):
        request = self.committed_request()
        with self.assertRaises(capsule.HandoffError):
            consumer.prepare_request(str(self.repo), {**request, "shutdown": True})
        (self.candidate / "bin" / "fullmag-api.exe").write_bytes(b"changed")
        with self.assertRaises(capsule.HandoffError):
            consumer.prepare_request(str(self.repo), request)


if __name__ == "__main__":
    unittest.main()
