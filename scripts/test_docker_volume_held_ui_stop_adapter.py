"""Mock-only contract tests for the held UI stop adapter."""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import docker_volume_dev as subject


class HeldStopAdapter(unittest.TestCase):
    def test_stale_approved_plan_is_rejected_before_context_or_stop(self):
        args = SimpleNamespace(apply=True, preview=False, expected_plan_sha256="a" * 64)
        controller = SimpleNamespace(_digest=lambda value, _label: value)
        preview = {"plan": {"accepted": {"run_id": "run"}}, "plan_sha256": "b" * 64}
        with patch.object(subject, "_run_held_ui_materialization", return_value=preview) as make_preview, \
             patch.object(subject, "_load_held_ui_publish_context", return_value=None), \
             patch.object(subject, "_capture_held_ui_stop_context") as capture, \
             self.assertRaisesRegex(subject.BuildControlError, "approved plan SHA"):
            subject._stop_held_ui_materialization(args, controller=controller)

        make_preview.assert_called_once()
        capture.assert_not_called()

    def test_matching_approved_plan_calls_typed_stop_once(self):
        args = SimpleNamespace(apply=True, preview=False, expected_plan_sha256="a" * 64)
        plan = {"accepted": {"run_id": "run"}}
        preview = {"plan": plan, "plan_sha256": "a" * 64}
        context = {"control": object(), "controller": object(), "plan": plan,
                   "expected_plan_sha256": "a" * 64, "expected_services": {},
                   "capture_fresh": Mock(), "inspect_services": Mock(),
                   "stop_service": Mock(), "preflight_drain": Mock(), "read_drain": Mock()}
        controller = SimpleNamespace(_digest=lambda value, _label: value)
        with patch.object(subject, "_run_held_ui_materialization", return_value=preview), \
             patch.object(subject, "_load_held_ui_publish_context", return_value=None), \
             patch.object(subject, "_capture_held_ui_stop_context", return_value=context) as capture, \
             patch("docker_volume_held_ui_lifecycle.execute_stop_only", return_value={"state": "stopped"}) as execute:
            result = subject._stop_held_ui_materialization(args, controller=controller)

        capture.assert_called_once_with(args, plan, controller=controller)
        execute.assert_called_once_with(**context)
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["plan_sha256"], "a" * 64)

    def test_spent_claim_uses_publish_only_path_without_reading_new_api_plan(self):
        args = SimpleNamespace(apply=True, preview=False, expected_plan_sha256="a" * 64)
        resume_context = {"control": object(), "controller": object(), "plan": {},
                          "claim": {}, "terminal_raw": b"{}", "proof_refs": {},
                          "expected_plan_sha256": "a" * 64, "expected_services": {},
                          "inspect_services": Mock(), "read_control_record": Mock()}
        controller = SimpleNamespace(_digest=lambda value, _label: value)
        with patch.object(subject, "_load_held_ui_publish_context", return_value=resume_context), \
             patch.object(subject, "_run_held_ui_materialization") as preview, \
             patch("docker_volume_held_ui_lifecycle.resume_publish_only",
                   return_value={"state": "stopped-awaiting-typed-recreate"}) as resume:
            result = subject._stop_held_ui_materialization(args, controller=controller)

        preview.assert_not_called()
        resume.assert_called_once_with(**resume_context)
        self.assertEqual(result["state"], "stopped-awaiting-typed-recreate")

    def test_public_read_only_preview_still_rejects_apply(self):
        args = SimpleNamespace(apply=True, preview=False)
        with self.assertRaisesRegex(subject.BuildControlError, "read-only preview slice"):
            subject._run_held_ui_materialization(args, controller=SimpleNamespace())


if __name__ == "__main__":
    unittest.main()
