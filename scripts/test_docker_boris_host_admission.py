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


class BorisPrivateCacheTests(unittest.TestCase):
    def test_copy_uses_the_same_build_subpath_as_backend(self):
        control = SimpleNamespace(helper_args=lambda *args, **kwargs:
            ["docker", "run", "--entrypoint", "sh", "helper"])
        for subpath in ("", "private/backend", "task/private/backend"):
            with self.subTest(subpath=subpath):
                cache = dict(volume_names=dict(build="selected-build"))
                if subpath:
                    cache.update(group_volume="selected-build", build_subpath=subpath)
                argv = producer.copy_args(control, "a"*32, cache)
                mount = argv[argv.index("--mount")+1]
                self.assertEqual(mount, "type=volume,src=selected-build,dst=/build,volume-nocopy" +
                    (",volume-subpath="+subpath if subpath else ""))
                self.assertEqual(argv[argv.index("--entrypoint")+1], "/usr/bin/python3")
                self.assertIn(producer.ASSET, argv)
                self.assertNotIn("--privileged", argv)

    def test_group_cache_never_falls_back_to_volume_root(self):
        control = SimpleNamespace(helper_args=lambda *args, **kwargs: [])
        for value in (None, "", "../backend", "/private/backend", "private//backend", "x,readonly"):
            with self.subTest(subpath=value), self.assertRaises(producer.BuildControlError):
                producer.copy_args(control, "a"*32, dict(group_volume="selected-build",
                    volume_names=dict(build="selected-build"), build_subpath=value))


if __name__ == "__main__":
    unittest.main()
