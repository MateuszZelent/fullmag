"""Interpreted restart admission observation checks; no native qualification."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from windows import verify_workspace_browser as proof


class AdmissionObservationChecks(unittest.TestCase):
    def test_before_capture_persists_prerequisites_and_rejects_scene_drift(self):
        scope = {"api_instance_id": "pin", "session_id": "s",
                 "session_resource_epoch": "s@1", "request_scope_epoch": "pin:1"}
        status = {"session": {"session_id": "s", "session_epoch": "s@1",
                              "request_scope_epoch": "pin:1"},
                  "lifecycle": {"connectivity": "disconnected"}}
        identity = {"api_instance_id": "pin", "session_id": "s", "session_epoch": 1}
        document = {"dirty": True, "scene_resource_sha256": "a" * 64,
                    "scene_document_sha256": "b" * 64}
        body = {"schema": "fullmag.development-browser-before.v1", "nonce": "nonce",
                "api_instance_id": "pin", "project_document_before": document,
                "project_document_after_grid": dict(document)}
        for drift in (False, True):
            with self.subTest(drift=drift), tempfile.TemporaryDirectory() as directory:
                receipt_path = Path(directory) / "receipt.json"
                bridge = proof.ProofBridge({"nonce": "nonce"}, 1, None, None,
                                           receipt_path=receipt_path)
                scene_reads = 0

                def read(port, pin, path):
                    nonlocal scene_reads
                    self.assertEqual((port, pin), (1, "pin"))
                    if path.endswith("/model/scene"):
                        scene_reads += 1
                        return {"objects": [{"id": "changed" if drift and scene_reads > 1 else "box"}]}
                    if path.endswith("/development-backend"):
                        return {"workspace_identity": identity}
                    if path.endswith("/status"):
                        return status
                    if path.endswith("/visualization/state"):
                        return {"camera": {"projection": "orthographic", "position": [2, 1, 2],
                            "target": [0, 0, 0], "up": [0, 0, 1], "fov_degrees": 45,
                            "orthographic_scale": None}}
                    if path.endswith("/meshing/semantics"):
                        return {"mesh_build_diagnostics": {"last_build_error": None}}
                    self.fail("Unexpected API read: " + path)

                with patch.object(bridge, "eligibility", return_value={"api_instance_id": "pin"}), \
                        patch.object(proof, "read_execution_scope", return_value=scope), \
                        patch.object(proof, "read_api", side_effect=read):
                    if drift:
                        with self.assertRaises(proof.storage.StorageError):
                            bridge.capture_before(body)
                        self.assertIsNone(bridge.before)
                        self.assertFalse(receipt_path.exists())
                    else:
                        self.assertTrue(bridge.capture_before(body)["captured"])
                        saved = json.loads(receipt_path.read_text(encoding="utf-8"))
                        self.assertEqual(saved["workspace_browser_before"]["admission_observation"]["status"], status)
                        self.assertEqual(saved["workspace_browser_before"]["scene"], {"objects": [{"id": "box"}]})

    def test_admission_observation_preserves_disconnected_and_pending_mesh(self):
        scope = {"api_instance_id": "pin", "session_id": "s",
                 "session_resource_epoch": "s@1", "request_scope_epoch": "pin:1"}
        status = {"session": {"session_id": "s", "session_epoch": "s@1",
                              "request_scope_epoch": "pin:1"},
                  "lifecycle": {"connectivity": "disconnected"}}
        mesh = {"mesh_build_diagnostics": {"mesh_pipeline_status": [
            {"id": "runtime", "status": "active"}]}}
        with patch.object(proof, "read_execution_scope", return_value=scope), \
                patch.object(proof, "read_api", side_effect=[status, mesh]):
            observed = proof.read_admission_observation(1, "pin")
        self.assertEqual(observed["status"], status)
        self.assertEqual(observed["meshing_semantics"], mesh)

    def test_admission_observation_rejects_scope_transition_and_unbound_status(self):
        scope = {"api_instance_id": "pin", "session_id": "s",
                 "session_resource_epoch": "s@1", "request_scope_epoch": "pin:1"}
        session = {"session_id": "s", "session_epoch": "s@1",
                   "request_scope_epoch": "pin:1"}
        for after, observed_session in (({**scope, "session_id": "next"}, session),
                                        (scope, {**session, "session_epoch": "s@2"})):
            with self.subTest(after=after, session=observed_session), \
                    patch.object(proof, "read_execution_scope", side_effect=[scope, after]), \
                    patch.object(proof, "read_api", side_effect=[{"session": observed_session}, {}]), \
                    self.assertRaises(proof.storage.StorageError):
                proof.read_admission_observation(1, "pin")
