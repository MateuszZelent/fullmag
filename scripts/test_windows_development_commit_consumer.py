"""Interpreted regressions of the API's read-only semantic commit boundary."""
from copy import deepcopy
import json
import os
from pathlib import Path
import unittest

import test_windows_development_scene_handoff as scene_tests
from windows import development_handoff as capsule
from windows import development_scene_handoff as semantic
from windows import validate_commit_handoff as consumer


class CommitConsumerTests(unittest.TestCase):
    def setUp(self):
        scene_tests.SemanticSceneHandoffTests.setUp(self)

    stage = scene_tests.SemanticSceneHandoffTests.stage
    rewrite_snapshot = scene_tests.SemanticSceneHandoffTests.rewrite_snapshot

    def request(self, ref, *, verify_restored_scene=False, restored_scene=None):
        path = self.runtime / capsule.HANDOFF_DIRECTORY / ref["handoff_id"] / "snapshot.json"
        return {"schema": consumer.REQUEST_SCHEMA, "storage_root": str(self.store),
                "worktree_id": "fixture", "handoff_id": ref["handoff_id"],
                "snapshot_sha256": capsule._sha256(path.read_bytes()), "binding": self.binding,
                "verify_restored_scene": verify_restored_scene,
                "restored_scene": restored_scene}

    def validate(self, ref):
        return consumer.validate_request(str(self.repo), self.request(ref))

    def test_valid_import_preserves_capsule_bytes_and_receipt(self):
        ref = self.stage()
        root = self.runtime / capsule.HANDOFF_DIRECTORY / ref["handoff_id"]
        before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        ack = self.validate(ref)
        self.assertEqual(ack["handoff_id"], ref["handoff_id"])
        self.assertEqual(ack["asset_count"], 1)
        self.assertEqual(before, {str(p.relative_to(root)): p.read_bytes()
                                for p in root.rglob("*") if p.is_file()})

    def test_restored_scene_matches_semantic_rebase_with_real_asset(self):
        ref = self.stage()
        loaded = semantic.load_scene_handoff(str(self.repo), ref["handoff_id"], self.binding)
        source_path = loaded["source_scene"]["magnetization_assets"][0]["source_path"]
        restored_path = loaded["scene"]["magnetization_assets"][0]["source_path"]
        self.assertNotEqual(source_path, restored_path)
        self.assertEqual(Path(source_path).read_bytes(), Path(restored_path).read_bytes())

        request = self.request(ref, verify_restored_scene=True, restored_scene=loaded["scene"])
        acknowledgement = consumer.validate_request(str(self.repo), request)
        self.assertTrue(acknowledgement["restored_scene_matches"])

        # The original source path is valid capsule data but is not the
        # restored scene after asset rebasing; every other scene field remains
        # part of the semantic comparison too.
        with self.assertRaises(capsule.HandoffError):
            consumer.validate_request(
                str(self.repo),
                self.request(ref, verify_restored_scene=True, restored_scene=loaded["source_scene"]),
            )
        tampered = deepcopy(loaded["scene"])
        tampered["study"]["requested_precision"] = "double"
        with self.assertRaises(capsule.HandoffError):
            consumer.validate_request(
                str(self.repo),
                self.request(ref, verify_restored_scene=True, restored_scene=tampered),
            )

    def test_correct_outer_digest_does_not_hide_invalid_payload_or_component_hash(self):
        for field in ("payload_sha256", "component_sha256"):
            with self.subTest(field=field):
                ref = self.stage()
                root = self.runtime / capsule.HANDOFF_DIRECTORY / ref["handoff_id"]
                path = root / "snapshot.json"
                snapshot = json.loads(path.read_bytes())
                if field == "payload_sha256":
                    snapshot[field] = "0" * 64
                else:
                    snapshot[field]["scene"] = "0" * 64
                raw = capsule._canonical_json(snapshot, "fixture snapshot", capsule.MAX_SNAPSHOT_BYTES)
                path.write_bytes(raw)
                binding_hash = capsule._sha256(capsule._canonical_json(self.binding, "binding", 4096))
                receipt = capsule._new_receipt(ref["handoff_id"], capsule._sha256(raw), binding_hash,
                                               "staged", None)
                (root / "receipt.json").write_bytes(capsule._encode_receipt(receipt))
                with self.assertRaises(capsule.HandoffError):
                    self.validate(ref)

    def test_fully_resigned_snapshot_still_requires_every_scene_asset(self):
        scene = deepcopy(self.scene)
        scene["magnetization_assets"] = []
        ref = self.stage(scene)
        self.rewrite_snapshot(ref, lambda value: value["payload"]["scene"].update(
            magnetization_assets=self.scene["magnetization_assets"]))
        with self.assertRaises(capsule.HandoffError):
            self.validate(ref)

    def test_foreign_root_worktree_digest_and_binding_rejected(self):
        ref = self.stage()
        for field, value in (("storage_root", str(self.repo)), ("worktree_id", "foreign"),
                             ("snapshot_sha256", "0" * 64),
                             ("binding", {**self.binding, "session_epoch": 999})):
            with self.subTest(field=field):
                request = {**self.request(ref), field: value}
                with self.assertRaises(capsule.HandoffError):
                    consumer.validate_request(str(self.repo), request)

    def test_unknown_request_fields_rejected(self):
        ref = self.stage()
        with self.assertRaises(capsule.HandoffError):
            consumer.validate_request(str(self.repo), {**self.request(ref), "helper_path": "foreign"})

    @unittest.skipUnless(os.name == "nt", "Windows verbatim-path contract")
    def test_windows_verbatim_spelling_identifies_the_same_verified_storage(self):
        ref = self.stage()
        request = self.request(ref)
        request["storage_root"] = "\\\\?\\" + str(self.store)
        ack = consumer.validate_request(str(self.repo), request)
        self.assertEqual(ack["snapshot_sha256"], request["snapshot_sha256"])


if __name__ == "__main__":
    unittest.main()
