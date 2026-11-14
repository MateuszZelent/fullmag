"""Mock-only contract tests for the held UI stop adapter."""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import docker_volume_dev as subject
import docker_volume_held_ui_lifecycle as lifecycle
import docker_volume_held_ui_materialization as controller
from test_docker_volume_held_ui_materialization import valid_proof_chain


class HeldStopAdapter(unittest.TestCase):
    def test_production_fresh_capture_adapter_feeds_the_real_lifecycle_plan_validator(self):
        request, proofs = valid_proof_chain()
        source_scope = request["source_scope"]
        accepted = request["accepted"]
        plan, plan_sha256 = controller.build_preview_plan(
            attempt=request["plan"]["attempt"],
            maintenance_request_id=request["plan"]["maintenance_request_id"],
            source_scope=source_scope,
            accepted=accepted,
            preflight=proofs["preflight"],
            inventory=proofs["inventory"],
        )
        events = []

        def verify_source_and_state():
            events.append("source-revalidated")

        def capture(*args, **kwargs):
            events.append("preflight-captured")
            self.assertEqual(args, (source_scope["backend_container_id"],))
            self.assertEqual(kwargs, {
                "attempt": plan["attempt"],
                "maintenance_request_id": plan["maintenance_request_id"],
                "run_id": accepted["run_id"],
                "source_scope": source_scope,
            })
            return accepted, proofs["preflight"], proofs["inventory"]

        with patch.object(controller, "capture_readonly_preflight", side_effect=capture):
            fresh = subject._capture_held_ui_fresh_plan(
                controller, backend_container_id=source_scope["backend_container_id"],
                plan=plan, source_scope=source_scope,
                verify_source_and_state=verify_source_and_state,
            )
        actual = lifecycle._assert_plan(controller, plan, plan_sha256, lambda: fresh)

        self.assertEqual(events, ["source-revalidated", "preflight-captured"])
        self.assertEqual(set(fresh), {
            "accepted", "preflight", "inventory", "source_scope", "attempt",
            "maintenance_request_id",
        })
        self.assertEqual(actual, (accepted, proofs["preflight"], proofs["inventory"]))

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

    def test_public_apply_uses_typed_lifecycle_driver(self):
        args = SimpleNamespace(apply=True, preview=False)
        controller = SimpleNamespace()
        with patch.object(subject, "_apply_held_ui_materialization", return_value={"state": "restored"}) as apply:
            result = subject._run_held_ui_materialization(args, controller=controller)
        apply.assert_called_once_with(args, controller=controller)
        self.assertEqual(result["state"], "restored")


if __name__ == "__main__":
    unittest.main()
