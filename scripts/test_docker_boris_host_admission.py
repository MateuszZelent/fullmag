"""Interpreted BORIS host admission regressions; no Docker or solver execution."""
from contextlib import ExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_boris_volume as producer
import docker_dev
import docker_dev_host as host
import docker_nf_common_volume as scientific


class BorisHostAdmissionTests(unittest.TestCase):
    def exercise(self, controller, os_name, platform, exception, message):
        args = SimpleNamespace(profile="comparison", attempt="invalid", config_sha256="invalid",
            producer_attempt="invalid", producer_receipt_sha256="invalid", report_id="invalid")
        with ExitStack() as stack:
            stack.enter_context(patch.object(host, "os", SimpleNamespace(name=os_name)))
            stack.enter_context(patch.object(host.sys, "platform", platform))
            stack.enter_context(patch.object(docker_dev, "os", SimpleNamespace(name=os_name)))
            checkout = stack.enter_context(patch.object(docker_dev, "_select_source"))
            docker = stack.enter_context(patch.object(controller, "docker_capture"))
            control = stack.enter_context(patch.object(controller, "BuildControl"))
            with self.assertRaisesRegex(exception, message):
                controller.run(args)
            checkout.assert_not_called()
            docker.assert_not_called()
            control.assert_not_called()

    def test_linux_reaches_existing_pin_rejection_before_checkout_or_docker(self):
        for controller in (producer, scientific):
            with self.subTest(controller=controller.__name__):
                self.exercise(controller, "posix", "linux", producer.BuildControlError, "exact .*pins required")

    def test_windows_retains_pin_rejection_before_checkout_or_docker(self):
        for controller in (producer, scientific):
            with self.subTest(controller=controller.__name__):
                self.exercise(controller, "nt", "win32", producer.BuildControlError, "exact .*pins required")

    def test_unsupported_host_is_rejected_before_pin_validation_or_docker(self):
        for controller in (producer, scientific):
            with self.subTest(controller=controller.__name__):
                self.exercise(controller, "posix", "darwin", ValueError, "Windows and Linux/WSL hosts")


if __name__ == "__main__":
    unittest.main()
