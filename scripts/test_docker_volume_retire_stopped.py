"""Retiring a drained group must not launch a replacement runtime."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev as dev
from docker_build_control import BuildControlError

TOKEN = "a" * 32
BACKEND, FRONTEND = "b" * 64, "c" * 64
SOURCE = "/registered/source"


class RetireStoppedTests(unittest.TestCase):
    def setUp(self):
        self.control = Mock(project="fullmag-worktree-test", volume="control-test")
        self.control.identity = {"source_root": SOURCE}
        self.archive = {"state": "succeeded", "operation_attempt": TOKEN,
                        "compose_project": self.control.project,
                        "source_root": SOURCE}
        self.receipt = {"phase": "recreate-services", "state": "succeeded",
                        "attempt": TOKEN, "fresh_state": True,
                        "compose_project": self.control.project,
                        "removed_containers": [BACKEND, FRONTEND],
                        "runtime_control_archive": deepcopy(self.archive)}
        self.control.read.return_value = deepcopy(self.archive)

    def test_retirement_reports_only_after_archive_and_exact_absence(self):
        with patch("docker_volume_fresh_runtime._assert_exact_absence") as absence:
            result = dev._retired_recreation_result(self.control, self.receipt, SOURCE)
        self.assertEqual(result["state"], "succeeded")
        self.assertTrue(result["results_preserved"])
        self.assertFalse(result["replacement_started"])
        self.assertEqual(result["removed_containers"], [BACKEND, FRONTEND])
        self.assertEqual(absence.call_args_list[0].args, (BACKEND, "backend"))
        self.assertEqual(absence.call_args_list[1].args, (FRONTEND, "frontend"))

    def test_nonterminal_or_nonfresh_operation_cannot_finish_retirement(self):
        for update in ({"state": "outcome-unknown-resources-retained"},
                       {"fresh_state": False}, {"phase": "iteration"}):
            with self.subTest(update=update):
                receipt = dict(self.receipt, **update)
                with self.assertRaises(BuildControlError):
                    dev._retired_recreation_result(self.control, receipt, SOURCE)

    def test_changed_archive_cannot_be_reported_as_retired(self):
        self.control.read.return_value["operation_attempt"] = "d" * 32
        with self.assertRaises(BuildControlError):
            dev._retired_recreation_result(self.control, self.receipt, SOURCE)

    def test_foreign_source_archive_cannot_be_reported_as_retired(self):
        with self.assertRaises(BuildControlError):
            dev._retired_recreation_result(self.control, self.receipt, "/another/source")

    def test_container_reappearance_cannot_be_reported_as_retired(self):
        with patch("docker_volume_fresh_runtime._assert_exact_absence",
                   side_effect=BuildControlError("container reappeared")):
            with self.assertRaisesRegex(BuildControlError, "reappeared"):
                dev._retired_recreation_result(self.control, self.receipt, SOURCE)

    def test_ambiguous_removed_pair_cannot_be_reported_as_retired(self):
        self.receipt["removed_containers"] = [BACKEND, BACKEND]
        with self.assertRaises(BuildControlError):
            dev._retired_recreation_result(self.control, self.receipt, SOURCE)

    def test_pair_requires_both_services_cleanly_stopped(self):
        stopped = {"Running": False, "Status": "exited", "Pid": 0,
                   "ExitCode": 0, "OOMKilled": False}
        pair = {name: {"State": deepcopy(stopped)} for name in ("backend", "frontend")}
        dev._require_retirement_stopped_pair(pair)
        for field, value in (("Running", True), ("Status", "running"), ("Pid", 42),
                             ("ExitCode", 255), ("OOMKilled", True), ("Paused", True),
                             ("Restarting", True), ("Dead", True)):
            with self.subTest(field=field):
                changed = deepcopy(pair)
                changed["frontend"]["State"][field] = value
                with self.assertRaises(BuildControlError):
                    dev._require_retirement_stopped_pair(changed)

    def test_retirement_rejects_missing_archive_intent_before_host_access(self):
        with self.assertRaisesRegex(BuildControlError, "explicit fresh-state"):
            dev.retire_stopped(SimpleNamespace(fresh_state=False))

    def test_retirement_rejects_start_options_before_host_access(self):
        with self.assertRaisesRegex(BuildControlError, "explicit fresh-state"):
            dev.retire_stopped(SimpleNamespace(fresh_state=True, script="a.py"))

    def test_malformed_container_identity_is_rejected(self):
        self.receipt["removed_containers"] = [BACKEND, {}]
        with self.assertRaises(BuildControlError):
            dev._retired_recreation_result(self.control, self.receipt, SOURCE)


if __name__ == "__main__":
    unittest.main()
