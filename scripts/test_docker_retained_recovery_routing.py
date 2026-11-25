"""Behavioral routing regressions for pending native recovery recreation.

Reuse the retained-operation fixture; only external Docker/storage boundaries
are mocked. The real orchestration must distinguish authenticated recovery
from the mutually exclusive no-native pre-admission route.
"""

from copy import deepcopy
import unittest
from unittest import mock

import docker_volume_dev as dev
from docker_build_control import BuildControlError
import test_docker_volume_pre_admission_integration as integration


class RetainedRecoveryRoutingTests(unittest.TestCase):
    def setUp(self):
        self.harness = integration._Harness()
        self.addCleanup(self.harness.close)
        self.runner = integration.RetainedPreAdmissionIntegrationTests()
        self.context = dev.RetainedContainerRecoveryContext({
            "recovery_environment": {
                "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION":
                    "/opt/fullmag/control/verification/authorization.json",
                "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256": "a" * 64,
            },
            "recovery_metadata": {"request_id": "pending-request"},
        })

    def run_recreation(self, context, *, reject_pre_admission=True):
        self.helper = integration._helper_module(
            self.harness, reject=reject_pre_admission,
        )
        return self.runner._run(
            self.harness, helper=self.helper, recovery_context=context,
        )

    def test_pending_authority_reaches_start_unchanged_without_pre_admission(self):
        expected = deepcopy(dict(self.context))
        result, started = self.run_recreation(self.context)
        self.assertEqual(result, {"started": True})
        self.assertEqual(self.helper.calls["count"], 0)
        started.assert_called_once()
        for key, value in expected.items():
            self.assertEqual(started.call_args.kwargs[key], value)
        self.assertEqual(started.call_args.kwargs["reuse_state"]["state"], self.harness.state)
        self.assertFalse(self.harness.certificate["restart_verified"])
        self.assertIsNone(self.harness.args.script)
        self.assertEqual(self.harness.events.count("rm"), 1)
        self.assertGreaterEqual(self.harness.inspect_calls["backend"], 3)
        self.assertGreaterEqual(self.harness.inspect_calls["frontend"], 3)
        self.harness.archive_runtime_control.assert_not_called()

    def test_empty_authority_still_requires_pre_admission(self):
        with self.assertRaisesRegex(BuildControlError, "post-publication or probe"):
            self.run_recreation({})
        self.assertEqual(self.helper.calls["count"], 1)
        self.assertNotIn("lease-enter", self.harness.events)
        self.assertNotIn("rm", self.harness.events)

    def test_untyped_nonempty_context_cannot_skip_pre_admission(self):
        with self.assertRaisesRegex(BuildControlError, "post-publication or probe"):
            self.run_recreation(dict(self.context))
        self.assertEqual(self.helper.calls["count"], 1)
        self.assertNotIn("rm", self.harness.events)

    def test_authority_change_under_lease_refuses_removal(self):
        changed = deepcopy(self.context)
        changed["recovery_metadata"]["request_id"] = "different-request"
        contexts = iter([self.context, changed])
        with self.assertRaisesRegex(BuildControlError, "capability changed"):
            self.run_recreation(lambda *_args, **_kwargs: next(contexts))
        self.assertEqual(self.helper.calls["count"], 0)
        self.assertIn("lease-enter", self.harness.events)
        self.assertNotIn("rm", self.harness.events)

    def test_restarted_backend_under_lease_refuses_removal(self):
        self.harness.drift_under_lease = True
        with self.assertRaisesRegex(BuildControlError, "service incarnation changed"):
            self.run_recreation(self.context)
        self.assertEqual(self.helper.calls["count"], 0)
        self.assertIn("lease-enter", self.harness.events)
        self.assertNotIn("rm", self.harness.events)

    def test_backend_state_change_after_lease_refuses_removal(self):
        original = self.harness.docker_text

        def changed(*args, **kwargs):
            import json
            raw = original(*args, **kwargs)
            if args == ("inspect", integration.BACKEND_ID) and self.harness.inspect_calls["backend"] == 3:
                rows = json.loads(raw)
                rows[0]["State"]["ExitCode"] = 0
                return json.dumps(rows)
            return raw

        with mock.patch.object(self.harness, "docker_text", side_effect=changed):
            with self.assertRaisesRegex(BuildControlError, "backend stopped state changed"):
                self.run_recreation(self.context)
        self.assertEqual(self.helper.calls["count"], 0)
        self.assertNotIn("rm", self.harness.events)


if __name__ == "__main__":
    unittest.main()
