"""Interpreted semantic capsule checks, without launching or restarting a solver."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_windows_development_handoff import binding
from windows import development_handoff as capsule
from windows import development_scene_handoff as semantic


class SemanticSceneHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Path(self.temp.name) / "storage"
        self.runtime = self.store / "runtimes" / "fixture"
        self.runtime.mkdir(parents=True)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.layout = {"storage_root": str(self.store), "runtime_root": str(self.runtime),
                       "project_root": self.temp.name, "repo_root": str(self.repo),
                       "worktree_id": "fixture"}
        self.marker = self.store / ".fullmag-storage.json"
        self.marker.write_text(json.dumps({"schema": capsule._STORAGE.SCHEMA,
                                          "project_root": self.temp.name}), encoding="utf-8")
        self.registry = self.store / "index" / "fixture.json"
        self.registry.parent.mkdir()
        self.owner = {"schema": capsule._STORAGE.SCHEMA, "worktree_id": "fixture",
                      "repo_root": str(self.repo), "task_id": "handoff-fixture",
                      "owner": "fixture-owner", "state": "wip"}
        self.registry.write_text(json.dumps(self.owner), encoding="utf-8")
        self.patch = patch.object(capsule._STORAGE, "resolve_layout", return_value=self.layout)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.binding = binding()
        self.source = self.store / "runs" / "initial.ovf"
        self.source.parent.mkdir()
        self.source.write_bytes(b"nonempty imported magnetization fixture")
        self.scene = {
            "version": "scene.v2", "revision": 5,
            "scene": {"id": "scene-fixture", "name": "Imported state"},
            "objects": [],
            "magnetization_assets": [{"id": "mag-1", "name": "Initial M", "kind": "sampled",
                                        "source_path": str(self.source), "source_format": "ovf"}],
            "study": {"requested_device": "gpu", "requested_precision": "single"},
        }

    def stage(self, scene=None):
        return semantic.create_scene_handoff(str(self.repo), self.binding,
                                             self.scene if scene is None else scene,
                                             {"selected_object_id": "body"},
                                             {"camera": {"zoom": 3}}, {"project_id": "project-fixture"})

    def load(self, ref):
        return semantic.load_scene_handoff(str(self.repo), ref["handoff_id"], self.binding)

    def rewrite_snapshot(self, ref, edit):
        capsule_dir = self.runtime / capsule.HANDOFF_DIRECTORY / ref["handoff_id"]
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
            ref["handoff_id"], capsule._sha256(snapshot_bytes), binding_hash, "staged", None
        )
        (capsule_dir / "receipt.json").write_bytes(capsule._encode_receipt(receipt))

    def stage_empty(self, binding=None):
        empty_binding = {**self.binding, "session_id": None} if binding is None else binding
        return semantic.create_empty_workspace_handoff(
            str(self.repo), empty_binding,
            {"tabs": ["scene", "materials"], "drafts": {"material": {"dirty": True}}},
            {"camera": {"zoom": 2.25}, "active_view": "viewport"},
            {"project_id": "project-empty-fixture", "revision": 14},
        )

    def test_requires_existing_project_marker_before_any_handoff_write(self):
        for value in (None, {"schema": capsule._STORAGE.SCHEMA, "project_root": "another-project"}):
            with self.subTest(marker=value):
                if value is None:
                    self.marker.unlink()
                else:
                    self.marker.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(capsule.HandoffError):
                    self.stage()
                self.assertFalse((self.runtime / capsule.HANDOFF_DIRECTORY).exists())

    def test_requires_matching_active_worktree_registration_before_write(self):
        for field, value in (("schema", "unknown"), ("worktree_id", "foreign"),
                             ("repo_root", "another-checkout"), ("task_id", ""),
                             ("owner", " "), ("state", "completed"), ("state", [])):
            with self.subTest(field=field):
                owner = {**self.owner, field: value}
                self.registry.write_text(json.dumps(owner), encoding="utf-8")
                with self.assertRaises(capsule.HandoffError):
                    self.stage()
                self.assertFalse((self.runtime / capsule.HANDOFF_DIRECTORY).exists())
        self.registry.unlink()
        with self.assertRaises(capsule.HandoffError):
            self.stage()
        self.assertFalse(self.registry.exists())

    def test_revalidates_storage_registration_when_loading_a_capsule(self):
        ref = self.stage()
        self.registry.write_text(json.dumps({**self.owner, "state": "completed"}), encoding="utf-8")
        with self.assertRaises(capsule.HandoffError):
            self.load(ref)

    def test_empty_workspace_round_trips_ui_without_fabricating_session_or_scene_ids(self):
        binding = {**self.binding, "session_id": None}
        editor = {"tabs": ["scene", "materials"], "drafts": {"material": {"dirty": True}}}
        workspace = {"camera": {"zoom": 2.25}, "active_view": "viewport"}
        project_document = {"project_id": "project-empty-fixture", "revision": 14}
        reference = semantic.create_empty_workspace_handoff(
            str(self.repo), binding, editor, workspace, project_document
        )
        loaded = semantic.load_scene_handoff(str(self.repo), reference["handoff_id"], binding)

        self.assertEqual(capsule.EMPTY_WORKSPACE_SCHEMA, "fullmag.development-empty-workspace-handoff.v1")
        self.assertEqual(loaded["schema"], capsule.EMPTY_WORKSPACE_SCHEMA)
        self.assertIsNone(loaded["binding"]["session_id"])
        self.assertIsNone(loaded["scene"])
        self.assertIsNone(loaded["source_scene"])
        self.assertEqual(loaded["assets"], [])
        self.assertEqual(loaded["editor"], editor)
        self.assertEqual(loaded["workspace"], workspace)
        self.assertEqual(loaded["project_document"], project_document)
        self.assertEqual(loaded["receipt"]["state"], "staged")
        self.assertEqual(reference["snapshot_sha256"], loaded["snapshot_sha256"])
        self.assertNotIn("scene_id", loaded["binding"])

    def test_empty_workspace_writer_requires_no_session_identity(self):
        with self.assertRaisesRegex(capsule.HandoffError, "must not claim a session"):
            self.stage_empty({**self.binding, "session_id": "session-invented"})

    def test_empty_workspace_schema_rejects_scene_session_and_assets(self):
        mutations = (
            ("scene", lambda snapshot: snapshot["payload"].update(scene={"id": "invented"})),
            ("session", lambda snapshot: snapshot["binding"].update(session_id="session-invented")),
            ("assets", lambda snapshot: snapshot.update(assets=[{
                "asset_id": "invented-asset", "path": f"assets/{'0' * 64}.blob",
                "sha256": "0" * 64, "size_bytes": 1,
            }])),
        )
        for label, mutation in mutations:
            with self.subTest(field=label):
                reference = self.stage_empty()
                self.rewrite_snapshot(reference, mutation)
                expected = {**self.binding, "session_id": None}
                if label == "session":
                    expected = {**self.binding, "session_id": "session-invented"}
                with self.assertRaises(capsule.HandoffError):
                    semantic.load_scene_handoff(str(self.repo), reference["handoff_id"], expected)

    def test_empty_workspace_detects_snapshot_and_receipt_corruption(self):
        reference = self.stage_empty()
        empty_binding = {**self.binding, "session_id": None}
        capsule_dir = self.runtime / capsule.HANDOFF_DIRECTORY / reference["handoff_id"]
        snapshot_path = capsule_dir / "snapshot.json"
        snapshot_path.write_bytes(snapshot_path.read_bytes() + b" ")
        with self.assertRaises(capsule.HandoffError):
            semantic.load_scene_handoff(str(self.repo), reference["handoff_id"], empty_binding)

        reference = self.stage_empty()
        receipt_path = self.runtime / capsule.HANDOFF_DIRECTORY / reference["handoff_id"] / "receipt.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["state"] = "restored"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaises(capsule.HandoffError):
            semantic.load_scene_handoff(str(self.repo), reference["handoff_id"], empty_binding)

    def test_empty_workspace_terminal_receipts_are_supported_and_guarded(self):
        failed_ref = self.stage_empty()
        failed = capsule.record_handoff_outcome(
            self.runtime, failed_ref["handoff_id"], {**self.binding, "session_id": None},
            "failed", detail="new API did not remain empty",
        )
        self.assertEqual(failed["state"], "failed")
        expected = {**self.binding, "session_id": None}
        failed_loaded = capsule.load_handoff(self.runtime, failed_ref["handoff_id"], expected)
        self.assertIsNone(failed_loaded["scene"])
        self.assertEqual(failed_loaded["receipt"]["detail"], "new API did not remain empty")
        with self.assertRaisesRegex(capsule.HandoffError, "Only a staged handoff"):
            semantic.load_scene_handoff(str(self.repo), failed_ref["handoff_id"], expected)

        restored_ref = self.stage_empty()
        expected = {**self.binding, "session_id": None}
        restored = capsule.record_handoff_outcome(
            self.runtime, restored_ref["handoff_id"], expected, "restored", detail="empty UI restored"
        )
        replay = capsule.record_handoff_outcome(
            self.runtime, restored_ref["handoff_id"], expected, "restored", detail="empty UI restored"
        )
        self.assertEqual(replay, restored)
        with self.assertRaises(capsule.HandoffError):
            capsule.record_handoff_outcome(
                self.runtime, restored_ref["handoff_id"], expected, "failed", detail="conflicting terminal"
            )

    def test_refuses_rebase_when_a_copied_asset_is_missing_or_modified(self):
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt):
                ref = self.stage()
                loaded = self.load(ref)
                copy = Path(loaded["scene"]["magnetization_assets"][0]["source_path"])
                if corrupt:
                    copy.write_bytes(b"incorrect data of a different length")
                else:
                    copy.unlink()
                with self.assertRaises(capsule.HandoffError):
                    self.load(ref)
                receipt_path = self.runtime / capsule.HANDOFF_DIRECTORY / ref["handoff_id"] / "receipt.json"
                receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                self.assertEqual(receipt["state"], "staged")

    def test_copies_managed_run_asset_and_rebases_without_changing_original_scene(self):
        original = deepcopy(self.scene)
        ref = self.stage()
        self.source.unlink()
        restored = self.load(ref)
        path = Path(restored["scene"]["magnetization_assets"][0]["source_path"])
        self.assertTrue(path.is_relative_to(self.runtime))
        self.assertEqual(path.suffix, ".ovf")
        self.assertEqual(path.read_bytes(), b"nonempty imported magnetization fixture")
        self.assertEqual(self.scene, original)
        self.assertEqual(restored["source_scene"], original)
        self.assertEqual(restored["scene"]["study"], original["study"])
        self.assertEqual(restored["workspace"], {"camera": {"zoom": 3}})
        self.assertEqual(restored["receipt"]["state"], "staged")

    def test_restored_model_can_be_staged_again_from_verified_prior_capsule(self):
        first = self.stage()
        self.source.unlink()
        prior = self.load(first)
        second = self.stage(prior["scene"])
        restored = self.load(second)
        self.assertNotEqual(first["handoff_id"], second["handoff_id"])
        second_path = Path(restored["scene"]["magnetization_assets"][0]["source_path"])
        self.assertIn(second["handoff_id"], str(second_path))
        self.assertEqual(second_path.read_bytes(), b"nonempty imported magnetization fixture")
        self.assertEqual(second_path.suffix, ".ovf")

    def test_preserves_mesh_source_extension_required_by_native_planner(self):
        mesh = self.store / "runs" / "mesh.JSON"
        mesh.write_bytes(b'{"mesh_fixture":true}')
        scene = deepcopy(self.scene)
        scene["objects"] = [{"id": "body", "name": "Body", "material_ref": "material-1",
                             "geometry": {"geometry_kind": "Box", "geometry_params": {}},
                             "object_mesh": {"mode": "import", "source": str(mesh)}}]
        restored = self.load(self.stage(scene))
        path = Path(restored["scene"]["objects"][0]["object_mesh"]["source"])
        self.assertEqual(path.suffix.lower(), ".json")
        self.assertEqual(path.read_bytes(), mesh.read_bytes())

    def test_copies_equilibrium_artifact_and_preserves_its_exact_bytes(self):
        artifact = self.store / "runs" / "equilibrium.json"
        data = b'{"schema_version":"equilibrium_artifact.v7","fixture":true}'
        artifact.write_bytes(data)
        scene = deepcopy(self.scene)
        scene["study"]["stages"] = [{"kind": "eigenmodes",
            "eigen_equilibrium_source": "artifact", "eigen_equilibrium_artifact": str(artifact)}]
        ref = self.stage(scene)
        artifact.unlink()
        restored = self.load(ref)
        stage = restored["scene"]["study"]["stages"][0]
        self.assertEqual(stage["eigen_equilibrium_source"], "artifact")
        self.assertEqual(Path(stage["eigen_equilibrium_artifact"]).read_bytes(), data)
        self.assertEqual(restored["source_scene"], scene)
        self.assertEqual(restored["scene"]["study"]["requested_device"], "gpu")

    def test_duplicate_content_with_differently_cased_suffixes_loads_once(self):
        upper = self.source.with_suffix(".OVF")
        # On Windows this is the same path; on Linux it is a separate fixture.
        if upper != self.source:
            upper.write_bytes(self.source.read_bytes())
        scene = deepcopy(self.scene)
        scene["study"]["initial_state"] = {"source_path": str(upper), "format": "ovf"}
        restored = self.load(self.stage(scene))
        first_path = restored["scene"]["magnetization_assets"][0]["source_path"]
        self.assertEqual(first_path, restored["scene"]["study"]["initial_state"]["source_path"])
        self.assertEqual(len(restored["assets"]), 2)

    def test_missing_or_outside_storage_assets_fail_before_publishing_capsule(self):
        outside = Path(self.temp.name) / "outside.ovf"
        outside.write_bytes(b"unmanaged")
        for path in (outside, self.store / "missing.ovf"):
            with self.subTest(path=path):
                scene = deepcopy(self.scene)
                scene["magnetization_assets"][0]["source_path"] = str(path)
                with self.assertRaises(capsule.HandoffError):
                    self.stage(scene)
        self.assertFalse((self.runtime / capsule.HANDOFF_DIRECTORY).exists())

    def test_source_change_during_staging_rejects_snapshot_and_keeps_source(self):
        original_stage = capsule._stage_handoff

        def mutate(*args, **kwargs):
            self.source.write_bytes(b"changed after preflight")
            return original_stage(*args, **kwargs)

        with patch.object(capsule, "_stage_handoff", side_effect=mutate):
            with self.assertRaises(capsule.HandoffError):
                self.stage()
        self.assertEqual(self.source.read_bytes(), b"changed after preflight")
        self.assertEqual(list((self.runtime / capsule.HANDOFF_DIRECTORY).iterdir()), [])

    def test_rejects_unclaimed_manifest_asset_in_semantic_reader(self):
        extra = self.runtime / "extra.dat"
        extra.write_bytes(b"orphan")
        ref = capsule.create_handoff(self.runtime, self.binding, {"version": "scene.v2", "objects": []},
                                     {}, {}, {}, assets=[{"asset_id": "unclaimed", "source_path": str(extra),
                                                          "sha256": hashlib.sha256(b"orphan").hexdigest()}])
        with self.assertRaises(capsule.HandoffError):
            self.load(ref)

    def test_legacy_blob_is_readable_but_cannot_silently_lose_source_format(self):
        source = self.runtime / "original.ovf"
        source.write_bytes(b"legacy source")
        scene = deepcopy(self.scene)
        scene["magnetization_assets"][0]["source_path"] = str(source)
        ref = capsule.create_handoff(
            self.runtime, self.binding, scene, {}, {}, {},
            assets=[{"asset_id": "/magnetization_assets/0/source_path", "source_path": str(source),
                     "sha256": hashlib.sha256(b"legacy source").hexdigest()}],
        )
        self.assertEqual(capsule.load_handoff(self.runtime, ref["handoff_id"], self.binding)["scene"], scene)
        with self.assertRaisesRegex(capsule.HandoffError, "source format suffix"):
            self.load(ref)

    def test_tampered_prior_capsule_cannot_be_reused(self):
        ref = self.stage()
        scene = self.load(ref)["scene"]
        receipt_path = self.runtime / capsule.HANDOFF_DIRECTORY / ref["handoff_id"] / "receipt.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["state"] = "restored"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaises(capsule.HandoffError):
            self.stage(scene)

    def test_v2_manifest_rejects_escaping_paths_even_with_matching_receipt_hashes(self):
        ref = self.stage()
        directory = self.runtime / capsule.HANDOFF_DIRECTORY / ref["handoff_id"]
        snapshot_path = directory / "snapshot.json"
        original = json.loads(snapshot_path.read_text(encoding="utf-8"))
        for suffix in (".ovf/../../outside", ".ovf.exe", ".", "." + "x" * 17):
            with self.subTest(suffix=suffix):
                snapshot = deepcopy(original)
                digest = snapshot["assets"][0]["sha256"]
                snapshot["assets"][0]["path"] = f"assets/{digest}{suffix}"
                data = capsule._canonical_json(snapshot, "fixture snapshot", capsule.MAX_SNAPSHOT_BYTES)
                snapshot_path.write_bytes(data)
                binding_hash = capsule._sha256(capsule._canonical_json(self.binding, "fixture binding", 4096))
                receipt = capsule._new_receipt(ref["handoff_id"], capsule._sha256(data), binding_hash, "staged", None)
                (directory / "receipt.json").write_bytes(capsule._encode_receipt(receipt))
                with self.assertRaisesRegex(capsule.HandoffError, "content-addressed"):
                    self.load(ref)
