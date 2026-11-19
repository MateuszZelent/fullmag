"""Interpreted workspace-preservation checks; no native execution."""
import json
import unittest

from validate_accepted_antenna_closed_loop_http import workspace_snapshot


class WorkspaceSnapshotTests(unittest.TestCase):
    def requester(self, active):
        self.calls = []
        payloads = {
            "/v2/platform/health": (200, {"status": "ok", "active_session": active}),
            "/v2/sessions": (200, {"schema_version": "2.0.0", "sessions": [{"session_id": "active"}] if active else []}),
            "/v2/sessions/current/model/scene": (200, {"version": "scene.v2", "revision": 7}) if active else
                (404, {"code": "not_found", "message": "no active local live workspace"}),
            "/v2/sessions/current/simulation/commands": (200, {"commands": []}) if active else
                (404, {"code": "not_found", "message": "no active local live workspace"}),
        }
        def request(path, expected=200):
            status, body = payloads[path]
            self.calls.append((path, expected))
            if status != expected:
                raise ValueError(f"{path}: expected {expected}, got {status}")
            return json.dumps(body).encode(), {}
        return request, payloads

    def test_empty_workspace_keeps_explicit_absence(self):
        request, _ = self.requester(False)
        snapshot = workspace_snapshot(request)
        self.assertFalse(snapshot["active_session"])
        self.assertEqual(snapshot["sessions"]["sessions"], [])
        self.assertEqual(snapshot["scene"]["code"], "not_found")
        self.assertEqual(snapshot["commands"]["code"], "not_found")
        self.assertEqual([expected for _, expected in self.calls], [200, 200, 404, 404])

    def test_active_workspace_keeps_scene_and_command_state(self):
        request, _ = self.requester(True)
        snapshot = workspace_snapshot(request)
        self.assertTrue(snapshot["active_session"])
        self.assertEqual(snapshot["scene"]["revision"], 7)
        self.assertEqual(snapshot["commands"], {"commands": []})

    def test_active_workspace_does_not_hide_missing_scene(self):
        request, payloads = self.requester(True)
        payloads["/v2/sessions/current/model/scene"] = (404, {"code": "not_found"})
        with self.assertRaises(ValueError): workspace_snapshot(request)

    def test_new_session_during_empty_snapshot_is_rejected(self):
        request, payloads = self.requester(False)
        payloads["/v2/sessions/current/simulation/commands"] = (200, {"commands": []})
        with self.assertRaises(ValueError): workspace_snapshot(request)

    def test_unknown_health_and_unrelated_not_found_are_rejected(self):
        for health in ({"status": "ok"}, {"status": "ok", "active_session": 0},
                       {"status": "degraded", "active_session": False}):
            request, payloads = self.requester(False)
            payloads["/v2/platform/health"] = (200, health)
            with self.subTest(health=health), self.assertRaises(ValueError): workspace_snapshot(request)
        request, payloads = self.requester(False)
        payloads["/v2/sessions/current/model/scene"] = (404, {"code": "missing_route"})
        with self.assertRaises(ValueError): workspace_snapshot(request)

    def test_before_after_detects_creation_or_scene_mutation(self):
        empty, _ = self.requester(False)
        active, payloads = self.requester(True)
        self.assertNotEqual(workspace_snapshot(empty), workspace_snapshot(active))
        before = workspace_snapshot(active)
        payloads["/v2/sessions/current/model/scene"][1]["revision"] += 1
        self.assertNotEqual(before, workspace_snapshot(active))


if __name__ == "__main__": unittest.main()
