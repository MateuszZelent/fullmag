"""Interpreted manager staging checks; no process shutdown or solver execution."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from test_windows_development_restore_launch import _write_candidate
from windows import development_acquisition_handoff as manager
from windows import development_handoff as capsule
from windows import development_scene_handoff as semantic
from windows import runtime_bundle


class AcquisitionHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.repo = base / "repo"
        self.repo.mkdir()
        self.store = base / "storage"
        self.runtime = self.store / "runtimes" / "fixture"
        self.runtime.mkdir(parents=True)
        (self.store / ".fullmag-storage.json").write_text(json.dumps(
            {"schema": capsule._STORAGE.SCHEMA, "project_root": str(base)}), encoding="utf-8")
        (self.store / "index").mkdir()
        (self.store / "index" / "fixture.json").write_text(json.dumps(
            {"schema": capsule._STORAGE.SCHEMA, "worktree_id": "fixture", "repo_root": str(self.repo),
             "task_id": "acquisition-fixture", "owner": "fixture", "state": "wip"}), encoding="utf-8")
        layout = {"storage_root": str(self.store), "runtime_root": str(self.runtime),
                  "project_root": str(base), "repo_root": str(self.repo), "worktree_id": "fixture"}
        mocked = patch.object(capsule._STORAGE, "resolve_layout", return_value=layout)
        mocked.start()
        self.addCleanup(mocked.stop)
        self.candidate, _ = _write_candidate(self.runtime)
        self.source = {"api_instance_id": str(uuid.uuid4()), "generation_id": uuid.uuid4().hex,
                       "source_build_id": "1.2.2-dev", "source_sha256": "a" * 64}
        self.frontend = {"api_instance_id": self.source["api_instance_id"], "session_id": None,
                         "session_epoch": 4, "editor": {"unsaved_script": "world = fm.World()"},
                         "workspace": {"inspector_hidden": True},
                         "project_document": {"dirty": True, "name": "Nowy projekt"}}
        self.acquisition = {"schema": manager.ACQUISITION_SCHEMA, "nonce": str(uuid.uuid4()),
                            "api_instance_id": self.source["api_instance_id"],
                            "workspace": {"state": "no_session", "session_epoch": 4}}

    def stage(self, data=None):
        return manager.stage_acquired_workspace(str(self.repo),
            json.dumps(self.acquisition).encode() if data is None else data,
            self.source, str(self.candidate), self.frontend)

    def prepare_commit(self, data=None, acknowledgement=None):
        data = json.dumps(self.acquisition).encode() if data is None else data
        if acknowledgement is None:
            acknowledgement = self.stage(data)
        return manager.prepare_acquired_workspace_commit(
            str(self.repo), data, self.source, str(self.candidate), acknowledgement, self.frontend
        )

    def assert_no_capsule(self):
        self.assertFalse((self.runtime / capsule.HANDOFF_DIRECTORY).exists())

    def test_empty_acquisition_stages_scoped_frontend_without_inventing_scene(self):
        result = self.stage()
        self.assertEqual(result["workspace_state"], "no_session")
        self.assertEqual(result["acquisition_nonce"], self.acquisition["nonce"])
        self.assertIsNone(result["binding"]["session_id"])
        loaded = semantic.load_scene_handoff(str(self.repo), result["handoff"]["handoff_id"], result["binding"])
        self.assertIsNone(loaded["source_scene"])
        self.assertEqual(loaded["project_document"], self.frontend["project_document"])
        self.assertEqual(loaded["editor"], self.frontend["editor"])
        self.assertEqual(loaded["receipt"]["state"], "staged")

    def test_precommit_check_returns_owner_binding_and_keeps_empty_handoff_staged(self):
        acknowledgement = self.stage()
        result = self.prepare_commit(acknowledgement=acknowledgement)
        self.assertEqual(result["acquisition_nonce"], self.acquisition["nonce"])
        self.assertEqual(result["binding"], acknowledgement["binding"])
        self.assertEqual(result["reference"], acknowledgement["handoff"])
        self.assertEqual(result["preparation"]["workspace_state"], "no_session")
        self.assertIsNone(result["preparation"]["envelope"])
        receipt_path = (self.runtime / capsule.HANDOFF_DIRECTORY /
                        acknowledgement["handoff"]["handoff_id"] / "receipt.json")
        self.assertEqual(json.loads(receipt_path.read_text(encoding="utf-8"))["state"], "staged")

    def test_precommit_check_accepts_captured_scene_without_marking_receipt(self):
        wire, scene = self.scene_acquisition()
        acknowledgement = self.stage(wire)
        result = self.prepare_commit(wire, acknowledgement)
        self.assertEqual(result["preparation"]["workspace_state"], "session")
        self.assertEqual(result["preparation"]["envelope"]["scene_document"], scene)
        loaded = semantic.load_scene_handoff(
            str(self.repo), acknowledgement["handoff"]["handoff_id"], result["binding"]
        )
        self.assertEqual(loaded["source_scene"], scene)
        self.assertEqual(loaded["receipt"]["state"], "staged")

    def test_precommit_check_rejects_foreign_or_malformed_acknowledgement(self):
        acknowledgement = self.stage()
        mutations = (
            lambda value: value.update(extra=True),
            lambda value: value.update(acquisition_nonce=str(uuid.uuid4())),
            lambda value: value["binding"].update(api_instance_id=str(uuid.uuid4())),
            lambda value: value["binding"].update(session_epoch=5),
            lambda value: value["binding"].update(session_epoch=True),
            lambda value: value["handoff"].update(state="restored"),
        )
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                altered = deepcopy(acknowledgement)
                mutate(altered)
                with self.assertRaises(capsule.HandoffError):
                    self.prepare_commit(acknowledgement=altered)

    def test_precommit_check_rechecks_source_scene_and_scoped_ui_payload(self):
        wire, _scene = self.scene_acquisition()
        acknowledgement = self.stage(wire)
        original = semantic.load_scene_handoff
        reads = 0

        def altered_scene(*args):
            nonlocal reads
            loaded = original(*args)
            reads += 1
            if reads == 2:
                loaded["source_scene"]["scene"]["name"] = "Changed after staging"
            return loaded

        with patch.object(semantic, "load_scene_handoff", side_effect=altered_scene):
            with self.assertRaises(capsule.HandoffError):
                self.prepare_commit(wire, acknowledgement)

        self.acquisition = {
            "schema": manager.ACQUISITION_SCHEMA,
            "nonce": str(uuid.uuid4()),
            "api_instance_id": self.source["api_instance_id"],
            "workspace": {"state": "no_session", "session_epoch": 4},
        }
        self.frontend["session_id"] = None
        acknowledgement = self.stage()
        reads = 0

        def altered_frontend(*args):
            nonlocal reads
            loaded = original(*args)
            reads += 1
            if reads == 2:
                loaded["project_document"] = {"dirty": False}
            return loaded

        with patch.object(semantic, "load_scene_handoff", side_effect=altered_frontend):
            with self.assertRaises(capsule.HandoffError):
                self.prepare_commit(acknowledgement=acknowledgement)

    def test_precommit_check_rejects_changed_snapshot(self):
        acknowledgement = self.stage()
        snapshot = (self.runtime / capsule.HANDOFF_DIRECTORY /
                    acknowledgement["handoff"]["handoff_id"] / "snapshot.json")
        snapshot.write_bytes(snapshot.read_bytes() + b" ")
        with self.assertRaises(capsule.HandoffError):
            self.prepare_commit(acknowledgement=acknowledgement)

    def test_precommit_check_rejects_candidate_changed_after_staging(self):
        acknowledgement = self.stage()
        (self.candidate / "bin" / runtime_bundle.BINARY_NAMES[0]).write_bytes(b"changed candidate")
        with self.assertRaises(capsule.HandoffError):
            self.prepare_commit(acknowledgement=acknowledgement)

    def test_precommit_check_rejects_terminal_receipt(self):
        acknowledgement = self.stage()
        capsule.record_handoff_outcome(
            self.runtime, acknowledgement["handoff"]["handoff_id"], acknowledgement["binding"], "restored"
        )
        with self.assertRaises(capsule.HandoffError):
            self.prepare_commit(acknowledgement=acknowledgement)

    def test_stale_frontend_scope_rejected_before_write(self):
        for field, value in (("api_instance_id", str(uuid.uuid4())), ("session_id", "invented"),
                             ("session_epoch", 5), ("session_epoch", True)):
            with self.subTest(field=field, value=value):
                payload = deepcopy(self.frontend)
                payload[field] = value
                with self.assertRaises(capsule.HandoffError):
                    manager.stage_acquired_workspace(str(self.repo), json.dumps(self.acquisition).encode(),
                        self.source, str(self.candidate), payload)
                self.assert_no_capsule()

    def test_untrusted_candidate_rejected_before_write(self):
        foreign, _ = _write_candidate(self.runtime, workspace_namespace="foreign")
        with self.assertRaises(capsule.HandoffError):
            manager.stage_acquired_workspace(str(self.repo), json.dumps(self.acquisition).encode(),
                self.source, str(foreign), self.frontend)
        self.assert_no_capsule()

    def test_malformed_or_foreign_acquisition_rejected_before_write(self):
        for mutate in (lambda x: x.update(nonce="invalid"),
                       lambda x: x.update(api_instance_id=str(uuid.uuid4())),
                       lambda x: x["workspace"].update(scene_document={}),
                       lambda x: x["workspace"].update(session_epoch=True)):
            value = deepcopy(self.acquisition)
            mutate(value)
            with self.assertRaises(capsule.HandoffError):
                self.stage(json.dumps(value).encode())
            self.assert_no_capsule()
        with self.assertRaises(capsule.HandoffError):
            self.stage(b'{"schema":1,"schema":2}')
        self.assert_no_capsule()

    def scene_acquisition(self):
        scene = {"version": "scene.v2", "revision": 3,
                 "scene": {"id": "scene-fixture", "name": "Tiny scale"},
                 "objects": [], "editor": {"scale": 1e-6}}
        self.frontend["session_id"] = "session-fixture"
        self.acquisition["workspace"] = {"state": "session",
            "identity": {"api_instance_id": self.source["api_instance_id"],
                "session_id": "session-fixture", "session_epoch": 4, "run_id": None, "scene_id": "scene-fixture"},
            "scene_document": scene, "scene_sha256": "pending"}
        wire = json.dumps(self.acquisition, ensure_ascii=False).replace("1e-06", "1e-6").encode()
        # Fixed independently authored bytes: do not derive the expected hash
        # with the production canonicalizer that this check exercises.
        canonical = (b'{"editor":{"scale":1e-6},"objects":[],"revision":3,'
                     b'"scene":{"id":"scene-fixture","name":"Tiny scale"},"version":"scene.v2"}')
        digest = capsule._sha256(canonical)
        return wire.replace(b'"pending"', ('"' + digest + '"').encode()), scene

    def test_scene_wire_numeric_hash_preserved_and_read_back(self):
        wire, scene = self.scene_acquisition()
        result = self.stage(wire)
        loaded = semantic.load_scene_handoff(str(self.repo), result["handoff"]["handoff_id"], result["binding"])
        self.assertEqual(loaded["source_scene"], scene)
        self.assertEqual(result["workspace_state"], "session")

    def test_scene_digest_and_identity_mismatch_rejected_before_write(self):
        wire, _ = self.scene_acquisition()
        response = json.loads(wire)
        response["workspace"]["scene_sha256"] = "0" * 64
        with self.assertRaises(capsule.HandoffError):
            self.stage(json.dumps(response).encode())
        self.assert_no_capsule()
        response["workspace"]["identity"]["scene_id"] = "foreign"
        with self.assertRaises(capsule.HandoffError):
            self.stage(json.dumps(response).encode())
        self.assert_no_capsule()

    def test_readback_mismatch_never_returns_success_and_retains_capsule(self):
        original = semantic.load_scene_handoff
        def altered(*args):
            loaded = original(*args)
            loaded["project_document"] = {"lost": True}
            return loaded
        with patch.object(semantic, "load_scene_handoff", side_effect=altered):
            with self.assertRaises(capsule.HandoffError):
                self.stage()
        self.assertEqual(len(list((self.runtime / capsule.HANDOFF_DIRECTORY).iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
