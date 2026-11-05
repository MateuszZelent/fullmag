"""Bounded read retries must not turn uncertain startup into another action."""
import unittest
from unittest.mock import Mock, patch

from docker_build_control import (
    BuildControlError, ControlOutcomeUnknown, DockerObservationBudgetExceeded,
)
import docker_volume_dev as dev


class PublicationObservationRetryTests(unittest.TestCase):
    def test_transient_read_timeout_retries_then_returns_observation(self):
        read = Mock(side_effect=[DockerObservationBudgetExceeded("timeout"), "same startup"])
        with patch.object(dev.time, "monotonic", return_value=0), patch.object(dev.time, "sleep") as sleep:
            self.assertEqual(dev._read_publication_observation(read, deadline=1000), "same startup")
        self.assertEqual(read.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_exhaustion_remains_unknown_after_three_reads(self):
        error = DockerObservationBudgetExceeded("timeout")
        read = Mock(side_effect=error)
        with patch.object(dev.time, "monotonic", return_value=0), patch.object(dev.time, "sleep") as sleep:
            with self.assertRaises(DockerObservationBudgetExceeded) as caught:
                dev._read_publication_observation(read, deadline=1000)
        self.assertIs(caught.exception, error)
        self.assertIsInstance(caught.exception, ControlOutcomeUnknown)
        self.assertEqual(read.call_count, 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])

    def test_ownership_and_integrity_errors_are_never_retried(self):
        for error in (ControlOutcomeUnknown("helper changed"), BuildControlError("incarnation changed")):
            with self.subTest(error=type(error).__name__):
                read = Mock(side_effect=error)
                with patch.object(dev.time, "monotonic", return_value=0), patch.object(dev.time, "sleep") as sleep:
                    with self.assertRaises(type(error)):
                        dev._read_publication_observation(read, deadline=1000)
                read.assert_called_once_with(90)
                sleep.assert_not_called()

    def test_expired_deadline_performs_no_read_or_mutation(self):
        read = Mock()
        with patch.object(dev.time, "monotonic", return_value=10):
            with self.assertRaises(DockerObservationBudgetExceeded):
                dev._read_publication_observation(read, deadline=10)
        read.assert_not_called()

    def test_read_budget_is_limited_by_global_deadline(self):
        read = Mock(return_value="observed")
        with patch.object(dev.time, "monotonic", return_value=7):
            dev._read_publication_observation(read, deadline=12)
        read.assert_called_once_with(5)


if __name__ == "__main__":
    unittest.main()
