from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from windows import development_handoff as capsule
from windows.development_handoff import (
    HandoffError,
    create_handoff,
    load_handoff,
    record_handoff_outcome,
)


def binding() -> dict[str, object]:
    return {
        "api_instance_id": str(uuid.uuid4()),
        "generation_id": uuid.uuid4().hex,
        "session_id": f"session-{uuid.uuid4().hex}",
        "session_epoch": 7,
        "source_build_id": "backend-dev:9b77a1f3",
        "target_build_id": "backend-dev:4f9a5d21",
        "source_sha256": "a" * 64,
    }


def scene_document() -> dict[str, object]:
    return {
        "version": "scene.v2",
        "revision": 19,
        "scene": {"id": "scene-1", "name": "Full scene", "source_of_truth": "repo_head"},
        "objects": [{"id": "object-1", "name": "Body", "magnetization_ref": "mag-1"}],
        "couplings": [{"id": "coupling-1", "members": ["object-1"]}],
        "selections": [{"id": "selection-1", "expression": {"future_projection": [1, 2]}}],
        "magnetization_constraints": [{"id": "constraint-1", "reference": {"asset_id": "mag-1"}}],
        "magnetization_assets": [{"id": "mag-1", "kind": "uniform", "value": [1, 0, 0]}],
        "study": {
            "requested_device": "gpu",
            "requested_precision": "single",
            "solver": {"integrator": "rk4"},
        },
        "outputs": {"items": [{"id": "output-1", "unsupported_projection_field": True}]},
        "editor": {"selected_object_id": "object-1", "future_scene_editor_field": {"zoom": 2.5}},
        "future_authoring_metadata": {"projection_only": True, "revision": "opaque"},
    }


class DevelopmentHandoffTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "runtime"
        self.root.mkdir()
        self.binding = binding()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def create(self, *, assets: list[dict[str, str]] | None = None) -> dict[str, object]:
        return create_handoff(
            self.root,
            self.binding,
            scene_document(),
            {"drafts": {"material": {"dirty": True, "value": "Ms=800e3"}}},
            {"selection": {"object_id": "object-1"}, "camera": {"zoom": 2.5}},
            {"project_id": "project-1", "revision": 6, "archive_base64": "AQID"},
            assets=[] if assets is None else assets,
        )

    def load(self, reference: dict[str, object], expected: dict[str, object] | None = None) -> dict[str, object]:
        return load_handoff(self.root, reference["handoff_id"], self.binding if expected is None else expected)

    def rewrite_snapshot(self, reference: dict[str, object], edit) -> None:
        capsule_dir = self.root / "development-handoffs" / reference["handoff_id"]
        snapshot_path = capsule_dir / "snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        edit(snapshot)
        payload = snapshot["payload"]
        snapshot["payload_sha256"] = capsule._sha256(
            capsule._canonical_json(payload, "fixture payload", capsule.MAX_SNAPSHOT_BYTES)
        )
        snapshot["component_sha256"] = {
            field: capsule._sha256(
                capsule._canonical_json(payload[field], f"fixture payload.{field}", capsule.MAX_SNAPSHOT_BYTES)
            )
            for field in capsule._PAYLOAD_FIELDS
        }
        snapshot_bytes = capsule._canonical_json(snapshot, "fixture snapshot", capsule.MAX_SNAPSHOT_BYTES)
        snapshot_path.write_bytes(snapshot_bytes)
        binding_hash = capsule._sha256(
            capsule._canonical_json(snapshot["binding"], "fixture binding", 4096)
        )
        receipt = capsule._new_receipt(
            reference["handoff_id"], capsule._sha256(snapshot_bytes), binding_hash, "staged", None
        )
        (capsule_dir / "receipt.json").write_bytes(capsule._encode_receipt(receipt))

    def test_round_trips_full_scene_and_separate_authoring_payloads(self) -> None:
        reference = self.create()
        loaded = self.load(reference)

        self.assertEqual(loaded["scene"], scene_document())
        self.assertIn("couplings", loaded["scene"])
        self.assertIn("selections", loaded["scene"])
        self.assertIn("magnetization_constraints", loaded["scene"])
        self.assertEqual(loaded["scene"]["study"]["requested_device"], "gpu")
        self.assertEqual(loaded["scene"]["future_authoring_metadata"], {"projection_only": True, "revision": "opaque"})
        self.assertEqual(loaded["editor"]["drafts"]["material"]["value"], "Ms=800e3")
        self.assertEqual(loaded["workspace"]["selection"]["object_id"], "object-1")
        self.assertEqual(loaded["project_document"]["project_id"], "project-1")
        self.assertEqual(loaded["receipt"]["state"], "staged")
        self.assertEqual(reference["snapshot_sha256"], loaded["snapshot_sha256"])

    def test_rejects_binding_from_another_api_or_session_epoch(self) -> None:
        reference = self.create()
        mismatched = dict(self.binding)
        mismatched["api_instance_id"] = str(uuid.uuid4())
        with self.assertRaises(HandoffError):
            self.load(reference, mismatched)
        mismatched = dict(self.binding)
        mismatched["session_epoch"] = 8
        with self.assertRaises(HandoffError):
            self.load(reference, mismatched)

    def test_rejects_snapshot_tampering(self) -> None:
        reference = self.create()
        snapshot = self.root / "development-handoffs" / reference["handoff_id"] / "snapshot.json"
        data = json.loads(snapshot.read_text(encoding="utf-8"))
        data["payload"]["scene"]["revision"] = 20
        snapshot.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(HandoffError):
            self.load(reference)

    def test_rejects_receipt_tampering(self) -> None:
        reference = self.create()
        receipt_path = self.root / "development-handoffs" / reference["handoff_id"] / "receipt.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["state"] = "restored"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaises(HandoffError):
            self.load(reference)

    def test_rejects_asset_path_traversal_and_unhashed_content(self) -> None:
        outside = Path(self.temp.name) / "outside.dat"
        outside.write_bytes(b"external")
        asset = {"asset_id": "asset-1", "source_path": str(outside), "sha256": hashlib.sha256(b"external").hexdigest()}
        with self.assertRaises(HandoffError):
            self.create(assets=[asset])

        inside = self.root / "source.dat"
        inside.write_bytes(b"content")
        bad_hash = {"asset_id": "asset-1", "source_path": str(inside), "sha256": "0" * 64}
        with self.assertRaises(HandoffError):
            self.create(assets=[bad_hash])

    def test_copies_and_revalidates_explicit_assets(self) -> None:
        source = self.root / "source.dat"
        source.write_bytes(b"authoring asset")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        reference = self.create(assets=[{"asset_id": "asset-1", "source_path": str(source), "sha256": digest}])
        loaded = self.load(reference)
        self.assertEqual(len(loaded["assets"]), 1)
        self.assertEqual(loaded["assets"][0]["asset_id"], "asset-1")
        self.assertEqual(loaded["assets"][0]["sha256"], digest)
        self.assertEqual(loaded["assets"][0]["size_bytes"], len(b"authoring asset"))
        self.assertTrue(Path(loaded["assets"][0]["storage_path"]).is_file())

        asset_file = self.root / "development-handoffs" / reference["handoff_id"] / "assets" / f"{digest}.blob"
        asset_file.write_bytes(b"tampered")
        with self.assertRaises(HandoffError):
            self.load(reference)

    def test_rejects_symlinked_asset_source_when_supported(self) -> None:
        outside = Path(self.temp.name) / "outside.dat"
        outside.write_bytes(b"external")
        link = self.root / "linked.dat"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable")
        asset = {"asset_id": "asset-1", "source_path": str(link), "sha256": hashlib.sha256(b"external").hexdigest()}
        with self.assertRaises(HandoffError):
            self.create(assets=[asset])

    def test_rejects_partial_capsules_and_duplicate_json_keys(self) -> None:
        handoff_id = str(uuid.uuid4())
        capsule = self.root / "development-handoffs" / handoff_id
        capsule.mkdir(parents=True)
        (capsule / "snapshot.json").write_text('{"schema":"first","schema":"second"}', encoding="utf-8")
        with self.assertRaises(HandoffError):
            load_handoff(self.root, handoff_id, self.binding)

    def test_rejects_non_json_nan(self) -> None:
        scene = scene_document()
        scene["unsupported_projection_field"] = float("nan")
        with self.assertRaises(HandoffError):
            create_handoff(self.root, self.binding, scene, {}, {}, {}, assets=[])

    def test_rejects_non_string_json_keys_without_coercing_them(self) -> None:
        editor = {1: "would be coerced to a string by json.dumps"}
        with self.assertRaises(HandoffError):
            create_handoff(self.root, self.binding, scene_document(), editor, {}, {}, assets=[])

    def test_bounds_snapshot_reads_before_parsing(self) -> None:
        reference = self.create()
        with patch("windows.development_handoff.MAX_SNAPSHOT_BYTES", 32):
            with self.assertRaises(HandoffError):
                self.load(reference)

    def test_failed_restore_keeps_original_snapshot(self) -> None:
        reference = self.create()
        receipt = record_handoff_outcome(self.root, reference["handoff_id"], self.binding, "failed", detail="restore rejected")
        loaded = self.load(reference)
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(loaded["scene"], scene_document())
        self.assertEqual(loaded["receipt"]["detail"], "restore rejected")

    def test_outcome_transitions_are_guarded_and_terminal_replays_must_match(self) -> None:
        reference = self.create()
        staged = record_handoff_outcome(self.root, reference["handoff_id"], self.binding, "staged")
        self.assertEqual(staged["state"], "staged")
        restored = record_handoff_outcome(self.root, reference["handoff_id"], self.binding, "restored", detail="new API ready")
        self.assertEqual(restored["state"], "restored")
        replay = record_handoff_outcome(self.root, reference["handoff_id"], self.binding, "restored", detail="new API ready")
        self.assertEqual(replay, restored)
        with self.assertRaises(HandoffError):
            record_handoff_outcome(self.root, reference["handoff_id"], self.binding, "failed", detail="different terminal result")

    def test_rejects_unknown_binding_fields(self) -> None:
        malformed = dict(self.binding)
        malformed["pid"] = 1
        with self.assertRaises(HandoffError):
            create_handoff(self.root, malformed, scene_document(), {}, {}, {}, assets=[])

    def test_legacy_capsule_schemas_reject_null_sessions_and_scenes(self) -> None:
        for schema in (capsule.SCHEMA, capsule.SCENE_ASSET_SCHEMA):
            with self.subTest(schema=schema, field="session_id"):
                reference = self.create()
                self.rewrite_snapshot(
                    reference,
                    lambda snapshot: snapshot.update(
                        schema=schema,
                        binding={**snapshot["binding"], "session_id": None},
                    ),
                )
                with self.assertRaises(HandoffError):
                    self.load(reference)

            with self.subTest(schema=schema, field="scene"):
                reference = self.create()
                self.rewrite_snapshot(
                    reference,
                    lambda snapshot: snapshot.update(
                        schema=schema,
                        payload={**snapshot["payload"], "scene": None},
                    ),
                )
                with self.assertRaises(HandoffError):
                    self.load(reference)

    def test_generic_legacy_writer_does_not_accept_a_null_session(self) -> None:
        malformed = {**self.binding, "session_id": None}
        with self.assertRaises(HandoffError):
            create_handoff(self.root, malformed, scene_document(), {}, {}, {}, assets=[])


if __name__ == "__main__":
    unittest.main()
